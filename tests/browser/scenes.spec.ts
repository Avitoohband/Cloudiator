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
    // The focus moves with the scene (fix round 1, M6): to Back to camp, never to <body>.
    await expect(backToCamp(page)).toBeFocused();
    await expect(scene(page, 'Replay').getByRole('button', { name: 'Encounter 1: victory', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // The browser's Back returns to the expedition scene, again with the focus in the scene.
    await page.goBack();
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Woodland Path' })).toBeVisible({ timeout: 45_000 });
    await expect(backToCamp(page)).toBeFocused();
    await page.goForward();
    await expect(scene(page, 'Replay')).toBeVisible();
    await expect(backToCamp(page)).toBeFocused();
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
    // Nor a promise of rewards that are not theirs (fix round 1, M5).
    await expect(replay).not.toContainText(/Rewards are credited/i);
    await backToCamp(page).click();
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
    expect(search(page)).toEqual({ mode: 'fixture', view: 'replay', activity: REPLAY_FIXTURES.npc.activityId });
    await backToCamp(page).click();
    await expect(scene(page, 'Replay')).toHaveCount(0);
    await results.getByRole('navigation', { name: 'Sample expeditions' }).getByRole('link', { name: EXPEDITION_FIXTURES.mountain.label }).click();
    await expect(scene(page, 'Expedition').getByRole('heading', { level: 2, name: 'Mountain Pass' })).toBeVisible({ timeout: 45_000 });
    expect(search(page)).toEqual({ mode: 'fixture', view: 'expedition', activity: EXPEDITION_FIXTURES.mountain.activityId });
    await backToCamp(page).click();
    await expect(scene(page, 'Expedition')).toHaveCount(0);
    expect(search(page)).toEqual({ mode: 'fixture' });
    expect(await page.evaluate(() => ({ ready: window.__cloudiatorCamp!.state()!.ready, canvases: window.__cloudiatorCamp!.canvases() }))).toEqual({ ready: true, canvases: 1 });
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
});
