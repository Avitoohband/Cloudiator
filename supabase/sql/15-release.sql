-- Task 23 reapplicable source. Committed migrations are immutable; deploy only the generated migrations: M17
-- (supabase/migrations/*_release.sql, Task 23.1, access hardening), M18 (*_timing.sql, Task 23.2, the second part below) and
-- M19 (*_dispatch_released.sql, Task 23.3, the third part: settlements released by due reveals).
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

-- ===== Task 23.3: settlements released by due reveals (M19) =====
-- Task 23.3's capacity run (docs/operations/release-evidence.md, "Boundary latency") found every boundary after a slot of
-- expeditions publishing at about 121.6 s, over spec §10.4's 120 s. An expedition's settlement depends on all of its reveal
-- jobs (10-tournament-results.sql's plan acceptance), and its last stage, "Arrive at camp", falls due exactly at the next
-- cutoff. The cutoff tick counted only dependency-ready jobs, so it dispatched for the reveals alone; the invocations claimed
-- settlements first and reveals last, so the settlements those reveals released waited for the next tick (minute 1), phase 1
-- with them, and preparation for minute 2.
-- Now a settlement whose every unfinished prerequisite is a claimable due reveal ("released") is counted by the dispatch and
-- claimed together with those reveals: claim_jobs(…,'settlement',…) returns the reveals first, then the settlement, never
-- splitting the group across the batch cap, and the worker runs each lease by its own kind (supabase/functions/_shared/
-- backend/jobs.ts, unchanged), so the reveal completes before the settlement settles in the same invocation. The cutoff tick
-- then settles the whole slot and the boundary publishes in the next tick (about 61 s), as an Arena-only boundary did.
-- Unchanged: Task 23.2's five invocations per scheduled minute (Decision 5), batch limits (20 simple, 5 combat), the
-- dependency rule itself (a settlement still settles only after its reveals complete; settle_activity checks it again), and
-- every other kind's claim.

-- Whether a pending, due settlement waits only on reveals this tick can claim: it has an unfinished prerequisite, and every
-- unfinished prerequisite is a reveal that is due by now_ms, claimable (pending, or leased with an expired lease and attempts
-- left) and dependency-ready itself. A reveal another worker holds, a reveal not due yet or any other kind keeps it waiting.
create or replace function private.released_by_due_reveals(job uuid,now_ms bigint) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from private.job_dependencies d join private.jobs p on p.id=d.prerequisite_id
      where d.job_id=released_by_due_reveals.job and p.status<>'completed')
    and not exists(select 1 from private.job_dependencies d join private.jobs p on p.id=d.prerequisite_id
      where d.job_id=released_by_due_reveals.job and p.status<>'completed'
        and not (p.kind='reveal' and p.due_at_ms<=released_by_due_reveals.now_ms
          and (p.status='pending' or (p.status='leased' and p.lease_until_ms<=released_by_due_reveals.now_ms and p.attempts<p.max_attempts))
          and private.dependencies_ready(p.id)))
$$;

-- Task 23.2's dispatch (per scheduled minute), unchanged except that a released settlement counts as claimable simple work
-- beside its reveals (both are leases of the same claim), and the answer reports how many there were.
create or replace function private.dispatch_workers() returns jsonb language plpgsql security invoker set search_path='' as $$
declare url text; secret text; now_ms bigint; minute_start bigint; simple integer; combat integer; released integer; spent integer;
  budget integer; wanted integer; request bigint; requests jsonb:='[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('cloudiator:dispatch',3));
  now_ms:=private.planning_now_ms();
  minute_start:=now_ms-now_ms%60000;
  select decrypted_secret into url from vault.decrypted_secrets where name='game_worker_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='game_worker_secret';
  if url is null or secret is null then return jsonb_build_object('ok',true,'dispatched',0,'reason','unconfigured'); end if;
  select count(*) filter (where kind<>'simulation'),count(*) filter (where kind='simulation'),
    count(*) filter (where kind='settlement' and not private.dependencies_ready(id)) into simple,combat,released from private.jobs
    where due_at_ms<=now_ms and (status='pending' or (status='leased' and lease_until_ms<=now_ms and attempts<max_attempts))
      and (private.dependencies_ready(id) or (kind='settlement' and private.released_by_due_reveals(id,now_ms)));
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
  return jsonb_build_object('ok',true,'dispatched',wanted,'requestIds',requests,'claimableSimple',simple,'claimableCombat',combat,
    'releasedSettlements',released);
end $$;
-- Owner only (pg_cron runs it inside private.cron_tick), as before.
revoke all on function private.dispatch_workers() from public, anon, authenticated, service_role;

-- 07-arena.sql's claim, unchanged for every kind but settlement, now selected into an ordered list before one shared lease
-- statement. A settlement claim walks the due settlements in due order; a released one is taken only together with every
-- reveal it waits on (each locked with SKIP LOCKED and re-checked after the lock, so a reveal another claim holds leaves the
-- settlement for later), only while the whole group fits the cap, reveals first. Leases are returned in that order, so the
-- worker completes the reveals before it settles. Database time is sampled once, before any lock, as before.
create or replace function public.claim_jobs(worker_id uuid,kind text,batch_limit integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare now_ms bigint:=private.planning_now_ms(); cap integer; leases jsonb; picked uuid[]:='{}'::uuid[]; candidate record; waits uuid[];
  held uuid[]; settlement uuid;
begin
  if claim_jobs.worker_id is null or claim_jobs.kind is null or claim_jobs.kind not in ('prepare','pair','simulation','reveal','settlement')
    or batch_limit is null or batch_limit<1 then
    raise exception 'invalid claim' using errcode='22023';
  end if;
  cap:=least(batch_limit,case when claim_jobs.kind='simulation' then 5 else 20 end);
  perform private.sweep_exhausted_leases(now_ms);
  if claim_jobs.kind<>'settlement' then
    select coalesce(array_agg(x.id order by x.due_at_ms,x.id),'{}'::uuid[]) into picked from (
      select j.id,j.due_at_ms from private.jobs j
      where j.kind=claim_jobs.kind and j.due_at_ms<=now_ms
        and private.dependencies_ready(j.id)
        and (j.status='pending' or (j.status='leased' and j.lease_until_ms<=now_ms and j.attempts<j.max_attempts))
      order by j.due_at_ms,j.id limit cap for update skip locked) x;
  else
    for candidate in select j.id,private.dependencies_ready(j.id) as ready from private.jobs j
      where j.kind='settlement' and j.due_at_ms<=now_ms
        and (j.status='pending' or (j.status='leased' and j.lease_until_ms<=now_ms and j.attempts<j.max_attempts))
        and (private.dependencies_ready(j.id) or private.released_by_due_reveals(j.id,now_ms))
      order by j.due_at_ms,j.id loop
      exit when cardinality(picked)>=cap;
      waits:='{}'::uuid[];
      if not candidate.ready then
        select coalesce(array_agg(p.id order by p.due_at_ms,p.id),'{}'::uuid[]) into waits from private.job_dependencies d
          join private.jobs p on p.id=d.prerequisite_id where d.job_id=candidate.id and p.status<>'completed';
      end if;
      continue when cardinality(picked)+cardinality(waits)+1>cap;
      select j.id into settlement from private.jobs j where j.id=candidate.id and j.kind='settlement' and j.due_at_ms<=now_ms
        and (j.status='pending' or (j.status='leased' and j.lease_until_ms<=now_ms and j.attempts<j.max_attempts))
        for update skip locked;
      continue when settlement is null;
      if cardinality(waits)>0 then
        select coalesce(array_agg(x.id order by x.due_at_ms,x.id),'{}'::uuid[]) into held from (
          select p.id,p.due_at_ms from private.jobs p where p.id=any(waits) and p.kind='reveal' and p.due_at_ms<=now_ms
            and (p.status='pending' or (p.status='leased' and p.lease_until_ms<=now_ms and p.attempts<p.max_attempts))
            and private.dependencies_ready(p.id)
          for update skip locked) x;
        continue when cardinality(held)<>cardinality(waits);
      end if;
      picked:=picked||waits||settlement;
    end loop;
  end if;
  with chosen as (
    select x.id,x.ord from unnest(picked) with ordinality x(id,ord)
  ), previous as (
    select j.id,j.status as previous_status,j.attempts as previous_attempt from private.jobs j join chosen c on c.id=j.id
  ), expired as (
    update private.job_attempts a set finished_at_ms=now_ms,outcome='expired',failure_code='lease-expired'
    from previous p where p.previous_status='leased' and a.job_id=p.id and a.attempt=p.previous_attempt and a.outcome is null
  ), claimed as (
    update private.jobs j set status='leased',lease_token=gen_random_uuid(),lease_owner=claim_jobs.worker_id,leased_at_ms=now_ms,
      lease_until_ms=now_ms+120000,attempts=j.attempts+1
    from chosen c where j.id=c.id
    returning j.*,c.ord
  ), logged as (
    insert into private.job_attempts(job_id,attempt,worker_id,claimed_at_ms) select c.id,c.attempts,claim_jobs.worker_id,now_ms from claimed c
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'token',c.lease_token,'expiresAtMs',c.lease_until_ms,'kind',c.kind,
    'activityId',c.activity_id,'gladiatorId',c.gladiator_id,'slotIndex',c.slot_index,'snapshot',c.input,'seed',c.seed,
    'rulesVersion',c.rules_version,'attempt',c.attempts) order by c.ord),'[]'::jsonb) into leases from claimed c;
  return leases;
end $$;
-- As 07-arena.sql: the backend claims, nobody else; the helper is the backend's too (claim_jobs runs as service_role).
revoke all on function public.claim_jobs(uuid,text,integer), private.released_by_due_reveals(uuid,bigint) from public, anon, authenticated;
grant execute on function public.claim_jobs(uuid,text,integer), private.released_by_due_reveals(uuid,bigint) to service_role;

notify pgrst, 'reload schema';
commit;
