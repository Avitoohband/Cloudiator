import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from './fixtures';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { OwnerState, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS, type ExpeditionFixtureKey } from '../fixtures/expedition-ids';
import { ownerFixture } from '../fixtures/domain';
import { lookFor } from '../../src/game/actors';
import { journeyMap, legPath } from '../../src/game/expedition-path';
import { stageWalks, type JourneyPoint } from '../../src/game/expedition-stage';
import { pathLength } from '../../src/game/paths';
import { planTrip, tripPositionOf } from '../../src/game/trip-replay';
import type { MapData } from '../../src/game/assets';
import { SLOT_MS, SUPABASE_URL, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { quietArrivals, touchLayout } from './shell-helpers';
import { focusDrops, focusedElement, noHorizontalScroll, watchFocus } from './a11y-helpers';
import { slotTime } from './slot-time';

// Patch A Task 9 (spec "Item 3 + Task 10", the approved mockup's live view and whole-trip replay; plan Review Focus 1, 3 and 4):
// the expedition view gets a LIVE badge and named marks while the trip runs, and replays the whole trip in about 1¼ minutes in
// chapters, from the camp's gate to the rest after it. During a running trip the replay never goes past now, and a stage revealed
// while watching unlocks its chapter without moving the position. The view names and draws the gladiator from the whole timeline
// from its first moment (the observed bug: "Gladiator" in the legacy look until the first fight). `trip()` and `seek()` (the
// fixture-only test hook) make the positions exact.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const KEYS = Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[];
const TIMELINES = Object.fromEntries(KEYS.map(key => [key, readJson(`tests/fixtures/expeditions/${key}.json`)])) as Record<ExpeditionFixtureKey, RevealedTimeline>;
const MAPS = Object.fromEntries(['woodland', 'outpost', 'mountain'].map(id => [id, readJson(`public/assets/expeditions/${id}-map.json`)])) as Record<string, MapData>;
const SPEED: number = readJson('public/assets/manifest.json').actors.gladiator.walk.tilesPerSecond;
const idOf = (key: ExpeditionFixtureKey) => EXPEDITION_FIXTURES[key].activityId;
const startOf = (key: ExpeditionFixtureKey) => TIMELINES[key].stages[0].startedAtMs;
const fights = (key: ExpeditionFixtureKey) => TIMELINES[key].stages.filter(s => s.kind === 'encounter');
const ASTER = EXPEDITION_GLADIATORS.aster;
const WOODLAND_CHAPTERS = ['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp', 'Resting'];
const LOCKED = 'Not yet: plays when it happens';

type TripState = NonNullable<ReturnType<NonNullable<Window['__cloudiatorExpedition']>['trip']>>;
const view = {
  page: (key: ExpeditionFixtureKey, extra = '') => `/expedition/?mode=fixture&activity=${idOf(key)}${extra}`,
  camp: (key: ExpeditionFixtureKey, extra = '') => `/game/?mode=fixture&view=expedition&activity=${idOf(key)}${extra}`,
  async open(page: Page, url: string) {
    await page.goto(url);
    await page.waitForFunction(() => !!window.__cloudiatorExpedition?.state(), null, { timeout: 45_000 });
  },
  state: (page: Page) => page.evaluate(() => window.__cloudiatorExpedition!.state()!),
  trip: (page: Page) => page.evaluate(() => window.__cloudiatorExpedition!.trip()) as Promise<TripState | null>,
  /** Waits for the whole-trip plan (the walking times load with the art). */
  planned: (page: Page) => page.waitForFunction(() => !!window.__cloudiatorExpedition?.trip(), null, { timeout: 45_000 }),
  seek: async (page: Page, ms: number) => { await page.evaluate(p => window.__cloudiatorExpedition!.seek(p), ms); await nextFrames(page); },
  /** Holds the server display clock at a minute of a fixture's slot. */
  hold: async (page: Page, key: ExpeditionFixtureKey, minute: number) => {
    await page.evaluate(ms => window.__cloudiatorExpedition!.freeze(ms), startOf(key) + minute * MIN);
    await nextFrames(page);
  },
  sceneReady: (page: Page) => page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 }),
  scene: (page: Page) => page.evaluate(() => window.__cloudiatorExpeditionScene!.debug()!),
};
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const bar = (page: Page) => page.getByRole('group', { name: 'Replay controls' });
const chapterList = (page: Page) => bar(page).getByRole('list', { name: 'Chapters', includeHidden: true });
/** Every chapter's label, in order (also in the touch layout, where the list is hidden). */
const chapterLabels = (page: Page) => chapterList(page).locator('button').allTextContents();
const playButton = (page: Page) => bar(page).getByRole('button', { name: 'Play', exact: true });
const pauseButton = (page: Page) => bar(page).getByRole('button', { name: 'Pause', exact: true });
const nextButton = (page: Page) => bar(page).getByRole('button', { name: 'Next chapter', exact: true });
const previousButton = (page: Page) => bar(page).getByRole('button', { name: 'Previous chapter', exact: true });
const backToLive = (page: Page) => bar(page).getByRole('button', { name: 'Back to live', exact: true });
const watchFromStart = (page: Page) => page.getByRole('button', { name: 'Watch from the start', exact: true });
const watchWholeTrip = (page: Page) => page.getByRole('button', { name: 'Watch the whole trip', exact: true });
const marks = (page: Page) => page.getByRole('list', { name: 'Trip marks' }).getByRole('listitem');
const phase = (page: Page) => page.getByRole('status', { name: 'Current stage' });
const result = (page: Page) => page.getByRole('region', { name: 'Result' });
const sceneBanner = (page: Page) => page.getByTestId('scene-banner');
const liveBadge = (page: Page) => page.getByTestId('live-badge');
const replayBadge = (page: Page) => page.getByTestId('replay-badge');
const expeditionDialog = (page: Page) => page.getByRole('dialog', { name: 'Expedition', exact: true });
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
/** The bar's time ("0:13 / now"), read from the bar's text after its buttons and chapters. */
const barTime = (page: Page) => bar(page).getByTestId('replay-time');

/** The next-slot Rest read (`recent_results` by gladiator). */
const isRestRead = (url: string) => url.includes('/rest/v1/recent_results') && new URL(url).searchParams.has('gladiator_id');

/** Goes to a chapter: its button on desktop, ⏭ and ⏮ in the touch layout (which shows one chapter name and no buttons). */
async function goToChapter(page: Page, label: string) {
  if (!(await touchLayout(page))) {
    await chapterList(page).getByRole('button', { name: label, exact: true }).click();
  } else {
    const labels = await chapterLabels(page);
    const target = labels.indexOf(label);
    expect(target, `chapter ${label} in ${labels.join(', ')}`).toBeGreaterThanOrEqual(0);
    for (let guard = 0; guard < 12; guard += 1) {
      const { index } = (await view.trip(page))!;
      if (index === target) break;
      await (index < target ? nextButton(page) : previousButton(page)).click();
    }
  }
  await expect.poll(async () => (await view.trip(page))!.index).toBe((await chapterLabels(page)).indexOf(label));
}

/** Saves an evidence screenshot in the test's output folder, and in TRIP_SHOTS when that is set (Task 9's review shots). */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const file = `${name}-${testInfo.project.name}.png`;
  await page.screenshot({ path: testInfo.outputPath(file), fullPage: true });
  if (process.env.TRIP_SHOTS) {
    mkdirSync(process.env.TRIP_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.TRIP_SHOTS}/${file}`, fullPage: true });
  }
}

/** The walking time of a leg on a fixture's map, as the planner is given it. */
const walk = (map: string) => {
  const journey = journeyMap(MAPS[map]);
  return (from: JourneyPoint, to: JourneyPoint) => (pathLength(legPath(journey, from, to)!) / SPEED) * 1000;
};

test.describe('the whole-trip replay', () => {
  test.skip(production, 'The whole-trip replay checks use the fixture timelines, which production exports never include.');
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

  test('opens a finished trip as a paused replay on its first chapter, named from the whole timeline', async ({ page }, testInfo) => {
    const look = lookFor(null, ASTER.id, fights('woodland')[0].battleLog!.participants[0].equipmentSilhouettes).layers;
    // Over the camp, from a shared link.
    await view.open(page, view.camp('woodland', '&play=trip'));
    await view.planned(page);
    const touch = await touchLayout(page);
    const dialog = expeditionDialog(page);
    await expect(replayBadge(page)).toHaveText(touch ? '▶ REPLAY' : '▶ REPLAY · THE WHOLE TRIP');
    await expect(liveBadge(page)).toHaveCount(0);
    expect(await chapterLabels(page)).toEqual(WOODLAND_CHAPTERS);
    if (touch) {
      await expect(chapterList(page)).toBeHidden();
      await expect(bar(page).getByText('1 / 8 · Leaving camp', { exact: true })).toBeVisible();
    } else {
      await expect(chapterList(page).getByRole('button')).toHaveText(WOODLAND_CHAPTERS);
      await expect(chapterList(page).getByRole('button', { name: 'Leaving camp', exact: true })).toHaveAttribute('aria-current', 'step');
    }
    await expect(playButton(page)).toBeFocused();
    await expect(barTime(page)).toHaveText(/^0:00 \/ 1:\d\d$/);
    expect(await view.trip(page)).toMatchObject({ mode: 'trip', catchUp: false, chapter: 'leaving', index: 0, positionMs: 0, playing: false, capMs: null, locked: [] });
    expect((await view.state(page)).name).toBe('Aster');
    await expect(dialog.getByText('EXPEDITION · Aster', { exact: true })).toBeVisible();
    await expect(phase(page)).toContainText('Leaving camp');
    await expect(phase(page)).toContainText('Through the gate and onto the Woodland Path.');
    await view.sceneReady(page);
    await expect.poll(async () => (await view.scene(page)).gladiator?.layers).toEqual(look);
    await expect(sceneBanner(page)).toHaveText('Leaving camp');
    await shot(page, testInfo, 'trip-leaving-camp');

    // The same on the expedition page.
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Woodland Path' })).toBeVisible();
    await expect(playButton(page)).toBeFocused();
    expect((await view.state(page)).name).toBe('Aster');
    await view.sceneReady(page);
    await expect.poll(async () => (await view.scene(page)).gladiator?.layers).toEqual(look);

    // Live at minute 1, before the first fight: still Aster, in Aster's look (the observed bug named it "Gladiator").
    await view.open(page, view.page('woodland', '&minute=1'));
    expect((await view.state(page)).name).toBe('Aster');
    await expect(page.getByText('EXPEDITION · Aster', { exact: true })).toBeVisible();
    await view.sceneReady(page);
    await expect.poll(async () => (await view.scene(page)).gladiator?.layers).toEqual(look);
    expect((await view.scene(page)).gladiator!.layers).not.toEqual(lookFor(null, ASTER.id, []).layers);
  });

  test('plays on through the chapters, steps with ⏮ ⏭ and jumps with a chapter button', async ({ page }, testInfo) => {
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    await playButton(page).click();
    await expect(pauseButton(page)).toBeVisible();
    expect((await view.trip(page))!.playing).toBe(true);
    // Leaving camp lasts 5 s: by 6 s the replay is on the trail.
    await page.waitForTimeout(6_000);
    expect(await view.trip(page)).toMatchObject({ chapter: 'trail', index: 1, playing: true });
    await pauseButton(page).click();
    const paused = (await view.trip(page))!.positionMs;
    await page.waitForTimeout(400);
    expect((await view.trip(page))!.positionMs).toBe(paused);
    await nextButton(page).click();
    await expect.poll(async () => (await view.trip(page))!.chapter).toBe('fight-1');
    await previousButton(page).click();
    await expect.poll(async () => (await view.trip(page))!.chapter).toBe('trail');
    await nextButton(page).click();
    await expect.poll(async () => (await view.trip(page))!.chapter).toBe('fight-1');
    // A chapter starts at its beginning: Fight 2 is encounter 2's start, with the scene's battle at its start.
    await goToChapter(page, 'Fight 2');
    expect(await view.trip(page)).toMatchObject({ chapter: 'fight-2', playing: false });
    expect((await view.state(page)).current).toBe('Encounter 2');
    expect((await view.state(page)).displayNowMs).toBe(fights('woodland')[1].startedAtMs);
    await view.sceneReady(page);
    await expect.poll(async () => (await view.scene(page)).battle).toEqual({ battleId: fights('woodland')[1].battleLog!.battleId, positionMs: 0 });
    await shot(page, testInfo, 'trip-fight-2');
    // ⏮ at the first chapter goes nowhere.
    await goToChapter(page, 'Leaving camp');
    await expect(previousButton(page)).toBeDisabled();
    // A hidden tab pauses the replay where it is.
    await playButton(page).click();
    await expect(pauseButton(page)).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(playButton(page)).toBeVisible();
    const hidden = (await view.trip(page))!;
    expect(hidden.playing).toBe(false);
    await page.waitForTimeout(500);
    expect((await view.trip(page))!.positionMs).toBe(hidden.positionMs);
  });

  test('shows a defeat as Fight 2 ✗ and the Safe point', async ({ page }) => {
    await view.open(page, view.page('outpost', '&minute=90&play=trip'));
    await view.planned(page);
    expect(await chapterLabels(page)).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2 ✗', 'Safe point', 'Back in camp']);
    await goToChapter(page, 'Back in camp');
    await expect(phase(page)).toContainText('Home through the gate, with all gear kept.');
  });

  test('offers Resting only after a real Rest', async ({ page, context }) => {
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    await expect.poll(() => chapterLabels(page)).toEqual(WOODLAND_CHAPTERS);
    // Mountain Pass, read live as a visitor: its next slot's public result was not a Rest. Once that one read has answered, the
    // replay ends at the gate.
    const end = startOf('mountain') + 80 * MIN;
    const { summary: _owner, ...shown } = structuredClone(TIMELINES.mountain);
    const live = await routeLiveReads(context, { world: { ...emptyWorld(end + SLOT_MS + 10 * MIN), revision: 'trip-mountain' }, timelines: { [idOf('mountain')]: shown } });
    const answered = page.waitForResponse(response => isRestRead(response.url()));
    await view.open(page, `/expedition/?activity=${idOf('mountain')}&play=trip`);
    await view.planned(page);
    await answered;
    await nextFrames(page);
    expect(live.requests.filter(r => r.table === 'recent_results' && r.query.has('gladiator_id'))).toHaveLength(1);
    expect((await chapterLabels(page)).at(-1)).toBe('Back in camp');
    expect(await chapterLabels(page)).not.toContain('Resting');
  });

  test('shows the result only from Back in camp', async ({ page }) => {
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    await goToChapter(page, 'Heading home');
    await expect(result(page)).toContainText('The result is known when the expedition returns at minute 80.');
    await expect(result(page)).not.toContainText('Success');
    await nextButton(page).click();
    await expect.poll(async () => (await view.trip(page))!.chapter).toBe('back');
    await expect(result(page)).toContainText('Success');
    await expect(phase(page)).toContainText('Home through the gate with the loot.');
    await view.sceneReady(page);
    await expect(sceneBanner(page)).toHaveText('Back in camp');
  });

  test.describe('in a pinned zone', () => {
    test.use({ timezoneId: 'Asia/Jerusalem', locale: 'en-US' });

    test('shows LIVE and named marks while the trip runs', async ({ page }, testInfo) => {
      await view.open(page, view.page('woodland', '&minute=30'));
      await view.hold(page, 'woodland', 30);
      const touch = await touchLayout(page);
      await expect(liveBadge(page)).toHaveText(touch ? 'LIVE' : 'LIVE · minute 30');
      await expect(replayBadge(page)).toHaveCount(0);
      const now = startOf('woodland') + 30 * MIN;
      const t = (minute: number) => slotTime(page, startOf('woodland') + minute * MIN, now);
      await expect(marks(page)).toHaveText([`Left camp · ${await t(0)}`, '▶ Fight 1 · won', `Fight 2 · ${await t(40)}`, `Fight 3 · ${await t(60)}`, `Back in camp · ${await t(80)}`]);
      // Only the fought fight is a button; the minute labels 0-80 are gone.
      await expect(page.getByRole('list', { name: 'Trip marks' }).getByRole('button')).toHaveCount(1);
      await expect(page.getByRole('list', { name: 'Minutes' })).toHaveCount(0);
      await expect(page.getByText('80 min', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('meter', { name: 'Expedition progress' })).toBeVisible();
      await view.sceneReady(page);
      await shot(page, testInfo, 'live-minute-30');
      // A fight being fought is "now", never won or lost.
      await view.hold(page, 'woodland', 40.02);
      await expect(marks(page).nth(2)).toHaveText('Fight 2 · now');
    });
  });

  test('rewinds to what was missed, never past now', async ({ page }, testInfo) => {
    await view.open(page, view.page('woodland', '&minute=30'));
    await view.hold(page, 'woodland', 30);
    await view.planned(page);
    const touch = await touchLayout(page);
    await watchFromStart(page).click();
    await expect(replayBadge(page)).toBeVisible();
    expect(search(page).play).toBe('trip');
    const caught = (await view.trip(page))!;
    expect(caught).toMatchObject({ mode: 'trip', catchUp: true, chapter: 'leaving', index: 0, positionMs: 0, playing: false, locked: ['fight-2', 'fight-3', 'heading-home', 'back'] });
    expect(caught.capMs).toBeGreaterThan(0);
    await expect(playButton(page)).toBeFocused();
    await expect(barTime(page)).toHaveText('0:00 / now');
    await expect(backToLive(page)).toBeVisible();
    if (!touch) {
      for (const label of ['Fight 2', 'Fight 3', 'Heading home', 'Back in camp']) {
        const chapter = chapterList(page).getByRole('button', { name: label, exact: true });
        await expect(chapter, label).toBeDisabled();
        await expect(chapter, label).toHaveAttribute('title', LOCKED);
      }
      for (const label of ['Leaving camp', 'On the trail', 'Fight 1']) await expect(chapterList(page).getByRole('button', { name: label, exact: true })).toBeEnabled();
    }
    await shot(page, testInfo, 'trip-catch-up');
    // Never past now: a seek past the cap stops at it.
    await view.seek(page, 10_000_000);
    const capped = (await view.trip(page))!;
    expect(capped.positionMs).toBe(capped.capMs);
    expect(capped.chapter).toBe('fight-1');
    expect((await view.state(page)).displayNowMs).toBe(startOf('woodland') + 30 * MIN);
    // ⏭ past the last chapter it may show returns to the live view.
    await nextButton(page).click();
    await expect(liveBadge(page)).toBeVisible();
    expect((await view.trip(page))!.mode).toBe('live');
    // A fought fight's mark opens the replay at that fight.
    await page.getByRole('list', { name: 'Trip marks' }).getByRole('button', { name: /Fight 1 · won/ }).click();
    await expect(replayBadge(page)).toBeVisible();
    const atFight = (await view.trip(page))!;
    expect(atFight).toMatchObject({ mode: 'trip', catchUp: true, chapter: 'fight-1', playing: false });
    expect((await view.state(page)).current).toBe('Encounter 1');
    // ● Back to live returns, and so does playing up to now.
    await backToLive(page).click();
    await expect(liveBadge(page)).toBeVisible();
    await watchFromStart(page).click();
    await view.seek(page, (await view.trip(page))!.capMs! - 300);
    await playButton(page).click();
    await expect(liveBadge(page)).toBeVisible({ timeout: 5_000 });
    expect((await view.trip(page))!.mode).toBe('live');
  });

  test('unlocks a chapter revealed while watching, keeping the position', async ({ page }) => {
    await view.open(page, view.page('woodland', '&minute=30'));
    await view.hold(page, 'woodland', 30);
    await view.planned(page);
    await watchFromStart(page).click();
    await goToChapter(page, 'Fight 1');
    const before = (await view.trip(page))!;
    expect(before.locked).toContain('fight-2');
    // The server clock reaches minute 45 while the replay is paused at Fight 1: Fight 2 is revealed and unlocked.
    await view.hold(page, 'woodland', 45);
    await expect.poll(async () => (await view.trip(page))!.locked).toEqual(['fight-3', 'heading-home', 'back']);
    const after = (await view.trip(page))!;
    expect(after.positionMs).toBe(before.positionMs);
    expect(after.chapter).toBe('fight-1');
    expect(after.capMs).toBeGreaterThan(before.capMs!);
    if (!(await touchLayout(page))) {
      await expect(chapterList(page).getByRole('button', { name: 'Fight 2', exact: true })).toBeEnabled();
      await expect(chapterList(page).getByRole('button', { name: 'Fight 2', exact: true })).not.toHaveAttribute('title', LOCKED);
    }
  });

  test('holds a search on its spot in the replay: no steps around it at the replay speed', async ({ page }) => {
    // The search cycle steps around its spot every few seconds of the trip; at the replay's x150 that would strobe, so the
    // replay holds the search on the spot (turns only).
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    await view.sceneReady(page);
    const t = TIMELINES.woodland;
    const plan = planTrip(t, { walkMs: walk('woodland'), resting: false, nowMs: startOf('woodland') + 200 * MIN })!;
    const [first, approach] = stageWalks(t);
    const from = first.atMs + walk('woodland')(first.from, first.to) + 2_000;
    const spot = MAPS.woodland.expedition!.searchSpots[0];
    for (let i = 0; i < 6; i += 1) {
      const displayMs = from + ((approach.atMs - 2_000 - from) * i) / 5;
      await view.seek(page, tripPositionOf(plan, displayMs));
      const { gladiator } = await view.scene(page);
      expect(gladiator, `at ${displayMs}`).toMatchObject({ x: spot.x + 0.5, y: spot.y + 0.5, action: 'search' });
    }
  });

  test('offers the whole trip on a finished live view', async ({ page }) => {
    await view.open(page, view.page('woodland'));
    await expect(watchWholeTrip(page)).toBeVisible();
    await expect(liveBadge(page)).toHaveCount(0);
    await expect(watchFromStart(page)).toHaveCount(0);
    await view.planned(page);
    await watchWholeTrip(page).click();
    await expect(replayBadge(page)).toBeVisible();
    expect(await view.trip(page)).toMatchObject({ mode: 'trip', catchUp: false, chapter: 'leaving', capMs: null });
    await expect(backToLive(page)).toHaveCount(0);
    await expect(playButton(page)).toBeFocused();
  });

  test('goes from live to the whole trip and back with the browser history, over the camp', async ({ page }) => {
    await view.open(page, view.camp('woodland'));
    await view.planned(page);
    const reads = await page.evaluate(() => window.__cloudiatorExpedition!.reads());
    await watchWholeTrip(page).click();
    await expect(replayBadge(page)).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: idOf('woodland'), play: 'trip' });
    await expect(playButton(page)).toBeFocused();
    await page.goBack();
    await expect(watchWholeTrip(page)).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: idOf('woodland') });
    expect((await view.trip(page))!.mode).toBe('live');
    await expect(watchWholeTrip(page)).toBeFocused();
    await page.goForward();
    await expect(replayBadge(page)).toBeVisible();
    expect(await view.trip(page)).toMatchObject({ mode: 'trip', chapter: 'leaving' });
    await expect(playButton(page)).toBeFocused();
    // The same view all along: switching modes reads nothing again.
    expect(await page.evaluate(() => window.__cloudiatorExpedition!.reads())).toBe(reads);
    await expect(expeditionDialog(page)).toBeVisible();
    // Back to camp leaves in one step, from the trip opened over the live view.
    await page.getByRole('button', { name: 'Back to camp', exact: true }).click();
    await expect(expeditionDialog(page)).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
  });

  test('goes from live to the whole trip and back with the browser history, on the expedition page', async ({ page }) => {
    await view.open(page, view.page('woodland'));
    await view.planned(page);
    const reads = await page.evaluate(() => window.__cloudiatorExpedition!.reads());
    await watchWholeTrip(page).click();
    await expect(replayBadge(page)).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture', activity: idOf('woodland'), play: 'trip' });
    await expect(playButton(page)).toBeFocused();
    await page.goBack();
    await expect(watchWholeTrip(page)).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture', activity: idOf('woodland') });
    await expect(watchWholeTrip(page)).toBeFocused();
    await page.goForward();
    await expect(replayBadge(page)).toBeVisible();
    expect(await view.trip(page)).toMatchObject({ mode: 'trip', chapter: 'leaving' });
    await expect(playButton(page)).toBeFocused();
    expect(search(page)).toEqual({ mode: 'fixture', activity: idOf('woodland'), play: 'trip' });
    expect(await page.evaluate(() => window.__cloudiatorExpedition!.reads())).toBe(reads);
  });

  // Fix round 1, Important 1: a finished trip opened as its replay never shows its end (the result, the later log, the arrival)
  // while the plan's walking times load; it shows the departure until the first chapter is there.
  test('never shows how the trip ended while the replay is being prepared', async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      const phases: string[] = [];
      Object.assign(window, { __tripSpoilers: seen, __tripPhases: phases });
      const check = () => {
        if (window.__cloudiatorExpedition?.trip()) return;
        const text = document.querySelector('main')?.textContent ?? '';
        for (const word of ['Defeated', 'Encounter 2: defeat', 'after a defeat', 'Arrive at camp', 'Processing results']) if (text.includes(word) && !seen.includes(word)) seen.push(word);
        // The phase while it is prepared (fix round 2): the first chapter's, so the live region does not say one thing and then another.
        const title = document.querySelector('[aria-label="Current stage"] strong')?.textContent;
        if (title && !phases.includes(title)) phases.push(title);
      };
      new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await view.open(page, view.page('outpost', '&minute=90&play=trip'));
    await view.planned(page);
    await expect(replayBadge(page)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __tripSpoilers: string[] }).__tripSpoilers)).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __tripPhases: string[] }).__tripPhases)).toEqual(['Leaving camp']);
    await expect(phase(page)).toContainText('Through the gate and onto the Ruined Outpost.');
    // Once planned, the first chapter, not the end.
    expect(await view.trip(page)).toMatchObject({ mode: 'trip', chapter: 'leaving' });
    await expect(result(page)).toContainText('The result is known when the expedition returns at minute 80.');
  });

  test('falls back to the live view when the replay cannot be planned', async ({ page }) => {
    // The walking times come with the art: a build whose art module cannot load has no plan, so the address's replay shows live.
    await page.route('**/_next/static/chunks/**', async route => {
      const response = await route.fetch();
      const body = await response.text();
      return /function loadAssetManifest\b/.test(body) ? route.abort() : route.fulfill({ response, body });
    });
    await view.open(page, view.page('woodland', '&minute=30&play=trip'));
    await view.hold(page, 'woodland', 30);
    await expect(liveBadge(page)).toBeVisible({ timeout: 10_000 });
    await expect(replayBadge(page)).toHaveCount(0);
    await expect(page.getByText('Preparing the whole trip…')).toHaveCount(0);
    await expect(marks(page)).toHaveCount(5);
    expect(await view.trip(page)).toBeNull();
    // A fight's mark is not a way into a replay that cannot be shown: it adds no history entry (fix round 2).
    const entries = await page.evaluate(() => history.length);
    const fight = page.getByRole('list', { name: 'Trip marks' }).getByRole('button', { name: /Fight 1 · won/ });
    if (await fight.count()) await fight.click();
    await expect(marks(page).nth(1)).toHaveText(/Fight 1 · won/);
    expect(await page.evaluate(() => history.length)).toBe(entries);
    await expect(liveBadge(page)).toBeVisible();
  });

  test('keeps the focus on ⏮ and ⏭ at the ends, and leaves a focus elsewhere when the replay returns to live', async ({ page }) => {
    await watchFocus(page);
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    // Keyboard only: ⏭ to the last chapter, then ⏮ to the first. The button that becomes unavailable keeps the focus.
    await expect.poll(() => chapterLabels(page)).toEqual(WOODLAND_CHAPTERS);
    await nextButton(page).focus();
    for (let i = 0; i < 9; i += 1) await page.keyboard.press('Enter');
    await expect.poll(async () => (await view.trip(page))!.chapter).toBe('resting');
    await expect(nextButton(page)).toBeFocused();
    await expect(nextButton(page)).toBeDisabled();
    await previousButton(page).focus();
    for (let i = 0; i < 9; i += 1) await page.keyboard.press('Enter');
    await expect.poll(async () => (await view.trip(page))!.chapter).toBe('leaving');
    await expect(previousButton(page)).toBeFocused();
    expect(await focusDrops(page)).toEqual([]);
    // A running trip played up to now returns to live; a focus the player put in the log stays there.
    await view.open(page, view.page('woodland', '&minute=30'));
    await view.hold(page, 'woodland', 30);
    await view.planned(page);
    await watchFromStart(page).click();
    await view.seek(page, (await view.trip(page))!.capMs! - 3_000);
    await playButton(page).click();
    const watch = page.getByRole('link', { name: 'Watch the replay of encounter 1' });
    await watch.focus();
    // Still replaying when the focus goes to the log (fix round 2: the check below is about the return to live).
    expect(await view.trip(page)).toMatchObject({ mode: 'trip', playing: true });
    await expect(liveBadge(page)).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(300);
    await expect(watch).toBeFocused();
    expect(await focusedElement(page)).toContain('Watch the replay of encounter 1');
    expect(await focusDrops(page)).toEqual([]);
  });

  // Fix round 2: a catch-up replay played up to now with ⏸ focused returns to live, and the focus goes to the live view's own
  // button ("⏪ Watch from the start"), never to <body>.
  test('gives the focus to Watch from the start when playing up to now returns to live', async ({ page }) => {
    await watchFocus(page);
    await view.open(page, view.page('woodland', '&minute=30'));
    await view.hold(page, 'woodland', 30);
    await view.planned(page);
    await watchFromStart(page).click();
    await view.seek(page, (await view.trip(page))!.capMs! - 1_500);
    await playButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(pauseButton(page)).toBeFocused();
    expect(await view.trip(page)).toMatchObject({ mode: 'trip', playing: true });
    await expect(liveBadge(page)).toBeVisible({ timeout: 8_000 });
    await expect(watchFromStart(page)).toBeFocused();
    await page.waitForTimeout(300);
    expect(await focusDrops(page)).toEqual([]);
  });

  test('phone: one chapter name with ⏮ ▶ ⏭', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    await expect(chapterList(page)).toBeHidden();
    await expect(bar(page).getByText('1 / 8 · Leaving camp', { exact: true })).toBeVisible();
    await expect(replayBadge(page)).toHaveText('▶ REPLAY');
    for (const button of [previousButton(page), playButton(page), nextButton(page)]) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await view.sceneReady(page);
    await shot(page, testInfo, 'phone-trip');
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(300);
    expect(await noHorizontalScroll(page)).toBe(true);
    await view.open(page, view.page('woodland', '&minute=30'));
    await view.hold(page, 'woodland', 30);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(liveBadge(page)).toHaveText('LIVE');
    await expect(watchFromStart(page)).toBeVisible();
    await expect(watchFromStart(page)).toHaveText('⏪');
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(300);
    expect(await noHorizontalScroll(page)).toBe(true);
    await view.sceneReady(page);
    await shot(page, testInfo, 'phone-live-360');
    await view.planned(page);
    await watchFromStart(page).click();
    await expect(backToLive(page)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await noHorizontalScroll(page)).toBe(true);
    const box = (await bar(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await bar(page).scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'phone-catch-up-360');
    // A touch screen wider than a phone keeps 44 px marks.
    if (await page.evaluate(() => matchMedia('(hover: none)').matches)) {
      await backToLive(page).click();
      await page.setViewportSize({ width: 820, height: 1000 });
      await page.waitForTimeout(300);
      const mark = (await page.getByRole('list', { name: 'Trip marks' }).getByRole('button').boundingBox())!;
      expect(mark.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('phone: the scene over the camp fits 360 × 740, live and replaying', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const dialogFits = () => expeditionDialog(page).evaluate(d => d.scrollWidth <= d.clientWidth);
    await view.open(page, view.camp('woodland'));
    await view.hold(page, 'woodland', 30);
    await view.planned(page);
    await expect(liveBadge(page)).toHaveText('LIVE');
    await expect(marks(page)).toHaveCount(5);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await dialogFits()).toBe(true);
    await watchFromStart(page).click();
    await expect(backToLive(page)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await dialogFits()).toBe(true);
    const box = (await bar(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    for (const button of [previousButton(page), playButton(page), nextButton(page), backToLive(page)]) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await bar(page).scrollIntoViewIfNeeded();
    await view.sceneReady(page);
    await shot(page, testInfo, 'phone-camp-catch-up-360');
  });

  test('lays the chapters out whole on a desktop, from a narrow window to a wide one', async ({ page }, testInfo) => {
    await view.open(page, view.page('woodland', '&play=trip'));
    await view.planned(page);
    test.skip(await touchLayout(page), 'The touch layout shows one chapter name instead of the buttons.');
    const cut = () => chapterList(page).getByRole('button').evaluateAll(buttons => buttons
      .filter(b => b.scrollWidth > b.clientWidth + 1 || b.getAttribute('title') !== b.textContent).map(b => b.textContent));
    for (const width of [1280, 900, 700, 520]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      expect(await cut(), `chapters cut or untitled at ${width} px`).toEqual([]);
      expect(await noHorizontalScroll(page)).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await goToChapter(page, 'Heading home');
    await view.sceneReady(page);
    await shot(page, testInfo, 'trip-heading-home-1280');
  });
});

test.describe('the whole-trip replay for its owner and for others', () => {
  test.skip(production, 'These checks use the test-only live transport and the fixture preview.');

  /** The Woodland sample, as the live server has it once the trip has ended. */
  const woodland = (): RevealedTimeline => structuredClone(TIMELINES.woodland);
  const tripEnd = startOf('woodland') + 80 * MIN;

  test('shows the owner, and only the owner, the stamina of the Rest', async ({ page, context }, testInfo) => {
    await seedSession(context);
    // The owner's current activity is the Rest that began when the trip ended, with 74 of 104 stamina.
    const owner: OwnerState = {
      ...structuredClone(ownerFixture), stamina: { current: 74, maximum: 104 }, processedSlotIndex: Math.floor(tripEnd / SLOT_MS),
      currentActivity: { id: randomUUID(), kind: 'rest', status: 'active', startsAtMs: tripEnd, endsAtMs: tripEnd + SLOT_MS, label: 'Resting in camp' },
    };
    const world: WorldSnapshot = { ...emptyWorld(tripEnd + 10 * MIN), revision: 'trip-owner' };
    const live = await routeLiveReads(context, { world, owner, timelines: { [idOf('woodland')]: woodland() } });
    await view.open(page, `/expedition/?activity=${idOf('woodland')}&play=trip`);
    await view.planned(page);
    const touch = await touchLayout(page);
    await expect.poll(() => chapterLabels(page)).toEqual(WOODLAND_CHAPTERS);
    // The owner's own Rest says so: no read of the next slot's result.
    expect(live.requests.filter(r => r.table === 'recent_results' && r.query.has('gladiator_id'))).toEqual([]);
    await view.seek(page, (await view.trip(page))!.totalMs - 1);
    expect((await view.trip(page))!.chapter).toBe('resting');
    await expect(phase(page)).toContainText('Resting in camp');
    await expect(phase(page)).toContainText('Sleeps through the next slot. Stamina refills to full when it ends: +30.');
    await view.sceneReady(page);
    const until = await slotTime(page, tripEnd + SLOT_MS, live.serverNowMs());
    await expect(sceneBanner(page)).toHaveText(touch ? 'Resting · stamina to 104' : `Resting until ${until} · stamina refills to 104`);
    await shot(page, testInfo, 'trip-resting-owner');

    // A visitor over the camp of the fixture preview (whose Rest read says the Woodland trip was followed by a Rest): the Rest,
    // with no stamina.
    await view.open(page, `/game/?mode=fixture&as=visitor&view=expedition&activity=${idOf('woodland')}&play=trip`);
    await view.planned(page);
    await expect.poll(() => chapterLabels(page)).toEqual(WOODLAND_CHAPTERS);
    await view.seek(page, (await view.trip(page))!.totalMs - 1);
    await expect(phase(page)).toContainText('Sleeps through the next slot.');
    await expect(phase(page)).not.toContainText('Stamina');
    await view.sceneReady(page);
    await expect(sceneBanner(page)).toHaveText(touch ? 'Resting' : /^Resting until \S+.*\S$/);
    await expect(sceneBanner(page)).not.toContainText('stamina');
  });

  test('asks once whether the next slot was a Rest, and ends at the gate when it cannot tell', async ({ page, context }) => {
    // A visitor: the next slot's public result was a Rest, settled 45 s after that slot ended.
    const restId = randomUUID();
    const restRow = { gladiatorId: ASTER.id, name: 'Aster', summary: { activityId: restId, resolvedKind: 'rest' as const, result: 'completed' as const, success: true,
      settledAtMs: tripEnd + SLOT_MS + 45_000, replayExpiry: { state: 'expired' as const } } };
    const { summary: _owner, ...shown } = woodland();
    const world: WorldSnapshot = { ...emptyWorld(tripEnd + SLOT_MS + 10 * MIN), revision: 'trip-visitor-1' };
    const live = await routeLiveReads(context, { world, timelines: { [idOf('woodland')]: shown }, recent: [restRow] });
    await view.open(page, `/expedition/?activity=${idOf('woodland')}&play=trip`);
    await view.planned(page);
    await expect.poll(() => chapterLabels(page)).toEqual(WOODLAND_CHAPTERS);
    // A new revision (seen on focus) reads the timeline again, but the Rest is asked once.
    const reads = await page.evaluate(() => window.__cloudiatorExpedition!.reads());
    await page.waitForTimeout(700);
    live.setWorld({ ...world, revision: 'trip-visitor-2' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => page.evaluate(() => window.__cloudiatorExpedition!.reads()), { timeout: 5_000 }).toBeGreaterThan(reads);
    await page.waitForTimeout(700);
    const asked = live.requests.filter(r => r.table === 'recent_results' && r.query.has('gladiator_id'));
    expect(asked).toHaveLength(1);
    expect(asked[0].query.get('gladiator_id')).toBe(`eq.${ASTER.id}`);

    // When the read fails (the server refuses it), the replay ends at the gate, with no error. The timeline's own read of the
    // public completion (`activity_id`) is still served.
    let refused = 0;
    await page.route(`${SUPABASE_URL}/rest/v1/recent_results**`, route => {
      if (route.request().method() !== 'GET' || !new URL(route.request().url()).searchParams.has('gladiator_id')) return route.fallback();
      refused += 1;
      return route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'internal error' }) });
    });
    const refusedAnswer = page.waitForResponse(response => isRestRead(response.url()));
    await view.open(page, `/expedition/?activity=${idOf('woodland')}&play=trip`);
    await view.planned(page);
    await refusedAnswer;
    await nextFrames(page);
    expect(refused).toBe(1);
    expect(await chapterLabels(page)).toEqual(WOODLAND_CHAPTERS.slice(0, -1));
    // (Next's route announcer is an empty alert region: no alert says anything.)
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(page.getByText(/cannot be loaded|not available/)).toHaveCount(0);
    expect(refused).toBe(1);
  });

  test('rebuilds the chapters when a fight ends on the display clock, before any new read', async ({ page, context }) => {
    // The Ruined Outpost's lost fight 2, 2 s in, as the live server has it: its result is the log's, but not shown until it ends.
    const lost = fights('outpost')[1];
    const timeline = structuredClone(TIMELINES.outpost);
    const { summary: _none, completion: _later, ...shown } = timeline;
    const serverNow = lost.startedAtMs + 2_000;
    const world: WorldSnapshot = { ...emptyWorld(serverNow), revision: 'trip-boundary' };
    const live = await routeLiveReads(context, { world, timelines: { [idOf('outpost')]: shown }, serverNowMs: () => serverNow });
    await view.open(page, `/expedition/?activity=${idOf('outpost')}`);
    await view.planned(page);
    await page.evaluate(ms => window.__cloudiatorExpedition!.freeze(ms), serverNow);
    await watchFromStart(page).click();
    await expect.poll(() => chapterLabels(page)).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2', 'Fight 3', 'Heading home', 'Back in camp']);
    // Hold the reads, then let the display clock pass the fight's end: the chapters change without a read.
    const release = live.hold('visible_events');
    const reads = live.count('visible_events');
    await page.evaluate(ms => window.__cloudiatorExpedition!.freeze(ms), lost.endsAtMs + 1_000);
    await expect.poll(() => chapterLabels(page)).toEqual(['Leaving camp', 'On the trail', 'Fight 1', 'Fight 2 ✗', 'Safe point', 'Back in camp']);
    expect(live.count('visible_events')).toBeLessThanOrEqual(reads + 1);
    release();
  });
});
