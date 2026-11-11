import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from './fixtures';
import { worldToScreen } from '../../src/game/iso';
import { NPC_ROUTINES, planNpcPosition } from '../../src/game/npcs';
import type { MapData } from '../../src/game/assets';
import { TALK_FADE_MS, talkHoldMs } from '../../src/game/npc-talk';
import { expectOwnerShown, menuDialog, openMenu, quietArrivals, touchLayout } from './shell-helpers';

// Patch 1.9, Task 11 (Avi approved the mockups 2026-11-11): camp NPCs talk in a pixel speech bubble, and the Settings panel
// chooses when names and titles show over the camp (Off, When zoomed in, Always), with "Tidy" overlaps.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const shotDir = process.env.TASK11_SHOT_DIR;
/** The device key the two choices are kept under (`LABEL_PREFS_KEY`). */
const LABELS_KEY = 'cloudiator.labels.v1';
type Prop = { id: string; frame: string; x: number; y: number; w: number; d: number };
const campMap = JSON.parse(readFileSync('public/assets/camp/map.json', 'utf8')) as MapData & { props: Prop[] };
const LINES = {
  trainer: [
    'I am Cassius. In this yard you call me Doctore.',
    'Sweat in the yard so you bleed less in the Arena.',
    "Two trainings a day. Try a third and you'll nap on the dummy.",
    "Train four hundred times and you'll earn my title. Then we spar.",
  ],
  cook: "They call me Old Marta. I've stirred this pot since before you.",
  smith: "Name's Brutus. Every blade in this camp came off my anvil.",
  armorer: "I'm Livia. Brutus makes holes; I make sure they're not in you.",
};

const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const campState = (page: Page) => page.evaluate(() => window.__cloudiatorCamp!.state()!);
const canvasBox = async (page: Page) => (await page.locator('canvas').boundingBox())!;
const bubble = (page: Page) => page.getByTestId('npc-bubble');
const liveLine = (page: Page) => page.getByTestId('npc-talk-live');
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished))); return locator; };

/** Opens the fixture camp; with `still`, reduced motion keeps each NPC at its first post and the clock is held. */
async function openCamp(page: Page, { query = '', still = true }: { query?: string; still?: boolean } = {}) {
  if (still) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/game/?mode=fixture${query}`);
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  if (still) await page.evaluate(() => window.__cloudiatorCamp!.freezeClock(window.__cloudiatorShell!.clock.now()));
}
/** Where `id`'s body is on the page (centred at `zoom` first, unless `keep`). */
async function bodyAt(page: Page, id: string, { zoom = 2, keep = false }: { zoom?: number; keep?: boolean } = {}) {
  if (!keep) {
    const actor = (await campState(page)).actors.find(a => a.id === id)!;
    await page.evaluate(({ x, y, z }) => window.__cloudiatorCamp!.centerOn(x, y, z), { x: actor.x, y: actor.y, z: zoom });
    await nextFrames(page);
  }
  const at = (await page.evaluate(x => window.__cloudiatorCamp!.screenOf(x), id))!;
  const box = await canvasBox(page);
  return { x: box.x + at.x, y: box.y + at.y };
}
/** Clicks (or taps) `id`'s body, the camp click a player makes. */
async function clickBody(page: Page, id: string, options?: { zoom?: number; keep?: boolean }) {
  const at = await bodyAt(page, id, options);
  if (await touchLayout(page)) await page.touchscreen.tap(at.x, at.y - 6);
  else await page.mouse.click(at.x, at.y - 6);
  await nextFrames(page);
  return at;
}
/** A point on the camp's ground, clear of everyone and of the stalls, in the middle of the view. */
async function emptyGround(page: Page) {
  const { actors, camera } = await campState(page);
  const z = camera.zoom, view = camera.worldView;
  const box = await canvasBox(page);
  const toPage = (p: { x: number; y: number }) => ({ x: box.x + (p.x - view.x) * z, y: box.y + (p.y - view.y) * z });
  const bodies = actors.filter(a => a.visible).map(a => toPage(worldToScreen(a.x, a.y)));
  const stalls = campMap.props.filter(p => p.frame.startsWith('stall-')).map(p => {
    const a = toPage(worldToScreen(p.x, p.y));
    return { x0: a.x - 69 * z, x1: a.x + 97 * z, y0: a.y - 48 * z, y1: a.y + 79 * z };
  });
  for (let y = box.y + box.height * 0.35; y < box.y + box.height * 0.8; y += 12) {
    for (let x = box.x + box.width * 0.25; x < box.x + box.width * 0.75; x += 12) {
      if (bodies.some(b => Math.abs(b.x - x) < 30 * z && y > b.y - 60 * z && y < b.y + 16 * z)) continue;
      if (stalls.some(s => x > s.x0 && x < s.x1 && y > s.y0 && y < s.y1)) continue;
      if (await page.evaluate(p => document.elementFromPoint(p.x, p.y) instanceof HTMLCanvasElement, { x, y })) return { x, y };
    }
  }
  throw new Error('no empty ground in view');
}
async function tapAt(page: Page, p: { x: number; y: number }) {
  if (await touchLayout(page)) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
  await nextFrames(page);
}
/** Clicks a merchant's stall on its awning, above anyone standing at the counter. */
async function clickStall(page: Page, frame: 'stall-weapons' | 'stall-armor') {
  const prop = campMap.props.find(p => p.frame === frame)!;
  await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: prop.x + 1.5, y: prop.y + 1 });
  await nextFrames(page);
  const { camera } = await campState(page);
  const anchor = worldToScreen(prop.x, prop.y);
  const box = await canvasBox(page);
  const at = { x: box.x + (anchor.x + 14 - camera.worldView.x) * camera.zoom, y: box.y + (anchor.y - 23 - camera.worldView.y) * camera.zoom };
  expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y) instanceof HTMLCanvasElement, at)).toBe(true);
  await tapAt(page, at);
}
const expectLine = async (page: Page, name: string, line: string, index: number) => {
  await expect(bubble(page)).toBeVisible();
  await expect(bubble(page).getByTestId('npc-bubble-name')).toHaveText(name);
  await expect(bubble(page).getByTestId('npc-bubble-line')).toHaveText(line);
  await expect(bubble(page).locator('[data-dot]')).toHaveCount(4);
  await expect(bubble(page).locator('[data-dot="on"]')).toHaveCount(1);
  expect(await bubble(page).locator('[data-dot]').evaluateAll(dots => dots.findIndex(d => d.getAttribute('data-dot') === 'on'))).toBe(index);
  await expect(liveLine(page)).toHaveText(`${name}: ${line}`);
};

test.describe('talking camp NPCs', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

  test('a click on an NPC shows its name, one line and four dots over its head; the next click shows the next line, cycling', async ({ page }, testInfo) => {
    await openCamp(page);
    const at = await clickBody(page, 'npc:trainer');
    await expectLine(page, 'Doctore Cassius', LINES.trainer[0], 0);
    // Over the head (and the name over it at zoom 2), the tail pointing at the NPC.
    const box = (await (await settled(bubble(page))).boundingBox())!;
    expect(box.y + box.height, 'the bubble ends above the head').toBeLessThanOrEqual(at.y - 26 * 2);
    expect(box.x).toBeLessThan(at.x);
    expect(box.x + box.width).toBeGreaterThan(at.x);
    expect(box.width).toBeLessThanOrEqual(240);
    if (shotDir && testInfo.project.name === 'desktop') await page.screenshot({ path: `${shotDir}/task-11-talk.png` });
    for (const index of [1, 2, 3, 0, 1]) {
      await clickBody(page, 'npc:trainer', { keep: true });
      await expectLine(page, 'Doctore Cassius', LINES.trainer[index], index);
    }
    // At zoom 1 (no names): the bubble sits over the head instead.
    const near = await bodyAt(page, 'npc:trainer', { zoom: 1 });
    await nextFrames(page);
    const atOne = (await bubble(page).boundingBox())!;
    expect(atOne.y + atOne.height).toBeLessThanOrEqual(near.y - 26);
    if (shotDir) await page.screenshot({ path: `${shotDir}/task-11-talk-${testInfo.project.name}.png` });
  });

  test('one bubble at a time; it goes on a click elsewhere, on Escape, and by itself after 4 to 6 s', async ({ page }) => {
    await openCamp(page);
    await clickBody(page, 'npc:trainer');
    await expectLine(page, 'Doctore Cassius', LINES.trainer[0], 0);
    await clickBody(page, 'npc:cook');
    await expect(bubble(page)).toHaveCount(1);
    await expectLine(page, 'Old Marta', LINES.cook, 0);
    // A click on the ground.
    await tapAt(page, await emptyGround(page));
    await expect(bubble(page)).toHaveCount(0);
    // Escape, with the keyboard on the camp view (where the click left it).
    await clickBody(page, 'npc:cook', { keep: true });
    await expect(bubble(page)).toBeVisible();
    if (!(await touchLayout(page))) {
      await page.keyboard.press('Escape');
      await expect(bubble(page)).toHaveCount(0);
      await clickBody(page, 'npc:cook', { keep: true });
    }
    // By itself, on the camp's clock: the line holds 4 to 6 s (longer lines longer), fades for 0.4 s, then goes.
    const t0 = await page.evaluate(() => window.__cloudiatorShell!.clock.now());
    const hold = talkHoldMs((await campState(page)).talk!.line);
    expect(hold).toBeGreaterThanOrEqual(4_000);
    expect(hold).toBeLessThanOrEqual(6_000);
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), t0 + hold - 100);
    await nextFrames(page);
    await expect(bubble(page)).toBeVisible();
    await expect(bubble(page)).not.toHaveAttribute('data-fading', 'true');
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), t0 + hold + 100);
    await nextFrames(page);
    await expect(bubble(page)).toHaveAttribute('data-fading', 'true');
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), t0 + hold + TALK_FADE_MS + 50);
    await nextFrames(page);
    await expect(bubble(page)).toHaveCount(0);
  });

  test('the bubble follows an NPC who walks on', async ({ page }) => {
    await openCamp(page, { still: false });
    const routine = NPC_ROUTINES.find(r => r.npcId === 'trainer')!;
    const base = await page.evaluate(() => window.__cloudiatorShell!.clock.now());
    const start = base - (base % routine.periodMs) + routine.periodMs;
    // A moment the trainer walks for the next second (a straight-ish leg between posts).
    let t = 0;
    for (; t < routine.periodMs; t += 250) {
      const [a, b] = [planNpcPosition(routine, campMap, start + t), planNpcPosition(routine, campMap, start + t + 1_000)];
      if (a.action === 'walk' && b.action === 'walk' && Math.hypot(b.x - a.x, b.y - a.y) > 0.8) break;
    }
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), start + t);
    const before = await clickBody(page, 'npc:trainer');
    await expect(bubble(page)).toBeVisible();
    const b0 = (await bubble(page).boundingBox())!;
    await page.evaluate(ms => window.__cloudiatorCamp!.freezeClock(ms), start + t + 1_000);
    await nextFrames(page);
    const after = await bodyAt(page, 'npc:trainer', { keep: true });
    const b1 = (await bubble(page).boundingBox())!;
    expect(Math.hypot(after.x - before.x, after.y - before.y), 'the trainer walked').toBeGreaterThan(20);
    expect(Math.abs((b1.x - b0.x) - (after.x - before.x))).toBeLessThanOrEqual(2);
    expect(Math.abs((b1.y - b0.y) - (after.y - before.y))).toBeLessThanOrEqual(2);
  });

  test('NPCs show a pointer and a gold ring on hover; gladiators do not', async ({ page }) => {
    await openCamp(page);
    test.skip(await touchLayout(page), 'Hover is the pointer layout\'s.');
    const at = await bodyAt(page, 'npc:trainer');
    await page.mouse.move(at.x, at.y - 6);
    await nextFrames(page);
    await expect.poll(() => page.locator('canvas').evaluate(c => (c as HTMLCanvasElement).style.cursor)).toBe('pointer');
    expect((await campState(page)).hoverRing).toBe('npc:trainer');
    const aster = (await campState(page)).actors.find(a => a.kind === 'player' && a.name === 'Aster')!;
    const g = await bodyAt(page, aster.id);
    await page.mouse.move(g.x, g.y - 6);
    await nextFrames(page);
    await expect.poll(() => page.locator('canvas').evaluate(c => (c as HTMLCanvasElement).style.cursor)).not.toBe('pointer');
    expect((await campState(page)).hoverRing).toBeNull();
  });

  test('Brutus and Livia talk and open no shop; their stalls open Inventory and shops as before', async ({ page }) => {
    await openCamp(page);
    await expectOwnerShown(page, 'Aster');
    const inventory = menuDialog(page, 'Inventory and shops');
    await clickBody(page, 'npc:smith');
    await expectLine(page, 'Brutus the Smith', LINES.smith, 0);
    await expect(inventory).toHaveCount(0);
    await clickBody(page, 'npc:armorer');
    await expectLine(page, 'Livia the Armorer', LINES.armorer, 0);
    await expect(inventory).toHaveCount(0);
    await clickStall(page, 'stall-weapons');
    await expect(inventory).toBeVisible();
    await expect(inventory.getByRole('group', { name: 'Shop filters', exact: true }).getByRole('button', { pressed: true })).toHaveText(['Weapons']);
  });

  test('visitors talk too, and a stall still asks them to sign in', async ({ page }) => {
    await openCamp(page, { query: '&as=visitor' });
    await clickBody(page, 'npc:armorer');
    await expectLine(page, 'Livia the Armorer', LINES.armorer, 0);
    await expect(menuDialog(page, 'My gladiator')).toHaveCount(0);
    // Livia's bubble sits over her stall's awning: a click on the ground closes it first.
    await tapAt(page, await emptyGround(page));
    await expect(bubble(page)).toHaveCount(0);
    await clickStall(page, 'stall-armor');
    const mine = menuDialog(page, 'My gladiator');
    await expect(mine).toBeVisible();
    await expect(mine.getByRole('button', { name: 'Sign in with Google to create your gladiator' })).toBeVisible();
    await expect(menuDialog(page, 'Inventory and shops')).toHaveCount(0);
  });
});

test.describe('names and titles in Settings', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

  const names = (settings: Locator) => settings.getByRole('radiogroup', { name: 'Names', exact: true });
  const titles = (settings: Locator) => settings.getByRole('radiogroup', { name: 'Titles', exact: true });
  const radio = (group: Locator, label: 'Off' | 'When zoomed in' | 'Always') => group.getByRole('radio', { name: label, exact: true });
  /** The visible camp actors (in the view, not just its margin). */
  const inView = (state: Awaited<ReturnType<typeof campState>>) => {
    const v = state.camera.worldView;
    return state.actors.filter(a => {
      const f = worldToScreen(a.x, a.y);
      return a.visible && f.x > v.x + 30 && f.x < v.x + v.width - 30 && f.y > v.y + 80 && f.y < v.y + v.height;
    });
  };

  test('Settings has a Names and titles section: two three-way choices with a hint each, When zoomed in to start', async ({ page }, testInfo) => {
    await openCamp(page);
    const settings = await openMenu(page, 'Settings');
    await expect(settings.getByRole('heading', { name: 'Names and titles', exact: true })).toBeVisible();
    for (const group of [names(settings), titles(settings)]) {
      await expect(group.getByRole('radio')).toHaveCount(3);
      expect(await group.getByRole('radio').evaluateAll(els => els.map(e => e.closest('label')!.textContent!.trim()))).toEqual(['Off', 'When zoomed in', 'Always']);
      await expect(radio(group, 'When zoomed in')).toBeChecked();
    }
    await expect(settings.getByText('Gladiator names from zoom 1.4, NPC names from zoom 2.', { exact: true })).toBeVisible();
    await expect(settings.getByText('Titles from zoom 2, beside the name.', { exact: true })).toBeVisible();
    await radio(names(settings), 'Always').check();
    await expect(settings.getByText('Names at any zoom, zoomed out too.', { exact: true })).toBeVisible();
    // The section fits the panel or sheet without a sideways scroll.
    expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (shotDir && testInfo.project.name === 'desktop') await (await settled(settings)).screenshot({ path: `${shotDir}/task-11-settings.png` });
    if (shotDir && testInfo.project.name === 'mobile') await page.screenshot({ path: `${shotDir}/task-11-settings-phone.png` });
  });

  test('Always shows every name at zoom 1 and zoomed out at zoom-1 size; Titles follow their own choice', async ({ page }, testInfo) => {
    await openCamp(page);
    const settings = await openMenu(page, 'Settings');
    await radio(names(settings), 'Always').check();
    expect((await campState(page)).labels).toEqual({ names: 'always', titles: 'zoom' });
    await page.getByRole('dialog', { name: 'Settings' }).locator('[data-menu-close]').click();
    const aster = (await campState(page)).actors.find(a => a.kind === 'player' && a.name === 'Aster')!;
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 1), { x: aster.x, y: aster.y });
    await nextFrames(page);
    let state = await campState(page);
    const shown = inView(state);
    expect(shown.length).toBeGreaterThan(10);
    for (const a of shown) expect(a.nameplate, `${a.name} at zoom 1`).not.toBeNull();
    // Titles stay When zoomed in: none at zoom 1.
    expect(shown.filter(a => a.title?.visible)).toEqual([]);
    const heightAt1 = shown[0].plates[0].height;
    // Zoomed right out: still every name, drawn at the size it has at zoom 1.
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 0.2), { x: aster.x, y: aster.y });
    await nextFrames(page);
    state = await campState(page);
    expect(state.camera.zoom).toBeLessThan(1);
    const far = inView(state);
    for (const a of far) expect(a.nameplate, `${a.name} zoomed out`).not.toBeNull();
    const sample = far.find(a => a.id === shown[0].id) ?? far[0];
    expect(sample.plates[0].height * state.camera.zoom).toBeCloseTo(heightAt1, 0);
    if (shotDir && testInfo.project.name === 'desktop') await page.screenshot({ path: `${shotDir}/task-11-names-always.png` });
    // Titles Always: a title with every name.
    const again = await openMenu(page, 'Settings');
    await radio(titles(again), 'Always').check();
    await expect(again.getByText('A title with every name that shows.', { exact: true })).toBeVisible();
    await nextFrames(page);
    state = await campState(page);
    const titled = inView(state).filter(a => a.title);
    expect(titled.length).toBeGreaterThan(0);
    for (const a of titled) expect(a.title!.visible, `${a.name}'s title`).toBe(true);
  });

  test('Off shows no names at all, a selected gladiator included, greys Titles out (kept) and is remembered', async ({ page }) => {
    await openCamp(page);
    const settings = await openMenu(page, 'Settings');
    await radio(titles(settings), 'Always').check();
    await radio(names(settings), 'Off').check();
    await expect(settings.getByText('No names on the camp.', { exact: true })).toBeVisible();
    await expect(settings.getByText('Titles show only where names show. Turn Names on to choose.', { exact: true })).toBeVisible();
    for (const label of ['Off', 'When zoomed in', 'Always'] as const) await expect(radio(titles(settings), label)).toBeDisabled();
    await expect(radio(titles(settings), 'Always')).toBeChecked();
    const aster = (await campState(page)).actors.find(a => a.kind === 'player' && a.name === 'Aster')!;
    await page.evaluate(id => window.__cloudiatorCamp!.emit('follow-character', { gladiatorId: id }), aster.id);
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2.4), { x: aster.x, y: aster.y });
    await page.evaluate(id => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: id }), aster.id);
    await nextFrames(page);
    const state = await campState(page);
    expect(state.selected).toBe(aster.id);
    for (const a of state.actors) {
      expect(a.nameplate, a.name).toBeNull();
      expect(a.title?.visible ?? false, a.name).toBe(false);
    }
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), LABELS_KEY)).toEqual({ names: 'off', titles: 'always' });
    await page.reload();
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    expect((await campState(page)).labels).toEqual({ names: 'off', titles: 'always' });
    const reopened = await openMenu(page, 'Settings');
    await expect(radio(names(reopened), 'Off')).toBeChecked();
    await radio(names(reopened), 'When zoomed in').check();
    await expect(radio(titles(reopened), 'Always')).toBeEnabled();
    await expect(radio(titles(reopened), 'Always')).toBeChecked();
  });

  test('Tidy: overlapping names behind fade to 30%, your gladiator and the talking NPC stay full, hover brings one back', async ({ page }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [LABELS_KEY, JSON.stringify({ names: 'always', titles: 'always' })]);
    await openCamp(page);
    await expectOwnerShown(page, 'Aster');
    const aster = (await campState(page)).actors.find(a => a.kind === 'player' && a.name === 'Aster')!;
    await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 0.7), { x: aster.x, y: aster.y });
    await nextFrames(page);
    let state = await campState(page);
    const faded = inView(state).filter(a => a.nameplate?.alpha === 0.3);
    expect(faded.length, 'some names behind others fade').toBeGreaterThan(0);
    for (const a of inView(state)) expect([0.3, 1], a.name).toContain(a.nameplate!.alpha);
    expect(state.actors.find(a => a.id === aster.id)!.nameplate!.alpha).toBe(1);
    // The talking NPC is never faded.
    await clickBody(page, 'npc:trainer', { zoom: 0.7 });
    await expect(bubble(page)).toBeVisible();
    state = await campState(page);
    expect(state.actors.find(a => a.id === 'npc:trainer')!.nameplate!.alpha).toBe(1);
    if (await touchLayout(page)) return;
    // Hover over a faded gladiator (one no nearer body covers): its name comes back.
    const targets = inView(state).filter(a => a.kind === 'player' && a.nameplate?.alpha === 0.3 && a.id !== aster.id);
    expect(targets.length, 'a faded gladiator in view').toBeGreaterThan(0);
    let restored: string | null = null;
    for (const target of targets.slice(0, 6)) {
      const at = await bodyAt(page, target.id, { keep: true });
      await page.mouse.move(at.x, at.y - 6);
      await nextFrames(page);
      state = await campState(page);
      if (state.hover !== target.id) continue;
      expect(state.actors.find(a => a.id === target.id)!.nameplate!.alpha).toBe(1);
      restored = target.id;
      break;
    }
    expect(restored, 'hovering a faded gladiator restores its name').not.toBeNull();
    // Moving off it fades it again.
    const ground = await emptyGround(page);
    await page.mouse.move(ground.x, ground.y);
    await nextFrames(page);
    expect((await campState(page)).actors.find(a => a.id === restored)!.nameplate!.alpha).toBe(0.3);
  });
});
