set check_function_bodies = off;

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

alter table "private"."boundaries" drop constraint "boundaries_wait_reason_check";

alter table "private"."boundaries" add column "last_error" text;

alter table "private"."coordinator" add column "last_failed_slot" bigint;

alter table "private"."boundaries" add constraint "boundaries_wait_reason_check" CHECK ((wait_reason = ANY (ARRAY['settlement'::text, 'extension'::text, 'preparation'::text, 'integration'::text, 'operator'::text, 'straggler'::text, 'error'::text]))) not valid;

alter table "private"."boundaries" validate constraint "boundaries_wait_reason_check";

set check_function_bodies = off;

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
  for m in select bm.gladiator_id,g.level,g.earned_points,bu.current_build from private.boundary_members bm
    join public.gladiators g on g.id=bm.gladiator_id join public.builds bu on bu.gladiator_id=bm.gladiator_id
    where bm.slot_index=target and not exists(select 1 from private.jobs j where j.dedupe_key='prepare:'||target||':'||bm.gladiator_id)
    order by bm.gladiator_id loop
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,input,rules_version,due_at_ms)
      values('prepare','prepare:'||target||':'||m.gladiator_id,target,m.gladiator_id,jsonb_build_object(
        'gladiatorId',m.gladiator_id,'slotIndex',target,'rulesVersion',b.rules_version,'build',m.current_build,
        'items',(select coalesce(jsonb_agg(i.item order by i.id),'[]'::jsonb) from public.item_instances i where i.gladiator_id=m.gladiator_id
          and i.id in (select e.value::uuid from jsonb_each_text(m.current_build->'equipment') e where e.value is not null)),
        'level',m.level,'earnedPoints',m.earned_points),b.rules_version,now_ms)
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
-- Reviewed completion of the CLI diff (see docs/operations/migrations.md): migra omits function ACLs, so the new private
-- function would keep PostgreSQL's default EXECUTE for PUBLIC. The revoke/grant follow the source exactly. The unchanged
-- private function bodies re-emitted above are byte-identical to M03 and are harmless CREATE OR REPLACE statements.
revoke all on function private.sweep_exhausted_leases(bigint) from public,anon,authenticated,service_role;
grant execute on function private.sweep_exhausted_leases(bigint) to service_role;
