import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures';
import { drawSlices, hidesActor } from '../../src/game/depth';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { worldToScreen } from '../../src/game/iso';
import { locationKind, tintFor } from '../../src/game/actors';
import { CLOTH_COLOURS, HAIR_COLOURS, SKIN_TONES } from '../../supabase/functions/_shared/domain/appearance';
import { NPC_ROUTINES, npcPostTiles, planNpcPosition } from '../../src/game/npcs';
import { SLOT_MS } from '../../src/game/lighting';
import type { MapData } from '../../src/game/assets';
import { createDemoWorld } from '../../src/game/demo-world';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { SLEEP_NAME_LIFT, ZZZ_FADE_MS } from '../../src/game/sleep-zzz';
import { closeMenu, openMenu, revealRail, touchLayout } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
type Zone = { id: string; bounds: { x: number; y: number; w: number; h: number } };
type Prop = { id: string; frame: string; x: number; y: number; w: number; d: number; sortY: number; layer: 'floor' | 'object' | 'foreground'; occludes: boolean; slices?: { left: number; width: number; depthOffset: number }[] };
const campMap: { zones: Zone[]; props: Prop[] } = readJson('public/assets/camp/map.json');
const propFrames: Record<string, { frame: { x: number; y: number; w: number; h: number }; anchorPx: { x: number; y: number } }> = readJson('public/assets/camp/props.json').frames;
/** The camp props atlas image the manifest names (by its content: final review F1). */
const propsImage: { width: number; rgba: Uint8Array } = decodePng(readFileSync(`public/assets/${readJson('public/assets/manifest.json').atlases['camp-props'].image}`));
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
    // 50 public rows: 6 away, and 44 in the camp, of whom Otho rests at home and is not drawn (Task 23.9).
    // 14 NPCs since patch 1.5.1: today's six, four more guards and four camp NPCs.
    expect({ players: state.players, ambientNpcs: state.ambientNpcs, away: state.away }).toEqual({ players: 43, ambientNpcs: 14, away: 6 });
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

  test('opens on the owner and finds or follows them from the Gladiators menu', { tag: '@render' }, async ({ page }) => {
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

  test('selects the gladiator whose body is under the pointer, not a neighbour', { tag: '@render' }, async ({ page }) => {
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
      const profile = page.getByRole('dialog', { name: 'Profile: Aster', exact: true });
      await expect(profile).toBeVisible();
      await profile.getByRole('button', { name: 'Close profile', exact: true }).click();
      await expect(profile).toHaveCount(0);
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

  test('keeps the camera inside the map after panning far beyond its edges', { tag: '@render' }, async ({ page }) => {
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

  test('zooms in fixed steps from buttons, keys and the wheel, and leaves browser shortcuts alone', { tag: '@render' }, async ({ page }, testInfo) => {
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

  test('lays sleepers along their beds under a rising ZzZ, names over it, and answers a click on the legs (Task 11b)', async ({ page }, testInfo) => {
    await openCamp(page);
    // A gladiator asleep on a bed: its station is a bed's head tile (x 14, 16 or 18; y 35, 36, 39 or 40).
    const onBed = (a: { x: number; y: number }) => [14, 16, 18].includes(Math.floor(a.x)) && [35, 36, 39, 40].includes(Math.floor(a.y));
    const sleepers = (await campState(page)).actors.filter(a => a.kind === 'player' && a.action === 'sleep' && !a.walking && onBed(a));
    expect(sleepers.length, 'the fixture camp has gladiators asleep on beds').toBeGreaterThan(0);
    const sleeper = sleepers[0];
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 3), { x: sleeper.x, y: sleeper.y });
    await nextFrames(page);
    const read = async () => (await campState(page)).actors.find(a => a.id === sleeper.id)!;
    const now = await read();
    const feet = worldToScreen(now.x, now.y);
    // Its name's bottom edge sits SLEEP_NAME_LIFT over the feet, the ZzZ between it and the body (which reaches 16 px up).
    expect(now.plates[0].y + now.plates[0].height).toBeCloseTo(feet.y - SLEEP_NAME_LIFT, 0);
    expect(now.zzz.length).toBeGreaterThanOrEqual(2);
    for (const z of now.zzz) {
      expect(z.y + z.height, `${z.glyph} over the body`).toBeLessThanOrEqual(feet.y - 17);
      expect(z.y, `${z.glyph} under the name`).toBeGreaterThan(feet.y - SLEEP_NAME_LIFT);
    }
    // The letters rise in a loop on the camp's clock (polled, not a fixed wait: final review Minor 13); a standing gladiator has none.
    await expect.poll(async () => JSON.stringify((await read()).zzz)).not.toBe(JSON.stringify(now.zzz));
    for (const a of (await campState(page)).actors.filter(x => x.action !== 'sleep')) expect(a.zzz, a.name).toEqual([]);
    // Its click box covers the whole lying body, from behind the head to the feet on the bed's foot tile.
    expect(now.hit).toEqual({ x: feet.x - 14, y: feet.y - 17, width: 48, height: 27 });
    await page.screenshot({ path: testInfo.outputPath('camp-sleepers.png') });
    const box = (await page.locator('canvas').boundingBox())!;
    const zoom = (await campState(page)).camera.zoom;
    const at = (await page.evaluate(id => window.__cloudiatorCamp!.screenOf(id), sleeper.id))!;
    // The legs: 26 art px toward the feet and 4 px under them (screenOf is 20 art px over the feet).
    await page.mouse.click(box.x + at.x + 26 * zoom, box.y + at.y + (20 + 4) * zoom);
    expect((await campState(page)).selected).toBe(sleeper.id);
    // Its selection ring lies under the middle of its body, half a tile along the bed from its head tile (final review Minor 10).
    await expect.poll(async () => (await campState(page)).ring).toEqual({ x: feet.x + 16, y: feet.y + 8 });
    await expect(page.getByRole('dialog', { name: `Profile: ${sleeper.name}`, exact: true })).toBeVisible();
  });

  for (const reduced of [false, true]) {
    test(`a sleeper who gets up ${reduced ? 'loses its ZzZ at once with reduced motion' : 'fades its ZzZ out over the letters\' own fade time, over its bed'} (Task 21 item 10)`, async ({ page }) => {
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      await openCamp(page);
      const onBed = (a: { x: number; y: number }) => [14, 16, 18].includes(Math.floor(a.x)) && [35, 36, 39, 40].includes(Math.floor(a.y));
      const players = (await campState(page)).actors.filter(a => a.kind === 'player' && !a.walking);
      const sleeper = players.find(a => a.action === 'sleep' && onBed(a))!;
      const awake = players.find(a => a.action !== 'sleep' && a.zone !== 'rest' && a.location)!;
      await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 3), { x: sleeper.x, y: sleeper.y });
      // The camp's clock held, so the fade is read at exact times.
      const t0 = await page.evaluate(() => window.__cloudiatorShell!.clock.now());
      const at = (ms: number) => page.evaluate(m => window.__cloudiatorCamp!.freezeClock(m), ms).then(() => nextFrames(page));
      await at(t0);
      const read = async () => (await campState(page)).actors.find(a => a.id === sleeper.id)!;
      const asleep = (await read()).zzz;
      expect(asleep.length).toBeGreaterThanOrEqual(2);
      // It gets up: its public location moves to the training ground, and it walks there.
      await page.evaluate(({ id, location }) => {
        const hook = window.__cloudiatorCamp!;
        const world = hook.world()!;
        hook.setWorld({ ...world, actors: world.actors.map(a => (a.gladiatorId === id ? { ...a, location: location as typeof a.location } : a)) });
      }, { id: sleeper.id, location: awake.location! });
      await expect.poll(async () => (await read()).action).not.toBe('sleep');
      if (reduced) {
        expect((await read()).zzz).toEqual([]);
        return;
      }
      // At first the letters are as they were; halfway through the fade they are at most half opaque, still over the bed (the
      // exact opacity over the fade is the unit test's, tests/domain/sleep-zzz.test.ts).
      expect((await read()).zzz).toEqual(asleep);
      await at(t0 + ZZZ_FADE_MS / 2);
      const half = (await read()).zzz;
      expect(half.length).toBeGreaterThan(0);
      for (const z of half) {
        expect(z.alpha).toBeGreaterThan(0);
        expect(z.alpha).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(asleep.some(a => Math.abs(a.x - z.x) <= 6 && Math.abs(a.y - z.y) <= 18), 'over the bed').toBe(true);
      }
      await at(t0 + ZZZ_FADE_MS - 20);
      expect((await read()).zzz.length, 'still fading').toBeGreaterThan(0);
      await at(t0 + ZZZ_FADE_MS + 20);
      expect((await read()).zzz).toEqual([]);
    });
  }

  test('takes the armor and helmet off a sleeper and brings its hair back, and keeps them on an awake gladiator (Task 14)', async ({ page }) => {
    await openCamp(page);
    const HIDDEN = ['armor-light', 'armor-heavy', 'head-hood', 'head-helmet', 'head-helmet-crest'];
    const HAIR = ['hair', 'hair-long', 'hair-ponytail'];
    const onBed = (a: { x: number; y: number }) => [14, 16, 18].includes(Math.floor(a.x)) && [35, 36, 39, 40].includes(Math.floor(a.y));
    const players = (await campState(page)).actors.filter(a => a.kind === 'player' && !a.walking);
    const sleeper = players.find(a => a.action === 'sleep' && onBed(a))!;
    const awake = players.find(a => a.action !== 'sleep' && a.id !== sleeper.id)!;
    // Both put on a helmet and heavy armor, and a look with a ponytail; nobody moves (the same variants keep their spots).
    await page.evaluate(({ sleeper, awake }) => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.map(a => (a.gladiatorId === sleeper || a.gladiatorId === awake
        ? { ...a, equipmentSilhouettes: ['weapon-sword', 'offhand-shield', 'head-helmet', 'armor-heavy'], appearance: { body: 'female', hair: 'ponytail', skin: 1, hairColor: 2, cloth: 3 } } : a)) });
    }, { sleeper: sleeper.id, awake: awake.id });
    const read = async (id: string) => (await campState(page)).actors.find(a => a.id === id)!;
    await expect.poll(async () => (await read(sleeper.id)).layers).toContain('hair-ponytail');
    const asleep = await read(sleeper.id);
    expect(asleep.action).toBe('sleep');
    expect(asleep.layers).toEqual(['body-female', 'cloth-female', 'hair-ponytail', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    for (const id of HIDDEN) expect(asleep.layers, id).not.toContain(id);
    // Awake, the helmet covers the hair.
    const up = await read(awake.id);
    expect(up.action).not.toBe('sleep');
    expect(up.layers).toEqual(expect.arrayContaining(['head-helmet', 'head-helmet-crest', 'armor-heavy']));
    for (const id of HAIR) expect(up.layers, id).not.toContain(id);
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

  // Patch 1.5.1 (camp-expansion proposal, Patch 1): five guards and four new camp NPCs on today's map; in the evening the two
  // wall patrols are the night watch, carrying a torch whose light walks with them.
  test('shows the five guards and the new camp NPCs, and lights the wall patrols\' torches only in the evening', async ({ page }, testInfo) => {
    await openCamp(page);
    const first = await campState(page);
    const npcs = first.actors.filter(a => a.kind === 'npc');
    expect(npcs.map(a => a.id).sort()).toEqual(NPC_ROUTINES.map(r => `npc:${r.npcId}`).sort());
    for (const r of NPC_ROUTINES) if (r.name) expect(npcs.find(a => a.id === `npc:${r.npcId}`)!.name, r.npcId).toBe(r.name);
    expect(npcs.filter(a => a.look === 'guard' || a.look === 'night-watch').map(a => a.id).sort())
      .toEqual(['npc:guard', 'npc:guard-south', 'npc:lookout', 'npc:patrol-north', 'npc:patrol-south']);
    for (const id of ['water-carrier', 'herald', 'porter', 'forester']) expect(npcs.find(a => a.id === `npc:${id}`)!.look, id).toBe(id);

    const slot = await page.evaluate(() => window.__cloudiatorCamp!.world()!.slotIndex);
    // Minute 20 of each phase, and 30 s before the afternoon ends, when the camp torches have mostly brightened for the evening
    // (review fix 5: the night watch takes up its torches with them, not at the slot edge).
    const moments: [string, number, boolean][] = [
      ['morning', 1_200_000, false], ['afternoon', SLOT_MS + 1_200_000, false], ['afternoon end', 2 * SLOT_MS - 30_000, true], ['evening', 2 * SLOT_MS + 1_200_000, true],
    ];
    for (const [phase, offset, evening] of moments) {
      const at = (slot - (slot % 3)) * SLOT_MS + offset;
      await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), at);
      for (const r of NPC_ROUTINES) {
        const p = planNpcPosition(r, campMap as unknown as MapData, at);
        // Each NPC in view at zoom 2, so its nameplate and its light (if any) are drawn.
        await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: p.x, y: p.y });
        await nextFrames(page);
        const state = await campState(page);
        const a = state.actors.find(x => x.id === `npc:${r.npcId}`)!;
        expect([a.x, a.y], `${r.npcId} ${phase}`).toEqual([p.x, p.y]);
        // The drawn nameplate fits the box tests/domain/camp-npcs.test.ts keeps clear (6 px a character + 4, 14 px, 46 px up).
        const feetAt = worldToScreen(a.x, a.y);
        expect(a.plates, `${r.npcId} nameplate`).toHaveLength(1);
        const [plate] = a.plates;
        expect(plate.width, `${r.npcId} nameplate`).toBeLessThanOrEqual(6 * a.name.length + 4);
        expect(plate.height, `${r.npcId} nameplate`).toBeLessThanOrEqual(14);
        expect(Math.abs(plate.y + plate.height - (feetAt.y - 46)), `${r.npcId} nameplate`).toBeLessThanOrEqual(1);
        expect(Math.abs(plate.x + plate.width / 2 - feetAt.x), `${r.npcId} nameplate`).toBeLessThanOrEqual(1);
        const watch = evening && r.npcId.startsWith('patrol-');
        expect(a.look, `${r.npcId} ${phase}`).toBe(watch ? 'night-watch' : r.look ?? r.npcId);
        expect(a.frame.startsWith(`${a.look}/`), `${r.npcId} ${phase} draws ${a.frame}`).toBe(true);
        if (!watch) { expect(a.torch, `${r.npcId} ${phase}`).toBeNull(); continue; }
        // The torch light rides with the patrol, at the strength of the camp's own evening torches.
        expect(a.torch, `${r.npcId} ${phase}`).not.toBeNull();
        const feet = worldToScreen(a.x, a.y);
        expect(Math.abs(a.torch!.x - feet.x), r.npcId).toBeLessThanOrEqual(16);
        expect(feet.y - a.torch!.y, r.npcId).toBeGreaterThan(16);
        expect(feet.y - a.torch!.y, r.npcId).toBeLessThan(48);
        expect(a.torch!.alpha, r.npcId).toBeGreaterThan(state.lighting.torchAlpha * 0.7);
        expect(a.torch!.alpha, r.npcId).toBeLessThan(state.lighting.torchAlpha / 0.7);
        if (r.npcId === 'patrol-south' && phase === 'evening') await page.screenshot({ path: testInfo.outputPath('camp-night-watch.png') });
      }
    }
  });

  // Review fix 6: with reduced motion the NPCs keep to their first post, and the night watch still carries a steady torch.
  test('lights the night watch\'s torches with reduced motion too, steady and only while the camp torches burn', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCamp(page);
    expect((await campState(page)).reducedMotion).toBe(true);
    const slot = await page.evaluate(() => window.__cloudiatorCamp!.world()!.slotIndex);
    const base = (slot - (slot % 3)) * SLOT_MS;
    for (const [phase, offset, lit] of [['morning', 1_200_000, false], ['afternoon', SLOT_MS + 1_200_000, false], ['evening', 2 * SLOT_MS + 1_200_000, true], ['evening end', 3 * SLOT_MS - 30_000, false]] as const) {
      for (const r of NPC_ROUTINES.filter(o => o.evening)) {
        const first = [...r.steps].sort((a, b) => a.at - b.at)[0];
        await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), base + offset);
        await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: first.x + 0.5, y: first.y + 0.5 });
        await nextFrames(page);
        const state = await campState(page);
        const a = state.actors.find(x => x.id === `npc:${r.npcId}`)!;
        expect([a.x, a.y, a.action], `${r.npcId} ${phase}`).toEqual([first.x + 0.5, first.y + 0.5, first.action]);
        expect(a.look, `${r.npcId} ${phase}`).toBe(lit ? 'night-watch' : 'guard');
        if (!lit) { expect(a.torch, `${r.npcId} ${phase}`).toBeNull(); continue; }
        // No flicker: exactly the camp torches' strength, every frame.
        expect(a.torch!.alpha, `${r.npcId} ${phase}`).toBeCloseTo(state.lighting.torchAlpha, 6);
        await nextFrames(page);
        expect((await campState(page)).actors.find(x => x.id === a.id)!.torch!.alpha, `${r.npcId} ${phase}`).toBeCloseTo(a.torch!.alpha, 6);
      }
    }
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
    expect(final.players).toBe(43);
    expect(final.away).toBe(6);
  });

  test('draws a gladiator in its chosen look and redraws it when the look changes', async ({ page }, testInfo) => {
    await openCamp(page);
    const players = (await campState(page)).actors.filter(a => a.kind === 'player');
    const subject = players[Math.floor(players.length / 2)];
    const GEAR = ['weapon-sword', 'offhand-shield'];
    const setLook = (appearance: unknown) => page.evaluate(({ id, appearance, gear }) => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.map(a => (a.gladiatorId === id ? { ...a, equipmentSilhouettes: gear, appearance } as typeof a : a)) });
    }, { id: subject.id, appearance, gear: GEAR });
    const drawn = async () => { const a = (await campState(page)).actors.find(x => x.id === subject.id)!; return { layers: a.layers, tint: a.tint, x: a.x, y: a.y }; };

    // A female ponytail look: the female body and clothes replace the male ones, in the chosen colours.
    await setLook({ body: 'female', hair: 'ponytail', skin: 4, hairColor: 3, cloth: 11 });
    const female = await drawn();
    expect(female.layers).toEqual(['body-female', 'cloth-female', 'hair-ponytail', 'accent', ...GEAR, 'held']);
    expect(female.tint).toEqual({ skin: SKIN_TONES[4].tint, hair: HAIR_COLOURS[3].tint, cloth: CLOTH_COLOURS[11].tint });
    await nextFrames(page);
    await page.screenshot({ path: testInfo.outputPath('camp-chosen-look-female.png') });

    // A new look redraws the same gladiator in place (a bald male: no hair layer at all).
    await setLook({ body: 'male', hair: 'bald', skin: 0, hairColor: 0, cloth: 0 });
    const bald = await drawn();
    expect(bald.layers).toEqual(['body', 'cloth', 'accent', ...GEAR, 'held']);
    expect(bald.tint).toEqual({ skin: SKIN_TONES[0].tint, hair: HAIR_COLOURS[0].tint, cloth: CLOTH_COLOURS[0].tint });
    expect([bald.x, bald.y]).toEqual([female.x, female.y]);

    // Long hair, then the legacy look (a null appearance): today's layers and the colours of its id.
    await setLook({ body: 'male', hair: 'long', skin: 2, hairColor: 5, cloth: 7 });
    expect((await drawn()).layers).toEqual(['body', 'cloth', 'hair-long', 'accent', ...GEAR, 'held']);
    await setLook(null);
    const legacy = await drawn();
    expect(legacy.layers).toEqual(['body', 'cloth', 'hair', 'accent', ...GEAR, 'held']);
    expect(legacy.tint).toEqual(tintFor(subject.id));
    // An actor cached before the look existed has no key at all: the legacy look too.
    await page.evaluate(id => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.map(a => { if (a.gladiatorId !== id) return a; const { appearance: _look, ...old } = a; return old as typeof a; }) });
    }, subject.id);
    expect((await drawn()).layers).toEqual(legacy.layers);
    // Everyone else kept the look they had.
    const others = (await campState(page)).actors.filter(a => a.kind === 'player' && a.id !== subject.id);
    expect(others.map(a => [a.id, a.layers])).toEqual(players.filter(a => a.id !== subject.id).map(a => [a.id, a.layers]));
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
    // Task 11b: a sleeper's ZzZ holds still too, all three letters drawn.
    const sleeper = (await campState(page)).actors.find(a => a.kind === 'player' && a.action === 'sleep')!;
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: sleeper.x, y: sleeper.y });
    await nextFrames(page);
    const zzz = async () => (await campState(page)).actors.find(a => a.id === sleeper.id)!.zzz;
    const still = await zzz();
    expect(still.map(z => [z.glyph, z.alpha])).toEqual([['Z', 1], ['z', 1], ['Z', 1]]);
    await page.waitForTimeout(800);
    expect(await zzz()).toEqual(still);
  });

  test('re-entering the game keeps one canvas and the camera still responds', async ({ page }) => {
    // The camp has no link away from itself (since Task 13.8 even the Results samples open over it), so it is entered
    // from a replay page's Back to camp link, left with the browser's Back and re-entered with Forward, each a
    // navigation inside the one document.
    await page.goto(`/replay/?mode=fixture&activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await page.getByRole('link', { name: 'Back to camp' }).click();
    await page.waitForURL(url => url.pathname === '/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    expect(await page.evaluate(() => window.__cloudiatorCamp!.canvases())).toBe(1);
    const listeners = await page.evaluate(() => window.__cloudiatorCamp!.listeners());
    await page.goBack();
    await page.waitForURL(url => url.pathname === '/replay/');
    await page.goForward();
    await page.waitForURL(url => url.pathname === '/game/');
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

// Patch 1.7: a worn title in gold over the name in the camp (spec "Where a title shows").
test.describe('worn titles in the camp', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');

  const TITLES: Record<string, string> = {
    Atticus: 'Pathfinder', Brennus: 'Tiro', Eira: 'Invictus', Jovan: 'Crowd-Pleaser', Mira: 'Collector', Pax: 'Bloodied',
    Quintus: 'Trailblazer', Wren: 'Rare Find', Xanthe: 'Victor', Octavia: 'Lion of the Arena',
  };
  type Box = { x: number; y: number; width: number; height: number };
  const closeUpOn = async (page: Page, name: string, zoom: number) => {
    const actor = (await campState(page)).actors.find(a => a.kind === 'player' && a.name === name)!;
    await page.evaluate(({ x, y, z }) => window.__cloudiatorCamp!.centerOn(x, y, z), { x: actor.x, y: actor.y, z: zoom });
    await nextFrames(page);
    return (await campState(page)).actors.find(a => a.id === actor.id)!;
  };

  test('shows titles over the names when close', async ({ page }) => {
    await openCamp(page);
    for (const [name, text] of Object.entries(TITLES)) {
      const actor = await closeUpOn(page, name, 2.4);
      expect(actor.visible, `${name} is in camp`).toBe(true);
      expect(actor.title, `${name} has a title`).toMatchObject({ text, visible: true });
      const nameBox = actor.plates[0];
      const box = actor.title!.box as Box;
      expect(box.y + box.height, `${name}'s title ends where the name starts`).toBeCloseTo(nameBox.y, 0);
      expect(box.x + box.width / 2, `${name}'s title is centred over the name`).toBeCloseTo(nameBox.x + nameBox.width / 2, 0);
    }
    expect((await closeUpOn(page, 'Ilaria', 2.4)).title).toBeNull();
  });

  test('never moves the name', async ({ page }) => {
    // Reduced motion: nobody walks, so the actor's feet and its name stay put between the two reads.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCamp(page);
    // Where the name's box sits relative to the actor's feet: bottom edge and centre, in world px.
    const nameOffsets = async (stripTitles: boolean) => {
      await page.evaluate(strip => {
        const hook = window.__cloudiatorCamp!;
        const world = hook.world()!;
        hook.setWorld({ ...world, revision: `titles-${strip}`, actors: world.actors.map(a => { const { title: _title, ...rest } = a; return strip ? rest : { ...a }; }) as typeof world.actors });
      }, stripTitles);
      const out: Record<string, { bottom: number; centre: number; height: number }> = {};
      for (const name of Object.keys(TITLES)) {
        const actor = await closeUpOn(page, name, 2.4);
        const feet = worldToScreen(actor.x, actor.y);
        const box = actor.plates[0];
        out[name] = { bottom: box.y + box.height - feet.y, centre: box.x + box.width / 2 - feet.x, height: box.height };
        expect(actor.title === null, `${name} title ${stripTitles ? 'stripped' : 'kept'}`).toBe(stripTitles);
      }
      return out;
    };
    const withTitles = await nameOffsets(false);
    const without = await nameOffsets(true);
    for (const name of Object.keys(TITLES)) {
      expect(without[name].bottom, `${name}'s name bottom`).toBeCloseTo(withTitles[name].bottom, 1);
      expect(without[name].centre, `${name}'s name centre`).toBeCloseTo(withTitles[name].centre, 1);
      expect(without[name].height, `${name}'s name height`).toBeCloseTo(withTitles[name].height, 1);
    }
  });

  test("shows only the followed gladiator's title at medium zoom", async ({ page }) => {
    await openCamp(page);
    const ids = await page.evaluate(() => Object.fromEntries(window.__cloudiatorCamp!.world()!.actors.map(a => [a.name, a.gladiatorId])));
    await page.evaluate(() => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, revision: 'titles-follow', actors: world.actors.map(a => a.name === 'Aster' ? { ...a, title: 'founder' } : a) });
    });
    // Close up on Atticus (a crowd gladiator both in camp and titled) at 1.6, then follow him: his title shows, a neighbour's does not.
    await closeUpOn(page, 'Atticus', 1.6);
    await page.evaluate(id => window.__cloudiatorCamp!.emit('follow-character', { gladiatorId: id }), ids.Atticus);
    await nextFrames(page);
    const state = await campState(page);
    expect(state.camera.zoom).toBeCloseTo(1.6, 1);
    expect(state.following).toBe(ids.Atticus);
    const byName = (n: string) => state.actors.find(a => a.name === n)!;
    expect(byName('Atticus').plates.length, 'the name shows').toBeGreaterThan(0);
    expect(byName('Atticus').title).toMatchObject({ text: 'Pathfinder', visible: true });
    // Everyone else with a title in view shows the name but not the title.
    const others = state.actors.filter(a => a.kind === 'player' && a.id !== ids.Atticus && a.plates.length > 0);
    expect(others.length, 'other names show at 1.6').toBeGreaterThan(0);
    for (const a of others) expect(a.title?.visible ?? false, `${a.name}'s title is hidden`).toBe(false);
  });

  test('keeps no title at zoom 1', async ({ page }) => {
    await openCamp(page);
    await page.evaluate(() => window.__cloudiatorCamp!.emit('follow-character', { gladiatorId: null }));
    await page.evaluate(() => { const h = window.__cloudiatorCamp!; const c = h.state()!.camera; h.centerOn(c.centerX, c.centerY, 1); });
    await nextFrames(page);
    const state = await campState(page);
    expect(state.camera.zoom).toBeCloseTo(1, 1);
    expect(state.following).toBeNull();
    expect(state.selected).toBeNull();
    expect(state.actors.filter(a => a.title?.visible)).toEqual([]);
  });

  test('keeps the NEW tag above the title and the title above the name', async ({ page }) => {
    await openCamp(page);
    // Every new Founder is also NEW: a titled crowd gladiator arrives at the gate.
    await page.evaluate(() => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, revision: 'titles-new', actors: world.actors.map(a => a.name === 'Atticus' ? { ...a, location: 'orientation' as const, resting: false, title: 'founder' } : a) });
    });
    await nextFrames(page);
    const actor = await closeUpOn(page, 'Atticus', 2.4);
    expect(actor.marker).toBe('NEW');
    expect(actor.title).toMatchObject({ text: 'Founder', visible: true });
    const [name, tag] = actor.plates;
    const title = actor.title!.box as Box;
    expect(actor.plates).toHaveLength(2);
    // Name at the bottom, the title directly above it, the tag over the title: no two touch.
    expect(title.y + title.height).toBeCloseTo(name.y, 0);
    expect(tag.y + tag.height, 'the tag ends where the title starts').toBeLessThanOrEqual(title.y + 0.5);
    expect(tag.y + tag.height, 'one line above the title').toBeGreaterThan(title.y - title.height);
  });
});
