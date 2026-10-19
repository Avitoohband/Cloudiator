import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BattleLog, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { PublicActor, TournamentView } from '../../supabase/functions/_shared/contracts/reads';
import { frameStats, type FrameStats } from '../../src/lib/frame-stats';
import { createDemoWorld } from '../../src/game/demo-world';
import { worldFixture } from '../fixtures/domain';
import { ARENA_BOUTS, type ArenaBoutKey } from '../fixtures/arena-ids';
import { buildArenaFixtures } from '../fixtures/arena-build';
import { EXPEDITION_FIXTURES } from '../fixtures/expedition-ids';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { TOURNAMENTS } from '../fixtures/tournament-ids';
import { tournamentCampActors } from '../fixtures/tournament-build';

// Task 23.4: the FPS harness (plan Decision 9; run it with tests/performance/playwright.perf.config.ts, never in the gates).
// A requestAnimationFrame sampler, injected before the page loads, records every frame's timestamp; each phase of a
// repeatable path is measured with the `?perf=1` overlay's own definitions (src/lib/frame-stats.ts): the mean and
// 5th-percentile frame rates and the share of frames over 16.7 ms and 33.3 ms. The path: the fixture camp with
// createDemoWorld(now, 50, 6)'s crowd (50 gladiators in camp, 6 away) around the camp's ambient NPCs, the current slot's
// Arena pairs fighting in the six rings at minute 60 and a tournament's final with its spectators (moved into that slot);
// a pan, the maximum zoom over the arena, then 20 open/close cycles of the replay and expedition scenes. The run records
// the WebGL renderer. The Pixel 7 project throttles the CPU 4x through CDP and is indicative only.

const MIN = 60_000;
const SLOT_MS = 4_800_000;
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
/** The fixture world's slot (its server time is minute 40 of it): the clock runs on from minute 60, never jumped back. */
const S = worldFixture.serverNowMs - (worldFixture.serverNowMs % SLOT_MS);
const AT = S + 60 * MIN + 5_000;
const CYCLES = 20;
const PHASE_MS = 6_000;

/** The `completed` tournament moved into slot S: at minute 60 its final is fighting and the eliminated watch. */
function tournamentInSlot(): { view: TournamentView; actors: PublicActor[] } {
  const from = TOURNAMENTS.completed.startsAtMs;
  const raw = readFileSync('tests/fixtures/tournaments/completed.json', 'utf8').replaceAll(`tournament:${from / SLOT_MS}:`, `tournament:${S / SLOT_MS}:`);
  const view = JSON.parse(raw) as TournamentView;
  const moved: TournamentView = { ...view, slotIndex: S / SLOT_MS, startsAtMs: S, endsAtMs: S + SLOT_MS, placements: [] };
  const actors = tournamentCampActors('completed').map(a => ({ ...a, startsAtMs: S, endsAtMs: S + SLOT_MS }));
  return { view: moved, actors };
}

type Phase = { name: string; stats: FrameStats; seconds: number };
const frameCount = (page: Page) => page.evaluate(() => (window as unknown as { __fpsFrames: number[] }).__fpsFrames.length);
async function measure(page: Page, name: string, during: () => Promise<void>): Promise<Phase> {
  const start = await frameCount(page);
  const began = Date.now();
  await during();
  const end = await frameCount(page);
  const times = await page.evaluate(([a, b]) => (window as unknown as { __fpsFrames: number[] }).__fpsFrames.slice(a, b), [start, end]);
  const intervals = times.slice(1).map((t, i) => t - times[i]);
  return { name, stats: frameStats(intervals), seconds: (Date.now() - began) / 1000 };
}
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('measures the camp, the arena at maximum zoom and 20 scene cycles', async ({ page }, testInfo) => {
  const throttled = testInfo.project.name.startsWith('pixel-7');
  await page.addInitScript(() => {
    const frames: number[] = [];
    (window as unknown as { __fpsFrames: number[] }).__fpsFrames = frames;
    const loop = (t: number) => { frames.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  if (throttled) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 120_000 });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no WebGL';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  });

  // The crowd: the current slot's Arena entrants, the tournament's entrants and createDemoWorld's crowd, 50 in camp, 6 away.
  const logs = Object.fromEntries((Object.keys(ARENA_BOUTS) as ArenaBoutKey[]).map(key => [key, readJson<BattleLog>(`tests/fixtures/arena/${key}.json`)])) as Record<ArenaBoutKey, BattleLog>;
  const arena = buildArenaFixtures(logs);
  const tournament = tournamentInSlot();
  const demo = createDemoWorld(AT, 50, 6);
  const entrants = [...arena.worldActors, ...tournament.actors];
  const inCamp = demo.actors.filter(a => !a.location.startsWith('expedition:') && a.location !== 'arena').slice(0, 50 - entrants.length);
  const away = demo.actors.filter(a => a.location.startsWith('expedition:'));
  const actors = [...entrants, ...inCamp, ...away];
  await page.evaluate(({ actors, timelines, view, at }) => {
    const hook = window.__cloudiatorCamp!;
    hook.freezeClock(at);
    hook.setWorld({ ...hook.world()!, actors });
    hook.setArenaTimelines(timelines);
    hook.setTournaments([view]);
    hook.freezeClock(null);
  }, { actors, timelines: arena.timelines as Record<string, RevealedTimeline>, view: tournament.view, at: AT });
  await nextFrames(page);
  await page.waitForTimeout(1_000);
  const setup = await page.evaluate(() => {
    const state = window.__cloudiatorCamp!.state()!;
    const world = window.__cloudiatorCamp!.world()!;
    return { inCamp: world.actors.filter(a => !a.location.startsWith('expedition:')).length, players: state.players, ambientNpcs: state.ambientNpcs, away: state.away, fights: state.arena.fights.length,
      inRings: state.arena.fights.filter(f => f.status !== 'queued' && f.status !== 'done').length, spectators: state.tournament.spectators.length };
  });
  expect(setup.inCamp).toBe(50);
  expect(setup.inRings).toBeGreaterThanOrEqual(6);

  const phases: Phase[] = [];
  phases.push(await measure(page, 'camp overview (default zoom)', () => page.waitForTimeout(PHASE_MS)));
  // A pan: small camera steps every frame for the phase, back and forth.
  phases.push(await measure(page, 'pan', () => page.evaluate(ms => new Promise<void>(resolve => {
    const end = performance.now() + ms;
    const step = (t: number) => {
      const dx = Math.sin(t / 700) * 12, dy = Math.cos(t / 900) * 6;
      window.__cloudiatorCamp!.emit('camera-pan', { dx, dy });
      if (t < end) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  }), PHASE_MS)));
  // The maximum zoom, over the arena rings and the spectators around its wall.
  let zoom = -1;
  for (let i = 0; i < 20; i += 1) {
    await page.evaluate(() => window.__cloudiatorCamp!.emit('camera-zoom', { direction: 'in' }));
    await nextFrames(page);
    const next = await page.evaluate(() => window.__cloudiatorCamp!.state()!.camera.zoom);
    if (next === zoom) break;
    zoom = next;
  }
  await page.evaluate(z => window.__cloudiatorCamp!.centerOn(23, 22.5, z), zoom);
  await nextFrames(page);
  phases.push(await measure(page, `arena at maximum zoom (${zoom.toFixed(2)}x), fights and spectators`, () => page.waitForTimeout(PHASE_MS)));
  await page.evaluate(() => window.__cloudiatorCamp!.emit('camera-zoom', { direction: 'reset' }));

  // 20 open/close cycles of the replay and the expedition scene over the camp.
  const dialog = (name: string) => page.getByRole('dialog', { name, exact: true });
  phases.push(await measure(page, `${CYCLES} replay and expedition scene cycles`, async () => {
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      await page.evaluate(id => window.__cloudiatorCamp!.emit('view-replay', { activityId: id }), REPLAY_FIXTURES.pvp.activityId);
      await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 60_000 });
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'Back to camp' }).click();
      await expect(dialog('Replay')).toHaveCount(0);
      await page.evaluate(id => window.__cloudiatorCamp!.emit('view-expedition', { activityId: id }), EXPEDITION_FIXTURES.woodland.activityId);
      await page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 60_000 });
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'Back to camp' }).click();
      await expect(dialog('Expedition')).toHaveCount(0);
    }
  }));
  // After the cycles: the same camp, one canvas, still ready.
  expect(await page.evaluate(() => ({ ready: window.__cloudiatorCamp!.state()!.ready, canvases: window.__cloudiatorCamp!.canvases() }))).toEqual({ ready: true, canvases: 1 });
  phases.push(await measure(page, 'camp after the cycles', () => page.waitForTimeout(PHASE_MS)));

  const all = { ...setup, project: testInfo.project.name, throttled, renderer, viewport: page.viewportSize(), phases };
  const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
  const lines = phases.map(p => `${p.name}: mean ${p.stats.meanFps.toFixed(1)} fps, p5 ${p.stats.p5Fps.toFixed(1)} fps, >16.7 ms ${pct(p.stats.over16)}, >33.3 ms ${pct(p.stats.over33)} (${p.stats.frames} frames, ${p.seconds.toFixed(1)} s)`);
  console.log([`FPS ${testInfo.project.name}${throttled ? ' (4x CPU throttle, indicative)' : ''}`, `renderer: ${renderer}`,
    `camp: ${setup.inCamp} in camp (${setup.players} drawn as players), ${setup.away} away, ${setup.ambientNpcs} ambient NPCs, ${setup.fights} ring fights (${setup.inRings} in rings), ${setup.spectators} spectators`, ...lines].join('\n'));
  await testInfo.attach('fps.json', { body: JSON.stringify(all, null, 2), contentType: 'application/json' });
  if (process.env.PERF_RESULTS) {
    const file = process.env.PERF_RESULTS.replace(/\.json$/, `-${testInfo.project.name}.json`);
    writeFileSync(file, JSON.stringify(all, null, 2));
  }
  // The desktop target (spec: 60 fps desktop) on the camp phases; the throttled phone emulation only reports.
  if (!throttled) {
    for (const p of phases.filter(phase => !phase.name.includes('cycles'))) expect.soft(p.stats.meanFps, `${p.name}: mean fps`).toBeGreaterThanOrEqual(59);
  }
});
