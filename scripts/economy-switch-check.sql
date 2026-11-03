-- Read-only, aggregate-only advisory precheck for the 1.6 economy switch: one SELECT, one timestamped row.
-- Live commands may change these totals before activation. Reconcile the committed audit with its receipts/ledger instead.
with wallet_totals as (
  select w.money,coalesce(h.held,0)::bigint as held,
    greatest(w.money-coalesce(h.held,0),0)::bigint as spendable
  from public.wallets w left join (
    select gladiator_id,sum(money) as held from public.reservations where status='held' group by gladiator_id
  ) h on h.gladiator_id=w.gladiator_id
), totals as (
  select count(*) as wallets,coalesce(sum(money),0) as money_now,
    coalesce(sum(money-(spendable-(spendable+3)/4)),0) as money_after_cut,coalesce(sum(held),0) as held
  from wallet_totals
)
select (select count(*) from private.boundaries where status<>'complete') as open_boundary,
  floor(extract(epoch from statement_timestamp())*1000)::bigint as checked_at_ms,
  private.active_rules_version() as active_version,
  exists(select 1 from private.rules_versions where version='v2') as v2_row,
  exists(select 1 from private.economy_switches where version='v2') as switched,
  t.wallets,t.money_now,t.money_after_cut,t.held,
  coalesce((select rules_version=private.active_rules_version() from public.world_revision_state where singleton),false) as copy_matches
from totals t;
