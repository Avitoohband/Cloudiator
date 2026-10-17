import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BattleAction, BattleLog } from '../../supabase/functions/_shared/contracts/events';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { emptyWorld, routeLiveReads } from './live-routes';
import { openMenu } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const LOGS: Record<string, BattleLog> = Object.fromEntries(['pvp', 'npc', 'tie', 'expedition-1', 'expedition-2', 'expedition-3']
  .map(name => [name, readJson(`tests/fixtures/battles/${name}.json`)]));
const CASES = [
  { name: 'pvp', activity: REPLAY_FIXTURES.pvp.activityId, log: 'pvp', stage: null },
  { name: 'npc', activity: REPLAY_FIXTURES.npc.activityId, log: 'npc', stage: null },
  { name: 'expedition', activity: REPLAY_FIXTURES.expedition.activityId, log: 'expedition-2', stage: 'woodland-encounter-2' },
  { name: 'tie', activity: REPLAY_FIXTURES.tie.activityId, log: 'tie', stage: null },
] as const;
const attacks = (log: BattleLog) => log.events.filter((e): e is BattleAction => e.kind === 'attack');
const url = (activity: string, stage: string | null = null) => `/replay/?mode=fixture&activity=${activity}${stage ? `&stage=${stage}` : ''}`;

async function openReplay(page: Page, activity: string, stage: string | null = null) {
  await page.goto(url(activity, stage));
  await page.waitForFunction(() => !!window.__cloudiatorReplay?.state(), null, { timeout: 45_000 });
}
const sceneReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
const replayState = (page: Page) => page.evaluate(() => window.__cloudiatorReplay!.state());
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const hpMeter = (page: Page, name: string) => page.getByRole('meter', { name: `${name} health` });

// Opaque pixel bounds of atlas frames, read independently from the shipped PNG and JSON.
const atlases = new Map<string, { frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; anchorPx: { x: number; y: number } }>; png: { width: number; rgba: Uint8Array } }>();
const manifest = readJson('public/assets/manifest.json');
function bounds(atlasKey: string, name: string) {
  if (!atlases.has(atlasKey)) {
    const def = manifest.atlases[atlasKey];
    atlases.set(atlasKey, { frames: readJson(`public/assets/${def.data}`).frames, png: decodePng(readFileSync(`public/assets/${def.image}`)) });
  }
  const { frames, png } = atlases.get(atlasKey)!;
  const f = frames[name];
  let b = { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
  for (let y = 0; y < f.frame.h; y += 1) for (let x = 0; x < f.frame.w; x += 1) {
    if (!png.rgba[((f.frame.y + y) * png.width + f.frame.x + x) * 4 + 3]) continue;
    b = { l: Math.min(b.l, x - f.anchorPx.x), r: Math.max(b.r, x + 1 - f.anchorPx.x), t: Math.min(b.t, y - f.anchorPx.y), b: Math.max(b.b, y + 1 - f.anchorPx.y) };
  }
  return b;
}
type DebugFighter = NonNullable<ReturnType<NonNullable<Window['__cloudiatorBattle']>['debug']>>['fighters'][number];
function rectOf(f: DebugFighter) {
  let u = { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
  for (const name of f.frames) { const b = bounds(f.atlas, name); u = { l: Math.min(u.l, b.l), r: Math.max(u.r, b.r), t: Math.min(u.t, b.t), b: Math.max(u.b, b.b) }; }
  const xs = [f.x + u.l * f.scaleX, f.x + u.r * f.scaleX];
  return { left: Math.min(...xs), right: Math.max(...xs), top: f.y + u.t * f.scaleY, bottom: f.y + u.b * f.scaleY };
}
async function expectStagedCorrectly(page: Page, log: BattleLog, at: number) {
  await page.evaluate(ms => window.__cloudiatorReplay!.seek(ms), at);
  await nextFrames(page);
  const d = (await page.evaluate(() => window.__cloudiatorBattle!.debug()))!;
  expect(d.positionMs).toBe(at);
  const [left, right] = d.fighters;
  // Facing each other: the left fighter faces se (unmirrored), the right one sw (mirrored), at an integer 3x scale.
  expect([left.scaleX, left.scaleY, right.scaleX, right.scaleY], `t=${at}`).toEqual([3, 3, -3, 3]);
  expect(left.x).toBeLessThan(right.x);
  const rects = d.fighters.map(rectOf);
  for (const [i, r] of rects.entries()) {
    expect(r.left >= 0 && r.right <= d.view.width && r.top >= 0 && r.bottom <= d.view.height, `t=${at} fighter ${i} ${d.fighters[i].action} ${JSON.stringify(r)} in ${JSON.stringify(d.view)}`).toBe(true);
  }
  for (const effect of d.effects.filter(e => e.visible && ['hit', 'critical', 'defend', 'evade'].includes(e.effect))) {
    const event = log.events.find(e => e.sequence === effect.sequence) as BattleAction;
    const defender = log.participants[0].id === event.defenderId ? 0 : 1;
    expect(effect.target, `effect ${effect.effect} of seq ${effect.sequence}`).toBe(defender);
    const r = rects[defender];
    expect(effect.x >= r.left - 6 && effect.x <= r.right + 6 && effect.y >= r.top && effect.y <= r.bottom, `effect on the defender at t=${at}`).toBe(true);
  }
  return d;
}

test.describe('battle-log replay', () => {
  test.skip(production, 'Replays need the fixture timelines, which production exports never include.');

  for (const c of CASES) {
    test(`shows the ${c.name} replay with both fighters' snapshots and reaches the logged result when skipped`, async ({ page }) => {
      const log = LOGS[c.log];
      const [a, b] = log.participants;
      await openReplay(page, c.activity, c.stage);
      await expect(page.getByRole('heading', { level: 1, name: `${a.name} vs ${b.name}` })).toBeVisible();
      const table = page.getByRole('table', { name: /Fighters/ });
      for (const p of log.participants) {
        await expect(table).toContainText(p.name);
        await expect(table).toContainText(new RegExp(p.stance, 'i'));
        await expect(table).toContainText(`${p.maxHealth}`);
        await expect(table).toContainText(`${(p.attackIntervalMs / 1000).toFixed(2)} s`);
      }
      await expect(hpMeter(page, a.name)).toHaveAttribute('aria-valuenow', `${a.initialHealth}`);
      await page.getByRole('button', { name: 'Skip to result' }).click();
      for (const [i, p] of log.participants.entries()) {
        await expect(hpMeter(page, p.name)).toHaveAttribute('aria-valuenow', `${log.finalHp[i]}`);
        await expect(hpMeter(page, p.name)).toContainText(`${log.finalHp[i]} / ${p.maxHealth}`);
      }
      const winner = log.participants.find(p => p.id === log.winnerId)!;
      await expect(page.getByRole('region', { name: 'Result' })).toContainText(`${winner.name} wins`);
      expect((await replayState(page))).toMatchObject({ finished: true, winnerId: log.winnerId, hp: [...log.finalHp] });
      // The readable log lists every event with the logged names and numbers.
      const items = page.getByRole('list', { name: 'Combat log' }).getByRole('listitem');
      await expect(items).toHaveCount(log.events.length);
      const texts = await items.allTextContents();
      for (const [k, e] of log.events.entries()) {
        if (e.kind === 'victory') { expect(texts[k]).toContain(winner.name); continue; }
        const [attacker, defender] = [e.attackerId, e.defenderId].map(id => log.participants.find(p => p.id === id)!.name);
        expect(texts[k], `seq ${e.sequence}`).toContain(attacker);
        expect(texts[k]).toContain(defender);
        expect(texts[k]).toContain(`${(e.elapsedMs / 1000).toFixed(2)} s`);
        if (e.hit) expect(texts[k]).toContain(`${e.damage} damage`);
        if (e.hit) expect(texts[k]).toContain(`${e.healthBefore} → ${e.healthAfter} HP`);
        else expect(texts[k]).toContain('misses');
        if (e.critical) expect(texts[k]).toContain('critical');
      }
    });
  }

  test('labels the NPC opponent, the creature encounter and each credited reward from the summary', async ({ page }) => {
    await openReplay(page, REPLAY_FIXTURES.npc.activityId);
    await expect(page.getByText('NPC opponent', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Skip to result' }).click();
    const result = page.getByRole('region', { name: 'Result' });
    await expect(result).toContainText('+3 renown');
    await expect(result).toContainText('No rating change');

    await openReplay(page, REPLAY_FIXTURES.pvp.activityId);
    await page.getByRole('button', { name: 'Skip to result' }).click();
    await expect(page.getByRole('region', { name: 'Result' })).toContainText('+10 renown');
    await expect(page.getByRole('region', { name: 'Result' })).toContainText('Rating +14');

    await openReplay(page, REPLAY_FIXTURES.expedition.activityId, 'woodland-encounter-2');
    const encounters = page.getByRole('group', { name: 'Encounters' }).getByRole('button');
    await expect(encounters).toHaveCount(3);
    await expect(encounters.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Creature', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Skip to result' }).click();
    const expedition = page.getByRole('region', { name: 'Result' });
    for (const text of ['+100 XP', '+20 money', 'Light boots']) await expect(expedition).toContainText(text);
    // Choosing another encounter loads its own log.
    await encounters.nth(0).click();
    await expect(encounters.nth(0)).toHaveAttribute('aria-pressed', 'true');
    expect((await replayState(page)).battleId).toBe(REPLAY_FIXTURES.expedition.battleIds[0]);

    await openReplay(page, REPLAY_FIXTURES.tie.activityId);
    await page.getByRole('button', { name: 'Skip to result' }).click();
    await expect(page.getByRole('region', { name: 'Result' })).toContainText(/tie-break/i);
    await expect(page.getByRole('region', { name: 'Result' })).toContainText('Rewards are credited when the activity settles');
  });

  test('shows the saved outcome and credited rewards once the replay has expired', async ({ page }, testInfo) => {
    await page.goto(url(REPLAY_FIXTURES.expired.activityId));
    const saved = page.getByRole('region', { name: 'Saved outcome' });
    await expect(saved).toContainText('The animation for this fight is no longer kept');
    await expect(saved).toContainText('Defeat');
    await expect(saved).toContainText('+2 renown');
    await expect(saved).toContainText('Rating -9');
    await expect(page.getByRole('button', { name: 'Skip to result' })).toHaveCount(0);
    expect(await page.locator('canvas').count()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('replay-expired.png'), fullPage: true });
  });

  test('explains an unknown activity and the live build without fabricating a replay', async ({ page, context }) => {
    // Since Task 13.2 the live page reads a visitor's public timeline: the test transport answers it (the server knows no
    // such activity), never the local Supabase stack.
    const live = await routeLiveReads(context, { world: emptyWorld() });
    await page.goto(url('9fce3cd5-e831-4a66-8ca1-16b4576b1499'));
    await expect(page.getByText(/replay is not available/i)).toBeVisible();
    await page.goto(`/replay/?activity=${REPLAY_FIXTURES.pvp.activityId}`);
    await expect(page.getByText(/replay is not available/i)).toBeVisible();
    expect(await page.locator('canvas').count()).toBe(0);
    await expect(page.getByRole('link', { name: 'Back to camp' })).toHaveAttribute('href', '/game/');
    expect(live.requests.length).toBeGreaterThan(0);
    // The timeline, and since Task 13.8 the shared sync controller's revision and world (the page's display clock).
    expect(live.requests.every(r => r.reader === null && ['world_revision', 'world_actor_reads', 'visible_events', 'recent_results'].includes(r.table))).toBe(true);
  });

  test('plays at normal speed to the logged result in real time', async ({ page }) => {
    const log = LOGS['expedition-2'];
    await openReplay(page, REPLAY_FIXTURES.expedition.activityId, 'woodland-encounter-2');
    const started = Date.now();
    await page.waitForFunction(() => window.__cloudiatorReplay!.state().finished && !window.__cloudiatorReplay!.state().playing, null, { timeout: 30_000 });
    const elapsed = Date.now() - started;
    const state = await replayState(page);
    expect(state).toMatchObject({ speed: 'normal', hp: [...log.finalHp], winnerId: log.winnerId, positionMs: state.endMs });
    // One playback loop: the log plus its outro takes about its own length, never half of it.
    expect(elapsed).toBeGreaterThan(state.endMs * 0.8);
    await expect(hpMeter(page, 'Aster')).toHaveAttribute('aria-valuenow', `${log.finalHp[0]}`);
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  });

  test('fast playback, pause, restart and skip each reach the logged result', async ({ page }) => {
    const log = LOGS.pvp;
    await openReplay(page, REPLAY_FIXTURES.pvp.activityId);
    const fast = page.getByRole('button', { name: 'Fast ×4' });
    await expect(fast).toHaveAttribute('aria-pressed', 'false');
    await fast.click();
    await expect(fast).toHaveAttribute('aria-pressed', 'true');
    const started = Date.now();
    await page.waitForFunction(() => !window.__cloudiatorReplay!.state().playing, null, { timeout: 20_000 });
    expect(Date.now() - started).toBeLessThan(((log.durationMs + 2000) / 4) * 1.8 + 1500);
    expect(await replayState(page)).toMatchObject({ speed: 'fast', finished: true, hp: [...log.finalHp], winnerId: log.winnerId });

    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(hpMeter(page, 'Varro')).toHaveAttribute('aria-valuenow', `${log.participants[1].initialHealth}`);
    expect((await replayState(page)).playing).toBe(true);
    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = (await replayState(page)).positionMs;
    await page.waitForTimeout(600);
    expect((await replayState(page)).positionMs).toBe(paused);
    expect((await replayState(page)).playing).toBe(false);
    await page.getByRole('button', { name: 'Play' }).click();
    await page.waitForFunction(p => window.__cloudiatorReplay!.state().positionMs > p, paused);
    await page.waitForFunction(() => !window.__cloudiatorReplay!.state().playing, null, { timeout: 20_000 });
    expect(await replayState(page)).toMatchObject({ finished: true, hp: [...log.finalHp], winnerId: log.winnerId });

    await page.getByRole('button', { name: 'Restart' }).click();
    await page.getByRole('button', { name: 'Skip to result' }).click();
    expect(await replayState(page)).toMatchObject({ playing: false, finished: true, hp: [...log.finalHp], winnerId: log.winnerId });
  });

  test('drives the controls from the keyboard', async ({ page }) => {
    const log = LOGS.npc;
    await openReplay(page, REPLAY_FIXTURES.npc.activityId);
    await page.getByRole('button', { name: 'Restart' }).focus();
    await page.keyboard.press('k');
    expect((await replayState(page)).playing).toBe(false);
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: 'Fast ×4' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('End');
    expect(await replayState(page)).toMatchObject({ finished: true, hp: [...log.finalHp] });
    await page.keyboard.press('r');
    expect(await replayState(page)).toMatchObject({ playing: true, finished: false });
    // Buttons work with Enter and Space as usual.
    await page.getByRole('button', { name: 'Skip to result' }).focus();
    await page.keyboard.press('Enter');
    expect((await replayState(page)).finished).toBe(true);
  });

  test('highlights the current group of equal-time events in the combat log', async ({ page }) => {
    const log = LOGS.npc;
    await openReplay(page, REPLAY_FIXTURES.npc.activityId);
    await page.evaluate(() => window.__cloudiatorReplay!.pause());
    const shared = attacks(log).find((e, i, all) => all.some(o => o !== e && o.elapsedMs === e.elapsedMs))!;
    await page.evaluate(ms => window.__cloudiatorReplay!.seek(ms), shared.elapsedMs);
    const list = page.getByRole('list', { name: 'Combat log' });
    const applied = log.events.filter(e => e.elapsedMs <= shared.elapsedMs).length;
    await expect(list.getByRole('listitem')).toHaveCount(applied);
    const current = list.locator('li[aria-current="true"]');
    await expect(current).toHaveCount(log.events.filter(e => e.elapsedMs === shared.elapsedMs).length);
    for (const text of await current.allTextContents()) expect(text).toContain(`${(shared.elapsedMs / 1000).toFixed(2)} s`);
  });

  test('pauses while the tab is hidden and resumes when it returns', async ({ page }) => {
    await openReplay(page, REPLAY_FIXTURES.pvp.activityId);
    await page.waitForFunction(() => window.__cloudiatorReplay!.state().positionMs > 200);
    const setHidden = (hidden: boolean) => page.evaluate(h => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await setHidden(true);
    const at = (await replayState(page)).positionMs;
    await page.waitForTimeout(700);
    expect(await replayState(page)).toMatchObject({ positionMs: at, playing: false, autoPaused: true });
    await setHidden(false);
    await page.waitForFunction(p => window.__cloudiatorReplay!.state().positionMs > p + 150, at);
    expect(await replayState(page)).toMatchObject({ playing: true, autoPaused: false });
  });

  test('keeps critical hits readable without shake or flashes when reduced motion is requested', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const log = LOGS.pvp;
    await openReplay(page, REPLAY_FIXTURES.pvp.activityId);
    await sceneReady(page);
    await page.evaluate(() => window.__cloudiatorReplay!.pause());
    const crit = attacks(log).find(e => e.critical)!;
    const d = await expectStagedCorrectly(page, log, crit.elapsedMs + 30);
    expect(d.reducedMotion).toBe(true);
    expect(d.shake).toEqual({ x: 0, y: 0 });
    expect(d.flash).toBe(0);
    expect(d.labels.map(l => l.text)).toContain(`-${crit.damage} CRIT`);
    expect((await replayState(page)).reducedMotion).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('replay-reduced-motion-critical.png') });
  });

  test('never duplicates playback or leaks listeners across navigation, remounts and reloads', async ({ page }) => {
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
    const counts = async () => ({
      ...(await page.evaluate(() => ({ listeners: window.__cloudiatorReplay!.listeners(), loops: window.__cloudiatorReplay!.loops(), canvases: document.querySelectorAll('canvas').length,
        visibility: (window as unknown as { __visibilityListeners: number }).__visibilityListeners }))),
    });
    const rate = async () => {
      const a = (await replayState(page)).positionMs;
      const t = Date.now();
      await page.waitForTimeout(1000);
      return ((await replayState(page)).positionMs - a) / (Date.now() - t);
    };
    await openReplay(page, REPLAY_FIXTURES.pvp.activityId);
    await sceneReady(page);
    const base = await counts();
    expect(base).toMatchObject({ loops: 1, canvases: 1 });
    await page.getByRole('link', { name: 'Back to camp' }).click();
    await page.waitForURL(/\/game\//);
    // The sample replays are listed in the camp's Results menu (Task 13.5) and open as scenes over the camp (Task 13.8
    // fix round 1): one playback loop and one scene canvas beside the camp's own.
    await openMenu(page, 'Results');
    await page.getByRole('link', { name: REPLAY_FIXTURES.npc.label }).click();
    await page.waitForFunction(id => window.__cloudiatorReplay?.state().battleId === id, REPLAY_FIXTURES.npc.battleId, { timeout: 45_000 });
    await sceneReady(page);
    expect(await page.evaluate(() => ({ listeners: window.__cloudiatorReplay!.listeners(), loops: window.__cloudiatorReplay!.loops(),
      canvases: document.querySelectorAll('dialog canvas').length }))).toEqual({ listeners: base.listeners, loops: 1, canvases: 1 });
    // Back closes the scene, and Back again returns to the replay page.
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Replay', exact: true })).toHaveCount(0);
    await page.goBack();
    await page.waitForFunction(id => window.__cloudiatorReplay?.state().battleId === id, REPLAY_FIXTURES.pvp.battleId, { timeout: 45_000 });
    await sceneReady(page);
    expect(await counts()).toEqual(base);
    await page.reload();
    await page.waitForFunction(() => !!window.__cloudiatorReplay?.state(), null, { timeout: 45_000 });
    await sceneReady(page);
    expect(await counts()).toEqual(base);
    const speed = await rate();
    expect(speed).toBeGreaterThan(0.7);
    expect(speed).toBeLessThan(1.4);
  });

  test('keeps the result and the combat log usable without WebGL', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        return /webgl/.test(type) ? null : (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
      } as typeof original;
    });
    const log = LOGS.pvp;
    await openReplay(page, REPLAY_FIXTURES.pvp.activityId);
    await expect(page.getByText(/needs WebGL/)).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('canvas').count()).toBe(0);
    await page.getByRole('button', { name: 'Skip to result' }).click();
    await expect(hpMeter(page, 'Varro')).toHaveAttribute('aria-valuenow', `${log.finalHp[1]}`);
    await expect(page.getByRole('region', { name: 'Result' })).toContainText('Aster wins');
    await expect(page.getByRole('list', { name: 'Combat log' }).getByRole('listitem')).toHaveCount(log.events.length);
  });

  test('keeps the result and the combat log usable when the replay art cannot load', async ({ page }) => {
    await page.route('**/assets/**/*.png', route => route.abort());
    const log = LOGS.npc;
    await openReplay(page, REPLAY_FIXTURES.npc.activityId);
    await expect(page.getByText(/art could not load/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Skip to result' }).click();
    await expect(page.getByRole('list', { name: 'Combat log' }).getByRole('listitem')).toHaveCount(log.events.length);
  });

  test('stays readable and inside a 360px-wide screen', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const log = LOGS.pvp;
    await openReplay(page, REPLAY_FIXTURES.pvp.activityId);
    await sceneReady(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const canvas = (await page.locator('canvas').boundingBox())!;
    expect(canvas.x).toBeGreaterThanOrEqual(0);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(360);
    for (const name of ['Pause', 'Fast ×4', 'Restart', 'Skip to result']) {
      const box = (await page.getByRole('button', { name }).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(40);
      expect(box.x >= 0 && box.x + box.width <= 360, name).toBe(true);
    }
    for (const p of log.participants) await expect(hpMeter(page, p.name)).toBeVisible();
    await page.evaluate(() => window.__cloudiatorReplay!.pause());
    const hit = attacks(log).find(e => e.hit && !e.critical && e.attackerId === log.participants[1].id)!;
    await expectStagedCorrectly(page, log, hit.elapsedMs + 40);
    await page.screenshot({ path: testInfo.outputPath('replay-360-hit.png') });
    await expectStagedCorrectly(page, log, log.durationMs + 2000);
    await page.screenshot({ path: testInfo.outputPath('replay-360-result.png'), fullPage: true });
  });

  test('stages both fighters facing each other inside the frame, with effects on the defender, for every action', async ({ page }, testInfo) => {
    for (const c of [CASES[0], CASES[2]]) {
      const log = LOGS[c.log];
      await openReplay(page, c.activity, c.stage);
      await sceneReady(page);
      await page.evaluate(() => window.__cloudiatorReplay!.pause());
      const times = [...new Set(log.events.map(e => e.elapsedMs))];
      for (const t of times) for (const offset of [-120, 20, 200]) if (t + offset >= 0) await expectStagedCorrectly(page, log, t + offset);
      for (const extra of [400, 900, 2000]) await expectStagedCorrectly(page, log, log.durationMs + extra);
      const crit = attacks(log).find(e => e.critical);
      if (crit) {
        await expectStagedCorrectly(page, log, crit.elapsedMs + 40);
        await page.screenshot({ path: testInfo.outputPath(`replay-${c.name}-critical.png`) });
      }
      const evade = attacks(log).find(e => e.evade);
      if (evade) {
        await expectStagedCorrectly(page, log, evade.elapsedMs + 60);
        await page.screenshot({ path: testInfo.outputPath(`replay-${c.name}-evade.png`) });
      }
      await expectStagedCorrectly(page, log, 0);
      await page.screenshot({ path: testInfo.outputPath(`replay-${c.name}-start.png`) });
      await expectStagedCorrectly(page, log, log.durationMs + 2000);
      await page.screenshot({ path: testInfo.outputPath(`replay-${c.name}-result.png`), fullPage: true });
    }
  });
});
