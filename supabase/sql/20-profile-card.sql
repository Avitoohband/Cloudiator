-- The richer profile card (2026-10-29) reapplicable source. Committed M01-M25 are immutable; this source and 19-patches.sql (the patch
-- list) are Patch 1.4's one migration, M26, generated from both (Avi: one database change per patch). Spec:
-- docs/superpowers/specs/2026-10-29-patch-a-design.md, "A richer profile card" ("Server: in M26, from supabase/sql/20-profile-card.sql");
-- plan: docs/superpowers/plans/2026-10-29-patch-a.md, Task 11c. Avi approved the mockup on 2026-10-29.
--
-- Avi asked to see other players' details, so a gladiator's CURRENT build and the gear it wears become public: in this game they are
-- not secrets (anyone watching a bout already sees the gear). Newly public, through the profile read only (public_profile_reads):
--   - the current build's stance and five attribute points;
--   - each equipped item's catalog id and version, level (tier), rarity and stats (the fields a market listing already shows);
--   - the Arena record summed over every season and league (each league-season row is already public, in the standings);
--   - the time the gladiator was made.
-- Still private: a queued (pending) build until it takes effect at its boundary; unspent and earned points; XP; stamina; gold; renown;
-- the inventory and its other items; the schedule; and every item's id, owner, origin, binding and reservation. The card's stats add
-- nothing new: the browser computes them from the build with the shared rules.
--
-- 1. public.public_profiles gains build jsonb and joined_at_ms bigint: nullable, no default and no CHECK, like its other projection
--    columns (a nullable column without a default does not rewrite the table).
-- 2. private.project_character: 17-appearance.sql's projector, unchanged except its public_profiles upsert, which also writes the two
--    columns (insert, update and the is-distinct check). Its triggers are today's: a build taking effect or a change to the
--    gladiator's items re-projects it, and an unchanged profile is not written.
-- 3. public.public_profile_reads: 06-projections.sql's view with build, joinedAtMs and arenaRecord in its profile object; the invoker
--    reads public.arena_standings, which anon and authenticated already read. create or replace keeps its columns; its grants are
--    restated (SELECT for anon, authenticated and service_role, as 11-visitor-access.sql left them).
-- 4. The backfill: every profile re-projected, so each carries its build at once.
-- No new relation, column grant, function grant or policy: public_profiles' table-level SELECT covers the new columns, so the access
-- matrix and the OPEN list are unchanged. Replacing the view and adding the columns take brief ACCESS EXCLUSIVE locks (profile reads
-- wait for the commit).
--
-- Every statement is reapplicable.
begin;

-- 1. The two columns.
alter table public.public_profiles add column if not exists build jsonb;
alter table public.public_profiles add column if not exists joined_at_ms bigint;

-- 2. 17-appearance.sql's projector, unchanged except the profile card's build and creation time in its public_profiles upsert.
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
  -- M24: the chosen look, null for the legacy look.
  actor:=jsonb_build_object('gladiatorId',g.id,'name',g.name,'classId',b->'classId','equipmentSilhouettes',silhouettes,'appearance',g.appearance,
    'league',g.league,'level',g.level,
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
  insert into public.public_profiles(gladiator_id,rating,prestige,build,joined_at_ms)
    values(gid,g.rating,awarded_prestige,card,g.created_at_ms) on conflict(gladiator_id) do update
    set rating=excluded.rating,prestige=excluded.prestige,build=excluded.build,joined_at_ms=excluded.joined_at_ms
    where (public_profiles.rating,public_profiles.prestige,public_profiles.build,public_profiles.joined_at_ms)
      is distinct from (excluded.rating,excluded.prestige,excluded.build,excluded.joined_at_ms);
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

-- Restated as 17-appearance.sql grants it: the backend's (service_role) only.
revoke all on function private.project_character(uuid) from public, anon, authenticated;
grant execute on function private.project_character(uuid) to service_role;

-- 3. 06-projections.sql's view with the card's keys. The WITH clause restates security_invoker (CREATE OR REPLACE VIEW replaces a view's
-- options with the ones it names), and the grants are restated after it.
create or replace view public.public_profile_reads with(security_invoker=true) as
  select p.gladiator_id,jsonb_build_object('actor',w.actor,'combatStrength',p.combat_strength,'rating',p.rating,'prestige',p.prestige,
    'build',p.build,'joinedAtMs',p.joined_at_ms,'arenaRecord',(select jsonb_build_object(
      'wins',coalesce(sum(s.human_wins),0)::bigint,'losses',coalesce(sum(s.human_losses),0)::bigint)
      from public.arena_standings s where s.gladiator_id=p.gladiator_id)) as profile
  from public.public_profiles p join public.world_actor_reads w using(gladiator_id);
revoke all on public.public_profile_reads from public,anon,authenticated,service_role;
grant select on public.public_profile_reads to anon,authenticated,service_role;

-- 4. Every profile carries its build at once.
select public.refresh_projections();

notify pgrst,'reload schema';
commit;
