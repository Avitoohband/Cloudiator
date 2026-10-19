import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql, TransactionSql } from 'postgres';
import { sql, account, resetIdentity, admin, creation } from '../fixtures/db.ts';
import { recordMeasurement } from '../fixtures/measurements.ts';
import { createDatabase, createWorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import type { WorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import type { CoordinatorReport } from '../../supabase/functions/_shared/domain/types.ts';
import { INVARIANTS } from '../../scripts/restore-compare.mjs';

// Task 22.4: the restore-check world (plan 2026-10-18-task-22-retention-operations, Decision 9). It builds a small real world
// with the existing helpers (real creation, the real create-listing command, pg_cron's tick function and the real worker, as
// tests/db/recovery.test.ts does): four characters (two Arena, one expedition, one trainee) checkpointed at slot FIRST - 1,
// one open marketplace listing, then the scheduler's catch-up through boundary PRESENT, which closes season 1 at boundary
// 1008 and archives its awards. It then runs scripts/restore-invariants.sql against that world: every invariant holds, and
// each invariant reports a violation it is meant to catch (rollback-only transactions).
//
// The world is deliberately LEFT IN PLACE (no reset in afterAll): `npm run test:db -- tests/db/restore-world.test.ts`
// followed by scripts/export-db.ps1 and scripts/restore-check.ps1 is how the restore check got a published boundary, settled
// slots, receipts, ledger rows, items, season awards and an open listing to verify (docs/operations/runbook.md). Every other
// DB test file resets the world before it starts.

const SLOT = RULES_V1.clock.slotMs;
const MINUTE = 60_000;
/** Slot 1000 lies in season 1 (slots 504-1007 at epoch 0): boundary 1008 closes season 1 during catch-up. */
const FIRST = 1000;
const PRESENT = FIRST + 9;
/** Database time ten minutes into `slot`, after its cutoff: "the present" of a catch-up. */
const at = (slot: number) => slot * SLOT + 10 * MINUTE;
const CREATED_AT = (FIRST - 1) * SLOT + 1;

const commands = createDatabase(admin);
const workerDatabase = createWorkerDatabase(admin);
const INVARIANT_SQL = readFileSync(new URL('../../scripts/restore-invariants.sql', import.meta.url), 'utf8');
type Check = { counts: Record<string, number>; invariants: Record<string, { ok: boolean; violations: number }> };
const check = async (q: Sql): Promise<Check> => JSON.parse((await q.unsafe(INVARIANT_SQL))[0].restore_check as string) as Check;
const violations = async (q: Sql) => Object.fromEntries(Object.entries((await check(q)).invariants).map(([name, value]) => [name, value.violations]));
const none = Object.fromEntries(INVARIANTS.map(name => [name, 0]));

const definitionOf = async (signature: string): Promise<string> =>
  (await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`)[0].definition;
/** The session clock stand-in of tests/db/recovery.test.ts, restored byte for byte (AGENTS.md stand-in rule). */
async function withClock<T>(run: () => Promise<T>): Promise<T> {
  const definition = await definitionOf('private.planning_now_ms()');
  try {
    await sql.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path=''
      as $clock$ select coalesce(nullif(current_setting('cloudiator.test_now_ms', true),'')::bigint, floor(extract(epoch from clock_timestamp())*1000)::bigint) $clock$`);
    return await run();
  } finally {
    await sql.unsafe(definition);
    expect(await definitionOf('private.planning_now_ms()')).toBe(definition);
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

async function resetWorld(published: number | null) {
  await resetIdentity();
  await sql`truncate private.boundaries, private.boundary_work, private.dispatch_log`;
  await sql`update private.coordinator set published_slot=${published}, lease_token=null, lease_until_ms=0, last_error=null,
    last_failed_slot=null where singleton`;
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`delete from private.rules_versions where version<>'v1'`;
  await sql`update private.rules_versions set active=true where version='v1'`;
  await sql`update private.scheduler set enabled=false where singleton`;
}
type Choices = { morning: unknown; afternoon: unknown; evening: unknown };
const every = (choice: unknown): Choices => ({ morning: choice, afternoon: choice, evening: choice });
async function fighter(schedule: Choices) {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Restore ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId;
  await sql`update public.gladiators set created_at_ms=${CREATED_AT},orientation_end_ms=${FIRST * SLOT},processed_slot_index=${FIRST - 1}
    where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${CREATED_AT},effective_slot_index=${FIRST},choice=${sql.json(schedule[phase] as never)}
      where gladiator_id=${gid} and phase=${phase}`;
  }
  return { ...owner, gid };
}
/** A tradable shop item (operator inventory setup), then the real create-listing command at database time `atMs`. */
async function listAt(seller: { id: string; gid: string }, catalogId: string, atMs: number) {
  const entry = CATALOG_V1.items[catalogId], itemId = randomUUID();
  const item = { id: itemId, ownerId: seller.gid, catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats,
    quantity: 1, origin: 'shop', binding: entry.binding, reservation: null };
  await sql`insert into public.item_instances values(${itemId},${seller.gid},${sql.json(item as never)})`;
  const command = { kind: 'create-listing', operationId: randomUUID(), itemId, price: 40 };
  const listed = await sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${atMs}'`);
    return (await tx`select public.create_listing(${seller.id},${command.operationId},${tx.json({ command, prepared: null } as never)}) as r`)[0].r;
  });
  expect(listed).toMatchObject({ ok: true });
  return itemId;
}
/** One scheduled tick at database time `atMs`: pg_cron's function, with the scheduler enabled only inside this transaction. */
async function tickAt(atMs: number) {
  return sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${atMs}'`);
    await tx`update private.scheduler set enabled=true where singleton`;
    const [{ tick }] = await tx`select private.cron_tick() as tick`;
    await tx`update private.scheduler set enabled=false where singleton`;
    return tick as { ok: boolean; coordination: CoordinatorReport };
  });
}
async function coordinateAt(atMs: number): Promise<CoordinatorReport> {
  return sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${atMs}'`);
    await tx`set local role service_role`;
    return (await tx`select public.coordinate_work() as report`)[0].report as CoordinatorReport;
  });
}
/** The resumed scheduler, round after round, until boundary PRESENT is published and every activity and job is finished. */
async function catchUp(present: number) {
  const target = Math.floor(present / SLOT);
  const database: WorkerDatabase = { ...workerDatabase, coordinate: () => coordinateAt(present) };
  for (let round = 0; ; round++) {
    if (round >= 300) throw new Error(`catch-up to slot ${target} did not finish`);
    expect(await tickAt(present)).toMatchObject({ ok: true });
    expect(await runWorker({ database, workerId: randomUUID(), cpuNow: () => 0 })).toMatchObject({ failed: 0, conflicts: 0, unrecorded: 0 });
    const [state] = await sql`select (select published_slot::int from private.coordinator) as published,
      (select count(*)::int from public.activities where status<>'completed') as unfinished,
      (select count(*)::int from private.jobs where status<>'completed') as jobs,
      (select count(*)::int from private.jobs where status='operator') as operator`;
    expect(state.operator).toBe(0);
    if (state.published === target && state.unfinished === 0 && state.jobs === 0) return;
  }
}

let world: { gids: string[]; listedItem: string };

describe('Task 22.4: the restore-check world and its invariants', () => {
  beforeAll(async () => {
    await resetWorld(FIRST - 1);
    await withClock(async () => {
      const ARENA = every({ kind: 'arena' });
      const all = await Promise.all([fighter(ARENA), fighter(ARENA), fighter(every({ kind: 'expedition', expeditionId: 'woodland' })),
        fighter(every({ kind: 'training' }))]);
      const listedItem = await listAt(all[3], 'spear:1:common', at(FIRST - 1));
      world = { gids: all.map(f => f.gid), listedItem };
      await catchUp(at(PRESENT));
    });
  }, 900_000);
  // No reset: the world stays for the export and restore check (see the header). Only the connection pool closes.
  afterAll(async () => { await sql.end(); });

  it('publishes boundary PRESENT with settled slots, receipts, ledger rows, season awards and an open listing, lease released', async () => {
    const [state] = await sql`select (select published_slot::int from private.coordinator) as published,
      (select lease_token is null and lease_until_ms=0 from private.coordinator) as released,
      (select count(*)::int from private.settled_slots) as settled, (select count(*)::int from public.operation_receipts) as receipts,
      (select count(*)::int from public.wallet_ledger) as ledger, (select count(*)::int from public.item_instances) as items,
      (select count(*)::int from private.season_awards) as awards,
      (select count(*)::int from private.market_listings where status='open' and item_id=${world.listedItem}) as listed`;
    expect(state).toMatchObject({ published: PRESENT, released: true, settled: world.gids.length * (PRESENT - FIRST + 1), listed: 1 });
    expect(state.receipts).toBeGreaterThan(world.gids.length);
    expect(state.ledger).toBeGreaterThan(world.gids.length);
    expect(state.awards).toBeGreaterThan(0);
    recordMeasurement('Task 22.4 restore-check world', state);
  });

  it('holds every invariant on the real world and counts every public and private table plus auth.users', async () => {
    const result = await check(sql);
    expect(Object.keys(result.invariants).sort()).toEqual([...INVARIANTS].sort());
    expect(await violations(sql)).toEqual(none);
    const [{ tables }] = await sql`select array_agg(n.nspname||'.'||c.relname order by 1)::text[] as tables from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')`;
    expect(Object.keys(result.counts).sort()).toEqual([...(tables as string[]), 'auth.users'].sort());
    expect(result.counts['public.gladiators']).toBe(world.gids.length);
    expect(result.counts['private.settled_slots']).toBe(world.gids.length * (PRESENT - FIRST + 1));
  });

  it('reports a wallet that differs from its checkpoint plus its ledger, with and without a checkpoint', () => rollback(async tx => {
    const [gid] = world.gids;
    await tx`update public.wallets set money=money+1 where gladiator_id=${gid}`;
    expect((await violations(tx)).walletReconciliation).toBe(1);
    await tx`update public.wallets set money=money-1 where gladiator_id=${gid}`;
    // A fold as cleanup_history does it: the ledger rows move into the checkpoint, and the books still balance.
    await tx`insert into private.wallet_checkpoints(gladiator_id,money,renown,ledger_rows,folded_through,updated_at_ms)
      select gladiator_id,sum(money_delta),sum(renown_delta),count(*),max(created_at),0 from public.wallet_ledger where gladiator_id=${gid} group by 1`;
    await tx`delete from public.wallet_ledger where gladiator_id=${gid}`;
    expect(await violations(tx)).toEqual(none);
    await tx`update private.wallet_checkpoints set money=money+1,ledger_rows=ledger_rows+1 where gladiator_id=${gid}`;
    expect((await violations(tx)).walletReconciliation).toBe(1);
  }));

  it('reports a lost grant guard, an orphan, an over-full inventory, a stray listing and a disabled guard', () => rollback(async tx => {
    // The data load runs with session_replication_role=replica, so neither guards nor foreign keys stop a damaged copy.
    await tx`set local session_replication_role = replica`;
    const [gid, other] = world.gids;
    await tx`delete from private.settled_slots where ctid=(select ctid from private.settled_slots where gladiator_id=${gid} limit 1)`;
    expect(await violations(tx)).toMatchObject({ completedActivitiesGuarded: 1, settledSlotsUnique: 0 });
    const orphan = randomUUID();
    const [moved] = await tx`update public.item_instances set gladiator_id=${orphan},item=jsonb_set(item,'{ownerId}',to_jsonb(${orphan}::text))
      where id=(select id from public.item_instances where gladiator_id=${other} and id<>${world.listedItem} order by id limit 1) returning id`;
    expect(moved).toBeDefined();
    expect((await violations(tx)).foreignKeys).toBeGreaterThan(0);
    await tx`update public.item_instances set gladiator_id=${other},item=jsonb_set(item,'{ownerId}',to_jsonb(${other}::text))
      where id=${world.listedItem}`;
    expect((await violations(tx)).itemsSingleOwner).toBe(1);
    const [{ held }] = await tx`select count(*)::int as held from public.item_instances where gladiator_id=${gid}`;
    const template = (await tx`select item from public.item_instances where gladiator_id=${gid} limit 1`)[0].item as Record<string, unknown>;
    for (let i = held; i <= 60; i++) {
      const id = randomUUID();
      await tx`insert into public.item_instances values(${id},${gid},${tx.json({ ...template, id, ownerId: gid } as never)})`;
    }
    expect((await violations(tx)).inventoryCap).toBe(1);
    await tx`alter table private.settled_slots disable trigger guard_frozen`;
    expect((await violations(tx)).guardsIntact).toBe(1);
  }));
});
