
  create table "public"."owned_cosmetics" (
    "gladiator_id" uuid not null,
    "catalog_id" text not null,
    "catalog_version" text not null,
    "binding" text not null default 'bound'::text
      );


alter table "public"."owned_cosmetics" enable row level security;

CREATE UNIQUE INDEX owned_cosmetics_pkey ON public.owned_cosmetics USING btree (gladiator_id, catalog_id);

alter table "public"."owned_cosmetics" add constraint "owned_cosmetics_pkey" PRIMARY KEY using index "owned_cosmetics_pkey";

alter table "public"."owned_cosmetics" add constraint "owned_cosmetics_binding_check" CHECK ((binding = 'bound'::text)) not valid;

alter table "public"."owned_cosmetics" validate constraint "owned_cosmetics_binding_check";

alter table "public"."owned_cosmetics" add constraint "owned_cosmetics_catalog_id_check" CHECK ((catalog_id = 'banner'::text)) not valid;

alter table "public"."owned_cosmetics" validate constraint "owned_cosmetics_catalog_id_check";

alter table "public"."owned_cosmetics" add constraint "owned_cosmetics_catalog_version_check" CHECK ((catalog_version = 'v1'::text)) not valid;

alter table "public"."owned_cosmetics" validate constraint "owned_cosmetics_catalog_version_check";

alter table "public"."owned_cosmetics" add constraint "owned_cosmetics_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) not valid;

alter table "public"."owned_cosmetics" validate constraint "owned_cosmetics_gladiator_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.buy_shop(actor_id uuid, operation_id uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.inventory_command(actor_id,operation_id,input,'buy-shop')
$function$
;

CREATE OR REPLACE FUNCTION public.discard_item(actor_id uuid, operation_id uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.inventory_command(actor_id,operation_id,input,'discard-item')
$function$
;

CREATE OR REPLACE FUNCTION public.sell_item(actor_id uuid, operation_id uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.inventory_command(actor_id,operation_id,input,'sell-item')
$function$
;

CREATE OR REPLACE FUNCTION public.advance_boundary(target_slot bigint, coordinator_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c private.coordinator%rowtype; b private.boundaries%rowtype; now_ms bigint; wait text;
begin
  if target_slot is null or coordinator_token is null or target_slot<1 then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into c from private.coordinator where singleton for update;
  now_ms:=private.planning_now_ms();
  if c.lease_token is distinct from coordinator_token or c.lease_until_ms<=now_ms then return jsonb_build_object('ok',false,'code','conflict'); end if;
  -- Never ahead of database time, never out of chronological order.
  if target_slot>now_ms/4800000 then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if c.published_slot is not null and target_slot<=c.published_slot then
    return jsonb_build_object('ok',true,'slotIndex',target_slot,'phase',9,'status','complete','replayed',true);
  end if;
  if c.published_slot is not null and target_slot<>c.published_slot+1 then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if c.published_slot is null then update private.coordinator set published_slot=target_slot-1,updated_at_ms=now_ms where singleton; end if;
  -- A job whose final lease expired without a further claim must reach operator state before the barriers look.
  perform private.sweep_exhausted_leases(now_ms);
  insert into private.boundaries(slot_index,cutoff_ms,rules_version,opened_at_ms,updated_at_ms)
    values(target_slot,target_slot*4800000,private.active_rules_version(),now_ms,now_ms) on conflict do nothing;
  select * into b from private.boundaries where slot_index=target_slot for update;
  while b.phase<9 loop
    if exists(select 1 from private.boundary_work w where w.slot_index=target_slot and w.phase=b.phase and w.status='pending') then wait:='extension';
    elsif b.phase=1 then wait:=private.boundary_settle_previous(target_slot);
    elsif b.phase=2 then wait:=private.boundary_close_season(target_slot);
    elsif b.phase=3 then wait:=private.boundary_apply_changes(target_slot);
    elsif b.phase=4 then wait:=private.boundary_recompute(target_slot);
    elsif b.phase=5 then wait:=private.boundary_snapshot(target_slot);
    elsif b.phase=6 then wait:=private.boundary_check_stamina(target_slot);
    elsif b.phase=7 then wait:=private.boundary_pair(target_slot);
    else wait:=private.boundary_start(target_slot);
    end if;
    if wait is not null then
      update private.boundaries set status='waiting',wait_reason=wait,last_error=null,updated_at_ms=now_ms where slot_index=target_slot;
      return jsonb_build_object('ok',true,'slotIndex',target_slot,'phase',b.phase,'status','waiting','wait',wait);
    end if;
    b.phase:=b.phase+1;
    update private.boundaries set phase=b.phase,status=case when b.phase=9 then 'complete' else 'running' end,wait_reason=null,last_error=null,
      updated_at_ms=now_ms,completed_at_ms=case when b.phase=9 then now_ms end where slot_index=target_slot;
  end loop;
  update private.coordinator set published_slot=target_slot,updated_at_ms=now_ms where singleton;
  return jsonb_build_object('ok',true,'slotIndex',target_slot,'phase',9,'status','complete');
end $function$
;

CREATE OR REPLACE FUNCTION public.cancel_build(actor_id uuid, operation_id uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.planning_command(actor_id,operation_id,input,'cancel-build')
$function$
;

CREATE OR REPLACE FUNCTION public.claim_jobs(worker_id uuid, kind text, batch_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.complete_job(job_id uuid, lease_token uuid, result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare j private.jobs%rowtype; now_ms bigint:=private.planning_now_ms();
begin
  if complete_job.job_id is null or complete_job.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into j from private.jobs where id=complete_job.job_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if j.status='completed' and j.lease_token=complete_job.lease_token then
    return jsonb_build_object('ok',true,'jobId',j.id,'replayed',true);
  end if;
  if j.status<>'leased' or j.lease_token is distinct from complete_job.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if j.kind='settlement' then return jsonb_build_object('ok',false,'code','invalid');
  elsif j.kind='prepare' then
    if not private.valid_preparation(j.id,result) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  elsif not private.accept_job_result(j.id,result) then return jsonb_build_object('ok',false,'code','invalid');
  end if;
  update private.jobs set status='completed',result=complete_job.result,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return jsonb_build_object('ok',true,'jobId',j.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.consume_command_rate(actor_id uuid, is_creation boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare now_at timestamptz; oldest timestamptz; attempts integer; maximum integer;
begin
  if actor_id is null or is_creation is null then raise exception 'invalid actor'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,1));
  now_at := clock_timestamp();
  delete from private.command_attempts a where a.actor_id=consume_command_rate.actor_id and a.attempted_at <= now_at-interval '1 minute';
  select count(*), min(attempted_at) into attempts, oldest from private.command_attempts a
    where a.actor_id=consume_command_rate.actor_id and a.is_creation=consume_command_rate.is_creation;
  maximum := case when is_creation then 5 else 60 end;
  if attempts >= maximum then return greatest(1,ceil(extract(epoch from (oldest+interval '1 minute'-now_at))*1000)::integer); end if;
  insert into private.command_attempts(actor_id,is_creation,attempted_at) values(actor_id,is_creation,now_at);
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.coordinate_work()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c private.coordinator%rowtype; now_ms bigint; current_slot bigint; token uuid:=gen_random_uuid(); result jsonb;
  reports jsonb:='[]'::jsonb; steps integer:=0; next_slot bigint; failure text;
begin
  now_ms:=private.planning_now_ms(); current_slot:=now_ms/4800000;
  -- Independent of the coordinator lease: exhausted leases reach operator state even while another coordinator runs.
  perform private.sweep_exhausted_leases(now_ms);
  select * into c from private.coordinator where singleton for update skip locked;
  if not found then return jsonb_build_object('ok',true,'busy',true,'publishedSlot',null); end if;
  if c.lease_token is not null and c.lease_until_ms>now_ms then return jsonb_build_object('ok',true,'busy',true,'publishedSlot',c.published_slot); end if;
  update private.coordinator set lease_token=token,lease_until_ms=now_ms+120000,updated_at_ms=now_ms where singleton;
  if c.published_slot is null then
    -- First run starts at the earliest existing checkpoint, so no saved character skips its offline slots.
    update private.coordinator set published_slot=least(current_slot,coalesce((select min(processed_slot_index) from public.gladiators),current_slot)) where singleton;
  end if;
  loop
    select * into c from private.coordinator where singleton;
    exit when c.published_slot>=current_slot or steps>=6;
    next_slot:=c.published_slot+1;
    -- Skip provably empty boundaries: nobody is due, nothing is unsettled, no partial boundary or registered work is pending.
    if not exists(select 1 from public.gladiators g where g.processed_slot_index<=c.published_slot)
      and not exists(select 1 from private.boundaries x where x.slot_index>c.published_slot and x.status<>'complete') then
      next_slot:=least(current_slot,
        coalesce((select min(g.processed_slot_index)+1 from public.gladiators g),current_slot),
        coalesce((select min(w.slot_index) from private.boundary_work w where w.status='pending' and w.slot_index>c.published_slot),current_slot));
      if next_slot>c.published_slot+1 then update private.coordinator set published_slot=next_slot-1 where singleton; end if;
    end if;
    begin
      result:=public.advance_boundary(next_slot,token);
    exception when others then
      -- The subtransaction rolled back every effect of this boundary. Keep only the SQLSTATE: raw messages can carry
      -- provider details or data. The persisted wait becomes truthful ('error') instead of a stale earlier reason.
      failure:=sqlstate;
      result:=jsonb_build_object('ok',false,'code','boundary-failed','slotIndex',next_slot,'sqlstate',failure);
      update private.boundaries set status='waiting',wait_reason='error',last_error=failure,updated_at_ms=now_ms where slot_index=next_slot;
      update private.coordinator set last_error=failure,last_failed_slot=next_slot,updated_at_ms=now_ms where singleton;
    end;
    reports:=reports||jsonb_build_array(result);
    steps:=steps+1;
    exit when result->>'status' is distinct from 'complete';
  end loop;
  update private.coordinator set lease_token=null,lease_until_ms=0,updated_at_ms=now_ms,
    last_error=case when failure is null then null else last_error end,
    last_failed_slot=case when failure is null then null else last_failed_slot end where singleton;
  return jsonb_build_object('ok',true,'publishedSlot',(select published_slot from private.coordinator where singleton),
    'currentSlot',current_slot,'boundaries',reports);
end $function$
;

CREATE OR REPLACE FUNCTION public.create_gladiator(actor_id uuid, operation_id uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare command jsonb := input->'command'; allocation jsonb; total numeric; value jsonb; stat jsonb;
  existing public.operation_receipts%rowtype; result jsonb; gid uuid := gen_random_uuid(); receipt uuid := gen_random_uuid();
  weapon_id uuid := gen_random_uuid(); body_id uuid := gen_random_uuid(); now_ms bigint; slot bigint; item jsonb; item_id uuid; n integer := 0;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(input) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (select count(*) from jsonb_object_keys(input)) <> 4 or not (input ?& array['command','starterItems','staminaMaximum','peakStrength'])
    or jsonb_typeof(command) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  -- One account lock covers all its operation IDs. Name's unique index also serializes different accounts.
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into existing from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=create_gladiator.operation_id;
  if found then
    if existing.request <> command then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return existing.result;
  end if;
  if (select count(*) from jsonb_object_keys(command)) <> 5
    or not (command ?& array['kind','operationId','name','classId','allocation'])
    or command->>'kind' is distinct from 'create-character' or command->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(command->'name') is distinct from 'string' or command->>'name' <> btrim(command->>'name')
    or not (command->>'name' ~ '^[A-Za-z0-9 _-]{3,20}$')
    or jsonb_typeof(command->'classId') is distinct from 'string' or command->>'classId' not in ('berserker','guardian','duelist') then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  allocation := command->'allocation';
  if jsonb_typeof(allocation) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (select count(*) from jsonb_object_keys(allocation)) <> 5
    or not (allocation ?& array['strength','agility','vitality','endurance','precision']) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  total := 0;
  for value in select v from jsonb_each(allocation) e(k,v) loop
    if jsonb_typeof(value) <> 'number' or value::text::numeric < 0 or value::text::numeric > 10 or trunc(value::text::numeric) <> value::text::numeric then
      return jsonb_build_object('ok',false,'code','invalid');
    end if;
    total := total + value::text::numeric;
  end loop;
  if total <> 10 or jsonb_typeof(input->'staminaMaximum') is distinct from 'number'
    or jsonb_typeof(input->'starterItems') is distinct from 'array' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (input->>'staminaMaximum')::numeric not between 90 and 122
    or trunc((input->>'staminaMaximum')::numeric) <> (input->>'staminaMaximum')::numeric
    or jsonb_array_length(input->'starterItems') <> 2 then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  -- Catalog rolls come only from the backend's canonical v1 domain catalog, never from the player's command.
  for item in select * from jsonb_array_elements(input->'starterItems') loop
    if jsonb_typeof(item) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select count(*) from jsonb_object_keys(item)) <> 6 or not (item ?& array['catalogId','catalogVersion','tier','rarity','stats','binding'])
      or item->>'catalogId' is distinct from (case when n=0 then 'sword:1:common' else 'light-armor:1:common' end)
      or item->>'catalogVersion' is distinct from 'v1' or item->'tier' is distinct from '1'::jsonb
      or item->>'rarity' is distinct from 'common' or item->>'binding' is distinct from 'tradable'
      or jsonb_typeof(item->'stats') is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    stat := item->'stats';
    if (select count(*) from jsonb_object_keys(stat)) <> 5 or not (stat ?& array['damage','armor','weight','intervalMs','attributes'])
      or jsonb_typeof(stat->'attributes') is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select count(*) from jsonb_object_keys(stat->'attributes')) <> 5
      or not ((stat->'attributes') ?& array['strength','agility','vitality','endurance','precision']) then return jsonb_build_object('ok',false,'code','invalid'); end if;
    for value in select v from jsonb_each(stat-'attributes') e(k,v) union all select v from jsonb_each(stat->'attributes') e(k,v) loop
      if jsonb_typeof(value) is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
      if value::text::numeric not between 0 and 1000000000 or trunc(value::text::numeric*100) <> value::text::numeric*100 then
        return jsonb_build_object('ok',false,'code','invalid'); end if;
    end loop;
    if trunc((stat->>'intervalMs')::numeric) <> (stat->>'intervalMs')::numeric then return jsonb_build_object('ok',false,'code','invalid'); end if;
    n := n+1;
  end loop;
  if input->'peakStrength' is distinct from '28'::jsonb then return jsonb_build_object('ok',false,'code','invalid'); end if;
  now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  slot := now_ms / 4800000;
  begin
    insert into public.gladiators(id,owner_id,name,stamina_current,stamina_maximum,processed_slot_index,created_at_ms,orientation_end_ms,peak_strength)
      values(gid,actor_id,command->>'name',(input->>'staminaMaximum')::bigint,(input->>'staminaMaximum')::bigint,slot,now_ms,(slot+1)*4800000,(input->>'peakStrength')::numeric);
    insert into public.builds(gladiator_id,current_build) values(gid,jsonb_build_object('version',1,'classId',command->>'classId','stance','balanced','allocations',allocation,
      'equipment',jsonb_build_object('weapon',weapon_id,'body',body_id,'offHand',null,'head',null,'feet',null)));
    insert into public.schedules(gladiator_id,schedule) values(gid,'{"morning":{"kind":"training"},"afternoon":{"kind":"expedition","expeditionId":"woodland"},"evening":{"kind":"rest"}}');
    insert into public.wallets(gladiator_id) values(gid);
    n := 0;
    for item in select * from jsonb_array_elements(input->'starterItems') loop
      item_id := case when n=0 then weapon_id else body_id end;
      insert into public.item_instances(id,gladiator_id,item) values(item_id,gid,item || jsonb_build_object('id',item_id,'ownerId',gid,'quantity',1,'origin','starter',
        'reservation',jsonb_build_object('kind','equipment','referenceId',gid)));
      n := n+1;
    end loop;
    result := jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('gladiatorId',gid));
  exception when unique_violation then
    gid := null;
    result := jsonb_build_object('ok',false,'code','conflict');
  end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,gid,command,sha256(convert_to(command::text,'UTF8')),result);
  if gid is not null then insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason) values(gid,receipt,100,0,'creation'); end if;
  return result;
end $function$
;

CREATE OR REPLACE FUNCTION public.edit_schedule(actor_id uuid, operation_id uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.planning_command(actor_id,operation_id,input,'edit-schedule')
$function$
;

CREATE OR REPLACE FUNCTION public.fail_job(job_id uuid, lease_token uuid, failure_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare j private.jobs%rowtype; now_ms bigint:=private.planning_now_ms(); code text; next_status text;
begin
  if fail_job.job_id is null or fail_job.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  -- Only a short sanitized code is retained; raw exception text can contain provider details.
  code:=case when failure_code ~ '^[a-z0-9][a-z0-9-]{0,63}$' then failure_code else 'execution-failed' end;
  select * into j from private.jobs where id=fail_job.job_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if j.status<>'leased' or j.lease_token is distinct from fail_job.lease_token then return jsonb_build_object('ok',false,'code','conflict'); end if;
  next_status:=case when j.attempts>=j.max_attempts then 'operator' else 'pending' end;
  update private.jobs set status=next_status,lease_token=null,lease_owner=null,lease_until_ms=null,last_failure=code where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='failed',failure_code=code where job_attempts.job_id=j.id and attempt=j.attempts;
  return jsonb_build_object('ok',true,'status',next_status,'attempts',j.attempts);
end $function$
;

create or replace view "public"."owner_state" as  SELECT g.owner_id,
    jsonb_build_object('gladiatorId', g.id, 'name', g.name, 'currentBuild', b.current_build, 'pendingBuild', b.pending_build, 'buildVersion', b.version, 'schedule', s.schedule, 'scheduleVersion', s.version, 'wallets', jsonb_build_object('money', w.money, 'renown', w.renown), 'reservedFees', jsonb_build_object('money', COALESCE(( SELECT sum(r.money) AS sum
           FROM public.reservations r
          WHERE ((r.gladiator_id = g.id) AND (r.status = 'held'::text))), (0)::numeric), 'renown', COALESCE(( SELECT sum(r.renown) AS sum
           FROM public.reservations r
          WHERE ((r.gladiator_id = g.id) AND (r.status = 'held'::text))), (0)::numeric)), 'inventory', COALESCE(( SELECT jsonb_agg(i.item ORDER BY i.id) AS jsonb_agg
           FROM public.item_instances i
          WHERE (i.gladiator_id = g.id)), '[]'::jsonb), 'inventoryCapacity', 60, 'ownedCosmetics', COALESCE(( SELECT jsonb_agg(jsonb_build_object('catalogId', c.catalog_id, 'catalogVersion', c.catalog_version, 'binding', c.binding) ORDER BY c.catalog_id) AS jsonb_agg
           FROM public.owned_cosmetics c
          WHERE (c.gladiator_id = g.id)), '[]'::jsonb), 'progression', jsonb_build_object('level', g.level, 'xp', g.xp, 'earnedAttributePoints', g.earned_points, 'unspentAttributePoints', g.unspent_points, 'league', g.league, 'peakStrength', g.peak_strength, 'rating', g.rating), 'stamina', jsonb_build_object('current', g.stamina_current, 'maximum', g.stamina_maximum), 'tournamentOptIn', g.tournament_opt_in, 'processedSlotIndex', g.processed_slot_index, 'currentActivity', COALESCE(( SELECT jsonb_build_object('id', a.id, 'kind', COALESCE(a.resolved_kind, (a.requested ->> 'kind'::text)), 'status',
                CASE
                    WHEN (a.status = 'completed'::text) THEN 'completed'::text
                    WHEN (a.status = 'preparing'::text) THEN 'queued'::text
                    WHEN ((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric) < (a.ends_at_ms)::numeric) THEN 'active'::text
                    ELSE 'processing'::text
                END, 'startsAtMs', a.starts_at_ms, 'endsAtMs', a.ends_at_ms, 'label',
                CASE COALESCE(a.resolved_kind, (a.requested ->> 'kind'::text))
                    WHEN 'training'::text THEN 'Training'::text
                    WHEN 'rest'::text THEN
                    CASE
                        WHEN a.fallback THEN 'Resting (not enough stamina)'::text
                        ELSE 'Resting'::text
                    END
                    WHEN 'expedition'::text THEN 'Expedition'::text
                    WHEN 'arena'::text THEN 'Arena'::text
                    ELSE 'Tournament'::text
                END) AS jsonb_build_object
           FROM public.activities a
          WHERE (a.gladiator_id = g.id)
          ORDER BY a.slot_index DESC
         LIMIT 1), jsonb_build_object('id', g.id, 'kind', 'orientation', 'status',
        CASE
            WHEN ((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric) < (g.orientation_end_ms)::numeric) THEN 'active'::text
            ELSE 'processing'::text
        END, 'startsAtMs', g.created_at_ms, 'endsAtMs', g.orientation_end_ms, 'label', 'Orientation'))) AS state
   FROM (((public.gladiators g
     JOIN public.builds b ON ((b.gladiator_id = g.id)))
     JOIN public.schedules s ON ((s.gladiator_id = g.id)))
     JOIN public.wallets w ON ((w.gladiator_id = g.id)));


CREATE OR REPLACE FUNCTION public.queue_build(actor_id uuid, operation_id uuid, input jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.planning_command(actor_id,operation_id,input,'queue-build')
$function$
;

CREATE OR REPLACE FUNCTION public.renew_job(job_id uuid, lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare j private.jobs%rowtype; now_ms bigint:=private.planning_now_ms();
begin
  if renew_job.job_id is null or renew_job.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into j from private.jobs where id=renew_job.job_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if j.status<>'leased' or j.lease_token is distinct from renew_job.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  update private.jobs set lease_until_ms=now_ms+120000 where id=j.id;
  return jsonb_build_object('ok',true,'expiresAtMs',now_ms+120000);
end $function$
;

CREATE OR REPLACE FUNCTION public.settle_activity(activity_id uuid, lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare a public.activities%rowtype; j private.jobs%rowtype; owner uuid; now_ms bigint; receipt uuid:=gen_random_uuid();
  settlement jsonb; result_summary jsonb; outcome jsonb; inserted integer;
begin
  if settle_activity.activity_id is null or settle_activity.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select g.owner_id into owner from public.activities x join public.gladiators g on g.id=x.gladiator_id where x.id=settle_activity.activity_id;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  perform 1 from public.gladiators g join public.activities x on x.gladiator_id=g.id where x.id=settle_activity.activity_id for update of g;
  select * into a from public.activities where id=settle_activity.activity_id for update;
  select * into j from private.jobs where dedupe_key='settlement:'||a.id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms();
  if j.status='completed' then
    -- A lost response retries with the same token and receives the committed receipt, never a second grant.
    if j.lease_token=settle_activity.lease_token then return j.result||jsonb_build_object('newGrants',0,'replayed',true); end if;
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if j.status<>'leased' or j.lease_token is distinct from settle_activity.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if a.status<>'active' or now_ms<a.ends_at_ms then return jsonb_build_object('ok',false,'code','processing'); end if;
  insert into private.settled_slots(gladiator_id,slot_index,activity_id,receipt_id,resolved_kind,settled_at_ms)
    values(a.gladiator_id,a.slot_index,a.id,receipt,a.resolved_kind,now_ms) on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then
    -- The permanent checkpoint already exists: finish the job with that receipt and grant nothing.
    select s.receipt_id into receipt from private.settled_slots s where s.gladiator_id=a.gladiator_id and s.slot_index=a.slot_index;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',0,'replayed',true);
  else
    settlement:=private.settle_rewards(a.id);
    -- Fail closed on a malformed hook outcome: the job fails, retries and reaches operator state rather than storing a false summary.
    if jsonb_typeof(settlement) is distinct from 'object' or jsonb_typeof(settlement->'rewards') is distinct from 'object'
      or coalesce(settlement->>'result','') not in ('completed','victory','defeat') or jsonb_typeof(settlement->'success') is distinct from 'boolean'
      or jsonb_typeof(settlement->'replayExpiry') is distinct from 'object' then
      raise exception 'invalid settlement outcome';
    end if;
    -- The canonical ActivitySummary: the hook's outcome plus the identity fields only settlement itself knows.
    result_summary:=settlement||jsonb_build_object('activityId',a.id,'resolvedKind',a.resolved_kind,'receiptId',receipt,'settledAtMs',now_ms);
    update public.activities set status='completed',receipt_id=receipt,summary=result_summary,settled_at_ms=now_ms where id=a.id;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',1,'summary',result_summary);
  end if;
  update private.jobs set status='completed',result=outcome,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return outcome;
end $function$
;

grant select on table "public"."owned_cosmetics" to "authenticated";

grant insert on table "public"."owned_cosmetics" to "service_role";

grant select on table "public"."owned_cosmetics" to "service_role";


  create policy "owner_read"
  on "public"."owned_cosmetics"
  as permissive
  for select
  to authenticated
using ((gladiator_id IN ( SELECT gladiators.id
   FROM public.gladiators
  WHERE (gladiators.owner_id = ( SELECT auth.uid() AS uid)))));





set check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.apply_inventory_plan(gid uuid, prepared jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare g public.gladiators%rowtype; baseline jsonb; plan jsonb:=prepared->'plan'; entry jsonb; row_item jsonb;
  item_id uuid; ids jsonb:='[]'::jsonb; peak numeric; total integer;
begin
  select owner_id into g.owner_id from public.gladiators where id=gid;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(g.owner_id::text,0));
  select * into g from public.gladiators where id=gid for update;
  perform 1 from public.wallets where gladiator_id=gid for update;
  perform 1 from public.item_instances where gladiator_id=gid order by id for update;
  select jsonb_build_object('items',coalesce(jsonb_object_agg(id::text,item->'quantity'),'{}'),'peakStrength',g.peak_strength)
    into baseline from public.item_instances where gladiator_id=gid;
  if prepared->'baseline' is distinct from baseline then return null; end if;
  if jsonb_typeof(plan) is distinct from 'object' or jsonb_typeof(plan->'retained') is distinct from 'array'
    or jsonb_typeof(plan->'stacked') is distinct from 'array' or plan->'rejected' is distinct from '[]'::jsonb
    or jsonb_typeof(prepared->'peakStrength') is distinct from 'number'
    or jsonb_typeof(plan->'overflowMoney') is distinct from 'number' then raise exception 'invalid inventory plan'; end if;
  peak:=(prepared->>'peakStrength')::numeric;
  if peak<g.peak_strength or peak>9007199254740991 or trunc(peak*100)<>peak*100
    or (plan->>'overflowMoney')::numeric not between 0 and 9007199254740991
    or trunc((plan->>'overflowMoney')::numeric)<>(plan->>'overflowMoney')::numeric then raise exception 'invalid inventory plan'; end if;
  select count(*) into total from public.item_instances where gladiator_id=gid;
  if total+jsonb_array_length(plan->'retained')>60 then return null; end if;
  -- Check every changed stack before mutation, so reservation changes cannot partially apply a plan.
  for entry in select value from jsonb_array_elements(plan->'stacked') loop
    select item into row_item from public.item_instances where id=(entry->>'itemId')::uuid and gladiator_id=gid;
    if not found or row_item->>'catalogId'<>'salvage' or row_item->'reservation' is distinct from 'null'::jsonb
      or exists(select 1 from public.pending_build_items where public.pending_build_items.item_id=(entry->>'itemId')::uuid) then return null; end if;
    if jsonb_typeof(entry->'quantity') is distinct from 'number' or (entry->>'quantity')::numeric not between 1 and 999
      or trunc((entry->>'quantity')::numeric)<>(entry->>'quantity')::numeric
      or (row_item->>'quantity')::numeric+(entry->>'quantity')::numeric>999 then raise exception 'invalid inventory plan'; end if;
  end loop;
  for entry in select value from jsonb_array_elements(plan->'stacked') loop
    update public.item_instances set item=jsonb_set(item,'{quantity}',to_jsonb((item->>'quantity')::integer+(entry->>'quantity')::integer))
      where id=(entry->>'itemId')::uuid and gladiator_id=gid;
  end loop;
  for entry in select value from jsonb_array_elements(plan->'retained') loop
    item_id:=gen_random_uuid();
    insert into public.item_instances(id,gladiator_id,item) values(item_id,gid,entry||jsonb_build_object('id',item_id,'ownerId',gid,'reservation',null));
    ids:=ids||jsonb_build_array(item_id);
  end loop;
  update public.gladiators set peak_strength=peak where id=gid;
  return jsonb_build_object('itemIds',ids,'overflowMoney',plan->'overflowMoney','overflow',plan->'overflow','peakStrength',peak);
end $function$
;

CREATE OR REPLACE FUNCTION private.guard_cosmetic()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin raise exception 'bound cosmetic'; end $function$
;

CREATE OR REPLACE FUNCTION private.guard_historical_strength()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.peak_strength<old.peak_strength then raise exception 'historical strength decrease'; end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION private.guard_inventory_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op='UPDATE' then
    if new.id<>old.id or (new.item-array['ownerId','reservation','quantity'])<>(old.item-array['ownerId','reservation','quantity'])
      or (old.item->>'binding'='bound' and new.gladiator_id<>old.gladiator_id)
      or (old.item->>'catalogId'<>'salvage' and new.item->'quantity'<>old.item->'quantity') then raise exception 'immutable item'; end if;
  end if;
  if new.item->>'catalogId'<>'salvage' and new.item->'quantity'<>'1'::jsonb then raise exception 'immutable item'; end if;
  if tg_op='INSERT' or new.gladiator_id<>old.gladiator_id then
    -- All production callers already hold the sorted account/character locks (including future market transfers).
    perform 1 from public.gladiators where id=new.gladiator_id for update;
    if (select count(*) from public.item_instances where gladiator_id=new.gladiator_id)>=60 then raise exception 'inventory full'; end if;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION private.inventory_command(actor_id uuid, operation_id uuid, input jsonb, kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c jsonb:=input->'command'; prep jsonb:=input->'prepared'; prior public.operation_receipts%rowtype;
  g public.gladiators%rowtype; w public.wallets%rowtype; item jsonb; offer jsonb; result jsonb; applied jsonb;
  receipt uuid:=gen_random_uuid(); err text; quantity bigint; cost numeric; money_delta bigint:=0; renown_delta bigint:=0;
  remaining bigint; available numeric; target uuid; unit_value numeric;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=inventory_command.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if c->>'kind' is distinct from kind or c->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(c->'quantity') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (c->>'quantity')::numeric not between 1 and 999 or trunc((c->>'quantity')::numeric)<>(c->>'quantity')::numeric
    then return jsonb_build_object('ok',false,'code','invalid'); end if;
  quantity:=(c->>'quantity')::bigint;
  if kind='buy-shop' then
    if (select count(*) from jsonb_object_keys(c))<>5 or not(c ?& array['kind','operationId','catalogId','catalogVersion','quantity'])
      or jsonb_typeof(c->'catalogId') is distinct from 'string' or jsonb_typeof(c->'catalogVersion') is distinct from 'string'
      then return jsonb_build_object('ok',false,'code','invalid'); end if;
  elsif kind in ('sell-item','discard-item') then
    if (select count(*) from jsonb_object_keys(c))<>4 or not(c ?& array['kind','operationId','itemId','quantity'])
      or jsonb_typeof(c->'itemId') is distinct from 'string' or c->>'itemId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then return jsonb_build_object('ok',false,'code','invalid'); end if;
    target:=(c->>'itemId')::uuid;
  else return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if g.processed_slot_index<private.planning_now_ms()/4800000 then return jsonb_build_object('ok',false,'code','processing','retryAfterMs',1000); end if;
  select * into w from public.wallets where gladiator_id=g.id for update;
  perform 1 from public.item_instances where gladiator_id=g.id order by id for update;
  if kind='buy-shop' and c->>'catalogId'='banner' then
    offer:=prep->'offer';
    if quantity<>1 or prep->'cosmetic' is distinct from 'true'::jsonb or c->>'catalogVersion'<>'v1'
      or offer->>'catalogId' is distinct from 'banner' or offer->>'catalogVersion' is distinct from 'v1'
      or offer->>'currency' is distinct from 'renown' or jsonb_typeof(offer->'unitPrice') is distinct from 'number' then err:='invalid';
    elsif exists(select 1 from public.owned_cosmetics where gladiator_id=g.id and catalog_id='banner') then err:='conflict';
    else
      cost:=(offer->>'unitPrice')::numeric;
      select w.renown-coalesce(sum(r.renown),0) into available from public.reservations r where r.gladiator_id=g.id and r.status='held';
      if cost not between 1 and 9007199254740991 or trunc(cost)<>cost then err:='invalid';
      elsif cost>available then err:='insufficient-funds';
      else
        insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version) values(g.id,'banner','v1');
        renown_delta:=-cost::bigint;
        result:=jsonb_build_object('cosmeticId','banner','catalogVersion','v1','renownDebit',cost,'moneyDebit',0,'bound',true);
      end if;
    end if;
  elsif kind='buy-shop' then
    offer:=prep->'offer';
    if prep is null or prep='null'::jsonb or jsonb_typeof(offer) is distinct from 'object'
      or offer->>'catalogId' is distinct from c->>'catalogId' or offer->>'catalogVersion' is distinct from c->>'catalogVersion'
      or offer->>'currency' not in ('money','renown') or jsonb_typeof(offer->'unitPrice') is distinct from 'number'
      or jsonb_typeof(offer->'requiredLevel') is distinct from 'number' then err:='invalid';
    elsif (offer->>'requiredLevel')::numeric>g.level or (offer->>'unitPrice')::numeric not between 1 and 9007199254740991
      or trunc((offer->>'unitPrice')::numeric)<>(offer->>'unitPrice')::numeric then err:='invalid';
    elsif (select count(*) from public.item_instances where gladiator_id=g.id)+quantity>60 then err:='inventory-full';
    else
      cost:=(offer->>'unitPrice')::numeric*quantity;
      if cost>9007199254740991 then err:='invalid';
      else
        select (case when offer->>'currency'='money' then w.money else w.renown end)
          -coalesce(sum(case when offer->>'currency'='money' then r.money else r.renown end),0) into available
          from public.reservations r where r.gladiator_id=g.id and r.status='held';
        if cost>available then err:='insufficient-funds'; end if;
      end if;
    end if;
    if err is null then
      if jsonb_array_length(prep->'plan'->'retained')<>quantity or prep->'plan'->'stacked'<>'[]'::jsonb
        or prep->'plan'->'overflowMoney'<>'0'::jsonb then err:='invalid';
      else
        applied:=private.apply_inventory_plan(g.id,prep);
        if applied is null then err:='conflict';
        else
          if offer->>'currency'='money' then money_delta:=-cost::bigint; else renown_delta:=-cost::bigint; end if;
          result:=jsonb_build_object('itemIds',applied->'itemIds','catalogId',c->'catalogId','catalogVersion',c->'catalogVersion','quantity',quantity,
            'currency',offer->'currency','moneyDebit',-money_delta,'renownDebit',-renown_delta,'bound',offer->>'currency'='renown','peakStrength',applied->'peakStrength');
        end if;
      end if;
    end if;
  else
    select i.item into item from public.item_instances i where i.id=target and i.gladiator_id=g.id;
    if not found then err:='not-found';
    elsif item->'reservation' is distinct from 'null'::jsonb or exists(select 1 from public.pending_build_items where item_id=target)
      or quantity>(item->>'quantity')::bigint then err:='invalid';
    elsif kind='sell-item' then
      if item->>'origin'='renown' or item->>'binding'<>'tradable' or prep is null or prep='null'::jsonb
        or prep->>'catalogId' is distinct from item->>'catalogId' or prep->>'catalogVersion' is distinct from item->>'catalogVersion'
        or jsonb_typeof(prep->'unitValue') is distinct from 'number' then err:='invalid';
      else
        unit_value:=(prep->>'unitValue')::numeric; cost:=unit_value*quantity;
        if unit_value not between 1 and 9007199254740991 or trunc(unit_value)<>unit_value or cost>9007199254740991
          or w.money::numeric+cost>9007199254740991 then err:='invalid'; else money_delta:=cost::bigint; end if;
      end if;
    end if;
    if err is null then
      remaining:=(item->>'quantity')::bigint-quantity;
      if remaining=0 then delete from public.item_instances where id=target;
      else update public.item_instances i set item=jsonb_set(i.item,'{quantity}',to_jsonb(remaining)) where i.id=target; end if;
      result:=jsonb_build_object('itemId',target,'quantity',quantity,'remainingQuantity',remaining);
      if kind='sell-item' then result:=result||jsonb_build_object('moneyCredit',money_delta); end if;
    end if;
  end if;
  result:=case when err is null then jsonb_build_object('ok',true,'receiptId',receipt,'value',result) else jsonb_build_object('ok',false,'code',err) end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  if err is null and kind<>'discard-item' then
    update public.wallets set money=money+money_delta,renown=renown+renown_delta where gladiator_id=g.id;
    insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason)
      values(g.id,receipt,money_delta,renown_delta,case kind when 'buy-shop' then 'shop-purchase' else 'npc-sale' end);
  end if;
  return result;
end $function$
;

CREATE OR REPLACE FUNCTION private.accept_job_result(job uuid, result jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select false
$function$
;

CREATE OR REPLACE FUNCTION private.active_rules_version()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select version from private.rules_versions where active
$function$
;

CREATE OR REPLACE FUNCTION private.activity_executor_ready(kind text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select coalesce(kind in ('training','rest'),false)
$function$
;

CREATE OR REPLACE FUNCTION private.apply_pending_build(gid uuid, boundary_slot bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare actor uuid; b public.builds%rowtype; prep private.pending_build_preparations%rowtype; fee bigint; receipt uuid; total bigint;
begin
  if gid is null or boundary_slot is null or boundary_slot<0 then raise exception 'invalid boundary'; end if;
  select owner_id into actor from public.gladiators where id=gid;
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  perform 1 from public.gladiators where id=gid for update;
  select * into b from public.builds where gladiator_id=gid for update;
  if b.pending_build is null or (b.pending_build->>'effectiveSlotIndex')::bigint>boundary_slot then return false; end if;
  select * into prep from private.pending_build_preparations where gladiator_id=gid;
  if not found or prep.operation_id<>(b.pending_build->>'operationId')::uuid then raise exception 'missing pending preparation'; end if;
  select money into fee from public.reservations where gladiator_id=gid and operation_id=prep.operation_id and status='held' for update;
  if not found then raise exception 'missing held fee'; end if;
  update public.wallets set money=money-fee where gladiator_id=gid;
  update public.reservations set status='consumed' where gladiator_id=gid and operation_id=prep.operation_id;
  select receipt_id into receipt from public.operation_receipts where owner_id=actor and operation_id=prep.operation_id;
  insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason) values(gid,receipt,-fee,0,'build');
  update public.item_instances set item=jsonb_set(item,'{reservation}',case when id in (select item_id from public.pending_build_items where gladiator_id=gid)
    then jsonb_build_object('kind','equipment','referenceId',gid) else 'null'::jsonb end)
    where gladiator_id=gid and (item->'reservation'->>'kind' in ('equipment','pending-build') or id in (select item_id from public.pending_build_items where gladiator_id=gid));
  select sum(value::text::bigint) into total from jsonb_each(b.pending_build->'build'->'allocations');
  update public.gladiators set stamina_maximum=prep.stamina_maximum,stamina_current=least(stamina_current,prep.stamina_maximum),unspent_points=earned_points-total where id=gid;
  update public.builds set current_build=pending_build->'build',pending_build=null where gladiator_id=gid;
  delete from public.pending_build_items where gladiator_id=gid;
  delete from private.pending_build_preparations where gladiator_id=gid;
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION private.boundary_apply_changes(target bigint)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare b private.boundaries%rowtype; m record;
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
    insert into private.boundary_members(slot_index,gladiator_id,owner_id)
      select target,g.id,g.owner_id from public.gladiators g where g.processed_slot_index=target-1 on conflict do nothing;
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
end $function$
;

CREATE OR REPLACE FUNCTION private.boundary_check_stamina(target bigint)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  with priced as (
    select a.id,(s.snapshot->'costs'->>(a.requested->>'kind'))::bigint as cost,(s.snapshot->'starting'->'stamina'->>'current')::bigint as stamina
    from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    where a.slot_index=target and a.status='preparing' and a.resolved_kind is null)
  update public.activities a set resolved_kind=case when p.cost>p.stamina then 'rest' else a.requested->>'kind' end,
    fallback=p.cost>p.stamina,stamina_debit=case when p.cost>p.stamina then 0 else p.cost end
  from priced p where p.id=a.id;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION private.boundary_close_season(target bigint)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select null::text
$function$
;

CREATE OR REPLACE FUNCTION private.boundary_pair(target bigint)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case when exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing'
    and a.resolved_kind in ('arena','tournament')) then 'integration' end
$function$
;

CREATE OR REPLACE FUNCTION private.boundary_published(target bigint)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select null::text
$function$
;

CREATE OR REPLACE FUNCTION private.boundary_recompute(target bigint)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare b private.boundaries%rowtype; m record; now_ms bigint:=private.planning_now_ms();
begin
  select * into b from private.boundaries where slot_index=target;
  for m in select bm.gladiator_id,g.level,g.earned_points,g.peak_strength,bu.current_build from private.boundary_members bm
    join public.gladiators g on g.id=bm.gladiator_id join public.builds bu on bu.gladiator_id=bm.gladiator_id
    where bm.slot_index=target and not exists(select 1 from private.jobs j where j.dedupe_key='prepare:'||target||':'||bm.gladiator_id)
    order by bm.gladiator_id loop
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
      values('prepare','prepare:'||target||':'||m.gladiator_id,target,m.gladiator_id,jsonb_build_object(
        'gladiatorId',m.gladiator_id,'slotIndex',target,'rulesVersion',b.rules_version,'build',m.current_build,
        'items',(select coalesce(jsonb_agg(i.item order by i.id),'[]'::jsonb) from public.item_instances i where i.gladiator_id=m.gladiator_id
          and i.id in (select e.value::uuid from jsonb_each_text(m.current_build->'equipment') e where e.value is not null)),
        'level',m.level,'earnedPoints',m.earned_points,'peakStrength',m.peak_strength),b.rules_version,now_ms)
      on conflict (dedupe_key) do nothing;
  end loop;
  if exists(select 1 from private.jobs j where j.kind='prepare' and j.slot_index=target and j.status='operator') then return 'operator'; end if;
  if exists(select 1 from private.jobs j where j.kind='prepare' and j.slot_index=target and j.status<>'completed') then return 'preparation'; end if;
  -- Adopt the recomputed capacity (a rules version can change it): absolute stamina is preserved, clamped down, never refilled.
  for m in select bm.gladiator_id,bm.owner_id,(j.result->>'staminaMaximum')::bigint as maximum from private.boundary_members bm
    join private.jobs j on j.dedupe_key='prepare:'||target||':'||bm.gladiator_id
    join public.gladiators g on g.id=bm.gladiator_id
    where bm.slot_index=target and g.stamina_maximum<>(j.result->>'staminaMaximum')::bigint order by bm.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(m.owner_id::text,0));
    update public.gladiators set stamina_maximum=m.maximum,stamina_current=least(stamina_current,m.maximum) where id=m.gladiator_id;
  end loop;
  return private.boundary_recompute_leagues(target);
end $function$
;

CREATE OR REPLACE FUNCTION private.boundary_recompute_leagues(target bigint)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select null::text
$function$
;

CREATE OR REPLACE FUNCTION private.boundary_settle_previous(target bigint)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case
    when exists(select 1 from private.jobs j where j.slot_index=target-1 and j.status='operator') then 'operator'
    when exists(select 1 from public.activities a where a.slot_index=target-1 and a.status<>'completed') then 'settlement'
  end
$function$
;

CREATE OR REPLACE FUNCTION private.boundary_snapshot(target bigint)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare b private.boundaries%rowtype; m record; g public.gladiators%rowtype; prep jsonb; rev record; activity uuid;
begin
  select * into b from private.boundaries where slot_index=target;
  for m in select bm.gladiator_id,bm.owner_id from private.boundary_members bm where bm.slot_index=target
    and not exists(select 1 from public.activities a where a.gladiator_id=bm.gladiator_id and a.slot_index=target) order by bm.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(m.owner_id::text,0));
    select * into g from public.gladiators where id=m.gladiator_id for update;
    select j.result into prep from private.jobs j where j.dedupe_key='prepare:'||target||':'||m.gladiator_id and j.status='completed';
    -- Historical authority: latest revision effective by this slot, never the mutable latest-plan row.
    select r.version,r.choice into rev from public.schedule_revisions r where r.gladiator_id=m.gladiator_id
      and r.phase=private.slot_phase(target) and r.effective_slot_index<=target order by r.effective_slot_index desc,r.version desc limit 1;
    if rev is null or prep is null then raise exception 'missing boundary input'; end if;
    insert into public.activities(gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,schedule_version,status)
      values(m.gladiator_id,target,target*4800000,(target+1)*4800000,rev.choice,rev.version,'preparing') returning id into activity;
    insert into private.activity_snapshots(activity_id,snapshot,seed,rules_version) values(activity,jsonb_build_object(
      'activityId',activity,'gladiatorId',m.gladiator_id,'slotIndex',target,'rulesVersion',b.rules_version,'cutoffMs',b.cutoff_ms,
      'choice',rev.choice,'scheduleVersion',rev.version,'build',prep->'snapshot','derived',prep->'derived','costs',prep->'costs',
      'trainingPoints',prep->'trainingPoints','starting',jsonb_build_object(
        'stamina',jsonb_build_object('current',g.stamina_current,'maximum',g.stamina_maximum),'level',g.level,'xp',g.xp,
        'earnedPoints',g.earned_points,'unspentPoints',g.unspent_points,'league',g.league,'rating',g.rating,
        'peakStrength',g.peak_strength,'tournamentOptIn',g.tournament_opt_in)),
      encode(extensions.gen_random_bytes(32),'hex'),b.rules_version);
  end loop;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION private.boundary_start(target bigint)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare a record; now_ms bigint:=private.planning_now_ms();
begin
  -- Check every member before any debit so an unsupported executor never leaves a partially started slot.
  if exists(select 1 from public.activities x where x.slot_index=target and x.status='preparing' and not private.activity_executor_ready(x.resolved_kind)) then
    return 'integration';
  end if;
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
  return private.boundary_published(target);
end $function$
;

CREATE OR REPLACE FUNCTION private.cron_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare coordination jsonb;
begin
  if not coalesce((select enabled from private.scheduler where singleton),false) then return jsonb_build_object('ok',true,'skipped','disabled'); end if;
  begin
    coordination:=public.coordinate_work();
  exception when others then
    -- Record only the SQLSTATE; dispatch still proceeds so pending work keeps draining.
    update private.coordinator set last_error=sqlstate,updated_at_ms=private.planning_now_ms() where singleton;
    coordination:=jsonb_build_object('ok',false,'code','coordinator-failed');
  end;
  return jsonb_build_object('ok',true,'coordination',coordination,'dispatch',private.dispatch_workers());
end $function$
;

CREATE OR REPLACE FUNCTION private.dispatch_workers()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare url text; secret text; now_ms bigint; simple integer; combat integer; recent integer; budget integer; wanted integer;
  request bigint; requests jsonb:='[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('cloudiator:dispatch',3));
  now_ms:=private.planning_now_ms();
  select decrypted_secret into url from vault.decrypted_secrets where name='game_worker_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='game_worker_secret';
  if url is null or secret is null then return jsonb_build_object('ok',true,'dispatched',0,'reason','unconfigured'); end if;
  select count(*) filter (where kind<>'simulation'),count(*) filter (where kind='simulation') into simple,combat from private.jobs
    where due_at_ms<=now_ms and (status='pending' or (status='leased' and lease_until_ms<=now_ms and attempts<max_attempts));
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
end $function$
;

CREATE OR REPLACE FUNCTION private.guard_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'immutable %', tg_table_name;
end $function$
;

CREATE OR REPLACE FUNCTION private.guard_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op='DELETE' then
    if old.status<>'completed' then raise exception 'unfinished job'; end if;
    return old;
  end if;
  if old.status='completed' then raise exception 'immutable job'; end if;
  if new.id<>old.id or new.kind<>old.kind or new.dedupe_key<>old.dedupe_key or new.slot_index<>old.slot_index
    or new.gladiator_id<>old.gladiator_id or new.activity_id is distinct from old.activity_id or new.input<>old.input
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
end $function$
;

CREATE OR REPLACE FUNCTION private.guard_reserved_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if old.item->'reservation' <> 'null'::jsonb or exists(select 1 from public.pending_build_items p where p.item_id=old.id) then
    if tg_op='DELETE' then raise exception 'reserved item'; end if;
    if new.id<>old.id or new.gladiator_id<>old.gladiator_id or (new.item-'reservation')<>(old.item-'reservation') then raise exception 'reserved item'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION private.initial_schedule_revision()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index)
    select new.gladiator_id,new.version,e.key,e.value,g.created_at_ms,g.processed_slot_index+1
    from public.gladiators g cross join jsonb_each(new.schedule) e where g.id=new.gladiator_id;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION private.planning_command(actor_id uuid, operation_id uuid, input jsonb, kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c jsonb:=input->'command'; prep jsonb:=input->'prepared'; prior public.operation_receipts%rowtype;
  g public.gladiators%rowtype; b public.builds%rowtype; s public.schedules%rowtype;
  now_ms bigint; slot bigint; receipt uuid:=gen_random_uuid(); result jsonb; err text; fee bigint; available bigint;
  inventory jsonb; ids jsonb; next_build jsonb; effective bigint; next_version bigint; required_level integer;
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
  if (c->>'expectedVersion')::bigint <> (case when kind='edit-schedule' then s.version else b.version end) then err:='conflict';
  elsif kind='edit-schedule' then
    if (select count(*) from jsonb_object_keys(c))<>5 or not(c ?& array['kind','operationId','expectedVersion','phase','choice'])
      or c->>'phase' is null or c->>'phase' not in ('morning','afternoon','evening') or jsonb_typeof(c->'choice') is distinct from 'object' then err:='invalid';
    elsif c->'choice'->>'kind' in ('rest','training','arena') and (select count(*) from jsonb_object_keys(c->'choice'))=1 then null;
    elsif c->'choice'->>'kind'='expedition' and (select count(*) from jsonb_object_keys(c->'choice'))=2 and c->'choice' ? 'expeditionId' then
      required_level:=case c->'choice'->>'expeditionId' when 'woodland' then 1 when 'outpost' then 5 when 'mountain' then 10 else null end;
      if required_level is null or g.level<required_level then err:='invalid'; end if;
    else err:='invalid'; end if;
    if err is null then
      effective:=private.schedule_effective_slot(c->>'phase',now_ms); next_version:=s.version+1;
      update public.schedules set version=next_version,schedule=jsonb_set(schedule,array[c->>'phase'],c->'choice') where gladiator_id=g.id;
      insert into public.schedule_revisions values(g.id,next_version,c->>'phase',c->'choice',now_ms,effective);
      result:=jsonb_build_object('version',next_version,'receivedAtMs',now_ms,'effectiveSlotIndex',effective,'effectiveAtMs',effective*4800000);
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
        if fee not in (0,100,200) then err:='invalid'; elsif available<fee then err:='insufficient-funds'; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION private.planning_now_ms()
 RETURNS bigint
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select floor(extract(epoch from clock_timestamp())*1000)::bigint
$function$
;

CREATE OR REPLACE FUNCTION private.prepare_activity_jobs(activity uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype;
begin
  select * into a from public.activities where id=activity;
  select * into s from private.activity_snapshots where activity_id=activity;
  if a.resolved_kind not in ('training','rest') then raise exception 'unsupported activity executor'; end if;
  insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
    values('settlement','settlement:'||a.id,a.slot_index,a.gladiator_id,a.id,
      jsonb_build_object('activityId',a.id,'gladiatorId',a.gladiator_id,'slotIndex',a.slot_index,'resolvedKind',a.resolved_kind,'endsAtMs',a.ends_at_ms),
      s.seed,s.rules_version,a.ends_at_ms)
    on conflict (dedupe_key) do nothing;
end $function$
;

CREATE OR REPLACE FUNCTION private.resume_operator_job(job uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update private.jobs set status='pending',max_attempts=attempts+3 where id=job and status='operator';
  if not found then return jsonb_build_object('ok',false,'code','invalid'); end if;
  return jsonb_build_object('ok',true);
end $function$
;

CREATE OR REPLACE FUNCTION private.schedule_effective_slot(phase text, now_ms bigint)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE STRICT
 SET search_path TO ''
AS $function$
  select now_ms/4800000 + coalesce(nullif(((array_position(array['morning','afternoon','evening'],phase)-1)-(now_ms/4800000)%3+3)%3,0),3)
$function$
;

CREATE OR REPLACE FUNCTION private.settle_rewards(activity uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype; points bigint := 0; earned bigint;
begin
  select * into a from public.activities where id=activity;
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
end $function$
;

CREATE OR REPLACE FUNCTION private.slot_phase(slot bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT
 SET search_path TO ''
AS $function$
  select (array['morning','afternoon','evening'])[(slot%3)::integer+1]
$function$
;

CREATE OR REPLACE FUNCTION private.sweep_exhausted_leases(now_ms bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare swept integer;
begin
  with exhausted as (
    select j.id,j.attempts from private.jobs j where j.status='leased' and j.lease_until_ms<=now_ms and j.attempts>=j.max_attempts
    order by j.id for update skip locked
  ), retained as (
    update private.jobs j set status='operator',lease_token=null,lease_owner=null,lease_until_ms=null,last_failure='lease-expired'
    from exhausted e where j.id=e.id returning j.id,j.attempts
  ), logged as (
    update private.job_attempts a set finished_at_ms=now_ms,outcome='expired',failure_code='lease-expired'
    from retained r where a.job_id=r.id and a.attempt=r.attempts and a.outcome is null returning a.job_id
  )
  select count(*) into swept from retained;
  return swept;
end $function$
;

CREATE OR REPLACE FUNCTION private.valid_preparation(job uuid, result jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
  return true;
end $function$
;



-- Complete migra omissions from the tested Task 8 source: dependencies, ACLs, view security and data initialization.
CREATE TRIGGER guard_historical_strength BEFORE UPDATE ON public.gladiators FOR EACH ROW EXECUTE FUNCTION private.guard_historical_strength();
CREATE TRIGGER guard_inventory_item BEFORE INSERT OR UPDATE ON public.item_instances FOR EACH ROW EXECUTE FUNCTION private.guard_inventory_item();
CREATE TRIGGER guard_cosmetic BEFORE DELETE OR UPDATE ON public.owned_cosmetics FOR EACH ROW EXECUTE FUNCTION private.guard_cosmetic();
revoke all on public.owned_cosmetics from public,anon,authenticated,service_role;
grant select on public.owned_cosmetics to authenticated;
grant select,insert on public.owned_cosmetics to service_role;
revoke all on function private.guard_cosmetic() from public,anon,authenticated;
grant execute on function private.guard_cosmetic() to service_role;
revoke all on function private.guard_inventory_item(),private.guard_historical_strength(),private.apply_inventory_plan(uuid,jsonb),
  private.inventory_command(uuid,uuid,jsonb,text),public.buy_shop(uuid,uuid,jsonb),public.sell_item(uuid,uuid,jsonb),public.discard_item(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.guard_inventory_item(),private.guard_historical_strength(),private.apply_inventory_plan(uuid,jsonb),
  private.inventory_command(uuid,uuid,jsonb,text),public.buy_shop(uuid,uuid,jsonb),public.sell_item(uuid,uuid,jsonb),public.discard_item(uuid,uuid,jsonb) to service_role;
alter view public.owner_state set (security_invoker=true);
-- Before Task 8 only the starter loadout was acquirable. Preserve higher history.
update public.gladiators set peak_strength=greatest(peak_strength,28);
notify pgrst,'reload schema';
