import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sql, account, admin, resetIdentity, creation, serverClockFetch } from './db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { slotAt } from '../../supabase/functions/_shared/domain/clock.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { isTournamentSlot } from '../../supabase/functions/_shared/domain/tournament-slot.ts';
import { seasonAt } from '../../supabase/functions/_shared/domain/season.ts';
import type { WorkerReport } from '../../supabase/functions/_shared/domain/types.ts';
import { readMarket, readOwner, readProfile, readRecent, readRevision, readSeasons, readStandingOf, readStandings, readTimeline, readTournament,
  readTournamentLog, readWorld } from '../../src/lib/api/reads.ts';
import { DISPATCH_PER_MINUTE, TABLE_CLASSES, type DatabaseMeasure, type EgressMeasure, type Encoding, type ReadSize, type RoleSizes,
  type TableMeasure } from '../performance/capacity-model.ts';
export { logSection, writeSection } from '../performance/harness.ts';

// Task 23.3 measurement harness for tests/db/capacity.test.ts (run through `npm run test:db`, or scripts/resource-report.mjs).
// It is local-only by construction: tests/fixtures/db.ts refuses anything but the loopback stack. Operator-only world
// controls (placement at historical slots, a test-only database clock, vault worker secrets) are the established patterns of
// tests/db/arena.test.ts and tournaments.test.ts, restored afterwards. Nothing secret is logged: reports carry counts, sizes
// and times only.

const SLOT = RULES_V1.clock.slotMs;
const MINUTE = 60_000;
const ENCODINGS: Encoding[] = ['raw', 'gzip', 'brotli'];
const commands = createDatabase(admin);
const API_URL = process.env.LOCAL_API_URL!;
const ANON_KEY = process.env.LOCAL_ANON_KEY!;

function bounded(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
/**
 * The measured load (scripts/resource-report.mjs passes --players, --viewers and --slots through these variables): the
 * characters of the measurement world, the concurrent visitors of the egress model, and the measured slots after the warm-up.
 * Commands per player per day are an assumption (no command is part of a scheduled slot): 10, generous for a 30-minute session
 * (the evidence shows 0, 5 and 20 too).
 */
export const CAPACITY = Object.freeze({
  players: bounded('CAPACITY_PLAYERS', 50, 3, 200),
  viewers: bounded('CAPACITY_VIEWERS', 50, 0, 10_000),
  slots: bounded('CAPACITY_SLOTS', 4, 3, 12),
  commandsPerPlayerPerDay: 10,
});

/**
 * Slots of the measurement world: 299 warms up (a cold boundary with nothing to settle), then 300, 301, … are measured. Slot
 * 301 starts on Saturday 1970-01-17 at 17:20 UTC, a v1 tournament slot; slot 373 is the next one, after any measured run.
 * Historical slots are fully in the past for row-level security and the views, which use the real clock, so every stage the
 * worker revealed is readable when the reads are measured.
 */
const WARM_UP = 299, FIRST = 300, TOURNAMENT = 301;

type Report = WorkerReport;
// Operator-only world controls for the isolated local test database (tests/db/restore-world.test.ts).
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

type Choice = { kind: 'arena' | 'training' | 'rest' } | { kind: 'expedition'; expeditionId: 'woodland' };
type Choices = { morning: Choice; afternoon: Choice; evening: Choice };
const ARENA: Choice = { kind: 'arena' }, TRAINING: Choice = { kind: 'training' }, WOODLAND: Choice = { kind: 'expedition', expeditionId: 'woodland' };
/**
 * Three schedules in rotation, so each regular slot mixes about a third Arena, a third Woodland expedition and a third
 * Training, and every character asks for Arena in the afternoon: on the tournament slot all of them enter one Bronze bracket.
 * No schedule rests, and every character starts rested with 40 earned points (20 in Endurance), so no slot of a run of up to
 * four falls back to Rest: an upper bound on activity (real schedules rest about one slot in three).
 */
const SCHEDULES: Choices[] = [
  { morning: ARENA, afternoon: ARENA, evening: WOODLAND },
  { morning: WOODLAND, afternoon: ARENA, evening: TRAINING },
  { morning: TRAINING, afternoon: ARENA, evening: ARENA },
];
const CLASSES = ['berserker', 'guardian', 'duelist'] as const;

/**
 * The new-character schedule (Training / Woodland / Rest, 01-identity.sql's creation default), for the second scenario:
 * every character the same, so the three slots of a game day are one of each.
 */
const DEFAULT_SCHEDULE: Choices = { morning: TRAINING, afternoon: WOODLAND, evening: { kind: 'rest' } };

/** Real creation, then the operator places the character at `firstSlot` with trusted progression inputs (arena.test.ts). */
async function player(i: number, firstSlot: number, schedules: Choices[] = SCHEDULES, optIn = true) {
  const owner = await account();
  const name = 'Cap ' + randomUUID().slice(0, 8);
  const created = await commands.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId, schedule = schedules[i % schedules.length], createdAt = (firstSlot - 1) * SLOT + 1;
  const a = i % 6, b = (i * 3) % 5;
  const allocations = { strength: 4 + a, agility: 2 + b, vitality: 12 - a - b, endurance: 20, precision: 2 };
  const [{ current }] = await sql`select current_build as current from public.builds where gladiator_id=${gid}`;
  await sql`update public.builds set current_build=${sql.json({ ...current, classId: CLASSES[i % 3], allocations })} where gladiator_id=${gid}`;
  // Stamina starts high; boundary preparation clamps it to the build's recomputed maximum (it never refills), so the character
  // starts rested. The windows' activity counts show whether any slot fell back to Rest.
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${firstSlot * SLOT},processed_slot_index=${firstSlot - 1},
    earned_points=40,unspent_points=0,tournament_opt_in=${optIn},stamina_maximum=1000,stamina_current=1000 where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${createdAt},effective_slot_index=${firstSlot},choice=${sql.json(schedule[phase] as never)}
      where gladiator_id=${gid} and phase=${phase}`;
  }
  return { ...owner, gid, name, group: i % 3 };
}
type Player = Awaited<ReturnType<typeof player>>;
/** `n` real characters, created 25 at a time (the Auth admin API and the creation RPC run concurrently). */
async function many<T>(n: number, make: (i: number) => Promise<T>): Promise<T[]> {
  const all: T[] = [];
  for (let start = 0; start < n; start += 25) all.push(...await Promise.all(Array.from({ length: Math.min(25, n - start) }, (_, j) => make(start + j))));
  return all;
}
/** A plain real character at the present slot (creation only), for the season, standings and market measurements. */
async function character() {
  const owner = await account();
  const name = 'Cap ' + randomUUID().slice(0, 8);
  const created = await commands.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw new Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId, name };
}

// ---- Tables and the database ---------------------------------------------------------------------------------------

/** Every table of the two game schemas. */
async function gameTables(): Promise<string[]> {
  return (await sql`select n.nspname||'.'||c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p') and n.nspname in ('public','private') order by 1`).map(r => r.name as string);
}
const quoted = (name: string) => name.split('.').map(part => `"${part.replaceAll('"', '""')}"`).join('.');
/** Exact row counts of `tables`, in one statement. */
async function counts(tables: string[]): Promise<Record<string, number>> {
  const rows = await sql.unsafe(tables.map(t => `select '${t}' as name, count(*)::float8 as n from ${quoted(t)}`).join(' union all '));
  return Object.fromEntries(rows.map(r => [r.name, Number(r.n)]));
}
/** On-disk size of each table: heap, TOAST, free-space and visibility maps, and every index. */
async function sizes(): Promise<Record<string, number>> {
  const rows = await sql`select n.nspname||'.'||c.relname as name, pg_total_relation_size(c.oid)::float8 as bytes from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','private')`;
  return Object.fromEntries(rows.map(r => [r.name as string, Number(r.bytes)]));
}
/** The database and the cron, pg_net and Auth tables that grow outside the game schemas. */
async function systemSizes() {
  const [s] = await sql`select pg_database_size(current_database())::float8 as database,
    (select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p') and n.nspname='auth')::float8 as auth,
    (select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p') and n.nspname='cron')::float8 as cron,
    (select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p') and n.nspname='net')::float8 as net,
    (select count(*) from auth.users)::float8 as users,
    (pg_total_relation_size('auth.users') + pg_total_relation_size('auth.identities'))::float8 as identity,
    (select count(*) from cron.job_run_details)::float8 as cron_rows,
    -- One run-log row as stored: its tuple plus a 28-byte header and line pointer and a 16-byte primary-key entry.
    (select coalesce(avg(pg_column_size(d.*)),0) + 44 from cron.job_run_details d)::float8 as cron_row_bytes,
    (select count(*) from net._http_response)::float8 as net_rows, pg_total_relation_size('net._http_response')::float8 as net_bytes`;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)])) as Record<string, number>;
}

/** Bytes a stored row takes beside its tuple: the 4-byte line pointer (heap). */
const LINE_POINTER = 4;
/** B-tree leaves fill to about 75 % under random (UUID) inserts; MAXALIGN is 8 bytes. */
const INDEX_FILL = 0.75;
const align8 = (n: number) => Math.ceil(n / 8) * 8;
/** Space autovacuum leaves in steady state (autovacuum_vacuum_scale_factor 0.2): rows take 20 % more than their live size. */
export const BLOAT_ALLOWANCE = 1.2;
/**
 * The modeled live size of an average row of `table` as stored: its tuple as `pg_column_size(row)` gives it (header and data,
 * TOASTed values at their compressed size), its line pointer, and one entry per index (an 8-byte index tuple header plus
 * the key columns, aligned, a line pointer, at 75 % leaf fill; an expression key counts 16 bytes). Unlike a table's file size
 * divided by its rows, it does not depend on how many rows the run left or on dead row versions.
 */
async function modeledRow(table: string): Promise<{ rows: number; tuple: number; index: number; bytes: number }> {
  const indexes = await sql`select i.indexrelid::regclass::text as name, coalesce(array_agg(a.attname::text order by k.ord) filter (where a.attname is not null), '{}') as cols,
    count(*) filter (where k.attnum = 0)::int as expressions
    from pg_index i cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
    left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum where i.indrelid=${table}::regclass group by 1`;
  const key = (cols: string[]) => cols.length ? cols.map(c => `coalesce(pg_column_size(t."${c.replaceAll('"', '""')}"),0)`).join('+') : '0';
  const [row] = await sql.unsafe(`select count(*)::float8 as rows, coalesce(avg(pg_column_size(t.*)),0)::float8 as tuple${indexes.map((ix, n) =>
    `, coalesce(avg(${key(ix.cols as string[])}),0)::float8 as k${n}`).join('')} from ${quoted(table)} t`);
  const index = indexes.reduce((sum, ix, n) => sum + (align8(8 + Number(row[`k${n}`]) + 16 * Number(ix.expressions)) + LINE_POINTER) / INDEX_FILL, 0);
  const tuple = Number(row.tuple);
  return { rows: Number(row.rows), tuple, index, bytes: Number(row.rows) > 0 ? (tuple + LINE_POINTER + index) * BLOAT_ALLOWANCE : 0 };
}

// ---- The scheduled tick and the real worker --------------------------------------------------------------------------

type Tick = { atMs: number; dispatched: number; claimableSimple: number; statuses: number[]; reports: Report[]; workMs: number; revision: string };
/**
 * Runs `body` with the real private Edge worker reachable through pg_net (vault secrets) and a test-only stand-in for the
 * database clock, both removed and verified afterwards (tests/db/arena.test.ts). `tick(at)` is one scheduled minute: pg_cron's
 * function with database time standing still at `at`, then running on from `at` in real time until every dispatched
 * invocation has answered.
 */
async function withWorker<T>(body: (tick: (at: number) => Promise<Tick>) => Promise<T>): Promise<T> {
  const secret = process.env.LOCAL_WORKER_SECRET ?? '';
  if (secret.length < 32) throw new Error('the local worker secret is missing');
  const clockQuery = `select pg_get_functiondef('private.planning_now_ms()'::regprocedure) as definition`;
  const [{ definition }] = await sql.unsafe(clockQuery);
  const setClock = (expression: string) => sql.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql
    volatile security invoker set search_path='' as '${expression}'`);
  async function tick(at: number): Promise<Tick> {
    await setClock(`select ${at}::bigint`);
    const began = performance.now();
    // The scheduler is enabled only inside this transaction, so the real pg_cron run stays inert.
    const result = await sql.begin(async tx => {
      await tx`update private.scheduler set enabled=true where singleton`;
      const [{ tick: ran }] = await tx`select private.cron_tick() as tick`;
      await tx`update private.scheduler set enabled=false where singleton`;
      return ran;
    });
    const [{ real }] = await sql`select floor(extract(epoch from clock_timestamp())*1000)::float8 as real`;
    await setClock(`select floor(extract(epoch from clock_timestamp())*1000)::bigint+${at - real}`);
    const ids: number[] = result?.dispatch?.requestIds ?? [];
    let responses: { status_code: number | null; content: string | null }[] = [];
    for (const deadline = Date.now() + 60_000; ids.length && Date.now() < deadline;) {
      responses = await sql`select status_code, content from net._http_response where id in ${sql(ids)}`;
      if (responses.length === ids.length && responses.every(r => r.status_code)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const workMs = performance.now() - began;
    const [{ revision }] = await sql`select revision from public.world_revision`;
    const reports = responses.filter(r => r.status_code === 200 && r.content).map(r => JSON.parse(r.content!) as Report);
    return { atMs: at, dispatched: Number(result?.dispatch?.dispatched ?? 0), claimableSimple: Number(result?.dispatch?.claimableSimple ?? 0), statuses: ids.map((_, i) => responses[i]?.status_code ?? 0),
      reports, workMs, revision: revision as string };
  }
  await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
  try {
    await sql`select vault.create_secret('http://supabase_edge_runtime_Cloudiator:8081/game-worker','game_worker_url')`;
    await sql`select vault.create_secret(${secret},'game_worker_secret')`;
    return await body(tick);
  } finally {
    await sql`update private.scheduler set enabled=false where singleton`;
    await sql.unsafe(definition);
    await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
    const [{ definition: restored }] = await sql.unsafe(clockQuery);
    if (restored !== definition) throw new Error('the database clock was not restored');
  }
}

type Window = { slot: number; tournament: boolean; dispatched: number; invocations: number; deferred: number; statuses: number[];
  changedMinutes: number; workMs: number[]; publishedMs: number | null; activities: Record<string, number>; tournamentEntrants: number;
  byKind: Record<string, number>; rows: Record<string, number>;
  /** The cutoff tick and the next two: what each dispatched, for how many claimable simple jobs. */
  firstTicks: { k: number; dispatched: number; claimableSimple: number }[];
  /** The previous slot's settlements, and how many of them the cutoff tick's invocations completed (before minute 1). */
  previousSettlements: number; settledInCutoffTick: number };
/** One slot of production cadence: a tick every minute of its 80, 300 ms into the minute, counting what the worker did. */
async function runWindow(slot: number, tick: (at: number) => Promise<Tick>, tables: string[], before: Record<string, number>, revision: { value: string }) {
  const cutoff = slot * SLOT;
  const w: Omit<Window, 'rows' | 'activities' | 'tournamentEntrants' | 'publishedMs' | 'previousSettlements' | 'settledInCutoffTick'> = { slot,
    tournament: isTournamentSlot(slotAt(cutoff)), dispatched: 0, invocations: 0, deferred: 0, statuses: [], changedMinutes: 0, workMs: [], byKind: {},
    firstTicks: [] };
  const flagged: Report[] = [];
  for (let k = 0; k < RULES_V1.clock.slotMs / MINUTE; k++) {
    const t = await tick(cutoff + k * MINUTE + 300);
    w.dispatched += t.dispatched;
    w.invocations += t.reports.length;
    w.statuses.push(...t.statuses);
    if (k < 3) w.firstTicks.push({ k, dispatched: t.dispatched, claimableSimple: t.claimableSimple });
    for (const r of t.reports) {
      w.deferred += r.deferred ?? 0;
      for (const [kind, n] of Object.entries(r.byKind)) w.byKind[kind] = (w.byKind[kind] ?? 0) + n;
      if (r.failed + r.conflicts + r.unrecorded > 0) flagged.push(r);
    }
    // A 30-second poller sees a change once per minute whose tick changed the revision (the split is the share of work
    // time a poll can fall into; it is kept per tick).
    if (t.revision !== revision.value) { w.changedMinutes += 1; w.workMs.push(t.workMs); }
    revision.value = t.revision;
  }
  const after = await counts(tables);
  const [p] = await sql`select (select completed_at_ms from private.boundaries where slot_index=${slot})::float8 as published,
    (select count(*) from private.jobs where kind='settlement' and slot_index=${slot - 1})::int as previous,
    (select count(*) from private.jobs where kind='settlement' and slot_index=${slot - 1} and completed_at_ms<${cutoff + MINUTE})::int as at_cutoff`;
  const activities = Object.fromEntries((await sql`select resolved_kind as kind, count(*)::int as n from public.activities where slot_index=${slot}
    group by 1`).map(r => [r.kind as string, r.n as number]));
  return { window: { ...w, rows: Object.fromEntries(tables.map(t => [t, after[t] - (before[t] ?? 0)])), activities,
    tournamentEntrants: activities.tournament ?? 0, publishedMs: p.published === null ? null : Number(p.published) - cutoff,
    previousSettlements: p.previous as number, settledInCutoffTick: p.at_cutoff as number } as Window, after, flagged };
}

// ---- Reads and their sizes -------------------------------------------------------------------------------------------

type Recorded = { bodyBytes: number; headerBytes: number; text: string };
/** A Data API client (anonymous when `token` is null) that records every response it receives; reads may sample `serverNowMs`. */
function recorder(token: string | null, serverNowMs?: number) {
  const records: Recorded[] = [];
  const base = serverClockFetch(serverNowMs);
  const client = createClient(API_URL, ANON_KEY, { global: { headers: token ? { Authorization: `Bearer ${token}` } : {}, fetch: async (input, init) => {
    const response = await base(input, init);
    records.push(await recorded(response.clone()));
    return response;
  } }, auth: { persistSession: false, autoRefreshToken: false } });
  return { client, records };
}
/** A response's body text and size, and its status line and headers as HTTP/1.1 sends them. */
async function recorded(response: Response): Promise<Recorded> {
  const text = await response.text();
  let headerBytes = `HTTP/1.1 ${response.status} ${response.statusText}\r\n\r\n`.length;
  response.headers.forEach((value, name) => { headerBytes += name.length + 2 + Buffer.byteLength(value, 'utf8') + 2; });
  return { bodyBytes: Buffer.byteLength(text, 'utf8'), headerBytes, text };
}
/** Body sizes raw and compressed (gzip level 6, brotli quality 5; never larger than raw), the request count and header bytes. */
function sizeOf(records: Recorded[]): ReadSize {
  const body = (r: Recorded, e: Encoding) => {
    if (e === 'raw' || r.bodyBytes === 0) return r.bodyBytes;
    const packed = e === 'gzip' ? gzipSync(r.text, { level: 6 }) : brotliCompressSync(r.text, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } });
    return Math.min(r.bodyBytes, packed.length);
  };
  return { ...Object.fromEntries(ENCODINGS.map(e => [e, records.reduce((sum, r) => sum + body(r, e), 0)])) as Record<Encoding, number>,
    requests: records.length, headerBytes: records.reduce((sum, r) => sum + r.headerBytes, 0) };
}
const ZERO: ReadSize = { raw: 0, gzip: 0, brotli: 0, requests: 0, headerBytes: 0 };
async function measure(rec: ReturnType<typeof recorder>, read: (client: SupabaseClient) => Promise<unknown>): Promise<ReadSize> {
  rec.records.length = 0;
  await read(rec.client);
  return sizeOf(rec.records);
}

/** The players' world after the run: one starter-inventory owner and one full-inventory owner, plus the activities to read. */
async function measureReads(players: Player[], lastSlot: number) {
  const reads: Record<string, RoleSizes> = {};
  const visitor = recorder(null);
  const [reader] = players;
  const member = recorder(reader.token);
  const both = async (kind: string, read: (client: SupabaseClient, role: 'visitor' | 'player') => Promise<unknown>) => {
    reads[kind] = { visitor: await measure(visitor, c => read(c, 'visitor')), player: await measure(member, c => read(c, 'player')) };
  };
  const activity = async (gid: string, slot: number) => (await sql`select id from public.activities where gladiator_id=${gid} and slot_index=${slot}`)[0].id as string;
  // Another character's Arena activity with a human bout (what the camp reads for every arena entrant after minute 60).
  const [arenaRow] = await sql`select s.activity_id as id from private.arena_assignment_sides s join private.arena_assignments x on x.battle_id=s.battle_id
    join public.activities a on a.id=s.activity_id where x.kind='human' and a.slot_index=${lastSlot} and a.gladiator_id<>${reader.gid} limit 1`;
  // The reader's own latest completed expedition (the largest own timeline: three encounter logs), read with its summary.
  const own = players.find(p => p.group === 1)!;
  const ownReader = recorder(own.token);
  const [ownRow] = await sql`select id from public.activities where gladiator_id=${own.gid} and resolved_kind='expedition' and status='completed'
    order by slot_index desc limit 1`;
  await both('revision', c => readRevision(c));
  await both('world', c => readWorld(c));
  reads.ownerStarter = { visitor: ZERO, player: await measure(member, c => readOwner(c)) };
  await both('timelineArena', (c, role) => readTimeline(c, arenaRow.id, { ownerSummary: role === 'player' }));
  reads.timelineOwn = { visitor: await measure(visitor, c => readTimeline(c, ownRow.id, { ownerSummary: false })),
    player: await measure(ownReader, c => readTimeline(c, ownRow.id, { ownerSummary: true })) };
  const training = await sql`select id from public.activities where resolved_kind='training' and status='completed' limit 1`;
  if (training.length) await both('timelineTraining', (c, role) => readTimeline(c, training[0].id, { ownerSummary: role === 'player' }));
  const entrant = await activity(reader.gid, TOURNAMENT);
  await both('timelineTournament', (c, role) => readTimeline(c, entrant, { ownerSummary: role === 'player' }));
  await both('profile', c => readProfile(c, own.gid));
  await both('recent', c => readRecent(c));
  await both('seasons', c => readSeasons(c));
  await both('standings', c => readStandings(c, 'bronze'));
  await both('standingOf', c => readStandingOf(c, 'bronze', reader.gid));
  // The tournament's polled view and every fought bout's log, read as a viewer just after its end (logs are kept seven days).
  const asOf = (TOURNAMENT + 1) * SLOT + 10 * MINUTE;
  const viewVisitor = recorder(null, asOf), viewMember = recorder(reader.token, asOf);
  const tournamentId = `tournament:${TOURNAMENT}:bronze`;
  reads.tournament = { visitor: await measure(viewVisitor, c => readTournament(c, tournamentId)), player: await measure(viewMember, c => readTournament(c, tournamentId)) };
  const view = await readTournament(viewVisitor.client, tournamentId);
  const fought = view.bouts.filter(b => b.revealedResult && !b.revealedResult.bye).map(b => b.id);
  const logs: ReadSize[] = [];
  for (const boutId of fought) logs.push(await measure(viewVisitor, c => readTournamentLog(c, boutId)));
  const sum = (sizesList: ReadSize[]): ReadSize => ({ ...Object.fromEntries(ENCODINGS.map(e => [e, sizesList.reduce((s, r) => s + r[e], 0)])) as Record<Encoding, number>,
    requests: sizesList.reduce((s, r) => s + r.requests, 0), headerBytes: sizesList.reduce((s, r) => s + r.headerBytes, 0) });
  const allLogs = sum(logs);
  reads.tournamentLog = { visitor: { ...Object.fromEntries(ENCODINGS.map(e => [e, Math.round(allLogs[e] / fought.length)])) as Record<Encoding, number>,
    requests: allLogs.requests / fought.length, headerBytes: Math.round(allLogs.headerBytes / fought.length) }, player: ZERO };
  reads.tournamentLog.player = reads.tournamentLog.visitor;
  return { reads, tournament: { bouts: view.bouts.length, fought: fought.length, entrants: view.entrants.length, status: view.status,
    logBytes: Object.fromEntries(ENCODINGS.map(e => [e, allLogs[e] + allLogs.headerBytes])) as Record<Encoding, number> } };
}

/** Ten sellers at the present slot list five tradable shop items each through the real create_listing function: a full page. */
async function listOffers() {
  const sellers = await many(10, () => character());
  const tradable = Object.values(CATALOG_V1.items).filter(entry => entry.binding === 'tradable' && entry.renownPrice === null);
  for (const [s, seller] of sellers.entries()) {
    for (let k = 0; k < RULES_V1.marketplace.maximumListings; k++) {
      const entry = tradable[(s * 5 + k) % tradable.length], itemId = randomUUID();
      const item = { id: itemId, ownerId: seller.gid, catalogId: entry.id, catalogVersion: CATALOG_V1.version, tier: entry.tier, rarity: entry.rarity,
        stats: entry.stats, quantity: 1, origin: 'shop', binding: entry.binding, reservation: null };
      await sql`insert into public.item_instances values(${itemId},${seller.gid},${sql.json(item as never)})`;
      const command = { kind: 'create-listing', operationId: randomUUID(), itemId, price: 40 + s * 5 + k };
      const [{ r }] = await sql`select public.create_listing(${seller.id},${command.operationId},${sql.json({ command, prepared: null } as never)}) as r`;
      if (!r?.ok) throw new Error(`listing failed: ${r?.code}`);
    }
  }
  return sellers;
}
/** Fills one character's inventory to the 60-item capacity with tradable shop items (operator inventory setup). */
async function fillInventory(gid: string) {
  const tradable = Object.values(CATALOG_V1.items).filter(entry => entry.binding === 'tradable' && entry.renownPrice === null);
  const [{ held }] = await sql`select count(*)::int as held from public.item_instances where gladiator_id=${gid}`;
  for (let k = held; k < RULES_V1.inventory.capacity; k++) {
    const entry = tradable[k % tradable.length], itemId = randomUUID();
    const item = { id: itemId, ownerId: gid, catalogId: entry.id, catalogVersion: CATALOG_V1.version, tier: entry.tier, rarity: entry.rarity,
      stats: entry.stats, quantity: 1, origin: 'shop', binding: entry.binding, reservation: null };
    await sql`insert into public.item_instances values(${itemId},${gid},${sql.json(item as never)})`;
  }
}
/**
 * A real command's client egress: its CORS preflight, the Edge response, and the session lookup the function makes in Auth
 * (backend traffic). The command is a real opt-in toggle by a present-slot character, sent through the local gateway.
 */
async function measureCommand(seller: { token: string }) {
  const headers = { Authorization: `Bearer ${seller.token}`, apikey: ANON_KEY, 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' };
  const url = `${API_URL}/functions/v1/game-command`;
  const preflight = await recorded(await fetch(url, { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization, apikey, content-type' } }));
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ kind: 'set-tournament-opt-in', operationId: randomUUID(), enabled: true }) });
  const answer = await recorded(response);
  const lookup = recorder(null);
  await lookup.client.auth.getUser(seller.token);
  let ok: unknown = null;
  try { ok = JSON.parse(answer.text)?.ok ?? null; } catch { ok = null; }
  return { status: response.status, ok, client: sizeOf([preflight, answer]), authLookup: sizeOf(lookup.records) };
}

// ---- The measurement world -------------------------------------------------------------------------------------------

/** A world at production cadence: `count` characters, the warm-up slot, then `slots` measured slots with the real worker. */
async function runWorld(count: number, slots: number, schedules: Choices[], optIn: boolean) {
  await resetWorld(WARM_UP - 1);
  const tables = await gameTables();
  const empty = await sizes(), systemStart = await systemSizes();
  const started = Date.now();
  const players = await many(count, i => player(i, WARM_UP, schedules, optIn));
  const seeded = await counts(tables);
  const windows: Window[] = [];
  const flagged: Report[] = [];
  let atEnd: Record<string, number> = seeded;
  await withWorker(async tick => {
    const revision = { value: (await sql`select revision from public.world_revision`)[0].revision as string };
    let before = seeded;
    for (const slot of [WARM_UP, ...Array.from({ length: slots }, (_, i) => FIRST + i)]) {
      const { window, after, flagged: bad } = await runWindow(slot, tick, tables, before, revision);
      if (slot !== WARM_UP) windows.push(window);
      flagged.push(...bad);
      before = after;
    }
    atEnd = before;
  });
  return { tables, empty, systemStart, players, windows, flagged, atEnd, runMs: Date.now() - started, end: await sizes() };
}
type World = Awaited<ReturnType<typeof runWorld>>;
const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
type Measured = TableMeasure & { asRunBytesPerRow: number; tupleBytes: number; indexBytes: number };
/**
 * Per-slot rows of each table and the modeled bytes of its rows. A regular slot is the mean of the windows the tournament
 * does not touch; a tournament slot is its own window plus the next one (which settles it) less one regular window. With
 * no tournament in the run every window is regular. As a cross-check, `asRunBytesPerRow` is the table's file growth per row
 * (dead row versions and first pages included).
 */
async function tableMeasures(run: World) {
  const hasTournament = run.windows.some(w => w.tournamentEntrants > 0);
  const regular = hasTournament ? run.windows.filter(w => w.slot !== TOURNAMENT && w.slot !== TOURNAMENT + 1) : run.windows;
  const regularOf = (f: (w: Window) => number) => mean(regular.map(f));
  const tournamentOf = (f: (w: Window) => number) => hasTournament
    ? f(run.windows.find(w => w.slot === TOURNAMENT)!) + f(run.windows.find(w => w.slot === TOURNAMENT + 1)!) - regularOf(f) : regularOf(f);
  // Compaction: a settlement receipt's result becomes {"compactedAtMs": n} at 90 days; a public bout result's log becomes
  // its fight summary at seven days (14-operations.sql). The row keeps its other bytes and its index entries.
  const [receipt] = await sql`select coalesce(avg(pg_column_size(r.result)),0)::float8 as full,
    pg_column_size(jsonb_build_object('compactedAtMs',1791590400000::bigint))::float8 as compacted
    from public.operation_receipts r where r.request->>'kind'='activity-settlement'`;
  const [bout] = await sql`select coalesce(avg(pg_column_size(b.result)),0)::float8 as full,
    coalesce(avg(pg_column_size((b.result-'battleLog')||jsonb_build_object('fight',jsonb_build_object('durationMs',b.result->'battleLog'->'durationMs',
      'victoryReason',b.result->'battleLog'->'victoryReason','tieBreakReason',coalesce(b.result->'battleLog'->'tieBreakReason','null'::jsonb))))),0)::float8 as compacted
    from public.tournament_bout_results b where jsonb_typeof(b.result->'battleLog')='object'`;
  const shrink: Record<string, number> = { 'public.operation_receipts': (Number(receipt.full) - Number(receipt.compacted)) * BLOAT_ALLOWANCE,
    'public.tournament_bout_results': (Number(bout.full) - Number(bout.compacted)) * BLOAT_ALLOWANCE };
  const tables: Record<string, Measured> = {};
  for (const name of run.tables) {
    const rows = run.atEnd[name] ?? 0, modeled = await modeledRow(name);
    tables[name] = { regularRows: regularOf(w => w.rows[name]), tournamentRows: tournamentOf(w => w.rows[name]), bytesPerRow: modeled.bytes,
      ...(shrink[name] !== undefined ? { compactedBytesPerRow: Math.max(0, modeled.bytes - shrink[name]) } : {}), rows, totalBytes: run.end[name],
      asRunBytesPerRow: rows > 0 ? Math.max(0, run.end[name] - run.empty[name]) / rows : 0, tupleBytes: modeled.tuple, indexBytes: modeled.index };
  }
  return { tables, regularOf, tournamentOf, regular };
}
/**
 * The database measure of a run: its tables, the system parts (the database without game, cron, pg_net and Auth rows; cron's
 * run log; pg_net's six-hour responses; Auth's rows per account) and the command and season extras.
 */
function databaseMeasure(run: World, measured: Record<string, Measured>, systemEnd: Record<string, number>, dispatchesPerSlot: number,
  extras: Pick<DatabaseMeasure, 'seasonBytes' | 'inventoryAllowanceBytes' | 'commandReceipts'>): DatabaseMeasure {
  const fixedEmpty = run.tables.filter(n => ['player', 'singleton'].includes(TABLE_CLASSES[n]?.retention)).reduce((sum, n) => sum + run.empty[n], 0);
  const baselineBytes = run.systemStart.database - run.systemStart.auth - run.systemStart.cron - run.systemStart.net - fixedEmpty;
  const netBytesPerRow = systemEnd.net_rows > 0 ? systemEnd.net_bytes / systemEnd.net_rows : 0;
  // pg_net keeps responses six hours (pg_net.ttl): 4.5 slots of dispatches.
  const netBytes = (6 * 60 / (SLOT / MINUTE)) * dispatchesPerSlot * netBytesPerRow;
  const tables = Object.fromEntries(Object.entries(measured).map(([n, m]) => [n, { regularRows: m.regularRows, tournamentRows: m.tournamentRows,
    bytesPerRow: m.bytesPerRow, ...(m.compactedBytesPerRow !== undefined ? { compactedBytesPerRow: m.compactedBytesPerRow } : {}), rows: m.rows,
    totalBytes: m.totalBytes }]));
  return { players: run.players.length, baselineBytes, slotsPerSeason: RULES_V1.seasons.durationSlots, tables, ...extras,
    system: { cronBytesPerRow: systemEnd.cron_row_bytes * BLOAT_ALLOWANCE, netBytes, authBytesPerPlayer: systemEnd.users > 0 ? systemEnd.identity / systemEnd.users : 0 } };
}
/** File sizes after VACUUM FULL (no dead row versions) per row, for the tables with at least 200 rows: a cross-check of the model. */
async function compactCheck(run: World, measured: Record<string, Measured>) {
  const big = run.tables.filter(n => (measured[n]?.rows ?? 0) >= 200);
  await sql.unsafe(`vacuum full ${big.map(quoted).join(', ')}`);
  const compact = await sizes(), rowsNow = await counts(big);
  return Object.fromEntries(big.map(n => [n, { compactBytesPerRow: Math.round(Math.max(0, compact[n] - run.empty[n]) / Math.max(1, rowsNow[n])),
    modeledLiveBytesPerRow: Math.round(measured[n].bytesPerRow / BLOAT_ALLOWANCE), asRunBytesPerRow: Math.round(measured[n].asRunBytesPerRow) }]));
}
const windowSummary = (list: Window[]) => list.map(({ statuses, workMs, rows: _rows, ...w }) => ({ ...w, statusesOk: statuses.every(s => s === 200),
  meanWorkMs: workMs.length ? Math.round(mean(workMs)) : 0, maxWorkMs: workMs.length ? Math.round(Math.max(...workMs)) : 0 }));
const perSlotRows = (tables: Record<string, Measured>) => Object.fromEntries(Object.entries(tables).filter(([, t]) => t.regularRows || t.tournamentRows)
  .map(([n, t]) => [n, { regular: Math.round(t.regularRows * 10) / 10, tournament: Math.round(t.tournamentRows * 10) / 10,
    bytesPerRow: Math.round(t.bytesPerRow), tuple: Math.round(t.tupleBytes), index: Math.round(t.indexBytes),
    ...(t.compactedBytesPerRow !== undefined ? { compactedBytesPerRow: Math.round(t.compactedBytesPerRow) } : {}) }]));

/**
 * The full measurement (tests/db/capacity.test.ts, case 1). Scenario 1 (the upper bound): `players` characters in three
 * rotating schedules with no Rest, all opted in, run the warm-up and `slots` measured slots at production cadence with the
 * real worker; then every table is measured and every read kind sized as a visitor and as a player, and the extras that need
 * a present-slot world (market offers, a command, a full inventory) and one season's archive are added. Scenario 2: the same
 * number of characters on the new-character schedule (Training / Woodland / Rest), three slots, measured for the database
 * and the worker only.
 */
export async function measureWorld(options: typeof CAPACITY) {
  const [{ ceiling }] = await sql`select max_dispatch_per_minute::int as ceiling from private.scheduler where singleton`;
  if (ceiling !== DISPATCH_PER_MINUTE) throw new Error(`the dispatch ceiling is ${ceiling}, the model assumes ${DISPATCH_PER_MINUTE}`);
  if (!isTournamentSlot(slotAt(TOURNAMENT * SLOT)) || isTournamentSlot(slotAt(FIRST * SLOT))) throw new Error('slot 301 must be the only tournament slot');
  const run = await runWorld(options.players, options.slots, SCHEDULES, true);
  const { players, windows, flagged } = run;
  const measured = await tableMeasures(run);
  const { regularOf, tournamentOf, regular } = measured;
  const lastSlot = FIRST + options.slots - 1;

  // Reads, as a visitor and as a player, on the world the run left (its last slot revealed and unsettled).
  const { reads, tournament: tournamentReads } = await measureReads(players, lastSlot);
  // Present-slot extras: a page of 50 market offers, a real command, and a full 60-item inventory.
  const sellers = await listOffers();
  reads.market = { visitor: await measure(recorder(null), c => readMarket(c)), player: await measure(recorder(players[0].token), c => readMarket(c)) };
  const command = await measureCommand(sellers[0]);
  reads.command = { visitor: ZERO, player: command.client };
  reads.authLookup = { visitor: ZERO, player: command.authLookup };
  // A session refresh answers the user (as the session lookup measured above returns it) with a new access token (about
  // 1,000 bytes of JWT) and about 200 bytes of session fields; email sign-in is disabled locally, so it is not sent.
  const lookup = command.authLookup;
  reads.authRefresh = { visitor: ZERO, player: { ...Object.fromEntries(ENCODINGS.map(e => [e, lookup[e] + (e === 'raw' ? 1_200 : 900)])) as Record<Encoding, number>,
    requests: 1, headerBytes: lookup.headerBytes } };
  const full = players.find(p => p.group === 2)!;
  await fillInventory(full.gid);
  reads.owner = { visitor: ZERO, player: await measure(recorder(full.token), c => readOwner(c)) };
  // A command receipt as stored (modeled, as every table): the mean of the real command receipts (creation, listing,
  // opt-in), with the receipt table's index entries.
  const receiptModel = await modeledRow('public.operation_receipts');
  const [commandRow] = await sql`select avg(pg_column_size(r.*))::float8 as tuple, count(*)::int as n from public.operation_receipts r
    where r.request->>'kind' in ('create-character','create-listing','set-tournament-opt-in')`;
  const commandReceiptBytes = (Number(commandRow.tuple) + LINE_POINTER + receiptModel.index) * BLOAT_ALLOWANCE;
  const receiptKinds = (await sql`select r.request->>'kind' as kind, count(*)::int as n, round(avg(pg_column_size(r.*)))::int as tuple,
    round(avg(pg_column_size(r.request)))::int as request, round(avg(pg_column_size(r.result)))::int as result from public.operation_receipts r group by 1 order by 1`)
    .map(r => ({ ...r }));
  // The 90-day row a command can add beside its receipt (a listing with its offer, a ledger row or a superseded schedule
  // revision): the largest modeled size among them.
  const listing = (await modeledRow('private.market_listings')).bytes + (await modeledRow('public.market_offers')).bytes;
  const commandSummaryBytes = Math.max(listing, (await modeledRow('public.wallet_ledger')).bytes, (await modeledRow('public.schedule_revisions')).bytes);
  const item = await modeledRow('public.item_instances');
  const inventoryAllowanceBytes = Math.max(0, options.players * RULES_V1.inventory.capacity - (run.atEnd['public.item_instances'] ?? 0)) * item.bytes;

  // One season's permanent rows for these players: ratings and standings from the run, then the archive and awards of a close.
  const [{ awarded }] = await sql`select private.close_season(0, floor(extract(epoch from clock_timestamp())*1000)::bigint) as awarded`;
  const seasonTables = Object.keys(TABLE_CLASSES).filter(n => TABLE_CLASSES[n].retention === 'season');
  let seasonBytes = 0;
  const seasonRows: Record<string, number> = {};
  for (const name of seasonTables) { const m = await modeledRow(name); seasonRows[name] = m.rows; seasonBytes += m.rows * m.bytes; }
  const systemEnd = await systemSizes();
  const dispatchesPerSlot = { regular: regularOf(w => w.dispatched), tournament: tournamentOf(w => w.dispatched) };
  const commandReceipts = { perPlayerPerDay: options.commandsPerPlayerPerDay, bytesPerRow: commandReceiptBytes, summaryBytesPerRow: commandSummaryBytes };
  const database = databaseMeasure(run, measured.tables, systemEnd, Math.max(dispatchesPerSlot.regular, dispatchesPerSlot.tournament),
    { seasonBytes, inventoryAllowanceBytes, commandReceipts });

  // Worker-side Data API traffic per slot (an estimate; see estimateWorkerBytes).
  const worker = await estimateWorkerBytes(windows, reads);
  const splitFactor = 1 + mean(regular.flatMap(w => w.workMs).map(ms => Math.min(1, ms / 30_000)));
  const egress: EgressMeasure = {
    reads,
    regular: { changedMinutes: regularOf(w => w.changedMinutes), arenaEntrants: regularOf(w => w.activities.arena ?? 0), splitFactor },
    // A viewer who watches the whole tournament: the camp reads its view at entry, at each of its rounds' reveals and at the
    // settlement, and the Tournaments panel as often again; each fought bout's log loads once.
    tournament: { changedMinutes: tournamentOf(w => w.changedMinutes), viewReads: 2 * (1 + Math.log2(64) + 1), logBytes: tournamentReads.logBytes },
    worker,
  };
  const compact = await compactCheck(run, measured.tables);

  // Scenario 2: the new-character schedule (a fresh world; the first one's measurement is complete above).
  const plain = await runWorld(options.players, 3, [DEFAULT_SCHEDULE], false);
  const plainMeasured = await tableMeasures(plain);
  const plainDispatches = plainMeasured.regularOf(w => w.dispatched);
  const plainDatabase = databaseMeasure(plain, plainMeasured.tables, await systemSizes(), plainDispatches,
    { seasonBytes, inventoryAllowanceBytes, commandReceipts });

  const summary = {
    players: options.players, viewers: options.viewers, measuredSlots: options.slots, warmUpSlot: WARM_UP, tournamentSlot: TOURNAMENT,
    runMs: run.runMs, windows: windowSummary(windows), dispatchesPerSlot, splitFactor, tournament: tournamentReads,
    command: { status: command.status, ok: command.ok, authLookup: command.authLookup },
    seasonAwards: awarded, seasonRows, seasonBytes, receiptKinds, commandReceiptBytes, commandSummaryBytes, inventoryAllowanceBytes,
    system: { start: run.systemStart, end: systemEnd }, rowsPerSlot: perSlotRows(measured.tables), compactCheck: compact,
    defaultSchedule: { runMs: plain.runMs, windows: windowSummary(plain.windows), dispatchesPerSlot: plainDispatches, flagged: plain.flagged.length,
      rowsPerSlot: perSlotRows(plainMeasured.tables) },
  };
  return { firstSlot: FIRST, tables: run.tables, windows, flagged: [...flagged, ...plain.flagged], plainWindows: plain.windows, database, plainDatabase,
    invocations: { regularPerSlot: dispatchesPerSlot.regular, tournamentPerSlot: dispatchesPerSlot.tournament },
    plainInvocations: { regularPerSlot: plainDispatches, tournamentPerSlot: plainDispatches }, egress, summary };
}

/**
 * The worker's own Data API responses in a regular and a tournament slot, estimated from what the run stored: every claimed
 * lease carries its job input (plus about 300 bytes of lease fields and a 500-byte response envelope for its completion), an
 * expedition settlement reads the owner state once, a tournament bout reads the stored graph with every result of the rounds
 * before its own, and each invocation makes about nine small claim and coordination calls (500 bytes each). Compressed sizes
 * use the ratio of the inputs themselves. Counted as egress only if the hosted project bills Edge-to-API traffic (Task 24).
 */
async function estimateWorkerBytes(windows: Window[], reads: Record<string, RoleSizes>) {
  const perWindow = new Map<number, Record<Encoding, number>>();
  for (const w of windows) {
    const cutoff = w.slot * SLOT;
    const [jobs] = await sql`select coalesce(sum(octet_length(j.input::text) + 800),0)::float8 as bytes, count(*)::int as n,
      coalesce(string_agg(left(j.input::text, 4000), ''),'') as sample from private.job_attempts a join private.jobs j on j.id=a.job_id
      where a.claimed_at_ms>=${cutoff} and a.claimed_at_ms<${cutoff + SLOT}`;
    const [{ n: expeditions }] = await sql`select count(*)::int as n from private.job_attempts a join private.jobs j on j.id=a.job_id
      where j.kind='settlement' and j.input->>'resolvedKind'='expedition' and a.claimed_at_ms>=${cutoff} and a.claimed_at_ms<${cutoff + SLOT}`;
    // Each fought bout's fenced read returns the graph as stored text, with the results of its own and later rounds still null.
    let graphs = 0;
    for (const t of await sql`select id, octet_length(private.tournament_graph(id)::text)::float8 as total from private.tournaments where slot_index=${w.slot}`) {
      const bouts = await sql`select round::int as round, bye, octet_length(coalesce(result::text,'null'))::float8 - 4 as extra
        from private.tournament_bouts where tournament_id=${t.id}`;
      for (const b of bouts.filter(x => !x.bye)) graphs += Number(t.total) - bouts.filter(x => !x.bye && x.round >= b.round).reduce((s, x) => s + Number(x.extra), 0);
    }
    const sample = String(jobs.sample);
    const ratio = (e: Encoding) => e === 'raw' || !sample.length ? 1 : (e === 'gzip' ? gzipSync(sample, { level: 6 }) : brotliCompressSync(sample,
      { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } })).length / Buffer.byteLength(sample, 'utf8');
    const owner = reads.owner?.player ?? reads.ownerStarter.player;
    perWindow.set(w.slot, Object.fromEntries(ENCODINGS.map(e => [e, (Number(jobs.bytes) + graphs) * ratio(e) + expeditions * (owner[e] + owner.headerBytes)
      + w.invocations * 9 * 500])) as Record<Encoding, number>);
  }
  const regular = windows.filter(w => w.slot !== TOURNAMENT && w.slot !== TOURNAMENT + 1).map(w => perWindow.get(w.slot)!);
  const of = (slot: number) => perWindow.get(slot)!;
  const regularPerSlot = Object.fromEntries(ENCODINGS.map(e => [e, regular.reduce((s, r) => s + r[e], 0) / regular.length])) as Record<Encoding, number>;
  const tournamentPerSlot = Object.fromEntries(ENCODINGS.map(e => [e, of(TOURNAMENT)[e] + of(TOURNAMENT + 1)[e] - regularPerSlot[e]])) as Record<Encoding, number>;
  // A command's function: its session lookup in Auth, an owner-state read (queue-build, buy-shop, sell-item, buy-listing), the
  // rate-limit and command RPC responses (about 600 bytes each).
  const owner = reads.owner?.player ?? reads.ownerStarter.player, lookup = reads.authLookup?.player;
  const perCommand = Object.fromEntries(ENCODINGS.map(e => [e, (lookup ? lookup[e] + lookup.headerBytes : 0) + owner[e] + owner.headerBytes + 2 * 600])) as Record<Encoding, number>;
  return { regularPerSlot, tournamentPerSlot, perCommand };
}

/**
 * Boundary latency at production cadence (Task 23.3 latency fix): `players` characters on the new-character schedule run
 * slots 300 (Training), 301 (Woodland) and 302 (Rest), so boundary 302 follows a slot of expeditions; then as many Arena-only
 * characters (no tournament entry) run slots 300 and 301, the 23.2 case. Every tick is the real scheduled tick with the real
 * worker, as in measureWorld.
 */
export async function measureCadence(players: number) {
  const ARENA_ONLY: Choices = { morning: ARENA, afternoon: ARENA, evening: ARENA };
  const expeditions = await runWorld(players, 3, [DEFAULT_SCHEDULE], false);
  const arena = await runWorld(players, 2, [ARENA_ONLY], false);
  const summary = (run: World) => run.windows.map(w => ({ slot: w.slot, activities: w.activities, publishedMs: w.publishedMs, firstTicks: w.firstTicks,
    previousSettlements: w.previousSettlements, settledInCutoffTick: w.settledInCutoffTick, statusesOk: w.statuses.every(s => s === 200) }));
  return { expeditions: summary(expeditions), arena: summary(arena), flagged: [...expeditions.flagged, ...arena.flagged].length };
}

// ---- Season close and standings ----------------------------------------------------------------------------------------

const LEAGUES = ['bronze', 'silver', 'gold', 'champion'] as const;
/** A season row with seasonAt's launch-epoch-0 bounds, as boundary phase 2 writes it (tests/db/seasons.test.ts). */
async function openSeason(index: number) {
  const season = seasonAt(index * RULES_V1.seasons.durationSlots, 0);
  await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(${season.index},${season.startsAtMs},${season.endsAtMs})`;
}
async function timedClose(season: number) {
  const began = performance.now();
  const [{ awards }] = await sql`select private.close_season(${season}, floor(extract(epoch from clock_timestamp())*1000)::bigint) as awards`;
  const ms = performance.now() - began;
  const [{ rows }] = await sql`select count(*)::int as rows from public.season_standings where season_index=${season}`;
  return { ms: Math.round(ms * 10) / 10, rows: rows as number, awards: awards as number };
}

/**
 * C14: the synchronous close of boundary phase 2, timed as one statement with its deferred projection triggers at commit.
 * Season 0 has four 50-player leagues (200 characters, one qualified rating row each). The stress season 1 has 500 rows a
 * league: 500 characters each rated in all four leagues, character i qualified (five human bouts) in the leagues up to
 * i mod 4, so it is eligible in exactly that one and every league awards its three places. Rating rows are seeded by SQL,
 * as tests/db/seasons.test.ts does.
 */
export async function measureSeasonClose() {
  await resetWorld(null);
  const people = await many(500, () => character());
  const rating = (i: number) => 900 + (i * 37) % 400;
  const rows50 = people.slice(0, 200).map((p, i) => ({ gid: p.gid, league: LEAGUES[i % 4], rating: rating(i), wins: 3 + (i % 5), losses: 2 + (i % 3) }));
  await openSeason(0);
  await sql`insert into private.arena_ratings ${sql(rows50.map(r => ({ gladiator_id: r.gid, league: r.league, season_index: 0, rating: r.rating,
    human_wins: r.wins, human_losses: r.losses })))}`;
  const ms50 = await timedClose(0);
  await openSeason(1);
  const rows500 = people.flatMap((p, i) => LEAGUES.map((league, l) => ({ gladiator_id: p.gid, league, season_index: 1, rating: rating(i + l),
    human_wins: l <= i % 4 ? 3 + (i % 5) : 0, human_losses: l <= i % 4 ? 2 + (i % 3) : 1 })));
  for (let start = 0; start < rows500.length; start += 500) await sql`insert into private.arena_ratings ${sql(rows500.slice(start, start + 500))}`;
  const ms500 = await timedClose(1);
  return { ms50, ms500 };
}

type PlanSummary = { planningMs: number; executionMs: number; sharedHit: number; sharedRead: number; nodes: string[] };
function summarize(plan: Record<string, unknown>): PlanSummary {
  const nodes: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    nodes.push(String(node['Node Type']) + (node['Index Name'] ? ` (${node['Index Name']})` : node['Relation Name'] ? ` (${node['Relation Name']})` : ''));
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  const root = plan.Plan as Record<string, unknown>;
  walk(root);
  return { planningMs: Number(plan['Planning Time']), executionMs: Number(plan['Execution Time']), sharedHit: Number(root['Shared Hit Blocks'] ?? 0),
    sharedRead: Number(root['Shared Read Blocks'] ?? 0), nodes };
}
/** EXPLAIN (ANALYZE, BUFFERS) of `query` as a visitor (the anon role, its row-level security), in a read-only transaction. */
async function explainAsVisitor(query: string, params: unknown[]): Promise<PlanSummary> {
  return sql.begin('read only', async tx => {
    await tx`set local role anon`;
    const [row] = await tx.unsafe(`explain (analyze, buffers, format json) ${query}`, params as never[]);
    return summarize((row['QUERY PLAN'] as Record<string, unknown>[])[0]);
  }) as Promise<PlanSummary>;
}
async function medianMs(runs: number, read: () => Promise<unknown>) {
  for (let i = 0; i < 3; i++) await read();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) { const began = performance.now(); await read(); times.push(performance.now() - began); }
  times.sort((a, b) => a - b);
  return { medianMs: Math.round(times[Math.floor(runs / 2)] * 10) / 10, maxMs: Math.round(times[runs - 1] * 10) / 10 };
}

/**
 * C13: one league-season of `n` rating rows (real characters; the projection publishes them as standings at commit). Times
 * the first standings page and the one-row standing read through the real read adapters as a visitor (two requests each:
 * the latest season, then the rows), and explains both queries as the anon role. The last-ranked character has rating 0.
 */
export async function measureStandings(n: number) {
  await resetWorld(null);
  const people = await many(n, () => character());
  await openSeason(0);
  const rows = people.map((p, i) => ({ gladiator_id: p.gid, league: 'bronze', season_index: 0, rating: i === n - 1 ? 0 : 1 + (i * 7919) % 2000,
    human_wins: i % 20, human_losses: i % 7 }));
  for (let start = 0; start < rows.length; start += 500) await sql`insert into private.arena_ratings ${sql(rows.slice(start, start + 500))}`;
  const [{ standings }] = await sql`select count(*)::int as standings from public.arena_standings where league='bronze' and season_index=0`;
  const last = people[n - 1];
  const visitor = createClient(API_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const page = await readStandings(visitor, 'bronze');
  const oneRow = await readStandingOf(visitor, 'bronze', last.gid);
  const pageTime = await medianMs(15, () => readStandings(visitor, 'bronze'));
  const oneRowTime = await medianMs(15, () => readStandingOf(visitor, 'bronze', last.gid));
  const columns = 'gladiator_id,name,rating,human_wins,human_losses,rank,promoted,reward_eligible';
  const plans = {
    page: await explainAsVisitor(`select ${columns} from public.arena_standing_reads where league=$1 and season_index=$2 and rank>$3 order by rank limit 50`,
      ['bronze', 0, 0]),
    oneRow: await explainAsVisitor(`select ${columns} from public.arena_standing_reads where league=$1 and season_index=$2 and gladiator_id=$3 limit 1`,
      ['bronze', 0, last.gid]),
  };
  return { rows: standings as number, page: { rows: page.rows.length, nextCursor: page.nextCursor !== null }, oneRow: { rank: oneRow?.rank ?? null },
    pageMs: pageTime.medianMs, pageMaxMs: pageTime.maxMs, oneRowMs: oneRowTime.medianMs, oneRowMaxMs: oneRowTime.maxMs, plans };
}
