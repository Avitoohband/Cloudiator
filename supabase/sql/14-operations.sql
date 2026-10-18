-- Tasks 22.1, 22.2 and 22.3 reapplicable source. Committed M01-M15 are immutable; deploy only the generated migration M16
-- (supabase/migrations/*_operations.sql, Task 22.3).
-- Retention in the database (game design §11; plan 2026-10-18-task-22-retention-operations, Decisions 2-5 and the binding
-- retention design): the retention state, the wallet checkpoints and the operations log; the permanent grant guards on
-- receipts and public bout results; private.cleanup_history(now_ms), one bounded, watermark-driven pruning call; its hourly
-- tick private.cleanup_tick(); and two projection changes that cut cleanup's commit-time cost.
-- Task 22.2 (Decisions 6 and 7): durable ticks (the market sweep isolates each seller, and cron_tick isolates dispatch, each
-- failure recorded as an operations event) and whole seasons (private.season_bounds, shared by boundary phase 2, phase 4 and
-- the season row backfill; phase 4 also inserts the row of the season it rates). See "Durable ticks" and "Whole seasons" below.
-- Task 22.3 (Decision 8): the owner-only health report private.health_report(now_ms) and its alerts (exception 8); the sweep
-- keeps every distinct SQLSTATE of its failed sellers and sweeps at most 50 sellers per call, and a tick records a failure of
-- its whole sweep (exception 6).
--
-- Restated rule constants (as 08-arena-bouts.sql exception 5): 604800000 is RULES_V1.retention.replayMs, 7776000000
-- RULES_V1.retention.summaryMs, 4800000 the slot length (clock.slotMs) and 18 RULES_V1.matchmaking.recentPairingSlots, the
-- pairing history window (07-arena.sql exception 7, 09-tournaments.sql's pairing_input). Operational windows: 3600000 (one
-- hour, command attempts), 172800000 (48 hours, dispatch log), 2592000000 (30 days, operations events). A rules version that
-- changes any of these needs a new source.
--
-- Retention matrix.
--   Kept forever: account and current state (gladiators, builds, schedules, wallets, item_instances, owned_cosmetics,
--     pending_build_items, pending_build_preparations); private.settled_slots (the permanent grant guard); every
--     public.operation_receipts row (its primary key is the replay and conflict guard; only a settlement receipt's result is
--     compacted at 90 days); season and standings records (arena_ratings, arena_standings, seasons, season_standings,
--     season_awards); projections (public_profiles, world_actors); configuration and singletons (rules_versions, season_epoch,
--     coordinator, scheduler, world_revision_state).
--   Seven-day detail (whole slots at or below H7): replay expiry flipped in activity summaries; public tournament bout logs
--     compacted to their fight summary; activity_stages, expedition_plans, arena_results, arena_assignment_sides,
--     arena_assignments, tournament_results, tournament_bouts, tournament_entries, tournaments, completed jobs with their
--     job_dependencies and job_attempts (a pairing job a tournament_views row references stays until the 90-day pass),
--     activity_snapshots and boundary_members deleted.
--   Ninety-day summary (whole slots at or below H90): settlement receipts compacted; tournament_bout_results,
--     tournament_placements, tournament_views and their pairing jobs (attempts first); completed activities (cascading
--     recent_results); boundary_work marked done and boundaries marked complete deleted.
--   Ninety-day, time-anchored: wallet_ledger rows folded into private.wallet_checkpoints; terminal market listings (and any
--     offer) whose expiry is 90 days past deleted after the private.expire_listings backstop; consumed and refunded fee
--     reservations whose queue-build receipt is 90 days old deleted; schedule revisions superseded for every future boundary
--     deleted 90 days after they were received.
--   Operational: command_attempts after one hour, dispatch_log after 48 hours, operations_events after 30 days,
--     cron.job_run_details after seven days (by end_time). net._http_response is left to pg_net's own pg_net.ttl (6 hours on the
--     local stack, verified for Task 22.1).
--   Never touched: unfinished jobs, held reservations and pending_build_*, open listings (only the established sweep expires a
--     due one), non-completed activities, and any slot above the checkpoint minus 19.
--
-- Checkpoint and horizons (Decision 2). P = least(coordinator.published_slot, min(gladiators.processed_slot_index)), and null
-- (both slot passes skipped) while the coordinator has published nothing. H7 = least(P - 19, (now - 604800000) / 4800000 - 1)
-- and H90 = least(P - 19, (now - 7776000000) / 4800000 - 1, detail_through_slot). P - 19 keeps the 18-slot pairing history
-- (07-arena.sql exception 7) and everything a catch-up still needs: the latest activity of every character stays (its slot is
-- its processed slot, at least P), and boundary_apply_changes never mistakes a character for a never-started one.
--
-- Step order of one call (one transaction; FK-safe, every step idempotent by watermark or state predicate).
--   0. Flip: at most 300 completed activities, lowest slots first, whose whole slot ended 7 days ago and whose replay expiry
--      has passed get summary.replayExpiry = {"state":"expired"}. Independent of P.
--   Seven-day pass over R = [detail_through_slot + 1, e]: e is the third distinct activity slot above the watermark (empty
--      slots are skipped), at most H7. A slot with an unfinished activity or job stops the batch just below it (blockedSlot).
--      With A the activities of R: (1) flip every still-available replay of A (a no-op in normal operation: step 0 covers them;
--      it guarantees no 'available' summary outlives its detail); (2) compact the tournament_bout_results of R's views;
--      delete (3) activity_stages and (4) expedition_plans of A, (5) arena_results, (6) arena_assignment_sides and
--      (7) arena_assignments of the pairing jobs of R, (8) tournament_results, (9) tournament_bouts, (10) tournament_entries and
--      (11) tournaments of R, (12) the completed jobs J of R no tournament_views row references (their job_dependencies in
--      either direction, then job_attempts, then J), (13) activity_snapshots of A and (14) boundary_members of R; (15) advance
--      detail_through_slot to e.
--   Ninety-day pass over R' = [summary_through_slot + 1, f], f at most H90 (so at most the seven-day watermark), three data
--      slots at most: (1) compact the settlement receipts of R' (activities.receipt_id) before their activities go;
--      delete (2) the tournament_bout_results and (3) tournament_placements of R''s views, (4) the views, (5) their pairing
--      jobs' attempts and then the jobs, (6) the completed activities of R' (cascading recent_results; any forgotten
--      referencing row raises a foreign-key error and the whole call fails closed), (7) done boundary_work, then complete
--      boundaries; (8) advance summary_through_slot to f.
--   Time-anchored: the ledger fold (at most 5000 rows, one statement), reservations, schedule revisions (1000 each).
--   Then every deferred projection trigger fires (SET CONSTRAINTS ALL IMMEDIATE), inside this call and its lock budget.
--   Then the market (backstop sweep, then at most 1000 terminal listings with their offers) and the operational windows
--   (1000 each; cron.job_run_details in its own block that reports only its SQLSTATE).
--   The result is returned and stored as retention_state.last_result.
--
-- Locks. lock_timeout is 500 ms for the rest of the transaction (set_config local), so cleanup gives up any contended lock
-- after 500 ms and fails whole (55P03); the next hourly tick retries. The retention_state row is locked first: one cleanup
-- runs at a time. Database time (private.planning_now_ms()) is sampled after that lock. Cleanup reads the coordinator row
-- without locking it, never takes the coordinator lease and never waits for an account lock. It locks only terminal rows of
-- slots at or below P - 19, old ledger rows and old operational rows, and finally the projection rows its deferred triggers
-- write (world_revision_state last), as every settlement does at commit. Those triggers fire inside the call (SET CONSTRAINTS
-- ALL IMMEDIATE, after the slot passes and the time-anchored steps), so the hot revision row is held only for the call's tail
-- and a trigger failure is this call's failure, caught by cleanup_tick. Both settings stay for the rest of the caller's
-- transaction.
--
-- Accepted exceptions:
-- 1. The market backstop calls private.expire_listings (12-market.sql), which try-locks each due seller's account lock and
--    skips a busy seller; it never waits, but a lock it obtains is held until this transaction commits. The step runs last
--    among the data steps to keep that hold short.
-- 2. The receipt guard (private.guard_receipt) allows exactly one update: a settlement receipt's result, once, to
--    {"compactedAtMs": n}. Command receipts are never compacted: five commands replay or refuse by comparing the full request.
-- 3. The public bout result guard (private.guard_tournament_bout_result) replaces guard_frozen on tournament_bout_results:
--    the one update it allows turns result.battleLog into result.fight {durationMs, victoryReason, tieBreakReason}.
-- 4. Projection cost. (a) project_changed_character no longer fires on activity_stages: private.project_character reads no
--    stage, so a reveal or a stage deletion only bumps the world revision (projection_changed stays). (b) The recent_results
--    upsert of private.project_character skips unchanged rows with an anti-join before ON CONFLICT, so an unchanged row is
--    neither written nor locked; the rows it leaves are exactly those of Task 10's upsert.
-- 5. Scheduling. private.cleanup_tick() is registered at minute 23 of every hour and is inert while private.scheduler is
--    disabled, like private.cron_tick. Hourly bounded calls meet the specification's daily cleanup (the day becomes the
--    maximum lateness). Each enabled tick records one private.operations_events row: ok, or the failure's SQLSTATE only.
-- 6. Durable ticks (Task 22.2, Decision 6). private.expire_listings sweeps each seller in its own subtransaction: a seller
--    whose listings cannot be closed (for example an inconsistent listing whose item is gone) rolls back only that seller's
--    work, and the sweep continues with the others. A sweep with failures records one operations event (source
--    'market-sweep', ok false, the first failure's SQLSTATE, detail {"failedSellers": n, "sqlstates": [every distinct
--    SQLSTATE, Task 22.3]}); nothing else of the failure is kept. The account try-lock is still taken outside the
--    subtransaction and never waits (12-market.sql). cleanup_history's backstop therefore no longer fails whole on one bad
--    listing. Task 22.3: one call sweeps at most 50 sellers, those whose listing has been due longest first; the others wait
--    for the next minute's sweep. That bounds the subtransactions of one tick below the 64 sub-XIDs PostgreSQL caches per
--    transaction (cron_tick: the coordination block and its at most 6 boundary blocks, the sweep block and its 50 sellers,
--    the dispatch block). private.cron_tick runs dispatch_workers() in its own block: a dispatch failure records a 'dispatch'
--    event (SQLSTATE only) and no longer rolls back the coordination and the sweep committed by the same tick. Task 22.3: a
--    failure of the whole sweep (outside any seller's block, for example a lock timeout on the listings) records a
--    'market-sweep' event with its SQLSTATE and no detail, so pg_cron's "succeeded" is not the only trace; a failure to
--    record either event is itself contained and never rolls back the tick. PL/pgSQL's OTHERS does not trap query_canceled
--    (57014): a canceled tick still aborts whole and records no event (the health report's cleanup-stale alert reads the
--    retention state instead).
-- 7. Whole seasons (Task 22.2, Decision 7; M15's known limit, docs/operations/migrations.md). private.season_bounds(index)
--    restates 13-seasons.sql's bounds (exception 1 there: 504 slots of 4800000 ms from the epoch) once; it is STABLE, not
--    IMMUTABLE, because it reads private.season_epoch. Phase 2 (private.boundary_close_season, 13-seasons.sql's body), the
--    season row backfill and phase 4 (private.boundary_recompute_leagues, 07-arena.sql's body) take their bounds from it.
--    Phase 4 also inserts the row of the season it rates (on conflict do nothing), so a season rated after the epoch was set
--    while its boundary waited at phase 4 ('epoch') has its row. The insert runs under advance_boundary's coordinator and
--    boundary locks and locks no existing season row (close_season, the only writer of an existing row, runs under the
--    same coordinator lock).
-- 8. Health (Task 22.3, Decision 8). private.health_report(now_ms) is the owner-operated report for the operator CLI
--    (scripts/health.mjs); EXECUTE is revoked from public, anon, authenticated and service_role, so no player or backend
--    path reaches it. It only reads and takes no row lock (scripts/health.mjs also runs it in a read-only transaction): it
--    reads the coordinator, boundaries, jobs, job attempts, the dispatch log, the retention state and the operations log as
--    of its snapshot, and only pg_database_size and pg_total_relation_size (the ten largest tables, any schema) beyond
--    them; those two make it VOLATILE (STABLE would misstate them; plpgsql_check flags it). Every value is a
--    number, boolean, slot, time, job id or code: a free-text column is reported only when it has the shape of a SQLSTATE
--    (coordinator and boundary last_error) or of a failure code (jobs.last_failure, job_attempts.failure_code), otherwise as
--    'unrecognized'; an event's detail contributes only failedSellers and its SQLSTATEs. It never reads Vault, pg_net
--    responses or cron run messages. Durations come from job_attempts (finished_at_ms - claimed_at_ms, completed attempts,
--    percentile_disc); CPU is "not available" (the Edge runtime does not expose it per request); egress and function
--    invocations are read from the hosting dashboard (runbook). private.health_alerts(report) derives the alerts from the
--    report alone. Restated thresholds: 600000 (ten minutes: a boundary late into its slot, a boundary waiting since it
--    opened, a job past due or past its lease), 3600000 (the last hour of tick failures), 86400000 (24 hours: attempts,
--    latest failures, the cleanup backlog), 93600000 (26 hours without a successful cleanup), three cleanup failures in a
--    row, and the 262144000-byte (250 MB) database budget: a warning from 80 %, an alert from 100 %. Lists hold at most 20
--    entries (boundaries, overdue and operator jobs), oldest first, with totals for the jobs.
begin;

-- ===== State (Decision 3): backend-only; service_role may only read it, for the health report. =====
-- Watermarks: the last slot whose seven-day detail, and whose ninety-day summary, were pruned (-1: none yet).
create table if not exists private.retention_state (
  singleton boolean primary key default true check (singleton),
  detail_through_slot bigint not null default -1 check (detail_through_slot >= -1),
  summary_through_slot bigint not null default -1 check (summary_through_slot >= -1),
  last_run_at_ms bigint,
  last_result jsonb check (last_result is null or jsonb_typeof(last_result)='object'),
  check (summary_through_slot <= detail_through_slot)
);
insert into private.retention_state(singleton) values(true) on conflict do nothing;
-- The folded part of a wallet: wallets.money = coalesce(money, 0) + sum(wallet_ledger.money_delta), the same for renown.
create table if not exists private.wallet_checkpoints (
  gladiator_id uuid primary key references public.gladiators(id),
  money bigint not null check (money between -9007199254740991 and 9007199254740991),
  renown bigint not null check (renown between -9007199254740991 and 9007199254740991),
  ledger_rows bigint not null check (ledger_rows >= 1),
  folded_through timestamptz not null,
  updated_at_ms bigint not null
);
-- Secret-free operational events (kept 30 days): a SQLSTATE, never raw error text.
create table if not exists private.operations_events (
  id bigint generated always as identity primary key,
  at_ms bigint not null,
  source text not null check (source in ('market-sweep','dispatch','cleanup')),
  ok boolean not null,
  sqlstate text check (sqlstate is null or sqlstate ~ '^[0-9A-Z]{5}$'),
  detail jsonb check (detail is null or jsonb_typeof(detail)='object')
);
create index if not exists operations_events_time_idx on private.operations_events(at_ms);
do $$ declare t text; begin
  foreach t in array array['retention_state','wallet_checkpoints','operations_events'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on private.%I to service_role',t);
    execute format('drop policy if exists backend_only on private.%I',t);
    execute format('create policy backend_only on private.%I for select to service_role using (true)',t);
  end loop;
end $$;

-- The ledger fold reads the oldest rows first; step 0 finds the still-available replays without scanning expired ones.
create index if not exists wallet_ledger_created_idx on public.wallet_ledger(created_at);
create index if not exists activities_replay_available_idx on public.activities(slot_index)
  where (summary->'replayExpiry'->>'state')='available';

-- ===== Guards =====
-- Exception 2: no receipt is ever deleted; a settlement receipt's result may be compacted once, and nothing else changes.
create or replace function private.guard_receipt() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'immutable operation_receipts'; end if;
  if old.request->>'kind' is distinct from 'activity-settlement'
    or (new.owner_id,new.operation_id,new.receipt_id,new.gladiator_id,new.request,new.request_digest,new.created_at)
      is distinct from (old.owner_id,old.operation_id,old.receipt_id,old.gladiator_id,old.request,old.request_digest,old.created_at)
    or (old.result ? 'compactedAtMs' and old.result-'compactedAtMs'='{}'::jsonb)
    or jsonb_typeof(new.result) is distinct from 'object' or new.result-'compactedAtMs'<>'{}'::jsonb
    or not private.safe_integer(new.result->'compactedAtMs') then
    raise exception 'immutable operation_receipts';
  end if;
  return new;
end $$;
drop trigger if exists guard_receipt on public.operation_receipts;
create trigger guard_receipt before update or delete on public.operation_receipts for each row execute function private.guard_receipt();

-- Exception 3: a public bout result changes once, from its battle log to its fight summary; deleting stays allowed.
create or replace function private.guard_tournament_bout_result() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if not (old.result ? 'battleLog')
    or (new.bout_id,new.tournament_id,new.ordinal,new.round,new.position,new.reveal_at_ms)
      is distinct from (old.bout_id,old.tournament_id,old.ordinal,old.round,old.position,old.reveal_at_ms)
    or new.result is distinct from (old.result-'battleLog')||jsonb_build_object('fight',jsonb_build_object(
      'durationMs',old.result->'battleLog'->'durationMs','victoryReason',old.result->'battleLog'->'victoryReason',
      'tieBreakReason',old.result->'battleLog'->'tieBreakReason')) then
    raise exception 'immutable tournament_bout_results';
  end if;
  return new;
end $$;
drop trigger if exists guard_frozen on public.tournament_bout_results;
drop trigger if exists guard_tournament_bout_result on public.tournament_bout_results;
create trigger guard_tournament_bout_result before update on public.tournament_bout_results
  for each row execute function private.guard_tournament_bout_result();

-- A checkpoint is never deleted and changes only by folding more ledger rows into it.
create or replace function private.guard_wallet_checkpoint() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' or new.gladiator_id<>old.gladiator_id or new.ledger_rows<=old.ledger_rows then
    raise exception 'immutable wallet_checkpoints';
  end if;
  return new;
end $$;
drop trigger if exists guard_wallet_checkpoint on private.wallet_checkpoints;
create trigger guard_wallet_checkpoint before update or delete on private.wallet_checkpoints
  for each row execute function private.guard_wallet_checkpoint();

-- ===== Projection cost (exception 4) =====
-- (a) A stage reveal or deletion bumps the world revision only; project_character reads no stage.
drop trigger if exists project_changed_character on public.activity_stages;
-- (b) 13-seasons.sql's projector, unchanged except that the recent_results upsert skips unchanged rows with an anti-join.
create or replace function private.project_character(gid uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare g public.gladiators%rowtype; b jsonb; a public.activities%rowtype; actor jsonb; silhouettes jsonb; awarded_prestige jsonb;
begin
  select * into g from public.gladiators where id=gid;
  if not found then return; end if;
  select current_build into b from public.builds where gladiator_id=gid;
  if b is null then return; end if;
  -- Only an authoritative published activity is visible. Preparing snapshots remain private.
  select * into a from public.activities where gladiator_id=gid and status<>'preparing'
    and published_at_ms is not null and published_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
    order by slot_index desc limit 1;
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
    'league',g.league,'level',g.level,'phase',private.slot_phase(coalesce(a.slot_index,g.processed_slot_index)),
    'location',case when a.id is null then 'orientation' when a.resolved_kind='expedition' then 'expedition:'||(a.requested->>'expeditionId') else a.resolved_kind end,
    'activityId',a.id,'activityStatus',case when a.id is null then 'active' else a.status end,
    'startsAtMs',coalesce(a.starts_at_ms,g.created_at_ms),'endsAtMs',coalesce(a.ends_at_ms,g.orientation_end_ms),'visibleStage',null);
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

-- ===== Cleanup (Decision 4) =====
-- One bounded call at database time now_ms (never ahead of private.planning_now_ms()): the steps, caps and locks of the
-- header. Returns {ok, nowMs, publishedSlot, checkpointSlot, durationMs, replay, detail, summary, ledger, market,
-- reservations, scheduleRevisions, operational} and stores it as retention_state.last_result.
create or replace function private.cleanup_history(now_ms bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  started_ms bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint; step_ms bigint;
  st private.retention_state%rowtype; published bigint; cp_slot bigint; horizon bigint; lo bigint; hi bigint;
  data_slots integer; third bigint; blocked bigint; n bigint; flipped bigint:=0; compacted bigint:=0;
  battles text[]; tids text[]; job_ids uuid[]; listing_ids uuid[];
  v_deleted jsonb; v_replay jsonb; v_detail jsonb; v_summary jsonb; v_ledger jsonb; v_market jsonb; v_operational jsonb; v_cron jsonb; v_result jsonb;
  folded_rows bigint; folded_gladiators bigint; expired integer; reservations bigint; revisions bigint;
  more boolean;
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
  v_detail:=jsonb_build_object('fromSlot',case when hi>=lo then lo end,'throughSlot',case when hi>=lo then hi end,'more',more,
    'blockedSlot',blocked,'deleted',v_deleted,'compacted',jsonb_build_object('tournamentBoutResults',compacted),
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

-- The hourly tick (Decision 5): inert unless the scheduler is enabled; one operations event per enabled run.
create or replace function private.cleanup_tick() returns jsonb language plpgsql security invoker set search_path='' as $$
declare now_ms bigint; v_result jsonb; failure text;
begin
  if not coalesce((select enabled from private.scheduler where singleton),false) then return jsonb_build_object('ok',true,'skipped','disabled'); end if;
  now_ms:=private.planning_now_ms();
  begin
    v_result:=private.cleanup_history(now_ms);
  exception when others then
    -- The whole call rolled back. Keep only the SQLSTATE: raw messages can carry data.
    failure:=sqlstate;
    v_result:=jsonb_build_object('ok',false,'code','cleanup-failed','sqlstate',failure);
  end;
  insert into private.operations_events(at_ms,source,ok,sqlstate,detail)
    values(now_ms,'cleanup',failure is null,failure,case when failure is null then v_result end);
  return v_result;
end $$;
select cron.schedule('cloudiator-cleanup','23 * * * *','select private.cleanup_tick()');

-- ===== Durable ticks (Decision 6, exception 6) =====
-- 12-market.sql's sweep, unchanged except that each seller's listings close in their own subtransaction, a sweep with
-- failed sellers records one operations event, and (Task 22.3) one call sweeps at most 50 sellers, the oldest due first.
create or replace function private.expire_listings(now_ms bigint) returns integer
language plpgsql security invoker set search_path='' as $$
declare seller record; listing uuid; expired integer:=0; seller_expired integer; swept integer:=0; failed integer:=0;
  first_failure text; failures text[]:='{}'::text[];
begin
  if now_ms is null then raise exception 'invalid expiry time'; end if;
  -- Task 22.3: the sellers whose listing has been due longest come first.
  for seller in select l.seller_gladiator_id as id,g.owner_id from private.market_listings l
    join public.gladiators g on g.id=l.seller_gladiator_id
    where l.status='open' and l.expires_at_ms<=now_ms
    group by l.seller_gladiator_id,g.owner_id order by min(l.expires_at_ms),l.seller_gladiator_id loop
    -- Task 22.3: at most 50 per-seller subtransactions per call (exception 6); the other sellers wait for the next sweep.
    exit when swept>=50;
    -- A busy seller is skipped, never waited for.
    continue when not pg_try_advisory_xact_lock(hashtextextended(seller.owner_id::text,0));
    swept:=swept+1;
    -- Task 22.2: a failure rolls back only this seller's listings; keep its SQLSTATE and count it, never its message.
    begin
      seller_expired:=0;
      for listing in select l.id from private.market_listings l where l.seller_gladiator_id=seller.id and l.status='open'
        and l.expires_at_ms<=now_ms order by l.id for update skip locked loop
        perform private.market_close_listing(listing,'expired',null);
        seller_expired:=seller_expired+1;
      end loop;
      expired:=expired+seller_expired;
    exception when others then
      failed:=failed+1;
      first_failure:=coalesce(first_failure,sqlstate);
      if not sqlstate=any(failures) then failures:=failures||sqlstate; end if;
    end;
  end loop;
  if failed>0 then
    insert into private.operations_events(at_ms,source,ok,sqlstate,detail)
      values(now_ms,'market-sweep',false,first_failure,jsonb_build_object('failedSellers',failed,'sqlstates',to_jsonb(failures)));
  end if;
  return expired;
end $$;

-- 12-market.sql's minute tick, unchanged except that dispatch runs in its own block that records a 'dispatch' event and
-- (Task 22.3) a failure of the whole sweep records a 'market-sweep' event.
create or replace function private.cron_tick() returns jsonb language plpgsql security invoker set search_path='' as $$
declare coordination jsonb; expiry jsonb; dispatch jsonb; failure text; sweep_failure text;
begin
  if not coalesce((select enabled from private.scheduler where singleton),false) then return jsonb_build_object('ok',true,'skipped','disabled'); end if;
  begin
    coordination:=public.coordinate_work();
  exception when others then
    -- Record only the SQLSTATE; dispatch still proceeds so pending work keeps draining.
    update private.coordinator set last_error=sqlstate,updated_at_ms=private.planning_now_ms() where singleton;
    coordination:=jsonb_build_object('ok',false,'code','coordinator-failed');
  end;
  -- The sweep in its own block: a failure rolls back only the sweep and reports only its SQLSTATE.
  begin
    expiry:=jsonb_build_object('ok',true,'expired',private.expire_listings(private.planning_now_ms()));
  exception when others then
    sweep_failure:=sqlstate;
    expiry:=jsonb_build_object('ok',false,'code','expiry-failed','sqlstate',sweep_failure);
    -- Task 22.3: the whole sweep failed (not one seller): keep its SQLSTATE as a 'market-sweep' event, so pg_cron's
    -- "succeeded" is not the only trace. Failing to record it is contained and never rolls back the coordination above.
    begin
      insert into private.operations_events(at_ms,source,ok,sqlstate) values(private.planning_now_ms(),'market-sweep',false,sweep_failure);
    exception when others then
      null;
    end;
  end;
  -- Task 22.2: dispatch in its own block. A failure rolls back only the dispatch and is kept as its SQLSTATE; the
  -- coordination and the sweep above still commit with this tick.
  begin
    dispatch:=private.dispatch_workers();
  exception when others then
    failure:=sqlstate;
    dispatch:=jsonb_build_object('ok',false,'code','dispatch-failed','sqlstate',failure);
    -- Task 22.3: failing to record it is contained as well.
    begin
      insert into private.operations_events(at_ms,source,ok,sqlstate) values(private.planning_now_ms(),'dispatch',false,failure);
    exception when others then
      null;
    end;
  end;
  return jsonb_build_object('ok',true,'coordination',coordination,'expiry',expiry,'dispatch',dispatch);
end $$;

-- ===== Whole seasons (Decision 7, exception 7) =====
-- One season's bounds from the launch epoch: slots epoch + 504 × index up to epoch + 504 × (index + 1), times 4800000 ms
-- (seasonAt in supabase/functions/_shared/domain/season.ts). No row without an epoch or for a negative index.
create or replace function private.season_bounds(index bigint) returns table(starts_at_ms bigint, ends_at_ms bigint)
language sql stable security invoker set search_path='' as $$
  select (e.epoch_slot+504*season_bounds.index)*4800000,(e.epoch_slot+504*(season_bounds.index+1))*4800000
  from private.season_epoch e where e.singleton and season_bounds.index>=0
$$;

-- Boundary phase 2: 13-seasons.sql's body, unchanged except that the boundary's own season row takes its bounds from
-- private.season_bounds.
create or replace function private.boundary_close_season(target bigint) returns text
language plpgsql volatile security invoker set search_path='' as $$
declare current_season bigint:=private.season_index(target); now_ms bigint; earlier bigint;
begin
  if current_season is null then return null; end if;
  now_ms:=private.planning_now_ms();
  for earlier in select s.season_index from public.seasons s where s.closed_at_ms is null and s.season_index<current_season
    order by s.season_index loop
    perform private.close_season(earlier,now_ms);
  end loop;
  insert into public.seasons(season_index,starts_at_ms,ends_at_ms)
    select current_season,b.starts_at_ms,b.ends_at_ms from private.season_bounds(current_season) b
    on conflict do nothing;
  return null;
end $$;

-- Boundary phase 4: 07-arena.sql's body, unchanged except that the season it rates gets its row first (bounds from
-- private.season_bounds), even when the epoch was set while this boundary waited here.
create or replace function private.boundary_recompute_leagues(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare season bigint:=private.season_index(target); m record; g public.gladiators%rowtype; placed text; current_rating bigint;
begin
  if not exists(select 1 from private.boundary_members bm where bm.slot_index=target) then return null; end if;
  if season is null then return 'epoch'; end if;
  insert into public.seasons(season_index,starts_at_ms,ends_at_ms)
    select season,b.starts_at_ms,b.ends_at_ms from private.season_bounds(season) b
    on conflict do nothing;
  for m in select bm.gladiator_id,bm.owner_id,j.result->>'league' as computed,(j.result->>'arenaStrength')::numeric as strength
    from private.boundary_members bm join private.jobs j on j.dedupe_key='prepare:'||target||':'||bm.gladiator_id
    where bm.slot_index=target order by bm.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(m.owner_id::text,0));
    select * into g from public.gladiators where id=m.gladiator_id for update;
    placed:=case when private.league_rank(m.computed)>private.league_rank(g.league) then m.computed else g.league end;
    insert into private.arena_ratings(gladiator_id,league,season_index) values(m.gladiator_id,placed,season) on conflict do nothing;
    select r.rating into current_rating from private.arena_ratings r
      where r.gladiator_id=m.gladiator_id and r.league=placed and r.season_index=season;
    if g.league is distinct from placed or g.rating is distinct from current_rating then
      update public.gladiators set league=placed,rating=current_rating where id=m.gladiator_id;
    end if;
    insert into public.public_profiles(gladiator_id,rating,combat_strength) values(m.gladiator_id,current_rating,m.strength)
      on conflict (gladiator_id) do update set combat_strength=excluded.combat_strength
      where public_profiles.combat_strength is distinct from excluded.combat_strength;
  end loop;
  return null;
end $$;

-- Season row backfill (Decision 7): M15's backfill through private.season_bounds, so it also gives a row to a season rated
-- while its row was missing (M15's known limit). Reapplicable; a generated migration omits it (append it to M16).
insert into public.seasons(season_index,starts_at_ms,ends_at_ms)
  select r.season_index,b.starts_at_ms,b.ends_at_ms from (select distinct season_index from private.arena_ratings) r
  cross join lateral private.season_bounds(r.season_index) b
  on conflict do nothing;

-- ===== Health (Decision 8, Task 22.3, exception 8) =====
-- The alerts of one report (private.health_report below), in this order: boundary-behind, boundary-waiting, operator-jobs,
-- overdue-jobs, cleanup-stale, cleanup-failures, cleanup-backlog, tick-failures, database-size. A pure function of the
-- report, so each threshold is testable on its own; a missing field counts as nothing to report. STABLE, not IMMUTABLE:
-- jsonb_build_object is STABLE.
create or replace function private.health_alerts(report jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  alerts jsonb:='[]'::jsonb; now_ms bigint:=(report->>'checkedAtMs')::bigint; current_slot bigint:=(report->>'currentSlot')::bigint;
  published bigint:=(report->>'publishedSlot')::bigint; enabled boolean:=coalesce(report->'scheduler'->'enabled'='true'::jsonb,false);
  n bigint; oldest bigint; longest bigint; last_run bigint; since bigint; bytes bigint; budget bigint; ticks jsonb;
begin
  -- boundary-behind: the oldest unpublished slot is more than 10 minutes into its slot; with the scheduler on, also when
  -- nothing has been published yet.
  if published is not null and published<current_slot and now_ms>(published+1)*4800000+600000 then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','boundary-behind','severity','alert','detail',jsonb_build_object(
      'publishedSlot',published,'currentSlot',current_slot,'lateMs',now_ms-(published+1)*4800000-600000)));
  elsif published is null and enabled then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','boundary-behind','severity','alert','detail',jsonb_build_object(
      'publishedSlot',null,'currentSlot',current_slot,'lateMs',null)));
  end if;
  -- boundary-waiting: a listed boundary has waited more than 10 minutes since it opened.
  select count(*),min((b->>'slot')::bigint),max((b->>'waitingMs')::bigint) into n,oldest,longest
    from jsonb_array_elements(coalesce(report->'boundaries','[]'::jsonb)) b where (b->>'waitingMs')::bigint>600000;
  if n>0 then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','boundary-waiting','severity','alert','detail',jsonb_build_object(
      'count',n,'oldestSlot',oldest,'longestWaitMs',longest)));
  end if;
  -- operator-jobs: any job held for the operator.
  n:=coalesce((report->'jobs'->>'operatorTotal')::bigint,0);
  if n>0 then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','operator-jobs','severity','alert','detail',jsonb_build_object('count',n)));
  end if;
  -- overdue-jobs: pending more than 10 minutes past due (or leased with a lease expired more than 10 minutes ago).
  n:=coalesce((report->'jobs'->>'overdueTotal')::bigint,0);
  if n>0 then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','overdue-jobs','severity','alert','detail',jsonb_build_object(
      'count',n,'oldestDueAtMs',report->'jobs'->'overdue'->0->'dueAtMs')));
  end if;
  -- cleanup-stale: the scheduler is on and no cleanup has succeeded for 26 hours (or ever). A canceled or failing tick
  -- leaves last_run_at_ms unchanged, so this also covers ticks that recorded nothing.
  last_run:=(report->'cleanup'->>'lastRunAtMs')::bigint;
  if enabled and (last_run is null or last_run<now_ms-93600000) then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','cleanup-stale','severity','alert','detail',jsonb_build_object('lastRunAtMs',last_run)));
  end if;
  -- cleanup-failures: the last three or more cleanup ticks failed.
  n:=coalesce((report->'cleanup'->'failures'->>'consecutive')::bigint,0);
  if n>=3 then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','cleanup-failures','severity','warn','detail',jsonb_build_object(
      'consecutive',n,'sqlstates',coalesce(report->'cleanup'->'failures'->'sqlstates','[]'::jsonb))));
  end if;
  -- cleanup-backlog: every cleanup tick of the last 24 hours (at least) still had more to do.
  since:=(report->'cleanup'->>'moreSinceMs')::bigint;
  if since is not null and since<=now_ms-86400000 then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','cleanup-backlog','severity','warn','detail',jsonb_build_object('moreSinceMs',since)));
  end if;
  -- tick-failures: market-sweep or dispatch failures in the last hour, aggregated per source (count and distinct SQLSTATEs).
  select jsonb_object_agg(s.source,report->'events'->s.source->'lastHour') into ticks from (values ('market-sweep'),('dispatch')) s(source)
    where coalesce((report->'events'->s.source->'lastHour'->>'failures')::bigint,0)>0;
  if ticks is not null then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','tick-failures','severity','warn','detail',ticks));
  end if;
  -- database-size: a warning from 80 % of the budget, an alert from 100 %.
  bytes:=(report->'resources'->>'databaseBytes')::bigint;
  budget:=(report->'resources'->>'budgetBytes')::bigint;
  if bytes is not null and budget is not null and bytes*5>=budget*4 then
    alerts:=alerts||jsonb_build_array(jsonb_build_object('code','database-size','severity',case when bytes>=budget then 'alert' else 'warn' end,
      'detail',jsonb_build_object('databaseBytes',bytes,'budgetBytes',budget)));
  end if;
  return alerts;
end $$;

-- The owner-only operator report at database time now_ms (header, exception 8): checkedAtMs, currentSlot, publishedSlot,
-- slotsBehind, coordinator, scheduler, boundaries, jobs, attempts24h, dispatch, cleanup, events, resources, cpu and alerts.
-- VOLATILE because pg_database_size and pg_total_relation_size are; it only reads (the CLI also runs it read-only).
create or replace function private.health_report(now_ms bigint) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare
  coord private.coordinator%rowtype; st private.retention_state%rowtype; enabled boolean; current_slot bigint; more boolean; more_since bigint;
  failures bigint; failure_states jsonb; overdue_total bigint; operator_total bigint; v_boundaries jsonb; v_jobs jsonb; v_attempts jsonb;
  v_dispatch jsonb; v_cleanup jsonb; v_events jsonb; v_resources jsonb; report jsonb;
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

  -- Resources against the 250 MB budget; egress and function invocations are read from the hosting dashboard.
  v_resources:=jsonb_build_object('databaseBytes',pg_database_size(current_database()),'budgetBytes',262144000,
    'largestTables',coalesce((select jsonb_agg(jsonb_build_object('name',t.name,'bytes',t.bytes) order by t.bytes desc,t.name collate "C") from (
      select n.nspname||'.'||r.relname as name,pg_total_relation_size(r.oid) as bytes from pg_class r join pg_namespace n on n.oid=r.relnamespace
      where r.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\_toast%'
        and n.nspname not like 'pg\_temp%'
      order by 2 desc,1 limit 10) t),'[]'::jsonb));

  report:=jsonb_build_object('checkedAtMs',now_ms,'currentSlot',current_slot,'publishedSlot',coord.published_slot,
    'slotsBehind',current_slot-coord.published_slot,
    'coordinator',jsonb_build_object('lastError',case when coord.last_error is null then null when coord.last_error ~ '^[0-9A-Z]{5}$' then coord.last_error
        else 'unrecognized' end,'lastFailedSlot',coord.last_failed_slot,'leaseHeld',coalesce(coord.lease_token is not null and coord.lease_until_ms>now_ms,false)),
    'scheduler',jsonb_build_object('enabled',enabled),'boundaries',v_boundaries,'jobs',v_jobs,'attempts24h',v_attempts,'dispatch',v_dispatch,
    'cleanup',v_cleanup,'events',v_events,'resources',v_resources,'cpu','not available');
  return report||jsonb_build_object('alerts',private.health_alerts(report));
end $$;

-- Cleanup and its tick are granted to nobody: only the owner (pg_cron, an operator) runs them. Guards and the projector keep
-- the backend's EXECUTE, as every earlier guard and projector does.
revoke all on function private.cleanup_history(bigint),private.cleanup_tick() from public,anon,authenticated,service_role;
revoke all on function private.guard_receipt(),private.guard_tournament_bout_result(),private.guard_wallet_checkpoint(),
  private.project_character(uuid) from public,anon,authenticated;
grant execute on function private.guard_receipt(),private.guard_tournament_bout_result(),private.guard_wallet_checkpoint(),
  private.project_character(uuid) to service_role;
-- Task 22.2: the sweep and the tick stay granted to nobody (12-market.sql); the season functions run inside the boundary,
-- which the worker coordinates as service_role (13-seasons.sql, 07-arena.sql).
revoke all on function private.expire_listings(bigint),private.cron_tick() from public,anon,authenticated,service_role;
revoke all on function private.season_bounds(bigint),private.boundary_close_season(bigint),private.boundary_recompute_leagues(bigint)
  from public,anon,authenticated;
grant execute on function private.season_bounds(bigint),private.boundary_close_season(bigint),private.boundary_recompute_leagues(bigint)
  to service_role;
-- Task 22.3: the health report and its alerts are the owner's (the operator's CLI): nobody else may EXECUTE them.
revoke all on function private.health_report(bigint),private.health_alerts(jsonb) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
