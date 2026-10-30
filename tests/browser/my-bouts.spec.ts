import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import { arenaActivityId } from '../fixtures/arena-ids';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { noHorizontalScroll } from './a11y-helpers';
import { closeMenu, menuDialog, openMenu, quietArrivals, touchLayout } from './shell-helpers';

// Arena replays Task 4 (spec 1, the approved mockup; plan Review Focus 1 and 5): a player's 📜 Results opens on My bouts, the owner's
// own Arena and tournament bouts, newest first, by day, with the result, the opponent, the renown and the rating, a gold dot until
// watched on this device and ▶ Watch (Result once the replay is gone). Everyone (today's list) is one tab away; a visitor sees it
// alone. The fixture owner Aster's eight bouts, in Etc/GMT-3 and 12-hour form, as the plan's Fixture reference lists them.

test.use({ timezoneId: 'Etc/GMT-3', locale: 'en-US' });

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const KEY = 'cloudiator.bouts-watched.v1';
const VARRO = arenaActivityId('ownerHumanWin');

type Row = { name: string; tag?: 'NPC' | 'TOURNAMENT'; letter: 'W' | 'L'; sub: string; gone?: boolean };
/** The plan's Fixture reference, newest first, by day. */
const GROUPS: { day: string; rows: Row[] }[] = [
  { day: 'TODAY · SAT 10 OCT', rows: [
    { name: 'vs Varro', letter: 'W', sub: 'Arena · 2:40\xA0AM · +10 renown · Rating +13' },
    { name: 'vs Cassia', letter: 'L', sub: 'Arena · 1:20\xA0AM · +2 renown · Rating −13' },
    { name: 'vs Iron Warden', tag: 'NPC', letter: 'W', sub: 'Arena · 12:00\xA0AM · +3 renown' },
  ] },
  { day: 'FRI 9 OCT', rows: [
    { name: 'vs Bronze Sentinel', tag: 'NPC', letter: 'L', sub: 'Arena · 10:40\xA0PM' },
    { name: 'vs Severus', letter: 'W', sub: 'Arena · 9:20\xA0PM · won on a tie-break · +10 renown · Rating +15' },
  ] },
  { day: 'WED 30 SEP', rows: [{ name: 'Arena bout', letter: 'L', sub: '4:00\xA0AM · replay no longer kept', gone: true }] },
  { day: 'SAT 26 SEP', rows: [{ name: 'Tournament bout', letter: 'L', sub: '9:40\xA0PM · replay no longer kept', gone: true }] },
  { day: 'WED 23 SEP', rows: [{ name: 'Tournament bout', letter: 'W', sub: '9:40\xA0PM · replay no longer kept', gone: true }] },
];

const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
async function openCamp(page: Page, url = '/game/?mode=fixture') {
  await page.goto(url);
  await campReady(page);
}
const replayScene = (page: Page) => page.getByRole('dialog', { name: 'Replay', exact: true });
const myBoutsTab = (results: Locator) => results.getByRole('tab', { name: /^My bouts/ });
const chip = (results: Locator, name: 'All' | 'Won' | 'Lost') => results.getByRole('group', { name: 'Show bouts' }).getByRole('button', { name, exact: true });
const rows = (results: Locator) => results.locator('[data-bout-row]');
const rowOf = (results: Locator, name: string) => results.locator(`[data-bout-row="${name}"]`);
const names = (results: Locator) => results.locator('[data-bout-name]');
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** Waits for the menu's slide and anything else animating, before a screenshot. */
const settled = async (page: Page) => { await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished))); await nextFrames(page); };

/** Results, opened on My bouts once the owner's list has loaded. */
async function myBouts(page: Page): Promise<Locator> {
  const results = await openMenu(page, 'Results');
  await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true', { timeout: 45_000 });
  await expect(rows(results)).toHaveCount(8, { timeout: 45_000 });
  return results;
}

/** A screenshot for Avi's review, in the test's output and in TASK_SHOTS when set (the task's shots folder). */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const file = `${name}-${testInfo.project.name}${production ? '-production' : ''}.png`;
  await page.screenshot({ path: testInfo.outputPath(file) });
  if (process.env.TASK_SHOTS) {
    mkdirSync(process.env.TASK_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.TASK_SHOTS}/${file}` });
  }
}

test.describe('My bouts in Results', () => {
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

  test('opens Results on My bouts, by day, with the result, the opponent and the rating', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(results.getByRole('tab', { name: 'Everyone', exact: true })).toHaveAttribute('aria-selected', 'false');
    await expect(results.getByText('Replays are kept 7 days · ● not watched yet', { exact: true })).toBeVisible();
    await expect(chip(results, 'All')).toHaveAttribute('aria-pressed', 'true');
    await expect(results.locator('[data-results-tab="mine"]')).toContainText('5');

    // The day groups, in order, each with its rows.
    const touch = await touchLayout(page);
    const sections = results.locator('[role="tabpanel"] section');
    await expect(sections.locator(':scope > p.eyebrow')).toHaveText(GROUPS.map(g => g.day));
    for (const [n, group] of GROUPS.entries()) {
      const section = sections.nth(n);
      // Each day is a region named by its eyebrow.
      await expect(section).toHaveAccessibleName(group.day);
      const shown = section.locator('[data-bout-row]');
      await expect(shown, group.day).toHaveCount(group.rows.length);
      for (const [i, row] of group.rows.entries()) {
        const item = shown.nth(i);
        await expect(item.locator('[data-bout-name]'), `${n}.${i}`).toHaveText(row.name);
        // The badge says Won or Lost to a screen reader; its letter is the picture.
        await expect(item.getByText(row.letter === 'W' ? 'Won' : 'Lost', { exact: true })).toHaveCount(1);
        if (row.tag) await expect(item.getByText(row.tag, { exact: true })).toBeVisible();
        // The phone's sub-line leaves out the leading kind word.
        const sub = touch && row.sub.startsWith('Arena · ') ? row.sub.slice('Arena · '.length) : row.sub;
        await expect(item.locator(`[data-sub="${touch ? 'narrow' : 'wide'}"]`), `${row.name} sub-line`).toHaveText(sub);
        await expect(item.locator(`[data-sub="${touch ? 'wide' : 'narrow'}"]`)).toBeHidden();
        await expect(item.getByRole('button')).toHaveText(row.gone ? 'Result' : '▶ Watch');
      }
    }
    // Five gold dots, one for each kept replay not watched yet; the three dimmed rows offer Result, named for their day and time.
    await expect(results.locator('[data-unwatched-dot]')).toHaveCount(5);
    await expect(results.getByText('Not watched yet:', { exact: false })).toHaveCount(5);
    await expect(results.locator('[data-gone]')).toHaveCount(3);
    await expect(results.locator('[data-gone]').getByRole('button')).toHaveText(['Result', 'Result', 'Result']);
    await expect(results.getByRole('button', { name: 'Result: Arena bout, Wed 30 Sep, 4:00\xA0AM', exact: true })).toBeVisible();
    await expect(results.getByRole('button', { name: 'Watch: vs Varro, Sat 10 Oct, 2:40\xA0AM', exact: true })).toBeVisible();
    await expect(results.getByRole('button', { name: 'Watch: vs Severus, Fri 9 Oct, 9:20\xA0PM', exact: true })).toBeVisible();
    // Eight bouts are one page: no More.
    await expect(results.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    await settled(page);
    await shot(page, testInfo, 'my-bouts');
  });

  test('filters Won and Lost', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    await chip(results, 'Lost').click();
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(results, 'All')).toHaveAttribute('aria-pressed', 'false');
    await expect(names(results)).toHaveText(['vs Cassia', 'vs Bronze Sentinel', 'Arena bout', 'Tournament bout']);
    await expect(results.getByText('Lost', { exact: true }).locator('xpath=ancestor::li[@data-bout-row]')).toHaveCount(4);
    await settled(page);
    await shot(page, testInfo, 'my-bouts-lost');
    await chip(results, 'Won').click();
    await expect(chip(results, 'Won')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'false');
    await expect(names(results)).toHaveText(['vs Varro', 'vs Iron Warden', 'vs Severus', 'Tournament bout']);
    // The count stays the All list's: five kept bouts not watched.
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toBeVisible();
    await chip(results, 'All').click();
    await expect(rows(results)).toHaveCount(8);
    // The chip is kept when Results closes and opens again.
    await chip(results, 'Lost').click();
    await expect(names(results)).toHaveCount(4);
    await closeMenu(page);
    await expect(results).toBeHidden();
    const again = await openMenu(page, 'Results');
    await expect(chip(again, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await expect(names(again)).toHaveText(['vs Cassia', 'vs Bronze Sentinel', 'Arena bout', 'Tournament bout']);
  });

  test('Everyone is today’s list one tab away, and a visitor sees only Everyone', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    const everyone = results.getByRole('tab', { name: 'Everyone', exact: true });
    await everyone.click();
    await expect(everyone).toHaveAttribute('aria-selected', 'true');
    await expect(results.getByText('RECENT RESULTS', { exact: true })).toBeVisible();
    await expect(results.getByRole('list', { name: 'Recent results' })).toBeVisible();
    await expect(results.getByRole('button', { name: /^Replay: / }).first()).toBeVisible();
    await expect(rows(results)).toHaveCount(0);
    await expect(results.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', (await everyone.getAttribute('id'))!);
    await settled(page);
    await shot(page, testInfo, 'my-bouts-everyone');
    // ARIA tabs: the arrow keys, Home and End move between them, the focus with the selection.
    await everyone.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(myBoutsTab(results)).toBeFocused();
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    await expect(rows(results)).toHaveCount(8);
    await page.keyboard.press('End');
    await expect(everyone).toBeFocused();
    await expect(everyone).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(everyone).toHaveAttribute('aria-selected', 'true');
    // Only the selected tab is in the Tab order.
    await expect(everyone).toHaveAttribute('tabindex', '0');
    await expect(myBoutsTab(results)).toHaveAttribute('tabindex', '-1');

    // A visitor: Everyone alone, with no tabs, no chips and no bouts.
    await openCamp(page, '/game/?mode=fixture&as=visitor');
    const visitor = await openMenu(page, 'Results');
    await expect(visitor.getByText('RECENT RESULTS', { exact: true })).toBeVisible();
    await expect(visitor.getByRole('list', { name: 'Recent results' })).toBeVisible();
    await expect(visitor.getByRole('tablist')).toHaveCount(0);
    await expect(visitor.getByRole('group', { name: 'Show bouts' })).toHaveCount(0);
    await expect(rows(visitor)).toHaveCount(0);
  });

  test('Watch opens the bout with ← My bouts and marks it watched on this device', async ({ page }, testInfo) => {
    await openCamp(page);
    let results = await myBouts(page);
    await results.getByRole('button', { name: 'Watch: vs Varro, Sat 10 Oct, 2:40\xA0AM', exact: true }).click();
    const scene = replayScene(page);
    await expect(scene).toBeVisible();
    const back = page.getByRole('button', { name: 'Back to My bouts', exact: true });
    await expect(back).toHaveText('← My bouts');
    expect(search(page)).toMatchObject({ view: 'replay', activity: VARRO, from: 'bouts' });
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await back.click();
    await expect(scene).toHaveCount(0);
    await expect(results).toBeVisible();
    await expect(results.getByRole('tab', { name: 'My bouts, 4 not watched', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(rowOf(results, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    await expect(rowOf(results, 'vs Cassia').locator('[data-unwatched-dot]')).toHaveCount(1);
    await expect(results.locator('[data-unwatched-dot]')).toHaveCount(4);
    await settled(page);
    await shot(page, testInfo, 'my-bouts-after-watch');

    // After a reload, the same: the mark is on this device.
    await page.reload();
    await campReady(page);
    results = await myBouts(page);
    await expect(results.getByRole('tab', { name: 'My bouts, 4 not watched', exact: true })).toBeVisible();
    await expect(rowOf(results, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    const marks = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as [string, number][], KEY);
    expect(marks.map(([id]) => id)).toContain(VARRO);
    expect(marks.every(([, at]) => Number.isSafeInteger(at))).toBe(true);

    // From Lost, the address names the chip; a reload of the scene then Back opens Results on My bouts with Lost pressed.
    await chip(results, 'Lost').click();
    await expect(names(results)).toHaveCount(4);
    await results.getByRole('button', { name: /^Watch: vs Cassia, / }).click();
    await expect(scene).toBeVisible();
    expect(search(page)).toMatchObject({ activity: arenaActivityId('ownerHumanLoss'), from: 'bouts-lost' });
    await page.reload();
    await campReady(page);
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Cassia' })).toBeVisible({ timeout: 45_000 });
    await expect(back).toHaveText('← My bouts');
    await back.click();
    await expect(scene).toHaveCount(0);
    results = menuDialog(page, 'Results');
    await expect(results).toBeVisible();
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await expect(names(results)).toHaveText(['vs Cassia', 'vs Bronze Sentinel', 'Arena bout', 'Tournament bout']);
    await expect(results.getByRole('tab', { name: 'My bouts, 3 not watched', exact: true })).toBeVisible();

    // A row of Everyone still goes back to Everyone, and the browser's Back after a reload does as well.
    await results.getByRole('tab', { name: 'Everyone', exact: true }).click();
    await results.getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first().click();
    await expect(scene).toBeVisible();
    expect(search(page).from).toBe('results');
    await page.reload();
    await campReady(page);
    await expect(scene).toBeVisible();
    await page.goBack();
    await expect(scene).toHaveCount(0);
    await expect(menuDialog(page, 'Results').getByRole('tab', { name: 'Everyone', exact: true })).toHaveAttribute('aria-selected', 'true');
  });

  test('Result opens the saved outcome of a bout whose replay is gone', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    await results.getByRole('button', { name: 'Result: Arena bout, Wed 30 Sep, 4:00\xA0AM', exact: true }).click();
    const scene = replayScene(page);
    await expect(scene).toBeVisible();
    expect(search(page)).toMatchObject({ activity: REPLAY_FIXTURES.expired.activityId, from: 'bouts' });
    await expect(scene.getByRole('heading', { level: 2, name: 'Saved outcome: Defeat' })).toBeVisible({ timeout: 45_000 });
    await expect(scene.getByText('The animation for this fight is no longer kept.', { exact: false })).toBeVisible();
    await settled(page);
    await shot(page, testInfo, 'my-bouts-result');
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(scene).toHaveCount(0);
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    // A gone bout has no dot to drop: still five not watched.
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toBeVisible();
  });

  test('keeps working when storage throws', async ({ page }) => {
    // Review Focus 1: private mode or blocked site data. The page keeps its marks in memory, so a dot that went stays gone.
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    });
    await openCamp(page);
    const results = await myBouts(page);
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toBeVisible();
    await results.getByRole('button', { name: 'Watch: vs Varro, Sat 10 Oct, 2:40\xA0AM', exact: true }).click();
    await expect(replayScene(page)).toBeVisible();
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(replayScene(page)).toHaveCount(0);
    await expect(rowOf(results, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    await expect(results.getByRole('tab', { name: 'My bouts, 4 not watched', exact: true })).toBeVisible();
    // Closed and opened again (the list read again), for the page's life.
    await closeMenu(page);
    const again = await myBouts(page);
    await expect(rowOf(again, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    await expect(again.locator('[data-unwatched-dot]')).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test('phone: tabs, chips and rows fit the sheet', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCamp(page);
    const results = await myBouts(page);
    // The sub-lines shown leave out the leading kind word.
    const subs = results.locator('[data-sub]:visible');
    await expect(subs).toHaveCount(8);
    for (const sub of await subs.allTextContents()) expect(sub.startsWith('Arena · '), sub).toBe(false);
    await expect(rowOf(results, 'vs Varro').locator('[data-sub]:visible')).toHaveText('2:40\xA0AM · +10 renown · Rating +13');
    await settled(page);
    await shot(page, testInfo, 'my-bouts-390');

    await page.setViewportSize({ width: 360, height: 740 });
    await nextFrames(page);
    expect(await noHorizontalScroll(page)).toBe(true);
    const sheet = (await results.boundingBox())!;
    expect(sheet.x).toBeGreaterThanOrEqual(0);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(360);
    // Every row's button, chip and tab is a 44 px target, and lies inside the sheet.
    const targets = results.locator('[data-bout-row] button, [role="tab"]').or(results.getByRole('group', { name: 'Show bouts' }).getByRole('button'));
    const count = await targets.count();
    expect(count).toBe(8 + 2 + 3);
    for (let i = 0; i < count; i += 1) {
      const target = targets.nth(i);
      await target.scrollIntoViewIfNeeded();
      const box = (await target.boundingBox())!;
      const what = (await target.getAttribute('aria-label')) ?? (await target.textContent());
      expect(box.height, `${what} height`).toBeGreaterThanOrEqual(44);
      expect(box.x, `${what} left`).toBeGreaterThanOrEqual(sheet.x);
      expect(box.x + box.width, `${what} right`).toBeLessThanOrEqual(sheet.x + sheet.width + 0.5);
    }
    // A row's name and sub-line end before its button.
    const varro = rowOf(results, 'vs Varro');
    const button = (await varro.getByRole('button').boundingBox())!;
    const sub = (await varro.locator('[data-sub]:visible').boundingBox())!;
    expect(sub.x + sub.width).toBeLessThanOrEqual(button.x);
    await results.locator('[data-bout-row]').first().scrollIntoViewIfNeeded();
    await settled(page);
    await shot(page, testInfo, 'my-bouts-360');
    await rowOf(results, 'Arena bout').scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'my-bouts-360-gone');
  });
});
