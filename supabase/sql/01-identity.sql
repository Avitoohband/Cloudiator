-- Reapplicable local source. Deploy only the generated immutable migration.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;

create table if not exists public.gladiators (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id),
  name text not null check (name = btrim(name) and name ~ '^[A-Za-z0-9 _-]{3,20}$'),
  normalized_name text generated always as (lower(name collate "C")) stored unique,
  level bigint not null default 1 check (level between 1 and 1000000000),
  xp bigint not null default 0 check (xp between 0 and 9007199254740991),
  earned_points bigint not null default 10 check (earned_points between 10 and 1000000000),
  unspent_points bigint not null default 0 check (unspent_points between 0 and earned_points),
  league text not null default 'bronze' check (league in ('bronze','silver','gold','champion')),
  peak_strength numeric not null default 0 check (peak_strength >= 0),
  rating bigint not null default 1000 check (rating between 0 and 9007199254740991),
  stamina_current bigint not null check (stamina_current >= 0),
  stamina_maximum bigint not null check (stamina_maximum between 1 and 9007199254740991 and stamina_current <= stamina_maximum),
  tournament_opt_in boolean not null default false,
  processed_slot_index bigint not null check (processed_slot_index >= 0),
  created_at_ms bigint not null,
  orientation_end_ms bigint not null check (orientation_end_ms > created_at_ms and orientation_end_ms % 4800000 = 0)
);
create table if not exists public.builds (
  gladiator_id uuid primary key references public.gladiators(id),
  current_build jsonb not null check (jsonb_typeof(current_build)='object'),
  pending_build jsonb check (jsonb_typeof(pending_build)='object')
);
create table if not exists public.schedules (
  gladiator_id uuid primary key references public.gladiators(id),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  schedule jsonb not null check (jsonb_typeof(schedule)='object')
);
create table if not exists public.wallets (
  gladiator_id uuid primary key references public.gladiators(id),
  money bigint not null default 100 check (money between 0 and 9007199254740991),
  renown bigint not null default 0 check (renown between 0 and 9007199254740991)
);
create table if not exists public.item_instances (
  id uuid primary key,
  gladiator_id uuid not null references public.gladiators(id),
  item jsonb not null check (jsonb_typeof(item)='object' and item->>'id'=id::text and item->>'ownerId'=gladiator_id::text
    and jsonb_typeof(item->'quantity')='number' and (item->>'quantity')::numeric between 1 and 999
    and trunc((item->>'quantity')::numeric)=(item->>'quantity')::numeric)
);
create index if not exists item_instances_gladiator_idx on public.item_instances(gladiator_id);
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  gladiator_id uuid not null references public.gladiators(id),
  operation_id uuid not null,
  money bigint not null check (money between 0 and 9007199254740991),
  renown bigint not null default 0 check (renown between 0 and 9007199254740991),
  status text not null check (status in ('held','consumed','refunded')),
  unique(gladiator_id, operation_id)
);
create table if not exists public.operation_receipts (
  owner_id uuid not null references auth.users(id),
  operation_id uuid not null,
  receipt_id uuid not null unique default gen_random_uuid(),
  gladiator_id uuid references public.gladiators(id),
  request jsonb not null,
  request_digest bytea not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, operation_id)
);
create index if not exists operation_receipts_gladiator_idx on public.operation_receipts(gladiator_id);
create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  gladiator_id uuid not null references public.gladiators(id),
  receipt_id uuid not null unique references public.operation_receipts(receipt_id),
  money_delta bigint not null check (money_delta between -9007199254740991 and 9007199254740991),
  renown_delta bigint not null check (renown_delta between -9007199254740991 and 9007199254740991),
  reason text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists wallet_ledger_gladiator_idx on public.wallet_ledger(gladiator_id);
create table if not exists private.command_attempts (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id),
  is_creation boolean not null,
  attempted_at timestamptz not null default clock_timestamp()
);
create index if not exists command_attempts_actor_time_idx on private.command_attempts(actor_id,is_creation,attempted_at);
alter table private.command_attempts enable row level security;
drop policy if exists backend_only on private.command_attempts;
create policy backend_only on private.command_attempts to service_role using (true) with check (true);
revoke all on private.command_attempts from public, anon, authenticated;
grant select, insert, delete on private.command_attempts to service_role;

-- No client mutation grants. service_role is server-only; every mutation RPC remains SECURITY INVOKER.
do $$
declare table_name text;
begin
  foreach table_name in array array['gladiators','builds','schedules','wallets','item_instances','reservations','operation_receipts','wallet_ledger'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    execute format('drop policy if exists owner_read on public.%I', table_name);
    if table_name in ('gladiators','operation_receipts') then
      execute format('create policy owner_read on public.%I for select to authenticated using (owner_id = (select auth.uid()))', table_name);
    else
      execute format('create policy owner_read on public.%I for select to authenticated using (gladiator_id in (select id from public.gladiators where owner_id = (select auth.uid())))', table_name);
    end if;
  end loop;
end $$;

create or replace view public.owner_state with (security_invoker = true) as
select g.owner_id, jsonb_build_object(
  'gladiatorId', g.id, 'name', g.name, 'currentBuild', b.current_build, 'pendingBuild', b.pending_build,
  'schedule', s.schedule, 'scheduleVersion', s.version,
  'wallets', jsonb_build_object('money',w.money,'renown',w.renown),
  'reservedFees', jsonb_build_object('money',coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0),
    'renown',coalesce((select sum(r.renown) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0)),
  'inventory', coalesce((select jsonb_agg(i.item order by i.id) from public.item_instances i where i.gladiator_id=g.id),'[]'::jsonb),
  'inventoryCapacity',60,
  'progression',jsonb_build_object('level',g.level,'xp',g.xp,'earnedAttributePoints',g.earned_points,'unspentAttributePoints',g.unspent_points,
    'league',g.league,'peakStrength',g.peak_strength,'rating',g.rating),
  'stamina',jsonb_build_object('current',g.stamina_current,'maximum',g.stamina_maximum),
  'tournamentOptIn',g.tournament_opt_in,'processedSlotIndex',g.processed_slot_index,
  'currentActivity',jsonb_build_object('id',g.id,'kind','orientation','status',
    case when extract(epoch from statement_timestamp())*1000 < g.orientation_end_ms then 'active' else 'processing' end,
    'startsAtMs',g.created_at_ms,'endsAtMs',g.orientation_end_ms,'label','Orientation')
) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id;
revoke all on public.owner_state from public, anon, authenticated, service_role;
grant select on public.owner_state to authenticated, service_role;

-- Separate rolling budgets: handler charges the general budget once, then the creation budget if its kind is creation.
create or replace function public.consume_command_rate(actor_id uuid, is_creation boolean) returns integer
language plpgsql security invoker set search_path = '' as $$
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
end $$;
revoke all on function public.consume_command_rate(uuid,boolean) from public, anon, authenticated;
grant execute on function public.consume_command_rate(uuid,boolean) to service_role;

create or replace function public.create_gladiator(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare command jsonb := input->'command'; allocation jsonb; total numeric; value jsonb; stat jsonb;
  existing public.operation_receipts%rowtype; result jsonb; gid uuid := gen_random_uuid(); receipt uuid := gen_random_uuid();
  weapon_id uuid := gen_random_uuid(); body_id uuid := gen_random_uuid(); now_ms bigint; slot bigint; item jsonb; item_id uuid; n integer := 0;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(input) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (select count(*) from jsonb_object_keys(input)) <> 3 or not (input ?& array['command','starterItems','staminaMaximum'])
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
  now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  slot := now_ms / 4800000;
  begin
    insert into public.gladiators(id,owner_id,name,stamina_current,stamina_maximum,processed_slot_index,created_at_ms,orientation_end_ms)
      values(gid,actor_id,command->>'name',(input->>'staminaMaximum')::bigint,(input->>'staminaMaximum')::bigint,slot,now_ms,(slot+1)*4800000);
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
end $$;
revoke all on function public.create_gladiator(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.create_gladiator(uuid,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
