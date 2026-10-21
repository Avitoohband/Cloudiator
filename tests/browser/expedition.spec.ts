import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from './fixtures';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { EXPEDITION_FIXTURES, type ExpeditionFixtureKey } from '../fixtures/expedition-ids';
import { renderExpeditionStage } from '../../src/game/expedition-stage';
import { gladiatorPose, journeyMap } from '../../src/game/expedition-path';
import { worldToScreen } from '../../src/game/iso';
import { drawSlices, hidesActor } from '../../src/game/depth';
import type { MapData } from '../../src/game/assets';
import { emptyWorld, routeLiveReads } from './live-routes';
import { openMenu } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const OUTRO_MS = 2000;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const KEYS = Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[];
const TIMELINES = Object.fromEntries(KEYS.map(key => [key, readJson(`tests/fixtures/expeditions/${key}.json`)])) as Record<ExpeditionFixtureKey, RevealedTimeline>;
const MAPS = Object.fromEntries(['woodland', 'outpost', 'mountain'].map(id => [id, readJson(`public/assets/expeditions/${id}-map.json`)])) as Record<string, MapData>;
const manifest = readJson('public/assets/manifest.json');
const SPEED: number = manifest.actors.gladiator.walk.tilesPerSecond;
const startOf = (key: ExpeditionFixtureKey) => TIMELINES[key].stages[0].startedAtMs;
const encounterStages = (key: ExpeditionFixtureKey) => TIMELINES[key].stages.filter(s => s.kind === 'encounter');
const idOf = (key: ExpeditionFixtureKey) => EXPEDITION_FIXTURES[key].activityId;
const walkable = (map: MapData, x: number, y: number) => map.walkable[Math.floor(y)]?.[Math.floor(x)] === '1';

const expeditionFlow = {
  url: (key: ExpeditionFixtureKey, minute?: number) => `/expedition/?mode=fixture&activity=${idOf(key)}${minute === undefined ? '' : `&minute=${minute}`}`,
  async open(page: Page, key: ExpeditionFixtureKey, minute?: number) {
    await page.goto(expeditionFlow.url(key, minute));
    await page.waitForFunction(() => !!window.__cloudiatorExpedition?.state(), null, { timeout: 45_000 });
  },
  /** The owner's settled Woodland success, opened at a minute of its slot. */
  openAtMinute: (page: Page, minute: number) => expeditionFlow.open(page, 'woodland', minute),
  /** The owner's Ruined Outpost run, defeated in encounter 2. */
  openFailedAtMinute: (page: Page, minute: number) => expeditionFlow.open(page, 'outpost', minute),
  /** Holds the display clock at a minute of the fixture's slot. */
  async hold(page: Page, key: ExpeditionFixtureKey, minute: number) {
    await page.evaluate(ms => window.__cloudiatorExpedition!.freeze(ms), startOf(key) + minute * MIN);
    await nextFrames(page);
  },
  holdAt: async (page: Page, ms: number) => { await page.evaluate(t => window.__cloudiatorExpedition!.freeze(t), ms); await nextFrames(page); },
  state: (page: Page) => page.evaluate(() => window.__cloudiatorExpedition!.state()!),
  sceneReady: (page: Page) => page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 }),
  scene: (page: Page) => page.evaluate(() => window.__cloudiatorExpeditionScene!.debug()!),
  /** Waits until a following camera has glided onto the gladiator (before evidence screenshots). */
  async settle(page: Page) {
    let last = { x: NaN, y: NaN };
    await expect.poll(async () => {
      await page.waitForTimeout(120);
      const { camera } = await expeditionFlow.scene(page);
      const moved = Math.hypot(camera.centerX - last.x, camera.centerY - last.y);
      last = { x: camera.centerX, y: camera.centerY };
      return Number.isNaN(moved) ? Infinity : moved;
    }, { timeout: 8_000 }).toBeLessThan(0.5);
  },
};
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const logItems = (page: Page) => page.getByRole('list', { name: 'Activity log' }).getByRole('listitem');
const phase = (page: Page) => page.getByRole('status', { name: 'Current stage' });
const result = (page: Page) => page.getByRole('region', { name: 'Result' });

test.describe('followable expedition scenes', () => {
  test.skip(production, 'Expedition scenes need the fixture timelines, which production exports never include.');

  test('opens mid-slot on the revealed stages only and presents a failure', async ({ page }, testInfo) => {
    await expeditionFlow.openAtMinute(page, 39);
    await expect(page.getByText('Encounter 1')).toBeVisible();
    await expect(page.getByText('Encounter 2')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Woodland Path' })).toBeVisible();
    await expect(page.getByText('EXPEDITION · Aster')).toBeVisible();
    await expect(logItems(page)).toHaveText([/Depart for Woodland Path/, /Encounter 1: victory/, /Recover and continue exploring/]);
    await expeditionFlow.sceneReady(page);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-woodland-minute-39.png') });

    await expeditionFlow.openFailedAtMinute(page, 65);
    await expect(page.getByText('Returning without rewards')).toBeVisible();
    await expect(logItems(page).last()).toContainText('Rest at the safe return point');
    await expect(logItems(page).last()).toHaveAttribute('aria-current', 'step');
    await expect(page.getByText('Encounter 3')).toHaveCount(0);
    await expect(result(page)).toContainText('No rewards');
    await expeditionFlow.sceneReady(page);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-outpost-minute-65-safe-point.png') });
  });

  test('walks the minute table for a success and for a defeat in each encounter', { tag: '@render' }, async ({ page }) => {
    const minutes = [19, 20, 39, 40, 59, 60, 79, 80];
    await expeditionFlow.open(page, 'woodland', 10);
    // Before any revealed log names whose journey this is, the header claims nobody.
    await expect(page.locator('main p.eyebrow').first()).toHaveText('EXPEDITION');
    const success: Record<number, [string, number]> = { 19: ['depart', 1], 20: ['encounter', 2], 39: ['exploration', 3], 40: ['encounter', 4], 59: ['exploration', 5], 60: ['encounter', 6], 79: ['returning', 7], 80: ['arrived', 8] };
    for (const minute of minutes) {
      await expeditionFlow.hold(page, 'woodland', minute);
      const s = await expeditionFlow.state(page);
      expect(s.phase, `minute ${minute}`).toBe(success[minute][0]);
      await expect(logItems(page), `minute ${minute}`).toHaveCount(success[minute][1]);
      // A battle that has just started shows no result yet.
      if (minute % 20 === 0 && minute < 80) await expect(logItems(page).last()).toHaveText(new RegExp(`^.*Encounter ${minute / 20}\\s*in progress$`));
    }
    for (const [key, lost] of [['spectator', 1], ['outpost', 2], ['mountain', 3]] as const) {
      await expeditionFlow.open(page, key, 10);
      for (const minute of minutes) {
        await expeditionFlow.hold(page, key, minute);
        const due = Math.min(3, Math.floor(minute / 20));
        const expected = minute < 20 ? 'depart' : minute === 80 ? 'arrived'
          : due > lost || (due === lost && minute % 20 !== 0) ? 'safe-return' : minute % 20 === 0 ? 'encounter' : 'exploration';
        expect((await expeditionFlow.state(page)).phase, `${key} minute ${minute}`).toBe(expected);
        for (let n = lost + 1; n <= 3; n += 1) await expect(page.getByText(`Encounter ${n}`), `${key} minute ${minute}`).toHaveCount(0);
        if (expected === 'safe-return') {
          await expect(page.getByText('Returning without rewards')).toBeVisible();
          await expect(page.getByText(`Encounter ${lost}: defeat`)).toBeVisible();
        }
      }
      await expect(result(page)).toContainText('Defeated');
    }
  });

  test('shows Preparing, never a fabricated encounter, while a due stage is unpublished', async ({ page }, testInfo) => {
    await expeditionFlow.open(page, 'delayed');
    expect((await expeditionFlow.state(page)).minute).toBeCloseTo(45, 0);
    await expect(phase(page)).toContainText('Preparing');
    await expect(page.getByText('Encounter 2')).toHaveCount(0);
    await expect(logItems(page)).toHaveCount(3);
    await expeditionFlow.sceneReady(page);
    await expeditionFlow.hold(page, 'delayed', 45);
    const d = await expeditionFlow.scene(page);
    // The gladiator waits at the next encounter spot; the only creature is encounter 1's, long faded.
    const spot = MAPS.woodland.expedition!.encounters[1];
    expect(d.gladiator).toMatchObject({ action: 'idle', x: spot.x + 0.5, y: spot.y + 0.5 });
    expect(d.creature === null || (d.creature.alpha === 0 && !d.creature.visible && d.creature.id === 'creature:dire-wolf:1')).toBe(true);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-delayed-preparing.png') });
  });

  test('new navigation and reload jump to the current visible progress', async ({ page }) => {
    await expeditionFlow.open(page, 'outpost');
    await expeditionFlow.sceneReady(page);
    const check = async () => {
      const s = await expeditionFlow.state(page);
      expect(s.minute).toBeGreaterThanOrEqual(65);
      expect(s.minute).toBeLessThan(65.5);
      expect(s.phase).toBe('safe-return');
      await nextFrames(page);
      const d = await expeditionFlow.scene(page);
      const now = renderExpeditionStage(TIMELINES.outpost, d.displayNowMs!);
      const pose = gladiatorPose(journeyMap(MAPS.outpost), now.route!, SPEED);
      expect(Math.hypot(d.gladiator!.x - pose.x, d.gladiator!.y - pose.y)).toBeLessThan(0.1);
      expect(d.gladiator!.action).toBe(pose.action);
    };
    await check();
    await page.reload();
    await page.waitForFunction(() => !!window.__cloudiatorExpedition?.state(), null, { timeout: 45_000 });
    await expeditionFlow.sceneReady(page);
    await check();
    // A fixture minute is where the clock starts on every load; it then runs in real time.
    await expeditionFlow.open(page, 'woodland', 50);
    await page.waitForTimeout(1500);
    const before = (await expeditionFlow.state(page)).minute!;
    expect(before).toBeGreaterThan(50);
    await page.reload();
    await page.waitForFunction(() => !!window.__cloudiatorExpedition?.state(), null, { timeout: 45_000 });
    const after = (await expeditionFlow.state(page)).minute!;
    expect(after).toBeGreaterThanOrEqual(50);
    expect(after).toBeLessThan(before + 0.05);
  });

  test('Watch replay opens the encounter it names', async ({ page }) => {
    await expeditionFlow.open(page, 'woodland', 85);
    const links = page.getByRole('link', { name: /Watch the replay of encounter/ });
    await expect(links).toHaveCount(3);
    const stage = encounterStages('woodland')[1];
    const link = page.getByRole('link', { name: 'Watch the replay of encounter 2' });
    await expect(link).toHaveAttribute('href', `/replay/?mode=fixture&activity=${idOf('woodland')}&stage=${encodeURIComponent(stage.id)}`);
    await link.click();
    await page.waitForURL(/\/replay\//);
    await page.waitForFunction(id => window.__cloudiatorReplay?.state().battleId === id, stage.battleLog!.battleId, { timeout: 45_000 });
    // No replay before a battle has ended, and none once the logs are gone.
    await expeditionFlow.open(page, 'woodland', 20.05);
    await expect(page.getByRole('link', { name: /Watch the replay/ })).toHaveCount(0);
    await expeditionFlow.open(page, 'expired', 85);
    await expect(page.getByRole('link', { name: /Watch the replay/ })).toHaveCount(0);
    await expect(result(page)).toContainText('Encounter replays are no longer kept');
    await expect(page.getByRole('meter', { name: 'Gladiator health' })).toHaveCount(0);
  });

  test('never duplicates the scene, the clock or listeners across leaving, returning and reloading', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __visibilityListeners: number };
      w.__visibilityListeners = 0;
      const add = Document.prototype.addEventListener;
      const remove = Document.prototype.removeEventListener;
      const seen = new WeakSet<object>();
      Document.prototype.addEventListener = function (this: Document, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (type === 'visibilitychange' && listener && !seen.has(listener)) { seen.add(listener); w.__visibilityListeners += 1; }
        return add.call(this, type, listener as EventListenerOrEventListenerObject, options);
      } as typeof add;
      Document.prototype.removeEventListener = function (this: Document, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        if (type === 'visibilitychange' && listener && seen.has(listener)) { seen.delete(listener); w.__visibilityListeners -= 1; }
        return remove.call(this, type, listener as EventListenerOrEventListenerObject, options);
      } as typeof remove;
    });
    const counts = () => page.evaluate(() => ({
      listeners: window.__cloudiatorExpedition!.listeners(), loops: window.__cloudiatorExpedition!.loops(),
      canvases: document.querySelectorAll('canvas').length, visibility: (window as unknown as { __visibilityListeners: number }).__visibilityListeners,
    }));
    const rate = async () => {
      const a = (await expeditionFlow.state(page)).displayNowMs;
      const t = Date.now();
      await page.waitForTimeout(1000);
      return ((await expeditionFlow.state(page)).displayNowMs - a) / (Date.now() - t);
    };
    const ready = async (key: ExpeditionFixtureKey) => {
      await page.waitForFunction(id => window.__cloudiatorExpedition?.state()?.activityId === id, idOf(key), { timeout: 45_000 });
      await expeditionFlow.sceneReady(page);
    };
    await expeditionFlow.open(page, 'woodland');
    await expeditionFlow.sceneReady(page);
    const base = await counts();
    expect(base).toMatchObject({ loops: 1, canvases: 1 });
    await page.getByRole('link', { name: 'Camp', exact: true }).click();
    await page.waitForURL(/\/game\/\?mode=fixture/);
    await openMenu(page, 'Results');
    await page.getByRole('navigation', { name: 'Sample expeditions' }).getByRole('link', { name: EXPEDITION_FIXTURES.mountain.label }).click();
    // A sample opens as a scene over the camp (Task 13.8 fix round 1): one view, one clock, one scene canvas beside the
    // camp's own.
    await ready('mountain');
    expect(await page.evaluate(() => ({ listeners: window.__cloudiatorExpedition!.listeners(), loops: window.__cloudiatorExpedition!.loops(),
      canvases: document.querySelectorAll('dialog canvas').length }))).toEqual({ listeners: base.listeners, loops: 1, canvases: 1 });
    // Back closes the scene, and Back again returns to the expedition page.
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Expedition', exact: true })).toHaveCount(0);
    await page.goBack();
    await ready('woodland');
    expect(await counts()).toEqual(base);
    await page.reload();
    await ready('woodland');
    expect(await counts()).toEqual(base);
    const speed = await rate();
    expect(speed).toBeGreaterThan(0.7);
    expect(speed).toBeLessThan(1.4);
  });

  test("shows another gladiator's expedition without any reward details", async ({ page }, testInfo) => {
    await expeditionFlow.open(page, 'spectator');
    await expect(page.getByText("EXPEDITION · Another gladiator's journey")).toBeVisible();
    expect((await expeditionFlow.state(page)).owner).toBe(false);
    await expect(page.getByText('Encounter 1: defeat')).toBeVisible();
    await expeditionFlow.sceneReady(page);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-spectator.png') });
    for (const minute of [30, 80, 85]) {
      await expeditionFlow.hold(page, 'spectator', minute);
      await expect(page.getByText(/Processing results/)).toHaveCount(0);
      const text = await page.locator('main').innerText();
      expect(text, `minute ${minute}`).not.toMatch(/\bmoney\b|\bXP\b|salvage|receipt|credited|renown|\+\d+/i);
    }
    await expect(result(page)).toContainText('Defeated');
  });

  test("settles the owner's result and rewards only from the summary", async ({ page }, testInfo) => {
    await expeditionFlow.open(page, 'woodland', 80);
    const t = TIMELINES.woodland;
    await expeditionFlow.holdAt(page, t.summary!.settledAtMs - 1);
    await expect(result(page)).toContainText('Processing results');
    await expect(result(page)).not.toContainText('money');
    await expeditionFlow.holdAt(page, t.summary!.settledAtMs);
    await expect(result(page).getByRole('listitem')).toHaveText(['+20 money', '+100 XP', 'Light boots (tier 1, uncommon) ×1', 'Salvage ×1']);
    await expect(result(page)).toContainText('Success');
    await expect(result(page)).toContainText('Encounter replays are kept until');
    await expect(page.getByText(/Processing results/)).toHaveCount(0);
    await expeditionFlow.sceneReady(page);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-woodland-settled.png'), fullPage: true });

    await expeditionFlow.open(page, 'laststand');
    await expect(result(page)).toContainText('Success');
    await expect(result(page).getByRole('listitem')).toHaveText(['+120 money', '+500 XP', 'Salvage ×3']);
    await expect(page.getByText('Encounter 3: victory')).toBeVisible();
  });

  test('shows a zero-HP tie-break win as a victory in the log, the health and the scene', async ({ page }, testInfo) => {
    await expeditionFlow.open(page, 'tiebreak');
    await expeditionFlow.sceneReady(page);
    const fight = encounterStages('tiebreak')[0];
    // The sample opens just before the simultaneous defeat: no result yet.
    await expect(logItems(page).last()).toContainText('Encounter 1');
    await expect(page.getByText('Encounter 1: victory')).toHaveCount(0);
    await expeditionFlow.holdAt(page, fight.endsAtMs + OUTRO_MS - 100);
    await expect(page.getByText('Encounter 1: victory')).toBeVisible();
    await expect(page.getByRole('meter', { name: 'Gladiator health' })).toHaveAttribute('aria-valuenow', '0');
    await expect(page.getByText('Returning without rewards')).toHaveCount(0);
    const d = await expeditionFlow.scene(page);
    expect(d.gladiator!.animation).toBe(manifest.actors.gladiator.animations.victory.se);
    expect(d.creature!.frame).toMatch(/^rock-troll\/defeat\//);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-tiebreak-victory-at-0hp.png') });
    // It then explores on towards encounter 2 instead of resting at the safe point.
    await expeditionFlow.hold(page, 'tiebreak', 30);
    expect(await expeditionFlow.state(page)).toMatchObject({ phase: 'exploration', route: { from: 'encounter-1', to: 'search-2' } });
    await expect(phase(page)).toContainText('Exploring');
    // A final zero-HP tie-break win completes the expedition: success before the summary, and home along the trail.
    await expeditionFlow.open(page, 'laststand', 80);
    await expeditionFlow.hold(page, 'laststand', 80.2);
    await expect(result(page)).toContainText('Success');
    await expect(result(page)).toContainText('Processing results');
    expect(await expeditionFlow.state(page)).toMatchObject({ outcome: 'success', route: { from: 'end', to: 'end', then: 'leave' } });
    await expect(page.getByText(/without rewards|after a defeat/)).toHaveCount(0);
  });

  test('names the encounter the shown health comes from, and notes the recovery after a non-final win', async ({ page }) => {
    const meter = () => page.getByRole('meter', { name: 'Gladiator health' });
    const recovers = () => page.getByText('Some health recovers before the next encounter.');
    await expeditionFlow.open(page, 'tiebreak');
    const [first, second] = encounterStages('tiebreak');
    // Exploring after the zero-HP tie-break win: the 0 is the health after encounter 1, not the health now.
    await expeditionFlow.holdAt(page, first.endsAtMs + OUTRO_MS + 1_000);
    await expect(page.getByText('Health after the first encounter', { exact: true })).toBeVisible();
    await expect(meter()).toHaveAttribute('aria-valuenow', '0');
    await expect(meter()).toHaveAttribute('aria-valuetext', `0 of ${first.battleLog!.participants[0].maxHealth} health after the first encounter`);
    await expect(recovers()).toBeVisible();
    await expeditionFlow.hold(page, 'tiebreak', 39.9);
    await expect(page.getByText('Health after the first encounter', { exact: true })).toBeVisible();
    await expect(recovers()).toBeVisible();
    // During encounter 2 the meter follows that fight; the note is gone. Encounter 2 is lost: nothing recovers.
    await expeditionFlow.holdAt(page, second.startedAtMs + 500);
    await expect(page.getByText('Health during the second encounter', { exact: true })).toBeVisible();
    await expect(recovers()).toHaveCount(0);
    await expeditionFlow.holdAt(page, second.endsAtMs + 1_000);
    await expect(page.getByText('Health after the second encounter', { exact: true })).toBeVisible();
    await expect(recovers()).toHaveCount(0);
    // A won final encounter has no next encounter to recover for.
    await expeditionFlow.open(page, 'woodland', 59);
    await expect(page.getByText('Health after the second encounter', { exact: true })).toBeVisible();
    await expect(recovers()).toBeVisible();
    await expeditionFlow.hold(page, 'woodland', 70);
    await expect(page.getByText('Health after the third encounter', { exact: true })).toBeVisible();
    await expect(recovers()).toHaveCount(0);
    // The qualifier never adds a second "Encounter N" text to the page.
    await expeditionFlow.hold(page, 'woodland', 39);
    await expect(page.getByText('Encounter 1')).toHaveCount(1);
  });

  test('has the gladiator leave the scene once the expedition is back at camp, and says so in the scene', async ({ page }, testInfo) => {
    const banner = () => page.getByText('Returned to camp', { exact: true });
    for (const key of ['woodland', 'outpost'] as const) {
      const journey = journeyMap(MAPS[EXPEDITION_FIXTURES[key].expedition]);
      const arrival = TIMELINES[key].stages.at(-1)!.startedAtMs;
      const where = key === 'woodland' ? journey.points.end : journey.points.safe;
      await expeditionFlow.open(page, key, 79);
      await expeditionFlow.sceneReady(page);
      // Just before arrival it is in full view where it waited (the trail's end) or rested (the safe point).
      await expeditionFlow.holdAt(page, arrival - 1_000);
      let d = await expeditionFlow.scene(page);
      expect(d.returned, key).toBe(false);
      expect(d.gladiator, key).toMatchObject({ x: where.x + 0.5, y: where.y + 0.5, visible: true, alpha: 1, labelVisible: true });
      const waiting = d.gladiator!.action;
      expect(waiting, key).toMatch(key === 'woodland' ? /^idle$/ : /^(sit|sleep)$/);
      await expect(banner()).toHaveCount(0);
      // Arriving, it fades out where it stood, in the pose it waited or rested in (Task 15 review: never standing up first)...
      await expeditionFlow.holdAt(page, arrival + 750);
      d = await expeditionFlow.scene(page);
      expect(d.returned, key).toBe(true);
      expect(d.gladiator!.action, key).toBe(waiting);
      expect(d.gladiator!.alpha, key).toBeGreaterThan(0.2);
      expect(d.gladiator!.alpha, key).toBeLessThan(0.8);
      // ...and is gone: the scene says it returned, in agreement with the text.
      await expeditionFlow.holdAt(page, arrival + 5_000);
      d = await expeditionFlow.scene(page);
      expect(d.gladiator, key).toMatchObject({ visible: false, alpha: 0, labelVisible: false });
      // Nothing is left for a prop to hide, so nothing stays faded.
      expect(d.faded, key).toEqual([]);
      await expect(banner()).toBeVisible();
      await expect(phase(page)).toContainText(key === 'woodland' ? 'Back at camp' : 'Back at camp after a defeat');
    }
    await expeditionFlow.open(page, 'woodland', 85);
    await expeditionFlow.sceneReady(page);
    await expect(banner()).toBeVisible();
    expect((await expeditionFlow.scene(page)).gladiator).toMatchObject({ visible: false });
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-woodland-returned-to-camp.png') });
    // Mid-journey there is nothing to say.
    await expeditionFlow.open(page, 'woodland', 40);
    await expeditionFlow.sceneReady(page);
    await expect(banner()).toHaveCount(0);
    expect((await expeditionFlow.scene(page)).returned).toBe(false);
  });

  test('pauses the scene while the tab is hidden and shows the current moment when it returns', async ({ page }) => {
    const setHidden = (hidden: boolean) => page.evaluate(h => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    const reads = () => page.evaluate(() => window.__cloudiatorExpedition!.reads());
    // Minute 5: walking from the start to the first search spot, so every frame moves the gladiator.
    await expeditionFlow.open(page, 'woodland', 5);
    await expeditionFlow.sceneReady(page);
    await page.waitForTimeout(300);
    const moving = (await expeditionFlow.scene(page)).displayNowMs!;
    await nextFrames(page);
    expect((await expeditionFlow.scene(page)).displayNowMs!).toBeGreaterThan(moving);
    await setHidden(true);
    await nextFrames(page);
    const paused = await expeditionFlow.scene(page);
    const readsHidden = await reads();
    await page.waitForTimeout(800);
    const still = await expeditionFlow.scene(page);
    expect(still.displayNowMs).toBe(paused.displayNowMs);
    expect(still.gladiator).toEqual(paused.gladiator);
    expect(still.camera).toEqual(paused.camera);
    expect(await reads()).toBe(readsHidden);
    // Back in view: the scene jumps to the current display time instead of resuming where it paused. The shared sync
    // controller asks for the revision again (Task 13.8); the fixture's never changes and no reveal mark passed, so the
    // timeline is not read again.
    await setHidden(false);
    await expect.poll(async () => (await expeditionFlow.scene(page)).displayNowMs! - paused.displayNowMs!, { timeout: 5_000 }).toBeGreaterThan(800);
    await page.waitForTimeout(700);
    expect(await reads()).toBe(readsHidden);
    const d = await expeditionFlow.scene(page);
    const s = await expeditionFlow.state(page);
    expect(Math.abs(s.displayNowMs - d.displayNowMs!)).toBeLessThan(500);
    const pose = gladiatorPose(journeyMap(MAPS.woodland), renderExpeditionStage(TIMELINES.woodland, d.displayNowMs!).route!, SPEED);
    expect(Math.hypot(d.gladiator!.x - pose.x, d.gladiator!.y - pose.y)).toBeLessThan(0.01);
  });

  test('never re-reads on a timer of its own while a due stage or the owner\'s summary is awaited', async ({ page }) => {
    // Task 13.8 replaces the view's 30-second poll (Task 15) with the shared sync controller's revision (Task 10 gate):
    // a held display clock that passes no reveal mark reads nothing more, however long "Preparing" or "Processing results"
    // lasts. The fixture's revision never changes; the live test below changes it.
    const reads = () => page.evaluate(() => window.__cloudiatorExpedition!.reads());
    // A held display clock ticks four times a second; give it a few ticks before counting.
    const readsAt = async (ms: number) => { await expeditionFlow.holdAt(page, ms); await page.waitForTimeout(700); return reads(); };
    // Preparing (encounter 2 is overdue), until the minute-60 mark.
    await expeditionFlow.open(page, 'delayed', 45);
    const t0 = startOf('delayed') + 46 * MIN;
    const r0 = await readsAt(t0);
    for (const s of [30, 60, 90, 600]) expect(await readsAt(t0 + s * 1000), `+${s} s`).toBe(r0);
    expect((await expeditionFlow.state(page)).phase).toBe('preparing');
    // The owner's summary is awaited after minute 80 ("Processing results"); the summary settles in the timeline it has.
    const s0 = startOf('woodland');
    const settled = TIMELINES.woodland.summary!.settledAtMs;
    await expeditionFlow.open(page, 'woodland', 80);
    await expect(result(page)).toContainText('Processing results');
    const r2 = await readsAt(s0 + 80 * MIN);
    for (const s of [30, 60, 90]) expect(await readsAt(s0 + 80 * MIN + s * 1000), `minute 80 +${s} s`).toBe(r2);
    expect(await readsAt(settled)).toBe(r2);
    await expect(result(page)).not.toContainText('Processing results');
  });

  test('re-reads the timeline when the shared revision changes, and reads nothing for an unchanged one', async ({ page, context }) => {
    // Live, as a visitor: the Woodland Path departed 45 minutes ago and its encounter 2 (minute 40) is overdue.
    const now = Date.now();
    const source = TIMELINES.woodland;
    const delta = now - 45 * MIN - source.stages[0].startedAtMs;
    const full: RevealedTimeline = { activityId: source.activityId, serverNowMs: now, visibleThroughMs: now,
      stages: source.stages.map(s => ({ ...s, revealedAtMs: s.revealedAtMs + delta, startedAtMs: s.startedAtMs + delta, endsAtMs: s.endsAtMs + delta })) };
    const late: RevealedTimeline = { ...full, stages: full.stages.filter(s => s.startedAtMs < now - 5 * MIN) };
    const world = { ...emptyWorld(now), revision: 'live-1' };
    const live = await routeLiveReads(context, { world, timelines: { [full.activityId]: late } });
    const reads = () => page.evaluate(() => window.__cloudiatorExpedition!.reads());
    await page.goto(`/expedition/?activity=${full.activityId}`);
    await page.waitForFunction(() => !!window.__cloudiatorExpedition?.state(), null, { timeout: 45_000 });
    await expect(phase(page)).toContainText('Preparing');
    await expect(logItems(page)).toHaveCount(3);
    await page.waitForTimeout(700);
    const r0 = await reads();
    // A revision poll (here on focus) that finds the same revision reads nothing.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => live.count('world_revision'), { timeout: 5_000 }).toBeGreaterThan(1);
    await page.waitForTimeout(700);
    expect(await reads()).toBe(r0);
    // The worker publishes encounter 2: the revision changes, and the next poll's new revision reads the timeline once.
    live.setTimelines({ [full.activityId]: full });
    live.setWorld({ ...world, revision: 'live-2' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(reads, { timeout: 5_000 }).toBe(r0 + 1);
    await expect(phase(page)).not.toContainText('Preparing');
    await expect(logItems(page).filter({ hasText: 'Encounter 2' })).toHaveCount(1);
    await page.waitForTimeout(700);
    expect(await reads()).toBe(r0 + 1);
    expect(live.requests.every(r => r.reader === null)).toBe(true);
  });

  test('follows the gladiator by default and pans freely after a drag', { tag: '@render' }, async ({ page }) => {
    await expeditionFlow.open(page, 'woodland', 5);
    await expeditionFlow.sceneReady(page);
    await expeditionFlow.hold(page, 'woodland', 5);
    const gap = async () => {
      const d = await expeditionFlow.scene(page);
      const feet = worldToScreen(d.gladiator!.x, d.gladiator!.y);
      return Math.hypot(d.camera.centerX - feet.x, d.camera.centerY - (feet.y - 24));
    };
    await page.waitForFunction(() => { const d = window.__cloudiatorExpeditionScene!.debug()!; return d.following; });
    await expect.poll(gap, { timeout: 5_000 }).toBeLessThan(40);
    const follow = page.getByRole('button', { name: 'Follow the gladiator' });
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3, { steps: 6 });
    await page.mouse.up();
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    const freeCamera = (await expeditionFlow.scene(page)).camera;
    // The gladiator walks on; a free camera stays where it was left.
    await expeditionFlow.hold(page, 'woodland', 15);
    const moved = await expeditionFlow.scene(page);
    expect(moved.following).toBe(false);
    expect(moved.camera.centerX).toBeCloseTo(freeCamera.centerX, 3);
    expect(moved.camera.centerY).toBeCloseTo(freeCamera.centerY, 3);
    expect(await gap()).toBeGreaterThan(60);
    await follow.click();
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(gap, { timeout: 5_000 }).toBeLessThan(40);
    // Zoom buttons step and the view stays inside the map.
    const zoom = async () => (await expeditionFlow.scene(page)).camera.zoom;
    const z0 = await zoom();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    expect(await zoom()).toBeGreaterThan(z0);
    for (let i = 0; i < 10; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click();
    const { worldView: v, bounds: b } = (await expeditionFlow.scene(page)).camera;
    expect(v.x).toBeGreaterThanOrEqual(b.x - 1);
    expect(v.x + v.width).toBeLessThanOrEqual(b.x + b.width + 1);
    await page.getByRole('button', { name: 'Reset zoom' }).click();
    expect(await zoom()).toBeCloseTo(z0, 5);
  });

  test('keeps the journey readable with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expeditionFlow.open(page, 'woodland', 19);
    await expeditionFlow.sceneReady(page);
    expect((await expeditionFlow.scene(page)).reducedMotion).toBe(true);
    const fight = encounterStages('woodland')[0];
    // The creature leaves at once after the result poses, instead of fading.
    await expeditionFlow.holdAt(page, fight.endsAtMs + OUTRO_MS + 200);
    expect((await expeditionFlow.scene(page)).creature!.alpha).toBe(0);
    // The camera snaps to the gladiator instead of gliding.
    await expeditionFlow.hold(page, 'woodland', 30);
    const d = await expeditionFlow.scene(page);
    const feet = worldToScreen(d.gladiator!.x, d.gladiator!.y);
    expect(Math.hypot(d.camera.centerX - feet.x, d.camera.centerY - (feet.y - 24))).toBeLessThan(1);
    await expect(phase(page)).toContainText('Exploring');
    // Back at camp, the gladiator leaves the scene at once instead of fading.
    await expeditionFlow.holdAt(page, TIMELINES.woodland.stages.at(-1)!.startedAtMs + 100);
    expect((await expeditionFlow.scene(page))).toMatchObject({ returned: true, gladiator: { visible: false, alpha: 0, labelVisible: false } });
    await expect(page.getByText('Returned to camp', { exact: true })).toBeVisible();
  });

  test('fades the creature after the result poses without reduced motion', async ({ page }) => {
    await expeditionFlow.open(page, 'woodland', 19);
    await expeditionFlow.sceneReady(page);
    const fight = encounterStages('woodland')[0];
    await expeditionFlow.holdAt(page, fight.endsAtMs + OUTRO_MS + 200);
    const alpha = (await expeditionFlow.scene(page)).creature!.alpha;
    expect(alpha).toBeGreaterThan(0.5);
    expect(alpha).toBeLessThan(1);
  });

  test('keeps the progress strip, log and result usable without WebGL', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        return /webgl/.test(type) ? null : (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
      } as typeof original;
    });
    await expeditionFlow.open(page, 'woodland', 85);
    await expect(page.getByText(/needs WebGL/)).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('canvas').count()).toBe(0);
    await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
    await expect(page.getByRole('meter', { name: 'Expedition progress' })).toHaveAttribute('aria-valuenow', '80');
    await expect(logItems(page)).toHaveCount(TIMELINES.woodland.stages.length);
    await expect(result(page)).toContainText('Success');
    // No scene, so no scene banner: the phase text alone says the gladiator is back.
    await expect(page.getByText('Returned to camp', { exact: true })).toHaveCount(0);
    await expect(phase(page)).toContainText('Back at camp');
    await expect(page.getByRole('link', { name: 'Camp', exact: true })).toHaveAttribute('href', '/game/?mode=fixture');
  });

  test('keeps the journey usable when the expedition art cannot load', async ({ page }) => {
    await page.route('**/assets/**/*.png', route => route.abort());
    await expeditionFlow.open(page, 'outpost');
    await expect(page.getByText(/art could not load/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Returning without rewards')).toBeVisible();
    await expect(logItems(page)).toHaveCount(5);
  });

  test('fits a 360px-wide screen and stays keyboard usable', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await expeditionFlow.open(page, 'mountain', 60.05);
    await expeditionFlow.sceneReady(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const canvas = (await page.locator('canvas').boundingBox())!;
    expect(canvas.x).toBeGreaterThanOrEqual(0);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(360);
    for (const name of ['Zoom in', 'Zoom out', 'Reset zoom', 'Follow the gladiator']) {
      const box = (await page.getByRole('button', { name }).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(40);
      expect(box.x >= 0 && box.x + box.width <= 360, name).toBe(true);
    }
    const camp = (await page.getByRole('link', { name: 'Camp', exact: true }).boundingBox())!;
    expect(camp.height).toBeGreaterThanOrEqual(40);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-360-mountain-encounter.png'), fullPage: true });
    // Keyboard: focus the scene, zoom with plus, toggle the follow with F.
    await page.getByRole('application').focus();
    const zoom = (await expeditionFlow.scene(page)).camera.zoom;
    await page.keyboard.press('+');
    expect((await expeditionFlow.scene(page)).camera.zoom).toBeGreaterThan(zoom);
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: 'Follow the gladiator' })).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: 'Follow the gladiator' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('reads the timeline once per reveal mark, not on focus alone, and sends no command or remote request', async ({ page }) => {
    const requests: Request[] = [];
    page.on('request', request => requests.push(request));
    await expeditionFlow.open(page, 'woodland', 39);
    await expeditionFlow.sceneReady(page);
    const reads = () => page.evaluate(() => window.__cloudiatorExpedition!.reads());
    // One read on entry (React's development mode runs the entry effect twice; only the last read counts).
    const first = await reads();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(2);
    // Passing minute 40 asks once for newly revealed stages, and never again for that mark.
    await expeditionFlow.hold(page, 'woodland', 40 - 0.5 / 60);
    await page.evaluate(() => window.__cloudiatorExpedition!.freeze(null));
    await expect.poll(reads, { timeout: 5_000 }).toBe(first + 1);
    await page.waitForTimeout(1200);
    expect(await reads()).toBe(first + 1);
    // Focus refreshes the shared revision (Task 13.8); the fixture's is unchanged, so the timeline is not read again.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(700);
    expect(await reads()).toBe(first + 1);
    // Camera controls change nothing on the server.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Follow the gladiator' }).click();
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, box.y + 60, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const origin = new URL(page.url()).origin;
    const remote = requests.filter(r => new URL(r.url()).origin !== origin && !r.url().startsWith('data:') && !r.url().startsWith('blob:'));
    expect(remote.map(r => r.url())).toEqual([]);
    expect(requests.filter(r => r.method() !== 'GET').map(r => `${r.method()} ${r.url()}`)).toEqual([]);
    expect(requests.filter(r => /functions\/v1|rest\/v1|auth\/v1|54321/.test(r.url())).map(r => r.url())).toEqual([]);
    // The state the page holds at minute 39 has nothing from later stages.
    await expeditionFlow.hold(page, 'woodland', 39);
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/Encounter [23]|Return to camp|Arrive at camp|light boots|salvage|\+\d+ money/i);
  });

  test('explains an unknown, malformed or unreadable expedition without drawing one, reading only public data', async ({ page, context }) => {
    // Since Task 13.2 the live page reads a visitor's public timeline, so its Data API reads are routed to the test
    // transport (never the local Supabase stack). Here the live read fails on the server: the live page cannot read the
    // expedition and must explain it. (An unknown live expedition the server answers is "not available yet": scenes.spec.)
    const live = await routeLiveReads(context, { world: emptyWorld() });
    live.fail('world_revision');
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto('/expedition/?mode=fixture&activity=0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e');
    await expect(page.getByRole('heading', { name: 'This expedition is not available' })).toBeVisible({ timeout: 45_000 });
    await page.goto('/expedition/?mode=fixture&activity=not-an-id');
    await expect(page.getByRole('heading', { name: 'This expedition is not available' })).toBeVisible();
    // The unknown and malformed fixture expeditions read nothing at all.
    expect(requests.filter(url => /functions\/v1|rest\/v1|auth\/v1|54321/.test(url))).toEqual([]);
    expect(live.requests).toEqual([]);
    await page.goto(`/expedition/?activity=${idOf('woodland')}&minute=39`);
    await expect(page.getByRole('heading', { name: 'This expedition is not available' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Camp', exact: true })).toHaveAttribute('href', '/game/');
    expect(await page.locator('canvas').count()).toBe(0);
    // The live page sent no command and no Auth call, and read only the public timeline, as a visitor, through the transport.
    expect(requests.filter(url => /functions\/v1|auth\/v1/.test(url))).toEqual([]);
    expect(live.requests.length).toBeGreaterThan(0);
    expect(live.requests.every(r => r.reader === null && ['world_revision', 'visible_events', 'recent_results'].includes(r.table))).toBe(true);
    expect(requests.filter(url => /54321/.test(url)).every(url => /\/rest\/v1\/(world_revision|visible_events|recent_results)\?/.test(url))).toBe(true);
  });

  test('draws the gladiator on walkable tiles with the shared depth rule, and fades the tree that hides it', { tag: '@render' }, async ({ page }, testInfo) => {
    const map = MAPS.woodland;
    const journey = journeyMap(map);
    await expeditionFlow.open(page, 'woodland', 1);
    await expeditionFlow.sceneReady(page);
    // Every prop slice sorts by the shared depth rule.
    const frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; anchorPx: { x: number; y: number } }> = readJson('public/assets/expeditions/woodland.json').frames;
    const props = await page.evaluate(() => window.__cloudiatorExpeditionScene!.props());
    expect(props).toHaveLength(map.props.length);
    const byId = new Map(props.map(p => [p.id, p]));
    for (const p of map.props) {
      const f = frames[p.frame];
      const expected = drawSlices(p, { w: f.frame.w, anchorX: f.anchorPx.x });
      expect(byId.get(p.id)!.slices.map(s => [s.left, s.width, s.depth]), p.id).toEqual(expected.map(s => [s.left, s.width, worldToScreen(p.x, p.y).y + s.depthOffset]));
    }
    const fight = encounterStages('woodland')[0];
    // Up to the arrival at minute 80, after which the gladiator has left the scene.
    for (const minute of [1, 5, 19.5, 30, 39.5, 45, 70, 79.5, 80 - 1 / 60]) {
      await expeditionFlow.hold(page, 'woodland', minute);
      const d = await expeditionFlow.scene(page);
      const pose = gladiatorPose(journey, renderExpeditionStage(TIMELINES.woodland, d.displayNowMs!).route!, SPEED);
      expect(walkable(map, d.gladiator!.x, d.gladiator!.y), `minute ${minute}`).toBe(true);
      expect([d.gladiator!.x, d.gladiator!.y]).toEqual([pose.x, pose.y]);
      expect(d.gladiator!.depth, `minute ${minute}`).toBeCloseTo(worldToScreen(pose.x, pose.y).y, 6);
    }
    // During the fight both fighters stand on their encounter tiles, the creature to the gladiator's right.
    await expeditionFlow.holdAt(page, fight.startedAtMs + 3_000);
    const d = await expeditionFlow.scene(page);
    const spot = map.expedition!.encounters[0];
    const enemy = worldToScreen(spot.enemyX + 0.5, spot.enemyY + 0.5);
    const hero = worldToScreen(spot.x + 0.5, spot.y + 0.5);
    expect(Math.abs(d.creature!.x - enemy.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(d.creature!.y - enemy.y)).toBeLessThanOrEqual(3);
    expect(Math.abs(d.gladiator!.screenX - hero.x)).toBeLessThanOrEqual(3);
    expect(d.creature!.scaleX).toBe(-1);
    expect(d.gladiator!.scaleX).toBe(1);
    expect(d.creature!.depth).toBeGreaterThan(enemy.y - 1);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-woodland-encounter-1.png') });
    // At the end of the trail an oak hides the waiting gladiator, so it fades.
    const oak = map.props.find(p => p.id === 'tree-oak-1@44,12')!;
    const f = frames[oak.frame];
    const png = decodePng(readFileSync('public/assets/expeditions/woodland.png'));
    const anchor = worldToScreen(oak.x, oak.y);
    const image = { left: anchor.x - f.anchorPx.x, top: anchor.y - f.anchorPx.y, width: f.frame.w, height: f.frame.h,
      slices: drawSlices(oak, { w: f.frame.w, anchorX: f.anchorPx.x }).map(s => ({ x0: anchor.x + s.left, x1: anchor.x + s.left + s.width, depth: anchor.y + s.depthOffset })) };
    const end = journey.points.end;
    expect(hidesActor(image, (x, y) => png.rgba[((f.frame.y + y) * png.width + f.frame.x + x) * 4 + 3], worldToScreen(end.x + 0.5, end.y + 0.5))).toBe(true);
    // A second before the arrival the gladiator waits there, behind the faded oak.
    await expeditionFlow.hold(page, 'woodland', 80 - 1 / 60);
    const waiting = await expeditionFlow.scene(page);
    expect(waiting.gladiator).toMatchObject({ x: end.x + 0.5, y: end.y + 0.5, visible: true });
    expect(waiting.faded).toContain(oak.id);
    expect((await page.evaluate(() => window.__cloudiatorExpeditionScene!.props())).find(p => p.id === oak.id)!.alpha).toBeLessThan(1);
    await expeditionFlow.settle(page);
    await page.screenshot({ path: testInfo.outputPath('expedition-woodland-arrival-behind-oak.png') });
  });

  test('draws all three environments with their creatures', async ({ page }, testInfo) => {
    for (const [key, creature] of [['woodland', 'dire-wolf'], ['outpost', 'raider-archer'], ['mountain', 'frost-troll']] as const) {
      const n = creature === 'dire-wolf' ? 1 : 2;
      const fight = encounterStages(key)[n - 1];
      await expeditionFlow.open(page, key, (fight.startedAtMs - startOf(key)) / MIN);
      await expeditionFlow.sceneReady(page);
      await expeditionFlow.holdAt(page, fight.startedAtMs + Math.min(2_500, fight.battleLog!.durationMs - 100));
      const d = await expeditionFlow.scene(page);
      expect(d.environment).toBe(key);
      expect(d.creature!.creatureId).toBe(creature);
      expect(d.gladiator!.action).toBe('fight');
      await expeditionFlow.settle(page);
      await page.screenshot({ path: testInfo.outputPath(`expedition-${key}-encounter-${n}.png`) });
    }
  });
});

test.describe('exported expedition route', () => {
  test.skip(!production, 'Runs against the static production export.');

  test('refuses the fixture preview and its minute clock, and reads nothing it could show', async ({ page }, testInfo) => {
    const requests: string[] = [];
    page.on('request', request => requests.push(`${request.method()} ${request.url()}`));
    for (const key of ['woodland', 'spectator'] as const) {
      await page.goto(`${expeditionFlow.url(key, 39)}`);
      await expect(page.getByText('Fixture preview is unavailable in this build.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'This expedition is not available' })).toBeVisible();
      await expect(page.getByText(/Fixture mode/)).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Camp', exact: true })).toHaveAttribute('href', '/game/');
      expect(await page.locator('canvas').count()).toBe(0);
      expect(await page.evaluate(() => window.__cloudiatorExpedition === undefined && window.__cloudiatorExpeditionScene === undefined)).toBe(true);
      const text = await page.locator('main').innerText();
      expect(text).not.toMatch(/Woodland Path|Ruined Outpost|Encounter \d|Aster|Varro|Depart for/);
    }
    await page.screenshot({ path: testInfo.outputPath('expedition-production-fixture-refused.png'), fullPage: true });
    // The fixture camp page lists no sample expeditions in an export.
    await page.goto('/game/?mode=fixture');
    await expect(page.getByText('Fixture preview is unavailable in this build.')).toBeVisible();
    await openMenu(page, 'Results');
    await expect(page.getByRole('navigation', { name: 'Sample expeditions' })).toHaveCount(0);
    // Only same-origin static reads (the exported router also prefetches linked pages with HEAD, and the camp's art loads
    // through in-page blob URLs of this origin); no data source at all.
    const origin = new URL(page.url()).origin;
    const local = (url: string) => url.startsWith(origin) || url.startsWith(`blob:${origin}/`);
    expect(requests.filter(r => !/^(GET|HEAD) /.test(r) || !local(r.slice(r.indexOf(' ') + 1)) || /functions\/v1|rest\/v1|auth\/v1|54321/.test(r))).toEqual([]);
  });
});
