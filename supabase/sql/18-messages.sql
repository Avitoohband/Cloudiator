-- Game messages and fixed class and points (2026-10-28) reapplicable source. Committed M01-M24 are immutable; deploy only the
-- separately generated migration M25 (supabase/migrations/*_messages.sql). Spec:
-- docs/superpowers/specs/2026-10-27-game-messages-design.md ("Added 2026-10-28: fixed class and points"); plan: the next
-- patch's messages plan, Task 1. Later tasks add the message sections below this one.
--
-- 1. private.planning_command: 16-launch-feedback.sql's body, plus in the queue-build branch
--    - a class change is `invalid`: the command's classId must equal the CURRENT build's (b.current_build->>'classId');
--    - taking a point back is `invalid`: no attribute of the command's allocation may be below the CURRENT build's value.
--      The floor is the current build, not the pending one: points become fixed when a build takes effect, so a pending build
--      can still be revised down to the current values (not below) and cancelled. Stance, equipment and more points stay free;
--    - the fee rule is `fee<>0` -> `invalid` (it was `fee not in (0,100,200)`): no build change costs gold any more, because
--      respec and class changes are gone until they return as paid, real-money options (nothing of that is built here).
--    The Edge preparation refuses the same two changes first (lockedChange in supabase/functions/_shared/domain/build.ts, used by
--      prepareBuild), so SQL's check is the database's own guarantee. Builds already pending at deploy keep their fee and class
--      and apply as queued (private.apply_pending_build is unchanged and reads the held reservation); a replay of a committed
--      operation is answered from its receipt before any of this, so it is unchanged.
--
--    Section 1 changes the rules in place in v1 (docs/operations/runbook.md, "Retained-rule deployments"): no executor of a job in
--    flight reads the fee or the class.
-- 2. public.change_appearance: the free, unlimited look change of the caller's own gladiator (Task 2; described at its function).
--
-- Every statement is reapplicable.
begin;

-- Lock order and clock as 02-build-schedule.sql: account lock, receipt, character row, then builds, schedules, wallet and
-- items; private.planning_now_ms() sampled after the character lock. Restated from 16-launch-feedback.sql with the queue-build
-- change marked "Fixed class and points" and nothing else.
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
          or exists(select 1 from jsonb_each(b.current_build->'allocations') a where coalesce((c->'allocation'->a.key)<a.value,true)) then err:='invalid';
        -- No build change costs gold any more (it was fee not in (0,100,200)).
        elsif fee<>0 then err:='invalid';
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

revoke all on function private.planning_command(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function private.planning_command(uuid,uuid,jsonb,text) to service_role;

-- 2. public.change_appearance(actor_id, operation_id, input): the free, unlimited look change of the caller's own gladiator
--    (spec Goal 4, "Change look command"). Shaped like public.set_tournament_opt_in (09-tournaments.sql): the account lock, the
--    receipt replay (a replay returns the stored result, the same operation with another body is `conflict`, both before any shape
--    check), the command's exact keys (`appearance`, `kind`, `operationId`), `private.valid_appearance` (17-appearance.sql: the same
--    look rules as creation; an invalid look is `invalid` and writes no receipt), the caller's own gladiator `for update`
--    (`not-found` for an account without one: the command names no gladiator, so no other can change), the update only when the
--    look differs, then the receipt. A legacy gladiator (appearance null) is changed like any other. The update fires the deferred
--    project_changed_character trigger (06-projections.sql), which republishes the world actor and raises the world revision; an
--    unchanged look updates nothing, so it publishes nothing. There is no count or cooldown: the Edge command rate limit is the
--    only limit. Unlike the opt-in it never answers `processing`: a look does not depend on the world clock.
--    Result: {ok:true, receiptId, value:{appearance, receivedAtMs}}. Backend only (EXECUTE for service_role).
create or replace function public.change_appearance(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prior public.operation_receipts%rowtype; g public.gladiators%rowtype; now_ms bigint;
  receipt uuid:=gen_random_uuid(); result jsonb;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=change_appearance.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['appearance','kind','operationId']
    or c->>'kind' is distinct from 'change-appearance' or c->>'operationId' is distinct from operation_id::text
    or not private.valid_appearance(c->'appearance') then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms();
  update public.gladiators set appearance=c->'appearance' where id=g.id and appearance is distinct from c->'appearance';
  result:=jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('appearance',c->'appearance','receivedAtMs',now_ms));
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  return result;
end $$;

revoke all on function public.change_appearance(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.change_appearance(uuid,uuid,jsonb) to service_role;

notify pgrst,'reload schema';
commit;
