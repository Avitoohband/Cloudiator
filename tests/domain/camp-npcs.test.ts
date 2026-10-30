// Patch 1.5.1 (camp-expansion proposal, Patch 1, Avi's answers 2026-10-30): five guards and four new camp NPCs on today's
// 46 x 46 map. Every new round walks on free tiles only, keeps clear of the gladiators' spots, the Arena floor and the
// whole-trip replay's gate road, and loops; today's NPCs, players and spectator spots stay exactly where they were; the two
// wall patrols are the night watch in the evening, with a torch.
import { describe, expect, it } from 'vitest';
import type { PublicActor } from '@contracts/reads';
import type { TilePoint } from '@/game/assets';
import { loadAssetManifest } from '@/game/assets';
import { layoutCamp } from '@/game/actors';
import { createDemoWorld, withDemoCrowd } from '@/game/demo-world';
import { SLOT_MS, lightingAt } from '@/game/lighting';
import { worldToScreen } from '@/game/iso';
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
  'guard-south': { look: 'guard', posts: [[41, 25], [38, 26]], periodMs: 70_000 },
  lookout: { look: 'guard', posts: [[40, 17], [41, 14]], periodMs: 80_000 },
  'patrol-north': { look: 'guard', posts: [[40, 11], [40, 5], [5, 5], [5, 11]], periodMs: 130_000 },
  'patrol-south': { look: 'guard', posts: [[39, 27], [40, 40], [6, 41], [5, 27]], periodMs: 160_000 },
  // Review fixes 4 and 6: Petra's well post (28, 31) stood on Sister Iona's nameplate row, her training post (13, 18) on the
  // trainer's way and her gate post (37, 25) under the Gate Guard's plate at (39, 24); the porter's stall post (21, 6) stacked
  // his nameplate on the armorer's.
  'water-carrier': { look: 'water-carrier', posts: [[27, 30], [14, 22], [36, 26]], periodMs: 120_000 },
  herald: { look: 'herald', posts: [[29, 27], [37, 21], [23, 32]], periodMs: 100_000 },
  porter: { look: 'porter', posts: [[35, 25], [20, 5], [27, 40]], periodMs: 140_000 },
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

type Box = { x0: number; x1: number; y0: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
/** Screen feet of an actor standing on tile (x, y): the tile centre (src/game/iso.ts). */
const feetOf = (x: number, y: number) => worldToScreen(x + 0.5, y + 0.5);
/**
 * An NPC's nameplate at zoom 2 and over (world px): `NAMEPLATE.perChar` px a character plus `pad`, 14 px tall, its bottom 46 px
 * over the feet. tests/browser/camp.spec.ts checks every NPC's drawn plate fits inside this box.
 */
const NAMEPLATE = { perChar: 6, pad: 4, height: 14, lift: 46 };
const plateOf = (name: string, x: number, y: number): Box => {
  const f = feetOf(x, y);
  const half = (NAMEPLATE.perChar * name.length + NAMEPLATE.pad) / 2;
  return { x0: f.x - half, x1: f.x + half, y0: f.y - NAMEPLATE.lift - NAMEPLATE.height, y1: f.y - NAMEPLATE.lift };
};
/** An actor's body (the camp's click box: 13 px either side of the feet, 46 px up). */
const bodyOf = (x: number, y: number): Box => { const f = feetOf(x, y); return { x0: f.x - 13, x1: f.x + 13, y0: f.y - 46, y1: f.y }; };
/** A gladiator who has just arrived, on a gate or departure spot: its body, and its name with the NEW tag over it. */
const arrivalOf = (x: number, y: number): Box[] => { const f = feetOf(x, y); return [bodyOf(x, y), { x0: f.x - 30, x1: f.x + 30, y0: f.y - 72, y1: f.y - 46 }]; };
const nameOf = (r: NpcRoutine) => r.name ?? manifest.actors.npcs.find(n => n.id === (r.look ?? r.npcId))!.name;

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
    // Review fix 1: the south gate guard stands beside the torch, clear of the departure spots, and tends at 46 s (the mockup).
    expect(routine('guard-south').steps[1]).toEqual({ x: 38, y: 26, at: 46_000, durationMs: 10_000, action: 'tend', facing: 'se' });
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

  it('keeps every new post off today\'s routes: no NPC of today walks through a new NPC standing at its post', () => {
    const posts = new Map(newRoutines().flatMap(r => r.steps.map(s => [key(s), r.npcId] as const)));
    for (const r of NPC_ROUTINES.filter(o => TODAY.includes(o.npcId))) {
      for (const [i, path] of routePaths(r, camp).entries()) {
        for (const p of path) expect(posts.get(key(p)) ?? null, `${r.npcId} leg ${i} at ${key(p)}`).toBeNull();
      }
    }
  });

  // Review fix 4: two plates side by side, less than a plate's height apart, read as one block of text (the porter's at (21, 6)
  // stood 2 px over the armorer's at (21, 7)). A new post's plate keeps a whole plate row clear of every other NPC's posts.
  it('never stacks two nameplates: each new post\'s plate keeps a plate row clear of every other NPC\'s', () => {
    const row = (b: Box): Box => ({ ...b, y0: b.y0 - NAMEPLATE.height, y1: b.y1 + NAMEPLATE.height });
    for (const r of newRoutines()) {
      for (const s of r.steps) {
        for (const o of NPC_ROUTINES.filter(other => other !== r)) {
          for (const t of o.steps) {
            expect(overlaps(row(plateOf(nameOf(r), s.x, s.y)), plateOf(nameOf(o), t.x, t.y)), `${r.npcId} at ${key(s)} vs ${o.npcId} at ${key(t)}`).toBe(false);
          }
        }
      }
    }
  });

  it('keeps the arrival Find clear: no new NPC or nameplate covers a gladiator on the gate or a departure spot', () => {
    const arrivals = camp.zones.flatMap(z => z.stations).filter(s => s.kind === 'gate' || s.kind === 'depart');
    expect(arrivals.map(key).sort()).toEqual(['39,22', '39,23', '41,22']);
    for (const r of newRoutines()) {
      for (const s of r.steps) {
        for (const a of arrivals) {
          const [body, name] = arrivalOf(a.x, a.y);
          const plate = plateOf(nameOf(r), s.x, s.y);
          const at = `${r.npcId} at ${key(s)} vs the arrival at ${key(a)}`;
          expect(overlaps(plate, body) || overlaps(plate, name), `${at}: its nameplate`).toBe(false);
          expect(overlaps(bodyOf(s.x, s.y), body), `${at}: its body`).toBe(false);
        }
      }
    }
  });

  it('still places a crowded gate and merchants\' zone on free tiles, off every NPC post', () => {
    const actor = (i: number, location: 'orientation' | 'camp'): PublicActor => ({
      gladiatorId: `00000000-0000-4000-8000-${String(700 + i).padStart(12, '0')}`, name: `G${i}`, classId: 'duelist' as const,
      equipmentSilhouettes: ['weapon-sword'], appearance: null, league: 'bronze' as const, level: 1, phase: 'morning' as const, location,
      activityId: null, activityStatus: 'idle' as const, startsAtMs: null, endsAtMs: null, visibleStage: null, resting: false,
    });
    const posts = npcPostTiles();
    for (const [gate, merchants] of [[10, 18], [14, 18], [24, 30]]) {
      const actors = [...Array.from({ length: gate }, (_, i) => actor(i, 'orientation')), ...Array.from({ length: merchants }, (_, i) => actor(100 + i, 'camp'))];
      const { placements } = layoutCamp(actors, camp, 373_248, { reserved: posts });
      expect(placements.size, `${gate} + ${merchants}`).toBe(gate + merchants);
      expect(new Set([...placements.values()].map(key)).size).toBe(gate + merchants);
      for (const p of placements.values()) {
        const zone = camp.zones.find(z => z.id === p.zone)!.bounds;
        expect(camp.walkable[p.y][p.x], key(p)).toBe('1');
        expect(p.x >= zone.x && p.y >= zone.y && p.x < zone.x + zone.w && p.y < zone.y + zone.h, `${key(p)} in ${p.zone}`).toBe(true);
        expect(posts.has(key(p)), `${key(p)} is an NPC post`).toBe(false);
      }
      expect([...placements.values()].filter(p => p.zone === 'expedition-gate')).toHaveLength(gate);
      expect([...placements.values()].filter(p => p.zone === 'merchants')).toHaveLength(merchants);
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
      // The morning and the afternoon until the camp torches start to brighten (the last 3 minutes of a slot blend).
      for (const phase of [0, 1]) for (const ms of [0, 1_200_000, SLOT_MS - 180_000]) {
        expect(npcLookAt(r, at(phase, ms)), `${r.npcId} phase ${phase}`).toBe('guard');
        expect(npcCarriesTorch(r, at(phase, ms)), `${r.npcId} phase ${phase}`).toBe(false);
      }
      // The evening, from its first moment to the end of the evening light (the camp torches still at least half lit).
      for (const ms of [0, 1_200_000, SLOT_MS - 180_000]) {
        expect(npcLookAt(r, at(2, ms)), r.npcId).toBe('night-watch');
        expect(npcCarriesTorch(r, at(2, ms)), r.npcId).toBe(true);
      }
      expect(npcLookAt(r, at(3, 0)), r.npcId).toBe('guard');
      expect(npcCarriesTorch(r, at(3, 0)), r.npcId).toBe(false);
    }
  });

  // Review fix 5: the torch comes with the camp torches, which brighten over the last 3 minutes of the afternoon and dim over
  // the last 3 minutes of the evening (src/game/lighting.ts), never at the slot edge itself.
  it('takes up and puts down the torch with the camp torches, inside their 3-minute fades, not at the slot edge', () => {
    const half = (ms: number) => lightingAt(ms).torchIntensity >= 0.5;
    for (const r of patrols()) {
      for (let ms = at(0, 0); ms < at(3, 0); ms += 5_000) {
        expect(npcCarriesTorch(r, ms), `${r.npcId} at ${ms - base}`).toBe(half(ms));
        expect(npcLookAt(r, ms), `${r.npcId} at ${ms - base}`).toBe(half(ms) ? 'night-watch' : 'guard');
      }
      const changes: number[] = [];
      for (let ms = at(0, 0); ms < at(3, 0); ms += 1_000) if (npcCarriesTorch(r, ms) !== npcCarriesTorch(r, ms - 1_000)) changes.push(ms - base);
      expect(changes, r.npcId).toHaveLength(2);
      const [on, off] = changes;
      expect(on).toBeGreaterThan(2 * SLOT_MS - 180_000);
      expect(on).toBeLessThan(2 * SLOT_MS);
      expect(off).toBeGreaterThan(3 * SLOT_MS - 180_000);
      expect(off).toBeLessThan(3 * SLOT_MS);
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
