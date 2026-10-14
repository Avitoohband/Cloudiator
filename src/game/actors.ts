// Turns public world actors into deterministic, locally animated camp routines.
// Everything here derives from (gladiatorId, slotIndex); no rewards or private data are involved.
import type { PublicActor } from '@contracts/reads';
import type { ActionId, Direction, MapData, MapStation } from './assets';

export type RoutineKind = 'training' | 'rest' | 'arena' | 'tournament' | 'away' | 'orientation' | 'idle';
export type ZoneId = 'training' | 'rest' | 'arena' | 'merchants' | 'expedition-gate';
export type Variant = 'weights' | 'practice' | 'spar' | 'sit' | 'eat' | 'sleep' | 'arena-staging' | 'arena-ring' | 'browse';

export type ActorRoutine = {
  gladiatorId: string;
  kind: RoutineKind;
  zone: ZoneId | null;
  variant: Variant | null;
  /** Animation phase offset so neighbours never loop in sync. */
  offsetMs: number;
  tint: { skin: number; cloth: number; hair: number };
  /** Gladiator layer ids to draw, in manifest order. */
  layers: string[];
};

export type Placement = {
  gladiatorId: string;
  zone: ZoneId;
  x: number;
  y: number;
  facing: Direction;
  action: ActionId;
  stationId: string | null;
  partnerId?: string;
  routine: ActorRoutine;
};

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Contract CampLocation ids ('camp' means idling about camp), with a keyword fallback for older display labels. */
export function locationKind(location: string): RoutineKind {
  const l = location.toLowerCase();
  if (l.startsWith('expedition')) return 'away';
  if (l === 'training' || /train|practice|yard/.test(l)) return 'training';
  if (l === 'rest' || /rest|sleep|quarters/.test(l)) return 'rest';
  if (l === 'tournament' || /tournament/.test(l)) return 'tournament';
  if (l === 'arena' || /arena/.test(l)) return 'arena';
  if (l === 'orientation' || /orientation|arriv/.test(l)) return 'orientation';
  return 'idle';
}

const ZONE_FOR: Record<RoutineKind, ZoneId | null> = {
  training: 'training', rest: 'rest', arena: 'arena', tournament: 'arena', away: null, orientation: 'expedition-gate', idle: 'merchants',
};
const VARIANTS: Record<RoutineKind, [Variant, number][]> = {
  training: [['weights', 40], ['practice', 35], ['spar', 25]],
  rest: [['sit', 35], ['eat', 30], ['sleep', 35]],
  // Regular Arena entrants warm up in staging; a revealed bout moves its real pair into a ring (src/game/arena-layout.ts).
  arena: [['arena-staging', 1]],
  tournament: [['arena-staging', 75], ['arena-ring', 25]],
  away: [],
  orientation: [['browse', 1]],
  idle: [['browse', 1]],
};
const ACTION_FOR: Record<Variant, ActionId> = {
  weights: 'weights', practice: 'practice', spar: 'spar', sit: 'sit', eat: 'eat', sleep: 'sleep',
  'arena-staging': 'idle', 'arena-ring': 'spar', browse: 'idle',
};

/** Player colours: tinted over the grey cloth and hair layers (multiply). */
export const CLOTH_TINTS = [0x22a39d, 0xbd3429, 0xf2b43d, 0x6a4fb8, 0x3c7fd0, 0x4e8d3b, 0xe0702a, 0xf4e8cb, 0x4b4b55, 0xa8693a, 0xd9608c, 0x8edcf4];
export const HAIR_TINTS = [0x5a3418, 0x2a2024, 0xb8742f, 0xe6c06a, 0x9a9a9a, 0x8a3324];
/** Multiplied over the light base skin: light, tan, olive, brown, deep brown. */
export const SKIN_TINTS = [0xffffff, 0xeac3a0, 0xcf9a74, 0x9f6e4c, 0x7a5038];

/** Must equal manifest.equipmentLayers (tested). Catalog template id to layer id. */
export const EQUIPMENT_LAYERS: Record<string, string | null> = {
  sword: 'weapon-sword', axe: 'weapon-axe', spear: 'weapon-spear', bow: 'weapon-bow', 'round-shield': 'offhand-shield',
  'leather-hood': 'head-hood', 'iron-helmet': 'head-helmet', 'light-armor': 'armor-light', 'heavy-armor': 'armor-heavy',
  'light-boots': null, 'heavy-boots': null,
};

const LAYER_ORDER = ['body', 'cloth', 'hair', 'armor-light', 'armor-heavy', 'accent', 'head-hood', 'head-helmet', 'head-helmet-crest', 'weapon-sword', 'weapon-axe', 'weapon-spear', 'weapon-bow', 'offhand-shield', 'held'];

/**
 * Accepts public silhouettes (layer ids such as 'weapon-sword'), catalog variant ids ('sword:1:common')
 * or template ids ('sword'). Boots ('feet-light', 'light-boots') have no layer.
 */
export function equipmentLayer(silhouette: string): string | null {
  if (LAYER_ORDER.includes(silhouette)) return silhouette;
  return EQUIPMENT_LAYERS[silhouette.split(':')[0]] ?? null;
}

export function layersFor(silhouettes: readonly string[]): string[] {
  const mapped = new Set(silhouettes.map(equipmentLayer).filter((id): id is string => !!id));
  const has = (id: string) => mapped.has(id);
  const weapon = ['weapon-sword', 'weapon-axe', 'weapon-spear', 'weapon-bow'].find(has);
  const armor = has('armor-heavy') ? 'armor-heavy' : has('armor-light') ? 'armor-light' : null;
  const head = has('head-helmet') ? 'head-helmet' : has('head-hood') ? 'head-hood' : null;
  const twoHanded = weapon === 'weapon-spear' || weapon === 'weapon-bow';
  const wanted = new Set(['body', 'cloth', 'accent', 'held']);
  if (!head) wanted.add('hair');
  if (head === 'head-helmet') wanted.add('head-helmet-crest');
  for (const id of [weapon, armor, head]) if (id) wanted.add(id);
  if (has('offhand-shield') && !twoHanded) wanted.add('offhand-shield');
  return LAYER_ORDER.filter(id => wanted.has(id));
}

function pick<T>(options: [T, number][], roll: number): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let left = roll % total;
  for (const [value, weight] of options) {
    if (left < weight) return value;
    left -= weight;
  }
  return options[options.length - 1][0];
}

/** A player's colours, from their gladiator id alone, so they look the same in camp and in replays. */
export function tintFor(gladiatorId: string): ActorRoutine['tint'] {
  const look = hashString(gladiatorId);
  return { skin: SKIN_TINTS[(look >>> 11) % SKIN_TINTS.length], cloth: CLOTH_TINTS[look % CLOTH_TINTS.length], hair: HAIR_TINTS[(look >>> 5) % HAIR_TINTS.length] };
}

export function planActorRoutine(actor: PublicActor, slotIndex: number): ActorRoutine {
  const kind = locationKind(actor.location);
  const seed = hashString(`${actor.gladiatorId}/${slotIndex}`);
  const variants = VARIANTS[kind];
  return {
    gladiatorId: actor.gladiatorId,
    kind,
    zone: ZONE_FOR[kind],
    variant: variants.length ? pick(variants, seed >>> 8) : null,
    offsetMs: seed % 12_007,
    tint: tintFor(actor.gladiatorId),
    layers: layersFor(actor.equipmentSilhouettes),
  };
}

const FALLBACK: Record<ZoneId, Variant[]> = {
  training: ['weights', 'practice', 'spar'],
  rest: ['sleep', 'sit', 'eat'],
  arena: ['arena-staging', 'arena-ring'],
  merchants: ['browse'],
  'expedition-gate': ['browse'],
};
const OVERFLOW_ACTION: Record<ZoneId, ActionId> = { training: 'weights', rest: 'sleep', arena: 'idle', merchants: 'idle', 'expedition-gate': 'idle' };
const PAIRED = new Set<Variant>(['spar', 'arena-ring']);

/** Stations a variant can use; gate departure spots double as orientation spots. */
function stationMatches(station: MapStation, variant: Variant): boolean {
  if (variant === 'browse') return station.kind === 'browse' || station.kind === 'depart';
  return station.kind === variant;
}

/**
 * Free walkable tiles of a zone, excluding NPC posts and, for the arena, everything outside the wall and the
 * sparring-ring tiles, which stay free for revealed bouts.
 */
function freeTiles(map: MapData, zoneId: ZoneId, taken: Set<string>): { x: number; y: number }[] {
  const zone = map.zones.find(z => z.id === zoneId)!;
  const rings = zoneId === 'arena' ? new Set(zone.stations.filter(s => s.kind === 'arena-ring').map(s => `${s.x},${s.y}`)) : null;
  const tiles: { x: number; y: number }[] = [];
  const { x: bx, y: by, w, h } = zone.bounds;
  for (let y = by; y < by + h; y += 1) for (let x = bx; x < bx + w; x += 1) {
    if (map.walkable[y]?.[x] !== '1' || taken.has(`${x},${y}`) || rings?.has(`${x},${y}`)) continue;
    if (zoneId === 'arena' && map.arena && Math.hypot(x + 0.5 - map.arena.centre[0], y + 0.5 - map.arena.centre[1]) > map.arena.radius - 1.1) continue;
    tiles.push({ x, y });
  }
  return tiles;
}

/**
 * Assign every visible actor a unique tile in its zone. Sparring variants are placed as
 * face-to-face pairs; when stations run out, actors fill free zone tiles.
 */
export type LayoutOptions = {
  /** Tiles players must not use (NPC posts). */
  reserved?: Iterable<string>;
  /** The previous layout: unchanged actors keep their spots when others arrive or leave. */
  previous?: Map<string, Placement>;
};

export function layoutCamp(actors: PublicActor[], map: MapData, slotIndex: number, options: LayoutOptions = {}): { placements: Map<string, Placement>; away: PublicActor[] } {
  const placements = new Map<string, Placement>();
  const away: PublicActor[] = [];
  const taken = new Set<string>(options.reserved ?? []);
  const usedStations = new Set<string>();
  for (const zone of map.zones) for (const s of zone.stations) if (s.npc) taken.add(`${s.x},${s.y}`);
  const routines = actors.map(a => planActorRoutine(a, slotIndex));
  // Keep previous spots for actors whose zone and variant did not change (and pairs whose partner stays).
  const previous = options.previous;
  const kept = new Set<string>();
  if (previous) {
    const byId = new Map(routines.map(r => [r.gladiatorId, r]));
    for (const [id, prev] of previous) {
      const routine = byId.get(id);
      if (!routine || routine.zone !== prev.zone || prev.routine.variant !== routine.variant || taken.has(`${prev.x},${prev.y}`)) continue;
      if (prev.partnerId) {
        const partner = previous.get(prev.partnerId);
        const partnerRoutine = byId.get(prev.partnerId);
        if (!partner || !partnerRoutine || partnerRoutine.zone !== partner.zone || partner.routine.variant !== partnerRoutine.variant) continue;
      }
      kept.add(id);
      taken.add(`${prev.x},${prev.y}`);
      if (prev.stationId) usedStations.add(prev.stationId);
      placements.set(id, { ...prev, routine });
    }
    // A pair stays together or not at all.
    for (const id of [...kept]) {
      const partnerId = placements.get(id)?.partnerId;
      if (partnerId && !kept.has(partnerId)) {
        const p = placements.get(id)!;
        kept.delete(id);
        placements.delete(id);
        taken.delete(`${p.x},${p.y}`);
        if (p.stationId) usedStations.delete(p.stationId);
      }
    }
  }
  const order = routines
    .map((routine, i) => ({ routine, actor: actors[i], rank: hashString(`${routine.gladiatorId}#${slotIndex}`) }))
    .sort((a, b) => a.rank - b.rank || a.routine.gladiatorId.localeCompare(b.routine.gladiatorId));

  const place = (routine: ActorRoutine, zone: ZoneId, x: number, y: number, facing: Direction, action: ActionId, stationId: string | null, partnerId?: string) => {
    taken.add(`${x},${y}`);
    if (stationId) usedStations.add(stationId);
    placements.set(routine.gladiatorId, { gladiatorId: routine.gladiatorId, zone, x, y, facing, action, stationId, ...(partnerId ? { partnerId } : {}), routine });
  };
  const stationsOf = (zone: ZoneId) => map.zones.find(z => z.id === zone)!.stations.filter(s => !s.npc);
  const placeSolo = (routine: ActorRoutine, zone: ZoneId, preferred: Variant) => {
    const options = [preferred, ...FALLBACK[zone].filter(v => v !== preferred && !PAIRED.has(v))];
    for (const variant of options) {
      const station = stationsOf(zone).find(s => !s.partner && stationMatches(s, variant) && !usedStations.has(s.id) && !taken.has(`${s.x},${s.y}`));
      if (station) { place(routine, zone, station.x, station.y, station.facing, ACTION_FOR[variant], station.id); return; }
    }
    const tile = freeTiles(map, zone, taken)[0];
    if (!tile) return false;
    place(routine, zone, tile.x, tile.y, (routine.offsetMs & 1) === 0 ? 'se' : 'sw', OVERFLOW_ACTION[zone], null);
    return true;
  };

  const pending = new Map<ZoneId, { routine: ActorRoutine; variant: Variant }[]>();
  for (const { routine, actor } of order) {
    if (kept.has(routine.gladiatorId)) continue;
    if (!routine.zone) { away.push(actor); continue; }
    const variant = routine.variant!;
    if (PAIRED.has(variant)) {
      const list = pending.get(routine.zone) ?? [];
      list.push({ routine, variant });
      pending.set(routine.zone, list);
    } else {
      placeSolo(routine, routine.zone, variant);
    }
  }
  for (const [zone, list] of pending) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const [a, b] = [list[i], list[i + 1]];
      const station = stationsOf(zone).find(s => s.partner && stationMatches(s, a.variant) && s.facing === 'se' && !usedStations.has(s.id) && !taken.has(`${s.x},${s.y}`));
      const partner = station && stationsOf(zone).find(s => s.id === station.partner);
      if (station && partner && !taken.has(`${partner.x},${partner.y}`)) {
        place(a.routine, zone, station.x, station.y, 'se', ACTION_FOR[a.variant], station.id, b.routine.gladiatorId);
        place(b.routine, zone, partner.x, partner.y, 'sw', ACTION_FOR[b.variant], partner.id, a.routine.gladiatorId);
        continue;
      }
      const free = freeTiles(map, zone, taken);
      const spot = free.find(t => free.some(u => u.x === t.x + 1 && u.y === t.y - 1));
      if (spot) {
        place(a.routine, zone, spot.x, spot.y, 'se', ACTION_FOR[a.variant], null, b.routine.gladiatorId);
        place(b.routine, zone, spot.x + 1, spot.y - 1, 'sw', ACTION_FOR[b.variant], null, a.routine.gladiatorId);
        continue;
      }
      placeSolo(a.routine, zone, FALLBACK[zone][0]);
      placeSolo(b.routine, zone, FALLBACK[zone][0]);
    }
    if (list.length % 2 === 1) placeSolo(list[list.length - 1].routine, zone, FALLBACK[zone][0]);
  }
  return { placements, away };
}
