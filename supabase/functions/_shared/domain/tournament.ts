import type { ActivityChoice, LeagueId } from '../contracts/commands.ts';
import type { BattleLog, CreditedRewards } from '../contracts/events.ts';
import { applyRatingDelta, copyFighter, LEAGUES, nonEmpty, RETAINED_RULES, type ArenaEntrant } from './arena.ts';
import type { DeepReadonly, FighterSnapshot, Rules, Seed, SlotWindow } from './types.ts';
import { freezeDomain } from './types.ts';
import { slotAt } from './clock.ts';
import { simulateBattle, validFighter } from './combat.ts';
import { RULES_V1 } from './rules-v1.ts';
import { seededRandom } from './random.ts';

/** Task 2's canonical slot window (`types.ts`), re-exported beside the tournament functions; not a second definition. */
export type { SlotWindow };

const CHOICES: readonly string[] = Object.freeze(['training', 'rest', 'arena', 'expedition']);

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Arena's retained rules registry: a fighter or graph frozen under an unknown version fails closed. */
function rulesFor(version: unknown): Rules {
  if (typeof version !== 'string' || !Object.hasOwn(RETAINED_RULES, version)) throw new RangeError('Unknown tournament rules version');
  return RETAINED_RULES[version];
}
/** Arena's whitelisted fighter copy, after validating the snapshot under its own retained rules. */
function validCopy(f: FighterSnapshot): FighterSnapshot {
  let valid = false;
  try { valid = validFighter(f, rulesFor(f?.rulesVersion)); } catch { valid = false; }
  if (!valid) throw new RangeError('Invalid tournament fighter snapshot');
  return copyFighter(f);
}
/** The one retained rules version of a non-empty set of input fighters. Mixed or unknown versions fail closed. */
function sharedRules(fighters: readonly (FighterSnapshot | null | undefined)[]): Rules {
  const versions = new Set(fighters.map(fighter => fighter?.rulesVersion));
  if (versions.size !== 1) throw new RangeError('Tournament entrants must share one rules version');
  return rulesFor([...versions][0]);
}
/** A validated whitelisted copy of one frozen league entrant of `slotIndex` and `seasonId`, under the shared `rules`. */
function copyEntrant(e: ArenaEntrant, slotIndex: number, seasonId: unknown, rules: Rules): ArenaEntrant {
  if (!e || typeof e !== 'object' || !nonEmpty(e.gladiatorId) || !nonEmpty(e.activityId) || !nonEmpty(e.seasonId)
    || e.seasonId !== seasonId || !LEAGUES.includes(e.league) || e.slotIndex !== slotIndex
    || !count(e.rating) || e.rating < rules.rating.minimum || e.fighter?.rulesVersion !== rules.version) {
    throw new RangeError('Invalid tournament entrant');
  }
  return { gladiatorId: e.gladiatorId, activityId: e.activityId, seasonId: e.seasonId, league: e.league,
    slotIndex: e.slotIndex, rating: e.rating, fighter: validCopy(e.fighter) };
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Epoch day 0 (1970-01-01) was a Thursday: weekday 4 in the 0 = Sunday convention of `utcWeekdays`. */
const EPOCH_WEEKDAY = 4;

/** The canonical `slotAt` window for `slot`; anything else (misaligned, wrong phase or length) fails closed. */
function canonicalSlot(slot: SlotWindow): SlotWindow {
  let canonical: SlotWindow | null = null;
  try { canonical = slot !== null && typeof slot === 'object' ? slotAt(slot.startMs) : null; } catch { canonical = null; }
  if (!canonical || canonical.index !== slot.index || canonical.phase !== slot.phase
    || canonical.startMs !== slot.startMs || canonical.endMs !== slot.endMs) throw new RangeError('Invalid slot window');
  return canonical;
}

/**
 * Spec §8.2 fixed times: a tournament slot is the 80-minute afternoon slot starting Wednesday or Saturday at 17:20 UTC.
 * Pure UTC epoch arithmetic on the slot start (no `Date`, local time zone or daylight saving), so local clock changes
 * never move a tournament. Every 17:20 UTC start is an afternoon, because a 24-hour day holds 18 slots. The days and time
 * come from `rules` (default v1); the partition and the bracket pass their entrants' retained rules.
 */
export function isTournamentSlot(slot: SlotWindow, rules: Rules = RULES_V1): boolean {
  const { startMs } = canonicalSlot(slot);
  const { utcWeekdays, hourUtc, minuteUtc } = rules.tournament;
  const day = Math.floor(startMs / DAY_MS);
  return utcWeekdays.includes((day + EPOCH_WEEKDAY) % 7) && startMs - day * DAY_MS === (hourUtc * 60 + minuteUtc) * MINUTE_MS;
}

/** One committed `set-tournament-opt-in` toggle and its server receipt time (UTC epoch milliseconds). */
export type OptInRevision = DeepReadonly<{ enabled: boolean; receivedAtMs: number }>;
/**
 * One character's frozen inputs for a slot's pairing phase (spec §4.1 step 7): its league entrant, the schedule choice
 * effective for this slot's phase, current stamina and the versioned activity costs from the cutoff snapshot, and its
 * committed opt-in toggles in commit order (non-decreasing receipt times). A character with no toggle is opted out.
 */
export type TournamentCandidate = DeepReadonly<{
  entrant: ArenaEntrant;
  choice: ActivityChoice;
  stamina: number;
  costs: { arena: number; tournament: number };
  optIn: OptInRevision[];
}>;
/**
 * Where one candidate goes this slot, with its single stamina debit for the whole slot: a bracket (`costs.tournament`),
 * regular Arena (`costs.arena`), Rest when Arena is unaffordable (0), or `other` for a non-Arena schedule, which this
 * partition neither routes nor charges (its own activity is charged by the boundary).
 */
export type TournamentRoute = DeepReadonly<{
  gladiatorId: string; activityId: string; league: LeagueId;
  route: 'tournament' | 'arena' | 'rest' | 'other';
  reason: 'bracket' | 'not-tournament-slot' | 'opted-out' | 'insufficient-stamina' | 'too-few-entrants' | 'not-arena';
  staminaDebit: number;
}>;
/** Per-league bracket entrants (input order), the regular-Arena entrants for `matchArena`, and one route per candidate. */
export type TournamentPartition = DeepReadonly<{
  slotIndex: number; tournamentSlot: boolean;
  brackets: { league: LeagueId; entrants: ArenaEntrant[] }[];
  arena: ArenaEntrant[];
  routes: TournamentRoute[];
}>;

/**
 * The opt-in value effective at a slot cutoff: the last toggle committed strictly before `cutoffMs`. The slot is
 * inclusive at its start (Task 7), so a toggle received exactly at the cutoff or later affects only future tournaments.
 */
function optedInAt(revisions: readonly OptInRevision[], cutoffMs: number): boolean {
  if (!Array.isArray(revisions)) throw new RangeError('Invalid tournament opt-in history');
  let enabled = false, previous = 0;
  for (const revision of revisions) {
    if (!revision || typeof revision.enabled !== 'boolean' || !count(revision.receivedAtMs) || revision.receivedAtMs < previous) {
      throw new RangeError('Invalid tournament opt-in history');
    }
    previous = revision.receivedAtMs;
    if (revision.receivedAtMs < cutoffMs) enabled = revision.enabled;
  }
  return enabled;
}

/**
 * Spec §8.2 eligibility at a common slot cutoff. On a tournament slot, a candidate enters its league's bracket when it
 * has Arena scheduled for the phase, was opted in before the cutoff and has stamina for both the requested Arena activity
 * (checked first, as boundary step 6 does) and the tournament. A league with at least the minimum entrants (v1: two)
 * gets a bracket; otherwise they run regular Arena, exactly once, with every other affordable Arena entrant (NPC
 * fallback included). No cross-league brackets. Days, time and minimum come from the candidates' one shared retained
 * rules version (v1 when there are no candidates). Any malformed candidate fails closed with a `RangeError`.
 */
export function partitionTournament(slot: SlotWindow, candidates: readonly TournamentCandidate[]): TournamentPartition {
  if (!Array.isArray(candidates)) throw new RangeError('Invalid tournament candidates');
  const rules = candidates.length > 0 ? sharedRules(candidates.map(c => c?.entrant?.fighter)) : RULES_V1;
  const tournamentSlot = isTournamentSlot(slot, rules);
  const season = candidates[0]?.entrant?.seasonId;
  const ids = new Set<string>(), activities = new Set<string>();
  const decided = candidates.map(c => {
    if (!c || typeof c !== 'object') throw new RangeError('Invalid tournament candidate');
    const entrant = copyEntrant(c.entrant, slot.index, season, rules);
    if (ids.has(entrant.gladiatorId) || activities.has(entrant.activityId)) throw new RangeError('Duplicate tournament candidate');
    ids.add(entrant.gladiatorId);
    activities.add(entrant.activityId);
    if (!c.choice || !CHOICES.includes(c.choice.kind) || !count(c.stamina) || !count(c.costs?.arena) || !count(c.costs?.tournament)) {
      throw new RangeError('Invalid tournament candidate');
    }
    const arena = c.choice.kind === 'arena';
    const affordsArena = c.stamina >= c.costs.arena;
    const optedIn = optedInAt(c.optIn, slot.startMs);
    const eligible = tournamentSlot && arena && affordsArena && optedIn && c.stamina >= c.costs.tournament;
    return { entrant, arena, affordsArena, optedIn, eligible, costs: { arena: c.costs.arena, tournament: c.costs.tournament } };
  });
  const bracketLeagues = new Set(LEAGUES.filter(league =>
    decided.filter(d => d.eligible && d.entrant.league === league).length >= rules.tournament.minimumEntrants));
  const routes: TournamentRoute[] = decided.map(d => {
    const base = { gladiatorId: d.entrant.gladiatorId, activityId: d.entrant.activityId, league: d.entrant.league };
    if (!d.arena) return { ...base, route: 'other', reason: 'not-arena', staminaDebit: 0 };
    if (!d.affordsArena) return { ...base, route: 'rest', reason: 'insufficient-stamina', staminaDebit: 0 };
    if (d.eligible && bracketLeagues.has(d.entrant.league)) return { ...base, route: 'tournament', reason: 'bracket', staminaDebit: d.costs.tournament };
    const reason = !tournamentSlot ? 'not-tournament-slot' : !d.optedIn ? 'opted-out' : !d.eligible ? 'insufficient-stamina' : 'too-few-entrants';
    return { ...base, route: 'arena', reason, staminaDebit: d.costs.arena };
  });
  return freezeDomain({ slotIndex: slot.index, tournamentSlot,
    brackets: LEAGUES.filter(league => bracketLeagues.has(league)).map(league => ({ league,
      entrants: decided.filter((d, i) => d.entrant.league === league && routes[i].route === 'tournament').map(d => d.entrant) })),
    arena: decided.filter((_, i) => routes[i].route === 'arena').map(d => d.entrant),
    routes });
}

/** One frozen bracket entrant: identity, activity, rating before the tournament and its initial arena snapshot. */
export type TournamentEntry = DeepReadonly<{
  gladiatorId: string; activityId: string; rating: number; fighter: FighterSnapshot;
  /** 1-based place in the seeded random order. Ranks 1 … (size − entrants) receive the first-round byes. */
  rank: number;
}>;
/** A resolved bout: the winner (`log.winnerId` for a fought bout) and loser; a bye has no loser and no log. */
export type BoutResult = DeepReadonly<{ winnerId: string; loserId: string | null; log: BattleLog | null }>;
/** One private bracket node. Its battle id is its stable bout id, shared by both participants' replays. */
export type BracketBout = DeepReadonly<{
  id: string; battleId: string; round: number; position: number;
  /** Empty in round 1; otherwise the two parent bouts whose winners meet here, upper half first. */
  parentBoutIds: string[];
  /** Round 1: the two placed entrant ids, `null` marking an empty bracket slot. Later rounds: `null`. */
  placed: [string | null, string | null] | null;
  bye: boolean;
  revealAtMs: number;
  result: BoutResult | null;
}>;
/**
 * The private tournament graph of one league and slot: frozen entries in seeded order, every bout (round-major,
 * position order) with stable ids, parents, byes, reveal times and private results. Public reads (`TournamentView`)
 * must be explicit projections of it, never a spread. It holds no bout seed: each fought bout's private seed is a
 * one-way value phase 2 stores with the bout row and passes to `runBout`, so nothing here lets one bout's revealed log
 * predict another bout's seed.
 */
export type TournamentGraph = DeepReadonly<{
  id: string; seasonId: string; league: LeagueId; slotIndex: number; rulesVersion: string;
  startsAtMs: number; settlesAtMs: number;
  /** Bracket slots (the next power of two) and rounds (`log2(size)`). */
  size: number; rounds: number;
  /** `revealAtMs[r − 1]` is round r's reveal time. */
  revealAtMs: number[];
  entries: TournamentEntry[];
  bouts: BracketBout[];
}>;

/** Standard bracket seeding order for `size` slots (1-8, 4-5, 2-7, 3-6 for 8): byes, the highest ranks, spread apart. */
function seedingOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) order = order.flatMap(rank => [rank, 2 * order.length + 1 - rank]);
  return order;
}
const boutId = (tournamentId: string, round: number, position: number) => `${tournamentId}:${round}:${position}`;
type Skeleton = Pick<BracketBout, 'id' | 'battleId' | 'round' | 'position' | 'parentBoutIds' | 'placed' | 'bye' | 'revealAtMs'>;
/**
 * The seed-independent bracket frame for entrants in rank order: the next power-of-two size, stable ids and parents,
 * standard-position placement and the reveal schedule. Round r of R reveals at `durationMs × r / (R + 1)` after the
 * start, rounded up to a whole millisecond so a reveal is never early; everything settles at `durationMs`.
 */
function frame(slotIndex: number, league: LeagueId, ranked: readonly string[], rules: Rules) {
  let size = 1, rounds = 0;
  while (size < ranked.length) { size *= 2; rounds += 1; }
  const id = `tournament:${slotIndex}:${league}`;
  const startsAtMs = slotIndex * rules.clock.slotMs;
  const duration = rules.tournament.durationMs;
  const revealAtMs = [...Array(rounds).keys()].map(i => startsAtMs + Math.ceil(duration * (i + 1) / (rounds + 1)));
  const order = seedingOrder(size);
  const at = (rank: number) => (rank <= ranked.length ? ranked[rank - 1] : null);
  const bouts: Skeleton[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (let position = 0; position < size >> round; position += 1) {
      const placed: [string | null, string | null] | null = round === 1 ? [at(order[2 * position]), at(order[2 * position + 1])] : null;
      const bid = boutId(id, round, position);
      bouts.push({ id: bid, battleId: bid, round, position,
        parentBoutIds: round === 1 ? [] : [boutId(id, round - 1, 2 * position), boutId(id, round - 1, 2 * position + 1)],
        placed, bye: placed !== null && placed.includes(null), revealAtMs: revealAtMs[round - 1] });
    }
  }
  return { id, size, rounds, startsAtMs, settlesAtMs: startsAtMs + duration, revealAtMs, bouts };
}

/**
 * Spec §8.2 bracket for one league's eligible entrants (at least the minimum, v1: two) on a tournament slot: seeded
 * random placement into the next power-of-two single-elimination bracket. Ranks follow a per-entrant seeded key (then
 * id), so the result does not depend on input order; ranks 1 … (size − n) meet an empty slot in standard bracket
 * positions, so no bout has two byes and no NPC is ever added. Byes resolve at once with no battle. Every bout uses the
 * entrants' frozen initial snapshots at full health. Bout ids `tournament:<slot>:<league>:<round>:<position>` are
 * stable for any seed. Days, minimum, rating floor, clock and reveal schedule come from the entrants' one shared
 * retained rules version, which the graph records.
 */
export function buildBracket(entries: readonly ArenaEntrant[], seed: Seed): TournamentGraph {
  if (!Array.isArray(entries) || entries.length === 0 || !nonEmpty(seed)) {
    throw new RangeError('A tournament needs entrants and a private seed');
  }
  const rules = sharedRules(entries.map(entry => entry?.fighter));
  if (entries.length < rules.tournament.minimumEntrants) throw new RangeError('A tournament needs the minimum number of entrants');
  const first = entries[0];
  const slotIndex = first?.slotIndex;
  if (!count(slotIndex) || !isTournamentSlot(slotAt(slotIndex * rules.clock.slotMs), rules)) throw new RangeError('Not a tournament slot');
  const ids = new Set<string>(), activities = new Set<string>();
  const copies = entries.map(entry => {
    const copy = copyEntrant(entry, slotIndex, first.seasonId, rules);
    if (copy.league !== first.league || ids.has(copy.gladiatorId) || activities.has(copy.activityId)) throw new RangeError('Invalid tournament entrant');
    ids.add(copy.gladiatorId);
    activities.add(copy.activityId);
    return { copy, key: seededRandom(`${seed}:tournament:${copy.gladiatorId}`)() };
  });
  copies.sort((a, b) => a.key - b.key || (a.copy.gladiatorId < b.copy.gladiatorId ? -1 : 1));
  const { bouts, ...shape } = frame(slotIndex, first.league, copies.map(c => c.copy.gladiatorId), rules);
  return freezeDomain({ ...shape, seasonId: first.seasonId, league: first.league, slotIndex, rulesVersion: rules.version,
    entries: copies.map(({ copy }, i) => ({ gladiatorId: copy.gladiatorId, activityId: copy.activityId, rating: copy.rating,
      fighter: copy.fighter, rank: i + 1 })),
    bouts: bouts.map(bout => ({ ...bout,
      result: bout.bye ? { winnerId: bout.placed!.find(entrant => entrant !== null)!, loserId: null, log: null } : null })) });
}

const sameList = (a: unknown, b: readonly unknown[] | null) =>
  b === null ? a === null : Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);
/** The two entrants of a fought bout once known: round 1 placement, or both parents' winners. Null otherwise. */
function sidesOf(bout: Skeleton, winners: ReadonlyMap<string, string>): [string, string] | null {
  const sides = bout.round === 1 ? bout.placed! : bout.parentBoutIds.map(parent => winners.get(parent) ?? null);
  return sides[0] !== null && sides[1] !== null ? [sides[0], sides[1]] : null;
}
const winnersOf = (graph: TournamentGraph) =>
  new Map(graph.bouts.flatMap(b => (b.result === null ? [] : [[b.id, b.result.winnerId] as [string, string]])));

/**
 * Fails closed unless a stored graph is internally consistent: retained rules, valid frozen entries in rank order, and
 * every bout matching the frame those ranks imply (ids, parents, placement, byes, reveal times), with results only where
 * both entrants are known, the winner is one of them and the stored log passes `recordBout`'s checks. A bye's result is
 * its placed entrant.
 */
function checkGraph(graph: TournamentGraph): void {
  const fail = (): never => { throw new RangeError('Invalid tournament graph'); };
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.entries) || !Array.isArray(graph.bouts)) fail();
  let rules: Rules;
  try { rules = rulesFor(graph.rulesVersion); } catch { return fail(); }
  if (graph.entries.length < rules.tournament.minimumEntrants || !count(graph.slotIndex) || !LEAGUES.includes(graph.league)
    || !nonEmpty(graph.seasonId)) fail();
  const ids = new Set<string>(), activities = new Set<string>();
  graph.entries.forEach((entry, i) => {
    if (!entry || !nonEmpty(entry.gladiatorId) || !nonEmpty(entry.activityId) || ids.has(entry.gladiatorId)
      || activities.has(entry.activityId) || !count(entry.rating) || entry.rating < rules.rating.minimum || entry.rank !== i + 1
      || entry.fighter?.rulesVersion !== graph.rulesVersion) fail();
    try { validCopy(entry.fighter); } catch { fail(); }
    ids.add(entry.gladiatorId);
    activities.add(entry.activityId);
  });
  const expected = frame(graph.slotIndex, graph.league, graph.entries.map(e => e.gladiatorId), rules);
  if (graph.id !== expected.id || graph.size !== expected.size || graph.rounds !== expected.rounds
    || graph.startsAtMs !== expected.startsAtMs || graph.settlesAtMs !== expected.settlesAtMs
    || !sameList(graph.revealAtMs, expected.revealAtMs) || graph.bouts.length !== expected.bouts.length) fail();
  const winners = new Map<string, string>();
  graph.bouts.forEach((bout, i) => {
    const s = expected.bouts[i];
    if (!bout || bout.id !== s.id || bout.battleId !== s.battleId || bout.round !== s.round || bout.position !== s.position
      || !sameList(bout.parentBoutIds, s.parentBoutIds) || !sameList(bout.placed, s.placed) || bout.bye !== s.bye
      || bout.revealAtMs !== s.revealAtMs) fail();
    const result = bout.result;
    if (result === null) { if (s.bye) fail(); return; }
    if (!result || typeof result !== 'object') fail();
    if (s.bye) {
      if (result.winnerId !== s.placed!.find(id => id !== null) || result.loserId !== null || result.log !== null) fail();
    } else {
      // A stored result passes the same log checks as `recordBout`, so a graph with stub or altered logs never settles.
      const sides = sidesOf(s, winners);
      if (!sides || !sides.includes(result.winnerId) || result.loserId !== sides.find(id => id !== result.winnerId)
        || !logBelongs(graph, s, sides, result.log) || result.log?.winnerId !== result.winnerId) fail();
    }
    winners.set(bout.id, result.winnerId);
  });
}

/** One bout entrant: identity, activity and the frozen initial snapshot it fights with in every round. */
export type BoutSide = DeepReadonly<{ gladiatorId: string; activityId: string; fighter: FighterSnapshot }>;
/**
 * One bounded simulation job: a single fought bout whose parents are resolved. It carries no seed: phase 2 supplies the
 * bout's own stored one-way seed to `runBout`. Retries reuse that seed and these snapshots, so they reproduce the same
 * log; participants start at full health.
 */
export type BoutJob = DeepReadonly<{
  tournamentId: string; boutId: string; battleId: string; round: number; position: number; parentBoutIds: string[];
  rulesVersion: string; revealAtMs: number;
  sides: [BoutSide, BoutSide];
}>;

/**
 * The bouts phase 2 may simulate now, one job each, in round then position order: unresolved fought bouts whose
 * entrants are known (round 1, or both parents resolved). Byes are resolved at build time and never appear.
 */
export function readyBouts(graph: TournamentGraph): BoutJob[] {
  checkGraph(graph);
  const winners = winnersOf(graph);
  const entries = new Map(graph.entries.map(entry => [entry.gladiatorId, entry]));
  return graph.bouts.flatMap(bout => {
    const sides = bout.result === null ? sidesOf(bout, winners) : null;
    if (!sides) return [];
    const side = (id: string): BoutSide => ({ gladiatorId: id, activityId: entries.get(id)!.activityId, fighter: entries.get(id)!.fighter });
    return [freezeDomain({ tournamentId: graph.id, boutId: bout.id, battleId: bout.battleId, round: bout.round, position: bout.position,
      parentBoutIds: [...bout.parentBoutIds], rulesVersion: graph.rulesVersion, revealAtMs: bout.revealAtMs,
      sides: [side(sides[0]), side(sides[1])] as [BoutSide, BoutSide] })];
  });
}

/**
 * Simulates one bout job with the canonical engine under its retained rules and `seed`, the bout's own private seed as
 * phase 2 storage supplies it (a one-way derivation per bout, never derived here from a shared tournament seed). Both
 * participants start at full health (no `startingHealth`); their battle ids are their gladiator ids. `names` only
 * labels the log (default `Gladiator`, as for expeditions); it never changes the outcome.
 */
export function runBout(job: BoutJob, seed: Seed, names: Readonly<Record<string, string>> = {}): BattleLog {
  const rules = rulesFor(job?.rulesVersion);
  const sides = job.sides;
  if (!Array.isArray(sides) || sides.length !== 2 || !nonEmpty(job.battleId) || !nonEmpty(seed)) throw new RangeError('Invalid bout job');
  const name = (id: string) => (names !== null && typeof names === 'object' && Object.hasOwn(names, id) && nonEmpty(names[id]) ? names[id] : 'Gladiator');
  const participant = (side: BoutSide) => ({ id: side.gladiatorId, gladiatorId: side.gladiatorId, name: name(side.gladiatorId), snapshot: side.fighter });
  return simulateBattle({ battleId: job.battleId, rulesVersion: rules.version, rules, fighters: [participant(sides[0]), participant(sides[1])] }, seed);
}

/** Canonical JSON (sorted object keys), so a stored log replays equal whatever key order its storage returns. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]])) : v));
}
/**
 * A revealed combatant fought as `id` with that entrant's frozen snapshot, from full health: every snapshot field the
 * engine reveals, including efficiency in basis points (the engine's `round(efficiency × 10,000)`) and the visible
 * equipment silhouettes in order.
 */
function sameCombatant(p: BattleLog['participants'][number] | undefined, id: string, f: FighterSnapshot): boolean {
  return !!p && p.id === id && p.gladiatorId === id && p.classId === f.classId && p.stance === f.stance
    && p.maxHealth === f.maxHealth && p.initialHealth === f.maxHealth && p.armor === f.armor && p.weaponDamage === f.weaponDamage
    && p.attackIntervalMs === f.attackIntervalMs && canonical(p.attributes) === canonical(f.attributes)
    && p.efficiencyBasisPoints === Math.round(f.efficiency * 10_000) && sameList(p.equipmentSilhouettes, f.equipmentSilhouettes);
}
/**
 * The log checks shared by `recordBout` and every stored result (`checkGraph`): this bout's battle under the graph's
 * rules, exactly the two known entrants in job order on their frozen snapshots at full health, and a winner among them.
 */
function logBelongs(graph: TournamentGraph, bout: Skeleton, sides: readonly [string, string], log: unknown): boolean {
  const l = log as BattleLog | null;
  const fighter = (id: string) => graph.entries.find(entry => entry.gladiatorId === id)?.fighter;
  return !!l && typeof l === 'object' && l.battleId === bout.battleId && l.rulesVersion === graph.rulesVersion
    && Array.isArray(l.participants) && l.participants.length === 2
    && sides.every((id, i) => { const f = fighter(id); return !!f && sameCombatant(l.participants[i], id, f); })
    && sides.includes(l.winnerId);
}

/**
 * Records one ready bout's revealed log and returns the new frozen graph; the input graph is unchanged. The log must be
 * this bout's battle under the graph's rules, with the two known entrants in job order on their frozen snapshots at full
 * health. The winner is `log.winnerId`, including a seeded simultaneous-defeat winner at 0 HP. Recording the same log
 * again returns the graph unchanged (a retried completion); a different log for a resolved bout is rejected.
 */
export function recordBout(graph: TournamentGraph, boutId: string, log: BattleLog): TournamentGraph {
  checkGraph(graph);
  const index = graph.bouts.findIndex(b => b.id === boutId);
  const bout = graph.bouts[index];
  if (!bout || bout.bye) throw new RangeError('Not a fought tournament bout');
  const sides = sidesOf(bout, winnersOf(graph));
  if (!sides) throw new RangeError('Tournament bout is not ready');
  if (!logBelongs(graph, bout, sides, log)) throw new RangeError('Battle log does not belong to the tournament bout');
  if (bout.result !== null) {
    if (canonical(bout.result.log) === canonical(log)) return graph;
    throw new RangeError('Tournament bout already has a different result');
  }
  const result = { winnerId: log.winnerId, loserId: sides.find(id => id !== log.winnerId)!, log: structuredClone(log) as BattleLog };
  return freezeDomain({ ...graph, bouts: graph.bouts.map((b, i) => (i === index ? { ...b, result } : b)) });
}

/** The completed graph's fought bouts in round, then position, order; fails closed while any bout is unresolved. */
function completedBouts(graph: TournamentGraph) {
  checkGraph(graph);
  if (graph.bouts.some(bout => bout.result === null)) throw new RangeError('The tournament is not complete');
  return graph.bouts.filter(bout => !bout.bye).map(bout => ({ bout, winnerId: bout.result!.winnerId, loserId: bout.result!.loserId! }));
}

/** One fought bout's Elo update, from the ratings left by every earlier round. */
export type RatedBout = DeepReadonly<{
  boutId: string; round: number; winnerId: string; loserId: string;
  winnerBefore: number; winnerAfter: number; loserBefore: number; loserAfter: number;
}>;
/** Every rated bout in round order, and each entry's rating before and after the tournament (entry order). */
export type TournamentRatings = DeepReadonly<{
  bouts: RatedBout[];
  ratings: { gladiatorId: string; before: number; after: number; delta: number }[];
}>;

/**
 * Spec §8.1 tournament ratings for a completed bracket: human bouts apply Elo (`applyRatingDelta` under the graph's
 * retained rules, clamped at their floor, v1: zero) in round order, each round starting from the ratings updated by
 * earlier rounds. Bouts of one round involve distinct players, so their order within the round does not matter. Byes
 * are not bouts and never change a rating.
 */
export function applyTournamentRatings(graph: TournamentGraph): TournamentRatings {
  const fought = completedBouts(graph);
  const rules = rulesFor(graph.rulesVersion);
  const current = new Map(graph.entries.map(entry => [entry.gladiatorId, entry.rating]));
  const bouts: RatedBout[] = [];
  for (let round = 1; round <= graph.rounds; round += 1) {
    const inRound = fought.filter(({ bout }) => bout.round === round);
    const players = inRound.flatMap(({ winnerId, loserId }) => [winnerId, loserId]);
    if (new Set(players).size !== players.length) throw new RangeError('A player appears twice in one tournament round');
    for (const { bout, winnerId, loserId } of inRound) {
      const winnerBefore = current.get(winnerId)!, loserBefore = current.get(loserId)!;
      const update = applyRatingDelta(winnerBefore, loserBefore, rules);
      current.set(winnerId, update.winner);
      current.set(loserId, update.loser);
      bouts.push({ boutId: bout.id, round, winnerId, loserId, winnerBefore, winnerAfter: update.winner, loserBefore, loserAfter: update.loser });
    }
  }
  return freezeDomain({ bouts, ratings: graph.entries.map(entry => ({ gladiatorId: entry.gladiatorId, before: entry.rating,
    after: current.get(entry.gladiatorId)!, delta: current.get(entry.gladiatorId)! - entry.rating })) });
}

/**
 * One immutable placement reward, additional to fight renown. Its id `<tournament id>:placement:<gladiator id>` is the
 * single grant identity; phase 2 carries it inside the entrant activity's one settlement outcome and receipt, which
 * settle at most once (no second grant guard).
 */
export type RewardGrant = DeepReadonly<{
  id: string; tournamentId: string; gladiatorId: string; activityId: string;
  kind: 'placement'; placement: 'winner' | 'runner-up' | 'semifinal' | 'entrant';
  /** 1 for the winner; a loser eliminated in round r of R shares place `2^(R − r) + 1` (2, 3, 5, 9, …). */
  place: number;
  money: number; renown: number;
}>;

/**
 * Spec §8.2 placement bonuses for a completed bracket, one per entrant, ordered by place then rank: the winner 100 money
 * and 50 renown, the runner-up 60 and 30, losers of the round before the final (semifinal losers) 30 and 15, every other
 * entrant 5 renown. A two-player bracket has no semifinal, so it awards only the winner and runner-up. A bye is never a
 * loss: a bye semifinal awards no semifinal placement.
 */
export function placementGrants(graph: TournamentGraph): RewardGrant[] {
  const fought = completedBouts(graph);
  const { placements } = rulesFor(graph.rulesVersion).tournament;
  const lostIn = new Map(fought.map(({ bout, loserId }) => [loserId, bout.round]));
  const grants = graph.entries.map(entry => {
    const round = lostIn.get(entry.gladiatorId);
    const [placement, amount] = round === undefined ? ['winner', placements.winner] as const
      : round === graph.rounds ? ['runner-up', placements.runnerUp] as const
        : round === graph.rounds - 1 ? ['semifinal', placements.semifinal] as const : ['entrant', placements.other] as const;
    return { id: `${graph.id}:placement:${entry.gladiatorId}`, tournamentId: graph.id, gladiatorId: entry.gladiatorId,
      activityId: entry.activityId, kind: 'placement' as const, placement,
      place: round === undefined ? 1 : 2 ** (graph.rounds - round) + 1, money: amount.money, renown: amount.renown, rank: entry.rank };
  });
  if (grants.filter(grant => grant.place === 1).length !== 1) throw new RangeError('A completed tournament has exactly one winner');
  return grants.sort((a, b) => a.place - b.place || a.rank - b.rank).map(({ rank: _rank, ...grant }) => freezeDomain(grant));
}

/**
 * One entrant's part in one bout. A `bye` is a renown-free, rating-free advance and is never a win; only fought bouts
 * are a human `win` or `loss`, earning fight renown and a rating change.
 */
export type EntrantBout = DeepReadonly<{ boutId: string; round: number; kind: 'bye' | 'win' | 'loss'; renown: number; ratingDelta: number }>;
/**
 * One entrant's complete tournament settlement, for its single activity of the slot: fight renown (10 a win, 2 a loss,
 * nothing for a bye) plus its placement grant, the round-ordered rating change, and `victory` only for the winner.
 * `wins` and `losses` count fought human bouts only, never byes: they are the standings counters and the human bouts
 * of the five-bout season rule. Never XP, attribute points or items. An eliminated entrant keeps this one activity
 * until settlement at minute 80.
 */
export type TournamentOutcome = DeepReadonly<{
  gladiatorId: string; activityId: string; place: number; result: 'victory' | 'defeat'; success: boolean;
  bouts: EntrantBout[];
  wins: number; losses: number;
  placement: RewardGrant;
  rewards: CreditedRewards;
  ratingBefore: number; ratingAfter: number; ratingDelta: number;
}>;

/** Pure settlement of a completed bracket, one outcome per entry in rank order (spec §8.2, minute 80). */
export function tournamentOutcomes(graph: TournamentGraph): TournamentOutcome[] {
  const grants = new Map(placementGrants(graph).map(grant => [grant.gladiatorId, grant]));
  const rated = applyTournamentRatings(graph);
  const ratingOf = new Map(rated.ratings.map(rating => [rating.gladiatorId, rating]));
  const deltaOf = new Map(rated.bouts.flatMap(b => [[`${b.boutId}:${b.winnerId}`, b.winnerAfter - b.winnerBefore],
    [`${b.boutId}:${b.loserId}`, b.loserAfter - b.loserBefore]] as [string, number][]));
  const { humanWinRenown, humanLossRenown } = rulesFor(graph.rulesVersion).arena;
  return graph.entries.map(entry => {
    const id = entry.gladiatorId;
    const bouts = graph.bouts.flatMap((bout): EntrantBout[] => {
      const result = bout.result!;
      if (bout.bye) return result.winnerId === id ? [{ boutId: bout.id, round: bout.round, kind: 'bye', renown: 0, ratingDelta: 0 }] : [];
      if (result.winnerId !== id && result.loserId !== id) return [];
      const won = result.winnerId === id;
      return [{ boutId: bout.id, round: bout.round, kind: won ? 'win' : 'loss', renown: won ? humanWinRenown : humanLossRenown,
        ratingDelta: deltaOf.get(`${bout.id}:${id}`)! }];
    });
    const placement = grants.get(id)!, rating = ratingOf.get(id)!;
    const fightRenown = bouts.reduce((sum, bout) => sum + bout.renown, 0);
    return freezeDomain({ gladiatorId: id, activityId: entry.activityId, place: placement.place,
      result: placement.place === 1 ? 'victory' as const : 'defeat' as const, success: placement.place === 1, bouts,
      wins: bouts.filter(bout => bout.kind === 'win').length, losses: bouts.filter(bout => bout.kind === 'loss').length, placement,
      rewards: { money: placement.money, renown: fightRenown + placement.renown, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 },
      ratingBefore: rating.before, ratingAfter: rating.after, ratingDelta: rating.delta });
  });
}
