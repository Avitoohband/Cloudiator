// Ambient NPC routines on the shared clock. Each NPC repeats a fixed period of scheduled steps and
// walks between them, so every viewer sees the same merchants tending stalls, the trainer touring
// the yard and pairs of NPCs meeting face to face (one facing se, the partner at x+1, y-1 facing sw).
// NPCs never affect progression.
// Patch 1.5.1 (camp-expansion proposal, Patch 1; Avi's answers 2026-10-30) adds four guards and four camp NPCs on today's
// map. A round names its art (several guards share the Gate Guard's) and its name; the two wall patrols are the night watch
// in the evening, with a torch whose light walks with them (src/game/camp-scene.ts). The new rounds walk around the
// gladiators' spots, the Arena floor, the whole-trip replay's gate road and the other NPCs' posts.
import type { Direction, MapData, TilePoint } from './assets';
import { SLOT_MS, phaseOfSlot } from './lighting';
import { facingFor, findPath, gridFromMap, pathLength, pointAlong, type Grid } from './paths';
import { spectatorSpots } from './tournament-camp';
import { gateRoadTiles } from './trip-vignette';

export { facingFor };

export type NpcAction = 'idle' | 'walk' | 'talk' | 'tend';
/** Stand at (x, y) from `at` for `durationMs` within the routine period. */
export type NpcStep = { x: number; y: number; at: number; durationMs: number; action: Exclude<NpcAction, 'walk'>; facing: Direction };
export type NpcRoutine = {
  /** The round's own id: the camp draws it as `npc:<npcId>`. */
  npcId: string;
  /** Its art, a `manifest.actors.npcs` id; the round's own id when absent. */
  look?: string;
  /** The name over its head; its art's name when absent. */
  name?: string;
  /** The night watch: the art it wears in the evening phase, and whether it carries a torch then (a light that walks with it). */
  evening?: { look: string; torch: boolean };
  /** Walks around the gladiators' spots, the Arena floor, the replay's gate road and the other NPCs' posts (`keepClearTiles`). */
  keepClear?: boolean;
  periodMs: number;
  steps: NpcStep[];
  meetsWith?: string;
};
export type NpcPosition = { x: number; y: number; action: NpcAction; facing: Direction };

/** Matches manifest actors.gladiator.walk.tilesPerSecond so NPC feet do not slide. */
export const NPC_WALK_TILES_PER_SECOND = 1;

const NIGHT_WATCH = { look: 'night-watch', torch: true } as const;

export const NPC_ROUTINES: NpcRoutine[] = [
  { npcId: 'smith', periodMs: 60_000, meetsWith: 'armorer', steps: [
    { x: 18, y: 7, at: 0, durationMs: 30_000, action: 'tend', facing: 'sw' },
    { x: 20, y: 8, at: 36_000, durationMs: 12_000, action: 'talk', facing: 'se' },
  ] },
  { npcId: 'armorer', periodMs: 60_000, meetsWith: 'smith', steps: [
    { x: 24, y: 7, at: 0, durationMs: 28_000, action: 'tend', facing: 'sw' },
    { x: 21, y: 7, at: 36_000, durationMs: 12_000, action: 'talk', facing: 'sw' },
  ] },
  { npcId: 'cook', periodMs: 90_000, meetsWith: 'healer', steps: [
    { x: 24, y: 33, at: 0, durationMs: 30_000, action: 'tend', facing: 'se' },
    { x: 26, y: 33, at: 40_000, durationMs: 13_000, action: 'talk', facing: 'se' },
    { x: 23, y: 38, at: 62_000, durationMs: 18_000, action: 'tend', facing: 'se' },
  ] },
  { npcId: 'healer', periodMs: 90_000, meetsWith: 'cook', steps: [
    { x: 27, y: 32, at: 40_000, durationMs: 13_000, action: 'talk', facing: 'sw' },
    { x: 16, y: 27, at: 68_000, durationMs: 2_000, action: 'idle', facing: 'se' },
    { x: 12, y: 22, at: 78_000, durationMs: 10_000, action: 'talk', facing: 'se' },
  ] },
  { npcId: 'trainer', periodMs: 90_000, meetsWith: 'healer', steps: [
    { x: 7, y: 18, at: 8_000, durationMs: 8_000, action: 'talk', facing: 'se' },
    { x: 10, y: 21, at: 22_000, durationMs: 6_000, action: 'idle', facing: 'sw' },
    { x: 13, y: 16, at: 40_000, durationMs: 12_000, action: 'talk', facing: 'sw' },
    { x: 13, y: 21, at: 78_000, durationMs: 10_000, action: 'talk', facing: 'sw' },
  ] },
  // The guard's patrol passes behind the watchtower, where only the selection fade shows him.
  { npcId: 'guard', periodMs: 90_000, steps: [
    { x: 40, y: 20, at: 0, durationMs: 30_000, action: 'idle', facing: 'sw' },
    { x: 36, y: 14, at: 40_000, durationMs: 10_000, action: 'idle', facing: 'se' },
    { x: 39, y: 24, at: 64_000, durationMs: 12_000, action: 'idle', facing: 'se' },
  ] },
  // Patch 1.5.1 guards: the gate's south post beside its torch, the lookout at the foot of the watchtower, and the two wall
  // patrols round the inside of the palisade (the night watch in the evening).
  { npcId: 'guard-south', look: 'guard', name: 'Gate Guard', keepClear: true, periodMs: 70_000, steps: [
    { x: 40, y: 24, at: 0, durationMs: 40_000, action: 'idle', facing: 'sw' },
    { x: 38, y: 26, at: 48_000, durationMs: 10_000, action: 'idle', facing: 'se' },
  ] },
  { npcId: 'lookout', look: 'guard', name: 'Tower Lookout', keepClear: true, periodMs: 80_000, steps: [
    { x: 40, y: 17, at: 0, durationMs: 50_000, action: 'idle', facing: 'se' },
    { x: 41, y: 14, at: 56_000, durationMs: 10_000, action: 'idle', facing: 'se' },
  ] },
  { npcId: 'patrol-north', look: 'guard', name: 'North Wall Patrol', evening: NIGHT_WATCH, keepClear: true, periodMs: 130_000, steps: [
    { x: 40, y: 11, at: 0, durationMs: 4_000, action: 'idle', facing: 'se' },
    { x: 40, y: 5, at: 15_000, durationMs: 6_000, action: 'idle', facing: 'se' },
    { x: 5, y: 5, at: 66_000, durationMs: 6_000, action: 'idle', facing: 'sw' },
    { x: 5, y: 11, at: 81_000, durationMs: 4_000, action: 'idle', facing: 'sw' },
  ] },
  { npcId: 'patrol-south', look: 'guard', name: 'South Wall Patrol', evening: NIGHT_WATCH, keepClear: true, periodMs: 160_000, steps: [
    { x: 39, y: 27, at: 0, durationMs: 4_000, action: 'idle', facing: 'se' },
    { x: 40, y: 40, at: 26_000, durationMs: 6_000, action: 'idle', facing: 'se' },
    { x: 6, y: 41, at: 76_000, durationMs: 6_000, action: 'idle', facing: 'sw' },
    { x: 5, y: 27, at: 103_000, durationMs: 4_000, action: 'idle', facing: 'sw' },
  ] },
  // Patch 1.5.1 camp NPCs: water from the well to the training yard and the gate; the herald at the Arena gate, the camp gate
  // and the plaza; crates from the gate to the stalls and the kitchen; the forester's four wooded corners (the future plots).
  { npcId: 'water-carrier', look: 'water-carrier', name: 'Petra the Water Carrier', keepClear: true, periodMs: 120_000, steps: [
    { x: 28, y: 31, at: 0, durationMs: 12_000, action: 'tend', facing: 'sw' },
    { x: 13, y: 18, at: 43_000, durationMs: 8_000, action: 'tend', facing: 'sw' },
    { x: 37, y: 25, at: 88_000, durationMs: 8_000, action: 'tend', facing: 'se' },
  ] },
  { npcId: 'herald', look: 'herald', name: 'Felix the Herald', keepClear: true, periodMs: 100_000, steps: [
    { x: 29, y: 27, at: 0, durationMs: 30_000, action: 'tend', facing: 'se' },
    { x: 37, y: 21, at: 45_000, durationMs: 10_000, action: 'talk', facing: 'sw' },
    { x: 23, y: 32, at: 79_000, durationMs: 8_000, action: 'idle', facing: 'se' },
  ] },
  { npcId: 'porter', look: 'porter', name: 'Quintus the Porter', keepClear: true, periodMs: 140_000, steps: [
    { x: 35, y: 25, at: 0, durationMs: 10_000, action: 'tend', facing: 'sw' },
    { x: 21, y: 6, at: 41_000, durationMs: 10_000, action: 'tend', facing: 'se' },
    { x: 27, y: 40, at: 98_000, durationMs: 10_000, action: 'tend', facing: 'sw' },
  ] },
  { npcId: 'forester', look: 'forester', name: 'Silva the Forester', keepClear: true, periodMs: 190_000, steps: [
    { x: 9, y: 8, at: 0, durationMs: 12_000, action: 'tend', facing: 'se' },
    { x: 36, y: 9, at: 46_000, durationMs: 12_000, action: 'tend', facing: 'sw' },
    { x: 33, y: 34, at: 94_000, durationMs: 12_000, action: 'tend', facing: 'se' },
    { x: 9, y: 33, at: 138_000, durationMs: 12_000, action: 'tend', facing: 'se' },
  ] },
];

/** Every tile an NPC stands on during its routine (players are kept off these). */
export function npcPostTiles(routines: NpcRoutine[] = NPC_ROUTINES): Set<string> {
  return new Set(routines.flatMap(r => r.steps.map(s => `${s.x},${s.y}`)));
}

/** The evening phase of the shared clock: the camp's own day and evening light (src/game/lighting.ts). */
const isEvening = (nowMs: number) => phaseOfSlot(Math.floor(nowMs / SLOT_MS)) === 'evening';

/** The art an NPC wears at shared time `nowMs`: the night watch's in the evening, its own otherwise. */
export function npcLookAt(routine: NpcRoutine, nowMs: number): string {
  return routine.evening && isEvening(nowMs) ? routine.evening.look : routine.look ?? routine.npcId;
}

/** Whether an NPC carries a lit torch at shared time `nowMs`: a night-watch patrol, in the evening phase only. */
export function npcCarriesTorch(routine: NpcRoutine, nowMs: number): boolean {
  return !!routine.evening?.torch && isEvening(nowMs);
}

/** Beds and seats: where gladiators sleep, sit and eat (their props' footprints). */
const BED_OR_SEAT = /^(bedroll|bench|log-seat)/;

/**
 * The tiles a `keepClear` round never walks on: the gladiators' activity spots (every station that is not an NPC's, the
 * tournament spectator spots, the beds and seats), the Arena floor inside its wall, the whole-trip replay's gate road and
 * every other NPC's post. Its own posts stay open to it.
 */
export function keepClearTiles(map: MapData, routine: NpcRoutine, routines: NpcRoutine[] = NPC_ROUTINES): Set<string> {
  const tiles = new Set<string>();
  for (const zone of map.zones) for (const s of zone.stations) if (!s.npc) tiles.add(`${s.x},${s.y}`);
  for (const s of spectatorSpots(map)) tiles.add(`${s.x},${s.y}`);
  for (const p of map.props) {
    if (!BED_OR_SEAT.test(p.frame)) continue;
    for (let y = p.y; y < p.y + p.d; y += 1) for (let x = p.x; x < p.x + p.w; x += 1) tiles.add(`${x},${y}`);
  }
  if (map.arena) {
    const [cx, cy] = map.arena.centre;
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= map.arena.radius + 0.5) tiles.add(`${x},${y}`);
    }
  }
  for (const p of gateRoadTiles(map)) tiles.add(`${p.x},${p.y}`);
  for (const post of npcPostTiles(routines.filter(r => r !== routine))) tiles.add(post);
  for (const s of routine.steps) tiles.delete(`${s.x},${s.y}`);
  return tiles;
}

type Leg = { step: NpcStep; next: NpcStep; nextAt: number; path: TilePoint[]; length: number };
const legCache = new WeakMap<MapData, Map<string, Leg[]>>();

function gridFor(routine: NpcRoutine, map: MapData): Grid {
  const grid = gridFromMap(map);
  if (!routine.keepClear) return grid;
  const blocked = keepClearTiles(map, routine);
  return { ...grid, walkable: (x, y) => grid.walkable(x, y) && !blocked.has(`${x},${y}`) };
}

function legsFor(routine: NpcRoutine, map: MapData): Leg[] {
  let perMap = legCache.get(map);
  if (!perMap) { perMap = new Map(); legCache.set(map, perMap); }
  const cached = perMap.get(routine.npcId);
  if (cached) return cached;
  const grid = gridFor(routine, map);
  const steps = [...routine.steps].sort((a, b) => a.at - b.at);
  const legs = steps.map((step, i) => {
    const next = steps[(i + 1) % steps.length];
    const nextAt = i + 1 < steps.length ? next.at : next.at + routine.periodMs;
    const path = findPath(grid, { x: step.x, y: step.y }, { x: next.x, y: next.y });
    if (!path) throw new Error(`NPC ${routine.npcId}: no path from ${step.x},${step.y} to ${next.x},${next.y}`);
    return { step, next, nextAt, path, length: pathLength(path) };
  });
  perMap.set(routine.npcId, legs);
  return legs;
}

/** Where an NPC is and what it is doing at shared time `nowMs`. */
export function planNpcPosition(routine: NpcRoutine, map: MapData, nowMs: number, tilesPerSecond = NPC_WALK_TILES_PER_SECOND): NpcPosition {
  const legs = legsFor(routine, map);
  const speed = tilesPerSecond / 1000;
  let t = ((nowMs % routine.periodMs) + routine.periodMs) % routine.periodMs;
  if (t < legs[0].step.at) t += routine.periodMs;
  for (const leg of legs) {
    const { step } = leg;
    if (t < step.at) continue;
    if (t < step.at + step.durationMs) return { x: step.x + 0.5, y: step.y + 0.5, action: step.action, facing: step.facing };
    if (t < leg.nextAt) {
      const walked = (t - step.at - step.durationMs) * speed;
      if (walked >= leg.length) return { x: leg.next.x + 0.5, y: leg.next.y + 0.5, action: 'idle', facing: leg.next.facing };
      const p = pointAlong(leg.path, walked);
      return { x: p.x, y: p.y, action: 'walk', facing: facingFor(p.dx, p.dy, step.facing) };
    }
  }
  const first = legs[0].step;
  return { x: first.x + 0.5, y: first.y + 0.5, action: first.action, facing: first.facing };
}

/** Walking time each leg needs versus the time the schedule allows (used by tests). */
export function routineSlack(routine: NpcRoutine, map: MapData, tilesPerSecond = NPC_WALK_TILES_PER_SECOND): number[] {
  return legsFor(routine, map).map(leg => leg.nextAt - (leg.step.at + leg.step.durationMs) - (leg.length / tilesPerSecond) * 1000);
}

/** The tiles of each leg, from each post to the next and from the last back to the first (used by tests). */
export function routePaths(routine: NpcRoutine, map: MapData): TilePoint[][] {
  return legsFor(routine, map).map(leg => leg.path);
}
