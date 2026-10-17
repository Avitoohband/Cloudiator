// Pure geometry for the expedition scene: where each named journey point lies on an expedition map,
// the walkable path between two of them, and where the gladiator stands and what it does for a route
// progress from the stage core (src/game/expedition-stage.ts). Movement uses the manifest walking
// speed, so the feet keep pace with the walk cycle; it is a function of display time alone.
import type { Direction, MapData, TilePoint } from './assets';
import type { JourneyPoint, RouteProgress } from './expedition-stage';
import { findPath, gridFromMap, pathLength, pointAlong, type Grid } from './paths';
import { facingFor } from './npcs';

export type EncounterSpot = { gladiator: TilePoint; enemy: TilePoint; facing: Direction; enemyFacing: Direction; creature: string };
export type JourneyMap = {
  map: MapData;
  grid: Grid;
  points: Record<JourneyPoint, TilePoint>;
  /** Encounters 1 to 3, in order. */
  encounters: EncounterSpot[];
  /** Cached walkable paths between journey points. */
  paths: Map<string, TilePoint[] | null>;
};

export type GladiatorAction = 'walk' | 'search' | 'idle' | 'sit' | 'sleep' | 'fight';
export type GladiatorPose = { x: number; y: number; action: GladiatorAction; facing: Direction; walking: boolean };

/** Resting at the safe point: sit for a while, then sleep, repeating. */
export const REST_PATTERN = { sitMs: 120_000, sleepMs: 240_000 } as const;

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
  return { map, grid: gridFromMap(map), points, encounters, paths: new Map() };
}

/** The walkable path between two journey points (null if the map has none). */
export function legPath(journey: JourneyMap, from: JourneyPoint, to: JourneyPoint): TilePoint[] | null {
  const key = `${from}>${to}`;
  if (!journey.paths.has(key)) journey.paths.set(key, findPath(journey.grid, journey.points[from], journey.points[to]));
  return journey.paths.get(key) ?? null;
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
    const facing = arrivalFacing(journey, route.to);
    const at = { x: target.x + 0.5, y: target.y + 0.5, facing, walking: false };
    if (route.then === 'search') return { ...at, action: 'search' };
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
