import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql, TransactionSql } from 'postgres';
import { sql, account, resetIdentity, admin, creation } from '../fixtures/db.ts';
import { createDatabase, createWorkerDatabase, prepareBuild, prepareShopPurchase } from '../../supabase/functions/_shared/backend/database.ts';
import type { WorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { prepareActivityV1, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { seasonAt } from '../../supabase/functions/_shared/domain/season.ts';
import type { CoordinatorReport, JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

// Task 22.2: robust ticks, season rows and recovery (plan 2026-10-18-task-22-retention-operations, Decisions 6-7 and the
// Review Focus). One world is built once: four characters (two Arena, one expedition, one trainee) checkpointed at slot
// FIRST - 1, with three marketplace listings made through the real command before the pause. Then the service pauses for
// more than two days: no tick and no coordination runs across PAUSE (37) slots. Catch-up is what the scheduler does when it
// resumes, round after round: one minute tick (private.cron_tick, with the scheduler enabled only inside its own transaction
// so pg_cron's real run stays inert) and one worker invocation (runWorker over the real worker adapter). The coordinator (the
// tick's and the worker's coordinate_work) reads "the present" from the session clock stand-in (withClock, the AGENTS.md
// rule); the historical slots' claims, executions and settlements run on the real clock, which is long past them (1970).

const SLOT = RULES_V1.clock.slotMs;
const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEK = RULES_V1.marketplace.expiryMs;
const SUMMARY_MS = RULES_V1.retention.summaryMs;
/** Slot 1000 lies in season 1 (slots 504-1007 at epoch 0): boundary 1008 closes season 1 and opens season 2 during catch-up. */
const FIRST = 1000;
/** Two days are 36 slots; each pause spans 37 boundaries. */
const PAUSE = 37;
const PRESENT = FIRST + PAUSE - 1;
const LATER = PRESENT + PAUSE;
/** Database time ten minutes into `slot`, after its cutoff: "the present" of a catch-up. */
const at = (slot: number) => slot * SLOT + 10 * MINUTE;
/** Listings made before the pause: two expire during it (slots FIRST + 10 and FIRST + 20), one only after both catch-ups. */
const LISTED_EARLY = FIRST * SLOT - WEEK + 10 * SLOT;
const LISTED_LATER = FIRST * SLOT - WEEK + 20 * SLOT;
const LISTED_FRESH = at(FIRST - 1);
const CREATED_AT = LISTED_EARLY - MINUTE;
/** A slot far after the world, in a season (5) with no row: the phase 2 and phase 4 season cases. */
const RATED = 3000;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const commands = createDatabase(admin);
const workerDatabase = createWorkerDatabase(admin);
type Outcome = { ok: boolean; code?: string; [key: string]: unknown };
async function rpc<T = Outcome>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
const nowSlot = () => Math.floor(Date.now() / SLOT);
/** Avoid starting real-clock commands in the final minutes before a shared boundary (they would answer processing). */
async function stableRealSlot(marginMs: number) {
  const remaining = SLOT - (Date.now() % SLOT);
  if (remaining < marginMs) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  return nowSlot();
}
const dbNow = async () => Number((await sql`select private.planning_now_ms()::text as now`)[0].now);
const definitionOf = async (signature: string): Promise<string> =>
  (await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`)[0].definition;

/**
 * Test-only stand-in for the database clock (as tests/db/market.test.ts): a session may pin its own time with the
 * cloudiator.test_now_ms setting, every other session keeps real time. Restored from the definition captured before it was
 * installed and verified byte for byte (AGENTS.md stand-in rule).
 */
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
/** Holds the locks `lock` takes in a second session while `run` executes, then releases them. */
async function holding<T>(lock: (tx: Sql) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  let release!: () => void, ready!: (failure?: unknown) => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<unknown>(resolve => { ready = resolve; });
  const holder = sql.begin(async tx => { await lock(tx); ready(); await released; }).catch(error => { ready(error); throw error; });
  const failure = await locked;
  if (failure) { await holder.catch(() => undefined); throw failure; }
  try { return await run(); } finally { release(); await holder; }
}

type Counts = Record<string, number>;
type Cleanup = {
  ok: true; checkpointSlot: number | null;
  detail: { fromSlot: number | null; throughSlot: number | null; more: boolean; blockedSlot: number | null; deleted: Counts };
  summary: { fromSlot: number | null; throughSlot: number | null; more: boolean; deleted: Counts; compacted: { receipts: number } };
  ledger: { rows: number; gladiators: number; more: boolean };
  market: { expired: number; listings: number; offers: number };
  reservations: number; scheduleRevisions: number;
};
/** One cleanup call at database time `nowMs`, in the caller's transaction (the session clock reads `nowMs` under withClock). */
async function cleanup(tx: Sql, nowMs: number): Promise<Cleanup> {
  await tx.unsafe(`set local cloudiator.test_now_ms = '${nowMs}'`);
  return (await tx`select private.cleanup_history(${nowMs}) as result`)[0].result as Cleanup;
}
/** The seven-day detail of slots lo..hi (as tests/db/retention.test.ts), keyed as cleanup_history reports its deletions. */
async function detailRows(q: Sql, lo: number, hi: number): Promise<Counts> {
  const [row] = await q`
    with a as (select id from public.activities where slot_index between ${lo} and ${hi}),
      b as (select x.battle_id from private.arena_assignments x join private.jobs p on p.id=x.pairing_job_id
        where p.kind='pair' and p.slot_index between ${lo} and ${hi}),
      j as (select id from private.jobs where slot_index between ${lo} and ${hi})
    select (select count(*)::int from public.activity_stages where activity_id in (select id from a)) as "activityStages",
      (select count(*)::int from private.expedition_plans where activity_id in (select id from a)) as "expeditionPlans",
      (select count(*)::int from private.arena_results where battle_id in (select battle_id from b)) as "arenaResults",
      (select count(*)::int from private.arena_assignment_sides where battle_id in (select battle_id from b)) as "arenaAssignmentSides",
      (select count(*)::int from b) as "arenaAssignments",
      (select count(*)::int from private.job_dependencies where job_id in (select id from j) or prerequisite_id in (select id from j)) as "jobDependencies",
      (select count(*)::int from private.job_attempts where job_id in (select id from j)) as "jobAttempts",
      (select count(*)::int from j) as "jobs",
      (select count(*)::int from private.activity_snapshots where activity_id in (select id from a)) as "activitySnapshots",
      (select count(*)::int from private.boundary_members where slot_index between ${lo} and ${hi}) as "boundaryMembers",
      (select count(*)::int from a) as activities,
      (select count(*)::int from public.recent_results where activity_id in (select id from a)) as "recentResults",
      (select count(*)::int from private.boundaries where slot_index between ${lo} and ${hi}) as boundaries`;
  return { ...row } as Counts;
}
/** Characters whose wallet differs from its checkpoint plus its remaining ledger rows (Decision 3's invariant). */
const unreconciled = (q: Sql) => q`select g.id::text from public.gladiators g join public.wallets w on w.gladiator_id=g.id
  left join private.wallet_checkpoints c on c.gladiator_id=g.id
  left join (select l.gladiator_id,sum(l.money_delta) as money,sum(l.renown_delta) as renown from public.wallet_ledger l group by l.gladiator_id) l
    on l.gladiator_id=g.id
  where w.money<>coalesce(c.money,0)+coalesce(l.money,0) or w.renown<>coalesce(c.renown,0)+coalesce(l.renown,0)`;
/** Every settlement receipt and how many of them have exactly one ledger row (spec: one ledger row per receipt). */
const settlementBooks = async (q: Sql) => ({ ...(await q`select count(*)::int as receipts,
  count(*) filter (where (select count(*) from public.wallet_ledger l where l.receipt_id=o.receipt_id)=1)::int as booked
  from public.operation_receipts o where o.request->>'kind'='activity-settlement'`)[0] });
/** Everything a grant can change. */
const grantState = async (q: Sql) => ({ ...(await q`select (select count(*)::int from private.settled_slots) as "settledSlots",
  (select count(*)::int from public.operation_receipts) as receipts, (select count(*)::int from public.wallet_ledger) as ledger,
  (select coalesce(sum(money),0)::float8 from public.wallets) as money, (select coalesce(sum(renown),0)::float8 from public.wallets) as renown,
  (select count(*)::int from public.item_instances) as items, (select count(*)::int from private.season_awards) as awards,
  (select coalesce(sum(earned_points),0)::float8 from public.gladiators) as points, (select coalesce(sum(xp),0)::float8 from public.gladiators) as xp,
  (select coalesce(sum(rating+human_wins+human_losses),0)::float8 from private.arena_ratings) as ratings`)[0] });
type SeasonRow = { index: number; starts: number; ends: number; closed: number | null };
const seasonRows = async (q: Sql) => (await q`select season_index::int as index, starts_at_ms::float8 as starts, ends_at_ms::float8 as ends,
  closed_at_ms::float8 as closed from public.seasons order by season_index`).map(r => ({ ...r }) as SeasonRow);
/** The public.seasons row that seasonAt(slot, epoch) describes, shifted by `shift` slots (the stand-in case). */
function seasonOf(slot: number, closed: number | null = null, shift = 0, epoch = 0): SeasonRow {
  const season = seasonAt(slot, epoch);
  return { index: season.index, starts: season.startsAtMs + shift * SLOT, ends: season.endsAtMs + shift * SLOT, closed };
}

// Operator-only world controls for the isolated local test database; no player API exposes them.
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
/** Real creation, then the operator places the character at the checkpoint FIRST - 1 with its schedule. */
async function fighter(schedule: Choices) {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Pause ' + randomUUID().slice(0, 8)));
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
type Fighter = Awaited<ReturnType<typeof fighter>>;
/** Real creation of a character caught up with real database time, for real-clock commands. */
async function realFighter(prefix: string) {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation(prefix + ' ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw new Error('creation failed');
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    if (error) throw new Error(error.message);
    return data!.state;
  };
  return { ...owner, gid: created.value.gladiatorId, state };
}
type Listed = { listingId: string; itemId: string; seller: Fighter };
/** A tradable shop item (operator inventory setup), then the real create-listing command at database time `atMs`. */
async function listAt(seller: Fighter, catalogId: string, atMs: number): Promise<Listed> {
  const entry = CATALOG_V1.items[catalogId], itemId = randomUUID();
  const item = { id: itemId, ownerId: seller.gid, catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats,
    quantity: 1, origin: 'shop', binding: entry.binding, reservation: null };
  await sql`insert into public.item_instances values(${itemId},${seller.gid},${sql.json(item as never)})`;
  const command = { kind: 'create-listing', operationId: randomUUID(), itemId, price: 40 };
  const listed = await sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${atMs}'`);
    return (await tx`select public.create_listing(${seller.id},${command.operationId},${tx.json({ command, prepared: null } as never)}) as r`)[0].r;
  });
  expect(listed).toMatchObject({ ok: true, value: { expiresAtMs: atMs + WEEK } });
  return { listingId: listed.value.listingId as string, itemId, seller };
}

type Tick = { ok: boolean; coordination: CoordinatorReport; expiry: { ok: boolean; expired?: number };
  dispatch: { ok: boolean; dispatched?: number; reason?: string; code?: string; sqlstate?: string } };
/** One scheduled tick at database time `atMs`: pg_cron's function, with the scheduler enabled only inside this transaction. */
async function tickAt(atMs: number): Promise<Tick> {
  return sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${atMs}'`);
    await tx`update private.scheduler set enabled=true where singleton`;
    const [{ tick }] = await tx`select private.cron_tick() as tick`;
    await tx`update private.scheduler set enabled=false where singleton`;
    return tick as Tick;
  });
}
/** The worker's coordination (coordinate_work as service_role) at database time `atMs`. */
async function coordinateAt(atMs: number): Promise<CoordinatorReport> {
  return sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${atMs}'`);
    await tx`set local role service_role`;
    return (await tx`select public.coordinate_work() as report`)[0].report as CoordinatorReport;
  });
}
type Run = { completed: number[]; ticks: Tick[]; reports: CoordinatorReport[]; problems: unknown[]; rounds: number };
/**
 * The resumed scheduler, round after round until the coordinator has published the slot of `present` and every activity
 * and job is finished: one tick, then one worker invocation (claims, executions and settlements on the real clock; its
 * coordination at `present`). `between` runs after each round with the published slot (the mid-catch-up cleanup case).
 */
async function catchUp(present: number, between?: (published: number) => Promise<void>): Promise<Run> {
  const target = Math.floor(present / SLOT);
  const run: Run = { completed: [], ticks: [], reports: [], problems: [], rounds: 0 };
  // Collected, not thrown: runWorker turns a throwing coordination into 'coordinator-unavailable' and carries on.
  const record = (report: CoordinatorReport) => {
    run.reports.push(report);
    // Bounded catch-up: at most six boundaries per coordination call, and none isolated as failed.
    if (!report.ok || (report.boundaries?.length ?? 0) > 6) run.problems.push(report);
    for (const boundary of report.boundaries ?? []) {
      if (!boundary.ok) run.problems.push(boundary);
      if (boundary.status === 'complete') run.completed.push(boundary.slotIndex!);
    }
  };
  const database: WorkerDatabase = { ...workerDatabase, coordinate: async () => { const report = await coordinateAt(present); record(report); return report; } };
  for (;;) {
    if (run.rounds++ >= 600) throw new Error(`catch-up to slot ${target} did not finish: ${JSON.stringify(run.reports.at(-1))}`);
    const tick = await tickAt(present);
    // No Vault worker secrets: the tick never invokes a real worker, which would coordinate at real time.
    expect(tick, JSON.stringify(tick)).toMatchObject({ ok: true, expiry: { ok: true }, dispatch: { ok: true, dispatched: 0, reason: 'unconfigured' } });
    run.ticks.push(tick);
    record(tick.coordination);
    // Compute budgeting is the worker tests' concern; here an invocation never defers a claimed job.
    const report = await runWorker({ database, workerId: randomUUID(), cpuNow: () => 0 });
    expect(report, JSON.stringify(report)).toMatchObject({ failed: 0, conflicts: 0, unrecorded: 0 });
    expect(run.problems).toEqual([]);
    const [state] = await sql`select (select published_slot::int from private.coordinator) as published,
      (select count(*)::int from public.activities where status<>'completed') as unfinished,
      (select count(*)::int from private.jobs where status<>'completed') as jobs,
      (select count(*)::int from private.jobs where status='operator') as operator`;
    expect(state.operator).toBe(0);
    if (between) await between(state.published);
    if (state.published === target && state.unfinished === 0 && state.jobs === 0) return run;
  }
}

/** Claims and completes every prepare job inside `tx` with the canonical preparation. */
async function prepareAll(tx: Sql) {
  for (;;) {
    const [{ jobs }] = await tx`select public.claim_jobs(${randomUUID()},'prepare',20) as jobs`;
    if (!(jobs as JobLease[]).length) return;
    for (const job of jobs as JobLease[]) {
      expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(prepareActivityV1(job.snapshot as PreparationInput) as never)}) as r`)[0].r)
        .toMatchObject({ ok: true });
    }
  }
}
/**
 * Inside a rollback-only transaction: the operator checkpoints the world's characters at RATED - 1 and removes the launch
 * epoch (TRUNCATE: no trigger is disabled), so boundary RATED runs phase 2 without a season and then waits at phase 4
 * ('epoch'). Returns the boundary step for the next advance.
 */
async function waitForEpochAtPhaseFour(tx: Sql) {
  const token = randomUUID();
  await tx`truncate private.season_epoch`;
  await tx`update private.coordinator set published_slot=${RATED - 1},lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
  await tx`update public.gladiators set processed_slot_index=${RATED - 1} where id in ${tx(world.all.map(f => f.gid))}`;
  const advance = async () => (await tx`select public.advance_boundary(${RATED},${token}) as step`)[0].step as Outcome;
  expect(await advance()).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
  await prepareAll(tx);
  expect(await advance()).toMatchObject({ phase: 4, status: 'waiting', wait: 'epoch' });
  return advance;
}
/** The backfill statement exactly as 14-operations.sql writes it (it runs once, when the source or M16 is applied). */
function backfillStatement(): string {
  const source = readFileSync(new URL('../../supabase/sql/14-operations.sql', import.meta.url), 'utf8');
  const match = /-- Season row backfill \(Decision 7\)[^\n]*\n(?:--[^\n]*\n)*(insert into public\.seasons[\s\S]*?on conflict do nothing;)/.exec(source);
  if (!match) throw new Error('The season row backfill is missing from 14-operations.sql');
  return match[1];
}

let world: { arena: Fighter[]; expedition: Fighter; trainee: Fighter; all: Fighter[]; listings: { early: Listed; later: Listed; fresh: Listed };
  items: Record<string, unknown>[] };
let first: Run;

describe('Task 22.2: robust ticks, season rows and recovery', () => {
  beforeAll(async () => {
    await resetWorld(FIRST - 1);
    expect(await sql`select count(*)::int as n from vault.secrets where name in ('game_worker_url','game_worker_secret')`).toEqual([{ n: 0 }]);
    await withClock(async () => {
      const ARENA = every({ kind: 'arena' });
      const [a, b, expedition, trainee] = await Promise.all([fighter(ARENA), fighter(ARENA),
        fighter(every({ kind: 'expedition', expeditionId: 'woodland' })), fighter(every({ kind: 'training' }))]);
      const listings = { early: await listAt(expedition, 'axe:1:common', LISTED_EARLY), later: await listAt(trainee, 'bow:1:common', LISTED_LATER),
        fresh: await listAt(trainee, 'spear:1:common', LISTED_FRESH) };
      const items = (await sql`select id::text, gladiator_id::text as owner, item from public.item_instances order by id`).map(r => ({ ...r }));
      world = { arena: [a, b], expedition, trainee, all: [a, b, expedition, trainee], listings, items };
      // The pause: nothing ran after boundary FIRST - 1. The service resumes PAUSE slots later.
      first = await catchUp(at(PRESENT));
    });
  }, 900_000);
  afterAll(async () => {
    await resetWorld(null);
    await sql.end();
  });

  it('catches up a service paused for two days in slot order with no duplicate grant', async () => {
    // Every boundary of the pause completed exactly once, in slot order.
    expect(first.completed).toEqual(range(FIRST, PRESENT));
    expect((await sql`select slot_index::int as slot, status from private.boundaries order by slot_index`).map(r => ({ ...r })))
      .toEqual(range(FIRST, PRESENT).map(slot => ({ slot, status: 'complete' })));
    // One settled activity and one settled_slots guard per character and slot.
    const settled = await sql`select a.gladiator_id::text as gid, a.slot_index::int as slot, s.activity_id=a.id as guarded
      from public.activities a left join private.settled_slots s on s.gladiator_id=a.gladiator_id and s.slot_index=a.slot_index
      where a.status='completed' order by 1, 2`;
    expect(settled).toHaveLength(world.all.length * PAUSE);
    expect(settled.every(row => row.guarded)).toBe(true);
    expect(await sql`select count(*)::int as n from private.settled_slots`).toEqual([{ n: world.all.length * PAUSE }]);
    // Settlement ran in slot order: no activity settled before the last settlement of the slot before it.
    const order = await sql`select slot_index::int as slot, min(settled_at_ms)::float8 as first, max(settled_at_ms)::float8 as last
      from public.activities group by 1 order by 1`;
    expect(order.map(row => row.slot)).toEqual(range(FIRST, PRESENT));
    for (let i = 1; i < order.length; i++) expect(order[i].first, `slot ${order[i].slot}`).toBeGreaterThanOrEqual(order[i - 1].last);
    // One receipt and one ledger row per financial settlement; wallets equal their ledger.
    const [{ financial }] = await sql`select count(*)::int as financial from public.activities where resolved_kind in ('expedition','arena','tournament')`;
    expect(financial).toBeGreaterThan(0);
    expect(await settlementBooks(sql)).toEqual({ receipts: financial, booked: financial });
    expect(await sql`select count(*)::int as n from (select request->>'activityId' from public.operation_receipts
      where request->>'kind'='activity-settlement' group by 1 having count(*)>1) x`).toEqual([{ n: 0 }]);
    expect(await unreconciled(sql)).toEqual([]);
    // Season 1 closed once, at boundary 1008, after its last slot settled; season 2 opened with seasonAt's bounds.
    const seasons = await seasonRows(sql);
    expect(seasons).toEqual([seasonOf(FIRST, seasons[0].closed), seasonOf(1008)]);
    expect(seasons[0].closed).toBe(at(PRESENT));
    expect(await sql`select count(*)::int as n from (select gladiator_id from private.season_awards group by season_index, gladiator_id having count(*)>1) x`)
      .toEqual([{ n: 0 }]);
    // Replays grant nothing: another round at the present, a replayed boundary and a lost-response settlement retry.
    const before = await grantState(sql);
    expect((await withClock(() => catchUp(at(PRESENT)))).completed).toEqual([]);
    const token = randomUUID();
    await sql`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
    try {
      expect(await rpc('advance_boundary', { target_slot: FIRST + 5, coordinator_token: token })).toMatchObject({ ok: true, status: 'complete', replayed: true });
    } finally {
      await sql`update private.coordinator set lease_token=null,lease_until_ms=0 where singleton`;
    }
    const [job] = await sql`select activity_id::text as activity, lease_token::text as token from private.jobs j join public.activities a on a.id=j.activity_id
      where j.kind='settlement' and a.resolved_kind='expedition' order by j.slot_index limit 1`;
    expect(await workerDatabase.settle(job.activity, job.token)).toMatchObject({ ok: true, newGrants: 0, replayed: true });
    expect(await grantState(sql)).toEqual(before);
    const [history] = await sql`select (select jsonb_object_agg(k,n) from (select resolved_kind as k,count(*) as n from public.activities group by 1) x) as kinds,
      (select count(*)::int from private.arena_assignments where kind='human') as "humanBattles",
      (select count(*)::int from public.season_standings) as archived, (select count(*)::int from private.season_awards) as awards`;
    console.info(`Task 22.2 catch-up after a ${PAUSE}-slot pause: ${JSON.stringify({ rounds: first.rounds, coordinations: first.reports.length,
      boundaries: first.completed.length, financial, ...history })}`);
  });

  it('sweeps listings that expired during the pause once and returns their items once', async () => {
    const { early, later, fresh } = world.listings;
    // The first tick of the resumed service expired both due listings; no later tick expired anything.
    expect(first.ticks[0].expiry).toEqual({ ok: true, expired: 2 });
    expect(first.ticks.slice(1).map(tick => tick.expiry.expired).filter(n => n !== 0)).toEqual([]);
    const listing = async (id: string) => (await sql`select status, terminal_receipt_id, buyer_gladiator_id from private.market_listings
      where id=${id}`).map(row => ({ ...row }));
    for (const { listingId } of [early, later]) {
      expect(await listing(listingId)).toEqual([{ status: 'expired', terminal_receipt_id: null, buyer_gladiator_id: null }]);
      expect(await sql`select count(*)::int as n from public.market_offers where id=${listingId}`).toEqual([{ n: 0 }]);
    }
    // Each item came back to its seller once: the same single row, released, with nothing else changed.
    const original = (id: string) => world.items.find(row => row.id === id) as { owner: string; item: Record<string, unknown> };
    for (const { itemId, seller } of [early, later]) {
      const rows = (await sql`select gladiator_id::text as owner, item from public.item_instances where id=${itemId}`).map(row => ({ ...row }));
      expect(rows).toEqual([{ owner: seller.gid, item: { ...original(itemId).item, reservation: null } }]);
    }
    // The listing that is not yet due stays open, offered and reserved.
    expect(await listing(fresh.listingId)).toEqual([{ status: 'open', terminal_receipt_id: null, buyer_gladiator_id: null }]);
    expect(await sql`select count(*)::int as n from public.market_offers where id=${fresh.listingId}`).toEqual([{ n: 1 }]);
    expect((await sql`select item->'reservation' as reservation from public.item_instances where id=${fresh.itemId}`)[0].reservation)
      .toEqual({ kind: 'listing', referenceId: fresh.listingId });
    // Sweeping again expires nothing more.
    expect((await sql`select private.expire_listings(${at(PRESENT)}) as n`)[0].n).toBe(0);
    expect(await sql`select count(*)::int as n from private.market_listings where status='expired'`).toEqual([{ n: 2 }]);
  });

  it('keeps everything catch-up still needs when cleanup runs in the middle of a catch-up', () => withClock(async () => {
    // A second pause of PAUSE slots. When the catch-up has published PRESENT + 20, the operator runs cleanup to completion at
    // real database time, which is far more than ninety days after every slot of this world (1970).
    let cut: { checkpoint: number; results: Cleanup[] } | undefined;
    const second = await catchUp(at(LATER), async published => {
      if (cut || published < PRESENT + 20) return;
      const [{ checkpoint }] = await sql`select least(c.published_slot,(select min(processed_slot_index) from public.gladiators))::int as checkpoint
        from private.coordinator c`;
      const horizon = checkpoint - 19;
      // Everything above the horizon (Decision 2: H = P - 19) and every unfinished row, as they are before cleanup.
      const unfinished = async () => ({
        jobs: (await sql`select id::text, status, slot_index::int as slot from private.jobs where status<>'completed' order by id`).map(r => ({ ...r })),
        activities: (await sql`select id::text, status from public.activities where status<>'completed' order by id`).map(r => ({ ...r })),
        boundaries: (await sql`select slot_index::int as slot, phase, status, wait_reason from private.boundaries where status<>'complete'`).map(r => ({ ...r })),
      });
      const kept = { detail: await detailRows(sql, horizon + 1, LATER), unfinished: await unfinished(), grants: await grantState(sql) };
      expect(kept.unfinished.jobs.length + kept.unfinished.activities.length).toBeGreaterThan(0);
      const [{ compactable }] = await sql`select count(*)::int as compactable from public.activities
        where slot_index<=${horizon} and resolved_kind in ('expedition','arena','tournament')`;
      const results: Cleanup[] = [];
      for (let call = 0; call < 40; call++) {
        const [{ result }] = await sql`select private.cleanup_history(private.planning_now_ms()) as result`;
        results.push(result);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, checkpointSlot: checkpoint, detail: { blockedSlot: null } });
        const [state] = await sql`select detail_through_slot::int as detail, summary_through_slot::int as summary from private.retention_state`;
        if (state.detail === horizon && state.summary === horizon) break;
      }
      expect(await sql`select detail_through_slot::int as detail, summary_through_slot::int as summary from private.retention_state`)
        .toEqual([{ detail: horizon, summary: horizon }]);
      // The old slots are pruned: detail, activities, recent results and boundaries; their settlement receipts compacted.
      expect(Object.values(await detailRows(sql, FIRST, horizon)).every(n => n === 0)).toBe(true);
      expect(results.reduce((sum, r) => sum + r.summary.compacted.receipts, 0)).toBe(compactable);
      // Nothing above the horizon, nothing unfinished and no grant changed.
      expect(await detailRows(sql, horizon + 1, LATER)).toEqual(kept.detail);
      expect(await unfinished()).toEqual(kept.unfinished);
      expect(await grantState(sql)).toEqual(kept.grants);
      cut = { checkpoint, results };
    });
    expect(cut).toBeDefined();
    const horizon = cut!.checkpoint - 19;
    // Catch-up then completed in slot order, with every grant guard kept for the pruned slots.
    expect(second.completed).toEqual(range(PRESENT + 1, LATER));
    expect(await sql`select count(*)::int as n from private.settled_slots`).toEqual([{ n: world.all.length * (LATER - FIRST + 1) }]);
    expect(await sql`select min(slot_index)::int as lo, max(slot_index)::int as hi, count(*)::int as n from public.activities where status='completed'`)
      .toEqual([{ lo: horizon + 1, hi: LATER, n: world.all.length * (LATER - horizon) }]);
    const settled = await sql`select a.slot_index::int as slot from public.activities a join private.settled_slots s on s.activity_id=a.id`;
    expect(settled).toHaveLength(world.all.length * (LATER - horizon));
    const books = await settlementBooks(sql);
    expect(books.booked).toBe(books.receipts);
    expect(await unreconciled(sql)).toEqual([]);
    // The swept listings stayed swept: the old terminal rows are gone, their items still with their sellers.
    for (const { itemId, seller } of [world.listings.early, world.listings.later]) {
      expect(await sql`select gladiator_id::text as owner, item->'reservation' as reservation from public.item_instances where id=${itemId}`)
        .toEqual([{ owner: seller.gid, reservation: null }]);
    }
    const sum = (pick: (r: Cleanup) => Counts) => cut!.results.reduce((total, r) => {
      for (const [k, n] of Object.entries(pick(r))) total[k] = (total[k] ?? 0) + n;
      return total;
    }, {} as Counts);
    console.info(`Task 22.2 cleanup in the middle of catch-up: ${JSON.stringify({ checkpoint: cut!.checkpoint, horizon, calls: cut!.results.length,
      rounds: second.rounds, detail: sum(r => r.detail.deleted), summary: sum(r => r.summary.deleted) })}`);
  }), 900_000);

  it('returns the stored receipt for a command retried after ninety days of cleanup and conflict for a changed payload', () => withClock(async () => {
    await stableRealSlot(90_000);
    const owner = await realFighter('Retry');
    // Two real commands at real time: a shop purchase (40 of creation's 100 money, a ledger row), then a build queue (a stance
    // change: no fee) whose fee reservation is consumed when the build applies (a reservation and a zero ledger row).
    const purchase = { kind: 'buy-shop' as const, operationId: randomUUID(), catalogId: 'sword:1:common', catalogVersion: 'v1', quantity: 1 };
    const bought = await commands.inventory({ userId: owner.id }, purchase);
    expect(bought).toMatchObject({ ok: true, value: { moneyDebit: 40 } });
    const state = await owner.state();
    const build = { kind: 'queue-build' as const, operationId: randomUUID(), expectedVersion: state.buildVersion, classId: state.currentBuild.classId,
      stance: 'offensive' as const, allocation: state.currentBuild.allocations, equipment: state.currentBuild.equipment };
    const queued = await commands.plan({ userId: owner.id }, build);
    expect(queued).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    const effective = (queued as { value: { effectiveSlotIndex: number } }).value.effectiveSlotIndex;
    expect(await sql`select private.apply_pending_build(${owner.gid},${effective}) as applied`).toEqual([{ applied: true }]);
    const owned = async (q: Sql) => ({
      wallet: { ...(await q`select money::float8, renown::float8 from public.wallets where gladiator_id=${owner.gid}`)[0] },
      items: (await q`select id::text, item from public.item_instances where gladiator_id=${owner.gid} order by id`).map(r => ({ ...r })),
      reservations: (await q`select operation_id::text, status from public.reservations where gladiator_id=${owner.gid}`).map(r => ({ ...r })),
      receipts: (await q`select operation_id::text, request, result from public.operation_receipts where owner_id=${owner.id} order by operation_id`).map(r => ({ ...r })),
      ledger: (await q`select reason, money_delta::float8 as money from public.wallet_ledger where gladiator_id=${owner.gid} order by reason`).map(r => ({ ...r })),
    });
    const before = await owned(sql);
    expect(before.reservations).toEqual([{ operation_id: build.operationId, status: 'consumed' }]);
    expect(before.ledger.map(row => row.reason)).toEqual(['build', 'creation', 'shop-purchase']);
    await rollback(async tx => {
      // Cleanup ninety days and a day later: the ledger folds into the checkpoint and the consumed fee reservation goes.
      const later = (await dbNow()) + SUMMARY_MS + DAY;
      for (let call = 0; ; call++) {
        expect(call).toBeLessThan(5);
        if (!(await cleanup(tx, later)).ledger.more) break;
      }
      const pruned = await owned(tx);
      expect(pruned.ledger).toEqual([]);
      expect(pruned.reservations).toEqual([]);
      expect(await tx`select money::float8, renown::float8, ledger_rows::int as rows from private.wallet_checkpoints where gladiator_id=${owner.gid}`)
        .toEqual([{ ...before.wallet, rows: 3 }]);
      // Every receipt stays, with its stored result: the replay and conflict guard.
      expect(pruned.receipts).toEqual(before.receipts);
      // The same operations, retried then with the backend's preparation of the current state, replay their receipts.
      const [{ state: current }] = await tx`select state from public.owner_state where owner_id=${owner.id}`;
      const buy = async (command: typeof purchase, prepared: unknown) =>
        (await tx`select public.buy_shop(${owner.id},${command.operationId},${tx.json({ command, prepared } as never)}) as r`)[0].r;
      const queue = async (command: typeof build, prepared: unknown) =>
        (await tx`select public.queue_build(${owner.id},${command.operationId},${tx.json({ command, prepared } as never)}) as r`)[0].r;
      expect(await buy(purchase, prepareShopPurchase(purchase, current))).toEqual(bought);
      expect(await queue(build, prepareBuild(build, current))).toEqual(queued);
      // A changed payload under the same operation is a conflict, never a new grant.
      expect(await buy({ ...purchase, quantity: 2 }, null)).toEqual({ ok: false, code: 'conflict' });
      expect(await queue({ ...build, stance: 'defensive' as never }, null)).toEqual({ ok: false, code: 'conflict' });
      expect(await owned(tx)).toEqual(pruned);
      expect(await unreconciled(tx)).toEqual([]);
    });
  }), 120_000);

  it('records a market-sweep failure for one seller and still expires the others', () => withClock(() => rollback(async tx => {
    const now = await dbNow();
    // One seller whose due listing is inconsistent (its item is gone, so closing it raises) between two whose due listings are
    // sound, in the sweep's seller order (gladiator id): the sweep goes on past the failure.
    const [lowest, lower, higher, highest] = [...world.all].sort((p, q) => (p.gid < q.gid ? -1 : 1));
    const due = async (seller: Fighter, sound: boolean) => {
      const id = randomUUID(), itemId = randomUUID();
      await tx`insert into private.market_listings(id,seller_gladiator_id,item_id,price,listed_at_ms,expires_at_ms,status)
        values(${id},${seller.gid},${itemId},10,${now - WEEK - MINUTE},${now - MINUTE},'open')`;
      if (sound) {
        const [template] = await tx`select item from public.item_instances where gladiator_id=${seller.gid} limit 1`;
        await tx`insert into public.item_instances(id,gladiator_id,item) values(${itemId},${seller.gid},${tx.json({ ...template.item, id: itemId,
          origin: 'shop', reservation: { kind: 'listing', referenceId: id } })})`;
      }
      return { id, itemId };
    };
    const broken = await due(lower, false);
    const sound = [await due(lowest, true), await due(higher, true)];
    const events = async () => (await tx`select source, ok, sqlstate, detail from private.operations_events order by id`).map(row => ({ ...row }));
    const status = async (id: string) => (await tx`select status from private.market_listings where id=${id}`)[0].status;
    const released = async (itemId: string) => (await tx`select item->'reservation' as reservation from public.item_instances where id=${itemId}`)[0].reservation;
    const before = await events();
    expect((await tx`select private.expire_listings(${now}) as n`)[0].n).toBe(2);
    expect([await status(broken.id), ...await Promise.all(sound.map(s => status(s.id)))]).toEqual(['open', 'expired', 'expired']);
    for (const s of sound) expect(await released(s.itemId)).toBeNull();
    // One secret-free event: the failure's SQLSTATE and the number of sellers that failed; never its message or an id.
    expect(await events()).toEqual([...before, { source: 'market-sweep', ok: false, sqlstate: 'P0001', detail: { failedSellers: 1 } }]);
    // The cleanup backstop no longer fails whole on an inconsistent listing: with a second failing seller, it expires the
    // sound listing, records both failures in one event and completes.
    const alsoBroken = await due(highest, false), again = await due(higher, true);
    const result = await cleanup(tx, now);
    expect(result).toMatchObject({ ok: true, market: { expired: 1 } });
    expect([await status(broken.id), await status(alsoBroken.id), await status(again.id)]).toEqual(['open', 'open', 'expired']);
    expect(await released(again.itemId)).toBeNull();
    expect((await events()).slice(before.length + 1)).toEqual([{ source: 'market-sweep', ok: false, sqlstate: 'P0001', detail: { failedSellers: 2 } }]);
  })), 60_000);

  it('keeps the committed coordination when dispatch fails in the same tick', () => withClock(async () => {
    // The next slot's tick: its coordination opens boundary LATER + 1 (waiting for preparation) while dispatch cannot get its
    // lock within the tick's lock timeout (another session holds it), as pg_cron would run it, in its own transaction.
    const next = LATER + 1, tickAtMs = at(next);
    const [{ eventsBefore }] = await sql`select count(*)::int as "eventsBefore" from private.operations_events`;
    const tick = await holding(tx => tx`select pg_advisory_xact_lock(hashtextextended('cloudiator:dispatch',3))`, () => sql.begin(async tx => {
      await tx.unsafe(`set local cloudiator.test_now_ms = '${tickAtMs}'`);
      await tx`set local lock_timeout = '200ms'`;
      await tx`update private.scheduler set enabled=true where singleton`;
      const [{ tick: ran }] = await tx`select private.cron_tick() as tick`;
      await tx`update private.scheduler set enabled=false where singleton`;
      return ran as Tick;
    }));
    expect(tick).toMatchObject({ ok: true, coordination: { ok: true, publishedSlot: LATER, boundaries: [{ ok: true, slotIndex: next, phase: 4,
      status: 'waiting', wait: 'preparation' }] }, expiry: { ok: true, expired: 0 }, dispatch: { ok: false, code: 'dispatch-failed', sqlstate: '55P03' } });
    // Committed, as read by another session: the boundary, its preparation jobs and the dispatch event (SQLSTATE only).
    expect(await sql`select status, phase, wait_reason from private.boundaries where slot_index=${next}`)
      .toEqual([{ status: 'waiting', phase: 4, wait_reason: 'preparation' }]);
    expect(await sql`select count(*)::int as n from private.jobs where kind='prepare' and slot_index=${next}`).toEqual([{ n: world.all.length }]);
    expect((await sql`select at_ms::float8, source, ok, sqlstate, detail from private.operations_events order by id offset ${eventsBefore}`).map(r => ({ ...r })))
      .toEqual([{ at_ms: tickAtMs, source: 'dispatch', ok: false, sqlstate: '55P03', detail: null }]);
    // The next ticks carry on from the committed boundary.
    expect((await catchUp(tickAtMs)).completed).toEqual([next]);
  }), 300_000);

  it('creates a season row in phase 4 when the epoch is set while a boundary waits at phase 4', () => rollback(async tx => {
    const season = seasonAt(RATED, 0).index;
    const advance = await waitForEpochAtPhaseFour(tx);
    // Phase 2 ran before the epoch existed: no season row and no rating row of the season yet.
    expect((await seasonRows(tx)).filter(row => row.index === season)).toEqual([]);
    expect(await tx`select count(*)::int as n from private.arena_ratings where season_index=${season}`).toEqual([{ n: 0 }]);
    await tx`insert into private.season_epoch(singleton,epoch_slot) values(true,0)`;
    expect((await advance()).phase).toBeGreaterThan(4);
    // Phase 4 rated the season and inserted its row with the epoch bounds.
    expect(await tx`select count(*)::int as n from private.arena_ratings where season_index=${season}`).toEqual([{ n: world.all.length }]);
    expect((await seasonRows(tx)).filter(row => row.index === season)).toEqual([seasonOf(RATED)]);
  }), 60_000);

  it('derives phase 2, the backfill and phase 4 season bounds from season_bounds', async () => {
    // The function: seasonAt's bounds from the epoch; no row for a negative index or without an epoch.
    const bounds = async (q: Sql, index: number) => (await q`select starts_at_ms::float8 as starts, ends_at_ms::float8 as ends
      from private.season_bounds(${index})`).map(r => ({ ...r }));
    for (const index of [0, 1, 2, 7]) {
      const season = seasonAt(index * 504, 0);
      expect(await bounds(sql, index)).toEqual([{ starts: season.startsAtMs, ends: season.endsAtMs }]);
    }
    expect(await bounds(sql, -1)).toEqual([]);
    await rollback(async tx => {
      await tx`truncate private.season_epoch`;
      expect(await bounds(tx, 1)).toEqual([]);
      await tx`insert into private.season_epoch(singleton,epoch_slot) values(true,10)`;
      const season = seasonAt(10 + 504, 10);
      expect(await bounds(tx, 1)).toEqual([{ starts: season.startsAtMs, ends: season.endsAtMs }]);
    });
    // Stable (it reads the epoch table), search_path pinned, executed by the boundary's role only.
    expect(await sql`select p.provolatile, p.proconfig, has_function_privilege('service_role',p.oid,'EXECUTE') as service,
      has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') as client
      from pg_proc p where p.oid='private.season_bounds(bigint)'::regprocedure`)
      .toEqual([{ provolatile: 's', proconfig: ['search_path=""'], service: true, client: false }]);
    // Each caller takes its bounds from season_bounds: a rollback-only stand-in shifts every season by one slot.
    const definition = await definitionOf('private.season_bounds(bigint)');
    await rollback(async tx => {
      await tx.unsafe(`create or replace function private.season_bounds(index bigint) returns table(starts_at_ms bigint, ends_at_ms bigint)
        language sql stable security invoker set search_path='' as $stand$
        select (e.epoch_slot+504*season_bounds.index+1)*4800000,(e.epoch_slot+504*(season_bounds.index+1)+1)*4800000
        from private.season_epoch e where e.singleton and season_bounds.index>=0 $stand$`);
      // Phase 2.
      await tx`truncate public.seasons`;
      expect(await tx`select private.boundary_close_season(${RATED}) as wait`).toEqual([{ wait: null }]);
      expect(await seasonRows(tx)).toEqual([seasonOf(RATED, null, 1)]);
      // The backfill, as written in the source: one row per rated season.
      await tx`truncate public.seasons`;
      const rated = (await tx`select distinct season_index::int as season from private.arena_ratings order by 1`).map(row => row.season as number);
      expect(rated.length).toBeGreaterThan(0);
      await tx.unsafe(backfillStatement());
      expect(await seasonRows(tx)).toEqual(rated.map(index => seasonOf(index * 504, null, 1)));
      // Phase 4, once the epoch is set while the boundary waits there.
      await tx`truncate public.seasons`;
      const advance = await waitForEpochAtPhaseFour(tx);
      expect(await seasonRows(tx)).toEqual([]);
      await tx`insert into private.season_epoch(singleton,epoch_slot) values(true,0)`;
      expect((await advance()).phase).toBeGreaterThan(4);
      expect(await seasonRows(tx)).toEqual([seasonOf(RATED, null, 1)]);
    });
    expect(await definitionOf('private.season_bounds(bigint)')).toBe(definition);
  }, 60_000);
});
