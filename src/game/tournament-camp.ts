// Pure camp tournament layout. During a tournament slot its entrants (public location `tournament`) stand in the
// arena: they wait in the staging spots, fight their revealed bouts in Task 17's sparring rings (the same CampFight
// shape, ring schedule and seek rule as regular Arena bouts, so no second arena layout), and once eliminated watch from
// spectator spots around the outside of the arena wall. The champion is marked once the final has ended. Everything
// comes from the public TournamentView through the stage core's reveal rule (a bout appears only when published and
// its round's reveal time has passed); nothing here simulates a fight, decides a result or adds an actor. Polled views
// carry no battle logs (Task 19 phase 2b review I1): a revealed bout is staged from its fight summary at once, so the
// ring schedule never depends on the order its logs load in (Task 19 R4), and the camp asks for the log of a staged bout
// only while its ring window is current or about to start (`tournamentLogsDue`), once, merging it in with the stage
// core's `withTournamentLogs`.
import type { PublicActor, TournamentView } from '@contracts/reads';
import type { Direction, MapData } from './assets';
import { ARENA_ENTRY_MS, ARENA_RESULT_HOLD_MS, byStart, type CampFight, type RingSlot } from './arena-layout';
import { RULES_V1 } from '@domain/rules-v1';
import { tournamentLookupIdOrNull } from '../lib/tournament-id';
import { TOURNAMENT_RETRY_MS, processingRetryDelay, renderTournament, type TournamentRole } from './tournament-stage';

/** A failed tournament read is asked for again this often while its slot runs (processing re-reads back off). */
export { TOURNAMENT_RETRY_MS };
const SLOT_MS = RULES_V1.clock.slotMs;

const isEntrant = (actor: PublicActor) => actor.location === 'tournament' && actor.startsAtMs !== null && !!actor.activityId;
/**
 * The tournament an entrant is in: its league's tournament of the slot its activity started in. Null when its slot or
 * league cannot name one (2b review M3): that actor then has no tournament, and the camp carries on without throwing.
 */
export function tournamentIdOfActor(actor: PublicActor): string | null {
  return tournamentLookupIdOrNull(Math.floor(Number(actor.startsAtMs) / SLOT_MS), actor.league);
}
function entrantsByTournament(actors: readonly PublicActor[]): Map<string, Map<string, PublicActor>> {
  const groups = new Map<string, Map<string, PublicActor>>();
  for (const actor of actors.filter(isEntrant)) {
    const id = tournamentIdOfActor(actor);
    if (id === null) continue;
    const group = groups.get(id) ?? new Map<string, PublicActor>();
    group.set(actor.gladiatorId, actor);
    groups.set(id, group);
  }
  return groups;
}
/**
 * The tournaments with at least one entrant in camp. The camp keeps only their views (and the logs of their bouts):
 * once a tournament's entrants have left (their slot is over), it forgets the view (Task 20 review minor 4).
 */
export function campTournamentIds(actors: readonly PublicActor[]): Set<string> {
  return new Set(entrantsByTournament(actors).keys());
}

/** Arena and tournament fights together, in start then battle-id order (as `campArenaFights` orders its own). */
export function mergeCampFights(...lists: readonly (readonly CampFight[])[]): CampFight[] {
  return lists.flat().sort(byStart);
}

/**
 * Revealed tournament bouts between two entrants in camp at the display time, from their round's reveal time on
 * (fighting or already decided, so a later round never reschedules an earlier fight), with or without their log: the
 * polled fight summary times a bout, so it is scheduled the moment it is revealed and its log attaches when it loads
 * (Task 19 R4). The bout id is its battle id (Task 19). Participant 0 takes ring side a: the log's order, which the
 * published result also follows (10-tournament-results.sql). A bout ends where the stage core decides it (its logged
 * duration after the reveal), the moment the Tournaments panel shows its winner, so its ring shows the result from then too.
 */
export function campTournamentFights(actors: readonly PublicActor[], views: ReadonlyMap<string, TournamentView>, displayNowMs: number): CampFight[] {
  const fights: CampFight[] = [];
  for (const [id, entrants] of entrantsByTournament(actors)) {
    const view = views.get(id);
    if (!view) continue;
    for (const bout of renderTournament(view, displayNowMs).rounds.flatMap(r => r.bouts)) {
      if ((bout.status !== 'fighting' && bout.status !== 'decided') || bout.fightEndsAtMs === null) continue;
      const ids = bout.log ? bout.log.participants.map(p => p.gladiatorId) : bout.sides.map(side => side?.gladiatorId ?? null);
      if (ids.length !== 2 || !ids.every(g => g !== null && entrants.has(g))) continue;
      const [a, b] = ids as [string, string];
      fights.push({ battleId: bout.id, log: bout.log, startedAtMs: bout.revealAtMs, endsAtMs: bout.fightEndsAtMs, fighters: [a, b],
        activities: [entrants.get(a)!.activityId!, entrants.get(b)!.activityId!] });
    }
  }
  return fights.sort(byStart);
}

export type CampTournamentRole = { readonly role: TournamentRole; readonly eliminatedInRound: number | null };
/** Each camp entrant's role at the display time (only entrants whose tournament view is known). */
export function campTournamentRoles(actors: readonly PublicActor[], views: ReadonlyMap<string, TournamentView>, displayNowMs: number): Map<string, CampTournamentRole> {
  const roles = new Map<string, CampTournamentRole>();
  for (const [id, entrants] of entrantsByTournament(actors)) {
    const view = views.get(id);
    if (!view) continue;
    for (const e of renderTournament(view, displayNowMs).entrants) {
      if (e.role && entrants.has(e.gladiatorId)) roles.set(e.gladiatorId, { role: e.role, eliminatedInRound: e.eliminatedInRound });
    }
  }
  return roles;
}

export type SpectatorSpot = { readonly x: number; readonly y: number; readonly facing: Direction };
/**
 * Free walkable tiles in a band just outside the arena wall, facing the arena: none on a station, an NPC post
 * (`reserved`), another zone or the gate approach. Sides first (they hide no fight), then behind the arena, then in
 * front of it, nearest the wall first.
 */
export function spectatorSpots(map: MapData, reserved: Iterable<string> = []): SpectatorSpot[] {
  if (!map.arena) return [];
  const [cx, cy] = map.arena.centre;
  const { radius } = map.arena;
  const blocked = new Set<string>([...reserved, ...map.zones.flatMap(z => z.stations.map(s => `${s.x},${s.y}`))]);
  const others = map.zones.filter(z => z.id !== 'arena').map(z => z.bounds);
  // The gate opens to the south-east, where the posts stand on the wall circle at 45°.
  const gate = { x: cx + (radius + 1.5) * Math.SQRT1_2, y: cy + (radius + 1.5) * Math.SQRT1_2 };
  const spots: (SpectatorSpot & { band: number; d: number; angle: number })[] = [];
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (map.walkable[y]?.[x] !== '1' || d <= radius + 0.6 || d > radius + 2.6 || blocked.has(`${x},${y}`)) continue;
    if (others.some(b => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h)) continue;
    if (Math.hypot(x + 0.5 - gate.x, y + 0.5 - gate.y) < 2.5) continue;
    const vertical = x + y - (cx + cy);
    const left = x - y < cx - cy;
    const facing: Direction = vertical < 0 ? (left ? 'se' : 'sw') : (left ? 'ne' : 'nw');
    spots.push({ x, y, facing, band: Math.abs(vertical) <= 2 ? 0 : vertical < 0 ? 1 : 2, d, angle: Math.atan2(y + 0.5 - cy, x + 0.5 - cx) });
  }
  return spots.sort((p, q) => p.band - q.band || p.d - q.d || p.angle - q.angle).map(({ x, y, facing }) => ({ x, y, facing }));
}

/**
 * Spectator spots by elimination round, then gladiator id: earlier spectators keep their spots when later rounds add
 * more. Spectators beyond the spots stay at their staging spot.
 */
export function assignSpectators(spectators: readonly { gladiatorId: string; eliminatedInRound: number | null }[], spots: readonly SpectatorSpot[]): Map<string, SpectatorSpot> {
  const order = [...spectators].sort((a, b) => (a.eliminatedInRound ?? 0) - (b.eliminatedInRound ?? 0) || (a.gladiatorId < b.gladiatorId ? -1 : a.gladiatorId > b.gladiatorId ? 1 : 0));
  return new Map(order.slice(0, spots.length).map((s, i) => [s.gladiatorId, spots[i]]));
}

/**
 * The camp's last read of one tournament: when it was asked (display time), the latest view it has (a failed read keeps
 * the previous one) and how many reads in a row found it processing, which sets the processing back-off.
 */
export type TournamentRead = { readAtMs: number; view: TournamentView | null; processingReads?: number };
/** The record after a read at `readAtMs` answered `view` (null: the read failed). */
export function recordTournamentRead(previous: TournamentRead | undefined, view: TournamentView | null, readAtMs: number): TournamentRead {
  if (!view) return { readAtMs, view: previous?.view ?? null, processingReads: previous?.processingReads ?? 0 };
  const processing = renderTournament(view, readAtMs).status === 'processing';
  return { readAtMs, view, processingReads: processing ? (previous?.processingReads ?? 0) + 1 : 0 };
}
/**
 * Tournaments the camp should read now: each tournament with an entrant in camp during its slot, once; again when a
 * reveal mark (a round, the settlement) has passed since the last read; every 30 s while the read failed; and, while a
 * due round is unpublished (processing), after 30 s, 60 s, 120 s, 240 s and then every 5 minutes, back to 30 s once
 * a read is no longer processing (2b review I1). `focused` (the tab has just become visible) re-reads a processing
 * tournament at once. Never before the start or after the slot; hidden tabs do not call this.
 */
export function tournamentReadsDue(actors: readonly PublicActor[], known: ReadonlyMap<string, TournamentRead>, displayNowMs: number,
  options: { focused?: boolean } = {}): string[] {
  const due: string[] = [];
  for (const [id, entrants] of entrantsByTournament(actors)) {
    const start = [...entrants.values()][0].startsAtMs!;
    if (displayNowMs < start || displayNowMs >= start + SLOT_MS) continue;
    const read = known.get(id);
    if (!read) { due.push(id); continue; }
    const waited = displayNowMs - read.readAtMs;
    if (!read.view) { if (waited >= TOURNAMENT_RETRY_MS) due.push(id); continue; }
    const passed = renderTournament(read.view, read.readAtMs).revealMarks.some(mark => mark <= displayNowMs);
    const processing = renderTournament(read.view, displayNowMs).status === 'processing';
    const backoff = processingRetryDelay(Math.max(0, (read.processingReads ?? 0) - 1));
    if (passed || (processing && (options.focused || waited >= backoff))) due.push(id);
  }
  return due;
}

/** The first wait before a failed ring log is asked for again (Task 23.4, C9). */
export const TOURNAMENT_LOG_RETRY_MS = 2_000;
/**
 * The wait before asking again for a ring log that failed `failures` times in a row: 2 s, then 4, 8 and 16 s, and never
 * more than 30 s (Task 23.4, C9; it was 30 s from the first failure, so a pair stood idle in its ring for most of a bout).
 * The scene stages the bout from its fight summary meanwhile, so a retry only brings the pair's moves.
 */
export function ringLogRetryDelay(failures: number): number {
  const n = Number.isFinite(failures) && failures > 1 ? Math.floor(failures) - 1 : 0;
  return Math.min(TOURNAMENT_RETRY_MS, TOURNAMENT_LOG_RETRY_MS * 2 ** Math.min(n, 10));
}

/**
 * How far ahead the camp asks for the log of a bout queued for a ring: the shortest ring window (the jog-in and the
 * result hold), so each ring asks for at most its current bout and the next one.
 */
export const TOURNAMENT_LOG_WINDOW_MS = ARENA_ENTRY_MS + ARENA_RESULT_HOLD_MS;

/**
 * Bouts of `view` whose battle log the camp should load now (the Task 19 live-camp gate): each bout the camp has given
 * a ring window (`rings`, the scene's ring schedule) that is current, or starts within `windowMs`, and that has no log
 * yet, soonest window first. Pass the view with the loaded logs merged in, so a loaded log is never asked for again. A
 * bout whose window has ended, or starts later, needs none now, so a viewer who joins late asks only for what the rings
 * show now and next, however many bouts are revealed.
 */
export function tournamentLogsDue(view: TournamentView, displayNowMs: number, windowMs: number, rings: ReadonlyMap<string, RingSlot>): string[] {
  const due: RingSlot[] = [];
  for (const bout of Array.isArray(view.bouts) ? view.bouts : []) {
    const slot = rings.get(bout.id);
    const result = bout.revealedResult;
    if (!slot || !result || result.bye || result.battleLog) continue;
    if (slot.leaveAtMs > displayNowMs && slot.enterAtMs <= displayNowMs + windowMs) due.push(slot);
  }
  return due.sort((p, q) => p.enterAtMs - q.enterAtMs || (p.battleId < q.battleId ? -1 : p.battleId > q.battleId ? 1 : 0)).map(s => s.battleId);
}
