// Pure camp Arena layout: which revealed bouts the camp shows, which sparring ring each one uses and when, and when
// the camp reads an Arena entrant's timeline. Arena entrants warm up in the staging spots (src/game/actors.ts); once
// a bout is revealed, its pair walks into a free ring, fights from the battle log and returns to staging. Rings are
// bounded (the map's six ring stations): extra pairs queue in staging and take the next free ring, so their camp
// animation starts later than the authoritative bout (the Arena card and replay keep the logged times). Nothing
// here simulates a fight, decides a result or reveals a bout early: only bouts the stage core shows are scheduled.
import type { BattleLog, RevealedTimeline } from '@contracts/events';
import type { PublicActor } from '@contracts/reads';
import type { Direction, MapData } from './assets';
import { REPLAY_OUTRO_MS } from './replay';
import { ARENA_REVEAL_MS, ARENA_SLOT_MS, renderArenaStage } from './arena-stage';

/** Walking time allowed from any staging tile into a ring (the longest walk is about 10 s at 1 tile/s). */
export const ARENA_ENTRY_MS = 11_000;
/** The victory and defeat poses stay this long after the replay outro before the pair leaves the ring. */
export const ARENA_RESULT_HOLD_MS = 6_000;
/** A missing bout is asked for again this often while its slot runs. */
export const ARENA_RETRY_MS = 30_000;

export type RingSpot = { id: string; x: number; y: number; facing: Direction };
/** `a` (facing se) holds participant 0 and `b` (facing sw) participant 1; b is one tile east and north of a. */
export type ArenaRing = { index: number; a: RingSpot; b: RingSpot };

/** The camp map's sparring rings, in station order. */
export function arenaRings(map: MapData): ArenaRing[] {
  const stations = map.zones.find(z => z.id === 'arena')?.stations ?? [];
  const rings: ArenaRing[] = [];
  for (const a of stations) {
    if (a.kind !== 'arena-ring' || a.facing !== 'se' || !a.partner) continue;
    const b = stations.find(s => s.id === a.partner);
    if (!b) continue;
    rings.push({ index: rings.length, a: { id: a.id, x: a.x, y: a.y, facing: 'se' }, b: { id: b.id, x: b.x, y: b.y, facing: 'sw' } });
  }
  return rings;
}

/** Ring tiles, kept free of staging so a pair can always step in. */
export function ringTiles(map: MapData): Set<string> {
  return new Set(arenaRings(map).flatMap(r => [`${r.a.x},${r.a.y}`, `${r.b.x},${r.b.y}`]));
}

export type CampFight = {
  readonly battleId: string;
  readonly log: BattleLog;
  /** The authoritative bout start (minute 60). */
  readonly startedAtMs: number;
  /** Camp gladiator ids in participant order; null is an NPC fallback, which the scene draws itself. */
  readonly fighters: readonly [string, string | null];
  /** The activity each side's Arena card opens; the NPC side opens its entrant's. */
  readonly activities: readonly [string, string];
};

const isArena = (actor: PublicActor) => actor.location === 'arena' && !!actor.activityId;

/**
 * Revealed bouts of the camp's Arena entrants at the display time. A human pair needs both fighters in the arena;
 * either entrant's timeline is enough, since both carry the same battle. Ordered by start, then battle id.
 */
export function campArenaFights(actors: readonly PublicActor[], timelines: ReadonlyMap<string, RevealedTimeline>, displayNowMs: number): CampFight[] {
  const entrants = new Map(actors.filter(isArena).map(a => [a.gladiatorId, a]));
  const fights = new Map<string, CampFight>();
  for (const actor of entrants.values()) {
    const timeline = timelines.get(actor.activityId!);
    if (!timeline) continue;
    const bout = renderArenaStage(timeline, displayNowMs, { entrantId: actor.gladiatorId }).bout;
    if (!bout?.log || !bout.battleId || fights.has(bout.battleId)) continue;
    const ids = bout.log.participants.map(p => p.gladiatorId) as [string | null, string | null];
    if (!ids.includes(actor.gladiatorId)) continue;
    if (!ids.every(id => id === null || entrants.has(id)) || ids.every(id => id === null)) continue;
    const activityOf = (id: string | null) => (id ? entrants.get(id)!.activityId! : actor.activityId!);
    fights.set(bout.battleId, {
      battleId: bout.battleId, log: bout.log, startedAtMs: bout.startedAtMs,
      fighters: ids as [string, string | null], activities: [activityOf(ids[0]), activityOf(ids[1])],
    });
  }
  return [...fights.values()].sort((p, q) => p.startedAtMs - q.startedAtMs || (p.battleId < q.battleId ? -1 : p.battleId > q.battleId ? 1 : 0));
}

export type RingSlot = { readonly battleId: string; readonly ring: number; readonly enterAtMs: number; readonly fightStartMs: number; readonly leaveAtMs: number };

/**
 * Assigns each fight a ring and a window: it enters when its bout starts and a ring is free, starts fighting after
 * the walk-in, and leaves after the result poses. `previous` keeps already scheduled fights unchanged; fights new to
 * it go after them and never before `knownAtMs`, so a late reveal never moves a running fight.
 */
export function scheduleArenaRings(fights: readonly CampFight[], ringCount: number, options: { previous?: ReadonlyMap<string, RingSlot>; knownAtMs?: number } = {}): Map<string, RingSlot> {
  const schedule = new Map<string, RingSlot>();
  const free = Array.from({ length: ringCount }, () => -Infinity);
  const fresh: CampFight[] = [];
  for (const fight of fights) {
    const kept = options.previous?.get(fight.battleId);
    if (kept && kept.ring < ringCount) {
      schedule.set(fight.battleId, kept);
      free[kept.ring] = Math.max(free[kept.ring], kept.leaveAtMs);
    } else fresh.push(fight);
  }
  for (const fight of fresh) {
    let ring = 0;
    for (let r = 1; r < ringCount; r += 1) if (free[r] < free[ring]) ring = r;
    const enterAtMs = Math.max(fight.startedAtMs, free[ring], options.knownAtMs ?? -Infinity);
    const fightStartMs = enterAtMs + ARENA_ENTRY_MS;
    const leaveAtMs = fightStartMs + fight.log.durationMs + REPLAY_OUTRO_MS + ARENA_RESULT_HOLD_MS;
    schedule.set(fight.battleId, { battleId: fight.battleId, ring, enterAtMs, fightStartMs, leaveAtMs });
    free[ring] = leaveAtMs;
  }
  return schedule;
}

export type FightStatus = 'queued' | 'entering' | 'fighting' | 'result' | 'done';

/** Where a scheduled fight is at the display time, and the replay position its pair shows. */
export function fightStatus(slot: RingSlot, durationMs: number, t: number): { status: FightStatus; positionMs: number } {
  const positionMs = Math.min(durationMs + REPLAY_OUTRO_MS, Math.max(0, t - slot.fightStartMs));
  if (t < slot.enterAtMs) return { status: 'queued', positionMs: 0 };
  if (t < slot.fightStartMs) return { status: 'entering', positionMs: 0 };
  if (t < slot.fightStartMs + durationMs) return { status: 'fighting', positionMs };
  if (t < slot.leaveAtMs) return { status: 'result', positionMs };
  return { status: 'done', positionMs };
}

export type ArenaRead = { readAtMs: number; hasBout: boolean };

/**
 * Arena activities whose timeline the camp should read now: an entrant in the arena whose bout is not known, once
 * minute 60 has passed (or at once when its public stage already shows the bout), again every 30 s while the bout
 * is missing, and never after its slot ends. In-camp actors only; at most one read per activity at a time.
 */
export function arenaReadsDue(actors: readonly PublicActor[], known: ReadonlyMap<string, ArenaRead>, displayNowMs: number): string[] {
  const due: string[] = [];
  for (const actor of actors) {
    if (!isArena(actor) || actor.startsAtMs === null) continue;
    const read = known.get(actor.activityId!);
    if (read?.hasBout) continue;
    const shown = actor.visibleStage?.kind === 'bout' || actor.visibleStage?.kind === 'return';
    if (!shown && displayNowMs < actor.startsAtMs + ARENA_REVEAL_MS) continue;
    if (displayNowMs >= actor.startsAtMs + ARENA_SLOT_MS) continue;
    if (read && displayNowMs - read.readAtMs < ARENA_RETRY_MS) continue;
    due.push(actor.activityId!);
  }
  return due;
}
