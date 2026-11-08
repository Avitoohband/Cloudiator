import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransactionSql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { account, admin, anonymous, resetIdentity, sql } from '../fixtures/db.ts';
import { advance, claim, coordinatorLease, fighter, historicalPort, resetWorld, rpc, SLOT, TTR, type Choices } from '../fixtures/boundary.ts';
import { DEFAULT_EXECUTORS, prepareActivity, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { DungeonId } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { DungeonGroupingInput, DungeonGroupingResult } from '../../supabase/functions/_shared/domain/dungeon-grouping.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { RULES_V2 } from '../../supabase/functions/_shared/domain/rules-v2.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';

import { partyInput } from '../fixtures/dungeon-builds.ts';
import { planDungeonRun, type DungeonRunInput, type DungeonRunPlan } from '../../supabase/functions/_shared/domain/dungeon.ts';
import type { ActivitySummary, PartyBattleLog } from '../../supabase/functions/_shared/contracts/events.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { createWorkerDatabase, prepareGrant } from '../../supabase/functions/_shared/backend/database.ts';
import { applyXp } from '../../supabase/functions/_shared/domain/inventory.ts';

const TARGET = 301;
const wolfDen = { kind: 'dungeon', dungeonId: 'wolf-den' } as const;
const rolledBack = new Error('rollback-only fixture');

async function selectRules(tx: TransactionSql, version: 'v1' | 'v2') {
  await tx`update private.rules_versions set active=false where active`;
  expect(await tx`update private.rules_versions set active=true where version=${version} returning version`).toHaveLength(1);
}

beforeEach(() => resetWorld(TARGET - 1));
afterEach(() => sql.begin(tx => selectRules(tx, 'v1')));
afterAll(async () => { await resetIdentity(); await sql.end(); });

it('ships M30 completed from 24-dungeons.sql: functions before the CHECKs and triggers that call them, revokes before grants, the source bodies, ACLs, RLS and policies, the invoker view and the reload last', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const all = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const files = all.filter(name => /^\d{14}_patch_1_8\.sql$/.test(name));
  expect(files, 'M30 generated migration').toHaveLength(1);
  expect(all.slice(27, 30)).toEqual(['20261106064426_patch_1_7.sql', '20261106200416_patch_1_7_1.sql', files[0]]);
  const migration = readFileSync(new URL(files[0], dir), 'utf8');
  const source = readFileSync(new URL('../../supabase/sql/24-dungeons.sql', import.meta.url), 'utf8');
  expect(migration).not.toMatch(/\r|^\uFEFF|pg-delta:\s*transaction\s*=\s*false|supabase:transaction-mode/i);
  const header = migration.split(/\n(?!--)/, 1)[0];
  expect(header).toContain('Supabase CLI 2.120.0');
  expect(header).toContain('npx.cmd --offline --no-install supabase db pull patch_1_8 --local --schema public,private --diff-engine pg-delta --yes');
  expect(header).toContain('supabase/sql/24-dungeons.sql on M01–M29');

  // The source and generated artifact use ordinary SQL strings and dollar-quoted routines.
  // Separate top-level statements without splitting comments, strings, or stored function bodies.
  const statements = (sql: string) => {
    const tokens = /\$(\w*)\$[^]*?\$\1\$|'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[^]*?\*\/|;/g;
    const result: string[] = [];
    let start = 0;
    let statement = '';
    for (const match of sql.matchAll(tokens)) {
      statement += sql.slice(start, match.index);
      start = match.index + match[0].length;
      if (match[0] === ';') { result.push(statement.trim()); statement = ''; }
      else if (!/^--|^\/\*/.test(match[0])) statement += match[0];
      else statement += ' ';
    }
    expect((statement + sql.slice(start)).trim(), 'unterminated SQL').toBe('');
    return result;
  };
  const from = statements(source);
  const shipped = statements(migration);
  expect(from.shift()).toBe('begin');
  expect(from.pop()).toBe('commit');
  expect(shipped.shift()?.toLowerCase()).toBe('set local check_function_bodies = off');
  expect(shipped.at(-1)).toMatch(/^notify pgrst,\s*'reload schema'$/i);

  const routine = (statement: string) => {
    if (!/^create or replace function\s/i.test(statement)) return null;
    const match = /^(create or replace function\s+[^]*?)\s+as\s+\$(\w*)\$([^]*)\$\2\$$/i.exec(statement);
    expect(match, statement.slice(0, 100)).not.toBeNull();
    const [, declaration, , body] = match!;
    const signature = declaration.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1')
      .replace(/ security invoker\b/, '').replace(/set search_path\s*(?:=|to)\s*/, 'set search_path=');
    return { signature, body };
  };
  const shape = (statement: string) => routine(statement) ?? statement;
  // Replaying the source order preserves CHECK/trigger dependencies, revoke-then-grant semantics,
  // the routine initializer, invoker view and final reload. Only routine formatting may differ.
  expect(shipped.map(shape)).toEqual(from.map(shape));
});

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

async function dungeonFighter(dungeonId: DungeonId = 'wolf-den', stamina = 100, firstSlot = TARGET, otherSlots: Choices = TTR) {
  const owner = await fighter({ firstSlot, stamina, schedule: { ...otherSlots, afternoon: { kind: 'dungeon', dungeonId } } });
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

async function reachGrouping(legacyId?: string, decimalCostId?: string, beforeSnapshot?: () => Promise<unknown>) {
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
  await beforeSnapshot?.();
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
      expect(leases.length).toBe(0);
      const [{ reveals: fallback }] = await tx`select public.claim_jobs(${randomUUID()},'reveal',1) as reveals`;
      expect(fallback.map((job: JobLease) => job.id)).toEqual([final.id]);
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

const workerDatabase = createWorkerDatabase(admin);
const slotEnd = (TARGET + 1) * SLOT;
const clearTitles = ['den-breaker', 'warlords-end', 'kingslayer', 'dungeoneer'];

async function strengthen(owner: Awaited<ReturnType<typeof dungeonFighter>>) {
  const allocation = { strength: 200, vitality: 100, endurance: 10, agility: 15, precision: 25 };
  await sql`update public.gladiators set earned_points=350 where id=${owner.gid}`;
  await sql`update public.builds set current_build=jsonb_set(current_build,'{allocations}',${sql.json(allocation)})
    where gladiator_id=${owner.gid}`;
}

async function settlementRun(dungeonId: DungeonId = 'wolf-den', overLevel = false) {
  const owners = [await dungeonFighter(dungeonId), await dungeonFighter(dungeonId)];
  for (const owner of owners) await strengthen(owner);
  if (overLevel) await sql`update public.gladiators set level=8 where id=${owners[0].gid}`;
  const { jobs, token } = await reachGrouping(undefined, undefined, overLevel
    ? () => sql`update public.gladiators set level=9 where id=${owners[0].gid}` : undefined);
  expect(await complete(jobs[0], await propose(jobs[0]))).toMatchObject({ ok: true });
  expect(await advance(TARGET, token)).toMatchObject({ phase: 9, status: 'complete' });
  const [sim] = await claim('simulation');
  const input = sim.snapshot as DungeonRunInput;
  const plan = planDungeonRun(input, 'settlement-strong-party', RULES_V2);
  expect(plan.fights.map(fight => fight.won)).toEqual([true, true, true, true]);
  return { owners, sim, input, plan };
}

// Use accepted fixture logs to separate a member's terminal pay from the party's result. The real Edge test below uses
// the unmodified executor, and the over-level test uses the plan built from the actual frozen preparation.
function wolfOutcome(plan: DungeonRunPlan, terminal: 1 | 3 | 4, partyWon: boolean, fallen?: string): DungeonRunPlan {
  const allDown = terminal === 1 && partyWon;
  const fights = plan.fights.slice(0, terminal).map((fight, i) => {
    const keep = (id: string) => i === 0 || id !== fallen;
    const won = i === terminal - 1 ? partyWon : true;
    const winnerSide = won ? 0 as const : 1 as const;
    const victoryReason = allDown ? 'tie-break' as const : 'defeat' as const;
    const participants = fight.log.participants.filter(p => keep(p.id));
    const finalHp = fight.log.participants.flatMap((p, index) => !keep(p.id) ? []
      : [p.id === fallen || (allDown && p.side === 0) || p.side !== winnerSide ? 0 : fight.log.finalHp[index]]);
    const events = fight.log.events.filter(e => e.kind === 'victory' || (keep(e.attackerId) && keep(e.defenderId)))
      .map((e, sequence) => e.kind === 'victory' ? { ...e, sequence, winnerSide, reason: victoryReason } : { ...e, sequence });
    return { ...fight, won, log: { ...fight.log, participants, events, finalHp, winnerSide, victoryReason,
      tieBreakReason: allDown ? 'simultaneous-defeat' as const : null } };
  });
  const lastFightIndex = plan.stages.findIndex(stage => stage.fight?.ordinal === terminal);
  const stages = [...plan.stages.slice(0, lastFightIndex + 1)];
  const lastStage = stages.at(-1)!;
  stages.push({ id: `${plan.runId}:${stages.length}`, kind: terminal === 4 && partyWon ? 'travel' : 'return',
    revealedAtMs: lastStage.endsAtMs, startedAtMs: lastStage.endsAtMs, endsAtMs: slotEnd, label: 'Safe return to camp' });
  stages.push({ ...plan.stages.at(-1)!, id: `${plan.runId}:${stages.length}` });
  const outcomes = plan.outcomes.map((outcome): DungeonRunPlan['outcomes'][number] => {
    const entered = outcome.gladiatorId === fallen ? [1] : fights.map(fight => fight.ordinal);
    const won = entered.filter(ordinal => fights[ordinal - 1].won);
    const success = won.includes(4);
    const rooms = won.filter(ordinal => ordinal < 4).length;
    return { ...outcome, entered, won, success, result: success ? 'victory' as const : 'defeat' as const,
      rewards: success ? { xp: 48, money: 8, loot: [{ catalogId: 'sword:1:uncommon', catalogVersion: 'v1', quantity: 1, origin: 'expedition' }] }
        : { xp: rooms * 6, money: rooms, loot: [] } };
  });
  return { ...plan, fights, stages, outcomes };
}

async function leaseFinal(sim: JobLease, plan: DungeonRunPlan) {
  expect(await complete(sim, plan)).toMatchObject({ ok: true });
  for (let n = 0; n < plan.stages.length - 1; n++) {
    const [reveal] = await claim('reveal');
    expect(await complete(reveal, {})).toMatchObject({ ok: true });
  }
}

async function revealAndLease(sim: JobLease, plan: DungeonRunPlan) {
  await leaseFinal(sim, plan);
  const [last, ...settlements] = await claim('settlement');
  expect(last.kind).toBe('reveal');
  expect(settlements).toHaveLength(plan.outcomes.length);
  expect(await complete(last, {})).toMatchObject({ ok: true });
  return settlements;
}

function preparation(state: OwnerState, rewards: DungeonRunPlan['outcomes'][number]['rewards']) {
  const { level, xp } = state.progression;
  return { rewards, grant: prepareGrant(state, rewards.loot, RULES_V2), progressionBaseline: { level, xp },
    progression: applyXp(level, xp, rewards.xp) };
}

const takeSettlement = (job: JobLease) => workerDatabase.settle(job.activityId!, job.token);
const preparedSettle = (job: JobLease, prepared: ReturnType<typeof preparation>) =>
  rpc('settle_expedition', { activity_id: job.activityId, lease_token: job.token, prepared });
const nowIn = (tx: TransactionSql, ms: number) => tx.unsafe(`create or replace function private.planning_now_ms() returns bigint
  language sql volatile security invoker set search_path='' as 'select ${ms}::bigint'`);
async function rollbackOnly(run: (tx: TransactionSql) => Promise<void>) {
  await sql.begin(async tx => { await run(tx); throw rolledBack; }).catch(error => { if (error !== rolledBack) throw error; });
}

async function creditedState(gids: string[]) {
  const [row] = await sql`select
    (select jsonb_agg(to_jsonb(w) order by w.gladiator_id) from public.wallets w where w.gladiator_id in ${sql(gids)}) wallets,
    (select jsonb_agg(jsonb_build_array(g.level,g.xp) order by g.id) from public.gladiators g where g.id in ${sql(gids)}) progression,
    (select jsonb_agg(to_jsonb(i) order by i.id) from public.item_instances i where i.gladiator_id in ${sql(gids)}) items,
    (select jsonb_agg(to_jsonb(c) order by c.gladiator_id,c.counter) from public.title_counters c where c.gladiator_id in ${sql(gids)}) counters,
    (select jsonb_agg(to_jsonb(t) order by t.gladiator_id,t.title_id) from public.gladiator_titles t where t.gladiator_id in ${sql(gids)}) titles,
    (select jsonb_agg(to_jsonb(o) order by o.receipt_id) from public.operation_receipts o where o.gladiator_id in ${sql(gids)}) receipts,
    (select jsonb_agg(to_jsonb(s) order by s.activity_id) from private.settled_slots s where s.gladiator_id in ${sql(gids)}) checkpoints,
    (select jsonb_agg(to_jsonb(l) order by l.id) from public.wallet_ledger l where l.gladiator_id in ${sql(gids)}) ledger`;
  return row;
}

describe('dungeon settlement', () => {
  async function dueBundle() {
    const { sim, plan } = await leasedDungeon();
    await leaseFinal(sim, plan);
    const [{ reveal }] = await sql`select id as reveal from private.jobs where kind='reveal' and status='pending'`;
    const members = (await sql`select id from private.jobs where kind='settlement' order by id`).map(row => row.id as string);
    expect(members).toHaveLength(2);
    return { reveal: reveal as string, members };
  }

  async function claimIn(tx: TransactionSql, cap: number) {
    const [{ jobs }] = await tx`select public.claim_jobs(${randomUUID()},'settlement',${cap}) as jobs`;
    return jobs as JobLease[];
  }

  it('does not hold member locks when an empty claim skips a shared reveal', async () => {
    const { reveal, members } = await dueBundle();
    await rollbackOnly(async owner => {
      await owner`select id from private.jobs where id=${reveal} for update`;
      await rollbackOnly(async contender => {
        expect((await claimIn(contender, 20)).length).toBe(0);
        // The contender's transaction stays open after its empty claim.
        const leases = await claimIn(owner, 3);
        expect(leases.map(job => job.id)).toEqual([reveal, ...members]);
        expect(leases.map(job => job.attempt)).toEqual([1, 1, 1]);
      });
    });
  });

  it('releases the reveal and tentative siblings when one member is locked', async () => {
    const { reveal, members } = await dueBundle();
    await rollbackOnly(async owner => {
      await owner`select id from private.jobs where id=${members[1]} for update`;
      await rollbackOnly(async contender => {
        expect((await claimIn(contender, 20)).length).toBe(0);
        // The contender got as far as the second member. Its rejected bundle must leave every row claimable here.
        expect((await claimIn(owner, 3)).map(job => job.id)).toEqual([reveal, ...members]);
      });
    });
  });

  it('fits nine shared reveals and 50 settlements in three claims without completing any reveal', async () => {
    const owner = await dungeonFighter();
    const id = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
    const groups = Array.from({ length: 9 }, (_, index) => {
      const runId = `dungeon:${TARGET}:wolf-den:${index + 1}`;
      const reveal = id(100 + index);
      // One member per group sorts before Rest, with the other two sorting after it.
      const members = index === 8 ? [id(index + 1)] : [id(index + 1), id(60 + index * 2), id(61 + index * 2)];
      return { runId, reveal, members };
    });
    const rest = Array.from({ length: 25 }, (_, index) => id(20 + index));
    await sql.begin(async tx => {
      for (const { runId, reveal, members } of groups) {
        await tx`insert into private.jobs(id,kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
          values(${reveal},'reveal',${`dungeon-reveal:${runId}:3`},${TARGET},${owner.gid},
            ${tx.json({ kind: 'dungeon-reveal', runId, ordinal: 3 })},'v2',${slotEnd})`;
        for (const member of members) {
          await tx`insert into private.jobs(id,kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
            values(${member},'settlement',${`settlement:${member}`},${TARGET},${owner.gid},'{"resolvedKind":"dungeon"}','v2',${slotEnd})`;
          await tx`insert into private.job_dependencies(job_id,prerequisite_id) values(${member},${reveal})`;
        }
      }
      for (const [index, job] of rest.entries()) {
        await tx`insert into private.jobs(id,kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
          values(${job},'settlement',${`settlement:${job}`},${TARGET},${owner.gid},'{"resolvedKind":"rest"}','v2',${slotEnd - (index === 0 ? 1 : 0)})`;
      }
    });
    const batches = [await claim('settlement', 20), await claim('settlement', 20), await claim('settlement', 20)];
    const leases = batches.flat();
    expect(batches[0][0].id).toBe(rest[0]);
    expect(batches.map(batch => batch.length)).toEqual([20, 20, 19]);
    expect(leases.map(job => job.id).sort()).toEqual([...groups.flatMap(g => [g.reveal, ...g.members]), ...rest].sort());
    expect(leases.every(job => job.attempt === 1)).toBe(true);
    for (const { reveal, members } of groups) {
      const batch = batches.find(batch => batch.some(job => job.id === reveal))!;
      const offset = batch.findIndex(job => job.id === reveal);
      expect(batch.slice(offset, offset + members.length + 1).map(job => job.id)).toEqual([reveal, ...members]);
    }
  });

  it('settles each member once at minute 80 from its own outcome; a retry replays the receipt', async () => {
    const { owners, sim, plan: original } = await settlementRun();
    const plan = wolfOutcome(original, 4, true, owners[0].gid);
    expect(plan.fights[0].log.finalHp[plan.fights[0].log.participants.findIndex(p => p.id === owners[0].gid)]).toBe(0);
    expect(plan.fights.slice(1).flatMap(fight => fight.log.participants).map(p => p.id)).not.toContain(owners[0].gid);
    await leaseFinal(sim, plan);
    expect((await owners[0].state()).currentActivity).toMatchObject({ kind: 'dungeon', label: 'Dungeon' });
    expect((await sql`select actor from public.world_actors where gladiator_id=${owners[0].gid}`)[0].actor)
      .toMatchObject({ location: 'dungeon:wolf-den', activityStatus: 'active' });
    await rollbackOnly(async tx => {
      await nowIn(tx, slotEnd - 1);
      const leases = () => tx`select public.claim_jobs(${randomUUID()},'settlement',20) as jobs`;
      expect((await leases())[0].jobs).toEqual([]);
      await nowIn(tx, slotEnd);
      const [{ jobs }] = await leases();
      expect(jobs.map((job: JobLease) => job.kind)).toEqual(['reveal', 'settlement', 'settlement']);
      const [last, member] = jobs as JobLease[];
      const [{ ready }] = await tx`select private.dependencies_ready(${member.id}) as ready`;
      expect(ready).toBe(false);
      const [{ result }] = await tx`select public.settle_activity(${member.activityId},${member.token}) as result`;
      expect(result).toEqual({ ok: false, code: 'processing' });
      await tx`select public.complete_job(${last.id},${last.token},'{}')`;
      expect((await tx`select private.dependencies_ready(${member.id}) as ready`)[0].ready).toBe(true);
    });
    const [last, ...jobs] = await claim('settlement');
    expect(await complete(last, {})).toMatchObject({ ok: true });
    const ordered = owners.map(owner => jobs.find(job => job.gladiatorId === owner.gid)!);
    const before = await Promise.all(owners.map(owner => owner.state()));
    const spectator = await account();
    const results = await Promise.all(ordered.map(async job => {
      const result = await takeSettlement(job);
      if (!result.ok) throw new Error(`Dungeon settlement refused: ${result.code}`);
      return result;
    }));
    const [fallen, cleared] = results;
    expect(fallen).toMatchObject({ ok: true, activityId: ordered[0].activityId, newGrants: 1,
      summary: { result: 'defeat', success: false, rewards: { xp: 6, money: 1, items: [], overflowMoney: 0 } } });
    expect(cleared).toMatchObject({ ok: true, activityId: ordered[1].activityId, newGrants: 1,
      summary: { result: 'victory', success: true, rewards: { xp: 48, money: 8, items: [{ catalogId: 'sword:1:uncommon' }] } } });
    expect(fallen.receiptId).not.toBe(cleared.receiptId);
    for (const [index, owner] of owners.entries()) {
      const result = results[index], activityId = ordered[index].activityId!;
      const credited = await owner.state();
      expect(credited.wallets.money).toBe(before[index].wallets.money + (index ? 8 : 1));
      expect(credited.progression).toMatchObject(applyXp(before[index].progression.level, before[index].progression.xp, index ? 48 : 6));
      expect(credited.currentActivity).toMatchObject({ kind: 'dungeon', label: 'Dungeon' });
      expect(credited.inbox?.newNotifications).toBe(1);
      expect(credited.titleProgress?.['gold-v2']).toBe(index ? 8 : 1);
      expect(credited.titleProgress?.['items-owned']).toBe((before[index].titleProgress?.['items-owned'] ?? 0) + index);
      expect(credited.titleProgress?.['dungeon-clears'] ?? 0).toBe(index);
      expect(credited.titleProgress?.['wolf-den-clears'] ?? 0).toBe(index);
      expect(credited.titles?.map(t => t.id).filter(id => clearTitles.includes(id))).toEqual(index ? ['den-breaker'] : []);
      const own = await owner.client.from('activities').select('summary').eq('id', activityId).single();
      expect(own.error).toBeNull();
      expect(own.data?.summary).toEqual(result.summary);
      const { data: other, error: otherError } = await spectator.client.from('activities').select('summary').eq('id', activityId);
      expect(otherError).toBeNull();
      expect(other).toEqual([]);
      expect((await anonymous.from('activities').select('summary').eq('id', activityId)).error).not.toBeNull();
      for (const client of [anonymous, spectator.client, owner.client]) {
        const forbidden = await client.rpc('expedition_settlement_input', { activity_id: activityId, lease_token: ordered[index].token });
        expect(forbidden.error).not.toBeNull();
        expect(forbidden.data).toBeNull();
      }
      const expected = { activityId, resolvedKind: 'dungeon', result: index ? 'victory' : 'defeat', success: Boolean(index),
        settledAtMs: (result.summary as ActivitySummary).settledAtMs, replayExpiry: { state: 'expired' },
        dungeon: { id: 'wolf-den', terminalFight: 4, partyWon: true } };
      for (const client of [anonymous, spectator.client, owner.client]) {
        const read = await client.from('recent_results').select('summary').eq('activity_id', activityId).single();
        expect(read.error).toBeNull();
        expect(read.data?.summary).toEqual(expected);
      }
      await rollbackOnly(async tx => {
        const [{ sanitized }] = await tx`select private.safe_settlement(jsonb_set(${tx.json(result.summary as never)}::jsonb,
          '{dungeon,private}', '"hidden"')) as sanitized`;
        expect(sanitized.dungeon).toEqual(expected.dungeon);
        await tx`update public.activities set summary=jsonb_set(summary||'{"secret":"hidden"}','{dungeon,private}', '"hidden"') where id=${activityId}`;
        await tx`set constraints all immediate`;
        expect((await tx`select summary from public.recent_results where activity_id=${activityId}`)[0].summary).toEqual(expected);
      });
      expect(await sql`select o.receipt_id,s.receipt_id as checkpoint,l.money_delta::int as money from public.operation_receipts o
        join private.settled_slots s on s.receipt_id=o.receipt_id join public.wallet_ledger l on l.receipt_id=o.receipt_id
        where o.owner_id=${owner.id} and o.request->>'activityId'=${activityId} and l.reason='dungeon'`)
        .toEqual([{ receipt_id: result.receiptId, checkpoint: result.receiptId, money: index ? 8 : 1 }]);
    }
    const gids = owners.map(owner => owner.gid);
    const settled = await creditedState(gids);
    for (const [index, job] of ordered.entries()) {
      expect(await takeSettlement(job)).toMatchObject({ ok: true, receiptId: results[index].receiptId, newGrants: 0, replayed: true });
      expect(await workerDatabase.settle(job.activityId!, randomUUID())).toEqual({ ok: false, code: 'conflict' });
    }
    expect(await creditedState(gids)).toEqual(settled);
    for (const table of ['world_actors', 'recent_results', 'arena_standings', 'operation_receipts', 'wallet_ledger']) {
      const rows = await sql`select * from public.${sql(table)}`;
      expect(rows.every(row => gids.includes(row.gladiator_id))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain('hired:');
    }
  });

  it('admits dungeon fight reads exactly at the database-clock reveal cutoff', async () => {
    const { runId } = await groupedDungeon();
    await rollbackOnly(async tx => {
      await tx`select set_config('cloudiator.test_run_id',${runId},true)`;
      for (const role of ['anon', 'authenticated']) {
        await tx`select set_config('cloudiator.test_reader_role',${role},true)`;
        // Bracket the RLS SELECT within the exact same real millisecond. Retry only if scheduling crossed a millisecond.
        await tx`do $probe$
        declare
          run text:=current_setting('cloudiator.test_run_id'); due bigint; at_read bigint; after_read bigint; seen smallint[];
        begin
          for attempt in 1..12 loop
            due:=floor(extract(epoch from clock_timestamp())*1000)::bigint+10;
            insert into public.dungeon_fights(run_id,ordinal,reveal_at_ms,log) values
              (run,1,due-1,'{}'),(run,2,due,'{}'),(run,3,due+1,'{}')
              on conflict(run_id,ordinal) do update set reveal_at_ms=excluded.reveal_at_ms;
            perform set_config('role',current_setting('cloudiator.test_reader_role'),true);
            loop
              at_read:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
              exit when at_read>=due;
            end loop;
            select array_agg(f.ordinal order by f.ordinal) into seen from public.dungeon_fights f where f.run_id=run;
            after_read:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
            perform set_config('role','none',true);
            if at_read=due and after_read=due then
              if seen is distinct from array[1,2]::smallint[] then raise exception 'unexpected due fight visibility: %',seen; end if;
              return;
            end if;
          end loop;
          raise exception 'could not bracket the fight visibility read within its exact reveal millisecond';
        end
        $probe$`;
      }
    });
  });

  it.each([
    [3, false, 12, 2], [4, false, 18, 3], [1, true, 6, 1],
  ] as const)('pays room wins at terminal fight %i with partyWon=%s', async (terminal, partyWon, xp, money) => {
    const { owners, sim, plan: original } = await settlementRun();
    const plan = wolfOutcome(original, terminal, partyWon);
    const jobs = await revealAndLease(sim, plan);
    if (partyWon) {
      expect(plan.fights[0].log.participants.every((p, i) => p.side !== 0 || plan.fights[0].log.finalHp[i] === 0)).toBe(true);
      expect(plan.stages.at(-2)).toMatchObject({ kind: 'return' });
    }
    expect(await sql`select ordinal from public.dungeon_fights where run_id=${plan.runId} order by ordinal`)
      .toEqual(plan.fights.map(fight => ({ ordinal: fight.ordinal })));
    for (const job of jobs) {
      const owner = owners.find(owner => owner.gid === job.gladiatorId)!;
      const before = await owner.state();
      expect(await takeSettlement(job)).toMatchObject({ ok: true, summary: { result: 'defeat', success: false,
        dungeon: { id: 'wolf-den', terminalFight: terminal, partyWon }, rewards: { xp, money, items: [], overflowMoney: 0 } } });
      const state = await owner.state();
      expect(state.wallets.money).toBe(before.wallets.money + money);
      expect(state.titleProgress?.['dungeon-clears'] ?? 0).toBe(0);
    }
  });

  it('pays an over-level member from its frozen level and sells full-inventory salvage at retained v2 value', async () => {
    const { owners: [owner], sim, input, plan } = await settlementRun('wolf-den', true);
    expect(input.seats.find(seat => seat.kind === 'human' && seat.gladiatorId === owner.gid)).toMatchObject({ level: 9 });
    const outcome = plan.outcomes.find(row => row.gladiatorId === owner.gid)!;
    expect(outcome).toMatchObject({ overLevel: true, rewards: { xp: 24, money: 4 } });
    expect(outcome.rewards.loot.length).toBeGreaterThan(0);
    expect(outcome.rewards.loot.every(loot => loot.catalogId === 'salvage')).toBe(true);
    await sql`update public.gladiators set level=8 where id=${owner.gid}`;
    const initial = await owner.state();
    const sample = initial.inventory[0];
    await sql`insert into public.item_instances(id,gladiator_id,item)
      select i.id,${owner.gid},${sql.json(sample)}::jsonb||jsonb_build_object('id',i.id,'origin','shop','reservation',null)
      from (select gen_random_uuid() id from generate_series(1,${60 - initial.inventory.length})) i`;
    const jobs = await revealAndLease(sim, plan);
    const job = jobs.find(job => job.gladiatorId === owner.gid)!;
    const before = await owner.state();
    const owned = before.titleProgress?.['items-owned'];
    const overflowMoney = outcome.rewards.loot.reduce((sum, loot) => sum + loot.quantity * 4, 0);
    await sql.begin(tx => selectRules(tx, 'v1')); // Retained plan v2 prices overflow even when the live rules differ.
    expect(await takeSettlement(job)).toMatchObject({ ok: true, summary: { rewards: { xp: 24, money: 4, items: [], overflowMoney,
      overflow: [expect.objectContaining({ catalogId: 'salvage', unitValue: 4 })] } } });
    const after = await owner.state();
    expect(after.inventory).toEqual(before.inventory);
    expect(after.titleProgress?.['items-owned']).toBe(owned);
    expect(after.titleProgress?.['gold-v1']).toBe(4 + overflowMoney);
    expect(after.wallets.money).toBe(before.wallets.money + 4 + overflowMoney);
  });

  it.each([
    ['wolf-den', 'den-breaker'], ['raider-stronghold', 'warlords-end'], ['troll-hall', 'kingslayer'],
  ] as const)('awards the first %s clear and the 25th total clear inside settlement', async (id, firstClear) => {
    const { owners, sim, plan } = await settlementRun(id);
    const [, veteran] = owners;
    await sql`select private.set_title_count(${veteran.gid},'dungeon-clears',24)`;
    const jobs = await revealAndLease(sim, plan);
    for (const [index, owner] of owners.entries()) {
      const job = jobs.find(job => job.gladiatorId === owner.gid)!;
      const outcome = plan.outcomes.find(outcome => outcome.activityId === job.activityId)!;
      const prepared = preparation(await owner.state(), outcome.rewards);
      await rollbackOnly(async tx => {
        const [{ result }] = await tx`select public.settle_expedition(${job.activityId},${job.token},${tx.json(prepared as never)}) as result`;
        expect(result).toMatchObject({ ok: true, summary: { success: true } });
        const titles = await tx`select title_id,source,activity_id from public.gladiator_titles where gladiator_id=${owner.gid}
          and title_id=any(${[...clearTitles, 'game-master', 'high-ground']}::text[]) order by title_id`;
        expect(titles).toEqual((index ? [firstClear, 'dungeoneer'].sort() : [firstClear])
          .map(title_id => ({ title_id, source: 'result', activity_id: job.activityId })));
        expect((await tx`select private.title_measures(${owner.gid},${slotEnd}) as measures`)[0].measures)
          .toMatchObject({ 'dungeon-clears': index ? 25 : 1, [`${id}-clears`]: 1, 'expeditions-won': 0 });
      });
    }
  });

  it('rolls back a stale preparation and rejects a matching lease that expires under the job lock', async () => {
    const { owners, sim, plan } = await settlementRun();
    const jobs = await revealAndLease(sim, plan);
    const [owner] = owners;
    const job = jobs.find(job => job.gladiatorId === owner.gid)!;
    const read = await rpc<{ rewards: DungeonRunPlan['outcomes'][number]['rewards']; rulesVersion: string } | null>(
      'expedition_settlement_input', { activity_id: job.activityId, lease_token: job.token });
    expect(read).toMatchObject({ rewards: plan.outcomes.find(outcome => outcome.activityId === job.activityId)!.rewards, rulesVersion: 'v2' });
    const prepared = preparation(await owner.state(), read!.rewards);
    await sql`update public.gladiators set xp=xp+1 where id=${owner.gid}`;
    const before = await creditedState([owner.gid]);
    expect(await preparedSettle(job, prepared)).toEqual({ ok: false, code: 'stale-preparation' });
    expect(await creditedState([owner.gid])).toEqual(before);
    const fresh = preparation(await owner.state(), read!.rewards);
    const [{ expiry }] = await sql`update private.jobs set lease_until_ms=private.planning_now_ms()+3000
      where id=${job.id} returning lease_until_ms::float8 as expiry`;
    const contender = await sql.reserve();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const blocker = sql.begin(async tx => {
      await tx`select 1 from private.jobs where id=${job.id} for update`;
      locked();
      await hold;
    });
    let pending: PromiseLike<unknown> | undefined;
    try {
      await ready;
      const [{ pid }] = await contender`select pg_backend_pid() as pid`;
      pending = contender`select public.settle_expedition(${job.activityId},${job.token},${contender.json(fresh as never)}) as r`.execute();
      void Promise.resolve(pending).catch(() => undefined);
      let blocked = false, now = 0;
      for (let poll = 0; poll < 100 && !blocked; poll++) {
        [{ blocked, now }] = await sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked,private.planning_now_ms()::float8 as now`;
        if (!blocked) await delay(10);
      }
      expect(blocked).toBe(true);
      expect(now).toBeLessThan(expiry);
      for (let poll = 0; poll < 125 && now <= expiry; poll++) {
        await delay(40);
        now = (await sql`select private.planning_now_ms()::float8 as now`)[0].now;
      }
      expect(now).toBeGreaterThan(expiry);
      release();
      await blocker;
      expect(await pending).toEqual([{ r: { ok: false, code: 'conflict' } }]);
      expect(await creditedState([owner.gid])).toEqual(before);
      const retried = (await claim('settlement')).find(retry => retry.id === job.id)!;
      expect(retried.attempt).toBe(2);
      expect(await takeSettlement(retried)).toMatchObject({ ok: true, newGrants: 1 });
    } finally {
      release();
      await Promise.allSettled([blocker, pending]);
      contender.release();
    }
  });

  it('prunes dungeon fights, results, members and runs after 7 days and keeps the summaries 90', async () => {
    const { owners, sim, plan: original } = await settlementRun();
    const plan = wolfOutcome(original, 4, true, owners[0].gid);
    await leaseFinal(sim, plan);
    const [last, ...jobs] = await claim('settlement');
    const expiry = slotEnd + RULES_V2.retention.replayMs;
    const summaryExpiry = slotEnd + RULES_V2.retention.summaryMs;
    const gids = owners.map(owner => owner.gid);
    const prepared = await Promise.all(jobs.map(async job => preparation(
      await owners.find(owner => owner.gid === job.gladiatorId)!.state(),
      plan.outcomes.find(outcome => outcome.activityId === job.activityId)!.rewards)));
    await rollbackOnly(async tx => {
      const cleanup = async (ms: number) => {
        await nowIn(tx, ms);
        return (await tx`select private.cleanup_history(${ms}) as result`)[0].result;
      };
      await tx`update private.coordinator set published_slot=${TARGET + 19} where singleton`;
      await tx`update public.gladiators set processed_slot_index=${TARGET + 19}`;
      const empty = { dungeonFights: 0, dungeonResults: 0, dungeonRunMembers: 0, dungeonRuns: 0 };
      expect((await cleanup(expiry)).detail).toMatchObject({ blockedSlot: TARGET, deleted: empty });
      await nowIn(tx, slotEnd);
      const [{ result: reveal }] = await tx`select public.complete_job(${last.id},${last.token},'{}') as result`;
      expect(reveal).toMatchObject({ ok: true });
      for (const [index, job] of jobs.entries()) {
        const [{ result }] = await tx`select public.settle_expedition(${job.activityId},${job.token},${tx.json(prepared[index] as never)}) as result`;
        expect(result).toMatchObject({ ok: true, summary: { replayExpiry: { state: 'available', expiresAtMs: expiry } } });
      }
      await tx`set constraints all immediate`;
      const summaries = () => tx`select a.id,a.summary as owner,r.summary as public
        from public.activities a join public.recent_results r on r.activity_id=a.id where a.slot_index=${TARGET} order by a.id`;
      const before = await summaries();
      expect(before).toHaveLength(2);
      const keys = () => tx`select o.owner_id,o.operation_id,o.receipt_id,o.request,o.request_digest from public.operation_receipts o
        join private.settled_slots s on s.receipt_id=o.receipt_id where s.slot_index=${TARGET} order by o.receipt_id`;
      const checkpoints = () => tx`select * from private.settled_slots where slot_index=${TARGET} order by gladiator_id`;
      const titles = () => tx`select * from public.gladiator_titles where gladiator_id in ${tx(gids)} order by gladiator_id,title_id`;
      const counters = () => tx`select * from public.title_counters where gladiator_id in ${tx(gids)} order by gladiator_id,counter`;
      const preserved = await Promise.all([keys(), checkpoints(), titles(), counters()]);
      expect((await cleanup(expiry - 1)).detail.deleted).toMatchObject(empty);
      expect(await summaries()).toEqual(before);
      expect((await cleanup(expiry)).detail.deleted).toMatchObject({
        dungeonFights: 4, dungeonResults: 1, dungeonRunMembers: 2, dungeonRuns: 1,
      });
      expect(await tx`select id from private.jobs where slot_index=${TARGET}`).toEqual([]);
      expect(await tx`select run_id from private.dungeon_runs union all select run_id from private.dungeon_results
        union all select run_id from private.dungeon_run_members union all select run_id from public.dungeon_fights`).toEqual([]);
      const expired = before.map(row => ({ ...row, owner: { ...row.owner, replayExpiry: { state: 'expired' } },
        public: { ...row.public, replayExpiry: { state: 'expired' } } }));
      expect(await summaries()).toEqual(expired);
      // Rebuild both public rows from the retained activities after all detailed sources are gone.
      await tx`delete from public.recent_results where activity_id in ${tx(before.map(row => row.id))}`;
      await tx`update public.gladiators set rating=rating+1 where id in ${tx(gids)}`;
      await tx`set constraints all immediate`;
      expect(await summaries()).toEqual(expired);
      expect((await cleanup(expiry)).detail.deleted).toMatchObject(empty);
      expect((await cleanup(summaryExpiry - 1)).summary.deleted.activities).toBe(0);
      expect(await summaries()).toEqual(expired);
      const pruned = await cleanup(summaryExpiry);
      expect(pruned.summary).toMatchObject({ deleted: { activities: 2 }, compacted: { receipts: 2 } });
      expect(await tx`select id from public.activities where slot_index=${TARGET}`).toEqual([]);
      expect(await tx`select activity_id from public.recent_results where activity_id in ${tx(before.map(row => row.id))}`).toEqual([]);
      expect(await Promise.all([keys(), checkpoints(), titles(), counters()])).toEqual(preserved);
      expect(await tx`select distinct o.result from public.operation_receipts o
        join private.settled_slots s on s.receipt_id=o.receipt_id where s.slot_index=${TARGET}`)
        .toEqual([{ result: { compactedAtMs: summaryExpiry } }]);
      expect((await cleanup(summaryExpiry)).summary.deleted.activities).toBe(0);
    });
  });

  it('runs a Wolf Den afternoon with four entrants end to end through the real worker HTTP endpoint', async () => {
    const previous = Math.floor(Date.now() / SLOT) - 1;
    const target = previous - (previous + 2) % 3;
    await resetWorld(target - 1);
    await sql.begin(tx => selectRules(tx, 'v2'));
    const rest = { kind: 'rest' };
    const owners = [];
    for (let i = 0; i < 4; i++) {
      const owner = await dungeonFighter('wolf-den', 100, target, { morning: rest, afternoon: rest, evening: rest });
      await strengthen(owner);
      owners.push(owner);
    }
    const before = await Promise.all(owners.map(owner => owner.state()));
    const invoke = () => {
      const secret = process.env.LOCAL_WORKER_SECRET;
      if (!secret || secret.length <= 20) throw new Error('Local worker test authorization is unavailable');
      const input = ['url = "http://supabase_edge_runtime_Cloudiator:8081/game-worker"', 'request = "POST"', 'silent',
        'show-error', 'write-out = "\\n%{http_code}"', `header = ${JSON.stringify(`Authorization: Bearer ${secret}`)}`,
        'header = "Content-Type: application/json"', 'data-binary = "{}"'].join('\n');
      const output = execFileSync('docker', ['exec', '-i', 'supabase_db_Cloudiator', 'curl', '--config', '-'], { input, encoding: 'utf8' });
      const split = output.lastIndexOf('\n');
      expect(Number(output.slice(split + 1))).toBe(200);
      return JSON.parse(output.slice(0, split));
    };
    for (let round = 0; round < 22; round++) {
      expect(invoke().failed).toBe(0);
      const [{ count }] = await sql`select count(*)::int from public.activities where slot_index=${target} and status='completed'`;
      if (count === 4) break;
    }
    const results = await sql`select a.gladiator_id,a.id,a.summary,p.plan,r.run_id from public.activities a
      join private.dungeon_run_members m on m.activity_id=a.id join private.dungeon_runs r using(run_id)
      join private.dungeon_results p using(run_id) where a.slot_index=${target} and a.status='completed'`;
    expect(results).toHaveLength(4);
    expect(new Set(results.map(row => row.run_id)).size).toBe(2);
    for (const [index, owner] of owners.entries()) {
      const row = results.find(result => result.gladiator_id === owner.gid)!;
      const outcome = (row.plan as DungeonRunPlan).outcomes.find(outcome => outcome.activityId === row.id)!;
      expect(row.summary).toMatchObject({ success: outcome.success, rewards: { xp: outcome.rewards.xp, money: outcome.rewards.money },
        replayExpiry: { state: 'available', expiresAtMs: (target + 1) * SLOT + RULES_V2.retention.replayMs } });
      const state = await owner.state();
      const credited = row.summary.rewards;
      const expected = preparation(before[index], outcome.rewards);
      expect(state.wallets.money).toBe(before[index].wallets.money + credited.money + credited.overflowMoney);
      expect(state.progression).toMatchObject(expected.progression);
      expect(credited.items).toEqual([
        ...expected.grant.plan.retained.map(({ catalogId, catalogVersion, tier, rarity, quantity }) => ({ catalogId, catalogVersion, tier, rarity, quantity })),
        ...expected.grant.plan.stacked.map(({ quantity }) => ({ catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity })),
      ]);
      expect(await sql`select money_delta::int as money from public.wallet_ledger where receipt_id=${row.summary.receiptId} and reason='dungeon'`)
        .toEqual([{ money: credited.money + credited.overflowMoney }]);
      expect(await sql`select ordinal from public.dungeon_fights where run_id=${row.run_id} order by ordinal`)
        .toEqual((row.plan as DungeonRunPlan).fights.map(fight => ({ ordinal: fight.ordinal })));
    }
    const { checkpoints: _beforeCheckpoints, ...credited } = await creditedState(owners.map(owner => owner.gid));
    expect(invoke().failed).toBe(0);
    expect(await sql`select activity_id from private.settled_slots where slot_index=${target}`).toHaveLength(4);
    const { checkpoints: _afterCheckpoints, ...replayed } = await creditedState(owners.map(owner => owner.gid));
    expect(replayed).toEqual(credited);
  }, 120_000);
});
