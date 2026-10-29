// Pure geometry for the expedition scene: where each named journey point lies on an expedition map,
// the walkable path between two of them, and where the gladiator stands and what it does for a route
// progress from the stage core (src/game/expedition-stage.ts). Movement uses the manifest walking
// speed, so the feet keep pace with the walk cycle; it is a function of display time alone.
import type { Direction, MapData, TilePoint } from './assets';
import { EXPEDITION_ENCOUNTERS, JOURNEY, type JourneyPoint, type RouteProgress } from './expedition-stage';
import { findPath, gridFromMap, pathLength, pointAlong, type Grid } from './paths';
import { facingFor } from './npcs';

export type EncounterSpot = { gladiator: TilePoint; enemy: TilePoint; facing: Direction; enemyFacing: Direction; creature: string };
/** A point the gladiator steps to while searching around a search spot, with the walkable paths there and back. */
export type WanderPoint = {
  point: TilePoint;
  out: TilePoint[];
  back: TilePoint[];
  /** Path length in tiles. */
  length: number;
  /** The side of the spot it lies on, on screen: se to the right, sw to the left. */
  side: 'se' | 'sw';
};
export type JourneyMap = {
  map: MapData;
  grid: Grid;
  points: Record<JourneyPoint, TilePoint>;
  /** Encounters 1 to 3, in order. */
  encounters: EncounterSpot[];
  /** Cached walkable paths between journey points. */
  paths: Map<string, TilePoint[] | null>;
  /** Cached wander points around each search spot. */
  wander: Map<JourneyPoint, WanderPoint[]>;
};

export type GladiatorAction = 'walk' | 'search' | 'idle' | 'sit' | 'sleep' | 'fight';
export type GladiatorPose = {
  x: number; y: number; action: GladiatorAction; facing: Direction; walking: boolean;
  /**
   * Time into the action's animation loop, when the pose decides it: the search cycle starts each crouch and each look
   * on time. Without it the scene runs the loop on the display clock.
   */
  animMs?: number;
};

/** Resting at the safe point: sit for a while, then sleep, repeating. */
export const REST_PATTERN = { sitMs: 120_000, sleepMs: 240_000 } as const;

/**
 * Searching at a search spot (Avi, 2026-10-29, "Slow + look around": the 1.3 s search loop, repeated on the spot for
 * minutes, read as squats). The manifest's `search` loop crouches and looks at the ground for `crouchMs`, then stands and
 * shades its eyes for `lookMs` (tested against the manifest). One cycle, driven only by the time spent at the spot:
 *   1. at the spot, crouch, then look (5 s), facing away from the wander point it goes to next;
 *   2. turn to face that point's side and look again (2.5 s);
 *   3. walk to the wander point (1 to 1.5 tiles) at the walking speed, with the walk animation;
 *   4. crouch, then look there (5 s), facing the way it walked;
 *   5. walk back to the spot.
 * At 1 tile per second a cycle takes 14.5 s (a 1-tile step) to 15.3 s (a sideways 1.4-tile step). Cycles alternate
 * between the spot's two wander points, one on each side of it on screen. The cycle still under way when the search ends
 * is spent at the spot instead (steps 1 and 2, then the same with the facings swapped), so the gladiator is on the spot
 * when the next leg starts there. Wander points stay within `reach` tiles of the spot.
 */
export const SEARCH_PATTERN = { crouchMs: 2_500, lookMs: 2_500, reach: 1.5 } as const;

/** Every leg the journey walks: the route in order, and from each encounter back to the safe point after a defeat. */
const LEGS: [JourneyPoint, JourneyPoint][] = [
  ...JOURNEY.slice(1).map((to, i): [JourneyPoint, JourneyPoint] => [JOURNEY[i], to]),
  ...Array.from({ length: EXPEDITION_ENCOUNTERS }, (_, i): [JourneyPoint, JourneyPoint] => [`encounter-${i + 1}` as JourneyPoint, 'safe']),
];

export function journeyMap(map: MapData): JourneyMap {
  const e = map.expedition;
  if (!e || e.encounters.length !== 3 || e.searchSpots.length !== 4) throw new Error(`${map.id} is not an expedition map`);
  const points = {
    start: e.start, end: e.end, safe: e.safePoint,
    'search-1': e.searchSpots[0], 'search-2': e.searchSpots[1], 'search-3': e.searchSpots[2], 'search-4': e.searchSpots[3],
    'encounter-1': { x: e.encounters[0].x, y: e.encounters[0].y },
    'encounter-2': { x: e.encounters[1].x, y: e.encounters[1].y },
    'encounter-3': { x: e.encounters[2].x, y: e.encounters[2].y },
  } satisfies Record<JourneyPoint, TilePoint>;
  const encounters = [...e.encounters].sort((a, b) => a.index - b.index).map(enc => ({
    gladiator: { x: enc.x, y: enc.y }, enemy: { x: enc.enemyX, y: enc.enemyY }, facing: enc.facing, enemyFacing: enc.enemyFacing, creature: enc.creature,
  }));
  return { map, grid: gridFromMap(map), points, encounters, paths: new Map(), wander: new Map() };
}

/** The walkable path between two journey points (null if the map has none). */
export function legPath(journey: JourneyMap, from: JourneyPoint, to: JourneyPoint): TilePoint[] | null {
  const key = `${from}>${to}`;
  if (!journey.paths.has(key)) journey.paths.set(key, findPath(journey.grid, journey.points[from], journey.points[to]));
  return journey.paths.get(key) ?? null;
}

/**
 * The points the gladiator wanders to around a search spot (SEARCH_PATTERN): neighbouring tiles that one step reaches
 * (at most `reach` tiles away), walkable, and never a prop's footprint (walkable floor props too), either fighter's
 * encounter tile, another journey point or a tile on another leg's path (a leg that neither starts nor ends at this spot).
 * One on each side of the spot on screen when it can (the left one first: the gladiator arrives facing se, so it first
 * turns to look left), each the widest sideways step, then the nearest the viewer. Computed once per journey map and spot.
 */
export function wanderPoints(journey: JourneyMap, spot: JourneyPoint): WanderPoint[] {
  const cached = journey.wander.get(spot);
  if (cached) return cached;
  const centre = journey.points[spot];
  const key = (p: TilePoint) => `${p.x},${p.y}`;
  const avoid = new Set<string>();
  for (const p of journey.map.props) for (let y = p.y; y < p.y + p.d; y += 1) for (let x = p.x; x < p.x + p.w; x += 1) avoid.add(`${x},${y}`);
  for (const e of journey.encounters) avoid.add(key(e.gladiator)).add(key(e.enemy));
  for (const [name, p] of Object.entries(journey.points)) if (name !== spot) avoid.add(key(p));
  for (const [from, to] of LEGS) if (from !== spot && to !== spot) for (const p of legPath(journey, from, to) ?? []) avoid.add(key(p));
  const candidates: { wander: WanderPoint; sx: number; sy: number }[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      // Screen offsets: sx sideways (0 for the spot itself and for straight up or down), sy toward the viewer.
      const sx = dx - dy;
      const point = { x: centre.x + dx, y: centre.y + dy };
      if (sx === 0 || avoid.has(key(point)) || !journey.grid.walkable(point.x, point.y)) continue;
      const out = findPath(journey.grid, centre, point);
      if (!out || pathLength(out) > SEARCH_PATTERN.reach) continue;
      candidates.push({ wander: { point, out, back: [...out].reverse(), length: pathLength(out), side: sx > 0 ? 'se' : 'sw' }, sx, sy: dx + dy });
    }
  }
  candidates.sort((a, b) => Math.abs(b.sx) - Math.abs(a.sx) || b.sy - a.sy);
  const chosen = (['sw', 'se'] as const).flatMap(side => candidates.filter(c => c.wander.side === side).slice(0, 1));
  for (const c of candidates) if (chosen.length < 2 && !chosen.includes(c)) chosen.push(c);
  const points = chosen.map(c => c.wander);
  journey.wander.set(spot, points);
  return points;
}

const turned = (facing: 'se' | 'sw'): 'se' | 'sw' => (facing === 'se' ? 'sw' : 'se');

/** The search at `spot` (SEARCH_PATTERN), `restMs` after arriving there, for a search that ends `endMs` after arriving. */
function searchPose(journey: JourneyMap, spot: JourneyPoint, restMs: number, endMs: number, tilesPerSecond: number): GladiatorPose {
  const { crouchMs, lookMs } = SEARCH_PATTERN;
  const searchMs = crouchMs + lookMs;
  const roundMs = searchMs + lookMs;
  const centre = journey.points[spot];
  const at = (p: TilePoint, facing: Direction, animMs: number): GladiatorPose => ({ x: p.x + 0.5, y: p.y + 0.5, action: 'search', facing, walking: false, animMs });
  // At the spot: crouch and look facing one way, then turn and look the other way; the next round crouches facing the
  // way it last looked.
  const inPlace = (ms: number, facing: 'se' | 'sw'): GladiatorPose => {
    const round = Math.floor(ms / roundMs);
    const local = ms - round * roundMs;
    const first = round % 2 ? turned(facing) : facing;
    return local < searchMs ? at(centre, first, local) : at(centre, turned(first), crouchMs + local - searchMs);
  };
  const t = Math.max(0, restMs);
  const points = wanderPoints(journey, spot);
  if (!points.length) return inPlace(t, 'se');
  const walkMs = (w: WanderPoint) => (w.length / tilesPerSecond) * 1000;
  const cycleMs = (w: WanderPoint) => roundMs + walkMs(w) + searchMs + walkMs(w);
  const period = points.reduce((sum, w) => sum + cycleMs(w), 0);
  /** The cycle under way `ms` after arriving: when it started, and its wander point. */
  const cycleAt = (ms: number) => {
    let start = Math.floor(ms / period) * period;
    let i = 0;
    while (i < points.length - 1 && start + cycleMs(points[i]) <= ms) start += cycleMs(points[i++]);
    return { start, w: points[i] };
  };
  // The cycle still under way when the search ends is spent at the spot, so the next leg starts where it stands.
  if (Number.isFinite(endMs)) {
    const last = cycleAt(Math.max(0, endMs));
    if (t >= last.start) return inPlace(t - last.start, turned(last.w.side));
  }
  const { start, w } = cycleAt(t);
  let local = t - start;
  if (local < roundMs) return inPlace(local, turned(w.side));
  local -= roundMs;
  const walk = (path: TilePoint[], ms: number): GladiatorPose => {
    const p = pointAlong(path, (ms * tilesPerSecond) / 1000);
    return { x: p.x, y: p.y, action: 'walk', facing: facingFor(p.dx, p.dy, w.side), walking: true };
  };
  if (local < walkMs(w)) return walk(w.out, local);
  local -= walkMs(w);
  if (local < searchMs) return at(w.point, w.side, local);
  return walk(w.back, local - searchMs);
}

function arrivalFacing(journey: JourneyMap, to: JourneyPoint): Direction {
  const encounter = /^encounter-(\d)$/.exec(to);
  return encounter ? journey.encounters[Number(encounter[1]) - 1].facing : 'se';
}

/** Where the gladiator is and what it does for a route progress, at `tilesPerSecond`. */
export function gladiatorPose(journey: JourneyMap, route: RouteProgress, tilesPerSecond: number): GladiatorPose {
  // Leaving after a defeat: it keeps the pose of its rest at the safe point while the scene fades it out.
  if (route.then === 'leave' && route.rest) return gladiatorPose(journey, route.rest, tilesPerSecond);
  const target = journey.points[route.to];
  const arrived = (restMs: number): GladiatorPose => {
    // Searching: it looks around the spot, a few steps at a time, and is back on it when the search ends (`untilMs`,
    // counted like `walkedMs` from when it set off; without one the cycle goes on).
    if (route.then === 'search') {
      const endMs = route.untilMs === undefined ? Infinity : route.untilMs - (route.walkedMs - restMs);
      return searchPose(journey, route.to, restMs, endMs, tilesPerSecond);
    }
    const facing = arrivalFacing(journey, route.to);
    const at = { x: target.x + 0.5, y: target.y + 0.5, facing, walking: false };
    if (route.then === 'fight') return { ...at, action: 'fight' };
    if (route.then === 'rest') {
      const cycle = REST_PATTERN.sitMs + REST_PATTERN.sleepMs;
      return { ...at, action: ((restMs % cycle) + cycle) % cycle < REST_PATTERN.sitMs ? 'sit' : 'sleep' };
    }
    return { ...at, action: 'idle' };
  };
  if (route.from === route.to) return arrived(route.walkedMs);
  const path = legPath(journey, route.from, route.to);
  // No walkable path (never on the shipped maps): show the gladiator at its destination.
  if (!path) return arrived(route.walkedMs);
  const length = pathLength(path);
  const walked = (route.walkedMs * tilesPerSecond) / 1000;
  if (walked >= length) return arrived(route.walkedMs - (length / tilesPerSecond) * 1000);
  const p = pointAlong(path, walked);
  return { x: p.x, y: p.y, action: 'walk', facing: facingFor(p.dx, p.dy, 'se'), walking: true };
}
