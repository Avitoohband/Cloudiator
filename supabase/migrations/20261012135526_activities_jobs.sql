-- Reviewed completion of the CLI diff (see docs/operations/migrations.md): migra omits extensions,
-- seed rows, the pg_cron schedule, function ACLs and complete table revocations; they follow the source exactly.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;


  create table "public"."activities" (
    "id" uuid not null default gen_random_uuid(),
    "gladiator_id" uuid not null,
    "slot_index" bigint not null,
    "starts_at_ms" bigint not null,
    "ends_at_ms" bigint not null,
    "requested" jsonb not null,
    "schedule_version" bigint not null default 1,
    "resolved_kind" text,
    "fallback" boolean not null default false,
    "stamina_debit" bigint,
    "debited" boolean not null default false,
    "status" text not null,
    "published_at_ms" bigint,
    "receipt_id" uuid,
    "summary" jsonb,
    "settled_at_ms" bigint
      );


alter table "public"."activities" enable row level security;

CREATE UNIQUE INDEX activities_gladiator_id_slot_index_key ON public.activities USING btree (gladiator_id, slot_index);

CREATE UNIQUE INDEX activities_pkey ON public.activities USING btree (id);

CREATE UNIQUE INDEX activities_receipt_id_key ON public.activities USING btree (receipt_id);

CREATE INDEX activities_slot_status_idx ON public.activities USING btree (slot_index, status);

alter table "public"."activities" add constraint "activities_pkey" PRIMARY KEY using index "activities_pkey";

alter table "public"."activities" add constraint "activities_check" CHECK (((starts_at_ms = (slot_index * 4800000)) AND (ends_at_ms = (starts_at_ms + 4800000)))) not valid;

alter table "public"."activities" validate constraint "activities_check";

alter table "public"."activities" add constraint "activities_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) not valid;

alter table "public"."activities" validate constraint "activities_gladiator_id_fkey";

alter table "public"."activities" add constraint "activities_gladiator_id_slot_index_key" UNIQUE using index "activities_gladiator_id_slot_index_key";

alter table "public"."activities" add constraint "activities_receipt_id_key" UNIQUE using index "activities_receipt_id_key";

alter table "public"."activities" add constraint "activities_requested_check" CHECK ((jsonb_typeof(requested) = 'object'::text)) not valid;

alter table "public"."activities" validate constraint "activities_requested_check";

alter table "public"."activities" add constraint "activities_resolved_kind_check" CHECK ((resolved_kind = ANY (ARRAY['training'::text, 'rest'::text, 'expedition'::text, 'arena'::text, 'tournament'::text]))) not valid;

alter table "public"."activities" validate constraint "activities_resolved_kind_check";

alter table "public"."activities" add constraint "activities_schedule_version_check" CHECK ((schedule_version >= 1)) not valid;

alter table "public"."activities" validate constraint "activities_schedule_version_check";

alter table "public"."activities" add constraint "activities_slot_index_check" CHECK ((slot_index >= 0)) not valid;

alter table "public"."activities" validate constraint "activities_slot_index_check";

alter table "public"."activities" add constraint "activities_stamina_debit_check" CHECK ((stamina_debit >= 0)) not valid;

alter table "public"."activities" validate constraint "activities_stamina_debit_check";

alter table "public"."activities" add constraint "activities_status_check" CHECK ((status = ANY (ARRAY['preparing'::text, 'active'::text, 'completed'::text]))) not valid;

alter table "public"."activities" validate constraint "activities_status_check";

alter table "public"."activities" add constraint "activities_summary_check" CHECK (((summary IS NULL) OR (jsonb_typeof(summary) = 'object'::text))) not valid;

alter table "public"."activities" validate constraint "activities_summary_check";

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
      update private.boundaries set status='waiting',wait_reason=wait,updated_at_ms=now_ms where slot_index=target_slot;
      return jsonb_build_object('ok',true,'slotIndex',target_slot,'phase',b.phase,'status','waiting','wait',wait);
    end if;
    b.phase:=b.phase+1;
    update private.boundaries set phase=b.phase,status=case when b.phase=9 then 'complete' else 'running' end,wait_reason=null,
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
  -- An expired lease at its attempt limit is retained for operator action instead of a further attempt.
  with exhausted as (
    update private.jobs j set status='operator',lease_token=null,lease_owner=null,last_failure='lease-expired'
    where j.kind=claim_jobs.kind and j.status='leased' and j.lease_until_ms<=now_ms and j.attempts>=j.max_attempts
    returning j.id,j.attempts)
  update private.job_attempts a set finished_at_ms=now_ms,outcome='expired',failure_code='lease-expired'
    from exhausted e where a.job_id=e.id and a.attempt=e.attempts and a.outcome is null;
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
  reports jsonb:='[]'::jsonb; steps integer:=0; next_slot bigint;
begin
  select * into c from private.coordinator where singleton for update skip locked;
  if not found then return jsonb_build_object('ok',true,'busy',true,'publishedSlot',null); end if;
  now_ms:=private.planning_now_ms(); current_slot:=now_ms/4800000;
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
    result:=public.advance_boundary(next_slot,token);
    reports:=reports||jsonb_build_array(result);
    steps:=steps+1;
    exit when result->>'status' is distinct from 'complete';
  end loop;
  update private.coordinator set lease_token=null,lease_until_ms=0,last_error=null,updated_at_ms=now_ms where singleton;
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
  rewards jsonb; result_summary jsonb; outcome jsonb; inserted integer;
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
    rewards:=private.settle_rewards(a.id);
    result_summary:=jsonb_build_object('activityId',a.id,'resolvedKind',a.resolved_kind,'result','completed','success',true,'rewards',rewards,
      'receiptId',receipt,'settledAtMs',now_ms,'replayExpiry',jsonb_build_object('state','expired'));
    update public.activities set status='completed',receipt_id=receipt,summary=result_summary,settled_at_ms=now_ms where id=a.id;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',1,'summary',result_summary);
  end if;
  update private.jobs set status='completed',result=outcome,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return outcome;
end $function$
;

create or replace view "public"."owner_state" as  SELECT g.owner_id,
    jsonb_build_object('gladiatorId', g.id, 'name', g.name, 'currentBuild', b.current_build, 'pendingBuild', b.pending_build, 'buildVersion', b.version, 'schedule', s.schedule, 'scheduleVersion', s.version, 'wallets', jsonb_build_object('money', w.money, 'renown', w.renown), 'reservedFees', jsonb_build_object('money', COALESCE(( SELECT sum(r.money) AS sum
           FROM public.reservations r
          WHERE ((r.gladiator_id = g.id) AND (r.status = 'held'::text))), (0)::numeric), 'renown', COALESCE(( SELECT sum(r.renown) AS sum
           FROM public.reservations r
          WHERE ((r.gladiator_id = g.id) AND (r.status = 'held'::text))), (0)::numeric)), 'inventory', COALESCE(( SELECT jsonb_agg(i.item ORDER BY i.id) AS jsonb_agg
           FROM public.item_instances i
          WHERE (i.gladiator_id = g.id)), '[]'::jsonb), 'inventoryCapacity', 60, 'progression', jsonb_build_object('level', g.level, 'xp', g.xp, 'earnedAttributePoints', g.earned_points, 'unspentAttributePoints', g.unspent_points, 'league', g.league, 'peakStrength', g.peak_strength, 'rating', g.rating), 'stamina', jsonb_build_object('current', g.stamina_current, 'maximum', g.stamina_maximum), 'tournamentOptIn', g.tournament_opt_in, 'processedSlotIndex', g.processed_slot_index, 'currentActivity', COALESCE(( SELECT jsonb_build_object('id', a.id, 'kind', COALESCE(a.resolved_kind, (a.requested ->> 'kind'::text)), 'status',
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


grant select on table "public"."activities" to "authenticated";

grant delete on table "public"."activities" to "service_role";

grant insert on table "public"."activities" to "service_role";

grant select on table "public"."activities" to "service_role";

grant update on table "public"."activities" to "service_role";


  create policy "owner_read"
  on "public"."activities"
  as permissive
  for select
  to authenticated
using ((gladiator_id IN ( SELECT gladiators.id
   FROM public.gladiators
  WHERE (gladiators.owner_id = ( SELECT auth.uid() AS uid)))));



  create table "private"."activity_snapshots" (
    "activity_id" uuid not null,
    "snapshot" jsonb not null,
    "seed" text not null,
    "rules_version" text not null
      );


alter table "private"."activity_snapshots" enable row level security;


  create table "private"."boundaries" (
    "slot_index" bigint not null,
    "cutoff_ms" bigint not null,
    "rules_version" text not null,
    "phase" smallint not null default 1,
    "status" text not null default 'running'::text,
    "wait_reason" text,
    "members_frozen" boolean not null default false,
    "member_count" integer,
    "opened_at_ms" bigint not null,
    "updated_at_ms" bigint not null,
    "completed_at_ms" bigint
      );


alter table "private"."boundaries" enable row level security;


  create table "private"."boundary_members" (
    "slot_index" bigint not null,
    "gladiator_id" uuid not null,
    "owner_id" uuid not null
      );


alter table "private"."boundary_members" enable row level security;


  create table "private"."boundary_work" (
    "slot_index" bigint not null,
    "phase" smallint not null,
    "key" text not null,
    "status" text not null default 'pending'::text,
    "detail" jsonb
      );


alter table "private"."boundary_work" enable row level security;


  create table "private"."coordinator" (
    "singleton" boolean not null default true,
    "published_slot" bigint,
    "lease_token" uuid,
    "lease_until_ms" bigint not null default 0,
    "last_error" text,
    "updated_at_ms" bigint
      );


alter table "private"."coordinator" enable row level security;


  create table "private"."dispatch_log" (
    "id" bigint generated always as identity not null,
    "dispatched_at_ms" bigint not null,
    "request_id" bigint,
    "claimable_simple" integer not null,
    "claimable_combat" integer not null
      );


alter table "private"."dispatch_log" enable row level security;


  create table "private"."job_attempts" (
    "job_id" uuid not null,
    "attempt" integer not null,
    "worker_id" uuid,
    "claimed_at_ms" bigint not null,
    "finished_at_ms" bigint,
    "outcome" text,
    "failure_code" text
      );


alter table "private"."job_attempts" enable row level security;


  create table "private"."jobs" (
    "id" uuid not null default gen_random_uuid(),
    "kind" text not null,
    "dedupe_key" text not null,
    "slot_index" bigint not null,
    "gladiator_id" uuid not null,
    "activity_id" uuid,
    "input" jsonb not null,
    "seed" text not null default encode(extensions.gen_random_bytes(32), 'hex'::text),
    "rules_version" text not null,
    "status" text not null default 'pending'::text,
    "due_at_ms" bigint not null,
    "attempts" integer not null default 0,
    "max_attempts" integer not null default 3,
    "lease_token" uuid,
    "lease_owner" uuid,
    "leased_at_ms" bigint,
    "lease_until_ms" bigint,
    "result" jsonb,
    "last_failure" text,
    "created_at_ms" bigint not null default (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric)))::bigint,
    "completed_at_ms" bigint
      );


alter table "private"."jobs" enable row level security;


  create table "private"."rules_versions" (
    "version" text not null,
    "active" boolean not null default false
      );


alter table "private"."rules_versions" enable row level security;


  create table "private"."scheduler" (
    "singleton" boolean not null default true,
    "enabled" boolean not null default false,
    "max_dispatch_per_minute" integer not null default 5
      );


alter table "private"."scheduler" enable row level security;


  create table "private"."settled_slots" (
    "gladiator_id" uuid not null,
    "slot_index" bigint not null,
    "activity_id" uuid not null,
    "receipt_id" uuid not null,
    "resolved_kind" text not null,
    "settled_at_ms" bigint not null
      );


alter table "private"."settled_slots" enable row level security;

CREATE UNIQUE INDEX activity_snapshots_pkey ON private.activity_snapshots USING btree (activity_id);

CREATE INDEX activity_snapshots_rules_idx ON private.activity_snapshots USING btree (rules_version);

CREATE UNIQUE INDEX boundaries_pkey ON private.boundaries USING btree (slot_index);

CREATE INDEX boundaries_rules_idx ON private.boundaries USING btree (rules_version);

CREATE INDEX boundary_members_gladiator_idx ON private.boundary_members USING btree (gladiator_id);

CREATE UNIQUE INDEX boundary_members_pkey ON private.boundary_members USING btree (slot_index, gladiator_id);

CREATE INDEX boundary_work_pending_idx ON private.boundary_work USING btree (slot_index, phase) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX boundary_work_pkey ON private.boundary_work USING btree (slot_index, phase, key);

CREATE UNIQUE INDEX coordinator_pkey ON private.coordinator USING btree (singleton);

CREATE UNIQUE INDEX dispatch_log_pkey ON private.dispatch_log USING btree (id);

CREATE INDEX dispatch_log_time_idx ON private.dispatch_log USING btree (dispatched_at_ms);

CREATE UNIQUE INDEX job_attempts_pkey ON private.job_attempts USING btree (job_id, attempt);

CREATE INDEX jobs_activity_idx ON private.jobs USING btree (activity_id);

CREATE INDEX jobs_claim_idx ON private.jobs USING btree (kind, status, due_at_ms);

CREATE UNIQUE INDEX jobs_dedupe_key_key ON private.jobs USING btree (dedupe_key);

CREATE INDEX jobs_gladiator_idx ON private.jobs USING btree (gladiator_id);

CREATE UNIQUE INDEX jobs_pkey ON private.jobs USING btree (id);

CREATE INDEX jobs_rules_idx ON private.jobs USING btree (rules_version);

CREATE INDEX jobs_slot_idx ON private.jobs USING btree (slot_index, kind, status);

CREATE UNIQUE INDEX rules_versions_one_active_idx ON private.rules_versions USING btree (active) WHERE active;

CREATE UNIQUE INDEX rules_versions_pkey ON private.rules_versions USING btree (version);

CREATE UNIQUE INDEX scheduler_pkey ON private.scheduler USING btree (singleton);

CREATE UNIQUE INDEX settled_slots_activity_id_key ON private.settled_slots USING btree (activity_id);

CREATE UNIQUE INDEX settled_slots_pkey ON private.settled_slots USING btree (gladiator_id, slot_index);

CREATE UNIQUE INDEX settled_slots_receipt_id_key ON private.settled_slots USING btree (receipt_id);

alter table "private"."activity_snapshots" add constraint "activity_snapshots_pkey" PRIMARY KEY using index "activity_snapshots_pkey";

alter table "private"."boundaries" add constraint "boundaries_pkey" PRIMARY KEY using index "boundaries_pkey";

alter table "private"."boundary_members" add constraint "boundary_members_pkey" PRIMARY KEY using index "boundary_members_pkey";

alter table "private"."boundary_work" add constraint "boundary_work_pkey" PRIMARY KEY using index "boundary_work_pkey";

alter table "private"."coordinator" add constraint "coordinator_pkey" PRIMARY KEY using index "coordinator_pkey";

alter table "private"."dispatch_log" add constraint "dispatch_log_pkey" PRIMARY KEY using index "dispatch_log_pkey";

alter table "private"."job_attempts" add constraint "job_attempts_pkey" PRIMARY KEY using index "job_attempts_pkey";

alter table "private"."jobs" add constraint "jobs_pkey" PRIMARY KEY using index "jobs_pkey";

alter table "private"."rules_versions" add constraint "rules_versions_pkey" PRIMARY KEY using index "rules_versions_pkey";

alter table "private"."scheduler" add constraint "scheduler_pkey" PRIMARY KEY using index "scheduler_pkey";

alter table "private"."settled_slots" add constraint "settled_slots_pkey" PRIMARY KEY using index "settled_slots_pkey";

alter table "private"."activity_snapshots" add constraint "activity_snapshots_activity_id_fkey" FOREIGN KEY (activity_id) REFERENCES public.activities(id) not valid;

alter table "private"."activity_snapshots" validate constraint "activity_snapshots_activity_id_fkey";

alter table "private"."activity_snapshots" add constraint "activity_snapshots_rules_version_fkey" FOREIGN KEY (rules_version) REFERENCES private.rules_versions(version) not valid;

alter table "private"."activity_snapshots" validate constraint "activity_snapshots_rules_version_fkey";

alter table "private"."activity_snapshots" add constraint "activity_snapshots_snapshot_check" CHECK ((jsonb_typeof(snapshot) = 'object'::text)) not valid;

alter table "private"."activity_snapshots" validate constraint "activity_snapshots_snapshot_check";

alter table "private"."boundaries" add constraint "boundaries_check" CHECK ((cutoff_ms = (slot_index * 4800000))) not valid;

alter table "private"."boundaries" validate constraint "boundaries_check";

alter table "private"."boundaries" add constraint "boundaries_phase_check" CHECK (((phase >= 1) AND (phase <= 9))) not valid;

alter table "private"."boundaries" validate constraint "boundaries_phase_check";

alter table "private"."boundaries" add constraint "boundaries_rules_version_fkey" FOREIGN KEY (rules_version) REFERENCES private.rules_versions(version) not valid;

alter table "private"."boundaries" validate constraint "boundaries_rules_version_fkey";

alter table "private"."boundaries" add constraint "boundaries_slot_index_check" CHECK ((slot_index >= 1)) not valid;

alter table "private"."boundaries" validate constraint "boundaries_slot_index_check";

alter table "private"."boundaries" add constraint "boundaries_status_check" CHECK ((status = ANY (ARRAY['running'::text, 'waiting'::text, 'complete'::text]))) not valid;

alter table "private"."boundaries" validate constraint "boundaries_status_check";

alter table "private"."boundaries" add constraint "boundaries_wait_reason_check" CHECK ((wait_reason = ANY (ARRAY['settlement'::text, 'extension'::text, 'preparation'::text, 'integration'::text, 'operator'::text, 'straggler'::text]))) not valid;

alter table "private"."boundaries" validate constraint "boundaries_wait_reason_check";

alter table "private"."boundary_members" add constraint "boundary_members_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) not valid;

alter table "private"."boundary_members" validate constraint "boundary_members_gladiator_id_fkey";

alter table "private"."boundary_work" add constraint "boundary_work_key_check" CHECK ((key ~ '^[a-z0-9][a-z0-9:-]{0,63}$'::text)) not valid;

alter table "private"."boundary_work" validate constraint "boundary_work_key_check";

alter table "private"."boundary_work" add constraint "boundary_work_phase_check" CHECK (((phase >= 1) AND (phase <= 8))) not valid;

alter table "private"."boundary_work" validate constraint "boundary_work_phase_check";

alter table "private"."boundary_work" add constraint "boundary_work_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text]))) not valid;

alter table "private"."boundary_work" validate constraint "boundary_work_status_check";

alter table "private"."coordinator" add constraint "coordinator_published_slot_check" CHECK ((published_slot >= 0)) not valid;

alter table "private"."coordinator" validate constraint "coordinator_published_slot_check";

alter table "private"."coordinator" add constraint "coordinator_singleton_check" CHECK (singleton) not valid;

alter table "private"."coordinator" validate constraint "coordinator_singleton_check";

alter table "private"."job_attempts" add constraint "job_attempts_attempt_check" CHECK ((attempt >= 1)) not valid;

alter table "private"."job_attempts" validate constraint "job_attempts_attempt_check";

alter table "private"."job_attempts" add constraint "job_attempts_job_id_fkey" FOREIGN KEY (job_id) REFERENCES private.jobs(id) not valid;

alter table "private"."job_attempts" validate constraint "job_attempts_job_id_fkey";

alter table "private"."job_attempts" add constraint "job_attempts_outcome_check" CHECK ((outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'expired'::text]))) not valid;

alter table "private"."job_attempts" validate constraint "job_attempts_outcome_check";

alter table "private"."jobs" add constraint "jobs_activity_id_fkey" FOREIGN KEY (activity_id) REFERENCES public.activities(id) not valid;

alter table "private"."jobs" validate constraint "jobs_activity_id_fkey";

alter table "private"."jobs" add constraint "jobs_attempts_check" CHECK ((attempts >= 0)) not valid;

alter table "private"."jobs" validate constraint "jobs_attempts_check";

alter table "private"."jobs" add constraint "jobs_dedupe_key_key" UNIQUE using index "jobs_dedupe_key_key";

alter table "private"."jobs" add constraint "jobs_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) not valid;

alter table "private"."jobs" validate constraint "jobs_gladiator_id_fkey";

alter table "private"."jobs" add constraint "jobs_kind_check" CHECK ((kind = ANY (ARRAY['prepare'::text, 'simulation'::text, 'reveal'::text, 'settlement'::text]))) not valid;

alter table "private"."jobs" validate constraint "jobs_kind_check";

alter table "private"."jobs" add constraint "jobs_max_attempts_check" CHECK ((max_attempts >= 1)) not valid;

alter table "private"."jobs" validate constraint "jobs_max_attempts_check";

alter table "private"."jobs" add constraint "jobs_rules_version_fkey" FOREIGN KEY (rules_version) REFERENCES private.rules_versions(version) not valid;

alter table "private"."jobs" validate constraint "jobs_rules_version_fkey";

alter table "private"."jobs" add constraint "jobs_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'completed'::text, 'operator'::text]))) not valid;

alter table "private"."jobs" validate constraint "jobs_status_check";

alter table "private"."rules_versions" add constraint "rules_versions_version_check" CHECK ((version ~ '^v[0-9]+$'::text)) not valid;

alter table "private"."rules_versions" validate constraint "rules_versions_version_check";

alter table "private"."scheduler" add constraint "scheduler_max_dispatch_per_minute_check" CHECK (((max_dispatch_per_minute >= 1) AND (max_dispatch_per_minute <= 5))) not valid;

alter table "private"."scheduler" validate constraint "scheduler_max_dispatch_per_minute_check";

alter table "private"."scheduler" add constraint "scheduler_singleton_check" CHECK (singleton) not valid;

alter table "private"."scheduler" validate constraint "scheduler_singleton_check";

alter table "private"."settled_slots" add constraint "settled_slots_activity_id_key" UNIQUE using index "settled_slots_activity_id_key";

alter table "private"."settled_slots" add constraint "settled_slots_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) not valid;

alter table "private"."settled_slots" validate constraint "settled_slots_gladiator_id_fkey";

alter table "private"."settled_slots" add constraint "settled_slots_receipt_id_key" UNIQUE using index "settled_slots_receipt_id_key";

set check_function_bodies = off;

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
  if new.id<>old.id or new.kind<>old.kind or new.dedupe_key<>old.dedupe_key or new.slot_index<>old.slot_index
    or new.gladiator_id<>old.gladiator_id or new.activity_id is distinct from old.activity_id or new.input<>old.input
    or new.seed<>old.seed or new.rules_version<>old.rules_version or new.attempts<old.attempts then
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
  insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,rules_version,due_at_ms)
    values('settlement','settlement:'||a.id,a.slot_index,a.gladiator_id,a.id,
      jsonb_build_object('activityId',a.id,'gladiatorId',a.gladiator_id,'slotIndex',a.slot_index,'resolvedKind',a.resolved_kind,'endsAtMs',a.ends_at_ms),
      s.rules_version,a.ends_at_ms)
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
  return jsonb_build_object('money',0,'renown',0,'xp',0,'attributePoints',points,'items','[]'::jsonb,'overflowMoney',0);
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

grant delete on table "private"."activity_snapshots" to "service_role";

grant insert on table "private"."activity_snapshots" to "service_role";

grant select on table "private"."activity_snapshots" to "service_role";

grant update on table "private"."activity_snapshots" to "service_role";

grant delete on table "private"."boundaries" to "service_role";

grant insert on table "private"."boundaries" to "service_role";

grant select on table "private"."boundaries" to "service_role";

grant update on table "private"."boundaries" to "service_role";

grant delete on table "private"."boundary_members" to "service_role";

grant insert on table "private"."boundary_members" to "service_role";

grant select on table "private"."boundary_members" to "service_role";

grant update on table "private"."boundary_members" to "service_role";

grant delete on table "private"."boundary_work" to "service_role";

grant insert on table "private"."boundary_work" to "service_role";

grant select on table "private"."boundary_work" to "service_role";

grant update on table "private"."boundary_work" to "service_role";

grant delete on table "private"."coordinator" to "service_role";

grant insert on table "private"."coordinator" to "service_role";

grant select on table "private"."coordinator" to "service_role";

grant update on table "private"."coordinator" to "service_role";

grant select on table "private"."dispatch_log" to "service_role";

grant delete on table "private"."job_attempts" to "service_role";

grant insert on table "private"."job_attempts" to "service_role";

grant select on table "private"."job_attempts" to "service_role";

grant update on table "private"."job_attempts" to "service_role";

grant delete on table "private"."jobs" to "service_role";

grant insert on table "private"."jobs" to "service_role";

grant select on table "private"."jobs" to "service_role";

grant update on table "private"."jobs" to "service_role";

grant select on table "private"."rules_versions" to "service_role";

grant select on table "private"."scheduler" to "service_role";

grant delete on table "private"."settled_slots" to "service_role";

grant insert on table "private"."settled_slots" to "service_role";

grant select on table "private"."settled_slots" to "service_role";

grant update on table "private"."settled_slots" to "service_role";


  create policy "backend_only"
  on "private"."activity_snapshots"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."boundaries"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."boundary_members"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."boundary_work"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."coordinator"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."dispatch_log"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."job_attempts"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."jobs"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."rules_versions"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."scheduler"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "backend_only"
  on "private"."settled_slots"
  as permissive
  for all
  to service_role
using (true)
with check (true);


CREATE TRIGGER guard_frozen BEFORE UPDATE ON private.activity_snapshots FOR EACH ROW EXECUTE FUNCTION private.guard_frozen();

CREATE TRIGGER guard_job BEFORE DELETE OR UPDATE ON private.jobs FOR EACH ROW EXECUTE FUNCTION private.guard_job();

CREATE TRIGGER guard_frozen BEFORE DELETE OR UPDATE ON private.settled_slots FOR EACH ROW EXECUTE FUNCTION private.guard_frozen();

-- Reviewed completion of the CLI diff: source-equivalent seeds, view option, ACLs and scheduler registration.
insert into private.rules_versions(version,active) values('v1',true) on conflict do nothing;
insert into private.coordinator(singleton) values(true) on conflict do nothing;
insert into private.scheduler(singleton) values(true) on conflict do nothing;
alter view public.owner_state set (security_invoker=true);
revoke all on public.activities from public,anon,authenticated,service_role;
grant select on public.activities to authenticated;
grant select,insert,update,delete on public.activities to service_role;
do $$ declare t text; begin
  foreach t in array array['activity_snapshots','coordinator','rules_versions','boundaries','boundary_members','boundary_work',
    'jobs','job_attempts','settled_slots','scheduler','dispatch_log'] loop
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
    execute format('grant %s on private.%I to service_role',
      case when t in ('rules_versions','scheduler','dispatch_log') then 'select' else 'select,insert,update,delete' end,t);
  end loop;
end $$;
revoke all on function public.advance_boundary(bigint,uuid),public.coordinate_work(),public.claim_jobs(uuid,text,integer),public.renew_job(uuid,uuid),
  public.complete_job(uuid,uuid,jsonb),public.fail_job(uuid,uuid,text),public.settle_activity(uuid,uuid),
  private.guard_job(),private.guard_frozen(),private.slot_phase(bigint),private.active_rules_version(),private.boundary_close_season(bigint),
  private.boundary_recompute_leagues(bigint),private.boundary_pair(bigint),private.activity_executor_ready(text),private.prepare_activity_jobs(uuid),
  private.boundary_published(bigint),private.settle_rewards(uuid),private.accept_job_result(uuid,jsonb),private.boundary_settle_previous(bigint),
  private.boundary_apply_changes(bigint),private.boundary_recompute(bigint),private.boundary_snapshot(bigint),private.boundary_check_stamina(bigint),
  private.boundary_start(bigint),private.valid_preparation(uuid,jsonb),private.resume_operator_job(uuid),private.dispatch_workers(),private.cron_tick()
  from public,anon,authenticated,service_role;
grant execute on function public.advance_boundary(bigint,uuid),public.coordinate_work(),public.claim_jobs(uuid,text,integer),public.renew_job(uuid,uuid),
  public.complete_job(uuid,uuid,jsonb),public.fail_job(uuid,uuid,text),public.settle_activity(uuid,uuid),
  private.guard_job(),private.guard_frozen(),private.slot_phase(bigint),private.active_rules_version(),private.boundary_close_season(bigint),
  private.boundary_recompute_leagues(bigint),private.boundary_pair(bigint),private.activity_executor_ready(text),private.prepare_activity_jobs(uuid),
  private.boundary_published(bigint),private.settle_rewards(uuid),private.accept_job_result(uuid,jsonb),private.boundary_settle_previous(bigint),
  private.boundary_apply_changes(bigint),private.boundary_recompute(bigint),private.boundary_snapshot(bigint),private.boundary_check_stamina(bigint),
  private.boundary_start(bigint),private.valid_preparation(uuid,jsonb),private.resume_operator_job(uuid)
  to service_role;
select cron.schedule('cloudiator-coordinate','* * * * *','select private.cron_tick()');
notify pgrst,'reload schema';
