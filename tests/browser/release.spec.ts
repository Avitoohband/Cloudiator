import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from './fixtures';
import type { BattleLog, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { MENUS } from '../../src/features/shell/menus';
import { ARENA_OWNER } from '../fixtures/arena-build';
import { itemFixture, ownerFixture, worldFixture } from '../fixtures/domain';
import { EXPEDITION_FIXTURES } from '../fixtures/expedition-ids';
import { MARKET_ROWS } from '../fixtures/market';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { a11yShot, contrastIssues, expectNamedControls, focusDrops, focusedElement, noHorizontalScroll, watchFocus } from './a11y-helpers';
import { SUPABASE_URL, emptyWorld, isPresence, routeLiveReads, seedSession, testUser } from './live-routes';
import { reviewShot, reviewShot360 } from './review-shots';
import { cornerChip, creationDialog, expectOwnerShown, joinButton, menuDialog, openMenu, railMenus, revealRail, touchLayout } from './shell-helpers';

// Task 23.5: the release browser spec. The game is usable by keyboard and screen reader (every control named, the focus
// never left on <body>, validation messages linked to their fields), readable (WCAG contrast), calm with reduced motion,
// and fits a 360 px phone; and the replay's unavailable state is checked in the production build, which the replay suite
// skips. Plan Decision 8: no new package, so names come from Playwright's accessibility tree, contrast from computed styles.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
/** The fixture preview's server time (the world fixture's). */
const NOW = worldFixture.serverNowMs;
const LABELS = MENUS.map(m => m.label);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
/** The fixture camp, ready, with the fixture owner shown (or as a visitor). */
async function openFixtureCamp(page: Page, url = '/game/?mode=fixture') {
  await page.goto(url);
  await campReady(page);
  if (!url.includes('as=visitor')) await expectOwnerShown(page, 'Aster');
  await page.waitForFunction(() => !!window.__cloudiatorShell);
}
/** Waits for an opening slide, a sheet's rise or a scene's fade (anything animating in `locator`) to end. */
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished))); return locator; };
const scene = (page: Page, name: 'Replay' | 'Expedition') => page.getByRole('dialog', { name, exact: true });
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
const shot = a11yShot;

/** A signed-in player in live mode (seeded session, test transport), with an inventory for every form: Build, Schedule, Shop, Market. */
async function livePlayer(page: Page, owner: OwnerState = structuredClone(ARENA_OWNER)) {
  const context = page.context();
  await seedSession(context);
  const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' }, owner, market: MARKET_ROWS.map(o => structuredClone(o)) });
  const commands: GameCommand[] = [];
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    // The player's presence (Task 23.9) is the live transport's.
    if (route.request().method() !== 'POST' || isPresence(route.request())) return route.fallback();
    commands.push(route.request().postDataJSON() as GameCommand);
    // Every command is refused as invalid input: these checks are about how a refusal is shown, never about its effect.
    return route.fulfill({ status: 409, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'invalid' }) });
  });
  return { live, commands };
}
/** Aster with 30 money (too little for any shop item) and a listable axe. */
function poorPlayer(): OwnerState {
  const state = structuredClone(ARENA_OWNER);
  state.wallets.money = 30;
  const axe: ItemInstance = { ...itemFixture(CATALOG_V1.items['axe:5:common']), id: randomUUID() };
  state.inventory.push(axe);
  return state;
}

test.describe('release accessibility in the fixture preview', () => {
  test.skip(production, 'These checks use the fixture preview.');

  test('keeps Schedule enabled and named "Schedule" when actor art fails', async ({ page }, testInfo) => {
    // R2 (plan Task 23 Step 1; Task 13 plan note): the camp art fails, the menus do not.
    const aborted: string[] = [];
    await page.route('**/assets/actors/**', route => { aborted.push(route.request().url()); return route.abort(); });
    await page.goto('/game/?mode=fixture');
    await expect(page.getByText(/The camp art could not load/)).toBeVisible({ timeout: 45_000 });
    expect(aborted.length).toBeGreaterThan(0);
    await expectOwnerShown(page, 'Aster');
    await revealRail(page);
    const schedule = railMenus(page).getByRole('button', { name: 'Schedule', exact: true });
    await expect(schedule).toBeEnabled();
    await expect(schedule).toHaveAccessibleName('Schedule');
    await schedule.click();
    await expect(menuDialog(page, 'Schedule')).toBeVisible();
    await expect(menuDialog(page, 'Schedule').getByRole('heading', { name: 'Repeating schedule' })).toBeVisible();
    await shot(page, testInfo, 'art-failed-schedule');
  });

  test('completes a keyboard-only journey through every menu with focus never on body', { tag: '@render' }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The pointer layout; the touch layout has its own journey below.');
    test.setTimeout(240_000);
    await watchFocus(page);
    // A sign-in that came back cancelled leaves a notice with a Dismiss button: one more control to leave by keyboard.
    await openFixtureCamp(page, '/game/?mode=fixture&signin=cancelled');
    const press = (key: string) => page.keyboard.press(key);
    const icon = (label: string) => railMenus(page).getByRole('button', { name: label, exact: true });
    const inside = (locator: Locator) => locator.evaluate(el => el.contains(document.activeElement));

    // The first Tab reaches the skip link, which shows; the next one the first menu icon, which reveals the rail.
    await press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect.soft(skip, 'the first Tab reaches the skip link').toBeFocused();
    if (await skip.evaluate(el => el === document.activeElement)) {
      expect(await skip.evaluate(el => getComputedStyle(el).clipPath)).toBe('none');
      await shot(page, testInfo, 'skip-link');
      await press('Tab');
    }
    await expect(icon('My gladiator')).toBeFocused();
    await expect(page.getByTestId('menu-rail')).toHaveAttribute('data-revealed', 'true');

    // Every menu: Enter opens it with the focus inside; Tab walks every control in it (each named, never <body>); Escape
    // closes it and gives the focus back to its icon; Tab moves on to the next icon.
    for (const [i, label] of LABELS.entries()) {
      await expect(icon(label)).toBeFocused();
      await press('Enter');
      const panel = menuDialog(page, label);
      await expect(panel).toBeVisible();
      expect(await inside(panel), `${label} takes the focus`).toBe(true);
      let steps = 0;
      for (; steps < 300; steps++) {
        await press('Tab');
        const where = await page.evaluate(() => {
          const el = document.activeElement;
          return { body: !el || el === document.body, tab: el?.getAttribute('role') === 'tab' ? el.textContent : null, selected: el?.getAttribute('aria-selected') };
        });
        expect(where.body, `${label}: Tab ${steps + 1} left the focus on <body>`).toBe(false);
        if (!(await inside(panel))) break;
        // The Marketplace tabs answer the arrow keys (one tab stop for the list).
        if (where.tab === 'Browse' && where.selected === 'true') {
          await press('ArrowRight');
          await expect(panel.getByRole('tab', { name: 'My listings' })).toBeFocused();
          await press('ArrowRight');
          await expect(panel.getByRole('tab', { name: 'Sell' })).toBeFocused();
          await expect(panel.getByRole('tab', { name: 'Sell' })).toHaveAttribute('aria-selected', 'true');
          await press('Home');
          await expect(panel.getByRole('tab', { name: 'Browse' })).toBeFocused();
        }
      }
      expect(steps, `${label}: the focus leaves the panel by Tab`).toBeLessThan(300);
      await press('Escape');
      await expect(panel).toBeHidden();
      await expect(icon(label)).toBeFocused();
      if (i < LABELS.length - 1) await press('Tab');
    }

    // The camera buttons, then the corner chip: Enter opens its small menu, Escape closes it back to the chip.
    for (const name of ['Zoom in', 'Zoom out', 'Reset zoom']) {
      await press('Tab');
      await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
    }
    await press('Tab');
    const chip = cornerChip(page).locator('button[aria-expanded]');
    await expect(chip).toBeFocused();
    await press('Enter');
    await expect(cornerChip(page).getByRole('group', { name: 'Account' })).toBeVisible();
    await press('Escape');
    await expect(chip).toBeFocused();
    // The sign-in notice's Dismiss: the notice goes, and the focus stays on the page.
    await press('Tab');
    await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused();
    await press('Enter');
    await expect(page.getByText('Google sign-in was canceled. You can keep watching the camp.')).toHaveCount(0);
    expect(await focusedElement(page), 'Dismiss leaves the focus on the page').not.toBe('body');

    // A replay scene from Results: Back to camp takes the focus, the replay keys work, Escape returns to the Replay button.
    for (let n = 0; n < 40 && !(await icon('Results').evaluate(el => el === document.activeElement)); n++) await press('Shift+Tab');
    await expect(icon('Results')).toBeFocused();
    await press('Enter');
    const results = menuDialog(page, 'Results');
    const replayButton = results.getByRole('button', { name: /^Replay: / }).first();
    await expect(replayButton).toBeVisible();
    for (let n = 0; n < 20 && !(await replayButton.evaluate(el => el === document.activeElement)); n++) await press('Tab');
    await expect(replayButton).toBeFocused();
    await press('Enter');
    const replay = scene(page, 'Replay');
    await expect(replay).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to camp' })).toBeFocused();
    await page.waitForFunction(() => !!window.__cloudiatorReplay?.state(), null, { timeout: 45_000 });
    // Tab walks the scene's controls (the page behind the modal scene is inert).
    const skipToResult = replay.getByRole('button', { name: 'Skip to result' });
    for (let n = 0; n < 8 && !(await skipToResult.evaluate(el => el === document.activeElement)); n++) {
      await press('Tab');
      expect(await inside(replay), 'the modal scene keeps the focus').toBe(true);
    }
    await expect(skipToResult).toBeFocused();
    const playing = await page.evaluate(() => window.__cloudiatorReplay!.state().playing);
    await press('k');
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay!.state().playing)).toBe(!playing);
    await press('End');
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay!.state().finished)).toBe(true);
    await press('Escape');
    await expect(replay).toHaveCount(0);
    await expect(replayButton).toBeFocused();
    await press('Escape');
    await expect(icon('Results')).toBeFocused();

    // A profile card from the Gladiators list: Enter opens it with the focus, Escape gives the focus back to the row.
    await press('Tab');
    await expect(icon('Gladiators')).toBeFocused();
    await press('Enter');
    const roster = menuDialog(page, 'Gladiators');
    const profile = roster.getByRole('button', { name: /^Profile: / }).first();
    for (let n = 0; n < 20 && !(await profile.evaluate(el => el === document.activeElement)); n++) await press('Tab');
    await expect(profile).toBeFocused();
    await press('Enter');
    const card = page.getByRole('dialog', { name: /^Profile: / });
    await expect(card).toBeFocused();
    await press('Tab');
    await expect(card.getByRole('button', { name: 'Close profile' })).toBeFocused();
    await press('Escape');
    await expect(card).toHaveCount(0);
    await expect(profile).toBeFocused();
    await press('Escape');
    await expect(icon('Gladiators')).toBeFocused();

    // Back to the skip link with Shift+Tab: Enter moves the focus into the camp (the main landmark), never to <body>.
    for (let n = 0; n < 12 && !(await skip.evaluate(el => el === document.activeElement)); n++) await press('Shift+Tab');
    await expect(skip).toBeFocused();
    await press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
    expect(new URL(page.url()).hash, 'the skip link adds no history entry').toBe('');
    await press('Tab');
    await expect(page.getByRole('application')).toBeFocused();

    expect(await focusDrops(page), 'the focus never fell to <body>').toEqual([]);
  });

  test('completes the touch layout journey by keyboard with focus never on body', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'The touch layout runs on the phone project.');
    await watchFocus(page);
    await openFixtureCamp(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Tab');
    const burger = page.getByRole('button', { name: 'Menus', exact: true });
    await expect(burger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(burger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    const first = railMenus(page).getByRole('button', { name: 'My gladiator', exact: true });
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    const sheet = menuDialog(page, 'My gladiator');
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    // The row was hidden behind the sheet, so the focus goes to ☰ (or back to the icon when the row shows).
    expect(['<button> Menus', '<button> My gladiator']).toContain(await focusedElement(page));
    expect(await focusDrops(page)).toEqual([]);
  });

  test('names every focusable control and links each validation message to its field', { tag: '@render' }, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    // The fixture camp: the rail, the chip, every menu (with an Arena card and the archived season), a profile card and both scenes.
    await openFixtureCamp(page);
    await revealRail(page);
    await expectNamedControls(page.getByTestId('menu-rail'), 'the rail');
    await expectNamedControls(cornerChip(page), 'the corner chip');
    for (const label of LABELS) {
      const panel = await settled(await openMenu(page, label));
      if (label === 'Arena') await expect(panel.getByRole('table', { name: 'Bronze league standings' }).locator('tbody tr')).toHaveCount(50, { timeout: 45_000 });
      await expectNamedControls(panel, label);
    }
    const arena = await openMenu(page, 'Arena');
    await arena.getByRole('button', { name: /^Arena: Aster beats Varro/ }).click();
    await expect(arena.getByRole('article', { name: 'Aster' })).toBeVisible();
    await expectNamedControls(arena, 'Arena with a card');
    const roster = await openMenu(page, 'Gladiators');
    await roster.getByRole('button', { name: /^Profile: / }).first().click();
    await expectNamedControls(page.getByRole('dialog', { name: /^Profile: / }), 'a profile card');
    await page.goto(`/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await page.waitForFunction(() => !!window.__cloudiatorReplay?.state(), null, { timeout: 45_000 });
    await expectNamedControls(scene(page, 'Replay'), 'the replay scene');
    await page.goto(`/game/?mode=fixture&view=expedition&activity=${EXPEDITION_FIXTURES.woodland.activityId}`);
    await expect(scene(page, 'Expedition').getByRole('heading', { name: 'Activity log' })).toBeVisible({ timeout: 45_000 });
    await expectNamedControls(scene(page, 'Expedition'), 'the expedition scene');

    // A live player's forms: each validation message names its field (aria-invalid) and describes it (aria-describedby).
    const { commands } = await livePlayer(page, poorPlayer());
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    // Build: more attribute points than earned.
    const mine = await openMenu(page, 'My gladiator');
    await expectNamedControls(mine, 'My gladiator (player)');
    const strength = mine.getByRole('spinbutton', { name: 'strength', exact: true });
    await strength.fill('9');
    await expect(mine.getByText(/^Review your build:/)).toBeVisible();
    await expect(strength).toHaveAttribute('aria-invalid', 'true');
    await expect(strength).toHaveAccessibleDescription(/Review your build/);
    await expect(mine.getByRole('button', { name: 'Queue build' })).toHaveAccessibleDescription(/Review your build/);
    // Not a whole number (fix round 1, I1): "invalid-input" marks and describes that field alone.
    const agility = mine.getByRole('spinbutton', { name: 'agility', exact: true });
    for (const value of ['1.5', '-1']) {
      await strength.fill(value);
      await expect(mine.getByText('Review your build: invalid-input.'), value).toBeVisible();
      await expect(strength, value).toHaveAttribute('aria-invalid', 'true');
      await expect(strength, value).toHaveAccessibleDescription('Review your build: invalid-input.');
      await expect(agility, value).not.toHaveAttribute('aria-invalid', 'true');
    }
    await strength.fill('2');
    await expect(mine.getByText(/^Review your build:/)).toHaveCount(0);
    await expect(strength).not.toHaveAttribute('aria-invalid', 'true');
    // Schedule: one Save for the day, disabled until a part is changed; the server refuses the day, and the changed morning is marked.
    const schedule = await openMenu(page, 'Schedule');
    await expectNamedControls(schedule, 'Schedule (player)');
    const saveDay = schedule.getByRole('button', { name: 'Save schedule', exact: true });
    await expect(saveDay).toBeDisabled();
    const morning = schedule.getByRole('combobox', { name: 'morning activity' });
    await morning.selectOption('rest');
    await expect(saveDay).toBeEnabled();
    await saveDay.click();
    await expect(schedule.getByRole('alert')).toHaveText('Schedule change rejected: invalid.');
    expect(commands.at(-1)).toMatchObject({ kind: 'edit-day-schedule', day: { morning: { kind: 'rest' } } });
    await expect(morning).toHaveAttribute('aria-invalid', 'true');
    await expect(morning).toHaveAccessibleDescription(/Schedule change rejected: invalid/);
    await expect(schedule.getByRole('combobox', { name: 'evening activity' })).not.toHaveAttribute('aria-invalid', 'true');
    // Shop: a quantity out of range, and offers too dear for the wallet.
    const shops = await openMenu(page, 'Inventory and shops');
    await expectNamedControls(shops, 'Inventory and shops (player)');
    const quantity = shops.getByRole('spinbutton', { name: 'Purchase quantity' });
    await quantity.fill('0');
    await expect(quantity).toHaveAttribute('aria-invalid', 'true');
    await expect(quantity).toHaveAccessibleDescription(/Choose a whole quantity from 1 to 60/);
    await quantity.fill('1');
    await expect(quantity).not.toHaveAttribute('aria-invalid', 'true');
    const buySword = shops.getByRole('button', { name: 'Buy Sword', exact: true });
    await expect(buySword).toBeDisabled();
    await expect(buySword).toHaveAccessibleDescription(/Not enough available money/);
    // Market: a Buy the wallet cannot pay, and a fractional price on the Sell tab.
    const market = await openMenu(page, 'Marketplace');
    const spear = market.getByRole('button', { name: /^Buy Spear for/ });
    await expect(spear).toBeDisabled();
    await expect(spear).toHaveAccessibleDescription(/Not enough available money/);
    await market.getByRole('tab', { name: 'Sell', exact: true }).click();
    const sell = market.getByRole('tabpanel', { name: 'Sell' });
    await sell.getByRole('radio', { name: /^Axe/ }).check();
    const price = sell.getByRole('spinbutton', { name: 'Price in money' });
    await price.fill('1.5');
    await expect(price).toHaveAttribute('aria-invalid', 'true');
    await expect(price).toHaveAccessibleDescription(/A whole price from 2 to 1,000,000,000\..*Enter a whole price from 2 to 1,000,000,000\./);
    await expect(sell.getByRole('button', { name: 'List for sale' })).toHaveAccessibleDescription(/Enter a whole price/);
    // A whole price under the lowest one is told why the lowest is 2 (launch feedback): the field and List for sale say so.
    await price.fill('1');
    await expect(price).toHaveAttribute('aria-invalid', 'true');
    await expect(price).toHaveAccessibleDescription(/A whole price from 2 to 1,000,000,000\..*The lowest price is 2 money, so you always receive something after the fee\./);
    await expect(sell.getByRole('button', { name: 'List for sale' })).toHaveAccessibleDescription(/The lowest price is 2 money/);
    await price.fill('100');
    await expect(price).not.toHaveAttribute('aria-invalid', 'true');
    await expectNamedControls(market, 'Marketplace (player)');
    await shot(page, testInfo, 'market-sell-valid');
  });

  test('links the creation form messages to their fields', async ({ page }, testInfo) => {
    // Signed in without a gladiator: the creation dialog. The server refuses every creation as invalid input here, which is the
    // only way the point fields can be marked invalid: Create is off until all 10 points are spent (launch feedback).
    await seedSession(page.context());
    await routeLiveReads(page.context(), { world: emptyWorld(), owner: null });
    await page.context().route(`${SUPABASE_URL}/functions/v1/game-command`, route => {
      if (route.request().method() !== 'POST' || isPresence(route.request())) return route.fallback();
      return route.fulfill({ status: 409, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'invalid' }) });
    });
    await page.goto('/game/');
    const dialog = creationDialog(page);
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    await expectNamedControls(dialog, 'the creation dialog');
    // Decision 8 (fix round 1, I3): the dialog's structure, by role and name. The points start at 0 with Create off.
    await expect(dialog).toMatchAriaSnapshot(`
      - dialog "Create your gladiator":
        - heading "Create your gladiator" [level=2]
        - group:
          - textbox "Gladiator name"
          - group "Choose a class":
            - radio "Berserker" [checked]
            - radio "Guardian"
            - radio "Duelist"
          - group "Spend 10 starting points":
            - status: 10 of 10 left
            - button "Suggested for Berserker"
            - button "Reset points"
            - button "Remove a point from Strength"
            - spinbutton "Strength points": "0"
            - button "Add a point to Strength"
            - button "Remove a point from Agility"
            - spinbutton "Agility points": "0"
            - button "Add a point to Agility"
            - button "Remove a point from Vitality"
            - spinbutton "Vitality points": "0"
            - button "Add a point to Vitality"
            - button "Remove a point from Endurance"
            - spinbutton "Endurance points": "0"
            - button "Add a point to Endurance"
            - button "Remove a point from Precision"
            - spinbutton "Precision points": "0"
            - button "Add a point to Precision"
            - status
        - button "Not now"
        - button "Create gladiator" [disabled]
    `);
    const create = dialog.getByRole('button', { name: 'Create gladiator' });
    await expect(create).toBeDisabled();
    await expect(create).toHaveAccessibleDescription('Spend 10 more points to continue.');
    // Nothing is marked invalid before a create attempt, not even the empty points.
    for (const key of ['Strength', 'Agility', 'Vitality', 'Endurance', 'Precision']) {
      await expect(dialog.getByRole('spinbutton', { name: `${key} points` })).not.toHaveAttribute('aria-invalid', 'true');
    }
    await expect(dialog.getByRole('textbox', { name: 'Gladiator name' })).not.toHaveAttribute('aria-invalid', 'true');
    expect(await contrastIssues(await settled(dialog)), 'the creation dialog with no points spent').toEqual([]);
    await shot(page, testInfo, 'creation-dialog-empty');
    // The name's refusal marks the name, described by it, and not the points.
    const name = dialog.getByRole('textbox', { name: 'Gladiator name' });
    await dialog.getByRole('button', { name: 'Suggested for Berserker' }).click();
    await name.fill('x');
    await create.click();
    const error = dialog.getByRole('alert');
    await expect(error).toHaveText('Use 3–20 English letters, digits, spaces, underscores or hyphens.');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(/3–20 letters, digits.*Use 3–20 English letters/);
    const strength = dialog.getByRole('spinbutton', { name: 'Strength points' });
    await expect(strength).not.toHaveAttribute('aria-invalid', 'true');
    // The server refusing the points (or the name) after an attempt marks every point field, described by the refusal.
    await name.fill('Brutus');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await create.click();
    await expect(error).toHaveText('Check your name and allocate exactly 10 whole points.');
    for (const key of ['Strength', 'Agility', 'Vitality', 'Endurance', 'Precision']) {
      const field = dialog.getByRole('spinbutton', { name: `${key} points` });
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAccessibleDescription(/allocate exactly 10 whole points/);
    }
    // Spending the points differently starts over: nothing is marked invalid again.
    await strength.fill('2');
    await expect(strength).not.toHaveAttribute('aria-invalid', 'true');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    // Contrast in the other states of the form: a capped number (its status line) and all points spent (the preview).
    // Strength held 5 (the suggestion) when it took the focus, so the line names its cap: 2 + the 3 left.
    await strength.fill('99');
    await expect(dialog.getByRole('status').filter({ hasText: 'Strength can take at most 5, so it was set to 5.' })).toBeVisible();
    expect(await contrastIssues(await settled(dialog)), 'the creation dialog with a capped number').toEqual([]);
    await dialog.getByRole('button', { name: 'Suggested for Berserker' }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'All 10 spent' })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Starting build preview' })).toBeVisible();
    expect(await contrastIssues(await settled(dialog)), 'the creation dialog with all points spent').toEqual([]);
    await shot(page, testInfo, 'creation-dialog');
  });

  test('keeps the focus on a point stepper that reaches its limit, and names every point control', async ({ page }) => {
    // Task 23.5 (focus never left on <body>), launch feedback goal 1: the last + and the last − stay focusable (aria-disabled)
    // instead of being disabled, which would drop a keyboard user's focus.
    await watchFocus(page);
    await seedSession(page.context());
    await routeLiveReads(page.context(), { world: emptyWorld(), owner: null });
    await page.goto('/game/');
    const dialog = creationDialog(page);
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    const counter = dialog.getByRole('status').filter({ hasText: /of 10 left|All 10 spent/ });
    const add = dialog.getByRole('button', { name: 'Add a point to Agility', exact: true });
    const remove = dialog.getByRole('button', { name: 'Remove a point from Agility', exact: true });
    await dialog.getByRole('spinbutton', { name: 'Strength points' }).fill('9');
    await expect(counter).toHaveText('1 of 10 left');
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(counter).toHaveText('All 10 spent');
    await expect(add).toHaveAttribute('aria-disabled', 'true');
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(counter).toHaveText('All 10 spent');
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect(counter).toHaveText('1 of 10 left');
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(remove).toBeFocused();
    await dialog.getByRole('button', { name: 'Reset points' }).focus();
    await page.keyboard.press('Enter');
    await expect(counter).toHaveText('10 of 10 left');
    await expect(dialog.getByRole('button', { name: 'Reset points' })).toBeFocused();
    expect(await focusDrops(page), 'the focus never fell to <body>').toEqual([]);
  });

  for (const how of ['Escape', 'Enter on Not now'] as const) {
    test(`keeps the focus on the page when the first-visit creation dialog is dismissed by keyboard (${how})`, async ({ page }) => {
      // Fix round 1, I2: the dialog opens on its own after sign-in, when nothing has the focus, so the browser has nothing
      // to give the focus back to. It goes to the chip's "Create your gladiator", which offers the dialog again.
      await watchFocus(page);
      await seedSession(page.context());
      await routeLiveReads(page.context(), { world: emptyWorld(), owner: null });
      await page.goto('/game/');
      const dialog = creationDialog(page);
      await expect(dialog).toBeVisible({ timeout: 45_000 });
      await expect(dialog.getByRole('heading', { name: 'Create your gladiator' })).toBeFocused();
      if (how === 'Escape') await page.keyboard.press('Escape');
      else {
        await dialog.getByRole('button', { name: 'Not now' }).focus();
        await page.keyboard.press('Enter');
      }
      await expect(dialog).toBeHidden();
      const offer = cornerChip(page).getByRole('button', { name: 'Create your gladiator', exact: true });
      await expect(offer).toBeFocused();
      expect(await focusDrops(page), 'the focus never fell to <body>').toEqual([]);
      // The offer reopens the dialog by keyboard.
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
    });
  }

  test("records a focus left on <body> (the focus watcher's own check)", async ({ page }) => {
    // Fix round 1: a negative control for `watchFocus`. A page with no focus rescue (the replay page): the focused
    // button is removed, so the focus falls to <body>, and the watcher records exactly that one drop.
    await watchFocus(page);
    await page.goto('/replay/?activity=not-an-activity');
    await expect(page.locator('main#main')).toContainText('No fight was found for this link.');
    expect(await focusDrops(page)).toEqual([]);
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Short-lived';
      document.body.append(button);
      button.focus();
      button.remove();
    });
    await expect.poll(() => focusDrops(page)).toEqual([{ from: '<button> Short-lived', after: 'a DOM change' }]);
  });

  test('pins the rail, a menu frame, a scene and the profile card in accessibility snapshots', { tag: '@render' }, async ({ page }, testInfo) => {
    // Plan Decision 8 (fix round 1, I3). The rail: the eight menus, and the camera controls on a pointer only.
    await openFixtureCamp(page);
    await revealRail(page);
    const rail = page.getByTestId('menu-rail');
    await expect(rail.getByRole('navigation', { name: 'Game menus' })).toMatchAriaSnapshot(`
      - navigation "Game menus":
        - /children: equal
        - button "My gladiator"
        - button "Schedule"
        - button "Inventory and shops"
        - button "Marketplace"
        - button "Arena"
        - button "Tournaments"
        - button "Results"
        - button "Gladiators"
    `);
    if (await touchLayout(page)) {
      await expect(page.getByRole('button', { name: 'Menus', exact: true })).toMatchAriaSnapshot('- button "Menus" [expanded]');
      await expect(rail.getByRole('group', { name: 'Camera controls' })).toHaveCount(0);
    } else {
      await expect(rail.getByRole('group', { name: 'Camera controls' })).toMatchAriaSnapshot(`
        - group "Camera controls":
          - /children: equal
          - button "Zoom in"
          - button "Zoom out"
          - button "Reset zoom"
      `);
    }
    // A menu's frame: the labelled dialog, its title, its Close button, then the panel's own heading.
    const schedule = await openMenu(page, 'Schedule');
    await expect(schedule).toMatchAriaSnapshot(`
      - dialog "Schedule":
        - paragraph: Schedule
        - button "Close"
        - heading "Repeating schedule" [level=2]
    `);
    // A profile card.
    const roster = await openMenu(page, 'Gladiators');
    await roster.getByRole('button', { name: 'Profile: Varro', exact: true }).first().click();
    const card = page.getByRole('dialog', { name: 'Profile: Varro' });
    await expect(card.getByRole('heading', { name: 'Varro' })).toBeVisible();
    await expect(card).toMatchAriaSnapshot(`
      - 'dialog "Profile: Varro"':
        - button "Close profile"
        - heading "Varro" [level=2]
        - term: Now
        - term: Rating
        - term: Equipped
        - button "Follow"
    `);
    // A replay scene over the camp.
    await page.goto(`/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await page.waitForFunction(() => !!window.__cloudiatorReplay?.state(), null, { timeout: 45_000 });
    await expect(scene(page, 'Replay')).toMatchAriaSnapshot(`
      - dialog "Replay":
        - button "Back to camp"
        - region "Aster vs Varro":
          - heading "Aster vs Varro" [level=2]
          - img
          - meter "Aster health"
          - meter "Varro health"
          - group "Replay controls":
            - button /^(Pause|Play)$/
            - button "Fast ×4"
            - button "Restart"
            - button "Skip to result"
          - slider "Replay position"
          - region "Result":
            - heading "Result" [level=3]
          - region "Fighters":
            - heading "Fighters" [level=3]
          - region "Combat log":
            - heading "Combat log" [level=3]
    `);
    void testInfo;
  });

  test('meets 4.5:1 contrast on panel text and 3:1 on controls', { tag: '@render' }, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await openFixtureCamp(page);
    // The rail with a focused icon: its focus ring against the rail.
    if (!(await touchLayout(page))) {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(railMenus(page).getByRole('button', { name: 'My gladiator' })).toBeFocused();
      expect(await contrastIssues(page.getByTestId('menu-rail'), { focusRing: true }), 'the rail').toEqual([]);
    }
    expect(await contrastIssues(cornerChip(page)), 'the corner chip').toEqual([]);
    for (const label of LABELS) {
      const panel = await settled(await openMenu(page, label));
      if (label === 'Arena') await expect(panel.getByRole('table', { name: 'Bronze league standings' }).locator('tbody tr')).toHaveCount(50, { timeout: 45_000 });
      expect(await contrastIssues(panel), label).toEqual([]);
    }
    // Seasons (C17): the picker, the progress bar and the archived season's medal pills.
    const arena = await settled(await openMenu(page, 'Arena'));
    const picker = arena.getByRole('combobox', { name: 'Season' });
    await picker.focus();
    expect(await contrastIssues(arena.getByRole('region', { name: 'Arena standings' }), { focusRing: true }), 'the season picker focused').toEqual([]);
    await shot(page, testInfo, 'season-picker-focus');
    await picker.selectOption({ label: 'Season 1 · ended Sat 26 Sep' });
    await expect(arena.getByRole('region', { name: 'Season 1 final standings' })).toBeVisible();
    expect(await contrastIssues(arena), 'the archived season').toEqual([]);
    await arena.getByRole('button', { name: /^Arena: Aster beats Varro/ }).click();
    expect(await contrastIssues(arena), 'an Arena card').toEqual([]);
    // A focused field and a focused button inside a panel, and the merchants' pressed button.
    const roster = await settled(await openMenu(page, 'Gladiators'));
    await roster.getByRole('searchbox', { name: 'Filter by name' }).focus();
    expect(await contrastIssues(roster, { focusRing: true }), 'the roster filter focused').toEqual([]);
    await shot(page, testInfo, 'roster-filter-focus');
    await roster.getByRole('button', { name: /^Profile: / }).first().click();
    expect(await contrastIssues(await settled(page.getByRole('dialog', { name: /^Profile: / }))), 'a profile card').toEqual([]);
    const shops = await settled(await openMenu(page, 'Inventory and shops'));
    // Reached by Tab, so the button shows its focus ring (:focus-visible).
    await shops.getByRole('button', { name: 'Weaponsmith' }).focus();
    await page.keyboard.press('Tab');
    await expect(shops.getByRole('button', { name: 'Armorer' })).toBeFocused();
    expect(await contrastIssues(shops.getByRole('region', { name: 'Shops' }), { focusRing: true }), 'the shops').toEqual([]);
    await shot(page, testInfo, 'shops-merchants');
    // The scenes.
    await page.goto(`/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    expect(await contrastIssues(await settled(scene(page, 'Replay')), { focusRing: true }), 'the replay scene').toEqual([]);
    await page.goto(`/game/?mode=fixture&view=expedition&activity=${EXPEDITION_FIXTURES.woodland.activityId}`);
    await expect(scene(page, 'Expedition').getByRole('heading', { name: 'Activity log' })).toBeVisible({ timeout: 45_000 });
    // Measured again until it holds: "Returned to camp" appears when the playback reaches camp and fades in over 600 ms,
    // which can begin after a single settle (measured mid-fade at 0.08 opacity once, 2026-10-24). A real failure persists.
    await expect.poll(async () => contrastIssues(await settled(scene(page, 'Expedition'))), { message: 'the expedition scene', timeout: 15_000 })
      .toEqual([]);
    // A visitor's chip and menus.
    await openFixtureCamp(page, '/game/?mode=fixture&as=visitor');
    expect(await contrastIssues(cornerChip(page)), 'the visitor chip').toEqual([]);
    for (const label of ['My gladiator', 'Marketplace']) expect(await contrastIssues(await settled(await openMenu(page, label))), `${label} (visitor)`).toEqual([]);
  });

  test('meets the contrast minimums in the player forms', { tag: '@render' }, async ({ page }, testInfo) => {
    await livePlayer(page, poorPlayer());
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    for (const label of ['My gladiator', 'Schedule', 'Inventory and shops']) {
      const panel = await settled(await openMenu(page, label));
      const field = panel.locator('select, input').first();
      await field.focus();
      expect(await contrastIssues(panel, { focusRing: true }), label).toEqual([]);
      await shot(page, testInfo, `form-${label.split(' ')[0].toLowerCase()}`);
    }
    const market = await settled(await openMenu(page, 'Marketplace'));
    await market.getByRole('tab', { name: 'Sell', exact: true }).click();
    await market.getByRole('radio', { name: /^Axe/ }).check();
    await market.getByRole('spinbutton', { name: 'Price in money' }).fill('0');
    await market.getByRole('spinbutton', { name: 'Price in money' }).focus();
    expect(await contrastIssues(market, { focusRing: true }), 'Marketplace Sell').toEqual([]);
    await shot(page, testInfo, 'form-market-sell');
  });

  test('respects reduced motion in the rail, panels and scenes', { tag: '@render' }, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openFixtureCamp(page);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.state()!.reducedMotion)).toBe(true);
    await revealRail(page);
    if (testInfo.project.name === 'desktop') expect(await page.getByTestId('menu-rail').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
    const panel = await openMenu(page, 'Results');
    expect(await panel.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await panel.getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first().click();
    const replay = scene(page, 'Replay');
    await expect(replay).toBeVisible();
    expect(await replay.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    expect(await page.evaluate(() => window.__cloudiatorReplay!.state().reducedMotion)).toBe(true);
    expect(await page.evaluate(() => window.__cloudiatorBattle!.debug()!.reducedMotion)).toBe(true);
    await page.getByRole('button', { name: 'Back to camp' }).click();
    await expect(replay).toHaveCount(0);
    await page.evaluate(id => window.__cloudiatorCamp!.emit('view-expedition', { activityId: id }), EXPEDITION_FIXTURES.woodland.activityId);
    await expect(scene(page, 'Expedition')).toBeVisible();
    await page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 });
    expect(await page.evaluate(() => window.__cloudiatorExpeditionScene!.debug()!.reducedMotion)).toBe(true);
    // Nothing on the page animates or scrolls smoothly.
    expect(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  });

  test('fits every sheet at 360 px with no horizontal scroll', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 360, height: 740 });
    await openFixtureCamp(page);
    const fits = async (locator: Locator, label: string) => {
      const box = (await (await settled(locator)).boundingBox())!;
      expect(box.x, label).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, label).toBeLessThanOrEqual(360);
      expect(box.y + box.height, label).toBeLessThanOrEqual(740.5);
      expect(await noHorizontalScroll(page), label).toBe(true);
      expect(await locator.evaluate(el => {
        const scroller = el.querySelector('[data-testid="menu-body"]') ?? el;
        return scroller.scrollWidth <= scroller.clientWidth;
      }), `${label} scrolls sideways`).toBe(true);
    };
    for (const label of LABELS) await fits(await openMenu(page, label), label);
    const roster = await openMenu(page, 'Gladiators');
    await roster.getByRole('button', { name: /^Profile: / }).first().click();
    await fits(page.getByRole('dialog', { name: /^Profile: / }), 'a profile card');
    // The scenes over the camp at 360 px (C20): the replay, after its result, and the expedition.
    await page.goto(`/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    await page.getByRole('button', { name: 'Skip to result' }).click();
    await fits(scene(page, 'Replay'), 'the replay scene');
    await shot(page, testInfo, '360-replay');
    await page.goto(`/game/?mode=fixture&view=expedition&activity=${EXPEDITION_FIXTURES.woodland.activityId}`);
    await expect(scene(page, 'Expedition').getByRole('heading', { name: 'Activity log' })).toBeVisible({ timeout: 45_000 });
    await fits(scene(page, 'Expedition'), 'the expedition scene');
    await shot(page, testInfo, '360-expedition');
  });

  test('names the season picker, progress bar and medal pills', async ({ page }) => {
    // C17: checked by accessible name and value (Task 21 review), in one accessibility snapshot each.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openFixtureCamp(page);
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), NOW);
    const arena = await openMenu(page, 'Arena');
    const standings = arena.getByRole('region', { name: 'Arena standings', exact: true });
    await expect(standings.getByRole('table', { name: 'Bronze league standings' }).locator('tbody tr')).toHaveCount(50, { timeout: 45_000 });
    const own = standings.getByRole('region', { name: 'Your standing' });
    await expect(standings).toMatchAriaSnapshot(`
      - combobox "Season":
        - option "Season 2 · current" [selected]
        - option "Season 1 · ended Sat 26 Sep"
      - region "Season 2 ends in 13 days 23 h":
        - heading "Season 2 ends in 13 days 23 h" [level=3]
        - list "Season prizes":
          - listitem:
            - img "First place"
          - listitem:
            - img "Second place"
          - listitem:
            - img "Third place"
    `);
    const progress = own.getByRole('progressbar', { name: 'Human bouts toward season rewards' });
    await expect(progress).toHaveAttribute('aria-valuetext', '3 of 5 human bouts');
    await standings.getByRole('combobox', { name: 'Season' }).selectOption({ label: 'Season 1 · ended Sat 26 Sep' });
    const severus = standings.getByRole('row').filter({ has: page.getByRole('button', { name: 'Profile: Severus', exact: true }) });
    await expect(severus).toMatchAriaSnapshot(`
      - row:
        - cell
        - 'rowheader "Profile: Severus"':
          - 'button "Profile: Severus"'
        - cell
        - cell
        - cell "1st · Champion"
    `);
  });

  test('shows an in-progress replay as not available yet until the fight ends', async ({ page }) => {
    // C20: the fixture tie-break bout starts five minutes before the fixture time and lasts 12 s.
    await openFixtureCamp(page);
    const start = NOW - 5 * MIN;
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), start + 1_000);
    await page.evaluate(id => window.__cloudiatorCamp!.emit('view-replay', { activityId: id }), REPLAY_FIXTURES.tie.activityId);
    const replay = scene(page, 'Replay');
    await expect(replay.getByRole('heading', { name: 'This replay is not available yet' })).toBeVisible({ timeout: 45_000 });
    await expect(replay).toContainText('The fight is still going on. Its replay appears here as soon as it ends.');
    await expect(replay.getByRole('button', { name: 'Skip to result' })).toHaveCount(0);
    // Once the display time passes the logged end, the replay is offered.
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), start + 30_000);
    await expect(replay.getByRole('heading', { name: 'Aster vs Cassia' })).toBeVisible();
  });

  test('tells only a fighter that the rewards are credited when the activity settles', async ({ page }) => {
    // C20: the positive case of the rewards line. The tie-break bout has ended, and nothing is credited yet.
    for (const visitor of [false, true]) {
      await openFixtureCamp(page, `/game/?mode=fixture${visitor ? '&as=visitor' : ''}&view=replay&activity=${REPLAY_FIXTURES.tie.activityId}`);
      const replay = scene(page, 'Replay');
      await replay.getByRole('button', { name: 'Skip to result' }).click();
      const result = replay.getByRole('region', { name: 'Result' });
      await expect(result).toContainText('Aster wins');
      if (visitor) await expect(result).not.toContainText('Rewards are credited');
      else await expect(result).toContainText('Rewards are credited when the activity settles.');
    }
  });

  test('opens a scene once when asked twice, so Back to camp returns at once', async ({ page }) => {
    // C19, the double-open history race: two requests before the address changes push one entry.
    await openFixtureCamp(page);
    const length = await page.evaluate(() => history.length);
    await page.evaluate(id => { window.__cloudiatorCamp!.emit('view-replay', { activityId: id }); window.__cloudiatorCamp!.emit('view-replay', { activityId: id }); },
      REPLAY_FIXTURES.pvp.activityId);
    await expect(scene(page, 'Replay')).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await page.getByRole('button', { name: 'Back to camp' }).click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
  });

  test('uses the touch layout in a narrow pointer window', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'A pointer window narrower than 481 px.');
    // C20: a mouse in a window under 481 px gets the ☰ button and bottom sheets; hovering the edge reveals nothing.
    await page.setViewportSize({ width: 470, height: 760 });
    await openFixtureCamp(page);
    expect(await touchLayout(page)).toBe(true);
    await page.mouse.move(2, 380);
    await page.waitForTimeout(400);
    await expect(railMenus(page)).toBeHidden();
    const burger = page.getByRole('button', { name: 'Menus', exact: true });
    await burger.click();
    await railMenus(page).getByRole('button', { name: 'Results', exact: true }).click();
    const sheet = await settled(menuDialog(page, 'Results'));
    const box = (await sheet.boundingBox())!;
    expect([box.x, box.width]).toEqual([0, 470]);
    expect(Math.abs(box.y + box.height - 760)).toBeLessThanOrEqual(1);
    // The pointer leaving the row never hides it while the sheet is open, and Escape returns the focus to ☰ or the icon.
    await page.mouse.move(400, 100);
    await page.waitForTimeout(400);
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    expect(['<button> Menus', '<button> Results']).toContain(await focusedElement(page));
    await shot(page, testInfo, 'narrow-pointer');
  });
});

test.describe('release accessibility in live mode', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test('closes a private menu and keeps the focus on the page when the session expires', async ({ page, context }) => {
    // C20: expiry with a private menu open (Task 13.6 deferred).
    await watchFocus(page);
    await seedSession(context, testUser(), { expiresIn: 8 });
    await routeLiveReads(context, { world: emptyWorld(), owner: ownerFixture });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const schedule = await openMenu(page, 'Schedule');
    await schedule.getByRole('combobox', { name: 'morning activity' }).focus();
    await expect(joinButton(page)).toBeVisible({ timeout: 20_000 });
    await expect(schedule).toBeHidden();
    await expect(page.getByText('Training at the practice yard')).toHaveCount(0);
    expect(await focusedElement(page)).not.toBe('body');
    expect(await focusDrops(page)).toEqual([]);
  });

  test('switches to another account signed in elsewhere without the old owner on screen', async ({ page, context }) => {
    // C20: an account switch in another tab (Task 13.6 deferred). Aster's Inventory is open; Brutus signs in elsewhere.
    await watchFocus(page);
    await seedSession(context);
    const live = await routeLiveReads(context, { world: emptyWorld(), owner: ownerFixture });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const inventory = await openMenu(page, 'Inventory and shops');
    await inventory.getByRole('spinbutton', { name: 'Purchase quantity' }).focus();
    const other = testUser('brutus@example.invalid');
    await seedSession(context, other);
    live.setOwner({ ...structuredClone(ownerFixture), gladiatorId: randomUUID(), name: 'Brutus', wallets: { money: 7, renown: 0 } });
    await page.evaluate(user => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp }))}.test-only`;
      const session = { access_token: token, refresh_token: `test-only:${user.id}`, token_type: 'bearer', expires_at: exp, expires_in: 3600, user };
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      const channel = new BroadcastChannel('sb-127-auth-token');
      channel.postMessage({ event: 'SIGNED_IN', session });
      channel.close();
    }, other);
    await expectOwnerShown(page, 'Brutus');
    await expect(cornerChip(page)).not.toContainText('Aster');
    await expect(inventory).toBeHidden();
    expect(await focusedElement(page)).not.toBe('body');
    expect(await focusDrops(page)).toEqual([]);
  });

  test('reads a replay scene once while the owner loads', async ({ page, context }) => {
    // C19, the scene remount on the first viewer change: a signed-in deep link waits for the viewer, then reads once.
    await seedSession(context);
    const bout = ownerBout(Date.now());
    const live = await routeLiveReads(context, { world: emptyWorld(), owner: ownerFixture, timelines: { [bout.activityId]: bout } });
    const timelineReads = () => live.requests.filter(r => r.table === 'visible_events' && r.query.get('activity_id') === `eq.${bout.activityId}`).length;
    // The owner read is held: the viewer is not known yet, so the scene waits and reads nothing (it used to mount as a
    // visitor's view, read, and remount as the player's once the owner arrived, reading again and restarting the replay).
    const release = live.hold('owner_state');
    await page.goto(`/game/?view=replay&activity=${bout.activityId}`);
    const replay = scene(page, 'Replay');
    await expect(replay.getByRole('status')).toHaveText('Loading the replay…', { timeout: 45_000 });
    await expect.poll(() => live.count('owner_state'), { timeout: 45_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(2_000);
    expect(timelineReads(), 'no timeline read before the viewer is known').toBe(0);
    release();
    await expectOwnerShown(page, 'Aster');
    await expect(replay.getByRole('heading', { name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    expect(timelineReads()).toBeGreaterThan(0);
  });
});

/** The owner's settled Arena bout two hours before `nowMs` (the fixture PvP log), with its credited summary. */
function ownerBout(nowMs: number): RevealedTimeline {
  const activityId = randomUUID();
  const start = nowMs - 120 * MIN, settledAtMs = start + 80 * MIN;
  const stage = (n: number, kind: RevealedStage['kind'], from: number, to: number, label: string, battleLog?: BattleLog): RevealedStage =>
    ({ id: `${activityId}:${n}`, kind, revealedAtMs: start + from * MIN, startedAtMs: start + from * MIN, endsAtMs: start + to * MIN, label, ...(battleLog ? { battleLog } : {}) });
  const replayExpiry = { state: 'available' as const, expiresAtMs: settledAtMs + 7 * 86_400_000 };
  return {
    activityId, serverNowMs: nowMs, visibleThroughMs: nowMs,
    stages: [stage(0, 'staging', 0, 60, 'Warm-up in the arena staging area'), stage(1, 'bout', 60, 80, 'Arena bout against Varro', readJson('tests/fixtures/battles/pvp.json') as BattleLog),
      stage(2, 'settlement', 80, 80, 'Result credited')],
    summary: { activityId, resolvedKind: 'arena', result: 'victory', success: true, rewards: { money: 15, renown: 2, xp: 40, attributePoints: 0, items: [], overflowMoney: 0 },
      receiptId: 'owner-bout', settledAtMs, replayExpiry, ratingDelta: 12 },
    completion: { activityId, resolvedKind: 'arena', result: 'victory', success: true, settledAtMs, replayExpiry },
  };
}

test('reaches the skip link first and moves the focus into the page on every route', async ({ page, context }) => {
  // Runs in the production build too: no read is answered, so each page shows its unavailable or visitor state.
  await context.route('**/rest/v1/**', route => route.abort());
  await watchFocus(page);
  for (const path of ['/game/', `/replay/?activity=${REPLAY_FIXTURES.pvp.activityId}`, `/expedition/?activity=${EXPEDITION_FIXTURES.woodland.activityId}`]) {
    await page.goto(path);
    await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip, path).toBeFocused();
    expect(await skip.evaluate(el => getComputedStyle(el).clipPath), path).toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main'), path).toBeFocused();
    expect(new URL(page.url()).hash, path).toBe('');
  }
  expect(await focusDrops(page)).toEqual([]);
});

test('shows an unavailable replay in the production build', async ({ page, context }, testInfo) => {
  // C20 / Task 14 review 6: the replay suite skips in production, so this checks the static export's unavailable state.
  const reads: string[] = [];
  await context.route('**/rest/v1/**', route => { reads.push(new URL(route.request().url()).pathname); return route.abort(); });
  await page.goto(`/replay/?activity=${REPLAY_FIXTURES.pvp.activityId}`);
  const main = page.locator('main#main');
  await expect(main.getByRole('heading', { level: 1, name: 'This replay is not available' })).toBeVisible({ timeout: 45_000 });
  await expect(main).toContainText('This replay cannot be loaded right now. Try again shortly.');
  await expect(main).not.toContainText(/Credited|wins|Loading/);
  expect(await page.locator('canvas').count()).toBe(0);
  await expect(page.getByRole('link', { name: 'Back to camp' })).toHaveAttribute('href', '/game/');
  await expectNamedControls(page.locator('body'), 'the replay page');
  // The development server reads through the test transport's address (refused here). The gate's production export has
  // no usable Supabase client, so it reads nothing at all, and says the same.
  if (!production) expect(reads.length, 'the timeline was asked for').toBeGreaterThan(0);
  await shot(page, testInfo, `replay-unavailable${production ? '-production' : ''}`);
  // A malformed link names no fight, and reads nothing.
  const before = reads.length;
  await page.goto('/replay/?activity=not-an-activity');
  await expect(main.getByRole('heading', { level: 1, name: 'This replay is not available' })).toBeVisible();
  await expect(main).toContainText('No fight was found for this link.');
  expect(reads.length).toBe(before);
  // The fixture preview is refused in a production export, with the same unavailable replay.
  if (production) {
    await page.goto(`/replay/?mode=fixture&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await expect(page.getByRole('status').filter({ hasText: 'Fixture preview is unavailable in this build.' })).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: 'This replay is not available' })).toBeVisible({ timeout: 45_000 });
  }
});

// R13 (Task 23.4, src/game/GameViewport.tsx): a camp that cannot start says so and offers Reload, which starts it again in
// place (the menus, the session and an open menu stay), in the development server and the production build alike.
test('offers Reload when the camp cannot load and recovers after it', async ({ page }, testInfo) => {
  await watchFocus(page);
  let failing = true;
  const aborted: string[] = [];
  await page.route('**/assets/actors/**', route => {
    if (!failing) return route.fallback();
    aborted.push(route.request().url());
    return route.abort();
  });
  await page.goto(production ? '/game/' : '/game/?mode=fixture');
  const fallback = page.locator('[data-camp-fallback]');
  await expect(fallback).toContainText('The camp art could not load', { timeout: 45_000 });
  expect(aborted.length).toBeGreaterThan(0);
  const reload = fallback.getByRole('button', { name: 'Reload', exact: true });
  await expect(reload).toBeEnabled();
  await expectNamedControls(fallback, 'the camp fallback');
  await reviewShot(page, testInfo, 'reload-camp-failed');
  await reviewShot360(page, testInfo, 'reload-camp-failed');
  // The menus still work while the camp is down (Schedule for the fixture player; the production build's live camp has
  // no backend here, so its viewer gets the public menus).
  await revealRail(page);
  await expect(railMenus(page).getByRole('button', { name: production ? 'Tournaments' : 'Schedule', exact: true })).toBeEnabled();
  // The art is back: Reload starts the camp again, and the keyboard stays on the camp view (never on <body>).
  failing = false;
  await reload.focus();
  await page.keyboard.press('Enter');
  await expect(fallback).toHaveCount(0, { timeout: 45_000 });
  const view = page.getByRole('application');
  await expect(view).toBeVisible();
  await expect(view).toBeFocused();
  await expect(page.getByText('Opening the camp…')).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator('[data-camp-view] canvas')).toHaveCount(1);
  if (!production) await campReady(page);
  expect(await focusDrops(page)).toEqual([]);
  // The rail's camera buttons are back (the pointer layout has them; touch zooms by pinch).
  if (!(await touchLayout(page))) {
    await revealRail(page);
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  }
  await reviewShot(page, testInfo, 'reload-camp-recovered');
});
