-- Task 23 reapplicable source. Committed migrations are immutable; deploy only the generated migrations: M17
-- (supabase/migrations/*_release.sql, Task 23.1, access hardening), M18 (*_timing.sql, Task 23.2, the second part below) and
-- M19 (*_dispatch_released.sql, Task 23.3, the third part: settlements released by due reveals), corrected by M20
-- (*_shared_reveal.sql, Task 23.3 fix round 1: the third part's claim_jobs leases a reveal several settlements share once),
-- M21 (*_job_payloads.sql, Task 23.7, the fourth part: settled jobs' payloads compacted, the 500 MB budget) and M22
-- (*_idle_rest.sql, Task 23.8, the fifth part: idle characters rest at home after 14 days without an owner's signal).
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
-- M20 (Task 23.3 fix round 1): a group adds only the reveals the claim has not taken yet. Every tournament entrant's
-- settlement waits on the same final reveal (10-tournament-results.sql, exception 5); M19 appended that reveal once per
-- settlement, so it counted against the cap once per settlement, and the lease update matched it once per copy, so its
-- position depended on the join plan (a hash join leased a settlement before it). Now each job is in the list once, every
-- reveal before the first settlement that waits on it, and the cap counts it once.
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
        -- Only the reveals not already picked: one this claim took for an earlier settlement is locked by this transaction,
        -- was checked then, and precedes this settlement in the list.
        select coalesce(array_agg(p.id order by p.due_at_ms,p.id),'{}'::uuid[]) into waits from private.job_dependencies d
          join private.jobs p on p.id=d.prerequisite_id where d.job_id=candidate.id and p.status<>'completed' and p.id<>all(picked);
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

-- ===== Task 23.7: settled jobs' payloads and the 500 MB budget (M21) =====
-- Database budget design (docs/superpowers/specs/2026-10-19-database-budget-design.md, A.1 and D): Avi's decision A + C + D,
-- 2026-10-19 (C, idle characters, is Task 23.8). Task 23.3 measured background job rows at about 62 MiB of the database at
-- 90 days, nearly all of it their input and result, kept for the seven-day detail window although nothing reads them once
-- their slot has settled:
--   - a job's input is read when it is claimed (claim_jobs' snapshot) and by its own completion's checks;
--   - a result is read by later phases of the same boundary (preparation's stamina, league and fighter; a pairing's bracket
--     and routes, publish_tournaments' insufficient-entrants branch included), all before that slot starts, and by a
--     same-token settlement retry (settle_activity_core returns j.result||{newGrants: 0, replayed: true}, and the worker reads
--     only its ok and replayed);
--   - replays, Arena results, tournament views and recent results keep their own copies (activity_stages, arena_results,
--     tournament_results, tournament_views, tournament_bout_results, recent_results); the pairing history reads only a pairing
--     job's kind and slot (07-arena.sql exception 7).
-- So cleanup_history now compacts the completed jobs of settled slots: the row and every other column stay, input becomes
-- {"compacted": true} and result {"ok": true, "compacted": true}, and the seven-day pass deletes the row as before. A
-- same-token settlement retry on a compacted job still answers ok, with no new grant, replayed. No job kind is read after its
-- slot has settled, so none is excluded (tests/db/retention.test.ts and tests/db/activities.test.ts pin each reader).
-- "Settled" is the seven-day pass's own rule without its seven-day age: at or below the checkpoint P - 19 (everything a
-- catch-up still needs stays above it; 14-operations.sql's header) and below the first slot that still has an unfinished
-- activity or job (blockedSlot's rule). The trim has its own watermark, retention_state.jobs_compacted_through_slot, and takes
-- at most three slots that have jobs a call, so the seven-day pass's watermark and result keep their meaning; its count is
-- the seven-day pass's compacted.jobs. Its locks are the seven-day pass's: completed rows of slots at or below P - 19, under
-- the same 500 ms lock timeout (a contended row fails the call whole; the next hourly tick retries).
-- D: the internal database budget is 500 MB, MB meaning 2^20 bytes (524,288,000 bytes); private.health_alerts already warns
-- from 80 % (419,430,400 bytes, 400 MB) and alerts from 100 %, both on physical pg_database_size. The report also counts the
-- characters with an activity in the current slot (cohort.activeCharacters), the watch for the boundary-latency risk at 50
-- characters (docs/operations/release-evidence.md, risk 5).

-- The last slot whose completed jobs' payloads cleanup has compacted (-1: none yet). Only cleanup_history advances it, under
-- its retention state lock; the job guard allows the compaction only at or below it.
alter table private.retention_state add column if not exists jobs_compacted_through_slot bigint not null default -1
  check (jobs_compacted_through_slot >= -1);

-- 07-arena.sql's status machine, and exactly one update of a completed job (as guard_receipt allows exactly one compaction of
-- a settlement receipt): input to {"compacted": true} and result to {"ok": true, "compacted": true}, once, every other column
-- unchanged, and only at or below retention_state.jobs_compacted_through_slot. cleanup_history moves that watermark across
-- settled slots just before it compacts them, so the same update anywhere else (an unsettled slot, an unfinished job, a
-- second compaction) is refused like every other update of a completed job. The trigger (03-activities-jobs.sql) is unchanged.
create or replace function private.guard_job() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if old.status<>'completed' then raise exception 'unfinished job'; end if;
    return old;
  end if;
  if old.status='completed' then
    if new.input='{"compacted": true}'::jsonb and new.result='{"ok": true, "compacted": true}'::jsonb
      and old.input<>'{"compacted": true}'::jsonb
      and (new.id,new.kind,new.dedupe_key,new.slot_index,new.gladiator_id,new.activity_id,new.seed,new.rules_version,new.status,
        new.due_at_ms,new.attempts,new.max_attempts,new.lease_token,new.lease_owner,new.leased_at_ms,new.lease_until_ms,new.last_failure,
        new.created_at_ms,new.completed_at_ms)
        is not distinct from (old.id,old.kind,old.dedupe_key,old.slot_index,old.gladiator_id,old.activity_id,old.seed,old.rules_version,
        old.status,old.due_at_ms,old.attempts,old.max_attempts,old.lease_token,old.lease_owner,old.leased_at_ms,old.lease_until_ms,
        old.last_failure,old.created_at_ms,old.completed_at_ms)
      and old.slot_index<=(select r.jobs_compacted_through_slot from private.retention_state r where r.singleton) then
      return new;
    end if;
    raise exception 'immutable job';
  end if;
  if new.id<>old.id or new.kind<>old.kind or new.dedupe_key<>old.dedupe_key or new.slot_index<>old.slot_index
    or new.gladiator_id is distinct from old.gladiator_id or new.activity_id is distinct from old.activity_id or new.input<>old.input
    or new.seed<>old.seed or new.rules_version<>old.rules_version or new.attempts<old.attempts then
    raise exception 'immutable job';
  end if;
  if new.status<>old.status and not (
    (old.status='pending' and new.status='leased')
    or (old.status='leased' and new.status in ('completed','pending','operator'))
    or (old.status='operator' and new.status='pending')) then
    raise exception 'immutable job';
  end if;
  if new.result is distinct from old.result and not (old.status='leased' and new.status='completed') then
    raise exception 'immutable job';
  end if;
  return new;
end $$;
-- As 07-arena.sql: the backend keeps EXECUTE, as every guard does (a trigger fires without it).
revoke all on function private.guard_job() from public, anon, authenticated;
grant execute on function private.guard_job() to service_role;

-- 14-operations.sql's cleanup, unchanged except the trim of settled jobs after the seven-day pass and its count in the
-- result (detail.compacted.jobs).
create or replace function private.cleanup_history(now_ms bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  started_ms bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint; step_ms bigint;
  st private.retention_state%rowtype; published bigint; cp_slot bigint; horizon bigint; lo bigint; hi bigint;
  data_slots integer; third bigint; blocked bigint; n bigint; flipped bigint:=0; compacted bigint:=0;
  battles text[]; tids text[]; job_ids uuid[]; listing_ids uuid[];
  v_deleted jsonb; v_replay jsonb; v_detail jsonb; v_summary jsonb; v_ledger jsonb; v_market jsonb; v_operational jsonb; v_cron jsonb; v_result jsonb;
  folded_rows bigint; folded_gladiators bigint; expired integer; reservations bigint; revisions bigint;
  more boolean; trim_lo bigint; trim_hi bigint; trim_horizon bigint; trim_slots integer; trim_third bigint; trim_blocked bigint;
  jobs_compacted bigint:=0;
begin
  if now_ms is null then raise exception 'invalid cleanup time' using errcode='22023'; end if;
  -- Give up any contended lock after 500 ms, for the rest of this transaction (Decision 4).
  perform set_config('lock_timeout','500ms',true);
  select * into st from private.retention_state where singleton for update;
  if not found then raise exception 'missing retention state'; end if;
  -- Database time after the guard lock; never a time ahead of it (Decision 4).
  if now_ms>private.planning_now_ms() then raise exception 'cleanup time is in the future' using errcode='22023'; end if;
  select c.published_slot into published from private.coordinator c where c.singleton;
  cp_slot:=case when published is null then null else least(published,(select min(g.processed_slot_index) from public.gladiators g)) end;

  -- 0. Expired replays, independent of the checkpoint: whole slots that ended 7 days ago, lowest first, at most 300.
  step_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  with picked as (
    select a.id from public.activities a
    where (a.summary->'replayExpiry'->>'state')='available' and a.status='completed' and a.slot_index<=(now_ms-604800000)/4800000-1
      and (a.summary->'replayExpiry'->>'expiresAtMs')::numeric<=now_ms
    order by a.slot_index,a.id limit 300)
  update public.activities a set summary=jsonb_set(a.summary,'{replayExpiry}','{"state":"expired"}'::jsonb) from picked p where a.id=p.id;
  get diagnostics n=row_count; flipped:=n;
  v_replay:=jsonb_build_object('flipped',flipped,'durationMs',floor(extract(epoch from clock_timestamp())*1000)::bigint-step_ms);

  -- Seven-day pass.
  step_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  v_deleted:=jsonb_build_object('activityStages',0,'expeditionPlans',0,'arenaResults',0,'arenaAssignmentSides',0,'arenaAssignments',0,
    'tournamentResults',0,'tournamentBouts',0,'tournamentEntries',0,'tournaments',0,'jobDependencies',0,'jobAttempts',0,'jobs',0,
    'activitySnapshots',0,'boundaryMembers',0);
  lo:=null; hi:=null; blocked:=null; more:=false; compacted:=0;
  if cp_slot is not null then
    horizon:=least(cp_slot-19,(now_ms-604800000)/4800000-1);
    lo:=st.detail_through_slot+1;
    if horizon>=lo then
      -- At most three data slots; empty slots between them are skipped.
      select count(*),max(x.slot_index) into data_slots,third from (
        select distinct a.slot_index from public.activities a where a.slot_index>=lo order by 1 limit 3) x;
      hi:=case when data_slots<3 then horizon else least(third,horizon) end;
      -- Stop below a slot that still has unfinished work.
      select min(x.slot) into blocked from (
        select min(a.slot_index) as slot from public.activities a where a.slot_index between lo and hi and a.status<>'completed'
        union all
        select min(j.slot_index) from private.jobs j where j.slot_index between lo and hi and j.status<>'completed') x;
      if blocked is not null then hi:=blocked-1; end if;
      if hi>=lo then
        -- (1) No 'available' summary outlives its detail.
        update public.activities a set summary=jsonb_set(a.summary,'{replayExpiry}','{"state":"expired"}'::jsonb)
          where a.slot_index between lo and hi and a.status='completed' and (a.summary->'replayExpiry'->>'state')='available';
        get diagnostics n=row_count; flipped:=flipped+n;
        -- (2) Public bout logs become their fight summary (exception 3).
        update public.tournament_bout_results b set result=(b.result-'battleLog')||jsonb_build_object('fight',jsonb_build_object(
            'durationMs',b.result->'battleLog'->'durationMs','victoryReason',b.result->'battleLog'->'victoryReason',
            'tieBreakReason',b.result->'battleLog'->'tieBreakReason'))
          from public.tournament_views v where v.id=b.tournament_id and v.slot_index between lo and hi and b.result ? 'battleLog';
        get diagnostics compacted=row_count;
        -- (3)-(4) Stages and expedition plans of A.
        delete from public.activity_stages s using public.activities a where a.id=s.activity_id and a.slot_index between lo and hi;
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('activityStages',n);
        delete from private.expedition_plans p using public.activities a where a.id=p.activity_id and a.slot_index between lo and hi;
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('expeditionPlans',n);
        -- (5)-(7) Arena battles, through their pairing jobs' slot (the indexed path).
        select coalesce(array_agg(x.battle_id),'{}') into battles from private.arena_assignments x join private.jobs p on p.id=x.pairing_job_id
          where p.kind='pair' and p.slot_index between lo and hi;
        delete from private.arena_results where battle_id=any(battles);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('arenaResults',n);
        delete from private.arena_assignment_sides where battle_id=any(battles);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('arenaAssignmentSides',n);
        delete from private.arena_assignments where battle_id=any(battles);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('arenaAssignments',n);
        -- (8)-(11) Tournament frames.
        select coalesce(array_agg(t.id),'{}') into tids from private.tournaments t where t.slot_index between lo and hi;
        delete from private.tournament_results where tournament_id=any(tids);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('tournamentResults',n);
        delete from private.tournament_bouts where tournament_id=any(tids);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('tournamentBouts',n);
        delete from private.tournament_entries where tournament_id=any(tids);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('tournamentEntries',n);
        delete from private.tournaments where id=any(tids);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('tournaments',n);
        -- (12) Completed jobs of R, except a pairing job a tournament view still references (the 90-day pass removes it).
        select coalesce(array_agg(j.id),'{}') into job_ids from private.jobs j where j.slot_index between lo and hi and j.status='completed'
          and not exists(select 1 from public.tournament_views v where v.pairing_job_id=j.id);
        delete from private.job_dependencies where job_id=any(job_ids) or prerequisite_id=any(job_ids);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('jobDependencies',n);
        delete from private.job_attempts where job_id=any(job_ids);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('jobAttempts',n);
        delete from private.jobs where id=any(job_ids);
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('jobs',n);
        -- (13)-(14) Frozen snapshots of A and the cohorts of R.
        delete from private.activity_snapshots s using public.activities a where a.id=s.activity_id and a.slot_index between lo and hi;
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('activitySnapshots',n);
        delete from private.boundary_members where slot_index between lo and hi;
        get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('boundaryMembers',n);
        -- (15)
        update private.retention_state set detail_through_slot=hi where singleton;
        st.detail_through_slot:=hi;
      end if;
      more:=blocked is null and st.detail_through_slot<horizon;
    end if;
  end if;
  -- Task 23.7: the completed jobs of settled slots keep their rows and lose their payloads. Settled: above the trim
  -- watermark, at or below P - 19 (the seven-day pass's rule without its seven-day age) and below the first slot with an
  -- unfinished activity or job; at most three slots that have jobs a call, empty slots skipped. The watermark moves first,
  -- because the job guard allows the compaction only at or below it.
  if cp_slot is not null then
    trim_lo:=st.jobs_compacted_through_slot+1;
    trim_horizon:=cp_slot-19;
    if trim_horizon>=trim_lo then
      select count(*),max(x.slot_index) into trim_slots,trim_third from (
        select distinct j.slot_index from private.jobs j where j.slot_index between trim_lo and trim_horizon order by 1 limit 3) x;
      trim_hi:=case when trim_slots<3 then trim_horizon else trim_third end;
      select min(x.slot) into trim_blocked from (
        select min(a.slot_index) as slot from public.activities a where a.slot_index between trim_lo and trim_hi and a.status<>'completed'
        union all
        select min(j.slot_index) from private.jobs j where j.slot_index between trim_lo and trim_hi and j.status<>'completed') x;
      if trim_blocked is not null then trim_hi:=trim_blocked-1; end if;
      if trim_hi>=trim_lo then
        update private.retention_state set jobs_compacted_through_slot=trim_hi where singleton;
        st.jobs_compacted_through_slot:=trim_hi;
        update private.jobs j set input='{"compacted": true}'::jsonb,result='{"ok": true, "compacted": true}'::jsonb
          where j.slot_index between trim_lo and trim_hi and j.status='completed' and j.input<>'{"compacted": true}'::jsonb;
        get diagnostics jobs_compacted=row_count;
      end if;
    end if;
  end if;
  v_detail:=jsonb_build_object('fromSlot',case when hi>=lo then lo end,'throughSlot',case when hi>=lo then hi end,'more',more,
    'blockedSlot',blocked,'deleted',v_deleted,'compacted',jsonb_build_object('tournamentBoutResults',compacted,'jobs',jobs_compacted),
    'durationMs',floor(extract(epoch from clock_timestamp())*1000)::bigint-step_ms);
  v_replay:=v_replay||jsonb_build_object('flipped',flipped);

  -- Ninety-day pass.
  step_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  v_deleted:=jsonb_build_object('tournamentBoutResults',0,'tournamentPlacements',0,'tournamentViews',0,'jobAttempts',0,'jobs',0,
    'activities',0,'boundaryWork',0,'boundaries',0);
  lo:=null; hi:=null; more:=false; compacted:=0;
  if cp_slot is not null then
    horizon:=least(cp_slot-19,(now_ms-7776000000)/4800000-1,st.detail_through_slot);
    lo:=st.summary_through_slot+1;
    if horizon>=lo then
      select count(*),max(x.slot_index) into data_slots,third from (
        select distinct a.slot_index from public.activities a where a.slot_index>=lo order by 1 limit 3) x;
      hi:=case when data_slots<3 then horizon else least(third,horizon) end;
      -- (1) Settlement receipts keep their key, request and digest (the replay guard); only their result is compacted.
      update public.operation_receipts o set result=jsonb_build_object('compactedAtMs',now_ms)
        from public.activities a where a.slot_index between lo and hi and o.receipt_id=a.receipt_id
          and o.request->>'kind'='activity-settlement' and not (o.result ? 'compactedAtMs' and o.result-'compactedAtMs'='{}'::jsonb);
      get diagnostics compacted=row_count;
      -- (2)-(5) The public tournament rows of R', then the pairing jobs only they still referenced.
      delete from public.tournament_bout_results b using public.tournament_views v where v.id=b.tournament_id and v.slot_index between lo and hi;
      get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('tournamentBoutResults',n);
      delete from public.tournament_placements p using public.tournament_views v where v.id=p.tournament_id and v.slot_index between lo and hi;
      get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('tournamentPlacements',n);
      with gone as (delete from public.tournament_views v where v.slot_index between lo and hi returning v.pairing_job_id)
        select coalesce(array_agg(g.pairing_job_id),'{}'),count(*) into job_ids,n from gone g;
      v_deleted:=v_deleted||jsonb_build_object('tournamentViews',n);
      delete from private.job_attempts where job_id=any(job_ids);
      get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('jobAttempts',n);
      delete from private.jobs where id=any(job_ids);
      get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('jobs',n);
      -- (6) Completed activities (recent_results cascade). A forgotten referencing row fails the whole call closed.
      delete from public.activities where slot_index between lo and hi and status='completed';
      get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('activities',n);
      -- (7) Finished boundary bookkeeping.
      delete from private.boundary_work where slot_index between lo and hi and status='done';
      get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('boundaryWork',n);
      delete from private.boundaries where slot_index between lo and hi and status='complete';
      get diagnostics n=row_count; v_deleted:=v_deleted||jsonb_build_object('boundaries',n);
      -- (8)
      update private.retention_state set summary_through_slot=hi where singleton;
      st.summary_through_slot:=hi;
      more:=hi<horizon;
    end if;
  end if;
  v_summary:=jsonb_build_object('fromSlot',case when hi>=lo then lo end,'throughSlot',case when hi>=lo then hi end,'more',more,
    'deleted',v_deleted,'compacted',jsonb_build_object('receipts',compacted),
    'durationMs',floor(extract(epoch from clock_timestamp())*1000)::bigint-step_ms);

  -- Ledger fold (one statement): the oldest rows older than 90 days, at most 5000, summed into their checkpoints.
  with picked as (
    select l.id from public.wallet_ledger l where l.created_at<to_timestamp((now_ms-7776000000)/1000.0)
    order by l.created_at,l.id limit 5000
  ), folded as (
    delete from public.wallet_ledger l using picked p where l.id=p.id
    returning l.gladiator_id,l.money_delta,l.renown_delta,l.created_at
  ), sums as (
    select f.gladiator_id,sum(f.money_delta)::bigint as money,sum(f.renown_delta)::bigint as renown,count(*) as n_rows,max(f.created_at) as through
    from folded f group by f.gladiator_id
  ), saved as (
    insert into private.wallet_checkpoints as c(gladiator_id,money,renown,ledger_rows,folded_through,updated_at_ms)
      select s.gladiator_id,s.money,s.renown,s.n_rows,s.through,now_ms from sums s
    on conflict (gladiator_id) do update set money=c.money+excluded.money,renown=c.renown+excluded.renown,
      ledger_rows=c.ledger_rows+excluded.ledger_rows,folded_through=greatest(c.folded_through,excluded.folded_through),
      updated_at_ms=excluded.updated_at_ms
    returning c.gladiator_id
  )
  select coalesce((select sum(s.n_rows) from sums s),0)::bigint,(select count(*) from saved) into folded_rows,folded_gladiators;
  v_ledger:=jsonb_build_object('rows',folded_rows,'gladiators',folded_gladiators,'more',folded_rows=5000);

  -- Fee reservations already consumed or refunded whose queue-build receipt is 90 days old; held ones are never touched.
  with doomed as (
    select r.id from public.reservations r join public.gladiators g on g.id=r.gladiator_id
      join public.operation_receipts o on o.owner_id=g.owner_id and o.operation_id=r.operation_id
    where r.status in ('consumed','refunded') and o.request->>'kind'='queue-build'
      and o.created_at<to_timestamp((now_ms-7776000000)/1000.0)
    order by o.created_at,r.id limit 1000)
  delete from public.reservations r using doomed d where r.id=d.id;
  get diagnostics reservations=row_count;

  -- Schedule revisions 90 days old that no future boundary can read: a newer revision of the same phase is effective by the
  -- character's next boundary (processed slot + 1) and is not effective earlier than this one (phase 5 picks the latest
  -- effective slot, then the latest version).
  with doomed as (
    select r.gladiator_id,r.phase,r.version from public.schedule_revisions r join public.gladiators g on g.id=r.gladiator_id
    where r.received_at_ms<now_ms-7776000000 and exists(select 1 from public.schedule_revisions x where x.gladiator_id=r.gladiator_id
      and x.phase=r.phase and x.version>r.version and x.effective_slot_index>=r.effective_slot_index
      and x.effective_slot_index<=g.processed_slot_index+1)
    order by r.received_at_ms,r.gladiator_id,r.phase,r.version limit 1000)
  delete from public.schedule_revisions r using doomed d where r.gladiator_id=d.gladiator_id and r.phase=d.phase and r.version=d.version;
  get diagnostics revisions=row_count;

  -- Every deferred projection trigger of this call fires now, inside the lock budget, so a failure is this call's failure.
  set constraints all immediate;

  -- Market (exception 1): the expiry backstop, then terminal listings 90 days past expiry with any offer; never an open one.
  expired:=private.expire_listings(now_ms);
  select coalesce(array_agg(x.id),'{}') into listing_ids from (
    select l.id from private.market_listings l where l.status<>'open' and l.expires_at_ms<=now_ms-7776000000
    order by l.expires_at_ms,l.id limit 1000) x;
  delete from public.market_offers where id=any(listing_ids);
  get diagnostics n=row_count; v_market:=jsonb_build_object('expired',expired,'offers',n);
  delete from private.market_listings where id=any(listing_ids);
  get diagnostics n=row_count; v_market:=v_market||jsonb_build_object('listings',n);

  -- Operational windows, 1000 rows each.
  delete from private.command_attempts a where a.id in (select x.id from private.command_attempts x
    where x.attempted_at<to_timestamp((now_ms-3600000)/1000.0) order by x.attempted_at limit 1000 for update skip locked);
  get diagnostics n=row_count; v_operational:=jsonb_build_object('commandAttempts',n);
  delete from private.dispatch_log d where d.id in (select x.id from private.dispatch_log x
    where x.dispatched_at_ms<now_ms-172800000 order by x.dispatched_at_ms limit 1000);
  get diagnostics n=row_count; v_operational:=v_operational||jsonb_build_object('dispatchLog',n);
  delete from private.operations_events e where e.id in (select x.id from private.operations_events x
    where x.at_ms<now_ms-2592000000 order by x.at_ms limit 1000);
  get diagnostics n=row_count; v_operational:=v_operational||jsonb_build_object('operationsEvents',n);
  -- pg_cron's run log in its own block: a failure here reports only its SQLSTATE and the rest of the call still commits.
  begin
    delete from cron.job_run_details d where d.runid in (select x.runid from cron.job_run_details x
      where x.end_time<to_timestamp((now_ms-604800000)/1000.0) order by x.end_time limit 1000);
    get diagnostics n=row_count; v_cron:=to_jsonb(n);
  exception when others then
    v_cron:=jsonb_build_object('ok',false,'sqlstate',sqlstate);
  end;
  v_operational:=v_operational||jsonb_build_object('cronRunDetails',v_cron);

  v_result:=jsonb_build_object('ok',true,'nowMs',now_ms,'publishedSlot',published,'checkpointSlot',cp_slot,
    'durationMs',floor(extract(epoch from clock_timestamp())*1000)::bigint-started_ms,'replay',v_replay,'detail',v_detail,'summary',v_summary,
    'ledger',v_ledger,'market',v_market,'reservations',reservations,'scheduleRevisions',revisions,'operational',v_operational);
  update private.retention_state set last_run_at_ms=now_ms,last_result=v_result where singleton;
  return v_result;
end $$;
-- Owner only (pg_cron through cleanup_tick, an operator), as before.
revoke all on function private.cleanup_history(bigint) from public, anon, authenticated, service_role;

-- 14-operations.sql's report, unchanged except the 500 MB budget and cohort.activeCharacters.
create or replace function private.health_report(now_ms bigint) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare
  coord private.coordinator%rowtype; st private.retention_state%rowtype; enabled boolean; current_slot bigint; more boolean; more_since bigint;
  failures bigint; failure_states jsonb; overdue_total bigint; operator_total bigint; v_boundaries jsonb; v_jobs jsonb; v_attempts jsonb;
  v_dispatch jsonb; v_cleanup jsonb; v_events jsonb; v_resources jsonb; v_cohort jsonb; report jsonb;
begin
  if now_ms is null or now_ms<0 then raise exception 'invalid health time' using errcode='22023'; end if;
  current_slot:=now_ms/4800000;
  select * into coord from private.coordinator where singleton;
  select * into st from private.retention_state where singleton;
  enabled:=coalesce((select s.enabled from private.scheduler s where s.singleton),false);

  -- Boundaries not yet complete (normally only the next one), lowest slot first, at most 20; waitingMs since it opened.
  select coalesce(jsonb_agg(jsonb_build_object('slot',b.slot_index,'phase',b.phase,'status',b.status,'waitReason',b.wait_reason,
      'lastError',case when b.last_error is null then null when b.last_error ~ '^[0-9A-Z]{5}$' then b.last_error else 'unrecognized' end,
      'waitingMs',now_ms-b.opened_at_ms) order by b.slot_index),'[]'::jsonb)
    into v_boundaries from (select * from private.boundaries x where x.status<>'complete' order by x.slot_index limit 20) b;

  -- Jobs: counts by kind and status; overdue (pending more than 10 minutes past due, or leased with a lease expired more
  -- than 10 minutes ago) and operator jobs, at most 20 each, oldest first, with their totals.
  select count(*) into overdue_total from private.jobs j
    where (j.status='pending' and j.due_at_ms<now_ms-600000) or (j.status='leased' and j.lease_until_ms<now_ms-600000);
  select count(*) into operator_total from private.jobs j where j.status='operator';
  v_jobs:=jsonb_build_object(
    'counts',coalesce((select jsonb_object_agg(k.kind,k.statuses) from (select x.kind,jsonb_object_agg(x.status,x.n) as statuses
      from (select j.kind,j.status,count(*) as n from private.jobs j group by j.kind,j.status) x group by x.kind) k),'{}'::jsonb),
    'overdueTotal',overdue_total,
    'overdue',coalesce((select jsonb_agg(jsonb_build_object('jobId',o.id,'kind',o.kind,'slot',o.slot_index,'status',o.status,
        'dueAtMs',o.due_at_ms,'overdueMs',now_ms-o.due_at_ms,'attempts',o.attempts) order by o.due_at_ms,o.id) from (
      select j.id,j.kind,j.slot_index,j.status,j.due_at_ms,j.attempts from private.jobs j
      where (j.status='pending' and j.due_at_ms<now_ms-600000) or (j.status='leased' and j.lease_until_ms<now_ms-600000)
      order by j.due_at_ms,j.id limit 20) o),'[]'::jsonb),
    'operatorTotal',operator_total,
    'operator',coalesce((select jsonb_agg(jsonb_build_object('jobId',o.id,'kind',o.kind,'slot',o.slot_index,'attempts',o.attempts,
        'lastFailure',case when o.last_failure is null then null when o.last_failure ~ '^[a-z0-9][a-z0-9-]{0,63}$' then o.last_failure
          else 'unrecognized' end) order by o.slot_index,o.id) from (
      select j.id,j.kind,j.slot_index,j.attempts,j.last_failure from private.jobs j where j.status='operator'
      order by j.slot_index,j.id limit 20) o),'[]'::jsonb));

  -- Attempts claimed in the last 24 hours: their count, failures by code, and per-kind durations (finished_at_ms -
  -- claimed_at_ms) of the completed ones. CPU time is not exposed per request by the Edge runtime (Decision 8).
  with w as (
    select a.outcome,a.failure_code,a.claimed_at_ms,a.finished_at_ms,j.kind from private.job_attempts a join private.jobs j on j.id=a.job_id
    where a.claimed_at_ms>now_ms-86400000 and a.claimed_at_ms<=now_ms)
  select jsonb_build_object('count',(select count(*) from w),'failed',(select count(*) from w where w.outcome in ('failed','expired')),
    'failuresByCode',coalesce((select jsonb_object_agg(f.code,f.n) from (
      select case when coalesce(w.failure_code,'unknown') ~ '^[a-z0-9][a-z0-9-]{0,63}$' then coalesce(w.failure_code,'unknown')
        else 'unrecognized' end as code,count(*) as n from w where w.outcome in ('failed','expired') group by 1) f),'{}'::jsonb),
    'durations',coalesce((select jsonb_object_agg(d.kind,jsonb_build_object('count',d.n,'p50Ms',d.p50,'p95Ms',d.p95,'maxMs',d.longest)) from (
      select w.kind,count(*) as n,percentile_disc(0.5) within group (order by w.finished_at_ms-w.claimed_at_ms) as p50,
        percentile_disc(0.95) within group (order by w.finished_at_ms-w.claimed_at_ms) as p95,max(w.finished_at_ms-w.claimed_at_ms) as longest
      from w where w.outcome='completed' and w.finished_at_ms is not null group by w.kind) d),'{}'::jsonb))
  into v_attempts;

  v_dispatch:=jsonb_build_object('lastAtMs',(select max(d.dispatched_at_ms) from private.dispatch_log d where d.dispatched_at_ms<=now_ms),
    'lastHour',(select count(*) from private.dispatch_log d where d.dispatched_at_ms>now_ms-3600000 and d.dispatched_at_ms<=now_ms));

  -- Cleanup: the watermarks and the last successful run's result (its durations surface the growth of each pass); since
  -- when every cleanup tick has still had more to do; the failed cleanup ticks since the last successful one.
  more:=coalesce(st.last_result->'detail'->'more'='true'::jsonb,false) or coalesce(st.last_result->'summary'->'more'='true'::jsonb,false)
    or coalesce(st.last_result->'ledger'->'more'='true'::jsonb,false);
  if more then
    with ev as (
      select e.id,e.at_ms,coalesce(e.detail->'detail'->'more'='true'::jsonb,false) or coalesce(e.detail->'summary'->'more'='true'::jsonb,false)
        or coalesce(e.detail->'ledger'->'more'='true'::jsonb,false) as more
      from private.operations_events e where e.source='cleanup' and e.ok and e.at_ms<=now_ms)
    select min(ev.at_ms) into more_since from ev where ev.more and ev.id>coalesce((select max(x.id) from ev x where not x.more),0);
  end if;
  with streak as (
    select e.sqlstate from private.operations_events e where e.source='cleanup' and not e.ok and e.at_ms<=now_ms
      and e.id>coalesce((select max(x.id) from private.operations_events x where x.source='cleanup' and x.ok and x.at_ms<=now_ms),0))
  select (select count(*) from streak),(select coalesce(jsonb_agg(x.sqlstate order by x.sqlstate collate "C"),'[]'::jsonb)
    from (select distinct s.sqlstate from streak s where s.sqlstate is not null) x)
  into failures,failure_states;
  v_cleanup:=jsonb_build_object('lastRunAtMs',st.last_run_at_ms,'detailThroughSlot',st.detail_through_slot,
    'summaryThroughSlot',st.summary_through_slot,'more',more,
    'durationMs',case when jsonb_typeof(st.last_result->'durationMs')='number' then st.last_result->'durationMs' end,
    'detail',jsonb_build_object('more',coalesce(st.last_result->'detail'->'more'='true'::jsonb,false),
      'blockedSlot',case when jsonb_typeof(st.last_result->'detail'->'blockedSlot')='number' then st.last_result->'detail'->'blockedSlot' end,
      'durationMs',case when jsonb_typeof(st.last_result->'detail'->'durationMs')='number' then st.last_result->'detail'->'durationMs' end),
    'summary',jsonb_build_object('more',coalesce(st.last_result->'summary'->'more'='true'::jsonb,false),
      'durationMs',case when jsonb_typeof(st.last_result->'summary'->'durationMs')='number' then st.last_result->'summary'->'durationMs' end),
    'ledger',jsonb_build_object('more',coalesce(st.last_result->'ledger'->'more'='true'::jsonb,false)),
    'moreSinceMs',more_since,'failures',jsonb_build_object('consecutive',failures,'sqlstates',failure_states));

  -- Events per source: the latest failure in 24 hours, and the failures of the last hour aggregated (count and distinct
  -- SQLSTATEs, including those a sweep keeps in its detail), never one entry per row.
  with w as (
    select e.id,e.source,e.at_ms,e.sqlstate,e.detail from private.operations_events e
    where not e.ok and e.at_ms>now_ms-86400000 and e.at_ms<=now_ms
  ), codes as (
    select w.id,w.sqlstate as code from w where w.sqlstate is not null
    union
    select w.id,t.code from w cross join lateral jsonb_array_elements_text(case when jsonb_typeof(w.detail->'sqlstates')='array'
      then w.detail->'sqlstates' else '[]'::jsonb end) t(code)
  ), valid as (
    select c.id,c.code from codes c where c.code ~ '^[0-9A-Z]{5}$'
  )
  select jsonb_object_agg(s.source,jsonb_build_object(
    'latestFailure',(select jsonb_build_object('atMs',l.at_ms,
        'sqlstates',(select coalesce(jsonb_agg(v.code order by v.code collate "C"),'[]'::jsonb) from valid v where v.id=l.id),
        'failedSellers',case when jsonb_typeof(l.detail->'failedSellers')='number' then l.detail->'failedSellers' end)
      from w l where l.source=s.source order by l.at_ms desc,l.id desc limit 1),
    'lastHour',jsonb_build_object('failures',(select count(*) from w h where h.source=s.source and h.at_ms>now_ms-3600000),
      'sqlstates',(select coalesce(jsonb_agg(x.code order by x.code collate "C"),'[]'::jsonb) from (
        select distinct v.code from valid v join w h on h.id=v.id where h.source=s.source and h.at_ms>now_ms-3600000) x))))
  into v_events from (values ('market-sweep'),('dispatch'),('cleanup')) s(source);

  -- Resources against the 500 MB budget (Task 23.7); egress and function invocations are read from the hosting dashboard.
  v_resources:=jsonb_build_object('databaseBytes',pg_database_size(current_database()),'budgetBytes',524288000,
    'largestTables',coalesce((select jsonb_agg(jsonb_build_object('name',t.name,'bytes',t.bytes) order by t.bytes desc,t.name collate "C") from (
      select n.nspname||'.'||r.relname as name,pg_total_relation_size(r.oid) as bytes from pg_class r join pg_namespace n on n.oid=r.relnamespace
      where r.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\_toast%'
        and n.nspname not like 'pg\_temp%'
      order by 2 desc,1 limit 10) t),'[]'::jsonb));

  -- Task 23.7: the characters with an activity in the current slot (unique per character and slot; activities_slot_status_idx).
  v_cohort:=jsonb_build_object('activeCharacters',(select count(*) from public.activities a where a.slot_index=current_slot));

  report:=jsonb_build_object('checkedAtMs',now_ms,'currentSlot',current_slot,'publishedSlot',coord.published_slot,
    'slotsBehind',current_slot-coord.published_slot,
    'coordinator',jsonb_build_object('lastError',case when coord.last_error is null then null when coord.last_error ~ '^[0-9A-Z]{5}$' then coord.last_error
        else 'unrecognized' end,'lastFailedSlot',coord.last_failed_slot,'leaseHeld',coalesce(coord.lease_token is not null and coord.lease_until_ms>now_ms,false)),
    'scheduler',jsonb_build_object('enabled',enabled),'boundaries',v_boundaries,'jobs',v_jobs,'attempts24h',v_attempts,'dispatch',v_dispatch,
    'cleanup',v_cleanup,'events',v_events,'resources',v_resources,'cohort',v_cohort,'cpu','not available');
  return report||jsonb_build_object('alerts',private.health_alerts(report));
end $$;
-- The operator's, as before: nobody else may EXECUTE it.
revoke all on function private.health_report(bigint) from public, anon, authenticated, service_role;

-- ===== Task 23.8: idle characters rest at home (M22) =====
-- Database budget design C (docs/superpowers/specs/2026-10-19-database-budget-design.md; Avi's decision A + C + D, 2026-10-19,
-- with spec §4.3 changed the same day): the schedule continues while the player is offline until the owner has sent no
-- activity signal for 14 days; then the character rests at home until the owner returns.
--   - The signal. private.owner_signals.last_signal_ms, one row per owner, written by public.consume_command_rate for the
--     verified actor of every command the Edge function receives (the payload-free `presence` included, and before the rate
--     decision, so a refused or rate-limited attempt counts too), at database time sampled after the account's rate lock, at
--     most once an hour: only when the stored signal is at least 3600000 ms older (an operational window, not a rule).
--   - The rule, at the freeze of boundary phase 3. A character rests at boundary `target` when
--     target x 4800000 - greatest(last signal, gladiators.created_at_ms) >= private.idle_rules()->afterMs, RULES_V1.idle.afterMs
--     restated (1209600000: 14 days, 252 slots; tests/db/idle.test.ts compares them). The scheduled start, never the wall
--     clock: a late or catch-up boundary classifies each slot as it would have on time. A signal recorded before the late
--     boundary freezes its cohort counts for it, even one after its scheduled start. Creation counts like a signal.
--   - Resting. The character is not a member: no preparation job, snapshot, activity, settlement, settled slot, pairing or
--     bracket entry, and no season rating row (phase 4 inserts members' rows only, so a character resting through a whole
--     season is absent from that season's standings). Phase 8 advances its processed_slot_index with the cohort's, so the
--     straggler wait, the commands' processing answers, the cleanup checkpoint and coordinate_work see it as everyone else.
--     Its tournament opt-in is kept. Changes queued while it rests (each comes with a signal) wait for its first boundary
--     back, which applies pending builds and reads the latest schedule revision effective by then. The activity of the slot
--     before it began resting settles normally (phase 1). Resting slots are never back-filled or rewarded.
--   - public.character_rests, one row per character that has rested: since_slot, the first slot of its latest rest;
--     through_slot, the last slot a boundary rested it in; signalled_at_ms, its owner's first signal since that rest began
--     (null until then). It rests in its processed slot P while since_slot <= P <= through_slot. A rest that reached the
--     previous slot continues (through_slot moves); otherwise a new one replaces the row. The owner reads its own row
--     (owner_read, as builds). public.owner_state shows currentActivity null while it rests and restingUntilSlot
--     through_slot + 1 once signalled_at_ms is set: normally P + 1, or P + 2 when the signal came after boundary P + 1 had
--     frozen its cohort with the character resting. private.project_character publishes `resting` on the public actor
--     (with location 'camp', activity status 'idle', and no activity, times or stage).
--   - Waking. The first signal after the rest began sets signalled_at_ms (consume_command_rate, for a rest whose
--     through_slot is at or after the processed slot); the next boundary that freezes its cohort classifies it playing.
--   - Locks. Phase 3 takes the owner's rate lock (hashtextextended(owner, 1), which consume_command_rate holds while it records
--     a signal) for each character its first read finds idle, then reads the signal again: a signal committed while the
--     boundary waited counts, and one recorded after the boundary commits finds the rest row and marks it. consume_command_rate
--     holds nothing else while it waits for that lock, and phase 3 touches a rest row only after taking it, so they never wait
--     on each other in a cycle. Phase 8 takes the resting characters' account locks (hashtextextended(owner, 0)) in one
--     gladiator-ordered pass with the members' (10-tournament-results.sql exception 1), before any row lock.
--   - Deploy day. Existing owners have no signal yet: the backfill below gives every owner of a character the deploy time
--     (reapplicable: a recorded signal is kept), so nobody rests on the first boundary after M22. Every actor is then
--     republished with its `resting` flag (public.refresh_projections()).
--   - The health report counts the characters resting in the current slot (cohort.restingCharacters).

-- RULES_V1.idle (supabase/functions/_shared/domain/rules-v1.ts), restated as 13-seasons.sql restates RULES_V1.seasons.
create or replace function private.idle_rules() returns jsonb language sql immutable security invoker set search_path='' as $$
  select '{"afterMs":1209600000}'::jsonb
$$;

-- The owner's latest activity signal, database time in ms. Backend only.
create table if not exists private.owner_signals (
  owner_id uuid primary key references auth.users(id),
  last_signal_ms bigint not null check (last_signal_ms >= 0)
);
alter table private.owner_signals enable row level security;
revoke all on private.owner_signals from public, anon, authenticated, service_role;
grant select, insert, update on private.owner_signals to service_role;
drop policy if exists backend_only on private.owner_signals;
create policy backend_only on private.owner_signals to service_role using (true) with check (true);

-- A character's rest at home (above). Its owner reads it, like its builds; only the backend writes it.
create table if not exists public.character_rests (
  gladiator_id uuid primary key references public.gladiators(id),
  since_slot bigint not null check (since_slot >= 1),
  through_slot bigint not null,
  signalled_at_ms bigint check (signalled_at_ms >= 0),
  check (through_slot >= since_slot)
);
alter table public.character_rests enable row level security;
revoke all on public.character_rests from public, anon, authenticated, service_role;
grant select on public.character_rests to authenticated;
grant select, insert, update on public.character_rests to service_role;
drop policy if exists owner_read on public.character_rests;
create policy owner_read on public.character_rests for select to authenticated
  using (gladiator_id in (select id from public.gladiators where owner_id=(select auth.uid())));

-- 01-identity.sql's rate limit, plus the owner's activity signal.
create or replace function public.consume_command_rate(actor_id uuid, is_creation boolean) returns integer
language plpgsql security invoker set search_path = '' as $$
declare now_at timestamptz; oldest timestamptz; attempts integer; maximum integer; signal_ms bigint; recorded integer;
begin
  if actor_id is null or is_creation is null then raise exception 'invalid actor'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,1));
  now_at := clock_timestamp();
  -- Task 23.8: the owner's activity signal at database time sampled after the rate lock, at most once an hour. A refused or
  -- rate-limited attempt is the owner's activity too, so it is recorded before the rate decision.
  signal_ms := private.planning_now_ms();
  insert into private.owner_signals as s(owner_id,last_signal_ms) values(consume_command_rate.actor_id,signal_ms)
    on conflict (owner_id) do update set last_signal_ms=excluded.last_signal_ms where s.last_signal_ms<=excluded.last_signal_ms-3600000;
  get diagnostics recorded = row_count;
  if recorded>0 then
    -- The first signal since a rest began (a rest not yet ended: through_slot at or after the processed slot) marks it; the
    -- next boundary that freezes its cohort returns the character.
    update public.character_rests r set signalled_at_ms=signal_ms from public.gladiators g
      where g.owner_id=consume_command_rate.actor_id and r.gladiator_id=g.id and r.signalled_at_ms is null
        and r.through_slot>=g.processed_slot_index;
  end if;
  delete from private.command_attempts a where a.actor_id=consume_command_rate.actor_id and a.attempted_at <= now_at-interval '1 minute';
  select count(*), min(attempted_at) into attempts, oldest from private.command_attempts a
    where a.actor_id=consume_command_rate.actor_id and a.is_creation=consume_command_rate.is_creation;
  maximum := case when is_creation then 5 else 60 end;
  if attempts >= maximum then return greatest(1,ceil(extract(epoch from (oldest+interval '1 minute'-now_at))*1000)::integer); end if;
  insert into private.command_attempts(actor_id,is_creation,attempted_at) values(actor_id,is_creation,now_at);
  return null;
end $$;

-- Boundary phase 3 (03-activities-jobs.sql), unchanged except the rest at the freeze.
create or replace function private.boundary_apply_changes(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare b private.boundaries%rowtype; m record; starts_at bigint:=target*4800000;
  idle_ms bigint:=(private.idle_rules()->>'afterMs')::bigint;
begin
  select * into b from private.boundaries where slot_index=target for update;
  if not b.members_frozen then
    -- A never-started character whose creation committed after an earlier cohort froze joins this cohort; its
    -- orientation simply extends to this cutoff. A participating straggler is an inconsistency for the operator.
    for m in select g.id,g.owner_id from public.gladiators g where g.processed_slot_index<target-1
      and not exists(select 1 from public.activities a where a.gladiator_id=g.id) order by g.id loop
      perform pg_advisory_xact_lock(hashtextextended(m.owner_id::text,0));
      update public.gladiators set processed_slot_index=target-1,orientation_end_ms=target*4800000
        where id=m.id and processed_slot_index<target-1;
    end loop;
    if exists(select 1 from public.gladiators where processed_slot_index<target-1) then return 'straggler'; end if;
    -- Task 23.8: a character whose owner's last signal (or its creation, when later) is RULES_V1.idle before this boundary's
    -- scheduled start rests at home instead of joining the cohort. Each one the first read finds idle is read again under its
    -- owner's rate lock (consume_command_rate's), so a signal committed while the boundary waited counts.
    for m in select g.id,g.owner_id from public.gladiators g left join private.owner_signals s on s.owner_id=g.owner_id
      where g.processed_slot_index=target-1 and starts_at-greatest(s.last_signal_ms,g.created_at_ms)>=idle_ms order by g.id loop
      perform pg_advisory_xact_lock(hashtextextended(m.owner_id::text,1));
      if (select starts_at-greatest(s.last_signal_ms,g.created_at_ms) from public.gladiators g
        left join private.owner_signals s on s.owner_id=g.owner_id where g.id=m.id)>=idle_ms then
        -- A rest that reached the previous slot continues; any other starts here, without a signal.
        insert into public.character_rests as r(gladiator_id,since_slot,through_slot,signalled_at_ms) values(m.id,target,target,null)
          on conflict (gladiator_id) do update set since_slot=case when r.through_slot=target-1 then r.since_slot else excluded.since_slot end,
            signalled_at_ms=case when r.through_slot=target-1 then r.signalled_at_ms end,through_slot=excluded.through_slot;
      end if;
    end loop;
    insert into private.boundary_members(slot_index,gladiator_id,owner_id)
      select target,g.id,g.owner_id from public.gladiators g where g.processed_slot_index=target-1
        and not exists(select 1 from public.character_rests r where r.gladiator_id=g.id and r.through_slot=target)
      on conflict do nothing;
    update private.boundaries set members_frozen=true,member_count=(select count(*) from private.boundary_members where slot_index=target)
      where slot_index=target;
  end if;
  for m in select bm.gladiator_id,bm.owner_id from private.boundary_members bm where bm.slot_index=target order by bm.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(m.owner_id::text,0));
    perform 1 from public.gladiators where id=m.gladiator_id for update;
    -- Repeat-safe: an already-applied or later-effective pending build returns false.
    perform private.apply_pending_build(m.gladiator_id,target);
  end loop;
  return null;
end $$;

-- Boundary phase 8 (10-tournament-results.sql), unchanged except the resting characters' locks and checkpoints.
create or replace function private.boundary_start(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare a record; now_ms bigint:=private.planning_now_ms();
begin
  -- Check every member before any debit so an unsupported executor never leaves a partially started slot.
  if exists(select 1 from public.activities x where x.slot_index=target and x.status='preparing' and not private.activity_executor_ready(x.resolved_kind)) then
    return 'integration';
  end if;
  -- Exception 1: a member's jobs can reference another member's rows (an Arena battle job is anchored to side 0, whichever
  -- side comes first), so every account lock is held before the first such foreign key takes KEY SHARE on those rows.
  -- Task 23.8: the characters resting at this boundary take their account locks in the same gladiator-ordered pass.
  for a in select locked.owner_id from (
      select bm.gladiator_id,bm.owner_id from public.activities x
        join private.boundary_members bm on bm.slot_index=target and bm.gladiator_id=x.gladiator_id
        where x.slot_index=target and x.status='preparing'
      union all
      select g.id,g.owner_id from public.character_rests r join public.gladiators g on g.id=r.gladiator_id
        where r.through_slot=target and g.processed_slot_index=target-1) locked
    order by locked.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,0));
  end loop;
  for a in select x.id,x.gladiator_id,x.stamina_debit,x.debited,bm.owner_id from public.activities x
    join private.boundary_members bm on bm.slot_index=target and bm.gladiator_id=x.gladiator_id
    where x.slot_index=target and x.status='preparing' order by x.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,0));
    perform 1 from public.gladiators where id=a.gladiator_id for update;
    if not a.debited then update public.gladiators set stamina_current=stamina_current-a.stamina_debit where id=a.gladiator_id; end if;
    perform private.prepare_activity_jobs(a.id);
    update public.activities set debited=true,status='active',published_at_ms=now_ms where id=a.id;
    update public.gladiators set processed_slot_index=target where id=a.gladiator_id and processed_slot_index=target-1;
  end loop;
  -- Task 23.8: a resting character's checkpoint advances with the cohort's.
  update public.gladiators g set processed_slot_index=target from public.character_rests r
    where r.gladiator_id=g.id and r.through_slot=target and g.processed_slot_index=target-1;
  return private.boundary_published(target);
end $$;

-- 14-operations.sql's projector, unchanged except the resting actor.
create or replace function private.project_character(gid uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare g public.gladiators%rowtype; b jsonb; a public.activities%rowtype; actor jsonb; silhouettes jsonb; awarded_prestige jsonb;
  resting boolean;
begin
  select * into g from public.gladiators where id=gid;
  if not found then return; end if;
  select current_build into b from public.builds where gladiator_id=gid;
  if b is null then return; end if;
  -- Only an authoritative published activity is visible. Preparing snapshots remain private.
  select * into a from public.activities where gladiator_id=gid and status<>'preparing'
    and published_at_ms is not null and published_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
    order by slot_index desc limit 1;
  -- Task 23.8: resting in its processed slot, it shows no activity, whatever its latest one was.
  resting:=exists(select 1 from public.character_rests r where r.gladiator_id=gid and r.since_slot<=g.processed_slot_index
    and g.processed_slot_index<=r.through_slot);
  select coalesce(jsonb_agg(silhouette order by silhouette),'[]'::jsonb) into silhouettes from (
    select case split_part(i.item->>'catalogId',':',1)
      when 'sword' then 'weapon-sword' when 'axe' then 'weapon-axe' when 'spear' then 'weapon-spear' when 'bow' then 'weapon-bow'
      when 'round-shield' then 'offhand-shield' when 'leather-hood' then 'head-hood' when 'iron-helmet' then 'head-helmet'
      when 'light-armor' then 'armor-light' when 'heavy-armor' then 'armor-heavy' when 'light-boots' then 'feet-light'
      when 'heavy-boots' then 'feet-heavy' end as silhouette
    from public.item_instances i where i.gladiator_id=gid
      and i.id in (select value::uuid from jsonb_each_text(b->'equipment') where value is not null)
  ) equipment where silhouette is not null;
  actor:=jsonb_build_object('gladiatorId',g.id,'name',g.name,'classId',b->'classId','equipmentSilhouettes',silhouettes,
    'league',g.league,'level',g.level,
    'phase',private.slot_phase(case when resting then g.processed_slot_index else coalesce(a.slot_index,g.processed_slot_index) end),
    'location',case when resting then 'camp' when a.id is null then 'orientation' when a.resolved_kind='expedition' then 'expedition:'||(a.requested->>'expeditionId') else a.resolved_kind end,
    'activityId',case when not resting then a.id end,'activityStatus',case when resting then 'idle' when a.id is null then 'active' else a.status end,
    'startsAtMs',case when not resting then coalesce(a.starts_at_ms,g.created_at_ms) end,
    'endsAtMs',case when not resting then coalesce(a.ends_at_ms,g.orientation_end_ms) end,'visibleStage',null,'resting',resting);
  insert into public.world_actors(gladiator_id,actor,processed_slot_index) values(gid,actor,g.processed_slot_index)
    on conflict(gladiator_id) do update set actor=excluded.actor,processed_slot_index=excluded.processed_slot_index
    where (world_actors.actor,world_actors.processed_slot_index) is distinct from (excluded.actor,excluded.processed_slot_index);
  -- Task 21: prestige, one entry per season award.
  select coalesce(jsonb_agg(jsonb_build_object('seasonIndex',x.season_index,'league',x.league,'place',x.place,'badge',x.badge,'title',x.title)
    order by x.season_index),'[]'::jsonb) into awarded_prestige from private.season_awards x where x.gladiator_id=gid;
  -- Combined combat strength/league score belongs to Task 16. Never label gear history as that score.
  insert into public.public_profiles(gladiator_id,rating,prestige) values(gid,g.rating,awarded_prestige) on conflict(gladiator_id) do update
    set rating=excluded.rating,prestige=excluded.prestige
    where (public_profiles.rating,public_profiles.prestige) is distinct from (excluded.rating,excluded.prestige);
  -- Task 22 (exception 4b): only new or changed rows reach the upsert; an unchanged row is neither written nor locked.
  insert into public.recent_results(activity_id,gladiator_id,name,reveal_at_ms,summary)
    select p.activity_id,p.gladiator_id,p.name,p.reveal_at_ms,p.summary from (
      select x.id as activity_id,gid as gladiator_id,g.name as name,x.settled_at_ms as reveal_at_ms,jsonb_build_object('activityId',x.id,'resolvedKind',x.resolved_kind,
        'result',x.summary->'result','success',x.summary->'success','settledAtMs',x.settled_at_ms,
        'replayExpiry',case when x.summary->'replayExpiry'->>'state'='available' then jsonb_build_object('state','available','expiresAtMs',x.summary->'replayExpiry'->'expiresAtMs') else jsonb_build_object('state','expired') end) as summary
      from public.activities x where x.gladiator_id=gid and x.status='completed' and x.summary is not null and x.settled_at_ms is not null
    ) p
    where not exists(select 1 from public.recent_results r where r.activity_id=p.activity_id
      and (r.name,r.summary,r.reveal_at_ms) is not distinct from (p.name,p.summary,p.reveal_at_ms))
    on conflict(activity_id) do update set name=excluded.name,summary=excluded.summary,reveal_at_ms=excluded.reveal_at_ms
    where (recent_results.name,recent_results.summary,recent_results.reveal_at_ms) is distinct from (excluded.name,excluded.summary,excluded.reveal_at_ms);
  -- Task 16: every league-season rating record of the character, as public standings (rating and human counters only).
  insert into public.arena_standings(gladiator_id,league,season_index,name,rating,human_wins,human_losses)
    select r.gladiator_id,r.league,r.season_index,g.name,r.rating,r.human_wins,r.human_losses from private.arena_ratings r where r.gladiator_id=gid
    on conflict(gladiator_id,league,season_index) do update set name=excluded.name,rating=excluded.rating,
      human_wins=excluded.human_wins,human_losses=excluded.human_losses
    where (arena_standings.name,arena_standings.rating,arena_standings.human_wins,arena_standings.human_losses)
      is distinct from (excluded.name,excluded.rating,excluded.human_wins,excluded.human_losses);
end $$;

-- 04-inventory-shops.sql's owner view, unchanged except currentActivity null while resting and restingUntilSlot. create or
-- replace keeps its grants and its security_invoker option.
create or replace view public.owner_state with (security_invoker=true) as
select g.owner_id,jsonb_build_object(
  'gladiatorId',g.id,'name',g.name,'currentBuild',b.current_build,'pendingBuild',b.pending_build,'buildVersion',b.version,
  'schedule',s.schedule,'scheduleVersion',s.version,'wallets',jsonb_build_object('money',w.money,'renown',w.renown),
  'reservedFees',jsonb_build_object('money',coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0),
    'renown',coalesce((select sum(r.renown) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0)),
  'inventory',coalesce((select jsonb_agg(i.item order by i.id) from public.item_instances i where i.gladiator_id=g.id),'[]'::jsonb),'inventoryCapacity',60,
  'ownedCosmetics',coalesce((select jsonb_agg(jsonb_build_object('catalogId',c.catalog_id,'catalogVersion',c.catalog_version,'binding',c.binding) order by c.catalog_id) from public.owned_cosmetics c where c.gladiator_id=g.id),'[]'::jsonb),
  'progression',jsonb_build_object('level',g.level,'xp',g.xp,'earnedAttributePoints',g.earned_points,'unspentAttributePoints',g.unspent_points,'league',g.league,'peakStrength',g.peak_strength,'rating',g.rating),
  'stamina',jsonb_build_object('current',g.stamina_current,'maximum',g.stamina_maximum),'tournamentOptIn',g.tournament_opt_in,'processedSlotIndex',g.processed_slot_index,
  'currentActivity',case when rest.gladiator_id is null then coalesce((select jsonb_build_object('id',a.id,'kind',coalesce(a.resolved_kind,a.requested->>'kind'),
      'status',case when a.status='completed' then 'completed' when a.status='preparing' then 'queued'
        when extract(epoch from statement_timestamp())*1000<a.ends_at_ms then 'active' else 'processing' end,
      'startsAtMs',a.starts_at_ms,'endsAtMs',a.ends_at_ms,
      'label',case coalesce(a.resolved_kind,a.requested->>'kind') when 'training' then 'Training'
        when 'rest' then case when a.fallback then 'Resting (not enough stamina)' else 'Resting' end
        when 'expedition' then 'Expedition' when 'arena' then 'Arena' else 'Tournament' end)
    from public.activities a where a.gladiator_id=g.id order by a.slot_index desc limit 1),
    jsonb_build_object('id',g.id,'kind','orientation','status',case when extract(epoch from statement_timestamp())*1000<g.orientation_end_ms then 'active' else 'processing' end,
      'startsAtMs',g.created_at_ms,'endsAtMs',g.orientation_end_ms,'label','Orientation')) end,
  'restingUntilSlot',case when rest.signalled_at_ms is not null then rest.through_slot+1 end) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id
  left join public.character_rests rest on rest.gladiator_id=g.id and rest.since_slot<=g.processed_slot_index and g.processed_slot_index<=rest.through_slot;

-- Task 23.7's report (above), unchanged except cohort.restingCharacters.
create or replace function private.health_report(now_ms bigint) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare
  coord private.coordinator%rowtype; st private.retention_state%rowtype; enabled boolean; current_slot bigint; more boolean; more_since bigint;
  failures bigint; failure_states jsonb; overdue_total bigint; operator_total bigint; v_boundaries jsonb; v_jobs jsonb; v_attempts jsonb;
  v_dispatch jsonb; v_cleanup jsonb; v_events jsonb; v_resources jsonb; v_cohort jsonb; report jsonb;
begin
  if now_ms is null or now_ms<0 then raise exception 'invalid health time' using errcode='22023'; end if;
  current_slot:=now_ms/4800000;
  select * into coord from private.coordinator where singleton;
  select * into st from private.retention_state where singleton;
  enabled:=coalesce((select s.enabled from private.scheduler s where s.singleton),false);

  -- Boundaries not yet complete (normally only the next one), lowest slot first, at most 20; waitingMs since it opened.
  select coalesce(jsonb_agg(jsonb_build_object('slot',b.slot_index,'phase',b.phase,'status',b.status,'waitReason',b.wait_reason,
      'lastError',case when b.last_error is null then null when b.last_error ~ '^[0-9A-Z]{5}$' then b.last_error else 'unrecognized' end,
      'waitingMs',now_ms-b.opened_at_ms) order by b.slot_index),'[]'::jsonb)
    into v_boundaries from (select * from private.boundaries x where x.status<>'complete' order by x.slot_index limit 20) b;

  -- Jobs: counts by kind and status; overdue (pending more than 10 minutes past due, or leased with a lease expired more
  -- than 10 minutes ago) and operator jobs, at most 20 each, oldest first, with their totals.
  select count(*) into overdue_total from private.jobs j
    where (j.status='pending' and j.due_at_ms<now_ms-600000) or (j.status='leased' and j.lease_until_ms<now_ms-600000);
  select count(*) into operator_total from private.jobs j where j.status='operator';
  v_jobs:=jsonb_build_object(
    'counts',coalesce((select jsonb_object_agg(k.kind,k.statuses) from (select x.kind,jsonb_object_agg(x.status,x.n) as statuses
      from (select j.kind,j.status,count(*) as n from private.jobs j group by j.kind,j.status) x group by x.kind) k),'{}'::jsonb),
    'overdueTotal',overdue_total,
    'overdue',coalesce((select jsonb_agg(jsonb_build_object('jobId',o.id,'kind',o.kind,'slot',o.slot_index,'status',o.status,
        'dueAtMs',o.due_at_ms,'overdueMs',now_ms-o.due_at_ms,'attempts',o.attempts) order by o.due_at_ms,o.id) from (
      select j.id,j.kind,j.slot_index,j.status,j.due_at_ms,j.attempts from private.jobs j
      where (j.status='pending' and j.due_at_ms<now_ms-600000) or (j.status='leased' and j.lease_until_ms<now_ms-600000)
      order by j.due_at_ms,j.id limit 20) o),'[]'::jsonb),
    'operatorTotal',operator_total,
    'operator',coalesce((select jsonb_agg(jsonb_build_object('jobId',o.id,'kind',o.kind,'slot',o.slot_index,'attempts',o.attempts,
        'lastFailure',case when o.last_failure is null then null when o.last_failure ~ '^[a-z0-9][a-z0-9-]{0,63}$' then o.last_failure
          else 'unrecognized' end) order by o.slot_index,o.id) from (
      select j.id,j.kind,j.slot_index,j.attempts,j.last_failure from private.jobs j where j.status='operator'
      order by j.slot_index,j.id limit 20) o),'[]'::jsonb));

  -- Attempts claimed in the last 24 hours: their count, failures by code, and per-kind durations (finished_at_ms -
  -- claimed_at_ms) of the completed ones. CPU time is not exposed per request by the Edge runtime (Decision 8).
  with w as (
    select a.outcome,a.failure_code,a.claimed_at_ms,a.finished_at_ms,j.kind from private.job_attempts a join private.jobs j on j.id=a.job_id
    where a.claimed_at_ms>now_ms-86400000 and a.claimed_at_ms<=now_ms)
  select jsonb_build_object('count',(select count(*) from w),'failed',(select count(*) from w where w.outcome in ('failed','expired')),
    'failuresByCode',coalesce((select jsonb_object_agg(f.code,f.n) from (
      select case when coalesce(w.failure_code,'unknown') ~ '^[a-z0-9][a-z0-9-]{0,63}$' then coalesce(w.failure_code,'unknown')
        else 'unrecognized' end as code,count(*) as n from w where w.outcome in ('failed','expired') group by 1) f),'{}'::jsonb),
    'durations',coalesce((select jsonb_object_agg(d.kind,jsonb_build_object('count',d.n,'p50Ms',d.p50,'p95Ms',d.p95,'maxMs',d.longest)) from (
      select w.kind,count(*) as n,percentile_disc(0.5) within group (order by w.finished_at_ms-w.claimed_at_ms) as p50,
        percentile_disc(0.95) within group (order by w.finished_at_ms-w.claimed_at_ms) as p95,max(w.finished_at_ms-w.claimed_at_ms) as longest
      from w where w.outcome='completed' and w.finished_at_ms is not null group by w.kind) d),'{}'::jsonb))
  into v_attempts;

  v_dispatch:=jsonb_build_object('lastAtMs',(select max(d.dispatched_at_ms) from private.dispatch_log d where d.dispatched_at_ms<=now_ms),
    'lastHour',(select count(*) from private.dispatch_log d where d.dispatched_at_ms>now_ms-3600000 and d.dispatched_at_ms<=now_ms));

  -- Cleanup: the watermarks and the last successful run's result (its durations surface the growth of each pass); since
  -- when every cleanup tick has still had more to do; the failed cleanup ticks since the last successful one.
  more:=coalesce(st.last_result->'detail'->'more'='true'::jsonb,false) or coalesce(st.last_result->'summary'->'more'='true'::jsonb,false)
    or coalesce(st.last_result->'ledger'->'more'='true'::jsonb,false);
  if more then
    with ev as (
      select e.id,e.at_ms,coalesce(e.detail->'detail'->'more'='true'::jsonb,false) or coalesce(e.detail->'summary'->'more'='true'::jsonb,false)
        or coalesce(e.detail->'ledger'->'more'='true'::jsonb,false) as more
      from private.operations_events e where e.source='cleanup' and e.ok and e.at_ms<=now_ms)
    select min(ev.at_ms) into more_since from ev where ev.more and ev.id>coalesce((select max(x.id) from ev x where not x.more),0);
  end if;
  with streak as (
    select e.sqlstate from private.operations_events e where e.source='cleanup' and not e.ok and e.at_ms<=now_ms
      and e.id>coalesce((select max(x.id) from private.operations_events x where x.source='cleanup' and x.ok and x.at_ms<=now_ms),0))
  select (select count(*) from streak),(select coalesce(jsonb_agg(x.sqlstate order by x.sqlstate collate "C"),'[]'::jsonb)
    from (select distinct s.sqlstate from streak s where s.sqlstate is not null) x)
  into failures,failure_states;
  v_cleanup:=jsonb_build_object('lastRunAtMs',st.last_run_at_ms,'detailThroughSlot',st.detail_through_slot,
    'summaryThroughSlot',st.summary_through_slot,'more',more,
    'durationMs',case when jsonb_typeof(st.last_result->'durationMs')='number' then st.last_result->'durationMs' end,
    'detail',jsonb_build_object('more',coalesce(st.last_result->'detail'->'more'='true'::jsonb,false),
      'blockedSlot',case when jsonb_typeof(st.last_result->'detail'->'blockedSlot')='number' then st.last_result->'detail'->'blockedSlot' end,
      'durationMs',case when jsonb_typeof(st.last_result->'detail'->'durationMs')='number' then st.last_result->'detail'->'durationMs' end),
    'summary',jsonb_build_object('more',coalesce(st.last_result->'summary'->'more'='true'::jsonb,false),
      'durationMs',case when jsonb_typeof(st.last_result->'summary'->'durationMs')='number' then st.last_result->'summary'->'durationMs' end),
    'ledger',jsonb_build_object('more',coalesce(st.last_result->'ledger'->'more'='true'::jsonb,false)),
    'moreSinceMs',more_since,'failures',jsonb_build_object('consecutive',failures,'sqlstates',failure_states));

  -- Events per source: the latest failure in 24 hours, and the failures of the last hour aggregated (count and distinct
  -- SQLSTATEs, including those a sweep keeps in its detail), never one entry per row.
  with w as (
    select e.id,e.source,e.at_ms,e.sqlstate,e.detail from private.operations_events e
    where not e.ok and e.at_ms>now_ms-86400000 and e.at_ms<=now_ms
  ), codes as (
    select w.id,w.sqlstate as code from w where w.sqlstate is not null
    union
    select w.id,t.code from w cross join lateral jsonb_array_elements_text(case when jsonb_typeof(w.detail->'sqlstates')='array'
      then w.detail->'sqlstates' else '[]'::jsonb end) t(code)
  ), valid as (
    select c.id,c.code from codes c where c.code ~ '^[0-9A-Z]{5}$'
  )
  select jsonb_object_agg(s.source,jsonb_build_object(
    'latestFailure',(select jsonb_build_object('atMs',l.at_ms,
        'sqlstates',(select coalesce(jsonb_agg(v.code order by v.code collate "C"),'[]'::jsonb) from valid v where v.id=l.id),
        'failedSellers',case when jsonb_typeof(l.detail->'failedSellers')='number' then l.detail->'failedSellers' end)
      from w l where l.source=s.source order by l.at_ms desc,l.id desc limit 1),
    'lastHour',jsonb_build_object('failures',(select count(*) from w h where h.source=s.source and h.at_ms>now_ms-3600000),
      'sqlstates',(select coalesce(jsonb_agg(x.code order by x.code collate "C"),'[]'::jsonb) from (
        select distinct v.code from valid v join w h on h.id=v.id where h.source=s.source and h.at_ms>now_ms-3600000) x))))
  into v_events from (values ('market-sweep'),('dispatch'),('cleanup')) s(source);

  -- Resources against the 500 MB budget (Task 23.7); egress and function invocations are read from the hosting dashboard.
  v_resources:=jsonb_build_object('databaseBytes',pg_database_size(current_database()),'budgetBytes',524288000,
    'largestTables',coalesce((select jsonb_agg(jsonb_build_object('name',t.name,'bytes',t.bytes) order by t.bytes desc,t.name collate "C") from (
      select n.nspname||'.'||r.relname as name,pg_total_relation_size(r.oid) as bytes from pg_class r join pg_namespace n on n.oid=r.relnamespace
      where r.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\_toast%'
        and n.nspname not like 'pg\_temp%'
      order by 2 desc,1 limit 10) t),'[]'::jsonb));

  -- Task 23.7: the characters with an activity in the current slot (unique per character and slot; activities_slot_status_idx).
  -- Task 23.8: the characters resting in the current slot (a rest covers since_slot to through_slot).
  v_cohort:=jsonb_build_object('activeCharacters',(select count(*) from public.activities a where a.slot_index=current_slot),
    'restingCharacters',(select count(*) from public.character_rests r where r.since_slot<=current_slot and current_slot<=r.through_slot));

  report:=jsonb_build_object('checkedAtMs',now_ms,'currentSlot',current_slot,'publishedSlot',coord.published_slot,
    'slotsBehind',current_slot-coord.published_slot,
    'coordinator',jsonb_build_object('lastError',case when coord.last_error is null then null when coord.last_error ~ '^[0-9A-Z]{5}$' then coord.last_error
        else 'unrecognized' end,'lastFailedSlot',coord.last_failed_slot,'leaseHeld',coalesce(coord.lease_token is not null and coord.lease_until_ms>now_ms,false)),
    'scheduler',jsonb_build_object('enabled',enabled),'boundaries',v_boundaries,'jobs',v_jobs,'attempts24h',v_attempts,'dispatch',v_dispatch,
    'cleanup',v_cleanup,'events',v_events,'resources',v_resources,'cohort',v_cohort,'cpu','not available');
  return report||jsonb_build_object('alerts',private.health_alerts(report));
end $$;

revoke all on function private.idle_rules(), public.consume_command_rate(uuid,boolean), private.boundary_apply_changes(bigint),
  private.boundary_start(bigint), private.project_character(uuid) from public, anon, authenticated;
grant execute on function private.idle_rules(), public.consume_command_rate(uuid,boolean), private.boundary_apply_changes(bigint),
  private.boundary_start(bigint), private.project_character(uuid) to service_role;
-- The operator's, as before.
revoke all on function private.health_report(bigint) from public, anon, authenticated, service_role;

-- Deploy day (Task 23.8): every owner of a character gets the deploy time as its last signal, so nobody rests on the first
-- boundary after M22. Reapplicable: a recorded signal is kept. A generated migration omits it (append it to M22).
insert into private.owner_signals(owner_id,last_signal_ms)
  select g.owner_id,private.planning_now_ms() from public.gladiators g
  on conflict (owner_id) do nothing;
-- Every actor republished with its resting flag.
select public.refresh_projections();

notify pgrst, 'reload schema';
commit;
