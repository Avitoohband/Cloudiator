import { RULES_V1 } from '../domain/rules-v1.ts';
import { validateBuild } from '../domain/build.ts';
import { activityCost, deriveStats } from '../domain/stats.ts';
import { freezeDomain } from '../domain/types.ts';
import { planExpedition } from '../domain/expedition.ts';
import type { ActivitySnapshot } from '../domain/types.ts';
import type { ActivityCosts, ActivityKind, BuildInput, CoordinatorReport, ItemInstance, JobKind, JobLease, PreparationInput, PreparationResult, WorkerReport } from '../domain/types.ts';
import type { ExecutorRegistry, JobOutcome, WorkerDependencies } from './database.ts';

/** Spec 10.4 batch limits and lease length; CPU measurements may lower the batch sizes without changing semantics. */
export const WORKER_LIMITS = Object.freeze({ simple: 20, combat: 5, cpuMs: 2_000, leaseMs: 120_000, renewBelowMs: 60_000 });

/** Stable, secret-free failure codes. Raw exception text is never stored, logged or returned. */
export type FailureCode = 'unsupported-rules' | 'unsupported-executor' | 'invalid-input' | 'invalid-build' | 'invalid-result' | 'execution-failed';
export class WorkerFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'WorkerFailure'; }
}

const ACTIVITY_KINDS: readonly ActivityKind[] = ['training', 'rest', 'expedition', 'arena', 'tournament'];
/** Canonical v1 boundary recompute: legal build snapshot, derived stats and versioned stamina costs. */
export function prepareActivityV1(input: PreparationInput): PreparationResult {
  if (!input || typeof input !== 'object' || !input.build || !Array.isArray(input.items)) throw new WorkerFailure('invalid-input');
  if (input.rulesVersion !== RULES_V1.version) throw new WorkerFailure('unsupported-rules');
  const build: BuildInput = { classId: input.build.classId, stance: input.build.stance,
    allocation: { ...input.build.allocations }, equipment: { ...input.build.equipment } };
  const validation = validateBuild(build, structuredClone(input.items) as ItemInstance[], input.earnedPoints, input.level);
  if (!validation.ok) throw new WorkerFailure('invalid-build');
  const derived = deriveStats(validation.snapshot, RULES_V1);
  const costs = Object.fromEntries(ACTIVITY_KINDS.map(kind => [kind, activityCost(RULES_V1.activityStamina[kind], derived.overload)])) as ActivityCosts;
  return { rulesVersion: RULES_V1.version, snapshot: structuredClone(validation.snapshot) as PreparationResult['snapshot'], derived,
    staminaMaximum: derived.maxStamina, costs, trainingPoints: RULES_V1.progression.trainingPoints };
}

/** Keep every retained rules version registered: a job always runs with the version persisted on it. */
export const DEFAULT_EXECUTORS: ExecutorRegistry = Object.freeze({
  v1: Object.freeze({ prepare: (job: JobLease) => prepareActivityV1(job.snapshot as PreparationInput),
    simulation: (job: JobLease) => planExpedition(job.snapshot as ActivitySnapshot, job.seed, RULES_V1),
    // SQL selects the immutable stage by ordinal; no worker-supplied stage payload is trusted here.
    reveal: () => ({}) }),
});

/** One bounded invocation: settle, then prepare, then reveal (≤20 simple), or else ≤5 combat simulations. */
export async function runWorker(deps: WorkerDependencies): Promise<WorkerReport> {
  const executors = deps.executors ?? DEFAULT_EXECUTORS;
  const now = deps.now ?? Date.now;
  const cpuNow = deps.cpuNow ?? (() => performance.now());
  let computeMs = 0;
  const report: WorkerReport = { claimed: 0, completed: 0, replayed: 0, failed: 0, conflicts: 0, unrecorded: 0,
    byKind: { prepare: 0, simulation: 0, reveal: 0, settlement: 0 }, coordination: null };
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
    return executor(job);
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
        record(await deps.database.settle(job.activityId, job.token));
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
  for (const kind of ['settlement', 'prepare', 'reveal'] as const satisfies readonly JobKind[]) {
    if (simple <= 0 || computeMs >= WORKER_LIMITS.cpuMs) break;
    const jobs = await deps.database.claim(deps.workerId, kind, simple);
    if (!jobs.length) continue;
    simple -= jobs.length;
    for (const job of jobs) await process(job);
    // Settled slots or completed preparation can release the next ordered boundary phase.
    report.coordination = await coordinate();
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
