import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { sql, admin, account, anonymous, resetIdentity, creation, request } from '../fixtures/db.ts';
import { SLOT, TRAINING, TTR, resetWorld, fighter as boundaryFighter, coordinatorLease, advance, runBoundary,
  settleDue, claim, completePreparations, rpc } from '../fixtures/boundary.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { DEFAULT_EXECUTORS } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { JobLease, PreparationInput, PreparationResult } from '../../supabase/functions/_shared/domain/types.ts';

const database = createDatabase(admin);
beforeEach(async () => {
  await resetIdentity();
  await sql`update private.scheduler set enabled=false where singleton`;
  // Do not normalize or manufacture retained rows: the seed test must observe the deployed source unchanged.
});
afterEach(async () => {
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`update private.rules_versions set active=true where version='v1'`;
});
afterAll(() => sql.end());

async function revision() {
  const result = await anonymous.from('world_revision').select('*').single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function fighter() {
  const owner = await account();
  const created = await database.createGladiator({ userId: owner.id }, creation('Economy ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId };
}
async function profile(gid: string) {
  const result = await anonymous.from('public_profile_reads').select('profile').eq('gladiator_id', gid).single();
  expect(result.error).toBeNull();
  return result.data!.profile;
}
/** SQL21 owns its BEGIN/COMMIT, so its whole-file replay must retain one explicitly reserved connection. */
async function reapply(source: string) {
  const connection = await sql.reserve();
  try {
    await connection.unsafe(source);
  } catch (error) {
    await connection`rollback`;
    throw error;
  } finally {
    connection.release();
  }
}

const ROLLBACK = new Error('rollback-only');
async function rollback<T>(run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await sql.begin(async tx => { value = await run(tx); throw ROLLBACK; });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return value as T;
}
async function activate(version: 'v1' | 'v2') {
  await sql.begin(async tx => {
    await tx`update private.rules_versions set active=false where active`;
    expect(await tx`update private.rules_versions set active=true where version=${version} returning version`).toHaveLength(1);
  });
}
const preparationRows = (gid: string) => sql`select slot_index::int as slot,input,result,seed,status from private.jobs
  where gladiator_id=${gid} and kind='prepare' order by slot_index`;
const activityRows = (gid: string) => sql`select a.slot_index::int as slot,a.requested->>'kind' as requested,a.resolved_kind as resolved,
  a.fallback,a.stamina_debit::int as debit,a.status,a.summary,s.rules_version as version,s.snapshot from public.activities a
  join private.activity_snapshots s on s.activity_id=a.id where a.gladiator_id=${gid} order by a.slot_index`;
const settledRows = (gid: string) => sql`select slot_index::int as slot,resolved_kind as resolved from private.settled_slots
  where gladiator_id=${gid} order by slot_index`;

/** A leased real job. Fault tests below change its frozen input only inside a transaction which always rolls back. */
async function preparationAt(target = 302) {
  await resetWorld(target - 1);
  const owner = await boundaryFighter({ firstSlot: target, schedule: TRAINING });
  await activate('v2');
  const token = await coordinatorLease();
  expect(await advance(target, token)).toMatchObject({ phase: 4, wait: 'preparation' });
  const jobs = await claim('prepare');
  expect(jobs).toHaveLength(1);
  return { owner, token, job: jobs[0] };
}
async function replaceFrozenInput(tx: TransactionSql, job: JobLease, input: unknown) {
  await tx`alter table private.jobs disable trigger guard_job`;
  await tx`update private.jobs set input=${tx.json(input as never)} where id=${job.id}`;
  await tx`alter table private.jobs enable trigger guard_job`;
}
/** Valid worker output is canonical; only the explicitly named persisted boundary fixture is forged. */
async function preparedFixture(job: JobLease, count = 0) {
  const input = { ...(job.snapshot as PreparationInput), trainingActivitiesEarlierInDay: count };
  const result = await DEFAULT_EXECUTORS.v2.prepare!({ ...job, snapshot: input }) as PreparationResult;
  return { input, result };
}
async function durableState(tx: TransactionSql, job: JobLease) {
  return {
    job: await tx`select * from private.jobs where id=${job.id}`,
    attempts: await tx`select * from private.job_attempts where job_id=${job.id} order by attempt`,
    gladiators: await tx`select id,earned_points,unspent_points,stamina_current,stamina_maximum,processed_slot_index from public.gladiators order by id`,
    activities: await tx`select * from public.activities order by id`,
    snapshots: await tx`select * from private.activity_snapshots order by activity_id`,
    settled: await tx`select * from private.settled_slots order by gladiator_id,slot_index`,
  };
}

describe('rules versions', () => {
  it('seeds v2 inactive beside the active v1', async () => {
    expect(await sql`select version,active from private.rules_versions order by version`)
      .toEqual([{ version: 'v1', active: true }, { version: 'v2', active: false }]);
  });

  it('publishes the active version only at commit, retaining every revision field', async () => {
    const before = await revision();
    expect(before.rules_version).toBe('v1');
    expect(Object.keys(before).sort()).toEqual(['latest_patch', 'published_slot_index', 'revision', 'rules_version', 'server_now_ms', 'slot_index']);
    await sql.begin(async tx => {
      await tx`update private.rules_versions set active=false where version='v1'`;
      expect(await tx`update private.rules_versions set active=true where version='v2' returning version`).toHaveLength(1);
      expect(await tx`select rules_version from public.world_revision_state`).toEqual([{ rules_version: 'v1' }]);
      expect((await revision()).rules_version).toBe('v1');
    });
    const after = await revision();
    expect(after.rules_version).toBe('v2');
    expect(after.latest_patch).toEqual(before.latest_patch);
    expect(after.published_slot_index).toEqual(before.published_slot_index);
    expect(after.revision).toEqual(expect.any(String));
    expect(after.server_now_ms).toBeGreaterThanOrEqual(before.server_now_ms);
  });

  it('does not publish a rolled-back activation', async () => {
    const rollback = new Error('rollback');
    await expect(sql.begin(async tx => {
      await tx`update private.rules_versions set active=false where version='v1'`;
      expect(await tx`update private.rules_versions set active=true where version='v2' returning version`).toHaveLength(1);
      expect(await tx`select rules_version from public.world_revision_state`).toEqual([{ rules_version: 'v1' }]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await revision()).rules_version).toBe('v1');
    expect(await sql`select version from private.rules_versions where active`).toEqual([{ version: 'v1' }]);
  });
});

describe('the Arena banner', () => {
  it('shows a real bought banner, preserves the rich profile, and publishes the revision', async () => {
    const owner = await fighter(), other = await fighter();
    await sql`update public.wallets set renown=50 where gladiator_id=${owner.gid}`;
    const beforeProfile = await profile(owner.gid), beforeRevision = await revision();
    expect(beforeProfile.banner).toBe(false);
    const response = await handleCommand(request(owner.token, { kind: 'buy-shop', operationId: randomUUID(),
      catalogId: 'banner', catalogVersion: 'v1', quantity: 1 }),
    { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] });
    expect(await response.json()).toMatchObject({ ok: true, value: { cosmeticId: 'banner', renownDebit: 50 } });
    expect(await sql`select renown::int from public.wallets where gladiator_id=${owner.gid}`).toEqual([{ renown: 0 }]);
    expect(await profile(owner.gid)).toEqual({ ...beforeProfile, banner: true });
    expect((await profile(other.gid)).banner).toBe(false);
    expect(Number((await revision()).revision.split(':')[0])).toBeGreaterThan(Number(beforeRevision.revision.split(':')[0]));
    // Existing projection upserts must retain ownership without re-purchasing.
    await sql`update public.gladiators set rating=1012 where id=${owner.gid}`;
    await sql`select private.project_character(${owner.gid})`;
    expect(await profile(owner.gid)).toMatchObject({ banner: true, rating: 1012,
      build: beforeProfile.build, joinedAtMs: beforeProfile.joinedAtMs, arenaRecord: beforeProfile.arenaRecord });
  });

  it('backfills existing banner ownership and reapplies without activating v2 or changing balances', async () => {
    const owner = await fighter(), other = await fighter();
    // Model ownership that predates this trigger; do not fake the implementation of the backfill.
    expect((await profile(owner.gid)).banner).toBe(false);
    await sql.begin(async tx => {
      await tx`alter table public.owned_cosmetics disable trigger publish_banner`;
      await tx`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding)
        values(${owner.gid},'banner','v1','bound')`;
      await tx`alter table public.owned_cosmetics enable trigger publish_banner`;
    });
    expect((await profile(owner.gid)).banner).toBe(false);
    const balances = await sql`select gladiator_id,money::text,renown::text from public.wallets order by gladiator_id`;
    const source = readFileSync(new URL('../../supabase/sql/21-economy.sql', import.meta.url), 'utf8');
    await reapply(source);
    expect((await profile(owner.gid)).banner).toBe(true);
    expect((await profile(other.gid)).banner).toBe(false);
    const filled = await profile(owner.gid);
    await reapply(source);
    expect(await profile(owner.gid)).toEqual(filled);
    expect(await sql`select gladiator_id,money::text,renown::text from public.wallets order by gladiator_id`).toEqual(balances);
    expect(await sql`select version,active from private.rules_versions order by version`)
      .toEqual([{ version: 'v1', active: true }, { version: 'v2', active: false }]);
    // Reapplying is equally inert when the operator has already selected v2.
    await sql.begin(async tx => {
      await tx`update private.rules_versions set active=false where version='v1'`;
      await tx`update private.rules_versions set active=true where version='v2'`;
    });
    await reapply(source);
    expect(await sql`select version from private.rules_versions where active`).toEqual([{ version: 'v2' }]);
    expect((await revision()).rules_version).toBe('v2');
    expect(await sql`select gladiator_id,money::text,renown::text from public.wallets order by gladiator_id`).toEqual(balances);
  });
});

describe('v2 Training uses actual daily history', () => {
  beforeEach(() => resetWorld(299));

  it.each(['edit-schedule', 'edit-day-schedule', 'legacy repeating plan'] as const)(
    '%s accepts triple Training and resolves Training, Training, ordinary Rest', async saveKind => {
      const owner = await boundaryFighter({ schedule: saveKind === 'legacy repeating plan' ? TRAINING : TTR });
      // Exercise the real command RPC at the preceding evening, then restore the exact clock before commit.
      if (saveKind !== 'legacy repeating plan') {
        const [{ definition }] = await sql`select pg_get_functiondef('private.planning_now_ms()'::regprocedure) as definition`;
        await sql.begin(async tx => {
          await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker
            set search_path='' as 'select ${299 * SLOT + 10}::bigint'`);
          const command = saveKind === 'edit-schedule'
            ? { kind: saveKind, operationId: randomUUID(), expectedVersion: 1, phase: 'evening', choice: { kind: 'training' } }
            : { kind: saveKind, operationId: randomUUID(), expectedVersion: 1, day: TRAINING };
          const invoke = async (body: typeof command) => saveKind === 'edit-schedule'
            ? (await tx`select public.edit_schedule(${owner.id},${body.operationId},${tx.json({ command: body, prepared: null } as never)}) as r`)[0].r
            : (await tx`select public.edit_day_schedule(${owner.id},${body.operationId},${tx.json({ command: body, prepared: null } as never)}) as r`)[0].r;
          const saved = await invoke(command);
          expect(saved).toMatchObject({ ok: true, value: { version: 2 } });
          expect(await invoke(command)).toEqual(saved);
          expect(await invoke({ ...command, operationId: randomUUID() })).toMatchObject({ ok: false, code: 'conflict' });
          expect(await tx`select schedule from public.schedules where gladiator_id=${owner.gid}`).toEqual([{ schedule: TRAINING }]);
          await tx.unsafe(definition);
        });
        expect((await sql`select pg_get_functiondef('private.planning_now_ms()'::regprocedure) as definition`)[0].definition).toBe(definition);
      }
      await activate('v2');
      const token = await coordinatorLease();
      for (const [slot, count] of [[300, 0], [301, 1], [302, 2]] as const) {
        if (slot > 300) await settleDue(slot - 1, token);
        expect(await advance(slot, token)).toMatchObject({ wait: 'preparation' });
        expect((await preparationRows(owner.gid)).find(row => row.slot === slot)!.input)
          .toMatchObject({ slotIndex: slot, trainingActivitiesEarlierInDay: count, peakStrength: 28 });
        await completePreparations();
        expect((await preparationRows(owner.gid)).find(row => row.slot === slot)!.result)
          .toMatchObject({ trainingAllowed: slot !== 302, trainingPoints: 1, costs: { training: 20 } });
        expect(await advance(slot, token)).toMatchObject({ status: 'complete' });
      }
      const rows = await activityRows(owner.gid);
      expect(rows.map(({ slot, requested, resolved, fallback, debit }) => ({ slot, requested, resolved, fallback, debit }))).toEqual([
        { slot: 300, requested: 'training', resolved: 'training', fallback: false, debit: 20 },
        { slot: 301, requested: 'training', resolved: 'training', fallback: false, debit: 20 },
        { slot: 302, requested: 'training', resolved: 'rest', fallback: false, debit: 0 },
      ]);
      expect(rows.map(row => row.snapshot.trainingAllowed)).toEqual([true, true, false]);
      expect(rows.map(row => row.version)).toEqual(['v2', 'v2', 'v2']);
      // Starting Rest does not refill. Ordinary recovery occurs at completion, with no third grant.
      expect(await owner.row()).toMatchObject({ earned: 12, unspent: 2, stamina: 64, maximum: 104 });
      await settleDue(302, token);
      expect(await owner.row()).toMatchObject({ earned: 12, unspent: 2, stamina: 104, maximum: 104 });
      expect(await settledRows(owner.gid)).toEqual([
        { slot: 300, resolved: 'training' }, { slot: 301, resolved: 'training' }, { slot: 302, resolved: 'rest' },
      ]);
      expect((await activityRows(owner.gid)).map(row => row.summary.rewards.attributePoints)).toEqual([1, 1, 0]);
    });

  it('retains the level-one earned 13/14 point-cap controls independently of the daily allowance', async () => {
    const below = await boundaryFighter(), full = await boundaryFighter();
    await sql`update public.gladiators set earned_points=13,unspent_points=3 where id=${below.gid}`;
    await sql`update public.gladiators set earned_points=14,unspent_points=4 where id=${full.gid}`;
    await activate('v2');
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    for (const [owner, points] of [[below, 1], [full, 0]] as const) {
      expect((await preparationRows(owner.gid))[0]).toMatchObject({
        input: { trainingActivitiesEarlierInDay: 0 }, result: { trainingAllowed: true, trainingPoints: points },
      });
      expect((await activityRows(owner.gid))[0]).toMatchObject({ resolved: 'training', debit: 20, fallback: false,
        version: 'v2', snapshot: { trainingAllowed: true, trainingPoints: points } });
    }
    await settleDue(300, token);
    expect(await below.row()).toMatchObject({ earned: 14, unspent: 4 });
    expect(await full.row()).toMatchObject({ earned: 14, unspent: 4 });
    expect((await activityRows(full.gid))[0].summary.rewards.attributePoints).toBe(0);
  });

  it('counts cap-zero Training and chooses ordinary Rest before an insufficient-stamina fallback', async () => {
    const owner = await boundaryFighter({ schedule: TRAINING, stamina: 40 });
    await sql`update public.gladiators set earned_points=14,unspent_points=4 where id=${owner.gid}`;
    await activate('v2');
    const token = await coordinatorLease();
    for (const slot of [300, 301, 302]) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    expect((await preparationRows(owner.gid)).map(row => row.input.trainingActivitiesEarlierInDay)).toEqual([0, 1, 2]);
    expect((await preparationRows(owner.gid)).map(row => row.result.trainingPoints)).toEqual([0, 0, 0]);
    expect((await activityRows(owner.gid)).map(row => [row.resolved, row.debit, row.fallback])).toEqual([
      ['training', 20, false], ['training', 20, false], ['rest', 0, false],
    ]);
    expect(await owner.row()).toMatchObject({ earned: 14, unspent: 4, stamina: 0 });
    await settleDue(302, token);
    expect(await owner.row()).toMatchObject({ earned: 14, unspent: 4, stamina: 104 });
    expect((await settledRows(owner.gid)).filter(row => row.resolved === 'training')).toHaveLength(2);
  });

  it('does not count insufficient-stamina Rest as Training', async () => {
    const owner = await boundaryFighter({ schedule: TRAINING, stamina: 19 });
    await activate('v2');
    const token = await coordinatorLease();
    for (const slot of [300, 301, 302]) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    expect((await preparationRows(owner.gid)).map(row => row.input.trainingActivitiesEarlierInDay)).toEqual([0, 0, 1]);
    expect((await activityRows(owner.gid)).map(row => [row.resolved, row.debit, row.fallback])).toEqual([
      ['rest', 0, true], ['training', 20, false], ['training', 20, false],
    ]);
    await settleDue(302, token);
    expect(await owner.row()).toMatchObject({ earned: 12, stamina: 64 });
    expect(await settledRows(owner.gid)).toEqual([
      { slot: 300, resolved: 'rest' }, { slot: 301, resolved: 'training' }, { slot: 302, resolved: 'training' },
    ]);
  });

  it('includes earlier same-day v1 Training but excludes previous-day and other-owner history', async () => {
    await resetWorld(298);
    const priorDay = await boundaryFighter({ firstSlot: 299, schedule: { morning: { kind: 'rest' }, afternoon: { kind: 'rest' }, evening: { kind: 'training' } } });
    const sameDay = await boundaryFighter({ firstSlot: 300, schedule: TRAINING });
    const token = await coordinatorLease();
    for (const slot of [299, 300, 301]) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    await settleDue(301, token);
    expect(await settledRows(sameDay.gid)).toEqual([{ slot: 300, resolved: 'training' }, { slot: 301, resolved: 'training' }]);
    // Changing the latest plan cannot erase actual Training or fabricate it for the other character.
    await sql`update public.schedules set schedule=${sql.json(TRAINING as never)} where gladiator_id=${priorDay.gid}`;
    await sql`update public.schedules set schedule='{"morning":{"kind":"rest"},"afternoon":{"kind":"rest"},"evening":{"kind":"rest"}}'
      where gladiator_id=${sameDay.gid}`;
    await activate('v2');
    expect(await runBoundary(302, token)).toMatchObject({ status: 'complete' });
    expect((await preparationRows(sameDay.gid)).at(-1)).toMatchObject({ input: { trainingActivitiesEarlierInDay: 2 }, result: { trainingAllowed: false } });
    expect((await preparationRows(priorDay.gid)).at(-1)).toMatchObject({ input: { trainingActivitiesEarlierInDay: 0 }, result: { trainingAllowed: true } });
    expect((await activityRows(sameDay.gid)).at(-1)).toMatchObject({ requested: 'training', resolved: 'rest', debit: 0, fallback: false });
    expect((await activityRows(priorDay.gid)).at(-1)).toMatchObject({ requested: 'training', resolved: 'training', debit: 20, fallback: false });
  });

  it('resets the daily allowance on the target morning during catch-up', async () => {
    const owner = await boundaryFighter({ schedule: TRAINING });
    await activate('v2');
    const token = await coordinatorLease();
    for (let slot = 300; slot <= 303; slot++) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    expect((await preparationRows(owner.gid)).map(row => row.input.trainingActivitiesEarlierInDay)).toEqual([0, 1, 2, 0]);
    expect((await activityRows(owner.gid)).map(row => [row.resolved, row.debit])).toEqual([
      ['training', 20], ['training', 20], ['rest', 0], ['training', 20],
    ]);
    await settleDue(303, token);
    expect(await owner.row()).toMatchObject({ earned: 13, unspent: 3, stamina: 84 });
  });

  it('retains an already frozen v1 third Training across activation', async () => {
    const owner = await boundaryFighter({ schedule: TRAINING });
    const token = await coordinatorLease();
    for (const slot of [300, 301]) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    await settleDue(301, token);
    expect(await advance(302, token)).toMatchObject({ wait: 'preparation' });
    const [job] = await claim('prepare');
    expect(job.rulesVersion).toBe('v1');
    expect(job.snapshot).not.toHaveProperty('trainingActivitiesEarlierInDay');
    const result = await DEFAULT_EXECUTORS.v1.prepare!(job);
    expect(result).not.toHaveProperty('trainingAllowed');
    await activate('v2');
    expect(await rpc('complete_job', { job_id: job.id, lease_token: job.token, result })).toMatchObject({ ok: true });
    expect(await advance(302, token)).toMatchObject({ status: 'complete' });
    expect((await activityRows(owner.gid)).at(-1)).toMatchObject({ version: 'v1', resolved: 'training', debit: 20, fallback: false });
    expect((await activityRows(owner.gid)).at(-1)!.snapshot).not.toHaveProperty('trainingAllowed');
    await settleDue(302, token);
    expect(await owner.row()).toMatchObject({ earned: 13, stamina: 44 });
  });

  it('freezes preparation input and seed across reclaim and grants each actual Training only once', async () => {
    const owner = await boundaryFighter({ schedule: TRAINING });
    await activate('v2');
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    await settleDue(300, token);
    expect(await advance(301, token)).toMatchObject({ wait: 'preparation' });
    const [first] = await claim('prepare');
    expect(first.snapshot).toMatchObject({ trainingActivitiesEarlierInDay: 1 });
    const frozen = (await preparationRows(owner.gid)).at(-1)!;
    await sql`update private.jobs set lease_until_ms=0 where id=${first.id}`;
    await sql`update public.schedules set schedule='{"morning":{"kind":"rest"},"afternoon":{"kind":"rest"},"evening":{"kind":"rest"}}'
      where gladiator_id=${owner.gid}`;
    expect(await advance(301, token)).toMatchObject({ wait: 'preparation' });
    const [second] = await claim('prepare');
    expect(second).toMatchObject({ id: first.id, seed: first.seed, snapshot: first.snapshot, attempt: 2 });
    expect(second.token).not.toBe(first.token);
    expect((await preparationRows(owner.gid)).at(-1)).toMatchObject({ input: frozen.input, seed: frozen.seed });
    const result = await DEFAULT_EXECUTORS.v2.prepare!(second);
    expect(await rpc('complete_job', { job_id: first.id, lease_token: first.token, result })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await rpc('complete_job', { job_id: second.id, lease_token: second.token, result })).toMatchObject({ ok: true });
    expect(await advance(301, token)).toMatchObject({ status: 'complete' });
    const [settlement] = await claim('settlement');
    const args = { activity_id: settlement.activityId, lease_token: settlement.token };
    expect(await rpc('settle_activity', args)).toMatchObject({ ok: true, newGrants: 1 });
    expect(await rpc('settle_activity', args)).toMatchObject({ ok: true, newGrants: 0, replayed: true });
    expect(await advance(301, token)).toMatchObject({ status: 'complete', replayed: true });
    expect(await owner.row()).toMatchObject({ earned: 12, unspent: 2, stamina: 64 });
    expect(await settledRows(owner.gid)).toEqual([{ slot: 300, resolved: 'training' }, { slot: 301, resolved: 'training' }]);
    await expect(sql`update private.jobs set input='{}' where id=${second.id}`).rejects.toThrow('immutable job');
  });

  it('excludes orientation slots from a late entrant’s Training count', async () => {
    const active = await boundaryFighter({ schedule: TRAINING });
    const late = await boundaryFighter({ firstSlot: 301, schedule: TRAINING });
    await sql`update public.gladiators set created_at_ms=${300 * SLOT + 1_000} where id=${late.gid}`;
    await activate('v2');
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    expect(await preparationRows(late.gid)).toEqual([]);
    expect(await activityRows(late.gid)).toEqual([]);
    expect(await settledRows(late.gid)).toEqual([]);
    for (const slot of [301, 302]) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    expect((await preparationRows(late.gid)).map(row => row.input.trainingActivitiesEarlierInDay)).toEqual([0, 1]);
    expect((await preparationRows(active.gid)).at(-1)!.input.trainingActivitiesEarlierInDay).toBe(2);
    expect((await activityRows(late.gid)).map(row => row.resolved)).toEqual(['training', 'training']);
    await settleDue(302, token);
    expect(await late.row()).toMatchObject({ earned: 12, stamina: 64 });
  });

  it('counts surviving permanent checkpoints after real activity pruning', async () => {
    const owner = await boundaryFighter({ schedule: TRAINING });
    const token = await coordinatorLease();
    // Historical v1 slots use the same permanent guard that v2 must read after cleanup.
    for (const slot of [300, 301]) expect(await runBoundary(slot, token)).toMatchObject({ status: 'complete' });
    await settleDue(301, token);
    const checkpoints = await settledRows(owner.gid);
    await activate('v2');
    await rollback(async tx => {
      // As in retention.test.ts, age a real history with operator checkpoint controls, then call actual cleanup.
      await tx`update private.coordinator set published_slot=320 where singleton`;
      await tx`update public.gladiators set processed_slot_index=320`;
      const cleanupTime = 302 * SLOT + 7_776_000_000;
      const [{ r }] = await tx`select private.cleanup_history(${cleanupTime}) as r`;
      expect(r.summary.deleted.activities).toBe(2);
      expect(await tx`select id from public.activities where gladiator_id=${owner.gid}`).toEqual([]);
      expect(await tx`select id from private.jobs where gladiator_id=${owner.gid}`).toEqual([]);
      expect(await tx`select slot_index::int as slot,resolved_kind as resolved from private.settled_slots
        where gladiator_id=${owner.gid} order by slot_index`).toEqual(checkpoints);
      // Revisit the next historical boundary only in this rollback-only probe. No checkpoint row is fabricated or edited.
      await tx`update private.coordinator set published_slot=301 where singleton`;
      await tx`update public.gladiators set processed_slot_index=301 where id=${owner.gid}`;
      expect((await tx`select public.advance_boundary(302,${token}) as r`)[0].r).toMatchObject({ wait: 'preparation' });
      const [job] = (await tx`select public.claim_jobs(${randomUUID()},'prepare',20) as jobs`)[0].jobs as JobLease[];
      expect(job.snapshot).toMatchObject({ slotIndex: 302, trainingActivitiesEarlierInDay: 2 });
      const result = await DEFAULT_EXECUTORS.v2.prepare!(job);
      expect(result).toMatchObject({ trainingAllowed: false, trainingPoints: 1 });
      expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r).toMatchObject({ ok: true });
      expect((await tx`select public.advance_boundary(302,${token}) as r`)[0].r).toMatchObject({ status: 'complete' });
      expect(await tx`select resolved_kind as resolved,fallback,stamina_debit::int as debit from public.activities where gladiator_id=${owner.gid}`)
        .toEqual([{ resolved: 'rest', fallback: false, debit: 0 }]);
      const [settlement] = (await tx`select public.claim_jobs(${randomUUID()},'settlement',20) as jobs`)[0].jobs as JobLease[];
      expect((await tx`select public.settle_activity(${settlement.activityId!},${settlement.token}) as r`)[0].r).toMatchObject({ ok: true, newGrants: 1 });
      expect(await tx`select earned_points::int as earned,stamina_current::int as stamina from public.gladiators where id=${owner.gid}`)
        .toEqual([{ earned: 12, stamina: 104 }]);
    });
    expect(await settledRows(owner.gid)).toEqual(checkpoints);
    expect(await activityRows(owner.gid)).toHaveLength(2);
  });
});

describe('v2 preparation and snapshot validation', () => {
  it('accepts integral JSON number spellings for a valid frozen slot and count', async () => {
    const { job } = await preparationAt(301);
    const { input, result } = await preparedFixture(job, 1);
    await rollback(async tx => {
      await replaceFrozenInput(tx, job, input);
      // Preserve PostgreSQL numeric spellings which JavaScript JSON.stringify normalizes to 301 and 1.
      await tx`alter table private.jobs disable trigger guard_job`;
      await tx`update private.jobs set input=input||'{"slotIndex":301.0,"trainingActivitiesEarlierInDay":1.0}'::jsonb where id=${job.id}`;
      await tx`alter table private.jobs enable trigger guard_job`;
      expect(await tx`select jsonb_typeof(input->'slotIndex') as slot_type,jsonb_typeof(input->'trainingActivitiesEarlierInDay') as count_type,
        private.safe_integer(input->'slotIndex') as valid_slot,private.safe_integer(input->'trainingActivitiesEarlierInDay') as valid_count
        from private.jobs where id=${job.id}`).toEqual([{ slot_type: 'number', count_type: 'number', valid_slot: true, valid_count: true }]);
      expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r).toMatchObject({ ok: true });
      expect(await tx`select status,result->'trainingAllowed' as allowed from private.jobs where id=${job.id}`)
        .toEqual([{ status: 'completed', allowed: true }]);
    });
  });

  it.each([300, 301, 302])('validates exact frozen count bounds at target %i before accepting the worker result', async target => {
    const { job } = await preparationAt(target);
    for (let count = 0; count <= target % 3; count++) {
      const { input, result } = await preparedFixture(job, count);
      await rollback(async tx => {
        await replaceFrozenInput(tx, job, input);
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r)
          .toMatchObject({ ok: true });
        expect(await tx`select result->'trainingAllowed' as allowed,status from private.jobs where id=${job.id}`)
          .toEqual([{ allowed: count < 2, status: 'completed' }]);
      });
    }
    const valid = await preparedFixture(job);
    await rollback(async tx => {
      await replaceFrozenInput(tx, job, { ...valid.input, trainingActivitiesEarlierInDay: target % 3 + 1 });
      const before = await durableState(tx, job);
      expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(valid.result as never)}) as r`)[0].r)
        .toMatchObject({ ok: false, code: 'invalid' });
      expect(await durableState(tx, job)).toEqual(before);
    });
  });

  it('rejects missing, wrong-type, unsafe or mismatched frozen slot/count without changing a leased job', async () => {
    const { job } = await preparationAt();
    const { input, result } = await preparedFixture(job);
    const invalid: [string, Record<string, unknown>][] = [];
    for (const key of ['slotIndex', 'trainingActivitiesEarlierInDay'] as const) {
      const omitted: Record<string, unknown> = { ...input };
      delete omitted[key];
      invalid.push([`${key} missing`, omitted]);
      for (const value of [null, '0', true, {}, [], -1, 0.5, 9_007_199_254_740_992]) {
        invalid.push([`${key} ${JSON.stringify(value)}`, { ...input, [key]: value }]);
      }
    }
    invalid.push(['target mismatch', { ...input, slotIndex: 301 }]);
    invalid.push(['count out of phase', { ...input, trainingActivitiesEarlierInDay: 3 }]);
    for (const [label, malformed] of invalid) {
      await rollback(async tx => {
        await replaceFrozenInput(tx, job, malformed);
        const before = await durableState(tx, job);
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r, label)
          .toMatchObject({ ok: false, code: 'invalid' });
        expect(await durableState(tx, job), label).toEqual(before);
      });
    }
  });

  it('rejects a negative or unsafe job target even when its frozen JSON target matches', async () => {
    const { job } = await preparationAt();
    const { input, result } = await preparedFixture(job);
    for (const target of [-1, 9_007_199_254_740_992]) {
      await rollback(async tx => {
        await tx`alter table private.jobs disable trigger guard_job`;
        await tx`update private.jobs set slot_index=${target},input=${tx.json({ ...input, slotIndex: target } as never)} where id=${job.id}`;
        await tx`alter table private.jobs enable trigger guard_job`;
        const before = await durableState(tx, job);
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r)
          .toMatchObject({ ok: false, code: 'invalid' });
        expect(await durableState(tx, job)).toEqual(before);
      });
    }
  });

  it('requires a boolean exactly matching the frozen count and preserves rejected job state', async () => {
    const { job } = await preparationAt();
    for (const count of [0, 1, 2]) {
      const { input, result } = await preparedFixture(job, count);
      const omitted = { ...result };
      delete omitted.trainingAllowed;
      const invalid = [omitted, ...[null, 'true', 'false', 0, 1, {}, [], count === 2]
        .map(trainingAllowed => ({ ...result, trainingAllowed }))];
      for (const malformed of invalid) {
        await rollback(async tx => {
          await replaceFrozenInput(tx, job, input);
          const before = await durableState(tx, job);
          expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(malformed as never)}) as r`)[0].r)
            .toMatchObject({ ok: false, code: 'invalid' });
          expect(await durableState(tx, job)).toEqual(before);
        });
      }
    }
  });

  it('retains existing preparation validation while adding daily allowance checks', async () => {
    const { job } = await preparationAt();
    const { input, result } = await preparedFixture(job);
    const invalid: [string, unknown][] = [
      ['result null', null], ['result array', []], ['version', { ...result, rulesVersion: 'v1' }],
      ['missing snapshot', { ...result, snapshot: null }], ['missing derived', { ...result, derived: [] }],
      ['costs array', { ...result, costs: [] }], ['extra cost', { ...result, costs: { ...result.costs, other: 0 } }],
      ['numeric cost string', { ...result, costs: { ...result.costs, training: '20' } }],
      ['fractional cost', { ...result, costs: { ...result.costs, training: 20.5 } }],
      ['negative cost', { ...result, costs: { ...result.costs, training: -1 } }],
      ['unsafe cost', { ...result, costs: { ...result.costs, training: 9_007_199_254_740_992 } }],
      ['paid Rest', { ...result, costs: { ...result.costs, rest: 1 } }],
      ['points string', { ...result, trainingPoints: '1' }], ['negative points', { ...result, trainingPoints: -1 }],
      ['fractional points', { ...result, trainingPoints: 0.5 }], ['too many points', { ...result, trainingPoints: 1_000_000_001 }],
      ['zero maximum', { ...result, staminaMaximum: 0 }], ['maximum string', { ...result, staminaMaximum: '104' }],
      ['fractional maximum', { ...result, staminaMaximum: 104.5 }],
      ['build version', { ...result, snapshot: { ...result.snapshot, rulesVersion: 'v1' } }],
      ['build class', { ...result, snapshot: { ...result.snapshot, classId: 'ranger' } }],
      ['build stance', { ...result, snapshot: { ...result.snapshot, stance: 'offensive' } }],
      ['build allocations', { ...result, snapshot: { ...result.snapshot, allocations: {} } }],
      ['equipment', { ...result, snapshot: { ...result.snapshot, equipment: { ...result.snapshot.equipment, weapon: { id: randomUUID() } } } }],
      ['league', { ...result, league: 'diamond' }], ['strength string', { ...result, arenaStrength: '28' }],
      ['negative strength', { ...result, arenaStrength: -1 }], ['strength precision', { ...result, arenaStrength: 28.001 }],
      ['fighter absent', { ...result, arenaFighter: null }],
      ['fighter version', { ...result, arenaFighter: { ...result.arenaFighter, rulesVersion: 'v1' } }],
      ['fighter class', { ...result, arenaFighter: { ...result.arenaFighter, classId: 'ranger' } }],
      ['fighter stance', { ...result, arenaFighter: { ...result.arenaFighter, stance: 'offensive' } }],
      ['template absent', { ...result, npcTemplate: [] }],
      ['template version', { ...result, npcTemplate: { ...result.npcTemplate, rulesVersion: 'v1' } }],
      ['template class', { ...result, npcTemplate: { ...result.npcTemplate, classId: 'guardian' } }],
      ['template stance', { ...result, npcTemplate: { ...result.npcTemplate, stance: 'offensive' } }],
    ];
    for (const [label, malformed] of invalid) {
      await rollback(async tx => {
        await replaceFrozenInput(tx, job, input);
        const before = await durableState(tx, job);
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(malformed as never)}) as r`)[0].r, label)
          .toMatchObject({ ok: false, code: 'invalid' });
        expect(await durableState(tx, job), label).toEqual(before);
      });
    }
  });

  it('revalidates a persisted completed preparation before writing any activity or snapshot', async () => {
    const { owner, token, job } = await preparationAt();
    const { input, result } = await preparedFixture(job);
    const omitted = { ...result };
    delete omitted.trainingAllowed;
    const missingCount: Record<string, unknown> = { ...input };
    delete missingCount.trainingActivitiesEarlierInDay;
    const invalid = [
      { input, result: omitted }, { input, result: { ...result, trainingAllowed: 'true' } },
      { input, result: { ...result, trainingAllowed: false } }, { input: missingCount, result },
      { input: { ...input, trainingActivitiesEarlierInDay: 3 }, result },
      { input: { ...input, slotIndex: 301 }, result },
    ];
    for (const malformed of invalid) {
      await rollback(async tx => {
        await replaceFrozenInput(tx, job, input);
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r).toMatchObject({ ok: true });
        await tx`alter table private.jobs disable trigger guard_job`;
        await tx`update private.jobs set input=${tx.json(malformed.input as never)},result=${tx.json(malformed.result as never)} where id=${job.id}`;
        await tx`alter table private.jobs enable trigger guard_job`;
        const before = await durableState(tx, job);
        // An explicit validation exception must precede gameplay writes, rather than a later cast error.
        await expect(tx.savepoint(sp => sp`select public.advance_boundary(302,${token})`)).rejects.toMatchObject({ code: 'P0001' });
        expect(await durableState(tx, job)).toEqual(before);
        expect(await tx`select id from public.activities where gladiator_id=${owner.gid}`).toEqual([]);
      });
    }
  });

  it('rejects missing or nonboolean persisted v2 snapshot allowance before routing any activity', async () => {
    const { token, job } = await preparationAt();
    const { input, result } = await preparedFixture(job);
    for (const invalid of [undefined, null, 'true', 'false', 0, 1, {}, []]) {
      await rollback(async tx => {
        await replaceFrozenInput(tx, job, input);
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r).toMatchObject({ ok: true });
        // Materialize the genuine phase-5 snapshot, then corrupt only the immutable field under test.
        await tx`select private.boundary_snapshot(302)`;
        const [{ activity_id: aid, snapshot }] = await tx`select activity_id,snapshot from private.activity_snapshots`;
        const malformed = { ...snapshot };
        if (invalid === undefined) delete malformed.trainingAllowed; else malformed.trainingAllowed = invalid;
        await tx`alter table private.activity_snapshots disable trigger guard_frozen`;
        await tx`update private.activity_snapshots set snapshot=${tx.json(malformed)} where activity_id=${aid}`;
        await tx`alter table private.activity_snapshots enable trigger guard_frozen`;
        const before = await durableState(tx, job);
        // Phase 4 has a completed preparation; phase 5 retains the pre-existing snapshot; phase 6 must reject it.
        await expect(tx.savepoint(sp => sp`select public.advance_boundary(302,${token})`)).rejects.toMatchObject({ code: 'P0001' });
        expect(await durableState(tx, job)).toEqual(before);
        expect(await tx`select resolved_kind,stamina_debit::int as debit,debited from public.activities where id=${aid}`)
          .toEqual([{ resolved_kind: null, debit: null, debited: false }]);
      });
    }
  });
});
