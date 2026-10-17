// Pure tournament stage core. Given a public TournamentView and the display clock (estimated server time), it returns
// what the Tournaments panel and the camp show: the next tournament and its countdown, the status, the bracket shape
// (next power of two, rounds and byes) from the start, each round's reveal time, which bout results may show, the
// winner of every shown bout, each entrant's role (waiting, fighting, eliminated and spectating, or champion) and the
// placements once the tournament is settled.
//
// Spec §8.2 timing: a tournament is the 80-minute afternoon slot starting Wednesday or Saturday at 17:20 UTC
// (`isTournamentSlot`, pure UTC arithmetic). Round r of R reveals at 80 × r / (R + 1) minutes after the start, rounded
// up to the millisecond as in Task 19, so a reveal is never early. A bout's result shows only when the view carries a
// well-formed `revealedResult` AND the display clock has reached its round's reveal time; a fought bout then plays for
// its logged duration ("fighting") before its winner shows. The winner is always `winnerId` (a seeded tie-break with
// both fighters at 0 HP included); health never decides it. The bracket's seeded first round is public from the start
// (`TournamentView.bracket.slots`, Task 19 phase 2b): round 1 names its sides from the start, a bye advances its entrant
// at once without a fight, and a published round-1 result must be exactly its seeded pair. A malformed bracket fails
// closed: no seeded sides, and byes only from their published results once round 1 is due. Before a round reveals its
// bouts read "Result preparing"; a due round without published results is "delayed" (the tournament shows as
// processing), never an invented result; later rounds name sides from the winners already shown. Nothing here computes
// a result, rating or reward, and no Phaser, React, clock or randomness is used.
//
// Polled views carry no battle logs (Task 19 phase 2b review I1): a fought result carries its fight summary (duration,
// victory and tie-break reasons), which times the fight and explains its winner; its log loads on demand and is merged
// in with `withTournamentLogs` when the bout is watched or animated.
import type { LeagueId } from '@contracts/commands';
import type { BattleLog } from '@contracts/events';
import type { TournamentBout, TournamentEntrant, TournamentFightSummary, TournamentView } from '@contracts/reads';
import { slotAt } from '@domain/clock';
import { RULES_V1 } from '@domain/rules-v1';
import { isTournamentSlot } from '@domain/tournament-slot';
import { tournamentLookupId, tournamentSlotOf } from '../lib/tournament-id';

/** One tournament lasts one 80-minute slot; its rewards settle at the end. */
export const TOURNAMENT_DURATION_MS = RULES_V1.tournament.durationMs;
const SLOT_MS = RULES_V1.clock.slotMs;
/** A week holds 126 slots; two of them are tournaments, at most four days apart. */
const SEARCH_SLOTS = 7 * 18;

export type TournamentWindow = { readonly slotIndex: number; readonly startsAtMs: number; readonly endsAtMs: number };
export type NextTournament = TournamentWindow & { readonly countdownMs: number };

function time(t: number): number {
  if (!Number.isFinite(t) || t < 0) throw new RangeError('Display time must be a nonnegative number');
  return Math.floor(t);
}
const windowOf = (slotIndex: number): TournamentWindow => {
  const slot = slotAt(slotIndex * SLOT_MS);
  return { slotIndex: slot.index, startsAtMs: slot.startMs, endsAtMs: slot.endMs };
};

/** The tournament slot that contains the display time, or null. */
export function tournamentWindowAt(displayNowMs: number): TournamentWindow | null {
  const slot = slotAt(time(displayNowMs));
  return isTournamentSlot(slot) ? windowOf(slot.index) : null;
}

/** The first tournament that starts after the display time, and the time left until it starts. */
export function nextTournament(displayNowMs: number): NextTournament {
  const t = time(displayNowMs);
  let index = slotAt(t).index + 1;
  for (let n = 0; n < SEARCH_SLOTS && !isTournamentSlot(slotAt(index * SLOT_MS)); n += 1) index += 1;
  const next = windowOf(index);
  return { ...next, countdownMs: next.startsAtMs - displayNowMs };
}

/** The latest tournament that has started by the display time: the one running, else the most recent. */
export function latestTournament(displayNowMs: number): TournamentWindow {
  let index = slotAt(time(displayNowMs)).index;
  for (let n = 0; n < SEARCH_SLOTS && index > 0 && !isTournamentSlot(slotAt(index * SLOT_MS)); n += 1) index -= 1;
  return windowOf(index);
}

/** Round r of R reveals `ceil(80 min × r / (R + 1))` after the start (never early). */
export function roundRevealTimes(startsAtMs: number, rounds: number): number[] {
  return Array.from({ length: rounds }, (_, i) => startsAtMs + Math.ceil(TOURNAMENT_DURATION_MS * (i + 1) / (rounds + 1)));
}

export type BracketShape = { readonly size: number; readonly rounds: number; readonly byes: number };
/** The single-elimination shape for n entrants: the next power of two, its rounds and the byes; null below the minimum. */
export function bracketShape(entrants: number): BracketShape | null {
  if (!Number.isSafeInteger(entrants) || entrants < RULES_V1.tournament.minimumEntrants) return null;
  let size = 1, rounds = 0;
  while (size < entrants) { size *= 2; rounds += 1; }
  return { size, rounds, byes: size - entrants };
}

/** The id of a league's tournament in a slot: Task 19's graph id, `tournament:<slot>:<league>` (the pure lookup id). */
export function tournamentIdFor(slotIndex: number, league: LeagueId): string {
  return tournamentLookupId(slotIndex, league);
}

/** A tournament view is asked for again this often while a read failed or, at first, while it is processing. */
export const TOURNAMENT_RETRY_MS = 30_000;
/** The longest wait between processing re-reads. */
export const TOURNAMENT_RETRY_MAX_MS = 300_000;
/**
 * The wait before the next re-read of a tournament that is still processing, after `retries` processing re-reads in a
 * row: 30 s, 60 s, 120 s, 240 s, then every 5 minutes (2b review I1), so a stuck settlement is not re-read every 30 s.
 */
export function processingRetryDelay(retries: number): number {
  const n = Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0;
  return Math.min(TOURNAMENT_RETRY_MAX_MS, TOURNAMENT_RETRY_MS * 2 ** Math.min(n, 10));
}

/**
 * How long after a tournament's cutoff a missing view reads as "being prepared" for every viewer (Task 19 R3). Phase 8
 * publishes a slot about 61–121 s after its cutoff; no public field says when it has, so a time bound covers visitors
 * and gladiators created after the cutoff, with room for a late cron tick.
 */
export const TOURNAMENT_PREPARE_GRACE_MS = 300_000;
/**
 * Whether a missing view (`not-found`) of tournament `id` means it is still being prepared (2b review M4; Task 19 R3):
 * the display time is inside that tournament's slot, and either less than `TOURNAMENT_PREPARE_GRACE_MS` has passed since
 * its cutoff, or the owner's processed slot (published with the slot's tournaments; null without an owner) is still an
 * earlier one. Otherwise a missing view means no tournament in that league. Never before the cutoff, after the slot or
 * for a malformed id.
 */
export function tournamentPreparing(id: string, displayNowMs: number, processedSlotIndex: number | null): boolean {
  const slot = tournamentSlotOf(id);
  if (slot === null || !Number.isFinite(displayNowMs) || displayNowMs < 0) return false;
  const running = tournamentWindowAt(displayNowMs);
  if (running?.slotIndex !== slot) return false;
  return displayNowMs - running.startsAtMs < TOURNAMENT_PREPARE_GRACE_MS || (processedSlotIndex !== null && processedSlotIndex < slot);
}

const roundLabel = (round: number, rounds: number) =>
  round === rounds ? 'Final' : round === rounds - 1 ? 'Semifinals' : round === rounds - 2 ? 'Quarterfinals' : `Round ${round}`;

export type TournamentRole = 'waiting' | 'fighting' | 'spectating' | 'champion';
export type TournamentStatus = TournamentView['status'];

export type TournamentBoutState = {
  readonly id: string;
  readonly round: number;
  readonly position: number;
  readonly revealAtMs: number;
  /**
   * `preparing` before its round reveals; `delayed` once due without a published result; `bye` an advance without a
   * fight; `fighting` while the revealed bout plays its logged duration; `decided` once it has ended.
   */
  readonly status: 'preparing' | 'delayed' | 'bye' | 'fighting' | 'decided';
  /**
   * The known sides: the revealed participants (one for a bye), or for a later round not yet revealed the winners
   * already shown of its parent bouts (null while undecided). Empty for round 1 before its reveal.
   */
  readonly sides: readonly (TournamentEntrant | null)[];
  /** Only once decided (or a bye). */
  readonly winnerId: string | null;
  readonly loserId: string | null;
  /** The revealed battle log (shared by reference), from the reveal time on, once loaded (polled views carry none). */
  readonly log: BattleLog | null;
  /** How the winner won (from the log, or the polled fight summary); only once decided. */
  readonly fight: TournamentFightSummary | null;
  readonly fightEndsAtMs: number | null;
  /** Display time since the bout's reveal; a scene seeks its playback to it. */
  readonly elapsedMs: number | null;
};
export type TournamentRoundState = {
  readonly round: number;
  readonly label: string;
  readonly revealAtMs: number;
  readonly due: boolean;
  /** Due, but at least one result is not published yet. */
  readonly delayed: boolean;
  readonly bouts: readonly TournamentBoutState[];
};
export type TournamentEntrantState = TournamentEntrant & {
  /** Null outside a bracket (too few entrants: they ran regular Arena). */
  readonly role: TournamentRole | null;
  readonly eliminatedInRound: number | null;
  /** The bout being fought now. */
  readonly boutId: string | null;
};
export type TournamentPlacementState = { readonly gladiatorId: string; readonly name: string; readonly place: number };

export type TournamentStageState = {
  readonly id: string;
  readonly league: LeagueId;
  readonly slotIndex: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly displayNowMs: number;
  readonly status: TournamentStatus;
  /** From the start only. */
  readonly shape: BracketShape | null;
  /** From the start only, in the view's order. */
  readonly entrants: readonly TournamentEntrantState[];
  readonly rounds: readonly TournamentRoundState[];
  /** The latest round whose reveal time has passed, else round 1; null without a bracket. */
  readonly currentRound: number | null;
  /** The winner of the final, once its bout has ended. */
  readonly championId: string | null;
  /** Only once settled (status `completed`): place and public identity, never anyone's rewards. */
  readonly placements: readonly TournamentPlacementState[];
  /**
   * The viewer's own entry and, once settled, its own place and tournament activity, whose credited summary only the
   * owner can read (its own timeline).
   */
  readonly viewer: { readonly entrant: TournamentEntrantState | null; readonly placement: { readonly place: number; readonly activityId: string } | null };
  /** Display times after now when a fresh read may reveal more: the start, each round's reveal and the settlement. */
  readonly revealMarks: readonly number[];
};

/** Deep-freezes the state it built; the caller's battle logs are shared by reference and left untouched. */
function freeze<V>(value: V, shared: ReadonlySet<object>): V {
  if (value && typeof value === 'object' && !shared.has(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child, shared);
  }
  return value;
}

type Result = NonNullable<TournamentBout['revealedResult']>;
const VICTORY_REASONS: readonly unknown[] = ['defeat', 'health-fraction', 'tie-break'];
const TIE_BREAK_REASONS: readonly unknown[] = ['simultaneous-defeat', 'equal-health-fraction', null];
/** A fight summary: a nonnegative finite duration and known victory and tie-break reasons. */
function wellFormedFight(fight: unknown): fight is TournamentFightSummary {
  if (!fight || typeof fight !== 'object') return false;
  const { durationMs, victoryReason, tieBreakReason } = fight as Record<string, unknown>;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 && VICTORY_REASONS.includes(victoryReason)
    && TIE_BREAK_REASONS.includes(tieBreakReason ?? null);
}
/** A log agrees with a fought result: the same winner and the same two gladiators, in either order. */
function logAgrees(log: BattleLog, result: Pick<Result, 'participants' | 'winnerId'>): boolean {
  if (!log || typeof log !== 'object' || log.winnerId !== result.winnerId || !Array.isArray(log.participants) || log.participants.length !== 2) return false;
  const ids = result.participants.map(p => p?.gladiatorId);
  const logged = log.participants.map(p => p?.gladiatorId);
  return new Set(logged).size === 2 && logged.every(id => typeof id === 'string' && ids.includes(id));
}
/**
 * A published result names one entrant for a bye or two for a fight, and its winner among them. A bye carries no log and
 * no fight summary; a fought result's log, when present, agrees with it (the result's order names the sides), and its
 * fight summary, when present, is well formed.
 */
function wellFormed(result: TournamentBout['revealedResult'], entrants: ReadonlySet<string>): result is Result {
  if (!result || typeof result !== 'object' || !Array.isArray(result.participants)) return false;
  const ids = result.participants.map(p => p?.gladiatorId);
  const count = result.bye ? 1 : 2;
  if (ids.length !== count || new Set(ids).size !== count || !ids.every(id => entrants.has(id)) || !ids.includes(result.winnerId)) return false;
  const log = result.battleLog;
  if (result.bye) return log == null && result.fight == null;
  if (result.fight != null && !wellFormedFight(result.fight)) return false;
  return log == null || logAgrees(log, result);
}
const fightOf = (log: BattleLog): TournamentFightSummary => ({ durationMs: log.durationMs, victoryReason: log.victoryReason, tieBreakReason: log.tieBreakReason });

/**
 * The polled shape of a view (what the live read returns): each fought result's battle log replaced by its fight
 * summary. Byes and unrevealed bouts are unchanged. A copy; the input keeps its logs.
 */
export function withoutTournamentLogs(view: TournamentView): TournamentView {
  return { ...view, bouts: view.bouts.map(bout => {
    const result = bout.revealedResult;
    if (!result?.battleLog) return { ...bout, parentBoutIds: [...bout.parentBoutIds], revealedResult: result ? { ...result } : null };
    const { battleLog, ...rest } = result;
    return { ...bout, parentBoutIds: [...bout.parentBoutIds], revealedResult: { ...rest, fight: rest.fight ?? fightOf(battleLog) } };
  }) };
}

/**
 * The view with the loaded logs of its published fought bouts merged in: a log joins only its own bout, only when the
 * bout has none yet and only when it agrees with the published result. The same view object when nothing joins.
 */
export function withTournamentLogs(view: TournamentView, logs: ReadonlyMap<string, BattleLog>): TournamentView {
  if (logs.size === 0 || !Array.isArray(view.bouts)) return view;
  let changed = false;
  const bouts = view.bouts.map(bout => {
    const result = bout.revealedResult;
    const log = logs.get(bout.id);
    if (!log || !result || result.bye || result.battleLog || !Array.isArray(result.participants) || !logAgrees(log, result)) return bout;
    changed = true;
    return { ...bout, revealedResult: { ...result, battleLog: log } };
  });
  return changed ? { ...view, bouts } : view;
}

/**
 * The seeded first-round seats when the view's bracket is well formed for its entrants: one seat per bracket position,
 * each an entrant at most once or null, every pair holding at least one entrant, and the shape the entrant count implies.
 */
function seededSeats(view: TournamentView, ids: ReadonlySet<string>, shape: BracketShape | null): (string | null)[] | null {
  const bracket = view.bracket;
  if (!shape || !bracket || typeof bracket !== 'object' || bracket.size !== shape.size || bracket.rounds !== shape.rounds
    || !Array.isArray(bracket.slots) || bracket.slots.length !== shape.size) return null;
  const seen = new Set<string>();
  for (const [i, seat] of bracket.slots.entries()) {
    if (seat === null) { if (bracket.slots[i ^ 1] === null) return null; continue; }
    if (typeof seat !== 'string' || !ids.has(seat) || seen.has(seat)) return null;
    seen.add(seat);
  }
  return seen.size === ids.size ? [...bracket.slots] : null;
}

/** The tournament as the display time shows it. `viewerId` is the signed-in owner's gladiator, if any. */
export function renderTournament(view: TournamentView, displayNowMs: number, options: { viewerId?: string | null } = {}): TournamentStageState {
  const t = displayNowMs;
  const viewerId = options.viewerId ?? null;
  const started = t >= view.startsAtMs;
  const insufficient = view.status === 'insufficient-entrants';
  const all = Array.isArray(view.entrants) ? view.entrants : [];
  const ids = new Set(all.map(e => e.gladiatorId));
  const copy = (id: string): TournamentEntrant => {
    const e = all.find(x => x.gladiatorId === id)!;
    return { gladiatorId: e.gladiatorId, name: e.name, classId: e.classId };
  };
  const fullShape = insufficient ? null : bracketShape(all.length);
  const shape = started ? fullShape : null;
  const reveals = fullShape ? roundRevealTimes(view.startsAtMs, fullShape.rounds) : [];
  const seats = seededSeats(view, ids, fullShape);

  const shown = new Map<string, string>();
  const shared = new Set<object>();
  const rounds: TournamentRoundState[] = !shape ? [] : reveals.map((revealAtMs, i) => {
    const round = i + 1;
    const due = t >= revealAtMs;
    const bouts = (Array.isArray(view.bouts) ? view.bouts : []).filter(b => b.round === round).sort((a, b) => a.position - b.position).map((bout): TournamentBoutState => {
      const base = { id: bout.id, round, position: bout.position, revealAtMs };
      const pair = round === 1 && seats ? [seats[2 * bout.position], seats[2 * bout.position + 1]] : null;
      const seated = pair?.filter((id): id is string => id !== null) ?? null;
      if (seated?.length === 1) {
        // A bye is public from the start: its entrant advances at once, with no fight.
        shown.set(bout.id, seated[0]);
        return { ...base, status: 'bye', sides: [copy(seated[0])], winnerId: seated[0], loserId: null, log: null, fight: null, fightEndsAtMs: null, elapsedMs: null };
      }
      const published = due && wellFormed(bout.revealedResult, ids) ? bout.revealedResult! : null;
      // A published round-1 result must be exactly its seeded pair (and a bye there, when seeded, is never a fight).
      const result = published && (!seated || (!published.bye && published.participants.every(p => seated.includes(p.gladiatorId)))) ? published : null;
      if (!result) {
        const sides = round === 1 ? (seated ? seated.map(copy) : []) : bout.parentBoutIds.map(parent => (shown.has(parent) ? copy(shown.get(parent)!) : null));
        return { ...base, status: due ? 'delayed' : 'preparing', sides, winnerId: null, loserId: null, log: null, fight: null, fightEndsAtMs: null, elapsedMs: null };
      }
      const sides = result.participants.map(p => copy(p.gladiatorId));
      if (result.bye) {
        shown.set(bout.id, result.winnerId);
        return { ...base, status: 'bye', sides, winnerId: result.winnerId, loserId: null, log: null, fight: null, fightEndsAtMs: null, elapsedMs: null };
      }
      const log = result.battleLog ?? null;
      if (log) shared.add(log);
      // The fight plays for its logged duration, known from the log once loaded or from the polled fight summary.
      const fight = log ? fightOf(log) : result.fight ? { ...result.fight, tieBreakReason: result.fight.tieBreakReason ?? null } : null;
      const fightEndsAtMs = revealAtMs + (fight?.durationMs ?? 0);
      const elapsedMs = t - revealAtMs;
      if (t < fightEndsAtMs) return { ...base, status: 'fighting', sides, winnerId: null, loserId: null, log, fight: null, fightEndsAtMs, elapsedMs };
      shown.set(bout.id, result.winnerId);
      const loserId = sides.find(s => s.gladiatorId !== result.winnerId)!.gladiatorId;
      return { ...base, status: 'decided', sides, winnerId: result.winnerId, loserId, log, fight, fightEndsAtMs, elapsedMs };
    });
    return { round, label: roundLabel(round, reveals.length), revealAtMs, due, delayed: due && bouts.some(b => b.status === 'delayed'), bouts };
  });

  const fighting = new Map<string, string>();
  const lost = new Map<string, number>();
  for (const bout of rounds.flatMap(r => r.bouts)) {
    if (bout.status === 'fighting') for (const side of bout.sides) if (side) fighting.set(side.gladiatorId, bout.id);
    if (bout.status === 'decided' && bout.loserId) lost.set(bout.loserId, bout.round);
  }
  const final = rounds.at(-1)?.bouts[0];
  const championId = final?.status === 'decided' ? final.winnerId : null;
  const entrants: TournamentEntrantState[] = !started ? [] : all.map(e => {
    const id = e.gladiatorId;
    const role: TournamentRole | null = !shape ? null : fighting.has(id) ? 'fighting' : lost.has(id) ? 'spectating' : championId === id ? 'champion' : 'waiting';
    return { ...copy(id), role, eliminatedInRound: lost.get(id) ?? null, boutId: fighting.get(id) ?? null };
  });

  const settled = view.status === 'completed' && Array.isArray(view.placements) && view.placements.length > 0;
  const status: TournamentStatus = !started ? 'scheduled'
    : insufficient ? 'insufficient-entrants'
      : !shape ? 'processing'
        : t >= view.endsAtMs ? (settled ? 'completed' : 'processing')
          : view.status === 'processing' || rounds.some(r => r.delayed) ? 'processing' : 'active';
  const placed = status === 'completed' ? view.placements.filter(p => ids.has(p.gladiatorId)) : [];
  const placements = placed.map(p => ({ gladiatorId: p.gladiatorId, name: copy(p.gladiatorId).name, place: p.place }))
    .sort((a, b) => a.place - b.place || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const own = viewerId ? placed.find(p => p.gladiatorId === viewerId) : undefined;
  const revealMarks = insufficient ? [] : [view.startsAtMs, ...reveals, view.endsAtMs].filter(mark => mark > t);

  return freeze({
    id: view.id, league: view.league, slotIndex: view.slotIndex, startsAtMs: view.startsAtMs, endsAtMs: view.endsAtMs, displayNowMs: t,
    status, shape, entrants, rounds,
    currentRound: shape ? Math.max(1, ...rounds.filter(r => r.due).map(r => r.round)) : null,
    championId, placements,
    viewer: { entrant: entrants.find(e => e.gladiatorId === viewerId) ?? null,
      placement: own && typeof own.completion?.activityId === 'string' ? { place: own.place, activityId: own.completion.activityId } : null },
    revealMarks,
  }, shared);
}

/** Display times when a fresh read of the view may reveal more (see `TournamentStageState.revealMarks`). */
export function tournamentRevealMarks(state: TournamentStageState): number[] {
  return [...state.revealMarks];
}
