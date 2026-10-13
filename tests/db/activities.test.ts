import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sql, account, resetIdentity, admin, anonymous, creation, request } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase, createWorkerDatabase, prepareBuild } from '../../supabase/functions/_shared/backend/database.ts';
import type { WorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { DEFAULT_EXECUTORS, prepareActivityV1, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

const SLOT = 4_800_000;
type Outcome = { ok: boolean; code?: string; [key: string]: unknown };
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> { toHaveCode(code: string): R }
}
expect.extend({
  toHaveCode(received: Outcome, code: string) {
    return { pass: received?.ok === false && received.code === code,
      message: () => `expected a failed result with code ${code}, received ${JSON.stringify(received)}` };
  },
});

const commands = createDatabase(admin);
const deps = { database: commands, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand) => (await handleCommand(request(token, body), deps)).json();
async function rpc<T = Outcome>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
const nowSlot = () => Math.floor(Date.now() / SLOT);
/** Avoid asserting exact real-clock slots in the final seconds before a shared boundary. */
async function stableRealSlot(marginMs = 30_000) {
  const remaining = SLOT - (Date.now() % SLOT);
  if (remaining < marginMs) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  return nowSlot();
}

// Operator-only world controls for the isolated local test database; no player API exposes them.
async function resetWorld(published: number | null) {
  await resetIdentity();
  await sql`truncate private.boundaries, private.boundary_work, private.dispatch_log`;
  await sql`update private.coordinator set published_slot=${published}, lease_token=null, lease_until_ms=0, last_error=null where singleton`;
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`delete from private.rules_versions where version<>'v1'`;
  await sql`update private.rules_versions set active=true where version='v1'`;
  await sql`update private.scheduler set enabled=false where singleton`;
}
type Choices = { morning: unknown; afternoon: unknown; evening: unknown };
const TTR: Choices = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'rest' } };
const TRAINING: Choices = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } };
/** Real creation, then the operator places the character at a historical first activity slot. */
async function fighter(options: { firstSlot?: number; stamina?: number; schedule?: Choices; name?: string } = {}) {
  const firstSlot = options.firstSlot ?? 300, schedule = options.schedule ?? TTR;
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation(options.name ?? 'Slot ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId;
  const createdAt = (firstSlot - 1) * SLOT + 1;
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${firstSlot * SLOT},processed_slot_index=${firstSlot - 1}
    ${options.stamina === undefined ? sql`` : sql`,stamina_current=${options.stamina}`} where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${createdAt},effective_slot_index=${firstSlot},choice=${sql.json(schedule[phase] as never)}
      where gladiator_id=${gid} and phase=${phase}`;
  }
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    if (error) throw new Error(error.message);
    return data!.state;
  };
  const row = async () => (await sql`select earned_points::int as earned, unspent_points::int as unspent, stamina_current::int as stamina,
    stamina_maximum::int as maximum, processed_slot_index::int as processed from public.gladiators where id=${gid}`)[0];
  return { ...owner, gid, state, row };
}
async function coordinatorLease() {
  const token = randomUUID();
  await sql`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
  return token;
}
const advance = (target: number, token: string) => rpc('advance_boundary', { target_slot: target, coordinator_token: token });
/** The real RPC adapter and real runWorker; only coordination is pinned to an explicit historical target. */
function historicalPort(target: number, token: string): WorkerDatabase {
  const real = createWorkerDatabase(admin);
  return { ...real, coordinate: async () => ({ ok: true, publishedSlot: null, boundaries: [await advance(target, token)] }) };
}
async function runBoundary(target: number, token?: string) {
  const lease = token ?? await coordinatorLease();
  for (let round = 0; round < 6; round++) {
    const result = await advance(target, lease);
    if (result.status === 'complete' || ['integration', 'operator', 'extension', 'straggler'].includes(result.wait as string)) return result;
    await runWorker({ database: historicalPort(target, lease), workerId: randomUUID() });
  }
  return advance(target, lease);
}
async function settleDue(target: number, token: string) {
  return runWorker({ database: historicalPort(target, token), workerId: randomUUID() });
}
async function claim(kind: string, limit = 20, worker = randomUUID()) {
  return rpc<JobLease[]>('claim_jobs', { worker_id: worker, kind, batch_limit: limit });
}
/** Completes due preparation through the canonical v1 executor without letting a worker coordinate afterwards. */
async function completePreparations() {
  for (const job of await claim('prepare')) {
    expect(await rpc('complete_job', { job_id: job.id, lease_token: job.token, result: prepareActivityV1(job.snapshot as PreparationInput) })).toMatchObject({ ok: true });
  }
}
const settlementAttempts = () => sql`select a.attempt::int, a.outcome, a.failure_code from private.job_attempts a join private.jobs j on j.id=a.job_id
  where j.kind='settlement' order by a.attempt`;
const activities = (gid: string) => sql`select slot_index::int as slot, requested->>'kind' as requested, resolved_kind, fallback,
  stamina_debit::int as debit, status from public.activities where gladiator_id=${gid} order by slot_index`;

/** Plan Step 1 helpers: real SQL lifecycle transactions, no fabricated results. */
const db = {
  async advanceTrainingRestSchedule(slots: number) {
    const owner = await fighter();
    const token = await coordinatorLease();
    for (let slot = 300; slot < 300 + slots; slot++) expect(await runBoundary(slot, token)).toMatchObject({ ok: true, status: 'complete' });
    await settleDue(300 + slots - 1, token);
    const [{ completed }] = await sql`select count(*)::int as completed from private.settled_slots where gladiator_id=${owner.gid}`;
    const row = await owner.row();
    return { completedSlots: completed, trainingPoints: row.earned - 10, owner, row };
  },
  async startTrainingWithStamina(stamina: number) {
    const owner = await fighter({ stamina });
    expect(await runBoundary(300)).toMatchObject({ status: 'complete' });
    const [activity] = await sql`select resolved_kind as "resolvedKind", stamina_debit::int as "staminaDebit", fallback from public.activities where gladiator_id=${owner.gid}`;
    return { ...activity, owner };
  },
  lost: null as null | { job: JobLease; owner: Awaited<ReturnType<typeof fighter>> },
  async commitThenLoseResponse() {
    const owner = await fighter();
    await runBoundary(300);
    const [job] = await claim('settlement');
    // The transaction commits; this caller deliberately discards the response as a lost network reply.
    void await rpc('settle_activity', { activity_id: job.activityId, lease_token: job.token });
    db.lost = { job, owner };
  },
  async retrySameSettlement() {
    const { job, owner } = db.lost!;
    const retried = await rpc('settle_activity', { activity_id: job.activityId, lease_token: job.token });
    return { ...retried, earned: (await owner.row()).earned };
  },
  async completeWithStolenLease() {
    await fighter();
    const token = await coordinatorLease();
    expect(await advance(300, token)).toMatchObject({ status: 'waiting', wait: 'preparation' });
    const [job] = await claim('prepare');
    const result = prepareActivityV1(job.snapshot as PreparationInput);
    return rpc('complete_job', { job_id: job.id, lease_token: randomUUID(), result });
  },
};

describe('authoritative ordered boundaries and fenced jobs', () => {
  beforeEach(() => resetWorld(299));
  afterAll(() => sql.end());

  it('freezes historical gear strength in boundary preparation for later league calculation', async () => {
    const owner = await fighter();
    const token = await coordinatorLease();
    expect(await advance(300, token)).toMatchObject({ phase: 4, wait: 'preparation' });
    const [job] = await claim('prepare');
    expect(job.snapshot).toMatchObject({ peakStrength: 28 });
    await sql`update public.gladiators set peak_strength=40 where id=${owner.gid}`;
    expect((await sql`select input from private.jobs where id=${job.id}`)[0].input).toMatchObject({ peakStrength: 28 });
  });

  it('exposes only the backend lifecycle RPCs with invoker security', async () => {
    const rows = await sql`select proname, prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and proname in ('advance_boundary','claim_jobs','complete_job','settle_activity','renew_job','fail_job','coordinate_work')`;
    expect(rows.map(r => r.proname).sort()).toEqual(['advance_boundary', 'claim_jobs', 'complete_job', 'coordinate_work', 'fail_job', 'renew_job', 'settle_activity']);
    expect(rows.filter(r => r.prosecdef)).toEqual([]);
  });

  it('advances offline Training/Training/Rest chronology to exactly six points in nine slots', async () => {
    const result = await db.advanceTrainingRestSchedule(9);
    expect(result).toMatchObject({ completedSlots: 9, trainingPoints: 6 });
    expect(result.row).toMatchObject({ earned: 16, unspent: 6, stamina: 104, maximum: 104, processed: 308 });
    expect((await activities(result.owner.gid)).map(a => a.resolved_kind)).toEqual(
      ['training', 'training', 'rest', 'training', 'training', 'rest', 'training', 'training', 'rest']);
    expect(await sql`select count(*)::int as n from private.jobs where kind='settlement' and status='completed'`).toEqual([{ n: 9 }]);
    expect((await result.owner.state()).currentActivity).toMatchObject({ kind: 'rest', status: 'completed', startsAtMs: 308 * SLOT, endsAtMs: 309 * SLOT });
    const summaries = await sql`select summary from public.activities where gladiator_id=${result.owner.gid} order by slot_index`;
    expect(summaries[0].summary).toMatchObject({ resolvedKind: 'training', result: 'completed', success: true, rewards: { attributePoints: 1, money: 0 } });
    expect(summaries[2].summary).toMatchObject({ resolvedKind: 'rest', result: 'completed', success: true, rewards: { attributePoints: 0 } });
  });

  it('replaces unaffordable Training with automatic Rest that refills only at settlement', async () => {
    const started = await db.startTrainingWithStamina(19);
    expect(started).toMatchObject({ resolvedKind: 'rest', staminaDebit: 0, fallback: true });
    expect(await started.owner.row()).toMatchObject({ stamina: 19, earned: 10 });
    await settleDue(300, await coordinatorLease());
    expect(await started.owner.row()).toMatchObject({ stamina: 104, earned: 10 });
  });

  it('replays a committed settlement after a lost response without new grants', async () => {
    await db.commitThenLoseResponse();
    expect(await db.retrySameSettlement()).toMatchObject({ ok: true, newGrants: 0, earned: 11 });
    expect(await sql`select count(*)::int as n from private.settled_slots`).toEqual([{ n: 1 }]);
  });

  it('rejects completion with a stolen lease', async () => {
    expect(await db.completeWithStolenLease()).toHaveCode('conflict');
    expect(await sql`select count(*)::int as n from private.jobs where kind='prepare' and status='completed'`).toEqual([{ n: 0 }]);
  });

  it('holds the next cohort behind previous settlement and registered season-close work', async () => {
    const a = await fighter(), b = await fighter();
    const token = await coordinatorLease();
    await runBoundary(300, token);
    await sql`insert into private.boundary_work(slot_index,phase,key,status) values(301,2,'season-close','pending')`;
    expect(await advance(301, token)).toMatchObject({ ok: true, slotIndex: 301, phase: 1, status: 'waiting', wait: 'settlement' });
    const [first] = await claim('settlement', 1);
    expect(await rpc('settle_activity', { activity_id: first.activityId, lease_token: first.token })).toMatchObject({ ok: true, newGrants: 1 });
    expect(await advance(301, token)).toMatchObject({ phase: 1, wait: 'settlement' });
    const [second] = await claim('settlement', 1);
    await rpc('settle_activity', { activity_id: second.activityId, lease_token: second.token });
    expect(await advance(301, token)).toMatchObject({ phase: 2, status: 'waiting', wait: 'extension' });
    expect(await sql`select count(*)::int as n from private.boundary_members where slot_index=301`).toEqual([{ n: 0 }]);
    expect(await sql`select count(*)::int as n from public.activities where slot_index=301`).toEqual([{ n: 0 }]);
    await sql`update private.boundary_work set status='done' where slot_index=301`;
    expect(await advance(301, token)).toMatchObject({ phase: 4, wait: 'preparation' });
    expect(await sql`select count(*)::int as n from private.boundary_members where slot_index=301`).toEqual([{ n: 2 }]);
    expect(await runBoundary(301, token)).toMatchObject({ status: 'complete' });
    for (const owner of [a, b]) expect((await owner.row()).processed).toBe(301);
  });

  it('enforces chronological, present-bounded and coordinator-fenced boundary calls', async () => {
    await fighter();
    const token = await coordinatorLease();
    expect(await advance(301, token)).toHaveCode('invalid');
    expect(await advance(nowSlot() + 1, token)).toHaveCode('invalid');
    expect(await advance(300, randomUUID())).toHaveCode('conflict');
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    expect(await advance(300, token)).toMatchObject({ ok: true, status: 'complete', replayed: true });
    await sql`update private.coordinator set lease_until_ms=0 where singleton`;
    expect(await advance(301, token)).toHaveCode('conflict');
  });

  it('recovers a partial boundary crash without duplicate snapshots, debits or jobs', async () => {
    const fighters = [await fighter(), await fighter(), await fighter()];
    const token = await coordinatorLease();
    expect(await advance(300, token)).toMatchObject({ phase: 4, wait: 'preparation' });
    await completePreparations();
    // An injected failure while the second start job is written aborts phases 5-8 of this call only.
    await sql.unsafe(`create function private.task7_crash() returns trigger language plpgsql set search_path='' as $$
      begin if (select count(*) from private.jobs where kind='settlement') >= 1 then raise exception 'injected boundary crash'; end if; return new; end $$;
      create trigger task7_crash before insert on private.jobs for each row when (new.kind='settlement') execute function private.task7_crash();`);
    try {
      await expect(advance(300, token)).rejects.toThrow('injected boundary crash');
      expect(await sql`select phase::int, status, wait_reason from private.boundaries where slot_index=300`).toEqual([{ phase: 4, status: 'waiting', wait_reason: 'preparation' }]);
      expect(await sql`select count(*)::int as n from public.activities`).toEqual([{ n: 0 }]);
      expect(await sql`select count(*)::int as n from private.jobs where kind='prepare' and status='completed'`).toEqual([{ n: 3 }]);
      for (const owner of fighters) expect(await owner.row()).toMatchObject({ stamina: 104, processed: 299 });
    } finally {
      await sql.unsafe('drop trigger task7_crash on private.jobs; drop function private.task7_crash();');
    }
    expect(await advance(300, token)).toMatchObject({ status: 'complete' });
    expect(await advance(300, token)).toMatchObject({ status: 'complete', replayed: true });
    for (const owner of fighters) {
      expect(await owner.row()).toMatchObject({ stamina: 84, processed: 300 });
      expect(await activities(owner.gid)).toEqual([{ slot: 300, requested: 'training', resolved_kind: 'training', fallback: false, debit: 20, status: 'active' }]);
    }
    expect(await sql`select count(*)::int as n from private.jobs where kind='settlement'`).toEqual([{ n: 3 }]);
    await expect(sql`insert into public.activities(gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,status)
      values(${fighters[0].gid},300,${300 * SLOT},${301 * SLOT},'{"kind":"rest"}','preparing')`).rejects.toThrow(/duplicate key/);
  });

  it('lets a replacement coordinator resume a persisted partial boundary and fences the stale one', async () => {
    await fighter();
    const stale = await coordinatorLease();
    expect(await advance(300, stale)).toMatchObject({ wait: 'preparation' });
    const replacement = await coordinatorLease();
    expect(await advance(300, stale)).toHaveCode('conflict');
    expect(await runBoundary(300, replacement)).toMatchObject({ status: 'complete' });
    expect(await sql`select count(*)::int as n from private.jobs where kind='prepare'`).toEqual([{ n: 1 }]);
  });

  it('fences a stale worker after renewal and reclaim while preserving seed and input', async () => {
    const owner = await fighter();
    await runBoundary(300);
    const [first] = await claim('settlement');
    expect(first.expiresAtMs - Date.now()).toBeGreaterThan(110_000);
    expect(first.expiresAtMs - Date.now()).toBeLessThanOrEqual(120_000);
    expect(await rpc('renew_job', { job_id: first.id, lease_token: first.token })).toMatchObject({ ok: true });
    await sql`update private.jobs set lease_until_ms=0 where id=${first.id}`;
    expect(await rpc('renew_job', { job_id: first.id, lease_token: first.token })).toHaveCode('conflict');
    const [second] = await claim('settlement');
    expect(second).toMatchObject({ id: first.id, attempt: 2, seed: first.seed, rulesVersion: first.rulesVersion });
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.token).not.toBe(first.token);
    expect(await rpc('renew_job', { job_id: second.id, lease_token: second.token })).toMatchObject({ ok: true });
    expect(await rpc('settle_activity', { activity_id: first.activityId, lease_token: first.token })).toHaveCode('conflict');
    expect(await rpc('settle_activity', { activity_id: second.activityId, lease_token: randomUUID() })).toHaveCode('conflict');
    expect(await rpc('settle_activity', { activity_id: second.activityId, lease_token: second.token })).toMatchObject({ ok: true, newGrants: 1 });
    expect(await rpc('settle_activity', { activity_id: first.activityId, lease_token: first.token })).toHaveCode('conflict');
    expect(await rpc('fail_job', { job_id: first.id, lease_token: second.token, failure_code: 'late' })).toHaveCode('conflict');
    expect((await owner.row()).earned).toBe(11);
    await expect(sql`update private.jobs set seed='replaced' where id=${first.id}`).rejects.toThrow('immutable job');
    await expect(sql`update private.jobs set input='{}' where id=${first.id}`).rejects.toThrow('immutable job');
    await expect(sql`update private.jobs set rules_version='v2' where id=${first.id}`).rejects.toThrow('immutable job');
  });

  it('serializes concurrent settlement retries into one grant', async () => {
    const owner = await fighter();
    await runBoundary(300);
    const [job] = await claim('settlement');
    const results = await Promise.all(Array.from({ length: 4 }, () => rpc('settle_activity', { activity_id: job.activityId, lease_token: job.token })));
    expect(results.map(r => r.newGrants).sort()).toEqual([0, 0, 0, 1]);
    expect(new Set(results.map(r => r.receiptId)).size).toBe(1);
    expect((await owner.row()).earned).toBe(11);
  });

  it('claims with SKIP LOCKED and caps simple and combat batches', async () => {
    const owner = await fighter();
    await sql`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
      select 'reveal','test-reveal:'||n,300,${owner.gid},'{}','v1',0 from generate_series(1,25) n`;
    await sql`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
      select 'simulation','test-simulation:'||n,300,${owner.gid},'{}','v1',0 from generate_series(1,8) n`;
    await sql`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
      values('reveal','test-future',300,${owner.gid},'{}','v1',9007199254740991)`;
    const [a, b] = await Promise.all([claim('reveal', 20), claim('reveal', 20)]);
    expect(a.length + b.length).toBe(25);
    expect(new Set([...a, ...b].map(j => j.id)).size).toBe(25);
    expect(Math.max(a.length, b.length)).toBeLessThanOrEqual(20);
    expect((await claim('simulation', 99)).length).toBe(5);
    expect((await claim('reveal', 99)).length).toBe(0);
    await expect(claim('everything', 1)).rejects.toThrow();
  });

  it('retains a job for operator action after three failed attempts, then resumes after repair', async () => {
    const owner = await fighter();
    const token = await coordinatorLease();
    await runBoundary(300, token);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [job] = await claim('settlement');
      expect(job.attempt).toBe(attempt);
      expect(await rpc('fail_job', { job_id: job.id, lease_token: job.token, failure_code: 'execution-failed' }))
        .toMatchObject({ ok: true, status: attempt === 3 ? 'operator' : 'pending' });
    }
    expect(await claim('settlement')).toEqual([]);
    expect(await sql`select status, attempts::int, last_failure from private.jobs where kind='settlement'`)
      .toEqual([{ status: 'operator', attempts: 3, last_failure: 'execution-failed' }]);
    expect(await settlementAttempts()).toEqual([1, 2, 3].map(attempt => ({ attempt, outcome: 'failed', failure_code: 'execution-failed' })));
    expect(JSON.stringify(await sql`select * from private.job_attempts`)).not.toMatch(/token/i);
    expect(await advance(301, token)).toMatchObject({ phase: 1, status: 'waiting', wait: 'operator' });
    expect((await owner.row()).earned).toBe(10);
    await sql`select private.resume_operator_job(id) from private.jobs where kind='settlement'`;
    expect(await runBoundary(301, token)).toMatchObject({ status: 'complete' });
    expect((await owner.row()).earned).toBe(11);
  });

  it('moves a job whose third lease expired to operator state without another claim', async () => {
    await fighter();
    const token = await coordinatorLease();
    await runBoundary(300, token);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [job] = await claim('settlement');
      expect(job.attempt).toBe(attempt);
      await sql`update private.jobs set lease_until_ms=0 where id=${job.id}`;
    }
    // No fourth claim: an Edge CPU/wall-clock kill on attempt 3 must still surface as operator state.
    expect(await rpc('coordinate_work')).toMatchObject({ ok: true, busy: true });
    expect(await sql`select status, attempts::int, last_failure, lease_token from private.jobs where kind='settlement'`)
      .toEqual([{ status: 'operator', attempts: 3, last_failure: 'lease-expired', lease_token: null }]);
    expect((await settlementAttempts()).map(r => r.outcome)).toEqual(['expired', 'expired', 'expired']);
    expect(await advance(301, token)).toMatchObject({ phase: 1, status: 'waiting', wait: 'operator' });
    expect(await claim('settlement')).toEqual([]);
  });

  it('reports a preparation job whose third lease expired as an operator wait at phase 4', async () => {
    await fighter();
    const token = await coordinatorLease();
    expect(await advance(300, token)).toMatchObject({ wait: 'preparation' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [job] = await claim('prepare');
      expect(job.attempt).toBe(attempt);
      await sql`update private.jobs set lease_until_ms=0 where id=${job.id}`;
    }
    expect(await advance(300, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'operator' });
    expect(await sql`select status, last_failure from private.jobs where kind='prepare'`).toEqual([{ status: 'operator', last_failure: 'lease-expired' }]);
  });

  it('keeps completed jobs terminal with an immutable result', async () => {
    await fighter();
    await runBoundary(300);
    const [prepared] = await sql`select id from private.jobs where kind='prepare' and status='completed'`;
    await expect(sql`update private.jobs set status='pending' where id=${prepared.id}`).rejects.toThrow('immutable job');
    await expect(sql`update private.jobs set result='{}' where id=${prepared.id}`).rejects.toThrow('immutable job');
    await expect(sql`update private.jobs set lease_token=${randomUUID()} where id=${prepared.id}`).rejects.toThrow('immutable job');
    const [settlement] = await claim('settlement');
    // Only completion writes a result; operator state resumes only to pending.
    await expect(sql`update private.jobs set result='{"forged":true}' where id=${settlement.id}`).rejects.toThrow('immutable job');
    await sql`update private.jobs set status='operator',lease_token=null where id=${settlement.id}`;
    await expect(sql`update private.jobs set status='completed' where id=${settlement.id}`).rejects.toThrow('immutable job');
    await expect(sql`update private.jobs set status='leased' where id=${settlement.id}`).rejects.toThrow('immutable job');
  });

  it('copies the authoritative snapshot seed onto the activity jobs', async () => {
    await fighter();
    await runBoundary(300);
    expect(await sql`select j.seed=s.seed as same, length(s.seed)::int as size from private.jobs j
      join private.activity_snapshots s on s.activity_id=j.activity_id where j.kind='settlement'`).toEqual([{ same: true, size: 64 }]);
  });

  it('builds the settlement summary from the settle_rewards hook outcome', async () => {
    await fighter();
    await runBoundary(300);
    const [{ definition }] = await sql`select pg_get_functiondef('private.settle_rewards(uuid)'::regprocedure) as definition`;
    // Operator stand-in for a later executor's hook (Task 9 defeat / Task 16 rating); restored below.
    await sql.unsafe(`create or replace function private.settle_rewards(activity uuid) returns jsonb language sql security invoker set search_path='' as $$
      select jsonb_build_object('rewards',jsonb_build_object('money',0,'renown',3,'xp',0,'attributePoints',0,'items','[]'::jsonb,'overflowMoney',0),
        'result','defeat','success',false,'ratingDelta',-12,'replayExpiry',jsonb_build_object('state','available','expiresAtMs',123)) $$`);
    try {
      const [job] = await claim('settlement');
      const settled = await rpc('settle_activity', { activity_id: job.activityId, lease_token: job.token });
      expect(settled.summary).toMatchObject({ resolvedKind: 'training', result: 'defeat', success: false, ratingDelta: -12,
        replayExpiry: { state: 'available', expiresAtMs: 123 }, rewards: { renown: 3, attributePoints: 0 }, receiptId: settled.receiptId });
    } finally {
      await sql.unsafe(definition);
    }
  });

  it('isolates a failing boundary inside coordinate_work and records only a sanitized failure', async () => {
    const current = await stableRealSlot(120_000);
    await resetWorld(current - 2);
    const owner = await fighter({ firstSlot: current - 1, schedule: TRAINING });
    expect(await rpc('coordinate_work')).toMatchObject({ ok: true, boundaries: [{ slotIndex: current - 1, wait: 'preparation' }] });
    await completePreparations();
    await sql.unsafe(`create function private.task7_fail_boundary() returns trigger language plpgsql set search_path='' as $$
      begin raise exception 'injected later boundary failure'; end $$;
      create trigger task7_fail_boundary before insert on private.boundaries for each row when (new.slot_index=${current})
      execute function private.task7_fail_boundary();`);
    let isolated: Outcome;
    try { isolated = await rpc('coordinate_work'); }
    finally { await sql.unsafe('drop trigger task7_fail_boundary on private.boundaries; drop function private.task7_fail_boundary();'); }
    expect(isolated).toMatchObject({ ok: true, publishedSlot: current - 1, boundaries: [
      { ok: true, slotIndex: current - 1, status: 'complete' }, { ok: false, code: 'boundary-failed', slotIndex: current, sqlstate: 'P0001' }] });
    expect(JSON.stringify(isolated)).not.toContain('injected');
    expect(await owner.row()).toMatchObject({ processed: current - 1 });
    expect(await sql`select last_error, last_failed_slot::int as slot from private.coordinator`).toEqual([{ last_error: 'P0001', slot: current }]);

    const [settlement] = await claim('settlement');
    expect(await rpc('settle_activity', { activity_id: settlement.activityId, lease_token: settlement.token })).toMatchObject({ ok: true });
    expect(await rpc('coordinate_work')).toMatchObject({ boundaries: [{ slotIndex: current, wait: 'preparation' }] });
    await completePreparations();
    await sql.unsafe(`create function private.task7_crash_start() returns trigger language plpgsql set search_path='' as $$
      begin raise exception 'injected start failure'; end $$;
      create trigger task7_crash_start before insert on private.jobs for each row when (new.kind='settlement') execute function private.task7_crash_start();`);
    let failed: Outcome;
    try { failed = await rpc('coordinate_work'); }
    finally { await sql.unsafe('drop trigger task7_crash_start on private.jobs; drop function private.task7_crash_start();'); }
    expect(failed).toMatchObject({ ok: true, boundaries: [{ ok: false, code: 'boundary-failed', slotIndex: current, sqlstate: 'P0001' }] });
    // The persisted wait is truthful rather than a stale 'preparation', and none of the failed call's work survives.
    expect(await sql`select phase::int, status, wait_reason, last_error from private.boundaries where slot_index=${current}`)
      .toEqual([{ phase: 4, status: 'waiting', wait_reason: 'error', last_error: 'P0001' }]);
    expect(await sql`select count(*)::int as n from public.activities where slot_index=${current}`).toEqual([{ n: 0 }]);
    expect(await rpc('coordinate_work')).toMatchObject({ boundaries: [{ slotIndex: current, status: 'complete' }] });
    expect(await sql`select wait_reason, last_error from private.boundaries where slot_index=${current}`).toEqual([{ wait_reason: null, last_error: null }]);
    expect(await sql`select last_error, last_failed_slot from private.coordinator`).toEqual([{ last_error: null, last_failed_slot: null }]);
    // One settled Training point and two Training debits (104 -> 84 -> 64): the retried boundary debited exactly once.
    expect(await owner.row()).toMatchObject({ processed: current, stamina: 64, earned: 11 });
  }, 180_000);

  it('keeps an in-progress boundary on its persisted rules version and fails an unknown version closed', async () => {
    const owner = await fighter();
    const token = await coordinatorLease();
    expect(await advance(300, token)).toMatchObject({ wait: 'preparation' });
    await sql`insert into private.rules_versions(version,active) values('v2',false)`;
    await sql`update private.rules_versions set active=false where version='v1'`;
    await sql`update private.rules_versions set active=true where version='v2'`;
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    expect(await sql`select s.rules_version, s.snapshot->>'rulesVersion' as snapshot_version from private.activity_snapshots s`)
      .toEqual([{ rules_version: 'v1', snapshot_version: 'v1' }]);
    for (let round = 0; round < 4; round++) await runWorker({ database: historicalPort(301, token), workerId: randomUUID() });
    expect(await sql`select rules_version, status, attempts::int, last_failure from private.jobs where kind='prepare' and slot_index=301`)
      .toEqual([{ rules_version: 'v2', status: 'operator', attempts: 3, last_failure: 'unsupported-rules' }]);
    expect(await advance(301, token)).toMatchObject({ phase: 4, wait: 'operator' });
    expect(await owner.row()).toMatchObject({ processed: 300, earned: 11 });
    expect(await sql`select count(*)::int as n from public.activities where slot_index=301`).toEqual([{ n: 0 }]);
  });

  it('recomputes the derived stamina maximum under a newer rules version without refilling', async () => {
    const owner = await fighter();
    const token = await coordinatorLease();
    await runBoundary(300, token);
    await sql`insert into private.rules_versions(version,active) values('v2',false)`;
    await sql`update private.rules_versions set active=false where version='v1'`;
    await sql`update private.rules_versions set active=true where version='v2'`;
    // Test-only stand-in for a future rules module: canonical v1 derivation with a reduced capacity.
    const executors = { ...DEFAULT_EXECUTORS, v2: { prepare: (job: JobLease) => {
      const derived = prepareActivityV1({ ...(job.snapshot as PreparationInput), rulesVersion: 'v1' });
      return { ...derived, rulesVersion: 'v2', staminaMaximum: 80, snapshot: { ...derived.snapshot, rulesVersion: 'v2' } };
    } } };
    for (let round = 0; round < 3 && (await advance(301, token)).status !== 'complete'; round++) {
      await runWorker({ database: historicalPort(301, token), workerId: randomUUID(), executors });
    }
    expect(await advance(301, token)).toMatchObject({ status: 'complete' });
    expect(await owner.row()).toMatchObject({ maximum: 80, stamina: 60, processed: 301 });
    const [{ starting }] = await sql`select s.snapshot->'starting'->'stamina' as starting from private.activity_snapshots s
      join public.activities a on a.id=s.activity_id where a.slot_index=301`;
    expect(starting).toEqual({ current: 80, maximum: 80 });
  });

  it('snapshots historical schedule revisions instead of the latest plan or late edits', async () => {
    const owner = await fighter();
    await sql`update public.schedules set schedule='{"morning":{"kind":"arena"},"afternoon":{"kind":"arena"},"evening":{"kind":"arena"}}' where gladiator_id=${owner.gid}`;
    // Received during evening slot 302: next morning is 303.
    await sql`insert into public.schedule_revisions values(${owner.gid},2,'morning','{"kind":"rest"}',${302 * SLOT + 5},303)`;
    // Received during afternoon slot 301 itself: that started afternoon is unaffected; next afternoon is 304.
    await sql`insert into public.schedule_revisions values(${owner.gid},3,'afternoon','{"kind":"rest"}',${301 * SLOT + 5},304)`;
    const token = await coordinatorLease();
    for (let slot = 300; slot <= 305; slot++) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    expect((await activities(owner.gid)).map(a => a.requested)).toEqual(['training', 'training', 'rest', 'rest', 'rest', 'rest']);
    expect(await sql`select slot_index::int as slot, schedule_version::int as version from public.activities where gladiator_id=${owner.gid} order by slot_index`)
      .toEqual([{ slot: 300, version: 1 }, { slot: 301, version: 1 }, { slot: 302, version: 1 }, { slot: 303, version: 2 }, { slot: 304, version: 3 }, { slot: 305, version: 1 }]);
  });

  it('keeps a character created after the cutoff in orientation until the next slot', async () => {
    const early = await fighter();
    const late = await fighter({ firstSlot: 301 });
    // Created inside slot 300 after its cutoff, but before a delayed boundary 300 was processed.
    await sql`update public.gladiators set created_at_ms=${300 * SLOT + 1_000} where id=${late.gid}`;
    const token = await coordinatorLease();
    await runBoundary(300, token);
    expect(await sql`select gladiator_id from private.boundary_members where slot_index=300`).toEqual([{ gladiator_id: early.gid }]);
    expect(await activities(late.gid)).toEqual([]);
    expect((await late.state()).currentActivity).toMatchObject({ kind: 'orientation', startsAtMs: 300 * SLOT + 1_000, endsAtMs: 301 * SLOT });
    await runBoundary(301, token);
    expect((await activities(late.gid)).map(a => a.slot)).toEqual([301]);
    expect((await late.row()).processed).toBe(301);
  });

  it('admits a never-started late-committed character to the next cohort but stalls on a participating straggler', async () => {
    const regular = await fighter();
    const lateCommit = await fighter({ firstSlot: 299 });
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    expect((await activities(lateCommit.gid)).map(a => a.slot)).toEqual([300]);
    expect(await sql`select orientation_end_ms::float8 as ends from public.gladiators where id=${lateCommit.gid}`).toEqual([{ ends: 300 * SLOT }]);
    await settleDue(300, token);
    await sql`update public.gladiators set processed_slot_index=299 where id=${regular.gid}`;
    expect(await advance(301, token)).toMatchObject({ phase: 3, status: 'waiting', wait: 'straggler' });
  });

  it('applies an eligible pending build once at the boundary before snapshotting and keeps buildVersion monotonic', async () => {
    const owner = await fighter();
    await sql`update public.wallets set money=300 where gladiator_id=${owner.gid}`;
    const before = await owner.state();
    await sql.begin(async tx => {
      // Rollback-only operator clock inside slot 299, never a player time input.
      await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path='' as 'select ${299 * SLOT + 10}::bigint'`);
      const command = { kind: 'queue-build', operationId: randomUUID(), expectedVersion: before.buildVersion, classId: 'berserker', stance: 'offensive',
        allocation: { strength: 3, agility: 1, vitality: 2, endurance: 2, precision: 2 }, equipment: before.currentBuild.equipment } as const;
      const prepared = prepareBuild(command, before);
      const [{ queued }] = await tx`select public.queue_build(${owner.id},${command.operationId},${tx.json({ command, prepared } as never)}) as queued`;
      expect(queued).toMatchObject({ ok: true, value: { effectiveSlotIndex: 300, reservedMoney: 200 } });
      await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path='' as 'select ${300 * SLOT + 10}::bigint'`);
      const token = randomUUID();
      await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
      const [{ first }] = await tx`select public.advance_boundary(300,${token}) as first`;
      expect(first).toMatchObject({ phase: 4, wait: 'preparation' });
      const [{ jobs }] = await tx`select public.claim_jobs(${randomUUID()},'prepare',20) as jobs`;
      const job = (jobs as JobLease[])[0];
      expect((job.snapshot as PreparationInput).build).toMatchObject({ classId: 'berserker', stance: 'offensive', version: 2 });
      const [{ completed }] = await tx`select public.complete_job(${job.id},${job.token},${tx.json(prepareActivityV1(job.snapshot as PreparationInput) as never)}) as completed`;
      expect(completed).toMatchObject({ ok: true });
      const [{ done }] = await tx`select public.advance_boundary(300,${token}) as done`;
      expect(done).toMatchObject({ status: 'complete' });
      const [snapshot] = await tx`select snapshot from private.activity_snapshots`;
      expect(snapshot.snapshot.build).toMatchObject({ classId: 'berserker', stance: 'offensive' });
      const [state] = await tx`select b.version::int as edit, b.current_build->>'version' as active, b.pending_build, w.money::int as money,
        (select count(*)::int from public.wallet_ledger l where l.gladiator_id=b.gladiator_id and reason='build') as fees
        from public.builds b join public.wallets w using (gladiator_id) where b.gladiator_id=${owner.gid}`;
      expect(state).toEqual({ edit: 2, active: '2', pending_build: null, money: 100, fees: 1 });
      await tx`rollback`;
    });
    const [{ now }] = await sql`select private.planning_now_ms()::float8 as now`;
    expect(Math.abs(now - Date.now())).toBeLessThan(5000);
  });

  it('clamps stamina for a pending lower-Endurance build before the snapshot and the debit', async () => {
    const owner = await fighter();
    await sql`update public.wallets set money=300 where gladiator_id=${owner.gid}`;
    const before = await owner.state();
    expect(before.stamina).toEqual({ current: 104, maximum: 104 });
    await sql.begin(async tx => {
      // Rollback-only operator clock inside slot 299, never a player time input.
      await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path='' as 'select ${299 * SLOT + 10}::bigint'`);
      const command = { kind: 'queue-build', operationId: randomUUID(), expectedVersion: before.buildVersion, classId: 'guardian', stance: 'balanced',
        allocation: { strength: 4, agility: 2, vitality: 2, endurance: 0, precision: 2 }, equipment: before.currentBuild.equipment } as const;
      const [{ queued }] = await tx`select public.queue_build(${owner.id},${command.operationId},${tx.json({ command, prepared: prepareBuild(command, before) } as never)}) as queued`;
      expect(queued).toMatchObject({ ok: true, value: { effectiveSlotIndex: 300, reservedMoney: 100 } });
      await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path='' as 'select ${300 * SLOT + 10}::bigint'`);
      const token = randomUUID();
      await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
      expect((await tx`select public.advance_boundary(300,${token}) as r`)[0].r).toMatchObject({ phase: 4, wait: 'preparation' });
      const job = ((await tx`select public.claim_jobs(${randomUUID()},'prepare',20) as jobs`)[0].jobs as JobLease[])[0];
      const prepared = prepareActivityV1(job.snapshot as PreparationInput);
      // Guardian Endurance 5 x 1.05 = 5.25: maximum floor(90 + 10.5) = 100.
      expect(prepared.staminaMaximum).toBe(100);
      expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(prepared as never)}) as r`)[0].r).toMatchObject({ ok: true });
      expect((await tx`select public.advance_boundary(300,${token}) as r`)[0].r).toMatchObject({ status: 'complete' });
      const [{ starting }] = await tx`select snapshot->'starting'->'stamina' as starting from private.activity_snapshots`;
      expect(starting).toEqual({ current: 100, maximum: 100 });
      expect(await tx`select stamina_current::int as current, stamina_maximum::int as maximum from public.gladiators where id=${owner.gid}`)
        .toEqual([{ current: 80, maximum: 100 }]);
      expect(await tx`select stamina_debit::int as debit, resolved_kind from public.activities`).toEqual([{ debit: 20, resolved_kind: 'training' }]);
      expect(await tx`select money::int from public.wallets where gladiator_id=${owner.gid}`).toEqual([{ money: 200 }]);
      await tx`rollback`;
    });
  });

  it('waits behind an in-flight account lock before applying builds', async () => {
    const owner = await fighter();
    const token = await coordinatorLease();
    let boundary: Promise<Outcome> | undefined;
    await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${owner.id},0))`;
      boundary = advance(300, token);
      const running = Promise.resolve(boundary); boundary = running;
      let waiting = false;
      for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        const [{ count }] = await sql`select count(*)::int from pg_locks where locktype='advisory' and not granted`;
        if (count > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    });
    expect(await boundary).toMatchObject({ phase: 4, wait: 'preparation' });
  });

  it('starts expeditions and retains the unsupported Arena integration gate', async () => {
    const explorer = await fighter({ schedule: { morning: { kind: 'expedition', expeditionId: 'woodland' }, afternoon: { kind: 'rest' }, evening: { kind: 'rest' } } });
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ phase: 9, status: 'complete' });
    expect(await runBoundary(300, token)).toMatchObject({ phase: 9, status: 'complete' });
    expect(await activities(explorer.gid)).toEqual([{ slot: 300, requested: 'expedition', resolved_kind: 'expedition', fallback: false, debit: 30, status: 'active' }]);
    expect(await explorer.row()).toMatchObject({ stamina: 74, processed: 300, earned: 10 });
    expect(await sql`select count(*)::int as n from private.jobs where kind<>'prepare'`).toEqual([{ n: 2 }]);
    expect(await sql`select count(*)::int as n from private.settled_slots`).toEqual([{ n: 0 }]);
    expect((await explorer.state()).currentActivity).toMatchObject({ kind: 'expedition', status: 'processing' });
    await resetWorld(299);
    const fighterArena = await fighter({ schedule: { morning: { kind: 'arena' }, afternoon: { kind: 'rest' }, evening: { kind: 'rest' } } });
    expect(await runBoundary(300)).toMatchObject({ phase: 7, status: 'waiting', wait: 'integration' });
    expect(await fighterArena.row()).toMatchObject({ stamina: 104, processed: 299 });

    await resetWorld(299);
    const tired = await fighter({ stamina: 10, schedule: { morning: { kind: 'arena' }, afternoon: { kind: 'rest' }, evening: { kind: 'rest' } } });
    expect(await runBoundary(300)).toMatchObject({ status: 'complete' });
    expect((await activities(tired.gid))[0]).toMatchObject({ requested: 'arena', resolved_kind: 'rest', fallback: true, debit: 0 });
  });

  it('advances offline without any player session and blocks stale commands until caught up', async () => {
    const current = await stableRealSlot();
    await resetWorld(current - 3);
    const owner = await fighter({ firstSlot: current - 2, schedule: TRAINING });
    const command: GameCommand = { kind: 'edit-schedule', operationId: randomUUID(), expectedVersion: 1, phase: 'evening', choice: { kind: 'training' } };
    expect(await send(owner.token, command)).toMatchObject({ ok: false, code: 'processing', retryAfterMs: 1000 });
    expect(await sql`select count(*)::int as n from public.operation_receipts where operation_id=${command.operationId}`).toEqual([{ n: 0 }]);
    // Only server-side workers run; the owner has no open session during catch-up.
    for (let round = 0; round < 6 && (await owner.row()).processed < current; round++) {
      await runWorker({ database: createWorkerDatabase(admin), workerId: randomUUID() });
    }
    expect(await owner.row()).toMatchObject({ processed: current });
    expect((await activities(owner.gid)).map(a => a.slot)).toEqual([current - 2, current - 1, current]);
    expect((await activities(owner.gid)).slice(0, 2).every(a => a.status === 'completed')).toBe(true);
    expect((await owner.state()).currentActivity).toMatchObject({ status: 'active', startsAtMs: current * SLOT, endsAtMs: (current + 1) * SLOT });
    expect(await send(owner.token, command)).toMatchObject({ ok: true });
  }, 60_000);

  it('denies clients the private lifecycle tables, RPCs and other owners’ activities', async () => {
    const owner = await fighter(), other = await account();
    await runBoundary(300);
    expect((await owner.client.from('activities').select('*')).data).toHaveLength(1);
    expect((await other.client.from('activities').select('*')).data).toEqual([]);
    expect((await anonymous.from('activities').select('*')).error).not.toBeNull();
    expect((await owner.client.from('activities').update({ status: 'completed' }).eq('gladiator_id', owner.gid)).error).not.toBeNull();
    const visible = JSON.stringify((await owner.client.from('activities').select('*')).data);
    expect(visible).not.toMatch(/seed|snapshot|costs/i);
    for (const [name, args] of [
      ['advance_boundary', { target_slot: 301, coordinator_token: randomUUID() }], ['claim_jobs', { worker_id: randomUUID(), kind: 'settlement', batch_limit: 1 }],
      ['complete_job', { job_id: randomUUID(), lease_token: randomUUID(), result: {} }], ['settle_activity', { activity_id: randomUUID(), lease_token: randomUUID() }],
      ['renew_job', { job_id: randomUUID(), lease_token: randomUUID() }], ['fail_job', { job_id: randomUUID(), lease_token: randomUUID(), failure_code: 'x' }],
      ['coordinate_work', {}],
    ] as const) {
      expect((await owner.client.rpc(name, args)).error, name).not.toBeNull();
      expect((await anonymous.rpc(name, args)).error, name).not.toBeNull();
    }
    const privateTables = await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relkind='r' and (has_table_privilege('authenticated',c.oid,'SELECT') or has_table_privilege('anon',c.oid,'SELECT') or not c.relrowsecurity)`;
    expect(privateTables).toEqual([]);
  });

  it('registers a one-minute cron tick that stays inert until the scheduler is enabled', async () => {
    expect(await sql`select schedule, command, active from cron.job where jobname='cloudiator-coordinate'`)
      .toEqual([{ schedule: '* * * * *', command: 'select private.cron_tick()', active: true }]);
    expect(await sql`select private.cron_tick() as tick`).toEqual([{ tick: { ok: true, skipped: 'disabled' } }]);
  });

  it('executes that tick through the local pg_cron scheduler', async () => {
    let runs = 0;
    for (const deadline = Date.now() + 75_000; Date.now() < deadline;) {
      [{ runs }] = await sql`select count(*)::int as runs from cron.job_run_details d join cron.job j on j.jobid=d.jobid
        where j.jobname='cloudiator-coordinate' and d.status='succeeded'`;
      if (runs > 0) break;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    expect(runs).toBeGreaterThan(0);
  }, 90_000);

  it('dispatches at most five workers per minute and only when claimable work exists', async () => {
    const owner = await fighter();
    await sql.begin(async tx => {
      await tx`select vault.create_secret('http://127.0.0.1:9/never-sent','game_worker_url')`;
      await tx`select vault.create_secret('dispatch-test-secret-0123456789abcdef','game_worker_secret')`;
      const queued = async () => (await tx`select count(*)::int as n from net.http_request_queue`)[0].n as number;
      const base = await queued();
      expect((await tx`select private.dispatch_workers() as d`)[0].d).toMatchObject({ ok: true, dispatched: 0 });
      await tx`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
        select 'reveal','dispatch:'||n,300,${owner.gid},'{}','v1',0 from generate_series(1,30) n`;
      expect((await tx`select private.dispatch_workers() as d`)[0].d).toMatchObject({ ok: true, dispatched: 2 });
      await tx`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
        select 'reveal','dispatch-more:'||n,300,${owner.gid},'{}','v1',0 from generate_series(1,200) n`;
      expect((await tx`select private.dispatch_workers() as d`)[0].d).toMatchObject({ ok: true, dispatched: 3 });
      expect((await tx`select private.dispatch_workers() as d`)[0].d).toMatchObject({ ok: true, dispatched: 0 });
      expect(await queued() - base).toBe(5);
      const [{ headers }] = await tx`select headers from net.http_request_queue order by id desc limit 1`;
      expect(headers.Authorization === 'Bearer dispatch-test-secret-0123456789abcdef').toBe(true);
      expect(JSON.stringify(await tx`select * from private.dispatch_log`)).not.toContain('dispatch-test-secret');
      await tx`rollback`;
    });
  });

  describe('real game-worker Edge runtime', () => {
    const secret = process.env.LOCAL_WORKER_SECRET ?? '';
    function directWorker(authorization: string | null, method = 'POST') {
      const config = ['url = "http://supabase_edge_runtime_Cloudiator:8081/game-worker"', `request = "${method}"`, 'silent', 'show-error',
        'write-out = "\\n%{http_code}"', ...(authorization ? [`header = ${JSON.stringify(`Authorization: ${authorization}`)}`] : []),
        'header = "Content-Type: application/json"', ...(method === 'POST' ? ['data-binary = "{}"'] : [])].join('\n');
      // The secret travels on stdin, never in arguments or diagnostics.
      const output = execFileSync('docker', ['exec', '-i', 'supabase_db_Cloudiator', 'curl', '--config', '-'], { input: config, encoding: 'utf8' });
      const split = output.lastIndexOf('\n');
      return { status: Number(output.slice(split + 1)), body: output.slice(0, split) };
    }
    async function realTimeWorld() {
      const current = await stableRealSlot();
      await resetWorld(current - 1);
      const owner = await fighter({ firstSlot: current, schedule: TRAINING });
      return { current, owner };
    }
    it('rejects the publishable key and runs a due boundary only with the server secret', async () => {
      expect(secret.length).toBeGreaterThanOrEqual(32);
      const { current, owner } = await realTimeWorld();
      for (const authorization of [null, `Bearer ${process.env.LOCAL_ANON_KEY}`, `Bearer ${secret}x`]) {
        expect(directWorker(authorization)).toMatchObject({ status: 401 });
      }
      expect(directWorker(`Bearer ${secret}`, 'GET').status).toBe(405);
      const gateway = await fetch(`${process.env.LOCAL_API_URL}/functions/v1/game-worker`, { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.LOCAL_ANON_KEY}`, apikey: process.env.LOCAL_ANON_KEY!, 'Content-Type': 'application/json' }, body: '{}' });
      expect(gateway.status).toBe(401);
      expect(await owner.row()).toMatchObject({ processed: current - 1 });
      const response = directWorker(`Bearer ${secret}`);
      expect(response.status).toBe(200);
      expect(response.body).not.toContain(secret);
      expect(JSON.parse(response.body)).toMatchObject({ byKind: { prepare: 1 }, failed: 0 });
      expect(await owner.row()).toMatchObject({ processed: current, stamina: 84 });
      expect((await owner.state()).currentActivity).toMatchObject({ kind: 'training', status: 'active' });
    }, 60_000);
    it('delivers a pg_net dispatch from the database to the real worker', async () => {
      const { current, owner } = await realTimeWorld();
      await sql`select public.coordinate_work()`;
      expect(await sql`select status, wait_reason from private.boundaries where slot_index=${current}`).toEqual([{ status: 'waiting', wait_reason: 'preparation' }]);
      await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
      try {
        await sql`select vault.create_secret('http://supabase_edge_runtime_Cloudiator:8081/game-worker','game_worker_url')`;
        await sql`select vault.create_secret(${secret},'game_worker_secret')`;
        const [{ dispatch }] = await sql`select private.dispatch_workers() as dispatch`;
        expect(dispatch).toMatchObject({ ok: true, dispatched: 1 });
        const id = dispatch.requestIds[0];
        let response: { status_code: number | null; content: string | null } | undefined;
        for (const deadline = Date.now() + 20_000; Date.now() < deadline && !response?.status_code;) {
          [response] = await sql`select status_code, content from net._http_response where id=${id}`;
          if (!response?.status_code) await new Promise(resolve => setTimeout(resolve, 200));
        }
        expect(response?.status_code).toBe(200);
        expect(JSON.parse(response!.content!)).toMatchObject({ byKind: { prepare: 1 } });
        expect(await owner.row()).toMatchObject({ processed: current });
      } finally {
        await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
      }
    }, 60_000);
  });
});
