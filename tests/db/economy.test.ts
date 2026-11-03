import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { sql, admin, account, anonymous, resetIdentity, creation, request, makeLegacyPending } from '../fixtures/db.ts';
import { SLOT, TRAINING, TTR, resetWorld, fighter as boundaryFighter, coordinatorLease, advance, runBoundary,
  settleDue, claim, completePreparations, rpc } from '../fixtures/boundary.ts';
import { createDatabase, prepareCreation, prepareBuild, prepareItemSale, prepareListingPurchase } from '../../supabase/functions/_shared/backend/database.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { DEFAULT_EXECUTORS } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { JobLease, PreparationInput, PreparationResult } from '../../supabase/functions/_shared/domain/types.ts';
import type { OwnerState, ItemInstance } from '../../supabase/functions/_shared/contracts/reads.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';

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

// Task 5: owner-only activation. Independent reserved sessions expose the real transaction boundaries;
// no function replacement, trigger hook, clock stand-in or Data API automatic retry drives these races.
type SwitchResult = { ok: true; version: 'v2'; switchedAtMs: number; walletsScanned: number; walletsCut: number;
  moneyBefore: number; moneyAfter: number; replayed: boolean };
type SwitchSession = { q: Awaited<ReturnType<typeof sql.reserve>>; pid: number; pending: Set<Promise<unknown>>;
  failure?: { error: unknown } };
type EconomyFighter = Awaited<ReturnType<typeof fighter>>;
async function withSwitchSessions<T>(count: number, run: (sessions: SwitchSession[]) => Promise<T>,
  isolation: 'read committed' | 'read uncommitted' | 'repeatable read' | 'serializable' = 'read committed'): Promise<T> {
  const sessions: SwitchSession[] = [];
  try {
    for (let n = 0; n < count; n++) {
      const q = await sql.reserve();
      const session: SwitchSession = { q, pid: 0, pending: new Set() };
      sessions.push(session);
      // The isolation level must precede even the pg_backend_pid SELECT used to identify this session.
      await q.unsafe(`begin isolation level ${isolation}`);
      await q`set local statement_timeout='20s'`;
      await q`set local lock_timeout='15s'`;
      session.pid = (await q`select pg_backend_pid() as pid`)[0].pid;
    }
    return await run(sessions);
  } finally {
    // Cancel all outstanding statements before awaiting any one session: cleanup must not itself
    // wait behind a holder whose rollback is queued later in this array.
    await Promise.all(sessions.filter(s => s.pending.size > 0 && s.pid !== 0)
      .map(s => sql`select pg_cancel_backend(${s.pid})`.catch(() => undefined)));
    await Promise.all(sessions.flatMap(s => [...s.pending].map(p => p.catch(() => undefined))));
    await Promise.all(sessions.map(async s => { try { await s.q`rollback`; } finally { s.q.release(); } }));
  }
}
function startSwitchQuery<T>(session: SwitchSession, query: PromiseLike<T>): Promise<T> {
  const result = Promise.resolve(query);
  session.failure = undefined;
  session.pending.add(result);
  void result.then(() => session.pending.delete(result), error => {
    session.failure = { error };
    session.pending.delete(result);
  });
  return result;
}
async function blockedBy(contender: SwitchSession, holder: SwitchSession) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [{ blocked }] = await sql`select ${holder.pid}::int=any(pg_blocking_pids(${contender.pid})) as blocked`;
    if (blocked) return;
    if (!contender.pending.size) {
      if (contender.failure) throw contender.failure.error;
      throw new Error(`backend ${contender.pid} finished before the required lock barrier`);
    }
    // Poll spacing only; the assertion is database blocker evidence, never elapsed time.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (contender.failure) throw contender.failure.error;
  throw new Error(`backend ${contender.pid} did not block on ${holder.pid}`);
}
async function populationLock(session: SwitchSession, mode: 'ShareLock' | 'ExclusiveLock', granted: boolean) {
  expect(await sql`select mode,granted from pg_locks where pid=${session.pid} and locktype='advisory'
    and classid=1600001::oid and objid=1::oid and objsubid=2`).toEqual([{ mode, granted }]);
}
const switchNow = async (): Promise<SwitchResult> => (await sql`select private.switch_to_economy_v2() as r`)[0].r;
const startSwitch = (s: SwitchSession) => startSwitchQuery(s, s.q<{ r: SwitchResult }[]>`select private.switch_to_economy_v2() as r`.execute());
const walletMoney = async (gid: string) => Number((await sql`select money::text from public.wallets where gladiator_id=${gid}`)[0].money);
const databaseNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::text as ms`)[0].ms);
const ownerState = async (owner: EconomyFighter): Promise<OwnerState> => {
  const { data, error } = await owner.client.from('owner_state').select('state').single();
  expect(error).toBeNull();
  return data!.state;
};
async function currentAccounts(owners: EconomyFighter[]) {
  // Both participants must pass the real processing guard; historical boundary fighters do not.
  for (const owner of owners) await sql`update public.gladiators
    set processed_slot_index=floor(extract(epoch from clock_timestamp())*1000/4800000) where id=${owner.gid}`;
}
async function orderedFighters(money = 100) {
  const owners = [await fighter(), await fighter()].sort((a, b) => a.gid.localeCompare(b.gid));
  for (const owner of owners) await sql`update public.wallets set money=${money} where gladiator_id=${owner.gid}`;
  await currentAccounts(owners);
  return owners;
}
async function extraSword(owner: EconomyFighter) {
  const entry = CATALOG_V1.items['sword:1:common'], id = randomUUID();
  const item: ItemInstance = { id, ownerId: owner.gid, catalogId: entry.id, catalogVersion: 'v1', tier: entry.tier,
    rarity: entry.rarity, stats: entry.stats, quantity: 1, origin: 'shop', binding: entry.binding, reservation: null };
  await sql`insert into public.item_instances(id,gladiator_id,item) values(${id},${owner.gid},${sql.json(item as never)})`;
  return item;
}
async function npcSale(owner: EconomyFighter) {
  const item = await extraSword(owner);
  const command = { kind: 'sell-item' as const, operationId: randomUUID(), itemId: item.id, quantity: 1 };
  const prepared = prepareItemSale(command, await ownerState(owner));
  expect(prepared).not.toBeNull();
  return { command, input: { command, prepared }, credit: prepared!.unitValue };
}
async function heldBuild(owner: EconomyFighter, fee = 40) {
  const state = await ownerState(owner);
  const command: Extract<GameCommand, { kind: 'queue-build' }> = { kind: 'queue-build', operationId: randomUUID(),
    expectedVersion: state.buildVersion, classId: state.currentBuild.classId, stance: 'offensive',
    allocation: state.currentBuild.allocations, equipment: state.currentBuild.equipment };
  const input = { command, prepared: prepareBuild(command, state) };
  expect((await sql`select public.queue_build(${owner.id},${command.operationId},${sql.json(input as never)}) as r`)[0].r)
    .toMatchObject({ ok: true, value: { reservedMoney: 0 } });
  // A paid pending fee is legacy state, not a command that current clients can newly queue.
  await makeLegacyPending(sql, owner.gid, command.operationId, { fee });
  const queued = await ownerState(owner);
  return { command, effectiveSlot: queued.pendingBuild!.effectiveSlotIndex,
    cancel: { kind: 'cancel-build' as const, operationId: randomUUID(), expectedVersion: queued.buildVersion } };
}
const cutRows = async () => (await sql`select r.gladiator_id::text as gid,r.owner_id::text as owner,r.receipt_id::text as receipt,
  r.request,r.result,encode(r.request_digest,'hex') as digest,
  encode(sha256(convert_to('economy-cut:v2:'||r.gladiator_id::text,'UTF8')),'hex') as expected_digest
  from public.operation_receipts r where r.request->>'kind'='economy-cut' order by r.gladiator_id`).map(row => ({ ...row }));
async function reconcileSwitch(result: SwitchResult) {
  const audit = await sql`select version,switched_at_ms::float8 as at,wallets_scanned as scanned,wallets_cut as cut,
    money_before::float8 as before,money_after::float8 as after,result from private.economy_switches`;
  expect(audit).toEqual([{ version: 'v2', at: result.switchedAtMs, scanned: result.walletsScanned, cut: result.walletsCut,
    before: result.moneyBefore, after: result.moneyAfter, result: { ...result, replayed: false } }]);
  const receipts = await cutRows();
  const ledger = await sql`select gladiator_id::text as gid,receipt_id::text as receipt,money_delta::float8 as money,
    renown_delta::float8 as renown from public.wallet_ledger where reason='economy-cut' order by gladiator_id`;
  expect(receipts).toHaveLength(result.walletsCut);
  expect(ledger).toHaveLength(result.walletsCut);
  expect(new Set(receipts.map(r => r.receipt)).size).toBe(result.walletsCut);
  expect(new Set(receipts.map(r => r.gid)).size).toBe(result.walletsCut);
  for (const receipt of receipts) {
    expect(receipt.request).toEqual({ kind: 'economy-cut', version: 'v2' });
    expect(receipt.digest).toBe(receipt.expected_digest);
    expect(receipt.result).toEqual({ moneyBefore: expect.any(Number), moneyAfter: expect.any(Number), cut: expect.any(Number) });
    expect(receipt.result.cut).toBeGreaterThan(0);
    expect(receipt.result.moneyBefore - receipt.result.moneyAfter).toBe(receipt.result.cut);
    expect(ledger.filter(l => l.receipt === receipt.receipt)).toEqual([
      { gid: receipt.gid, receipt: receipt.receipt, money: -receipt.result.cut, renown: 0 },
    ]);
    expect((await sql`select owner_id::text as owner from public.gladiators where id=${receipt.gid}`)[0].owner).toBe(receipt.owner);
  }
  expect(ledger.reduce((total, row) => total + row.money, 0)).toBe(result.moneyAfter - result.moneyBefore);
  expect(await sql`select private.active_rules_version() as version`).toEqual([{ version: 'v2' }]);
  expect((await revision()).rules_version).toBe('v2');
}
async function switchFootprint() {
  // Stable committed columns only: public.world_revision contains a live clock, unsuitable for equality.
  const [{ auditExists }] = await sql`select to_regclass('private.economy_switches') is not null as "auditExists"`;
  return {
    wallets: (await sql`select * from public.wallets order by gladiator_id`).map(r => ({ ...r })),
    receipts: (await sql`select * from public.operation_receipts order by receipt_id`).map(r => ({ ...r })),
    ledger: (await sql`select * from public.wallet_ledger order by id`).map(r => ({ ...r })),
    rules: (await sql`select * from private.rules_versions order by version`).map(r => ({ ...r })),
    mirror: (await sql`select * from public.world_revision_state`).map(r => ({ ...r })),
    actors: (await sql`select * from public.world_actors order by gladiator_id`).map(r => ({ ...r })),
    reservations: (await sql`select * from public.reservations order by gladiator_id,operation_id`).map(r => ({ ...r })),
    profiles: (await sql`select * from public.public_profile_reads order by gladiator_id`).map(r => ({ ...r })),
    audit: auditExists ? (await sql`select * from private.economy_switches order by version`).map(r => ({ ...r })) : [],
  };
}
async function switchPrecheck() {
  const source = readFileSync(new URL('../../scripts/economy-switch-check.sql', import.meta.url), 'utf8');
  const rows = await sql.unsafe(source);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(Object.keys(row).sort()).toEqual(['active_version', 'checked_at_ms', 'copy_matches', 'held', 'money_after_cut',
    'money_now', 'open_boundary', 'switched', 'v2_row', 'wallets'].sort());
  return { ...row, checked_at_ms: Number(row.checked_at_ms), open_boundary: Number(row.open_boundary),
    wallets: Number(row.wallets), money_now: Number(row.money_now), money_after_cut: Number(row.money_after_cut), held: Number(row.held) };
}
// Capture before mutation when available; assert its presence after the switch call so an unimplemented
// switch reports its own SQL RED before this separate, not-yet-authored script. The dedicated script case stays strict.
const captureSwitchPrecheck = () => existsSync(new URL('../../scripts/economy-switch-check.sql', import.meta.url))
  ? switchPrecheck() : Promise.resolve(null);

describe('the economy switch', () => {
  beforeEach(() => resetWorld(null));
  afterEach(async () => {
    // Missing Task 5 schema must stay an honest RED; cleanup must not manufacture it or mask the failure.
    if ((await sql`select to_regclass('private.economy_switches') is not null as present`)[0].present) {
      await sql`delete from private.economy_switches`;
    }
  });

  async function sevenWallets() {
    const owners: EconomyFighter[] = [];
    for (const money of [0, 1, 3, 4, 5, 100, 5601]) {
      const owner = await fighter();
      await sql`update public.wallets set money=${money} where gladiator_id=${owner.gid}`;
      owners.push(owner);
    }
    return owners;
  }

  it('cuts every wallet to a quarter rounded up and switches to v2', async () => {
    const owners = await sevenWallets(), before = await revision(), earliest = await databaseNow();
    const result = await switchNow(), latest = await databaseNow();
    expect(result).toEqual({ ok: true, version: 'v2', switchedAtMs: expect.any(Number), walletsScanned: 7,
      walletsCut: 5, moneyBefore: 5714, moneyAfter: 1431, replayed: false });
    expect(result.switchedAtMs).toBeGreaterThanOrEqual(earliest);
    expect(result.switchedAtMs).toBeLessThanOrEqual(latest);
    expect(await Promise.all(owners.map(owner => walletMoney(owner.gid)))).toEqual([0, 1, 1, 1, 2, 25, 1401]);
    expect((await sql`select money_delta::int as money from public.wallet_ledger where reason='economy-cut' order by money_delta`)
      .map(r => r.money)).toEqual([-4200, -75, -3, -3, -2]);
    expect(Number((await revision()).revision.split(':')[0])).toBeGreaterThan(Number(before.revision.split(':')[0]));
    await reconcileSwitch(result);
  });

  it('publishes a zero-cut activation and counts every scanned wallet', async () => {
    const owners = [await fighter(), await fighter()];
    await sql`update public.wallets set money=0 where gladiator_id=${owners[0].gid}`;
    await sql`update public.wallets set money=1 where gladiator_id=${owners[1].gid}`;
    const before = await revision();
    const result = await switchNow();
    expect(result).toMatchObject({ walletsScanned: 2, walletsCut: 0, moneyBefore: 1, moneyAfter: 1 });
    await reconcileSwitch(result);
    expect(Number((await revision()).revision.split(':')[0])).toBeGreaterThan(Number(before.revision.split(':')[0]));
  });

  it('keeps the gold held for a queued fee and consumes that fee exactly once', async () => {
    const owner = await fighter(), queued = await heldBuild(owner);
    const check = await captureSwitchPrecheck();
    const result = await switchNow();
    expect(check, 'the precheck must exist once the switch is implemented').not.toBeNull();
    expect(check).toMatchObject({ money_now: 100, money_after_cut: 55, held: 40, wallets: 1 });
    expect(result).toMatchObject({ walletsScanned: 1, walletsCut: 1, moneyBefore: 100, moneyAfter: 55 });
    expect(await walletMoney(owner.gid)).toBe(55);
    expect(await sql`select money::int,status from public.reservations where operation_id=${queued.command.operationId}`)
      .toEqual([{ money: 40, status: 'held' }]);
    expect(await sql`select private.apply_pending_build(${owner.gid},${queued.effectiveSlot}) as applied`).toEqual([{ applied: true }]);
    expect(await sql`select private.apply_pending_build(${owner.gid},${queued.effectiveSlot}) as applied`).toEqual([{ applied: false }]);
    expect(await walletMoney(owner.gid)).toBe(15);
    expect(await sql`select money::int,status from public.reservations where operation_id=${queued.command.operationId}`)
      .toEqual([{ money: 40, status: 'consumed' }]);
    expect(await sql`select l.money_delta::int as money from public.wallet_ledger l join public.operation_receipts r using(receipt_id)
      where r.operation_id=${queued.command.operationId} and l.reason='build'`).toEqual([{ money: -40 }]);
    await reconcileSwitch(result);
  });

  it('replays without a second cut, including wallets created after activation', async () => {
    await sevenWallets();
    const result = await switchNow(), newcomer = await fighter(), before = await switchFootprint();
    expect(await switchNow()).toEqual({ ...result, replayed: true });
    expect(await switchFootprint()).toEqual(before);
    expect(await walletMoney(newcomer.gid)).toBe(100);
    await reconcileSwitch(result);
  });

  it('refuses with an open boundary', async () => {
    await resetWorld(299);
    await boundaryFighter();
    const token = await coordinatorLease();
    expect(await advance(300, token)).toMatchObject({ wait: 'preparation' });
    const before = await switchFootprint();
    await expect(switchNow()).rejects.toMatchObject({ code: '55000', message: 'open boundary' });
    expect(await switchFootprint()).toEqual(before);
  });

  it('refuses unless v1 is active', async () => {
    await fighter();
    await activate('v2');
    const before = await switchFootprint();
    await expect(switchNow()).rejects.toMatchObject({ code: '55000', message: 'unexpected rules version' });
    expect(await switchFootprint()).toEqual(before);
  });

  it('refuses when the retained v2 row is missing', async () => {
    await fighter();
    const before = await switchFootprint();
    await rollback(async tx => {
      await tx`delete from private.rules_versions where version='v2'`;
      await expect(tx.savepoint(sp => sp`select private.switch_to_economy_v2()`))
        .rejects.toMatchObject({ code: '55000', message: 'missing v2' });
      expect(await tx`select version from private.rules_versions where active`).toEqual([{ version: 'v1' }]);
      expect(await tx`select * from private.economy_switches`).toEqual([]);
    });
    expect(await switchFootprint()).toEqual(before);
  });

  it.each(['read uncommitted', 'repeatable read', 'serializable'] as const)(
    'rejects %s activation without changing any state', async isolation => {
      await fighter();
      const before = await switchFootprint();
      await withSwitchSessions(1, async ([s]) => {
        await s.q`select count(*) from public.wallets`;
        await expect(s.q`select private.switch_to_economy_v2()`)
          .rejects.toMatchObject({ code: '55000', message: 'unsupported transaction isolation' });
      }, isolation);
      expect(await switchFootprint()).toEqual(before);
    });

  it("is the owner's alone", async () => {
    const owner = await fighter(), before = await switchFootprint();
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      await rollback(async tx => {
        await tx.unsafe(`set local role ${role}`);
        if (role === 'authenticated') await tx`select set_config('request.jwt.claim.sub',${owner.id},true)`;
        await expect(tx.savepoint(sp => sp`select private.switch_to_economy_v2()`)).rejects.toMatchObject({ code: '42501' });
        await expect(tx.savepoint(sp => sp`select * from private.economy_switches`)).rejects.toMatchObject({ code: '42501' });
      });
    }
    expect(await sql`select p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname='switch_to_economy_v2'`).toEqual([{ prosecdef: false, proconfig: ['search_path=""'] }]);
    expect(await sql`select relrowsecurity as rls from pg_class where oid='private.economy_switches'::regclass`).toEqual([{ rls: true }]);
    // Include PUBLIC's inherited privileges, not only direct grants on named backend roles.
    expect(await sql`select a.grantee::text as grantee from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid='private.switch_to_economy_v2()'::regprocedure and a.grantee<>p.proowner`).toEqual([]);
    expect(await sql`select a.grantee::text as grantee from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid='private.economy_switches'::regclass and a.grantee<>c.relowner`).toEqual([]);
    expect(await switchFootprint()).toEqual(before);
  });

  it('holds the coordinator while it runs', async () => {
    await fighter();
    expect(await sql`select lease_token,lease_until_ms::int from private.coordinator`).toEqual([{ lease_token: null, lease_until_ms: 0 }]);
    const before = await switchFootprint();
    await withSwitchSessions(1, async ([s]) => {
      expect((await s.q`select private.switch_to_economy_v2() as r`)[0].r).toMatchObject({ ok: true });
      expect((await sql`select public.coordinate_work() as r`)[0].r).toMatchObject({ ok: true, busy: true });
      expect((await revision()).rules_version).toBe('v1');
    });
    expect(await switchFootprint()).toEqual(before);
  });

  it('reports the timestamped aggregate-only pre-check', async () => {
    await sevenWallets();
    const before = await switchFootprint(), earliest = await databaseNow();
    const check = await switchPrecheck();
    expect(check).toEqual({ checked_at_ms: expect.any(Number), open_boundary: 0, active_version: 'v1', v2_row: true,
      switched: false, wallets: 7, money_now: 5714, money_after_cut: 1431, held: 0, copy_matches: true });
    expect(check.checked_at_ms).toBeGreaterThanOrEqual(earliest);
    expect(check.checked_at_ms).toBeLessThanOrEqual(await databaseNow());
    expect(await switchFootprint()).toEqual(before);
  });

  it.each(['commit', 'rollback'] as const)('drains an in-flight guarded creator on %s', async ending => {
    const owner = await account(), command = creation('Fence ' + randomUUID().slice(0, 8));
    await withSwitchSessions(2, async ([creator, activation]) => {
      const input = prepareCreation(command);
      const created = (await creator.q`select public.create_gladiator(${owner.id},${command.operationId},${creator.q.json(input as never)}) as r`)[0].r;
      expect(created).toMatchObject({ ok: true });
      const gid = created.value.gladiatorId as string;
      expect(await creator.q`select money::int from public.wallets where gladiator_id=${gid}`).toEqual([{ money: 100 }]);
      await populationLock(creator, 'ShareLock', true);
      const switching = startSwitch(activation);
      await blockedBy(activation, creator);
      await populationLock(activation, 'ExclusiveLock', false);
      if (ending === 'commit') await creator.q`commit`; else await creator.q`rollback`;
      const result = (await switching)[0].r;
      await activation.q`commit`;
      expect(result).toMatchObject(ending === 'commit'
        ? { walletsScanned: 1, walletsCut: 1, moneyBefore: 100, moneyAfter: 25 }
        : { walletsScanned: 0, walletsCut: 0, moneyBefore: 0, moneyAfter: 0 });
      expect(await sql`select money::int from public.wallets where gladiator_id=${gid}`)
        .toEqual(ending === 'commit' ? [{ money: 25 }] : []);
      expect(await sql`select receipt_id from public.operation_receipts where operation_id=${command.operationId}`)
        .toHaveLength(ending === 'commit' ? 1 : 0);
      await reconcileSwitch(result);
    });
  }, 45_000);

  it.each(['commit', 'rollback'] as const)('orders a new creator after switch %s', async ending => {
    const existing = await fighter(), newcomer = await account(), command = creation('After ' + randomUUID().slice(0, 8));
    const before = await switchFootprint();
    await withSwitchSessions(3, async ([holder, activation, creator]) => {
      await holder.q`select pg_advisory_xact_lock(hashtextextended(${existing.id}::text,0))`;
      const switching = startSwitch(activation);
      await blockedBy(activation, holder);
      await populationLock(activation, 'ExclusiveLock', true);
      const creating = startSwitchQuery(creator, creator.q`select public.create_gladiator(${newcomer.id},${command.operationId},
        ${creator.q.json(prepareCreation(command) as never)}) as r`.execute());
      await blockedBy(creator, activation);
      await populationLock(creator, 'ShareLock', false);
      expect(await sql`select count(*)::int as n from pg_locks where pid=${creator.pid} and locktype='advisory' and granted`).toEqual([{ n: 0 }]);
      expect(await sql`select id from public.gladiators where owner_id=${newcomer.id}`).toEqual([]);
      await holder.q`commit`;
      const result = (await switching)[0].r;
      if (ending === 'commit') await activation.q`commit`; else await activation.q`rollback`;
      const created = (await creating)[0].r;
      expect(created).toMatchObject({ ok: true });
      // The new creator has not committed yet, so rollback equality can include every original receipt/projection.
      if (ending === 'rollback') expect(await switchFootprint()).toEqual(before);
      await creator.q`commit`;
      const gid = created.value.gladiatorId as string;
      expect(await walletMoney(gid)).toBe(100);
      expect(await sql`select money_delta::int as money,reason from public.wallet_ledger where gladiator_id=${gid}`)
        .toEqual([{ money: 100, reason: 'creation' }]);
      expect(await walletMoney(existing.gid)).toBe(ending === 'commit' ? 25 : 100);
      if (ending === 'commit') {
        expect(result).toMatchObject({ walletsScanned: 1, walletsCut: 1 });
        await reconcileSwitch(result);
      } else {
        expect(await sql`select * from private.economy_switches`).toEqual([]);
        expect((await revision()).rules_version).toBe('v1');
      }
    });
  }, 45_000);

  it('rereads both money and held after a later account lock wait', async () => {
    const [low, high] = await orderedFighters(), queued = await heldBuild(high), sale = await npcSale(high);
    await withSwitchSessions(2, async ([command, activation]) => {
      // An earlier real command owns the later account before enumeration. Its writes happen only after
      // the switch has reached that wait, exposing both a stale money cursor and a stale held aggregate.
      await command.q`select pg_advisory_xact_lock(hashtextextended(${high.id}::text,0))`;
      const switching = startSwitch(activation);
      await blockedBy(activation, command);
      expect((await command.q`select public.sell_item(${high.id},${sale.command.operationId},${command.q.json(sale.input as never)}) as r`)[0].r)
        .toMatchObject({ ok: true, value: { moneyCredit: sale.credit } });
      const cancelInput = { command: queued.cancel, prepared: null };
      expect((await command.q`select public.cancel_build(${high.id},${queued.cancel.operationId},${command.q.json(cancelInput as never)}) as r`)[0].r)
        .toMatchObject({ ok: true });
      // The deferred publication must be free to commit while switch waits on this account.
      await command.q`commit`;
      const result = (await switching)[0].r;
      await activation.q`commit`;
      expect(await walletMoney(low.gid)).toBe(25);
      expect(await walletMoney(high.gid)).toBe(Math.ceil((100 + sale.credit) / 4));
      expect(result.moneyBefore).toBe(200 + sale.credit);
      expect((await cutRows()).find(r => r.gid === high.gid)!.result.moneyBefore).toBe(100 + sale.credit);
      expect(await sql`select status from public.reservations where operation_id=${queued.command.operationId}`).toEqual([{ status: 'refunded' }]);
      await reconcileSwitch(result);
    });
  }, 45_000);

  it.each(['before', 'after'] as const)('orders fee cancellation %s the cut', async order => {
    const [low, high] = await orderedFighters(), queued = await heldBuild(high);
    await withSwitchSessions(3, async ([holder, activation, cancellation]) => {
      await holder.q`select pg_advisory_xact_lock(hashtextextended(${high.id}::text,0))`;
      const switching = startSwitch(activation);
      await blockedBy(activation, holder);
      const input = { command: queued.cancel, prepared: null };
      if (order === 'before') {
        expect((await holder.q`select public.cancel_build(${high.id},${queued.cancel.operationId},${holder.q.json(input as never)}) as r`)[0].r)
          .toMatchObject({ ok: true });
      }
      await holder.q`commit`;
      const result = (await switching)[0].r;
      let cancelling: Promise<unknown> | undefined;
      if (order === 'after') {
        cancelling = startSwitchQuery(cancellation, cancellation.q`select public.cancel_build(${high.id},${queued.cancel.operationId},
          ${cancellation.q.json(input as never)}) as r`.execute());
        await blockedBy(cancellation, activation);
      }
      await activation.q`commit`;
      if (cancelling) {
        expect(await cancelling).toMatchObject([{ r: { ok: true } }]);
        await cancellation.q`commit`;
      }
      expect(await walletMoney(low.gid)).toBe(25);
      expect(await walletMoney(high.gid)).toBe(order === 'before' ? 25 : 55);
      expect(await sql`select money::int,status from public.reservations where operation_id=${queued.command.operationId}`)
        .toEqual([{ money: 40, status: 'refunded' }]);
      await reconcileSwitch(result);
    });
  }, 45_000);

  it.each(['lower sells', 'higher sells'] as const)('orders both market directions with switch: %s', async direction => {
    const [low, high] = await orderedFighters(1000);
    const [seller, buyer] = direction === 'lower sells' ? [low, high] : [high, low];
    const item = await extraSword(seller), sale = await npcSale(high);
    const listing = await database.market({ userId: seller.id }, { kind: 'create-listing', operationId: randomUUID(), itemId: item.id, price: 30 });
    expect(listing).toMatchObject({ ok: true });
    if (!listing.ok || !('listingId' in listing.value)) throw new Error('listing fixture failed');
    const listingId = listing.value.listingId;
    const buy = { kind: 'buy-listing' as const, operationId: randomUUID(), listingId };
    const input = { command: buy, prepared: prepareListingPurchase(await ownerState(buyer), item) };
    await currentAccounts([low, high]);
    await withSwitchSessions(3, async ([earlier, activation, market]) => {
      expect((await earlier.q`select public.sell_item(${high.id},${sale.command.operationId},${earlier.q.json(sale.input as never)}) as r`)[0].r)
        .toMatchObject({ ok: true });
      const switching = startSwitch(activation);
      await blockedBy(activation, earlier);
      const purchasing = startSwitchQuery(market, market.q`select public.buy_listing(${buyer.id},${buy.operationId},${market.q.json(input as never)}) as r`.execute());
      await blockedBy(market, activation);
      expect(await sql`select count(*)::int as n from pg_locks where pid=${market.pid} and locktype='advisory' and granted`).toEqual([{ n: 0 }]);
      expect(await sql`select status,buyer_gladiator_id from private.market_listings where id=${listingId}`)
        .toEqual([{ status: 'open', buyer_gladiator_id: null }]);
      expect(await sql`select receipt_id from public.operation_receipts where operation_id=${buy.operationId}`).toEqual([]);
      expect(await sql`select * from public.wallet_ledger where reason in ('market-purchase','market-sale','economy-cut')`).toEqual([]);
      await earlier.q`commit`;
      const result = (await switching)[0].r;
      await activation.q`commit`;
      const purchased = (await purchasing)[0].r;
      expect(purchased).toMatchObject({ ok: true, value: { listingId, itemId: item.id, price: 30, fee: 1 } });
      await market.q`commit`;
      const cutMoney = (owner: EconomyFighter) => Math.ceil((1000 + (owner.gid === high.gid ? sale.credit : 0)) / 4);
      expect(await walletMoney(buyer.gid)).toBe(cutMoney(buyer) - 30);
      expect(await walletMoney(seller.gid)).toBe(cutMoney(seller) + 29);
      expect(await sql`select gladiator_id::text as owner,item->>'ownerId' as item_owner,item->'reservation' as reservation
        from public.item_instances where id=${item.id}`).toEqual([{ owner: buyer.gid, item_owner: buyer.gid, reservation: null }]);
      expect(await sql`select status,buyer_gladiator_id::text as buyer,terminal_receipt_id::text as receipt
        from private.market_listings where id=${listingId}`).toEqual([{ status: 'sold', buyer: buyer.gid, receipt: purchased.receiptId }]);
      expect(await sql`select l.money_delta::int as money,l.reason,r.receipt_id::text as receipt from public.wallet_ledger l
        join public.operation_receipts r using(receipt_id) where r.operation_id=${buy.operationId}`)
        .toEqual([{ money: -30, reason: 'market-purchase', receipt: purchased.receiptId }]);
      expect(await sql`select l.money_delta::int as money,l.reason,r.gladiator_id::text as gid from public.wallet_ledger l
        join public.operation_receipts r using(receipt_id) where r.request->>'kind'='market-sale' and r.request->>'listingId'=${listingId}`)
        .toEqual([{ money: 29, reason: 'market-sale', gid: seller.gid }]);
      const beforeReplay = await switchFootprint();
      expect((await sql`select public.buy_listing(${buyer.id},${buy.operationId},${sql.json(input as never)}) as r`)[0].r).toEqual(purchased);
      expect(await switchFootprint()).toEqual(beforeReplay);
      expect(result.moneyBefore).toBe(2000 + sale.credit);
      await reconcileSwitch(result);
    });
  }, 45_000);

  it('rolls back every side effect after late cancellation, then permits one deliberate call', async () => {
    const [low, high] = await orderedFighters(), before = await switchFootprint();
    await withSwitchSessions(4, async ([holder, activation, accountProbe, walletProbe]) => {
      await holder.q`select pg_advisory_xact_lock(hashtextextended(${high.id}::text,0))`;
      const switching = startSwitch(activation);
      await blockedBy(activation, holder);
      const accountWait = startSwitchQuery(accountProbe,
        accountProbe.q`select pg_advisory_xact_lock(hashtextextended(${low.id}::text,0))`.execute());
      const walletWait = startSwitchQuery(walletProbe,
        walletProbe.q`select money from public.wallets where gladiator_id=${low.gid} for update`.execute());
      await blockedBy(accountProbe, activation);
      await blockedBy(walletProbe, activation);
      expect(await sql`select pg_cancel_backend(${activation.pid}) as cancelled`).toEqual([{ cancelled: true }]);
      await expect(switching).rejects.toMatchObject({ code: '57014' });
      await activation.q`rollback`;
      await accountWait;
      await walletWait;
      await holder.q`rollback`;
    });
    expect(await switchFootprint()).toEqual(before);
    const result = await switchNow();
    expect(result).toMatchObject({ walletsScanned: 2, walletsCut: 2, moneyBefore: 200, moneyAfter: 50, replayed: false });
    await reconcileSwitch(result);
    const newcomer = await fighter(), committed = await switchFootprint();
    expect(await switchNow()).toEqual({ ...result, replayed: true });
    expect(await switchFootprint()).toEqual(committed);
    expect(await walletMoney(newcomer.gid)).toBe(100);
  }, 45_000);

  it('reconciles committed audit despite wallet changes around precheck', async () => {
    const owner = await fighter(), sale = await npcSale(owner), check = await captureSwitchPrecheck();
    expect(await database.inventory({ userId: owner.id }, sale.command)).toMatchObject({ ok: true, value: { moneyCredit: sale.credit } });
    const result = await switchNow();
    expect(check, 'the precheck must exist once the switch is implemented').not.toBeNull();
    expect(check).toMatchObject({ money_now: 100 });
    expect(result.moneyBefore).toBe(100 + sale.credit);
    expect(result.moneyBefore).not.toBe(check!.money_now);
    expect(result.moneyAfter).toBe(Math.ceil((100 + sale.credit) / 4));
    await reconcileSwitch(result);
    const historicalReceipts = await cutRows(), after = await npcSale(owner);
    expect(await database.inventory({ userId: owner.id }, after.command)).toMatchObject({ ok: true });
    expect(await walletMoney(owner.gid)).toBe(result.moneyAfter + after.credit);
    expect(await cutRows()).toEqual(historicalReceipts);
    await reconcileSwitch(result);
  });

  it('settles a v1 activity on v1 after the switch', async () => {
    await resetWorld(299);
    const expedition = { kind: 'expedition', expeditionId: 'outpost' };
    const traveler = await boundaryFighter({ schedule: { morning: expedition, afternoon: { kind: 'rest' }, evening: { kind: 'rest' } } });
    const trainee = await boundaryFighter({ schedule: TRAINING });
    // Strong, legitimate operator fixture; the actual boundary freezes and worker executes the retained rules.
    await sql`update public.gladiators set level=5,earned_points=300,unspent_points=105 where id=${traveler.gid}`;
    await sql`update public.builds set current_build=jsonb_set(current_build,'{allocations}',
      '{"strength":150,"agility":5,"vitality":30,"endurance":5,"precision":5}') where gladiator_id=${traveler.gid}`;
    await sql`update public.gladiators set earned_points=94,unspent_points=84 where id=${trainee.gid}`;
    const item = CATALOG_V1.items['sword:1:common'];
    const template = { catalogId: item.id, catalogVersion: 'v1', tier: 1, rarity: 'common', stats: item.stats,
      quantity: 1, origin: 'shop', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances(id,gladiator_id,item) select x.id,${traveler.gid},
      ${sql.json(template)}::jsonb||jsonb_build_object('id',x.id,'ownerId',${traveler.gid}::text)
      from (select gen_random_uuid() as id from generate_series(1,58)) x`;
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    expect(await sql`select rules_version from private.boundaries where slot_index=300`).toEqual([{ rules_version: 'v1' }]);
    expect(await sql`select count(*)::int as n from public.item_instances where gladiator_id=${traveler.gid}`).toEqual([{ n: 60 }]);
    expect(await sql`select * from private.settled_slots where slot_index=300`).toEqual([]);
    await switchNow();
    // Reveal chains need several worker rounds, but there is no clock manipulation or retry of activation.
    let settled = false;
    for (let round = 0; round < 14; round++) {
      await settleDue(300, token);
      settled = (await sql`select count(*)::int as n from private.settled_slots where slot_index=300`)[0].n === 2;
      if (settled) break;
    }
    expect(settled).toBe(true);
    const summary = (await activityRows(traveler.gid))[0].summary;
    expect(summary).toMatchObject({ success: true, rewards: { xp: 250, money: 60,
      overflow: expect.arrayContaining([expect.objectContaining({ catalogId: 'salvage', quantity: 2, unitValue: 10, money: 20 })]) } });
    expect(await walletMoney(traveler.gid)).toBe(25 + 60 + summary.rewards.overflowMoney);
    expect(await trainee.row()).toMatchObject({ earned: 95 });
    expect(await runBoundary(301, token)).toMatchObject({ status: 'complete' });
    expect(await sql`select rules_version from private.boundaries where slot_index=301`).toEqual([{ rules_version: 'v2' }]);
    expect(await sql`select distinct rules_version from private.jobs where slot_index=301`).toEqual([{ rules_version: 'v2' }]);
    await settleDue(301, token);
    expect(await trainee.row()).toMatchObject({ earned: 95 });
    expect(await sql`select resolved_kind from private.settled_slots where gladiator_id=${trainee.gid} and slot_index=301`)
      .toEqual([{ resolved_kind: 'training' }]);
    expect((await activityRows(trainee.gid)).at(-1)).toMatchObject({ slot: 301, version: 'v2', resolved: 'training',
      status: 'completed', summary: { resolvedKind: 'training', result: 'completed', success: true, rewards: { attributePoints: 0 } } });
  }, 60_000);
});

describe('selling salvage', () => {
  type Sale = Extract<GameCommand, { kind: 'sell-item' }>;

  beforeEach(() => resetWorld(null));
  afterEach(async () => { await sql`delete from private.economy_switches`; });

  async function addSalvage(owner: EconomyFighter, quantity: number) {
    const entry = CATALOG_V1.salvage, id = randomUUID();
    const item: ItemInstance = { id, ownerId: owner.gid, catalogId: entry.id, catalogVersion: CATALOG_V1.version,
      tier: entry.tier, rarity: entry.rarity, stats: entry.stats, quantity, origin: 'expedition', binding: entry.binding, reservation: null };
    await sql`insert into public.item_instances(id,gladiator_id,item) values(${id},${owner.gid},${sql.json(item as never)})`;
    return item;
  }

  const sell = (itemId: string, quantity = 3): Sale => ({ kind: 'sell-item', operationId: randomUUID(), itemId, quantity });
  const prepared = (unitValue: number) => ({ catalogId: CATALOG_V1.salvage.id, catalogVersion: CATALOG_V1.version, unitValue });
  const send = (owner: EconomyFighter, command: Sale) => handleCommand(request(owner.token, command), {
    database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'],
  });
  async function rawSale(owner: EconomyFighter, command: Sale, preparation: unknown) {
    const { data, error } = await admin.rpc('sell_item', {
      actor_id: owner.id, operation_id: command.operationId, input: { command, prepared: preparation },
    });
    expect(error).toBeNull();
    return data;
  }

  async function saleState(owner: EconomyFighter, q = sql) {
    return {
      items: await q`select id,item from public.item_instances where gladiator_id=${owner.gid} order by id`,
      wallet: await q`select money::int,renown::int from public.wallets where gladiator_id=${owner.gid}`,
      ledger: await q`select receipt_id,money_delta::int,renown_delta::int,reason from public.wallet_ledger
        where gladiator_id=${owner.gid} order by id`,
      receipts: await q`select operation_id,receipt_id,request,result from public.operation_receipts
        where owner_id=${owner.id} order by operation_id`,
    };
  }

  it('sells salvage for the active rules value and keeps gear pricing under both versions', async () => {
    const owner = await fighter(), stack = await addSalvage(owner, 6);
    const gearPrice = CATALOG_V1.items['sword:1:common'].npcSellValue;
    if (gearPrice === null) throw new Error('The test sword must be sellable');
    const credits = new Map<string, number>();
    for (const [version, credit, remaining] of [['v1', 30, 3], ['v2', 12, 0]] as const) {
      if (version === 'v2') await activate(version);
      expect((await revision()).rules_version).toBe(version);
      const response = await send(owner, sell(stack.id));
      expect(response.status).toBe(200);
      const sale = await response.json();
      expect(sale).toMatchObject({ ok: true, receiptId: expect.any(String), value: {
        itemId: stack.id, quantity: 3, remainingQuantity: remaining, moneyCredit: credit,
      } });
      credits.set(sale.receiptId, credit);
      const gear = await extraSword(owner);
      const gearResponse = await send(owner, sell(gear.id, 1));
      expect(gearResponse.status).toBe(200);
      const gearSale = await gearResponse.json();
      expect(gearSale).toMatchObject({ ok: true, receiptId: expect.any(String), value: { moneyCredit: gearPrice } });
      credits.set(gearSale.receiptId, gearPrice);
    }
    const state = await saleState(owner);
    expect(state.items.some(row => row.id === stack.id)).toBe(false);
    expect(state.wallet).toEqual([{ money: 142 + 2 * gearPrice, renown: 0 }]);
    const saleRows = state.ledger.filter(row => row.reason === 'npc-sale');
    expect(saleRows).toHaveLength(4);
    expect(new Map(saleRows.map(row => [row.receipt_id, row.money_delta]))).toEqual(credits);
  });

  it('accepts the unstamped migration-first v1 preparation and replays its receipt after activation', async () => {
    const owner = await fighter(), stack = await addSalvage(owner, 3), command = sell(stack.id);
    const original = await rawSale(owner, command, prepared(10));
    expect(original).toEqual({ ok: true, receiptId: expect.any(String), value: {
      itemId: stack.id, quantity: 3, remainingQuantity: 0, moneyCredit: 30,
    } });
    expect(await walletMoney(owner.gid)).toBe(130);
    expect(await switchNow()).toMatchObject({ ok: true, moneyBefore: 130, moneyAfter: 33 });
    const afterSwitch = await saleState(owner);
    expect(await rawSale(owner, command, { ...prepared(10), rulesVersion: 'v1' })).toEqual(original);
    expect(await rawSale(owner, command, null)).toEqual(original);
    expect(await saleState(owner)).toEqual(afterSwitch);
  });

  it.each([
    ['legacy v1 at the wrong price', 'v1', prepared(4)],
    ['stamped v2 at the wrong price', 'v2', { ...prepared(10), rulesVersion: 'v2' }],
    ['stamped v2 with a fractional price', 'v2', { ...prepared(4.5), rulesVersion: 'v2' }],
    // Casting first would round 4.1 to the canonical v2 price.
    ['stamped v2 with a fractional price that rounds to four', 'v2', { ...prepared(4.1), rulesVersion: 'v2' }],
    ['stamped v2 with a string price', 'v2', { ...prepared(4), unitValue: '4', rulesVersion: 'v2' }],
    ['unsupported rules stamp at the canonical v2 price', 'v2', { ...prepared(4), rulesVersion: 'v3' }],
    ['explicit null stamp under v1', 'v1', { ...prepared(10), rulesVersion: null }],
  ] as const)('rejects a new sale with %s without changing inventory or gold', async (_, version, preparation) => {
    const owner = await fighter(), stack = await addSalvage(owner, 3);
    if (version === 'v2') await activate(version);
    const before = await saleState(owner);
    expect(await rawSale(owner, sell(stack.id), preparation)).toEqual({ ok: false, code: 'invalid' });
    const after = await saleState(owner);
    expect({ items: after.items, wallet: after.wallet, ledger: after.ledger })
      .toEqual({ items: before.items, wallet: before.wallet, ledger: before.ledger });
  });

  it.each([
    ['an unstamped preparation', prepared(4)],
    ['a stale v1 stamp', { ...prepared(4), rulesVersion: 'v1' }],
  ] as const)('leaves %s retryable at the canonical v2 price', async (_, preparation) => {
    const owner = await fighter(), stack = await addSalvage(owner, 3);
    await activate('v2');
    const before = await saleState(owner);
    expect(await rawSale(owner, sell(stack.id), preparation)).toEqual({ ok: false, code: 'unavailable' });
    expect(await saleState(owner)).toEqual(before);
  });

  it('waits for the real switch, then retries the stale operation once at the v2 price', async () => {
    const owner = await fighter(), stack = await addSalvage(owner, 4), command = sell(stack.id);
    const input = { command, prepared: { ...prepared(10), rulesVersion: 'v1' } };
    await withSwitchSessions(2, async ([activation, seller]) => {
      expect((await startSwitch(activation))[0].r).toMatchObject({ ok: true, version: 'v2', moneyBefore: 100, moneyAfter: 25 });
      expect((await revision()).rules_version).toBe('v1');
      await seller.q`set local role service_role`;
      const sale = startSwitchQuery(seller, seller.q`select public.sell_item(${owner.id},${command.operationId},
        ${seller.q.json(input)}) as r`.execute());
      await blockedBy(seller, activation);
      // Check the contender waits on the one-bigint account guard held by this switch, not a row or table lock.
      expect(await sql`select count(*)::int as n from pg_locks waiting join pg_locks held
        on held.locktype=waiting.locktype and held.database=waiting.database and held.classid=waiting.classid
          and held.objid=waiting.objid and held.objsubid=waiting.objsubid
        where waiting.pid=${seller.pid} and not waiting.granted and held.pid=${activation.pid} and held.granted
          and waiting.locktype='advisory' and waiting.objsubid=1`).toEqual([{ n: 1 }]);
      const afterCut = await saleState(owner, activation.q);
      expect(afterCut.wallet).toEqual([{ money: 25, renown: 0 }]);
      expect(afterCut.receipts.some(row => row.operation_id === command.operationId)).toBe(false);
      await activation.q`commit`;
      const [{ r }] = await sale;
      await seller.q`commit`;
      expect(r).toEqual({ ok: false, code: 'unavailable' });
      expect(await saleState(owner)).toEqual(afterCut);
    });

    expect((await revision()).rules_version).toBe('v2');
    const response = await send(owner, command);
    expect(response.status).toBe(200);
    const applied = await response.json();
    expect(applied).toEqual({ ok: true, receiptId: expect.any(String), value: {
      itemId: stack.id, quantity: 3, remainingQuantity: 1, moneyCredit: 12,
    } });
    const afterRetry = await saleState(owner);
    expect(afterRetry.wallet).toEqual([{ money: 37, renown: 0 }]);
    expect(afterRetry.items.find(row => row.id === stack.id)?.item.quantity).toBe(1);
    expect(afterRetry.ledger.filter(row => row.reason === 'npc-sale')).toEqual([
      { receipt_id: applied.receiptId, money_delta: 12, renown_delta: 0, reason: 'npc-sale' },
    ]);
    expect(afterRetry.receipts.filter(row => row.operation_id === command.operationId)).toEqual([
      { operation_id: command.operationId, receipt_id: applied.receiptId, request: command, result: applied },
    ]);
    const replay = await send(owner, command);
    expect([replay.status, await replay.json()]).toEqual([200, applied]);
    expect(await saleState(owner)).toEqual(afterRetry);
  }, 45_000);
});

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
