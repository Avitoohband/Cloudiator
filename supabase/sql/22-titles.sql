-- Wearable titles (patch 1.7) reapplicable source. Committed M01-M27 are immutable; deploy only the separately generated
-- migration M28 (supabase/migrations/*_patch_1_7.sql, Task 7). Spec: docs/superpowers/specs/2026-10-30-titles-1-7-design.md,
-- "Server: M28 from supabase/sql/22-titles.sql" ("Tables", "Functions", "Triggers", "Lock order", "Time", "The command
-- wear-title", "Public and owner reads", "The back-fill"); plan: docs/superpowers/plans/2026-10-30-titles-1-7.md, Tasks 2-5.
-- Later tasks add their sections above section 5's closing call.
--
-- Purpose: a gladiator earns a title when one of its measures (what it has done: expeditions won, Trainings, Arena wins, gold
-- earned from play, items ever owned, days in camp, Season 1...) reaches the rule's threshold. Titles are kept forever, never
-- taken back, and one earned title (or none) is worn; only the worn id and a count are ever public.
--
-- 1. The spec's "Tables" exactly: public.gladiator_titles, public.title_counters and public.item_firsts (owner-only reads through
--    01-identity.sql's owner_read recipe, the backend reads and inserts, nobody deletes), public.gladiators.worn_title (the deferred
--    foreign key gladiators_worn_title_fkey: only an earned title can be worn), public.public_profiles.titles_earned (published by
--    Task 4's projector), and the owner-only private.title_backfills (the release back-fill's record, Task 5). Title rows and the
--    ownership history refuse update and delete (guard_frozen); a deferred project_changed_character trigger republishes the
--    gladiator when it earns a title.
-- 2. The rules and awarding: private.title_rules() (the catalog's 31 rules), private.founder_cutoff_ms() (the end of
--    public.seasons row season_index 0, read from the table, never a typed date), private.title_measures(gid, at_ms),
--    private.add_title_count and private.set_title_count (one upsert each), private.award_titles (grants every rule met and not
--    held; the first title ever earned is worn at once) and the titles_on_gladiator trigger (Founder at creation).
-- 3. Counting: private.refresh_item_counters and six trigger functions for the spec's counting triggers (titles_on_item serves
--    titles_on_item and titles_on_item_move). Each runs in its writer's own transaction; no settlement, executor or worker
--    function is restated or changed.
-- 4. Wearing and the reads: public.wear_title (the command wear-title, backend only), private.project_character restated from
--    20-profile-card.sql with the actor's `title` and the profile's titles_earned, public.public_profile_reads restated from
--    21-economy.sql with titlesEarned, public.owner_state restated from 18-messages.sql with wornTitle, titles, titleProgress and
--    the title notices in inbox.newNotifications, and refresh_projections() so every actor and profile carries them at once.
-- 5. The release back-fill: private.backfill_titles() (the owner's only) counts the history the database still proves, once,
--    and its one call is the last statement (after every trigger), so M28 runs it at the release.
--
-- Accepted restatements: private.title_rules() restates TITLES_V1's id, measure, threshold and tier
-- (supabase/functions/_shared/domain/titles.ts) in catalog order, and private.title_measures restates its 18 stored counters
-- (STORED_COUNTERS); tests/db/titles.test.ts compares both with the TypeScript catalog, as private.season_rules() is pinned.
-- public.owner_state restates title_measures' gold-earned and days-in-camp (ruling R3: the owner may not execute the private
-- helper); tests/db/titles.test.ts compares them with title_measures in one statement.
--
-- Lock order: every writer that awards (commands, settlements, the season close; section 3's triggers, path by path there)
-- already holds the gladiator's account advisory lock (hashtextextended(owner_id::text,0)) and touches only that gladiator's
-- rows, so the counters, the title rows and the worn_title update follow the shared order (coordinator, account lock, gladiator
-- row, wallet, items) without a new wait. The auto-wear update takes the gladiator row last. Creation inserts the gladiator
-- itself in the same transaction. The deferred projectors run at commit and take the global revision lock last. Trigger
-- functions are not directly executable. The back-fill (section 5) takes table locks instead of account locks; its comment
-- says why.
--
-- Every statement is reapplicable.
begin;

-- 1. Tables.
-- The titles a gladiator has earned: one row per title, never changed or deleted (guard_frozen). activity_id has no foreign
-- key: activities are pruned after 90 days, the title stays. detail is null or an object (a season award's
-- {seasonIndex, league, place}).
create table if not exists public.gladiator_titles (
  gladiator_id uuid not null references public.gladiators(id),
  title_id text not null check (title_id ~ '^[a-z][a-z-]{1,30}$'),
  earned_at_ms bigint not null check (earned_at_ms>=0),
  activity_id uuid,
  source text not null check (source in ('history','result','season','shop','market','sale','joined')),
  detail jsonb check (detail is null or jsonb_typeof(detail)='object'),
  primary key (gladiator_id,title_id)
);
-- The stored measures (counters), by name; they only grow except the Arena streak.
create table if not exists public.title_counters (
  gladiator_id uuid not null references public.gladiators(id),
  counter text not null check (counter ~ '^[a-z][a-z0-9-]{1,40}$'),
  value bigint not null check (value between 0 and 9007199254740991),
  primary key (gladiator_id,counter)
);
-- The ownership history: each catalog id (item, tier and kind) a gladiator has ever owned, the first time it was seen.
create table if not exists public.item_firsts (
  gladiator_id uuid not null references public.gladiators(id),
  catalog_id text not null check (catalog_id ~ '^[a-z][a-z-]*:(1|5|10):(common|uncommon|rare|renown)$'),
  first_at_ms bigint not null check (first_at_ms>=0),
  primary key (gladiator_id,catalog_id)
);
-- The worn title: null (none) or an earned one. Deferred, so a gladiator's first title and its auto-wear may be written in
-- either order within one transaction; checked at commit (23503).
alter table public.gladiators add column if not exists worn_title text;
alter table public.gladiators drop constraint if exists gladiators_worn_title_fkey;
alter table public.gladiators add constraint gladiators_worn_title_fkey foreign key (id,worn_title)
  references public.gladiator_titles(gladiator_id,title_id) deferrable initially deferred;
-- The public count of earned titles (Task 4's projector publishes it).
alter table public.public_profiles add column if not exists titles_earned integer not null default 0;
-- The release back-fill's one record (Task 5): the owner's only, like private.economy_switches.
create table if not exists private.title_backfills (
  singleton boolean primary key default true check (singleton),
  ran_at_ms bigint not null check (ran_at_ms>=0),
  result jsonb not null check (jsonb_typeof(result)='object')
);
alter table private.title_backfills enable row level security;
revoke all on private.title_backfills from public,anon,authenticated,service_role;

-- A new public table gets service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN by default: everything is revoked first, then
-- the owner's read and the backend's writes are granted. No DELETE for anyone.
do $$ declare t text; begin
  foreach t in array array['gladiator_titles','title_counters','item_firsts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant select,insert on public.%I to service_role',t);
    execute format('drop policy if exists owner_read on public.%I',t);
    execute format('create policy owner_read on public.%I for select to authenticated using (gladiator_id in (select id from public.gladiators where owner_id = (select auth.uid())))',t);
  end loop;
end $$;
grant update on public.title_counters to service_role;

-- Never taken back: title rows and the ownership history refuse update and delete ('immutable <table>').
drop trigger if exists guard_frozen on public.gladiator_titles;
create trigger guard_frozen before update or delete on public.gladiator_titles for each row execute function private.guard_frozen();
drop trigger if exists guard_frozen on public.item_firsts;
create trigger guard_frozen before update or delete on public.item_firsts for each row execute function private.guard_frozen();
-- A new title republishes the gladiator at commit (its titles_earned, Task 4), as the other character tables do.
drop trigger if exists project_changed_character on public.gladiator_titles;
create constraint trigger project_changed_character after insert or update or delete on public.gladiator_titles
  deferrable initially deferred for each row execute function private.project_changed_character();

-- 2. The rules, the measures and awarding.
-- TITLES_V1's 31 rules in catalog order (the accepted restatement above): id, measure, threshold, tier (1-3 or null).
create or replace function private.title_rules() returns jsonb language sql immutable security invoker set search_path='' as $$
  select '[
    {"id":"founder","measure":"founder","threshold":1,"tier":null},
    {"id":"old-guard","measure":"days-in-camp","threshold":100,"tier":null},
    {"id":"bannerman","measure":"banner","threshold":1,"tier":null},
    {"id":"wanderer","measure":"expeditions-won","threshold":10,"tier":1},
    {"id":"pathfinder","measure":"expeditions-won","threshold":50,"tier":2},
    {"id":"trailblazer","measure":"expeditions-won","threshold":200,"tier":3},
    {"id":"wolfbane","measure":"woodland-won","threshold":25,"tier":null},
    {"id":"raiders-bane","measure":"outpost-won","threshold":25,"tier":null},
    {"id":"troll-slayer","measure":"mountain-won","threshold":25,"tier":null},
    {"id":"tiro","measure":"trainings","threshold":10,"tier":1},
    {"id":"disciplined","measure":"trainings","threshold":100,"tier":2},
    {"id":"doctore","measure":"trainings","threshold":400,"tier":3},
    {"id":"bloodied","measure":"arena-wins","threshold":1,"tier":1},
    {"id":"crowd-pleaser","measure":"arena-wins","threshold":25,"tier":2},
    {"id":"lion","measure":"arena-wins","threshold":100,"tier":3},
    {"id":"invictus","measure":"arena-best-streak","threshold":5,"tier":null},
    {"id":"finalist","measure":"tournament-finals","threshold":1,"tier":null},
    {"id":"victor","measure":"tournament-wins","threshold":1,"tier":null},
    {"id":"triumphator","measure":"tournament-wins","threshold":5,"tier":null},
    {"id":"medalist","measure":"season-top-three","threshold":1,"tier":null},
    {"id":"champion","measure":"season-firsts","threshold":1,"tier":null},
    {"id":"thrice-crowned","measure":"season-firsts","threshold":3,"tier":null},
    {"id":"collector","measure":"items-owned","threshold":10,"tier":1},
    {"id":"curator","measure":"items-owned","threshold":40,"tier":2},
    {"id":"antiquarian","measure":"items-owned","threshold":100,"tier":3},
    {"id":"tempered","measure":"tiers-of-one","threshold":3,"tier":null},
    {"id":"connoisseur","measure":"rarities-of-one","threshold":3,"tier":null},
    {"id":"rare-find","measure":"rare-items","threshold":1,"tier":null},
    {"id":"moneyed","measure":"gold-earned","threshold":1000,"tier":1},
    {"id":"patrician","measure":"gold-earned","threshold":4000,"tier":2},
    {"id":"croesus","measure":"gold-earned","threshold":12000,"tier":3}
  ]'::jsonb
$$;

-- Founder's line: the end of Season 1 (public.seasons row season_index 0; 1795339200000 in production). Null without that row,
-- and then nobody is a founder.
create or replace function private.founder_cutoff_ms() returns bigint language sql stable security invoker set search_path='' as $$
  select s.ends_at_ms from public.seasons s where s.season_index=0
$$;

-- Every measure of a gladiator at at_ms: the 18 stored counters (0 when absent; the accepted restatement of STORED_COUNTERS)
-- and any other stored one, plus the derived gold-earned (gold-v2 + one floor of gold-v1 / 4, never per credit), days-in-camp
-- (whole days from created_at_ms to at_ms), founder (1 when made before the cutoff) and banner (1 when it owns the Arena banner).
-- Null for an unknown gladiator.
create or replace function private.title_measures(gid uuid, at_ms bigint) returns jsonb
language sql stable security invoker set search_path='' as $$
  select '{"expeditions-won":0,"woodland-won":0,"outpost-won":0,"mountain-won":0,"trainings":0,"arena-wins":0,"arena-streak":0,
      "arena-best-streak":0,"tournament-finals":0,"tournament-wins":0,"season-top-three":0,"season-firsts":0,"gold-v1":0,"gold-v2":0,
      "items-owned":0,"rare-items":0,"tiers-of-one":0,"rarities-of-one":0}'::jsonb
    ||coalesce((select jsonb_object_agg(c.counter,c.value) from public.title_counters c where c.gladiator_id=g.id),'{}'::jsonb)
    ||jsonb_build_object(
      'gold-earned',coalesce((select c.value from public.title_counters c where c.gladiator_id=g.id and c.counter='gold-v2'),0)
        +coalesce((select c.value from public.title_counters c where c.gladiator_id=g.id and c.counter='gold-v1'),0)/4,
      'days-in-camp',floor((title_measures.at_ms-g.created_at_ms)::numeric/86400000)::bigint,
      'founder',case when g.created_at_ms<private.founder_cutoff_ms() then 1 else 0 end,
      'banner',case when exists(select 1 from public.owned_cosmetics o where o.gladiator_id=g.id and o.catalog_id='banner') then 1 else 0 end)
  from public.gladiators g where g.id=title_measures.gid
$$;

-- One upsert each, returning the counter's new value. The caller holds the account lock; the table refuses a value outside
-- 0..9007199254740991.
create or replace function private.add_title_count(gid uuid, counter text, delta bigint) returns bigint
language sql security invoker set search_path='' as $$
  insert into public.title_counters as c(gladiator_id,counter,value)
    values(add_title_count.gid,add_title_count.counter,add_title_count.delta)
  on conflict (gladiator_id,counter) do update set value=c.value+excluded.value
  returning c.value
$$;
create or replace function private.set_title_count(gid uuid, counter text, value bigint) returns bigint
language sql security invoker set search_path='' as $$
  insert into public.title_counters as c(gladiator_id,counter,value)
    values(set_title_count.gid,set_title_count.counter,set_title_count.value)
  on conflict (gladiator_id,counter) do update set value=excluded.value
  returning c.value
$$;

-- Awarding (spec "Earning, wearing and notices"): every rule whose measure at at_ms reaches its threshold and that the
-- gladiator does not hold is granted, in catalog order, with one time, one source, the activity (a result's) and the detail.
-- When the gladiator held no title before this call and gained one, it wears one of the gained: Founder, else the highest
-- tier (III before II before I, then untiered), else the first in catalog order. Earning never changes what a gladiator that
-- already held a title wears, so a player who chose No title keeps none. Returns the number granted.
create or replace function private.award_titles(gid uuid, at_ms bigint, activity uuid, source text, detail jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare measures jsonb; held boolean; gained text[]; first_title text;
begin
  measures:=private.title_measures(award_titles.gid,award_titles.at_ms);
  if measures is null then return 0; end if;
  held:=exists(select 1 from public.gladiator_titles t where t.gladiator_id=award_titles.gid);
  with granted as (
    insert into public.gladiator_titles(gladiator_id,title_id,earned_at_ms,activity_id,source,detail)
      select award_titles.gid,r.rule->>'id',award_titles.at_ms,award_titles.activity,award_titles.source,award_titles.detail
      from jsonb_array_elements(private.title_rules()) with ordinality r(rule,ord)
      where (measures->>(r.rule->>'measure'))::bigint>=(r.rule->>'threshold')::bigint
      order by r.ord
    on conflict do nothing
    returning title_id
  )
  select coalesce(array_agg(g.title_id),'{}'::text[]) into gained from granted g;
  if not held and cardinality(gained)>0 then
    select r.rule->>'id' into first_title from jsonb_array_elements(private.title_rules()) with ordinality r(rule,ord)
      where r.rule->>'id'=any(gained)
      order by r.rule->>'id'='founder' desc,(r.rule->>'tier')::integer desc nulls last,r.ord
      limit 1;
    update public.gladiators set worn_title=first_title where id=award_titles.gid;
  end if;
  return cardinality(gained);
end $$;

-- Founder at creation (source 'joined', at created_at_ms; no notice). Every new gladiator is checked, so one made after the
-- cutoff, or while no season 0 row exists, earns nothing here.
create or replace function private.titles_on_gladiator() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  perform private.award_titles(new.id,new.created_at_ms,null,'joined',null);
  return null;
end $$;
drop trigger if exists titles_on_gladiator on public.gladiators;
create trigger titles_on_gladiator after insert on public.gladiators for each row execute function private.titles_on_gladiator();

-- A new function is executable by PUBLIC by default. The helpers are the backend's (the counting triggers run in service_role's
-- writes); the trigger function is executable by nobody.
revoke all on function private.title_rules(),private.founder_cutoff_ms(),private.title_measures(uuid,bigint),
  private.add_title_count(uuid,text,bigint),private.set_title_count(uuid,text,bigint),
  private.award_titles(uuid,bigint,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function private.title_rules(),private.founder_cutoff_ms(),private.title_measures(uuid,bigint),
  private.add_title_count(uuid,text,bigint),private.set_title_count(uuid,text,bigint),
  private.award_titles(uuid,bigint,uuid,text,jsonb) to service_role;
revoke all on function private.titles_on_gladiator() from public,anon,authenticated,service_role;

-- 3. Counting (spec "Triggers", "What each measure counts", "Gold", "Time"). Each trigger counts its writer's event in that
-- writer's own transaction (a failing trigger rolls the whole write back) and awards at the end of the write that earned
-- something: a settlement when its activity completes, with that activity at its settled_at_ms (the loot found and the gold
-- credited earlier in the same settlement are already counted, so their titles join the result); a season award at its
-- awarded_at_ms; a purchase or an NPC sale at the database time, sampled once per trigger call.
--
-- Lock order (Task 2 review ruling: award_titles relies on its caller holding the gladiator's account lock for the held ->
-- auto-wear step). No trigger takes a lock of its own before its writer's; every writer that fires an awarding trigger has
-- already taken the gladiator's account advisory lock:
--   titles_on_activity       private.settle_activity_core, the only writer that completes an activity: the account lock, then
--                            the gladiator row, the wallet and the items, before any grant.
--   titles_on_ledger         an NPC sale: private.inventory_command 'sell-item' (the account lock, the gladiator row, the wallet,
--                            the items). Settlement and season credits only count here.
--   titles_on_item           private.apply_inventory_plan (the account lock, then the gladiator row) from 'buy-shop'
--                            (inventory_command, which took the same lock first) and from an expedition settlement (counted
--                            only); public.create_gladiator's starter items (the actor's account lock; the gladiator row is its
--                            own new row).
--   titles_on_item_move      private.market_command 'buy-listing': both accounts' locks in gladiator order, then both rows.
--   titles_on_season_award   private.close_season: each awarded account's lock, then its wallet. The auto-wear then takes the
--                            gladiator row last; every other holder of a gladiator row takes its account lock first, so none
--                            can hold or wait for that row here (spec "Lock order").
--   titles_on_banner         private.inventory_command 'buy-shop' of the banner (the account lock, the gladiator row).
-- tests/db/titles.test.ts runs each path end to end under a lock probe that fails any title written without the lock.

-- The four ownership measures from public.item_firsts: its rows; its rare rows; the most distinct tiers (1, 5, 10) held by one
-- item template (a renown variant is a tier of its template); the most distinct of common, uncommon and rare held by one template
-- at one tier. The history only grows, so these only grow.
create or replace function private.refresh_item_counters(gid uuid) returns void
language sql security invoker set search_path='' as $$
  with f as (
    select split_part(x.catalog_id,':',1) as template,split_part(x.catalog_id,':',2) as tier,split_part(x.catalog_id,':',3) as kind
    from public.item_firsts x where x.gladiator_id=refresh_item_counters.gid
  )
  insert into public.title_counters as c(gladiator_id,counter,value)
    select refresh_item_counters.gid,m.counter,m.value from (values
      ('items-owned',(select count(*) from f)),
      ('rare-items',(select count(*) from f where f.kind='rare')),
      ('tiers-of-one',(select coalesce(max(t.n),0) from (select count(distinct f.tier) as n from f group by f.template) t)),
      ('rarities-of-one',(select coalesce(max(r.n),0) from (select count(distinct f.kind) as n from f
        where f.kind in ('common','uncommon','rare') group by f.template,f.tier) r))
    ) m(counter,value)
  on conflict (gladiator_id,counter) do update set value=excluded.value
$$;

-- A result (after update of status, when an activity first becomes completed). A Training counts with or without a point; an
-- expedition counts when won (summary.success: all three fights), by trip for the three the server knows (any other counts toward
-- expeditions-won only); an Arena bout won adds a win and to the run, raising the best run to it, and a loss ends the run; a
-- tournament counts from its placement (1: a win and a final, 2: a final). A Rest counts and awards nothing. The award's time
-- is the result's settled_at_ms (settle_activity_core always sets it); an activity an operator completes without one is awarded
-- at the database time.
create or replace function private.titles_on_activity() returns trigger language plpgsql security invoker set search_path='' as $$
declare won boolean:=new.summary->>'success'='true'; placed integer; streak bigint;
begin
  if new.resolved_kind='training' then
    perform private.add_title_count(new.gladiator_id,'trainings',1);
  elsif new.resolved_kind='expedition' and won then
    perform private.add_title_count(new.gladiator_id,'expeditions-won',1);
    if new.requested->>'expeditionId' in ('woodland','outpost','mountain') then
      perform private.add_title_count(new.gladiator_id,(new.requested->>'expeditionId')||'-won',1);
    end if;
  elsif new.resolved_kind='arena' and won then
    perform private.add_title_count(new.gladiator_id,'arena-wins',1);
    streak:=private.add_title_count(new.gladiator_id,'arena-streak',1);
    if streak>coalesce((select c.value from public.title_counters c
        where c.gladiator_id=new.gladiator_id and c.counter='arena-best-streak'),0) then
      perform private.set_title_count(new.gladiator_id,'arena-best-streak',streak);
    end if;
  elsif new.resolved_kind='arena' then
    perform private.set_title_count(new.gladiator_id,'arena-streak',0);
  elsif new.resolved_kind='tournament' then
    select p.place into placed from public.tournament_placements p where p.activity_id=new.id;
    if placed=1 then perform private.add_title_count(new.gladiator_id,'tournament-wins',1); end if;
    if placed in (1,2) then perform private.add_title_count(new.gladiator_id,'tournament-finals',1); end if;
  end if;
  if new.resolved_kind is distinct from 'rest' then
    perform private.award_titles(new.gladiator_id,
      coalesce(new.settled_at_ms,floor(extract(epoch from clock_timestamp())*1000)::bigint),new.id,'result',null);
  end if;
  return null;
end $$;
drop trigger if exists titles_on_activity on public.activities;
create trigger titles_on_activity after update of status on public.activities for each row
  when (old.status is distinct from 'completed' and new.status='completed') execute function private.titles_on_activity();

-- Gold earned from play (spec "Gold"; the trigger's WHEN: a credit above 0 from a result, a season or an NPC sale). Ruling S1
-- (refined): into gold-v1 while the pre-1.6 rules v1 are active, else gold-v2, so only v1 gold counts at a quarter and any later
-- version counts unscaled. The version is read through private.active_rules_version() at write time, never from
-- private.economy_switches (no API role may read it, and settlements and sales run as service_role). The switch flips the active
-- version in its own commit, so this is the spec's "before switched_at_ms" (the back-fill reads switched_at_ms for history). An
-- NPC sale of an item the gladiator bought in a shop itself (its id in the gladiator's own successful buy-shop receipts) never
-- counts. Only an NPC sale awards here; a settlement's or a season's gold is awarded with its result or its award.
create or replace function private.titles_on_ledger() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.reason='npc-sale' and exists(select 1 from public.operation_receipts sale join public.operation_receipts bought
      on bought.gladiator_id=new.gladiator_id and bought.request->>'kind'='buy-shop' and bought.result->>'ok'='true'
      where sale.receipt_id=new.receipt_id and bought.result->'value'->'itemIds' ? (sale.request->>'itemId')) then
    return null;
  end if;
  perform private.add_title_count(new.gladiator_id,
    case when private.active_rules_version()='v1' then 'gold-v1' else 'gold-v2' end,new.money_delta);
  if new.reason='npc-sale' then
    perform private.award_titles(new.gladiator_id,floor(extract(epoch from clock_timestamp())*1000)::bigint,null,'sale',null);
  end if;
  return null;
end $$;
drop trigger if exists titles_on_ledger on public.wallet_ledger;
create trigger titles_on_ledger after insert on public.wallet_ledger for each row
  when (new.money_delta>0 and new.reason in ('expedition','arena','tournament','season','npc-sale'))
  execute function private.titles_on_ledger();

-- The ownership history (spec "The ownership history"): an item inserted for a gladiator (a find, a shop purchase, a starter
-- item) or moved to it by a market purchase adds its catalog id the first time only; salvage never counts (the triggers' WHEN).
-- A new id refreshes the four ownership measures and then awards at the database time: 'market' for a purchase moved to the
-- gladiator, else 'shop', except a find (origin expedition), which is awarded with its result. An id seen before earns nothing.
-- One function serves both triggers (ruling D1).
create or replace function private.titles_on_item() returns trigger language plpgsql security invoker set search_path='' as $$
declare at_ms bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint; added integer;
begin
  insert into public.item_firsts(gladiator_id,catalog_id,first_at_ms) values(new.gladiator_id,new.item->>'catalogId',at_ms)
    on conflict do nothing;
  get diagnostics added=row_count;
  if added=0 then return null; end if;
  perform private.refresh_item_counters(new.gladiator_id);
  if tg_op='UPDATE' then
    perform private.award_titles(new.gladiator_id,at_ms,null,'market',null);
  elsif new.item->>'origin' is distinct from 'expedition' then
    perform private.award_titles(new.gladiator_id,at_ms,null,'shop',null);
  end if;
  return null;
end $$;
drop trigger if exists titles_on_item on public.item_instances;
create trigger titles_on_item after insert on public.item_instances for each row
  when (new.item->>'catalogId' is distinct from 'salvage') execute function private.titles_on_item();
drop trigger if exists titles_on_item_move on public.item_instances;
create trigger titles_on_item_move after update of gladiator_id on public.item_instances for each row
  when (old.gladiator_id is distinct from new.gladiator_id and new.item->>'catalogId' is distinct from 'salvage')
  execute function private.titles_on_item();

-- A season award (places 1-3): a top-three place, and a first place at place 1; awarded at awarded_at_ms with the award's
-- {seasonIndex, league, place}. The season's gold was credited (and counted) just before, in the same close.
create or replace function private.titles_on_season_award() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  perform private.add_title_count(new.gladiator_id,'season-top-three',1);
  if new.place=1 then perform private.add_title_count(new.gladiator_id,'season-firsts',1); end if;
  perform private.award_titles(new.gladiator_id,new.awarded_at_ms,null,'season',
    jsonb_build_object('seasonIndex',new.season_index,'league',new.league,'place',new.place));
  return null;
end $$;
drop trigger if exists titles_on_season_award on private.season_awards;
create trigger titles_on_season_award after insert on private.season_awards for each row
  execute function private.titles_on_season_award();

-- The Arena banner bought (its measure reads public.owned_cosmetics): awarded at the database time, source 'shop'.
create or replace function private.titles_on_banner() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  perform private.award_titles(new.gladiator_id,floor(extract(epoch from clock_timestamp())*1000)::bigint,null,'shop',null);
  return null;
end $$;
drop trigger if exists titles_on_banner on public.owned_cosmetics;
create trigger titles_on_banner after insert on public.owned_cosmetics for each row when (new.catalog_id='banner')
  execute function private.titles_on_banner();

-- The ownership measures are the backend's, like the other helpers; the trigger functions are executable by nobody.
revoke all on function private.refresh_item_counters(uuid) from public,anon,authenticated;
grant execute on function private.refresh_item_counters(uuid) to service_role;
revoke all on function private.titles_on_activity(),private.titles_on_ledger(),private.titles_on_item(),
  private.titles_on_season_award(),private.titles_on_banner() from public,anon,authenticated,service_role;

-- 4. Wearing, and the reads (spec "The command wear-title", "Public and owner reads", "Access matrix and probes"). Only the worn
-- id (the world actor's `title`) and a count (the profile's `titlesEarned`) are ever public; the owner reads its titles, their
-- sources and times, and its progress. The three restated objects come from the latest sources (global constraints: "Restate
-- from the latest source") and change only what the spec names.

-- public.wear_title(actor_id, operation_id, input): the caller's own gladiator wears an earned title or none, free, any time.
-- Shaped like public.change_appearance (18-messages.sql): the account lock; the receipt replay (a replay returns the stored
-- result, another body under the same operation is `conflict`, both before any shape check); exactly the keys `kind`,
-- `operationId` (the operation id as text, which the backend sends lowercased like every command) and `titleId`; `titleId`
-- null or a string of the id pattern, else `invalid`; the caller's own gladiator `for update` (`not-found` without one: the
-- command names no gladiator, so no other can change); a title it does not hold (a catalog title not earned, or an id no
-- catalog has) is `invalid`; the update only when it differs, which fires the deferred project_changed_character trigger, so
-- the world actor is republished and the world revision rises at commit (an unchanged title publishes nothing); then the
-- receipt. No refusal writes a receipt. It never answers `processing`: a title does not depend on the world clock. The held
-- check is the command's own; the deferred gladiators_worn_title_fkey is the table's guarantee (titles are never deleted, so
-- a title held here is still held at commit).
-- Result: {ok:true, receiptId, value:{titleId, receivedAtMs}}. Backend only (EXECUTE for service_role).
create or replace function public.wear_title(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prior public.operation_receipts%rowtype; g public.gladiators%rowtype; wanted text; now_ms bigint;
  receipt uuid:=gen_random_uuid(); result jsonb;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=wear_title.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  -- Each term is true or false, never null (a null term would let the OR chain fall through).
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['kind','operationId','titleId']
    or c->>'kind' is distinct from 'wear-title' or c->>'operationId' is distinct from operation_id::text
    or coalesce(jsonb_typeof(c->'titleId') not in ('null','string'),true)
    or coalesce(c->>'titleId' !~ '^[a-z][a-z-]{1,30}$',false) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  wanted:=c->>'titleId';
  if wanted is not null and not exists(select 1 from public.gladiator_titles t where t.gladiator_id=g.id and t.title_id=wanted) then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  now_ms:=private.planning_now_ms();
  update public.gladiators set worn_title=wanted where id=g.id and worn_title is distinct from wanted;
  result:=jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('titleId',wanted,'receivedAtMs',now_ms));
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  return result;
end $$;

revoke all on function public.wear_title(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wear_title(uuid,uuid,jsonb) to service_role;

-- private.project_character: 20-profile-card.sql's projector (M26; no later source restates it), unchanged except
--   - the actor's `title`: the worn id or null (g.worn_title), after `appearance`. Every client reads it within one poll; an
--     older client ignores it;
--   - the public_profiles upsert's titles_earned: the count of the gladiator's title rows, in its insert, update and
--     is-distinct check (an unchanged profile is still not written).
-- Its triggers are today's, plus section 1's deferred trigger on public.gladiator_titles: a wear (the gladiators row) or a new
-- title (its row) republishes the gladiator at commit. Its ACL is restated as 20-profile-card.sql grants it.
create or replace function private.project_character(gid uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare g public.gladiators%rowtype; b jsonb; a public.activities%rowtype; actor jsonb; silhouettes jsonb; awarded_prestige jsonb;
  resting boolean; card jsonb;
begin
  select * into g from public.gladiators where id=gid;
  if not found then return; end if;
  select current_build into b from public.builds where gladiator_id=gid;
  if b is null then return; end if;
  -- Only an authoritative published activity is visible. Preparing snapshots remain private.
  select * into a from public.activities where gladiator_id=gid and status<>'preparing'
    and published_at_ms is not null and published_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
    order by slot_index desc limit 1;
  -- Task 23.8: resting in its processed slot, it shows no activity, whatever its latest one was.
  resting:=exists(select 1 from public.character_rests r where r.gladiator_id=gid and r.since_slot<=g.processed_slot_index
    and g.processed_slot_index<=r.through_slot);
  select coalesce(jsonb_agg(silhouette order by silhouette),'[]'::jsonb) into silhouettes from (
    select case split_part(i.item->>'catalogId',':',1)
      when 'sword' then 'weapon-sword' when 'axe' then 'weapon-axe' when 'spear' then 'weapon-spear' when 'bow' then 'weapon-bow'
      when 'round-shield' then 'offhand-shield' when 'leather-hood' then 'head-hood' when 'iron-helmet' then 'head-helmet'
      when 'light-armor' then 'armor-light' when 'heavy-armor' then 'armor-heavy' when 'light-boots' then 'feet-light'
      when 'heavy-boots' then 'feet-heavy' end as silhouette
    from public.item_instances i where i.gladiator_id=gid
      and i.id in (select value::uuid from jsonb_each_text(b->'equipment') where value is not null)
  ) equipment where silhouette is not null;
  -- M24: the chosen look, null for the legacy look. M28: the worn title, null for none.
  actor:=jsonb_build_object('gladiatorId',g.id,'name',g.name,'classId',b->'classId','equipmentSilhouettes',silhouettes,'appearance',g.appearance,
    'title',g.worn_title,'league',g.league,'level',g.level,
    'phase',private.slot_phase(case when resting then g.processed_slot_index else coalesce(a.slot_index,g.processed_slot_index) end),
    'location',case when resting then 'camp' when a.id is null then 'orientation' when a.resolved_kind='expedition' then 'expedition:'||(a.requested->>'expeditionId') else a.resolved_kind end,
    'activityId',case when not resting then a.id end,'activityStatus',case when resting then 'idle' when a.id is null then 'active' else a.status end,
    'startsAtMs',case when not resting then coalesce(a.starts_at_ms,g.created_at_ms) end,
    'endsAtMs',case when not resting then coalesce(a.ends_at_ms,g.orientation_end_ms) end,'visibleStage',null,'resting',resting);
  insert into public.world_actors(gladiator_id,actor,processed_slot_index) values(gid,actor,g.processed_slot_index)
    on conflict(gladiator_id) do update set actor=excluded.actor,processed_slot_index=excluded.processed_slot_index
    where (world_actors.actor,world_actors.processed_slot_index) is distinct from (excluded.actor,excluded.processed_slot_index);
  -- Task 21: prestige, one entry per season award.
  select coalesce(jsonb_agg(jsonb_build_object('seasonIndex',x.season_index,'league',x.league,'place',x.place,'badge',x.badge,'title',x.title)
    order by x.season_index),'[]'::jsonb) into awarded_prestige from private.season_awards x where x.gladiator_id=gid;
  -- Task 11c: the profile card's build, from the CURRENT build only (never pending_build): the stance, the points and each worn item's
  -- public fields, never its id, owner, origin, binding or reservation; a slot with nothing worn is null.
  card:=jsonb_build_object('stance',b->'stance','allocations',b->'allocations','equipment',
    (select jsonb_object_agg(s.slot,(select jsonb_build_object('catalogId',i.item->'catalogId','catalogVersion',
       i.item->'catalogVersion','tier',i.item->'tier','rarity',i.item->'rarity','stats',i.item->'stats')
       from public.item_instances i where i.gladiator_id=gid and i.id=(b->'equipment'->>s.slot)::uuid))
     from unnest(array['weapon','offHand','head','body','feet']) as s(slot)));
  -- Combined combat strength/league score belongs to Task 16. Never label gear history as that score.
  -- M28: titles_earned, the count of the gladiator's titles (never which, how or when).
  insert into public.public_profiles(gladiator_id,rating,prestige,build,joined_at_ms,titles_earned)
    values(gid,g.rating,awarded_prestige,card,g.created_at_ms,(select count(*) from public.gladiator_titles t where t.gladiator_id=gid))
    on conflict(gladiator_id) do update
    set rating=excluded.rating,prestige=excluded.prestige,build=excluded.build,joined_at_ms=excluded.joined_at_ms,titles_earned=excluded.titles_earned
    where (public_profiles.rating,public_profiles.prestige,public_profiles.build,public_profiles.joined_at_ms,public_profiles.titles_earned)
      is distinct from (excluded.rating,excluded.prestige,excluded.build,excluded.joined_at_ms,excluded.titles_earned);
  -- Task 22 (exception 4b): only new or changed rows reach the upsert; an unchanged row is neither written nor locked.
  insert into public.recent_results(activity_id,gladiator_id,name,reveal_at_ms,summary)
    select p.activity_id,p.gladiator_id,p.name,p.reveal_at_ms,p.summary from (
      select x.id as activity_id,gid as gladiator_id,g.name as name,x.settled_at_ms as reveal_at_ms,jsonb_build_object('activityId',x.id,'resolvedKind',x.resolved_kind,
        'result',x.summary->'result','success',x.summary->'success','settledAtMs',x.settled_at_ms,
        'replayExpiry',case when x.summary->'replayExpiry'->>'state'='available' then jsonb_build_object('state','available','expiresAtMs',x.summary->'replayExpiry'->'expiresAtMs') else jsonb_build_object('state','expired') end) as summary
      from public.activities x where x.gladiator_id=gid and x.status='completed' and x.summary is not null and x.settled_at_ms is not null
    ) p
    where not exists(select 1 from public.recent_results r where r.activity_id=p.activity_id
      and (r.name,r.summary,r.reveal_at_ms) is not distinct from (p.name,p.summary,p.reveal_at_ms))
    on conflict(activity_id) do update set name=excluded.name,summary=excluded.summary,reveal_at_ms=excluded.reveal_at_ms
    where (recent_results.name,recent_results.summary,recent_results.reveal_at_ms) is distinct from (excluded.name,excluded.summary,excluded.reveal_at_ms);
  -- Task 16: every league-season rating record of the character, as public standings (rating and human counters only).
  insert into public.arena_standings(gladiator_id,league,season_index,name,rating,human_wins,human_losses)
    select r.gladiator_id,r.league,r.season_index,g.name,r.rating,r.human_wins,r.human_losses from private.arena_ratings r where r.gladiator_id=gid
    on conflict(gladiator_id,league,season_index) do update set name=excluded.name,rating=excluded.rating,
      human_wins=excluded.human_wins,human_losses=excluded.human_losses
    where (arena_standings.name,arena_standings.rating,arena_standings.human_wins,arena_standings.human_losses)
      is distinct from (excluded.name,excluded.rating,excluded.human_wins,excluded.human_losses);
end $$;

-- Restated as 20-profile-card.sql grants it: the backend's (service_role) only.
revoke all on function private.project_character(uuid) from public, anon, authenticated;
grant execute on function private.project_character(uuid) to service_role;

-- public.public_profile_reads: 21-economy.sql's complete invoker read (M27: build, joinedAtMs, arenaRecord and banner), with
-- titlesEarned added. The WITH clause restates security_invoker (CREATE OR REPLACE VIEW replaces a view's options with the ones
-- it names), and the grants are restated after it, revokes first.
create or replace view public.public_profile_reads with(security_invoker=true) as
  select p.gladiator_id,jsonb_build_object('actor',w.actor,'combatStrength',p.combat_strength,'rating',p.rating,'prestige',p.prestige,
    'build',p.build,'joinedAtMs',p.joined_at_ms,'arenaRecord',(select jsonb_build_object(
      'wins',coalesce(sum(s.human_wins),0)::bigint,'losses',coalesce(sum(s.human_losses),0)::bigint)
      from public.arena_standings s where s.gladiator_id=p.gladiator_id),'banner',p.banner,'titlesEarned',p.titles_earned) as profile
  from public.public_profiles p join public.world_actor_reads w using(gladiator_id);
revoke all on public.public_profile_reads from public,anon,authenticated,service_role;
grant select on public.public_profile_reads to anon,authenticated,service_role;

-- public.owner_state: 18-messages.sql's view (section 4, the last statement there; no later source restates it), unchanged except
--   wornTitle       the worn id or null;
--   titles          [{id, earnedAtMs, activityId, source, detail}], by earnedAtMs then id;
--   titleProgress   every stored counter of the gladiator (an absent one reads 0), plus gold-earned and days-in-camp now;
--   inbox.newNotifications  the results counted as before plus the title notices: the distinct (source, earned_at_ms) among its
--                   titles with no activity and a source other than `joined`, after greatest(mark, created_at_ms), the results'
--                   own rule (a title with an activity joins its result's notification; Founder at creation has no notice).
-- Accepted restatement (ruling R3): titleProgress's gold-earned (gold-v2 + one floor of gold-v1 / 4) and days-in-camp (whole
-- days from created_at_ms to the statement time) restate private.title_measures (section 2): the view is an invoker view that
-- the owner (authenticated) reads, and no client role may execute the private helper. tests/db/titles.test.ts compares both
-- with title_measures in one statement. Like the rest of the view it filters by the account itself (the owner's own
-- gladiator), because the backend (service_role) reads it past row security. create or replace keeps the grants; the WITH clause
-- restates security_invoker.
create or replace view public.owner_state with (security_invoker=true) as
select g.owner_id,jsonb_build_object(
  'gladiatorId',g.id,'name',g.name,'appearance',g.appearance,'currentBuild',b.current_build,'pendingBuild',b.pending_build,'buildVersion',b.version,
  'schedule',s.schedule,'scheduleVersion',s.version,'wallets',jsonb_build_object('money',w.money,'renown',w.renown),
  'reservedFees',jsonb_build_object('money',coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0),
    'renown',coalesce((select sum(r.renown) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0)),
  'inventory',coalesce((select jsonb_agg(i.item order by i.id) from public.item_instances i where i.gladiator_id=g.id),'[]'::jsonb),'inventoryCapacity',60,
  'ownedCosmetics',coalesce((select jsonb_agg(jsonb_build_object('catalogId',c.catalog_id,'catalogVersion',c.catalog_version,'binding',c.binding) order by c.catalog_id) from public.owned_cosmetics c where c.gladiator_id=g.id),'[]'::jsonb),
  'progression',jsonb_build_object('level',g.level,'xp',g.xp,'earnedAttributePoints',g.earned_points,'unspentAttributePoints',g.unspent_points,'league',g.league,'peakStrength',g.peak_strength,'rating',g.rating),
  'stamina',jsonb_build_object('current',g.stamina_current,'maximum',g.stamina_maximum),'tournamentOptIn',g.tournament_opt_in,'processedSlotIndex',g.processed_slot_index,
  'currentActivity',case when rest.gladiator_id is null then coalesce((select jsonb_build_object('id',a.id,'kind',coalesce(a.resolved_kind,a.requested->>'kind'),
      'status',case when a.status='completed' then 'completed' when a.status='preparing' then 'queued'
        when extract(epoch from statement_timestamp())*1000<a.ends_at_ms then 'active' else 'processing' end,
      'startsAtMs',a.starts_at_ms,'endsAtMs',a.ends_at_ms,
      'label',case coalesce(a.resolved_kind,a.requested->>'kind') when 'training' then 'Training'
        when 'rest' then case when a.fallback then 'Resting (not enough stamina)' else 'Resting' end
        when 'expedition' then 'Expedition' when 'arena' then 'Arena' else 'Tournament' end)
    from public.activities a where a.gladiator_id=g.id order by a.slot_index desc limit 1),
    jsonb_build_object('id',g.id,'kind','orientation','status',case when extract(epoch from statement_timestamp())*1000<g.orientation_end_ms then 'active' else 'processing' end,
      'startsAtMs',g.created_at_ms,'endsAtMs',g.orientation_end_ms,'label','Orientation')) end,
  'restingUntilSlot',case when rest.signalled_at_ms is not null then rest.through_slot+1 end,
  'wornTitle',g.worn_title,
  'titles',coalesce((select jsonb_agg(jsonb_build_object('id',t.title_id,'earnedAtMs',t.earned_at_ms,'activityId',t.activity_id,
      'source',t.source,'detail',t.detail) order by t.earned_at_ms,t.title_id)
    from public.gladiator_titles t where t.gladiator_id=g.id),'[]'::jsonb),
  'titleProgress',coalesce((select jsonb_object_agg(c.counter,c.value) from public.title_counters c where c.gladiator_id=g.id),'{}'::jsonb)
    ||jsonb_build_object('gold-earned',
      coalesce((select c.value from public.title_counters c where c.gladiator_id=g.id and c.counter='gold-v2'),0)
      +coalesce((select c.value from public.title_counters c where c.gladiator_id=g.id and c.counter='gold-v1'),0)/4,
      'days-in-camp',(floor(extract(epoch from statement_timestamp())*1000)::bigint-g.created_at_ms)/86400000),
  'inbox',jsonb_build_object(
    'unread',(select count(*) from public.game_messages m where not m.hidden and m.published_at_ms>g.created_at_ms
      and not exists(select 1 from public.message_reads r where r.owner_id=g.owner_id and r.message_id=m.id)),
    'readIds',coalesce((select jsonb_agg(r.message_id order by r.message_id) from public.message_reads r
      join public.game_messages m on m.id=r.message_id and not m.hidden where r.owner_id=g.owner_id),'[]'::jsonb),
    'sinceMs',g.created_at_ms,
    'newNotifications',(select count(*) from public.activities a where a.gladiator_id=g.id and a.status='completed'
      and a.resolved_kind in ('training','expedition','arena','tournament') and a.summary is not null and a.settled_at_ms is not null
      and a.settled_at_ms<=floor(extract(epoch from statement_timestamp())*1000)::bigint
      and a.settled_at_ms>greatest(coalesce(nm.seen_ms,0),g.created_at_ms))
      +(select count(*) from (select distinct t.source,t.earned_at_ms from public.gladiator_titles t where t.gladiator_id=g.id
        and t.activity_id is null and t.source<>'joined' and t.earned_at_ms>greatest(coalesce(nm.seen_ms,0),g.created_at_ms)) n),
    'notificationsSeenMs',greatest(coalesce(nm.seen_ms,0),g.created_at_ms))) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id
  left join public.character_rests rest on rest.gladiator_id=g.id and rest.since_slot<=g.processed_slot_index and g.processed_slot_index<=rest.through_slot
  left join public.notification_marks nm on nm.owner_id=g.owner_id;

-- Every actor carries its title and every profile its count at once (the new projector, run after its restatement).
select public.refresh_projections();

-- 5. The release back-fill (spec "The back-fill", and the "Back-fill" column of "What each measure counts"). Its one call is
-- the last statement of this source (and of M28, Task 7): after every trigger above exists. Later sections go above it.
--
-- private.backfill_titles() counts what the database still proves, once. Its private.title_backfills row records the result;
-- any later call returns that record with replayed true and writes nothing. At one database time T, sampled after its locks,
-- for each gladiator in id order:
--   1. The counters from history, each set (never added), and absent when 0:
--        expeditions-won        completed expeditions whose summary.success is true; woodland-won, outpost-won and
--                               mountain-won by requested.expeditionId (any other trip counts toward expeditions-won only);
--        trainings              the greater of the completed Trainings and earned_points - 10 (every earned point came from a
--                               Training, and the points outlive the activities' 90 days);
--        arena-wins             completed Arena activities won; in slot order, arena-streak is the wins since the last loss
--                               and arena-best-streak the longest run of wins (the live trigger's reading of the same bouts);
--        tournament-finals,     public.tournament_placements of completed activities: places 1 and 2, and place 1 (each
--        tournament-wins        settlement writes its placement and completes its activity in one transaction);
--        season-top-three,      private.season_awards: every award, and the first places;
--        season-firsts
--        gold-v1, gold-v2       wallet_ledger credits above 0 with reason expedition, arena, tournament, season or npc-sale,
--                               into gold-v1 when credited before private.economy_switches' v2 switched_at_ms (or when no
--                               switch is recorded), else gold-v2 (ruling S1: the live trigger buckets the same credits by the
--                               active rules version, which the switch flips in its own commit); an npc-sale of an item id
--                               listed in the gladiator's own successful buy-shop receipts never counts (the live trigger's
--                               test); market sales, the 1.6 cut and the starting 100 have other reasons.
--   2. The ownership history, every row at T: the two starter items every gladiator was given (sword:1:common,
--      light-armor:1:common); the items held now; the items of its completed activities' summary.rewards.items; the catalog
--      ids of its own successful buy-shop receipts (an item purchase: the banner's has no itemIds); and its market purchases
--      (sold listings with it as buyer), identified by the item if it still exists or else by the buy-shop receipt that made
--      it (a market-bought find gone since cannot be identified: missed). Only item catalog ids count (salvage, cosmetics and
--      anything else that is not one never do). Then private.refresh_item_counters.
--   3. private.award_titles(gid, T, null, 'history', null): every title its measures meet (days-in-camp, founder and banner
--      at T), and the first title worn (Founder, else the highest tier, else the catalog order). All of a gladiator's history
--      titles share one source and time: one release notice.
-- Result {ok: true, ranAtMs: T, gladiators (processed), titles (granted by this call), founders (gladiators holding Founder),
-- worn (gladiators wearing a title), replayed: false}; the release reads it back (spec "Release", step 3).
--
-- History it reads, and how long it lasts (14-operations.sql's retention matrix, 15-release.sql's cleanup): kept forever:
-- gladiators (earned_points), item_instances, private.season_awards, private.economy_switches and every operation receipt
-- (buy-shop and sell-item receipts are command receipts, never compacted; only settlement receipts' results are, and none is
-- read here); ninety days: completed activities with their summaries and tournament_placements (the ninety-day slot pass),
-- wallet_ledger rows (folded into wallet_checkpoints by created_at), and terminal market listings (deleted 90 days after
-- their expiry, itself 7 days after listing). The launch week's history leaves from 23 Jan 2027 09:20 UTC (its first credits),
-- so M28 runs before then (spec "Deadline").
--
-- Locks (Review Focus 4: run twice, or with a write waiting on the migration, nothing is counted twice).
--   - private.title_backfills EXCLUSIVE first: a second call waits for the first to commit, then reads its record and replays.
--   - public.gladiators EXCLUSIVE: every writer of a gladiator row, every insert that references one (a FOR KEY SHARE) and
--     wear_title wait; plain reads go on. So no other transaction holds a gladiator row the auto-wear updates, and none can
--     grant a title or change worn_title until the commit (award_titles' held -> auto-wear step relies on that, as it relies
--     on the account lock elsewhere).
--   - SHARE ROW EXCLUSIVE, the lock CREATE TRIGGER takes, on the other five tables a counting trigger watches
--     (public.activities, public.wallet_ledger, public.item_instances, public.owned_cosmetics, private.season_awards): no
--     counted write is in flight or can start until the commit; plain reads go on.
--   Inside M28 these are no-ops: the migration already holds them (its worn_title column on public.gladiators, its seven
--   triggers). Every counted write either committed before them, so this call reads it and the counters it sets include it
--   (counted once, here), or waits for this commit and then fires the triggers above, which add to the counters this call
--   set (counted once, there). Retention cleanup, which deletes history, waits too (its 500 ms lock_timeout makes it retry
--   in the next hour). No account lock is taken: in M28 the table locks come first, and an account lock after them could
--   deadlock with a command that holds its account lock and waits on those tables.
create or replace function private.backfill_titles() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prior jsonb; run_at bigint; switch_at bigint; who uuid; tally record; processed integer:=0; granted integer:=0; answer jsonb;
begin
  lock table private.title_backfills in exclusive mode;
  select b.result into prior from private.title_backfills b where b.singleton;
  if found then return prior||jsonb_build_object('replayed',true); end if;
  lock table public.gladiators in exclusive mode;
  lock table public.activities,public.wallet_ledger,public.item_instances,public.owned_cosmetics,private.season_awards
    in share row exclusive mode;
  run_at:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  select e.switched_at_ms into switch_at from private.economy_switches e where e.version='v2';
  for who in select g.id from public.gladiators g order by g.id loop
    -- 1. The counters.
    for tally in
      with done as (
        select a.slot_index,a.resolved_kind,a.requested->>'expeditionId' as trip,coalesce(a.summary->>'success'='true',false) as won
        from public.activities a where a.gladiator_id=who and a.status='completed'
      ), bouts as (
        -- Each loss opens a new run: the bouts that share a count of losses so far are one loss and the wins after it.
        select d.won,count(*) filter (where not d.won) over (order by d.slot_index) as losses
        from done d where d.resolved_kind='arena'
      ), runs as (
        select r.losses,count(*) filter (where r.won) as wins from bouts r group by r.losses
      ), places as (
        select p.place from public.tournament_placements p
          join public.activities a on a.id=p.activity_id and a.status='completed'
        where p.gladiator_id=who
      ), credits as (
        select l.money_delta,switch_at is null or floor(extract(epoch from l.created_at)*1000)<switch_at as early
        from public.wallet_ledger l
        where l.gladiator_id=who and l.money_delta>0 and l.reason in ('expedition','arena','tournament','season','npc-sale')
          and not (l.reason='npc-sale' and exists(select 1 from public.operation_receipts sale join public.operation_receipts bought
            on bought.gladiator_id=who and bought.request->>'kind'='buy-shop' and bought.result->>'ok'='true'
            where sale.receipt_id=l.receipt_id and bought.result->'value'->'itemIds' ? (sale.request->>'itemId')))
      )
      select x.counter,x.amount from (values
        ('expeditions-won',(select count(*) from done d where d.resolved_kind='expedition' and d.won)),
        ('woodland-won',(select count(*) from done d where d.resolved_kind='expedition' and d.won and d.trip='woodland')),
        ('outpost-won',(select count(*) from done d where d.resolved_kind='expedition' and d.won and d.trip='outpost')),
        ('mountain-won',(select count(*) from done d where d.resolved_kind='expedition' and d.won and d.trip='mountain')),
        ('trainings',greatest((select count(*) from done d where d.resolved_kind='training'),
          (select g.earned_points-10 from public.gladiators g where g.id=who))),
        ('arena-wins',(select count(*) from done d where d.resolved_kind='arena' and d.won)),
        ('arena-streak',coalesce((select r.wins from runs r order by r.losses desc limit 1),0)),
        ('arena-best-streak',coalesce((select max(r.wins) from runs r),0)),
        ('tournament-finals',(select count(*) from places p where p.place in (1,2))),
        ('tournament-wins',(select count(*) from places p where p.place=1)),
        ('season-top-three',(select count(*) from private.season_awards s where s.gladiator_id=who)),
        ('season-firsts',(select count(*) from private.season_awards s where s.gladiator_id=who and s.place=1)),
        ('gold-v1',coalesce((select sum(c.money_delta) from credits c where c.early),0)::bigint),
        ('gold-v2',coalesce((select sum(c.money_delta) from credits c where not c.early),0)::bigint)
      ) x(counter,amount) where x.amount>0
    loop
      perform private.set_title_count(who,tally.counter,tally.amount);
    end loop;
    -- 2. The ownership history.
    insert into public.item_firsts(gladiator_id,catalog_id,first_at_ms)
      select who,s.catalog_id,run_at from (
        select unnest(array['sword:1:common','light-armor:1:common']) as catalog_id
        union select i.item->>'catalogId' from public.item_instances i where i.gladiator_id=who
        union select e.entry->>'catalogId' from public.activities a
          cross join lateral jsonb_array_elements(case when jsonb_typeof(a.summary->'rewards'->'items')='array'
            then a.summary->'rewards'->'items' else '[]'::jsonb end) e(entry)
          where a.gladiator_id=who and a.status='completed'
        union select o.request->>'catalogId' from public.operation_receipts o
          where o.gladiator_id=who and o.request->>'kind'='buy-shop' and o.result->>'ok'='true'
            and jsonb_typeof(o.result->'value'->'itemIds')='array'
        union select coalesce(held.item->>'catalogId',(select o.request->>'catalogId' from public.operation_receipts o
            where o.request->>'kind'='buy-shop' and o.result->>'ok'='true' and o.result->'value'->'itemIds' ? m.item_id::text limit 1))
          from private.market_listings m left join public.item_instances held on held.id=m.item_id
          where m.status='sold' and m.buyer_gladiator_id=who
      ) s
      where s.catalog_id ~ '^[a-z][a-z-]*:(1|5|10):(common|uncommon|rare|renown)$'
    on conflict do nothing;
    perform private.refresh_item_counters(who);
    -- 3. The titles.
    granted:=granted+private.award_titles(who,run_at,null,'history',null);
    processed:=processed+1;
  end loop;
  answer:=jsonb_build_object('ok',true,'ranAtMs',run_at,'gladiators',processed,'titles',granted,
    'founders',(select count(*) from public.gladiator_titles t where t.title_id='founder'),
    'worn',(select count(*) from public.gladiators g where g.worn_title is not null),'replayed',false);
  insert into private.title_backfills(singleton,ran_at_ms,result) values(true,run_at,answer);
  return answer;
end $$;

-- The owner's only, like private.switch_to_economy_v2(): no API role (service_role included) may run it.
revoke all on function private.backfill_titles() from public,anon,authenticated,service_role;

-- The back-fill, once (a reapply replays its record). Last: every trigger it must precede exists above.
select private.backfill_titles();

notify pgrst, 'reload schema';
commit;
