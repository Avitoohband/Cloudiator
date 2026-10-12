// Ambient NPC routines: deterministic waypoint loops driven by the shared clock, so every
// viewer sees the same merchants tending stalls, the trainer touring the yard and the
// cook and healer stopping to chat. They never affect progression.
import type { Direction, MapData } from './assets';
import { findPath, gridFromMap, pathLength, pointAlong } from './paths';
import type { TilePoint } from './assets';

export type NpcAction = 'idle' | 'walk' | 'talk' | 'tend';
export type NpcStep = { x: number; y: number; action: Exclude<NpcAction, 'walk'>; durationMs: number; facing: Direction };
export type NpcRoutine = { npcId: string; steps: NpcStep[] };
export type NpcPosition = { x: number; y: number; action: NpcAction; facing: Direction };

const WALK_TILES_PER_MS = 1.3 / 1000;

export const NPC_ROUTINES: NpcRoutine[] = [
  { npcId: 'smith', steps: [
    { x: 18, y: 7, action: 'tend', durationMs: 18_000, facing: 'sw' },
    { x: 19, y: 9, action: 'talk', durationMs: 8_000, facing: 'se' },
  ] },
  { npcId: 'armorer', steps: [
    { x: 24, y: 7, action: 'tend', durationMs: 15_000, facing: 'sw' },
    { x: 25, y: 9, action: 'talk', durationMs: 7_000, facing: 'se' },
    { x: 24, y: 7, action: 'idle', durationMs: 5_000, facing: 'se' },
  ] },
  { npcId: 'trainer', steps: [
    { x: 7, y: 18, action: 'talk', durationMs: 10_000, facing: 'se' },
    { x: 10, y: 21, action: 'idle', durationMs: 6_000, facing: 'sw' },
    { x: 13, y: 16, action: 'talk', durationMs: 10_000, facing: 'sw' },
  ] },
  { npcId: 'cook', steps: [
    { x: 24, y: 33, action: 'tend', durationMs: 20_000, facing: 'se' },
    { x: 26, y: 33, action: 'talk', durationMs: 9_000, facing: 'se' },
    { x: 23, y: 38, action: 'tend', durationMs: 9_000, facing: 'se' },
  ] },
  { npcId: 'healer', steps: [
    { x: 27, y: 32, action: 'talk', durationMs: 9_000, facing: 'sw' },
    { x: 20, y: 34, action: 'idle', durationMs: 6_000, facing: 'se' },
    { x: 12, y: 22, action: 'talk', durationMs: 8_000, facing: 'sw' },
    { x: 16, y: 27, action: 'idle', durationMs: 5_000, facing: 'se' },
  ] },
  { npcId: 'guard', steps: [
    { x: 40, y: 20, action: 'idle', durationMs: 22_000, facing: 'sw' },
    { x: 39, y: 24, action: 'idle', durationMs: 12_000, facing: 'se' },
    { x: 37, y: 21, action: 'talk', durationMs: 6_000, facing: 'se' },
  ] },
];

type Leg = { step: NpcStep; path: TilePoint[]; walkMs: number };
const legCache = new WeakMap<MapData, Map<string, Leg[]>>();

function legsFor(routine: NpcRoutine, map: MapData): Leg[] {
  let perMap = legCache.get(map);
  if (!perMap) { perMap = new Map(); legCache.set(map, perMap); }
  const cached = perMap.get(routine.npcId);
  if (cached) return cached;
  const grid = gridFromMap(map);
  const legs = routine.steps.map((step, i) => {
    const next = routine.steps[(i + 1) % routine.steps.length];
    const path = findPath(grid, { x: step.x, y: step.y }, { x: next.x, y: next.y });
    if (!path) throw new Error(`NPC ${routine.npcId}: no path from ${step.x},${step.y} to ${next.x},${next.y}`);
    return { step, path, walkMs: pathLength(path) / WALK_TILES_PER_MS };
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
export function planNpcPosition(routine: NpcRoutine, map: MapData, nowMs: number): NpcPosition {
  const legs = legsFor(routine, map);
  const cycle = legs.reduce((s, l) => s + l.step.durationMs + l.walkMs, 0);
  let t = ((nowMs % cycle) + cycle) % cycle;
  for (const leg of legs) {
    if (t < leg.step.durationMs) return { x: leg.step.x + 0.5, y: leg.step.y + 0.5, action: leg.step.action, facing: leg.step.facing };
    t -= leg.step.durationMs;
    if (t < leg.walkMs) {
      const p = pointAlong(leg.path, t * WALK_TILES_PER_MS);
      return { x: p.x, y: p.y, action: 'walk', facing: facingFor(p.dx, p.dy, leg.step.facing) };
    }
    t -= leg.walkMs;
  }
  const last = legs[legs.length - 1].step;
  return { x: last.x + 0.5, y: last.y + 0.5, action: last.action, facing: last.facing };
}
