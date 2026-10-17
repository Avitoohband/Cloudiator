// Pure camp Arena layout: which revealed bouts the camp shows, which sparring ring each one uses and when, and when
// the camp reads an Arena entrant's timeline. Arena entrants warm up in the staging spots (src/game/actors.ts); once
// a bout is revealed, its pair jogs into a free ring and plays the battle log there at the bout's real time (the
// display time minus the logged start) until the bout stage's end, the moment the Arena card shows the result; what
// the bout showed during the short jog-in is skipped, and the full bout stays in the replay. Rings are bounded (the
// map's six ring stations): extra pairs queue in staging and take the next free ring, then show the bout at its real
// position or, when it is already over, its end state. Nothing here simulates a fight, decides a result or reveals a bout
// early: only bouts the stage core shows are scheduled.
import type { BattleLog, RevealedTimeline } from '@contracts/events';
import type { PublicActor } from '@contracts/reads';
import type { Direction, MapData, TilePoint } from './assets';
import type { ArenaFightSide, ArenaFightSummary } from './bridge';
import { REPLAY_OUTRO_MS } from './replay';
import { ARENA_REVEAL_MS, ARENA_SLOT_MS, renderArenaStage } from './arena-stage';

/** Pairs jog into their rings at this multiple of the manifest walk (3 tiles/s at 1 tile/s), stepping as much faster. */
export const ARENA_JOG_PACE = 3;
/** NPC fallback opponents walk in and out through the arena gate, inside the wall. */
export const ARENA_GATE: TilePoint = { x: 27, y: 27 };
/** Jogging time allowed from any staging tile or the arena gate into a ring (the longest jog is about 10.1 tiles, 3.4 s). */
export const ARENA_ENTRY_MS = 4_000;
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
  /**
   * The battle log, or null while a tournament bout's log is still loading (Task 19 R4): the bout is scheduled from its
   * fight summary's times as soon as it is revealed, and its pair stands in the ring until the log arrives.
   */
  readonly log: BattleLog | null;
  /** The authoritative bout start (minute 60). */
  readonly startedAtMs: number;
  /** The bout stage's end: the ring shows the result from here, as the Arena card does. */
  readonly endsAtMs: number;
  /** Camp gladiator ids in participant order; null is an NPC fallback (on either side), which the scene draws itself. */
  readonly fighters: readonly [string | null, string | null];
  /** The activity each side's Arena card opens; the NPC side opens its entrant's. */
  readonly activities: readonly [string, string];
};

/** An Arena bout: its log always comes with the entrant's timeline. */
export type ArenaCampFight = CampFight & { readonly log: BattleLog };

const isArena = (actor: PublicActor) => actor.location === 'arena' && !!actor.activityId;
/** Start, then battle id: the one order in which the camp lists and schedules its fights. */
export const byStart = (p: CampFight, q: CampFight) => p.startedAtMs - q.startedAtMs || (p.battleId < q.battleId ? -1 : p.battleId > q.battleId ? 1 : 0);

/**
 * Revealed bouts of the camp's Arena entrants at the display time. A human pair needs both fighters in the arena;
 * either entrant's timeline is enough, since both carry the same battle. Ordered by start, then battle id.
 */
export function campArenaFights(actors: readonly PublicActor[], timelines: ReadonlyMap<string, RevealedTimeline>, displayNowMs: number): ArenaCampFight[] {
  const entrants = new Map(actors.filter(isArena).map(a => [a.gladiatorId, a]));
  const fights = new Map<string, ArenaCampFight>();
  for (const actor of entrants.values()) {
    const timeline = timelines.get(actor.activityId!);
    if (!timeline) continue;
    const bout = renderArenaStage(timeline, displayNowMs, { entrantId: actor.gladiatorId }).bout;
    if (!bout?.log || !bout.battleId || fights.has(bout.battleId)) continue;
    const ids: readonly [string | null, string | null] = [bout.log.participants[0].gladiatorId, bout.log.participants[1].gladiatorId];
    if (!ids.includes(actor.gladiatorId)) continue;
    if (!ids.every(id => id === null || entrants.has(id)) || ids.every(id => id === null)) continue;
    const activityOf = (id: string | null) => (id ? entrants.get(id)!.activityId! : actor.activityId!);
    fights.set(bout.battleId, {
      battleId: bout.battleId, log: bout.log, startedAtMs: bout.startedAtMs, endsAtMs: bout.endsAtMs,
      fighters: ids, activities: [activityOf(ids[0]), activityOf(ids[1])],
    });
  }
  return [...fights.values()].sort(byStart);
}

export type RingSlot = {
  readonly battleId: string;
  readonly ring: number;
  /** The authoritative bout start: ring playback is always the display time minus this. */
  readonly boutStartMs: number;
  /** The bout stage's end, when the Arena card shows the result. */
  readonly boutEndsAtMs: number;
  readonly enterAtMs: number;
  /** The latest arrival (the jog-in bound); a pair already standing in its ring plays from its arrival. */
  readonly fightStartMs: number;
  readonly leaveAtMs: number;
};

/**
 * Assigns each fight a ring and a window: it enters when its bout starts and a ring is free, plays from its arrival
 * (at the latest after the jog-in), and leaves after the bout stage's end, the outro and the result hold (or, when it
 * arrives after the bout ended, after its arrival and the hold). Fights are planned in start, then battle-id order,
 * whatever order they are given in. `previous` keeps the fights that have entered their ring by `knownAtMs` unchanged,
 * so a late reveal never moves a running fight; fights new to it, and those it still has queued in staging, are
 * planned again after them, in that order and never before `knownAtMs`, so a queue converges on the same order however
 * its fights became known (Task 19 R4).
 */
export function scheduleArenaRings(fights: readonly CampFight[], ringCount: number, options: { previous?: ReadonlyMap<string, RingSlot>; knownAtMs?: number } = {}): Map<string, RingSlot> {
  const schedule = new Map<string, RingSlot>();
  const free = Array.from({ length: ringCount }, () => -Infinity);
  const fresh: CampFight[] = [];
  const entered = options.knownAtMs ?? Infinity;
  for (const fight of [...fights].sort(byStart)) {
    const kept = options.previous?.get(fight.battleId);
    if (kept && kept.ring < ringCount && kept.enterAtMs <= entered) {
      schedule.set(fight.battleId, kept);
      free[kept.ring] = Math.max(free[kept.ring], kept.leaveAtMs);
    } else fresh.push(fight);
  }
  for (const fight of fresh) {
    let ring = 0;
    for (let r = 1; r < ringCount; r += 1) if (free[r] < free[ring]) ring = r;
    const enterAtMs = Math.max(fight.startedAtMs, free[ring], options.knownAtMs ?? -Infinity);
    const fightStartMs = enterAtMs + ARENA_ENTRY_MS;
    const leaveAtMs = Math.max(fightStartMs, fight.endsAtMs + REPLAY_OUTRO_MS) + ARENA_RESULT_HOLD_MS;
    schedule.set(fight.battleId, { battleId: fight.battleId, ring, boutStartMs: fight.startedAtMs, boutEndsAtMs: fight.endsAtMs, enterAtMs, fightStartMs, leaveAtMs });
    free[ring] = leaveAtMs;
  }
  return schedule;
}

/**
 * The camp's ring schedule after its fights changed at display time `nowMs` (camp-scene.ts): the fights still shown keep
 * their rings by `scheduleArenaRings`' rule, and the first fights the camp learns show where their logged times put
 * them. Tournament bouts are fights from their reveal, logs or not, so their logs arriving never changes the schedule.
 */
export function updateRingSchedule(schedule: ReadonlyMap<string, RingSlot>, fights: readonly CampFight[], ringCount: number, nowMs: number): Map<string, RingSlot> {
  const shown = new Set(fights.map(f => f.battleId));
  const kept = new Map([...schedule].filter(([id]) => shown.has(id)));
  return scheduleArenaRings(fights, ringCount, kept.size ? { previous: kept, knownAtMs: nowMs } : {});
}

export type FightStatus = 'queued' | 'entering' | 'fighting' | 'result' | 'done';

/**
 * Where a scheduled fight is at the display time, and the replay position its pair shows. It is fighting only until
 * the bout stage's end, the moment the Arena card shows the result, at the bout's real time (display time minus the
 * logged start), held short of the logged result if the stage ends after the log; from the stage's end it shows the
 * logged result and its outro. `arrived` (both fighters stand in the ring) ends the jog-in before its bound.
 */
export function fightStatus(slot: RingSlot, durationMs: number, t: number, arrived = false): { status: FightStatus; positionMs: number } {
  const ended = durationMs + Math.min(REPLAY_OUTRO_MS, Math.max(0, t - slot.boutEndsAtMs));
  if (t < slot.enterAtMs) return { status: 'queued', positionMs: 0 };
  if (t < slot.fightStartMs && !arrived) return { status: 'entering', positionMs: 0 };
  if (t < slot.boutEndsAtMs) return { status: 'fighting', positionMs: Math.min(durationMs - 1, Math.max(0, t - slot.boutStartMs)) };
  if (t < slot.leaveAtMs) return { status: 'result', positionMs: ended };
  return { status: 'done', positionMs: ended };
}

/**
 * The keyboard button for a ring fight: the gladiator first and an NPC fallback second (marked), whichever side of
 * the log the NPC is on; it opens the gladiator's Arena card (an NPC side opens its entrant's activity anyway).
 */
export function arenaFightButton(fight: ArenaFightSummary): { label: string; entrant: ArenaFightSide } {
  const [first, second] = fight.sides[0].npc && !fight.sides[1].npc ? [fight.sides[1], fight.sides[0]] : fight.sides;
  return { label: `${first.name} vs ${second.name}${second.npc ? ' (NPC)' : ''}`, entrant: first };
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
