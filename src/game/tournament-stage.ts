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
// both fighters at 0 HP included); health never decides it. Byes advance their entrant at round 1 without a fight.
// Before a round reveals its bouts read "Result preparing"; a due round without published results is "delayed"
// (the tournament shows as processing), never an invented result. Round 1 pairings are not in the public view before
// their reveal (the open TournamentView contract question), so only later rounds name sides early, from the winners
// already shown. Nothing here computes a result, rating or reward, and no Phaser, React, clock or randomness is used.
import type { LeagueId } from '@contracts/commands';
import type { ActivitySummary, BattleLog } from '@contracts/events';
import type { TournamentBout, TournamentEntrant, TournamentView } from '@contracts/reads';
import { slotAt } from '@domain/clock';
import { RULES_V1 } from '@domain/rules-v1';
import { isTournamentSlot } from '@domain/tournament';

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

/** The id of a league's tournament in a slot: the Task 19 graph id, `tournament:<slot>:<league>`. */
export function tournamentIdFor(slotIndex: number, league: LeagueId): string {
  return `tournament:${slotIndex}:${league}`;
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
  /** The revealed battle log (shared by reference), from the reveal time on. */
  readonly log: BattleLog | null;
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
  /** The viewer's own entry and, once settled, only their own credited summary. */
  readonly viewer: { readonly entrant: TournamentEntrantState | null; readonly placement: { readonly place: number; readonly summary: ActivitySummary } | null };
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
/**
 * A published result names one entrant for a bye or two for a fight, its winner among them, and a log that agrees: the
 * same winner and the same two gladiators, in either order (the result's order names the sides).
 */
function wellFormed(result: TournamentBout['revealedResult'], entrants: ReadonlySet<string>): result is Result {
  if (!result || typeof result !== 'object' || !Array.isArray(result.participants)) return false;
  const ids = result.participants.map(p => p?.gladiatorId);
  const count = result.bye ? 1 : 2;
  if (ids.length !== count || new Set(ids).size !== count || !ids.every(id => entrants.has(id)) || !ids.includes(result.winnerId)) return false;
  const log = result.battleLog;
  if (result.bye) return log == null;
  if (log == null) return true;
  if (log.winnerId !== result.winnerId || !Array.isArray(log.participants) || log.participants.length !== 2) return false;
  const logged = log.participants.map(p => p?.gladiatorId);
  return new Set(logged).size === 2 && logged.every(id => typeof id === 'string' && ids.includes(id));
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

  const shown = new Map<string, string>();
  const shared = new Set<object>();
  const rounds: TournamentRoundState[] = !shape ? [] : reveals.map((revealAtMs, i) => {
    const round = i + 1;
    const due = t >= revealAtMs;
    const bouts = (Array.isArray(view.bouts) ? view.bouts : []).filter(b => b.round === round).sort((a, b) => a.position - b.position).map((bout): TournamentBoutState => {
      const base = { id: bout.id, round, position: bout.position, revealAtMs };
      const result = due && wellFormed(bout.revealedResult, ids) ? bout.revealedResult! : null;
      if (!result) {
        const sides = round === 1 ? [] : bout.parentBoutIds.map(parent => (shown.has(parent) ? copy(shown.get(parent)!) : null));
        return { ...base, status: due ? 'delayed' : 'preparing', sides, winnerId: null, loserId: null, log: null, fightEndsAtMs: null, elapsedMs: null };
      }
      const sides = result.participants.map(p => copy(p.gladiatorId));
      if (result.bye) {
        shown.set(bout.id, result.winnerId);
        return { ...base, status: 'bye', sides, winnerId: result.winnerId, loserId: null, log: null, fightEndsAtMs: null, elapsedMs: null };
      }
      const log = result.battleLog ?? null;
      if (log) shared.add(log);
      const fightEndsAtMs = revealAtMs + (log?.durationMs ?? 0);
      const elapsedMs = t - revealAtMs;
      if (t < fightEndsAtMs) return { ...base, status: 'fighting', sides, winnerId: null, loserId: null, log, fightEndsAtMs, elapsedMs };
      shown.set(bout.id, result.winnerId);
      const loserId = sides.find(s => s.gladiatorId !== result.winnerId)!.gladiatorId;
      return { ...base, status: 'decided', sides, winnerId: result.winnerId, loserId, log, fightEndsAtMs, elapsedMs };
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
    viewer: { entrant: entrants.find(e => e.gladiatorId === viewerId) ?? null, placement: own ? { place: own.place, summary: structuredClone(own.summary) } : null },
    revealMarks,
  }, shared);
}

/** Display times when a fresh read of the view may reveal more (see `TournamentStageState.revealMarks`). */
export function tournamentRevealMarks(state: TournamentStageState): number[] {
  return [...state.revealMarks];
}
