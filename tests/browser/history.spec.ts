import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import { contrastIssues, expectNamedControls, noHorizontalScroll } from './a11y-helpers';
import { expectOwnerShown, openMenu, quietArrivals, touchLayout, pageTo } from './shell-helpers';
import { routeLiveReads, seedSession } from './live-routes';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { PublicActor, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { ARENA_GLADIATORS, arenaActivityId } from '../fixtures/arena-ids';
import { EXPEDITION_FIXTURES } from '../fixtures/expedition-ids';

// Patch 1.9 Task 27 (Avi, 2026-11-12: "option to see gladiators arena match history\expedition history and tournaments battles history"; the
// approved mockup `.superpowers/design/2026-11-12-gladiator-history/`): every player's card opens their History (📜 History, or "See all" in
// RECORD): chips Arena · 🏆 Tournament fights · Expeditions with counts, newest first by day, 20 at a time and six a page with Back and Next (Task 32), ▶ Watch on every
// kept replay (the existing viewer), never another gladiator's rewards; tournament rows in gold, and a tournament bout's replay under a gold
// band. The fixture preview's history is tests/fixtures/history.ts: Varro (every kind, 23 Arena rows), Corvina (the 7 Oct tournament, lost
// in the Final; no expedition) and the viewer, Aster (her own rewards).
const production = process.env.PLAYWRIGHT_STATIC === 'true';
const SHOTS = '.superpowers/sdd/2026-11-12-1.9-additions';
const PRIVATE = /renown|gold\b|Rating [+−]|Light boots|Salvage/;
const profileCard = (page: Page, name: string) => page.getByRole('dialog', { name: `Profile: ${name}`, exact: true });
const historyRows = (card: Locator) => card.locator('[data-history-row]');
const chips = (card: Locator) => card.getByRole('group', { name: 'Show history', exact: true });

/** Rows a page of the History shows on this layout: six, four on the touch layout (Task 32 fix round 1, I3). */
const perPage = async (page: Page) => ((await touchLayout(page)) ? 4 : 6);
/** Whether the card's page of rows fits its paging surface without a scroll (the scope's body is the part that scrolls). */
const scopeFits = (card: Locator) => card.locator('[data-paging-scope] > div').first().evaluate(el => el.scrollHeight <= el.clientHeight + 1);

async function openCamp(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
/** A gladiator's card from the Gladiators list. */
async function fromList(page: Page, name: string): Promise<Locator> {
  const roster = await openMenu(page, 'Gladiators');
  const row = roster.getByRole('button', { name: `Profile: ${name}`, exact: true }).first();
  await pageTo(roster, row);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(profileCard(page, name)).toBeVisible();
  return profileCard(page, name);
}
/** Varro's card, from his Bronze standings row (he is not in the camp now). */
async function varroCard(page: Page): Promise<Locator> {
  const arena = await openMenu(page, 'Arena');
  const varro = arena.getByRole('table', { name: 'Bronze league standings' }).getByRole('button', { name: 'Profile: Varro', exact: true });
  await pageTo(arena, varro);
  await varro.click();
  await expect(profileCard(page, 'Varro')).toBeVisible();
  return profileCard(page, 'Varro');
}
async function shot(page: Page, info: TestInfo, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/task-27-${name}-${info.project.name === 'mobile' ? 'phone' : 'desktop'}.png` });
}

test.describe('A gladiator’s history on the card (fixture)', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');
  test.beforeEach(async ({ context, page }, info) => {
    await quietArrivals(context);
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 360, height: 740 } : { width: 1280, height: 720 });
  });

  test('another gladiator’s History: chips with counts, six a page with Back and Next, newest first by day, no reward, and ← back to the card', async ({ page }, info) => {
    await openCamp(page);
    const card = await varroCard(page);
    // The entries: "History · See all" in RECORD and 📜 History after ⚔ Spar a copy.
    const record = card.getByRole('region', { name: 'Record', exact: true });
    await expect(record.getByRole('button', { name: 'See all', exact: true })).toBeVisible();
    const actions = await card.locator('[data-card-actions] button').evaluateAll(nodes => nodes.map(node => node.textContent ?? ''));
    expect(actions.indexOf('📜 History')).toBe(actions.indexOf('⚔ Spar a copy') + 1);
    const open = card.getByRole('button', { name: 'History', exact: true });
    await open.click();

    await expect(card.getByRole('heading', { name: 'Varro\'s history', level: 2 })).toBeVisible();
    await expect(card).toContainText('Newest first');
    await expect(card.getByRole('button', { name: 'Back to the card', exact: true })).toBeFocused();
    // Chips: the Arena record (won–lost) and the number of tournament fights and expeditions this history lists.
    await expect(chips(card).getByRole('button')).toHaveText([/^Arena\s*15–8$/, /^🏆\s*Tournament fights\s*6$/, /^Expeditions\s*2$/]);
    await expect(chips(card).getByRole('button', { name: 'Tournament fights 6', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(chips(card).getByRole('button', { name: 'Arena 15–8', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Fix round 1 (controller ruling): the Arena line says what the chip and list count.
    await expect(card).toContainText('Replays are kept for 7 days. ▶ Watch shows where a replay is still kept. Last 90 days, NPC and bot bouts included.');
    await expect(card.locator('[data-history-footer]')).toHaveText('Rewards stay private. Anyone can watch a kept replay; it shows the fights, never loot.');

    const rows = historyRows(card);
    // Patch 1.9 Task 32: six a page of the 20 read; 23 exist, so the label says "Page 1" with "more to see" until the last is read.
    const bar = card.getByRole('navigation', { name: 'Pages' });
    const label = bar.locator('b').first();
    const per = await perPage(page);
    // Of the 23 rows the first 20 are read: whole pages of `per` are known, and the last read turns to the page that holds the 23rd row.
    const known = Math.floor(20 / per), end = Math.ceil(23 / per), tail = 23 - (end - 1) * per;
    await expect(rows).toHaveCount(per);
    expect(await scopeFits(card), 'page 1 fits the card').toBe(true);
    await expect(label).toHaveText('Page 1');
    await expect(bar).toContainText('more to see');
    await expect(card.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
    // Newest first: his bout with Aster (kept: ▶ Watch), then older bouts whose replays are gone (dimmed, no opponent, Result).
    await expect(rows.first()).toContainText('vs Aster');
    await expect(rows.first()).toContainText(/Arena · \d{1,2}:\d{2}\s?[AP]M · Bronze league/);
    await expect(rows.first().getByRole('button', { name: /^Watch: vs Aster, \w{3} \d{1,2} \w{3}, / })).toBeVisible();
    await expect(rows.nth(1)).toHaveAttribute('data-gone', '');
    await expect(rows.nth(1)).toContainText('Arena bout');
    await expect(rows.nth(1)).toContainText('replay no longer kept');
    await expect(rows.nth(1).getByRole('button')).toHaveCount(0);
    await expect(rows.nth(1)).toContainText('Result');
    const days = card.locator('[data-history-day]');
    expect(await days.count()).toBeGreaterThan(1);
    await expect(days.first()).toHaveText(/^(TODAY · )?[A-Z]{3} \d{1,2} [A-Z]{3}$/);
    await expect(card).not.toContainText(PRIVATE);
    await expectNamedControls(card, 'the history view');
    expect(await contrastIssues(card), 'the history view').toEqual([]);
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, info, 'history');

    // Next (by keyboard) from the last page read (page 3 of the 20 read) reads the last three: "Page 4 of 4", the five rows of the last page, the
    // focus on its first row, and "That is everything." on it.
    await bar.getByRole('button', { name: `Go to page ${known}`, exact: true }).click();
    await expect(label).toHaveText(`Page ${known}`);
    await bar.getByRole('button', { name: 'Next page', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(label).toHaveText(`Page ${end} of ${end}`);
    await expect(rows).toHaveCount(tail);
    await expect(card.getByText('That is everything.', { exact: true })).toBeVisible();
    await expect(rows.first()).toBeFocused();
    // Back goes one page back, and the end line is only on the last page.
    await bar.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(label).toHaveText(`Page ${end - 1} of ${end}`);
    await expect(rows).toHaveCount(per);
    await expect(card.getByText('That is everything.', { exact: true })).toHaveCount(0);
    await bar.getByRole('button', { name: 'Go to page 1', exact: true }).click();
    await expect(card.getByText('That is everything.', { exact: true })).toHaveCount(0);

    // Expeditions: his Ruined Outpost (kept) and an older Woodland Path (gone). The chip choice stays while the card is open.
    await chips(card).getByRole('button', { name: 'Expeditions 2', exact: true }).click();
    await expect(card).toContainText('Expedition replays are kept for 7 days. A trip still under way can be watched once it is over.');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Ruined Outpost');
    await expect(rows.first()).toContainText('Expedition · Failed');
    await expect(rows.nth(1)).toContainText('Woodland Path');
    await expect(rows.nth(1)).toContainText(/Expedition · Success · .* · replay no longer kept/);
    await expect(card).not.toContainText(PRIVATE);

    // ← goes back to the card, the focus on 📜 History; opening it again shows the chip chosen before.
    await card.getByRole('button', { name: 'Back to the card', exact: true }).click();
    await expect(card.getByRole('region', { name: 'Record', exact: true })).toBeVisible();
    await expect(open).toBeFocused();
    await record.getByRole('button', { name: 'See all', exact: true }).click();
    await expect(chips(card).getByRole('button', { name: 'Expeditions 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Two expeditions are one page: no bar. A chip goes back to page 1: Arena shows its first page again.
    await expect(bar).toHaveCount(0);
    await chips(card).getByRole('button', { name: /^Arena/ }).click();
    await expect(label).toHaveText(`Page 1 of ${end}`);
    await chips(card).getByRole('button', { name: 'Expeditions 2', exact: true }).click();

    // ▶ Watch on his kept trip opens the existing expedition scene (the whole trip); the card closes.
    await rows.first().getByRole('button', { name: /^Watch: Ruined Outpost/ }).click();
    const scene = page.getByRole('dialog', { name: 'Expedition', exact: true });
    await expect(scene).toBeVisible();
    const url = new URL(page.url());
    expect([url.searchParams.get('view'), url.searchParams.get('activity'), url.searchParams.get('play')]).toEqual(['expedition', EXPEDITION_FIXTURES.spectator.activityId, 'trip']);
    // Fix round 1: the scene names the History it came from (`from=history`, the gladiator and the chip), and Back reopens it at that chip.
    expect([url.searchParams.get('from'), url.searchParams.get('who'), url.searchParams.get('chip')]).toEqual(['history', ARENA_GLADIATORS.varro.id, 'expedition']);
    await expect(card).toHaveCount(0);
    const back = scene.getByRole('button', { name: 'Back to Varro\'s history', exact: true });
    await expect(back).toHaveText('← Varro\'s history');
    await back.click();
    await expect(scene).toHaveCount(0);
    await expect(card.getByRole('heading', { name: 'Varro\'s history', level: 2 })).toBeVisible();
    await expect(chips(card).getByRole('button', { name: 'Expeditions 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('button', { name: 'Back to the card', exact: true })).toBeFocused();
    expect(new URL(page.url()).searchParams.get('view')).toBeNull();
  });

  test('▶ Watch on another gladiator’s kept Arena bout opens the existing replay, with no band', async ({ page }) => {
    await openCamp(page);
    const card = await varroCard(page);
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await historyRows(card).first().getByRole('button', { name: /^Watch: vs Aster/ }).click();
    const replay = page.getByRole('dialog', { name: 'Replay', exact: true });
    await expect(replay).toBeVisible();
    const url = new URL(page.url());
    expect([url.searchParams.get('view'), url.searchParams.get('activity')]).toEqual(['replay', arenaActivityId('varroSpectator')]);
    await expect(replay.getByRole('heading', { name: 'Aster vs Varro' })).toBeVisible();
    await expect(replay.locator('header p.eyebrow')).toHaveText(/^ARENA · /);
    await expect(replay.locator('[data-tournament-band]')).toHaveCount(0);
    // Varro's own rewards are never shown to another player.
    await expect(replay).not.toContainText(/Credited rewards|\+\d+ renown/);
  });

  test('tournament fights are gold rows, and ▶ Watch plays that round under the gold tournament band with round pips', async ({ page }, info) => {
    await openCamp(page);
    const card = await fromList(page, 'Corvina');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await chips(card).getByRole('button', { name: 'Tournament fights 4', exact: true }).click();
    await expect(card).toContainText('Tournament replays are kept for 7 days after the tournament ends.');
    const rows = card.locator('[data-history-row="tournament"]');
    await expect(rows).toHaveCount(4);
    await expect(rows.locator('[data-round]')).toHaveText(['FINAL', 'SEMIFINAL', 'QUARTERFINAL', 'QUARTERFINAL']);
    await expect(rows.locator('[data-pill]')).toHaveText(['LOST', 'WON', 'WON', 'LOST']);
    for (let i = 0; i < 4; i += 1) await expect(rows.nth(i)).toContainText('Bronze Tournament');
    await expect(rows.first()).toContainText(/vs Varro · \d{1,2}:\d{2}\s?[AP]M/);
    await expect(rows.nth(3)).toHaveAttribute('data-gone', '');
    await expect(rows.nth(3)).toContainText('replay no longer kept');
    // The gold frame and medallion (a trophy; laurels beside it on a desktop).
    const frame = await rows.first().evaluate(el => getComputedStyle(el).borderTopColor);
    expect(frame).toBe('rgb(217, 169, 64)');
    await expect(rows.first().locator('[data-medal]')).toHaveText('🏆');
    await expect(card).not.toContainText(PRIVATE);
    // Corvina has been on no expedition.
    await chips(card).getByRole('button', { name: 'Expeditions 0', exact: true }).click();
    await expect(card.getByText('No expeditions yet', { exact: true })).toBeVisible();
    await expect(card.getByText('Corvina has not been on an expedition.', { exact: true })).toBeVisible();
    await chips(card).getByRole('button', { name: 'Tournament fights 4', exact: true }).click();
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await contrastIssues(card), 'the tournament rows').toEqual([]);
    await shot(page, info, 'tournament-rows');

    // ▶ Watch on the Final: the run's replay at its Final (stage <run>:3), in the tournament arena, under the gold band.
    await rows.first().getByRole('button', { name: /^Watch: Bronze Tournament, Final vs Varro/ }).click();
    const replay = page.getByRole('dialog', { name: 'Replay', exact: true });
    await expect(replay).toBeVisible();
    const url = new URL(page.url());
    const activity = url.searchParams.get('activity')!;
    expect(url.searchParams.get('stage')).toBe(`${activity}:3`);
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 2);
    const band = replay.locator('[data-tournament-band]');
    await expect(band).toBeVisible();
    // Fix round 1: the band names the tournament's league (the row's, carried in the address: a run's timeline has none).
    await expect(band).toContainText('TOURNAMENT · BRONZE · FINAL');
    expect([url.searchParams.get('league'), url.searchParams.get('from'), url.searchParams.get('chip')]).toEqual(['bronze', 'history', 'tournament']);
    await expect(band.getByRole('heading', { name: 'Varro vs Corvina' })).toBeVisible();
    const pips = replay.getByRole('list', { name: 'Rounds', exact: true }).getByRole('listitem');
    await expect(pips).toHaveText([/Quarterfinal\s*✓/, /Semifinal\s*✓/, /^Final$/]);
    await expect(pips.nth(2)).toHaveAttribute('aria-current', 'step');
    await expect(replay.locator('[data-tournament-frame]')).toBeVisible();
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    expect((await page.evaluate(() => window.__cloudiatorBattle!.debug()))!.backdrop).toBe('tournament');
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await contrastIssues(band), 'the tournament band').toEqual([]);
    await shot(page, info, 'tournament-replay');
    // Another round of the run: the pips follow it.
    await replay.getByRole('button', { name: 'Previous bout', exact: true }).click();
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 1);
    await expect(pips).toHaveText([/Quarterfinal\s*✓/, /^Semifinal$/, /^Final$/]);
    await expect(pips.nth(1)).toHaveAttribute('aria-current', 'step');
    // A chapter keeps the league and the origin; after a reload too.
    await expect(band).toContainText('TOURNAMENT · BRONZE · SEMIFINAL');
    await page.reload();
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 1, null, { timeout: 45_000 });
    await expect(replay.locator('[data-tournament-band]')).toContainText('TOURNAMENT · BRONZE · SEMIFINAL');

    // Fix round 1: Back (the button, Escape and the browser's Back) reopens Corvina's card on her History, at Tournament fights.
    const reopened = async () => {
      await expect(replay).toHaveCount(0);
      await expect(card.getByRole('heading', { name: 'Corvina\'s history', level: 2 })).toBeVisible();
      await expect(chips(card).getByRole('button', { name: 'Tournament fights 4', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(rows).toHaveCount(4);
    };
    const back = replay.getByRole('button', { name: 'Back to Corvina\'s history', exact: true });
    await expect(back).toHaveText('← Corvina\'s history');
    await back.click();
    await reopened();
    await rows.first().getByRole('button', { name: /^Watch: Bronze Tournament, Final/ }).click();
    await expect(replay).toBeVisible();
    await page.keyboard.press('Escape');
    await reopened();
    await rows.nth(1).getByRole('button', { name: /^Watch: Bronze Tournament, Semifinal/ }).click();
    await expect(replay).toBeVisible();
    await page.goBack();
    await reopened();
  });

  test('your own card: My history, with your own rewards beside your rows', async ({ page }, info) => {
    await openCamp(page);
    const roster = await openMenu(page, 'Gladiators');
    await pageTo(roster, roster.getByRole('button', { name: 'Profile: Aster', exact: true }).first());
    await roster.getByRole('button', { name: 'Profile: Aster', exact: true }).first().click();
    const card = profileCard(page, 'Aster');
    await expect(card).toContainText('YOUR GLADIATOR');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await expect(card.getByRole('heading', { name: 'My history', level: 2 })).toBeVisible();
    await expect(card.locator('[data-history-footer]')).toHaveText('You see your own rewards here. Other players see only the results.');
    const rows = historyRows(card);
    await expect(rows).toHaveCount(await perPage(page));
    await expect(rows.first()).toContainText('vs Varro');
    await expect(rows.first()).toContainText(/Arena · .* · Bronze league · \+10 renown · Rating \+13/);
    await expect(rows.nth(2)).toContainText(/vs Iron Warden\s*NPC/);
    await expect(rows.nth(2)).toContainText(/Arena · \d{1,2}:\d{2}\s?[AP]M · \+3 renown/);
    await shot(page, info, 'own-history');
    // Fix round 1: a replay from your own History goes back to "My history", at the chip it came from.
    await rows.first().getByRole('button', { name: /^Watch: vs Varro/ }).click();
    const replay = page.getByRole('dialog', { name: 'Replay', exact: true });
    const back = replay.getByRole('button', { name: 'Back to My history', exact: true });
    await expect(back).toHaveText('← My history');
    await back.click();
    await expect(replay).toHaveCount(0);
    await expect(card.getByRole('heading', { name: 'My history', level: 2 })).toBeVisible();
    await expect(chips(card).getByRole('button', { name: /^Arena / })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.first()).toContainText(/\+10 renown · Rating \+13/);
    await chips(card).getByRole('button', { name: 'Tournament fights 2', exact: true }).click();
    const runs = card.locator('[data-history-row="tournament"]');
    await expect(runs).toHaveCount(2);
    await expect(runs.nth(1)).toContainText('1st place · 100 gold · +60 renown');
    await chips(card).getByRole('button', { name: 'Expeditions 5', exact: true }).click();
    await expect(rows.first()).toContainText('Woodland Path');
    await expect(rows.first()).toContainText(/Expedition · Success · .* · \+20 gold · Light boots · Salvage/);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('phone 360 × 740: the history shows four rows a page in the sheet, its bar is the sheet’s bottom edge, and its buttons are 44 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openCamp(page);
    expect(await touchLayout(page)).toBe(true);
    const card = await varroCard(page);
    await card.getByRole('button', { name: 'History', exact: true }).click();
    // Task 32 fix round 1 (I3): four rows a page on the touch layout, and all four are inside the sheet, with no scroll.
    await expect(historyRows(card)).toHaveCount(4);
    const box = (await card.boundingBox())!;
    for (let i = 0; i < 4; i += 1) {
      const rowBox = (await historyRows(card).nth(i).boundingBox())!;
      expect(rowBox.y, `row ${i} starts inside the sheet`).toBeGreaterThanOrEqual(box.y);
      expect(rowBox.y + rowBox.height, `row ${i} ends inside the sheet`).toBeLessThanOrEqual(box.y + box.height);
    }
    expect(await scopeFits(card), 'page 1 fits the sheet').toBe(true);
    expect(await chips(card).getByRole('button').evaluateAll(buttons => new Set(buttons.map(b => Math.round(b.getBoundingClientRect().top))).size), 'the chips share one row').toBe(1);
    await expect(card.getByRole('combobox', { name: 'Rows per page' })).toHaveCount(0);
    expect(Math.round(box.x)).toBe(10);
    expect(Math.round(box.x + box.width)).toBe(350);
    const body = card.getByTestId('profile-body');
    // Task 32: the sheet no longer scrolls its list (Back and Next page it); the bar is the sheet's bottom edge, inside the card.
    const bar = card.getByRole('navigation', { name: 'Pages' });
    await expect(bar).toBeInViewport();
    const bottom = (await bar.boundingBox())!;
    expect(Math.abs(bottom.y + bottom.height - (box.y + box.height))).toBeLessThanOrEqual(12);
    // Fix round 1: the sheet's history is opaque, so nothing behind it shows through under the rows.
    expect(await body.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(21, 19, 28)');
    for (const button of [card.getByRole('button', { name: 'Back to the card' }), historyRows(card).first().getByRole('button'),
      chips(card).getByRole('button').first(), card.getByRole('button', { name: 'Close profile' })]) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    for (const control of [bar.getByRole('button', { name: 'Next page', exact: true }), bar.getByRole('button', { name: 'Previous page', exact: true })]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

// The live game (M37's public views through the live gateway; the development-only intercepted transport): another gladiator's history is
// read from `gladiator_history_reads` and `gladiator_history_counts`, by a visitor too, and never asks the owner-only `activities`; only the
// viewer's own card asks `activities` for its own rewards, for the rows it shows.
test.describe('A gladiator’s history from the live views', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');
  const NOW = worldFixture.serverNowMs, DAY = 86_400_000, lucilla = ARENA_GLADIATORS.lucilla, aster = ownerFixture.gladiatorId;
  const ACT = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const actor: PublicActor = { ...worldFixture.actors[0], gladiatorId: lucilla.id, name: lucilla.name, location: 'camp', activityId: null, activityStatus: 'idle',
    startsAtMs: null, endsAtMs: null, league: 'silver', level: 6 };
  const world: WorldSnapshot = { ...worldFixture, actors: [...worldFixture.actors, actor] };
  const row = (gladiatorId: string, n: number, over: Record<string, unknown>) => ({ gladiator_id: gladiatorId, kind: 'arena', entry_id: ACT(n), activity_id: ACT(n),
    fought_at_ms: NOW - n * 3_600_000, settled_at_ms: NOW - n * 3_600_000 + 1_200_000, result: 'victory', success: true, replay_expires_at_ms: NOW + 6 * DAY,
    arena_mode: null, league: 'silver', tournament_id: null, round: null, place: null, expedition_id: null, opponent: { name: 'Aster', npc: false }, ...over });
  const history = [
    row(lucilla.id, 1, {}),
    row(lucilla.id, 2, { result: 'defeat', success: false, replay_expires_at_ms: null, opponent: null, fought_at_ms: NOW - 9 * DAY }),
    row(aster, 3, { league: 'bronze', opponent: { name: 'Varro', npc: false } }),
  ];
  // Aster's own bout: its owner summary (renown and rating change) is in the owner-only `activities`.
  const own: RevealedTimeline = { activityId: ACT(3), serverNowMs: NOW, visibleThroughMs: NOW, stages: [],
    summary: { activityId: ACT(3), resolvedKind: 'arena', result: 'victory', success: true, receiptId: 'live-receipt', settledAtMs: NOW - 3 * 3_600_000 + 1_200_000,
      replayExpiry: { state: 'available', expiresAtMs: NOW + 6 * DAY }, ratingDelta: 13, rewards: { money: 0, renown: 10, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 } } };
  const ownRewardReads = (requests: readonly { table: string; query: URLSearchParams }[]) => requests.filter(r => r.table === 'activities' && (r.query.get('id') ?? '').startsWith('in.'));

  test('a player reads another gladiator’s public history without any owner read, and their own card’s rewards from their own activities', async ({ page, context }) => {
    await quietArrivals(context);
    await seedSession(context);
    const live = await routeLiveReads(context, { world, owner: ownerFixture, history, timelines: { [ACT(3)]: own } });
    await page.goto('/game/');
    await expectOwnerShown(page, ownerFixture.name);
    const card = await fromList(page, 'Lucilla');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await expect(historyRows(card)).toHaveCount(2);
    await expect(chips(card).getByRole('button', { name: 'Arena 1–1', exact: true })).toBeVisible();
    await expect(historyRows(card).first()).toContainText(/vs Aster.*Arena · .* · Silver league/);
    await expect(historyRows(card).nth(1)).toContainText('replay no longer kept');
    const reads = live.requests.filter(r => r.table === 'gladiator_history_reads');
    expect(reads.map(r => [r.query.get('gladiator_id'), r.query.get('kind')])).toEqual([[`eq.${lucilla.id}`, 'eq.arena']]);
    expect(live.count('gladiator_history_counts')).toBe(1);
    expect(ownRewardReads(live.requests)).toEqual([]);
    await expect(card).not.toContainText(PRIVATE);

    await card.getByRole('button', { name: 'Close profile', exact: true }).click();
    const roster = await openMenu(page, 'Gladiators');
    await pageTo(roster, roster.getByRole('button', { name: 'Profile: Aster', exact: true }).first());
    await roster.getByRole('button', { name: 'Profile: Aster', exact: true }).first().click();
    const mine = profileCard(page, 'Aster');
    await mine.getByRole('button', { name: 'History', exact: true }).click();
    await expect(mine.getByRole('heading', { name: 'My history', level: 2 })).toBeVisible();
    await expect(historyRows(mine).first()).toContainText(/vs Varro.*\+10 renown · Rating \+13/);
    expect(ownRewardReads(live.requests).map(r => r.query.get('id'))).toEqual([`in.(${ACT(3)})`]);
  });

  test('a visitor reads the same public history, and is never asked for anything private', async ({ page, context }) => {
    await quietArrivals(context);
    const live = await routeLiveReads(context, { world, history });
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const card = await fromList(page, 'Lucilla');
    // A failed first page says so; Try again reads it again and hands the focus to the chip shown (fix round 1), never to the page.
    live.fail('gladiator_history_reads');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('This history could not be loaded right now.');
    live.fail('gladiator_history_reads', false);
    await card.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(historyRows(card)).toHaveCount(2);
    await expect(chips(card).getByRole('button', { name: /^Arena/ })).toBeFocused();
    await expect(historyRows(card).first().getByRole('button', { name: /^Watch: vs Aster/ })).toBeVisible();
    await expect(card.locator('[data-history-footer]')).toHaveText('Rewards stay private. Anyone can watch a kept replay; it shows the fights, never loot.');
    expect(live.requests.filter(r => r.table === 'activities')).toEqual([]);
    expect(live.requests.filter(r => r.table === 'gladiator_history_reads').every(r => r.reader === null)).toBe(true);
  });

  // Patch 1.9 Task 32: Back from a replay lands on the page and row the replay was opened from. The card closes under a scene and its store is
  // new when it reopens, so the rows before the one opened are read again (a page of 20 at a time) until it is on the page shown.
  for (const afterRead of [false, true]) test(`Back from a replay reopens the History ${afterRead ? 'on a page that needed a second server read' : 'on the page'}, at the row it was opened from`, async ({ page, context }) => {
    await quietArrivals(context);
    const many = Array.from({ length: 30 }, (_, i) => row(lucilla.id, i + 1, { opponent: { name: `Rival ${i + 1}`, npc: false } }));
    await routeLiveReads(context, { world, history: many });
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const card = await fromList(page, 'Lucilla');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    const bar = card.getByRole('navigation', { name: 'Pages' });
    const label = bar.locator('b').first();
    const per = await perPage(page);
    await expect(historyRows(card)).toHaveCount(per);
    // The last whole page of the 20 read (page 3 of 6 a page, page 5 of 4 a page), or the next one, which reads the other 10 first.
    const known = Math.floor(20 / per), pageNo = afterRead ? known + 1 : known, n = (pageNo - 1) * per + 2;
    await bar.getByRole('button', { name: `Go to page ${known}`, exact: true }).click();
    if (afterRead) await bar.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(label).toHaveText(afterRead ? `Page ${pageNo} of ${Math.ceil(30 / per)}` : `Page ${pageNo}`);
    const opened = historyRows(card).filter({ hasText: `vs Rival ${n}` });
    await expect(opened).toHaveCount(1);
    await opened.getByRole('button', { name: new RegExp(`^Watch: vs Rival ${n},`) }).click();
    const replay = page.getByRole('dialog', { name: 'Replay', exact: true });
    await expect(replay).toBeVisible();
    await replay.getByRole('button', { name: /^Back to Lucilla.s history$/ }).click();
    await expect(replay).toHaveCount(0);
    await expect(card.getByRole('heading', { name: /^Lucilla.s history$/, level: 2 })).toBeVisible();
    await expect(label).toHaveText(afterRead ? `Page ${pageNo} of ${Math.ceil(30 / per)}` : new RegExp(`^Page ${pageNo}( of \\d+)?$`));
    await expect(historyRows(card).filter({ hasText: `vs Rival ${n}` })).toBeVisible();
  });

  test('a failed read of the next twenty keeps the page and says so; Next tries again', async ({ page, context }) => {
    await quietArrivals(context);
    const many = Array.from({ length: 30 }, (_, i) => row(lucilla.id, i + 1, { opponent: { name: `Rival ${i + 1}`, npc: false } }));
    const live = await routeLiveReads(context, { world, history: many });
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const card = await fromList(page, 'Lucilla');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    const bar = card.getByRole('navigation', { name: 'Pages' });
    const label = bar.locator('b').first();
    const per = await perPage(page), known = Math.floor(20 / per);
    await expect(historyRows(card)).toHaveCount(per);
    await bar.getByRole('button', { name: `Go to page ${known}`, exact: true }).click();
    live.fail('gladiator_history_reads');
    await bar.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(bar).toContainText('Could not load more. Try Next again.');
    await expect(label).toHaveText(`Page ${known}`);
    await expect(historyRows(card)).toHaveCount(per);
    live.fail('gladiator_history_reads', false);
    await bar.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(label).toHaveText(`Page ${known + 1} of ${Math.ceil(30 / per)}`);
  });

  test('a failed read for the row to land on says so, and the card stays on its first page', async ({ page, context }) => {
    await quietArrivals(context);
    const many = Array.from({ length: 30 }, (_, i) => row(lucilla.id, i + 1, { opponent: { name: `Rival ${i + 1}`, npc: false } }));
    await routeLiveReads(context, { world, history: many });
    // The reads that continue after the first twenty (they carry the cursor's `or` filter) fail once this is set.
    let failCursor = false;
    await context.route('**/rest/v1/gladiator_history_reads*', route => (failCursor && new URL(route.request().url()).searchParams.has('or')
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.fallback()));
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const card = await fromList(page, 'Lucilla');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    const bar = card.getByRole('navigation', { name: 'Pages' });
    const label = bar.locator('b').first();
    const per = await perPage(page), known = Math.floor(20 / per), n = known * per + 2;
    await expect(historyRows(card)).toHaveCount(per);
    await bar.getByRole('button', { name: `Go to page ${known}`, exact: true }).click();
    await bar.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(label).toHaveText(`Page ${known + 1} of ${Math.ceil(30 / per)}`);
    await historyRows(card).filter({ hasText: `vs Rival ${n}` }).getByRole('button', { name: new RegExp(`^Watch: vs Rival ${n},`) }).click();
    const replay = page.getByRole('dialog', { name: 'Replay', exact: true });
    await expect(replay).toBeVisible();
    failCursor = true;
    await replay.getByRole('button', { name: /^Back to Lucilla.s history$/ }).click();
    await expect(card.getByRole('heading', { name: /^Lucilla.s history$/, level: 2 })).toBeVisible();
    await expect(card.locator('[data-landing-failed]')).toHaveText('Could not load more. Try Next again.');
    await expect(label).toHaveText('Page 1');
    // Served again, Next reads on and the line goes.
    failCursor = false;
    await bar.getByRole('button', { name: `Go to page ${known}`, exact: true }).click();
    await bar.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(label).toHaveText(`Page ${known + 1} of ${Math.ceil(30 / per)}`);
    await expect(card.locator('[data-landing-failed]')).toHaveCount(0);
  });

  test('desktop: Show 25 makes a page taller than the card, and the bar stays the card’s bottom edge', async ({ page, context }) => {
    await quietArrivals(context);
    const many = Array.from({ length: 30 }, (_, i) => row(lucilla.id, i + 1, { opponent: { name: `Rival ${i + 1}`, npc: false } }));
    await routeLiveReads(context, { world, history: many });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    test.skip(await touchLayout(page), 'The desktop card only; the phone case checks its sheet.');
    const card = await fromList(page, 'Lucilla');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    const bar = card.getByRole('navigation', { name: 'Pages' });
    await bar.getByRole('combobox', { name: 'Rows per page' }).selectOption('25');
    await expect(historyRows(card)).toHaveCount(20);
    const box = (await card.boundingBox())!, foot = (await bar.boundingBox())!;
    expect(box.y + box.height, 'the card fits the window').toBeLessThanOrEqual(720);
    expect(Math.abs(foot.y + foot.height - (box.y + box.height)), 'the bar is the card’s bottom').toBeLessThanOrEqual(18);
    expect(await scopeFits(card), 'twenty rows scroll inside the card, not the card').toBe(false);
    await expect(bar.getByRole('button', { name: 'Next page', exact: true })).toBeInViewport();
  });
});
