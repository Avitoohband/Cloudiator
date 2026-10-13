-- Reapplicable Task 8 source. Deploy the separately generated migration.
-- Mutation order: account advisory lock, character, wallet, items ordered by UUID.
-- Trusted canonical catalog preparation comes from the backend, never the HTTP payload.
begin;
create table if not exists public.owned_cosmetics (
  gladiator_id uuid not null references public.gladiators(id),
  catalog_id text not null check(catalog_id='banner'),
  catalog_version text not null check(catalog_version='v1'),
  binding text not null default 'bound' check(binding='bound'),
  primary key(gladiator_id,catalog_id)
);
alter table public.owned_cosmetics enable row level security;
revoke all on public.owned_cosmetics from public,anon,authenticated,service_role;
grant select on public.owned_cosmetics to authenticated;
grant select,insert on public.owned_cosmetics to service_role;
drop policy if exists owner_read on public.owned_cosmetics;
create policy owner_read on public.owned_cosmetics for select to authenticated using
  (gladiator_id in (select id from public.gladiators where owner_id=(select auth.uid())));
create or replace function private.guard_cosmetic() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'bound cosmetic'; end $$;
drop trigger if exists guard_cosmetic on public.owned_cosmetics;
create trigger guard_cosmetic before update or delete on public.owned_cosmetics for each row execute function private.guard_cosmetic();
revoke all on function private.guard_cosmetic() from public,anon,authenticated;
grant execute on function private.guard_cosmetic() to service_role;

create or replace function private.guard_inventory_item() returns trigger language plpgsql security invoker set search_path='' as $$
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
end $$;
drop trigger if exists guard_inventory_item on public.item_instances;
create trigger guard_inventory_item before insert or update on public.item_instances for each row execute function private.guard_inventory_item();

create or replace function private.guard_historical_strength() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.peak_strength<old.peak_strength then raise exception 'historical strength decrease'; end if;
  return new;
end $$;
drop trigger if exists guard_historical_strength on public.gladiators;
create trigger guard_historical_strength before update on public.gladiators for each row execute function private.guard_historical_strength();

-- Returns NULL on a stale baseline. No wallet credit or receipt: settlement must own those atomically.
-- The caller's permanent settlement/operation receipt is the replay guard; a no-op plan is not itself a replay guard.
create or replace function private.apply_inventory_plan(gid uuid, prepared jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
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
end $$;

create or replace function private.inventory_command(actor_id uuid, operation_id uuid, input jsonb, kind text) returns jsonb
language plpgsql security invoker set search_path='' as $$
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
end $$;
create or replace function public.buy_shop(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.inventory_command(actor_id,operation_id,input,'buy-shop')
$$;
create or replace function public.sell_item(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.inventory_command(actor_id,operation_id,input,'sell-item')
$$;
create or replace function public.discard_item(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.inventory_command(actor_id,operation_id,input,'discard-item')
$$;
revoke all on function private.guard_inventory_item(),private.guard_historical_strength(),private.apply_inventory_plan(uuid,jsonb),
  private.inventory_command(uuid,uuid,jsonb,text),public.buy_shop(uuid,uuid,jsonb),public.sell_item(uuid,uuid,jsonb),public.discard_item(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.guard_inventory_item(),private.guard_historical_strength(),private.apply_inventory_plan(uuid,jsonb),
  private.inventory_command(uuid,uuid,jsonb,text),public.buy_shop(uuid,uuid,jsonb),public.sell_item(uuid,uuid,jsonb),public.discard_item(uuid,uuid,jsonb) to service_role;
create or replace function public.create_gladiator(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
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
end $$;
-- Before Task8 only the fixed starter loadout was acquirable; initialize its canonical score without decreasing history.
update public.gladiators set peak_strength=greatest(peak_strength,28);
create or replace view public.owner_state with (security_invoker=true) as
select g.owner_id,jsonb_build_object(
  'gladiatorId',g.id,'name',g.name,'currentBuild',b.current_build,'pendingBuild',b.pending_build,'buildVersion',b.version,
  'schedule',s.schedule,'scheduleVersion',s.version,'wallets',jsonb_build_object('money',w.money,'renown',w.renown),
  'reservedFees',jsonb_build_object('money',coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0),
    'renown',coalesce((select sum(r.renown) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0)),
  'inventory',coalesce((select jsonb_agg(i.item order by i.id) from public.item_instances i where i.gladiator_id=g.id),'[]'::jsonb),'inventoryCapacity',60,
  'ownedCosmetics',coalesce((select jsonb_agg(jsonb_build_object('catalogId',c.catalog_id,'catalogVersion',c.catalog_version,'binding',c.binding) order by c.catalog_id) from public.owned_cosmetics c where c.gladiator_id=g.id),'[]'::jsonb),
  'progression',jsonb_build_object('level',g.level,'xp',g.xp,'earnedAttributePoints',g.earned_points,'unspentAttributePoints',g.unspent_points,'league',g.league,'peakStrength',g.peak_strength,'rating',g.rating),
  'stamina',jsonb_build_object('current',g.stamina_current,'maximum',g.stamina_maximum),'tournamentOptIn',g.tournament_opt_in,'processedSlotIndex',g.processed_slot_index,
  'currentActivity',coalesce((select jsonb_build_object('id',a.id,'kind',coalesce(a.resolved_kind,a.requested->>'kind'),
      'status',case when a.status='completed' then 'completed' when a.status='preparing' then 'queued'
        when extract(epoch from statement_timestamp())*1000<a.ends_at_ms then 'active' else 'processing' end,
      'startsAtMs',a.starts_at_ms,'endsAtMs',a.ends_at_ms,
      'label',case coalesce(a.resolved_kind,a.requested->>'kind') when 'training' then 'Training'
        when 'rest' then case when a.fallback then 'Resting (not enough stamina)' else 'Resting' end
        when 'expedition' then 'Expedition' when 'arena' then 'Arena' else 'Tournament' end)
    from public.activities a where a.gladiator_id=g.id order by a.slot_index desc limit 1),
    jsonb_build_object('id',g.id,'kind','orientation','status',case when extract(epoch from statement_timestamp())*1000<g.orientation_end_ms then 'active' else 'processing' end,
      'startsAtMs',g.created_at_ms,'endsAtMs',g.orientation_end_ms,'label','Orientation'))) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id;

create or replace function private.boundary_recompute(target bigint) returns text language plpgsql security invoker set search_path='' as $$
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
end $$;
notify pgrst,'reload schema';
commit;
