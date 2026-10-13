import { describe, expect, it } from 'vitest';
import { handleWorker, prepareActivityV1, runWorker, WORKER_LIMITS } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { ExecutorRegistry, JobOutcome, WorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import type { JobKind, JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { itemFixture } from '../fixtures/domain.ts';

const SECRET = 'unit-worker-secret-0123456789abcdef0123456789';
const gid = '0d5f8471-d919-428f-9ab7-058c95821757';
function preparation(overrides: Partial<PreparationInput> = {}): PreparationInput {
  return { gladiatorId: gid, slotIndex: 300, rulesVersion: 'v1', level: 1, earnedPoints: 10, items: [],
    build: { version: 1, classId: 'berserker', stance: 'balanced', allocations: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 },
      equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } }, ...overrides } as PreparationInput;
}
let sequence = 0;
function lease(kind: JobKind, overrides: Partial<JobLease> = {}): JobLease {
  sequence += 1;
  return { id: `job-${sequence}`, token: `token-${sequence}`, expiresAtMs: Date.now() + WORKER_LIMITS.leaseMs, kind,
    activityId: kind === 'settlement' ? `activity-${sequence}` : null, gladiatorId: gid, slotIndex: 300,
    snapshot: kind === 'prepare' ? preparation() : {}, seed: `seed-${sequence}`, rulesVersion: 'v1', attempt: 1, ...overrides } as JobLease;
}
/** In-memory port recording calls; the SQL fencing itself is exercised by tests/db/activities.test.ts. */
function port(queues: Partial<Record<JobKind, JobLease[]>>, outcome: (call: string) => JobOutcome = () => ({ ok: true })) {
  const calls: { name: string; args: unknown[] }[] = [];
  const database: WorkerDatabase = {
    coordinate: async () => { calls.push({ name: 'coordinate', args: [] }); return { ok: true, publishedSlot: 300 }; },
    claim: async (worker, kind, limit) => { calls.push({ name: 'claim', args: [worker, kind, limit] }); return (queues[kind] ?? []).splice(0, limit); },
    renew: async (id, token) => { calls.push({ name: 'renew', args: [id, token] }); return { ok: true, expiresAtMs: Date.now() + WORKER_LIMITS.leaseMs }; },
    complete: async (id, token, result) => { calls.push({ name: 'complete', args: [id, token, result] }); return outcome('complete'); },
    settle: async (id, token) => { calls.push({ name: 'settle', args: [id, token] }); return outcome('settle'); },
    fail: async (id, token, code) => { calls.push({ name: 'fail', args: [id, token, code] }); return { ok: true }; },
  };
  return { database, calls };
}
const post = (authorization?: string, method = 'POST') => new Request('http://local/game-worker', {
  method, headers: authorization === undefined ? {} : { Authorization: authorization } });

describe('canonical v1 activity preparation', () => {
  it('derives versioned stamina costs and the training reward without a second stats engine', () => {
    const result = prepareActivityV1(preparation());
    expect(result).toMatchObject({ rulesVersion: 'v1', staminaMaximum: 100, trainingPoints: 1,
      costs: { training: 20, rest: 0, expedition: 30, arena: 25, tournament: 25 } });
    expect(result.derived.maxStamina).toBe(100);
    expect(result.snapshot.rulesVersion).toBe('v1');
  });
  it('charges overloaded Training through the canonical activity cost formula', () => {
    const heavy = { ...itemFixture(CATALOG_V1.items['heavy-armor:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b11', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const helmet = { ...itemFixture(CATALOG_V1.items['iron-helmet:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b12', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const input = preparation({ items: [heavy, helmet], build: { ...preparation().build, equipment: { weapon: null, offHand: null, head: helmet.id, body: heavy.id, feet: null } } });
    // Endurance 5 gives capacity 20; 14 load is not overloaded, so add a second heavy item through the boots slot.
    const boots = { ...itemFixture(CATALOG_V1.items['heavy-boots:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b13', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const shield = { ...itemFixture(CATALOG_V1.items['round-shield:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b14', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const overloaded = prepareActivityV1({ ...input, items: [heavy, helmet, boots, shield],
      build: { ...input.build, equipment: { ...input.build.equipment, feet: boots.id, offHand: shield.id } } });
    // Load 23 against capacity 20: overload 0.15, ceil(20 × 1.15) = 23.
    expect(overloaded.derived.overload).toBeCloseTo(0.15, 10);
    expect(overloaded.costs).toMatchObject({ training: 23, rest: 0, expedition: 35, arena: 29 });
  });
  it('fails closed with a sanitized code when the build is no longer legal', () => {
    expect(() => prepareActivityV1(preparation({ earnedPoints: 10, build: { ...preparation().build, allocations: { strength: 11, agility: 0, vitality: 0, endurance: 0, precision: 0 } } })))
      .toThrow(expect.objectContaining({ code: 'invalid-build' }));
    expect(() => prepareActivityV1(preparation({ rulesVersion: 'v2' }))).toThrow(expect.objectContaining({ code: 'unsupported-rules' }));
  });
});

describe('fenced worker orchestration', () => {
  it('claims at most twenty simple jobs, settles before preparing and coordinates between batches', async () => {
    const settlements = Array.from({ length: 12 }, () => lease('settlement'));
    const prepares = Array.from({ length: 30 }, () => lease('prepare'));
    const { database, calls } = port({ settlement: settlements, prepare: prepares, simulation: [lease('simulation')] });
    const report = await runWorker({ database, workerId: 'worker-a' });
    const claims = calls.filter(c => c.name === 'claim').map(c => c.args.slice(1));
    expect(claims).toEqual([['settlement', 20], ['prepare', 8]]);
    expect(report).toMatchObject({ claimed: 20, completed: 20, failed: 0, conflicts: 0, byKind: { settlement: 12, prepare: 8, simulation: 0 } });
    expect(calls.filter(c => c.name === 'settle')).toHaveLength(12);
    expect(calls.filter(c => c.name === 'complete')).toHaveLength(8);
    expect(calls.filter(c => c.name === 'coordinate').length).toBeGreaterThanOrEqual(3);
  });
  it('processes at most five combat jobs only when no simple work exists', async () => {
    const simulations = Array.from({ length: 9 }, () => lease('simulation'));
    let executed = 0;
    const executors: ExecutorRegistry = { v1: { simulation: () => { executed += 1; return { outcome: 'private' }; } } };
    const { database, calls } = port({ simulation: simulations });
    const report = await runWorker({ database, workerId: 'worker-b', executors });
    expect(calls.filter(c => c.name === 'claim').map(c => c.args.slice(1)).at(-1)).toEqual(['simulation', 5]);
    expect(executed).toBe(5);
    expect(report).toMatchObject({ claimed: 5, completed: 5 });
  });
  it('dispatches by the job’s persisted rules version and keeps an older executor available', async () => {
    const seen: string[] = [];
    const executors: ExecutorRegistry = {
      v0: { prepare: job => { seen.push(`v0:${job.id}`); return { retained: true }; } },
      v1: { prepare: job => { seen.push(`v1:${job.id}`); return { current: true }; } },
    };
    const old = lease('prepare', { rulesVersion: 'v0' }), current = lease('prepare');
    const { database, calls } = port({ prepare: [old, current] });
    await runWorker({ database, workerId: 'worker-c', executors });
    expect(seen).toEqual([`v0:${old.id}`, `v1:${current.id}`]);
    expect(calls.find(c => c.name === 'complete' && c.args[0] === old.id)?.args[2]).toEqual({ retained: true });
  });
  it('fails unknown rules versions and missing executors closed with sanitized codes only', async () => {
    const unknown = lease('prepare', { rulesVersion: 'v9' }), missing = lease('reveal');
    const leaking = lease('prepare');
    const executors: ExecutorRegistry = { v1: { prepare: () => { throw new Error('postgres://user:secret@host leaked'); } } };
    const { database, calls } = port({ prepare: [unknown, leaking], reveal: [missing] });
    const report = await runWorker({ database, workerId: 'worker-d', executors });
    expect(calls.filter(c => c.name === 'fail').map(c => c.args)).toEqual([
      [unknown.id, unknown.token, 'unsupported-rules'], [leaking.id, leaking.token, 'execution-failed'], [missing.id, missing.token, 'unsupported-executor']]);
    expect(report).toMatchObject({ failed: 3, completed: 0 });
    expect(JSON.stringify(report)).not.toContain('secret');
  });
  it('renews a lease that is close to expiry before executing and stops when renewal is fenced', async () => {
    const soon = lease('settlement', { expiresAtMs: Date.now() + 1_000 });
    const stale = lease('settlement', { expiresAtMs: Date.now() + 1_000 });
    const { database, calls } = port({ settlement: [soon, stale] });
    let renewals = 0;
    database.renew = async (id, token) => {
      calls.push({ name: 'renew', args: [id, token] });
      renewals += 1;
      return renewals === 1 ? { ok: true, expiresAtMs: Date.now() + WORKER_LIMITS.leaseMs } : { ok: false, code: 'conflict' };
    };
    const report = await runWorker({ database, workerId: 'worker-e' });
    expect(calls.filter(c => c.name === 'renew').map(c => c.args[0])).toEqual([soon.id, stale.id]);
    expect(calls.filter(c => c.name === 'settle').map(c => c.args[0])).toEqual([soon.activityId]);
    expect(report).toMatchObject({ completed: 1, conflicts: 1 });
  });
  it('counts fenced completions and replayed settlements without inventing grants', async () => {
    const jobs = [lease('settlement'), lease('settlement'), lease('settlement')];
    const outcomes: JobOutcome[] = [{ ok: true, newGrants: 1 }, { ok: true, newGrants: 0, replayed: true }, { ok: false, code: 'conflict' }];
    const { database } = port({ settlement: jobs }, () => outcomes.shift()!);
    expect(await runWorker({ database, workerId: 'worker-f' })).toMatchObject({ completed: 1, replayed: 1, conflicts: 1, failed: 0 });
  });
  it('uses the authoritative renewed expiry and renews again after long execution before completion', async () => {
    let clock = 1_000;
    const job = lease('simulation', { expiresAtMs: 2_000 });
    const { database, calls } = port({ simulation: [job] });
    database.renew = async (id, token) => { calls.push({ name: 'renew', args: [id, token] }); return { ok: true, expiresAtMs: clock + 120_000 }; };
    const executors: ExecutorRegistry = { v1: { simulation: observed => {
      expect(observed.expiresAtMs).toBe(121_000); clock = 100_000; return {};
    } } };
    expect(await runWorker({ database, executors, workerId: 'renew', now: () => clock })).toMatchObject({ completed: 1 });
    expect(calls.filter(c => c.name === 'renew')).toHaveLength(2);
  });
  it('stops execution at the two-second compute budget and leaves unprocessed leases reclaimable', async () => {
    let cpu = 0;
    const { database, calls } = port({ simulation: [lease('simulation'), lease('simulation')] });
    const executors: ExecutorRegistry = { v1: { simulation: () => { cpu += 2_001; return {}; } } };
    const result = await runWorker({ database, executors, workerId: 'budget', cpuNow: () => cpu });
    expect(result).toMatchObject({ claimed: 2, completed: 1, deferred: 1 });
    expect(calls.filter(c => c.name === 'complete')).toHaveLength(1);
  });
  it('still claims and runs due jobs when coordination itself is unavailable', async () => {
    const job = lease('settlement');
    const { database, calls } = port({ settlement: [job] });
    database.coordinate = async () => { calls.push({ name: 'coordinate', args: [] }); throw new Error('worker-database-unavailable'); };
    const report = await runWorker({ database, workerId: 'worker-h' });
    expect(calls.filter(c => c.name === 'settle').map(c => c.args[0])).toEqual([job.activityId]);
    expect(report).toMatchObject({ claimed: 1, completed: 1, coordination: { ok: false, code: 'coordinator-unavailable', publishedSlot: null } });
  });
  it('does not count a failure as recorded when the fail RPC itself is unreachable', async () => {
    const job = lease('prepare', { rulesVersion: 'v9' });
    const { database } = port({ prepare: [job] });
    database.fail = async () => { throw new Error('worker-database-unavailable'); };
    expect(await runWorker({ database, workerId: 'worker-i' })).toMatchObject({ claimed: 1, failed: 0, unrecorded: 1, completed: 0 });
  });
  it('fails a job whose prepared result the database rejects as invalid', async () => {
    const job = lease('prepare');
    const { database, calls } = port({ prepare: [job] }, () => ({ ok: false, code: 'invalid' }));
    expect(await runWorker({ database, workerId: 'worker-g' })).toMatchObject({ failed: 1, completed: 0 });
    expect(calls.find(c => c.name === 'fail')?.args).toEqual([job.id, job.token, 'invalid-result']);
  });
});

describe('private worker HTTP boundary', () => {
  const run = async () => ({ claimed: 0, completed: 0, replayed: 0, failed: 0, conflicts: 0, unrecorded: 0,
    byKind: { prepare: 0, simulation: 0, reveal: 0, settlement: 0 }, coordination: null });
  it('rejects missing, publishable and near-miss credentials before any database work', async () => {
    for (const authorization of [undefined, 'Bearer publishable-key', `Bearer ${SECRET}x`, SECRET, `Bearer ${SECRET.slice(0, -1)}`]) {
      const response = await handleWorker(post(authorization), { secret: SECRET, run: async () => { throw new Error('must not run'); } });
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.json()).toEqual({ ok: false, code: 'unauthenticated' });
    }
    const unconfigured = await handleWorker(post('Bearer '), { secret: '', run: async () => { throw new Error('must not run'); } });
    expect(unconfigured.status).toBe(401);
  });
  it('accepts only POST with the server secret and returns an uncached report without CORS', async () => {
    expect((await handleWorker(post(`Bearer ${SECRET}`, 'GET'), { secret: SECRET, run })).status).toBe(405);
    const response = await handleWorker(post(`Bearer ${SECRET}`), { secret: SECRET, run });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await response.json()).toMatchObject({ claimed: 0, coordination: null });
  });
  it('masks unexpected worker failures', async () => {
    const response = await handleWorker(post(`Bearer ${SECRET}`), { secret: SECRET, run: async () => { throw new Error('service key abc'); } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('service key');
  });
});
