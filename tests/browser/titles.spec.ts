import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from './fixtures';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { OwnerState, PrestigeAward, PublicProfile } from '../../supabase/functions/_shared/contracts/reads';
import { titleText } from '../../src/features/seasons/season-text';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { withAsterTitles } from '../fixtures/titles';
import { a11yShot, contrastIssues, expectNamedControls, focusDrops, noHorizontalScroll, watchFocus } from './a11y-helpers';
import { SUPABASE_URL, isPresence, routeLiveReads, seedSession } from './live-routes';
import { expectOwnerShown, menuDialog, openMenu, quietArrivals } from './shell-helpers';

// Patch 1.7 Task 10 (spec "My gladiator: the Title button", "The picker"; the approved mockup, section 4): a Title button beside the name on
// My gladiator opens "Choose your title", a modal dialog like Change look: a preview of how others see the choice, Earned or All by family,
// No title first, and Wear title. Live mode uses the development-only intercepted transport; its command handler stands in for the Edge
// function and the database (`wear-title` stores the title the owner read then carries). Set A11Y_SHOTS to keep the review screenshots.
const production = process.env.PLAYWRIGHT_STATIC === 'true';
const CORS = { 'access-control-allow-origin': '*' };

type WearReply = 'ok' | 'invalid';
type Setup = {
  /** How each `wear-title` is answered, in order ('ok' once they run out). */
  replies?: WearReply[];
  /** The title the owner wears at first (Founder). */
  worn?: string | null;
  /** Extra titles the owner holds, after Aster's 8. */
  extra?: OwnerState['titles'];
  /** Public profiles (the picker reads the owner's prestige when it holds Champion). */
  profiles?: Record<string, PublicProfile>;
};

/** A signed-in Aster in live mode, with 8 titles earned, wearing Founder; the server keeps the title a wear stores. */
async function player(page: Page, setup: Setup = {}) {
  const context = page.context();
  await quietArrivals(context);
  await seedSession(context);
  const server = { worn: setup.worn === undefined ? 'founder' : setup.worn };
  const ownerOf = (): OwnerState => {
    const owner = withAsterTitles(structuredClone(ownerFixture), server.worn);
    return { ...owner, titles: [...owner.titles, ...structuredClone(setup.extra ?? [])] };
  };
  const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' }, owner: ownerOf(), profiles: setup.profiles });
  const commands: GameCommand[] = [];
  let wears = 0;
  /** While set, a `wear-title` waits for it before the server stores the title and answers (the answer is on its way). */
  let held: Promise<void> | null = null;
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() !== 'POST' || isPresence(route.request())) return route.fallback();
    const command = route.request().postDataJSON() as GameCommand;
    commands.push(command);
    const answer = (status: number, body: unknown) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (command.kind !== 'wear-title') return answer(400, { ok: false, code: 'invalid' });
    const reply = setup.replies?.[wears++] ?? 'ok';
    if (held) await held;
    if (reply !== 'ok') return answer(400, { ok: false, code: reply });
    server.worn = command.titleId;
    live.setOwner(ownerOf());
    return answer(200, { ok: true, receiptId: randomUUID(), value: { titleId: command.titleId, receivedAtMs: live.serverNowMs() } });
  });
  return {
    live, commands, server, ownerOf,
    /** Holds every later `wear-title` before it is stored and answered, until the returned release is called. */
    holdWears(): () => void {
      let release!: () => void;
      held = new Promise<void>(resolve => { release = resolve; });
      return () => { held = null; release(); };
    },
  };
}
const wears = (commands: readonly GameCommand[]) => commands.filter(c => c.kind === 'wear-title');

/**
 * Holds the owner reads that arrive from now on: each answers, when released, the owner as the server had it when the read arrived (a read
 * that started before a wear carries the old title). `stop` lets every held read go and serves later reads at once.
 */
async function holdOwnerReads(page: Page, ownerNow: () => OwnerState) {
  const held: { worn: string | null; release(): void }[] = [];
  let holding = true;
  await page.context().route(url => url.href.startsWith(`${SUPABASE_URL}/rest/v1/owner_state`), async route => {
    if (!holding || route.request().method() !== 'GET') return route.fallback();
    const owner = ownerNow();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    held.push({ worn: owner.wornTitle, release });
    await gate;
    const single = (route.request().headers().accept ?? '').includes('application/vnd.pgrst.object+json');
    await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(single ? { state: owner } : [{ state: owner }]) });
  });
  return { held, stop() { holding = false; held.forEach(read => read.release()); } };
}
/** Lets the held read `index` go and waits until its answer has reached the page. */
async function land(page: Page, reads: Awaited<ReturnType<typeof holdOwnerReads>>, index: number) {
  const landed = page.waitForResponse(response => response.url().startsWith(`${SUPABASE_URL}/rest/v1/owner_state`) && response.request().method() === 'GET');
  reads.held[index].release();
  await landed;
  // The page renders what it read (or drops it) on its next tasks.
  await page.waitForTimeout(400);
}
/** A tab coming back to focus reads the owner (not within 2 s of the last owner read): a background update, for a page that is open. */
async function backgroundRead(page: Page) {
  await page.waitForTimeout(2_500);
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
}

async function openLive(page: Page) {
  await page.goto('/game/');
  await expectOwnerShown(page, 'Aster');
}
const titleButton = (page: Page) => menuDialog(page, 'My gladiator').getByRole('button', { name: /^Title: .*\. Choose your title$/ });
const pickerOf = (page: Page) => page.getByRole('dialog', { name: 'Choose your title', exact: true });
/** Waits for an opening slide or a sheet's rise (anything animating in `locator`) to end. */
const settled = (locator: Locator) => locator.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)));
/** Opens My gladiator and presses the Title button: the picker opens. */
async function openPicker(page: Page) {
  await settled(await openMenu(page, 'My gladiator'));
  const button = titleButton(page);
  await expect(button).toBeVisible();
  await button.click();
  const dialog = pickerOf(page);
  await expect(dialog).toBeVisible();
  return { button, dialog };
}
const wearButton = (dialog: Locator) => dialog.getByRole('button', { name: 'Wear title', exact: true });
const status = (page: Page) => page.getByTestId('title-status');

test.describe('the Title button and "Choose your title" in live mode', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');

  test('opens the picker from the Title button', async ({ page }, testInfo) => {
    await watchFocus(page);
    const { commands } = await player(page);
    await openLive(page);
    const panel = await openMenu(page, 'My gladiator');
    await settled(panel);
    const button = titleButton(page);
    await expect(button).toHaveAccessibleName('Title: Founder. Choose your title');
    await expect(button).toContainText('TITLE');
    await expect(button).toContainText('Founder');
    expect(await contrastIssues(button), 'the Title button').toEqual([]);
    await a11yShot(page, testInfo, 'title-button');
    await button.click();
    const dialog = pickerOf(page);
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(el => el.matches('dialog:modal'))).toBe(true);
    await expect(dialog.getByRole('heading', { name: 'Choose your title', exact: true })).toBeFocused();
    // The preview: how the camp and the menus show the choice (the worn title at first).
    await expect(dialog.getByText('IN THE CAMP', { exact: true })).toBeVisible();
    await expect(dialog.getByText('IN MENUS', { exact: true })).toBeVisible();
    await expect(dialog.getByTestId('title-preview')).toContainText('Founder');
    // Earned or All, Earned pressed.
    const which = dialog.getByRole('group', { name: 'Which titles', exact: true });
    await expect(which.getByRole('button', { name: 'Earned · 8', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(which.getByRole('button', { name: 'All · 31', exact: true })).toHaveAttribute('aria-pressed', 'false');
    // First "Wear nothing", then each family with its earned titles, the worn one chosen.
    const nothing = dialog.getByRole('group', { name: 'Wear nothing', exact: true });
    await expect(nothing.getByRole('radio', { name: 'No title', exact: true })).not.toBeChecked();
    await expect(nothing.getByText('Show your name only.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Founder', exact: true })).toBeChecked();
    await expect(dialog.getByRole('radio')).toHaveCount(9);
    await expect(dialog.getByRole('group', { name: 'Gear collection', exact: true }).getByRole('radio')).toHaveCount(2);
    await expect(dialog.getByRole('group', { name: 'Seasons', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('group', { name: 'Expeditions', exact: true })).toContainText('✓ Earned');
    await expect(dialog.getByRole('group', { name: 'Expeditions', exact: true })).toContainText('10 expeditions won');
    // Wear title is off while the choice is the worn one, and says why.
    await expect(wearButton(dialog)).toBeDisabled();
    await expect(dialog.getByText('You wear this now', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await expectNamedControls(dialog, 'the title picker');
    expect(await contrastIssues(dialog), 'the title picker').toEqual([]);
    await a11yShot(page, testInfo, 'title-picker-earned');
    // Another choice turns Wear title on; the preview follows it.
    await dialog.getByRole('radio', { name: 'Wanderer', exact: true }).check();
    await expect(wearButton(dialog)).toBeEnabled();
    await expect(dialog.getByText('You wear this now', { exact: true })).toHaveCount(0);
    await expect(dialog.getByTestId('title-preview')).toContainText('Wanderer');
    await dialog.getByRole('radio', { name: 'No title', exact: true }).check();
    await expect(dialog.getByTestId('title-preview')).toContainText('No title');
    // Escape and × cancel: nothing is sent and the focus is back on the Title button.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    await button.click();
    await expect(dialog).toBeVisible();
    // It opens on the worn title again.
    await expect(dialog.getByRole('radio', { name: 'Founder', exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    await expect(panel).toBeVisible();
    expect(wears(commands)).toEqual([]);
    await expect(status(page)).toHaveText('');
    expect(await focusDrops(page)).toEqual([]);
  });

  test('wears another title', async ({ page }, testInfo) => {
    await watchFocus(page);
    const { commands, server } = await player(page);
    await openLive(page);
    const { button, dialog } = await openPicker(page);
    await dialog.getByRole('radio', { name: 'Wanderer', exact: true }).check();
    await wearButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(wears(commands)).toEqual([{ kind: 'wear-title', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), titleId: 'wanderer' }]);
    expect(server.worn).toBe('wanderer');
    await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
    await expect(button).toContainText('Wanderer');
    await expect(status(page)).toHaveAttribute('role', 'status');
    await expect(status(page)).toHaveText('You now wear Wanderer.');
    await expect(button).toBeFocused();
    expect(await contrastIssues(status(page)), 'the status line').toEqual([]);
    await a11yShot(page, testInfo, 'title-worn-status');
    // Opened again, it opens on Wanderer; No title is worn the same way, and the status says so.
    await button.click();
    await expect(dialog.getByRole('radio', { name: 'Wanderer', exact: true })).toBeChecked();
    await expect(status(page)).toHaveText('');
    await dialog.getByRole('radio', { name: 'No title', exact: true }).check();
    await wearButton(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(button).toHaveAccessibleName('Title: No title. Choose your title');
    await expect(status(page)).toHaveText('You now wear no title.');
    expect(wears(commands)).toHaveLength(2);
    expect(wears(commands)[1]).toMatchObject({ kind: 'wear-title', titleId: null });
    expect(wears(commands)[1].operationId).not.toBe(wears(commands)[0].operationId);
    expect(await focusDrops(page)).toEqual([]);
  });

  test('shows locked titles in All', async ({ page }, testInfo) => {
    const { commands } = await player(page);
    await openLive(page);
    const { dialog } = await openPicker(page);
    const all = dialog.getByRole('button', { name: 'All · 31', exact: true });
    await all.click();
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'Earned · 8', exact: true })).toHaveAttribute('aria-pressed', 'false');
    const expeditions = dialog.getByRole('group', { name: 'Expeditions', exact: true });
    const pathfinder = expeditions.getByTestId('locked-title').filter({ hasText: 'Pathfinder' });
    await expect(pathfinder).toBeVisible();
    await expect(pathfinder).toContainText('50 expeditions won');
    await expect(pathfinder).toContainText('34 of 50');
    // The lock is decoration: hidden from the accessibility tree.
    await expect(pathfinder.getByText('🔒', { exact: true })).toHaveAttribute('aria-hidden', 'true');
    // A locked title cannot be chosen: no radio, and a press on it changes nothing.
    await expect(dialog.getByRole('radio', { name: 'Pathfinder' })).toHaveCount(0);
    await pathfinder.click();
    await expect(dialog.getByRole('radio', { name: 'Founder', exact: true })).toBeChecked();
    await expect(wearButton(dialog)).toBeDisabled();
    // Every family is listed, every title once, and the earned ones are still radios.
    await expect(dialog.getByRole('group', { name: 'Seasons', exact: true })).toContainText('A season first place');
    await expect(dialog.getByRole('radio')).toHaveCount(9);
    await expect(dialog.getByTestId('locked-title')).toHaveCount(23);
    await expect(expeditions.getByTestId('locked-title').filter({ hasText: 'Troll-Slayer' })).toContainText('Opens at level 10');
    await expect(dialog.getByRole('group', { name: 'Wealth', exact: true }).getByTestId('locked-title').filter({ hasText: 'Patrician' })).toContainText('1,240 of 4,000');
    // The list ends with the titles that arrive later.
    const body = dialog.getByTestId('title-picker-body');
    await expect(body.locator(':scope > *').last()).toHaveText('8 more arrive later: 4 with party dungeons, 2 in the Deep, Outfitter with the new gear, and Legend-Bearer if a Legendary rarity ever comes.');
    expect(await contrastIssues(dialog), 'the title picker, All').toEqual([]);
    await body.evaluate(el => { el.scrollTop = 520; });
    await a11yShot(page, testInfo, 'title-picker-all');
    // Earned again hides the locked ones.
    await dialog.getByRole('button', { name: 'Earned · 8', exact: true }).click();
    await expect(dialog.getByTestId('locked-title')).toHaveCount(0);
    expect(wears(commands)).toEqual([]);
  });

  test('keeps the answer over an older owner read', async ({ page }) => {
    const { commands, ownerOf } = await player(page);
    await openLive(page);
    const { button, dialog } = await openPicker(page);
    await dialog.getByRole('radio', { name: 'Wanderer', exact: true }).check();
    const reads = await holdOwnerReads(page, ownerOf);
    try {
      // An owner read starts before the wear is answered (the server still says Founder), and is held.
      await backgroundRead(page);
      await expect.poll(() => reads.held.length).toBe(1);
      expect(reads.held[0].worn).toBe('founder');
      await wearButton(dialog).click();
      await expect(dialog).toBeHidden();
      // The answer shows at once, before any read after it has landed (the one the answer started is held too).
      await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
      await expect.poll(() => reads.held.length).toBe(2);
      expect(reads.held[1].worn).toBe('wanderer');
      // The older read lands after the answer: the button keeps Wanderer.
      await land(page, reads, 0);
      await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
      await expect(button).toContainText('Wanderer');
      await expect(status(page)).toHaveText('You now wear Wanderer.');
      // Then the newer one, which agrees.
      await land(page, reads, 1);
      await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
      expect(wears(commands)).toHaveLength(1);
    } finally {
      reads.stop();
    }
  });

  // AGENTS.md (React async state): a background update that arrives before the answer never decides what the answer shows.
  test('keeps the answer when a background read lands before it', async ({ page }) => {
    const { commands, ownerOf, holdWears, live } = await player(page);
    await openLive(page);
    const { button, dialog } = await openPicker(page);
    await dialog.getByRole('radio', { name: 'Wanderer', exact: true }).check();
    const release = holdWears();
    let reads: Awaited<ReturnType<typeof holdOwnerReads>> | null = null;
    try {
      await wearButton(dialog).click();
      await expect.poll(() => wears(commands).length).toBe(1);
      // While the wear is on its way, a background read lands with Founder (the title is not stored yet).
      const owners = live.count('owner_state');
      const landed = page.waitForResponse(response => response.url().startsWith(`${SUPABASE_URL}/rest/v1/owner_state`));
      await backgroundRead(page);
      await landed;
      expect(live.count('owner_state')).toBeGreaterThan(owners);
      await expect(dialog).toBeVisible();
      await expect(wearButton(dialog)).toHaveAttribute('aria-disabled', 'true');
      // Then the answer: Wanderer, at once, while the read it starts is held.
      reads = await holdOwnerReads(page, ownerOf);
      release();
      await expect(dialog).toBeHidden();
      await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
      await expect.poll(() => reads!.held.length).toBe(1);
      await page.waitForTimeout(400);
      await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
      await land(page, reads, 0);
      await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
    } finally {
      release();
      reads?.stop();
    }
  });

  test('says when a wear is refused', async ({ page }) => {
    await watchFocus(page);
    const { commands, server } = await player(page, { replies: ['invalid'] });
    await openLive(page);
    const { button, dialog } = await openPicker(page);
    await dialog.getByRole('radio', { name: 'Wanderer', exact: true }).check();
    await wearButton(dialog).click();
    await expect(dialog.getByRole('alert')).toHaveText('That title could not be worn. Try again.');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Wanderer', exact: true })).toBeChecked();
    await expect(wearButton(dialog)).toBeEnabled();
    expect(server.worn).toBe('founder');
    expect(await contrastIssues(dialog), 'the picker with the error').toEqual([]);
    // The button behind it is unchanged.
    await expect(page.locator('[data-title-button]')).toHaveAttribute('aria-label', 'Title: Founder. Choose your title');
    // A refusal decided the matter: the next try is a new command, and it wears.
    await wearButton(dialog).click();
    await expect(dialog).toBeHidden();
    const [refused, accepted] = wears(commands);
    expect(accepted.operationId).not.toBe(refused.operationId);
    await expect(button).toHaveAccessibleName('Title: Wanderer. Choose your title');
    await expect(status(page)).toHaveText('You now wear Wanderer.');
    expect(await focusDrops(page)).toEqual([]);
  });

  test('fits a phone', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await player(page);
    await openLive(page);
    await settled(await openMenu(page, 'My gladiator'));
    const button = titleButton(page);
    await expect(button).toBeVisible();
    const target = (await button.boundingBox())!;
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.x + target.width).toBeLessThanOrEqual(360);
    expect(await noHorizontalScroll(page)).toBe(true);
    await a11yShot(page, testInfo, 'title-button-360');
    await button.click();
    const dialog = pickerOf(page);
    await expect(dialog).toBeVisible();
    // The dialog fills the screen less a 10–14 px margin (measured once its opening slide has ended).
    await settled(dialog);
    const box = (await dialog.boundingBox())!;
    for (const [edge, gap] of [['left', box.x], ['top', box.y], ['right', 360 - box.x - box.width], ['bottom', 740 - box.y - box.height]] as const) {
      expect(gap, edge).toBeGreaterThanOrEqual(10);
      expect(gap, edge).toBeLessThanOrEqual(14);
    }
    // Wear title and Cancel are in view before any scroll, 44 px tall.
    const footTargets = async () => {
      for (const name of ['Wear title', 'Cancel']) {
        const b = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!;
        expect(b.height, name).toBeGreaterThanOrEqual(44);
        expect(b.y, name).toBeGreaterThanOrEqual(box.y);
        expect(b.y + b.height, name).toBeLessThanOrEqual(box.y + box.height);
        expect(b.x + b.width, name).toBeLessThanOrEqual(360);
      }
    };
    await footTargets();
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await a11yShot(page, testInfo, 'title-picker-360-earned');
    // In All the titles scroll inside the body; the preview stays at the top and the foot at the bottom.
    await dialog.getByRole('button', { name: 'All · 31', exact: true }).click();
    const body = dialog.getByTestId('title-picker-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const preview = dialog.getByTestId('title-preview');
    const before = (await preview.boundingBox())!;
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await preview.boundingBox()).toEqual(before);
    await footTargets();
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await body.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await a11yShot(page, testInfo, 'title-picker-360-all');
  });

  // A regression guard (ruling R4): it passed before the button existed, and keeps a visitor without one.
  test('has no Title button for a visitor', async ({ page, context }) => {
    await quietArrivals(context);
    await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' } });
    await page.goto('/game/');
    const panel = await openMenu(page, 'My gladiator');
    await expect(panel.getByRole('heading', { name: 'A legend awaits' })).toBeVisible();
    await expect(page.locator('[data-title-button]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^Title:/ })).toHaveCount(0);
  });

  // Ruling D2: the picker reads the owner's prestige and names Champion's latest first place in the menus' preview; the button and the camp
  // preview say "Champion".
  test('names Champion with its latest first place in the menus preview', async ({ page }) => {
    const award: PrestigeAward = { seasonId: '1', league: 'silver', place: 1, badge: 'gold', title: 'champion' };
    const actor = worldFixture.actors.find(a => a.gladiatorId === ownerFixture.gladiatorId)!;
    const profile: PublicProfile = { actor: structuredClone(actor), combatStrength: 400, rating: 1000, prestige: [award] };
    await player(page, { worn: 'champion', profiles: { [ownerFixture.gladiatorId]: profile },
      extra: [{ id: 'champion', earnedAtMs: worldFixture.serverNowMs, activityId: null, source: 'season', detail: { seasonIndex: 1, league: 'silver', place: 1 } }] });
    await openLive(page);
    const { button, dialog } = await openPicker(page);
    await expect(button).toHaveAccessibleName('Title: Champion. Choose your title');
    const preview = dialog.getByTestId('title-preview');
    await expect(preview.getByTestId('menu-title')).toHaveText(titleText(award)!);
    await expect(preview.getByTestId('camp-title')).toHaveText('Champion');
    await expect(dialog.getByRole('radio', { name: 'Champion', exact: true })).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Earned · 9', exact: true })).toBeVisible();
  });
});

test.describe('the Title button in the fixture preview', () => {
  test.skip(production, 'The production export carries no fixture preview data.');

  test('the preview, which takes no commands, says so and keeps the title', async ({ page, context }) => {
    await quietArrivals(context);
    await page.goto('/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    const { button, dialog } = await openPicker(page);
    await expect(button).toHaveAccessibleName('Title: Founder. Choose your title');
    await expect(dialog.getByRole('button', { name: 'Earned · 8', exact: true })).toBeVisible();
    await dialog.getByRole('radio', { name: 'Tiro', exact: true }).check();
    await wearButton(dialog).click();
    await expect(dialog.getByRole('alert')).toHaveText('Title changes are unavailable in this preview. Your title is unchanged.');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(button).toHaveAccessibleName('Title: Founder. Choose your title');
  });

  // A regression guard (ruling R4): it passed before the button existed.
  test('has no Title button for the visitor preview', async ({ page, context }) => {
    await quietArrivals(context);
    await page.goto('/game/?mode=fixture&as=visitor');
    const panel = await openMenu(page, 'My gladiator');
    await expect(panel.getByRole('heading', { name: 'A legend awaits' })).toBeVisible();
    await expect(page.locator('[data-title-button]')).toHaveCount(0);
  });
});
