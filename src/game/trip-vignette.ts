// The camp's bookends of the whole-trip replay (Patch A Task 10, spec "Item 3 + Task 10", "Camp bookends"): where the gladiator is
// on the camp's own map in each camp chapter (src/game/trip-replay.ts's `TripVignette`), drawn by src/game/trip-camp-scene.ts.
//   - "Leaving camp": it walks from inside the camp to the gate (41, 22), along the road through it, stands there, then fades out
//     at the gate.
//   - "Back in camp": it fades in at the gate, walks in along the same road, and stands.
//   - "Resting": it walks to its bed in the rest zone (a `sleep` station, the same one for the same gladiator) and lies down there
//     (the `sleep` action, the station's way).
// Each walk is at most `VIGNETTE.reach` tiles at the gladiator's walking speed, so the feet keep pace with the walk cycle, and it is
// shortened when a slower walk would not fit in the chapter. Everything is a function of the chapter's elapsed time alone (the
// replay can be paused or sought anywhere): no Phaser, React, clock or randomness.
import type { Direction, MapData, TilePoint } from './assets';
import type { TripVignette } from './trip-replay';
import { hashString } from './actors';
import { facingFor, findPath, gridFromMap, pathLength, pointAlong, type Grid } from './paths';

export type VignettePose = { x: number; y: number; action: 'walk' | 'idle' | 'sleep'; facing: Direction; alpha: number };
/**
 * `fades: false` (reduced motion) shows no fade: the gladiator is there at once at the gate when it comes back, and gone at once when
 * the fade out would start. The walks are shown as they are.
 */
export type VignetteOptions = { readonly fades?: boolean };

/**
 * How far a walk goes at most (tiles), how long the fades at the gate last, and how long the gladiator at least lies on its bed at
 * the end of "Resting" (ms of replay time).
 */
export const VIGNETTE = { reach: 4, fadeMs: 500, restMs: 1_500 } as const;

/** One tile along a facing: the way a station faces. */
const STEP: Record<Direction, TilePoint> = { se: { x: 1, y: 0 }, sw: { x: 0, y: 1 }, ne: { x: 0, y: -1 }, nw: { x: -1, y: 0 } };
/** Back in camp, the gladiator ends turned toward the viewer and the camp. */
const STAND_FACING: Direction = 'sw';

type Walks = { gate: TilePoint & { facing: Direction }; beds: (TilePoint & { facing: Direction })[]; grid: Grid; paths: Map<string, TilePoint[]> };
const cache = new WeakMap<MapData, Walks>();

function walksOf(map: MapData): Walks {
  const found = cache.get(map);
  if (found) return found;
  const stations = map.zones.flatMap(zone => zone.stations);
  const gate = stations.find(s => s.kind === 'gate');
  const beds = map.zones.find(zone => zone.id === 'rest')?.stations.filter(s => s.kind === 'sleep') ?? [];
  if (!gate || !beds.length) throw new Error(`${map.id} has no gate or no beds`);
  const walks: Walks = {
    gate: { x: gate.x, y: gate.y, facing: gate.facing },
    beds: beds.map(s => ({ x: s.x, y: s.y, facing: s.facing })),
    grid: gridFromMap(map),
    paths: new Map(),
  };
  cache.set(map, walks);
  return walks;
}

/** The bed a gladiator rests on in the replay: a `sleep` station of the rest zone, picked by `hashString(key)` (its id). */
export function bedFor(map: MapData, key: string): TilePoint & { facing: Direction } {
  const { beds } = walksOf(map);
  const bed = beds[hashString(key) % beds.length];
  return { x: bed.x, y: bed.y, facing: bed.facing };
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0);
const within = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isNaN(value) ? low : value));

/**
 * The road through the gate, from the tile `tiles` inside it (the gate station faces out of the camp) to the gate: a straight walk,
 * as long as the tiles on it are walkable.
 */
function gateRoad(walks: Walks, tiles: number): TilePoint[] {
  const { gate, grid } = walks;
  const key = `gate|${tiles}`;
  const known = walks.paths.get(key);
  if (known) return known;
  const out = STEP[gate.facing];
  const road: TilePoint[] = [{ x: gate.x, y: gate.y }];
  for (let k = 1; k <= tiles; k += 1) {
    const p = { x: gate.x - out.x * k, y: gate.y - out.y * k };
    if (!grid.walkable(p.x, p.y)) break;
    road.unshift(p);
  }
  walks.paths.set(key, road);
  return road;
}

/** The longest road the replay walks through the gate (`VIGNETTE.reach` tiles inside it): the camp's NPCs keep off it (patch 1.5.1). */
export function gateRoadTiles(map: MapData): TilePoint[] {
  return gateRoad(walksOf(map), VIGNETTE.reach);
}

/**
 * The walk to a bed from the furthest tile at most `reach` tiles of walking from it, over open ground: it never crosses another
 * bed or a bench (props' footprints), only steps onto its own bed at the end. Of the furthest tiles, the one furthest east, then
 * south (deterministic).
 */
function bedWalk(map: MapData, walks: Walks, bed: TilePoint, reach: number): TilePoint[] {
  const key = `bed|${bed.x},${bed.y}|${reach}`;
  const known = walks.paths.get(key);
  if (known) return known;
  const covered = new Set<string>();
  for (const p of map.props) for (let y = p.y; y < p.y + p.d; y += 1) for (let x = p.x; x < p.x + p.w; x += 1) covered.add(`${x},${y}`);
  const open: Grid = { ...walks.grid, walkable: (x, y) => walks.grid.walkable(x, y) && ((x === bed.x && y === bed.y) || !covered.has(`${x},${y}`)) };
  let best: { path: TilePoint[]; length: number } = { path: [{ x: bed.x, y: bed.y }], length: 0 };
  const r = Math.ceil(reach);
  for (let y = bed.y - r; y <= bed.y + r; y += 1) for (let x = bed.x - r; x <= bed.x + r; x += 1) {
    if (x === bed.x && y === bed.y) continue;
    const path = findPath(open, { x, y }, bed);
    if (!path) continue;
    const length = pathLength(path);
    if (length > reach + 1e-9) continue;
    const start = path[0], was = best.path[0];
    const better = length > best.length + 1e-9
      || (Math.abs(length - best.length) <= 1e-9 && (start.x > was.x || (start.x === was.x && start.y > was.y)));
    if (better) best = { path, length };
  }
  walks.paths.set(key, best.path);
  return best.path;
}

/** Where the walk along `path` (in order) is `ms` after it started, at `tilesPerSecond`; `facing` until it moves. */
function along(path: TilePoint[], ms: number, tilesPerSecond: number, facing: Direction): Omit<VignettePose, 'alpha'> {
  const length = pathLength(path);
  const walked = (Math.max(0, ms) * tilesPerSecond) / 1000;
  if (walked >= length || path.length < 2) {
    const end = path[path.length - 1];
    const last = path.length >= 2 ? facingFor(end.x - path[path.length - 2].x, end.y - path[path.length - 2].y, facing) : facing;
    return { x: end.x + 0.5, y: end.y + 0.5, action: 'idle', facing: last };
  }
  const p = pointAlong(path, walked);
  return { x: p.x, y: p.y, action: 'walk', facing: facingFor(p.dx, p.dy, facing) };
}

/** How long walking `path` takes at `tilesPerSecond`, in ms. */
const walkMs = (path: TilePoint[], tilesPerSecond: number) => (pathLength(path) / tilesPerSecond) * 1000;

/**
 * The gladiator in a camp chapter, `vignette.elapsedMs` into it (held to the chapter), walking at `tilesPerSecond`; `key` (its id)
 * picks its bed. `alpha` is how much of it shows (the fades at the gate).
 */
export function vignettePose(
  map: MapData, vignette: Pick<TripVignette, 'kind' | 'elapsedMs' | 'durationMs'>, key: string, tilesPerSecond: number, options: VignetteOptions = {},
): VignettePose {
  const walks = walksOf(map);
  const fades = options.fades !== false;
  const total = Math.max(0, finite(vignette.durationMs));
  const t = within(vignette.elapsedMs, 0, total);
  const speed = Number.isFinite(tilesPerSecond) && tilesPerSecond > 0 ? tilesPerSecond : 0;
  /** The longest walk (tiles) that leaves `spareMs` of the chapter after it. */
  const reach = (spareMs: number) => Math.min(VIGNETTE.reach, (speed * Math.max(0, total - spareMs)) / 1000);
  const { fadeMs } = VIGNETTE;

  if (vignette.kind === 'leaving') {
    const road = gateRoad(walks, Math.floor(reach(fadeMs)));
    const fadeFrom = total - fadeMs;
    const alpha = t < fadeFrom ? 1 : fades ? within((total - t) / fadeMs, 0, 1) : 0;
    return { ...along(road, t, speed, walks.gate.facing), alpha };
  }
  if (vignette.kind === 'back') {
    // The same road, walked in once the gladiator has faded in at the gate.
    const road = [...gateRoad(walks, Math.floor(reach(fadeMs)))].reverse();
    const inward = road.length >= 2 ? facingFor(road[1].x - road[0].x, road[1].y - road[0].y, walks.gate.facing) : walks.gate.facing;
    const alpha = fades ? within(t / fadeMs, 0, 1) : 1;
    const pose = along(road, t - fadeMs, speed, inward);
    if (t < fadeMs) return { ...pose, action: 'idle', facing: inward, alpha };
    return { ...pose, facing: pose.action === 'idle' && road.length >= 2 ? STAND_FACING : pose.facing, alpha };
  }
  const bed = bedFor(map, key);
  const path = bedWalk(map, walks, bed, reach(VIGNETTE.restMs));
  if (speed && t < walkMs(path, speed)) return { ...along(path, t, speed, bed.facing), alpha: 1 };
  return { x: bed.x + 0.5, y: bed.y + 0.5, action: 'sleep', facing: bed.facing, alpha: 1 };
}
