-- Hand-given titles (patch 1.7.1) reapplicable source. Committed M01-M28 are immutable; deploy only the separately generated
-- migration M29 (supabase/migrations/*_patch_1_7_1.sql). Plan: docs/superpowers/plans/2026-11-06-hand-given-titles-1-7-1.md
-- ("Global constraints", Task 1); for everything the plan does not name, the 1.7 spec
-- docs/superpowers/specs/2026-10-30-titles-1-7-design.md and its source supabase/sql/22-titles.sql (M28).
--
-- Purpose: two titles nobody earns by playing, Game Master and High Ground (TITLES_V1's Special family, after Bannerman; the
-- measure `award`, supabase/functions/_shared/domain/titles.ts), which only the owner gives, with private.give_title. A given
-- title arrives as the usual title notice (owner_state counts a title with no activity and a source other than `joined`), is
-- worn at once, and the player may switch back any time (public.wear_title wears any title it holds). Kept forever like every
-- title (guard_frozen).
--
-- 1. The rules: private.title_rules() restated from 22-titles.sql with TITLES_V1's two hand-given rows after Bannerman (the
--    accepted restatement; tests/db/titles.test.ts compares it with TITLES_V1). No counter, trigger, settlement or back-fill
--    produces the measure `award` (private.title_measures holds no such key), and private.award_titles compares a missing
--    measure as null, so it never grants them; the release back-fill already ran once (its record replays). Its ACL is
--    restated as 22-titles.sql grants it.
-- 2. The source: public.gladiator_titles' source CHECK (22-titles.sql's inline gladiator_titles_source_check) widened with
--    'award', in one ALTER TABLE.
-- 3. Giving: private.give_title(gladiator_id, title_id), the owner's only (no API role, service_role included, may run it).
--
-- Lock order: give_title takes the gladiator's account advisory lock (hashtextextended(owner_id::text,0)), then the gladiator
-- row, the shared order (coordinator, account lock, gladiator row, wallet, items) of every writer that awards a title, and
-- samples the database time after both. The deferred project_changed_character triggers (on the title row and the gladiator
-- row) republish the gladiator at commit and take the global revision lock last.
--
-- At the release: M29 takes ACCESS EXCLUSIVE on public.gladiator_titles (the CHECK; the owner read and every title write wait
-- for its commit) and no other table lock; replacing title_rules and creating give_title lock no table.
--
-- Every statement is reapplicable.
begin;

-- 1. The rules. TITLES_V1's 33 rules in catalog order: 22-titles.sql's 31 and, after Bannerman, the two hand-given ones (measure
-- `award`, threshold 1, untiered).
create or replace function private.title_rules() returns jsonb language sql immutable security invoker set search_path='' as $$
  select '[
    {"id":"founder","measure":"founder","threshold":1,"tier":null},
    {"id":"old-guard","measure":"days-in-camp","threshold":100,"tier":null},
    {"id":"bannerman","measure":"banner","threshold":1,"tier":null},
    {"id":"game-master","measure":"award","threshold":1,"tier":null},
    {"id":"high-ground","measure":"award","threshold":1,"tier":null},
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

-- Restated as 22-titles.sql grants it: the backend's (the counting triggers award inside service_role's writes).
revoke all on function private.title_rules() from public,anon,authenticated;
grant execute on function private.title_rules() to service_role;

-- 2. The source: 'award' for a title the owner gave (no activity, no detail); every other source as 22-titles.sql states it.
alter table public.gladiator_titles drop constraint if exists gladiator_titles_source_check,
  add constraint gladiator_titles_source_check check (source in ('history','result','season','shop','market','sale','joined','award'));

-- 3. Giving (plan, "Global constraints"). private.give_title(gladiator_id, title_id): the owner gives a hand-given title (a
-- catalog id whose measure is `award`; anything else, a title earned by play or no title at all, is refused with 23514, and an
-- unknown gladiator with 23503, writing nothing). It takes the gladiator's account lock, then the gladiator row; then, at the
-- database time sampled after both, inserts the title row once (source 'award', no activity, no detail) and puts the title
-- on. Given a title it already holds, it changes nothing (not even an unchanged update) and says so: given false, and the
-- title it wears now. The deferred projectors republish the gladiator at commit (the world actor's title, the profile's
-- titles_earned: the count of its title rows), and the owner read counts the new title as a notice.
-- Result {ok: true, given, worn}: given whether this call gave it; worn the title the gladiator wears after the call.
create or replace function private.give_title(gladiator_id uuid, title_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare account uuid; worn text; at_ms bigint; added integer;
begin
  if not exists(select 1 from jsonb_array_elements(private.title_rules()) r(rule)
      where r.rule->>'id'=give_title.title_id and r.rule->>'measure'='award') then
    raise exception '% is not a hand-given title',coalesce(give_title.title_id,'null') using errcode='23514';
  end if;
  select g.owner_id into account from public.gladiators g where g.id=give_title.gladiator_id;
  if not found then
    raise exception 'no gladiator %',coalesce(give_title.gladiator_id::text,'null') using errcode='23503';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(account::text,0));
  select g.worn_title into worn from public.gladiators g where g.id=give_title.gladiator_id for update;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  insert into public.gladiator_titles(gladiator_id,title_id,earned_at_ms,activity_id,source,detail)
    values(give_title.gladiator_id,give_title.title_id,at_ms,null,'award',null)
    on conflict do nothing;
  get diagnostics added=row_count;
  if added=0 then return jsonb_build_object('ok',true,'given',false,'worn',worn); end if;
  update public.gladiators set worn_title=give_title.title_id where id=give_title.gladiator_id;
  return jsonb_build_object('ok',true,'given',true,'worn',give_title.title_id);
end $$;

-- A new function is executable by PUBLIC by default. give_title is the owner's only (the owner always keeps EXECUTE): no client
-- role, and not service_role, like private.backfill_titles() and private.record_patch().
revoke all on function private.give_title(uuid,text) from public,anon,authenticated,service_role;

notify pgrst, 'reload schema';
commit;
