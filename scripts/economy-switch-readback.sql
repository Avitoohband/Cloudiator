-- Read-only read-back after the 1.6 economy switch (runbook "The economy switch (1.6)", step 3): one SELECT, one row.
-- Run it as the database owner right after `select private.switch_to_economy_v2();` commits, and retain the whole row with the
-- returned JSON. It holds the runbook's audit, mirror, ledger and receipt-identity reads, and checks every cut receipt against
-- the quarter rule: a cut wallet keeps at least a quarter of its gold, rounded up (moneyAfter >= (moneyBefore+3)/4), and exactly
-- that when it held no queued fee (`exact_quarter_receipts`). Every boolean column must be true. The revision is printed only:
-- compare it with one read before the switch (it must have advanced, even with no wallet cut). Zero-cut wallets have no receipt
-- or ledger row; the audit counts them in `wallets_scanned` and the money totals.
with audit as (
  select count(*)::int as audits,max(switched_at_ms) as switched_at_ms,max(wallets_scanned) as wallets_scanned,
    max(wallets_cut) as wallets_cut,max(money_before) as money_before,max(money_after) as money_after,
    (array_agg(result))[1] as result
  from private.economy_switches where version='v2'
), mirror as (
  select private.active_rules_version() as active_version,w.rules_version,w.revision from public.world_revision w
), ledger as (
  select count(*)::int as ledger_rows,coalesce(sum(money_delta),0)::bigint as ledger_delta
  from public.wallet_ledger where reason='economy-cut'
), cuts as (
  select * from public.operation_receipts where request->>'kind'='economy-cut'
), linked as (
  select r.*,l.gladiator_id as ledger_gladiator,l.money_delta,l.renown_delta,l.reason
    from cuts r left join public.wallet_ledger l using(receipt_id)
), receipts as (
  select (select count(*) from cuts)::int as cut_receipts,
    count(money_delta)::int as linked_ledger_rows,count(distinct receipt_id)::int as distinct_receipts,
    count(distinct gladiator_id)::int as distinct_wallets,coalesce(sum(money_delta),0)::bigint as linked_delta,
    coalesce(bool_and(coalesce(request='{"kind":"economy-cut","version":"v2"}'::jsonb
      and request_digest=sha256(convert_to('economy-cut:v2:'||gladiator_id::text,'UTF8'))
      and ledger_gladiator=gladiator_id and reason='economy-cut' and renown_delta=0
      and (result->>'cut')::bigint>0
      and (result->>'moneyBefore')::bigint-(result->>'moneyAfter')::bigint=(result->>'cut')::bigint
      and money_delta=-(result->>'cut')::bigint,false)),true) as each_receipt_matches
  from linked
), quarters as (
  -- Per receipt (not per ledger join row): the quarter rule, and the receipts cut to exactly a quarter.
  select coalesce(bool_and(coalesce((result->>'moneyAfter')::bigint>=((result->>'moneyBefore')::bigint+3)/4,false)),true)
      as each_receipt_at_least_quarter,
    (count(*) filter (where (result->>'moneyAfter')::bigint=((result->>'moneyBefore')::bigint+3)/4))::int as exact_quarter_receipts
  from cuts
)
select a.audits,a.switched_at_ms,a.wallets_scanned,a.wallets_cut,a.money_before,a.money_after,a.result,
  m.active_version,m.rules_version,m.revision,
  l.ledger_rows,l.ledger_delta,
  r.cut_receipts,r.linked_ledger_rows,r.distinct_receipts,r.distinct_wallets,r.linked_delta,
  q.exact_quarter_receipts,
  a.audits=1 as one_audit,
  coalesce(a.result->>'ok'='true' and a.result->>'version'='v2' and a.result->>'replayed'='false'
    and (a.result->>'switchedAtMs')::bigint=a.switched_at_ms and (a.result->>'walletsScanned')::bigint=a.wallets_scanned
    and (a.result->>'walletsCut')::bigint=a.wallets_cut and (a.result->>'moneyBefore')::bigint=a.money_before
    and (a.result->>'moneyAfter')::bigint=a.money_after,false) as audit_matches_result,
  coalesce(m.active_version='v2',false) as active_is_v2,
  coalesce(m.rules_version='v2',false) as mirror_is_v2,
  coalesce(l.ledger_rows=a.wallets_cut and l.ledger_delta=a.money_after-a.money_before,false) as ledger_matches_audit,
  coalesce(r.cut_receipts=a.wallets_cut and r.linked_ledger_rows=a.wallets_cut and r.distinct_receipts=a.wallets_cut
    and r.distinct_wallets=a.wallets_cut and r.linked_delta=l.ledger_delta,false) as receipts_match_audit,
  r.each_receipt_matches,
  q.each_receipt_at_least_quarter
from audit a,mirror m,ledger l,receipts r,quarters q;
