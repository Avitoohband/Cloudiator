import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from './fixtures';
import type { BattleLog, PublicActivitySummary, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { ResultRow, TournamentView } from '../../supabase/functions/_shared/contracts/reads';
import { worldFixture } from '../fixtures/domain';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { TOURNAMENTS, tournamentAsOf } from '../fixtures/tournament-ids';
import { SLOT_MS, emptyWorld, routeLiveReads } from './live-routes';
import { closeMenu, expectOwnerShown, openMenu } from './shell-helpers';

// Task 22.5 (Review Focus 4): a replay older than seven days shows its summary with "no longer kept" everywhere: Recent
// results, Arena, expeditions and tournaments. The client decides by server time (the revision and timeline reads and the
// shared display clock), so it agrees with the server before cleanup (the log still held, the summary still saying
// `available`) and after it (the stages pruned, the summary flipped, a tournament's bouts compacted to fight summaries).

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = worldFixture.serverNowMs;
const SLOT_START = NOW - (NOW % SLOT_MS);
const RETENTION = 'Detailed replays are kept for 7 days. Results and credited rewards stay here for 90 days.';
const REWARDS = /\+\d+ (money|gold|renown|XP)|Credited rewards|Rating [+−-]\d|No rating change|Salvage/;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const AGED = readJson('tests/fixtures/tournaments/aged.json') as TournamentView;
/** When the aged tournament's bout replays went: the end of its slot plus seven days. */
const AGED_EXPIRY = AGED.endsAtMs + WEEK;

/** "Sat 10 Oct, 00:40", as Recent results shows a settlement time (the specs run in UTC). */
const resultTime = (ms: number) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone: 'UTC' }).format(ms);
/** The fixture Arena bout of the slot `slotsAgo` before the current one settled at that slot's end. */
const settledSlotsAgo = (slotsAgo: number) => SLOT_START - (slotsAgo - 1) * SLOT_MS;

const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
async function openCamp(page: Page, url: string) {
  await page.goto(url);
  await campReady(page);
}
const scene = (page: Page, name: 'Replay' | 'Expedition') => page.getByRole('dialog', { name, exact: true });
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settled = async (page: Page) => { await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished))); await nextFrames(page); };
/** One Recent results row, picked by what it says and when it settled. */
const resultRow = (list: Locator, what: string, settledAtMs: number) =>
  list.getByRole('listitem').filter({ hasText: what }).filter({ hasText: resultTime(settledAtMs) });
const freezeShellClock = (page: Page, ms: number) => page.evaluate(t => window.__cloudiatorShell!.clock.freeze(t), ms);

/** A settled public Arena bout of `log` that ended at `endMs`, its completion saying `replayExpiry` (no owner summary). */
function publicBout(endMs: number, replayExpiry: PublicActivitySummary['replayExpiry'], nowMs: number, stages = true): RevealedTimeline {
  const activityId = randomUUID(), start = endMs - SLOT_MS;
  const stage = (n: number, kind: RevealedStage['kind'], from: number, to: number, label: string, battleLog?: BattleLog): RevealedStage =>
    ({ id: `${activityId}:${n}`, kind, revealedAtMs: start + from * MIN, startedAtMs: start + from * MIN, endsAtMs: start + to * MIN, label, ...(battleLog ? { battleLog } : {}) });
  return {
    activityId, serverNowMs: nowMs, visibleThroughMs: nowMs,
    stages: stages ? [stage(0, 'staging', 0, 60, 'Warm-up in the arena staging area'),
      stage(1, 'bout', 60, 80, 'Arena bout against Varro', readJson('tests/fixtures/battles/pvp.json') as BattleLog), stage(2, 'settlement', 80, 80, 'Result credited')] : [],
    completion: { activityId, resolvedKind: 'arena', result: 'victory', success: true, settledAtMs: endMs, replayExpiry },
  };
}

test.describe('replays older than seven days in the fixture preview', () => {
  test.skip(production, 'These checks use the fixture preview, which production exports never include.');
  test.use({ timezoneId: 'UTC' });

  test('explains retention in Recent results and offers no replay once a result is older than seven days', { tag: '@render' }, async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    const results = await openMenu(page, 'Results');
    await expect(results.getByText(RETENTION, { exact: true })).toBeVisible();
    const list = results.getByRole('list', { name: 'Recent results' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    // A week and one slot old: its summary still says available (cleanup has not run), but its expiry has passed by server time.
    const lapsed = resultRow(list, 'Aster won an Arena bout', settledSlotsAgo(127));
    await expect(lapsed).toContainText('Aster won an Arena bout · replay no longer kept');
    await expect(lapsed.getByRole('button')).toHaveCount(0);
    // The tournament results of 26 and 23 September say available too, and are no longer kept either.
    for (const what of ['Aster was knocked out of a tournament', 'Aster won a tournament']) {
      await expect(list.getByRole('listitem').filter({ hasText: what })).toContainText(`${what} · replay no longer kept`);
      await expect(list.getByRole('listitem').filter({ hasText: what }).getByRole('button')).toHaveCount(0);
    }
    // One slot younger, the replay is still kept until the end of the current slot.
    const lastDay = resultRow(list, 'Aster won an Arena bout', settledSlotsAgo(126));
    await expect(lastDay.getByRole('button', { name: 'Replay: Aster won an Arena bout' })).toBeVisible();
    await expect(lastDay).not.toContainText('no longer kept');
    // Training and Rest never say a replay is no longer kept.
    await expect(list.getByRole('listitem').filter({ hasText: 'Cassia finished resting' })).not.toContainText('no longer kept');
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`retention-results-top-${testInfo.project.name}.png`) });
    await lapsed.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`retention-results-expired-${testInfo.project.name}.png`) });
  });

  test('shows the saved summary with "no longer kept" for an expired Arena and expedition replay', async ({ page }, testInfo) => {
    // Arena, before cleanup: the log is still held and the summary still says available, but its expiry has passed.
    await page.goto(`/replay/?mode=fixture&activity=${REPLAY_FIXTURES.lapsed.activityId}`);
    const saved = page.getByRole('region', { name: 'Saved outcome: Victory' });
    await expect(saved).toBeVisible({ timeout: 45_000 });
    await expect(saved).toContainText('The animation for this fight is no longer kept');
    await expect(saved).toContainText('Credited rewards');
    await expect(saved).toContainText('+3 renown');
    await expect(page.getByRole('button', { name: 'Skip to result' })).toHaveCount(0);
    expect(await page.evaluate(() => !!window.__cloudiatorReplay)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`retention-arena-replay-${testInfo.project.name}.png`), fullPage: true });
    // Expedition, after cleanup: no stage is left, only the owner's settled summary.
    await page.goto(`/expedition/?mode=fixture&activity=${REPLAY_FIXTURES.cleared.activityId}`);
    const trip = page.getByRole('region', { name: 'This expedition’s replays are no longer kept' });
    await expect(trip).toBeVisible({ timeout: 45_000 });
    await expect(trip).toContainText('Success');
    await expect(trip).toContainText('Credited rewards');
    await expect(trip).toContainText('+20 gold');
    await expect(trip).toContainText('Detailed replays are kept for seven days; the result and the credited rewards stay in your history for 90 days.');
    await expect(page.locator('main')).not.toContainText(/not available yet|Nothing has been revealed|Preparing/);
    await page.screenshot({ path: testInfo.outputPath(`retention-expedition-${testInfo.project.name}.png`), fullPage: true });
    // The same expedition as a scene over the camp.
    await openCamp(page, `/game/?mode=fixture&view=expedition&activity=${REPLAY_FIXTURES.cleared.activityId}`);
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'This expedition’s replays are no longer kept' })).toBeVisible({ timeout: 45_000 });
  });

  test('says a tournament replay is no longer kept after seven days and when its log was pruned', { tag: '@render' }, async ({ page }, testInfo) => {
    await page.goto('/game/?mode=fixture');
    const panel = await openMenu(page, 'Tournaments');
    await expect(page.getByRole('heading', { name: 'Tournaments', level: 2 })).toBeVisible({ timeout: 45_000 });
    await panel.getByRole('button', { name: TOURNAMENTS.aged.label, exact: true }).click();
    const card = panel.locator('article[data-status]');
    await expect(card).toHaveAttribute('data-status', 'completed');
    // Held at its sample time, ten days after the start: the results and fight summaries stay, the replays do not.
    await expect(card.getByRole('table')).toContainText('Placements');
    await expect(card.getByText('These bout replays are no longer kept. Detailed replays are kept for seven days; the results stay.')).toBeVisible();
    await expect(card.getByRole('button', { name: /Watch replay/ })).toHaveCount(0);
    await expect(card.getByText('Replay no longer kept').first()).toBeVisible();
    await expect(card.getByText(/was defeated\.|tie-break decided it\.|larger share of health\./).first()).toBeVisible();
    await card.getByRole('tabpanel').scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`retention-tournament-${testInfo.project.name}.png`) });
    // A minute before the replays go the final can still be watched; its log, compacted on the server, cannot be read.
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), AGED_EXPIRY - MIN);
    await card.getByRole('tab', { name: 'Final', exact: true }).click();
    const watch = card.getByRole('button', { name: /^Watch replay of / });
    await expect(watch).toHaveCount(1);
    await watch.click();
    const replay = card.getByRole('region', { name: /^Replay · Final, bout 1$/ });
    await expect(replay).toContainText('This replay cannot be loaded right now. Try again shortly.');
    expect(await page.evaluate(() => window.__cloudiatorTournaments!.logReads())).toBe(1);
    // From the expiry on, the same missing log reads as no longer kept, and nothing is read again.
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), AGED_EXPIRY);
    await expect(replay).toContainText('This replay is no longer kept. Detailed replays are kept for seven days. The result stays in the recent results.');
    await expect(card.getByRole('button', { name: /Watch replay/ })).toHaveCount(0);
    await expect(card.getByRole('tabpanel')).toContainText('Replay no longer kept');
    expect(await page.evaluate(() => window.__cloudiatorTournaments!.logReads())).toBe(1);
    await replay.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`retention-tournament-replay-gone-${testInfo.project.name}.png`) });
  });

  test('keeps offering a replay until its expiry by server time', async ({ page }) => {
    // The last-day bout settled at the end of the slot 126 slots (seven days) ago: kept until the end of the current slot.
    const expiry = settledSlotsAgo(126) + WEEK;
    expect(expiry).toBe(SLOT_START + SLOT_MS);
    await openCamp(page, '/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    await freezeShellClock(page, expiry - MIN);
    let results = await openMenu(page, 'Results');
    let lastDay = resultRow(results.getByRole('list', { name: 'Recent results' }), 'Aster won an Arena bout', settledSlotsAgo(126));
    await lastDay.getByRole('button', { name: 'Replay: Aster won an Arena bout' }).click();
    await expect(scene(page, 'Replay').getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await scene(page, 'Replay').getByRole('button', { name: 'Back to camp' }).click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    // The shared display clock reaches the expiry: the row no longer offers the replay, without a new read.
    await freezeShellClock(page, expiry);
    results = await openMenu(page, 'Results');
    lastDay = resultRow(results.getByRole('list', { name: 'Recent results' }), 'Aster won an Arena bout', settledSlotsAgo(126));
    await expect(lastDay).toContainText('Aster won an Arena bout · replay no longer kept');
    await expect(lastDay.getByRole('button')).toHaveCount(0);
    await closeMenu(page);
  });
});

test.describe('a 360 px phone', () => {
  test.skip(production, 'These checks use the fixture preview, which production exports never include.');
  test.use({ timezoneId: 'UTC', viewport: { width: 360, height: 760 } });

  test('fits the retention line and the expired rows of Recent results', async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    const results = await openMenu(page, 'Results');
    const line = results.getByText(RETENTION, { exact: true });
    await expect(line).toBeVisible();
    const lapsed = resultRow(results.getByRole('list', { name: 'Recent results' }), 'Aster won an Arena bout', settledSlotsAgo(127));
    await expect(lapsed).toContainText('replay no longer kept');
    // Nothing overflows the sheet sideways.
    expect(await results.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect((await line.boundingBox())!.width).toBeLessThanOrEqual(360);
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`retention-phone-results-top-${testInfo.project.name}.png`) });
    await lapsed.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`retention-phone-results-expired-${testInfo.project.name}.png`) });
  });
});

test.describe('replays older than seven days for a live visitor', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');
  test.use({ timezoneId: 'UTC' });

  test('decides by the server time of the read, before and after cleanup', async ({ page, context }) => {
    let now = Date.now();
    const end = Math.floor(now / SLOT_MS) * SLOT_MS - SLOT_MS;
    const expiry = end + WEEK;
    now = expiry - MIN;
    // Kept a minute before its expiry; from the expiry on no longer kept, while the server still holds the log and the
    // completion still says available (before cleanup), and once the stages are gone (after cleanup).
    const before = publicBout(end, { state: 'available', expiresAtMs: expiry }, now);
    const pruned = publicBout(end, { state: 'available', expiresAtMs: expiry }, now, false);
    const trip: RevealedTimeline = { activityId: randomUUID(), serverNowMs: now, visibleThroughMs: now, stages: [],
      completion: { activityId: '', resolvedKind: 'expedition', result: 'victory', success: true, settledAtMs: end + 45_000, replayExpiry: { state: 'available', expiresAtMs: expiry } } };
    trip.completion!.activityId = trip.activityId;
    // Someone's Woodland Path that ended in that slot, before cleanup: its stages and logs still held, its completion past expiry.
    const woodland = readJson('tests/fixtures/expeditions/woodland.json') as RevealedTimeline;
    const delta = end - SLOT_MS - woodland.stages[0].startedAtMs;
    const journeyId = randomUUID();
    const journey: RevealedTimeline = { activityId: journeyId, serverNowMs: now, visibleThroughMs: now,
      stages: woodland.stages.map(st => ({ ...st, revealedAtMs: st.revealedAtMs + delta, startedAtMs: st.startedAtMs + delta, endsAtMs: st.endsAtMs + delta })),
      completion: { activityId: journeyId, resolvedKind: 'expedition', result: 'victory', success: true, settledAtMs: end + 45_000,
        replayExpiry: { state: 'available', expiresAtMs: expiry } } };
    const recent: ResultRow[] = [{ gladiatorId: randomUUID(), name: 'Varro', summary: before.completion! }];
    await routeLiveReads(context, { world: { ...emptyWorld(now), revision: 'retention-1' }, timelines: { [before.activityId]: before, [pruned.activityId]: pruned, [trip.activityId]: trip, [journeyId]: journey },
      recent, serverNowMs: () => now });
    await page.goto(`/replay/?activity=${before.activityId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await page.goto(`/expedition/?activity=${journeyId}`);
    await expect(page.getByRole('link', { name: /^Watch the replay of encounter/ })).toHaveCount(3, { timeout: 45_000 });
    now = expiry;
    await page.goto(`/expedition/?activity=${journeyId}`);
    await expect(page.getByRole('region', { name: 'Result' })).toContainText('Encounter replays are no longer kept; the result stays in the recent results.',
      { timeout: 45_000 });
    await expect(page.getByRole('link', { name: /^Watch the replay of encounter/ })).toHaveCount(0);
    for (const id of [before.activityId, pruned.activityId]) {
      await page.goto(`/replay/?activity=${id}`);
      await expect(page.getByRole('heading', { name: 'This replay is no longer kept' })).toBeVisible({ timeout: 45_000 });
      await expect(page.locator('main')).not.toContainText(/not available yet|has not been revealed/i);
    }
    // A visitor's expedition after cleanup: no stage, only the public completion.
    await page.goto(`/expedition/?activity=${trip.activityId}`);
    const gone = page.getByRole('region', { name: 'This expedition’s replays are no longer kept' });
    await expect(gone).toBeVisible({ timeout: 45_000 });
    await expect(gone).toContainText('Detailed replays are kept for seven days. The result stays in the recent results.');
    await expect(page.locator('main')).not.toContainText(REWARDS);
    await expect(page.locator('main')).not.toContainText(/not available yet/);
    // Recent results agree, by the same server time.
    await openCamp(page, '/game/');
    const list = (await openMenu(page, 'Results')).getByRole('list', { name: 'Recent results' });
    await expect(list.getByRole('listitem').filter({ hasText: 'Varro won an Arena bout' })).toContainText('Varro won an Arena bout · replay no longer kept');
    await expect(list.getByRole('button')).toHaveCount(0);
  });

  test('shows a compacted tournament’s fight summaries and says an old tournament link is no longer kept', async ({ page, context }) => {
    // The live read of a tournament compacted by cleanup: each fought result carries `fight`, never a log.
    const at = tournamentAsOf('aged');
    const live = await routeLiveReads(context, { world: { ...emptyWorld(at), revision: 'retention-2' }, tournaments: [AGED], serverNowMs: () => at });
    await page.goto('/game/');
    const panel = await openMenu(page, 'Tournaments');
    await expect(page.getByRole('heading', { name: 'Tournaments', level: 2 })).toBeVisible({ timeout: 45_000 });
    await page.waitForFunction(() => !!window.__cloudiatorTournaments);
    await page.evaluate(id => window.__cloudiatorTournaments!.open(id), AGED.id);
    const card = panel.locator('article[data-status]');
    await expect(card).toHaveAttribute('data-status', 'completed', { timeout: 45_000 });
    await expect(card.getByText(/was defeated\.|tie-break decided it\.|larger share of health\./).first()).toBeVisible();
    await expect(card.getByRole('button', { name: /Watch replay/ })).toHaveCount(0);
    await expect(card.getByText('Replay no longer kept').first()).toBeVisible();
    expect(live.count('tournament_bout_results')).toBeGreaterThan(0);
    // An old tournament link (its id carries its slot) whose view is gone reads as no longer kept, not as a load error.
    const old = `tournament:${AGED.slotIndex - 126}:bronze`;
    await page.evaluate(id => window.__cloudiatorTournaments!.open(id), old);
    await expect(panel.getByText('This tournament is no longer kept')).toBeVisible({ timeout: 45_000 });
    await expect(panel).not.toContainText(/cannot be loaded right now|No tournament matches/);
  });
});
