-- Task 16 phase 2a reapplicable source. Committed M01-M08 are immutable; deploy only the separately generated migration.
-- Season identity, league placement at phase 4, one rating row per character/league/season, the visible combat strength,
-- and fenced per-league regular pairing inside the boundary at phase 7. Phase 2a stops before any bout is simulated or
-- settled: Arena activities still stall truthfully at phase 8 ('integration', no debit) until phase 2b adds their executor.
-- Shared lock order (Tasks 4/6/7/9): coordinator row, account advisory hashtextextended(owner,0), gladiator row, then
-- dependent rows (here the rating row), activities, jobs; projection rows last. Database time is private.planning_now_ms().
--
-- Accepted exceptions:
-- 1. Pairing jobs belong to one slot and league, not to a gladiator or an activity. private.jobs.gladiator_id is nullable and
--    jobs_gladiator_check allows that for kind 'pair' only. Like 'prepare', a pairing job keeps its own job-local seed.
-- 2. Battle seeds. Each private.arena_assignments row stores
--    encode(extensions.digest(<pairing job seed>||':'||battleId,'sha256'),'hex'), computed here when the row is written, so a
--    retried pairing reproduces it. This is the exception to 03-activities-jobs.sql's rule that every job of an activity
--    carries its activity snapshot seed: phase 2b's single simulation job per battle carries this battle seed instead.
-- 3. Lock order of a pairing completion: complete_job locks the pairing job row, then private.accept_pairing inserts assignment
--    sides whose foreign keys take KEY SHARE locks on the entrants' activity rows (job before activity). No cycle exists: those
--    activities are 'preparing' and no path locks them while phase 7 waits for an unfinished pairing job; phase 8, the next
--    writer, starts only after every pairing job of the slot has completed.
-- 4. Phase 4 upserts public.public_profiles.combat_strength from the frozen preparation strength. Task 10's
--    private.project_character never writes that column, so the projection change is additive and its deferred revision
--    trigger still publishes the change.
-- 5. Pairing acceptance checks identity, completeness and equality with the frozen phase-4/5 values (entrant, activity, rating,
--    strength, fighter, NPC template, battle id, season, league, slot). It does not re-run matchArena's ordering: canonical
--    TypeScript decides the pairs, as it decides derived stats.
-- 6. Seasons need the launch epoch, set once (Task 24 at launch; local and test setup explicitly). With no epoch covering a slot,
--    phase 4 waits with 'epoch' instead of inventing a season.
-- 7. The pairing history passed to a job is bounded to the v1 window S - 18 .. S - 1; matchArena applies the same versioned
--    window. A rules version with a longer window must widen this bound.
-- Inherited (Tasks 7/9): the exhausted-lease sweep may lock expired jobs before the coordinator row; unchanged here.
begin;

-- Backend-only launch epoch: the slot index of the first launch boundary. Set once; update and delete are refused.
create table if not exists private.season_epoch (
  singleton boolean primary key default true check (singleton),
  epoch_slot bigint not null check (epoch_slot >= 0)
);
-- One rating record per character, league and season: 1000 on entry, floor 0, plus human-only win/loss counters.
-- public.gladiators.league/rating are the cache of the current placement and its current league-season row.
create table if not exists private.arena_ratings (
  gladiator_id uuid not null references public.gladiators(id),
  league text not null check (league in ('bronze','silver','gold','champion')),
  season_index bigint not null check (season_index >= 0),
  rating bigint not null default 1000 check (rating between 0 and 9007199254740991),
  human_wins bigint not null default 0 check (human_wins >= 0),
  human_losses bigint not null default 0 check (human_losses >= 0),
  primary key (gladiator_id,league,season_index)
);
-- Immutable regular-Arena assignments, one per battle, written once by an accepted pairing job (exception 2).
create table if not exists private.arena_assignments (
  battle_id text primary key,
  pairing_job_id uuid not null references private.jobs(id),
  slot_index bigint not null check (slot_index >= 0),
  league text not null check (league in ('bronze','silver','gold','champion')),
  season_index bigint not null check (season_index >= 0),
  kind text not null check (kind in ('human','npc')),
  seed text not null,
  assignment jsonb not null check (jsonb_typeof(assignment)='object'),
  created_at_ms bigint not null
);
create index if not exists arena_assignments_pairing_job_idx on private.arena_assignments(pairing_job_id);
-- Every entrant activity sits on exactly one side of exactly one battle.
create table if not exists private.arena_assignment_sides (
  activity_id uuid primary key references public.activities(id),
  battle_id text not null references private.arena_assignments(battle_id),
  side smallint not null check (side in (0,1)),
  unique (battle_id,side)
);
do $$ declare t text; begin
  foreach t in array array['season_epoch','arena_ratings','arena_assignments','arena_assignment_sides'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
    execute format('grant %s on private.%I to service_role',case t when 'season_epoch' then 'select'
      when 'arena_ratings' then 'select,insert,update' else 'select,insert,delete' end,t);
    execute format('drop policy if exists backend_only on private.%I',t);
    execute format('create policy backend_only on private.%I to service_role using (true) with check (true)',t);
  end loop;
end $$;

-- Pairing is a fifth job kind (exception 1), and phase 7 can now wait for it ('pairing') or phase 4 for an epoch ('epoch').
alter table private.jobs drop constraint if exists jobs_kind_check;
alter table private.jobs add constraint jobs_kind_check check (kind in ('prepare','pair','simulation','reveal','settlement'));
alter table private.jobs alter column gladiator_id drop not null;
alter table private.jobs drop constraint if exists jobs_gladiator_check;
alter table private.jobs add constraint jobs_gladiator_check check (gladiator_id is not null or kind='pair');
alter table private.boundaries drop constraint if exists boundaries_wait_reason_check;
alter table private.boundaries add constraint boundaries_wait_reason_check
  check (wait_reason in ('settlement','extension','preparation','pairing','epoch','integration','operator','straggler','error'));

-- floor((slot - epoch) / 504): the season containing an activity's start (v1 seasons last 504 slots). Null when no epoch
-- covers the slot.
create or replace function private.season_index(slot bigint) returns bigint language sql stable security invoker set search_path='' as $$
  select (slot-e.epoch_slot)/504 from private.season_epoch e where e.singleton and slot>=e.epoch_slot
$$;
create or replace function private.league_rank(league text) returns integer language sql immutable security invoker set search_path='' as $$
  select array_position(array['bronze','silver','gold','champion'],league)
$$;
-- League placement never decreases (spec 8.1), whatever writes the row.
create or replace function private.guard_league() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if private.league_rank(new.league)<private.league_rank(old.league) then raise exception 'league placement decrease'; end if;
  return new;
end $$;
-- Rating identity is immutable and its human counters only grow; records are retained (no delete).
create or replace function private.guard_arena_rating() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'immutable arena rating'; end if;
  if new.gladiator_id<>old.gladiator_id or new.league<>old.league or new.season_index<>old.season_index
    or new.human_wins<old.human_wins or new.human_losses<old.human_losses then raise exception 'immutable arena rating'; end if;
  return new;
end $$;
drop trigger if exists guard_league on public.gladiators;
create trigger guard_league before update of league on public.gladiators for each row execute function private.guard_league();
drop trigger if exists guard_arena_rating on private.arena_ratings;
create trigger guard_arena_rating before update or delete on private.arena_ratings for each row execute function private.guard_arena_rating();
drop trigger if exists guard_frozen on private.season_epoch;
create trigger guard_frozen before update or delete on private.season_epoch for each row execute function private.guard_frozen();
drop trigger if exists guard_frozen on private.arena_assignments;
create trigger guard_frozen before update on private.arena_assignments for each row execute function private.guard_frozen();
drop trigger if exists guard_frozen on private.arena_assignment_sides;
create trigger guard_frozen before update on private.arena_assignment_sides for each row execute function private.guard_frozen();

-- Task 7's status machine, with the now-nullable gladiator compared by IS DISTINCT FROM.
create or replace function private.guard_job() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if old.status<>'completed' then raise exception 'unfinished job'; end if;
    return old;
  end if;
  if old.status='completed' then raise exception 'immutable job'; end if;
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

-- Canonical TypeScript preparation, checked for shape and for the frozen cutoff build it was given. Task 16 adds the
-- league placement, the visible strength and the frozen arena fighter with its NPC template (never recomputed in SQL).
create or replace function private.valid_preparation(job uuid,result jsonb) returns boolean language plpgsql stable security invoker set search_path='' as $$
declare j private.jobs%rowtype; k text; v jsonb;
begin
  select * into j from private.jobs where id=job;
  if jsonb_typeof(result) is distinct from 'object' or result->>'rulesVersion' is distinct from j.rules_version
    or jsonb_typeof(result->'snapshot') is distinct from 'object' or jsonb_typeof(result->'derived') is distinct from 'object'
    or jsonb_typeof(result->'costs') is distinct from 'object' or (select count(*) from jsonb_object_keys(result->'costs'))<>5 then return false; end if;
  foreach k in array array['training','rest','expedition','arena','tournament'] loop
    v:=result->'costs'->k;
    if jsonb_typeof(v) is distinct from 'number' then return false; end if;
    if v::text::numeric not between 0 and 9007199254740991 or trunc(v::text::numeric)<>v::text::numeric then return false; end if;
  end loop;
  if (result->'costs'->>'rest')::numeric<>0 or jsonb_typeof(result->'trainingPoints') is distinct from 'number'
    or jsonb_typeof(result->'staminaMaximum') is distinct from 'number' then return false; end if;
  if (result->>'trainingPoints')::numeric not between 0 and 1000000000 or trunc((result->>'trainingPoints')::numeric)<>(result->>'trainingPoints')::numeric
    or (result->>'staminaMaximum')::numeric not between 1 and 9007199254740991
    or trunc((result->>'staminaMaximum')::numeric)<>(result->>'staminaMaximum')::numeric then return false; end if;
  if result->'snapshot'->>'rulesVersion' is distinct from j.rules_version or result->'snapshot'->>'classId' is distinct from j.input->'build'->>'classId'
    or result->'snapshot'->>'stance' is distinct from j.input->'build'->>'stance'
    or result->'snapshot'->'allocations' is distinct from j.input->'build'->'allocations' then return false; end if;
  foreach k in array array['weapon','offHand','head','body','feet'] loop
    if result->'snapshot'->'equipment'->k->>'id' is distinct from j.input->'build'->'equipment'->>k then return false; end if;
  end loop;
  if result->'league' is null or result->'league' not in ('"bronze"'::jsonb,'"silver"'::jsonb,'"gold"'::jsonb,'"champion"'::jsonb)
    or jsonb_typeof(result->'arenaStrength') is distinct from 'number' then return false; end if;
  if (result->>'arenaStrength')::numeric not between 0 and 9007199254740991
    or trunc((result->>'arenaStrength')::numeric*100)<>(result->>'arenaStrength')::numeric*100 then return false; end if;
  if jsonb_typeof(result->'arenaFighter') is distinct from 'object' or jsonb_typeof(result->'npcTemplate') is distinct from 'object'
    or result->'arenaFighter'->>'rulesVersion' is distinct from j.rules_version or result->'npcTemplate'->>'rulesVersion' is distinct from j.rules_version
    or result->'arenaFighter'->>'classId' is distinct from j.input->'build'->>'classId'
    or result->'arenaFighter'->>'stance' is distinct from j.input->'build'->>'stance'
    or result->'npcTemplate'->'classId' is distinct from 'null'::jsonb or result->'npcTemplate'->>'stance' is distinct from 'balanced' then return false; end if;
  return true;
end $$;

-- Phase 4 (after canonical preparation): placement never decreases; entering a league starts its league-season row at 1000
-- and keeps every earlier record; the character caches its placement and current row; the visible strength is published.
create or replace function private.boundary_recompute_leagues(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare season bigint:=private.season_index(target); m record; g public.gladiators%rowtype; placed text; current_rating bigint;
begin
  if not exists(select 1 from private.boundary_members bm where bm.slot_index=target) then return null; end if;
  if season is null then return 'epoch'; end if;
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

-- One league's frozen entrants for slot `target` and its bounded human pairing history (exception 7).
create or replace function private.pairing_input(target bigint,league_id text,season bigint,rules text) returns jsonb
language sql stable security invoker set search_path='' as $$
  with entrants as (
    select a.id as activity_id,a.gladiator_id,s.snapshot->'starting'->'rating' as rating,p.result->'arenaFighter' as fighter
    from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    join private.jobs p on p.dedupe_key='prepare:'||target||':'||a.gladiator_id and p.status='completed'
    where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena' and s.snapshot->'starting'->>'league'=league_id)
  select jsonb_build_object('slotIndex',target,'league',league_id,'seasonId',season::text,'rulesVersion',rules,
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

-- Phase 7: one fenced pairing job per slot and league with Arena entrants. Waits while any is unfinished, reports operator
-- state, and passes once every job completed and every entrant holds exactly one adopted assignment side.
create or replace function private.boundary_pair(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare b private.boundaries%rowtype; season bigint; l text; now_ms bigint:=private.planning_now_ms();
begin
  -- Tournament brackets remain the Task 19 integration gate.
  if exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='tournament') then
    return 'integration';
  end if;
  if not exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena') then return null; end if;
  select * into b from private.boundaries where slot_index=target;
  season:=private.season_index(target);
  if season is null then return 'epoch'; end if;
  for l in select distinct s.snapshot->'starting'->>'league' from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena'
      and not exists(select 1 from private.jobs j where j.dedupe_key='pair:'||target||':'||(s.snapshot->'starting'->>'league')) loop
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,rules_version,due_at_ms)
      values('pair','pair:'||target||':'||l,target,null,null,private.pairing_input(target,l,season,b.rules_version),b.rules_version,now_ms)
      on conflict (dedupe_key) do nothing;
  end loop;
  if exists(select 1 from private.jobs j where j.kind='pair' and j.slot_index=target and j.status='operator') then return 'operator'; end if;
  if exists(select 1 from private.jobs j where j.kind='pair' and j.slot_index=target and j.status<>'completed') then return 'pairing'; end if;
  if exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena'
    and not exists(select 1 from private.arena_assignment_sides x where x.activity_id=a.id)) then
    raise exception 'unpaired arena entrant';
  end if;
  return null;
end $$;

-- Completion of a pairing job (called by complete_job under the current lease). Fails closed unless the result assigns every
-- entrant of the job's slot and league exactly once with its frozen values; only then writes the immutable rows and seeds.
create or replace function private.accept_pairing(job uuid,result jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; expected jsonb; seen jsonb:='{}'::jsonb; e jsonb; s jsonb; x jsonb; gid text; human boolean;
  keys text[]; sides integer; league_id text; season bigint; now_ms bigint:=private.planning_now_ms();
begin
  select * into j from private.jobs where id=job;
  if j.kind is distinct from 'pair' or jsonb_typeof(result) is distinct from 'object' or jsonb_typeof(result->'assignments') is distinct from 'array'
    or (select array_agg(k) from jsonb_object_keys(result) k) is distinct from array['assignments'] then return false; end if;
  league_id:=j.input->>'league';
  season:=private.season_index(j.slot_index);
  if season is null or j.input->>'seasonId' is distinct from season::text then return false; end if;
  -- The frozen values of every entrant of this slot and league: snapshot rating, preparation strength, fighter and NPC template.
  select coalesce(jsonb_object_agg(a.gladiator_id::text,jsonb_build_object('activityId',a.id,'rating',sn.snapshot->'starting'->'rating',
      'strength',p.result->'arenaStrength','fighter',p.result->'arenaFighter','npc',p.result->'npcTemplate')),'{}'::jsonb) into expected
    from public.activities a join private.activity_snapshots sn on sn.activity_id=a.id
    join private.jobs p on p.dedupe_key='prepare:'||a.slot_index||':'||a.gladiator_id and p.status='completed'
    where a.slot_index=j.slot_index and a.status='preparing' and a.resolved_kind='arena' and sn.snapshot->'starting'->>'league'=league_id;
  for e in select value from jsonb_array_elements(result->'assignments') loop
    if jsonb_typeof(e) is distinct from 'object' or e->'kind' is null or e->'kind' not in ('"human"'::jsonb,'"npc"'::jsonb)
      or jsonb_typeof(e->'sides') is distinct from 'array' then return false; end if;
    human:=e->>'kind'='human';
    -- PL/pgSQL ends an IF condition at its first THEN, so the kind-dependent shape is computed first.
    keys:=case when human then array['battleId','kind','league','seasonId','sides','slotIndex']
      else array['battleId','kind','league','opponent','seasonId','sides','slotIndex'] end;
    sides:=case when human then 2 else 1 end;
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(e) k) is distinct from keys
      or e->'slotIndex' is distinct from to_jsonb(j.slot_index) or e->'league' is distinct from to_jsonb(league_id)
      or e->'seasonId' is distinct from to_jsonb(season::text) or jsonb_array_length(e->'sides')<>sides then return false; end if;
    for s in select value from jsonb_array_elements(e->'sides') loop
      if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'gladiatorId') is distinct from 'string'
        or (select array_agg(k order by k collate "C") from jsonb_object_keys(s) k) is distinct from array['activityId','fighter','gladiatorId','rating','strength']
        then return false; end if;
      gid:=s->>'gladiatorId';
      x:=expected->gid;
      if x is null or seen ? gid or s->'activityId' is distinct from x->'activityId' or s->'rating' is distinct from x->'rating'
        or s->'strength' is distinct from x->'strength' or s->'fighter' is distinct from x->'fighter' then return false; end if;
      seen:=seen||jsonb_build_object(gid,true);
    end loop;
    if human then
      if e->'battleId' is distinct from to_jsonb('arena:'||j.slot_index||':'||(e->'sides'->0->>'gladiatorId')||':'||(e->'sides'->1->>'gladiatorId')) then
        return false;
      end if;
    else
      gid:=e->'sides'->0->>'gladiatorId';
      if e->'battleId' is distinct from to_jsonb('arena:'||j.slot_index||':'||gid||':npc') or jsonb_typeof(e->'opponent') is distinct from 'object' then
        return false;
      end if;
      if (select array_agg(k order by k collate "C") from jsonb_object_keys(e->'opponent') k) is distinct from array['id','snapshot']
        or e->'opponent'->'id' is distinct from to_jsonb('npc:'||gid) or e->'opponent'->'snapshot' is distinct from expected->gid->'npc' then
        return false;
      end if;
    end if;
  end loop;
  -- Complete: every entrant appeared, each exactly once (duplicates were refused above).
  if (select count(*) from jsonb_object_keys(seen))<>(select count(*) from jsonb_object_keys(expected)) then return false; end if;
  for e in select value from jsonb_array_elements(result->'assignments') loop
    insert into private.arena_assignments(battle_id,pairing_job_id,slot_index,league,season_index,kind,seed,assignment,created_at_ms)
      values(e->>'battleId',j.id,j.slot_index,league_id,season,e->>'kind',
        encode(extensions.digest(j.seed||':'||(e->>'battleId'),'sha256'),'hex'),e,now_ms);
    insert into private.arena_assignment_sides(activity_id,battle_id,side)
      select (side.value->>'activityId')::uuid,e->>'battleId',(side.ordinality-1)::smallint
      from jsonb_array_elements(e->'sides') with ordinality side(value,ordinality);
  end loop;
  return true;
end $$;

-- SKIP LOCKED claims (Task 9 dependency gating) now also whitelist pairing, claimed as simple work (cap 20).
create or replace function public.claim_jobs(worker_id uuid,kind text,batch_limit integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare now_ms bigint:=private.planning_now_ms(); cap integer; leases jsonb;
begin
  if claim_jobs.worker_id is null or claim_jobs.kind is null or claim_jobs.kind not in ('prepare','pair','simulation','reveal','settlement')
    or batch_limit is null or batch_limit<1 then
    raise exception 'invalid claim' using errcode='22023';
  end if;
  cap:=least(batch_limit,case when claim_jobs.kind='simulation' then 5 else 20 end);
  perform private.sweep_exhausted_leases(now_ms);
  with picked as (
    select j.id,j.status as previous_status,j.attempts as previous_attempt from private.jobs j
    where j.kind=claim_jobs.kind and j.due_at_ms<=now_ms
      and private.dependencies_ready(j.id)
      and (j.status='pending' or (j.status='leased' and j.lease_until_ms<=now_ms and j.attempts<j.max_attempts))
    order by j.due_at_ms,j.id limit cap for update skip locked
  ), expired as (
    update private.job_attempts a set finished_at_ms=now_ms,outcome='expired',failure_code='lease-expired'
    from picked p where p.previous_status='leased' and a.job_id=p.id and a.attempt=p.previous_attempt and a.outcome is null
  ), claimed as (
    update private.jobs j set status='leased',lease_token=gen_random_uuid(),lease_owner=claim_jobs.worker_id,leased_at_ms=now_ms,
      lease_until_ms=now_ms+120000,attempts=j.attempts+1
    from picked p where j.id=p.id
    returning j.*
  ), logged as (
    insert into private.job_attempts(job_id,attempt,worker_id,claimed_at_ms) select c.id,c.attempts,claim_jobs.worker_id,now_ms from claimed c
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'token',c.lease_token,'expiresAtMs',c.lease_until_ms,'kind',c.kind,
    'activityId',c.activity_id,'gladiatorId',c.gladiator_id,'slotIndex',c.slot_index,'snapshot',c.input,'seed',c.seed,
    'rulesVersion',c.rules_version,'attempt',c.attempts) order by c.due_at_ms,c.id),'[]'::jsonb) into leases from claimed c;
  return leases;
end $$;
-- Task 9's post-lock fenced completion, with its own pairing branch (otherwise a pairing result would reach accept_job_result).
create or replace function public.complete_job(job_id uuid,lease_token uuid,result jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; now_ms bigint;
begin
  if complete_job.job_id is null or complete_job.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into j from private.jobs where id=complete_job.job_id for update;
  now_ms:=private.planning_now_ms();
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if j.status='completed' and j.lease_token=complete_job.lease_token then
    return jsonb_build_object('ok',true,'jobId',j.id,'replayed',true);
  end if;
  if j.status<>'leased' or j.lease_token is distinct from complete_job.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if not private.dependencies_ready(j.id) or j.due_at_ms>now_ms then return jsonb_build_object('ok',false,'code','processing'); end if;
  if j.kind='settlement' then return jsonb_build_object('ok',false,'code','invalid');
  elsif j.kind='prepare' then
    if not private.valid_preparation(j.id,result) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  elsif j.kind='pair' then
    if not private.accept_pairing(j.id,result) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  elsif not private.accept_job_result(j.id,result) then return jsonb_build_object('ok',false,'code','invalid');
  end if;
  update private.jobs set status='completed',result=complete_job.result,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return jsonb_build_object('ok',true,'jobId',j.id);
end $$;

revoke all on function private.season_index(bigint),private.league_rank(text),private.guard_league(),private.guard_arena_rating(),
  private.guard_job(),private.valid_preparation(uuid,jsonb),private.boundary_recompute_leagues(bigint),
  private.pairing_input(bigint,text,bigint,text),private.boundary_pair(bigint),private.accept_pairing(uuid,jsonb),
  public.claim_jobs(uuid,text,integer),public.complete_job(uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function private.season_index(bigint),private.league_rank(text),private.guard_league(),private.guard_arena_rating(),
  private.guard_job(),private.valid_preparation(uuid,jsonb),private.boundary_recompute_leagues(bigint),
  private.pairing_input(bigint,text,bigint,text),private.boundary_pair(bigint),private.accept_pairing(uuid,jsonb),
  public.claim_jobs(uuid,text,integer),public.complete_job(uuid,uuid,jsonb)
  to service_role;
notify pgrst,'reload schema';
commit;
