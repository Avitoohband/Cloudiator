import { readFileSync } from 'node:fs';
import { PATCH } from '../../src/lib/patch';
import { expect, test, type Locator, type Page } from './fixtures';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { GameMessage, Inbox, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { EXPEDITION_FIXTURES } from '../fixtures/expedition-ids';
import { PATCH_1_4, SEED_PATCHES, linkNotes } from '../fixtures/patches';
import { contrastIssues, expectNamedControls, noHorizontalScroll } from './a11y-helpers';
import { reviewShot } from './review-shots';
import { routeLiveReads, seedSession, type LiveTransport } from './live-routes';
import { chipToggle, cornerChip, expectOwnerShown, openChipMenu, quietArrivals, touchLayout } from './shell-helpers';

// Task 11b: patch numbers (Patch A spec, "Patch numbers and the changelog"; Avi approved the mockup in chat, 2026-10-29). The account
// menu shows the patch this build is and opens Patch history inside the messages panel; each patch note shows its number, which opens
// the history at that patch; and an open game whose build is behind the server's newest patch says so in the notice column, never over
// a scene or a dialog. Live mode uses the development-only intercepted transport: `setLatestPatch` stands in for the server recording a
// newer patch, which the page learns on its next revision read (a window `focus` starts one).
const production = process.env.PLAYWRIGHT_STATIC === 'true';
// Keep the server ahead of this build, including when the next minor release changes PATCH.
const NEWER_PATCH = `${Number(PATCH.split('.')[0]) + 1}.0`;
const LATER_PATCH = `${Number(PATCH.split('.')[0]) + 1}.1`;
/** A local-noon time on a day of 2026, so a posting date reads the same in every time zone. */
const at = (month: number, day: number) => new Date(2026, month, day, 12).getTime();
const note = (id: number, title: string, day: number): GameMessage => ({ id, kind: 'patch-notes', title, preview: `What ${title} changed.`,
  body: [{ p: 'What changed:' }, { li: `${title}.` }], action: null, publishedAtMs: at(9, day) });
/** The four patch notes as production has them (ids 1-4, linked to 1.1, 1.2, 1.3 and 1.3.1), and one admin message. */
const NOTES = [note(4, 'Attribute points: easier on a phone', 29), note(3, 'Messages, gold, fixed builds and bigger beds', 29),
  note(2, 'New: choose your gladiator’s look', 27), note(1, 'Evening Arena, waiting monsters, clearer menus', 26)];
const ADMIN: GameMessage = { id: 5, kind: 'admin', title: 'A note from Avi', preview: 'The arena opens early on Saturday.', body: [{ p: 'The arena opens early on Saturday.' }],
  action: null, publishedAtMs: at(9, 30) };
const PATCHES = [PATCH_1_4, ...linkNotes(SEED_PATCHES, { '1.1': 1, '1.2': 2, '1.3': 3, '1.3.1': 4 })];
const WOODLAND = EXPEDITION_FIXTURES.woodland.activityId;
/** The Woodland sample's timeline (the runner reads the fixture's JSON itself; it cannot import it). */
const WOODLAND_TIMELINE = JSON.parse(readFileSync('tests/fixtures/expeditions/woodland.json', 'utf8')) as RevealedTimeline;
/** Every message read: an inbox with nothing unread (the gladiator is older than none of them, and has read them all). */
const inbox = (messages: readonly GameMessage[]): Inbox => ({ unread: 0, readIds: messages.map(m => m.id).sort((a, b) => a - b), sinceMs: 0, newNotifications: 0, notificationsSeenMs: 0 });

/** A signed-in player (Aster) in live mode on a server with the patches, the notes and the given newest patch. */
async function player(page: Page, latestPatch: string | null = PATCH): Promise<LiveTransport> {
  const context = page.context();
  await seedSession(context);
  await quietArrivals(context);
  const messages = [ADMIN, ...NOTES];
  const owner: OwnerState = { ...structuredClone(ownerFixture), inbox: inbox(messages) };
  return routeLiveReads(context, { world: { ...worldFixture, revision: 'patches-1' }, owner, messages, patches: PATCHES, latestPatch,
    timelines: { [WOODLAND]: WOODLAND_TIMELINE } });
}
async function openLive(page: Page, url = '/game/') {
  await page.goto(url);
  await expectOwnerShown(page, 'Aster');
}
const messagesButton = (page: Page) => cornerChip(page).locator('[data-messages-button]');
const panelOf = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true });
const history = (panel: Locator) => panel.getByRole('heading', { name: 'Patch history', exact: true });
/** A patch's disclosure button in Patch history ("1.3 · Messages, gold, fixed builds and bigger beds · 29 Oct"). */
const disclosure = (panel: Locator, number: string) => panel.getByRole('button', { name: new RegExp(`^${number.replace(/\./g, '\\.')} · `) });
const notice = (page: Page) => page.getByRole('status').filter({ hasText: /patch is out|is out/i }).filter({ has: page.getByRole('button', { name: 'Reload', exact: true }) });
/**
 * The server records a newer patch; the page reads it with its next revision read (a window focus starts one). The camp's world is
 * loaded first, so no refresh is in flight: a focus during one joins it, and its revision read was sent before the change. It returns
 * once that read has landed in the sync (the shell's test hook counts the refreshes that land) and the shell has rendered its patch (11b
 * review: a fixed wait could pass before the read landed, which a case that expects no change would not notice).
 */
async function serverHas(page: Page, live: LiveTransport, latest: string | null) {
  await page.waitForFunction(() => window.__cloudiatorCamp?.world()?.revision === 'patches-1', null, { timeout: 45_000 });
  live.setLatestPatch(latest);
  const landed = await page.evaluate(() => window.__cloudiatorShell!.syncs());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(([before, patch]) => window.__cloudiatorShell!.syncs() > (before as number) && window.__cloudiatorShell!.latestPatch() === patch,
    [landed, latest] as const, { timeout: 15_000 });
  // And one more frame for the commit's effects.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function openHistoryFromMenu(page: Page) {
  const menu = await openChipMenu(page);
  await menu.getByRole('button', { name: /^Patch history/ }).click();
  const panel = panelOf(page);
  await expect(history(panel)).toBeVisible();
  return panel;
}

test.describe('patch numbers in live mode', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');

  test('shows the patch in the account menu and opens Patch history', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await player(page);
    await openLive(page);
    const menu = await openChipMenu(page);
    // This build's patch after the Clock group and before Sign out.
    const order = await menu.evaluate(root => [...root.children].map(child => (child.getAttribute('aria-label') ?? (child as HTMLElement).innerText).replace(/\s+/g, ' ').trim()));
    const clockAt = order.findIndex(text => text.startsWith('Clock')), patchAt = order.findIndex(text => text.startsWith(`Patch ${PATCH} `)), signOutAt = order.indexOf('Sign out');
    expect(clockAt, order.join(' | ')).toBeGreaterThan(-1);
    expect(patchAt, order.join(' | ')).toBe(clockAt + 1);
    expect(signOutAt, order.join(' | ')).toBe(patchAt + 1);
    await expect(menu.getByText(`Patch ${PATCH}`, { exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Reload' })).toHaveCount(0);
    await reviewShot(page, testInfo, 'patch-menu');
    await menu.getByRole('button', { name: /^Patch history/ }).click();
    const panel = panelOf(page);
    await expect(history(panel)).toBeVisible();
    await expect(history(panel)).toBeFocused();
    await expect(panel.getByText(`You are playing Patch ${PATCH}`, { exact: true })).toBeVisible();
    // Newest first; the newest is open with its features, the others are closed.
    const buttons = panel.locator('[data-patch]');
    await expect(buttons).toHaveCount(7);
    expect(await buttons.evaluateAll(els => els.map(el => el.getAttribute('data-patch')))).toEqual(['1.4', '1.3.1', '1.3', '1.2.1', '1.2', '1.1', '1.0']);
    await expect(disclosure(panel, '1.4')).toHaveAttribute('aria-expanded', 'true');
    await expect(disclosure(panel, '1.4')).toHaveAccessibleName(`1.4 · ${PATCH_1_4.title} · 30 Oct`);
    const features = panel.locator(`[id="${await disclosure(panel, '1.4').getAttribute('aria-controls')}"]`).getByRole('listitem');
    await expect(features).toHaveText(PATCH_1_4.features);
    for (const n of ['1.3.1', '1.3', '1.2.1', '1.2', '1.1', '1.0']) await expect(disclosure(panel, n)).toHaveAttribute('aria-expanded', 'false');
    await expect(disclosure(panel, '1.3')).toHaveAccessibleName('1.3 · Messages, gold, fixed builds and bigger beds · 29 Oct');
    // 1.4 has no note yet: no "Read the patch note".
    await expect(panel.getByRole('button', { name: /Read the patch note/ })).toHaveCount(0);
    await reviewShot(page, testInfo, 'patch-history');
    // Opening 1.3 closes 1.4 and lists its features and its note.
    await disclosure(panel, '1.3').click();
    await expect(disclosure(panel, '1.3')).toHaveAttribute('aria-expanded', 'true');
    await expect(disclosure(panel, '1.4')).toHaveAttribute('aria-expanded', 'false');
    const opened = panel.locator(`[id="${await disclosure(panel, '1.3').getAttribute('aria-controls')}"]`);
    await expect(opened.getByRole('listitem').filter({ hasText: 'The beds in the camp are bigger, so a gladiator fits on one. Punchy asked for it.' })).toHaveCount(1);
    await expect(opened.getByRole('listitem')).toHaveCount(6);
    await reviewShot(page, testInfo, 'patch-history-1.3');
    await panel.getByRole('button', { name: /^Read the patch note/ }).click();
    await expect(panel.getByRole('heading', { name: 'Messages, gold, fixed builds and bigger beds', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /Back to messages/ })).toBeFocused();
    await panel.getByRole('button', { name: /Back to messages/ }).click();
    await expect(panel.locator('[data-message-row]')).toHaveCount(5);
    // Escape closes the panel and gives the focus back to the account button the history was opened from.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(chipToggle(page)).toBeFocused();
  });

  test('numbers each patch note', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await player(page);
    await openLive(page);
    await messagesButton(page).click();
    const panel = panelOf(page);
    await expect(panel.locator('[data-message-row]')).toHaveCount(5);
    const item = (id: number) => panel.getByRole('listitem').filter({ has: page.locator(`[data-message-row="${id}"]`) });
    await expect(item(3)).toContainText('Patch 1.3');
    await expect(item(4)).toContainText('Patch 1.3.1');
    await expect(item(1)).toContainText('Patch 1.1');
    await expect(item(5)).not.toContainText('Patch');
    // The number sits between the tag and the date, on the row's top line.
    const box = async (l: Locator) => (await l.boundingBox())!;
    const tag = await box(item(3).locator('[data-message-tag]')), number = await box(item(3).getByRole('button', { name: /^Patch 1\.3/ }));
    const date = await box(item(3).getByText('29 Oct', { exact: true }));
    expect(number.x).toBeGreaterThan(tag.x + tag.width);
    expect(number.x + number.width).toBeLessThan(date.x);
    expect(Math.abs((number.y + number.height / 2) - (tag.y + tag.height / 2))).toBeLessThanOrEqual(2);
    expect(await contrastIssues(item(3)), 'a numbered row').toEqual([]);
    await reviewShot(page, testInfo, 'patch-numbers');
    // The opened note: "Patch notes", "Patch 1.3", then its date.
    await panel.locator('[data-message-row="3"]').click();
    const top = panel.locator('article [data-row-top]');
    expect((await top.evaluate(el => [...el.children].map(child => (child as HTMLElement).innerText.trim())))).toEqual(['Patch notes', 'Patch 1.3', '29 Oct']);
    await reviewShot(page, testInfo, 'patch-note');
    await top.getByRole('button', { name: /^Patch 1\.3/ }).click();
    await expect(history(panel)).toBeVisible();
    await expect(disclosure(panel, '1.3')).toHaveAttribute('aria-expanded', 'true');
    await expect(disclosure(panel, '1.4')).toHaveAttribute('aria-expanded', 'false');
    // From the list too.
    await panel.getByRole('button', { name: /Back to messages/ }).click();
    await item(1).getByRole('button', { name: /^Patch 1\.1/ }).click();
    await expect(disclosure(panel, '1.1')).toHaveAttribute('aria-expanded', 'true');
  });

  test('says a new patch is out, never over a scene or a dialog', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const live = await player(page);
    let loads = 0;
    page.on('load', () => { loads += 1; });
    await openLive(page);
    await expect(notice(page)).toHaveCount(0);
    await chipToggle(page).focus();
    await serverHas(page, live, NEWER_PATCH);
    // The touch layout (the mobile project: no hover) shows the short form.
    const words = async (n: string) => ((await touchLayout(page)) ? `Patch ${n} is out` : `A new patch is out — reload to play Patch ${n}.`);
    await expect(notice(page)).toContainText(await words(NEWER_PATCH));
    await expect(notice(page).getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    await expect(notice(page).getByRole('button', { name: 'Later', exact: true })).toBeVisible();
    // It never takes the focus.
    await expect(chipToggle(page)).toBeFocused();
    expect(await contrastIssues(notice(page)), 'the notice').toEqual([]);
    await reviewShot(page, testInfo, 'patch-notice');
    // Not over a scene: it waits, and shows again when the scene closes.
    await page.goto(`/game/?view=expedition&activity=${WOODLAND}`);
    await expectOwnerShown(page, 'Aster');
    const back = page.getByRole('button', { name: 'Back to Camp', exact: true });
    await expect(back).toBeVisible();
    await serverHas(page, live, NEWER_PATCH);
    await expect(notice(page)).toHaveCount(0);
    await back.click();
    await expect(notice(page)).toContainText(`Patch ${NEWER_PATCH}`);
    // Not over a modal dialog, whichever it is (here one the test opens; the Change look dialog has its own case below).
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('data-test-modal', '');
      dialog.textContent = 'A modal dialog';
      document.body.append(dialog);
      dialog.showModal();
    });
    await expect(notice(page)).toHaveCount(0);
    await page.evaluate(() => { const dialog = document.querySelector<HTMLDialogElement>('[data-test-modal]')!; dialog.close(); dialog.remove(); });
    await expect(notice(page)).toContainText(`Patch ${NEWER_PATCH}`);
    // Later hides it for this number, for this page: the same patch keeps it hidden, a later patch shows it again.
    await notice(page).getByRole('button', { name: 'Later', exact: true }).click();
    await expect(notice(page)).toHaveCount(0);
    await serverHas(page, live, NEWER_PATCH);
    await expect(notice(page)).toHaveCount(0);
    await serverHas(page, live, LATER_PATCH);
    await expect(notice(page)).toContainText(await words(LATER_PATCH));
    // Reload reloads once, at the same address.
    const address = page.url(), before = loads;
    await notice(page).getByRole('button', { name: 'Reload', exact: true }).click();
    await expectOwnerShown(page, 'Aster');
    await page.waitForTimeout(500);
    expect(loads - before).toBe(1);
    expect(page.url()).toBe(address);
  });

  test('hides the notice under the Change look dialog', async ({ page }) => {
    const context = page.context();
    await seedSession(context);
    await quietArrivals(context);
    const look: GameMessage = { ...NOTES[2], action: 'change-look' };
    const messages = [ADMIN, NOTES[0], NOTES[1], look, NOTES[3]];
    const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'patches-1' }, owner: { ...structuredClone(ownerFixture), inbox: inbox(messages) },
      messages, patches: PATCHES, latestPatch: NEWER_PATCH });
    await openLive(page);
    await expect(notice(page)).toContainText(`Patch ${NEWER_PATCH}`);
    await messagesButton(page).click();
    await panelOf(page).locator('[data-message-row="2"]').click();
    await panelOf(page).getByRole('button', { name: 'Change look', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Change your look', exact: true });
    await expect(dialog).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    await serverHas(page, live, LATER_PATCH);
    await expect(notice(page)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(notice(page)).toContainText(`Patch ${LATER_PATCH}`);
  });

  test('offers Reload in the menu and the history while behind', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const live = await player(page);
    await openLive(page);
    await serverHas(page, live, NEWER_PATCH);
    await expect(notice(page)).toBeVisible();
    const menu = await openChipMenu(page);
    const behind = menu.locator('[data-patch-behind]');
    // The open menu offers Reload itself: the notice under it steps aside (the menu's glass would show it through), its controls with it.
    await expect(notice(page)).toHaveCount(0);
    await expect(page.locator('[data-patch-notice] button').first()).toBeHidden();
    await expect(behind).toContainText(`Patch ${NEWER_PATCH} is out`);
    await expect(behind.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    await expectNamedControls(menu, 'the account menu while behind');
    expect(await contrastIssues(menu), 'the account menu while behind').toEqual([]);
    await reviewShot(page, testInfo, 'patch-menu-behind');
    await menu.getByRole('button', { name: /^Patch history/ }).click();
    const panel = panelOf(page);
    await expect(history(panel)).toBeVisible();
    await expect(panel.getByText(`You are playing Patch ${PATCH} · Patch ${NEWER_PATCH} is out`, { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    await expectNamedControls(panel, 'Patch history');
    expect(await contrastIssues(panel), 'Patch history').toEqual([]);
    await reviewShot(page, testInfo, 'patch-history-behind');
    await expect(notice(page)).toHaveCount(0);
    // Closed, the notice is back.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(notice(page)).toBeVisible();
  });

  test('announces a patch that comes out while the menu is open, without drawing the notice over it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const live = await player(page);
    await openLive(page);
    const menu = await openChipMenu(page);
    await serverHas(page, live, NEWER_PATCH);
    await expect(menu.locator('[data-patch-behind]')).toContainText(`Patch ${NEWER_PATCH} is out`);
    // The live region holds the words (a screen reader hears them now), drawn nowhere and with no control to reach under the menu.
    const region = page.getByRole('status').filter({ hasText: `Patch ${NEWER_PATCH}` });
    await expect(region).toHaveCount(1);
    const box = (await region.boundingBox())!;
    expect(box.width * box.height).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-patch-notice] button')).toHaveCount(2);
    for (const button of await page.locator('[data-patch-notice] button').all()) await expect(button).toBeHidden();
    // Closed, the notice shows with its controls.
    await chipToggle(page).click();
    await expect(notice(page)).toBeVisible();
    expect((await notice(page).boundingBox())!.width).toBeGreaterThan(100);
  });

  test('reads older patches 20 at a time', async ({ page }) => {
    const live = await player(page);
    // 25 patches, 1.0 to 1.24: the history reads the newest 20, then the 5 older ones.
    live.setPatches(Array.from({ length: 25 }, (_, i) => ({ number: `1.${i}`, sortKey: 1_000_000 + i * 1_000, title: `Patch title ${i}`,
      releasedAtMs: at(9, 1 + i), messageId: null, features: [`Feature of 1.${i}.`] })).reverse());
    await openLive(page);
    const panel = await openHistoryFromMenu(page);
    const buttons = panel.locator('[data-patch]');
    await expect(buttons).toHaveCount(20);
    await expect(disclosure(panel, '1.24')).toHaveAttribute('aria-expanded', 'true');
    await panel.getByRole('button', { name: 'Older patches', exact: true }).click();
    await expect(buttons).toHaveCount(25);
    expect(await buttons.evaluateAll(els => els.map(el => el.getAttribute('data-patch')))).toEqual(Array.from({ length: 25 }, (_, i) => `1.${24 - i}`));
    await expect(panel.getByRole('button', { name: 'Older patches', exact: true })).toHaveCount(0);
    const reads = live.requests.filter(r => r.table === 'patches' && r.query.get('select')?.includes('patch_features'));
    // The first page asks for no key (React's development double mount may ask twice), the next one for patches older than 1.5.
    const keys = reads.map(r => r.query.get('sort_key'));
    expect([...new Set(keys)]).toEqual([null, 'lt.1005000']);
    expect(keys.filter(key => key !== null)).toEqual(['lt.1005000']);
  });

  test('shows no notice when up to date or ahead', async ({ page }) => {
    const live = await player(page);
    await openLive(page);
    for (const latest of [PATCH, '1.4', '1.3.1', null]) {
      await serverHas(page, live, latest);
      await expect(notice(page), String(latest)).toHaveCount(0);
      const menu = await openChipMenu(page);
      await expect(menu.locator('[data-patch-behind]'), String(latest)).toHaveCount(0);
      await expect(menu.getByText(`Patch ${PATCH}`, { exact: true })).toBeVisible();
      await chipToggle(page).click();
    }
  });

  test('shows the notice to a visitor', async ({ page }) => {
    const context = page.context();
    await quietArrivals(context);
    const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'patches-1' }, patches: PATCHES, latestPatch: PATCH });
    await page.goto('/game/');
    await expect(cornerChip(page).getByRole('button', { name: /^Sign in (with Google )?to join$/ })).toBeVisible();
    await serverHas(page, live, NEWER_PATCH);
    await expect(notice(page)).toContainText(`Patch ${NEWER_PATCH}`);
  });

  test('phone 360 × 740: the notice under the chip, the history in the panel', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const live = await player(page);
    await openLive(page);
    await serverHas(page, live, NEWER_PATCH);
    await expect(notice(page)).toBeVisible();
    // The short form on a phone.
    expect((await notice(page).locator('p').innerText()).trim()).toBe(`Patch ${NEWER_PATCH} is out`);
    const box = (await notice(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(348);
    const chip = (await cornerChip(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(chip.y + chip.height);
    for (const name of ['Reload', 'Later']) {
      const target = (await notice(page).getByRole('button', { name, exact: true }).boundingBox())!;
      expect(target.width, name).toBeGreaterThanOrEqual(44);
      expect(target.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await noHorizontalScroll(page)).toBe(true);
    await reviewShot(page, testInfo, 'patch-notice-360');
    // The menu's patch row and its Reload.
    const menu = await openChipMenu(page);
    await expect(menu.locator('[data-patch-behind]')).toContainText(`Patch ${NEWER_PATCH} is out`);
    for (const button of await menu.locator('[data-patch-row] button, [data-patch-behind] button').all()) {
      const target = (await button.boundingBox())!;
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    await reviewShot(page, testInfo, 'patch-menu-360');
    // The history fits the panel and the screen.
    await menu.getByRole('button', { name: /^Patch history/ }).click();
    const panel = panelOf(page);
    await expect(history(panel)).toBeVisible();
    const area = (await panel.boundingBox())!;
    expect(area.x).toBeGreaterThanOrEqual(0);
    expect(area.x + area.width).toBeLessThanOrEqual(360);
    expect(area.y + area.height).toBeLessThanOrEqual(740);
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const button of await panel.locator('[data-patch]').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noHorizontalScroll(page)).toBe(true);
    await reviewShot(page, testInfo, 'patch-history-360');
  });

  test('phone 360 × 740 with an arrival: the notice below the banner', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const context = page.context();
    await seedSession(context);
    // A newcomer in orientation, not yet announced on this device: the arrival banner stacks under the chip.
    const aster = worldFixture.actors[0];
    const ursa = { ...aster, gladiatorId: 'a0000000-0000-4000-8000-000000000001', name: 'Ursa', location: 'orientation' as const, activityId: null,
      activityStatus: 'active' as const, startsAtMs: worldFixture.serverNowMs - 60_000, endsAtMs: worldFixture.serverNowMs - 60_000 + 4_800_000 };
    await routeLiveReads(context, { world: { ...worldFixture, revision: 'patches-1', actors: [{ ...aster, location: 'camp' }, ursa] },
      owner: { ...structuredClone(ownerFixture), inbox: inbox([]) }, latestPatch: NEWER_PATCH });
    await openLive(page);
    const banner = page.getByTestId('arrival-banner');
    await expect(banner).toBeVisible();
    await expect(notice(page)).toBeVisible();
    const b = (await banner.boundingBox())!, n = (await notice(page).boundingBox())!;
    expect(n.y).toBeGreaterThanOrEqual(b.y + b.height);
    expect(n.x + n.width).toBeLessThanOrEqual(348);
    expect(await noHorizontalScroll(page)).toBe(true);
    await reviewShot(page, testInfo, 'patch-notice-banner-360');
  });
});
