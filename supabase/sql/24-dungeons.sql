-- Reapplicable local source for Patch 1.8 (M30). Sections 1–2 admit and group v2 dungeon activities.
-- Planning keeps the account/receipt/character order and samples database time after the character lock.
-- Pair completion locks the job first and samples database time before checking the lease. Grouping's member
-- FKs then take KEY SHARE on preparing activities while phase 7 waits, as with Arena assignments.
-- Run seeds derive from the grouping job seed and run id. Phase 8 will anchor the simulation to seat 0.
-- The shared reveal will take member activity KEY SHARE locks after its reveal-job lock. A member's
-- settlement uses only its own account, character, wallet, sorted items, activity and job locks, then samples time.
-- The later run phases restate 960000 ms and 604800000 ms. This section restates the v2 afternoon and levels 3/7/12.
begin;

-- 1. Planning and affordability. Old workers can still send the five-key preparation under either retained version.
alter table public.activities drop constraint if exists activities_resolved_kind_check,
  add constraint activities_resolved_kind_check check (resolved_kind in ('training','rest','expedition','arena','tournament','dungeon'));

create or replace function private.planning_command(actor_id uuid, operation_id uuid, input jsonb, kind text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prep jsonb:=input->'prepared'; prior public.operation_receipts%rowtype;
  g public.gladiators%rowtype; b public.builds%rowtype; s public.schedules%rowtype;
  now_ms bigint; slot bigint; receipt uuid:=gen_random_uuid(); result jsonb; err text; fee bigint; available bigint;
  inventory jsonb; ids jsonb; next_build jsonb; effective bigint; next_version bigint; required_level integer;
  part record; parts jsonb; next_schedule jsonb;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=planning_command.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if c->>'kind' is distinct from kind or c->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(c->'expectedVersion') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (c->>'expectedVersion')::numeric not between 1 and 9007199254740991 or trunc((c->>'expectedVersion')::numeric)<>(c->>'expectedVersion')::numeric
    then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms(); slot:=now_ms/4800000;
  -- A transient processing result is not retained: this exact operation may succeed after catch-up.
  if g.processed_slot_index<slot then return jsonb_build_object('ok',false,'code','processing','retryAfterMs',1000); end if;
  select * into b from public.builds where gladiator_id=g.id for update;
  select * into s from public.schedules where gladiator_id=g.id for update;
  perform 1 from public.wallets where gladiator_id=g.id for update;
  perform 1 from public.item_instances where gladiator_id=g.id order by id for update;
  if (c->>'expectedVersion')::bigint <> (case when kind in ('edit-schedule','edit-day-schedule') then s.version else b.version end) then err:='conflict';
  elsif kind='edit-schedule' then
    if (select count(*) from jsonb_object_keys(c))<>5 or not(c ?& array['kind','operationId','expectedVersion','phase','choice'])
      or c->>'phase' is null or c->>'phase' not in ('morning','afternoon','evening') or jsonb_typeof(c->'choice') is distinct from 'object' then err:='invalid';
    -- Arena only in the evening (RULES_V1.schedule.arenaPhases).
    elsif c->'choice'->>'kind'='arena' and c->>'phase'<>'evening' then err:='invalid';
    elsif c->'choice'->>'kind' in ('rest','training','arena') and (select count(*) from jsonb_object_keys(c->'choice'))=1 then null;
    elsif c->'choice'->>'kind'='expedition' and (select count(*) from jsonb_object_keys(c->'choice'))=2 and c->'choice' ? 'expeditionId' then
      required_level:=case c->'choice'->>'expeditionId' when 'woodland' then 1 when 'outpost' then 5 when 'mountain' then 10 else null end;
      if required_level is null or g.level<required_level then err:='invalid'; end if;
    elsif c->'choice'->>'kind'='dungeon' and (select count(*) from jsonb_object_keys(c->'choice'))=2 and c->'choice' ? 'dungeonId' then
      required_level:=case c->'choice'->>'dungeonId' when 'wolf-den' then 3 when 'raider-stronghold' then 7 when 'troll-hall' then 12 end;
      if c->>'phase'<>'afternoon' or private.active_rules_version() is distinct from 'v2'
        or required_level is null or g.level<required_level then err:='invalid'; end if;
    else err:='invalid'; end if;
    if err is null then
      effective:=private.schedule_effective_slot(c->>'phase',now_ms); next_version:=s.version+1;
      update public.schedules set version=next_version,schedule=jsonb_set(schedule,array[c->>'phase'],c->'choice') where gladiator_id=g.id;
      insert into public.schedule_revisions values(g.id,next_version,c->>'phase',c->'choice',now_ms,effective);
      result:=jsonb_build_object('version',next_version,'receivedAtMs',now_ms,'effectiveSlotIndex',effective,'effectiveAtMs',effective*4800000);
    end if;
  elsif kind='edit-day-schedule' then
    if (select count(*) from jsonb_object_keys(c))<>4 or not(c ?& array['kind','operationId','expectedVersion','day'])
      or jsonb_typeof(c->'day') is distinct from 'object' then err:='invalid';
    elsif (select count(*) from jsonb_object_keys(c->'day'))<>3 or not(c->'day' ?& array['morning','afternoon','evening']) then err:='invalid';
    else
      -- Each part's choice exactly as edit-schedule checks one; any refused part refuses the whole day.
      for part in select e.key as phase,e.value as choice from jsonb_each(c->'day') e loop
        if jsonb_typeof(part.choice) is distinct from 'object' then err:='invalid';
        elsif part.choice->>'kind'='arena' and part.phase<>'evening' then err:='invalid';
        elsif part.choice->>'kind' in ('rest','training','arena') and (select count(*) from jsonb_object_keys(part.choice))=1 then null;
        elsif part.choice->>'kind'='expedition' and (select count(*) from jsonb_object_keys(part.choice))=2 and part.choice ? 'expeditionId' then
          required_level:=case part.choice->>'expeditionId' when 'woodland' then 1 when 'outpost' then 5 when 'mountain' then 10 else null end;
          if required_level is null or g.level<required_level then err:='invalid'; end if;
        elsif part.choice->>'kind'='dungeon' and (select count(*) from jsonb_object_keys(part.choice))=2 and part.choice ? 'dungeonId' then
          required_level:=case part.choice->>'dungeonId' when 'wolf-den' then 3 when 'raider-stronghold' then 7 when 'troll-hall' then 12 end;
          if part.phase<>'afternoon' or private.active_rules_version() is distinct from 'v2'
            or required_level is null or g.level<required_level then err:='invalid'; end if;
        else err:='invalid'; end if;
      end loop;
      -- A day with no change is invalid (values are compared, not their key order).
      if err is null and not exists(select 1 from jsonb_each(c->'day') e where e.value is distinct from s.schedule->e.key) then err:='invalid'; end if;
    end if;
    if err is null then
      -- One version for the day; a revision, at its own next occurrence, only for each part whose choice changes.
      next_version:=s.version+1; next_schedule:=s.schedule; parts:='{}'::jsonb;
      for part in select p.phase,c->'day'->p.phase as choice from unnest(array['morning','afternoon','evening']) with ordinality p(phase,n) order by p.n loop
        if part.choice is distinct from s.schedule->part.phase then
          effective:=private.schedule_effective_slot(part.phase,now_ms);
          next_schedule:=jsonb_set(next_schedule,array[part.phase],part.choice);
          insert into public.schedule_revisions values(g.id,next_version,part.phase,part.choice,now_ms,effective);
          parts:=parts||jsonb_build_object(part.phase,jsonb_build_object('effectiveSlotIndex',effective,'effectiveAtMs',effective*4800000));
        else
          parts:=parts||jsonb_build_object(part.phase,null);
        end if;
      end loop;
      update public.schedules set version=next_version,schedule=next_schedule where gladiator_id=g.id;
      result:=jsonb_build_object('version',next_version,'receivedAtMs',now_ms,'parts',parts);
    end if;
  elsif kind='queue-build' then
    if prep is null or prep='null'::jsonb then err:='invalid';
    else
      select coalesce(jsonb_agg(item order by id),'[]'::jsonb) into inventory from public.item_instances where gladiator_id=g.id;
      if prep->'baseline' is distinct from jsonb_build_object('currentBuild',b.current_build,'pendingBuild',b.pending_build,'buildVersion',b.version,
        'earnedPoints',g.earned_points,'level',g.level,'inventory',inventory) then err:='conflict';
      else
        fee:=(prep->>'fee')::bigint;
        select w.money-coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'
          and r.operation_id is distinct from (b.pending_build->>'operationId')::uuid),0) into available from public.wallets w where w.gladiator_id=g.id;
        -- Fixed class and points: the class and every attribute are compared to the CURRENT build (b.current_build), never to the
        -- pending one, so a pending build may still be revised down to the current values (not below) and cancelled.
        if c->>'classId' is distinct from b.current_build->>'classId'
          or exists(select 1 from jsonb_each(b.current_build->'allocations') a where jsonb_typeof(c->'allocation'->a.key) is distinct from 'number' or (c->'allocation'->a.key) < a.value) then err:='invalid';
        -- No build change costs gold any more (it was fee not in (0,100,200)); a null fee is refused too.
        elsif fee is distinct from 0 then err:='invalid';
        elsif available<fee then err:='insufficient-funds'; end if;
      end if;
    end if;
    if err is null then
      next_version:=b.version+1; effective:=slot+1;
      next_build:=jsonb_build_object('version',next_version,'classId',c->'classId','stance',c->'stance','allocations',c->'allocation','equipment',c->'equipment');
      select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into ids from jsonb_each(c->'equipment') where value<>'null'::jsonb;
      update public.reservations r set status='refunded' where r.gladiator_id=g.id and r.operation_id=(b.pending_build->>'operationId')::uuid and r.status='held';
      delete from public.pending_build_items where gladiator_id=g.id;
      update public.item_instances set item=jsonb_set(item,'{reservation}','null') where gladiator_id=g.id and item->'reservation'->>'kind'='pending-build';
      insert into public.reservations(gladiator_id,operation_id,money,status) values(g.id,planning_command.operation_id,fee,'held');
      insert into public.pending_build_items select value::text::uuid,g.id,planning_command.operation_id from jsonb_array_elements_text(ids);
      update public.item_instances set item=jsonb_set(item,'{reservation}',jsonb_build_object('kind','pending-build','referenceId',planning_command.operation_id))
        where gladiator_id=g.id and id in (select item_id from public.pending_build_items where gladiator_id=g.id) and item->'reservation'='null'::jsonb;
      result:=jsonb_build_object('build',next_build,'effectiveSlotIndex',effective,'reservedMoney',fee,'reservedItemIds',ids,'operationId',operation_id);
      update public.builds set version=next_version,pending_build=result where gladiator_id=g.id;
      insert into private.pending_build_preparations values(g.id,operation_id,prep->'snapshot',(prep->>'staminaMaximum')::bigint,now_ms)
        on conflict(gladiator_id) do update set operation_id=excluded.operation_id,snapshot=excluded.snapshot,stamina_maximum=excluded.stamina_maximum,received_at_ms=excluded.received_at_ms;
    end if;
  elsif kind='cancel-build' then
    if (select count(*) from jsonb_object_keys(c))<>3 then err:='invalid';
    else
      update public.reservations r set status='refunded' where r.gladiator_id=g.id and r.operation_id=(b.pending_build->>'operationId')::uuid and r.status='held';
      delete from public.pending_build_items where gladiator_id=g.id;
      update public.item_instances set item=jsonb_set(item,'{reservation}','null') where gladiator_id=g.id and item->'reservation'->>'kind'='pending-build';
      delete from private.pending_build_preparations where gladiator_id=g.id;
      update public.builds set version=version+1,pending_build=null where gladiator_id=g.id;
      result:=jsonb_build_object('buildVersion',b.version+1);
    end if;
  else err:='invalid'; end if;
  result:=case when err is null then jsonb_build_object('ok',true,'receiptId',receipt,'value',result) else jsonb_build_object('ok',false,'code',err) end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  return result;
end $$;

create or replace function private.valid_preparation(job uuid,result jsonb) returns boolean language plpgsql stable security invoker set search_path='' as $$
declare j private.jobs%rowtype; k text; v jsonb;
begin
  select * into j from private.jobs where id=job;
  if not found then return false; end if;
  if jsonb_typeof(result) is distinct from 'object' or result->>'rulesVersion' is distinct from j.rules_version
    or jsonb_typeof(result->'snapshot') is distinct from 'object' or jsonb_typeof(result->'derived') is distinct from 'object'
    or jsonb_typeof(result->'costs') is distinct from 'object' then return false; end if;
  -- Type guards precede enumeration and casts; SQL expression evaluation order is not a validation boundary.
  if result->'costs' ? 'dungeon' then
    if j.rules_version is distinct from 'v2' or (select count(*) from jsonb_object_keys(result->'costs'))<>6
      or not private.safe_integer(result->'costs'->'dungeon') then return false; end if;
  elsif (select count(*) from jsonb_object_keys(result->'costs'))<>5 then return false;
  end if;
  if j.rules_version='v2' then
    if not private.safe_integer(to_jsonb(j.slot_index)) or not private.safe_integer(j.input->'slotIndex')
      or not private.safe_integer(j.input->'trainingActivitiesEarlierInDay')
      or jsonb_typeof(result->'trainingAllowed') is distinct from 'boolean' then return false; end if;
    -- Integral JSON numbers can retain decimal spelling (301.0); numeric preserves safe_integer's accepted domain.
    if (j.input->>'slotIndex')::numeric<>j.slot_index
      or (j.input->>'trainingActivitiesEarlierInDay')::numeric>j.slot_index%3 then return false; end if;
    if result->'trainingAllowed' is distinct from to_jsonb((j.input->>'trainingActivitiesEarlierInDay')::numeric<2) then return false; end if;
  end if;
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

create or replace function private.boundary_check_stamina(target bigint) returns text language plpgsql security invoker set search_path='' as $$
begin
  -- Reject a malformed immutable v2 snapshot before pricing casts or any activity write. Historical v1 omits this field.
  if exists(select 1 from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    where a.slot_index=target and a.status='preparing' and a.resolved_kind is null and s.rules_version='v2'
      and jsonb_typeof(s.snapshot->'trainingAllowed') is distinct from 'boolean') then
    raise exception 'invalid Training allowance snapshot';
  end if;
  with chosen as (
    select a.id,s.snapshot,s.rules_version,case when s.rules_version='v2' and a.requested->>'kind'='training'
      and s.snapshot->'trainingAllowed'='false'::jsonb then 'rest' else a.requested->>'kind' end as kind
    from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    where a.slot_index=target and a.status='preparing' and a.resolved_kind is null
  ), priced as (
    -- A validated v2 cost can have an integral decimal spelling (40.0). Keep historical v1 pricing unchanged.
    select c.id,c.kind,case when c.rules_version='v2' then (c.snapshot->'costs'->>c.kind)::numeric::bigint
      when c.kind<>'dungeon' then (c.snapshot->'costs'->>c.kind)::bigint end as cost,
      (c.snapshot->'starting'->'stamina'->>'current')::bigint as stamina
    from chosen c
  ), resolved as (
    select p.*,case when p.kind='dungeon' and p.cost is null then true else p.cost>p.stamina end as fallback from priced p
  )
  update public.activities a set resolved_kind=case when r.fallback then 'rest' else r.kind end,
    fallback=r.fallback,stamina_debit=case when r.fallback then 0 else r.cost end
  from resolved r where r.id=a.id;
  return null;
end $$;

-- 2. Phase 7. Each dungeon's pair job owns its frozen cohort and every accepted run has exactly one row per human seat.
create table if not exists private.dungeon_runs (
  run_id text primary key,
  grouping_job_id uuid not null references private.jobs(id),
  slot_index bigint not null check (slot_index >= 0),
  dungeon_id text not null check (dungeon_id in ('wolf-den','raider-stronghold','troll-hall')),
  seed text not null,
  assignment jsonb not null check (jsonb_typeof(assignment)='object'),
  created_at_ms bigint not null,
  check (run_id ~ ('^dungeon:'||slot_index||':'||dungeon_id||':[1-9][0-9]*$'))
);
create index if not exists dungeon_runs_grouping_job_idx on private.dungeon_runs(grouping_job_id);
create index if not exists dungeon_runs_slot_idx on private.dungeon_runs(slot_index);

create table if not exists private.dungeon_run_members (
  activity_id uuid primary key references public.activities(id),
  run_id text not null references private.dungeon_runs(run_id),
  seat smallint not null check (seat between 0 and 2),
  unique (run_id,seat)
);

alter table private.dungeon_runs enable row level security;
alter table private.dungeon_run_members enable row level security;
revoke all on private.dungeon_runs,private.dungeon_run_members from public,anon,authenticated,service_role;
grant select,insert,delete on private.dungeon_runs,private.dungeon_run_members to service_role;
drop policy if exists backend_only on private.dungeon_runs;
create policy backend_only on private.dungeon_runs to service_role using (true) with check (true);
drop policy if exists backend_only on private.dungeon_run_members;
create policy backend_only on private.dungeon_run_members to service_role using (true) with check (true);
drop trigger if exists guard_frozen on private.dungeon_runs;
create trigger guard_frozen before update on private.dungeon_runs for each row execute function private.guard_frozen();
drop trigger if exists guard_frozen on private.dungeon_run_members;
create trigger guard_frozen before update on private.dungeon_run_members for each row execute function private.guard_frozen();

create or replace function private.grouping_input(target bigint,dungeon text,rules text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('kind','dungeon-grouping','slotIndex',target,'dungeonId',dungeon,'rulesVersion',rules,
    'entrants',coalesce(jsonb_agg(jsonb_build_object('gladiatorId',a.gladiator_id,'activityId',a.id,'name',g.name,
      'level',s.snapshot->'starting'->'level','build',s.snapshot->'build') order by a.gladiator_id),'[]'::jsonb))
  from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    join public.gladiators g on g.id=a.gladiator_id
  where a.slot_index=target and a.status='preparing' and a.resolved_kind='dungeon'
    and a.requested->>'kind'='dungeon' and a.requested->>'dungeonId'=dungeon and s.rules_version=rules
$$;

create or replace function private.boundary_pair(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare b private.boundaries%rowtype; season bigint; l text; now_ms bigint:=private.planning_now_ms(); seed text; input jsonb; dungeon text; has_arena boolean;
begin
  select * into b from private.boundaries where slot_index=target;
  select exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing'
    and (a.resolved_kind='arena' or (b.rules_version='v2' and a.requested->>'kind'='arena' and a.resolved_kind='rest'))) into has_arena;
  if not has_arena and not exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing'
    and a.resolved_kind='dungeon') then return null; end if;
  if has_arena then
    season:=private.season_index(target);
    if season is null then return 'epoch'; end if;
    for l in select distinct s.snapshot->'starting'->>'league' from public.activities a join private.activity_snapshots s on s.activity_id=a.id
      where a.slot_index=target and a.status='preparing'
        and (a.resolved_kind='arena' or (b.rules_version='v2' and a.requested->>'kind'='arena' and a.resolved_kind='rest'))
        and not exists(select 1 from private.jobs j where j.dedupe_key='pair:'||target||':'||(s.snapshot->'starting'->>'league')) loop
      seed:=encode(extensions.gen_random_bytes(32),'hex');
      input:=jsonb_set(private.pairing_input(target,l,season,b.rules_version),'{tournament,bracketSeed}',
        to_jsonb(encode(extensions.digest(seed||':bracket','sha256'),'hex')));
      insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
        values('pair','pair:'||target||':'||l,target,null,null,input,seed,b.rules_version,now_ms)
        on conflict (dedupe_key) do nothing;
    end loop;
  end if;
  if b.rules_version='v2' then
    for dungeon in select distinct a.requested->>'dungeonId' from public.activities a
      join private.activity_snapshots s on s.activity_id=a.id
      where a.slot_index=target and a.status='preparing' and a.resolved_kind='dungeon' and s.rules_version=b.rules_version
        and a.requested->>'kind'='dungeon' and a.requested->>'dungeonId' in ('wolf-den','raider-stronghold','troll-hall')
        and not exists(select 1 from private.jobs j where j.dedupe_key='party:'||target||':'||(a.requested->>'dungeonId'))
      order by 1 loop
      input:=private.grouping_input(target,dungeon,b.rules_version);
      insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
        values('pair','party:'||target||':'||dungeon,target,null,null,input,encode(extensions.gen_random_bytes(32),'hex'),b.rules_version,now_ms)
        on conflict (dedupe_key) do nothing;
    end loop;
  end if;
  if exists(select 1 from private.jobs j where j.kind='pair' and j.slot_index=target and j.status='operator') then return 'operator'; end if;
  if exists(select 1 from private.jobs j where j.kind='pair' and j.slot_index=target and j.status<>'completed') then return 'pairing'; end if;
  if has_arena then
    -- Only entries written by accepted complete pairing jobs may promote a preliminary Rest.
    update public.activities a set resolved_kind='tournament',
      stamina_debit=case when t.rules_version='v2' then 0 else (s.snapshot->'costs'->>'tournament')::bigint end,
      fallback=case when t.rules_version='v2' then false else a.fallback end
      from private.tournament_entries e join private.tournaments t on t.id=e.tournament_id join private.activity_snapshots s on s.activity_id=e.activity_id
      where t.slot_index=target and a.id=e.activity_id and a.status='preparing'
        and (a.resolved_kind='arena' or (t.rules_version='v2' and s.rules_version='v2' and a.resolved_kind='rest'));
    if exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena'
      and not exists(select 1 from private.arena_assignment_sides x where x.activity_id=a.id)) then
      raise exception 'unpaired arena entrant';
    end if;
    if exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='tournament'
      and not exists(select 1 from private.tournament_entries e where e.activity_id=a.id)) then
      raise exception 'unbracketed tournament entrant';
    end if;
  end if;
  if exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='dungeon'
    and not exists(select 1 from private.dungeon_run_members m where m.activity_id=a.id)) then
    raise exception 'ungrouped dungeon entrant';
  end if;
  return null;
end $$;

create or replace function private.accept_grouping(job uuid,result jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; dungeon text; expected jsonb; scoped jsonb; entrant jsonb;
  run jsonb; seat jsonb; run_number bigint; seat_number bigint; gid text;
  seen text[]:='{}'; has_human boolean; has_hireling boolean; now_ms bigint;
begin
  select * into j from private.jobs where id=job;
  if not found or j.kind is distinct from 'pair' or j.rules_version is distinct from 'v2'
    or j.gladiator_id is not null or j.activity_id is not null or j.slot_index%3<>1
    or j.input->>'kind' is distinct from 'dungeon-grouping' or j.input->'slotIndex' is distinct from to_jsonb(j.slot_index)
    or j.input->>'rulesVersion' is distinct from j.rules_version
    or jsonb_typeof(j.input->'entrants') is distinct from 'array'
    or jsonb_typeof(result) is distinct from 'object' or jsonb_typeof(result->'runs') is distinct from 'array' then return false; end if;
  dungeon:=j.input->>'dungeonId';
  if dungeon is null or dungeon not in ('wolf-den','raider-stronghold','troll-hall')
    or j.dedupe_key is distinct from 'party:'||j.slot_index||':'||dungeon
    or result-'runs'<>'{}'::jsonb or jsonb_array_length(result->'runs') not between 1 and jsonb_array_length(j.input->'entrants')
    then return false; end if;

  -- The job froze names. Compare its identities/builds/levels to the preparing activity snapshots, never the live build or name.
  select coalesce(jsonb_object_agg(value->>'gladiatorId',value),'{}'::jsonb) into expected
    from jsonb_array_elements(j.input->'entrants') where jsonb_typeof(value->'gladiatorId')='string'
      and jsonb_typeof(value->'name')='string';
  if (select count(*) from jsonb_object_keys(expected))<>jsonb_array_length(j.input->'entrants') then return false; end if;
  select coalesce(jsonb_object_agg(a.gladiator_id::text,jsonb_build_object('activityId',a.id,
    'level',s.snapshot->'starting'->'level','build',s.snapshot->'build')),'{}'::jsonb) into scoped
    from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    where a.slot_index=j.slot_index and a.status='preparing' and a.resolved_kind='dungeon'
      and a.requested->>'kind'='dungeon' and a.requested->>'dungeonId'=dungeon and s.rules_version=j.rules_version;

  -- Validate the whole proposal before the first insert, including a bad seat in a later run.
  for run,run_number in select value,ordinality from jsonb_array_elements(result->'runs') with ordinality loop
    if jsonb_typeof(run) is distinct from 'object' or jsonb_typeof(run->'seats') is distinct from 'array' then return false; end if;
    if run-array['runId','seats']<>'{}'::jsonb or jsonb_array_length(run->'seats')<>3
      or run->'runId' is distinct from to_jsonb('dungeon:'||j.slot_index||':'||dungeon||':'||run_number) then return false; end if;
    has_human:=false;
    has_hireling:=false;
    for seat,seat_number in select value,ordinality from jsonb_array_elements(run->'seats') with ordinality loop
      if jsonb_typeof(seat) is distinct from 'object' or seat->'seat' is distinct from to_jsonb(seat_number-1) then return false; end if;
      if seat->>'kind'='human' then
        if has_hireling or jsonb_typeof(seat->'gladiatorId') is distinct from 'string' then return false; end if;
        gid:=seat->>'gladiatorId';
        entrant:=expected->gid;
        if entrant is null or gid=any(seen) or seat-array['kind','seat'] is distinct from entrant
          or entrant-array['gladiatorId','name'] is distinct from scoped->gid then return false; end if;
        seen:=array_append(seen,gid);
        has_human:=true;
      elsif seat->>'kind'='hireling' then
        if not has_human or seat-array['kind','seat','role']<>'{}'::jsonb or seat->>'role' is null
          or seat->>'role' not in ('guard','striker','skirmisher') then return false; end if;
        has_hireling:=true;
      else return false;
      end if;
    end loop;
    if not has_human then return false; end if;
  end loop;
  if cardinality(seen)<>jsonb_array_length(j.input->'entrants') then return false; end if;

  now_ms:=private.planning_now_ms();
  for run in select value from jsonb_array_elements(result->'runs') loop
    insert into private.dungeon_runs(run_id,grouping_job_id,slot_index,dungeon_id,seed,assignment,created_at_ms)
      values(run->>'runId',j.id,j.slot_index,dungeon,encode(extensions.digest(j.seed||':'||(run->>'runId'),'sha256'),'hex'),run,now_ms);
    insert into private.dungeon_run_members(activity_id,run_id,seat)
      select (value->>'activityId')::uuid,run->>'runId',(ordinality-1)::smallint
      from jsonb_array_elements(run->'seats') with ordinality where value->>'kind'='human';
  end loop;
  return true;
end $$;

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
    if j.input->>'kind'='dungeon-grouping' then
      if not private.accept_grouping(j.id,result) then return jsonb_build_object('ok',false,'code','invalid'); end if;
    elsif not private.accept_pairing(j.id,result) then return jsonb_build_object('ok',false,'code','invalid');
    end if;
  elsif not private.accept_job_result(j.id,result) then return jsonb_build_object('ok',false,'code','invalid');
  end if;
  update private.jobs set status='completed',result=complete_job.result,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return jsonb_build_object('ok',true,'jobId',j.id);
end $$;

revoke all on function private.planning_command(uuid,uuid,jsonb,text),private.valid_preparation(uuid,jsonb),
  private.boundary_check_stamina(bigint),private.grouping_input(bigint,text,text),private.boundary_pair(bigint),
  private.accept_grouping(uuid,jsonb),public.complete_job(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.planning_command(uuid,uuid,jsonb,text),private.valid_preparation(uuid,jsonb),
  private.boundary_check_stamina(bigint),private.grouping_input(bigint,text,text),private.boundary_pair(bigint),
  private.accept_grouping(uuid,jsonb),public.complete_job(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
