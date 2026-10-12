-- Reapplicable source; M02 is generated separately by the CLI.
begin;
alter table public.builds add column if not exists version bigint not null default 1 check (version between 1 and 9007199254740991);

create table if not exists public.schedule_revisions (
  gladiator_id uuid not null references public.gladiators(id),
  version bigint not null check (version >= 1),
  phase text not null check (phase in ('morning','afternoon','evening')),
  choice jsonb not null,
  received_at_ms bigint not null,
  effective_slot_index bigint not null,
  primary key (gladiator_id,phase,version)
);
create index if not exists schedule_revisions_effective_idx on public.schedule_revisions(gladiator_id,phase,effective_slot_index desc,version desc);
create table if not exists public.pending_build_items (
  item_id uuid primary key references public.item_instances(id),
  gladiator_id uuid not null references public.gladiators(id),
  operation_id uuid not null
);
create index if not exists pending_build_items_gladiator_idx on public.pending_build_items(gladiator_id);
create table if not exists private.pending_build_preparations (
  gladiator_id uuid primary key references public.gladiators(id),
  operation_id uuid not null,
  snapshot jsonb not null,
  stamina_maximum bigint not null check (stamina_maximum >= 90),
  received_at_ms bigint not null
);
alter table private.pending_build_preparations enable row level security;
revoke all on private.pending_build_preparations from public,anon,authenticated;
grant select,insert,update,delete on private.pending_build_preparations to service_role;
drop policy if exists backend_only on private.pending_build_preparations;
create policy backend_only on private.pending_build_preparations to service_role using(true) with check(true);
do $$ declare t text; begin
  foreach t in array array['schedule_revisions','pending_build_items'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to service_role',t);
    execute format('drop policy if exists owner_read on public.%I',t);
    execute format('create policy owner_read on public.%I for select to authenticated using (gladiator_id in (select id from public.gladiators where owner_id=(select auth.uid())))',t);
  end loop;
end $$;

-- No player-controlled time argument or session setting. Tests replace this function only inside rollback-only operator transactions.
create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path='' as $$
  select floor(extract(epoch from clock_timestamp())*1000)::bigint
$$;
create or replace function private.schedule_effective_slot(phase text, now_ms bigint) returns bigint language sql immutable strict security invoker set search_path='' as $$
  select now_ms/4800000 + coalesce(nullif(((array_position(array['morning','afternoon','evening'],phase)-1)-(now_ms/4800000)%3+3)%3,0),3)
$$;
create or replace function private.initial_schedule_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index)
    select new.gladiator_id,new.version,e.key,e.value,g.created_at_ms,g.processed_slot_index+1
    from public.gladiators g cross join jsonb_each(new.schedule) e where g.id=new.gladiator_id;
  return new;
end $$;
drop trigger if exists initial_schedule_revision on public.schedules;
create trigger initial_schedule_revision after insert on public.schedules for each row execute function private.initial_schedule_revision();
insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index)
  select s.gladiator_id,s.version,e.key,e.value,g.created_at_ms,g.processed_slot_index+1
  from public.schedules s join public.gladiators g on g.id=s.gladiator_id cross join jsonb_each(s.schedule) e
  where not exists(select 1 from public.schedule_revisions r where r.gladiator_id=s.gladiator_id)
  on conflict do nothing;

-- Task8 sale/list/discard transactions must take the account/character lock and require reservation=null.
-- This guard additionally protects both active and pending references against transfer, deletion or quantity/stat mutation.
create or replace function private.guard_reserved_item() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.item->'reservation' <> 'null'::jsonb or exists(select 1 from public.pending_build_items p where p.item_id=old.id) then
    if tg_op='DELETE' then raise exception 'reserved item'; end if;
    if new.id<>old.id or new.gladiator_id<>old.gladiator_id or (new.item-'reservation')<>(old.item-'reservation') then raise exception 'reserved item'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists guard_reserved_item on public.item_instances;
create trigger guard_reserved_item before update or delete on public.item_instances for each row execute function private.guard_reserved_item();

create or replace function private.planning_command(actor_id uuid, operation_id uuid, input jsonb, kind text) returns jsonb
language plpgsql security invoker set search_path='' as $$
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
end $$;
create or replace function public.edit_schedule(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.planning_command(actor_id,operation_id,input,'edit-schedule')
$$;
create or replace function public.queue_build(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.planning_command(actor_id,operation_id,input,'queue-build')
$$;
create or replace function public.cancel_build(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.planning_command(actor_id,operation_id,input,'cancel-build')
$$;

-- Task7 owns settlement and global cutoff ordering. Invoke only inside that transaction, after prior-slot settlement.
create or replace function private.apply_pending_build(gid uuid,boundary_slot bigint) returns boolean
language plpgsql security invoker set search_path='' as $$
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
end $$;

-- Preserve the existing protected DTO projection and add only its canonical build edit version.
create or replace view public.owner_state with (security_invoker=true) as
select g.owner_id,jsonb_build_object(
  'gladiatorId',g.id,'name',g.name,'currentBuild',b.current_build,'pendingBuild',b.pending_build,'buildVersion',b.version,
  'schedule',s.schedule,'scheduleVersion',s.version,'wallets',jsonb_build_object('money',w.money,'renown',w.renown),
  'reservedFees',jsonb_build_object('money',coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0),
    'renown',coalesce((select sum(r.renown) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0)),
  'inventory',coalesce((select jsonb_agg(i.item order by i.id) from public.item_instances i where i.gladiator_id=g.id),'[]'::jsonb),'inventoryCapacity',60,
  'progression',jsonb_build_object('level',g.level,'xp',g.xp,'earnedAttributePoints',g.earned_points,'unspentAttributePoints',g.unspent_points,'league',g.league,'peakStrength',g.peak_strength,'rating',g.rating),
  'stamina',jsonb_build_object('current',g.stamina_current,'maximum',g.stamina_maximum),'tournamentOptIn',g.tournament_opt_in,'processedSlotIndex',g.processed_slot_index,
  'currentActivity',jsonb_build_object('id',g.id,'kind','orientation','status',case when extract(epoch from statement_timestamp())*1000<g.orientation_end_ms then 'active' else 'processing' end,
    'startsAtMs',g.created_at_ms,'endsAtMs',g.orientation_end_ms,'label','Orientation')) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id;

revoke all on function public.edit_schedule(uuid,uuid,jsonb),public.queue_build(uuid,uuid,jsonb),public.cancel_build(uuid,uuid,jsonb),
  private.planning_command(uuid,uuid,jsonb,text),private.planning_now_ms(),private.schedule_effective_slot(text,bigint),private.initial_schedule_revision(),private.guard_reserved_item(),private.apply_pending_build(uuid,bigint) from public,anon,authenticated;
grant execute on function public.edit_schedule(uuid,uuid,jsonb),public.queue_build(uuid,uuid,jsonb),public.cancel_build(uuid,uuid,jsonb),
  private.planning_command(uuid,uuid,jsonb,text),private.planning_now_ms(),private.schedule_effective_slot(text,bigint),private.initial_schedule_revision(),private.guard_reserved_item(),private.apply_pending_build(uuid,bigint) to service_role;
notify pgrst,'reload schema';
commit;
