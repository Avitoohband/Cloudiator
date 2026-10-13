
  create table "public"."activity_stages" (
    "id" uuid not null default gen_random_uuid(),
    "activity_id" uuid not null,
    "ordinal" integer not null,
    "reveal_at_ms" bigint not null,
    "stage" jsonb not null
      );


alter table "public"."activity_stages" enable row level security;

CREATE UNIQUE INDEX activity_stages_activity_id_ordinal_key ON public.activity_stages USING btree (activity_id, ordinal);

CREATE UNIQUE INDEX activity_stages_pkey ON public.activity_stages USING btree (id);

CREATE INDEX activity_stages_reveal_idx ON public.activity_stages USING btree (reveal_at_ms);

alter table "public"."activity_stages" add constraint "activity_stages_pkey" PRIMARY KEY using index "activity_stages_pkey";

alter table "public"."activity_stages" add constraint "activity_stages_activity_id_fkey" FOREIGN KEY (activity_id) REFERENCES public.activities(id) not valid;

alter table "public"."activity_stages" validate constraint "activity_stages_activity_id_fkey";

alter table "public"."activity_stages" add constraint "activity_stages_activity_id_ordinal_key" UNIQUE using index "activity_stages_activity_id_ordinal_key";

alter table "public"."activity_stages" add constraint "activity_stages_ordinal_check" CHECK ((ordinal >= 0)) not valid;

alter table "public"."activity_stages" validate constraint "activity_stages_ordinal_check";

alter table "public"."activity_stages" add constraint "activity_stages_stage_check" CHECK ((jsonb_typeof(stage) = 'object'::text)) not valid;

alter table "public"."activity_stages" validate constraint "activity_stages_stage_check";

set check_function_bodies = off;

create or replace function public.commit_expedition_plan(job_id uuid,lease_token uuid,plan jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from private.jobs j join public.activities a on a.id=j.activity_id
    where j.id=job_id and j.kind='simulation' and a.resolved_kind='expedition') then return jsonb_build_object('ok',false,'code','invalid'); end if;
  return public.complete_job(job_id,lease_token,plan);
end $$;

create or replace function public.expedition_settlement_input(activity_id uuid,lease_token uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  select jsonb_build_object('jobId',j.id,'state',o.state,'rewards',p.plan->'rewards','rulesVersion',p.plan->'rulesVersion') into result
    from public.activities a join private.jobs j on j.dedupe_key='settlement:'||a.id
    join private.expedition_plans p on p.activity_id=a.id join public.gladiators g on g.id=a.gladiator_id
    join public.owner_state o on o.owner_id=g.owner_id
    where a.id=expedition_settlement_input.activity_id and j.lease_token=expedition_settlement_input.lease_token and j.status='leased'
      and j.lease_until_ms>private.planning_now_ms();
  return result;
end $$;

create or replace function public.settle_expedition(activity_id uuid,lease_token uuid,prepared jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  return private.settle_activity_core(activity_id,lease_token,prepared);
exception when no_data_found then return jsonb_build_object('ok',false,'code','stale-preparation');
end $$;

create or replace function public.claim_jobs(worker_id uuid,kind text,batch_limit integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare now_ms bigint:=private.planning_now_ms(); cap integer; leases jsonb;
begin
  if claim_jobs.worker_id is null or claim_jobs.kind is null or claim_jobs.kind not in ('prepare','simulation','reveal','settlement')
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
  elsif not private.accept_job_result(j.id,result) then return jsonb_build_object('ok',false,'code','invalid');
  end if;
  update private.jobs set status='completed',result=complete_job.result,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return jsonb_build_object('ok',true,'jobId',j.id);
end $$;

create or replace function public.renew_job(job_id uuid,lease_token uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; now_ms bigint;
begin
  if renew_job.job_id is null or renew_job.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into j from private.jobs where id=renew_job.job_id for update;
  now_ms:=private.planning_now_ms();
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if j.status<>'leased' or j.lease_token is distinct from renew_job.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  update private.jobs set lease_until_ms=now_ms+120000 where id=j.id;
  return jsonb_build_object('ok',true,'expiresAtMs',now_ms+120000);
end $$;

create or replace function public.settle_activity(activity_id uuid,lease_token uuid) returns jsonb language sql security invoker set search_path='' as $$
  select private.settle_activity_core(activity_id,lease_token,null)
$$;

grant select on table "public"."activity_stages" to "authenticated";

grant delete on table "public"."activity_stages" to "service_role";

grant insert on table "public"."activity_stages" to "service_role";

grant select on table "public"."activity_stages" to "service_role";


  create policy "due_read"
  on "public"."activity_stages"
  as permissive
  for select
  to authenticated
using ((reveal_at_ms <= (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric)))::bigint));



  create table "private"."expedition_plans" (
    "activity_id" uuid not null,
    "plan" jsonb not null
      );


alter table "private"."expedition_plans" enable row level security;


  create table "private"."job_dependencies" (
    "job_id" uuid not null,
    "prerequisite_id" uuid not null
      );


alter table "private"."job_dependencies" enable row level security;

CREATE UNIQUE INDEX expedition_plans_pkey ON private.expedition_plans USING btree (activity_id);

CREATE UNIQUE INDEX job_dependencies_pkey ON private.job_dependencies USING btree (job_id, prerequisite_id);

CREATE INDEX job_dependencies_prerequisite_idx ON private.job_dependencies USING btree (prerequisite_id);

alter table "private"."expedition_plans" add constraint "expedition_plans_pkey" PRIMARY KEY using index "expedition_plans_pkey";

alter table "private"."job_dependencies" add constraint "job_dependencies_pkey" PRIMARY KEY using index "job_dependencies_pkey";

alter table "private"."expedition_plans" add constraint "expedition_plans_activity_id_fkey" FOREIGN KEY (activity_id) REFERENCES public.activities(id) not valid;

alter table "private"."expedition_plans" validate constraint "expedition_plans_activity_id_fkey";

alter table "private"."expedition_plans" add constraint "expedition_plans_plan_check" CHECK ((jsonb_typeof(plan) = 'object'::text)) not valid;

alter table "private"."expedition_plans" validate constraint "expedition_plans_plan_check";

alter table "private"."job_dependencies" add constraint "job_dependencies_check" CHECK ((job_id <> prerequisite_id)) not valid;

alter table "private"."job_dependencies" validate constraint "job_dependencies_check";

alter table "private"."job_dependencies" add constraint "job_dependencies_job_id_fkey" FOREIGN KEY (job_id) REFERENCES private.jobs(id) not valid;

alter table "private"."job_dependencies" validate constraint "job_dependencies_job_id_fkey";

alter table "private"."job_dependencies" add constraint "job_dependencies_prerequisite_id_fkey" FOREIGN KEY (prerequisite_id) REFERENCES private.jobs(id) not valid;

alter table "private"."job_dependencies" validate constraint "job_dependencies_prerequisite_id_fkey";

set check_function_bodies = off;

create or replace function private.dependencies_ready(job uuid) returns boolean language sql stable security invoker set search_path='' as $$
  select not exists(select 1 from private.job_dependencies d join private.jobs p on p.id=d.prerequisite_id
    where d.job_id=job and p.status<>'completed')
$$;

create or replace function private.expedition_rewards(activity uuid,prepared jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; g public.gladiators%rowtype; p jsonb; applied jsonb; items jsonb:='[]'::jsonb; e jsonb; overflow jsonb;
begin
  select * into a from public.activities where id=activity;
  select * into g from public.gladiators where id=a.gladiator_id;
  select plan into p from private.expedition_plans where activity_id=activity;
  if p is null or prepared->'rewards' is distinct from p->'rewards' then raise exception 'invalid expedition preparation'; end if;
  if prepared->'progressionBaseline' is distinct from jsonb_build_object('level',g.level,'xp',g.xp) then return null; end if;
  if not private.safe_integer(prepared->'progression'->'level',1) or not private.safe_integer(prepared->'progression'->'xp') then raise exception 'invalid progression'; end if;
  applied:=private.apply_inventory_plan(g.id,prepared->'grant');
  if applied is null then return null; end if;
  update public.gladiators set level=(prepared->'progression'->>'level')::bigint,xp=(prepared->'progression'->>'xp')::bigint where id=g.id;
  update public.wallets set money=money+(p->'rewards'->>'money')::bigint+(applied->>'overflowMoney')::bigint where gladiator_id=g.id;
  for e in select * from jsonb_array_elements(prepared->'grant'->'plan'->'retained') loop
    items:=items||jsonb_build_array(jsonb_build_object('catalogId',e->'catalogId','catalogVersion',e->'catalogVersion','tier',e->'tier','rarity',e->'rarity','quantity',e->'quantity'));
  end loop;
  for e in select * from jsonb_array_elements(prepared->'grant'->'plan'->'stacked') loop
    items:=items||jsonb_build_array(jsonb_build_object('catalogId','salvage','catalogVersion',p->'catalogVersion','tier',1,'rarity','common','quantity',e->'quantity'));
  end loop;
  select coalesce(jsonb_agg(entry||jsonb_build_object('catalogVersion',p->'catalogVersion')),'[]'::jsonb) into overflow
    from jsonb_array_elements(applied->'overflow') entry;
  return jsonb_build_object('result',case when (p->>'success')::boolean then 'victory' else 'defeat' end,'success',p->'success',
    'rewards',jsonb_build_object('money',p->'rewards'->'money','xp',p->'rewards'->'xp','renown',0,'attributePoints',0,'items',items,'overflowMoney',applied->'overflowMoney','overflow',overflow),
    'replayExpiry',case when private.planning_now_ms()<a.ends_at_ms+604800000 then jsonb_build_object('state','available','expiresAtMs',a.ends_at_ms+604800000)
      else jsonb_build_object('state','expired') end);
end $$;

create or replace function private.json_project(value jsonb,keys text[]) returns jsonb language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_object_agg(key,val),'{}'::jsonb) from jsonb_each(value) e(key,val) where key=any(keys)
$$;

create or replace function private.safe_battle_log(value jsonb) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; participants jsonb:='[]'::jsonb; events jsonb:='[]'::jsonb; p jsonb; e jsonb; k text; projected jsonb;
begin
  if jsonb_typeof(value) is distinct from 'object' or jsonb_typeof(value->'participants') is distinct from 'array'
    or jsonb_typeof(value->'events') is distinct from 'array' or jsonb_typeof(value->'finalHp') is distinct from 'array'
    then raise exception 'invalid battle log'; end if;
  if jsonb_array_length(value->'participants')<>2 or jsonb_array_length(value->'finalHp')<>2
    or not private.safe_integer(value->'durationMs') or not private.safe_integer(value->'finalHp'->0) or not private.safe_integer(value->'finalHp'->1)
    then raise exception 'invalid battle log'; end if;
  foreach k in array array['battleId','rulesVersion','winnerId','victoryReason'] loop
    if jsonb_typeof(value->k) is distinct from 'string' then raise exception 'invalid battle log'; end if;
  end loop;
  if value->>'victoryReason' not in ('defeat','health-fraction','tie-break')
    or value->'tieBreakReason' is null or value->'tieBreakReason' not in ('null'::jsonb,'"simultaneous-defeat"'::jsonb,'"equal-health-fraction"'::jsonb) then raise exception 'invalid battle log'; end if;
  for p in select * from jsonb_array_elements(value->'participants') loop
    foreach k in array array['id','name','stance'] loop
      if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'invalid battle log'; end if;
    end loop;
    if p->>'stance' not in ('balanced','offensive','defensive') or p->'classId' is null
      or p->'classId' not in ('null'::jsonb,'"berserker"'::jsonb,'"guardian"'::jsonb,'"duelist"'::jsonb)
      or p->'gladiatorId' is null or jsonb_typeof(p->'gladiatorId') not in ('null','string')
      or jsonb_typeof(p->'attributes') is distinct from 'object' or jsonb_typeof(p->'equipmentSilhouettes') is distinct from 'array'
      then raise exception 'invalid battle log'; end if;
    foreach k in array array['maxHealth','initialHealth','attackIntervalMs','efficiencyBasisPoints'] loop
      if not private.safe_integer(p->k,1) then raise exception 'invalid battle log'; end if;
    end loop;
    foreach k in array array['armor','weaponDamage'] loop
      if jsonb_typeof(p->k) is distinct from 'number' then raise exception 'invalid battle log'; end if;
    end loop;
    foreach k in array array['strength','agility','vitality','endurance','precision'] loop
      if jsonb_typeof(p->'attributes'->k) is distinct from 'number' then raise exception 'invalid battle log'; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(p->'equipmentSilhouettes') s where jsonb_typeof(s)<>'string') then raise exception 'invalid battle log'; end if;
    projected:=private.json_project(p,array['id','gladiatorId','name','classId','stance','maxHealth','initialHealth','armor','weaponDamage','attackIntervalMs','efficiencyBasisPoints','equipmentSilhouettes']);
    participants:=participants||jsonb_build_array(projected||jsonb_build_object('attributes',private.json_project(p->'attributes',array['strength','agility','vitality','endurance','precision'])));
  end loop;
  for e in select * from jsonb_array_elements(value->'events') loop
    if not private.safe_integer(e->'sequence') or not private.safe_integer(e->'elapsedMs') then raise exception 'invalid battle log'; end if;
    if e->>'kind'='attack' then
      foreach k in array array['attackerId','defenderId'] loop
        if jsonb_typeof(e->k) is distinct from 'string' then raise exception 'invalid battle log'; end if;
      end loop;
      foreach k in array array['hit','critical','defend','evade'] loop
        if jsonb_typeof(e->k) is distinct from 'boolean' then raise exception 'invalid battle log'; end if;
      end loop;
      foreach k in array array['damage','healthBefore','healthAfter'] loop
        if not private.safe_integer(e->k) then raise exception 'invalid battle log'; end if;
      end loop;
      projected:=private.json_project(e,array['kind','sequence','elapsedMs','attackerId','defenderId','hit','critical','defend','evade','damage','healthBefore','healthAfter']);
    elsif e->>'kind'='victory' then
      foreach k in array array['winnerId','loserId','reason'] loop
        if jsonb_typeof(e->k) is distinct from 'string' then raise exception 'invalid battle log'; end if;
      end loop;
      projected:=private.json_project(e,array['kind','sequence','elapsedMs','winnerId','loserId','reason']);
    else raise exception 'invalid battle log'; end if;
    events:=events||jsonb_build_array(projected);
  end loop;
  result:=private.json_project(value,array['battleId','rulesVersion','durationMs','winnerId','victoryReason','finalHp','tieBreakReason']);
  return result||jsonb_build_object('participants',participants,'events',events);
end $$;

create or replace function private.safe_integer(value jsonb, minimum numeric default 0) returns boolean language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(value) is distinct from 'number' then return false; end if;
  return value::text::numeric between minimum and 9007199254740991 and trunc(value::text::numeric)=value::text::numeric;
end $$;

create or replace function private.safe_settlement(value jsonb) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare r jsonb:=value->'rewards'; e jsonb; items jsonb:='[]'::jsonb; expiry jsonb; k text; result jsonb;
  overflow jsonb:='[]'::jsonb; total numeric:=0;
begin
  if jsonb_typeof(value) is distinct from 'object' or jsonb_typeof(r) is distinct from 'object'
    or coalesce(value->>'result','') not in ('completed','victory','defeat') or jsonb_typeof(value->'success') is distinct from 'boolean'
    or jsonb_typeof(r->'items') is distinct from 'array' then raise exception 'invalid settlement outcome'; end if;
  foreach k in array array['money','renown','xp','attributePoints','overflowMoney'] loop
    if not private.safe_integer(r->k) then raise exception 'invalid settlement outcome'; end if;
  end loop;
  for e in select * from jsonb_array_elements(r->'items') loop
    if jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'catalogId') is distinct from 'string'
      or jsonb_typeof(e->'catalogVersion') is distinct from 'string' or e->>'catalogId'='' or e->>'catalogVersion'=''
      or e->'tier' not in ('1'::jsonb,'5'::jsonb,'10'::jsonb) or e->'tier' is null
      or coalesce(e->>'rarity','') not in ('common','uncommon','rare') or not private.safe_integer(e->'quantity',1) then raise exception 'invalid settlement outcome'; end if;
    items:=items||jsonb_build_array(jsonb_build_object('catalogId',e->'catalogId','catalogVersion',e->'catalogVersion','tier',e->'tier','rarity',e->'rarity','quantity',e->'quantity'));
  end loop;
  if jsonb_typeof(value->'replayExpiry') is distinct from 'object' then raise exception 'invalid settlement outcome'; end if;
  if value->'replayExpiry'->>'state'='available' then
    if not private.safe_integer(value->'replayExpiry'->'expiresAtMs') then raise exception 'invalid settlement outcome'; end if;
    expiry:=jsonb_build_object('state','available','expiresAtMs',value->'replayExpiry'->'expiresAtMs');
  elsif value->'replayExpiry'->>'state'='expired' then expiry:=jsonb_build_object('state','expired');
  else raise exception 'invalid settlement outcome'; end if;
  result:=jsonb_build_object('result',value->'result','success',value->'success','replayExpiry',expiry,
    'rewards',jsonb_build_object('money',r->'money','renown',r->'renown','xp',r->'xp','attributePoints',r->'attributePoints','overflowMoney',r->'overflowMoney','items',items));
  if r ? 'overflow' then
    if jsonb_typeof(r->'overflow') is distinct from 'array' then raise exception 'invalid settlement outcome'; end if;
    for e in select * from jsonb_array_elements(r->'overflow') loop
      if jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'catalogId') is distinct from 'string'
        or jsonb_typeof(e->'catalogVersion') is distinct from 'string' or e->>'catalogId'='' or e->>'catalogVersion'=''
        or not private.safe_integer(e->'quantity',1) or not private.safe_integer(e->'unitValue') or not private.safe_integer(e->'money')
        then raise exception 'invalid settlement outcome'; end if;
      if (e->>'quantity')::numeric*(e->>'unitValue')::numeric<>(e->>'money')::numeric then raise exception 'invalid settlement outcome'; end if;
      total:=total+(e->>'money')::numeric;
      overflow:=overflow||jsonb_build_array(jsonb_build_object('catalogId',e->'catalogId','catalogVersion',e->'catalogVersion',
        'quantity',e->'quantity','unitValue',e->'unitValue','money',e->'money'));
    end loop;
    if total<>(r->>'overflowMoney')::numeric then raise exception 'invalid settlement outcome'; end if;
    result:=jsonb_set(result,'{rewards,overflow}',overflow);
  end if;
  if value ? 'ratingDelta' then
    if not private.safe_integer(value->'ratingDelta',-9007199254740991) then raise exception 'invalid settlement outcome'; end if;
    result:=result||jsonb_build_object('ratingDelta',value->'ratingDelta');
  end if;
  return result;
end $$;

create or replace function private.settle_activity_core(activity_id uuid,lease_token uuid,prepared jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; j private.jobs%rowtype; owner uuid; now_ms bigint; receipt uuid:=gen_random_uuid();
  settlement jsonb; operation uuid:=gen_random_uuid(); result_summary jsonb; outcome jsonb; inserted integer;
begin
  if settle_activity_core.activity_id is null or settle_activity_core.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select g.owner_id into owner from public.activities x join public.gladiators g on g.id=x.gladiator_id where x.id=settle_activity_core.activity_id;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  perform 1 from public.gladiators g join public.activities x on x.gladiator_id=g.id where x.id=settle_activity_core.activity_id for update of g;
  perform 1 from public.wallets w join public.activities x on x.gladiator_id=w.gladiator_id where x.id=settle_activity_core.activity_id for update of w;
  perform 1 from public.item_instances i join public.activities x on x.gladiator_id=i.gladiator_id where x.id=settle_activity_core.activity_id order by i.id for update of i;
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
    if a.resolved_kind='expedition' then
      insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
        values(owner,operation,receipt,a.gladiator_id,jsonb_build_object('kind','activity-settlement','activityId',a.id),
          extensions.digest(a.id::text,'sha256'),result_summary);
      insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason)
        values(a.gladiator_id,receipt,(settlement->'rewards'->>'money')::bigint+(settlement->'rewards'->>'overflowMoney')::bigint,0,'expedition');
    end if;
    update public.activities set status='completed',receipt_id=receipt,summary=result_summary,settled_at_ms=now_ms where id=a.id;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',1,'summary',result_summary);
  end if;
  update private.jobs set status='completed',result=outcome,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return outcome;
end $$;

create or replace function private.accept_job_result(job uuid,result jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; a public.activities%rowtype; p jsonb; stage jsonb; ordinal integer:=0;
  child uuid; previous uuid; terminal uuid; offset_ms bigint;
begin
  select * into j from private.jobs where id=job;
  select * into a from public.activities where id=j.activity_id;
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

create or replace function private.activity_executor_ready(kind text) returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(kind in ('training','rest','expedition'),false)
$$;

create or replace function private.dispatch_workers() returns jsonb language plpgsql security invoker set search_path='' as $$
declare url text; secret text; now_ms bigint; simple integer; combat integer; recent integer; budget integer; wanted integer;
  request bigint; requests jsonb:='[]'::jsonb::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('cloudiator:dispatch',3));
  now_ms:=private.planning_now_ms();
  select decrypted_secret into url from vault.decrypted_secrets where name='game_worker_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='game_worker_secret';
  if url is null or secret is null then return jsonb_build_object('ok',true,'dispatched',0,'reason','unconfigured'); end if;
  select count(*) filter (where kind<>'simulation'),count(*) filter (where kind='simulation') into simple,combat from private.jobs
    where private.dependencies_ready(id) and due_at_ms<=now_ms and (status='pending' or (status='leased' and lease_until_ms<=now_ms and attempts<max_attempts));
  select count(*) into recent from private.dispatch_log where dispatched_at_ms>now_ms-60000;
  select max_dispatch_per_minute into budget from private.scheduler where singleton;
  wanted:=greatest(0,least(coalesce(budget,5)-recent,ceil(simple/20.0)::integer+ceil(combat/5.0)::integer));
  for i in 1..wanted loop
    -- Positional (url, body, params, headers, timeout) avoids PL/pgSQL name capture in named arguments.
    request:=net.http_post(url,'{}'::jsonb,'{}'::jsonb,
      jsonb_build_object('Authorization','Bearer '||secret,'Content-Type','application/json'),30000);
    insert into private.dispatch_log(dispatched_at_ms,request_id,claimable_simple,claimable_combat) values(now_ms,request,simple,combat);
    requests:=requests||to_jsonb(request);
  end loop;
  return jsonb_build_object('ok',true,'dispatched',wanted,'requestIds',requests,'claimableSimple',simple,'claimableCombat',combat);
end $$;

create or replace function private.prepare_activity_jobs(activity uuid) returns void language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype; simulation uuid; terminal uuid;
begin
  select * into a from public.activities where id=activity;
  select * into s from private.activity_snapshots where activity_id=activity;
  if a.resolved_kind not in ('training','rest','expedition') then raise exception 'unsupported activity executor'; end if;
  insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
    values('settlement','settlement:'||a.id,a.slot_index,a.gladiator_id,a.id,
      jsonb_build_object('activityId',a.id,'gladiatorId',a.gladiator_id,'slotIndex',a.slot_index,'resolvedKind',a.resolved_kind,'endsAtMs',a.ends_at_ms),
      s.seed,s.rules_version,a.ends_at_ms) on conflict(dedupe_key) do nothing;
  if a.resolved_kind='expedition' then
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('simulation','expedition:'||a.id,a.slot_index,a.gladiator_id,a.id,s.snapshot,s.seed,s.rules_version,a.starts_at_ms)
      on conflict(dedupe_key) do nothing;
    select id into simulation from private.jobs where dedupe_key='expedition:'||a.id;
    select id into terminal from private.jobs where dedupe_key='settlement:'||a.id;
    insert into private.job_dependencies values(terminal,simulation) on conflict do nothing;
  end if;
end $$;

grant delete on table "private"."expedition_plans" to "service_role";

grant insert on table "private"."expedition_plans" to "service_role";

grant select on table "private"."expedition_plans" to "service_role";

grant delete on table "private"."job_dependencies" to "service_role";

grant insert on table "private"."job_dependencies" to "service_role";

grant select on table "private"."job_dependencies" to "service_role";


  create policy "backend_only"
  on "private"."expedition_plans"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."job_dependencies"
  as permissive
  for all
  to service_role
using (true)
with check (true);


CREATE TRIGGER guard_frozen BEFORE UPDATE ON private.expedition_plans FOR EACH ROW EXECUTE FUNCTION private.guard_frozen();

CREATE TRIGGER guard_frozen BEFORE UPDATE ON private.job_dependencies FOR EACH ROW EXECUTE FUNCTION private.guard_frozen();



-- Complete the generated draft from the tested source: explicit table/function ACLs.
revoke all on public.activity_stages from public,anon,authenticated,service_role;
grant select on public.activity_stages to authenticated;
grant select,insert,delete on public.activity_stages to service_role;
revoke all on function private.activity_executor_ready(text),private.prepare_activity_jobs(uuid),private.dependencies_ready(uuid),private.safe_integer(jsonb,numeric),private.safe_settlement(jsonb),private.accept_job_result(uuid,jsonb),public.commit_expedition_plan(uuid,uuid,jsonb),public.expedition_settlement_input(uuid,uuid),private.expedition_rewards(uuid,jsonb),public.claim_jobs(uuid,text,integer),public.complete_job(uuid,uuid,jsonb),private.settle_activity_core(uuid,uuid,jsonb),public.settle_activity(uuid,uuid),public.settle_expedition(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.activity_executor_ready(text),private.prepare_activity_jobs(uuid),private.dependencies_ready(uuid),private.safe_integer(jsonb,numeric),private.safe_settlement(jsonb),private.accept_job_result(uuid,jsonb),public.commit_expedition_plan(uuid,uuid,jsonb),public.expedition_settlement_input(uuid,uuid),private.expedition_rewards(uuid,jsonb),public.claim_jobs(uuid,text,integer),public.complete_job(uuid,uuid,jsonb),private.settle_activity_core(uuid,uuid,jsonb),public.settle_activity(uuid,uuid),public.settle_expedition(uuid,uuid,jsonb) to service_role;
revoke all on function private.json_project(jsonb,text[]),private.safe_battle_log(jsonb) from public,anon,authenticated;
grant execute on function private.json_project(jsonb,text[]),private.safe_battle_log(jsonb) to service_role;
revoke all on private.expedition_plans,private.job_dependencies from public,anon,authenticated,service_role;
grant select,insert,delete on private.expedition_plans,private.job_dependencies to service_role;
notify pgrst,'reload schema';
