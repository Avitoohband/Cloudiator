import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { sql, account, resetIdentity, admin, anonymous, creation } from '../fixtures/db.ts';
import { createDatabase, createWorkerDatabase, prepareGrant } from '../../supabase/functions/_shared/backend/database.ts';
import { DEFAULT_EXECUTORS, prepareActivityV1 } from '../../supabase/functions/_shared/backend/jobs.ts';
import { applyXp } from '../../supabase/functions/_shared/domain/inventory.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

// Task 22.1: retention in the database (plan 2026-10-18-task-22-retention-operations, Decisions 2-5 and the retention design).
// One real history is built once: slots 300-302 (1970) through real boundaries, the canonical v1 executors and fenced jobs,
// with an expedition, a trainee, regular Arena and, on the tournament slot 301, a three-entrant bracket. Every activity is
// settled at its own minute 80 under a session clock, so its replay is 'available' for seven days, as on a live server.
// Each case then ages that history inside a rollback-only transaction: the operator moves the checkpoint (the coordinator's
// published slot and every character's processed slot) and calls private.cleanup_history at a database time. Times in 1970
// need no clock stand-in; a time after the real clock uses the session clock stand-in (withClock, the AGENTS.md rule).

const SLOT = 4_800_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const REPLAY_MS = RULES_V1.retention.replayMs;
const SUMMARY_MS = RULES_V1.retention.summaryMs;
const FIRST = 300;
/** Slot 301 starts on Saturday 1970-01-17 at 17:20 UTC, a v1 tournament slot. */
const TOURNAMENT = 301;
const LAST = 302;
/** Database times seven and ninety days after the last history slot ended. */
const SEVEN_DAYS_LATER = (LAST + 1) * SLOT + REPLAY_MS;
const NINETY_DAYS_LATER = (LAST + 1) * SLOT + SUMMARY_MS;

const commands = createDatabase(admin);
const worker = createWorkerDatabase(admin);
type Outcome = { ok: boolean; code?: string; [key: string]: unknown };
async function rpc<T = Outcome>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
const claim = (kind: string, limit = 20) => rpc<JobLease[]>('claim_jobs', { worker_id: randomUUID(), kind, batch_limit: limit });
const complete = (job: JobLease, result: unknown) => rpc('complete_job', { job_id: job.id, lease_token: job.token, result });
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
  ok: true; nowMs: number; publishedSlot: number | null; checkpointSlot: number | null; durationMs: number;
  replay: { flipped: number; durationMs: number };
  detail: { fromSlot: number | null; throughSlot: number | null; more: boolean; blockedSlot: number | null; deleted: Counts;
    compacted: { tournamentBoutResults: number }; durationMs: number };
  summary: { fromSlot: number | null; throughSlot: number | null; more: boolean; deleted: Counts; compacted: { receipts: number }; durationMs: number };
  ledger: { rows: number; gladiators: number; more: boolean };
  market: { expired: number; listings: number; offers: number };
  reservations: number; scheduleRevisions: number;
  operational: { commandAttempts: number; dispatchLog: number; operationsEvents: number; cronRunDetails: number | { ok: false; sqlstate: string } };
};
/** One cleanup call at database time `nowMs`, in the caller's transaction (the session clock reads `nowMs` under withClock). */
async function cleanup(tx: Sql, nowMs: number): Promise<Cleanup> {
  await tx.unsafe(`set local cloudiator.test_now_ms = '${nowMs}'`);
  return (await tx`select private.cleanup_history(${nowMs}) as result`)[0].result as Cleanup;
}
/** Every count a call reports, flattened (durations, times and slots excluded). */
function countsOf(result: Cleanup): number[] {
  const cron = result.operational.cronRunDetails;
  return [result.replay.flipped, ...Object.values(result.detail.deleted), result.detail.compacted.tournamentBoutResults,
    ...Object.values(result.summary.deleted), result.summary.compacted.receipts, result.ledger.rows, result.ledger.gladiators,
    result.market.expired, result.market.listings, result.market.offers, result.reservations, result.scheduleRevisions,
    result.operational.commandAttempts, result.operational.dispatchLog, result.operational.operationsEvents, typeof cron === 'number' ? cron : -1];
}
/** Operator-only world control: the checkpoint P = least(published slot, every character's processed slot). */
async function checkpoint(tx: Sql, slot: number) {
  await tx`update private.coordinator set published_slot=${slot} where singleton`;
  await tx`update public.gladiators set processed_slot_index=${slot}`;
}

/** The seven-day detail of slots lo..hi, keyed as cleanup_history reports its deletions. */
async function detailRows(q: Sql, lo: number, hi: number): Promise<Counts> {
  const [row] = await q`
    with a as (select id from public.activities where slot_index between ${lo} and ${hi}),
      b as (select x.battle_id from private.arena_assignments x join private.jobs p on p.id=x.pairing_job_id
        where p.kind='pair' and p.slot_index between ${lo} and ${hi}),
      t as (select id from private.tournaments where slot_index between ${lo} and ${hi}),
      j as (select id from private.jobs where slot_index between ${lo} and ${hi}
        and not exists(select 1 from public.tournament_views v where v.pairing_job_id=jobs.id))
    select (select count(*)::int from public.activity_stages where activity_id in (select id from a)) as "activityStages",
      (select count(*)::int from private.expedition_plans where activity_id in (select id from a)) as "expeditionPlans",
      (select count(*)::int from private.arena_results where battle_id in (select battle_id from b)) as "arenaResults",
      (select count(*)::int from private.arena_assignment_sides where battle_id in (select battle_id from b)) as "arenaAssignmentSides",
      (select count(*)::int from b) as "arenaAssignments",
      (select count(*)::int from private.tournament_results where tournament_id in (select id from t)) as "tournamentResults",
      (select count(*)::int from private.tournament_bouts where tournament_id in (select id from t)) as "tournamentBouts",
      (select count(*)::int from private.tournament_entries where tournament_id in (select id from t)) as "tournamentEntries",
      (select count(*)::int from t) as "tournaments",
      (select count(*)::int from private.job_dependencies where job_id in (select id from j) or prerequisite_id in (select id from j)) as "jobDependencies",
      (select count(*)::int from private.job_attempts where job_id in (select id from j)) as "jobAttempts",
      (select count(*)::int from j) as "jobs",
      (select count(*)::int from private.activity_snapshots where activity_id in (select id from a)) as "activitySnapshots",
      (select count(*)::int from private.boundary_members where slot_index between ${lo} and ${hi}) as "boundaryMembers"`;
  return { ...row } as Counts;
}
/** State the matrix keeps forever, whatever the age. */
async function keptRows(q: Sql): Promise<Counts> {
  const [row] = await q`select (select count(*)::int from private.settled_slots) as "settledSlots",
    (select count(*)::int from public.operation_receipts) as receipts, (select count(*)::int from public.wallet_ledger) as ledger,
    (select count(*)::int from private.arena_ratings) as ratings, (select count(*)::int from public.arena_standings) as standings,
    (select count(*)::int from public.seasons) as seasons, (select count(*)::int from public.gladiators) as gladiators,
    (select count(*)::int from public.wallets) as wallets, (select count(*)::int from public.item_instances) as items,
    (select count(*)::int from public.builds) as builds, (select count(*)::int from public.public_profiles) as profiles,
    (select count(*)::int from public.world_actors) as actors, (select count(*)::int from public.schedule_revisions) as revisions`;
  return { ...row } as Counts;
}
/** The 90-day summary of slots lo..hi. */
async function summaryRows(q: Sql, lo: number, hi: number): Promise<Counts> {
  const [row] = await q`
    with v as (select id,pairing_job_id from public.tournament_views where slot_index between ${lo} and ${hi})
    select (select count(*)::int from public.activities where slot_index between ${lo} and ${hi}) as activities,
      (select count(*)::int from public.recent_results r join public.activities a on a.id=r.activity_id where a.slot_index between ${lo} and ${hi}) as "recentResults",
      (select count(*)::int from v) as "tournamentViews",
      (select count(*)::int from public.tournament_bout_results where tournament_id in (select id from v)) as "tournamentBoutResults",
      (select count(*)::int from public.tournament_placements where tournament_id in (select id from v)) as "tournamentPlacements",
      (select count(*)::int from private.jobs where id in (select pairing_job_id from v)) as "viewJobs",
      (select count(*)::int from private.boundaries where slot_index between ${lo} and ${hi}) as boundaries`;
  return { ...row } as Counts;
}
/** Characters whose wallet differs from its checkpoint plus its remaining ledger rows (Decision 3's invariant). */
const unreconciled = (q: Sql) => q`select g.id::text from public.gladiators g join public.wallets w on w.gladiator_id=g.id
  left join private.wallet_checkpoints c on c.gladiator_id=g.id
  left join (select l.gladiator_id,sum(l.money_delta) as money,sum(l.renown_delta) as renown from public.wallet_ledger l group by l.gladiator_id) l
    on l.gladiator_id=g.id
  where w.money<>coalesce(c.money,0)+coalesce(l.money,0) or w.renown<>coalesce(c.renown,0)+coalesce(l.renown,0)`;

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
const ARENA = every({ kind: 'arena' });
const TRAINING = every({ kind: 'training' });
const EXPEDITION = every({ kind: 'expedition', expeditionId: 'woodland' });
/** Real creation, then the operator places the character just before the first history slot with its schedule. */
async function fighter(schedule: Choices, optIn = false) {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Keep ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId, createdAt = (FIRST - 1) * SLOT + 1;
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${FIRST * SLOT},processed_slot_index=${FIRST - 1},
    tournament_opt_in=${optIn} where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${createdAt},effective_slot_index=${FIRST},choice=${sql.json(schedule[phase] as never)}
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

/** Claims and completes every claimable job of `kind` with `execute`; returns how many completed. */
async function completeAll(kind: string, execute: (job: JobLease) => unknown, limit = 20) {
  let done = 0;
  for (let jobs = await claim(kind, limit); jobs.length; jobs = await claim(kind, limit)) {
    for (const job of jobs) {
      expect(await complete(job, await execute(job)), `${kind} ${job.id}`).toMatchObject({ ok: true });
      done += 1;
    }
  }
  return done;
}
/**
 * One settlement at database time `atMs` (needs withClock): the worker adapter's own steps (expedition preparation from the
 * fenced settlement input, otherwise the plain settlement) in one session whose clock reads `atMs`.
 */
async function settleAt(job: JobLease, atMs: number) {
  return sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${atMs}'`);
    const [{ input }] = await tx`select public.expedition_settlement_input(${job.activityId},${job.token}) as input`;
    if (!input) return (await tx`select public.settle_activity(${job.activityId},${job.token}) as outcome`)[0].outcome as Outcome;
    const baseline = { level: input.state.progression.level as number, xp: input.state.progression.xp as number };
    const prepared = { rewards: input.rewards, grant: prepareGrant(input.state as OwnerState, input.rewards.loot), progressionBaseline: baseline,
      progression: applyXp(baseline.level, baseline.xp, input.rewards.xp) };
    return (await tx`select public.settle_expedition(${job.activityId},${job.token},${tx.json(prepared as never)}) as outcome`)[0].outcome as Outcome;
  });
}
/** A whole slot: the boundary with canonical preparation and pairing, every simulation and reveal, then each settlement at minute 80. */
async function playSlot(target: number, token: string) {
  for (let round = 0; ; round++) {
    const step = await rpc('advance_boundary', { target_slot: target, coordinator_token: token });
    if (step.status === 'complete') break;
    if (round > 6) throw new Error(`boundary ${target}: ${JSON.stringify(step)}`);
    if (step.wait === 'preparation') await completeAll('prepare', job => prepareActivityV1(job.snapshot as PreparationInput));
    else if (step.wait === 'pairing') await completeAll('pair', job => DEFAULT_EXECUTORS.v1.pair!(job));
    else throw new Error(`boundary ${target}: ${JSON.stringify(step)}`);
  }
  for (let round = 0; round < 20; round++) {
    const simulated = await completeAll('simulation', job => DEFAULT_EXECUTORS.v1.simulation!(job, { database: worker }), 5);
    const revealed = await completeAll('reveal', () => ({}));
    if (!simulated && !revealed) break;
  }
  for (let jobs = await claim('settlement'); jobs.length; jobs = await claim('settlement')) {
    for (const job of jobs) expect(await settleAt(job, (target + 1) * SLOT + MINUTE)).toMatchObject({ ok: true, newGrants: 1 });
  }
}

let world: { expedition: Fighter; trainee: Fighter; arena: Fighter[]; entrants: Fighter[]; all: Fighter[] };

describe('Task 22.1: retention in the database', () => {
  beforeAll(async () => {
    await resetWorld(FIRST - 1);
    world = await withClock(async () => {
      const [expedition, trainee, ...rest] = await Promise.all([fighter(EXPEDITION), fighter(TRAINING), fighter(ARENA), fighter(ARENA),
        fighter(ARENA, true), fighter(ARENA, true), fighter(ARENA, true)]);
      const token = randomUUID();
      await sql`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
      for (let slot = FIRST; slot <= LAST; slot++) await playSlot(slot, token);
      await sql`update private.coordinator set lease_token=null,lease_until_ms=0 where singleton`;
      return { expedition, trainee, arena: rest.slice(0, 2), entrants: rest.slice(2), all: [expedition, trainee, ...rest] };
    });
    // The history: every activity settled, one bracket on the tournament slot with a bye and two fought bouts.
    expect(await sql`select count(*)::int as n from public.activities where status='completed'`).toEqual([{ n: 21 }]);
    expect(await sql`select slot_index::int as slot from private.tournaments`).toEqual([{ slot: TOURNAMENT }]);
    expect(await sql`select count(*)::int as n from public.tournament_bout_results where result ? 'battleLog'`).toEqual([{ n: 2 }]);
  }, 600_000);
  // The ledger case commits real commands; leave no committed state behind for a single-file run.
  afterAll(async () => {
    await resetIdentity();
    await sql.end();
  });

  it('flips available replays to expired once their expiry passes and reprojects recent results', () => rollback(async tx => {
    const available = await tx`select id, slot_index::int as slot, (summary->'replayExpiry'->>'expiresAtMs')::float8 as expires
      from public.activities where summary->'replayExpiry'->>'state'='available' order by slot_index, id`;
    // Expedition, Arena and tournament replays are kept seven days; Training never has one.
    const first = available.filter(a => a.slot === FIRST);
    expect(first.map(a => a.expires)).toEqual(first.map(() => (FIRST + 1) * SLOT + REPLAY_MS));
    expect(first).toHaveLength(6);
    expect(available).toHaveLength(18);
    const [{ revision }] = await tx`select revision::int from public.world_revision_state`;
    // One millisecond early nothing flips. The checkpoint is still 302, so the seven-day pass only moves its watermark across
    // the empty slots up to 302 - 19 and deletes nothing.
    const early = await cleanup(tx, (FIRST + 1) * SLOT + REPLAY_MS - 1);
    expect(early.replay.flipped).toBe(0);
    expect(early.detail).toMatchObject({ fromSlot: 0, throughSlot: LAST - 19, more: false, blockedSlot: null });
    expect(Object.values(early.detail.deleted).every(n => n === 0)).toBe(true);
    const result = await cleanup(tx, (FIRST + 1) * SLOT + REPLAY_MS);
    expect(result.replay.flipped).toBe(6);
    // The owner's summary and its public recent result agree.
    const states = await tx`select a.slot_index::int as slot, a.summary->'replayExpiry' as owner, r.summary->'replayExpiry' as public
      from public.activities a join public.recent_results r on r.activity_id=a.id where a.id in ${tx(available.map(a => a.id as string))}`;
    expect(states).toHaveLength(18);
    for (const row of states) {
      expect(row.public).toEqual(row.owner);
      expect(row.owner.state).toBe(row.slot === FIRST ? 'expired' : 'available');
    }
    // The flip reprojected recent results, which bumps the world revision.
    expect((await tx`select revision::int from public.world_revision_state`)[0].revision).toBeGreaterThan(revision);
    expect(result.detail).toMatchObject({ fromSlot: null, throughSlot: null, more: false, blockedSlot: null });
    expect((await cleanup(tx, (FIRST + 1) * SLOT + REPLAY_MS)).replay.flipped).toBe(0);
  }));

  it('removes replay detail of slots older than seven days and keeps their summaries and settled slots', () => rollback(async tx => {
    await checkpoint(tx, LAST + 19);
    const before = await detailRows(tx, FIRST, LAST);
    for (const [table, n] of Object.entries(before)) expect(n, table).toBeGreaterThan(0);
    const kept = await keptRows(tx), summaries = await summaryRows(tx, FIRST, LAST);
    const outcomes = (await tx`select id, summary-'replayExpiry' as summary from public.activities order by id`).map(row => ({ ...row }));
    const result = await cleanup(tx, SEVEN_DAYS_LATER);
    expect(result).toMatchObject({ ok: true, nowMs: SEVEN_DAYS_LATER, publishedSlot: LAST + 19, checkpointSlot: LAST + 19 });
    expect(result.detail).toMatchObject({ fromSlot: 0, throughSlot: LAST, more: false, blockedSlot: null, deleted: before });
    expect(result.summary).toMatchObject({ fromSlot: null, throughSlot: null, more: false });
    expect(Object.values(await detailRows(tx, FIRST, LAST)).every(n => n === 0)).toBe(true);
    // Summaries, recent results, tournament views (with their pairing jobs), boundaries and every permanent row stay.
    expect(await keptRows(tx)).toEqual(kept);
    expect(await summaryRows(tx, FIRST, LAST)).toEqual(summaries);
    expect((await tx`select id, summary-'replayExpiry' as summary from public.activities order by id`).map(row => ({ ...row }))).toEqual(outcomes);
    expect(await tx`select distinct summary->'replayExpiry' as expiry from public.activities`).toEqual([{ expiry: { state: 'expired' } }]);
    expect(await tx`select distinct summary->'replayExpiry' as expiry from public.recent_results`).toEqual([{ expiry: { state: 'expired' } }]);
    expect(await tx`select detail_through_slot::int as detail, summary_through_slot::int as summary, last_run_at_ms::float8 as at, last_result
      from private.retention_state`).toEqual([{ detail: LAST, summary: -1, at: SEVEN_DAYS_LATER, last_result: result }]);
    for (const value of [result.durationMs, result.replay.durationMs, result.detail.durationMs]) expect(value).toBeGreaterThanOrEqual(0);
  }));

  it('compacts tournament bout logs to their fight summary and keeps the bracket', () => rollback(async tx => {
    await checkpoint(tx, LAST + 19);
    const results = async () => (await tx`select bout_id, tournament_id, ordinal, round, position, reveal_at_ms::float8 as reveal, result
      from public.tournament_bout_results order by ordinal`).map(row => ({ ...row }));
    const view = async () => (await tx`select * from public.tournament_views`).map(row => ({ ...row }));
    const placements = async () => (await tx`select * from public.tournament_placements order by place, gladiator_id`).map(row => ({ ...row }));
    const [before, bracket, places] = [await results(), await view(), await placements()];
    expect(places).toHaveLength(3);
    const result = await cleanup(tx, SEVEN_DAYS_LATER);
    expect(result.detail.compacted).toEqual({ tournamentBoutResults: 2 });
    expect(await results()).toEqual(before.map(row => {
      if (!('battleLog' in row.result)) return row;
      const { battleLog, ...rest } = row.result;
      return { ...row, result: { ...rest, fight: { durationMs: battleLog.durationMs, victoryReason: battleLog.victoryReason, tieBreakReason: battleLog.tieBreakReason } } };
    }));
    expect(before.filter(row => row.result.bye)).toHaveLength(1);
    expect(await view()).toEqual(bracket);
    expect(await placements()).toEqual(places);
    expect(JSON.stringify(await tx`select result from public.tournament_bout_results`)).not.toContain('battleLog');
  }));

  it('removes activities, recent results and tournament views of slots older than ninety days', () => rollback(async tx => {
    await checkpoint(tx, LAST + 19);
    const kept = await keptRows(tx), summaries = await summaryRows(tx, FIRST, LAST);
    const receipts = (await tx`select o.receipt_id::text as id, o.request from public.operation_receipts o join public.activities a on a.receipt_id=o.receipt_id
      order by o.receipt_id`).map(row => ({ ...row }));
    const commandReceipts = (await tx`select receipt_id::text as id, result from public.operation_receipts where request->>'kind'<>'activity-settlement'
      order by receipt_id`).map(row => ({ ...row }));
    // Expedition, Arena and tournament settlements write a financial receipt; Training writes none.
    expect(receipts).toHaveLength(18);
    const result = await cleanup(tx, NINETY_DAYS_LATER);
    expect(result.detail).toMatchObject({ fromSlot: 0, throughSlot: LAST, more: false });
    expect(result.summary).toMatchObject({ fromSlot: 0, throughSlot: LAST, more: false, compacted: { receipts: 18 } });
    expect(result.summary.deleted).toMatchObject({ activities: 21, tournamentViews: 1, tournamentBoutResults: summaries.tournamentBoutResults,
      tournamentPlacements: 3, boundaries: 3 });
    expect(await summaryRows(tx, FIRST, LAST)).toEqual({ activities: 0, recentResults: 0, tournamentViews: 0, tournamentBoutResults: 0,
      tournamentPlacements: 0, viewJobs: 0, boundaries: 0 });
    expect(await tx`select count(*)::int as n from public.recent_results`).toEqual([{ n: 0 }]);
    expect(await tx`select count(*)::int as n from private.jobs where slot_index between ${FIRST} and ${LAST}`).toEqual([{ n: 0 }]);
    // Settled slots, receipts (compacted settlement results only), the ledger, ratings, standings and seasons stay forever.
    expect(await keptRows(tx)).toEqual(kept);
    expect((await tx`select receipt_id::text as id, request, result from public.operation_receipts where receipt_id in ${tx(receipts.map(r => r.id))}
      order by receipt_id`).map(row => ({ ...row }))).toEqual(receipts.map(r => ({ ...r, result: { compactedAtMs: NINETY_DAYS_LATER } })));
    expect((await tx`select receipt_id::text as id, result from public.operation_receipts where request->>'kind'<>'activity-settlement'
      order by receipt_id`).map(row => ({ ...row }))).toEqual(commandReceipts);
    expect(await tx`select detail_through_slot::int as detail, summary_through_slot::int as summary from private.retention_state`)
      .toEqual([{ detail: LAST, summary: LAST }]);
  }));

  it('never touches the last 19 slots before the checkpoint, unfinished jobs, held reservations or open listings', () => rollback(async tx => {
    await checkpoint(tx, LAST + 18);
    const owner = world.trainee;
    // An unfinished job on the protected slot and one beyond the checkpoint.
    for (const slot of [LAST, LAST + 40]) {
      await tx`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
        values('reveal',${'retention-unfinished:' + slot},${slot},${owner.gid},'{}','v1',0)`;
    }
    // A held and a consumed fee reservation whose queue-build receipts are long past ninety days.
    const reservation = async (status: string) => {
      const operation = randomUUID(), request = { kind: 'queue-build', operationId: operation };
      await tx`insert into public.operation_receipts(owner_id,operation_id,gladiator_id,request,request_digest,result,created_at)
        values(${owner.id},${operation},${owner.gid},${tx.json(request)},sha256(convert_to(${JSON.stringify(request)},'UTF8')),'{"ok":true}',to_timestamp(0))`;
      return (await tx`insert into public.reservations(gladiator_id,operation_id,money,status) values(${owner.gid},${operation},100,${status}) returning id`)[0].id as string;
    };
    const held = await reservation('held'), consumed = await reservation('consumed');
    // Listings: open and not yet due; open and due now (the backstop sweep expires it and returns its item); expired 90 days ago.
    const [template] = await tx`select item from public.item_instances where gladiator_id=${owner.gid} limit 1`;
    const listed = randomUUID(), due = randomUUID(), open = randomUUID(), old = randomUUID();
    await tx`insert into public.item_instances(id,gladiator_id,item) values(${listed},${owner.gid},${tx.json({ ...template.item, id: listed, origin: 'shop',
      reservation: { kind: 'listing', referenceId: due } })})`;
    const real = await dbNow();
    await tx`insert into private.market_listings(id,seller_gladiator_id,item_id,price,listed_at_ms,expires_at_ms,status) values
      (${open},${owner.gid},${randomUUID()},10,${real},${real + 7 * DAY},'open'),
      (${due},${owner.gid},${listed},10,${NINETY_DAYS_LATER - 7 * DAY},${NINETY_DAYS_LATER - 1},'open'),
      (${old},${owner.gid},${randomUUID()},10,0,1000,'expired')`;
    // Schedule history: evening v1 is superseded by v2 (effective before the next boundary); morning v1 still governs until v3.
    await tx`insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index) values
      (${owner.gid},2,'evening','{"kind":"rest"}',${FIRST * SLOT},${LAST + 10}),(${owner.gid},3,'morning','{"kind":"rest"}',${FIRST * SLOT},${LAST + 100})`;
    const protectedDetail = await detailRows(tx, LAST, LAST), protectedSummary = await summaryRows(tx, LAST, LAST);
    const result = await cleanup(tx, NINETY_DAYS_LATER);
    expect(result).toMatchObject({ checkpointSlot: LAST + 18, detail: { throughSlot: LAST - 1, more: false }, summary: { throughSlot: LAST - 1 },
      market: { expired: 1, listings: 1, offers: 0 }, reservations: 1, scheduleRevisions: 1 });
    // The protected slot keeps all its detail (its unfinished job included) and summaries.
    expect(await detailRows(tx, LAST, LAST)).toEqual(protectedDetail);
    expect(await summaryRows(tx, LAST, LAST)).toEqual(protectedSummary);
    expect(await tx`select slot_index::int as slot, status from private.jobs where dedupe_key like 'retention-unfinished:%' order by slot_index`)
      .toEqual([{ slot: LAST, status: 'pending' }, { slot: LAST + 40, status: 'pending' }]);
    expect(await tx`select id::text, status from public.reservations where id in ${tx([held, consumed])}`).toEqual([{ id: held, status: 'held' }]);
    expect((await tx`select id::text, status from private.market_listings order by status`).map(row => ({ ...row })))
      .toEqual([{ id: due, status: 'expired' }, { id: open, status: 'open' }]);
    expect((await tx`select item->'reservation' as reservation from public.item_instances where id=${listed}`)[0].reservation).toBeNull();
    expect(await tx`select phase, version::int from public.schedule_revisions where gladiator_id=${owner.gid} order by phase, version`).toEqual([
      { phase: 'afternoon', version: 1 }, { phase: 'evening', version: 2 }, { phase: 'morning', version: 1 }, { phase: 'morning', version: 3 }]);
  }));

  it('stops a batch below a slot that still has an unfinished job and reports blockedSlot', () => rollback(async tx => {
    await checkpoint(tx, LAST + 30);
    await tx`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
      values('reveal','retention-blocked',${TOURNAMENT},${world.trainee.gid},'{}','v1',0)`;
    const [middle, last] = [await detailRows(tx, TOURNAMENT, TOURNAMENT), await detailRows(tx, LAST, LAST)];
    const first = await cleanup(tx, SEVEN_DAYS_LATER);
    expect(first.detail).toMatchObject({ fromSlot: 0, throughSlot: FIRST, more: false, blockedSlot: TOURNAMENT });
    expect(Object.values(await detailRows(tx, FIRST, FIRST)).every(n => n === 0)).toBe(true);
    expect(await detailRows(tx, TOURNAMENT, TOURNAMENT)).toEqual(middle);
    expect(await detailRows(tx, LAST, LAST)).toEqual(last);
    const again = await cleanup(tx, SEVEN_DAYS_LATER);
    expect(again.detail).toMatchObject({ fromSlot: null, throughSlot: null, more: false, blockedSlot: TOURNAMENT });
    expect(Object.values(again.detail.deleted).every(n => n === 0)).toBe(true);
    // Once the job finishes (its status machine), the batch continues from its watermark.
    await tx`update private.jobs set status='leased' where dedupe_key='retention-blocked'`;
    await tx`update private.jobs set status='completed',result='{}' where dedupe_key='retention-blocked'`;
    const resumed = await cleanup(tx, SEVEN_DAYS_LATER);
    expect(resumed.detail).toMatchObject({ fromSlot: TOURNAMENT, throughSlot: LAST, more: false, blockedSlot: null });
    expect(Object.values(await detailRows(tx, FIRST, LAST)).every(n => n === 0)).toBe(true);
  }));

  it('refuses to delete a receipt and allows only the settlement-receipt compaction', async () => {
    const [settlement] = await sql`select receipt_id::text as id, result from public.operation_receipts where request->>'kind'='activity-settlement' limit 1`;
    const [command] = await sql`select receipt_id::text as id from public.operation_receipts where request->>'kind'='create-character' limit 1`;
    for (const id of [settlement.id, command.id]) {
      await expect(sql`delete from public.operation_receipts where receipt_id=${id}`).rejects.toThrow('immutable operation_receipts');
    }
    // A command receipt is the replay result of its operation: never compacted.
    await expect(sql`update public.operation_receipts set result='{"compactedAtMs":1}' where receipt_id=${command.id}`).rejects.toThrow('immutable operation_receipts');
    for (const change of [sql`request=request||'{"x":1}'`, sql`request_digest='\\x00'`, sql`created_at=clock_timestamp()`, sql`gladiator_id=null`,
      sql`operation_id=gen_random_uuid()`, sql`result=result||'{"x":1}'`, sql`result='{"compactedAtMs":1,"rewards":{}}'`, sql`result='{"compactedAtMs":"1"}'`,
      sql`result='{"compactedAtMs":1.5}'`, sql`result='{}'`]) {
      await expect(sql`update public.operation_receipts set ${change} where receipt_id=${settlement.id}`).rejects.toThrow('immutable operation_receipts');
    }
    await rollback(async tx => {
      await tx`update public.operation_receipts set result='{"compactedAtMs":123}' where receipt_id=${settlement.id}`;
      expect((await tx`select result from public.operation_receipts where receipt_id=${settlement.id}`)[0].result).toEqual({ compactedAtMs: 123 });
      // Compacted once: never again.
      await expect(tx.savepoint(sp => sp`update public.operation_receipts set result='{"compactedAtMs":124}' where receipt_id=${settlement.id}`))
        .rejects.toThrow('immutable operation_receipts');
    });
    expect((await sql`select result from public.operation_receipts where receipt_id=${settlement.id}`)[0].result).toEqual(settlement.result);
  });

  it('refuses any tournament bout result update except the log compaction', async () => {
    const [fought] = await sql`select bout_id, result from public.tournament_bout_results where result ? 'battleLog' limit 1`;
    const [bye] = await sql`select bout_id, result from public.tournament_bout_results where (result->>'bye')::boolean`;
    const { battleLog, ...rest } = fought.result;
    const compacted = { ...rest, fight: { durationMs: battleLog.durationMs, victoryReason: battleLog.victoryReason, tieBreakReason: battleLog.tieBreakReason } };
    for (const change of [sql`result=jsonb_set(result,'{winnerId}','"forged"')`, sql`result=result-'battleLog'`,
      sql`result=${sql.json({ ...compacted, fight: { ...compacted.fight, durationMs: battleLog.durationMs + 1 } })}`,
      sql`result=${sql.json({ ...compacted, winnerId: 'forged' })}`, sql`ordinal=ordinal+100`, sql`reveal_at_ms=0`,
      sql`result=${sql.json(compacted)},round=round+1`]) {
      await expect(sql`update public.tournament_bout_results set ${change} where bout_id=${fought.bout_id}`).rejects.toThrow('immutable tournament_bout_results');
    }
    await expect(sql`update public.tournament_bout_results set result=result||'{"x":1}' where bout_id=${bye.bout_id}`).rejects.toThrow('immutable tournament_bout_results');
    await rollback(async tx => {
      await tx`update public.tournament_bout_results set result=${tx.json(compacted)} where bout_id=${fought.bout_id}`;
      expect((await tx`select result from public.tournament_bout_results where bout_id=${fought.bout_id}`)[0].result).toEqual(compacted);
      await expect(tx.savepoint(sp => sp`update public.tournament_bout_results set result=result||'{"x":1}' where bout_id=${fought.bout_id}`))
        .rejects.toThrow('immutable tournament_bout_results');
      // Deleting stays allowed: the ninety-day pass removes these rows.
      await tx`delete from public.tournament_bout_results where bout_id=${fought.bout_id}`;
    });
    expect((await sql`select result from public.tournament_bout_results where bout_id=${fought.bout_id}`)[0].result).toEqual(fought.result);
  });

  it('returns all-zero counts on a second call after catch-up', () => rollback(async tx => {
    await checkpoint(tx, LAST + 19);
    const first = await cleanup(tx, NINETY_DAYS_LATER);
    expect(countsOf(first).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    const second = await cleanup(tx, NINETY_DAYS_LATER);
    expect(countsOf(second).every(n => n === 0), JSON.stringify(second)).toBe(true);
    expect(second.detail).toMatchObject({ fromSlot: null, throughSlot: null, more: false, blockedSlot: null });
    expect(second.summary).toMatchObject({ fromSlot: null, throughSlot: null, more: false });
    expect(second.ledger.more).toBe(false);
  }));

  it('caps each call and continues from its watermarks', () => withClock(async () => {
    // Three data slots per pass: two more completed slots after the history, then two calls.
    await rollback(async tx => {
      await checkpoint(tx, LAST + 30);
      for (const slot of [LAST + 1, LAST + 2]) {
        await tx`insert into public.activities(gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms,summary,settled_at_ms)
          values(${world.trainee.gid},${slot},${slot * SLOT},${(slot + 1) * SLOT},'{"kind":"training"}','training','completed',${slot * SLOT},
            ${tx.json({ resolvedKind: 'training', result: 'completed', success: true, replayExpiry: { state: 'expired' } })},${(slot + 1) * SLOT})`;
      }
      const at = (LAST + 3) * SLOT + REPLAY_MS;
      expect((await cleanup(tx, at)).detail).toMatchObject({ fromSlot: 0, throughSlot: LAST, more: true });
      expect((await cleanup(tx, at)).detail).toMatchObject({ fromSlot: LAST + 1, throughSlot: LAST + 2, more: false });
      const at90 = (LAST + 3) * SLOT + SUMMARY_MS;
      expect((await cleanup(tx, at90)).summary).toMatchObject({ fromSlot: 0, throughSlot: LAST, more: true });
      expect((await cleanup(tx, at90)).summary).toMatchObject({ fromSlot: LAST + 1, throughSlot: LAST + 2, more: false });
    });
    // 300 replay flips: 300 fabricated available replays of one character come first by slot, then the history's 18.
    await rollback(async tx => {
      await tx`insert into public.activities(gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms,summary,settled_at_ms)
        select ${world.trainee.gid},s,s*${SLOT}::bigint,(s+1)*${SLOT}::bigint,'{"kind":"arena"}','arena','completed',s*${SLOT}::bigint,
          jsonb_build_object('resolvedKind','arena','result','victory','success',true,'replayExpiry',
            jsonb_build_object('state','available','expiresAtMs',(s+1)*${SLOT}::bigint+${REPLAY_MS}::bigint)),(s+1)*${SLOT}::bigint
        from generate_series(0,${FIRST - 1}) s`;
      const at = (LAST + 8) * SLOT + REPLAY_MS;
      expect((await cleanup(tx, at)).replay.flipped).toBe(300);
      expect((await cleanup(tx, at)).replay.flipped).toBe(18);
      expect((await cleanup(tx, at)).replay.flipped).toBe(0);
    });
    // 5000 ledger rows and 1000 dispatch-log rows per call, at real time plus 91 days (session clock).
    await rollback(async tx => {
      await tx`insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result,created_at)
        select ${world.trainee.id},gen_random_uuid(),gen_random_uuid(),${world.trainee.gid},'{"kind":"retention-cap"}','\\x00','{}',clock_timestamp()-interval '1 day'
        from generate_series(1,5001)`;
      await tx`insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason,created_at)
        select ${world.trainee.gid},receipt_id,0,0,'retention-cap',created_at from public.operation_receipts where request->>'kind'='retention-cap'`;
      const [{ total }] = await tx`select count(*)::int as total from public.wallet_ledger`;
      const now = await dbNow();
      await tx`insert into private.dispatch_log(dispatched_at_ms,claimable_simple,claimable_combat) select ${now - 3 * DAY},0,0 from generate_series(1,1001)`;
      const at = now + SUMMARY_MS + DAY;
      const first = await cleanup(tx, at);
      expect(first.ledger).toMatchObject({ rows: 5000, gladiators: 1, more: true });
      expect(first.operational.dispatchLog).toBe(1000);
      const second = await cleanup(tx, at);
      expect(second.ledger).toMatchObject({ rows: total - 5000, more: false });
      expect(second.operational.dispatchLog).toBe(1);
      expect(await tx`select count(*)::int as n from public.wallet_ledger`).toEqual([{ n: 0 }]);
      expect(await unreconciled(tx)).toEqual([]);
    });
  }), 120_000);

  it('prunes command attempts, the dispatch log, operations events and cron run details by their windows', async () => {
    await rollback(async tx => {
      const now = await dbNow(), actor = world.trainee.id;
      const [oldAttempt] = await tx`insert into private.command_attempts(actor_id,is_creation,attempted_at)
        values(${actor},false,to_timestamp(${(now - 3_600_000 - 1_000) / 1000})) returning id`;
      const [newAttempt] = await tx`insert into private.command_attempts(actor_id,is_creation,attempted_at)
        values(${actor},false,to_timestamp(${(now - 3_600_000 + MINUTE) / 1000})) returning id`;
      const [oldDispatch] = await tx`insert into private.dispatch_log(dispatched_at_ms,claimable_simple,claimable_combat) values(${now - 2 * DAY - 1},0,0) returning id`;
      const [newDispatch] = await tx`insert into private.dispatch_log(dispatched_at_ms,claimable_simple,claimable_combat) values(${now - 2 * DAY + MINUTE},0,0) returning id`;
      const [oldEvent] = await tx`insert into private.operations_events(at_ms,source,ok) values(${now - 30 * DAY - 1},'dispatch',true) returning id`;
      const [newEvent] = await tx`insert into private.operations_events(at_ms,source,ok) values(${now - 30 * DAY + MINUTE},'market-sweep',false) returning id`;
      // Explicit run ids: pg_cron's run id sequence belongs to its own role.
      const run = async (runid: number, endMs: number) => (await tx`insert into cron.job_run_details(jobid,runid,job_pid,database,username,command,status,
        return_message,start_time,end_time) values(0,${runid},0,'postgres','postgres','select 1','succeeded','1 row',to_timestamp(${(endMs - 1_000) / 1000}),
        to_timestamp(${endMs / 1000})) returning runid`)[0];
      const oldRun = await run(-1_000_001, now - 7 * DAY - 1_000), newRun = await run(-1_000_002, now - 7 * DAY + MINUTE);
      const result = await cleanup(tx, now);
      expect(result.operational).toMatchObject({ commandAttempts: 1, dispatchLog: 1, operationsEvents: 1 });
      expect(result.operational.cronRunDetails).toBeGreaterThanOrEqual(1);
      expect(await tx`select id::text from private.command_attempts where id in ${tx([oldAttempt.id, newAttempt.id])}`).toEqual([{ id: newAttempt.id }]);
      expect((await tx`select id::int from private.dispatch_log where id in ${tx([oldDispatch.id, newDispatch.id])}`).map(r => r.id)).toEqual([Number(newDispatch.id)]);
      expect((await tx`select id::int from private.operations_events where id in ${tx([oldEvent.id, newEvent.id])}`).map(r => r.id)).toEqual([Number(newEvent.id)]);
      expect((await tx`select runid::int from cron.job_run_details where runid in ${tx([oldRun.runid, newRun.runid])}`).map(r => r.runid)).toEqual([Number(newRun.runid)]);
    });
    // The cron step runs in its own block: a contended run row reports its SQLSTATE and the rest of the call still commits.
    // The held row is a committed, fabricated run that ended in 1970 (the oldest by end_time, so the step's batch of 1000
    // always reaches it, even on a fresh stack with no finished pg_cron run); it is removed afterwards.
    const held = -1_000_003;
    await sql`insert into cron.job_run_details(jobid,runid,job_pid,database,username,command,status,return_message,start_time,end_time)
      values(0,${held},0,'postgres','postgres','select 1','succeeded','1 row',to_timestamp(0),to_timestamp(1))`;
    try {
      await withClock(() => holding(async tx => {
        const locked = await tx`select runid from cron.job_run_details where runid=${held} for update`;
        if (locked.length !== 1) throw new Error('the fabricated run row was not locked');
      }, () => rollback(async tx => {
        const result = await cleanup(tx, (await dbNow()) + 8 * DAY);
        expect(result.ok).toBe(true);
        expect(result.operational.cronRunDetails).toEqual({ ok: false, sqlstate: '55P03' });
      })));
    } finally {
      await sql`delete from cron.job_run_details where runid=${held}`;
    }
  }, 60_000);

  it('refuses a now_ms in the future and gives no client role execute', async () => {
    const now = await dbNow();
    await expect(sql`select private.cleanup_history(${now + MINUTE})`).rejects.toThrow('future');
    await expect(sql`select private.cleanup_history(null)`).rejects.toThrow();
    const functions = await sql`select p.oid::regprocedure::text as name, p.prosecdef,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service, p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('cleanup_history','cleanup_tick') order by 1`;
    expect(functions.map(row => ({ ...row }))).toEqual(['private.cleanup_history(bigint)', 'private.cleanup_tick()'].map(name =>
      ({ name, prosecdef: false, anon: false, authenticated: false, service: false, proconfig: ['search_path=""'] })));
    const tables = await sql`select c.relname, c.relrowsecurity as rls,
      has_table_privilege('service_role',c.oid,'SELECT') as "select",
      has_table_privilege('service_role',c.oid,'INSERT') or has_table_privilege('service_role',c.oid,'UPDATE') or has_table_privilege('service_role',c.oid,'DELETE') as write,
      has_table_privilege('anon',c.oid,'SELECT') or has_table_privilege('authenticated',c.oid,'SELECT') as client
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
      and c.relname in ('retention_state','wallet_checkpoints','operations_events') order by 1`;
    expect(tables.map(row => ({ ...row }))).toEqual(['operations_events', 'retention_state', 'wallet_checkpoints'].map(relname =>
      ({ relname, rls: true, select: true, write: false, client: false })));
    // Exposure checks only (the privileges are proven above): neither function is reachable through the Data API, because
    // `public` has no such function and `private` is not an exposed schema.
    const owner = world.trainee;
    for (const client of [owner.client, anonymous, admin]) {
      expect((await client.rpc('cleanup_history', { now_ms: now })).error).not.toBeNull();
      expect((await client.schema('private').rpc('cleanup_tick')).error).not.toBeNull();
    }
  });

  it('records each cleanup tick in operations events and stays inert while the scheduler is off', async () => {
    expect(await sql`select schedule, command, active from cron.job where jobname='cloudiator-cleanup'`)
      .toEqual([{ schedule: '23 * * * *', command: 'select private.cleanup_tick()', active: true }]);
    await rollback(async tx => {
      expect((await tx`select private.cleanup_tick() as tick`)[0].tick).toEqual({ ok: true, skipped: 'disabled' });
      expect(await tx`select count(*)::int as n from private.operations_events`).toEqual([{ n: 0 }]);
      expect(await tx`select last_run_at_ms from private.retention_state`).toEqual([{ last_run_at_ms: null }]);
      await tx`update private.scheduler set enabled=true where singleton`;
      const [{ tick }] = await tx`select private.cleanup_tick() as tick`;
      expect(tick).toMatchObject({ ok: true, replay: { flipped: 18 } });
      expect((await tx`select source, ok, sqlstate, detail from private.operations_events`).map(row => ({ ...row })))
        .toEqual([{ source: 'cleanup', ok: true, sqlstate: null, detail: tick }]);
      expect((await tx`select last_result from private.retention_state`)[0].last_result).toEqual(tick);
    });
    // A failed call rolls back whole and leaves only its SQLSTATE: here the retention state row is held for longer than 500 ms.
    await holding(tx => tx`select 1 from private.retention_state where singleton for update`, () => rollback(async tx => {
      await tx`update private.scheduler set enabled=true where singleton`;
      const started = Date.now();
      const [{ tick }] = await tx`select private.cleanup_tick() as tick`;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(tick).toEqual({ ok: false, code: 'cleanup-failed', sqlstate: '55P03' });
      expect((await tx`select source, ok, sqlstate, detail from private.operations_events`).map(row => ({ ...row })))
        .toEqual([{ source: 'cleanup', ok: false, sqlstate: '55P03', detail: null }]);
      expect(await tx`select summary->'replayExpiry'->>'state' as state, count(*)::int as n from public.activities group by 1 order by 1`)
        .toEqual([{ state: 'available', n: 18 }, { state: 'expired', n: 3 }]);
    }));
  });

  it('never waits for the coordinator row or an account lock, and gives up a contended row lock after 500 ms', async () => {
    const owner = world.arena[0];
    // A due listing of the owner: the market backstop is the only step that asks for an account lock, and it only tries it
    // (as market.test.ts:605-634 proves for the sweep alone).
    const dueListing = async (tx: Sql) => {
      const [template] = await tx`select item from public.item_instances where gladiator_id=${owner.gid} limit 1`;
      const listing = randomUUID(), item = randomUUID();
      await tx`insert into private.market_listings(id,seller_gladiator_id,item_id,price,listed_at_ms,expires_at_ms,status)
        values(${listing},${owner.gid},${item},10,${SEVEN_DAYS_LATER - 8 * DAY},${SEVEN_DAYS_LATER - DAY},'open')`;
      await tx`insert into public.item_instances(id,gladiator_id,item) values(${item},${owner.gid},${tx.json({ ...template.item, id: item, origin: 'shop',
        reservation: { kind: 'listing', referenceId: listing } })})`;
      return listing;
    };
    await holding(async tx => {
      await tx`select 1 from private.coordinator where singleton for update`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${owner.id},0))`;
    }, () => rollback(async tx => {
      const listing = await dueListing(tx);
      const started = Date.now();
      const result = await cleanup(tx, SEVEN_DAYS_LATER);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.replay.flipped).toBe(18);
      // The busy owner is skipped, not waited for: its listing stays open for a later sweep.
      expect(result.market).toMatchObject({ expired: 0 });
      expect(await tx`select status from private.market_listings where id=${listing}`).toEqual([{ status: 'open' }]);
      expect(await tx`select lease_token, published_slot::int as published from private.coordinator`).toEqual([{ lease_token: null, published: LAST }]);
    }));
    // Control: with the account lock free, the same call expires that listing.
    await rollback(async tx => {
      const listing = await dueListing(tx);
      expect((await cleanup(tx, SEVEN_DAYS_LATER)).market).toMatchObject({ expired: 1 });
      expect(await tx`select status from private.market_listings where id=${listing}`).toEqual([{ status: 'expired' }]);
    });
    await holding(tx => tx`select 1 from public.activities where gladiator_id=${owner.gid} and slot_index=${FIRST} for update`, async () => {
      const started = Date.now();
      await expect(rollback(tx => cleanup(tx, SEVEN_DAYS_LATER))).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  it('keeps stage reveals bumping the world revision without reprojecting characters', () => rollback(async tx => {
    const triggers = await tx`select tgname from pg_trigger where tgrelid='public.activity_stages'::regclass and not tgisinternal order by tgname`;
    expect(triggers.map(t => t.tgname)).toEqual(['projection_changed']);
    const owner = world.arena[1];
    const [activity] = await tx`select id from public.activities where gladiator_id=${owner.gid} and slot_index=${LAST}`;
    await tx`update public.world_actors set actor=actor||'{"stale":true}' where gladiator_id=${owner.gid}`;
    await tx`set constraints all immediate`;
    const [{ revision }] = await tx`select revision::int from public.world_revision_state`;
    await tx`insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(${activity.id},9,0,'{"id":"late","kind":"return"}')`;
    expect((await tx`select revision::int from public.world_revision_state`)[0].revision).toBe(revision + 1);
    expect((await tx`select actor->'stale' as stale from public.world_actors where gladiator_id=${owner.gid}`)[0].stale).toBe(true);
  }));

  it('reprojects the same recent results as before with the anti-join upsert', async () => {
    const owner = world.entrants[0];
    // The rows Task 10's upsert writes: one per completed activity with its six safe summary fields.
    const reference = (q: Sql) => q`select x.id as activity_id, x.gladiator_id, g.name, x.settled_at_ms::float8 as reveal_at_ms,
      jsonb_build_object('activityId',x.id,'resolvedKind',x.resolved_kind,'result',x.summary->'result','success',x.summary->'success',
        'settledAtMs',x.settled_at_ms,'replayExpiry',case when x.summary->'replayExpiry'->>'state'='available'
          then jsonb_build_object('state','available','expiresAtMs',x.summary->'replayExpiry'->'expiresAtMs') else jsonb_build_object('state','expired') end) as summary
      from public.activities x join public.gladiators g on g.id=x.gladiator_id
      where x.gladiator_id=${owner.gid} and x.status='completed' and x.summary is not null and x.settled_at_ms is not null order by x.id`;
    const projected = (q: Sql) => q`select activity_id, gladiator_id, name, reveal_at_ms::float8 as reveal_at_ms, summary
      from public.recent_results where gladiator_id=${owner.gid} order by activity_id`;
    const ids = (await sql`select activity_id from public.recent_results where gladiator_id=${owner.gid} order by activity_id`).map(r => r.activity_id as string);
    expect(ids).toHaveLength(3);
    await rollback(async tx => {
      expect((await projected(tx)).map(row => ({ ...row }))).toEqual((await reference(tx)).map(row => ({ ...row })));
      await tx`delete from public.recent_results where activity_id=${ids[0]}`;
      await tx`update public.recent_results set summary=summary||'{"stale":true}',name='Stale' where activity_id=${ids[1]}`;
      await tx`select private.project_character(${owner.gid})`;
      expect((await projected(tx)).map(row => ({ ...row }))).toEqual((await reference(tx)).map(row => ({ ...row })));
    });
    // An unchanged row is skipped, not locked: a reprojection never waits behind a reader holding it.
    await holding(tx => tx`select 1 from public.recent_results where activity_id=${ids[2]} for update`, () => rollback(async tx => {
      await tx`set local lock_timeout='300ms'`;
      await tx`select private.project_character(${owner.gid})`;
    }));
  });

  it('folds ledger rows older than ninety days into checkpoints so wallets reconcile', () => withClock(async () => {
    // Every wallet-moving kind first. The history holds creation, expedition, Arena and tournament credits; real-clock
    // commands add a season award, a build fee, money and renown purchases, an NPC sale and a market sale.
    await stableRealSlot(60_000);
    const [{ split }] = await sql`select floor(extract(epoch from clock_timestamp())*1000)::float8 as split`;
    const seller = await realFighter('Seller'), buyer = await realFighter('Buyer');
    await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(9,${9 * 504 * SLOT},${9 * 504 * SLOT + 2_419_200_000})`;
    await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses) values(${seller.gid},'bronze',9,1100,5,0)`;
    expect(await sql`select private.close_season(9,${await dbNow()}) as awards`).toEqual([{ awards: 1 }]);
    const before = await seller.state();
    const build = { kind: 'queue-build' as const, operationId: randomUUID(), expectedVersion: before.buildVersion, classId: 'berserker' as const,
      stance: before.currentBuild.stance, allocation: before.currentBuild.allocations, equipment: before.currentBuild.equipment };
    const queued = await commands.plan({ userId: seller.id }, build);
    expect(queued).toMatchObject({ ok: true, value: { reservedMoney: 100 } });
    const effective = (queued as { value: { effectiveSlotIndex: number } }).value.effectiveSlotIndex;
    expect(await sql`select private.apply_pending_build(${seller.gid},${effective}) as applied`).toEqual([{ applied: true }]);
    const shop = async (catalogId: string) => {
      const bought = await commands.inventory({ userId: seller.id }, { kind: 'buy-shop', operationId: randomUUID(), catalogId, catalogVersion: 'v1', quantity: 1 });
      expect(bought, catalogId).toMatchObject({ ok: true });
      return bought as { value: { itemIds?: string[] } };
    };
    const sword = (await shop('sword:1:common')).value.itemIds![0], axe = (await shop('axe:1:common')).value.itemIds![0];
    await shop('banner');
    expect(await commands.inventory({ userId: seller.id }, { kind: 'sell-item', operationId: randomUUID(), itemId: axe, quantity: 1 })).toMatchObject({ ok: true });
    const listed = await commands.market({ userId: seller.id }, { kind: 'create-listing', operationId: randomUUID(), itemId: sword, price: 40 });
    expect(listed).toMatchObject({ ok: true });
    const listingId = (listed as { value: { listingId: string } }).value.listingId;
    expect(await commands.market({ userId: buyer.id }, { kind: 'buy-listing', operationId: randomUUID(), listingId })).toMatchObject({ ok: true });
    expect((await sql`select distinct reason from public.wallet_ledger`).map(r => r.reason as string).sort()).toEqual(['arena', 'build', 'creation',
      'expedition', 'market-purchase', 'market-sale', 'npc-sale', 'season', 'shop-purchase', 'tournament']);
    // The invariant holds over the raw ledger, before any fold.
    const raw = await sql`select g.id from public.gladiators g join public.wallets w on w.gladiator_id=g.id
      left join (select gladiator_id,sum(money_delta) as money,sum(renown_delta) as renown from public.wallet_ledger group by 1) l on l.gladiator_id=g.id
      where w.money<>coalesce(l.money,0) or w.renown<>coalesce(l.renown,0)`;
    expect(raw).toEqual([]);
    const [{ history }] = await sql`select count(*)::int as history from public.wallet_ledger where created_at<to_timestamp(${split / 1000})`;
    const [{ total }] = await sql`select count(*)::int as total from public.wallet_ledger`;
    await rollback(async tx => {
      // Ninety days after the split: only the history's rows are old enough, oldest first.
      const first = await cleanup(tx, split + SUMMARY_MS);
      expect(first.ledger).toEqual({ rows: history, gladiators: world.all.length, more: false });
      expect(await unreconciled(tx)).toEqual([]);
      expect(await tx`select count(*)::int as n, sum(ledger_rows)::int as folded from private.wallet_checkpoints`).toEqual([{ n: world.all.length, folded: history }]);
      // Later, the commands' rows fold too, into the existing checkpoints and two new ones.
      const second = await cleanup(tx, (await dbNow()) + SUMMARY_MS + DAY);
      expect(second.ledger).toEqual({ rows: total - history, gladiators: 2, more: false });
      // The consumed build-fee reservation goes with its ninety-day-old queue-build receipt.
      expect(second.reservations).toBe(1);
      expect(await tx`select count(*)::int as n from public.wallet_ledger`).toEqual([{ n: 0 }]);
      expect(await unreconciled(tx)).toEqual([]);
      expect(await tx`select money::int, renown::int, ledger_rows::int as rows from private.wallet_checkpoints where gladiator_id=${seller.gid}`)
        .toEqual([{ money: 100 + 500 - 100 - 40 - 40 + 10 + 38, renown: 100 - 50, rows: 8 }]);
      // A checkpoint is never deleted and changes only by folding more rows into it.
      await expect(tx.savepoint(sp => sp`delete from private.wallet_checkpoints where gladiator_id=${seller.gid}`)).rejects.toThrow('immutable wallet_checkpoints');
      await expect(tx.savepoint(sp => sp`update private.wallet_checkpoints set money=money+1 where gladiator_id=${seller.gid}`)).rejects.toThrow('immutable wallet_checkpoints');
    });
  }), 180_000);
});
