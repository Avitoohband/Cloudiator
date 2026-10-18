import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Sql, TransactionSql } from 'postgres';
import { sql, account, resetIdentity, admin, anonymous, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';

// Task 22.3: the owner-only health report (plan 2026-10-18-task-22-retention-operations, Decision 8) and its CLI.
// Each report case fabricates operator state inside a rollback-only transaction and asks private.health_report for a fixed
// database time NOW (fifteen minutes into slot S, in 1970), so every window and threshold is exact. The CLI case
// commits a healthy state at real time, runs scripts/health.mjs against the local stack (loopback only) and resets the
// world afterwards.

const SLOT = RULES_V1.clock.slotMs;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const S = 5_000;
const NOW = S * SLOT + 15 * MINUTE;
const BUDGET = 262_144_000;
/** 80 % of the budget: the database-size warning threshold. */
const WARN = 209_715_200;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/health.mjs', import.meta.url));

type Failures = { failures: number; sqlstates: string[] };
type Health = {
  checkedAtMs: number; currentSlot: number; publishedSlot: number | null; slotsBehind: number | null;
  coordinator: { lastError: string | null; lastFailedSlot: number | null; leaseHeld: boolean };
  scheduler: { enabled: boolean };
  boundaries: { slot: number; phase: number; status: string; waitReason: string | null; lastError: string | null; waitingMs: number }[];
  jobs: {
    counts: Record<string, Record<string, number>>;
    overdueTotal: number; overdue: { jobId: string; kind: string; slot: number; status: string; dueAtMs: number; overdueMs: number; attempts: number }[];
    operatorTotal: number; operator: { jobId: string; kind: string; slot: number; attempts: number; lastFailure: string | null }[];
  };
  attempts24h: { count: number; failed: number; failuresByCode: Record<string, number>;
    durations: Record<string, { count: number; p50Ms: number; p95Ms: number; maxMs: number }> };
  dispatch: { lastAtMs: number | null; lastHour: number };
  cleanup: { lastRunAtMs: number | null; detailThroughSlot: number | null; summaryThroughSlot: number | null; more: boolean;
    durationMs: number | null; detail: { more: boolean; blockedSlot: number | null; durationMs: number | null };
    summary: { more: boolean; durationMs: number | null }; ledger: { more: boolean }; moreSinceMs: number | null;
    failures: { consecutive: number; sqlstates: string[] } };
  events: Record<'market-sweep' | 'dispatch' | 'cleanup', {
    latestFailure: { atMs: number; sqlstates: string[]; failedSellers: number | null } | null; lastHour: Failures }>;
  resources: { databaseBytes: number; budgetBytes: number; largestTables: { name: string; bytes: number }[] };
  cpu: string;
  alerts: { code: string; severity: 'warn' | 'alert'; detail: Record<string, unknown> }[];
};

const commands = createDatabase(admin);
const ROLLBACK = new Error('rollback-only');
/** Runs `run` in one transaction that is always rolled back; returns what `run` returned. */
async function rollback<T>(run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await sql.begin(async tx => { value = await run(tx); throw ROLLBACK; });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return value as T;
}
const report = async (q: Sql, now = NOW) => (await q`select private.health_report(${now}) as report`)[0].report as Health;
const alertsOf = async (q: Sql, value: unknown) => (await q`select private.health_alerts(${q.json(value as never)}) as alerts`)[0].alerts as Health['alerts'];

// Operator-only world controls for the isolated local test database; no player API exposes them.
async function resetWorld(published: number | null) {
  await resetIdentity();
  await sql`truncate private.boundaries, private.boundary_work, private.dispatch_log`;
  await sql`update private.coordinator set published_slot=${published}, lease_token=null, lease_until_ms=0, last_error=null,
    last_failed_slot=null where singleton`;
  await sql`update private.scheduler set enabled=false where singleton`;
}

let gid: string;
type JobOptions = { dueAtMs: number; slot?: number; attempts?: number; leaseUntilMs?: number; lastFailure?: string };
/** A job row as the boundary and worker leave it (operator fabrication; the guard allows any insert). */
async function job(tx: Sql, kind: string, status: string, options: JobOptions) {
  const [row] = await tx`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,status,due_at_ms,attempts,
      lease_token,lease_until_ms,last_failure)
    values(${kind},${'health:' + randomUUID()},${options.slot ?? S},${gid},${tx.json({})},'v1',${status},${options.dueAtMs},
      ${options.attempts ?? 0},${status === 'leased' ? randomUUID() : null},${options.leaseUntilMs ?? null},${options.lastFailure ?? null})
    returning id::text`;
  return row.id as string;
}
/** One worker attempt of `jobId`: claimed at `claimedAtMs`, finished `durationMs` later (or still running). */
async function attempt(tx: Sql, jobId: string, n: number, claimedAtMs: number, durationMs: number | null, outcome: string | null, code: string | null = null) {
  await tx`insert into private.job_attempts(job_id,attempt,worker_id,claimed_at_ms,finished_at_ms,outcome,failure_code)
    values(${jobId},${n},${randomUUID()},${claimedAtMs},${durationMs === null ? null : claimedAtMs + durationMs},${outcome},${code})`;
}
async function boundary(tx: Sql, slot: number, phase: number, status: string, waitReason: string | null, openedAtMs: number, lastError: string | null = null) {
  await tx`insert into private.boundaries(slot_index,cutoff_ms,rules_version,phase,status,wait_reason,last_error,opened_at_ms,updated_at_ms)
    values(${slot},${slot * SLOT},'v1',${phase},${status},${waitReason},${lastError},${openedAtMs},${NOW - MINUTE})`;
}
async function event(tx: Sql, atMs: number, source: string, ok: boolean, sqlstate: string | null, detail: unknown = null) {
  await tx`insert into private.operations_events(at_ms,source,ok,sqlstate,detail)
    values(${atMs},${source},${ok},${sqlstate},${detail === null ? null : tx.json(detail as never)})`;
}
/** Runs the CLI as an operator would, with `env` added to (or removed from) the inherited environment. */
function cli(env: Record<string, string | undefined>, args: string[] = []): Promise<{ code: number | string; stdout: string; stderr: string }> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return new Promise(resolve => execFile(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: merged as NodeJS.ProcessEnv, timeout: 60_000 },
    (error, stdout, stderr) => resolve({ code: error ? (error as { code?: number | string }).code ?? 'error' : 0, stdout, stderr })));
}

describe('Task 22.3: operator health', () => {
  beforeAll(async () => {
    await resetWorld(null);
    const owner = await account();
    const created = await commands.createGladiator({ userId: owner.id }, creation('Health ' + randomUUID().slice(0, 8)));
    if (!created.ok) throw new Error('creation failed');
    gid = created.value.gladiatorId;
  });
  afterAll(async () => {
    await resetWorld(null);
    await sql.end();
  });

  it('reports slots behind, waiting boundaries, overdue and operator jobs with their alerts', async () => {
    const leased = await rollback(async tx => {
      const lease = randomUUID();
      await tx`update private.coordinator set published_slot=${S - 2},lease_token=${lease},lease_until_ms=${NOW + MINUTE},last_error='40P01',
        last_failed_slot=${S - 1} where singleton`;
      // The next boundary failed and waits since a minute into its slot; the current one waits for preparation since 5 minutes.
      await boundary(tx, S - 1, 1, 'waiting', 'error', (S - 1) * SLOT + MINUTE, '40P01');
      await boundary(tx, S, 4, 'waiting', 'preparation', NOW - 5 * MINUTE);
      await boundary(tx, S - 3, 9, 'complete', null, (S - 3) * SLOT);
      // Overdue: an expired lease (25 minutes past due, its lease 20 minutes past), twenty prepare jobs 12 minutes past due
      // and a settlement 11 minutes past due. Not overdue: a settlement 9 minutes past due and a job whose lease still runs.
      const reveal = await job(tx, 'reveal', 'leased', { dueAtMs: NOW - 25 * MINUTE, attempts: 1, leaseUntilMs: NOW - 20 * MINUTE });
      for (let i = 1; i <= 20; i++) await job(tx, 'prepare', 'pending', { dueAtMs: NOW - 12 * MINUTE - i });
      const settlement = await job(tx, 'settlement', 'pending', { dueAtMs: NOW - 11 * MINUTE });
      await job(tx, 'settlement', 'pending', { dueAtMs: NOW - 9 * MINUTE });
      await job(tx, 'simulation', 'leased', { dueAtMs: NOW - 30 * MINUTE, attempts: 1, leaseUntilMs: NOW + MINUTE });
      await job(tx, 'prepare', 'completed', { dueAtMs: NOW - HOUR });
      // Twenty-one jobs held for the operator.
      const held: string[] = [];
      for (let i = 1; i <= 21; i++) held.push(await job(tx, 'simulation', 'operator', { dueAtMs: NOW - HOUR, slot: S - 1 - i, attempts: 3, lastFailure: 'rating-mismatch' }));
      const health = await report(tx);
      expect(health).toMatchObject({ checkedAtMs: NOW, currentSlot: S, publishedSlot: S - 2, slotsBehind: 2,
        coordinator: { lastError: '40P01', lastFailedSlot: S - 1, leaseHeld: true }, scheduler: { enabled: false }, cpu: 'not available' });
      expect(health.boundaries).toEqual([
        { slot: S - 1, phase: 1, status: 'waiting', waitReason: 'error', lastError: '40P01', waitingMs: NOW - (S - 1) * SLOT - MINUTE },
        { slot: S, phase: 4, status: 'waiting', waitReason: 'preparation', lastError: null, waitingMs: 5 * MINUTE }]);
      expect(health.jobs.counts).toEqual({ prepare: { pending: 20, completed: 1 }, reveal: { leased: 1 }, settlement: { pending: 2 },
        simulation: { leased: 1, operator: 21 } });
      // At most twenty of each, oldest first.
      expect(health.jobs.overdueTotal).toBe(22);
      expect(health.jobs.overdue).toHaveLength(20);
      expect(health.jobs.overdue[0]).toEqual({ jobId: reveal, kind: 'reveal', slot: S, status: 'leased', dueAtMs: NOW - 25 * MINUTE,
        overdueMs: 25 * MINUTE, attempts: 1 });
      expect(health.jobs.overdue.slice(1).map(j => [j.kind, j.status])).toEqual(Array(19).fill(['prepare', 'pending']));
      expect(health.jobs.overdue.map(j => j.jobId)).not.toContain(settlement);
      expect(health.jobs.operatorTotal).toBe(21);
      expect(health.jobs.operator).toHaveLength(20);
      expect(health.jobs.operator[0]).toEqual({ jobId: held[20], kind: 'simulation', slot: S - 22, attempts: 3, lastFailure: 'rating-mismatch' });
      expect(health.alerts).toEqual([
        { code: 'boundary-behind', severity: 'alert', detail: { publishedSlot: S - 2, currentSlot: S, lateMs: NOW - (S - 1) * SLOT - 10 * MINUTE } },
        { code: 'boundary-waiting', severity: 'alert', detail: { count: 1, oldestSlot: S - 1, longestWaitMs: NOW - (S - 1) * SLOT - MINUTE } },
        { code: 'operator-jobs', severity: 'alert', detail: { count: 21 } },
        { code: 'overdue-jobs', severity: 'alert', detail: { count: 22, oldestDueAtMs: NOW - 25 * MINUTE } }]);
      return health.coordinator.leaseHeld;
    });
    expect(leased).toBe(true);
    // Thresholds: the next boundary is behind only more than ten minutes into its slot; nothing is waiting or overdue here.
    await rollback(async tx => {
      await tx`update private.coordinator set published_slot=${S - 1} where singleton`;
      const at = (ms: number) => report(tx, S * SLOT + ms);
      expect((await at(10 * MINUTE)).alerts).toEqual([]);
      expect((await at(10 * MINUTE + 1)).alerts).toEqual([{ code: 'boundary-behind', severity: 'alert',
        detail: { publishedSlot: S - 1, currentSlot: S, lateMs: 1 } }]);
      expect(await at(10 * MINUTE + 1)).toMatchObject({ slotsBehind: 1, coordinator: { lastError: null, lastFailedSlot: null, leaseHeld: false } });
      // Nothing published yet: no alert while the scheduler is off; once it is on, nothing has been coordinated (and nothing
      // cleaned up) yet.
      await tx`update private.coordinator set published_slot=null where singleton`;
      expect(await at(30 * MINUTE)).toMatchObject({ publishedSlot: null, slotsBehind: null, alerts: [] });
      await tx`update private.scheduler set enabled=true where singleton`;
      expect((await at(30 * MINUTE)).alerts).toEqual([
        { code: 'boundary-behind', severity: 'alert', detail: { publishedSlot: null, currentSlot: S, lateMs: null } },
        { code: 'cleanup-stale', severity: 'alert', detail: { lastRunAtMs: null } }]);
      await tx`update private.scheduler set enabled=false where singleton`;
      // A boundary waiting exactly ten minutes is listed but not yet an alert; at most twenty are listed, lowest slot first.
      await tx`update private.coordinator set published_slot=${S} where singleton`;
      await boundary(tx, S + 1, 1, 'waiting', 'settlement', NOW - 10 * MINUTE);
      expect(await at(15 * MINUTE)).toMatchObject({ boundaries: [{ slot: S + 1, waitingMs: 10 * MINUTE }], alerts: [] });
      for (let slot = S - 30; slot < S - 5; slot++) await boundary(tx, slot, 3, 'waiting', 'settlement', NOW - 11 * MINUTE);
      const many = await at(15 * MINUTE);
      expect(many.boundaries.map(b => b.slot)).toEqual(Array.from({ length: 20 }, (_, i) => S - 30 + i));
      expect(many.alerts).toEqual([{ code: 'boundary-waiting', severity: 'alert', detail: { count: 20, oldestSlot: S - 30, longestWaitMs: 11 * MINUTE } }]);
    });
  });

  it('reports attempt durations by kind and failures by code from job attempts', () => rollback(async tx => {
    const prepare: string[] = [];
    for (const ms of [400, 100, 300, 200]) {
      const id = await job(tx, 'prepare', 'completed', { dueAtMs: NOW - 2 * HOUR });
      await attempt(tx, id, 1, NOW - HOUR, ms, 'completed');
      prepare.push(id);
    }
    // A simulation that failed, expired and then completed in 1.5 s; a settlement held for the operator after one failure.
    const simulation = await job(tx, 'simulation', 'completed', { dueAtMs: NOW - 2 * HOUR, attempts: 3 });
    await attempt(tx, simulation, 1, NOW - 3 * HOUR, 20, 'failed', 'execution-failed');
    await attempt(tx, simulation, 2, NOW - 2 * HOUR, 120_000, 'expired', 'lease-expired');
    await attempt(tx, simulation, 3, NOW - HOUR, 1_500, 'completed');
    const settlement = await job(tx, 'settlement', 'operator', { dueAtMs: NOW - 2 * HOUR, attempts: 1, lastFailure: 'rating-mismatch' });
    await attempt(tx, settlement, 1, NOW - HOUR, 50, 'failed', 'rating-mismatch');
    // Still running, then outside the window (claimed 25 hours ago) and after NOW: counted only when claimed in the last 24 hours.
    const running = await job(tx, 'reveal', 'leased', { dueAtMs: NOW - MINUTE, attempts: 1, leaseUntilMs: NOW + MINUTE });
    await attempt(tx, running, 1, NOW - MINUTE, null, null);
    await attempt(tx, prepare[0], 2, NOW - 25 * HOUR, 9_999, 'completed');
    await attempt(tx, prepare[1], 2, NOW + MINUTE, 9_999, 'completed');
    const health = await report(tx);
    expect(health.attempts24h).toEqual({
      count: 9, failed: 3, failuresByCode: { 'execution-failed': 1, 'lease-expired': 1, 'rating-mismatch': 1 },
      durations: { prepare: { count: 4, p50Ms: 200, p95Ms: 400, maxMs: 400 }, simulation: { count: 1, p50Ms: 1_500, p95Ms: 1_500, maxMs: 1_500 } },
    });
    // The settlement is operator work; CPU time is not exposed per request by the Edge runtime.
    expect(health.jobs.operator).toEqual([{ jobId: settlement, kind: 'settlement', slot: S, attempts: 1, lastFailure: 'rating-mismatch' }]);
    expect(health.cpu).toBe('not available');
  }));

  it('reports cleanup state, the latest tick failures and database size against the budget', async () => {
    await rollback(async tx => {
      await tx`update private.coordinator set published_slot=${S} where singleton`;
      await tx`update private.scheduler set enabled=true where singleton`;
      // The last successful cleanup ran 27 hours ago and still had seven-day and ledger work left.
      const last = { ok: true, durationMs: 42, detail: { more: true, blockedSlot: null, durationMs: 30 }, summary: { more: false, durationMs: 9 },
        ledger: { rows: 5000, gladiators: 3, more: true } };
      await tx`update private.retention_state set detail_through_slot=120,summary_through_slot=100,last_run_at_ms=${NOW - 27 * HOUR},
        last_result=${tx.json(last)} where singleton`;
      // Cleanup ticks: caught up 40 hours ago, more work at 30 and 27 hours, then three failures in a row.
      await event(tx, NOW - 40 * HOUR, 'cleanup', true, null, { ...last, detail: { more: false }, summary: { more: false }, ledger: { more: false } });
      await event(tx, NOW - 30 * HOUR, 'cleanup', true, null, last);
      await event(tx, NOW - 27 * HOUR, 'cleanup', true, null, last);
      await event(tx, NOW - 3 * HOUR, 'cleanup', false, '55P03');
      await event(tx, NOW - 2 * HOUR, 'cleanup', false, '40P01');
      await event(tx, NOW - 90 * MINUTE, 'cleanup', false, '55P03');
      // Market sweeps: per-seller failures (their distinct SQLSTATEs in detail) and a whole-sweep failure; one dispatch failure.
      await event(tx, NOW - 25 * HOUR, 'market-sweep', false, 'XX000', { failedSellers: 1, sqlstates: ['XX000'] });
      await event(tx, NOW - 2 * HOUR, 'market-sweep', false, 'P0001', { failedSellers: 1, sqlstates: ['P0001'] });
      await event(tx, NOW - 30 * MINUTE, 'market-sweep', false, 'P0001', { failedSellers: 2, sqlstates: ['P0001', '23505'] });
      await event(tx, NOW - 10 * MINUTE, 'market-sweep', false, '55P03');
      await event(tx, NOW - 5 * MINUTE, 'dispatch', false, '55P03');
      await event(tx, NOW + MINUTE, 'dispatch', false, '08006');
      for (const ms of [NOW - 2 * HOUR, NOW - 30 * MINUTE, NOW + MINUTE]) {
        await tx`insert into private.dispatch_log(dispatched_at_ms,claimable_simple,claimable_combat) values(${ms},1,0)`;
      }
      const before = Number((await tx`select pg_database_size(current_database())::text as bytes`)[0].bytes);
      const health = await report(tx);
      expect(health.cleanup).toEqual({ lastRunAtMs: NOW - 27 * HOUR, detailThroughSlot: 120, summaryThroughSlot: 100, more: true, durationMs: 42,
        detail: { more: true, blockedSlot: null, durationMs: 30 }, summary: { more: false, durationMs: 9 }, ledger: { more: true },
        moreSinceMs: NOW - 30 * HOUR, failures: { consecutive: 3, sqlstates: ['40P01', '55P03'] } });
      expect(health.events).toEqual({
        'market-sweep': { latestFailure: { atMs: NOW - 10 * MINUTE, sqlstates: ['55P03'], failedSellers: null },
          lastHour: { failures: 2, sqlstates: ['23505', '55P03', 'P0001'] } },
        dispatch: { latestFailure: { atMs: NOW - 5 * MINUTE, sqlstates: ['55P03'], failedSellers: null }, lastHour: { failures: 1, sqlstates: ['55P03'] } },
        cleanup: { latestFailure: { atMs: NOW - 90 * MINUTE, sqlstates: ['55P03'], failedSellers: null }, lastHour: { failures: 0, sqlstates: [] } },
      });
      expect(health.dispatch).toEqual({ lastAtMs: NOW - 30 * MINUTE, lastHour: 1 });
      expect(health.alerts).toEqual([
        { code: 'cleanup-stale', severity: 'alert', detail: { lastRunAtMs: NOW - 27 * HOUR } },
        { code: 'cleanup-failures', severity: 'warn', detail: { consecutive: 3, sqlstates: ['40P01', '55P03'] } },
        { code: 'cleanup-backlog', severity: 'warn', detail: { moreSinceMs: NOW - 30 * HOUR } },
        { code: 'tick-failures', severity: 'warn', detail: { 'market-sweep': { failures: 2, sqlstates: ['23505', '55P03', 'P0001'] },
          dispatch: { failures: 1, sqlstates: ['55P03'] } } }]);
      // The database against its 250 MB budget, with its ten largest tables, largest first.
      expect(health.resources.budgetBytes).toBe(BUDGET);
      expect(Math.abs(health.resources.databaseBytes - before)).toBeLessThan(before / 100);
      expect(health.resources.largestTables).toHaveLength(10);
      for (const table of health.resources.largestTables) expect(table.name).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/);
      const sizes = health.resources.largestTables.map(t => t.bytes);
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
      // Recovered: a success clears the failure streak, a caught-up run clears the backlog and a recent run the staleness.
      await tx`update private.retention_state set last_run_at_ms=${NOW - HOUR},last_result=${tx.json({ ...last, detail: { more: false }, ledger: { more: false } })}`;
      await event(tx, NOW - HOUR, 'cleanup', true, null, { ...last, detail: { more: false }, ledger: { more: false } });
      expect((await report(tx)).cleanup).toMatchObject({ more: false, moreSinceMs: null, failures: { consecutive: 0, sqlstates: [] } });
      expect((await report(tx)).alerts.map(a => a.code)).toEqual(['tick-failures']);
      // Two failures in a row are not yet repeated failures; an enabled scheduler that never cleaned up is stale.
      await event(tx, NOW - 40 * MINUTE, 'cleanup', false, '55P03');
      await event(tx, NOW - 20 * MINUTE, 'cleanup', false, '55P03');
      await tx`update private.retention_state set last_run_at_ms=null,last_result=null`;
      const stale = await report(tx);
      expect(stale.cleanup).toMatchObject({ lastRunAtMs: null, more: false, durationMs: null, failures: { consecutive: 2 } });
      expect(stale.alerts.slice(0, 1)).toEqual([{ code: 'cleanup-stale', severity: 'alert', detail: { lastRunAtMs: null } }]);
      expect(stale.alerts.map(a => a.code)).toEqual(['cleanup-stale', 'tick-failures']);
      // With the scheduler off, staleness is expected (nothing runs) and not reported.
      await tx`update private.scheduler set enabled=false where singleton`;
      expect((await report(tx)).alerts.map(a => a.code)).toEqual(['tick-failures']);
    });
    // The size alert: a warning from 80 % of the budget, an alert from 100 %.
    const quiet = { checkedAtMs: NOW, currentSlot: S, publishedSlot: S, scheduler: { enabled: false }, boundaries: [],
      jobs: { overdueTotal: 0, overdue: [], operatorTotal: 0 }, cleanup: { failures: { consecutive: 0, sqlstates: [] }, moreSinceMs: null },
      events: {}, resources: { budgetBytes: BUDGET } };
    const sized = (bytes: number) => alertsOf(sql, { ...quiet, resources: { databaseBytes: bytes, budgetBytes: BUDGET } });
    expect(await sized(WARN - 1)).toEqual([]);
    expect(await sized(WARN)).toEqual([{ code: 'database-size', severity: 'warn', detail: { databaseBytes: WARN, budgetBytes: BUDGET } }]);
    expect(await sized(BUDGET - 1)).toEqual([{ code: 'database-size', severity: 'warn', detail: { databaseBytes: BUDGET - 1, budgetBytes: BUDGET } }]);
    expect(await sized(BUDGET)).toEqual([{ code: 'database-size', severity: 'alert', detail: { databaseBytes: BUDGET, budgetBytes: BUDGET } }]);
  });

  it('contains no secrets: no URLs, keys, tokens or raw error text', () => rollback(async tx => {
    const marker = randomUUID();
    const planted = {
      coordinator: `password=hunter2-${marker} postgres://operator:pw@db.example.invalid/postgres`,
      boundary: `token eyJhbGciOiJIUzI1NiJ9.${marker}`,
      job: `Error: https://example.invalid/?apikey=sk_live_${marker}`,
      attempt: `Bearer abc.${marker}`,
      event: `secret message ${marker}`,
      vault: `vault-value-${marker}`,
    };
    await tx`update private.coordinator set published_slot=${S - 1},last_error=${planted.coordinator},last_failed_slot=${S} where singleton`;
    await boundary(tx, S, 2, 'waiting', 'error', NOW - 20 * MINUTE, planted.boundary);
    const held = await job(tx, 'settlement', 'operator', { dueAtMs: NOW - HOUR, attempts: 3, lastFailure: planted.job });
    await attempt(tx, held, 1, NOW - HOUR, 10, 'failed', planted.attempt);
    await event(tx, NOW - MINUTE, 'market-sweep', false, 'P0001', { failedSellers: 1, sqlstates: ['P0001', planted.event], message: planted.event,
      url: 'https://example.invalid/' + marker });
    await tx`update private.retention_state set last_run_at_ms=${NOW - HOUR},last_result=${tx.json({ durationMs: 'https://example.invalid/' + marker,
      detail: { more: planted.event, durationMs: planted.event, blockedSlot: planted.event }, summary: { more: true, durationMs: [marker] } })}`;
    await tx`select vault.create_secret(${planted.vault}, ${'health-' + marker})`;
    const health = await report(tx);
    const text = JSON.stringify(health);
    for (const value of [marker, ...Object.values(planted), '://', 'eyJ', 'Bearer', 'hunter2', 'sk_live']) expect(text).not.toContain(value);
    // Free-text columns are reported only as codes: anything that is not a SQLSTATE or a failure code is "unrecognized".
    expect(health.coordinator.lastError).toBe('unrecognized');
    expect(health.boundaries).toEqual([expect.objectContaining({ slot: S, lastError: 'unrecognized' })]);
    expect(health.jobs.operator).toEqual([expect.objectContaining({ jobId: held, lastFailure: 'unrecognized' })]);
    expect(health.attempts24h.failuresByCode).toEqual({ unrecognized: 1 });
    expect(health.events['market-sweep'].latestFailure).toEqual({ atMs: NOW - MINUTE, sqlstates: ['P0001'], failedSellers: 1 });
    expect(health.cleanup).toMatchObject({ durationMs: null, more: true, detail: { more: false, durationMs: null, blockedSlot: null },
      summary: { more: true, durationMs: null } });
  }));

  it('denies every client role execute on health_report', async () => {
    const functions = await sql`select p.oid::regprocedure::text as name, p.prosecdef, p.provolatile, p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service, has_function_privilege('public',p.oid,'EXECUTE') as public
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('health_report','health_alerts') order by 1`;
    expect(functions.map(row => ({ ...row }))).toEqual([
      { name: 'private.health_alerts(jsonb)', prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], anon: false, authenticated: false, service: false, public: false },
      { name: 'private.health_report(bigint)', prosecdef: false, provolatile: 'v', proconfig: ['search_path=""'], anon: false, authenticated: false, service: false, public: false }]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await expect(rollback(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select private.health_report(${NOW})`;
      })).rejects.toMatchObject({ code: '42501' });
    }
    await expect(sql`select private.health_report(null)`).rejects.toMatchObject({ code: '22023' });
    // Exposure checks only (the privileges are proven above): `private` is not an exposed schema and `public` has no report.
    const owner = await account();
    for (const client of [owner.client, anonymous, admin]) {
      expect((await client.rpc('health_report', { now_ms: NOW })).error).not.toBeNull();
      expect((await client.schema('private').rpc('health_report', { now_ms: NOW })).error).not.toBeNull();
    }
  });

  it('runs the health script against the local stack and exits 0 when healthy and 1 with an alert', async () => {
    const dbUrl = process.env.LOCAL_DB_URL!;
    const secrets = [dbUrl, new URL(dbUrl).password ? `:${new URL(dbUrl).password}@` : dbUrl];
    const clean = (out: { stdout: string; stderr: string }) => { for (const s of secrets) expect(out.stdout + out.stderr).not.toContain(s); };
    try {
      // Healthy at real time: the coordinator has published the current slot, nothing waits and nothing failed.
      await resetWorld(Math.floor(Date.now() / SLOT));
      const healthy = await cli({ CLOUDIATOR_DB_URL: undefined });
      clean(healthy);
      expect(healthy.code, healthy.stdout).toBe(0);
      const body = JSON.parse(healthy.stdout) as Health;
      expect(body).toMatchObject({ scheduler: { enabled: false }, cpu: 'not available', alerts: [], resources: { budgetBytes: BUDGET } });
      expect(Math.abs(body.checkedAtMs - Date.now())).toBeLessThan(60_000);
      // A dispatch failure a minute ago: one alert, exit 1 (here through an explicit loopback operator URL).
      await sql`insert into private.operations_events(at_ms,source,ok,sqlstate) values(private.planning_now_ms()-60000,'dispatch',false,'55P03')`;
      const alerting = await cli({ CLOUDIATOR_DB_URL: dbUrl });
      clean(alerting);
      expect(alerting.code, alerting.stdout).toBe(1);
      expect((JSON.parse(alerting.stdout) as Health).alerts).toEqual([{ code: 'tick-failures', severity: 'warn',
        detail: { dispatch: { failures: 1, sqlstates: ['55P03'] } } }]);
    } finally {
      await resetWorld(null);
    }
    // Failures exit 2 with a short code and never echo the URL or its credential.
    const marker = randomUUID();
    const remote = await cli({ CLOUDIATOR_DB_URL: `postgresql://operator:pw-${marker}@db.example.invalid:5432/postgres` });
    expect(remote.code).toBe(2);
    expect(JSON.parse(remote.stdout)).toEqual({ ok: false, code: 'remote-not-allowed' });
    const refused = await cli({ CLOUDIATOR_DB_URL: `postgresql://operator:pw-${marker}@127.0.0.1:1/postgres` });
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout)).toEqual({ ok: false, code: 'connection-failed' });
    const usage = await cli({}, ['--verbose']);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout)).toEqual({ ok: false, code: 'usage' });
    for (const out of [remote, refused, usage]) expect(out.stdout + out.stderr).not.toContain(marker);
  }, 120_000);
});
