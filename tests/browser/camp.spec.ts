import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { drawSlices, hidesActor } from '../../src/game/depth';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { worldToScreen } from '../../src/game/iso';
import { locationKind } from '../../src/game/actors';
import { NPC_ROUTINES, npcPostTiles, planNpcPosition } from '../../src/game/npcs';
import { SLOT_MS } from '../../src/game/lighting';
import type { MapData } from '../../src/game/assets';
import { createDemoWorld } from '../../src/game/demo-world';
import { closeMenu, openMenu, revealRail, touchLayout } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
type Zone = { id: string; bounds: { x: number; y: number; w: number; h: number } };
type Prop = { id: string; frame: string; x: number; y: number; w: number; d: number; sortY: number; layer: 'floor' | 'object' | 'foreground'; occludes: boolean; slices?: { left: number; width: number; depthOffset: number }[] };
const campMap: { zones: Zone[]; props: Prop[] } = readJson('public/assets/camp/map.json');
const propFrames: Record<string, { frame: { x: number; y: number; w: number; h: number }; anchorPx: { x: number; y: number } }> = readJson('public/assets/camp/props.json').frames;
const propsImage: { width: number; rgba: Uint8Array } = decodePng(readFileSync('public/assets/camp/props.png'));
/** Where each kind of public location belongs (spec §3.3), written independently of the scene code. */
const EXPECTED_ZONE: Record<string, string> = { training: 'training', rest: 'rest', arena: 'arena', tournament: 'arena', orientation: 'expedition-gate', idle: 'merchants' };

async function openCamp(page: Page) {
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
const campState = (page: Page) => page.evaluate(() => window.__cloudiatorCamp!.state()!);
/**
 * One zoom step in: the Zoom in button at the bottom of the menu rail (Task 13.5). The touch layout has no zoom buttons
 * (it pinches), so there the camp's own + key takes the step.
 */
async function zoomInStep(page: Page) {
  if (await touchLayout(page)) {
    await page.getByRole('application').focus();
    await page.keyboard.press('+');
    return;
  }
  await revealRail(page);
  await page.getByRole('button', { name: 'Zoom in' }).click();
}
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test.describe('living isometric camp', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');

  test('places every gladiator inside the zone its public location names, off the NPC posts', async ({ page }, testInfo) => {
    await openCamp(page);
    const state = await campState(page);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors.length)).toBeLessThanOrEqual(50);
    expect({ players: state.players, ambientNpcs: state.ambientNpcs, away: state.away }).toEqual({ players: 44, ambientNpcs: 6, away: 6 });
    const posts = npcPostTiles();
    const players = state.actors.filter(a => a.kind === 'player');
    expect(new Set(players.map(a => a.location)).size).toBeGreaterThanOrEqual(4);
    for (const a of players) {
      const zone = campMap.zones.find(z => z.id === EXPECTED_ZONE[locationKind(a.location!)])!;
      expect(a.zone, `${a.name} (${a.location})`).toBe(zone.id);
      const [tx, ty] = [Math.floor(a.x), Math.floor(a.y)];
      const b = zone.bounds;
      expect(tx >= b.x && ty >= b.y && tx < b.x + b.w && ty < b.y + b.h, `${a.name} at ${tx},${ty} outside ${zone.id}`).toBe(true);
      expect(posts.has(`${tx},${ty}`), `${a.name} stands on an NPC post`).toBe(false);
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath('camp-overview.png') });
  });

  test('opens on the owner and finds or follows them from the Gladiators menu', async ({ page }) => {
    await openCamp(page);
    const ownerId = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors[0].gladiatorId);
    const near = async () => {
      const s = await campState(page);
      const owner = s.actors.find(a => a.id === ownerId)!;
      const feet = worldToScreen(owner.x, owner.y);
      return Math.hypot(s.camera.centerX - feet.x, s.camera.centerY - (feet.y - 24));
    };
    expect(await near()).toBeLessThan(40);
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.up();
    expect(await near()).toBeGreaterThan(100);
    // Find and Follow live in the Gladiators menu (Task 13.5), which hands the view back to the camp after each.
    await (await openMenu(page, 'Gladiators')).getByRole('button', { name: 'Find my gladiator' }).click();
    expect(await near()).toBeLessThan(40);
    expect((await campState(page)).selected).toBe(ownerId);
    const follow = page.getByRole('button', { name: 'Follow my gladiator' });
    await openMenu(page, 'Gladiators');
    await follow.click();
    await openMenu(page, 'Gladiators');
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    expect((await campState(page)).following).toBe(ownerId);
    await closeMenu(page);
    // Dragging the map ends the follow and the toggle says so.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 5 });
    await page.mouse.up();
    await openMenu(page, 'Gladiators');
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    expect((await campState(page)).following).toBeNull();
    // A click with a few pixels of jitter is not a drag and keeps the follow.
    await follow.click();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5 + 3, box.y + box.height * 0.6 + 2, { steps: 3 });
    await page.mouse.up();
    await openMenu(page, 'Gladiators');
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    expect((await campState(page)).following).toBe(ownerId);
  });

  test('selects the gladiator whose body is under the pointer, not a neighbour', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCamp(page);
    const ownerId = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors[0].gladiatorId);
    const box = (await page.locator('canvas').boundingBox())!;
    // screenOf is the body centre, 20 art px above the feet; at zoom 2 the head is about 50 px above it. Points
    // above the feet keep clear of a neighbour standing in front, whose body may cover the owner's feet.
    for (const dy of [-36, -16, 0, 10]) {
      await page.evaluate(() => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: 'npc:smith' }));
      expect((await campState(page)).selected).toBe('npc:smith');
      const owner = (await campState(page)).actors.find(a => a.id === ownerId)!;
      await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: owner.x, y: owner.y });
      await nextFrames(page);
      const at = (await page.evaluate(id => window.__cloudiatorCamp!.screenOf(id), ownerId))!;
      await page.mouse.click(box.x + at.x, box.y + at.y + dy);
      expect((await campState(page)).selected, `${dy} px from the body centre`).toBe(ownerId);
    }
  });

  test('disables Find and Follow while the owner is away, and never shows a follow that did not happen', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // departures leave at once
    await openCamp(page);
    await openMenu(page, 'Gladiators');
    const find = page.getByRole('button', { name: 'Find my gladiator' });
    const follow = page.getByRole('button', { name: 'Follow my gladiator' });
    await expect(find).toBeEnabled();
    const ownerId = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors[0].gladiatorId);
    await page.evaluate(id => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.map(a => (a.gladiatorId === id ? { ...a, location: 'expedition:woodland' as const } : a)) });
    }, ownerId);
    expect((await campState(page)).actors.some(a => a.id === ownerId)).toBe(false);
    await expect(find).toBeDisabled();
    await expect(follow).toBeDisabled();
    // The scene refuses a follow it cannot apply, and the toggle reflects what the scene did,
    // even once the owner comes back.
    await page.evaluate(id => window.__cloudiatorCamp!.emit('follow-character', { gladiatorId: id }), ownerId);
    expect((await campState(page)).following).toBeNull();
    await page.evaluate(id => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.map(a => (a.gladiatorId === id ? { ...a, location: 'training' as const } : a)) });
    }, ownerId);
    await expect(follow).toBeEnabled();
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    expect((await campState(page)).following).toBeNull();
  });

  test('draws a full 50-gladiator camp, each on its own tile', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // arrivals take their places at once
    await openCamp(page);
    const serverNowMs = await page.evaluate(() => window.__cloudiatorCamp!.world()!.serverNowMs);
    const full = createDemoWorld(serverNowMs, 50, 0);
    await page.evaluate(world => window.__cloudiatorCamp!.setWorld(world), full);
    const state = await campState(page);
    expect(state.players).toBe(50);
    expect(state.away).toBe(0);
    const players = state.actors.filter(a => a.kind === 'player');
    expect(players.every(a => !a.walking)).toBe(true);
    expect(new Set(players.map(a => `${Math.floor(a.x)},${Math.floor(a.y)}`)).size).toBe(50);
  });

  test('keeps the camera inside the map after panning far beyond its edges', async ({ page }) => {
    await openCamp(page);
    const box = (await page.locator('canvas').boundingBox())!;
    for (const [fx, fy, tx, ty] of [[0.9, 0.9, 0.05, 0.05], [0.9, 0.9, 0.05, 0.05], [0.1, 0.1, 0.95, 0.95], [0.1, 0.1, 0.95, 0.95], [0.1, 0.1, 0.95, 0.95]]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * tx, box.y + box.height * ty, { steps: 6 });
      await page.mouse.up();
      const { camera } = await campState(page);
      const { worldView: v, bounds: b } = camera;
      expect(v.x).toBeGreaterThanOrEqual(b.x - 1);
      expect(v.y).toBeGreaterThanOrEqual(b.y - 1);
      expect(v.x + v.width).toBeLessThanOrEqual(b.x + b.width + 1);
      expect(v.y + v.height).toBeLessThanOrEqual(b.y + b.height + 1);
    }
  });

  test('zooms in fixed steps from buttons, keys and the wheel, and leaves browser shortcuts alone', async ({ page }, testInfo) => {
    await openCamp(page);
    const zoom = async () => (await campState(page)).camera.zoom;
    for (let i = 0; i < 12; i += 1) await zoomInStep(page);
    expect(await zoom()).toBeCloseTo(3, 5);
    // Clicking the camp gives it keyboard focus.
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + 20);
    await expect(page.getByRole('application')).toBeFocused();
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('-');
    expect(await zoom()).toBeCloseTo(0.5, 5);
    await page.keyboard.press('0');
    expect(await zoom()).toBeCloseTo(1, 5);
    await page.keyboard.press('Control+Minus');
    expect(await zoom()).toBeCloseTo(1, 5);
    if (testInfo.project.name === 'mobile') return; // phones pinch instead (next test)

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(120, 0); // horizontal scroll never zooms
    await nextFrames(page);
    expect(await zoom()).toBeCloseTo(1, 5);
    // Small trackpad deltas accumulate. Phaser handles wheel events as they arrive, so the checks
    // read the camera at once and stay well inside the 250 ms gesture window.
    for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -12);
    expect(await zoom()).toBeCloseTo(1, 5);
    await page.mouse.wheel(0, -12);
    await nextFrames(page);
    expect(await zoom()).toBeCloseTo(1.25, 5);
    await page.mouse.wheel(0, 100); // one mouse notch out
    await nextFrames(page);
    expect(await zoom()).toBeCloseTo(1, 5);
    // Line-mode wheels (Firefox) step once per notch of three lines.
    const lineNotch = (deltaY: number) => page.evaluate(dy => {
      const canvas = document.querySelector('canvas')!;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true }));
    }, deltaY);
    await lineNotch(-3);
    await nextFrames(page);
    expect(await zoom()).toBeCloseTo(1.25, 5);
    await lineNotch(3);
    await nextFrames(page);
    expect(await zoom()).toBeCloseTo(1, 5);
    // Leftover deltas from an earlier gesture do not add up with a later one.
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, -60);
    await nextFrames(page);
    expect(await zoom()).toBeCloseTo(1, 5);
  });

  test('pinches to zoom with two fingers on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Touch pinch runs on the phone project.');
    await openCamp(page);
    const box = (await page.locator('canvas').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', spread: number) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx - spread, y: cy, id: 1 }, { x: cx + spread, y: cy, id: 2 }],
    });
    await touch('touchStart', 30);
    for (let spread = 35; spread <= 90; spread += 5) await touch('touchMove', spread);
    await touch('touchEnd', 0);
    const zoom = (await campState(page)).camera.zoom;
    expect(zoom).toBeGreaterThan(2);
    expect(zoom).toBeLessThanOrEqual(3);
  });

  test('animates neighbouring gladiators out of sync', async ({ page }) => {
    await openCamp(page);
    await page.waitForTimeout(500);
    const { actors } = await campState(page);
    const players = actors.filter(a => a.kind === 'player');
    for (const action of ['weights', 'sleep', 'spar']) {
      const group = players.filter(a => a.action === action);
      if (group.length >= 3) expect(new Set(group.map(a => a.frame)).size, action).toBeGreaterThan(1);
    }
    expect(new Set(players.map(a => a.action)).size).toBeGreaterThanOrEqual(5);
  });

  test('sorts every prop slice and actor by the shared depth rule', async ({ page }) => {
    await openCamp(page);
    const props = await page.evaluate(() => window.__cloudiatorCamp!.props());
    expect(props).toHaveLength(campMap.props.length);
    const byId = new Map(props.map(p => [p.id, p]));
    for (const p of campMap.props) {
      const f = propFrames[p.frame];
      const expected = drawSlices(p, { w: f.frame.w, anchorX: f.anchorPx.x });
      const anchorY = worldToScreen(p.x, p.y).y;
      const drawn = byId.get(p.id)!;
      expect(drawn.slices.map(s => [s.left, s.width, s.depth]), p.id).toEqual(expected.map(s => [s.left, s.width, anchorY + s.depthOffset]));
    }
    const { actors } = await campState(page);
    for (const a of actors) expect(a.depth, a.id).toBeCloseTo(worldToScreen(a.x, a.y).y, 6);
  });

  test('draws the guard behind the watchtower and fades the tower while he is selected', async ({ page }, testInfo) => {
    // From the shared routines, find a moment when an NPC stands behind a building (not a tree or wall).
    const occluders = campMap.props.filter(p => p.occludes && !/^(tree|palisade|arena-wall)/.test(p.frame)).map(p => {
      const f = propFrames[p.frame];
      const a = worldToScreen(p.x, p.y);
      const slices = drawSlices(p, { w: f.frame.w, anchorX: f.anchorPx.x }).map(sl => ({ x0: a.x + sl.left, x1: a.x + sl.left + sl.width, depth: a.y + sl.depthOffset }));
      const alphaAt = (x: number, y: number) => propsImage.rgba[((f.frame.y + y) * propsImage.width + f.frame.x + x) * 4 + 3];
      return { id: p.id, alphaAt, image: { left: a.x - f.anchorPx.x, top: a.y - f.anchorPx.y, width: f.frame.w, height: f.frame.h, slices } };
    });
    // Covered means opaque prop pixels over the body, drawn after the actor.
    const coveredBy = (x: number, y: number) => occluders.filter(o => hidesActor(o.image, o.alphaAt, worldToScreen(x, y))).map(o => o.id);
    let moment: { routine: (typeof NPC_ROUTINES)[number]; t: number; x: number; y: number; covering: string[] } | null = null;
    for (const routine of NPC_ROUTINES) {
      for (let t = 0; t < routine.periodMs && !moment; t += 250) {
        const p = planNpcPosition(routine, campMap as unknown as MapData, t);
        const covering = coveredBy(p.x, p.y);
        if (covering.length) moment = { routine, t, x: p.x, y: p.y, covering };
      }
    }
    expect(moment, 'some NPC route passes behind a building').not.toBeNull();
    const { routine, t, x, y, covering } = moment!;
    expect(routine.npcId).toBe('guard');
    expect(covering).toContain('watchtower@38,16');

    await openCamp(page);
    const base = await page.evaluate(() => window.__cloudiatorCamp!.world()!.serverNowMs);
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), base - (base % routine.periodMs) + t);
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2.44), { x, y });
    await nextFrames(page);
    const npc = (await campState(page)).actors.find(a => a.id === `npc:${routine.npcId}`)!;
    expect([npc.x, npc.y]).toEqual([x, y]);
    const sliceDepths = (await page.evaluate(() => window.__cloudiatorCamp!.props())).filter(p => covering.includes(p.id));
    for (const prop of sliceDepths) expect(Math.max(...prop.slices.map(sl => sl.depth)), prop.id).toBeGreaterThan(npc.depth);
    await page.screenshot({ path: testInfo.outputPath('camp-behind-building.png') });

    await page.evaluate(id => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: id }), npc.id);
    await nextFrames(page);
    expect([...(await campState(page)).faded].sort()).toEqual([...covering].sort());
    const alphas = new Map((await page.evaluate(() => window.__cloudiatorCamp!.props())).map(p => [p.id, p.alpha]));
    for (const id of covering) expect(alphas.get(id), id).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath('camp-behind-building-faded.png') });

    const open = (await campState(page)).actors.find(a => a.kind === 'player' && a.zone === 'arena')!;
    await page.evaluate(id => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: id }), open.id);
    await nextFrames(page);
    expect((await campState(page)).faded).toEqual([]);
    const restored = new Map((await page.evaluate(() => window.__cloudiatorCamp!.props())).map(p => [p.id, p.alpha]));
    for (const id of covering) expect(restored.get(id), id).toBe(1);
  });

  test('darkens the evening and lights the torches', async ({ page }, testInfo) => {
    await openCamp(page);
    const slot = await page.evaluate(() => window.__cloudiatorCamp!.world()!.slotIndex);
    const applied: Record<string, { overlayAlpha: number; torchAlpha: number }> = {};
    for (const [i, phase] of ['morning', 'afternoon', 'evening'].entries()) {
      // Twenty minutes into the slot whose index mod 3 names the phase, away from the blend window.
      const start = (slot - (slot % 3) + i) * SLOT_MS + 1_200_000;
      await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), start);
      await nextFrames(page);
      applied[phase] = (await campState(page)).lighting;
      await page.screenshot({ path: testInfo.outputPath(`camp-${phase}.png`) });
    }
    expect(applied.evening.overlayAlpha).toBeGreaterThan(applied.morning.overlayAlpha);
    expect(applied.afternoon.overlayAlpha).toBeLessThan(applied.morning.overlayAlpha);
    expect(applied.evening.torchAlpha).toBeGreaterThan(applied.afternoon.torchAlpha * 2);
    expect(applied.evening.overlayAlpha).toBeLessThanOrEqual(0.35);
  });

  test('walks departures to the gate, arrivals in from it, and redraws changed equipment', async ({ page }) => {
    await openCamp(page);
    const before = await campState(page);
    const players = before.actors.filter(a => a.kind === 'player');
    const leaver = players.reduce((best, a) => (Math.hypot(a.x - 41.5, a.y - 22.5) < Math.hypot(best.x - 41.5, best.y - 22.5) ? a : best));
    const changed = players.find(a => a.id !== leaver.id && !a.layers.includes('armor-heavy'))!;
    const arrival = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors.find(a => a.location.startsWith('expedition'))!.gladiatorId);
    await page.evaluate(({ leaver, changed, arrival }) => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({
        ...world,
        actors: world.actors.map(a => a.gladiatorId === leaver ? { ...a, location: 'expedition:woodland' }
          : a.gladiatorId === arrival ? { ...a, location: 'rest' }
          : a.gladiatorId === changed ? { ...a, equipmentSilhouettes: ['weapon-axe', 'armor-heavy', 'head-helmet'] } : a),
      });
    }, { leaver: leaver.id, changed: changed.id, arrival });
    const after = await campState(page);
    const find = (id: string) => after.actors.find(a => a.id === id);
    expect(find(leaver.id)?.walking).toBe(true);
    const comer = find(arrival)!;
    expect(comer.walking).toBe(true);
    expect(Math.hypot(comer.x - 41.5, comer.y - 22.5)).toBeLessThan(1.5);
    expect(find(changed.id)!.layers).toEqual(expect.arrayContaining(['armor-heavy', 'head-helmet', 'weapon-axe']));
    // Only the leaver, the arrival and at most the leaver's sparring partner move.
    const walking = after.actors.filter(a => a.walking).map(a => a.id);
    expect(walking).toEqual(expect.arrayContaining([leaver.id, arrival]));
    expect(walking.length).toBeLessThanOrEqual(3);
    for (const a of players) {
      const now = find(a.id)!;
      if (!now.walking) expect(`${Math.floor(now.x)},${Math.floor(now.y)}`, a.name).toBe(`${Math.floor(a.x)},${Math.floor(a.y)}`);
    }
    await page.waitForFunction(id => !window.__cloudiatorCamp!.state()!.actors.some(a => a.id === id), leaver.id, { timeout: 40_000 });
    const final = await campState(page);
    expect(final.players).toBe(44);
    expect(final.away).toBe(6);
  });

  test('holds NPCs at their posts and torches steady with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCamp(page);
    const npcs = async () => (await campState(page)).actors.filter(a => a.kind === 'npc').map(a => ({ id: a.id, x: a.x, y: a.y, action: a.action }));
    expect((await campState(page)).reducedMotion).toBe(true);
    const first = await npcs();
    const torch = (await campState(page)).lighting.torchAlpha;
    await page.waitForTimeout(1500);
    expect(await npcs()).toEqual(first);
    expect(first.every(n => n.action !== 'walk')).toBe(true);
    expect((await campState(page)).lighting.torchAlpha).toBe(torch);
  });

  test('re-entering the game keeps one canvas and the camera still responds', async ({ page }) => {
    await openCamp(page);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.canvases())).toBe(1);
    const listeners = await page.evaluate(() => window.__cloudiatorCamp!.listeners());
    // Leave through a link in the page (the shell has no header: a sample replay in Results), then come back.
    await (await openMenu(page, 'Results')).getByRole('navigation', { name: 'Sample replays' }).getByRole('link').first().click();
    await page.waitForURL(url => !url.pathname.startsWith('/game'));
    await page.goBack();
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    expect(await page.evaluate(() => window.__cloudiatorCamp!.canvases())).toBe(1);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.listeners())).toBe(listeners);
    await zoomInStep(page);
    expect((await campState(page)).camera.zoom).toBeCloseTo(1.25, 5);
  });

  test('repaints the baked ground after the WebGL context is lost and restored', async ({ page }) => {
    await openCamp(page);
    await page.evaluate(() => window.__cloudiatorCamp!.freezeClock(window.__cloudiatorCamp!.world()!.serverNowMs));
    await nextFrames(page);
    const canvas = page.locator('canvas');
    const before = decodePng(await canvas.screenshot());
    await page.evaluate(async () => {
      const gl = (document.querySelector('canvas')!.getContext('webgl2') ?? document.querySelector('canvas')!.getContext('webgl'))!;
      const ext = gl.getExtension('WEBGL_lose_context')!;
      ext.loseContext();
      await new Promise(resolve => setTimeout(resolve, 300));
      ext.restoreContext();
      await new Promise(resolve => setTimeout(resolve, 600));
    });
    await nextFrames(page);
    const after = decodePng(await canvas.screenshot());
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    let differing = 0;
    for (let i = 0; i < before.rgba.length; i += 4) {
      if (Math.abs(before.rgba[i] - after.rgba[i]) + Math.abs(before.rgba[i + 1] - after.rgba[i + 1]) + Math.abs(before.rgba[i + 2] - after.rgba[i + 2]) > 24) differing += 1;
    }
    expect(differing / (before.width * before.height)).toBeLessThan(0.02);
  });

  test('keeps management usable when the camp art cannot load', async ({ page }) => {
    await page.route('**/assets/**/*.png', route => route.abort());
    await page.goto('/game/?mode=fixture');
    await expect(page.getByText(/camp art could not load/)).toBeVisible({ timeout: 30_000 });
    await revealRail(page);
    await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
  });

  test('explains the missing camp and keeps management usable without WebGL', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        return /webgl/.test(type) ? null : (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
      } as typeof original;
    });
    await page.goto('/game/?mode=fixture');
    await expect(page.getByText(/needs WebGL/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Camp view unavailable')).toBeVisible();
    await revealRail(page);
    await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toBeEnabled();
  });
});
