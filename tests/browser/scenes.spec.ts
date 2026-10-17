import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { PublicActor, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS } from '../fixtures/expedition-ids';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { SLOT_MS, emptyWorld, routeLiveReads } from './live-routes';
import { menuDialog, openMenu } from './shell-helpers';

// Task 13.8 (spec "Scenes", plan Decision 4): a replay or an expedition opens as a full-screen scene over the running
// camp, with "Back to camp", as a history entry on the camp's own route (`?view=replay|expedition&activity=…`); the
// browser's Back closes it as well. The /replay/ and /expedition/ pages stay as deep links. A visitor's guessed or
// unrevealed activity is "not available yet", with no summary, never an endless "Preparing" or an error page (Review
// Focus 3). Visitors never see rewards or an owner summary in a scene.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** Text that only an owner's settled summary holds (its credited rewards and rating change); no visitor's scene shows it. */
const REWARDS = /\+\d+ (money|renown|XP)|Credited rewards|Credited for|Rating [+−-]\d|No rating change|Light boots|Salvage/;

/** A scene over the camp: the replay or the expedition dialog. */
const scene = (page: Page, name: 'Replay' | 'Expedition') => page.getByRole('dialog', { name, exact: true });
const backToCamp = (page: Page) => page.getByRole('button', { name: 'Back to camp' });
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
/** Varro, away on the shifted Ruined Outpost expedition: the public actor a visitor's world shows. */
function awayActor(timeline: RevealedTimeline): PublicActor {
  const start = timeline.stages[0].startedAtMs;
  return { gladiatorId: EXPEDITION_GLADIATORS.varro.id, name: 'Varro', classId: 'duelist', equipmentSilhouettes: ['weapon-sword'], league: 'bronze', level: 6,
    phase: 'afternoon', location: 'expedition:outpost', activityId: timeline.activityId, activityStatus: 'active', startsAtMs: start, endsAtMs: start + SLOT_MS,
    visibleStage: null };
}

test.describe('replays and expeditions over the camp (fixture preview)', () => {
  test.skip(production, 'These checks use the fixture preview.');

  test('opens a replay full screen over the camp and returns with Back to camp', async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    const results = await openMenu(page, 'Results');
    const replay = results.getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first();
    await replay.click();
    const replayScene = scene(page, 'Replay');
    await expect(replayScene).toBeVisible();
    // A history entry on the camp's own route (plan Decision 4); the newest Arena win is the pvp sample.
    expect(new URL(page.url()).pathname).toBe('/game/');
    expect(search(page)).toEqual({ mode: 'fixture', view: 'replay', activity: REPLAY_FIXTURES.pvp.activityId });
    await expect(replayScene.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await page.waitForFunction(() => !!window.__cloudiatorReplay?.state(), null, { timeout: 45_000 });
    // Full window, over the camp, which keeps running beneath it; Back to camp takes the focus.
    const viewport = page.viewportSize()!;
    expect(await replayScene.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    await expect(backToCamp(page)).toBeFocused();
    expect(await page.evaluate(() => window.__cloudiatorCamp!.state()!.ready)).toBe(true);
    await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`scene-replay-${testInfo.project.name}.png`) });
    await backToCamp(page).click();
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
    await (await openMenu(page, 'Results')).getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first().click();
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
    await backToCamp(page).click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    await page.goForward();
    await expect(scene(page, 'Replay')).toBeVisible();
  });

  test('opens an expedition result over the camp as its expedition scene', async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    const results = await openMenu(page, 'Results');
    const woodland = EXPEDITION_FIXTURES.woodland.activityId;
    // The 13.7 review: Results sent every kind to the battle replay. An expedition (the newest is the Woodland Path
    // sample) opens its expedition scene.
    await results.getByRole('button', { name: /^Replay: Aster returned victorious from an expedition/ }).first().click();
    const expedition = scene(page, 'Expedition');
    await expect(expedition).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: woodland });
    await expect(expedition.getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(scene(page, 'Replay')).toHaveCount(0);
    // Over the camp the scene has no Camp link of its own, only Back to camp.
    await expect(expedition.getByRole('link', { name: 'Camp', exact: true })).toHaveCount(0);
    await page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 });
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`scene-expedition-result-${testInfo.project.name}.png`) });
    // Its encounter replays open the replay scene; Back to camp returns to the camp, not to the expedition.
    const watch = expedition.getByRole('button', { name: /^Watch the replay of encounter 1$/ });
    await watch.click();
    await expect(scene(page, 'Replay')).toBeVisible();
    expect(search(page)).toEqual({ mode: 'fixture', view: 'replay', activity: woodland, stage: `${woodland}:1` });
    await expect(scene(page, 'Replay').getByRole('button', { name: 'Encounter 1: victory', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await backToCamp(page).click();
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
    await backToCamp(page).click();
    await page.goto(`/game/?mode=fixture&as=visitor&view=expedition&activity=${EXPEDITION_FIXTURES.woodland.activityId}`);
    const expedition = scene(page, 'Expedition');
    await expect(expedition.getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(expedition.getByRole('region', { name: 'Result' })).toContainText('Success');
    await expect(expedition).not.toContainText(REWARDS);
    await expect(expedition).toContainText("Another gladiator's expedition");
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
    expect(search(page)).toEqual({ view: 'expedition', activity: timeline.activityId });
    await expect(expedition.getByRole('heading', { level: 2, name: 'Ruined Outpost' })).toBeVisible({ timeout: 45_000 });
    await expect(expedition.getByText('EXPEDITION · Varro')).toBeVisible();
    await expect(expedition.getByRole('status', { name: 'Current stage' })).toContainText('Returning without rewards');
    await expect(expedition).not.toContainText(REWARDS);
    await page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 });
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`scene-expedition-${testInfo.project.name}.png`) });
    await backToCamp(page).click();
    await expect(expedition).toHaveCount(0);
    expect(search(page)).toEqual({});
    await expect(watch).toBeFocused();
    // A visitor's scene reads public projections only, and sends no command.
    expect(commands).toEqual([]);
    expect(live.requests.every(r => r.reader === null)).toBe(true);
    expect(live.count('owner_state') + live.count('activities')).toBe(0);
    expect(live.count('visible_events')).toBeGreaterThan(0);
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
});
