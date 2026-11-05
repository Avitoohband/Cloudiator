-- Wearable titles (patch 1.7) reapplicable source. Committed M01-M27 are immutable; deploy only the separately generated
-- migration M28 (supabase/migrations/*_patch_1_7.sql, Task 7). Spec: docs/superpowers/specs/2026-10-30-titles-1-7-design.md,
-- "Server: M28 from supabase/sql/22-titles.sql" ("Tables", "Functions", "Triggers", "Lock order", "Time"); plan:
-- docs/superpowers/plans/2026-10-30-titles-1-7.md, Tasks 2-5. Later tasks add their sections below section 2.
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
--
-- Accepted restatement: private.title_rules() restates TITLES_V1's id, measure, threshold and tier
-- (supabase/functions/_shared/domain/titles.ts) in catalog order, and private.title_measures restates its 18 stored counters
-- (STORED_COUNTERS); tests/db/titles.test.ts compares both with the TypeScript catalog, as private.season_rules() is pinned.
--
-- Lock order: every writer that awards (commands, settlements, the season close; Task 3's triggers) already holds the gladiator's
-- account advisory lock (hashtextextended(owner_id::text,0)) and touches only that gladiator's rows, so the counters, the title
-- rows and the worn_title update follow the shared order (coordinator, account lock, gladiator row, wallet, items) without a new
-- wait. The auto-wear update takes the gladiator row last. Creation inserts the gladiator itself in the same transaction. The
-- deferred projectors run at commit and take the global revision lock last. Trigger functions are not directly executable.
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

notify pgrst, 'reload schema';
commit;
