// Patch 1.5.1 (camp-expansion proposal, Patch 1, Avi's answers 2026-10-30): five guards and four new camp NPCs on today's
// 46 x 46 map. Every new round walks on free tiles only, keeps clear of the gladiators' spots, the Arena floor and the
// whole-trip replay's gate road, and loops; today's NPCs, players and spectator spots stay exactly where they were; the two
// wall patrols are the night watch in the evening, with a torch.
import { describe, expect, it } from 'vitest';
import type { TilePoint } from '@/game/assets';
import { loadAssetManifest } from '@/game/assets';
import { layoutCamp } from '@/game/actors';
import { createDemoWorld, withDemoCrowd } from '@/game/demo-world';
import { SLOT_MS } from '@/game/lighting';
import {
  NPC_ROUTINES, npcCarriesTorch, npcLookAt, npcPostTiles, planNpcPosition, routePaths, routineSlack, type NpcRoutine,
} from '@/game/npcs';
import { spectatorSpots } from '@/game/tournament-camp';
import { vignettePose } from '@/game/trip-vignette';
import { worldFixture } from '../fixtures/domain';

const manifest = loadAssetManifest();
const camp = manifest.maps.find(m => m.id === 'camp')!;
const key = (p: TilePoint) => `${p.x},${p.y}`;
const routine = (id: string) => NPC_ROUTINES.find(r => r.npcId === id)!;

const TODAY = ['smith', 'armorer', 'cook', 'healer', 'trainer', 'guard'];
const NEW: Record<string, { look: string; posts: [number, number][]; periodMs: number }> = {
  'guard-south': { look: 'guard', posts: [[40, 24], [38, 26]], periodMs: 70_000 },
  lookout: { look: 'guard', posts: [[40, 17], [41, 14]], periodMs: 80_000 },
  'patrol-north': { look: 'guard', posts: [[40, 11], [40, 5], [5, 5], [5, 11]], periodMs: 130_000 },
  'patrol-south': { look: 'guard', posts: [[39, 27], [40, 40], [6, 41], [5, 27]], periodMs: 160_000 },
  'water-carrier': { look: 'water-carrier', posts: [[28, 31], [13, 18], [37, 25]], periodMs: 120_000 },
  herald: { look: 'herald', posts: [[29, 27], [37, 21], [23, 32]], periodMs: 100_000 },
  porter: { look: 'porter', posts: [[35, 25], [21, 6], [27, 40]], periodMs: 140_000 },
  forester: { look: 'forester', posts: [[9, 8], [36, 9], [33, 34], [9, 33]], periodMs: 190_000 },
};
const newRoutines = () => Object.keys(NEW).map(routine);
/** Today's six rounds, as they were before patch 1.5.1 (src/game/npcs.ts at 424334e): nothing of them may change. */
const TODAY_ROUNDS = [
  { npcId: 'smith', periodMs: 60_000, meetsWith: 'armorer', steps: [
    { x: 18, y: 7, at: 0, durationMs: 30_000, action: 'tend', facing: 'sw' }, { x: 20, y: 8, at: 36_000, durationMs: 12_000, action: 'talk', facing: 'se' }] },
  { npcId: 'armorer', periodMs: 60_000, meetsWith: 'smith', steps: [
    { x: 24, y: 7, at: 0, durationMs: 28_000, action: 'tend', facing: 'sw' }, { x: 21, y: 7, at: 36_000, durationMs: 12_000, action: 'talk', facing: 'sw' }] },
  { npcId: 'cook', periodMs: 90_000, meetsWith: 'healer', steps: [
    { x: 24, y: 33, at: 0, durationMs: 30_000, action: 'tend', facing: 'se' }, { x: 26, y: 33, at: 40_000, durationMs: 13_000, action: 'talk', facing: 'se' },
    { x: 23, y: 38, at: 62_000, durationMs: 18_000, action: 'tend', facing: 'se' }] },
  { npcId: 'healer', periodMs: 90_000, meetsWith: 'cook', steps: [
    { x: 27, y: 32, at: 40_000, durationMs: 13_000, action: 'talk', facing: 'sw' }, { x: 16, y: 27, at: 68_000, durationMs: 2_000, action: 'idle', facing: 'se' },
    { x: 12, y: 22, at: 78_000, durationMs: 10_000, action: 'talk', facing: 'se' }] },
  { npcId: 'trainer', periodMs: 90_000, meetsWith: 'healer', steps: [
    { x: 7, y: 18, at: 8_000, durationMs: 8_000, action: 'talk', facing: 'se' }, { x: 10, y: 21, at: 22_000, durationMs: 6_000, action: 'idle', facing: 'sw' },
    { x: 13, y: 16, at: 40_000, durationMs: 12_000, action: 'talk', facing: 'sw' }, { x: 13, y: 21, at: 78_000, durationMs: 10_000, action: 'talk', facing: 'sw' }] },
  { npcId: 'guard', periodMs: 90_000, steps: [
    { x: 40, y: 20, at: 0, durationMs: 30_000, action: 'idle', facing: 'sw' }, { x: 36, y: 14, at: 40_000, durationMs: 10_000, action: 'idle', facing: 'se' },
    { x: 39, y: 24, at: 64_000, durationMs: 12_000, action: 'idle', facing: 'se' }] },
];
const todayPosts = () => npcPostTiles(NPC_ROUTINES.filter(r => TODAY.includes(r.npcId)));

/** Where the gladiators' activities happen: every station that is not an NPC's, the spectator spots, the beds and seats. */
function activitySpots(): Map<string, string> {
  const spots = new Map<string, string>();
  for (const z of camp.zones) for (const s of z.stations) if (!s.npc) spots.set(key(s), `${z.id} ${s.kind} station`);
  for (const s of spectatorSpots(camp, npcPostTiles())) spots.set(key(s), 'spectator spot');
  for (const p of camp.props) {
    if (!/^(bedroll|bench|log-seat)/.test(p.frame)) continue;
    for (let y = p.y; y < p.y + p.d; y += 1) for (let x = p.x; x < p.x + p.w; x += 1) spots.set(`${x},${y}`, p.frame);
  }
  return spots;
}
/** The road the whole-trip replay walks through the gate ("Leaving camp" and "Back in camp"), sampled from the replay itself. */
function replayGateRoad(): Set<string> {
  const tiles = new Set<string>();
  for (const kind of ['leaving', 'back'] as const) {
    for (let t = 0; t <= 60_000; t += 50) {
      const p = vignettePose(camp, { kind, elapsedMs: t, durationMs: 60_000 }, 'any', manifest.actors.gladiator.walk.tilesPerSecond);
      tiles.add(`${Math.floor(p.x)},${Math.floor(p.y)}`);
    }
  }
  return tiles;
}
const insideArenaWall = (x: number, y: number) =>
  Math.hypot(x + 0.5 - camp.arena!.centre[0], y + 0.5 - camp.arena!.centre[1]) <= camp.arena!.radius + 0.5;

describe('patch 1.5.1 camp NPCs: who is there', () => {
  it('adds a second gate guard, a tower lookout, two wall patrols and four camp NPCs: 14 NPCs, 5 of them guards', () => {
    expect(NPC_ROUTINES.map(r => r.npcId)).toEqual([...TODAY, ...Object.keys(NEW)]);
    expect(NPC_ROUTINES.filter(r => (r.look ?? r.npcId) === 'guard')).toHaveLength(5);
    for (const [id, want] of Object.entries(NEW)) {
      const r = routine(id);
      expect(r.look, id).toBe(want.look);
      expect(r.name, id).toBeTruthy();
      expect(r.periodMs, id).toBe(want.periodMs);
      expect([...r.steps].sort((a, b) => a.at - b.at).map(s => [s.x, s.y]), id).toEqual(want.posts);
    }
    expect(new Set(NPC_ROUTINES.map(r => r.name ?? r.npcId)).size).toBe(14);
  });

  it('keeps every round of today exactly as it was', () => {
    expect(NPC_ROUTINES.filter(r => TODAY.includes(r.npcId))).toEqual(TODAY_ROUNDS);
  });

  it('wears an art that exists, and the patrols swap to the night watch', () => {
    const looks = new Set(manifest.actors.npcs.map(n => n.id));
    for (const r of NPC_ROUTINES) {
      expect(looks.has(r.look ?? r.npcId), r.npcId).toBe(true);
      if (r.evening) expect(looks.has(r.evening.look), r.npcId).toBe(true);
    }
    expect(NPC_ROUTINES.filter(r => r.evening).map(r => [r.npcId, r.evening!.look, r.evening!.torch])).toEqual([
      ['patrol-north', 'night-watch', true], ['patrol-south', 'night-watch', true],
    ]);
  });
});

describe('patch 1.5.1 camp NPCs: posts and rounds', () => {
  it('stands every new NPC on a free walkable tile: no station, spot, bed, seat, gate road, Arena floor or other post', () => {
    const spots = activitySpots();
    const road = replayGateRoad();
    const others = todayPosts();
    const seen = new Set<string>();
    for (const r of newRoutines()) {
      for (const s of r.steps) {
        const at = `${r.npcId} at ${key(s)}`;
        expect(camp.walkable[s.y][s.x], at).toBe('1');
        expect(spots.get(key(s)) ?? null, at).toBeNull();
        expect(road.has(key(s)), at).toBe(false);
        expect(insideArenaWall(s.x, s.y), at).toBe(false);
        expect(others.has(key(s)), at).toBe(false);
        expect(seen.has(key(s)), at).toBe(false);
        seen.add(key(s));
      }
    }
  });

  it('walks every new round on walkable tiles, clear of the gladiators\' spots, the Arena floor, the gate road and the other posts', () => {
    const spots = activitySpots();
    const road = replayGateRoad();
    expect([...road].sort()).toEqual(['37,22', '38,22', '39,22', '40,22', '41,22']);
    for (const r of newRoutines()) {
      const own = new Set(r.steps.map(key));
      const others = npcPostTiles(NPC_ROUTINES.filter(o => o !== r));
      for (const [i, path] of routePaths(r, camp).entries()) {
        for (const p of path) {
          const at = `${r.npcId} leg ${i} at ${key(p)}`;
          expect(camp.walkable[p.y][p.x], at).toBe('1');
          expect(spots.get(key(p)) ?? null, at).toBeNull();
          expect(road.has(key(p)), at).toBe(false);
          expect(insideArenaWall(p.x, p.y), at).toBe(false);
          if (!own.has(key(p))) expect(others.has(key(p)), at).toBe(false);
        }
      }
    }
  });

  it('loops: each leg starts where the last one ended, the last returns to the first post, and the round repeats', () => {
    for (const r of newRoutines()) {
      const posts = [...r.steps].sort((a, b) => a.at - b.at);
      const paths = routePaths(r, camp);
      expect(paths, r.npcId).toHaveLength(posts.length);
      paths.forEach((path, i) => {
        expect(key(path[0]), `${r.npcId} leg ${i}`).toBe(key(posts[i]));
        expect(key(path[path.length - 1]), `${r.npcId} leg ${i}`).toBe(key(posts[(i + 1) % posts.length]));
      });
      for (const slack of routineSlack(r, camp)) expect(slack, r.npcId).toBeGreaterThanOrEqual(1_000);
      for (let t = 0; t < r.periodMs; t += 1_337) expect(planNpcPosition(r, camp, t + r.periodMs), `${r.npcId} at ${t}`).toEqual(planNpcPosition(r, camp, t));
    }
  });

  it('leaves today\'s camp in place: the same spectator spots, and every gladiator on the same spot', () => {
    expect(spectatorSpots(camp, npcPostTiles())).toEqual(spectatorSpots(camp, todayPosts()));
    const worlds = [withDemoCrowd(worldFixture), createDemoWorld(1_791_592_800_000, 50, 6), createDemoWorld(1_791_597_600_000, 50, 6)];
    for (const world of worlds) {
      const before = layoutCamp(world.actors, camp, world.slotIndex, { reserved: todayPosts() }).placements;
      const after = layoutCamp(world.actors, camp, world.slotIndex, { reserved: npcPostTiles() }).placements;
      expect([...after].map(([id, p]) => [id, p.x, p.y, p.action, p.facing])).toEqual([...before].map(([id, p]) => [id, p.x, p.y, p.action, p.facing]));
    }
  });
});

describe('patch 1.5.1 night watch', () => {
  // A morning slot (index a multiple of 3), then its afternoon and evening (src/game/lighting.ts phaseOfSlot).
  const base = 373_248 * SLOT_MS;
  const at = (phase: number, ms: number) => base + phase * SLOT_MS + ms;
  const patrols = () => NPC_ROUTINES.filter(r => r.npcId.startsWith('patrol-'));

  it('dresses the wall patrols as the night watch, with a torch, only in the evening', () => {
    expect(patrols()).toHaveLength(2);
    for (const r of patrols()) {
      for (const phase of [0, 1]) for (const ms of [0, 1_200_000, SLOT_MS - 1]) {
        expect(npcLookAt(r, at(phase, ms)), `${r.npcId} phase ${phase}`).toBe('guard');
        expect(npcCarriesTorch(r, at(phase, ms)), `${r.npcId} phase ${phase}`).toBe(false);
      }
      for (const ms of [0, 1_200_000, SLOT_MS - 1]) {
        expect(npcLookAt(r, at(2, ms)), r.npcId).toBe('night-watch');
        expect(npcCarriesTorch(r, at(2, ms)), r.npcId).toBe(true);
      }
      expect(npcLookAt(r, at(3, 0)), r.npcId).toBe('guard');
      expect(npcCarriesTorch(r, at(3, 0)), r.npcId).toBe(false);
    }
  });

  it('keeps every other NPC in its own look, without a torch, at any time', () => {
    for (const r of NPC_ROUTINES.filter(o => !o.npcId.startsWith('patrol-'))) {
      for (const phase of [0, 1, 2]) {
        expect(npcLookAt(r, at(phase, 1_200_000)), r.npcId).toBe((r as NpcRoutine).look ?? r.npcId);
        expect(npcCarriesTorch(r, at(phase, 1_200_000)), r.npcId).toBe(false);
      }
    }
  });
});
