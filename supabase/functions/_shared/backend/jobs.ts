import { RULES_V1 } from '../domain/rules-v1.ts';
import { validateBuild } from '../domain/build.ts';
import { activityCost, deriveStats } from '../domain/stats.ts';
import { freezeDomain } from '../domain/types.ts';
import { planExpedition } from '../domain/expedition.ts';
import { makeFighter, simulateBattle } from '../domain/combat.ts';
import { arenaNpcName, arenaOutcomes, estimateArenaStrength, leagueFor, makeFallback, matchArena, nonEmpty } from '../domain/arena.ts';
import type { ArenaAssignment, ArenaEntrant, ArenaOutcome, PairingHistory } from '../domain/arena.ts';
import { buildBracket, isTournamentSlot, partitionTournament, readyBouts, recordBout, runBout, tournamentOutcomes } from '../domain/tournament.ts';
import type { OptInRevision, TournamentCandidate, TournamentGraph, TournamentOutcome, TournamentRoute } from '../domain/tournament.ts';
import { slotAt } from '../domain/clock.ts';
import type { ActivityChoice, LeagueId } from '../contracts/commands.ts';
import type { BattleLog } from '../contracts/events.ts';
import type { ActivitySnapshot, BattleParticipant, DeepReadonly, FighterSnapshot, Seed, SlotWindow } from '../domain/types.ts';
import type { ActivityCosts, ActivityKind, BuildInput, CoordinatorReport, ItemInstance, JobKind, JobLease, PreparationInput, PreparationResult, WorkerReport } from '../domain/types.ts';
import type { ExecutorIo, ExecutorRegistry, JobOutcome, TournamentBoutRead, WorkerDependencies } from './database.ts';

/** Spec 10.4 batch limits and lease length; CPU measurements may lower the batch sizes without changing semantics. */
export const WORKER_LIMITS = Object.freeze({ simple: 20, combat: 5, cpuMs: 2_000, leaseMs: 120_000, renewBelowMs: 60_000 });

/** Stable, secret-free failure codes. Raw exception text is never stored, logged or returned. */
export type FailureCode = 'unsupported-rules' | 'unsupported-executor' | 'invalid-input' | 'invalid-build' | 'invalid-result' | 'execution-failed';
export class WorkerFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'WorkerFailure'; }
}

const ACTIVITY_KINDS: readonly ActivityKind[] = ['training', 'rest', 'expedition', 'arena', 'tournament'];
/**
 * Canonical v1 boundary recompute: legal build snapshot, derived stats and versioned stamina costs. Task 16 adds the
 * frozen arena fighter, its NPC fallback template, its visible strength estimate and the league placement, so SQL
 * compares pairing results with these values instead of restating makeFighter, makeFallback or leagueFor.
 */
export function prepareActivityV1(input: PreparationInput): PreparationResult {
  if (!input || typeof input !== 'object' || !input.build || !Array.isArray(input.items)) throw new WorkerFailure('invalid-input');
  if (input.rulesVersion !== RULES_V1.version) throw new WorkerFailure('unsupported-rules');
  const build: BuildInput = { classId: input.build.classId, stance: input.build.stance,
    allocation: { ...input.build.allocations }, equipment: { ...input.build.equipment } };
  const validation = validateBuild(build, structuredClone(input.items) as ItemInstance[], input.earnedPoints, input.level);
  if (!validation.ok) throw new WorkerFailure('invalid-build');
  const derived = deriveStats(validation.snapshot, RULES_V1);
  const costs = Object.fromEntries(ACTIVITY_KINDS.map(kind => [kind, activityCost(RULES_V1.activityStamina[kind], derived.overload)])) as ActivityCosts;
  const arenaFighter = makeFighter(validation.snapshot, 'arena', RULES_V1);
  return { rulesVersion: RULES_V1.version, snapshot: structuredClone(validation.snapshot) as PreparationResult['snapshot'], derived,
    staminaMaximum: derived.maxStamina, costs, trainingPoints: RULES_V1.progression.trainingPoints,
    // A job frozen before Task 8 has no gear history. SQL never lowers a placement, so 0 can only delay a promotion.
    league: leagueFor(input.level, input.earnedPoints, input.peakStrength ?? 0, RULES_V1),
    arenaFighter: structuredClone(arenaFighter) as FighterSnapshot, npcTemplate: structuredClone(makeFallback(arenaFighter)) as FighterSnapshot,
    arenaStrength: estimateArenaStrength(arenaFighter) };
}

/**
 * Task 19: one Arena-requesting activity's frozen tournament inputs at the slot cutoff: its schedule choice, starting
 * stamina, the versioned Arena and tournament costs, and the opt-in in force at the cutoff. SQL freezes the opt-in under
 * the account and character locks at phase 5 and passes it as one revision received at cutoff − 1 ms.
 */
export type PairingCandidate = DeepReadonly<{
  gladiatorId: string; choice: ActivityChoice; stamina: number; costs: { arena: number; tournament: number }; optIn: OptInRevision[];
}>;
/** One slot and league's frozen regular-Arena entrants, written by `private.boundary_pair` at phase 7 (Task 16). */
export type PairingInput = DeepReadonly<{
  slotIndex: number; league: LeagueId; seasonId: string; rulesVersion: string;
  /** The earliest slot SQL searched for human bouts (S − 18 in v1); the executor fails closed on a narrower window. */
  historyFromSlot: number;
  /** The Arena entrants that afforded Arena at boundary step 6. */
  entrants: ArenaEntrant[]; recent: PairingHistory[];
  /**
   * Task 19, written for every slot since M11: the bracket's one-way placement seed (never the job seed), the Arena
   * requests that step 6 replaced with Rest, and one candidate per entrant and per such Rest fallback. Absent only from
   * inputs frozen before M11.
   */
  tournament?: { bracketSeed: Seed; rested: ArenaEntrant[]; candidates: PairingCandidate[] };
}>;
/** Task 19: one route per candidate, and the league's bracket when it has one (checked by `checkGraph` before completion). */
export type PairingResult = { assignments: ArenaAssignment[]; tournament?: { routes: TournamentRoute[]; bracket: TournamentGraph | null } };
/**
 * Canonical v1 pairing: spec §8.1 `matchArena` on the frozen entrants and history, under the pairing job's private seed.
 * Since Task 19 the job first runs spec §8.2's `partitionTournament` over every Arena request of its league, then
 * `buildBracket` under the separate placement seed when the league has a bracket, and `matchArena` exactly once over the
 * rest. No entrant is in both. SQL restates none of these rules; it checks the result against the frozen values.
 */
export function pairArenaV1(input: PairingInput, seed: Seed): PairingResult {
  if (!input || typeof input !== 'object' || !Array.isArray(input.entrants) || !Array.isArray(input.recent)) throw new WorkerFailure('invalid-input');
  if (input.rulesVersion !== RULES_V1.version) throw new WorkerFailure('unsupported-rules');
  // One job pairs exactly one slot, season and league; a mixed input is corrupt rather than a cross-league pairing.
  const inScope = (entrant: ArenaEntrant | null | undefined) => !!entrant && entrant.league === input.league
    && entrant.slotIndex === input.slotIndex && entrant.seasonId === input.seasonId;
  if (!input.entrants.every(inScope)) throw new WorkerFailure('invalid-input');
  // SQL bounds the history it passes; a window shorter than this version's own would silently drop counted bouts.
  if (!Number.isSafeInteger(input.historyFromSlot) || !Number.isSafeInteger(input.slotIndex)
    || input.historyFromSlot > input.slotIndex - RULES_V1.matchmaking.recentPairingSlots) throw new WorkerFailure('invalid-input');
  let slot: SlotWindow;
  try { slot = slotAt(input.slotIndex * RULES_V1.clock.slotMs); } catch { throw new WorkerFailure('invalid-input'); }
  const tournament = input.tournament;
  if (tournament === undefined) {
    // A pre-M11 input pairs as before, but on a tournament slot that would silently turn a bracket into regular Arena.
    if (isTournamentSlot(slot, RULES_V1)) throw new WorkerFailure('invalid-input');
    return { assignments: matchArena(input.entrants, input.recent, seed) };
  }
  if (!tournament || typeof tournament !== 'object' || !nonEmpty(tournament.bracketSeed) || tournament.bracketSeed === seed
    || !Array.isArray(tournament.rested) || !Array.isArray(tournament.candidates) || !tournament.rested.every(inScope)) {
    throw new WorkerFailure('invalid-input');
  }
  // Every entrant and Rest fallback is exactly one candidate, and every candidate is one of them.
  const pool = new Map<string, ArenaEntrant>();
  for (const entrant of [...input.entrants, ...tournament.rested]) {
    if (!nonEmpty(entrant.gladiatorId) || pool.has(entrant.gladiatorId)) throw new WorkerFailure('invalid-input');
    pool.set(entrant.gladiatorId, entrant);
  }
  const used = new Set<string>();
  const candidates: TournamentCandidate[] = tournament.candidates.map(candidate => {
    const entrant = candidate && typeof candidate === 'object' ? pool.get(candidate.gladiatorId) : undefined;
    if (!entrant || used.has(entrant.gladiatorId)) throw new WorkerFailure('invalid-input');
    used.add(entrant.gladiatorId);
    return { entrant, choice: candidate.choice, stamina: candidate.stamina, costs: candidate.costs, optIn: candidate.optIn };
  });
  if (used.size !== pool.size) throw new WorkerFailure('invalid-input');
  try {
    const partition = partitionTournament(slot, candidates);
    const [own, ...others] = partition.brackets;
    if (others.length > 0 || (own && own.league !== input.league)) throw new RangeError('A pairing job holds one league');
    const bracket = own ? buildBracket(own.entrants, tournament.bracketSeed) : null;
    // `readyBouts` runs `checkGraph`: the graph is validated before completion, as every later bout executor will again.
    if (bracket) readyBouts(bracket);
    return { assignments: matchArena(partition.arena, input.recent, seed), tournament: { routes: [...partition.routes], bracket } };
  } catch {
    throw new WorkerFailure('invalid-input');
  }
}

/**
 * The one regular-Arena simulation of a battle, written by `private.prepare_activity_jobs` at phase 8 (Task 16). Its job
 * carries the battle's private seed, not an activity seed. `assignment` is the immutable frozen assignment: the only
 * source of fighters and of the NPC template. `names` are the human sides' public names in side order. `revealAtMs`
 * restates the minute-60 reveal that SQL schedules; the executor checks it against these rules.
 */
export type ArenaSimulationInput = DeepReadonly<{
  kind: 'arena'; battleId: string; slotIndex: number; rulesVersion: string; startsAtMs: number; revealAtMs: number;
  assignment: ArenaAssignment; names: string[];
}>;
/** The bout's log and each side's outcome in assignment order, validated and frozen once by `private.accept_arena_result`. */
export type ArenaSimulationResult = { battleId: string; log: BattleLog; outcomes: ArenaOutcome[] };
/**
 * Canonical v1 regular bout: one `simulateBattle` of the frozen assignment under the battle seed, then `arenaOutcomes`.
 * Fighters are never rebuilt from stored build snapshots (JSONB reorders equipment keys, which would change the logged
 * silhouette order). A human participant's id is its gladiatorId; the NPC is `opponent.id` with a null gladiatorId.
 */
export function simulateArenaV1(input: ArenaSimulationInput, seed: Seed): ArenaSimulationResult {
  if (!input || typeof input !== 'object') throw new WorkerFailure('invalid-input');
  if (input.rulesVersion !== RULES_V1.version) throw new WorkerFailure('unsupported-rules');
  const { assignment, names } = input;
  if (!assignment || typeof assignment !== 'object' || !Array.isArray(assignment.sides) || !Array.isArray(names)
    || assignment.battleId !== input.battleId || assignment.slotIndex !== input.slotIndex || !Number.isSafeInteger(input.slotIndex)
    || input.startsAtMs !== input.slotIndex * RULES_V1.clock.slotMs || input.revealAtMs !== input.startsAtMs + RULES_V1.arena.revealAfterMs
    || names.length !== assignment.sides.length || !names.every(nonEmpty)) throw new WorkerFailure('invalid-input');
  const human = (index: number): BattleParticipant => {
    const side = assignment.sides[index];
    return { id: side.gladiatorId, gladiatorId: side.gladiatorId, name: names[index], snapshot: side.fighter };
  };
  try {
    const fighters: [BattleParticipant, BattleParticipant] = assignment.kind === 'human' && assignment.sides.length === 2 ? [human(0), human(1)]
      : assignment.kind === 'npc' && assignment.sides.length === 1
        ? [human(0), { id: assignment.opponent.id, gladiatorId: null, name: arenaNpcName(assignment.league), snapshot: assignment.opponent.snapshot }]
        : (() => { throw new RangeError('Unknown arena assignment'); })();
    const log = simulateBattle({ battleId: assignment.battleId, rulesVersion: RULES_V1.version, rules: RULES_V1, fighters }, seed);
    return { battleId: assignment.battleId, log, outcomes: arenaOutcomes(assignment, log) };
  } catch {
    throw new WorkerFailure('invalid-input');
  }
}

/**
 * The input of one tournament bout's simulation job, written at phase 8 (Task 19): which bout of which tournament, never
 * its participants, which depend on earlier results, nor its seed, which the job itself carries.
 */
export type TournamentBoutInput = DeepReadonly<{ kind: 'tournament-bout'; tournamentId: string; boutId: string }>;
/**
 * One simulated bout. `log.battleId` is the bout id; the fenced acceptance validates and stores it once. The final also
 * carries `outcomes`: `tournamentOutcomes` of the graph it completes, one per entrant in rank order (placements, fight
 * renown, round-ordered ratings), which acceptance checks against the stored results and freezes for each entrant's
 * settlement at minute 80. Every earlier bout has no `outcomes` key.
 */
export type TournamentBoutResult = { boutId: string; log: BattleLog; outcomes?: TournamentOutcome[] };
/**
 * Canonical v1 tournament bout: the stored graph read under the job's current lease (`public.tournament_bout_input`)
 * is rebuilt and checked by `readyBouts` (its `checkGraph` refuses stub or altered stored logs); the bout must be ready,
 * so a child fights its parents' stored winners. `runBout` simulates it from the frozen entries at full health under the
 * bout's own one-way seed, labelled with the frozen names, and `recordBout` applies the full log fence before the worker
 * completes the job. The final, which completes the graph, also returns every entrant's `tournamentOutcomes`. A bye, an
 * unready, resolved or unknown bout, a refused read or missing name fails closed.
 */
export function simulateTournamentBoutV1(input: TournamentBoutInput, read: TournamentBoutRead, seed: Seed): TournamentBoutResult {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 3 || input.kind !== 'tournament-bout'
    || !nonEmpty(input.tournamentId) || !nonEmpty(input.boutId) || !nonEmpty(seed)) throw new WorkerFailure('invalid-input');
  if (!read || read.ok !== true || !read.graph || typeof read.graph !== 'object') throw new WorkerFailure('invalid-input');
  const { graph, names } = read;
  if (graph.rulesVersion !== RULES_V1.version) throw new WorkerFailure('unsupported-rules');
  if (graph.id !== input.tournamentId) throw new WorkerFailure('invalid-input');
  try {
    const job = readyBouts(graph).find(bout => bout.boutId === input.boutId);
    const named = (id: string) => !!names && typeof names === 'object' && Object.hasOwn(names, id) && nonEmpty(names[id]);
    if (!job || !job.sides.every(side => named(side.gladiatorId))) throw new RangeError('The tournament bout is not ready');
    const log = runBout(job, seed, names);
    const recorded = recordBout(graph, job.boutId, log);
    if (job.round !== graph.rounds) return { boutId: job.boutId, log };
    return { boutId: job.boutId, log, outcomes: [...tournamentOutcomes(recorded)] };
  } catch {
    throw new WorkerFailure('invalid-input');
  }
}

/**
 * `v1.simulation` dispatches on an explicit discriminator. An Arena input carries `kind: 'arena'`, a tournament bout
 * `kind: 'tournament-bout'`; an expedition job's input is its activity snapshot, which has no `kind` and whose choice is
 * an expedition. Anything else is unsupported.
 */
function simulateV1(job: JobLease, io?: ExecutorIo): unknown {
  const input: unknown = job.snapshot;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (Object.hasOwn(input, 'kind')) {
      const kind = (input as { kind?: unknown }).kind;
      if (kind === 'arena') return simulateArenaV1(input as ArenaSimulationInput, job.seed);
      if (kind === 'tournament-bout') {
        if (!io) throw new WorkerFailure('invalid-input');
        // The parents' winners come from storage under this job's own lease, never from the job input.
        return io.database.tournamentBoutInput(job.id, job.token)
          .then(read => simulateTournamentBoutV1(input as TournamentBoutInput, read, job.seed));
      }
    } else if ((input as { choice?: { kind?: unknown } }).choice?.kind === 'expedition') {
      return planExpedition(input as ActivitySnapshot, job.seed, RULES_V1);
    }
  }
  throw new WorkerFailure('unsupported-executor');
}

/** Keep every retained rules version registered: a job always runs with the version persisted on it. */
export const DEFAULT_EXECUTORS: ExecutorRegistry = Object.freeze({
  v1: Object.freeze({ prepare: (job: JobLease) => prepareActivityV1(job.snapshot as PreparationInput),
    pair: (job: JobLease) => pairArenaV1(job.snapshot as PairingInput, job.seed),
    simulation: simulateV1,
    // SQL selects the immutable stage by ordinal; no worker-supplied stage payload is trusted here.
    reveal: () => ({}) }),
});

/**
 * One bounded invocation: settle, then prepare, then pair, then reveal (≤20 simple), then any pairing its own coordination
 * released (≤5, claimed one at a time within the compute budget), or else ≤5 combat simulations.
 */
export async function runWorker(deps: WorkerDependencies): Promise<WorkerReport> {
  const executors = deps.executors ?? DEFAULT_EXECUTORS;
  const now = deps.now ?? Date.now;
  const cpuNow = deps.cpuNow ?? (() => performance.now());
  let computeMs = 0;
  const report: WorkerReport = { claimed: 0, completed: 0, replayed: 0, failed: 0, conflicts: 0, unrecorded: 0,
    byKind: { prepare: 0, pair: 0, simulation: 0, reveal: 0, settlement: 0 }, coordination: null };
  const record = (outcome: JobOutcome) => {
    if (!outcome.ok) report.conflicts += 1;
    else if (outcome.replayed) report.replayed += 1;
    else report.completed += 1;
  };
  /** Coordination failing must never stop claimable work: due jobs still drain, and the report says coordination was unreachable. */
  async function coordinate(): Promise<CoordinatorReport> {
    try {
      return await deps.database.coordinate();
    } catch {
      return { ok: false, code: 'coordinator-unavailable', publishedSlot: null };
    }
  }
  async function execute(job: JobLease): Promise<unknown> {
    const versioned = Object.hasOwn(executors, job.rulesVersion) ? executors[job.rulesVersion] : undefined;
    if (!versioned) throw new WorkerFailure('unsupported-rules');
    const executor = job.kind === 'settlement' ? undefined : versioned[job.kind];
    if (!executor) throw new WorkerFailure('unsupported-executor');
    return executor(job, { database: deps.database });
  }
  async function process(raw: JobLease): Promise<void> {
    let job = freezeDomain(structuredClone(raw)) as JobLease;
    report.claimed += 1;
    report.byKind[job.kind] += 1;
    if (computeMs >= WORKER_LIMITS.cpuMs) { report.deferred = (report.deferred ?? 0) + 1; return; }
    try {
      async function renewIfNeeded(): Promise<boolean> {
        if (job.expiresAtMs - now() >= WORKER_LIMITS.renewBelowMs) return true;
        const renewed = await deps.database.renew(job.id, job.token);
        if (!renewed.ok) { report.conflicts += 1; return false; }
        job = freezeDomain({ ...job, expiresAtMs: renewed.expiresAtMs }) as JobLease;
        return true;
      }
      if (!await renewIfNeeded()) return;
      if (job.kind === 'settlement') {
        if (!job.activityId) throw new WorkerFailure('invalid-input');
        const settled = await deps.database.settle(job.activityId, job.token);
        // The database itself retained the job for operator action (an Arena rating mismatch): a recorded failure.
        if (!settled.ok && settled.code === 'operator') { report.failed += 1; return; }
        record(settled);
        return;
      }
      const began = cpuNow();
      let result: unknown;
      try { result = await execute(job); } finally { computeMs += Math.max(0, cpuNow() - began); }
      if (!await renewIfNeeded()) return;
      const outcome = await deps.database.complete(job.id, job.token, result);
      if (!outcome.ok && outcome.code === 'invalid') throw new WorkerFailure('invalid-result');
      record(outcome);
    } catch (error) {
      const code: FailureCode = error instanceof WorkerFailure ? error.code : 'execution-failed';
      try {
        // Fail only with the token this worker owns; a fenced or already-completed job reports conflict and is unchanged.
        const failed = await deps.database.fail(job.id, job.token, code);
        if (failed.ok) report.failed += 1; else report.conflicts += 1;
      } catch {
        // Nothing was recorded: the lease expires and the job is reclaimed with the same seed and input.
        report.unrecorded += 1;
      }
    }
  }
  report.coordination = await coordinate();
  let simple = WORKER_LIMITS.simple;
  // Pairing follows preparation: completed preparations release a boundary's phases 5–7, whose pairing jobs this same
  // invocation can then claim before any reveal.
  for (const kind of ['settlement', 'prepare', 'pair', 'reveal'] as const satisfies readonly JobKind[]) {
    if (simple <= 0 || computeMs >= WORKER_LIMITS.cpuMs) break;
    const jobs = await deps.database.claim(deps.workerId, kind, simple);
    if (!jobs.length) continue;
    simple -= jobs.length;
    for (const job of jobs) await process(job);
    // Settled slots or completed preparation can release the next ordered boundary phase.
    report.coordination = await coordinate();
  }
  // The invocation that completes a boundary's last preparation has usually spent its simple budget, so the pairing jobs
  // its own coordination released would wait a whole scheduled minute. Claim them one at a time, at most the combat batch
  // limit (a slot has one pairing job per league), checking the compute budget before each claim so that a spent budget
  // never leaves a claimed pairing job leased and unrun until its lease expires. The dispatch budget is unchanged.
  if (report.coordination?.boundaries?.some(b => b.status === 'waiting' && b.wait === 'pairing')) {
    let paired = 0;
    while (paired < WORKER_LIMITS.combat && computeMs < WORKER_LIMITS.cpuMs) {
      const [job] = await deps.database.claim(deps.workerId, 'pair', 1);
      if (!job) break;
      paired += 1;
      await process(job);
    }
    if (paired) report.coordination = await coordinate();
  }
  if (simple === WORKER_LIMITS.simple && computeMs < WORKER_LIMITS.cpuMs) {
    const jobs = await deps.database.claim(deps.workerId, 'simulation', WORKER_LIMITS.combat);
    for (const job of jobs) await process(job);
    if (jobs.length) report.coordination = await coordinate();
  }
  return report;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
/** Server-to-server only: the explicit worker secret is the sole authority. No body, time or seed input is read. */
export async function handleWorker(request: Request, deps: { secret: string; run: () => Promise<WorkerReport> }): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const [expected, supplied] = await Promise.all([digest(`Bearer ${deps.secret}`), digest(request.headers.get('Authorization') ?? '')]);
  // Fixed-length digest comparison avoids prefix/length timing differences on the secret itself.
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ supplied[index];
  if (!deps.secret || difference !== 0) return new Response(JSON.stringify({ ok: false, code: 'unauthenticated' }), { status: 401, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, code: 'invalid' }), { status: 405, headers });
  try {
    return new Response(JSON.stringify(await deps.run()), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ ok: false, code: 'unavailable' }), { status: 503, headers });
  }
}
