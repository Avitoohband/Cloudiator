import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { OPEN, PUBLIC_TOURNAMENT_COLUMNS } from '../fixtures/access.ts';

// Task 23.1 (M17): the release access matrix. Every expectation is derived from the catalog through the exported operator
// audit (scripts/access-audit.sql, one read-only SELECT), except the OPEN list of visitor projections
// (tests/fixtures/access.ts) and the pinned service_role snapshot below. The visitor, row-security, function,
// default-privilege and owner-policy cases also prove, inside a transaction that always rolls back, that the audit reports the
// violation they guard against; the authenticated case reads the same sections for another role.
const commands = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());

const AUDIT = readFileSync(new URL('../../scripts/access-audit.sql', import.meta.url), 'utf8');
type Row = { section: string; object: string; grantee: string; privilege: string; detail: string };
/** The client roles: visitors (anon), signed-in players (authenticated), and PUBLIC, which every role inherits. */
const CLIENT_ROLES = ['anon', 'authenticated', 'PUBLIC'];
/**
 * The platform's settings, outside the matrix (accepted exception E in supabase/sql/15-release.sql): other roles' default
 * privileges and the owner's defaults in platform schemas, and database privileges. The audit lists them so that Task 24 can
 * compare the hosted project with a local replay; only a client's CREATE on the database is checked here.
 */
const PLATFORM_SECTIONS = ['platform-default', 'database'];
const line = (r: Row) => [r.section, r.object, r.grantee, r.privilege, r.detail].filter(Boolean).join(' ');
const lines = (rows: Row[]) => rows.map(line).sort();
const toRows = (result: unknown) => [...(result as Row[])];
const audit = async () => toRows(await sql.unsafe(AUDIT));
class RolledBack extends Error {}
/**
 * What `read` sees inside a transaction that first runs `statements`. The transaction always rolls back. It runs on a
 * connection of its own that is closed afterwards, so no later statement shares a backend with the rolled-back DDL (a
 * precaution after one transient PostgreSQL error in the Task 23.1 runs; see docs/implementation/task-23.1-report.md).
 */
async function rolledBack<T>(statements: string[], read: (tx: postgres.TransactionSql) => Promise<T>) {
  const probe = postgres(process.env.LOCAL_DB_URL!, { max: 1, onnotice: () => {} });
  let seen: T | undefined;
  try {
    await probe.begin(async tx => {
      for (const statement of statements) await tx.unsafe(statement);
      seen = await read(tx);
      throw new RolledBack();
    }).catch(error => { if (!(error instanceof RolledBack)) throw error; });
  } finally { await probe.end(); }
  return seen as T;
}
/** The audit as seen inside a transaction that first runs `statements` and always rolls back. */
const auditAfter = (...statements: string[]) => rolledBack(statements, async tx => toRows(await tx.unsafe(AUDIT)));
/**
 * Every permissive SELECT (or ALL) policy for authenticated or PUBLIC on a table outside the OPEN projections whose USING
 * expression does not reference auth.uid(): such a policy would show one account another owner's rows. Run with `db`.
 */
async function unfilteredOwnerPolicies(db: postgres.Sql | postgres.TransactionSql) {
  return (await db`select n.nspname||'.'||c.relname||'.'||p.polname as policy
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and p.polpermissive and p.polcmd in ('r','*')
      and (0 = any(p.polroles) or 'authenticated'::regrole = any(p.polroles))
      and not (n.nspname = 'public' and c.relname = any(${OPEN}))
      and strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'auth.uid()') = 0
    order by 1`).map(r => r.policy as string);
}
/**
 * Every public relation a signed-in player may read: whether it may read all columns, the columns it may read, and a
 * deterministic page order (the primary key, or every readable column where there is none).
 */
async function signedInReadable() {
  return (await sql`select c.relname as name, has_table_privilege('authenticated', c.oid, 'SELECT') as whole,
    array(select a.attname from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      and has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT') order by a.attnum) as columns,
    array(select a.attname from pg_index i cross join unnest(i.indkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid=c.oid and a.attnum=k.attnum where i.indrelid=c.oid and i.indisprimary order by k.ord) as key
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p','f')
      and has_any_column_privilege('authenticated', c.oid, 'SELECT') order by 1`)
    .map(r => ({ name: r.name as string, whole: r.whole as boolean, columns: r.columns as string[], key: r.key as string[] }));
}
/** Everything `client` reads from each of `relations` through the Data API, as JSON text, page by page in a fixed order. */
async function readAll(client: SupabaseClient, relations: Awaited<ReturnType<typeof signedInReadable>>) {
  const seen: Record<string, string> = {};
  for (const r of relations) {
    seen[r.name] = '';
    for (let from = 0; ; from += 50) {
      let query = client.from(r.name).select(r.whole ? '*' : r.columns.join(','));
      for (const column of r.key.length ? r.key : r.columns) query = query.order(column);
      const { data, error } = await query.range(from, from + 49);
      if (error) throw Error(`${r.name}: ${error.message}`);
      seen[r.name] += JSON.stringify(data);
      if (data.length < 50) break;
    }
  }
  return seen;
}
/** `schema.relation` of a relation, column or policy object. */
const relationOf = (object: string) => object.split('.').slice(0, 2).join('.');

/**
 * service_role's effective privileges (every audit section but policies and the platform's), one line per object. Pinned so
 * that any drift fails and shows the lines added and removed; a deliberate change edits these lines in the same commit.
 * Accepted backend exception (controller ruling, exception D in supabase/sql/15-release.sql): service_role keeps MAINTAIN on
 * the eight M01 owner tables, MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on owner_state, and the default UPDATE on new
 * public sequences and MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on new public tables.
 */
const SERVICE_ROLE = [
  'default postgres:public:sequences: UPDATE',
  'default postgres:public:tables: MAINTAIN,REFERENCES,TRIGGER,TRUNCATE',
  'function private.accept_arena_result(uuid, jsonb): EXECUTE',
  'function private.accept_job_result(uuid, jsonb): EXECUTE',
  'function private.accept_pairing(uuid, jsonb): EXECUTE',
  'function private.accept_tournament_result(uuid, jsonb): EXECUTE',
  'function private.active_rules_version(): EXECUTE',
  'function private.activity_executor_ready(text): EXECUTE',
  'function private.apply_inventory_plan(uuid, jsonb): EXECUTE',
  'function private.apply_pending_build(uuid, bigint): EXECUTE',
  'function private.arena_rewards(uuid): EXECUTE',
  'function private.arena_settlement_failure(uuid): EXECUTE',
  'function private.boundary_apply_changes(bigint): EXECUTE',
  'function private.boundary_check_stamina(bigint): EXECUTE',
  'function private.boundary_close_season(bigint): EXECUTE',
  'function private.boundary_pair(bigint): EXECUTE',
  'function private.boundary_published(bigint): EXECUTE',
  'function private.boundary_recompute(bigint): EXECUTE',
  'function private.boundary_recompute_leagues(bigint): EXECUTE',
  'function private.boundary_settle_previous(bigint): EXECUTE',
  'function private.boundary_snapshot(bigint): EXECUTE',
  'function private.boundary_start(bigint): EXECUTE',
  'function private.close_season(bigint, bigint): EXECUTE',
  'function private.dependencies_ready(uuid): EXECUTE',
  'function private.expedition_rewards(uuid, jsonb): EXECUTE',
  'function private.expire_seller_listings(uuid, bigint): EXECUTE',
  'function private.guard_arena_rating(): EXECUTE',
  'function private.guard_cosmetic(): EXECUTE',
  'function private.guard_frozen(): EXECUTE',
  'function private.guard_historical_strength(): EXECUTE',
  'function private.guard_inventory_item(): EXECUTE',
  'function private.guard_job(): EXECUTE',
  'function private.guard_league(): EXECUTE',
  'function private.guard_market_listing(): EXECUTE',
  'function private.guard_receipt(): EXECUTE',
  'function private.guard_reserved_item(): EXECUTE',
  'function private.guard_season(): EXECUTE',
  'function private.guard_tournament_bout(): EXECUTE',
  'function private.guard_tournament_bout_result(): EXECUTE',
  'function private.guard_wallet_checkpoint(): EXECUTE',
  // Task 23.8 (M22): RULES_V1.idle, restated for boundary phase 3.
  'function private.idle_rules(): EXECUTE',
  'function private.initial_schedule_revision(): EXECUTE',
  'function private.inventory_command(uuid, uuid, jsonb, text): EXECUTE',
  'function private.json_project(jsonb, text[]): EXECUTE',
  'function private.league_rank(text): EXECUTE',
  'function private.market_close_listing(uuid, text, uuid): EXECUTE',
  'function private.market_command(uuid, uuid, jsonb, text): EXECUTE',
  'function private.pairing_input(bigint, text, bigint, text): EXECUTE',
  'function private.planning_command(uuid, uuid, jsonb, text): EXECUTE',
  'function private.planning_now_ms(): EXECUTE',
  'function private.prepare_activity_jobs(uuid): EXECUTE',
  'function private.project_changed_character(): EXECUTE',
  'function private.project_character(uuid): EXECUTE',
  'function private.projection_changed(): EXECUTE',
  'function private.publish_tournaments(bigint): EXECUTE',
  // Task 23.3 latency fix (M19): public.claim_jobs, which runs as service_role, asks whether a settlement waits only on due reveals.
  'function private.released_by_due_reveals(uuid, bigint): EXECUTE',
  'function private.resume_operator_job(uuid): EXECUTE',
  'function private.safe_battle_log(jsonb): EXECUTE',
  'function private.safe_integer(jsonb, numeric): EXECUTE',
  'function private.safe_settlement(jsonb): EXECUTE',
  'function private.schedule_effective_slot(text, bigint): EXECUTE',
  'function private.season_bounds(bigint): EXECUTE',
  'function private.season_index(bigint): EXECUTE',
  'function private.season_rules(): EXECUTE',
  'function private.settle_activity_core(uuid, uuid, jsonb): EXECUTE',
  'function private.settle_rewards(uuid): EXECUTE',
  'function private.slot_phase(bigint): EXECUTE',
  'function private.sweep_exhausted_leases(bigint): EXECUTE',
  'function private.tournament_graph(text): EXECUTE',
  'function private.tournament_rewards(uuid): EXECUTE',
  'function private.tournament_settlement_failure(uuid): EXECUTE',
  'function private.valid_bracket(uuid, jsonb, jsonb): EXECUTE',
  'function private.valid_preparation(uuid, jsonb): EXECUTE',
  'function private.valid_tournament_outcomes(text, text, text, text, jsonb): EXECUTE',
  'function public.advance_boundary(bigint, uuid): EXECUTE',
  'function public.buy_listing(uuid, uuid, jsonb): EXECUTE',
  'function public.buy_shop(uuid, uuid, jsonb): EXECUTE',
  'function public.cancel_build(uuid, uuid, jsonb): EXECUTE',
  'function public.cancel_listing(uuid, uuid, jsonb): EXECUTE',
  'function public.claim_jobs(uuid, text, integer): EXECUTE',
  'function public.commit_expedition_plan(uuid, uuid, jsonb): EXECUTE',
  'function public.complete_job(uuid, uuid, jsonb): EXECUTE',
  'function public.consume_command_rate(uuid, boolean): EXECUTE',
  'function public.coordinate_work(): EXECUTE',
  'function public.create_gladiator(uuid, uuid, jsonb): EXECUTE',
  'function public.create_listing(uuid, uuid, jsonb): EXECUTE',
  'function public.discard_item(uuid, uuid, jsonb): EXECUTE',
  'function public.edit_schedule(uuid, uuid, jsonb): EXECUTE',
  'function public.expedition_settlement_input(uuid, uuid): EXECUTE',
  'function public.fail_job(uuid, uuid, text): EXECUTE',
  'function public.queue_build(uuid, uuid, jsonb): EXECUTE',
  'function public.refresh_projections(): EXECUTE',
  'function public.renew_job(uuid, uuid): EXECUTE',
  'function public.sell_item(uuid, uuid, jsonb): EXECUTE',
  'function public.set_tournament_opt_in(uuid, uuid, jsonb): EXECUTE',
  'function public.settle_activity(uuid, uuid): EXECUTE',
  'function public.settle_expedition(uuid, uuid, jsonb): EXECUTE',
  'function public.tournament_bout_input(uuid, uuid): EXECUTE',
  'relation private.activity_snapshots: DELETE,INSERT,SELECT,UPDATE',
  'relation private.arena_assignment_sides: DELETE,INSERT,SELECT',
  'relation private.arena_assignments: DELETE,INSERT,SELECT',
  'relation private.arena_ratings: INSERT,SELECT,UPDATE',
  'relation private.arena_results: DELETE,INSERT,SELECT',
  'relation private.boundaries: DELETE,INSERT,SELECT,UPDATE',
  'relation private.boundary_members: DELETE,INSERT,SELECT,UPDATE',
  'relation private.boundary_work: DELETE,INSERT,SELECT,UPDATE',
  'relation private.command_attempts: DELETE,INSERT,SELECT',
  'relation private.coordinator: DELETE,INSERT,SELECT,UPDATE',
  'relation private.dispatch_log: SELECT',
  'relation private.expedition_plans: DELETE,INSERT,SELECT',
  'relation private.job_attempts: DELETE,INSERT,SELECT,UPDATE',
  'relation private.job_dependencies: DELETE,INSERT,SELECT',
  'relation private.jobs: DELETE,INSERT,SELECT,UPDATE',
  'relation private.market_listings: INSERT,SELECT,UPDATE',
  'relation private.operations_events: SELECT',
  // Task 23.8 (M22): the owner's activity signal, written by consume_command_rate and read by boundary phase 3.
  'relation private.owner_signals: INSERT,SELECT,UPDATE',
  'relation private.pending_build_preparations: DELETE,INSERT,SELECT,UPDATE',
  'relation private.retention_state: SELECT',
  'relation private.rules_versions: SELECT',
  'relation private.scheduler: SELECT',
  'relation private.season_awards: INSERT,SELECT',
  'relation private.season_epoch: SELECT',
  'relation private.settled_slots: DELETE,INSERT,SELECT,UPDATE',
  'relation private.tournament_bouts: DELETE,INSERT,SELECT,UPDATE',
  'relation private.tournament_entries: DELETE,INSERT,SELECT',
  'relation private.tournament_results: DELETE,INSERT,SELECT',
  'relation private.tournaments: DELETE,INSERT,SELECT',
  'relation private.wallet_checkpoints: SELECT',
  'relation public.activities: DELETE,INSERT,SELECT,UPDATE',
  'relation public.activity_stages: DELETE,INSERT,SELECT',
  'relation public.arena_standing_reads: SELECT',
  'relation public.arena_standings: DELETE,INSERT,SELECT,UPDATE',
  'relation public.builds: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  // Task 23.8 (M22): a character's rest at home, written by boundary phase 3 and consume_command_rate.
  'relation public.character_rests: INSERT,SELECT,UPDATE',
  'relation public.gladiators: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  'relation public.item_instances: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  'relation public.market_offers: DELETE,INSERT,SELECT',
  'relation public.operation_receipts: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  'relation public.owned_cosmetics: INSERT,SELECT',
  'relation public.owner_state: MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE',
  'relation public.pending_build_items: DELETE,INSERT,SELECT,UPDATE',
  'relation public.public_profile_reads: SELECT',
  'relation public.public_profiles: DELETE,INSERT,SELECT,UPDATE',
  'relation public.recent_results: DELETE,INSERT,SELECT,UPDATE',
  'relation public.reservations: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  'relation public.schedule_revisions: DELETE,INSERT,SELECT,UPDATE',
  'relation public.schedules: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  'relation public.season_standings: INSERT,SELECT',
  'relation public.seasons: INSERT,SELECT,UPDATE',
  'relation public.tournament_bout_results: DELETE,INSERT,SELECT',
  'relation public.tournament_placements: DELETE,INSERT,SELECT',
  'relation public.tournament_views: DELETE,INSERT,SELECT',
  'relation public.visible_events: SELECT',
  'relation public.wallet_ledger: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  'relation public.wallets: DELETE,INSERT,MAINTAIN,SELECT,UPDATE',
  'relation public.world_actor_reads: SELECT',
  'relation public.world_actors: DELETE,INSERT,SELECT,UPDATE',
  'relation public.world_revision: SELECT',
  'relation public.world_revision_state: DELETE,INSERT,SELECT,UPDATE',
  'schema private: USAGE',
  'schema public: USAGE',
];

async function fighter() {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Matrix ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  return { owner, gid: created.value.gladiatorId };
}
/** Every base table's contents, hashed: proof that the refused requests changed nothing anywhere. */
async function contents() {
  const tables = await sql`select n.nspname||'.'||c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p') order by 1`;
  const hashes: Record<string, string> = {};
  for (const { name } of tables) {
    const [{ hash }] = await sql.unsafe(`select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) as hash from ${name} t`);
    hashes[name] = hash;
  }
  return hashes;
}

describe('release access matrix', () => {
  it('grants visitors SELECT on the open projections only and nothing else on any relation', async () => {
    const rows = await audit();
    // anon's whole effective set outside policies, defaults (both checked below) and the platform's settings: the open
    // projections, the public tournament columns and USAGE on schema public. No sequence, function, role membership or private
    // schema.
    expect(lines(rows.filter(r => r.grantee === 'anon' && !['policy', 'default', ...PLATFORM_SECTIONS].includes(r.section)))).toEqual([
      ...OPEN.filter(o => o !== 'tournament_views').map(o => `relation public.${o} anon SELECT`),
      ...PUBLIC_TOURNAMENT_COLUMNS.split(',').map(c => `column public.tournament_views.${c} anon SELECT`),
      'schema public anon USAGE',
    ].sort());
    // PUBLIC reaches every role, so it holds nothing on any relation, column or sequence. Its one privilege outside functions
    // and defaults (checked below) is PostgreSQL's USAGE on schema public, which opens no object by itself.
    expect(lines(rows.filter(r => r.grantee === 'PUBLIC' && !['policy', 'default', 'function', ...PLATFORM_SECTIONS].includes(r.section))))
      .toEqual(['schema public PUBLIC USAGE']);
    // No client role may create schemas in the database (CONNECT and TEMPORARY are the platform's, exception E).
    expect(lines(rows.filter(r => r.section === 'database' && CLIENT_ROLES.includes(r.grantee) && r.privilege === 'CREATE'))).toEqual([]);

    // The audit sees every privilege kind, column grants, sequences and PUBLIC.
    const probe = await auditAfter('create table public.matrix_probe(id int)', 'create sequence public.matrix_probe_seq',
      'grant references, trigger, maintain on public.matrix_probe to anon', 'grant select (id) on public.matrix_probe to public',
      'grant usage on sequence public.matrix_probe_seq to anon');
    expect(lines(probe.filter(r => r.object.startsWith('public.matrix_probe') && ['anon', 'PUBLIC'].includes(r.grantee))))
      .toEqual(expect.arrayContaining(['column public.matrix_probe.id PUBLIC SELECT', 'column public.matrix_probe.id anon SELECT',
        'relation public.matrix_probe anon MAINTAIN', 'relation public.matrix_probe anon REFERENCES',
        'relation public.matrix_probe anon TRIGGER', 'sequence public.matrix_probe_seq anon USAGE']));
  });

  it('grants authenticated users no write on any table and no execute on any function', async () => {
    const rows = await audit();
    const mine = rows.filter(r => r.grantee === 'authenticated');
    // Relations and columns: SELECT only, and only in public.
    expect(lines(mine.filter(r => ['relation', 'column'].includes(r.section) && r.privilege !== 'SELECT'))).toEqual([]);
    expect(lines(mine.filter(r => ['relation', 'column'].includes(r.section) && !r.object.startsWith('public.')))).toEqual([]);
    // No sequence, function or role membership; USAGE on schema public only (private is not exposed).
    expect(lines(mine.filter(r => ['sequence', 'function', 'membership', 'schema'].includes(r.section))))
      .toEqual(['schema public authenticated USAGE']);
    // Every readable table is filtered by a SELECT policy for signed-in readers (row security is on everywhere: next case).
    const readable = new Set(mine.filter(r => ['relation', 'column'].includes(r.section)).map(r => relationOf(r.object)));
    for (const o of OPEN) expect(readable.has(`public.${o}`), o).toBe(true);
    const tables = new Set((await sql`select n.nspname||'.'||c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private') and c.relkind in ('r','p')`).map(r => r.name as string));
    const policed = new Set(rows.filter(r => r.section === 'policy' && r.privilege === 'SELECT' && ['authenticated', 'PUBLIC'].includes(r.grantee))
      .map(r => relationOf(r.object)));
    expect([...readable].filter(o => tables.has(o) && !policed.has(o))).toEqual([]);
    // No policy gives a client role any command but SELECT.
    expect(lines(rows.filter(r => r.section === 'policy' && CLIENT_ROLES.includes(r.grantee) && r.privilege !== 'SELECT'))).toEqual([]);
  });

  it('filters every signed-in read outside the open projections by auth.uid()', async () => {
    // Every permissive read policy for signed-in players on a table outside OPEN names the caller (auth.uid()); an open-read
    // policy there (`using (true)`) would let every account read another owner's rows.
    expect(await unfilteredOwnerPolicies(sql)).toEqual([]);
    // Proven by two rolled-back regressions: an owner filter opened in place, and a second permissive policy beside one.
    const before = (await audit()).filter(r => r.section === 'policy' && r.object === 'public.wallets.owner_read');
    const probe = await rolledBack(["alter policy owner_read on public.wallets using (true)",
      'create policy matrix_probe_read on public.builds for select to authenticated using (true)'],
    async tx => ({ gaps: await unfilteredOwnerPolicies(tx), audit: toRows(await tx.unsafe(AUDIT)) }));
    expect(probe.gaps).toEqual(['public.builds.matrix_probe_read', 'public.wallets.owner_read']);
    // The audit's policy rows carry the body's hash, so the hosted comparison sees a changed body too.
    const after = probe.audit.filter(r => r.section === 'policy' && r.object === 'public.wallets.owner_read');
    expect(after.map(r => r.grantee)).toEqual(before.map(r => r.grantee));
    expect(after.map(r => r.detail)).not.toEqual(before.map(r => r.detail));
    expect(before.map(r => r.detail.split(' ')[0])).toEqual(['permissive']);
    expect(lines(probe.audit.filter(r => r.object === 'public.builds.matrix_probe_read')))
      .toEqual([expect.stringMatching(/^policy public\.builds\.matrix_probe_read authenticated SELECT permissive md5:[0-9a-f]{32}$/)]);
  });

  it('enables RLS on every public table and security_invoker on every view', async () => {
    const rows = await audit();
    expect(lines(rows.filter(r => ['rls-disabled', 'not-security-invoker', 'materialized-view'].includes(r.section)))).toEqual([]);
    // The audit reports a table without row security in either schema, a view without security_invoker and a materialized view.
    const probe = await auditAfter('create table public.matrix_probe(id int)', 'create table private.matrix_probe(id int)',
      'create view public.matrix_probe_view as select 1 as id', 'create materialized view public.matrix_probe_mv as select 1 as id');
    expect(lines(probe.filter(r => ['rls-disabled', 'not-security-invoker', 'materialized-view'].includes(r.section)))).toEqual([
      'materialized-view public.matrix_probe_mv no row security', 'not-security-invoker public.matrix_probe_view no options',
      'rls-disabled private.matrix_probe row security off', 'rls-disabled public.matrix_probe row security off']);
  });

  it('defines no SECURITY DEFINER function and pins search_path on every function', async () => {
    const rows = await audit();
    expect(lines(rows.filter(r => ['security-definer', 'search-path'].includes(r.section)))).toEqual([]);
    expect(lines(rows.filter(r => r.section === 'function' && CLIENT_ROLES.includes(r.grantee)))).toEqual([]);
    // Every function in public and private outside extensions is audited: the backend's and the owner-only ones together.
    const [{ count }] = await sql`select count(*)::int as count from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`;
    const backend = rows.filter(r => r.section === 'function' && r.grantee === 'service_role').length;
    const ownerOnly = await sql`select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
      and not has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`;
    expect(backend + ownerOnly.length).toBe(count);
    // The audit reports a definer function, an unpinned or unset search path, and EXECUTE for each client role.
    const probe = await auditAfter(
      "create function public.matrix_probe_definer() returns int language sql security definer set search_path='' as 'select 1'",
      "create function private.matrix_probe_path() returns int language sql set search_path=public as 'select 1'",
      "create function public.matrix_probe_open() returns int language sql as 'select 1'",
      'grant execute on function public.matrix_probe_definer() to anon',
      'grant execute on function private.matrix_probe_path() to authenticated',
      'grant execute on function public.matrix_probe_open() to public');
    expect(lines(probe.filter(r => r.object.includes('.matrix_probe_') && r.grantee !== 'service_role'))).toEqual([
      'function private.matrix_probe_path() authenticated EXECUTE', 'function public.matrix_probe_definer() anon EXECUTE',
      'function public.matrix_probe_open() PUBLIC EXECUTE', 'function public.matrix_probe_open() anon EXECUTE',
      'function public.matrix_probe_open() authenticated EXECUTE', 'search-path private.matrix_probe_path() search_path',
      'search-path public.matrix_probe_open() unset', 'security-definer public.matrix_probe_definer() SECURITY DEFINER'].sort());
  });

  it('names the settings in a finding row, never their values (Task 24.1, 23.1 M4)', async () => {
    // A view's options and a function's configuration can carry configuration values; the hosted CSV leaves the database, so
    // a finding row says which settings an object has and never what they are set to.
    const VALUE = 'matrix-probe-setting-value';
    const probe = await auditAfter(
      'create view public.matrix_probe_view with (security_barrier=true) as select 1 as id',
      `create function private.matrix_probe_cfg() returns int language sql set search_path=public set work_mem='64kB'
         set application_name='${VALUE}' as 'select 1'`,
      `create function public.matrix_probe_pinned() returns int language sql set search_path='' set application_name='${VALUE}' as 'select 1'`);
    expect(lines(probe.filter(r => ['not-security-invoker', 'search-path'].includes(r.section) && r.object.includes('.matrix_probe_')))).toEqual([
      'not-security-invoker public.matrix_probe_view security_barrier',
      'search-path private.matrix_probe_cfg() application_name,search_path,work_mem',
      'search-path public.matrix_probe_pinned() application_name,search_path']);
    // No row of any section carries a setting's value, nor any `name=value` pair.
    const leaks = probe.filter(r => [r.section, r.object, r.grantee, r.privilege, r.detail].some(field => field.includes(VALUE)
      || field.includes('64kB') || field.includes('=')));
    expect(lines(leaks)).toEqual([]);
  });

  it('leaves no default privileges to anon or authenticated', async () => {
    const rows = await audit();
    expect(lines(rows.filter(r => r.section === 'default' && CLIENT_ROLES.includes(r.grantee)))).toEqual([]);
    // The audit reports a default grant to a client role, per schema and globally.
    const granted = await auditAfter('alter default privileges in schema private grant select on tables to authenticated',
      'alter default privileges grant execute on functions to public');
    expect(lines(granted.filter(r => r.section === 'default' && CLIENT_ROLES.includes(r.grantee)))).toEqual(expect.arrayContaining([
      'default postgres:private:tables authenticated SELECT', 'default postgres:private:functions PUBLIC EXECUTE',
      'default postgres:public:functions PUBLIC EXECUTE']));
  });

  it('gives anon and authenticated nothing on a new table, sequence or function the owner creates', async () => {
    // postgres creates one of each in both schemas, inside a transaction that always rolls back.
    const created = await auditAfter(
      'create table public.matrix_probe(id int generated always as identity, note text)', 'create sequence public.matrix_probe_seq',
      "create function public.matrix_probe() returns int language sql set search_path='' as 'select 1'",
      'create table private.matrix_probe(id int generated always as identity, note text)', 'create sequence private.matrix_probe_seq',
      "create function private.matrix_probe() returns int language sql set search_path='' as 'select 1'");
    // The audit saw them: the backend's accepted defaults (exception D) reached the new public table and sequences.
    expect(lines(created.filter(r => r.object.startsWith('public.matrix_probe') && r.grantee === 'service_role'))).toEqual(expect.arrayContaining([
      'relation public.matrix_probe service_role MAINTAIN', 'relation public.matrix_probe service_role TRUNCATE',
      'sequence public.matrix_probe_id_seq service_role UPDATE', 'sequence public.matrix_probe_seq service_role UPDATE']));
    // No client role holds any privilege of any kind on any of them, nor on any of their columns.
    expect(lines(created.filter(r => r.object.includes('.matrix_probe') && CLIENT_ROLES.includes(r.grantee)))).toEqual([]);
  });

  it('matches the pinned service_role privilege set', async () => {
    const grouped = new Map<string, string[]>();
    for (const r of (await audit()).filter(r => r.grantee === 'service_role' && !['policy', ...PLATFORM_SECTIONS].includes(r.section))) {
      const key = `${r.section} ${r.object}`;
      grouped.set(key, [...(grouped.get(key) ?? []), r.privilege]);
    }
    const actual = [...grouped].map(([key, privileges]) => `${key}: ${privileges.sort().join(',')}`).sort();
    const added = actual.filter(x => !SERVICE_ROLE.includes(x)), removed = SERVICE_ROLE.filter(x => !actual.includes(x));
    expect({ added, removed }, 'service_role drifted from the pinned snapshot; change SERVICE_ROLE only deliberately')
      .toEqual({ added: [], removed: [] });
    expect(SERVICE_ROLE).toEqual([...SERVICE_ROLE].sort());
  });

  it('denies direct writes and private RPCs through the Data API as owner, other account and visitor', { timeout: 120_000 }, async () => {
    const f = await fighter(), other = await account();
    const clients: [string, SupabaseClient][] = [['owner', f.owner.client], ['other account', other.client], ['visitor', anonymous]];
    // pg_relation_is_updatable: the bit mask of the commands a relation can take at all (UPDATE 4, INSERT 8, DELETE 16). The
    // probe column is the first updatable one when the relation has any, so an update of a column that cannot be updated
    // (0A000, before the privilege check) never stands in for the privilege check: since Task 23.2 world_revision has one,
    // published_slot_index, beside its three computed columns.
    const relations = await sql`select n.nspname as schema, c.relname as name, (select a.attname from pg_attribute a
      where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by pg_column_is_updatable(c.oid, a.attnum, true) desc, a.attnum
      limit 1) as col,
      pg_relation_is_updatable(c.oid, true) as updatable
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private') and c.relkind in ('r','v','m','p','f') order by 1,2`;
    const functions = await sql`select n.nspname as schema, p.proname as name, coalesce(p.proargnames, '{}') as args
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')
        and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') order by 1,2`;
    const before = await contents();
    const unexpected: string[] = [];
    const check = (label: string, error: { code?: string; message?: string } | null, codes: string[]) => {
      if (!codes.includes(error?.code ?? '')) unexpected.push(`${label}: ${error ? `${error.code} ${error.message}` : 'allowed'}`);
    };
    // A write is refused for want of the privilege (42501). A view that cannot take the command at all (no updatable column
    // or not auto-updatable) refuses it before the privilege check (55000); the catalog cases above prove no grant either.
    const refusal = (updatable: number, bit: number) => (updatable & bit ? ['42501'] : ['42501', '55000']);
    for (const [who, client] of clients) {
      for (const r of relations.filter(r => r.schema === 'public')) {
        // The update and delete filters match no row, so a privilege, had it existed, would still have changed nothing.
        check(`${who} insert ${r.name}`, (await client.from(r.name).insert({})).error, refusal(r.updatable, 8));
        check(`${who} update ${r.name}`, (await client.from(r.name).update({ [r.col]: null }).is(r.col, null)).error, refusal(r.updatable, 4));
        check(`${who} delete ${r.name}`, (await client.from(r.name).delete().is(r.col, null)).error, refusal(r.updatable, 16));
      }
      for (const fn of functions.filter(fn => fn.schema === 'public')) {
        const args = Object.fromEntries((fn.args as string[]).map(name => [name, null]));
        check(`${who} rpc ${fn.name}`, (await client.rpc(fn.name, args)).error, ['42501']);
      }
      // Real writes aimed at the owner's own rows, which a granted privilege would have reached.
      check(`${who} raises the owner's money`, (await client.from('wallets').update({ money: 1_000_000_000 }).eq('gladiator_id', f.gid)).error, ['42501']);
      check(`${who} grants the owner an item`, (await client.from('item_instances').insert({ id: randomUUID(), gladiator_id: f.gid, item: {} })).error, ['42501']);
      check(`${who} deletes the owner's receipts`, (await client.from('operation_receipts').delete().eq('gladiator_id', f.gid)).error, ['42501']);
      check(`${who} creates a character as the owner`, (await client.rpc('create_gladiator',
        { actor_id: f.owner.id, operation_id: randomUUID(), input: { command: creation('Forged ' + who.slice(0, 5)) } })).error, ['42501']);
      // Exposure: the Data API does not serve the private schema, so no private table or function is reachable at all.
      for (const r of relations.filter(r => r.schema === 'private')) {
        check(`${who} exposure private.${r.name}`, (await client.schema('private').from(r.name).select('*')).error, ['PGRST106']);
      }
      for (const fn of functions.filter(fn => fn.schema === 'private')) {
        check(`${who} exposure rpc private.${fn.name}`, (await client.schema('private').rpc(fn.name, {})).error, ['PGRST106']);
      }
    }
    expect(unexpected).toEqual([]);
    expect(await contents()).toEqual(before);
  });

  it('keeps seeds, plans and snapshots unreadable even by their owner', { timeout: 60_000 }, async () => {
    const f = await fighter(), marker = `matrix-secret-${randomUUID()}`;
    const slot = Math.floor(Date.now() / 4_800_000) - 1, activityId = randomUUID();
    await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms)
      values(${activityId},${f.gid},${slot},${slot * 4_800_000},${(slot + 1) * 4_800_000},'{"kind":"expedition","expeditionId":"woodland"}',
        'expedition','active',${slot * 4_800_000})`;
    // The private inputs of that activity, each carrying the marker: its snapshot and seed, its expedition plan, a job's input
    // and seed, an Arena assignment's seed, and a queued build's preparation snapshot.
    await sql`insert into private.activity_snapshots(activity_id,snapshot,seed,rules_version)
      values(${activityId},${sql.json({ marker, kind: 'snapshot' })},${marker + ':activity-seed'},'v1')`;
    await sql`insert into private.expedition_plans(activity_id,plan) values(${activityId},${sql.json({ marker, kind: 'plan' })})`;
    await sql`insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms,status)
      values('simulation',${'matrix:' + randomUUID()},${slot},${f.gid},${activityId},${sql.json({ marker, kind: 'input' })},
        ${marker + ':job-seed'},'v1',${slot * 4_800_000},'completed')`;
    const [{ pair }] = await sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms,status)
      values('pair',${'matrix-pair:' + randomUUID()},${slot},'{}','v1',0,'completed') returning id as pair`;
    await sql`insert into private.arena_assignments(battle_id,pairing_job_id,slot_index,league,season_index,kind,seed,assignment,created_at_ms)
      values(${'matrix:' + randomUUID()},${pair},${slot},'bronze',0,'human',${marker + ':arena-seed'},${sql.json({ marker, gladiatorIds: [f.gid] })},0)`;
    await sql`insert into private.pending_build_preparations(gladiator_id,operation_id,snapshot,stamina_maximum,received_at_ms)
      values(${f.gid},${randomUUID()},${sql.json({ marker, kind: 'build' })},104,0)`;
    const [{ planted }] = await sql`select (select count(*) from private.activity_snapshots where seed like ${marker + '%'})
      + (select count(*) from private.expedition_plans where plan->>'marker' = ${marker})
      + (select count(*) from private.jobs where seed like ${marker + '%'})
      + (select count(*) from private.arena_assignments where seed like ${marker + '%'})
      + (select count(*) from private.pending_build_preparations where snapshot->>'marker' = ${marker}) as planted`;
    expect(Number(planted)).toBe(5);

    // The owner reads every public relation the catalog lets a signed-in player read, page by page, and never sees the marker.
    const seen = Object.values(await readAll(f.owner.client, await signedInReadable())).join('');
    expect(seen).toContain(f.gid);
    expect(seen).toContain(activityId);
    expect(seen).not.toContain(marker);
    // Even their owner cannot name the private tables (exposure), and no client role holds any privilege on any of them.
    for (const t of ['activity_snapshots', 'expedition_plans', 'jobs', 'arena_assignments', 'pending_build_preparations']) {
      expect((await f.owner.client.schema('private').from(t).select('*')).error?.code, t).toBe('PGRST106');
    }
    expect(await sql`select c.relname from pg_class c where c.relnamespace='private'::regnamespace and c.relkind in ('r','v','m','p','f')
      and (has_any_column_privilege('authenticated', c.oid, 'SELECT') or has_any_column_privilege('anon', c.oid, 'SELECT'))`).toEqual([]);
  });

  it("never shows one account another owner's private state", { timeout: 60_000 }, async () => {
    const owner = await fighter(), other = await fighter();
    // Creation writes no activity, fee reservation, pending build item or cosmetic, so each gladiator gets one of each, as a
    // published activity, a queued build (its held fee and its reserved starter item, under one operation) and a bought
    // banner would write them. resetIdentity's truncate removes them before the next case.
    const slot = Math.floor(Date.now() / 4_800_000) - 1;
    const seed = async (gid: string) => {
      const activityId = randomUUID(), operationId = randomUUID();
      await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms)
        values(${activityId},${gid},${slot},${slot * 4_800_000},${(slot + 1) * 4_800_000},'{"kind":"rest"}','rest','active',${slot * 4_800_000})`;
      await sql`insert into public.reservations(gladiator_id,operation_id,money,renown,status) values(${gid},${operationId},10,0,'held')`;
      const [{ item }] = await sql`select id as item from public.item_instances where gladiator_id=${gid} order by id limit 1`;
      await sql`insert into public.pending_build_items(item_id,gladiator_id,operation_id) values(${item},${gid},${operationId})`;
      await sql`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding) values(${gid},'banner','v1','bound')`;
      // Task 23.8: a rest at home, as boundary phase 3 writes it.
      await sql`insert into public.character_rests(gladiator_id,since_slot,through_slot) values(${gid},${slot},${slot})`;
      return [activityId];
    };
    const [ownerActivities, otherActivities] = [await seed(owner.gid), await seed(other.gid)];
    // Every relation a signed-in player may read that is not an open projection: the owner-filtered state.
    const owned = (await signedInReadable()).filter(r => !OPEN.includes(r.name));
    expect(owned.length).toBeGreaterThan(0);
    const holding = (read: Record<string, string>, ids: string[]) =>
      Object.entries(read).filter(([, text]) => ids.some(id => text.includes(id))).map(([name]) => name).sort();
    const names = owned.map(r => r.name).sort();
    // Each relation's own read holds an id of its reader (account, gladiator or activity), relation by relation, so the
    // absence below is never vacuous: a relation that returns nothing to its owner fails here by name.
    const ownerIds = [owner.owner.id, owner.gid, ...ownerActivities], otherIds = [other.owner.id, other.gid, ...otherActivities];
    const mine = await readAll(owner.owner.client, owned);
    expect(holding(mine, ownerIds), 'relations whose read by their owner holds no owner id').toEqual(names);
    const theirs = await readAll(other.owner.client, owned);
    expect(holding(theirs, otherIds), 'relations whose read by the other account holds none of its own ids').toEqual(names);
    // The other account reads, from no relation, any id of the owner's.
    expect(holding(theirs, ownerIds), "relations that showed the other account the owner's ids").toEqual([]);
  });
});
