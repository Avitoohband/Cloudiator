-- Task 23 reapplicable source. Committed M01-M17 are immutable; deploy only the generated migrations: M17
-- (supabase/migrations/*_release.sql, Task 23.1, access hardening) and M18 (*_timing.sql, Task 23.2, the second part below).
-- Release access hardening (plan 2026-10-19-task-23-release-readiness, Task 23.1, and the controller's rulings on the access
-- matrix's findings). tests/db/access-matrix.test.ts derives every expectation from the catalog through the exported audit
-- scripts/access-audit.sql. On the M01-M16 replay it found these client privileges, all revoked here:
--   1. anon's MAINTAIN on the eight M01 owner tables (C1). M01's generated revokes covered REFERENCES, TRIGGER and TRUNCATE
--      only; PostgreSQL 17's MAINTAIN came with the platform's default table privileges.
--   2. M01's default `grant update on sequences` to anon and authenticated in schema public.
--   A. authenticated's MAINTAIN on the same eight tables.
--   B. authenticated's MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on the owner_state view (recorded by M13, not changed then).
--   C. The default table privileges in schema public: anon and authenticated TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on
--      every new table, which every later source had to revoke by hand.
-- Afterwards a client role holds only SELECT (anon on the open projections; authenticated on those and on its owner-filtered
-- tables) and USAGE on schema public.
--
-- Every statement is idempotent and names each non-SELECT privilege kind, so on a project whose platform defaults started
-- fuller (Task 24 compares the hosted project with scripts/access-audit.sql) the same source still leaves only SELECT. The
-- function defaults hold no client grant on the replay; their revoke is included for the same reason.
--
-- Accepted exceptions (controller rulings; documented in docs/operations/migrations.md, M17):
--   D. service_role (the backend) keeps MAINTAIN on the eight tables, MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on
--      owner_state, and the default UPDATE on new public sequences and TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on new public
--      tables. They are pinned in the access matrix's service_role snapshot, so any change fails a test.
--   E. Platform-owned and outside this migration's scope: supabase_admin's default privileges in schema public (anon,
--      authenticated and service_role receive everything on its new tables, sequences and functions; postgres is not a member
--      of supabase_admin and cannot alter them) and in the graphql, graphql_public, storage and supabase_functions schemas;
--      the platform's defaults for postgres in schema storage (the same grants); PUBLIC's USAGE on schema public; PUBLIC's
--      CONNECT and TEMP on the database. None of our objects is created by supabase_admin or in those schemas. The access
--      matrix checks the defaults of the role that owns our objects (postgres) in public and private.
begin;

-- 1 and B (anon): the owner tables and the owner view grant a visitor nothing at all.
revoke all on public.builds, public.gladiators, public.item_instances, public.operation_receipts, public.reservations,
  public.schedules, public.wallet_ledger, public.wallets, public.owner_state from anon;
-- A and B: a signed-in player keeps only SELECT (filtered by the owner_read policies, and by the invoker view).
revoke insert, update, delete, truncate, references, trigger, maintain on public.builds, public.gladiators, public.item_instances,
  public.operation_receipts, public.reservations, public.schedules, public.wallet_ledger, public.wallets, public.owner_state
  from authenticated;

-- 2 and C: objects postgres creates in schema public from now on give anon and authenticated nothing by default.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- ===== Task 23.2: timing correctness (M18) =====
-- Plan 2026-10-19-task-23-release-readiness, Task 23.2, Decisions 5 and 6. (Decision 3 is test-only; Decision 4 is the
-- worker's bounded retry of a busy coordination in supabase/functions/_shared/backend/jobs.ts.)

-- Decision 5 (C3): the dispatch budget per scheduled minute. 05-expeditions.sql's body, unchanged except the budget: it
-- counts the invocations dispatched in the scheduled minute this tick runs in, [minute start, minute start + 60 s), instead
-- of those of the last rolling 60 s. pg_cron starts each minute's tick a few hundred ms late, and dispatch time is sampled
-- after coordination, so a cutoff tick whose coordination took longer left the next tick (for example 59 950 ms later) a
-- rolling window that still counted its invocations; at 50 characters publication then waited for a third tick (121 s).
-- The ceiling stays five per scheduled minute (about 216 000 in a 30-day month, 5 x 1 440 x 30); two consecutive minutes can
-- now send up to ten within 60 s across their edge. Time is still sampled after the dispatch lock.
create or replace function private.dispatch_workers() returns jsonb language plpgsql security invoker set search_path='' as $$
declare url text; secret text; now_ms bigint; minute_start bigint; simple integer; combat integer; spent integer; budget integer;
  wanted integer; request bigint; requests jsonb:='[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('cloudiator:dispatch',3));
  now_ms:=private.planning_now_ms();
  minute_start:=now_ms-now_ms%60000;
  select decrypted_secret into url from vault.decrypted_secrets where name='game_worker_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='game_worker_secret';
  if url is null or secret is null then return jsonb_build_object('ok',true,'dispatched',0,'reason','unconfigured'); end if;
  select count(*) filter (where kind<>'simulation'),count(*) filter (where kind='simulation') into simple,combat from private.jobs
    where private.dependencies_ready(id) and due_at_ms<=now_ms and (status='pending' or (status='leased' and lease_until_ms<=now_ms and attempts<max_attempts));
  select count(*) into spent from private.dispatch_log where dispatched_at_ms>=minute_start and dispatched_at_ms<minute_start+60000;
  select max_dispatch_per_minute into budget from private.scheduler where singleton;
  wanted:=greatest(0,least(coalesce(budget,5)-spent,ceil(simple/20.0)::integer+ceil(combat/5.0)::integer));
  for i in 1..wanted loop
    -- Positional (url, body, params, headers, timeout) avoids PL/pgSQL name capture in named arguments.
    request:=net.http_post(url,'{}'::jsonb,'{}'::jsonb,
      jsonb_build_object('Authorization','Bearer '||secret,'Content-Type','application/json'),30000);
    insert into private.dispatch_log(dispatched_at_ms,request_id,claimable_simple,claimable_combat) values(now_ms,request,simple,combat);
    requests:=requests||to_jsonb(request);
  end loop;
  return jsonb_build_object('ok',true,'dispatched',wanted,'requestIds',requests,'claimableSimple',simple,'claimableCombat',combat);
end $$;
-- Owner only (pg_cron runs it inside private.cron_tick), as before.
revoke all on function private.dispatch_workers() from public, anon, authenticated, service_role;

-- Decision 6 (C5): the published slot in the public revision state. private.coordinator.published_slot is private, so the
-- revision row carries a copy that visitors and players read with the revision (public.world_revision): a slot with
-- published_slot_index < slot_index is still being prepared, without the client's five-minute grace. The copy is written by
-- a deferred constraint trigger, so it changes exactly when the coordinator's transaction commits (never on a rollback) and
-- takes the global revision row last, like every projection write (06-projections.sql). A publication already holds that
-- row from phase 8 (private.boundary_published); every other change of published_slot (the first coordination, skipped
-- empty boundaries, an operator) takes it only at commit, after every coordinator, account and character lock.
alter table public.world_revision_state add column if not exists published_slot_index bigint;
create or replace function private.mirror_published_slot() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  update public.world_revision_state r set published_slot_index=c.published_slot from private.coordinator c
    where r.singleton and c.singleton and r.published_slot_index is distinct from c.published_slot;
  return null;
end $$;
drop trigger if exists mirror_published_slot on private.coordinator;
create constraint trigger mirror_published_slot after update of published_slot on private.coordinator
  deferrable initially deferred for each row when (old.published_slot is distinct from new.published_slot)
  execute function private.mirror_published_slot();
-- A trigger function needs no EXECUTE grant to fire; nobody calls it directly, the backend included.
revoke all on function private.mirror_published_slot() from public, anon, authenticated, service_role;
-- Backfill: the coordinator's current published slot.
update public.world_revision_state r set published_slot_index=c.published_slot from private.coordinator c
  where r.singleton and c.singleton and r.published_slot_index is distinct from c.published_slot;
-- 06-projections.sql's view with the copy appended. create or replace keeps its grants (SELECT for anon, authenticated and
-- service_role; Task 13.1 and the access matrix's OPEN list) and its security_invoker option.
create or replace view public.world_revision with(security_invoker=true) as
  select r.revision::text||':'||floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint::text||':'||
    coalesce((select max(reveal_at_ms) from public.visible_events),0)::text as revision,
    floor(extract(epoch from statement_timestamp())*1000)::bigint as server_now_ms,
    floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint as slot_index,
    r.published_slot_index
  from public.world_revision_state r where singleton;

notify pgrst, 'reload schema';
commit;
