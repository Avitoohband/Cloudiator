-- Task 10 reapplicable source. M01-M06 are immutable; deploy the new generated M07.
begin;
create table if not exists public.world_revision_state (
  singleton boolean primary key default true check(singleton), revision bigint not null default 0
);
insert into public.world_revision_state(singleton) values(true) on conflict do nothing;
create table if not exists public.world_actors (
  gladiator_id uuid primary key references public.gladiators(id) on delete cascade,
  actor jsonb not null check(jsonb_typeof(actor)='object')
);
create table if not exists public.public_profiles (
  gladiator_id uuid primary key references public.gladiators(id) on delete cascade,
  rating bigint not null, combat_strength numeric, prestige jsonb not null default '[]'
);
create table if not exists public.recent_results (
  activity_id uuid primary key references public.activities(id) on delete cascade,
  gladiator_id uuid not null references public.gladiators(id) on delete cascade,
  name text not null, reveal_at_ms bigint not null, summary jsonb not null
);
create index if not exists recent_results_reveal_idx on public.recent_results(reveal_at_ms desc,activity_id);
create index if not exists recent_results_gladiator_idx on public.recent_results(gladiator_id);
do $$ declare t text; begin
  foreach t in array array['world_revision_state','world_actors','public_profiles','recent_results'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to service_role',t);
    execute format('drop policy if exists player_read on public.%I',t);
    if t='recent_results' then
      execute format('create policy player_read on public.%I for select to authenticated using(reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint)',t);
    else
      execute format('create policy player_read on public.%I for select to authenticated using(true)',t);
    end if;
  end loop;
end $$;

-- All writer functions are invoker-only, unexposed, and callable only by the trusted backend.
create or replace function private.project_character(gid uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare g public.gladiators%rowtype; b jsonb; a public.activities%rowtype; actor jsonb; silhouettes jsonb;
begin
  select * into g from public.gladiators where id=gid;
  if not found then return; end if;
  select current_build into b from public.builds where gladiator_id=gid;
  if b is null then return; end if;
  -- Only an authoritative published activity is visible. Preparing snapshots remain private.
  select * into a from public.activities where gladiator_id=gid and status<>'preparing'
    and published_at_ms is not null and published_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
    order by slot_index desc limit 1;
  select coalesce(jsonb_agg(silhouette order by silhouette),'[]'::jsonb) into silhouettes from (
    select case split_part(i.item->>'catalogId',':',1)
      when 'sword' then 'weapon-sword' when 'axe' then 'weapon-axe' when 'spear' then 'weapon-spear' when 'bow' then 'weapon-bow'
      when 'round-shield' then 'offhand-shield' when 'leather-hood' then 'head-hood' when 'iron-helmet' then 'head-helmet'
      when 'light-armor' then 'armor-light' when 'heavy-armor' then 'armor-heavy' when 'light-boots' then 'feet-light'
      when 'heavy-boots' then 'feet-heavy' end as silhouette
    from public.item_instances i where i.gladiator_id=gid
      and i.id in (select value::uuid from jsonb_each_text(b->'equipment') where value is not null)
  ) equipment where silhouette is not null;
  actor:=jsonb_build_object('gladiatorId',g.id,'name',g.name,'classId',b->'classId','equipmentSilhouettes',silhouettes,
    'league',g.league,'level',g.level,'phase',private.slot_phase(coalesce(a.slot_index,g.processed_slot_index)),
    'location',case when a.id is null then 'orientation' when a.resolved_kind='expedition' then 'expedition:'||(a.requested->>'expeditionId') else a.resolved_kind end,
    'activityId',a.id,'activityStatus',case when a.id is null then 'active' else a.status end,
    'startsAtMs',coalesce(a.starts_at_ms,g.created_at_ms),'endsAtMs',coalesce(a.ends_at_ms,g.orientation_end_ms),'visibleStage',null);
  insert into public.world_actors values(gid,actor) on conflict(gladiator_id) do update set actor=excluded.actor
    where world_actors.actor is distinct from excluded.actor;
  -- Combined combat strength/league score belongs to Task 16. Never label gear history as that score.
  insert into public.public_profiles(gladiator_id,rating) values(gid,g.rating) on conflict(gladiator_id) do update set rating=excluded.rating
    where public_profiles.rating is distinct from excluded.rating;
  insert into public.recent_results(activity_id,gladiator_id,name,reveal_at_ms,summary)
    select x.id,gid,g.name,x.settled_at_ms,jsonb_build_object('activityId',x.id,'resolvedKind',x.resolved_kind,
      'result',x.summary->'result','success',x.summary->'success','settledAtMs',x.settled_at_ms,
      'replayExpiry',case when x.summary->'replayExpiry'->>'state'='available' then jsonb_build_object('state','available','expiresAtMs',x.summary->'replayExpiry'->'expiresAtMs') else jsonb_build_object('state','expired') end)
    from public.activities x where x.gladiator_id=gid and x.status='completed' and x.summary is not null and x.settled_at_ms is not null
    on conflict(activity_id) do update set name=excluded.name,summary=excluded.summary,reveal_at_ms=excluded.reveal_at_ms
    where (recent_results.name,recent_results.summary,recent_results.reveal_at_ms) is distinct from (excluded.name,excluded.summary,excluded.reveal_at_ms);
end $$;
create or replace function private.projection_changed() returns trigger language plpgsql security invoker set search_path='' as $$
begin update public.world_revision_state set revision=revision+1 where singleton; return null; end $$;
create or replace function private.project_changed_character() returns trigger language plpgsql security invoker set search_path='' as $$
declare gid uuid;
begin
  if tg_table_name='gladiators' then gid:=coalesce(new.id,old.id);
  elsif tg_table_name='activity_stages' then select gladiator_id into gid from public.activities where id=coalesce(new.activity_id,old.activity_id);
  else gid:=coalesce(new.gladiator_id,old.gladiator_id); end if;
  if gid is not null then perform private.project_character(gid); end if;
  return null;
end $$;
-- Deferred publication observes complete command/settlement state and holds the global revision lock last.
do $$ declare t text; begin
  foreach t in array array['gladiators','builds','item_instances','activities','activity_stages'] loop
    execute format('drop trigger if exists project_changed_character on public.%I',t);
    execute format('create constraint trigger project_changed_character after insert or update or delete on public.%I deferrable initially deferred for each row execute function private.project_changed_character()',t);
  end loop;
  foreach t in array array['world_actors','public_profiles','recent_results','activity_stages'] loop
    execute format('drop trigger if exists projection_changed on public.%I',t);
    execute format('create constraint trigger projection_changed after insert or update or delete on public.%I deferrable initially deferred for each row execute function private.projection_changed()',t);
  end loop;
end $$;
create or replace function private.boundary_published(target bigint) returns text language plpgsql security invoker set search_path='' as $$
begin
  if target is null or target<0 then raise exception 'invalid published slot'; end if;
  -- Row triggers publish changed actors at transaction end; the completed phase itself also invalidates the small revision.
  update public.world_revision_state set revision=revision+1 where singleton;
  return null;
end $$;
create or replace function public.refresh_projections() returns void language plpgsql security invoker set search_path='' as $$
declare gid uuid;
begin for gid in select id from public.gladiators order by id loop perform private.project_character(gid); end loop; end $$;

create or replace view public.visible_events with(security_invoker=true) as
  select id,activity_id,ordinal,reveal_at_ms,stage from public.activity_stages
  where reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint;
create or replace view public.world_revision with(security_invoker=true) as
  select r.revision::text||':'||floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint::text||':'||
    coalesce((select max(reveal_at_ms) from public.visible_events),0)::text as revision,
    floor(extract(epoch from statement_timestamp())*1000)::bigint as server_now_ms,
    floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint as slot_index
  from public.world_revision_state r where singleton;
create or replace view public.world_actor_reads with(security_invoker=true) as
  select w.gladiator_id,w.actor||jsonb_build_object(
    'phase',(array['morning','afternoon','evening'])[1+mod(floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint,3)::integer],
    'activityStatus',case when w.actor->>'activityStatus'='active' and (w.actor->>'endsAtMs')::bigint<=floor(extract(epoch from statement_timestamp())*1000)::bigint then 'processing' else w.actor->>'activityStatus' end,
    -- Camp projection deliberately omits bulky battle logs; on-demand timeline carries them.
    'visibleStage',(select e.stage-'battleLog' from public.visible_events e where e.activity_id=(w.actor->>'activityId')::uuid order by ordinal desc limit 1)) as actor
  from public.world_actors w;
create or replace view public.public_profile_reads with(security_invoker=true) as
  select p.gladiator_id,jsonb_build_object('actor',w.actor,'combatStrength',p.combat_strength,'rating',p.rating,'prestige',p.prestige) as profile
  from public.public_profiles p join public.world_actor_reads w using(gladiator_id);
revoke all on public.visible_events,public.world_revision,public.world_actor_reads,public.public_profile_reads from public,anon,authenticated,service_role;
grant select on public.visible_events,public.world_revision,public.world_actor_reads,public.public_profile_reads to authenticated,service_role;
revoke all on function private.project_character(uuid),private.projection_changed(),private.project_changed_character(),private.boundary_published(bigint),public.refresh_projections() from public,anon,authenticated;
grant execute on function private.project_character(uuid),private.projection_changed(),private.project_changed_character(),private.boundary_published(bigint),public.refresh_projections() to service_role;
select public.refresh_projections();
notify pgrst,'reload schema';
commit;
