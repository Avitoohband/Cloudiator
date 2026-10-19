-- Task 22.4: counts and invariants of a restored Cloudiator database (plan 2026-10-18-task-22-retention-operations,
-- Decision 9 and the Review Focus "A restore into a separate database"). One read-only statement that prints one JSON object:
--   counts      rows of every public and private table plus auth.users, compared with the export manifest
--               (scripts/restore-compare.mjs); the manifest counts the COPY rows of the data dump itself.
--   invariants  {name: {ok, violations}} for the grant, ledger and ownership guards:
--     settledSlotsUnique         private.settled_slots: one row per (gladiator, slot), one per activity and per receipt
--     completedActivitiesGuarded every completed activity has its settled_slots guard (the permanent grant guard)
--     ledgerReceiptsUnique       one ledger row per receipt, and every ledger receipt exists
--     walletReconciliation       wallets.money = coalesce(checkpoint.money,0) + sum(ledger.money_delta), and renown alike
--                                (Decision 3's invariant with the folded part in private.wallet_checkpoints)
--     itemsSingleOwner           each item names its own row and owner; a pending build or open listing only holds an
--                                item its own character owns; an item is in at most one open listing
--     inventoryCap               no character holds more than 60 items
--     seasonAwardsUnique         one award per (season, character), per (season, league, place) and per receipt
--     foreignKeys                no orphan row under any public or private foreign key (the data load bypasses them)
--     guardsIntact               the grant and ownership guard triggers exist and no public/private trigger is disabled
-- It is read-only, so tests/db/restore-world.test.ts also runs it against the local database.
with tables as (
  select n.nspname||'.'||c.relname as name, format('%I.%I',n.nspname,c.relname) as ident
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where c.relkind='r' and (n.nspname in ('public','private') or (n.nspname='auth' and c.relname='users'))
), counts as (
  select name, (xpath('/row/n/text()',query_to_xml(format('select count(*) as n from %s',ident),false,true,'')))[1]::text::bigint as n
  from tables
), foreign_keys as (
  -- One orphan count per constraint, MATCH SIMPLE: a row with a null key column references nothing.
  select (xpath('/row/n/text()',query_to_xml(format('select count(*) as n from %s c where %s and not exists (select 1 from %s p where %s)',
      con.conrelid::regclass,
      (select string_agg(format('c.%I is not null',a.attname),' and ' order by k.i)
         from unnest(con.conkey) with ordinality as k(attnum,i) join pg_catalog.pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.attnum),
      con.confrelid::regclass,
      (select string_agg(format('p.%I = c.%I',pa.attname,ca.attname),' and ' order by k.i)
         from unnest(con.conkey,con.confkey) with ordinality as k(child,parent,i)
         join pg_catalog.pg_attribute ca on ca.attrelid=con.conrelid and ca.attnum=k.child
         join pg_catalog.pg_attribute pa on pa.attrelid=con.confrelid and pa.attnum=k.parent)),false,true,'')))[1]::text::bigint as orphans
  from pg_catalog.pg_constraint con
  where con.contype='f' and con.connamespace in ('public'::regnamespace,'private'::regnamespace)
), guards(relation,trigger) as (
  values ('private.settled_slots','guard_frozen'),('public.operation_receipts','guard_receipt'),
    ('private.wallet_checkpoints','guard_wallet_checkpoint'),('private.jobs','guard_job'),
    ('public.item_instances','guard_inventory_item'),('public.item_instances','guard_reserved_item'),
    ('private.market_listings','guard_market_listing'),('private.season_awards','guard_frozen'),
    ('private.arena_ratings','guard_arena_rating'),('public.seasons','guard_season')
), unreconciled as (
  select w.gladiator_id from public.wallets w
  left join private.wallet_checkpoints cp on cp.gladiator_id=w.gladiator_id
  left join (select l.gladiator_id,sum(l.money_delta) as money,sum(l.renown_delta) as renown from public.wallet_ledger l group by l.gladiator_id) l
    on l.gladiator_id=w.gladiator_id
  where w.money<>coalesce(cp.money,0)+coalesce(l.money,0) or w.renown<>coalesce(cp.renown,0)+coalesce(l.renown,0)
), v as (
  select
    (select (count(*)-count(distinct (gladiator_id,slot_index)))+(count(*)-count(distinct activity_id))+(count(*)-count(distinct receipt_id))
       from private.settled_slots) as settled_slots_unique,
    (select count(*) from public.activities a where a.status='completed' and not exists(select 1 from private.settled_slots s
       where s.gladiator_id=a.gladiator_id and s.slot_index=a.slot_index and s.activity_id=a.id)) as completed_activities_guarded,
    (select count(*)-count(distinct receipt_id) from public.wallet_ledger)
      +(select count(*) from public.wallet_ledger l where not exists(select 1 from public.operation_receipts o where o.receipt_id=l.receipt_id))
      as ledger_receipts_unique,
    (select count(*) from unreconciled)
      +(select count(*) from private.wallet_checkpoints cp where not exists(select 1 from public.wallets w where w.gladiator_id=cp.gladiator_id))
      as wallet_reconciliation,
    (select count(*) from public.item_instances i where i.item->>'ownerId' is distinct from i.gladiator_id::text or i.item->>'id' is distinct from i.id::text)
      +(select count(*) from public.pending_build_items p where not exists(select 1 from public.item_instances i
          where i.id=p.item_id and i.gladiator_id=p.gladiator_id))
      +(select count(*) from private.market_listings m where m.status='open' and not exists(select 1 from public.item_instances i
          where i.id=m.item_id and i.gladiator_id=m.seller_gladiator_id))
      +(select count(*)-count(distinct item_id) from private.market_listings where status='open') as items_single_owner,
    (select count(*) from (select gladiator_id from public.item_instances group by gladiator_id having count(*)>60) x) as inventory_cap,
    (select (count(*)-count(distinct (season_index,gladiator_id)))+(count(*)-count(distinct (season_index,league,place)))
       +(count(*)-count(distinct receipt_id)) from private.season_awards) as season_awards_unique,
    (select coalesce(sum(orphans),0) from foreign_keys) as foreign_keys,
    -- A listed guard that is missing, plus every disabled trigger (a disabled listed guard counts once).
    (select count(*) from guards g where not exists(select 1 from pg_catalog.pg_trigger t
       where t.tgrelid=to_regclass(g.relation) and t.tgname=g.trigger))
      +(select count(*) from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
          where not t.tgisinternal and t.tgenabled='D' and c.relnamespace in ('public'::regnamespace,'private'::regnamespace)) as guards_intact
)
select jsonb_build_object(
  'counts',(select jsonb_object_agg(name,n) from counts),
  'invariants',jsonb_build_object(
    'settledSlotsUnique',jsonb_build_object('ok',settled_slots_unique=0,'violations',settled_slots_unique),
    'completedActivitiesGuarded',jsonb_build_object('ok',completed_activities_guarded=0,'violations',completed_activities_guarded),
    'ledgerReceiptsUnique',jsonb_build_object('ok',ledger_receipts_unique=0,'violations',ledger_receipts_unique),
    'walletReconciliation',jsonb_build_object('ok',wallet_reconciliation=0,'violations',wallet_reconciliation),
    'itemsSingleOwner',jsonb_build_object('ok',items_single_owner=0,'violations',items_single_owner),
    'inventoryCap',jsonb_build_object('ok',inventory_cap=0,'violations',inventory_cap),
    'seasonAwardsUnique',jsonb_build_object('ok',season_awards_unique=0,'violations',season_awards_unique),
    'foreignKeys',jsonb_build_object('ok',foreign_keys=0,'violations',foreign_keys),
    'guardsIntact',jsonb_build_object('ok',guards_intact=0,'violations',guards_intact)))::text as restore_check
from v;
