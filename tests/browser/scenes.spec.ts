import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from './fixtures';
import type { BattleLog, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { PublicActor, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS } from '../fixtures/expedition-ids';
import { ARENA_ACTIVITIES, arenaActivityId } from '../fixtures/arena-ids';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { noHorizontalScroll } from './a11y-helpers';
import { SLOT_MS, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { reviewShot, reviewShot360 } from './review-shots';
import { everyoneResults, menuDialog, openMenu, quietArrivals } from './shell-helpers';

// Task 13.8 (spec "Scenes", plan Decision 4): a replay or an expedition opens as a full-screen scene over the running
// camp, with "Back to camp", as a history entry on the camp's own route (`?view=replay|expedition&activity=…`); the
// browser's Back closes it as well. The /replay/ and /expedition/ pages stay as deep links. A visitor's guessed or
// unrevealed activity is "not available yet", with no summary, never an endless "Preparing" or an error page (Review
// Focus 3). Visitors never see rewards or an owner summary in a scene.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** Text that only an owner's settled summary holds (its credited rewards and rating change); no visitor's scene shows it. */
const REWARDS = /\+\d+ (money|gold|renown|XP)|Credited rewards|Credited for|Rating [+−-]\d|No rating change|Light boots|Salvage/;

/** A scene over the camp: the replay or the expedition dialog. */
const scene = (page: Page, name: 'Replay' | 'Expedition') => page.getByRole('dialog', { name, exact: true });
/** A scene opened from no menu: its Back button names the camp ("Back to Camp"; the lookup is not case-sensitive). */
const backToCamp = (page: Page) => page.getByRole('button', { name: 'Back to camp' });
/** A scene's Back button names where it goes: "← Results", "← Arena", "← Gladiators" or "← Camp" (Arena replays Task 3). */
const backTo = (page: Page, label: 'Camp' | 'Results' | 'Arena' | 'Gladiators' | 'My bouts' | 'Notifications' | 'Tournaments') =>
  page.getByRole('button', { name: `Back to ${label}`, exact: true });
const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
async function openCamp(page: Page, url: string) {
  await page.goto(url);
  await campReady(page);
}
/** The search of the current address, as an object. */
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** Waits for a scene's fade-in (and anything else animating on the page) before an evidence screenshot. */
const settled = async (page: Page) => { await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished))); await nextFrames(page); };

/** A fixture expedition timeline moved so that it departed `minutesAgo` before `nowMs`, with no owner summary. */
function liveExpedition(key: keyof typeof EXPEDITION_FIXTURES, nowMs: number, minutesAgo: number): RevealedTimeline {
  const timeline = readJson(`tests/fixtures/expeditions/${key}.json`) as RevealedTimeline;
  const delta = nowMs - minutesAgo * MIN - timeline.stages[0].startedAtMs;
  return {
    activityId: timeline.activityId, serverNowMs: nowMs, visibleThroughMs: nowMs,
    stages: timeline.stages.map(s => ({ ...s, revealedAtMs: s.revealedAtMs + delta, startedAtMs: s.startedAtMs + delta, endsAtMs: s.endsAtMs + delta })),
  };
}
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
/**
 * Another tab signs this account out: supabase-js there removes the stored session the tabs share and tells the other
 * tabs' clients (its BroadcastChannel, named after the storage key), so this tab's session state ends without a reload.
 */
const signOutInAnotherTab = (page: Page) => page.evaluate(() => {
  localStorage.removeItem('sb-127-auth-token');
  const channel = new BroadcastChannel('sb-127-auth-token');
  channel.postMessage({ event: 'SIGNED_OUT', session: null });
  channel.close();
});

/** Varro, away on the shifted Ruined Outpost expedition: the public actor a visitor's world shows. */
function awayActor(timeline: RevealedTimeline): PublicActor {
  const start = timeline.stages[0].startedAtMs;
  return { gladiatorId: EXPEDITION_GLADIATORS.varro.id, name: 'Varro', classId: 'duelist', equipmentSilhouettes: ['weapon-sword'], appearance: null, league: 'bronze', level: 6,
    phase: 'afternoon', location: 'expedition:outpost', activityId: timeline.activityId, activityStatus: 'active', startsAtMs: start, endsAtMs: start + SLOT_MS,
    visibleStage: null, resting: false };
}

test.describe('replays and expeditions over the camp (fixture preview)', () => {
  test.skip(production, 'These checks use the fixture preview.');

  test('opens a replay full screen over the camp and returns with its Back button', async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    const results = await everyoneResults(page);
    const replay = results.getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first();
    await replay.click();
    const replayScene = scene(page, 'Replay');
    await expect(replayScene).toBeVisible();
    // A history entry on the camp's own route (plan Decision 4); the newest Arena win is the pvp sample.
    expect(new URL(page.url()).pathname).toBe('/game/');
    // A row of Results' Everyone: its Back button says so (Arena replays Task 3).
    expect(search(page)).toEqual({ mode: 'fixture', view: 'replay', activity: REPLAY_FIXTURES.pvp.activityId, from: 'results' });
    await expect(replayScene.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await page.waitForFunction(() => !!window.__cloudiatorReplay?.state(), null, { timeout: 45_000 });
    // Full window, over the camp, which stays ready (paused beneath it since Task 23.4); Back takes the focus.
    const viewport = page.viewportSize()!;
    expect(await replayScene.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    await expect(backTo(page, 'Results')).toBeFocused();
    expect(await page.evaluate(() => window.__cloudiatorCamp!.state()!.ready)).toBe(true);
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`scene-replay-${testInfo.project.name}.png`) });
    await backTo(page, 'Results').click();
    await expect(replayScene).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    // The camp is the same, still ready, with its one canvas; the focus goes back to the Replay button.
    expect(await page.evaluate(() => ({ ready: window.__cloudiatorCamp!.state()!.ready, canvases: window.__cloudiatorCamp!.canvases(), replay: !!window.__cloudiatorReplay })))
      .toEqual({ ready: true, canvases: 1, replay: false });
    await expect(replay).toBeFocused();
    await expect(menuDialog(page, 'Results')).toBeVisible();
  });

  test('closes the scene with the browser Back button', async ({ page }) => {
    await openCamp(page, '/game/?mode=fixture');
    await (await everyoneResults(page)).getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first().click();
    await expect(scene(page, 'Replay')).toBeVisible();
    const opened = page.url();
    await page.goBack();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    expect(await page.evaluate(() => ({ ready: window.__cloudiatorCamp!.state()!.ready, canvases: window.__cloudiatorCamp!.canvases() }))).toEqual({ ready: true, canvases: 1 });
    // Forward opens it again; Back to camp then returns to that same camp entry.
    await page.goForward();
    await expect(scene(page, 'Replay')).toBeVisible();
    expect(page.url()).toBe(opened);
    await backTo(page, 'Results').click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    await page.goForward();
    await expect(scene(page, 'Replay')).toBeVisible();
  });

  test('opens an expedition result over the camp as its expedition scene', async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    const results = await everyoneResults(page);
    const woodland = EXPEDITION_FIXTURES.woodland.activityId;
    // The 13.7 review: Results sent every kind to the battle replay. An expedition (the newest is the Woodland Path
    // sample) opens its expedition scene.
    await results.getByRole('button', { name: /^Replay: Aster returned victorious from an expedition/ }).first().click();
    const expedition = scene(page, 'Expedition');
    await expect(expedition).toBeVisible();
    // A result opens the whole-trip replay (Patch A Task 8): its address carries `play=trip`, and the view opens as that replay (Task 9).
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: woodland, play: 'trip', from: 'results' });
    await expect(expedition.getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Replay')).toHaveCount(0);
    // Over the camp the scene has no Camp link of its own, only its Back button.
    await expect(expedition.getByRole('link', { name: 'Camp', exact: true })).toHaveCount(0);
    await page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 });
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`scene-expedition-result-${testInfo.project.name}.png`) });
    // Its encounter replays open the replay scene; Back to camp returns to the camp, not to the expedition. The whole-trip replay
    // starts at "Leaving camp", whose log has only the departure: at its end the log holds every encounter (Patch A Task 9).
    await expect(expedition.getByRole('button', { name: 'Play', exact: true })).toBeFocused();
    await page.evaluate(() => window.__cloudiatorExpedition!.seek(Number.MAX_SAFE_INTEGER));
    const watch = expedition.getByRole('button', { name: /^Watch the replay of encounter 1$/ });
    await watch.click();
    await expect(scene(page, 'Replay')).toBeVisible();
    // The encounter's replay goes back to where the expedition did.
    expect(search(page)).toEqual({ mode: 'fixture', view: 'replay', activity: woodland, stage: `${woodland}:1`, from: 'results' });
    // The focus moves with the scene (fix round 1, M6): to its Back button, never to <body>.
    await expect(backTo(page, 'Results')).toBeFocused();
    await expect(scene(page, 'Replay').getByRole('button', { name: 'Encounter 1: victory', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // The browser's Back returns to the expedition scene, again with the focus in the scene: its whole-trip replay starts with ▶
    // focused (Patch A Task 9).
    await page.goBack();
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Expedition').getByRole('button', { name: 'Play', exact: true })).toBeFocused();
    await page.goForward();
    await expect(scene(page, 'Replay')).toBeVisible();
    await expect(backTo(page, 'Results')).toBeFocused();
    await backTo(page, 'Results').click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    await expect(scene(page, 'Expedition')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    // The bridge events are the scenes' one way in: a view-expedition or view-replay from the scene opens them too.
    await page.evaluate(id => window.__cloudiatorCamp!.emit('view-expedition', { activityId: id }), woodland);
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await backToCamp(page).click();
    await page.evaluate(id => window.__cloudiatorCamp!.emit('view-replay', { activityId: id, stageId: null }), REPLAY_FIXTURES.pvp.activityId);
    await expect(scene(page, 'Replay').getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await page.keyboard.press('Escape');
    await expect(scene(page, 'Replay')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
  });

  test('carries the whole-trip address (&play=trip) on an expedition scene and on its page, and ignores any other play', async ({ page }) => {
    const woodland = EXPEDITION_FIXTURES.woodland.activityId;
    // A shared link opens the expedition over the camp with its play kept in the address, as the whole-trip replay (Task 9); Back
    // to camp drops it.
    await page.goto(`/game/?mode=fixture&view=expedition&activity=${woodland}&play=trip`);
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Expedition').getByTestId('replay-badge')).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: woodland, play: 'trip' });
    await campReady(page);
    await backToCamp(page).click();
    await expect(scene(page, 'Expedition')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    // The camp's own sample link is the live view of the same expedition: no play in its address.
    await page.evaluate(id => window.__cloudiatorCamp!.emit('view-expedition', { activityId: id }), woodland);
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: woodland });
    await backToCamp(page).click();
    // Any other value is ignored: the scene opens, and a result's whole-trip replay is a different scene from the live one.
    await page.goto(`/game/?mode=fixture&view=expedition&activity=${woodland}&play=fast`);
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Expedition').getByRole('button', { name: 'Watch the whole trip', exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Expedition').getByTestId('replay-badge')).toHaveCount(0);
    // The deep link page takes the same address.
    await page.goto(`/expedition/?mode=fixture&activity=${woodland}&play=trip`);
    await expect(page.getByRole('heading', { level: 1, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('replay-badge')).toBeVisible();
    await page.goto(`/expedition/?mode=fixture&activity=${woodland}&play=fast`);
    await expect(page.getByRole('heading', { level: 1, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('replay-badge')).toHaveCount(0);
  });

  test('keeps /replay/ and /expedition/ deep links working', async ({ page }) => {
    await page.goto(`/replay/?mode=fixture&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('link', { name: 'Back to camp' })).toHaveAttribute('href', '/game/?mode=fixture');
    await page.goto(`/expedition/?mode=fixture&activity=${EXPEDITION_FIXTURES.woodland.activityId}&minute=39`);
    await expect(page.getByRole('heading', { level: 1, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('link', { name: 'Camp', exact: true })).toHaveAttribute('href', '/game/?mode=fixture');
    // A shared camp link with a scene opens it straight over the camp; Back to camp stays on the camp's route.
    await page.goto(`/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.npc.activityId}`);
    await expect(scene(page, 'Replay').getByRole('heading', { level: 2, name: 'Aster vs Iron Warden' })).toBeVisible({ timeout: 45_000 });
    await campReady(page);
    await backToCamp(page).click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/game/');
    expect(search(page)).toEqual({ mode: 'fixture' });
    expect(await page.evaluate(() => window.__cloudiatorCamp!.state()!.ready)).toBe(true);
    await page.goto(`/?mode=fixture&view=expedition&activity=${EXPEDITION_FIXTURES.mountain.activityId}`);
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Mountain Pass' })).toBeVisible({ timeout: 45_000 });
    await backToCamp(page).click();
    await expect(scene(page, 'Expedition')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(search(page)).toEqual({ mode: 'fixture' });
  });

  test('never shows a visitor the owner rewards in a scene', async ({ page }) => {
    await openCamp(page, '/game/?mode=fixture&as=visitor');
    // The newest Arena win is the pvp sample, whose owner summary credits renown and a rating change.
    await (await openMenu(page, 'Results')).getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first().click();
    const replay = scene(page, 'Replay');
    await expect(replay.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    expect(search(page).activity).toBe(REPLAY_FIXTURES.pvp.activityId);
    await replay.getByRole('button', { name: 'Skip to result' }).click();
    await expect(replay.getByRole('region', { name: 'Result' })).toContainText('wins');
    await expect(replay).not.toContainText(REWARDS);
    // Nor a promise of rewards that are not theirs (fix round 1, M5).
    await expect(replay).not.toContainText(/Rewards are credited/i);
    await backTo(page, 'Results').click();
    await page.goto(`/game/?mode=fixture&as=visitor&view=expedition&activity=${EXPEDITION_FIXTURES.woodland.activityId}`);
    const expedition = scene(page, 'Expedition');
    await expect(expedition.getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(expedition.getByRole('region', { name: 'Result' })).toContainText('Success');
    await expect(expedition).not.toContainText(REWARDS);
    await expect(expedition).toContainText("Another gladiator's expedition");
  });

  test('opens the fixture samples over the camp', async ({ page }) => {
    // Fix round 1, M10: the Results menu's sample replays and expeditions are scenes over the camp too (spec "Scenes").
    await openCamp(page, '/game/?mode=fixture');
    const results = await openMenu(page, 'Results');
    await results.getByRole('navigation', { name: 'Sample replays' }).getByRole('link', { name: REPLAY_FIXTURES.npc.label }).click();
    await expect(scene(page, 'Replay').getByRole('heading', { level: 2, name: 'Aster vs Iron Warden' })).toBeVisible({ timeout: 45_000 });
    expect(new URL(page.url()).pathname).toBe('/game/');
    // The sample rows are Results' own: Back goes there.
    expect(search(page)).toEqual({ mode: 'fixture', view: 'replay', activity: REPLAY_FIXTURES.npc.activityId, from: 'results' });
    await backTo(page, 'Results').click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    await results.getByRole('navigation', { name: 'Sample expeditions' }).getByRole('link', { name: EXPEDITION_FIXTURES.mountain.label }).click();
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Mountain Pass' })).toBeVisible({ timeout: 45_000 });
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: EXPEDITION_FIXTURES.mountain.activityId, from: 'results' });
    await backTo(page, 'Results').click();
    await expect(scene(page, 'Expedition')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    expect(await page.evaluate(() => ({ ready: window.__cloudiatorCamp!.state()!.ready, canvases: window.__cloudiatorCamp!.canvases() }))).toEqual({ ready: true, canvases: 1 });
  });

  test('names where the scene goes back to, and opens it after a reload', async ({ page, context }, testInfo) => {
    // Arena replays Task 3 (spec 5): a scene's Back button names the menu it came from, "← Results", "← Arena", "← Camp", with the
    // accessible name "Back to Results"; a `from` in the address keeps that across a reload, and a menu that is not open when the
    // scene closes is opened. A scene is one history entry over the camp, whatever its origin.
    await quietArrivals(context);
    await openCamp(page, '/game/?mode=fixture');
    const atCamp = await page.evaluate(() => history.length);
    const replayScene = scene(page, 'Replay');
    const menusOpen = () => page.locator('[data-menu-surface]:visible');
    const openRow = async () => (await everyoneResults(page)).getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first().click();

    // A row of Results' Everyone: "← Results", and Back returns with Results open.
    await openRow();
    await expect(replayScene).toBeVisible();
    await expect(backTo(page, 'Results')).toHaveText('← Results');
    expect(await page.evaluate(() => history.length)).toBe(atCamp + 1);
    await settled(page);
    await reviewShot(page, testInfo, 'scene-back-results');
    await reviewShot360(page, testInfo, 'scene-back-results');
    await backTo(page, 'Results').click();
    await expect(replayScene).toHaveCount(0);
    await expect(menuDialog(page, 'Results')).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(atCamp + 1);

    // A reload with the scene open still says "← Results", and Back opens Results, which the reload closed.
    await openRow();
    await expect(replayScene).toBeVisible();
    await page.reload();
    await campReady(page);
    await expect(replayScene).toBeVisible();
    await expect(backTo(page, 'Results')).toHaveText('← Results');
    await expect(menusOpen()).toHaveCount(0);
    await backTo(page, 'Results').click();
    await expect(replayScene).toHaveCount(0);
    await expect(menuDialog(page, 'Results')).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture' });

    // The Arena card's Watch replay: "← Arena", with Arena still open beneath; after a reload Escape opens it again.
    const bout = ARENA_ACTIVITIES.ownerNpcWin;
    const slotStart = worldFixture.serverNowMs - (worldFixture.serverNowMs % SLOT_MS) - bout.slotsAgo * SLOT_MS;
    await openMenu(page, 'Arena');
    await page.getByRole('button', { name: bout.label, exact: true }).click();
    await page.waitForFunction(id => window.__cloudiatorArena?.state()?.activityId === id, arenaActivityId('ownerNpcWin'));
    await page.evaluate(ms => window.__cloudiatorArena!.freeze(ms), slotStart + 61 * MIN);
    const watch = page.getByRole('button', { name: 'Watch replay' });
    await expect(watch).toBeEnabled();
    await watch.click();
    await expect(replayScene).toBeVisible();
    await expect(backTo(page, 'Arena')).toHaveText('← Arena');
    expect(search(page).from).toBe('arena');
    await settled(page);
    await reviewShot(page, testInfo, 'scene-back-arena');
    await page.keyboard.press('Escape');
    await expect(replayScene).toHaveCount(0);
    await expect(menuDialog(page, 'Arena')).toBeVisible();
    await watch.click();
    await expect(backTo(page, 'Arena')).toBeVisible();
    await page.reload();
    await campReady(page);
    await expect(backTo(page, 'Arena')).toHaveText('← Arena');
    await expect(menusOpen()).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(replayScene).toHaveCount(0);
    await expect(menuDialog(page, 'Arena')).toBeVisible();

    // A shared link has no camp entry below it: closing it replaces its entry, and still opens the origin it names.
    await page.goto(`/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}&from=gladiators`);
    await campReady(page);
    await expect(backTo(page, 'Gladiators')).toHaveText('← Gladiators');
    await expect(menusOpen()).toHaveCount(0);
    await backTo(page, 'Gladiators').click();
    await expect(replayScene).toHaveCount(0);
    await expect(menuDialog(page, 'Gladiators')).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture' });

    // An address without a `from` says "← Camp" and opens no menu: not when it closes, and not by the browser's Back after a reload.
    await page.goto(`/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await campReady(page);
    await expect(replayScene).toBeVisible();
    await expect(backTo(page, 'Camp')).toHaveText('← Camp');
    await settled(page);
    await reviewShot(page, testInfo, 'scene-back-camp');
    await backTo(page, 'Camp').click();
    await expect(replayScene).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    await expect(menusOpen()).toHaveCount(0);
    await page.evaluate(id => window.__cloudiatorCamp!.emit('view-replay', { activityId: id, stageId: null }), REPLAY_FIXTURES.pvp.activityId);
    await expect(backTo(page, 'Camp')).toBeVisible();
    await page.reload();
    await campReady(page);
    await expect(backTo(page, 'Camp')).toHaveText('← Camp');
    await page.goBack();
    await expect(replayScene).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    await expect(menusOpen()).toHaveCount(0);
    // With a `from`, the browser's Back after a reload opens the origin, as the button does.
    await openRow();
    await expect(backTo(page, 'Results')).toBeVisible();
    await page.reload();
    await campReady(page);
    await expect(backTo(page, 'Results')).toBeVisible();
    await expect(menusOpen()).toHaveCount(0);
    await page.goBack();
    await expect(replayScene).toHaveCount(0);
    await expect(menuDialog(page, 'Results')).toBeVisible();
  });

  test('phone: Back sits in a solid bar at the top of the scene, which stays there as it scrolls', async ({ page, context }, testInfo) => {
    // Arena replays Task 3 (spec 2): the scene's header is solid on a phone, so nothing floats over the content once you scroll.
    await quietArrivals(context);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCamp(page, `/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}&from=results`);
    const replayScene = scene(page, 'Replay');
    await expect(replayScene.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    await settled(page);
    await reviewShot(page, testInfo, 'scene-back-390-top');
    await replayScene.evaluate(element => { element.scrollTop = 400; });
    // The scene is tall enough to scroll 400 px, and has done so.
    expect(await replayScene.evaluate(element => element.scrollTop)).toBe(400);
    await nextFrames(page);
    const bar = page.getByTestId('scene-top');
    const box = (await bar.boundingBox())!;
    const button = (await backTo(page, 'Results').boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBe(390);
    expect(button.y + button.height).toBeLessThanOrEqual(box.y + box.height);
    // Opaque: nothing of the content scrolling beneath shows through it.
    const alpha = await bar.evaluate(element => {
      const [, channels = ''] = /rgba?\(([^)]*)\)/.exec(getComputedStyle(element).backgroundColor) ?? [];
      const parts = channels.split(/[,/\s]+/).filter(Boolean);
      return parts.length > 3 ? Number(parts[3]) : 1;
    });
    expect(alpha).toBe(1);
    await reviewShot(page, testInfo, 'scene-back-390-scrolled');
    // The phone at 360 x 740: the bar and its button fit, and the page does not scroll sideways.
    await page.setViewportSize({ width: 360, height: 740 });
    await nextFrames(page);
    const narrow = (await backTo(page, 'Results').boundingBox())!;
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(360);
    expect(narrow.height).toBeGreaterThanOrEqual(44);
    expect(await noHorizontalScroll(page)).toBe(true);
    await reviewShot(page, testInfo, 'scene-back-360-scrolled');
  });

  test('phone: a control Tab reaches is scrolled clear of the bar, never left under it', async ({ page, context }, testInfo) => {
    // Arena replays Task 3 review, carried to Task 4 (WCAG 2.4.11, focus not obscured): the bar is sticky and solid, so the scene keeps
    // 72 px of scroll padding at its top. A control the bar covers is scrolled out from under it when Tab reaches it.
    await quietArrivals(context);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCamp(page, `/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}&from=results`);
    const replayScene = scene(page, 'Replay');
    await expect(replayScene.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    const back = backTo(page, 'Results');
    // The control after Back in the Tab order.
    await back.focus();
    await page.keyboard.press('Tab');
    await page.evaluate(() => document.activeElement!.setAttribute('data-tab-probe', ''));
    const probe = page.locator('[data-tab-probe]');
    expect(await probe.count()).toBe(1);
    // Scrolled so that control sits under the bar (its top 12 px below the window's), with the focus back on Back.
    await back.focus();
    await replayScene.evaluate(element => { element.scrollTop += element.querySelector('[data-tab-probe]')!.getBoundingClientRect().top - 12; });
    await nextFrames(page);
    const bar = (await page.getByTestId('scene-top').boundingBox())!;
    expect((await probe.boundingBox())!.y).toBeLessThan(bar.y + bar.height);
    await page.keyboard.press('Tab');
    await expect(probe).toBeFocused();
    await nextFrames(page);
    expect((await probe.boundingBox())!.y, 'the focused control starts below the bar').toBeGreaterThanOrEqual(bar.y + bar.height);
    await reviewShot(page, testInfo, 'scene-tab-clear-of-bar');
  });

  test('phone: every origin’s Back fits the bar at 360 px', async ({ page, context }, testInfo) => {
    // Arena replays Task 3 review, carried to Task 4: the longest labels, "← Notifications" and "← Tournaments", fit a 360 px phone.
    await quietArrivals(context);
    await page.setViewportSize({ width: 360, height: 740 });
    for (const [from, label] of [['notifications', 'Notifications'], ['tournaments', 'Tournaments'], ['bouts-lost', 'My bouts']] as const) {
      await openCamp(page, `/game/?mode=fixture&view=replay&activity=${REPLAY_FIXTURES.pvp.activityId}&from=${from}`);
      const back = backTo(page, label);
      await expect(back).toHaveText(`← ${label}`);
      const box = (await back.boundingBox())!;
      const bar = (await page.getByTestId('scene-top').boundingBox())!;
      expect(box.x, label).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, label).toBeLessThanOrEqual(360);
      expect(box.height, label).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height, label).toBeLessThanOrEqual(bar.y + bar.height);
      // One line: the label does not wrap (its text boxes share a line; the arrow glyph sits a little differently).
      expect(await back.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const tops = [...range.getClientRects()].map(r => r.top); return Math.max(...tops) - Math.min(...tops); }), label).toBeLessThan(8);
      expect(await noHorizontalScroll(page), label).toBe(true);
      if (from === 'notifications') await reviewShot(page, testInfo, 'scene-back-360-notifications');
    }
  });

  test("releases each closed scene's WebGL context, so the camp's is never the one the browser drops", async ({ page }) => {
    // Fix round 1, I1: Phaser 4.2.1 never releases its context, and Chromium force-loses the oldest live one past its cap
    // (16 on desktop), which is the camp's. Every WebGL context the page creates is recorded.
    test.setTimeout(240_000);
    await page.addInitScript(() => {
      const made: { canvas: HTMLCanvasElement; gl: WebGLRenderingContext }[] = [];
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        const context = (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
        if (context && /webgl/.test(type) && !made.some(m => m.gl === context)) made.push({ canvas: this, gl: context as WebGLRenderingContext });
        return context;
      } as typeof original;
      // A game's canvas joins the page; a feature probe's never does.
      const attached = new WeakSet<Element>();
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node instanceof HTMLCanvasElement) attached.add(node);
          node.querySelectorAll('canvas').forEach(canvas => attached.add(canvas));
        }
      }).observe(document, { childList: true, subtree: true });
      (window as unknown as { __webgl: () => unknown }).__webgl = () => made.map(m => ({
        camp: !!m.canvas.closest('[data-camp-view]'), attached: attached.has(m.canvas), connected: m.canvas.isConnected, lost: m.gl.isContextLost() }));
    });
    type Context = { camp: boolean; attached: boolean; connected: boolean; lost: boolean };
    const contexts = () => page.evaluate(() => (window as unknown as { __webgl: () => Context[] }).__webgl());
    await openCamp(page, '/game/?mode=fixture');
    const woodland = EXPEDITION_FIXTURES.woodland.activityId;
    const battleReady = (id: string) => page.waitForFunction(b => window.__cloudiatorReplay?.state().battleId === b && window.__cloudiatorBattle?.debug()?.ready === true, id, { timeout: 45_000 });
    for (let round = 0; round < 6; round += 1) {
      // A replay with its three encounters (each a scene of its own), then an expedition.
      await page.evaluate(id => window.__cloudiatorCamp!.emit('view-replay', { activityId: id, stageId: null }), REPLAY_FIXTURES.expedition.activityId);
      const replay = scene(page, 'Replay');
      await battleReady(REPLAY_FIXTURES.expedition.battleIds[0]);
      for (const n of [1, 2]) {
        await replay.getByRole('group', { name: 'Encounters' }).getByRole('button').nth(n).click();
        await battleReady(REPLAY_FIXTURES.expedition.battleIds[n]);
      }
      await backToCamp(page).click();
      await expect(replay).toHaveCount(0);
      await page.evaluate(id => window.__cloudiatorCamp!.emit('view-expedition', { activityId: id }), woodland);
      await page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 });
      await backToCamp(page).click();
      await expect(scene(page, 'Expedition')).toHaveCount(0);
    }
    await expect.poll(async () => (await contexts()).filter(c => c.attached && !c.connected && !c.lost).length, { timeout: 5_000 }).toBe(0);
    const all = await contexts();
    // Far more scenes than the browser's cap came and went...
    expect(all.filter(c => c.attached && !c.camp).length).toBeGreaterThan(20);
    // ...each one's context is released once it closed, and the camp's own is live, with the camp still ready.
    expect(all.filter(c => c.camp)).toEqual([{ camp: true, attached: true, connected: true, lost: false }]);
    // Besides them, only Phaser's own WebGL feature probe (made once per page, never shown) is left as it was.
    expect(all.filter(c => !c.attached && !c.lost).length).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-camp-view] canvas')!;
      return { lost: (canvas.getContext('webgl') as WebGLRenderingContext).isContextLost(), ready: window.__cloudiatorCamp!.state()!.ready };
    })).toEqual({ lost: false, ready: true });
  });
});

test.describe('replays and expeditions over the live camp for a visitor', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test("opens an away gladiator's expedition from the Gladiators list", async ({ page, context }, testInfo) => {
    const now = Date.now();
    const timeline = liveExpedition('spectator', now, 30);
    const world: WorldSnapshot = { ...emptyWorld(now), revision: 'scenes-1', actors: [awayActor(timeline)] };
    const live = await routeLiveReads(context, { world, timelines: { [timeline.activityId]: timeline } });
    const commands: string[] = [];
    page.on('request', request => { if (request.url().includes('/functions/v1/')) commands.push(request.url()); });
    await openCamp(page, '/game/');
    const gladiators = await openMenu(page, 'Gladiators');
    const row = gladiators.getByRole('listitem').filter({ hasText: 'Varro' });
    await expect(row).toContainText('On an expedition');
    const watch = row.getByRole('button', { name: "Watch Varro's expedition", exact: true });
    await watch.click();
    const expedition = scene(page, 'Expedition');
    await expect(expedition).toBeVisible();
    expect(search(page)).toEqual({ view: 'expedition', activity: timeline.activityId, from: 'gladiators' });
    await expect(backTo(page, 'Gladiators')).toHaveText('← Gladiators');
    await expect(expedition.getByRole('heading', { level: 2, name: 'Ruined Outpost' })).toBeVisible({ timeout: 45_000 });
    await expect(expedition.getByText('EXPEDITION · Varro')).toBeVisible();
    await expect(expedition.getByRole('status', { name: 'Current stage' })).toContainText('Returning without rewards');
    await expect(expedition).not.toContainText(REWARDS);
    await page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 });
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`scene-expedition-${testInfo.project.name}.png`) });
    await backTo(page, 'Gladiators').click();
    await expect(expedition).toHaveCount(0);
    expect(search(page)).toEqual({});
    await expect(watch).toBeFocused();
    // A visitor's scene reads public projections only, and sends no command.
    expect(commands).toEqual([]);
    expect(live.requests.every(r => r.reader === null)).toBe(true);
    expect(live.count('owner_state') + live.count('activities')).toBe(0);
    expect(live.count('visible_events')).toBeGreaterThan(0);
  });

  test("says a visitor's expired replay is no longer kept, not that it is coming", async ({ page, context }) => {
    // Fix round 1, M5: a visitor has no owner summary, only the public completion, which says the replay expired.
    const now = Date.now();
    const expired = randomUUID();
    const timeline: RevealedTimeline = { activityId: expired, serverNowMs: now, visibleThroughMs: now, stages: [],
      completion: { activityId: expired, resolvedKind: 'arena', result: 'victory', success: true, settledAtMs: now - 10 * 86_400_000, replayExpiry: { state: 'expired' } } };
    const live = await routeLiveReads(context, { world: { ...emptyWorld(now), revision: 'scenes-3' }, timelines: { [expired]: timeline } });
    await page.goto(`/replay/?activity=${expired}`);
    await expect(page.getByRole('heading', { name: 'This replay is no longer kept' })).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('main')).not.toContainText(/not available yet|has not been revealed/i);
    await expect(page.locator('main')).not.toContainText(REWARDS);
    await openCamp(page, `/game/?view=replay&activity=${expired}`);
    await expect(scene(page, 'Replay').getByRole('heading', { level: 2, name: 'This replay is no longer kept' })).toBeVisible({ timeout: 45_000 });
    expect(live.requests.every(r => r.reader === null)).toBe(true);
  });

  test("shows a visitor's guessed or unrevealed activity as not available yet, without a summary", async ({ page, context }, testInfo) => {
    const now = Date.now();
    const guessed = randomUUID();
    // Someone's activity that is only revealed later: its stages, completion and owner summary are all in the future.
    const later = liveExpedition('woodland', now, -30);
    const owned = readJson('tests/fixtures/expeditions/woodland.json') as RevealedTimeline;
    const unrevealed: RevealedTimeline = { ...later, summary: { ...owned.summary!, activityId: later.activityId, settledAtMs: now + 120 * MIN },
      completion: { activityId: later.activityId, resolvedKind: 'expedition', result: 'completed', success: true, settledAtMs: now + 120 * MIN, replayExpiry: { state: 'expired' } } };
    const live = await routeLiveReads(context, { world: { ...emptyWorld(now), revision: 'scenes-2' }, timelines: { [unrevealed.activityId]: unrevealed } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const expectNotYet = async (kind: 'replay' | 'expedition', root = page.locator('body')) => {
      await expect(root.getByRole('heading', { name: `This ${kind} is not available yet` })).toBeVisible({ timeout: 45_000 });
      await expect(root).not.toContainText(REWARDS);
      await expect(root).not.toContainText(/Preparing|Processing results|Woodland Path|Encounter \d|Success|Defeated/);
      await expect(page.getByText(/Application error|Unhandled Runtime Error|could not be loaded/i)).toHaveCount(0);
    };
    for (const activity of [guessed, unrevealed.activityId]) {
      await page.goto(`/replay/?activity=${activity}`);
      await expectNotYet('replay');
      await page.goto(`/expedition/?activity=${activity}`);
      await expectNotYet('expedition');
      // It stays so: nothing reveals while the page waits.
      await page.waitForTimeout(1500);
      await expectNotYet('expedition');
      expect(await page.locator('canvas').count()).toBe(0);
    }
    // The same over the camp.
    await openCamp(page, `/game/?view=replay&activity=${guessed}`);
    await expectNotYet('replay', scene(page, 'Replay'));
    await page.goto(`/game/?view=expedition&activity=${unrevealed.activityId}`);
    await expectNotYet('expedition', scene(page, 'Expedition'));
    await campReady(page);
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`scene-visitor-not-available-yet-${testInfo.project.name}.png`) });
    await backToCamp(page).click();
    await expect(scene(page, 'Expedition')).toHaveCount(0);
    // Public reads as a visitor only: never the owner-only activity summaries.
    expect(live.requests.every(r => r.reader === null)).toBe(true);
    expect(live.count('activities') + live.count('owner_state')).toBe(0);
    expect(errors).toEqual([]);
  });

  test('says a failed live read cannot be loaded right now, and a malformed shared link is not found without a read', async ({ page, context }) => {
    // Final review Minor 6: a network failure (or PostgREST refusing a malformed id) is no missing reader, so it never
    // says "in this build"; a malformed activity id names nothing, on the deep link as over the camp, and reads nothing.
    const now = Date.now();
    const live = await routeLiveReads(context, { world: { ...emptyWorld(now), revision: 'scenes-4' } });
    const unreadable = randomUUID();
    live.fail('visible_events');
    const noBuildCopy = /in this build|may not exist/;
    await page.goto(`/replay/?activity=${unreadable}`);
    await expect(page.locator('main').getByText('This replay cannot be loaded right now. Try again shortly.')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('main')).not.toContainText(noBuildCopy);
    await page.goto(`/expedition/?activity=${unreadable}`);
    await expect(page.locator('main').getByText(/^This expedition cannot be loaded right now\./)).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('main')).not.toContainText(noBuildCopy);
    await openCamp(page, `/game/?view=replay&activity=${unreadable}`);
    await expect(scene(page, 'Replay').getByText('This replay cannot be loaded right now. Try again shortly.')).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Replay')).not.toContainText(noBuildCopy);
    await page.goto(`/game/?view=expedition&activity=${unreadable}`);
    await expect(scene(page, 'Expedition').getByText(/^This expedition cannot be loaded right now\./)).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Expedition')).not.toContainText(noBuildCopy);
    live.fail('visible_events', false);
    // A malformed id from a shared link: not found, with no timeline read at all (only the camp's own world reads).
    const timelineReads = () => live.count('visible_events') + live.count('recent_results') + live.count('activities');
    const before = timelineReads();
    for (const bad of ['not-an-id', `${unreadable}x`]) {
      await openCamp(page, `/game/?view=replay&activity=${encodeURIComponent(bad)}`);
      await expect(scene(page, 'Replay').getByRole('heading', { level: 2, name: 'This replay is not available' })).toBeVisible();
      await expect(scene(page, 'Replay').getByText('No fight was found for this link.')).toBeVisible();
      await page.goto(`/game/?view=expedition&activity=${encodeURIComponent(bad)}`);
      await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'This expedition is not available' })).toBeVisible();
      await expect(scene(page, 'Expedition').getByText('No expedition matches this link.')).toBeVisible();
      await backToCamp(page).click();
      await expect(scene(page, 'Expedition')).toHaveCount(0);
      expect(search(page)).toEqual({});
      // The replay deep link, as the expedition page already does.
      await page.goto(`/replay/?activity=${encodeURIComponent(bad)}`);
      await expect(page.locator('main').getByText('No fight was found for this link.')).toBeVisible({ timeout: 45_000 });
    }
    await page.waitForTimeout(500);
    expect(timelineReads()).toBe(before);
    expect(live.requests.every(r => r.reader === null)).toBe(true);
  });
});

test.describe("an owner's replay and expedition when the session ends", () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test('leaves no credited reward on the pages or the scenes once the session ends in another tab', async ({ page, context }) => {
    // Final review Minor 1: the views were keyed without the account, so the owner's credited rewards outlived the
    // session (on /replay/ until a reload, on /expedition/ until the next revision, and in the expedition scene until the
    // visitor's re-read landed). The timeline re-read is held here, so a view that keeps the owner's timeline shows it.
    const user = await seedSession(context);
    const now = Date.now();
    const bout = ownerBout(now);
    const expedition = readJson('tests/fixtures/expeditions/woodland.json') as RevealedTimeline;
    expect(expedition.summary).toBeDefined();
    const live = await routeLiveReads(context, { world: { ...emptyWorld(now), revision: 'scenes-owner' }, owner: ownerFixture,
      timelines: { [bout.activityId]: bout, [expedition.activityId]: expedition } });
    type Root = ReturnType<Page['locator']>;
    // A replay shows its result (and any credited rewards) once played through: skip to it.
    const replayResult = async (root: Root) => {
      await root.getByRole('button', { name: 'Skip to result' }).click({ timeout: 45_000 });
      await expect(root.getByRole('heading', { name: 'Result' })).toBeVisible();
    };
    const journey = async (root: Root) => { await expect(root.getByRole('heading', { name: 'Woodland Path', exact: true })).toBeVisible({ timeout: 45_000 }); };
    const surfaces = [
      { url: `/replay/?activity=${bout.activityId}`, root: () => page.locator('main'), shown: replayResult },
      { url: `/expedition/?activity=${expedition.activityId}`, root: () => page.locator('main'), shown: journey },
      { url: `/game/?view=replay&activity=${bout.activityId}`, root: () => scene(page, 'Replay'), shown: replayResult },
      { url: `/game/?view=expedition&activity=${expedition.activityId}`, root: () => scene(page, 'Expedition'), shown: journey },
    ];
    for (const surface of surfaces) {
      await page.goto(surface.url);
      const root = surface.root();
      // Signed in, the owner sees the credited rewards.
      await surface.shown(root);
      await expect(root).toContainText(REWARDS);
      const release = live.hold('visible_events');
      const from = live.requests.length;
      await signOutInAnotherTab(page);
      // This tab now reads as a visitor (the sync's world, then any timeline re-read, which is held).
      await expect.poll(() => live.requests.slice(from).some(r => r.table === 'world_revision' && r.reader === null), { message: surface.url }).toBe(true);
      await expect(root, surface.url).not.toContainText(REWARDS);
      release();
      await surface.shown(root);
      await expect(root, surface.url).not.toContainText(REWARDS);
      // Nothing after the sign-out read as the old account.
      expect(live.requests.slice(from).filter(r => r.reader === user.id).map(r => r.table), surface.url).toEqual([]);
    }
  });
});
