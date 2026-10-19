-- Task 22.4: the restore check's resume step (plan 2026-10-18-task-22-retention-operations, Decision 9). Run by
-- scripts/restore-check.ps1 with psql -v ON_ERROR_STOP=1 in the restored copy only; it refuses any other database.
--
-- It resumes the restored world the way the worker does, once: it acquires the coordinator lease exactly as
-- public.coordinate_work() does (only when no live lease is held: a fresh token, 120 s from private.planning_now_ms()), replays
-- the last published boundary with public.advance_boundary(published_slot, token), and releases the lease. A restored
-- checkpoint must answer 'replayed' and change nothing. It prints one JSON object:
--   status           replayed | not-replayed | no-published-slot | lease-held
--   slot, result     the replayed slot and advance_boundary's answer
--   before, after    settled slots, receipts, ledger rows, items, season awards, wallet totals
--   duplicateGrants  new settled slots + receipts + ledger rows + season awards + new items + wallets whose balance changed
--   lostItems        items that disappeared or changed owner
do $$ begin
  if current_database()<>'cloudiator_restore_check' then
    raise exception 'restore-resume.sql runs only in cloudiator_restore_check';
  end if;
end $$;

create temp table resume_items as select id,gladiator_id from public.item_instances;
create temp table resume_wallets as select gladiator_id,money,renown from public.wallets;
create temp table resume_before as select
  (select count(*) from private.settled_slots) as settled_slots,(select count(*) from public.operation_receipts) as receipts,
  (select count(*) from public.wallet_ledger) as ledger,(select count(*) from public.item_instances) as items,
  (select count(*) from private.season_awards) as awards,
  (select coalesce(sum(money),0) from public.wallets) as money,(select coalesce(sum(renown),0) from public.wallets) as renown;

-- The lease, as public.coordinate_work() takes it.
create temp table resume_lease(slot bigint,token uuid);
with acquired as (
  update private.coordinator set lease_token=gen_random_uuid(),lease_until_ms=private.planning_now_ms()+120000,
    updated_at_ms=private.planning_now_ms()
  where singleton and published_slot is not null and (lease_token is null or lease_until_ms<=private.planning_now_ms())
  returning published_slot,lease_token
)
insert into resume_lease select published_slot,lease_token from acquired;

create temp table resume_result as select public.advance_boundary(l.slot,l.token) as result from resume_lease l;

-- Released as public.coordinate_work() releases it.
update private.coordinator c set lease_token=null,lease_until_ms=0,updated_at_ms=private.planning_now_ms()
from resume_lease l where c.singleton and c.lease_token=l.token;

with after as (select
  (select count(*) from private.settled_slots) as settled_slots,(select count(*) from public.operation_receipts) as receipts,
  (select count(*) from public.wallet_ledger) as ledger,(select count(*) from public.item_instances) as items,
  (select count(*) from private.season_awards) as awards,
  (select coalesce(sum(money),0) from public.wallets) as money,(select coalesce(sum(renown),0) from public.wallets) as renown
)
select jsonb_build_object(
  'status',case
    when exists(select 1 from resume_result r where r.result->>'ok'='true' and r.result->>'replayed'='true') then 'replayed'
    when exists(select 1 from resume_lease) then 'not-replayed'
    when (select published_slot from private.coordinator where singleton) is null then 'no-published-slot'
    else 'lease-held' end,
  'slot',(select slot from resume_lease),
  'result',(select result from resume_result),
  'before',(select jsonb_build_object('settledSlots',b.settled_slots,'receipts',b.receipts,'ledger',b.ledger,'items',b.items,
    'awards',b.awards,'money',b.money,'renown',b.renown) from resume_before b),
  'after',(select jsonb_build_object('settledSlots',a.settled_slots,'receipts',a.receipts,'ledger',a.ledger,'items',a.items,
    'awards',a.awards,'money',a.money,'renown',a.renown) from after a),
  'duplicateGrants',(select greatest(a.settled_slots-b.settled_slots,0)+greatest(a.receipts-b.receipts,0)+greatest(a.ledger-b.ledger,0)
      +greatest(a.awards-b.awards,0) from resume_before b,after a)
    +(select count(*) from public.item_instances i where not exists(select 1 from resume_items r where r.id=i.id))
    +(select count(*) from resume_wallets r join public.wallets w on w.gladiator_id=r.gladiator_id
       where w.money<>r.money or w.renown<>r.renown),
  'lostItems',(select count(*) from resume_items r where not exists(select 1 from public.item_instances i
    where i.id=r.id and i.gladiator_id=r.gladiator_id))
)::text as resume;
