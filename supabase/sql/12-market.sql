-- Task 18.1 reapplicable source. Committed M01-M13 are immutable; deploy only the separately generated migration (M14).
-- Fixed-price marketplace (game design §9; plan 2026-10-17-task-18-marketplace, Decisions 2-9): authoritative private listings,
-- a sanitized public offers projection, three receipt-backed commands (create, cancel, buy) and an expiry sweep.
--
-- Lock order (Decision 6). Every writer of an account's items, listings and wallet holds that account's advisory lock
-- hashtextextended(owner_id::text,0) first, as every earlier command, boundary and settlement does.
--   create, cancel: the actor's account lock, the receipt lookup, the gladiator row, the wallet, the account's items in id
--     order, then listing rows.
--   buy: the listing's seller is read without a lock. Then BOTH account locks in gladiator_id order (the boundary_start
--     precedent, 10-tournament-results.sql), the receipt lookup, both gladiator rows in gladiator_id order, both wallets in
--     gladiator_id order, the buyer's items and the listed item in id order, then the listing row.
--   Database time (private.planning_now_ms()) is sampled after all of these locks (AGENTS.md Postgres concurrency), and the
--   expiry, processing and every business check use that one post-lock sample.
--   A command then expires its seller's own due listings (create and cancel: the actor; buy: the listing's seller). In a buy
--     that locks the seller's other listed items after the listing row; only holders of the seller's account lock ever lock
--     them, so that wait cannot cycle.
--   The sweep try-locks each seller's account lock and skips a busy seller (its next command, or the next tick, expires
--     those listings); it then locks that seller's due listing rows with FOR UPDATE SKIP LOCKED.
--
-- Transfer. guard_reserved_item refuses any owner change while the old row is reserved, and the item CHECK requires
-- gladiator_id and item.ownerId to change together. A sale is therefore two UPDATEs: clear the listing reservation, then
-- move gladiator_id and item.ownerId in one statement (guard_inventory_item still refuses bound items and a 61st item).
--
-- Receipts and ledger (Decision 5). Each command records the actor's operation receipt: a changed payload under the same
-- operation returns conflict, an identical one replays the stored result. Shape errors return invalid with no receipt;
-- business refusals after the gladiator lock are stored; processing is never stored. A purchase also writes a seller
-- receipt with a generated operation id and request {kind:'market-sale', listingId}, as settlement does, because
-- wallet_ledger.receipt_id is unique: the buyer's 'market-purchase' row (-price) and the seller's 'market-sale' row
-- (+price-fee). Create and cancel write no ledger row. Total currency changes only by the fee, floor(price*5/100).
--
-- Offers. public.market_offers holds open listings only, readable by visitors (anon) and players, written only by these
-- functions. Its select policy hides an offer from the moment it expires, before any sweep. Offers do NOT bump
-- world_revision (no projection_changed trigger): marketplace pages load on demand.
begin;

create table if not exists private.market_listings (
  id uuid primary key,
  seller_gladiator_id uuid not null references public.gladiators(id),
  -- No foreign key: a sold item may later be sold to an NPC or discarded by its new owner, and the listing stays.
  item_id uuid not null,
  price bigint not null check (price between 1 and 1000000000),
  listed_at_ms bigint not null check (listed_at_ms >= 0),
  expires_at_ms bigint not null check (expires_at_ms > listed_at_ms),
  status text not null default 'open' check (status in ('open','sold','cancelled','expired')),
  terminal_receipt_id uuid references public.operation_receipts(receipt_id),
  buyer_gladiator_id uuid references public.gladiators(id),
  check ((status='sold') = (buyer_gladiator_id is not null)),
  check ((status in ('sold','cancelled')) = (terminal_receipt_id is not null)),
  check (buyer_gladiator_id is distinct from seller_gladiator_id)
);
create index if not exists market_listings_seller_idx on private.market_listings(seller_gladiator_id,status);
create index if not exists market_listings_buyer_idx on private.market_listings(buyer_gladiator_id);
create index if not exists market_listings_receipt_idx on private.market_listings(terminal_receipt_id);
create index if not exists market_listings_due_idx on private.market_listings(expires_at_ms) where status='open';
create unique index if not exists market_listings_open_item_idx on private.market_listings(item_id) where status='open';
alter table private.market_listings enable row level security;
revoke all on private.market_listings from public,anon,authenticated,service_role;
grant select,insert,update on private.market_listings to service_role;
drop policy if exists backend_only on private.market_listings;
create policy backend_only on private.market_listings to service_role using (true) with check (true);

-- Only an open listing changes, and only its terminal fields: identity, price and times are fixed when it is listed.
create or replace function private.guard_market_listing() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.status<>'open' or (new.id,new.seller_gladiator_id,new.item_id,new.price,new.listed_at_ms,new.expires_at_ms)
    is distinct from (old.id,old.seller_gladiator_id,old.item_id,old.price,old.listed_at_ms,old.expires_at_ms) then
    raise exception 'immutable listing';
  end if;
  return new;
end $$;
drop trigger if exists guard_market_listing on private.market_listings;
create trigger guard_market_listing before update on private.market_listings for each row execute function private.guard_market_listing();

-- The sanitized projection: inserted on create, deleted on every terminal transition. Never the item id, owner, origin,
-- binding or reservation, and never the buyer.
create table if not exists public.market_offers (
  id uuid primary key references private.market_listings(id),
  seller_gladiator_id uuid not null references public.gladiators(id),
  seller_name text not null,
  item jsonb not null check (jsonb_typeof(item)='object'),
  price bigint not null check (price between 1 and 1000000000),
  listed_at_ms bigint not null,
  expires_at_ms bigint not null check (expires_at_ms > listed_at_ms)
);
create index if not exists market_offers_seller_idx on public.market_offers(seller_gladiator_id);
create index if not exists market_offers_listed_idx on public.market_offers(listed_at_ms desc,id);
alter table public.market_offers enable row level security;
revoke all on public.market_offers from public,anon,authenticated,service_role;
grant select on public.market_offers to anon,authenticated;
grant select,insert,delete on public.market_offers to service_role;
drop policy if exists player_read on public.market_offers;
-- Real database clock, for every reader and every guessed id: an expired offer is hidden before the sweep removes it.
create policy player_read on public.market_offers for select to anon,authenticated
  using (expires_at_ms>floor(extract(epoch from clock_timestamp())*1000)::bigint);

-- Returns an open listing's item to its seller and closes it. Callers hold the seller's account lock and the listing row.
create or replace function private.market_close_listing(listing_id uuid,next_status text,receipt uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare l private.market_listings%rowtype;
begin
  select * into l from private.market_listings where id=listing_id;
  if not found or l.status<>'open' or next_status is null or next_status not in ('cancelled','expired') then
    raise exception 'invalid listing transition';
  end if;
  update public.item_instances set item=jsonb_set(item,'{reservation}','null')
    where id=l.item_id and gladiator_id=l.seller_gladiator_id and item->'reservation'=jsonb_build_object('kind','listing','referenceId',l.id);
  if not found then raise exception 'listed item missing'; end if;
  update private.market_listings set status=next_status,terminal_receipt_id=receipt where id=l.id;
  delete from public.market_offers where id=l.id;
end $$;

-- A seller's own due listings, expired at `now_ms` (Decision 7). Callers hold the seller's account lock.
create or replace function private.expire_seller_listings(seller uuid,now_ms bigint) returns integer
language plpgsql security invoker set search_path='' as $$
declare listing uuid; expired integer:=0;
begin
  for listing in select l.id from private.market_listings l where l.seller_gladiator_id=seller and l.status='open'
    and l.expires_at_ms<=now_ms order by l.id for update loop
    perform private.market_close_listing(listing,'expired',null);
    expired:=expired+1;
  end loop;
  return expired;
end $$;

-- The scheduled sweep (from private.cron_tick). Granted to nobody: only pg_cron's tick runs it.
create or replace function private.expire_listings(now_ms bigint) returns integer
language plpgsql security invoker set search_path='' as $$
declare seller record; listing uuid; expired integer:=0;
begin
  if now_ms is null then raise exception 'invalid expiry time'; end if;
  for seller in select distinct l.seller_gladiator_id as id,g.owner_id from private.market_listings l
    join public.gladiators g on g.id=l.seller_gladiator_id
    where l.status='open' and l.expires_at_ms<=now_ms order by l.seller_gladiator_id loop
    -- A busy seller is skipped, never waited for.
    continue when not pg_try_advisory_xact_lock(hashtextextended(seller.owner_id::text,0));
    for listing in select l.id from private.market_listings l where l.seller_gladiator_id=seller.id and l.status='open'
      and l.expires_at_ms<=now_ms order by l.id for update skip locked loop
      perform private.market_close_listing(listing,'expired',null);
      expired:=expired+1;
    end loop;
  end loop;
  return expired;
end $$;

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

  -- Shape: invalid, never recorded. Whole prices from 1 to 1,000,000,000 (Decision 2).
  if c->>'kind' is distinct from kind or c->>'operationId' is distinct from operation_id::text then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if kind='create-listing' then
    if (select count(*) from jsonb_object_keys(c))<>4 or not(c ?& array['kind','operationId','itemId','price'])
      or jsonb_typeof(c->'itemId') is distinct from 'string' or c->>'itemId' !~ uuid_shape
      or jsonb_typeof(c->'price') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (c->>'price')::numeric not between 1 and 1000000000 or trunc((c->>'price')::numeric)<>(c->>'price')::numeric then
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
      fee:=l.price*5/100;
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
create or replace function public.create_listing(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.market_command(actor_id,operation_id,input,'create-listing')
$$;
create or replace function public.cancel_listing(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.market_command(actor_id,operation_id,input,'cancel-listing')
$$;
create or replace function public.buy_listing(actor_id uuid,operation_id uuid,input jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select private.market_command(actor_id,operation_id,input,'buy-listing')
$$;

-- Every minute (Task 7): coordinate, then (Task 18) expire due listings, then dispatch. Inert until private.scheduler.enabled.
create or replace function private.cron_tick() returns jsonb language plpgsql security invoker set search_path='' as $$
declare coordination jsonb; expiry jsonb;
begin
  if not coalesce((select enabled from private.scheduler where singleton),false) then return jsonb_build_object('ok',true,'skipped','disabled'); end if;
  begin
    coordination:=public.coordinate_work();
  exception when others then
    -- Record only the SQLSTATE; dispatch still proceeds so pending work keeps draining.
    update private.coordinator set last_error=sqlstate,updated_at_ms=private.planning_now_ms() where singleton;
    coordination:=jsonb_build_object('ok',false,'code','coordinator-failed');
  end;
  -- The sweep in its own block: a failure rolls back only the sweep and reports only its SQLSTATE.
  begin
    expiry:=jsonb_build_object('ok',true,'expired',private.expire_listings(private.planning_now_ms()));
  exception when others then
    expiry:=jsonb_build_object('ok',false,'code','expiry-failed','sqlstate',sqlstate);
  end;
  return jsonb_build_object('ok',true,'coordination',coordination,'expiry',expiry,'dispatch',private.dispatch_workers());
end $$;

revoke all on function public.create_listing(uuid,uuid,jsonb),public.cancel_listing(uuid,uuid,jsonb),public.buy_listing(uuid,uuid,jsonb),
  private.market_command(uuid,uuid,jsonb,text),private.market_close_listing(uuid,text,uuid),private.expire_seller_listings(uuid,bigint),
  private.guard_market_listing(),private.expire_listings(bigint),private.cron_tick() from public,anon,authenticated,service_role;
grant execute on function public.create_listing(uuid,uuid,jsonb),public.cancel_listing(uuid,uuid,jsonb),public.buy_listing(uuid,uuid,jsonb),
  private.market_command(uuid,uuid,jsonb,text),private.market_close_listing(uuid,text,uuid),private.expire_seller_listings(uuid,bigint),
  private.guard_market_listing() to service_role;
notify pgrst,'reload schema';
commit;
