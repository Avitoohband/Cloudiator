import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransactionSql } from 'postgres';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { anonymous, resetIdentity, sql } from '../fixtures/db.ts';
import { advance, claim, coordinatorLease, fighter, resetWorld, rpc, SLOT, TTR } from '../fixtures/boundary.ts';
import { DEFAULT_EXECUTORS, prepareActivity } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { DungeonId } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { DungeonGroupingInput, DungeonGroupingResult } from '../../supabase/functions/_shared/domain/dungeon-grouping.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { RULES_V2 } from '../../supabase/functions/_shared/domain/rules-v2.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';

const TARGET = 301;
const wolfDen = { kind: 'dungeon', dungeonId: 'wolf-den' } as const;
const rolledBack = new Error('rollback-only fixture');

async function selectRules(tx: TransactionSql, version: 'v1' | 'v2') {
  await tx`update private.rules_versions set active=false where active`;
  expect(await tx`update private.rules_versions set active=true where version=${version} returning version`).toHaveLength(1);
}

beforeEach(() => resetWorld(TARGET - 1));
afterEach(() => sql.begin(tx => selectRules(tx, 'v1')));
afterAll(() => sql.end());

it.each(['edit_schedule', 'edit_day_schedule'] as const)('validates fresh dungeon %s after consulting its receipt', async wrapper => {
  const owner = await fighter({ firstSlot: TARGET });
  const operationId = randomUUID();
  const command = wrapper === 'edit_schedule'
    ? { kind: 'edit-schedule', operationId, expectedVersion: 1, phase: 'afternoon', choice: wolfDen }
    : { kind: 'edit-day-schedule', operationId, expectedVersion: 1, day: { ...TTR, afternoon: wolfDen } };

  await sql.begin(async tx => {
    const now = (TARGET - 1) * SLOT + 1;
    await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker
      set search_path='' as 'select ${now}::bigint'`);
    const save = async (body: Record<string, unknown> & { operationId: string }) => {
      const input = tx.json({ command: body, prepared: null } as never);
      return wrapper === 'edit_schedule'
        ? (await tx`select public.edit_schedule(${owner.id},${body.operationId},${input}) as r`)[0].r
        : (await tx`select public.edit_day_schedule(${owner.id},${body.operationId},${input}) as r`)[0].r;
    };
    await tx`update public.gladiators set level=2 where id=${owner.gid}`;
    await selectRules(tx, 'v2');
    expect(await save({ ...command, operationId: randomUUID() })).toMatchObject({ ok: false, code: 'invalid' });

    await tx`update public.gladiators set level=3 where id=${owner.gid}`;
    for (const [phase, choice] of [
      ['morning', wolfDen], ['evening', wolfDen], ['afternoon', { ...wolfDen, dungeonId: 'dragon-lair' }],
      ['afternoon', { ...wolfDen, extra: true }],
    ] as const) {
      const invalid = wrapper === 'edit_schedule' ? { phase, choice } : { day: { ...TTR, afternoon: wolfDen, [phase]: choice } };
      expect(await save({ ...command, ...invalid, operationId: randomUUID() })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await tx`select version::int as version,schedule from public.schedules where gladiator_id=${owner.gid}`)
      .toEqual([{ version: 1, schedule: TTR }]);
    expect(await tx`select 1 from public.schedule_revisions where gladiator_id=${owner.gid} and version>1`).toHaveLength(0);
    const saved = await save(command);
    expect(saved).toMatchObject({ ok: true, value: { version: 2 } });
    await selectRules(tx, 'v1');
    expect(await save(command)).toEqual(saved);
    const changed = wrapper === 'edit_schedule' ? { choice: { kind: 'rest' } } : { day: TTR };
    expect(await save({ ...command, ...changed })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await save({ ...command, operationId: randomUUID(), expectedVersion: 2 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await tx`select phase,choice,effective_slot_index::int as slot from public.schedule_revisions
      where gladiator_id=${owner.gid} and version>1`).toEqual([{ phase: 'afternoon', choice: wolfDen, slot: TARGET }]);
    throw rolledBack;
  }).catch(error => { if (error !== rolledBack) throw error; });
});

const complete = (job: JobLease, result: unknown) => rpc('complete_job', { job_id: job.id, lease_token: job.token, result });

it.each(['v1', 'v2'] as const)('validates the %s preparation cost shape at a real lease', async version => {
  const owners = [await fighter({ firstSlot: TARGET }), await fighter({ firstSlot: TARGET })];
  await sql.begin(tx => selectRules(tx, version));
  const token = await coordinatorLease();
  expect(await advance(TARGET, token)).toMatchObject({ phase: 4, wait: 'preparation' });
  const jobs = await claim('prepare');
  expect(jobs.map(job => job.gladiatorId).sort()).toEqual(owners.map(owner => owner.gid).sort());
  for (const [index, job] of jobs.entries()) {
    const prep = prepareActivity(job.snapshot as PreparationInput, version === 'v2' ? RULES_V2 : RULES_V1);
    const { dungeon: _newCost, ...legacy } = prep.costs;
    const { arena: _arena, ...missingArena } = legacy;
    const six = { ...legacy, dungeon: 40 };
    for (const costs of [{ ...six, other: 0 }, { ...legacy, other: 0 }, { ...missingArena, dungeon: 40, other: 0 },
      ...[-1, 40.5, 9_007_199_254_740_992, null, '40'].map(dungeon => ({ ...legacy, dungeon }))]) {
      expect(await complete(job, { ...prep, costs })).toMatchObject({ ok: false, code: 'invalid' });
    }
    if (version === 'v1') expect(await complete(job, { ...prep, costs: six })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await complete(job, { ...prep, costs: version === 'v2' && index === 1 ? six : legacy })).toMatchObject({ ok: true });
  }
});

async function dungeonFighter(dungeonId: DungeonId = 'wolf-den', stamina = 100) {
  const owner = await fighter({ firstSlot: TARGET, stamina, schedule: { ...TTR, afternoon: { kind: 'dungeon', dungeonId } } });
  await sql`update public.gladiators set level=${dungeonId === 'troll-hall' ? 12 : dungeonId === 'raider-stronghold' ? 7 : 3}
    where id=${owner.gid}`;
  return owner;
}

it('publishes Rest from a legacy five-cost v2 preparation that requested a dungeon', async () => {
  const owner = await dungeonFighter();
  await sql.begin(tx => selectRules(tx, 'v2'));
  const token = await coordinatorLease();
  expect(await advance(TARGET, token)).toMatchObject({ phase: 4, wait: 'preparation' });
  const [job] = await claim('prepare');
  const prep = prepareActivity(job.snapshot as PreparationInput, RULES_V2);
  const { dungeon: _newCost, ...costs } = prep.costs;
  expect(await complete(job, { ...prep, costs })).toMatchObject({ ok: true });

  expect(await advance(TARGET, token)).toMatchObject({ phase: 9, status: 'complete' });
  expect(await sql`select requested,resolved_kind,stamina_debit::int as debit from public.activities
    where gladiator_id=${owner.gid} and slot_index=${TARGET}`).toEqual([{ requested: wolfDen, resolved_kind: 'rest', debit: 0 }]);
  expect(await sql`select 1 from private.jobs where kind='pair' and slot_index=${TARGET}`).toHaveLength(0);
});

async function reachGrouping(legacyId?: string, decimalCostId?: string) {
  await sql.begin(tx => selectRules(tx, 'v2'));
  const token = await coordinatorLease();
  expect(await advance(TARGET, token)).toMatchObject({ phase: 4, wait: 'preparation' });
  for (const job of await claim('prepare')) {
    const prep = prepareActivity(job.snapshot as PreparationInput, RULES_V2);
    if (job.gladiatorId === decimalCostId) {
      // A raw numeric literal survives JSONB parsing with the spelling accepted by safe-integer validation.
      const [{ r }] = await sql`select public.complete_job(${job.id},${job.token},
        jsonb_set(${sql.json(prep as never)}::jsonb,'{costs,dungeon}','40.0'::jsonb)) as r`;
      expect(r).toMatchObject({ ok: true });
      continue;
    }
    const { dungeon: _newCost, ...legacy } = prep.costs;
    expect(await complete(job, job.gladiatorId === legacyId ? { ...prep, costs: legacy } : prep)).toMatchObject({ ok: true });
  }
  expect(await advance(TARGET, token)).toMatchObject({ phase: 7, status: 'waiting', wait: 'pairing' });
  return { token, jobs: await claim('pair') };
}

const propose = async (job: JobLease) => await DEFAULT_EXECUTORS.v2.pair!(job) as DungeonGroupingResult;

it('groups a dungeon-only afternoon from frozen snapshots and skips both forms of Rest fallback', async () => {
  const wolfA = await dungeonFighter('wolf-den', 40);
  const wolfB = await dungeonFighter();
  const poor = await dungeonFighter('wolf-den', 39);
  const legacy = await dungeonFighter();
  const troll = await dungeonFighter('troll-hall');
  const { token, jobs } = await reachGrouping(legacy.gid, wolfA.gid);
  expect(jobs).toHaveLength(2);
  expect(await sql`select dedupe_key from private.jobs where kind='pair' and slot_index=${TARGET} order by dedupe_key`).toEqual([
    { dedupe_key: `party:${TARGET}:troll-hall` }, { dedupe_key: `party:${TARGET}:wolf-den` },
  ]);

  const frozen = (ids: string[]) => sql`select a.id as "activityId",g.id as "gladiatorId",g.name,
    (s.snapshot->'starting'->>'level')::int as level,s.snapshot->'build' as build from public.activities a
    join private.activity_snapshots s on s.activity_id=a.id join public.gladiators g on g.id=a.gladiator_id
    where a.slot_index=${TARGET} and g.id=any(${ids}::uuid[]) order by g.id`;
  const wolf = jobs.find(job => (job.snapshot as DungeonGroupingInput).dungeonId === 'wolf-den')!;
  expect(wolf).toMatchObject({ rulesVersion: 'v2', gladiatorId: null, activityId: null, snapshot: {
    kind: 'dungeon-grouping', slotIndex: TARGET, dungeonId: 'wolf-den', rulesVersion: 'v2', entrants: [...await frozen([wolfA.gid, wolfB.gid])],
  } });
  expect(await sql`select resolved_kind as kind,stamina_debit::int as debit,requested from public.activities
    where slot_index=${TARGET} and gladiator_id in (${poor.gid},${legacy.gid})`).toEqual([
    { kind: 'rest', debit: 0, requested: wolfDen }, { kind: 'rest', debit: 0, requested: wolfDen },
  ]);

  // Live values can change after the job exists. Both dispatch and acceptance use the frozen version and entrant values.
  await sql`update public.gladiators set level=8,name='Renamed Wolf' where id=${wolfA.gid}`;
  await sql.begin(tx => selectRules(tx, 'v1'));
  for (const job of jobs) {
    const proposal = await propose(job);
    expect(await complete(job, proposal)).toMatchObject({ ok: true });
    expect(await complete(job, proposal)).toMatchObject({ ok: true, replayed: true });
    for (const run of proposal.runs) {
      const seed = createHash('sha256').update(`${job.seed}:${run.runId}`).digest('hex');
      expect(await sql`select seed from private.dungeon_runs where run_id=${run.runId}`).toEqual([{ seed }]);
    }
  }
  const members = await sql`select a.gladiator_id as id from private.dungeon_run_members m join public.activities a on a.id=m.activity_id`;
  expect(members.map(row => row.id).sort()).toEqual([wolfA.gid, wolfB.gid, troll.gid].sort());
  expect(await advance(TARGET, token)).toMatchObject({ phase: 8, wait: 'integration' });
  expect(await sql`select 1 from public.activities where slot_index=${TARGET} and debited`).toHaveLength(0);
  expect(await sql`select 1 from private.jobs where kind in ('simulation','settlement')`).toHaveLength(0);
});

it('validates every run and frozen seat before writing the grouping', async () => {
  for (let index = 0; index < 4; index++) await dungeonFighter();
  const { jobs } = await reachGrouping();
  const [job] = jobs;
  const valid = await propose(job);
  expect(valid.runs).toHaveLength(2);
  const [first, last] = valid.runs;
  const [a, b, hire] = last.seats;
  expect(a.kind).toBe('human');
  expect(b.kind).toBe('human');
  expect(hire.kind).toBe('hireling');
  const seats = (...changed: unknown[]) => ({ runs: [first, { ...last, seats: changed }] });
  const rejected = [
    ['dropped entrant', { runs: [first] }],
    ['repeated entrant', seats(a, { ...a, seat: 1 }, hire)],
    ['changed activity', seats({ ...a, activityId: randomUUID() }, b, hire)],
    ['changed build', seats({ ...a, build: {} }, b, hire)],
    ['changed level', seats({ ...a, level: 4 }, b, hire)],
    ['changed name', seats({ ...a, name: 'Changed' }, b, hire)],
    ['misnumbered run', { runs: [first, { ...last, runId: `dungeon:${TARGET}:wolf-den:3` }] }],
    ['misnumbered late seat', seats(a, b, { ...hire, seat: 1 })],
    ['hireling before human', seats({ ...hire, seat: 0 }, b, { ...a, seat: 2 })],
    ['no human', seats({ ...hire, seat: 0 }, { ...hire, seat: 1 }, hire)],
    ['unknown hireling role', seats(a, b, { ...hire, role: 'archer' })],
    ['extra keys', seats({ ...a, extra: true }, b, hire)],
    ['wrong JSON type', { runs: [first, { ...last, seats: {} }] }],
  ] as const;
  for (const [label, result] of rejected) {
    expect(await complete(job, result), label).toMatchObject({ ok: false, code: 'invalid' });
    expect(await sql`select 1 from private.dungeon_runs`, label).toHaveLength(0);
    expect(await sql`select 1 from private.dungeon_run_members`, label).toHaveLength(0);
  }
  expect(await complete(job, valid)).toMatchObject({ ok: true });
});

it('waits for each dungeon job and preserves its input and seed through operator resume', async () => {
  for (let index = 0; index < 3; index++) await dungeonFighter();
  await dungeonFighter('troll-hall');
  const { jobs, token } = await reachGrouping();
  expect(jobs).toHaveLength(2);
  const wolf = jobs.find(job => (job.snapshot as DungeonGroupingInput).dungeonId === 'wolf-den')!;
  const troll = jobs.find(job => job.id !== wolf.id)!;
  expect((wolf.snapshot as DungeonGroupingInput).entrants).toHaveLength(3);
  expect((troll.snapshot as DungeonGroupingInput).entrants).toHaveLength(1);
  expect(await complete(troll, await propose(troll))).toMatchObject({ ok: true });
  let current = wolf;
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await rpc('fail_job', { job_id: current.id, lease_token: current.token, failure_code: 'execution-failed' }))
      .toMatchObject({ ok: true, status: attempt === 3 ? 'operator' : 'pending' });
    if (attempt === 3) break;
    expect(await advance(TARGET, token)).toMatchObject({ phase: 7, wait: 'pairing' });
    [current] = await claim('pair');
  }
  expect(await advance(TARGET, token)).toMatchObject({ phase: 7, wait: 'operator' });
  await sql`select private.resume_operator_job(${wolf.id})`;
  expect(await advance(TARGET, token)).toMatchObject({ phase: 7, wait: 'pairing' });
  const [resumed] = await claim('pair');
  expect(resumed).toMatchObject({ id: wolf.id, snapshot: wolf.snapshot, seed: wolf.seed, attempt: 4 });
  expect(await complete(resumed, await propose(resumed))).toMatchObject({ ok: true });
  expect(await advance(TARGET, token)).toMatchObject({ phase: 8, wait: 'integration' });
});

it('holds phase 7 when a late dungeon activity has no run member row', async () => {
  await dungeonFighter();
  const { jobs, token } = await reachGrouping();
  const [job] = jobs;
  expect(await complete(job, await propose(job))).toMatchObject({ ok: true });
  const late = await dungeonFighter();
  await sql`insert into public.activities (gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,stamina_debit,status)
    values (${late.gid},${TARGET},${TARGET * SLOT},${(TARGET + 1) * SLOT},${sql.json(wolfDen)},'dungeon',40,'preparing')`;
  await expect(advance(TARGET, token)).rejects.toThrow('ungrouped dungeon entrant');
  expect(await sql`select phase::int as phase from private.boundaries where slot_index=${TARGET}`).toEqual([{ phase: 7 }]);
});

it('keeps grouping data private and immutable and removes it with identity fixture cleanup', async () => {
  const owner = await dungeonFighter();
  const { jobs } = await reachGrouping();
  const [job] = jobs;
  expect(await complete(job, await propose(job))).toMatchObject({ ok: true });
  for (const client of [anonymous, owner.client]) {
    for (const table of ['dungeon_runs', 'dungeon_run_members', 'jobs']) {
      expect((await client.schema('private').from(table).select('*')).error?.code).toBe('PGRST106');
    }
    expect((await client.rpc('claim_jobs', { worker_id: randomUUID(), kind: 'pair', batch_limit: 1 })).error).not.toBeNull();
    expect((await client.rpc('complete_job', { job_id: job.id, lease_token: randomUUID(), result: {} })).error).not.toBeNull();
  }
  const state = await owner.state();
  expect(JSON.stringify(state)).not.toContain(job.seed);
  expect(JSON.stringify(state)).not.toContain('dungeon-grouping');
  await expect(sql`update private.dungeon_runs set seed='changed'`).rejects.toThrow('immutable dungeon_runs');
  await expect(sql`update private.dungeon_run_members set seat=1`).rejects.toThrow('immutable dungeon_run_members');
  await resetIdentity();
  expect(await sql`select 1 from private.dungeon_runs`).toHaveLength(0);
  expect(await sql`select 1 from private.dungeon_run_members`).toHaveLength(0);
});

it('revalidates the grouping lease after waiting on its job lock', async () => {
  await dungeonFighter();
  const { jobs } = await reachGrouping();
  const [job] = jobs;
  const proposal = await propose(job);
  const contender = await sql.reserve();
  const [{ expiry }] = await sql`update private.jobs set lease_until_ms=private.planning_now_ms()+3000
    where id=${job.id} returning lease_until_ms::float8 as expiry`;
  let locked!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const blocker = sql.begin(async tx => {
    await tx`select 1 from private.jobs where id=${job.id} for update`;
    locked();
    await hold;
  });
  let response: PromiseLike<unknown> | undefined;
  try {
    await ready;
    const [{ pid }] = await contender`select pg_backend_pid() as pid`;
    response = contender`select public.complete_job(${job.id},${job.token},${contender.json(proposal as never)}) as r`.execute();
    let seenBlocked = false;
    for (let poll = 0; poll < 100; poll++) {
      const [{ blocked, now }] = await sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked,private.planning_now_ms()::float8 as now`;
      if (blocked) {
        expect(now).toBeLessThan(expiry);
        seenBlocked = true;
        break;
      }
      await delay(10);
    }
    expect(seenBlocked).toBe(true);
    let now = 0;
    for (let poll = 0; poll < 125 && now <= expiry; poll++) {
      now = (await sql`select private.planning_now_ms()::float8 as now`)[0].now;
      if (now <= expiry) await delay(40);
    }
    expect(now).toBeGreaterThan(expiry);
    release();
    await blocker;
    expect(await response).toMatchObject([{ r: { ok: false, code: 'conflict' } }]);
    expect(await sql`select status from private.jobs where id=${job.id}`).toEqual([{ status: 'leased' }]);
    expect(await sql`select 1 from private.dungeon_runs`).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled([blocker, response]);
    contender.release();
  }
});
