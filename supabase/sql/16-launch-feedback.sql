-- Launch feedback (2026-10-25) reapplicable source. Committed M01-M22 are immutable; deploy only the separately generated
-- migration M23 (supabase/migrations/*_launch_feedback.sql). Spec: docs/superpowers/specs/2026-10-25-launch-feedback-design.md
-- ("The change surface", "Settled after the builder check"); plan: docs/superpowers/plans/2026-10-25-launch-feedback.md, Task 2.
--
-- 1. private.planning_command: 02-build-schedule.sql's body, plus
--    - Arena only in the evening (RULES_V1.schedule.arenaPhases, restated): Arena in the morning or the afternoon is `invalid`
--      for edit-schedule and for edit-day-schedule. It is checked at command time, like the expedition level; the boundary
--      does not re-check the phase.
--    - edit-day-schedule {kind, operationId, expectedVersion, day: {morning, afternoon, evening}}: the whole day saved at
--      once, every changed part or none. It keeps the planning order: the account lock, receipt replay, the command shape
--      (`invalid`, not stored), the character lock, the database time after the locks, the processing gate (not stored), the
--      schedule version (`conflict`, stored), every part's choice as edit-schedule checks one (`invalid`, stored), then one
--      version bump: jsonb_set and one revision for each part whose choice changes, each at its own schedule_effective_slot.
--      A day with no change is `invalid`. Its value is DayScheduleValue (contracts/commands.ts): {version, receivedAtMs,
--      parts: {morning|afternoon|evening: {effectiveSlotIndex, effectiveAtMs} | null}}, null for an unchanged part.
-- 2. public.edit_day_schedule(actor_id, operation_id, input): the backend-only wrapper, granted as edit_schedule is.
-- 3. private.market_command: 12-market.sql's body, plus a fee of 5 % floored but at least 1 gold, greatest(1, price*5/100),
--    and listing prices from 2 to 1,000,000,000 (a price shape error is `invalid` with no receipt), so a seller always
--    receives at least 1 and no sale moves money for free. The tables' price CHECKs stay `between 1 and 1000000000`: a price
--    never changes, and no open listing below 2 existed when this shipped (an earlier one would still sell, its seller
--    receiving 0). Total currency changes only by the fee.
-- 4. The deploy-time backfill between the marker comments below (tests/db/launch-feedback-backfill.test.ts runs exactly that
--    span and checks that M23 ships it).
--
-- The rules change in place in v1 (docs/operations/runbook.md, "Retained-rule deployments"): no executor of a job in flight
-- reads the phase rule or the fee. Every statement is reapplicable.
begin;

-- Lock order and clock as 02-build-schedule.sql: account lock, receipt, character row, then builds, schedules, wallet and
-- items; private.planning_now_ms() sampled after the character lock.
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
create or replace function public.edit_day_schedule(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.planning_command(actor_id,operation_id,input,'edit-day-schedule')
$$;

create or replace function private.market_command(actor_id uuid,operation_id uuid,input jsonb,kind text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prep jsonb:=input->'prepared'; prior public.operation_receipts%rowtype;
  g public.gladiators%rowtype; s public.gladiators%rowtype; w public.wallets%rowtype; sw public.wallets%rowtype;
  l private.market_listings%rowtype; offered jsonb; result jsonb; err text; receipt uuid:=gen_random_uuid(); sale_receipt uuid:=gen_random_uuid();
  sale_request jsonb; target uuid; listing uuid; price bigint; fee bigint; now_ms bigint; buyer_gid uuid; seller_gid uuid; seller_owner uuid;
  listed_item uuid; account record; available numeric; baseline numeric; next_peak numeric;
  uuid_shape constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' or kind is null
    or kind not in ('create-listing','cancel-listing','buy-listing') then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if kind='buy-listing' then
    -- Unlocked reads choose the lock set only (a listing's seller and item never change); all else is read under the locks.
    select x.id into buyer_gid from public.gladiators x where x.owner_id=actor_id;
    if jsonb_typeof(c->'listingId')='string' and c->>'listingId' ~ uuid_shape then
      select m.seller_gladiator_id,x.owner_id,m.item_id into seller_gid,seller_owner,listed_item
        from private.market_listings m join public.gladiators x on x.id=m.seller_gladiator_id where m.id=(c->>'listingId')::uuid;
    end if;
  end if;
  if buyer_gid is not null and seller_gid is not null then
    -- Both account locks in gladiator order, as boundary_start takes every member's: a purchase cannot deadlock a boundary.
    for account in select x.owner from (values (buyer_gid,actor_id),(seller_gid,seller_owner)) x(gid,owner) order by x.gid loop
      perform pg_advisory_xact_lock(hashtextextended(account.owner::text,0));
    end loop;
  else
    perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  end if;
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=market_command.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;

  -- Shape: invalid, never recorded. Whole prices from 2 to 1,000,000,000 (Decision 2; the lowest price 2 is launch feedback's).
  if c->>'kind' is distinct from kind or c->>'operationId' is distinct from operation_id::text then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if kind='create-listing' then
    if (select count(*) from jsonb_object_keys(c))<>4 or not(c ?& array['kind','operationId','itemId','price'])
      or jsonb_typeof(c->'itemId') is distinct from 'string' or c->>'itemId' !~ uuid_shape
      or jsonb_typeof(c->'price') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (c->>'price')::numeric not between 2 and 1000000000 or trunc((c->>'price')::numeric)<>(c->>'price')::numeric then
      return jsonb_build_object('ok',false,'code','invalid'); end if;
    target:=(c->>'itemId')::uuid; price:=(c->>'price')::bigint;
  else
    if (select count(*) from jsonb_object_keys(c))<>3 or not(c ?& array['kind','operationId','listingId'])
      or jsonb_typeof(c->'listingId') is distinct from 'string' or c->>'listingId' !~ uuid_shape then
      return jsonb_build_object('ok',false,'code','invalid'); end if;
    listing:=(c->>'listingId')::uuid;
  end if;
  if kind='buy-listing' then
    -- Decision 8: the backend's historical-strength preparation for the buyer, checked against the baseline below.
    if jsonb_typeof(prep) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select count(*) from jsonb_object_keys(prep))<>2 or jsonb_typeof(prep->'baselinePeakStrength') is distinct from 'number'
      or jsonb_typeof(prep->'nextPeakStrength') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    baseline:=(prep->>'baselinePeakStrength')::numeric; next_peak:=(prep->>'nextPeakStrength')::numeric;
    if baseline<0 or next_peak<baseline or next_peak>9007199254740991 or trunc(next_peak*100)<>next_peak*100 then
      return jsonb_build_object('ok',false,'code','invalid'); end if;
    if buyer_gid is null then return jsonb_build_object('ok',false,'code','not-found'); end if;
  end if;

  if kind='buy-listing' and seller_gid is not null then
    for account in select x.gid from (values (buyer_gid),(seller_gid)) x(gid) group by x.gid order by x.gid loop
      perform 1 from public.gladiators where id=account.gid for update;
    end loop;
    for account in select x.gid from (values (buyer_gid),(seller_gid)) x(gid) group by x.gid order by x.gid loop
      perform 1 from public.wallets where gladiator_id=account.gid for update;
    end loop;
    select * into g from public.gladiators where id=buyer_gid;
    select * into s from public.gladiators where id=seller_gid;
    select * into w from public.wallets where gladiator_id=buyer_gid;
    select * into sw from public.wallets where gladiator_id=seller_gid;
    -- The listed item only while the seller still owns it: a sold item belongs to an account whose lock is not held here.
    perform 1 from public.item_instances where gladiator_id=buyer_gid or (id=listed_item and gladiator_id=seller_gid) order by id for update;
    perform 1 from private.market_listings where id=listing for update;
  else
    select * into g from public.gladiators where owner_id=actor_id for update;
    if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
    select * into w from public.wallets where gladiator_id=g.id for update;
    perform 1 from public.item_instances where gladiator_id=g.id order by id for update;
  end if;
  now_ms:=private.planning_now_ms();
  -- A transient processing result is not retained: this exact operation may succeed after catch-up (either party, for a buy).
  if g.processed_slot_index<now_ms/4800000 or (s.id is not null and s.processed_slot_index<now_ms/4800000) then
    return jsonb_build_object('ok',false,'code','processing','retryAfterMs',1000);
  end if;
  if kind<>'buy-listing' then perform private.expire_seller_listings(g.id,now_ms);
  elsif s.id is not null then perform private.expire_seller_listings(s.id,now_ms); end if;

  if kind='create-listing' then
    select i.item into offered from public.item_instances i where i.id=target and i.gladiator_id=g.id;
    if not found then err:='not-found';
    elsif offered->'reservation' is distinct from 'null'::jsonb or exists(select 1 from public.pending_build_items p where p.item_id=target)
      or offered->>'binding' is distinct from 'tradable' or offered->>'origin' is not distinct from 'renown' then err:='invalid';
    elsif (select count(*) from private.market_listings m where m.seller_gladiator_id=g.id and m.status='open')>=5 then err:='invalid';
    else
      listing:=gen_random_uuid();
      result:=jsonb_build_object('listingId',listing,'expiresAtMs',now_ms+604800000);
    end if;
  else
    -- Only the seller's own listing row is locked by a cancel; a buy already holds its listing row.
    if kind='cancel-listing' then select * into l from private.market_listings m where m.id=listing and m.seller_gladiator_id=g.id for update;
    elsif s.id is not null then select * into l from private.market_listings m where m.id=listing; end if;
    if l.id is null then err:='not-found';
    elsif l.status='sold' then err:='sold';
    elsif l.status='expired' then err:='expired';
    elsif l.status<>'open' then err:='not-found';
    elsif kind='cancel-listing' then result:=jsonb_build_object('listingId',l.id,'itemId',l.item_id);
    elsif l.seller_gladiator_id=g.id then err:='invalid';
    elsif (select count(*) from public.item_instances where gladiator_id=g.id)>=60 then err:='inventory-full';
    else
      -- 5 % floored, at least 1 gold (launch feedback): no sale moves money for free.
      fee:=greatest(1,l.price*5/100);
      select w.money-coalesce(sum(r.money),0) into available from public.reservations r where r.gladiator_id=g.id and r.status='held';
      if l.price>available then err:='insufficient-funds';
      elsif sw.money::numeric+(l.price-fee)>9007199254740991 then err:='invalid';
      elsif baseline<>g.peak_strength then err:='conflict';
      else result:=jsonb_build_object('listingId',l.id,'itemId',l.item_id,'price',l.price,'fee',fee);
      end if;
    end if;
  end if;

  result:=case when err is null then jsonb_build_object('ok',true,'receiptId',receipt,'value',result) else jsonb_build_object('ok',false,'code',err) end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  if err is not null then return result; end if;
  if kind='create-listing' then
    insert into private.market_listings(id,seller_gladiator_id,item_id,price,listed_at_ms,expires_at_ms,status)
      values(listing,g.id,target,price,now_ms,now_ms+604800000,'open');
    update public.item_instances set item=jsonb_set(item,'{reservation}',jsonb_build_object('kind','listing','referenceId',listing)) where id=target;
    insert into public.market_offers(id,seller_gladiator_id,seller_name,item,price,listed_at_ms,expires_at_ms)
      values(listing,g.id,g.name,jsonb_build_object('catalogId',offered->'catalogId','catalogVersion',offered->'catalogVersion','tier',offered->'tier',
        'rarity',offered->'rarity','stats',offered->'stats','quantity',offered->'quantity'),price,now_ms,now_ms+604800000);
  elsif kind='cancel-listing' then
    perform private.market_close_listing(l.id,'cancelled',receipt);
  else
    sale_request:=jsonb_build_object('kind','market-sale','listingId',l.id);
    insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
      values(s.owner_id,gen_random_uuid(),sale_receipt,s.id,sale_request,sha256(convert_to(sale_request::text,'UTF8')),
        jsonb_build_object('ok',true,'receiptId',sale_receipt,'value',jsonb_build_object('listingId',l.id,'itemId',l.item_id,'price',l.price,'fee',fee,
          'moneyCredit',l.price-fee)));
    update public.wallets set money=money-l.price where gladiator_id=g.id;
    update public.wallets set money=money+(l.price-fee) where gladiator_id=s.id;
    insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason)
      values(g.id,receipt,-l.price,0,'market-purchase'),(s.id,sale_receipt,l.price-fee,0,'market-sale');
    -- Two UPDATEs (guard_reserved_item): release the listing reservation, then move the owner and item.ownerId together.
    update public.item_instances set item=jsonb_set(item,'{reservation}','null')
      where id=l.item_id and gladiator_id=s.id and item->'reservation'=jsonb_build_object('kind','listing','referenceId',l.id)
        and item->>'binding'='tradable' and item->>'origin' is distinct from 'renown';
    if not found then raise exception 'listed item unavailable'; end if;
    update public.item_instances set gladiator_id=g.id,item=jsonb_set(item,'{ownerId}',to_jsonb(g.id::text)) where id=l.item_id;
    update private.market_listings set status='sold',terminal_receipt_id=receipt,buyer_gladiator_id=g.id where id=l.id;
    delete from public.market_offers where id=l.id;
    update public.gladiators set peak_strength=next_peak where id=g.id and peak_strength<>next_peak;
  end if;
  return result;
end $$;

revoke all on function public.edit_day_schedule(uuid,uuid,jsonb),private.planning_command(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.edit_day_schedule(uuid,uuid,jsonb),private.planning_command(uuid,uuid,jsonb,text) to service_role;
revoke all on function private.market_command(uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function private.market_command(uuid,uuid,jsonb,text) to service_role;

-- launch-feedback backfill: start
-- Arena only in the evening, from deploy time (spec, "The change surface" and "Settled after the builder check"; no schedule
-- held Arena on production or the bench on 2026-10-25, so this is expected to change nothing there). For each character
-- with a morning or afternoon Arena, under its account lock and then its gladiator and schedule rows (the planning lock
-- order), with the database time sampled after them:
--   - when the revision its next boundary (processed slot + 1) picks for the morning or the afternoon is Arena, a Rest
--     revision at processed slot + 1, all in one new version;
--   - for each later morning or afternoon Arena revision that no later version at its own effective slot overrides, a Rest
--     revision at that same slot in a further version (a part may hold both; a revision's key allows one row per part and
--     version).
-- The boundary picks the latest effective slot, then the latest version (private.boundary_snapshot), so it sees Rest. The
-- latest plan shows Rest for those parts, at the last new version. Activities already snapshotted keep their choice. Run
-- with no open boundary (the deploy rule); applying it again changes nothing.
do $$
declare x record; processed bigint; s public.schedules%rowtype; now_ms bigint; v bigint; future record; current_phases text[];
begin
  for x in select g.id,g.owner_id from public.gladiators g
    where exists(select 1 from public.schedule_revisions r where r.gladiator_id=g.id and r.phase in ('morning','afternoon') and r.choice->>'kind'='arena')
      or exists(select 1 from public.schedules y where y.gladiator_id=g.id and 'arena' in (y.schedule->'morning'->>'kind',y.schedule->'afternoon'->>'kind'))
    order by g.id loop
    perform pg_advisory_xact_lock(hashtextextended(x.owner_id::text,0));
    select g.processed_slot_index into processed from public.gladiators g where g.id=x.id for update;
    select * into s from public.schedules y where y.gladiator_id=x.id for update;
    now_ms:=private.planning_now_ms(); v:=s.version;
    select array_agg(c.phase order by c.phase) into current_phases from (
      select distinct on (r.phase) r.phase,r.choice from public.schedule_revisions r
        where r.gladiator_id=x.id and r.phase in ('morning','afternoon') and r.effective_slot_index<=processed+1
        order by r.phase,r.effective_slot_index desc,r.version desc) c
      where c.choice->>'kind'='arena';
    if current_phases is not null then
      v:=v+1;
      insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index)
        select x.id,v,c.phase,'{"kind":"rest"}'::jsonb,now_ms,processed+1 from unnest(current_phases) c(phase);
    end if;
    for future in select f.phase,f.effective_slot_index from public.schedule_revisions f
      where f.gladiator_id=x.id and f.phase in ('morning','afternoon') and f.choice->>'kind'='arena' and f.effective_slot_index>processed+1
        and not exists(select 1 from public.schedule_revisions o where o.gladiator_id=f.gladiator_id and o.phase=f.phase
          and o.effective_slot_index=f.effective_slot_index and o.version>f.version)
      order by f.effective_slot_index,f.phase loop
      v:=v+1;
      insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index)
        values(x.id,v,future.phase,'{"kind":"rest"}'::jsonb,now_ms,future.effective_slot_index);
    end loop;
    if v>s.version or 'arena' in (s.schedule->'morning'->>'kind',s.schedule->'afternoon'->>'kind') then
      update public.schedules y set version=greatest(v,s.version+1),
        schedule=s.schedule||(select coalesce(jsonb_object_agg(k.phase,'{"kind":"rest"}'::jsonb),'{}'::jsonb)
          from unnest(array['morning','afternoon']) k(phase) where s.schedule->k.phase->>'kind'='arena')
        where y.gladiator_id=x.id;
    end if;
  end loop;
end $$;
-- launch-feedback backfill: end

notify pgrst,'reload schema';
commit;
