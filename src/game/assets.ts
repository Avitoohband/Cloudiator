// Typed access to the generated asset package in public/assets plus contract validators.
// The JSON files are produced by assets/source/build-assets.mjs; never edit them by hand.
import rawManifest from '../../public/assets/manifest.json';
import gladiatorsAtlas from '../../public/assets/actors/gladiators.json';
import npcsAtlas from '../../public/assets/actors/npcs.json';
import creaturesAtlas from '../../public/assets/actors/creatures.json';
import campTilesAtlas from '../../public/assets/camp/tiles.json';
import campPropsAtlas from '../../public/assets/camp/props.json';
import woodlandAtlas from '../../public/assets/expeditions/woodland.json';
import outpostAtlas from '../../public/assets/expeditions/outpost.json';
import mountainAtlas from '../../public/assets/expeditions/mountain.json';
import effectsAtlas from '../../public/assets/effects/combat.json';
import iconsAtlas from '../../public/assets/ui/icons.json';
import campMap from '../../public/assets/camp/map.json';
import woodlandMap from '../../public/assets/expeditions/woodland-map.json';
import outpostMap from '../../public/assets/expeditions/outpost-map.json';
import mountainMap from '../../public/assets/expeditions/mountain-map.json';

export const ACTIONS = ['idle', 'walk', 'weights', 'practice', 'spar', 'sit', 'eat', 'sleep', 'search', 'attack', 'hit', 'defend', 'evade', 'defeat', 'victory'] as const;
export type ActionId = (typeof ACTIONS)[number];
export type AttackVariant = 'thrust' | 'shoot';
export type Direction = 'se' | 'sw' | 'ne' | 'nw';
export type MapId = 'camp' | 'woodland' | 'outpost' | 'mountain';

export type PropMeta = {
  footprint: { w: number; d: number };
  sortY: number;
  occludes: boolean;
  walkable: boolean;
  layer: 'floor' | 'object' | 'foreground';
  light?: { radius: number; color: string };
};
export type FrameRect = { x: number; y: number; w: number; h: number; anchorX: number; anchorY: number; meta?: PropMeta };
export type AtlasKind = 'actor' | 'tiles' | 'props' | 'environment' | 'effects' | 'icons';
export type AtlasDef = { key: string; image: string; data: string; width: number; height: number; kind: AtlasKind; frames: Record<string, FrameRect> };
export type AnimationDef = { atlas: string; frames: string[]; durationsMs: number[]; loop: boolean };
export type DirectionalAnimation = { se: string; ne?: string };
export type TintKey = 'skin' | 'cloth' | 'hair';
export type GladiatorLayer = { id: string; slot: string; tintable: boolean; tint?: TintKey };
export type CreatureAction = 'idle' | 'walk' | 'attack' | 'hit' | 'defend' | 'evade' | 'defeat' | 'victory';
export type EffectId = 'hit' | 'critical' | 'defend' | 'evade' | 'defeat' | 'victory' | 'dust' | 'arrow';
export type ActorAnimations<A extends string> = Record<A, DirectionalAnimation>;

export type MapStation = { id: string; kind: string; x: number; y: number; facing: Direction; partner?: string; npc?: string };
export type MapZone = { id: string; label: string; bounds: { x: number; y: number; w: number; h: number }; walkableTiles: number; stations: MapStation[] };
export type MapProp = {
  id: string; frame: string; x: number; y: number; w: number; d: number; sortY: number;
  layer: PropMeta['layer']; occludes: boolean; walkable: boolean; animation?: string;
  /** Explicit depth slices (arena wall segments); see src/game/depth.ts. */
  slices?: { left: number; width: number; depthOffset: number }[];
  /** Click target: opens a shop or the expedition gate panel. */
  interact?: 'merchant-weapons' | 'merchant-armor' | 'expedition-gate';
};
export type MapLight = { x: number; y: number; radius: number; color: string; kind: string };
export type TilePoint = { x: number; y: number };
export type ExpeditionLayout = {
  start: TilePoint; end: TilePoint; route: TilePoint[];
  encounters: { index: 1 | 2 | 3; x: number; y: number; enemyX: number; enemyY: number; facing: Direction; enemyFacing: Direction; creature: string }[];
  searchSpots: TilePoint[]; safePoint: TilePoint;
};
export type MapData = {
  id: MapId; width: number; height: number; tileWidth: number; tileHeight: number;
  tilesAtlas: string; propsAtlas: string; projection: string;
  vertices: string[]; groundFrames: string[]; ground: number[]; walkable: string[];
  props: MapProp[]; zones: MapZone[]; lights: MapLight[]; spawn: TilePoint;
  paths: { nodes: { id: string; x: number; y: number }[]; edges: [string, string][] };
  arena?: { centre: [number, number]; radius: number };
  expedition?: ExpeditionLayout;
};
export type ProvenanceRecord = { file: string; sha256: string; bytes: number; source: string; generator: string; inputs: string[]; command: string; license: string };
export type MapFile = { id: MapId; data: string; tilesAtlas: string; propsAtlas: string };

export type AssetManifest = {
  version: number;
  generatedBy: string;
  artDirection: string;
  pixelScale: { tileWidth: number; tileHeight: number; actorWidth: number; actorHeight: number };
  projection: { tileWidth: number; tileHeight: number; rule: string };
  palette: Record<string, string>;
  actions: ActionId[];
  directions: Record<Direction, { source: 'se' | 'ne'; flipX: boolean }>;
  atlases: Record<string, AtlasDef>;
  animations: Record<string, AnimationDef>;
  actors: {
    gladiator: {
      atlas: string; anchor: { x: number; y: number }; layers: GladiatorLayer[];
      animations: ActorAnimations<ActionId | AttackVariant>; attackVariants: Record<string, AttackVariant>; notes: string;
      walk: { tilesPerSecond: number };
    };
    npcs: { id: string; name: string; role: string; atlas: string; animations: Partial<ActorAnimations<'idle' | 'walk' | 'talk' | 'tend'>> }[];
    creatures: { id: string; name: string; expedition: Exclude<MapId, 'camp'>; atlas: string; animations: Partial<ActorAnimations<CreatureAction>> }[];
    /** Creature id shown at encounters 1, 2 and 3 of each expedition. */
    encounterCreatures: Record<Exclude<MapId, 'camp'>, [string, string, string]>;
  };
  effects: Record<EffectId, string>;
  /** Catalog template id (prefix of 'sword:1:common') to gladiator layer id; null when not drawn. */
  equipmentLayers: Record<string, string | null>;
  depthRule: string;
  /** Data file of each map, for provenance checks. */
  mapFiles: MapFile[];
  icons: Record<string, string>;
  maps: MapData[];
  provenance: ProvenanceRecord[];
};

type PhaserAtlas = { frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; pivot: { x: number; y: number }; anchorPx: { x: number; y: number }; meta?: PropMeta }>; meta: { size: { w: number; h: number } } };
type RawManifest = Omit<AssetManifest, 'atlases' | 'maps' | 'mapFiles'> & {
  atlases: Record<string, Omit<AtlasDef, 'key' | 'frames'>>;
  maps: MapFile[];
};

/** Raw Phaser JSON-hash atlas tables keyed by their manifest data path (passed to the loader to avoid refetching). */
export const ATLAS_DATA: Record<string, unknown> = {
  'actors/gladiators.json': gladiatorsAtlas, 'actors/npcs.json': npcsAtlas, 'actors/creatures.json': creaturesAtlas,
  'camp/tiles.json': campTilesAtlas, 'camp/props.json': campPropsAtlas,
  'expeditions/woodland.json': woodlandAtlas, 'expeditions/outpost.json': outpostAtlas, 'expeditions/mountain.json': mountainAtlas,
  'effects/combat.json': effectsAtlas, 'ui/icons.json': iconsAtlas,
};
const MAP_DATA: Record<string, unknown> = {
  'camp/map.json': campMap, 'expeditions/woodland-map.json': woodlandMap,
  'expeditions/outpost-map.json': outpostMap, 'expeditions/mountain-map.json': mountainMap,
};

let cached: AssetManifest | null = null;

/** The shared manifest is read-only: freeze it once so no consumer can mutate another's view. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** The complete asset package: manifest metadata joined with every atlas frame table and map. */
export function loadAssetManifest(): AssetManifest {
  if (cached) return cached;
  const raw = rawManifest as unknown as RawManifest;
  const atlases: Record<string, AtlasDef> = {};
  for (const [key, def] of Object.entries(raw.atlases)) {
    const data = ATLAS_DATA[def.data] as PhaserAtlas | undefined;
    if (!data) throw new Error(`Atlas data ${def.data} is not bundled in src/game/assets.ts`);
    const frames: Record<string, FrameRect> = {};
    for (const [name, f] of Object.entries(data.frames)) {
      frames[name] = { x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h, anchorX: f.anchorPx.x, anchorY: f.anchorPx.y, ...(f.meta ? { meta: f.meta } : {}) };
    }
    atlases[key] = { key, ...def, frames };
  }
  const maps = raw.maps.map(entry => {
    const data = MAP_DATA[entry.data] as MapData | undefined;
    if (!data) throw new Error(`Map data ${entry.data} is not bundled in src/game/assets.ts`);
    return data;
  });
  cached = deepFreeze({ ...raw, atlases, maps, mapFiles: raw.maps });
  return cached;
}

// ------------------------------------------------------------------ validators

/** Every frame and anchor lies inside its image; actor frames are 64x64, tiles 64x32; frames never overlap. */
export function validateFrameBounds(manifest: AssetManifest): string[] {
  const errors: string[] = [];
  const { actorWidth, actorHeight, tileWidth, tileHeight } = manifest.pixelScale;
  for (const atlas of Object.values(manifest.atlases)) {
    const rects = Object.entries(atlas.frames);
    for (const [name, r] of rects) {
      const where = `${atlas.key}:${name}`;
      if (![r.x, r.y, r.w, r.h, r.anchorX, r.anchorY].every(Number.isInteger)) errors.push(`${where} has non-integer geometry`);
      if (r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > atlas.width || r.y + r.h > atlas.height) errors.push(`${where} lies outside ${atlas.width}x${atlas.height}`);
      if (r.anchorX < 0 || r.anchorY < 0 || r.anchorX > r.w || r.anchorY > r.h) errors.push(`${where} anchor outside frame`);
      if (atlas.kind === 'actor' && (r.w !== actorWidth || r.h !== actorHeight)) errors.push(`${where} is not ${actorWidth}x${actorHeight}`);
      if ((atlas.kind === 'tiles' || (atlas.kind === 'environment' && /^\w+\/\d+\/\d+$/.test(name))) && (r.w !== tileWidth || r.h !== tileHeight)) errors.push(`${where} is not a ${tileWidth}x${tileHeight} tile`);
    }
    const sorted = rects.map(([name, r]) => ({ name, ...r })).sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length && sorted[j].y < sorted[i].y + sorted[i].h; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w) errors.push(`${atlas.key}: ${a.name} overlaps ${b.name}`);
      }
    }
  }
  return errors;
}

/** Every shipped image, atlas table and map has a provenance record with hash, generator and license. */
export function validateProvenance(manifest: AssetManifest): string[] {
  const errors: string[] = [];
  const records = new Map<string, ProvenanceRecord>();
  for (const r of manifest.provenance) {
    if (records.has(r.file)) errors.push(`duplicate provenance for ${r.file}`);
    records.set(r.file, r);
    if (!/^[0-9a-f]{64}$/.test(r.sha256)) errors.push(`${r.file} has an invalid sha256`);
    if (!r.license?.trim()) errors.push(`${r.file} has no license`);
    if (!r.source?.trim()) errors.push(`${r.file} has no source`);
    if (!r.generator?.startsWith('assets/source/')) errors.push(`${r.file} generator is not under assets/source`);
  }
  const required = [
    ...Object.values(manifest.atlases).flatMap(a => [a.image, a.data]),
    ...manifest.mapFiles.map(m => m.data),
  ];
  for (const file of required) if (!records.has(file)) errors.push(`${file} has no provenance record`);
  return errors;
}

/** Animations reference existing frames with positive integer durations; actor, effect, icon and layer references resolve. */
export function validateAnimations(manifest: AssetManifest): string[] {
  const errors: string[] = [];
  for (const [key, anim] of Object.entries(manifest.animations)) {
    const atlas = manifest.atlases[anim.atlas];
    if (!atlas) { errors.push(`${key}: unknown atlas ${anim.atlas}`); continue; }
    if (anim.frames.length === 0) errors.push(`${key}: no frames`);
    if (anim.durationsMs.length !== anim.frames.length) errors.push(`${key}: ${anim.frames.length} frames but ${anim.durationsMs.length} durations`);
    for (const d of anim.durationsMs) if (!Number.isInteger(d) || d <= 0) errors.push(`${key}: invalid duration ${d}`);
    for (const f of anim.frames) if (!atlas.frames[f]) errors.push(`${key}: missing frame ${f}`);
  }
  const refs: [string, DirectionalAnimation | undefined][] = [
    ...Object.entries(manifest.actors.gladiator.animations),
    ...manifest.actors.npcs.flatMap(n => Object.entries(n.animations).map(([a, d]) => [`${n.id}/${a}`, d] as [string, DirectionalAnimation | undefined])),
    ...manifest.actors.creatures.flatMap(c => Object.entries(c.animations).map(([a, d]) => [`${c.id}/${a}`, d] as [string, DirectionalAnimation | undefined])),
  ];
  for (const [name, dirs] of refs) {
    if (!dirs) { errors.push(`${name}: missing directional animation`); continue; }
    for (const key of [dirs.se, dirs.ne].filter(Boolean) as string[]) if (!manifest.animations[key]) errors.push(`${name}: unknown animation ${key}`);
  }
  for (const action of manifest.actions) if (!manifest.actors.gladiator.animations[action]) errors.push(`gladiator lacks ${action}`);
  for (const [id, key] of Object.entries(manifest.effects)) if (!manifest.animations[key]) errors.push(`effect ${id}: unknown animation ${key}`);
  for (const [id, frame] of Object.entries(manifest.icons)) if (!manifest.atlases.icons?.frames[frame]) errors.push(`icon ${id}: missing frame ${frame}`);
  const g = manifest.actors.gladiator;
  const gFrames = manifest.atlases[g.atlas]?.frames ?? {};
  for (const name of Object.keys(gFrames).filter(n => n.startsWith('body/'))) {
    for (const layer of g.layers) if (!gFrames[name.replace(/^body\//, `${layer.id}/`)]) errors.push(`layer ${layer.id} lacks ${name}`);
  }
  return errors;
}

const key = (x: number, y: number) => `${x},${y}`;

/** Walkability, ground, props, zones, stations, path graph and expedition routes are consistent and connected. */
export function validateMaps(manifest: AssetManifest): string[] {
  const errors: string[] = [];
  for (const map of manifest.maps) {
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && map.walkable[y][x] === '1';
    const tiles = manifest.atlases[map.tilesAtlas];
    const props = manifest.atlases[map.propsAtlas];
    if (!tiles || !props) { errors.push(`${map.id}: unknown atlas`); continue; }
    if (map.walkable.length !== map.height || map.walkable.some(r => r.length !== map.width)) errors.push(`${map.id}: walkable grid size`);
    if (map.vertices.length !== map.height + 1 || map.vertices.some(r => r.length !== map.width + 1)) errors.push(`${map.id}: vertex grid size`);
    if (map.ground.length !== map.width * map.height) errors.push(`${map.id}: ground size`);
    for (const f of map.groundFrames) if (!tiles.frames[f]) errors.push(`${map.id}: missing ground frame ${f}`);
    if (map.ground.some(i => !Number.isInteger(i) || i < 0 || i >= map.groundFrames.length)) errors.push(`${map.id}: ground index out of range`);
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const v = map.vertices;
        const mask = +v[y][x] + 2 * +v[y][x + 1] + 4 * +v[y + 1][x + 1] + 8 * +v[y + 1][x];
        const frame = map.groundFrames[map.ground[y * map.width + x]];
        if (frame && Number(frame.split('/')[1]) !== mask) { errors.push(`${map.id}: tile ${x},${y} uses ${frame} but corners give ${mask}`); y = map.height; break; }
      }
    }
    for (const p of map.props) {
      if (!props.frames[p.frame]) errors.push(`${map.id}: missing prop frame ${p.frame}`);
      if (p.x < 0 || p.y < 0 || p.x + p.w > map.width || p.y + p.d > map.height) errors.push(`${map.id}: prop ${p.id} outside map`);
      if (!p.walkable) for (let y = p.y; y < p.y + p.d; y += 1) for (let x = p.x; x < p.x + p.w; x += 1) if (at(x, y)) errors.push(`${map.id}: prop ${p.id} footprint ${x},${y} is walkable`);
    }
    for (const l of map.lights) if (l.x < 0 || l.y < 0 || l.x > map.width || l.y > map.height || l.radius <= 0) errors.push(`${map.id}: light outside map`);
    // flood fill from spawn
    const reach = new Set<string>();
    if (!at(map.spawn.x, map.spawn.y)) errors.push(`${map.id}: spawn not walkable`);
    const queue: [number, number][] = [[map.spawn.x, map.spawn.y]];
    while (queue.length) {
      const [x, y] = queue.pop()!;
      if (!at(x, y) || reach.has(key(x, y))) continue;
      reach.add(key(x, y));
      queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    const ids = new Set<string>();
    for (const zone of map.zones) {
      const b = zone.bounds;
      let count = 0;
      for (let y = b.y; y < b.y + b.h; y += 1) for (let x = b.x; x < b.x + b.w; x += 1) if (at(x, y)) count += 1;
      if (count !== zone.walkableTiles) errors.push(`${map.id}/${zone.id}: walkableTiles ${zone.walkableTiles} but ${count} counted`);
      for (const s of zone.stations) {
        if (ids.has(s.id)) errors.push(`${map.id}: duplicate station ${s.id}`);
        ids.add(s.id);
        if (!reach.has(key(s.x, s.y))) errors.push(`${map.id}/${zone.id}: station ${s.id} at ${s.x},${s.y} is not reachable`);
        if (s.x < b.x || s.y < b.y || s.x >= b.x + b.w || s.y >= b.y + b.h) errors.push(`${map.id}/${zone.id}: station ${s.id} outside zone`);
      }
      for (const s of zone.stations) if (s.partner && !zone.stations.some(o => o.id === s.partner)) errors.push(`${map.id}: ${s.id} partner missing`);
    }
    const nodes = new Map(map.paths.nodes.map(n => [n.id, n]));
    for (const n of map.paths.nodes) if (!reach.has(key(n.x, n.y))) errors.push(`${map.id}: path node ${n.id} unreachable`);
    for (const [a, b] of map.paths.edges) {
      const na = nodes.get(a);
      const nb = nodes.get(b);
      if (!na || !nb) { errors.push(`${map.id}: edge ${a}-${b} references a missing node`); continue; }
      const steps = Math.max(1, Math.ceil(Math.hypot(nb.x - na.x, nb.y - na.y) * 3));
      for (let i = 0; i <= steps; i += 1) {
        const x = Math.floor(na.x + 0.5 + ((nb.x - na.x) * i) / steps);
        const y = Math.floor(na.y + 0.5 + ((nb.y - na.y) * i) / steps);
        if (!at(x, y)) { errors.push(`${map.id}: edge ${a}-${b} crosses blocked tile ${x},${y}`); break; }
      }
    }
    const graphSeen = new Set<string>();
    const stack = map.paths.nodes.length ? [map.paths.nodes[0].id] : [];
    while (stack.length) {
      const id = stack.pop()!;
      if (graphSeen.has(id)) continue;
      graphSeen.add(id);
      for (const [a, b] of map.paths.edges) { if (a === id) stack.push(b); if (b === id) stack.push(a); }
    }
    if (graphSeen.size !== map.paths.nodes.length) errors.push(`${map.id}: path graph is not connected`);
    if (map.expedition) {
      const e = map.expedition;
      for (const p of [e.start, e.end, e.safePoint, ...e.route, ...e.searchSpots]) if (!reach.has(key(p.x, p.y))) errors.push(`${map.id}: expedition point ${p.x},${p.y} unreachable`);
      for (const enc of e.encounters) {
        if (!reach.has(key(enc.x, enc.y))) errors.push(`${map.id}: encounter ${enc.index} unreachable`);
        if (!at(enc.enemyX, enc.enemyY)) errors.push(`${map.id}: encounter ${enc.index} enemy tile blocked`);
      }
    }
  }
  return errors;
}
