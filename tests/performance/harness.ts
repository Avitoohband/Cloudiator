import { cpus, platform, release, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_EXECUTORS, simulateTournamentBoutV1 } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { ArenaSimulationInput, ArenaSimulationResult, PairingInput, PairingResult, TournamentBoutInput, TournamentBoutResult } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { TournamentBoutRead } from '../../supabase/functions/_shared/backend/database.ts';
import { matchArena, type ArenaEntrant } from '../../supabase/functions/_shared/domain/arena.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { makeFighter } from '../../supabase/functions/_shared/domain/combat.ts';
import type { ExpeditionPlan } from '../../supabase/functions/_shared/domain/expedition.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { buildBracket, readyBouts, recordBout, runBout, type TournamentGraph } from '../../supabase/functions/_shared/domain/tournament.ts';
import { freezeDomain } from '../../supabase/functions/_shared/domain/types.ts';
import type { ActivitySnapshot, BuildSnapshot, FighterSnapshot, ItemInstance, JobLease } from '../../supabase/functions/_shared/domain/types.ts';
import { BUDGETS } from './capacity-model.ts';
import { recordMeasurement } from '../fixtures/measurements.ts';

// Task 23.3 worker benchmarks in pure code: builders for the heaviest v1 jobs and a timer. Each `run` does what one Edge
// invocation does for a job: parse the claimed lease (and any fenced read) from its JSON, freeze it as runWorker does, run
// the v1 executor, and serialize the result for complete_job. Nothing here touches a database.

/** The worker's per-invocation compute budget (`WORKER_LIMITS.cpuMs`, 2,000 ms) less a 25 % margin. */
export const BUDGET_MS = BUDGETS.workerMs;

const SLOT_MS = RULES_V1.clock.slotMs;
/** Slot 302 starts on Saturday 1970-01-17 at 18:40 UTC: an evening and a v1 tournament slot (as tests/db/tournaments.test.ts uses). */
const TOURNAMENT_SLOT = 302;
const UNEQUIPPED = { weapon: null, offHand: null, head: null, body: null, feet: null };
const build = (classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: BuildSnapshot['allocations'],
  equipment: Partial<Record<keyof typeof UNEQUIPPED, ItemInstance>> = {}): BuildSnapshot =>
  ({ rulesVersion: RULES_V1.version, classId, stance, allocations, equipment: { ...UNEQUIPPED, ...equipment } });
const item = (id: string): ItemInstance => {
  const entry = CATALOG_V1.items[id];
  return { id: `item-${id}`, ownerId: 'benchmark', catalogId: entry.id, catalogVersion: CATALOG_V1.version, tier: entry.tier, rarity: entry.rarity,
    stats: structuredClone(entry.stats), quantity: 1, origin: 'shop', binding: entry.binding, reservation: null };
};

/**
 * The engine's worst case under v1: a Duelist with 320 effective Agility attacks every 250 ms (the minimum interval), 95 %
 * of attacks hit (the maximum), 40 % of hits are critical (the maximum), and 20,100 health outlasts 480 hits of at most
 * 4 damage, so both sides attack until the 120 s cap: 960 attacks and the victory event, the longest log v1 can produce.
 */
export const WORST_FIGHTER: FighterSnapshot = makeFighter(build('duelist', 'balanced',
  { strength: 0, agility: 300, vitality: 2_000, endurance: 0, precision: 300 }), 'arena', RULES_V1);
/** The creation build's fighter (Berserker {4, 2, 2, 1, 1} with the starter sword and light armor). */
const STARTER_FIGHTER: FighterSnapshot = makeFighter(build('berserker', 'balanced', { strength: 4, agility: 2, vitality: 2, endurance: 1, precision: 1 },
  { weapon: item('sword:1:common'), body: item('light-armor:1:common') }), 'arena', RULES_V1);

const entrant = (i: number, slotIndex: number, fighter: FighterSnapshot): ArenaEntrant => ({ gladiatorId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  activityId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, seasonId: '0', league: 'bronze', slotIndex, rating: 1000, fighter });
const lease = <T>(kind: JobLease['kind'], snapshot: T, slotIndex: number): JobLease<T> => ({ id: '20000000-0000-4000-8000-000000000001',
  token: '30000000-0000-4000-8000-000000000001', expiresAtMs: slotIndex * SLOT_MS + 120_000, kind, activityId: null, gladiatorId: null, slotIndex,
  snapshot: snapshot as JobLease<T>['snapshot'], seed: 'seed', rulesVersion: RULES_V1.version, attempt: 1 });
/** The claim response as the worker receives it (one lease of the batch), parsed and frozen as runWorker's `process` does. */
const claimed = <T>(wire: string, seed: string) => freezeDomain(structuredClone({ ...JSON.parse(wire), seed })) as JobLease<T>;

/** One regular-Arena simulation job of two worst-case fighters, paired by the canonical `matchArena`. */
export function worstCaseArenaJob() {
  const slotIndex = 300;
  const [assignment] = matchArena([entrant(1, slotIndex, WORST_FIGHTER), entrant(2, slotIndex, WORST_FIGHTER)], [], 'pairing-seed');
  const input: ArenaSimulationInput = { kind: 'arena', battleId: assignment.battleId, slotIndex, rulesVersion: RULES_V1.version,
    startsAtMs: slotIndex * SLOT_MS, revealAtMs: slotIndex * SLOT_MS + RULES_V1.arena.revealAfterMs, assignment, names: ['Worst One', 'Worst Two'] };
  const wire = JSON.stringify(lease('simulation', input, slotIndex));
  return {
    run(seed: string): ArenaSimulationResult {
      const job = claimed<ArenaSimulationInput>(wire, seed);
      const result = DEFAULT_EXECUTORS.v1.simulation!(job) as ArenaSimulationResult;
      JSON.stringify({ job_id: job.id, lease_token: job.token, result });
      return result;
    },
  };
}

/**
 * A long Mountain Pass expedition job (three encounters in one simulation job): an unarmed defensive Guardian deals 2 damage
 * a hit about every 580 ms and outlasts the creature's blows, so each encounter runs for about a minute.
 */
export function expeditionJob() {
  const slotIndex = 300, snapshotBuild = build('guardian', 'defensive', { strength: 0, agility: 67, vitality: 200, endurance: 0, precision: 0 });
  const snapshot = { activityId: '40000000-0000-4000-8000-000000000001', gladiatorId: '00000000-0000-4000-8000-000000000001', slotIndex,
    rulesVersion: RULES_V1.version, cutoffMs: slotIndex * SLOT_MS, choice: { kind: 'expedition', expeditionId: 'mountain' }, scheduleVersion: 1,
    build: snapshotBuild, starting: { level: 10 } } as unknown as ActivitySnapshot;
  const wire = JSON.stringify(lease('simulation', snapshot, slotIndex));
  const plan = (seed: string): ExpeditionPlan => {
    const job = claimed<ActivitySnapshot>(wire, seed);
    const result = DEFAULT_EXECUTORS.v1.simulation!(job) as ExpeditionPlan;
    JSON.stringify({ job_id: job.id, lease_token: job.token, result });
    return result;
  };
  return { run: plan, events: (seed: string) => plan(seed).encounters.reduce((sum, e) => sum + e.battleLog.events.length, 0) };
}

/** The tournament slot's per-league pairing job for `n` opted-in Bronze entrants (partition, bracket and graph check). */
export function bracketPairingJob(n: number) {
  const slotIndex = TOURNAMENT_SLOT, cutoff = slotIndex * SLOT_MS;
  const entrants = Array.from({ length: n }, (_, i) => entrant(i + 1, slotIndex, STARTER_FIGHTER));
  const input: PairingInput = { slotIndex, league: 'bronze', seasonId: '0', rulesVersion: RULES_V1.version,
    historyFromSlot: slotIndex - RULES_V1.matchmaking.recentPairingSlots, entrants, recent: [],
    tournament: { bracketSeed: 'bracket-seed', rested: [], candidates: entrants.map(e => ({ gladiatorId: e.gladiatorId, choice: { kind: 'arena' },
      stamina: 104, costs: { arena: 25, tournament: 25 }, optIn: [{ enabled: true, receivedAtMs: cutoff - 3_600_000 }] })) } };
  const wire = JSON.stringify(lease('pair', input, slotIndex));
  return {
    run(seed: string): PairingResult {
      const job = claimed<PairingInput>(wire, seed);
      const result = DEFAULT_EXECUTORS.v1.pair!(job) as PairingResult;
      JSON.stringify({ job_id: job.id, lease_token: job.token, result });
      return result;
    },
  };
}

/**
 * The final bout job of an `n`-entrant bracket of worst-case fighters, every earlier fought bout already stored with its
 * worst-case 120 s log: the largest fenced graph read (`tournament_bout_input`) any bout job makes.
 */
export function tournamentFinalJob(n: number) {
  const slotIndex = TOURNAMENT_SLOT;
  let graph: TournamentGraph = buildBracket(Array.from({ length: n }, (_, i) => entrant(i + 1, slotIndex, WORST_FIGHTER)), 'bracket-seed');
  const names = Object.fromEntries(graph.entries.map((e, i) => [e.gladiatorId, `Entrant ${i + 1}`]));
  for (let ready = readyBouts(graph); ready.length && ready[0].round < graph.rounds; ready = readyBouts(graph)) {
    for (const job of ready) graph = recordBout(graph, job.boutId, runBout(job, `bout:${job.boutId}`, names));
  }
  const [final] = readyBouts(graph);
  const read: TournamentBoutRead = { ok: true, graph, names };
  const readWire = JSON.stringify(read);
  const input: TournamentBoutInput = { kind: 'tournament-bout', tournamentId: graph.id, boutId: final.boutId };
  const wire = JSON.stringify(lease('simulation', input, slotIndex));
  return {
    storedLogs: graph.bouts.filter(b => b.result?.log).length,
    graphBytes: Buffer.byteLength(readWire, 'utf8'),
    run(seed: string): TournamentBoutResult {
      const job = claimed<TournamentBoutInput>(wire, seed);
      const result = simulateTournamentBoutV1(job.snapshot, JSON.parse(readWire) as TournamentBoutRead, job.seed);
      JSON.stringify({ job_id: job.id, lease_token: job.token, result });
      return result;
    },
  };
}

export type Timing = { firstMs: number; medianMs: number; maxMs: number; runs: number };
const tenth = (ms: number) => Math.round(ms * 10) / 10;
/** One timed run and its value (used for the first, cold run of a job kind in this process). */
export function timeOnce<T>(run: () => T): { value: T; ms: number } {
  const began = performance.now();
  const value = run();
  return { value, ms: tenth(performance.now() - began) };
}
/** Times `run(0)` alone (the cold first run, before the JIT warms up), then `runs` more; `maxMs` covers every run. */
export function timeRuns(run: (i: number) => unknown, runs: number): Timing {
  const time = (i: number) => { const began = performance.now(); run(i); return performance.now() - began; };
  const first = time(0);
  const rest = Array.from({ length: runs }, (_, i) => time(i + 1)).sort((a, b) => a - b);
  return { firstMs: tenth(first), medianMs: tenth(rest[Math.floor(rest.length / 2)]), maxMs: tenth(Math.max(first, ...rest)), runs: runs + 1 };
}

/** The machine these numbers come from (no host names, users or paths). */
export function machine() {
  const cores = cpus();
  return { cpu: cores[0]?.model ?? 'unknown', logicalCores: cores.length, memoryGiB: Math.round(totalmem() / 2 ** 30), platform: platform(),
    release: release(), node: process.version, v8: process.versions.v8 };
}

/**
 * Prints one measurement section on the console, for a report run (scripts/resource-report.mjs sets CAPACITY_REPORT_DIR) or
 * behind CLOUDIATOR_MEASUREMENTS=1 only. Any other run prints nothing, the release gate's CAPACITY_GATE=1 run included
 * (Task 23.6, C23: its failed budget checks name their numbers); writeSection's on-disk sections are unchanged.
 */
export function logSection(label: string, value: unknown) {
  recordMeasurement(`Task 23.3 ${label}`, value, Boolean(process.env.CAPACITY_REPORT_DIR));
}

/** Writes one report section for scripts/resource-report.mjs when it set CAPACITY_REPORT_DIR; otherwise nothing. */
export function writeSection(name: string, value: unknown) {
  const dir = process.env.CAPACITY_REPORT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
}
