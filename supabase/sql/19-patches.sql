-- Patch numbers (2026-10-29) reapplicable source. Committed M01-M25 are immutable; deploy only the separately generated migration
-- M26 (Patch A's one database change). Spec: docs/superpowers/specs/2026-10-29-patch-a-design.md, "Patch numbers and the
-- changelog" ("Server: M26 from supabase/sql/19-patches.sql"); plan: docs/superpowers/plans/2026-10-29-patch-a.md, Task 11b.
--
-- Avi: "please also add patch numbers. it should be written somewhere at the server". The server keeps the list of patches (number,
-- title, release time, the patch note) and each patch's features, so a player sees the patch in the account menu and on each patch
-- note, an open game learns that a newer patch is out, and the marketing and video agents see what each patch added.
--
-- 1. public.patches and public.patch_features: public text in the access matrix's OPEN list (tests/fixtures/access.ts), like
--    public.game_messages: RLS on, SELECT for anon, authenticated and service_role, the policy player_read using (true). Nobody writes
--    through the Data API. Patch numbers say nothing about any player.
-- 2. private.record_patch: the operator records a patch and its features in one statement, stamped with the database clock
--    (operator-only, as private.post_message; docs/operations/runbook.md, "Recording a patch").
-- 3. public.world_revision: 15-release.sql's view with one more last column, latest_patch. Every client reads that view every 30 s,
--    on focus and on return to the tab, so the newest patch costs no new request, no Edge change and no new command; an older
--    client names its columns, so the new one changes nothing for it. No projection_changed trigger: the number comes with every
--    revision read, whatever the revision.
-- 4. The seed: 1.0 to 1.3.1 from docs/CHANGELOG.md's released sections, word for word (tests/db/patches.test.ts compares them),
--    with the release times of the spec's table ("The numbers"). The patch note of 1.1, 1.2, 1.3 and 1.3.1 is found by its kind and
--    exact title: production links notes 1-4; a local database (no notes) stores null.
--
-- Release order (spec "Release"): M26 first (the 1.4 client's revision read names latest_patch, so a 1.4 client could not read the
-- camp without it), then the client; once the 1.4 client is live and after Avi's go, the patch note (private.post_message), then
-- patch 1.4 (private.record_patch with the statement scripts/patch-statement.mjs writes). Recording 1.4 only after its client is
-- live means a reload always brings 1.4. Replacing world_revision takes an ACCESS EXCLUSIVE lock on the view until commit, so
-- revision reads wait for that moment.
--
-- Every statement is reapplicable.
begin;

-- 1. The patches. `number` is "1.0" or "1.2.1" (never "1.3.0" or "01.2"); its sort_key orders numbers as numbers (1.2.1 is
-- 1,002,001, 1.10 is 1,010,000) and is unique, so two spellings of one patch cannot both exist. The title is what players read
-- (1-80 characters, not blank). message_id is the patch note's id, null for a fix without a note, unique. There is no foreign key
-- to the note (spec, Claude's call): the database tests' reset truncates game_messages on its own, which a foreign key would
-- refuse, and a message is never deleted, only hidden; private.record_patch checks the id instead.
create table if not exists public.patches (
  number text primary key check (number ~ '^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(\.[1-9][0-9]{0,2})?$'),
  sort_key integer generated always as (split_part(number,'.',1)::integer*1000000 + split_part(number,'.',2)::integer*1000
    + coalesce(nullif(split_part(number,'.',3),'')::integer,0)) stored unique,
  title text not null check (char_length(title) between 1 and 80 and title ~ '[^[:space:]]'),
  released_at_ms bigint not null check (released_at_ms>=0),
  message_id bigint unique
);
-- Each patch's features in the order players read them: positions 1-20, plain text of 1-240 characters, not blank.
create table if not exists public.patch_features (
  patch text not null references public.patches(number),
  position smallint not null check (position between 1 and 20),
  text text not null check (char_length(text) between 1 and 240 and text ~ '[^[:space:]]'),
  primary key (patch,position)
);
alter table public.patches enable row level security;
alter table public.patch_features enable row level security;
-- A new table here gets service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN by default: everything is revoked first, then the
-- one read is granted. service_role only reads (it bypasses row security; the revision view it may read names latest_patch).
revoke all on public.patches from public,anon,authenticated,service_role;
revoke all on public.patch_features from public,anon,authenticated,service_role;
grant select on public.patches to anon,authenticated,service_role;
grant select on public.patch_features to anon,authenticated,service_role;
drop policy if exists player_read on public.patches;
create policy player_read on public.patches for select to anon,authenticated using (true);
drop policy if exists player_read on public.patch_features;
create policy player_read on public.patch_features for select to anon,authenticated using (true);

-- 2. Operator-only: record a patch (its number), stamped with the time of recording (clock_timestamp(), never back-dated), and its
-- features at positions 1..n, in one statement. It refuses with 23514 a list of features that is empty or longer than 20, a
-- message_id that is not a visible patch-notes message, and a number whose sort_key is not above every other patch's (checked after
-- its insert, so a repeated number is the primary key's 23505 first). The tables' constraints refuse a malformed number (23514, or
-- 22P02 when the generated sort_key cannot be computed), a bad title and a bad feature. A correction is a plain owner update after
-- Avi's go. Run with the linked CLI after Avi's go (runbook, "Recording a patch"), never before the patch's client is live.
create or replace function private.record_patch(number text, title text, features text[], message_id bigint default null) returns text
language plpgsql security invoker set search_path='' as $$
declare recorded text;
begin
  if coalesce(cardinality(record_patch.features),0) not between 1 and 20 then
    raise exception 'a patch has 1 to 20 features' using errcode='23514';
  end if;
  if record_patch.message_id is not null and not exists(select 1 from public.game_messages m
      where m.id=record_patch.message_id and m.kind='patch-notes' and not m.hidden) then
    raise exception 'message % is not a visible patch note',record_patch.message_id using errcode='23514';
  end if;
  insert into public.patches(number,title,released_at_ms,message_id)
    values(record_patch.number,record_patch.title,floor(extract(epoch from clock_timestamp())*1000)::bigint,record_patch.message_id)
    returning patches.number into recorded;
  if exists(select 1 from public.patches p join public.patches q on q.number=recorded where p.number<>recorded and p.sort_key>q.sort_key) then
    raise exception 'patch % is not above every recorded patch',recorded using errcode='23514';
  end if;
  insert into public.patch_features(patch,position,text)
    select recorded,f.ord::smallint,f.feature from unnest(record_patch.features) with ordinality f(feature,ord);
  return recorded;
end $$;
-- A new function is executable by PUBLIC by default. record_patch is the operator's only (the owner always keeps EXECUTE): no client
-- role, and not service_role, which never writes these tables.
revoke all on function private.record_patch(text,text,text[],bigint) from public,anon,authenticated,service_role;

-- 3. 15-release.sql's view with the newest patch appended. create or replace keeps its grants (SELECT for anon, authenticated and
-- service_role; the access matrix's OPEN list). It stays security_invoker because the WITH (security_invoker=true) clause below
-- restates it, not because create or replace keeps it. Null when no patch is recorded.
create or replace view public.world_revision with(security_invoker=true) as
  select r.revision::text||':'||floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint::text||':'||
    coalesce((select max(reveal_at_ms) from public.visible_events),0)::text as revision,
    floor(extract(epoch from statement_timestamp())*1000)::bigint as server_now_ms,
    floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint as slot_index,
    r.published_slot_index,
    (select p.number from public.patches p order by p.sort_key desc limit 1) as latest_patch
  from public.world_revision_state r where singleton;

-- 4. The seed: docs/CHANGELOG.md's released sections, word for word (titles and features), with the spec's release times: 1.0 the
-- first slot (epoch 373525), 1.1 and 1.2 their deploy record commits, 1.2.1 and 1.3 their release records, 1.3.1 the points-hotfix
-- ledger's "about 17:40 UTC". Players see the date only. Each note is found by its kind and exact title (none matches locally).
insert into public.patches(number,title,released_at_ms,message_id) values
  ('1.0',$t$Public launch$t$,1792920000000,null),
  ('1.1',$t$Evening Arena, waiting monsters, clearer menus$t$,1793006949000,(select m.id from public.game_messages m where m.kind='patch-notes' and not m.hidden and m.title=$t$Evening Arena, waiting monsters, clearer menus$t$
    order by m.id limit 1)),
  ('1.2',$t$Choose your gladiator's look$t$,1793095651000,(select m.id from public.game_messages m where m.kind='patch-notes' and not m.hidden and m.title=$t$New: choose your gladiator's look$t$
    order by m.id limit 1)),
  ('1.2.1',$t$Clearer busy buttons$t$,1793115007000,null),
  ('1.3',$t$Messages, gold, fixed builds and bigger beds$t$,1793263477000,(select m.id from public.game_messages m where m.kind='patch-notes' and not m.hidden and m.title=$t$Messages, gold, fixed builds and bigger beds$t$
    order by m.id limit 1)),
  ('1.3.1',$t$Phone attribute points$t$,1793295600000,(select m.id from public.game_messages m where m.kind='patch-notes' and not m.hidden and m.title=$t$Attribute points: easier on a phone$t$
    order by m.id limit 1))
on conflict do nothing;
insert into public.patch_features(patch,position,text) values
  ('1.0',1,$f$Sign in with Google and create one gladiator: a name, a class (Berserker, Guardian or Duelist) and starting attribute points.$f$),
  ('1.0',2,$f$A shared camp where every gladiator lives out its day, with a camera you can move, on a desktop or a phone. Visitors can watch without signing in.$f$),
  ('1.0',3,$f$A day of three 80-minute parts (morning, afternoon and evening) that repeats until you change it: Training, Expedition, Arena or Rest.$f$),
  ('1.0',4,$f$Stamina: each activity spends it, a Rest refills it, and a part you cannot afford becomes a Rest.$f$),
  ('1.0',5,$f$Training earns attribute points for your build: five attributes, a fighting stance and gear in five slots.$f$),
  ('1.0',6,$f$Expeditions to the Woodland Path, the Ruined Outpost and the Mountain Pass earn XP, levels, gold and gear. Watch a trip live and replay its fights.$f$),
  ('1.0',7,$f$Automatic Arena fights in strength leagues, with a rating, renown and a replay of every bout.$f$),
  ('1.0',8,$f$Tournaments on Wednesdays and Saturdays, and four-week seasons with prestige awards.$f$),
  ('1.0',9,$f$Shops, a player market at fixed prices, and an inventory.$f$),
  ('1.0',10,$f$Results, the Gladiators list and every gladiator's profile.$f$),
  ('1.1',1,$f$Arena runs in the evening part of the day only. Wednesday and Saturday tournaments start in the evening too, at 18:40 UTC.$f$),
  ('1.1',2,$f$Plan the whole day and save it once. The schedule says which part is running now.$f$),
  ('1.1',3,$f$Market sales pay a fee of at least 1 gold, and the lowest price is 2 gold.$f$),
  ('1.1',4,$f$Character creation says how many points are left and each attribute's cap.$f$),
  ('1.1',5,$f$My gladiator shows the gear you wear, and the inventory swaps it with Wear. A shield comes back when a one-handed weapon replaces a two-handed one.$f$),
  ('1.1',6,$f$On an expedition, each monster waits at its spot, named over its head, until its fight.$f$),
  ('1.2',1,$f$Choose a look when you create a gladiator: a male or female body; short, long, ponytail or bald hair; skin, hair and clothes colours; a Random look and a live preview.$f$),
  ('1.2',2,$f$Every gladiator is drawn in its own look in the camp, on expeditions and in replays. Gladiators made before keep the original look.$f$),
  ('1.2',3,$f$A build the server refuses says why and reloads your gear, and the schedule drops an old saved note when the day changes in the background.$f$),
  ('1.2.1',1,$f$While a build, market, inventory or shop button sends its command, it dims and keeps the keyboard focus, and pressing it again does nothing.$f$),
  ('1.3',1,$f$Messages: a button beside your name, with a count, where patch notes and news from the game arrive.$f$),
  ('1.3',2,$f$Notifications: what your training, expeditions, Arena fights and tournaments earned, with XP, level-ups, gear and gold.$f$),
  ('1.3',3,$f$Change your gladiator's look from the look patch note, free and as often as you like for now.$f$),
  ('1.3',4,$f$Money is now called gold everywhere. Your amount is unchanged.$f$),
  ('1.3',5,$f$When you level up, the build shows how many points are left. Saved points and your class are fixed; your stance can still change.$f$),
  ('1.3',6,$f$The beds in the camp are bigger, so a gladiator fits on one. Punchy asked for it.$f$),
  ('1.3.1',1,$f$Each attribute has +1 and +5 buttons when you create a gladiator or plan a build, on their own line on a phone.$f$),
  ('1.3.1',2,$f$Tap a points number and type: what you type replaces it. A number above what you have left is corrected when you leave the box, and the game says why.$f$),
  ('1.3.1',3,$f$The build step has no minus: points in a build that has taken effect are permanent. A gray Respec button says it is coming later as a paid option.$f$)
on conflict do nothing;

notify pgrst,'reload schema';
commit;
