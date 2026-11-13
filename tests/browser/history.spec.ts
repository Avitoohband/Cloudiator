import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import { contrastIssues, expectNamedControls, noHorizontalScroll } from './a11y-helpers';
import { expectOwnerShown, openMenu, quietArrivals, touchLayout } from './shell-helpers';
import { routeLiveReads, seedSession } from './live-routes';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { PublicActor, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { ARENA_GLADIATORS, arenaActivityId } from '../fixtures/arena-ids';
import { EXPEDITION_FIXTURES } from '../fixtures/expedition-ids';

// Patch 1.9 Task 27 (Avi, 2026-11-12: "option to see gladiators arena match history\expedition history and tournaments battles history"; the
// approved mockup `.superpowers/design/2026-11-12-gladiator-history/`): every player's card opens their History (📜 History, or "See all" in
// RECORD): chips Arena · 🏆 Tournament fights · Expeditions with counts, newest first by day, 20 at a time with Show more, ▶ Watch on every
// kept replay (the existing viewer), never another gladiator's rewards; tournament rows in gold, and a tournament bout's replay under a gold
// band. The fixture preview's history is tests/fixtures/history.ts: Varro (every kind, 23 Arena rows), Corvina (the 7 Oct tournament, lost
// in the Final; no expedition) and the viewer, Aster (her own rewards).
const production = process.env.PLAYWRIGHT_STATIC === 'true';
const SHOTS = '.superpowers/sdd/2026-11-12-1.9-additions';
const PRIVATE = /renown|gold\b|Rating [+−]|Light boots|Salvage/;
const profileCard = (page: Page, name: string) => page.getByRole('dialog', { name: `Profile: ${name}`, exact: true });
const historyRows = (card: Locator) => card.locator('[data-history-row]');
const chips = (card: Locator) => card.getByRole('group', { name: 'Show history', exact: true });

async function openCamp(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
/** A gladiator's card from the Gladiators list. */
async function fromList(page: Page, name: string): Promise<Locator> {
  const roster = await openMenu(page, 'Gladiators');
  const row = roster.getByRole('button', { name: `Profile: ${name}`, exact: true }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(profileCard(page, name)).toBeVisible();
  return profileCard(page, name);
}
/** Varro's card, from his Bronze standings row (he is not in the camp now). */
async function varroCard(page: Page): Promise<Locator> {
  const arena = await openMenu(page, 'Arena');
  await arena.getByRole('table', { name: 'Bronze league standings' }).getByRole('button', { name: 'Profile: Varro', exact: true }).click();
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

  test('another gladiator’s History: chips with counts, 20 a page with Show more, newest first by day, no reward, and ← back to the card', async ({ page }, info) => {
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
    await expect(card).toContainText('Newest first · 20 at a time');
    await expect(card.getByRole('button', { name: 'Back to the card', exact: true })).toBeFocused();
    // Chips: the Arena record (won–lost) and the number of tournament fights and expeditions this history lists.
    await expect(chips(card).getByRole('button')).toHaveText([/^Arena\s*15–8$/, /^🏆\s*Tournament fights\s*6$/, /^Expeditions\s*2$/]);
    await expect(chips(card).getByRole('button', { name: 'Tournament fights 6', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(chips(card).getByRole('button', { name: 'Arena 15–8', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(card).toContainText('Replays are kept for 7 days. ▶ Watch shows where a replay is still kept.');
    await expect(card.locator('[data-history-footer]')).toHaveText('Rewards stay private. Anyone can watch a kept replay; it shows the fights, never loot.');

    const rows = historyRows(card);
    await expect(rows).toHaveCount(20);
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

    // Show more: the last three, then "That is everything." and no Show more.
    await card.getByRole('button', { name: 'Show more', exact: true }).click();
    await expect(rows).toHaveCount(23);
    await expect(card.getByText('That is everything.', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);

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

    // ▶ Watch on his kept trip opens the existing expedition scene (the whole trip); the card closes.
    await rows.first().getByRole('button', { name: /^Watch: Ruined Outpost/ }).click();
    await expect(page.getByRole('dialog', { name: 'Expedition', exact: true })).toBeVisible();
    const url = new URL(page.url());
    expect([url.searchParams.get('view'), url.searchParams.get('activity'), url.searchParams.get('play')]).toEqual(['expedition', EXPEDITION_FIXTURES.spectator.activityId, 'trip']);
    await expect(card).toHaveCount(0);
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
    await expect(band).toContainText('TOURNAMENT · FINAL');
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
  });

  test('your own card: My history, with your own rewards beside your rows', async ({ page }, info) => {
    await openCamp(page);
    const roster = await openMenu(page, 'Gladiators');
    await roster.getByRole('button', { name: 'Profile: Aster', exact: true }).first().click();
    const card = profileCard(page, 'Aster');
    await expect(card).toContainText('YOUR GLADIATOR');
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await expect(card.getByRole('heading', { name: 'My history', level: 2 })).toBeVisible();
    await expect(card.locator('[data-history-footer]')).toHaveText('You see your own rewards here. Other players see only the results.');
    const rows = historyRows(card);
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText('vs Varro');
    await expect(rows.first()).toContainText(/Arena · .* · Bronze league · \+10 renown · Rating \+13/);
    await expect(rows.nth(2)).toContainText(/vs Iron Warden\s*NPC/);
    await expect(rows.nth(2)).toContainText(/Arena · \d{1,2}:\d{2}\s?[AP]M · \+3 renown/);
    await shot(page, info, 'own-history');
    await chips(card).getByRole('button', { name: 'Tournament fights 2', exact: true }).click();
    const runs = card.locator('[data-history-row="tournament"]');
    await expect(runs).toHaveCount(2);
    await expect(runs.nth(1)).toContainText('1st place · 100 gold · +60 renown');
    await chips(card).getByRole('button', { name: 'Expeditions 5', exact: true }).click();
    await expect(rows.first()).toContainText('Woodland Path');
    await expect(rows.first()).toContainText(/Expedition · Success · .* · \+20 gold · Light boots · Salvage/);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('phone 360 × 740: the history fills the sheet, which scrolls, and its buttons are 44 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openCamp(page);
    expect(await touchLayout(page)).toBe(true);
    const card = await varroCard(page);
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await expect(historyRows(card)).toHaveCount(20);
    const box = (await card.boundingBox())!;
    expect(Math.round(box.x)).toBe(10);
    expect(Math.round(box.x + box.width)).toBe(350);
    const body = card.getByTestId('profile-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    for (const button of [card.getByRole('button', { name: 'Back to the card' }), historyRows(card).first().getByRole('button'),
      chips(card).getByRole('button').first(), card.getByRole('button', { name: 'Close profile' })]) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await card.getByRole('button', { name: 'Show more', exact: true }).scrollIntoViewIfNeeded();
    await expect(card.getByRole('button', { name: 'Show more', exact: true })).toBeInViewport();
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
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await expect(historyRows(card)).toHaveCount(2);
    await expect(historyRows(card).first().getByRole('button', { name: /^Watch: vs Aster/ })).toBeVisible();
    await expect(card.locator('[data-history-footer]')).toHaveText('Rewards stay private. Anyone can watch a kept replay; it shows the fights, never loot.');
    expect(live.requests.filter(r => r.table === 'activities')).toEqual([]);
    expect(live.requests.filter(r => r.table === 'gladiator_history_reads').every(r => r.reader === null)).toBe(true);
  });
});

