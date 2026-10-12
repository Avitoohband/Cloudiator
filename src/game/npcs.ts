// Ambient NPC routines on the shared clock. Each NPC repeats a fixed period of scheduled steps and
// walks between them, so every viewer sees the same merchants tending stalls, the trainer touring
// the yard and pairs of NPCs meeting face to face (one facing se, the partner at x+1, y-1 facing sw).
// NPCs never affect progression.
import type { Direction, MapData, TilePoint } from './assets';
import { findPath, gridFromMap, pathLength, pointAlong } from './paths';

export type NpcAction = 'idle' | 'walk' | 'talk' | 'tend';
/** Stand at (x, y) from `at` for `durationMs` within the routine period. */
export type NpcStep = { x: number; y: number; at: number; durationMs: number; action: Exclude<NpcAction, 'walk'>; facing: Direction };
export type NpcRoutine = { npcId: string; periodMs: number; steps: NpcStep[]; meetsWith?: string };
export type NpcPosition = { x: number; y: number; action: NpcAction; facing: Direction };

/** Matches manifest actors.gladiator.walk.tilesPerSecond so NPC feet do not slide. */
export const NPC_WALK_TILES_PER_SECOND = 1;

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
  { npcId: 'guard', periodMs: 60_000, steps: [
    { x: 40, y: 20, at: 0, durationMs: 30_000, action: 'idle', facing: 'sw' },
    { x: 39, y: 24, at: 38_000, durationMs: 12_000, action: 'idle', facing: 'se' },
  ] },
];

/** Every tile an NPC stands on during its routine (players are kept off these). */
export function npcPostTiles(routines: NpcRoutine[] = NPC_ROUTINES): Set<string> {
  return new Set(routines.flatMap(r => r.steps.map(s => `${s.x},${s.y}`)));
}

type Leg = { step: NpcStep; next: NpcStep; nextAt: number; path: TilePoint[]; length: number };
const legCache = new WeakMap<MapData, Map<string, Leg[]>>();

function legsFor(routine: NpcRoutine, map: MapData): Leg[] {
  let perMap = legCache.get(map);
  if (!perMap) { perMap = new Map(); legCache.set(map, perMap); }
  const cached = perMap.get(routine.npcId);
  if (cached) return cached;
  const grid = gridFromMap(map);
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

export function facingFor(dx: number, dy: number, fallback: Direction = 'se'): Direction {
  const sx = dx - dy;
  const sy = dx + dy;
  if (sx === 0 && sy === 0) return fallback;
  if (sy >= 0) return sx >= 0 ? 'se' : 'sw';
  return sx >= 0 ? 'ne' : 'nw';
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
