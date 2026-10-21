import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import type { SeasonView, StandingRow, StandingsPage } from '../../supabase/functions/_shared/contracts/reads';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { ARENA_STANDINGS } from '../fixtures/arena-build';
import { FIXTURE_ARCHIVE, FIXTURE_SEASONS } from '../fixtures/seasons';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { forbidRemote } from './remote';
import { expectOwnerShown, menuDialog, openMenu } from './shell-helpers';
import { watchSyncPoll } from './sync-poll';

// Task 21.4 (plan Decision 8, the approved mockup): seasons inside Arena standings. A season picker, the current season's
// countdown, end time (local and UTC), prizes and rule; the owner's season rank and progress to five human bouts; an
// archived season's frozen ranks with medals and its promotion footnote; and season titles and badges on profile cards.
// The fixture preview serves two seasons: '1' ("Season 2", current) and '0' ("Season 1", closed with medals).

const production = process.env.PLAYWRIGHT_STATIC === 'true';
// Times are checked in one zone: the fixture seasons end at 00:00 UTC, 03:00 in Jerusalem (summer time until 25 Oct 2026).
test.use({ timezoneId: 'Asia/Jerusalem' });

const ASTER = ARENA_GLADIATORS.aster.id;
const [CURRENT, PREVIOUS] = FIXTURE_SEASONS;
const ASTER_ROW = ARENA_STANDINGS.bronze.find(row => row.gladiatorId === ASTER)!;
/** The world fixture's time: 14 days into season 2, 40 minutes into its slot (13 days 23 h 20 min left). */
const NOW = worldFixture.serverNowMs;

const standings = (page: Page) => page.getByRole('region', { name: 'Arena standings', exact: true });
const picker = (page: Page) => standings(page).getByRole('combobox', { name: 'Season' });
const table = (page: Page, league: string) => page.getByRole('table', { name: `${league} league standings` });
const rowOf = (page: Page, league: string, name: string) => table(page, league).getByRole('row').filter({ has: page.getByRole('button', { name: `Profile: ${name}`, exact: true }) });
const profileCard = (page: Page, name: string) => page.getByRole('dialog', { name: `Profile: ${name}`, exact: true });
const wide = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Opens the fixture camp (the owner Aster, or a visitor) with the display clock held at the world fixture's time, and the Arena menu. */
async function openStandings(page: Page, visitor = false) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/game/?mode=fixture${visitor ? '&as=visitor' : ''}`);
  if (!visitor) await expectOwnerShown(page, 'Aster');
  await page.waitForFunction(() => !!window.__cloudiatorShell);
  await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), NOW);
  await openMenu(page, 'Arena');
  await expect(table(page, 'Bronze').locator('tbody tr')).toHaveCount(50, { timeout: 45_000 });
}
/**
 * A screenshot of the window for the visual review (as the mockup's views), with `top` scrolled to the top of its menu
 * panel (or `bottom` to its bottom) first; saved in the test's output folder and copied to the workspace after the run.
 */
async function shot(page: Page, testInfo: TestInfo, name: string, align: { top?: Locator; bottom?: Locator } = {}) {
  await align.top?.evaluate(el => el.scrollIntoView({ block: 'start' }));
  await align.bottom?.evaluate(el => el.scrollIntoView({ block: 'end' }));
  await page.screenshot({ path: testInfo.outputPath(`seasons-${testInfo.project.name}-${name}.png`) });
}

test.describe('seasons in the fixture preview', () => {
  test.skip(production, 'These checks use the fixture preview.');

  test('shows the current season countdown, prizes and own qualification progress', { tag: '@render' }, async ({ page, baseURL }, testInfo) => {
    const remote = forbidRemote(page, baseURL);
    await openStandings(page);
    const section = standings(page);
    await expect(section.getByText('Current season', { exact: true })).toBeVisible();
    // The picker: the current season and the finished one, by its local end date.
    await expect(picker(page).locator('option')).toHaveText(['Season 2 · current', 'Season 1 · ended Sat 26 Sep']);
    await expect(picker(page)).toHaveValue(CURRENT.seasonId);
    // The season card: the countdown on the shared display clock, the end in local time with the UTC time, the prizes and the rule.
    const season = section.getByRole('region', { name: 'Season 2 ends in 13 days 23 h' });
    await expect(season).toBeVisible();
    await expect(season).toContainText('Sat 24 Oct, 03:00 your time (00:00 UTC). Ratings then restart at 1000; level, gear, money and renown stay.');
    await expect(season.getByRole('listitem')).toHaveText([
      /500 money · 100 renown · Champion title · gold badge/, /300 money · 60 renown · silver badge/, /200 money · 40 renown · bronze badge/]);
    await expect(season).toContainText('Top 3 in each league among gladiators with at least 5 human bouts. Paid once, in your highest league where you qualify.');
    // The display clock moves the countdown; no read is needed.
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), CURRENT.endsAtMs - 90 * 60_000);
    await expect(section.getByRole('region', { name: 'Season 2 ends in 1 h 30 min' })).toBeVisible();
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), NOW);
    // Your standing keeps league, rating, renown and current combat strength, and adds the season rank and human bouts.
    const own = section.getByRole('region', { name: 'Your standing' });
    await expect(own.getByRole('term')).toHaveText(['League', 'Rating', 'Renown', 'Current combat strength', 'Season rank', 'Human bouts']);
    await expect(own.getByRole('definition')).toHaveText(['Bronze', '1015', '25', '412', `#${ASTER_ROW.rank}`, '3 of 5']);
    const progress = own.getByRole('progressbar', { name: 'Human bouts toward season rewards' });
    await expect(progress).toHaveAttribute('aria-valuenow', '3');
    await expect(progress).toHaveAttribute('aria-valuemax', '5');
    await expect(own).toContainText('2 more human bouts in the Bronze league to qualify there. NPC bouts do not count.');
    // Notes: You on the owner's row; ✓ Eligible on rows with five human bouts in their highest league; the footnote says so.
    await expect(rowOf(page, 'Bronze', 'Aster')).toContainText('You');
    await expect(rowOf(page, 'Bronze', 'Aster')).not.toContainText('✓ Eligible');
    await expect(rowOf(page, 'Bronze', 'Severus')).toContainText('✓ Eligible');
    // The mark keeps its mixed case (as the mockup and the footnote write it), unlike the other pills.
    await expect(rowOf(page, 'Bronze', 'Severus').getByText('✓ Eligible')).toHaveCSS('text-transform', 'none');
    await expect(table(page, 'Bronze')).not.toContainText(/1st|2nd|3rd/);
    await expect(section).toContainText('✓ Eligible: has 5 or more human bouts and this is their highest qualifying league.');
    await shot(page, testInfo, 'current', { top: section });
    await shot(page, testInfo, 'current-standing', { top: own });
    expect(remote).toEqual([]);
  });

  for (const visitor of [false, true]) {
    test(`switches to a finished season with medals, no Your standing and the promotion footnote${visitor ? ' (visitor)' : ''}`, { tag: '@render' }, async ({ page, baseURL }, testInfo) => {
      const remote = forbidRemote(page, baseURL);
      await openStandings(page, visitor);
      const section = standings(page);
      await expect(section.getByRole('region', { name: 'Your standing' })).toHaveCount(visitor ? 0 : 1);
      await picker(page).selectOption({ label: 'Season 1 · ended Sat 26 Sep' });
      await expect(section.getByText('Archived season', { exact: true })).toBeVisible();
      // The finished season: frozen at the close, its end in local time with UTC, and no countdown or Your standing.
      const final = section.getByRole('region', { name: 'Season 1 final standings' });
      await expect(final).toContainText('Ended Sat 26 Sep, 03:00 your time (00:00 UTC). Frozen at the close; medals show the season rewards.');
      await expect(section.getByRole('region', { name: /ends in/ })).toHaveCount(0);
      await expect(section.getByRole('region', { name: 'Your standing' })).toHaveCount(0);
      // Frozen ranks with medals: Lucilla ranks first but was promoted and qualified in Silver, so Bronze's medals go on.
      const bronze = FIXTURE_ARCHIVE[PREVIOUS.seasonId].bronze;
      await expect(table(page, 'Bronze').locator('tbody tr')).toHaveCount(50);
      await expect(table(page, 'Bronze').locator('tbody tr').first()).toContainText(`1Lucilla${bronze[0].rating}${bronze[0].humanWins}–${bronze[0].humanLosses}Promoted`);
      await expect(rowOf(page, 'Bronze', 'Lucilla')).not.toContainText(/1st|2nd|3rd/);
      await expect(rowOf(page, 'Bronze', 'Severus')).toContainText('🥇 1st · Champion');
      // The medal is decoration: the notes cell's accessible name carries the place text once, without the emoji.
      await expect(rowOf(page, 'Bronze', 'Severus').getByRole('cell').last()).toHaveAccessibleName('1st · Champion');
      await expect(rowOf(page, 'Bronze', 'Nerva')).toContainText('🥈 2nd');
      await expect(rowOf(page, 'Bronze', 'Aster')).toContainText('🥉 3rd');
      if (visitor) await expect(table(page, 'Bronze')).not.toContainText('You');
      else await expect(rowOf(page, 'Bronze', 'Aster')).toContainText('You');
      await expect(rowOf(page, 'Bronze', 'Gallus')).toContainText('Inactive');
      await expect(table(page, 'Bronze')).not.toContainText('✓ Eligible');
      await expect(section).toContainText('Lucilla was promoted and qualified in a higher league, so only that league can reward Lucilla, and the Bronze medals go to the next eligible gladiators.');
      // Read-only: the section offers the leagues, the names, the picker and paging, and nothing else.
      const buttons = await section.getByRole('button').allTextContents();
      expect(buttons.filter(name => !['Bronze', 'Silver', 'Gold', 'Champion', 'More'].includes(name) && !bronze.some(r => r.name === name))).toEqual([]);
      if (!visitor) {
        await shot(page, testInfo, 'archived', { top: section });
        await shot(page, testInfo, 'archived-footnote', { bottom: section.getByText(/was promoted and qualified/) });
      }
      // Silver's champion is Lucilla; no promoted qualifier ranks above its medals, so the footnote gives the rule.
      await section.getByRole('group', { name: 'League' }).getByRole('button', { name: 'Silver' }).click();
      await expect(rowOf(page, 'Silver', 'Lucilla')).toContainText('🥇 1st · Champion');
      await expect(rowOf(page, 'Silver', 'Marcellus')).toContainText('🥈 2nd');
      await expect(section).toContainText('A gladiator promoted during the season is rewarded only in their highest league with at least 5 human bouts');
      // Back to the current season: its card returns (and the owner's standing).
      await picker(page).selectOption({ label: 'Season 2 · current' });
      await expect(section.getByRole('region', { name: 'Season 2 ends in 13 days 23 h' })).toBeVisible();
      await expect(section.getByRole('region', { name: 'Your standing' })).toHaveCount(visitor ? 0 : 1);
      if (visitor) await shot(page, testInfo, 'visitor', { top: section });
      expect(remote).toEqual([]);
    });
  }

  test('shows the champion title and badges on a profile card, and nothing for a gladiator without prestige', { tag: '@render' }, async ({ page }, testInfo) => {
    await openStandings(page);
    await picker(page).selectOption({ label: 'Season 1 · ended Sat 26 Sep' });
    await standings(page).getByRole('group', { name: 'League' }).getByRole('button', { name: 'Silver' }).click();
    await rowOf(page, 'Silver', 'Lucilla').getByRole('button', { name: 'Profile: Lucilla', exact: true }).click();
    const lucilla = profileCard(page, 'Lucilla');
    await expect(lucilla.getByText('Champion · Season 1 Silver', { exact: true })).toBeVisible();
    await expect(lucilla.getByRole('list', { name: 'Season badges' }).getByRole('listitem')).toHaveText(['🥇 Season 1 · Silver']);
    await shot(page, testInfo, 'profile', { top: standings(page) });
    await lucilla.getByRole('button', { name: 'Close profile' }).click();
    // A third place: a bronze badge and no title.
    await standings(page).getByRole('group', { name: 'League' }).getByRole('button', { name: 'Bronze' }).click();
    await rowOf(page, 'Bronze', 'Aster').getByRole('button', { name: 'Profile: Aster', exact: true }).click();
    const aster = profileCard(page, 'Aster');
    await expect(aster.getByRole('list', { name: 'Season badges' }).getByRole('listitem')).toHaveText(['🥉 Season 1 · Bronze']);
    await expect(aster).not.toContainText('Champion ·');
    await aster.getByRole('button', { name: 'Close profile' }).click();
    // Varro qualified in Bronze but placed fifth: no award, so no title line and no badge list.
    await rowOf(page, 'Bronze', 'Varro').getByRole('button', { name: 'Profile: Varro', exact: true }).click();
    const varro = profileCard(page, 'Varro');
    await expect(varro).toContainText(/Rating · record\s*\d+/);
    await expect(varro.getByRole('list', { name: 'Season badges' })).toHaveCount(0);
    await expect(varro).not.toContainText(/Season \d|Champion ·/);
  });

  test('fits the standings sheet at 360 px with no horizontal scroll', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await openStandings(page);
    const sheet = menuDialog(page, 'Arena');
    const body = sheet.getByTestId('menu-body');
    const fits = async () => {
      expect(await wide(page)).toBeLessThanOrEqual(0);
      expect(await body.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const box = (await picker(page).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      // The table fits its own box too: no sideways scrolling for the medals or the eligible marks.
      const [scroll, client] = await table(page, 'Bronze').evaluate(el => [el.parentElement!.scrollWidth, el.parentElement!.clientWidth]);
      expect(scroll, `table ${scroll} px in ${client} px`).toBeLessThanOrEqual(client);
    };
    await expect(standings(page).getByRole('region', { name: 'Season 2 ends in 13 days 23 h' })).toBeVisible();
    await fits();
    await shot(page, testInfo, 'phone-current', { top: standings(page) });
    await shot(page, testInfo, 'phone-standing', { top: standings(page).getByRole('region', { name: 'Your standing' }) });
    await picker(page).selectOption({ label: 'Season 1 · ended Sat 26 Sep' });
    await expect(rowOf(page, 'Bronze', 'Severus')).toContainText('🥇 1st · Champion');
    await fits();
    await shot(page, testInfo, 'phone-archived', { top: standings(page) });
    // Task 24.0c fix round 1: the fit must not depend on Segoe UI. CI's Linux runner, with another system-ui font, found the
    // archived table 342 px wide in its 332 px box. A wider stack (Verdana here, DejaVu Sans where Verdana is missing),
    // forced for this check only, must fit too: the archived season with its medal notes, then the current one.
    await page.addStyleTag({ content: 'body, body * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
    await page.evaluate(() => document.fonts.ready);
    await fits();
    await shot(page, testInfo, 'phone-archived-wide-font', { top: standings(page) });
    await picker(page).selectOption({ label: 'Season 2 · current' });
    await expect(standings(page).getByRole('region', { name: 'Season 2 ends in 13 days 23 h' })).toBeVisible();
    await fits();
  });
});

// ------------------------------------------------------------------ live mode through the test transport

const SEASON_MS = 2_419_200_000;
const liveRow = (rank: number, gladiatorId: string, name: string, extra: Partial<StandingRow> = {}): StandingRow => ({ rank, gladiatorId, name, rating: 1100 - rank,
  humanWins: 3, humanLosses: 2, promoted: false, inactive: false, rewardEligible: true, awardPlace: null, ...extra });
/** A current season ('7', Season 8) ending in 10 days, and the finished season '6' (Season 7) before it. */
function liveSeasons(now: number): SeasonView[] {
  const end = now + 10 * 86_400_000;
  return [{ seasonId: '7', startsAtMs: end - SEASON_MS, endsAtMs: end, closedAtMs: null },
    { seasonId: '6', startsAtMs: end - 2 * SEASON_MS, endsAtMs: end - SEASON_MS, closedAtMs: end - SEASON_MS + 4_000 }];
}

test.describe('seasons in live mode', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test('a visitor reads a finished season’s frozen archive, without any owner read or command', async ({ page, context }) => {
    const world = emptyWorld();
    const filler = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const current: StandingsPage = { league: 'bronze', seasonId: '7', archived: false, nextCursor: null, rows: [liveRow(1, filler(1), 'Livia')] };
    const archive: StandingsPage = { league: 'bronze', seasonId: '6', archived: true, nextCursor: null, rows: [
      liveRow(1, filler(2), 'Varro', { promoted: true, rewardEligible: false }), liveRow(2, filler(3), 'Livia', { awardPlace: 1 }),
      liveRow(3, filler(4), 'Cassia', { awardPlace: 2 }), liveRow(4, filler(5), 'Brutus', { awardPlace: 3 }),
      liveRow(5, filler(6), 'Nerva', { humanWins: 0, humanLosses: 0, inactive: true, rewardEligible: false })] };
    const live = await routeLiveReads(context, { world, standings: [current, archive], seasons: liveSeasons(world.serverNowMs) });
    await page.goto('/game/');
    await openMenu(page, 'Arena');
    await expect(rowOf(page, 'Bronze', 'Livia')).toContainText('✓ Eligible');
    await expect(standings(page).getByRole('region', { name: /^Season 8 ends in (9 days 23 h|10 days 0 h)$/ })).toBeVisible();
    await picker(page).selectOption('6');
    await expect(standings(page).getByRole('region', { name: 'Season 7 final standings' })).toBeVisible();
    await expect(rowOf(page, 'Bronze', 'Livia')).toContainText('🥇 1st · Champion');
    await expect(rowOf(page, 'Bronze', 'Brutus')).toContainText('🥉 3rd');
    await expect(rowOf(page, 'Bronze', 'Nerva')).toContainText('Inactive');
    await expect(standings(page)).toContainText('Varro was promoted and qualified in a higher league, so only that league can reward Varro, and the Bronze medals go to the next eligible gladiators.');
    await expect(standings(page).getByRole('region', { name: 'Your standing' })).toHaveCount(0);
    // The archive was read from the frozen table for that season, as a visitor; no owner state, no gladiator row read.
    const archived = live.requests.filter(r => r.table === 'season_standings');
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every(r => r.query.get('season_index') === 'eq.6' && r.reader === null)).toBe(true);
    expect(live.requests.some(r => r.table === 'owner_state' || (r.table === 'arena_standing_reads' && r.query.has('gladiator_id')))).toBe(false);
    expect(live.requests.every(r => r.reader === null)).toBe(true);
  });

  // Task 21.3 review M2: each page costs a season lookup, so the panel must not read more than it needs at a new revision.
  test('reads the current season again at each new revision, a picked finished season never, and the season list only when stale', async ({ page, context }) => {
    const world = emptyWorld();
    const filler = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const current: StandingsPage = { league: 'bronze', seasonId: '7', archived: false, nextCursor: null, rows: [liveRow(1, filler(1), 'Livia')] };
    const archive: StandingsPage = { league: 'bronze', seasonId: '6', archived: true, nextCursor: null, rows: [liveRow(1, filler(2), 'Varro', { awardPlace: 1 })] };
    const live = await routeLiveReads(context, { world, standings: [current, archive], seasons: liveSeasons(world.serverNowMs) });
    await page.clock.install();
    // Each publish fires the next 30 s poll once it is armed (tests/browser/sync-poll.ts; Task 24.0c fix round 1).
    const poll = await watchSyncPoll(page);
    await page.goto('/game/');
    await openMenu(page, 'Arena');
    await expect(rowOf(page, 'Bronze', 'Livia')).toContainText('✓ Eligible');
    const views = () => live.count('arena_standing_reads');
    const frozen = () => live.count('season_standings');
    const lists = () => live.requests.filter(r => r.table === 'seasons' && r.query.get('limit') === '50').length;
    const lookups = () => live.requests.filter(r => r.table === 'seasons' && r.query.get('limit') === '1').length;
    const worlds = () => live.count('world_actor_reads');
    // (The development server's React Strict Mode mounts the panel's effects twice, so counts at opening are not pinned.)
    await expect.poll(lists).toBeGreaterThan(0);
    const counts = () => [views(), lookups(), lists(), frozen()];
    /** The server publishes a new revision, and the sync controller's next poll (30 s) loads it. */
    const publish = async (revision: string) => {
      const seen = worlds();
      live.setWorld({ ...world, revision });
      await poll.nextSyncPoll();
      await expect.poll(worlds).toBeGreaterThan(seen);
    };
    /**
     * The panel's reads for a new revision land some time after the world's (Task 24.0c fix round 1: a fixed 500 ms was too
     * short on CI): the counts must reach `expected` and still be `expected` 500 ms later, so a late extra read fails too.
     */
    const settlesAt = async (expected: number[]) => {
      await expect.poll(counts).toEqual(expected);
      await page.waitForTimeout(500);
      expect(counts()).toEqual(expected);
    };
    // The current season: its page again (one season lookup, one view read); the list is not stale, so it is not read.
    let before = counts();
    await publish('empty-2');
    await settlesAt([before[0] + 1, before[1] + 1, before[2], before[3]]);
    // A picked finished season is read once; its frozen archive is not read again at a new revision, nor anything else.
    await picker(page).selectOption('6');
    await expect(rowOf(page, 'Bronze', 'Varro')).toContainText('🥇 1st · Champion');
    before = counts();
    expect(before[3]).toBeGreaterThan(0);
    await publish('empty-3');
    await settlesAt(before);
    // Back to the current season: read at the pick, and again at the next revision.
    await picker(page).selectOption('7');
    await expect(rowOf(page, 'Bronze', 'Livia')).toContainText('✓ Eligible');
    before = counts();
    await publish('empty-4');
    await settlesAt([before[0] + 1, before[1] + 1, before[2], before[3]]);
  });

  test('follows the current season to the next one when the newest season was closed at opening', async ({ page, context }) => {
    const world = emptyWorld();
    const filler = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    // At opening the newest season ('6') is already closed: the view follows it, as an archive.
    const archive: StandingsPage = { league: 'bronze', seasonId: '6', archived: true, nextCursor: null, rows: [liveRow(1, filler(2), 'Varro', { awardPlace: 1 })] };
    const live = await routeLiveReads(context, { world, standings: [archive] });
    await page.clock.install();
    await page.goto('/game/');
    await openMenu(page, 'Arena');
    await expect(rowOf(page, 'Bronze', 'Varro')).toContainText('🥇 1st · Champion');
    await expect(standings(page).getByText('Archived season', { exact: true })).toBeVisible();
    // A boundary opens season '7' (Season 8) with a new revision: the panel reads the current season again and lists it.
    live.setStandings([{ league: 'bronze', seasonId: '7', archived: false, nextCursor: null, rows: [liveRow(1, filler(1), 'Livia')] }, archive]);
    const seen = live.count('world_actor_reads');
    live.setWorld({ ...world, revision: 'empty-2' });
    await page.clock.fastForward(30_000);
    await expect.poll(() => live.count('world_actor_reads')).toBeGreaterThan(seen);
    await expect(rowOf(page, 'Bronze', 'Livia')).toContainText('✓ Eligible');
    await expect(standings(page).getByText('Current season', { exact: true })).toBeVisible();
    await expect(picker(page).locator('option')).toHaveText(['Season 8 · current', /^Season 7 · ended /]);
  });

  test('shows the owner’s season rank and human bouts from its own row when it is outside the loaded page', async ({ page, context }) => {
    const user = await seedSession(context);
    const owner = structuredClone(ownerFixture);
    const world = emptyWorld();
    // Fifty rows on the first page; the owner ranks 57th, so only the one-row read can tell its rank.
    const first: StandingsPage = { league: 'bronze', seasonId: '7', archived: false, nextCursor: '7:50',
      rows: Array.from({ length: 50 }, (_, i) => liveRow(i + 1, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, `Rival ${i + 1}`)) };
    const rest: StandingsPage = { league: 'bronze', seasonId: '7', archived: false, nextCursor: null, rows: [
      ...Array.from({ length: 6 }, (_, i) => liveRow(51 + i, `00000000-0000-4000-8000-${String(51 + i).padStart(12, '0')}`, `Rival ${51 + i}`)),
      liveRow(57, owner.gladiatorId, owner.name, { humanWins: 1, humanLosses: 3, rewardEligible: false })] };
    const live = await routeLiveReads(context, { world, owner, standings: [first, rest], seasons: liveSeasons(world.serverNowMs) });
    await page.goto('/game/');
    await expectOwnerShown(page, owner.name);
    await openMenu(page, 'Arena');
    await expect(table(page, 'Bronze').locator('tbody tr')).toHaveCount(50);
    const own = standings(page).getByRole('region', { name: 'Your standing' });
    await expect(own.getByRole('definition').nth(4)).toHaveText('#57');
    await expect(own.getByRole('definition').nth(5)).toHaveText('4 of 5');
    await expect(own).toContainText('1 more human bout in the Bronze league to qualify there. NPC bouts do not count.');
    // One row of the current season's live view, for the owner's league and gladiator, read as the signed-in owner.
    const mine = live.requests.filter(r => r.table === 'arena_standing_reads' && r.query.has('gladiator_id'));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(r => r.query.get('gladiator_id') === `eq.${owner.gladiatorId}` && r.query.get('league') === `eq.${owner.progression.league}`
      && r.query.get('season_index') === 'eq.7' && r.query.get('limit') === '1' && r.reader === user.id)).toBe(true);
  });
});
