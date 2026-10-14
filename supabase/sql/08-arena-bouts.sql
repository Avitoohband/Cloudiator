-- Task 16 phase 2b reapplicable source. Committed M01-M09 are immutable; deploy only the separately generated migration.
-- Regular Arena bouts end to end: one simulation per battle from the frozen assignment, fenced acceptance that freezes the
-- log and both sides' outcomes once, each side's reveal and settlement under its own locks, public Arena stages and public
-- league standings. Builds on 07-arena.sql (assignments, battle seeds, rating rows, the season epoch).
-- Shared lock order (Tasks 4/6/7/9/16): coordinator row, account advisory hashtextextended(owner,0), gladiator row, then
-- dependent rows (wallet, sorted items, the side's own rating row), activities, jobs; projection rows last. Database time is
-- private.planning_now_ms(), sampled after the guard locks.
--
-- Accepted exceptions:
-- 1. One simulation per battle. 03-activities-jobs.sql says every job of an activity carries its activity snapshot seed. The
--    one `arena:<battleId>` simulation job of a battle instead carries that battle's private seed (07-arena.sql exception 2)
--    and the frozen assignment, anchored to the first side's activity and gladiator. Whichever side phase 8 starts first
--    creates it (on conflict do nothing); the other side's reveal and settlement jobs depend on a job of another activity.
--    Each side's own reveal and settlement jobs keep its activity seed.
-- 2. Acceptance trusts canonical TypeScript amounts, as preparation and pairing acceptance do: private.accept_arena_result
--    checks the result's exact shape and the log against the frozen assignment (battle id, rules version, participants,
--    their gladiatorId, name and frozen fighter values, the winner from winnerId including a 0 HP tie-break) and checks
--    each outcome's identity, its result and success against the winner, zero XP/money/points/items, the frozen rating
--    before, after = before + delta, the delta's sign, and a zero NPC delta. It restates neither renown amounts nor Elo.
-- 3. Lock order of a side's settlement: account, character, wallet, sorted items, then that side's own league-season
--    rating row (a dependent row of its character), activity and job; time is sampled after all of them. Phase 4 takes
--    account, character, rating row. A side never locks the opponent's account or rows, so the two sides settle
--    independently. Phase 8 creates the battle's simulation job under whichever side's account lock comes first; its
--    foreign keys take KEY SHARE locks on the first side's gladiator and activity rows. No cycle: a command holding that
--    gladiator row waits for no lock the boundary holds, and nothing locks a preparing activity.
-- 4. Stage publication. The warm-up (ordinal 0) is due at the slot start S, so the boundary writes it at phase 8, which
--    runs at or after S. The bout (ordinal 1) is written by the side's own reveal job at S + 60 min. The zero-length return
--    (ordinal 2) is written by the side's settlement in the transaction that credits it, at or after S + 80 min, so
--    "Results credited" never precedes the credit. Only due stages exist; RLS still checks database time on every read.
-- 5. Restated presentation and rule constants: 3600000 is RULES_V1.arena.revealAfterMs (the simulation job carries the
--    scheduled revealAtMs and the versioned executor fails closed if it differs from its own rules); 604800000 is
--    RULES_V1.retention.replayMs, as in Task 9; 18 is RULES_V1.matchmaking.recentPairingSlots, now passed as the pairing
--    input's historyFromSlot, which the versioned executor asserts; 504 in 07-arena.sql's private.season_index restates
--    RULES_V1.seasons.durationSlots. A rules version that changes any of these needs a new source.
-- 6. A side whose frozen rating differs from its own live league-season row (or whose bout has no frozen outcome) is moved
--    straight to operator state with last_failure 'rating-mismatch' (or 'arena-unsimulated'), before any grant or
--    checkpoint: the inconsistency is deterministic, so retrying it would only spend attempts. Operators repair the row and
--    resume the same job (private.resume_operator_job).
-- 7. Standings. public.arena_standings is a public projection of private.arena_ratings, written additively by Task 10's
--    private.project_character and bumping the world revision through its projection trigger. Its invoker view ranks rows
--    and marks promotions. The current season is the latest one with rows: the launch epoch stays private.
-- 8. The bout label is the side's own perspective of the logged winnerId; the return label is fixed. No domain formula.
-- Inherited (Tasks 7/9/16): the exhausted-lease sweep may lock expired jobs before the coordinator row; 07-arena.sql's
-- pairing-completion lock order is unchanged.
begin;

-- One frozen bout per battle: the sanitized public log and both sides' outcomes, written once by fenced acceptance.
create table if not exists private.arena_results (
  battle_id text primary key references private.arena_assignments(battle_id),
  simulation_job_id uuid not null unique references private.jobs(id),
  log jsonb not null check (jsonb_typeof(log)='object'),
  outcomes jsonb not null check (jsonb_typeof(outcomes)='array'),
  created_at_ms bigint not null
);
alter table private.arena_results enable row level security;
revoke all on private.arena_results from public,anon,authenticated,service_role;
grant select,insert,delete on private.arena_results to service_role;
drop policy if exists backend_only on private.arena_results;
create policy backend_only on private.arena_results to service_role using (true) with check (true);
drop trigger if exists guard_frozen on private.arena_results;
create trigger guard_frozen before update on private.arena_results for each row execute function private.guard_frozen();

-- Public standings projection (exception 7): rating and human counters only; no wallet, inventory, owner or loot.
create table if not exists public.arena_standings (
  gladiator_id uuid not null references public.gladiators(id) on delete cascade,
  league text not null check (league in ('bronze','silver','gold','champion')),
  season_index bigint not null check (season_index >= 0),
  name text not null,
  rating bigint not null check (rating between 0 and 9007199254740991),
  human_wins bigint not null check (human_wins >= 0),
  human_losses bigint not null check (human_losses >= 0),
  primary key (gladiator_id,league,season_index)
);
create index if not exists arena_standings_rank_idx on public.arena_standings(season_index,league,rating desc,human_wins desc,human_losses,gladiator_id);
alter table public.arena_standings enable row level security;
revoke all on public.arena_standings from public,anon,authenticated,service_role;
grant select on public.arena_standings to authenticated;
grant select,insert,update,delete on public.arena_standings to service_role;
drop policy if exists player_read on public.arena_standings;
create policy player_read on public.arena_standings for select to authenticated using (true);
-- Spec 8.3 order: rating, then human wins, then fewer human losses, then the stable character identifier. A row is promoted
-- when the same character holds a higher league's row in the same season.
create or replace view public.arena_standing_reads with (security_invoker=true) as
  select s.league,s.season_index,s.gladiator_id,s.name,s.rating,s.human_wins,s.human_losses,
    row_number() over (partition by s.league,s.season_index order by s.rating desc,s.human_wins desc,s.human_losses,s.gladiator_id) as rank,
    exists(select 1 from public.arena_standings h where h.gladiator_id=s.gladiator_id and h.season_index=s.season_index
      and array_position(array['bronze','silver','gold','champion'],h.league)>array_position(array['bronze','silver','gold','champion'],s.league)) as promoted
  from public.arena_standings s;
revoke all on public.arena_standing_reads from public,anon,authenticated,service_role;
grant select on public.arena_standing_reads to authenticated,service_role;

create or replace function private.activity_executor_ready(kind text) returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(kind in ('training','rest','expedition','arena'),false)
$$;

-- Phase 8: the activity's private jobs. Arena (exceptions 1 and 4): the battle's one simulation, the side's own reveal and
-- settlement depending on it, and the public warm-up stage.
create or replace function private.prepare_activity_jobs(activity uuid) returns void language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype; simulation uuid; terminal uuid; reveal uuid;
  seat private.arena_assignment_sides%rowtype; x private.arena_assignments%rowtype;
begin
  select * into a from public.activities where id=activity;
  select * into s from private.activity_snapshots where activity_id=activity;
  if a.resolved_kind not in ('training','rest','expedition','arena') then raise exception 'unsupported activity executor'; end if;
  insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
    values('settlement','settlement:'||a.id,a.slot_index,a.gladiator_id,a.id,
      jsonb_build_object('activityId',a.id,'gladiatorId',a.gladiator_id,'slotIndex',a.slot_index,'resolvedKind',a.resolved_kind,'endsAtMs',a.ends_at_ms),
      s.seed,s.rules_version,a.ends_at_ms) on conflict(dedupe_key) do nothing;
  select id into terminal from private.jobs where dedupe_key='settlement:'||a.id;
  if a.resolved_kind='expedition' then
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('simulation','expedition:'||a.id,a.slot_index,a.gladiator_id,a.id,s.snapshot,s.seed,s.rules_version,a.starts_at_ms)
      on conflict(dedupe_key) do nothing;
    select id into simulation from private.jobs where dedupe_key='expedition:'||a.id;
    insert into private.job_dependencies values(terminal,simulation) on conflict do nothing;
  elsif a.resolved_kind='arena' then
    select * into seat from private.arena_assignment_sides where activity_id=a.id;
    if not found then raise exception 'unpaired arena entrant'; end if;
    select * into x from private.arena_assignments where battle_id=seat.battle_id;
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('simulation','arena:'||x.battle_id,x.slot_index,(x.assignment->'sides'->0->>'gladiatorId')::uuid,
        (x.assignment->'sides'->0->>'activityId')::uuid,
        jsonb_build_object('kind','arena','battleId',x.battle_id,'slotIndex',x.slot_index,'rulesVersion',s.rules_version,
          'startsAtMs',a.starts_at_ms,'revealAtMs',a.starts_at_ms+3600000,'assignment',x.assignment,
          'names',(select jsonb_agg(g.name order by e.ordinality) from jsonb_array_elements(x.assignment->'sides') with ordinality e(value,ordinality)
            join public.gladiators g on g.id=(e.value->>'gladiatorId')::uuid)),
        x.seed,s.rules_version,a.starts_at_ms)
      on conflict(dedupe_key) do nothing;
    select id into simulation from private.jobs where dedupe_key='arena:'||x.battle_id;
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('reveal','arena-reveal:'||a.id,a.slot_index,a.gladiator_id,a.id,jsonb_build_object('activityId',a.id,'ordinal',1),
        s.seed,s.rules_version,a.starts_at_ms+3600000) on conflict(dedupe_key) do nothing;
    select id into reveal from private.jobs where dedupe_key='arena-reveal:'||a.id;
    insert into private.job_dependencies values(reveal,simulation),(terminal,simulation),(terminal,reveal) on conflict do nothing;
    insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,0,a.starts_at_ms,jsonb_build_object(
      'id',a.id::text||':0','kind','staging','revealedAtMs',a.starts_at_ms,'startedAtMs',a.starts_at_ms,'endsAtMs',a.starts_at_ms+3600000,
      'label','Warming up')) on conflict(activity_id,ordinal) do nothing;
  end if;
end $$;

-- Fenced Arena acceptance (called by complete_job, which locked the job row and checked its token, status and expiry under
-- database time sampled after that lock). This branch locks the row again (a no-op), samples the clock after it and
-- re-checks status, expiry, due time and dependencies before any write. Exception 2 lists what it validates.
create or replace function private.accept_arena_result(job uuid,result jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; a public.activities%rowtype; x private.arena_assignments%rowtype; seat private.arena_assignment_sides%rowtype;
  log jsonb; now_ms bigint; human boolean; sides integer; side jsonb; fighter jsonb; p jsonb; o jsonb;
  expected_id text; expected_gid jsonb; won boolean; delta numeric;
begin
  select * into j from private.jobs where id=job for update;
  now_ms:=private.planning_now_ms();
  if not found or j.status is distinct from 'leased' or j.lease_until_ms<=now_ms or j.due_at_ms>now_ms or not private.dependencies_ready(j.id) then
    return false;
  end if;
  select * into a from public.activities where id=j.activity_id;
  if a.resolved_kind is distinct from 'arena' then return false; end if;
  if j.kind='simulation' then
    select * into x from private.arena_assignments where battle_id=j.input->>'battleId';
    if not found or j.dedupe_key is distinct from 'arena:'||x.battle_id or jsonb_typeof(result) is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(result) k) is distinct from array['battleId','log','outcomes']
      or result->>'battleId' is distinct from x.battle_id or jsonb_typeof(result->'outcomes') is distinct from 'array' then
      return false;
    end if;
    begin
      log:=private.safe_battle_log(result->'log');
    exception when others then
      return false;
    end;
    human:=x.kind='human';
    sides:=case when human then 2 else 1 end;
    if log->>'battleId' is distinct from x.battle_id or log->>'rulesVersion' is distinct from j.rules_version
      or jsonb_array_length(result->'outcomes')<>sides
      or log->>'winnerId' not in (log->'participants'->0->>'id',log->'participants'->1->>'id')
      or (log->'events'->-1)->>'kind' is distinct from 'victory' or (log->'events'->-1)->>'winnerId' is distinct from log->>'winnerId' then
      return false;
    end if;
    -- Each participant is the frozen assignment's: a human by its gladiatorId, the NPC as npc:<entrant> with a null one.
    for i in 0..1 loop
      p:=log->'participants'->i;
      if i<sides then
        side:=x.assignment->'sides'->i;
        fighter:=side->'fighter';
        expected_id:=side->>'gladiatorId';
        expected_gid:=side->'gladiatorId';
        if p->'name' is distinct from j.input->'names'->i then return false; end if;
      else
        fighter:=x.assignment->'opponent'->'snapshot';
        expected_id:=x.assignment->'opponent'->>'id';
        expected_gid:='null'::jsonb;
        if coalesce(p->>'name','')='' then return false; end if;
      end if;
      if p->>'id' is distinct from expected_id or p->'gladiatorId' is distinct from expected_gid
        or p->'classId' is distinct from fighter->'classId' or p->'stance' is distinct from fighter->'stance'
        or p->'attributes' is distinct from fighter->'attributes' or p->'maxHealth' is distinct from fighter->'maxHealth'
        or p->'initialHealth' is distinct from fighter->'maxHealth' or p->'armor' is distinct from fighter->'armor'
        or p->'weaponDamage' is distinct from fighter->'weaponDamage' or p->'attackIntervalMs' is distinct from fighter->'attackIntervalMs'
        or p->'equipmentSilhouettes' is distinct from fighter->'equipmentSilhouettes' then
        return false;
      end if;
    end loop;
    -- One outcome per side, in assignment order, consistent with the logged winner and the frozen ratings.
    for i in 0..sides-1 loop
      o:=result->'outcomes'->i;
      side:=x.assignment->'sides'->i;
      if jsonb_typeof(o) is distinct from 'object' or jsonb_typeof(o->'rewards') is distinct from 'object'
        or (select array_agg(k order by k collate "C") from jsonb_object_keys(o) k)
          is distinct from array['activityId','gladiatorId','ratingAfter','ratingBefore','ratingDelta','result','rewards','success']
        or (select array_agg(k order by k collate "C") from jsonb_object_keys(o->'rewards') k)
          is distinct from array['attributePoints','items','money','overflowMoney','renown','xp']
        or o->'gladiatorId' is distinct from side->'gladiatorId' or o->'activityId' is distinct from side->'activityId' then
        return false;
      end if;
      won:=log->>'winnerId'=side->>'gladiatorId';
      if o->'result' is distinct from to_jsonb(case when won then 'victory' else 'defeat' end) or o->'success' is distinct from to_jsonb(won)
        or o->'rewards'->'money' is distinct from '0'::jsonb or o->'rewards'->'xp' is distinct from '0'::jsonb
        or o->'rewards'->'attributePoints' is distinct from '0'::jsonb or o->'rewards'->'overflowMoney' is distinct from '0'::jsonb
        or o->'rewards'->'items' is distinct from '[]'::jsonb or not private.safe_integer(o->'rewards'->'renown')
        or o->'ratingBefore' is distinct from side->'rating' or not private.safe_integer(o->'ratingAfter')
        or not private.safe_integer(o->'ratingDelta',-9007199254740991) then
        return false;
      end if;
      delta:=(o->>'ratingAfter')::numeric-(o->>'ratingBefore')::numeric;
      if (o->>'ratingDelta')::numeric<>delta or (not human and delta<>0) or (human and won and delta<0) or (human and not won and delta>0) then
        return false;
      end if;
    end loop;
    insert into private.arena_results(battle_id,simulation_job_id,log,outcomes,created_at_ms) values(x.battle_id,j.id,log,result->'outcomes',now_ms);
    return true;
  elsif j.kind='reveal' then
    -- The side's bout stage at minute 60: the battle's one frozen log, labelled from this side's perspective (exception 8).
    select * into seat from private.arena_assignment_sides where activity_id=a.id;
    select r.log into log from private.arena_results r where r.battle_id=seat.battle_id;
    if log is null or (j.input->>'ordinal')::integer is distinct from 1 then return false; end if;
    insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,1,j.due_at_ms,jsonb_build_object(
      'id',a.id::text||':1','kind','bout','revealedAtMs',j.due_at_ms,'startedAtMs',j.due_at_ms,
      'endsAtMs',j.due_at_ms+(log->>'durationMs')::bigint,
      'label',case when log->>'winnerId'=a.gladiator_id::text then 'Bout: victory' else 'Bout: defeat' end,'battleLog',log));
    return true;
  end if;
  return false;
end $$;

-- Task 9's expedition acceptance, unchanged, now dispatching Arena activities to their own fenced branch first.
create or replace function private.accept_job_result(job uuid,result jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; a public.activities%rowtype; p jsonb; stage jsonb; ordinal integer:=0;
  child uuid; previous uuid; terminal uuid; offset_ms bigint;
begin
  select * into j from private.jobs where id=job;
  select * into a from public.activities where id=j.activity_id;
  if a.resolved_kind='arena' then return private.accept_arena_result(job,result); end if;
  if a.resolved_kind is distinct from 'expedition' then return false; end if;
  if j.kind='simulation' then
    if jsonb_typeof(result) is distinct from 'object' or result->>'activityId' is distinct from a.id::text
      or result->>'rulesVersion' is distinct from j.rules_version or result->>'catalogVersion' is distinct from 'v1'
      or result->>'expeditionId' is distinct from j.input->'choice'->>'expeditionId'
      or jsonb_typeof(result->'success') is distinct from 'boolean' or jsonb_typeof(result->'encounters') is distinct from 'array'
      or jsonb_typeof(result->'stages') is distinct from 'array' or jsonb_typeof(result->'rewards') is distinct from 'object'
      or jsonb_typeof(result->'rewards'->'loot') is distinct from 'array'
      or not private.safe_integer(result->'rewards'->'money') or not private.safe_integer(result->'rewards'->'xp')
      then return false; end if;
    if jsonb_array_length(result->'encounters') not between 1 and 3 or jsonb_array_length(result->'stages') not between 4 and 8 then return false; end if;
    if result->'success'='false'::jsonb and result->'rewards'<>'{"money":0,"xp":0,"loot":[]}'::jsonb then return false; end if;
    -- Validate the entire plan's stage schedule before any write, so invalid results cannot leave partial children.
    offset_ms:=-1;
    for stage in select * from jsonb_array_elements(result->'stages') loop
      if jsonb_typeof(stage) is distinct from 'object' or jsonb_typeof(stage->'label') is distinct from 'string' or jsonb_typeof(stage->'id') is distinct from 'string'
        or coalesce(stage->>'kind','') not in ('depart','travel','exploration','encounter','return')
        or not private.safe_integer(stage->'revealedAtMs') or not private.safe_integer(stage->'startedAtMs') or not private.safe_integer(stage->'endsAtMs') then return false; end if;
      if (stage->>'revealedAtMs')::bigint<a.starts_at_ms or (stage->>'revealedAtMs')::bigint>a.ends_at_ms
        or (stage->>'revealedAtMs')::bigint<offset_ms or stage->'startedAtMs'<>stage->'revealedAtMs'
        or (stage->>'endsAtMs')::bigint<(stage->>'startedAtMs')::bigint or (stage->>'endsAtMs')::bigint>a.ends_at_ms then return false; end if;
      offset_ms:=(stage->>'revealedAtMs')::bigint;
      if stage ? 'battleLog' then perform private.safe_battle_log(stage->'battleLog'); end if;
    end loop;
    insert into private.expedition_plans values(a.id,result);
    select id into terminal from private.jobs where dedupe_key='settlement:'||a.id;
    previous:=j.id;
    for stage in select * from jsonb_array_elements(result->'stages') loop
      insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
        values('reveal','expedition-reveal:'||a.id||':'||ordinal,a.slot_index,a.gladiator_id,a.id,
          jsonb_build_object('activityId',a.id,'ordinal',ordinal),j.seed,j.rules_version,(stage->>'revealedAtMs')::bigint) returning id into child;
      insert into private.job_dependencies values(child,previous),(terminal,child);
      previous:=child;ordinal:=ordinal+1;
    end loop;
    return true;
  elsif j.kind='reveal' then
    if j.due_at_ms>private.planning_now_ms() or not private.dependencies_ready(j.id) then return false; end if;
    select plan into p from private.expedition_plans where activity_id=a.id;
    stage:=p->'stages'->((j.input->>'ordinal')::integer);
    if stage is null then return false; end if;
    insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,(j.input->>'ordinal')::integer,j.due_at_ms,
      jsonb_build_object('id',stage->'id','kind',stage->'kind','revealedAtMs',stage->'revealedAtMs','startedAtMs',stage->'startedAtMs',
        'endsAtMs',stage->'endsAtMs','label',stage->'label')||case when stage ? 'battleLog' then jsonb_build_object('battleLog',private.safe_battle_log(stage->'battleLog')) else '{}'::jsonb end);
    return true;
  end if;
  return false;
end $$;

-- Exception 6: whether this side may be credited, decided under its settlement locks before any grant. Null when it may;
-- otherwise the failure code that retains the job for operator action. Each side checks only its own frozen rating
-- against its own live league-season row, never the opponent's, which the first settlement may already have moved.
create or replace function private.arena_settlement_failure(activity uuid) returns text language plpgsql stable security invoker set search_path='' as $$
declare a public.activities%rowtype; seat private.arena_assignment_sides%rowtype; x private.arena_assignments%rowtype; o jsonb; live bigint;
begin
  select * into a from public.activities where id=activity;
  select * into seat from private.arena_assignment_sides where activity_id=activity;
  if not found then return 'arena-unassigned'; end if;
  select * into x from private.arena_assignments where battle_id=seat.battle_id;
  select r.outcomes->(seat.side::integer) into o from private.arena_results r where r.battle_id=seat.battle_id;
  if o is null or o->>'activityId' is distinct from a.id::text or o->>'gladiatorId' is distinct from a.gladiator_id::text then
    return 'arena-unsimulated';
  end if;
  select r.rating into live from private.arena_ratings r where r.gladiator_id=a.gladiator_id and r.league=x.league and r.season_index=x.season_index;
  if live is null or live is distinct from (x.assignment->'sides'->(seat.side::integer)->>'rating')::bigint
    or live is distinct from (o->>'ratingBefore')::bigint then
    return 'rating-mismatch';
  end if;
  return null;
end $$;

-- One side's credit, from its frozen outcome (called by settle_rewards inside the side's own settlement): its rating row,
-- human counters (human bouts only), the character's rating cache, renown only, and its zero-length return stage.
create or replace function private.arena_rewards(activity uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; seat private.arena_assignment_sides%rowtype; x private.arena_assignments%rowtype; o jsonb;
  human boolean; won boolean; after bigint;
begin
  select * into a from public.activities where id=activity;
  select * into seat from private.arena_assignment_sides where activity_id=activity;
  select * into x from private.arena_assignments where battle_id=seat.battle_id;
  select r.outcomes->(seat.side::integer) into o from private.arena_results r where r.battle_id=seat.battle_id;
  if o is null or o->>'activityId' is distinct from a.id::text then raise exception 'missing arena outcome'; end if;
  human:=x.kind='human';
  won:=o->>'result'='victory';
  after:=(o->>'ratingAfter')::bigint;
  update private.arena_ratings set rating=after,
    human_wins=human_wins+case when human and won then 1 else 0 end,
    human_losses=human_losses+case when human and not won then 1 else 0 end
    where gladiator_id=a.gladiator_id and league=x.league and season_index=x.season_index;
  if not found then raise exception 'missing arena rating'; end if;
  update public.gladiators set rating=after where id=a.gladiator_id and league=x.league and rating is distinct from after;
  update public.wallets set renown=renown+(o->'rewards'->>'renown')::bigint where gladiator_id=a.gladiator_id;
  insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,2,a.ends_at_ms,jsonb_build_object(
    'id',a.id::text||':2','kind','return','revealedAtMs',a.ends_at_ms,'startedAtMs',a.ends_at_ms,'endsAtMs',a.ends_at_ms,
    'label','Results credited'));
  return jsonb_build_object('rewards',o->'rewards','result',o->'result','success',o->'success','ratingDelta',o->'ratingDelta',
    'replayExpiry',case when private.planning_now_ms()<a.ends_at_ms+604800000
      then jsonb_build_object('state','available','expiresAtMs',a.ends_at_ms+604800000) else jsonb_build_object('state','expired') end);
end $$;

-- Task 7's Training/Rest settlement hook, unchanged, now with the Arena kind.
create or replace function private.settle_rewards(activity uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype; points bigint := 0; earned bigint;
begin
  select * into a from public.activities where id=activity;
  if a.resolved_kind='arena' then return private.arena_rewards(activity); end if;
  select * into s from private.activity_snapshots where activity_id=activity;
  if a.resolved_kind='training' then
    select earned_points into earned from public.gladiators where id=a.gladiator_id;
    points := least((s.snapshot->>'trainingPoints')::bigint,1000000000-earned);
    update public.gladiators set earned_points=earned_points+points,unspent_points=unspent_points+points where id=a.gladiator_id;
  elsif a.resolved_kind='rest' then
    -- Rest restores the current maximum at slot completion; no build change has occurred inside the slot.
    update public.gladiators set stamina_current=stamina_maximum where id=a.gladiator_id;
  else
    raise exception 'unsupported settlement';
  end if;
  -- Training and Rest have no replay; the canonical contract offers no non-replay state yet (Task 10/13 gate).
  return jsonb_build_object('rewards',jsonb_build_object('money',0,'renown',0,'xp',0,'attributePoints',points,'items','[]'::jsonb,'overflowMoney',0),
    'result','completed','success',true,'replayExpiry',jsonb_build_object('state','expired'));
end $$;

-- Task 9's common settlement with the Arena side's own rating row locked as a dependent row (exception 3), its fail-closed
-- rating check (exception 6), and the financial receipt and renown ledger row that Expedition already writes.
create or replace function private.settle_activity_core(activity_id uuid,lease_token uuid,prepared jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; j private.jobs%rowtype; owner uuid; now_ms bigint; receipt uuid:=gen_random_uuid();
  settlement jsonb; operation uuid:=gen_random_uuid(); result_summary jsonb; outcome jsonb; inserted integer; failure text;
begin
  if settle_activity_core.activity_id is null or settle_activity_core.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select g.owner_id into owner from public.activities x join public.gladiators g on g.id=x.gladiator_id where x.id=settle_activity_core.activity_id;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  perform 1 from public.gladiators g join public.activities x on x.gladiator_id=g.id where x.id=settle_activity_core.activity_id for update of g;
  perform 1 from public.wallets w join public.activities x on x.gladiator_id=w.gladiator_id where x.id=settle_activity_core.activity_id for update of w;
  perform 1 from public.item_instances i join public.activities x on x.gladiator_id=i.gladiator_id where x.id=settle_activity_core.activity_id order by i.id for update of i;
  perform 1 from private.arena_ratings r join private.arena_assignment_sides s on s.activity_id=settle_activity_core.activity_id
    join private.arena_assignments x on x.battle_id=s.battle_id join public.activities y on y.id=s.activity_id
    where r.gladiator_id=y.gladiator_id and r.league=x.league and r.season_index=x.season_index for update of r;
  select * into a from public.activities where id=settle_activity_core.activity_id for update;
  select * into j from private.jobs where dedupe_key='settlement:'||a.id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms();
  if j.status='completed' then
    -- A lost response retries with the same token and receives the committed receipt, never a second grant.
    if j.lease_token=settle_activity_core.lease_token then return j.result||jsonb_build_object('newGrants',0,'replayed',true); end if;
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if j.status<>'leased' or j.lease_token is distinct from settle_activity_core.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if a.status<>'active' or now_ms<a.ends_at_ms then return jsonb_build_object('ok',false,'code','processing'); end if;
  if not private.dependencies_ready(j.id) or a.slot_index>coalesce((select published_slot from private.coordinator where singleton),-1)
    or exists(select 1 from public.activities earlier where earlier.slot_index<a.slot_index and earlier.status<>'completed') then
    return jsonb_build_object('ok',false,'code','processing'); end if;
  if a.resolved_kind='arena' and not exists(select 1 from private.settled_slots s where s.gladiator_id=a.gladiator_id and s.slot_index=a.slot_index) then
    failure:=private.arena_settlement_failure(a.id);
    if failure is not null then
      -- Fail closed before any grant or checkpoint: neither the frozen nor the live value is used.
      update private.jobs set status='operator',lease_token=null,lease_owner=null,lease_until_ms=null,last_failure=failure where id=j.id;
      update private.job_attempts set finished_at_ms=now_ms,outcome='failed',failure_code=failure where job_attempts.job_id=j.id and attempt=j.attempts;
      return jsonb_build_object('ok',false,'code','operator');
    end if;
  end if;
  insert into private.settled_slots(gladiator_id,slot_index,activity_id,receipt_id,resolved_kind,settled_at_ms)
    values(a.gladiator_id,a.slot_index,a.id,receipt,a.resolved_kind,now_ms) on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then
    -- The permanent checkpoint already exists: finish the job with that receipt and grant nothing.
    select s.receipt_id into receipt from private.settled_slots s where s.gladiator_id=a.gladiator_id and s.slot_index=a.slot_index;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',0,'replayed',true);
  else
    if a.resolved_kind='expedition' then
      settlement:=private.expedition_rewards(a.id,prepared);
      if settlement is null then
        -- Raise in a subtransaction at the RPC wrapper: every tentative write/guard rolls back before stale return.
        raise exception 'stale preparation' using errcode='P0002';
      end if;
    else settlement:=private.settle_rewards(a.id); end if;
    settlement:=private.safe_settlement(settlement);
    result_summary:=settlement||jsonb_build_object('activityId',a.id,'resolvedKind',a.resolved_kind,'receiptId',receipt,'settledAtMs',now_ms);
    if a.resolved_kind in ('expedition','arena') then
      insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
        values(owner,operation,receipt,a.gladiator_id,jsonb_build_object('kind','activity-settlement','activityId',a.id),
          extensions.digest(a.id::text,'sha256'),result_summary);
      insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason)
        values(a.gladiator_id,receipt,(settlement->'rewards'->>'money')::bigint+(settlement->'rewards'->>'overflowMoney')::bigint,
          (settlement->'rewards'->>'renown')::bigint,a.resolved_kind);
    end if;
    update public.activities set status='completed',receipt_id=receipt,summary=result_summary,settled_at_ms=now_ms where id=a.id;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',1,'summary',result_summary);
  end if;
  update private.jobs set status='completed',result=outcome,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return outcome;
end $$;

-- 07-arena.sql's pairing input, now carrying the history lower bound the versioned executor asserts (exception 5).
create or replace function private.pairing_input(target bigint,league_id text,season bigint,rules text) returns jsonb
language sql stable security invoker set search_path='' as $$
  with entrants as (
    select a.id as activity_id,a.gladiator_id,s.snapshot->'starting'->'rating' as rating,p.result->'arenaFighter' as fighter
    from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    join private.jobs p on p.dedupe_key='prepare:'||target||':'||a.gladiator_id and p.status='completed'
    where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena' and s.snapshot->'starting'->>'league'=league_id)
  select jsonb_build_object('slotIndex',target,'league',league_id,'seasonId',season::text,'rulesVersion',rules,'historyFromSlot',target-18,
    'entrants',coalesce((select jsonb_agg(jsonb_build_object('gladiatorId',e.gladiator_id,'activityId',e.activity_id,'seasonId',season::text,
      'league',league_id,'slotIndex',target,'rating',e.rating,'fighter',e.fighter) order by e.gladiator_id) from entrants e),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(jsonb_build_object('slotIndex',x.slot_index,
        'gladiatorIds',jsonb_build_array(x.assignment->'sides'->0->'gladiatorId',x.assignment->'sides'->1->'gladiatorId'))
        order by x.slot_index,x.battle_id)
      from private.jobs pj join private.arena_assignments x on x.pairing_job_id=pj.id
      where pj.kind='pair' and pj.slot_index between target-18 and target-1 and x.kind='human'
        and x.assignment->'sides'->0->>'gladiatorId' in (select e.gladiator_id::text from entrants e)
        and x.assignment->'sides'->1->>'gladiatorId' in (select e.gladiator_id::text from entrants e)),'[]'::jsonb))
$$;

-- Task 10's explicit projector, unchanged, plus the character's public standings rows (exception 7).
create or replace function private.project_character(gid uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare g public.gladiators%rowtype; b jsonb; a public.activities%rowtype; actor jsonb; silhouettes jsonb;
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
  -- Combined combat strength/league score belongs to Task 16. Never label gear history as that score.
  insert into public.public_profiles(gladiator_id,rating) values(gid,g.rating) on conflict(gladiator_id) do update set rating=excluded.rating
    where public_profiles.rating is distinct from excluded.rating;
  insert into public.recent_results(activity_id,gladiator_id,name,reveal_at_ms,summary)
    select x.id,gid,g.name,x.settled_at_ms,jsonb_build_object('activityId',x.id,'resolvedKind',x.resolved_kind,
      'result',x.summary->'result','success',x.summary->'success','settledAtMs',x.settled_at_ms,
      'replayExpiry',case when x.summary->'replayExpiry'->>'state'='available' then jsonb_build_object('state','available','expiresAtMs',x.summary->'replayExpiry'->'expiresAtMs') else jsonb_build_object('state','expired') end)
    from public.activities x where x.gladiator_id=gid and x.status='completed' and x.summary is not null and x.settled_at_ms is not null
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

-- Task 10's deferred hooks, additively: rating rows republish their character; standings rows invalidate the revision.
drop trigger if exists project_changed_character on private.arena_ratings;
create constraint trigger project_changed_character after insert or update or delete on private.arena_ratings
  deferrable initially deferred for each row execute function private.project_changed_character();
drop trigger if exists projection_changed on public.arena_standings;
create constraint trigger projection_changed after insert or update or delete on public.arena_standings
  deferrable initially deferred for each row execute function private.projection_changed();

revoke all on function private.activity_executor_ready(text),private.prepare_activity_jobs(uuid),private.accept_arena_result(uuid,jsonb),
  private.accept_job_result(uuid,jsonb),private.arena_settlement_failure(uuid),private.arena_rewards(uuid),private.settle_rewards(uuid),
  private.settle_activity_core(uuid,uuid,jsonb),private.pairing_input(bigint,text,bigint,text),private.project_character(uuid)
  from public,anon,authenticated;
grant execute on function private.activity_executor_ready(text),private.prepare_activity_jobs(uuid),private.accept_arena_result(uuid,jsonb),
  private.accept_job_result(uuid,jsonb),private.arena_settlement_failure(uuid),private.arena_rewards(uuid),private.settle_rewards(uuid),
  private.settle_activity_core(uuid,uuid,jsonb),private.pairing_input(bigint,text,bigint,text),private.project_character(uuid)
  to service_role;
-- Backfill: publish the standings of every existing rating record.
select public.refresh_projections();
notify pgrst,'reload schema';
commit;
