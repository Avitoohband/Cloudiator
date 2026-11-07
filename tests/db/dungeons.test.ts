import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransactionSql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anonymous, resetIdentity, sql } from '../fixtures/db.ts';
import { advance, claim, coordinatorLease, fighter, historicalPort, resetWorld, rpc, SLOT, TTR } from '../fixtures/boundary.ts';
import { DEFAULT_EXECUTORS, prepareActivity, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { DungeonId } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { DungeonGroupingInput, DungeonGroupingResult } from '../../supabase/functions/_shared/domain/dungeon-grouping.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { RULES_V2 } from '../../supabase/functions/_shared/domain/rules-v2.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';

import { partyInput } from '../fixtures/dungeon-builds.ts';
import { planDungeonRun, type DungeonRunInput, type DungeonRunPlan } from '../../supabase/functions/_shared/domain/dungeon.ts';
import type { PartyBattleLog } from '../../supabase/functions/_shared/contracts/events.ts';

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
  expect(await advance(TARGET, token)).toMatchObject({ phase: 9, status: 'complete' });
  expect(await sql`select 1 from public.activities where slot_index=${TARGET} and debited`).toHaveLength(5);
  expect(await sql`select 1 from private.jobs where kind='simulation' and slot_index=${TARGET}`).toHaveLength(2);
  expect(await sql`select 1 from private.jobs where kind='settlement' and slot_index=${TARGET}`).toHaveLength(5);
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
  expect(await advance(TARGET, token)).toMatchObject({ phase: 9, status: 'complete' });
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

async function groupedDungeon() {
  const owners = [await dungeonFighter(), await dungeonFighter()];
  const { jobs, token } = await reachGrouping();
  expect(jobs).toHaveLength(1);
  const grouped = await propose(jobs[0]);
  expect(grouped.runs).toHaveLength(1);
  expect(await complete(jobs[0], grouped)).toMatchObject({ ok: true });
  return { owners, token, runId: grouped.runs[0].runId };
}

async function leasedDungeon() {
  const grouped = await groupedDungeon();
  expect(await advance(TARGET, grouped.token)).toMatchObject({ phase: 9, status: 'complete' });
  const sims = await claim('simulation');
  expect(sims).toHaveLength(1);
  const [sim] = sims;
  const plan = planDungeonRun(sim.snapshot as DungeonRunInput, sim.seed, RULES_V2);
  return { ...grouped, sim, plan };
}

const sampledTrollFight = () => planDungeonRun(partyInput('troll-hall', [
  { classId: 'berserker', level: 12 }, { classId: 'guardian', level: 12 }, { classId: 'duelist', level: 12 },
], 'dungeon:1:troll-hall:1'), 'balance:troll-hall:full:254', RULES_V2).fights[3];

async function sanitizedLog(value: unknown) {
  return (await sql`select log,octet_length(log::text)::int as bytes
    from (select private.safe_party_log(${sql.json(value as never)}::jsonb) as log) sanitized`)[0];
}

// Every released fighter attacks at the shortest interval through the inclusive cutoff. A major hits all three
// opponents on every fourth attack. Use long IDs and safe integer fields to stress PostgreSQL's JSON serialization.
function fullLengthLog(major: boolean): PartyBattleLog {
  const reference = sampledTrollFight().log.participants[0];
  const party = Array.from({ length: 3 }, (_, seat) => ({
    ...reference, id: `f${seat}-`.padEnd(36, 'a'), gladiatorId: `f${seat}-`.padEnd(36, 'a'), side: 0 as const,
    role: 'gladiator' as const, seat, maxHealth: Number.MAX_SAFE_INTEGER, initialHealth: Number.MAX_SAFE_INTEGER,
    attackIntervalMs: 250,
  }));
  const foes = Array.from({ length: major ? 1 : 3 }, (_, index) => ({
    ...reference, id: `creature:long-monster-identifier-${index}:4:1`, gladiatorId: null, side: 1 as const,
    role: major ? 'major' as const : 'monster' as const, seat: null, maxHealth: Number.MAX_SAFE_INTEGER,
    initialHealth: Number.MAX_SAFE_INTEGER, attackIntervalMs: 250,
  }));
  const participants = [...party, ...foes];
  const events: PartyBattleLog['events'][number][] = [];
  for (let turn = 1; turn <= 480; turn++) {
    for (const unit of participants) {
      const sweep = unit.role === 'major' && turn % 4 === 0;
      const targets = sweep ? party : unit.side === 0 ? [foes[0]] : [party[0]];
      for (const target of targets) events.push({
        kind: 'attack', sequence: events.length, elapsedMs: turn * 250, attackerId: unit.id, defenderId: target.id,
        hit: false, critical: false, defend: false, evade: true, damage: 0, healthBefore: Number.MAX_SAFE_INTEGER,
        healthAfter: Number.MAX_SAFE_INTEGER, sweep,
      });
    }
  }
  events.push({ kind: 'victory', sequence: events.length, elapsedMs: 120_000, winnerSide: 0, reason: 'tie-break' });
  return { battleId: 'dungeon:301:troll-hall:1:fight:4', rulesVersion: 'v2', durationMs: 120_000,
    participants, events, finalHp: participants.map(p => p.initialHealth),
    winnerSide: 0, victoryReason: 'tie-break', tieBreakReason: 'equal-health-fraction' };
}

describe('dungeon runs', () => {
  it('starts one seat-0 run and reveals its stages once before releasing both settlements', async () => {
    await dungeonFighter();
    await dungeonFighter();
    const { jobs, token } = await reachGrouping();
    expect(jobs).toHaveLength(1);
    const grouped = await propose(jobs[0]);
    expect(grouped.runs).toHaveLength(1);
    const { runId, seats } = grouped.runs[0];
    const anchor = seats[0];
    if (anchor.kind !== 'human') throw new Error('Expected a human seat 0');
    const memberIds = seats.flatMap(seat => seat.kind === 'human' ? [seat.activityId] : []).sort();
    expect(memberIds).toHaveLength(2);
    const startsAtMs = TARGET * SLOT;
    const endsAtMs = startsAtMs + SLOT;
    const runSeed = createHash('sha256').update(`${jobs[0].seed}:${runId}`).digest('hex');
    expect(await complete(jobs[0], grouped)).toMatchObject({ ok: true });

    expect(await advance(TARGET, token)).toMatchObject({ phase: 9, status: 'complete' });
    expect(await advance(TARGET, token)).toMatchObject({ phase: 9, status: 'complete', replayed: true });
    const sims = await claim('simulation');
    expect(sims).toHaveLength(1);
    const [sim] = sims;
    expect(sim).toMatchObject({ activityId: anchor.activityId, gladiatorId: anchor.gladiatorId,
      slotIndex: TARGET, rulesVersion: 'v2', seed: runSeed });
    expect(sim.snapshot).toEqual({ kind: 'dungeon', runId, slotIndex: TARGET, rulesVersion: 'v2',
      dungeonId: 'wolf-den', startsAtMs, seats });
    expect(await sql`select dedupe_key,due_at_ms::float8 as due from private.jobs where id=${sim.id}`)
      .toEqual([{ dedupe_key: `dungeon:${runId}`, due: startsAtMs }]);
    const settlements = await sql`select id,activity_id,due_at_ms::float8 as due from private.jobs
      where kind='settlement' and slot_index=${TARGET} order by activity_id`;
    expect(settlements.map(row => [row.activity_id, row.due])).toEqual(memberIds.map(id => [id, endsAtMs]));
    const prerequisites = async (jobId: string) => (await sql`select prerequisite_id from private.job_dependencies
      where job_id=${jobId} order by prerequisite_id`).map(row => row.prerequisite_id);
    for (const settlement of settlements) expect(await prerequisites(settlement.id)).toEqual([sim.id]);
    expect(await claim('settlement')).toEqual([]);

    const plan = await DEFAULT_EXECUTORS.v2.simulation!(sim) as DungeonRunPlan;
    const dirty = { ...plan, privateDebug: 'private', stages: plan.stages.map(stage => ({
      ...stage, privateDebug: 'private', battleLog: { privateDebug: 'private' },
      ...(stage.fight ? { fight: { ...stage.fight, privateDebug: 'private' } } : {}),
    })), fights: plan.fights.map(fight => ({ ...fight, log: { ...fight.log, privateDebug: 'private',
      participants: fight.log.participants.map(p => ({ ...p, privateDebug: 'private', attributes: { ...p.attributes, privateDebug: 'private' } })),
      events: fight.log.events.map(event => ({ ...event, privateDebug: 'private' })),
    } })) };
    expect(await complete(sim, dirty)).toMatchObject({ ok: true });
    expect(await complete(sim, plan)).toMatchObject({ ok: true, replayed: true });
    expect(await sql`select run_id,simulation_job_id,plan from private.dungeon_results where run_id=${runId}`)
      .toEqual([{ run_id: runId, simulation_job_id: sim.id, plan: dirty }]);
    expect(await sql`select 1 from public.activity_stages where activity_id in ${sql(memberIds)}`).toHaveLength(0);
    expect(await sql`select 1 from public.dungeon_fights where run_id=${runId}`).toHaveLength(0);

    const [{ seed: anchorSeed }] = await sql`select seed from private.activity_snapshots where activity_id=${anchor.activityId}`;
    const reveals = await sql`select id,dedupe_key,activity_id,gladiator_id,input,seed,due_at_ms::float8 as due
      from private.jobs where kind='reveal' and slot_index=${TARGET} order by (input->>'ordinal')::int`;
    expect(reveals.map(({ id: _id, ...row }) => row)).toEqual(plan.stages.map((stage, ordinal) => ({
      dedupe_key: `dungeon-reveal:${runId}:${ordinal}`, activity_id: anchor.activityId, gladiator_id: anchor.gladiatorId,
      input: { kind: 'dungeon-reveal', runId, ordinal }, seed: anchorSeed, due: stage.revealedAtMs,
    })));
    for (const [index, reveal] of reveals.entries()) {
      expect(await prerequisites(reveal.id)).toEqual([index === 0 ? sim.id : reveals[index - 1].id]);
    }
    const final = reveals[reveals.length - 1];
    expect(final.due).toBe(endsAtMs);
    for (const settlement of settlements) expect(await prerequisites(settlement.id)).toEqual([sim.id, final.id].sort());

    // These historical jobs are all due. Only the earliest ready reveal can be leased.
    for (const reveal of reveals.slice(0, -2)) {
      const leases = await claim('reveal');
      expect(leases.map(job => job.id)).toEqual([reveal.id]);
      expect(await complete(leases[0], {})).toMatchObject({ ok: true });
    }
    const penultimate = await claim('reveal');
    expect(penultimate.map(job => job.id)).toEqual([reveals[reveals.length - 2].id]);
    expect(await claim('reveal')).toEqual([]);
    expect(await claim('settlement')).toEqual([]);
    expect(await complete(penultimate[0], {})).toMatchObject({ ok: true });
    expect(await claim('settlement', 1)).toEqual([]);
    await sql.begin(async tx => {
      const [{ leases }] = await tx`select public.claim_jobs(${randomUUID()},'settlement',2) as leases`;
      expect(leases.map((job: JobLease) => [job.kind, job.id])).toEqual([
        ['reveal', final.id], ['settlement', settlements.map(row => row.id).sort()[0]],
      ]);
      throw rolledBack;
    }).catch(error => { if (error !== rolledBack) throw error; });
    const released = await claim('settlement', 3);
    expect(released.map(job => [job.kind, job.id])).toEqual([
      ['reveal', final.id], ...settlements.map(row => row.id).sort().map(id => ['settlement', id]),
    ]);
    const readiness = async () => (await sql`select private.dependencies_ready(j.id) as ready
      from private.jobs j where j.kind='settlement' and j.slot_index=${TARGET}`).map(row => row.ready);
    expect(await readiness()).toEqual([false, false]);
    expect(await complete(released[0], {})).toMatchObject({ ok: true });
    await sql.begin(async tx => {
      await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker
        set search_path='' as 'select ${released[0].expiresAtMs + 1}::bigint'`);
      const [{ r }] = await tx`select public.complete_job(${released[0].id},${released[0].token},'{}') as r`;
      expect(r).toMatchObject({ ok: true, replayed: true });
      throw rolledBack;
    }).catch(error => { if (error !== rolledBack) throw error; });
    expect(await readiness()).toEqual([true, true]);

    expect(await sql`select activity_id,ordinal::int as ordinal,reveal_at_ms::float8 as due,stage
      from public.activity_stages where activity_id in ${sql(memberIds)} order by activity_id,ordinal`)
      .toEqual(memberIds.flatMap(activityId => plan.stages.map((stage, ordinal) => ({
        activity_id: activityId, ordinal, due: stage.revealedAtMs, stage: { ...stage, id: `${activityId}:${ordinal}` },
      }))));
    expect(await sql`select ordinal::int as ordinal,reveal_at_ms::float8 as due,log
      from public.dungeon_fights where run_id=${runId} order by ordinal`)
      .toEqual(plan.fights.map(fight => ({ ordinal: fight.ordinal, due: startsAtMs + fight.offsetMs, log: fight.log })));
  });

  it('whitelists the longest sampled Troll Hall fight under 100 KB of PostgreSQL JSON', async () => {
    const fight = sampledTrollFight();
    expect(fight).toMatchObject({ ordinal: 4, log: { durationMs: 68_544 } });
    const dirty = { ...fight.log, debug: 'private',
      participants: fight.log.participants.map((p, index) => index === 0
        ? { ...p, debug: 'private', attributes: { ...p.attributes, debug: 'private' } } : p),
      events: fight.log.events.map((event, index) => index === 0 ? { ...event, debug: 'private' } : event),
    };
    const { log, bytes } = await sanitizedLog(dirty);
    expect(log).toEqual(fight.log);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(100_000);
  });

  it.each([[false, 2881], [true, 2161]] as const)('admits the released maximum event envelope (major=%s, events=%i)', async (major, events) => {
    const stress = fullLengthLog(major);
    expect(stress.events).toHaveLength(events);
    const { log, bytes } = await sanitizedLog(stress);
    expect(log).toEqual(stress);
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBeLessThan(4_000_000);
  });

  it('rejects over-limit and malformed party logs before exposure', async () => {
    const sample = sampledTrollFight().log;
    expect(await sanitizedLog(sample)).toMatchObject({ log: sample });
    const attack = sample.events[0];
    const victory = sample.events.at(-1)!;
    if (attack.kind !== 'attack' || victory.kind !== 'victory') throw new Error('Expected sample attacks and victory');
    const padded = (count: number) => ({ ...sample, events: [
      ...Array.from({ length: count - 1 }, (_, sequence) => ({ ...attack, sequence })),
      { ...victory, sequence: count - 1 },
    ] });
    const maximum = await sanitizedLog(padded(9361));
    expect(maximum.log.events).toHaveLength(9361);
    const excessive = padded(9362);
    const [{ bytes: excessBytes }] = await sql`select octet_length(${sql.json(excessive as never)}::jsonb::text)::int as bytes`;
    expect(excessBytes).toBeLessThan(4_000_000);
    for (const [label, invalid] of [
      ['raw byte limit', { ...sample, extra: 'x'.repeat(4_000_001) }],
      ['event count limit', excessive],
      ['fight time cap', { ...sample, durationMs: 120_001, events: [...sample.events.slice(0, -1), { ...victory, elapsedMs: 120_001 }] }],
      ['final HP length', { ...sample, finalHp: [] }],
      ['wrong side', { ...sample, participants: [{ ...sample.participants[0], side: '0' }, ...sample.participants.slice(1)] }],
      ['missing sweep', { ...sample, events: [{ ...attack, sweep: undefined }, ...sample.events.slice(1)] }],
      ['not terminal', { ...sample, events: [...sample.events, attack] }],
      ['unknown target', { ...sample, events: [{ ...attack, defenderId: 'absent' }, ...sample.events.slice(1)] }],
    ] as const) {
      await expect(sanitizedLog(invalid), label).rejects.toThrow('invalid party log');
    }
  });

  it('rejects invalid run identities, membership, rewards and stage timing without consuming the lease', async () => {
    const { sim, plan } = await leasedDungeon();
    const [member, late] = plan.outcomes;
    expect(late).toBeDefined();
    const outcomes = (...changed: unknown[]) => ({ ...plan, outcomes: [member, ...changed] });
    const lateOutcome = (changed: Partial<typeof late>) => outcomes({ ...late, ...changed });
    const rewards = (changed: Partial<typeof late.rewards>) => lateOutcome({ rewards: { ...late.rewards, ...changed } });
    const final = plan.stages.at(-1)!;
    const bad = [
      ['run', { ...plan, runId: plan.runId + '-wrong' }],
      ['dungeon', { ...plan, dungeonId: 'troll-hall' }],
      ['rules', { ...plan, rulesVersion: 'v1' }],
      ['catalog', { ...plan, catalogVersion: 'v2' }],
      ['missing', outcomes()],
      ['duplicate', outcomes(member)],
      ['extra', outcomes(late, { ...late, activityId: randomUUID(), gladiatorId: randomUUID() })],
      ['hired', lateOutcome({ gladiatorId: 'hired:2' })],
      ['paired identity', lateOutcome({ gladiatorId: member.gladiatorId })],
      ['unsafe xp', rewards({ xp: Number.MAX_SAFE_INTEGER + 1 })],
      ['negative money', rewards({ money: -1 })],
      ['bad loot', rewards({ loot: [{ catalogId: 'salvage', catalogVersion: 'v1', quantity: 0, origin: 'expedition' }] })],
      ['invalid entered', lateOutcome({ entered: [5] })],
      ['victory without success', lateOutcome({ result: 'victory', success: false })],
      ['outside slot', { ...plan, stages: [...plan.stages.slice(0, -1), { ...final, endsAtMs: final.endsAtMs + 1 }] }],
      ['out of order', { ...plan, stages: [plan.stages[1], plan.stages[0], ...plan.stages.slice(2)] }],
      ['bad fight ref', { ...plan, stages: plan.stages.map(stage => stage.fight ? { ...stage, fight: { ...stage.fight, ordinal: 4 } } : stage) }],
      ['late log error', { ...plan, fights: plan.fights.map((fight, i) => i === plan.fights.length - 1
        ? { ...fight, log: { ...fight.log, finalHp: [] } } : fight) }],
    ] as const;
    for (const [label, result] of bad) {
      expect(await complete(sim, result), label).toMatchObject({ ok: false, code: 'invalid' });
      const [state] = await sql`select (select count(*)::int from private.dungeon_results) as plans,
        (select count(*)::int from private.jobs where kind='reveal') as reveals,
        (select count(*)::int from public.activity_stages) as stages,
        (select count(*)::int from public.dungeon_fights) as fights,
        (select count(*)::int from private.job_attempts where job_id=${sim.id} and outcome is not null) as finished`;
      expect(state, label).toEqual({ plans: 0, reveals: 0, stages: 0, fights: 0, finished: 0 });
    }
    expect(await complete(sim, plan)).toMatchObject({ ok: true });
    await expect(sql`update private.dungeon_results set plan='{}'`).rejects.toThrow('immutable dungeon_results');
  });

  it('shows due fights to visitors and players while keeping frozen plans, runs and seeds private', async () => {
    const { owners, token, runId } = await groupedDungeon();
    const fight = sampledTrollFight().log;
    await sql`insert into public.dungeon_fights(run_id,ordinal,reveal_at_ms,log)
      values(${runId},4,private.planning_now_ms()+300000,${sql.json(fight as never)})`;
    for (const client of [anonymous, ...owners.map(owner => owner.client)]) {
      const response = await client.from('dungeon_fights').select('*').eq('run_id', runId).eq('ordinal', 4);
      expect(response.error).toBeNull();
      expect(response.data).toEqual([]);
      for (const relation of ['dungeon_runs', 'dungeon_run_members', 'dungeon_results', 'jobs']) {
        expect((await client.schema('private').from(relation).select('*')).error?.code).toBe('PGRST106');
      }
    }
    // Move only the operator's fixture across the actual RLS cutoff; do not substitute the database clock.
    const due = TARGET * SLOT;
    await sql`update public.dungeon_fights set reveal_at_ms=${due} where run_id=${runId} and ordinal=4`;
    for (const client of [anonymous, ...owners.map(owner => owner.client)]) {
      const response = await client.from('dungeon_fights').select('*').eq('run_id', runId);
      expect(response.error).toBeNull();
      expect(response.data).toEqual([{ run_id: runId, ordinal: 4, reveal_at_ms: due, log: fight }]);
    }
    await sql`delete from public.dungeon_fights where run_id=${runId}`;
    expect(await advance(TARGET, token)).toMatchObject({ phase: 9, status: 'complete' });
    const database = historicalPort(TARGET, token);
    const worker = await runWorker({ database, workerId: randomUUID() });
    expect(worker.byKind.simulation).toBe(1);
    const [{ plan, seed }] = await sql`select d.plan,j.seed from private.dungeon_results d
      join private.jobs j on j.id=d.simulation_job_id where d.run_id=${runId}`;
    expect(plan).toMatchObject({ runId, rulesVersion: 'v2' });
    for (const owner of owners) expect(JSON.stringify(await owner.state())).not.toContain(seed);
  });

  it('takes every member account lock before anchoring the run to seat 0', async () => {
    const x = await dungeonFighter(), y = await dungeonFighter();
    const [low, high] = x.gid < y.gid ? [x, y] : [y, x];
    await sql`update public.builds set current_build=jsonb_set(current_build,'{allocations,strength}','3')
      where gladiator_id=${high.gid}`;
    await sql`update public.gladiators set earned_points=11 where id=${high.gid}`;
    const { token, jobs } = await reachGrouping();
    const grouping = await propose(jobs[0]);
    expect(grouping.runs.map(run => run.seats.slice(0, 2))).toEqual([[
      expect.objectContaining({ gladiatorId: high.gid }), expect.objectContaining({ gladiatorId: low.gid }),
    ]]);
    expect(await complete(jobs[0], grouping)).toMatchObject({ ok: true });
    const contender = await sql.reserve();
    let locked!: (pid: number) => void, release!: () => void;
    const ready = new Promise<number>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const command = sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${high.id}::text,0))`;
      locked((await tx`select pg_backend_pid() as pid`)[0].pid);
      await hold;
      await tx`set local lock_timeout='3s'`;
      return (await tx`select 1 from public.gladiators where id=${high.gid} for update`).length;
    });
    let pending: PromiseLike<unknown> | undefined;
    try {
      const blocker = await ready;
      const [{ pid }] = await contender`select pg_backend_pid() as pid`;
      pending = contender`select public.advance_boundary(${TARGET},${token}) as r`.execute();
      void Promise.resolve(pending).catch(() => undefined);
      let waiting = false;
      for (let poll = 0; poll < 200 && !waiting; poll++) {
        waiting = (await sql`select ${blocker}::int = any(pg_blocking_pids(${pid})) as waiting`)[0].waiting;
        if (!waiting) await delay(10);
      }
      expect(waiting).toBe(true);
      release();
      expect(await command).toBe(1);
      expect(await pending).toMatchObject([{ r: { phase: 9, status: 'complete' } }]);
      expect(await sql`select gladiator_id from private.jobs where kind='simulation'`).toEqual([{ gladiator_id: high.gid }]);
    } finally {
      release();
      await Promise.allSettled([command, pending]);
      contender.release();
    }
  });

  it('rejects a pre-due reveal and revalidates its lease after a proven job lock wait', async () => {
    const { sim, plan } = await leasedDungeon();
    expect(await complete(sim, plan)).toMatchObject({ ok: true });
    const [depart] = await claim('reveal');
    expect(await complete(depart, {})).toMatchObject({ ok: true });
    const [fight] = await claim('reveal');
    const due = plan.stages[1].revealedAtMs;
    await sql`update private.jobs set due_at_ms=private.planning_now_ms()+300000 where id=${fight.id}`;
    expect(await complete(fight, {})).toMatchObject({ ok: false, code: 'processing' });
    const [{ expiry }] = await sql`update private.jobs set due_at_ms=${due},lease_until_ms=private.planning_now_ms()+3000
      where id=${fight.id} returning lease_until_ms::float8 as expiry`;
    const contender = await sql.reserve();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const blocker = sql.begin(async tx => {
      await tx`select 1 from private.jobs where id=${fight.id} for update`;
      locked();
      await hold;
    });
    let pending: PromiseLike<unknown> | undefined;
    try {
      await ready;
      const [{ pid }] = await contender`select pg_backend_pid() as pid`;
      pending = contender`select public.complete_job(${fight.id},${fight.token},'{}') as r`.execute();
      void Promise.resolve(pending).catch(() => undefined);
      let seen = false;
      for (let poll = 0; poll < 100 && !seen; poll++) {
        const [{ blocked, now }] = await sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked,
          private.planning_now_ms()::float8 as now`;
        if (blocked) { expect(now).toBeLessThan(expiry); seen = true; }
        else await delay(10);
      }
      expect(seen).toBe(true);
      let now = 0;
      for (let poll = 0; poll < 125 && now <= expiry; poll++) {
        now = (await sql`select private.planning_now_ms()::float8 as now`)[0].now;
        if (now <= expiry) await delay(40);
      }
      expect(now).toBeGreaterThan(expiry);
      release();
      await blocker;
      expect(await pending).toMatchObject([{ r: { ok: false, code: 'conflict' } }]);
      expect(await sql`select j.status,j.completed_at_ms,a.outcome,a.finished_at_ms from private.jobs j
        join private.job_attempts a on a.job_id=j.id where j.id=${fight.id}`)
        .toEqual([{ status: 'leased', completed_at_ms: null, outcome: null, finished_at_ms: null }]);
      expect(await sql`select 1 from public.activity_stages where ordinal=1`).toHaveLength(0);
      expect(await sql`select 1 from public.dungeon_fights`).toHaveLength(0);
      const [reclaimed] = await claim('reveal');
      expect(reclaimed).toMatchObject({ id: fight.id, attempt: 2 });
      expect(await complete(reclaimed, {})).toMatchObject({ ok: true });
      expect(await sql`select 1 from public.activity_stages where ordinal=1`).toHaveLength(2);
      expect(await sql`select 1 from public.dungeon_fights where ordinal=1`).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([blocker, pending]);
      contender.release();
    }
  });
});
