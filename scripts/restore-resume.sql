-- Task 22.4: the restore check's resume step (plan 2026-10-18-task-22-retention-operations, Decision 9). Run by
-- scripts/restore-check.ps1 with psql -v ON_ERROR_STOP=1 in the restored copy only; it refuses any other database.
--
-- 1. Structural replay. It acquires the coordinator lease exactly as public.coordinate_work() does (only when no live lease
--    is held: a fresh token, 120 s from private.planning_now_ms()), calls public.advance_boundary(published_slot, token) and
--    releases the lease. For a published slot advance_boundary answers 'replayed' right after taking the coordinator row
--    lock and reading the clock (03-activities-jobs.sql): no phase and no grant table is reached. This step therefore proves
--    only that the checkpoint was restored, that the lease can be taken and released and that the function runs; its
--    before/after comparison cannot see a second grant on its own (Task 22.4 review, Important 1).
-- 2. Behavioural guard probes (Fix round 1). Each runs in its own subtransaction that is always rolled back, against the
--    restored rows of the latest settled slot at or below the published slot:
--      secondSettlement   a second settlement of that (character, slot) with a fresh activity and receipt
--                         must be refused by private.settled_slots' primary key       (expected: primary-key)
--      deleteSettledSlot  deleting that settled slot must be refused by guard_frozen (expected: guard)
--      deleteReceipt      deleting an operation receipt must be refused by guard_receipt (expected: guard)
--    'accepted' means the write went through (and was rolled back); 'no-row' means there was nothing to probe; any other
--    value is the SQLSTATE that refused it. Only these codes are printed, never an error message.
-- 3. The counts afterwards: settled slots, receipts, ledger rows, items, season awards and wallets must be unchanged.
--
-- It prints one JSON object:
--   replayCheck      'structural' (step 1's limit, stated in the output)
--   status           replayed | not-replayed | no-published-slot | lease-held (step 1)
--   slot, result     the replayed slot and advance_boundary's answer
--   probes           {name: {expected, observed}} (step 2); scripts/restore-compare.mjs requires every probe to match
--   before, after    settled slots, receipts, ledger rows, items, season awards, wallet totals
--   duplicateGrants  new settled slots + receipts + ledger rows + season awards + new items + wallets whose balance changed
--   lostItems        items that disappeared or changed owner
--   countsUnchanged  every before count equals its after count (a probe's write never survives)
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

-- Step 1. The lease, as public.coordinate_work() takes it.
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

-- Step 2. The guard probes. 'RC001' is this script's own marker that rolls an accepted write back.
create temp table resume_probes(name text primary key,expected text not null,observed text not null);
do $$
declare s private.settled_slots%rowtype; r public.operation_receipts%rowtype; observed text; violated text; probed boolean;
begin
  select * into s from private.settled_slots
    where slot_index<=(select published_slot from private.coordinator where singleton)
    order by slot_index desc,gladiator_id limit 1;
  probed:=found;

  observed:='no-row';
  if probed then
    begin
      insert into private.settled_slots(gladiator_id,slot_index,activity_id,receipt_id,resolved_kind,settled_at_ms)
        values(s.gladiator_id,s.slot_index,gen_random_uuid(),gen_random_uuid(),s.resolved_kind,s.settled_at_ms);
      observed:='accepted';
      raise exception using errcode='RC001';
    exception when others then
      if sqlstate<>'RC001' then
        get stacked diagnostics violated=constraint_name;
        observed:=case when sqlstate='23505' and violated='settled_slots_pkey' then 'primary-key' else sqlstate end;
      end if;
    end;
  end if;
  insert into resume_probes values('secondSettlement','primary-key',observed);

  observed:='no-row';
  if probed then
    begin
      delete from private.settled_slots where gladiator_id=s.gladiator_id and slot_index=s.slot_index;
      observed:='accepted';
      raise exception using errcode='RC001';
    exception when others then
      if sqlstate<>'RC001' then
        observed:=case when sqlstate='P0001' and sqlerrm='immutable settled_slots' then 'guard' else sqlstate end;
      end if;
    end;
  end if;
  insert into resume_probes values('deleteSettledSlot','guard',observed);

  observed:='no-row';
  select * into r from public.operation_receipts order by created_at desc,receipt_id limit 1;
  if found then
    begin
      delete from public.operation_receipts where owner_id=r.owner_id and operation_id=r.operation_id;
      observed:='accepted';
      raise exception using errcode='RC001';
    exception when others then
      if sqlstate<>'RC001' then
        observed:=case when sqlstate='P0001' and sqlerrm='immutable operation_receipts' then 'guard' else sqlstate end;
      end if;
    end;
  end if;
  insert into resume_probes values('deleteReceipt','guard',observed);
end $$;

-- Step 3. The counts after the replay and the probes.
with after as (select
  (select count(*) from private.settled_slots) as settled_slots,(select count(*) from public.operation_receipts) as receipts,
  (select count(*) from public.wallet_ledger) as ledger,(select count(*) from public.item_instances) as items,
  (select count(*) from private.season_awards) as awards,
  (select coalesce(sum(money),0) from public.wallets) as money,(select coalesce(sum(renown),0) from public.wallets) as renown
)
select jsonb_build_object(
  'replayCheck','structural',
  'status',case
    when exists(select 1 from resume_result r where r.result->>'ok'='true' and r.result->>'replayed'='true') then 'replayed'
    when exists(select 1 from resume_lease) then 'not-replayed'
    when (select published_slot from private.coordinator where singleton) is null then 'no-published-slot'
    else 'lease-held' end,
  'slot',(select slot from resume_lease),
  'result',(select result from resume_result),
  'probes',(select jsonb_object_agg(p.name,jsonb_build_object('expected',p.expected,'observed',p.observed)) from resume_probes p),
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
    where i.id=r.id and i.gladiator_id=r.gladiator_id)),
  'countsUnchanged',(select to_jsonb(b) = to_jsonb(a) from resume_before b,after a)
)::text as resume;
