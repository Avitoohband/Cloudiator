
  create table "public"."public_profiles" (
    "gladiator_id" uuid not null,
    "rating" bigint not null,
    "combat_strength" numeric,
    "prestige" jsonb not null default '[]'::jsonb
      );


alter table "public"."public_profiles" enable row level security;


  create table "public"."recent_results" (
    "activity_id" uuid not null,
    "gladiator_id" uuid not null,
    "name" text not null,
    "reveal_at_ms" bigint not null,
    "summary" jsonb not null
      );


alter table "public"."recent_results" enable row level security;


  create table "public"."world_actors" (
    "gladiator_id" uuid not null,
    "actor" jsonb not null
      );


alter table "public"."world_actors" enable row level security;


  create table "public"."world_revision_state" (
    "singleton" boolean not null default true,
    "revision" bigint not null default 0
      );


alter table "public"."world_revision_state" enable row level security;

CREATE UNIQUE INDEX public_profiles_pkey ON public.public_profiles USING btree (gladiator_id);

CREATE INDEX recent_results_gladiator_idx ON public.recent_results USING btree (gladiator_id);

CREATE UNIQUE INDEX recent_results_pkey ON public.recent_results USING btree (activity_id);

CREATE INDEX recent_results_reveal_idx ON public.recent_results USING btree (reveal_at_ms DESC, activity_id);

CREATE UNIQUE INDEX world_actors_pkey ON public.world_actors USING btree (gladiator_id);

CREATE UNIQUE INDEX world_revision_state_pkey ON public.world_revision_state USING btree (singleton);

alter table "public"."public_profiles" add constraint "public_profiles_pkey" PRIMARY KEY using index "public_profiles_pkey";

alter table "public"."recent_results" add constraint "recent_results_pkey" PRIMARY KEY using index "recent_results_pkey";

alter table "public"."world_actors" add constraint "world_actors_pkey" PRIMARY KEY using index "world_actors_pkey";

alter table "public"."world_revision_state" add constraint "world_revision_state_pkey" PRIMARY KEY using index "world_revision_state_pkey";

alter table "public"."public_profiles" add constraint "public_profiles_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) ON DELETE CASCADE not valid;

alter table "public"."public_profiles" validate constraint "public_profiles_gladiator_id_fkey";

alter table "public"."recent_results" add constraint "recent_results_activity_id_fkey" FOREIGN KEY (activity_id) REFERENCES public.activities(id) ON DELETE CASCADE not valid;

alter table "public"."recent_results" validate constraint "recent_results_activity_id_fkey";

alter table "public"."recent_results" add constraint "recent_results_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) ON DELETE CASCADE not valid;

alter table "public"."recent_results" validate constraint "recent_results_gladiator_id_fkey";

alter table "public"."world_actors" add constraint "world_actors_actor_check" CHECK ((jsonb_typeof(actor) = 'object'::text)) not valid;

alter table "public"."world_actors" validate constraint "world_actors_actor_check";

alter table "public"."world_actors" add constraint "world_actors_gladiator_id_fkey" FOREIGN KEY (gladiator_id) REFERENCES public.gladiators(id) ON DELETE CASCADE not valid;

alter table "public"."world_actors" validate constraint "world_actors_gladiator_id_fkey";

alter table "public"."world_revision_state" add constraint "world_revision_state_singleton_check" CHECK (singleton) not valid;

alter table "public"."world_revision_state" validate constraint "world_revision_state_singleton_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.refresh_projections()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare gid uuid;
begin for gid in select id from public.gladiators order by id loop perform private.project_character(gid); end loop; end $function$
;

create or replace view "public"."visible_events" as  SELECT id,
    activity_id,
    ordinal,
    reveal_at_ms,
    stage
   FROM public.activity_stages
  WHERE (reveal_at_ms <= (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric)))::bigint);


create or replace view "public"."world_actor_reads" as  SELECT gladiator_id,
    (actor || jsonb_build_object('phase', (ARRAY['morning'::text, 'afternoon'::text, 'evening'::text])[(1 + (mod((floor(((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric) / (4800000)::numeric)))::bigint, (3)::bigint))::integer)], 'activityStatus',
        CASE
            WHEN (((actor ->> 'activityStatus'::text) = 'active'::text) AND (((actor ->> 'endsAtMs'::text))::bigint <= (floor((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric)))::bigint)) THEN 'processing'::text
            ELSE (actor ->> 'activityStatus'::text)
        END, 'visibleStage', ( SELECT (e.stage - 'battleLog'::text)
           FROM public.visible_events e
          WHERE (e.activity_id = ((w.actor ->> 'activityId'::text))::uuid)
          ORDER BY e.ordinal DESC
         LIMIT 1))) AS actor
   FROM public.world_actors w;


create or replace view "public"."world_revision" as  SELECT (((((revision)::text || ':'::text) || ((floor(((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric) / (4800000)::numeric)))::bigint)::text) || ':'::text) || (COALESCE(( SELECT max(visible_events.reveal_at_ms) AS max
           FROM public.visible_events), (0)::bigint))::text) AS revision,
    (floor((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric)))::bigint AS server_now_ms,
    (floor(((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric) / (4800000)::numeric)))::bigint AS slot_index
   FROM public.world_revision_state r
  WHERE singleton;


create or replace view "public"."public_profile_reads" as  SELECT p.gladiator_id,
    jsonb_build_object('actor', w.actor, 'combatStrength', p.combat_strength, 'rating', p.rating, 'prestige', p.prestige) AS profile
   FROM (public.public_profiles p
     JOIN public.world_actor_reads w USING (gladiator_id));


grant select on table "public"."public_profiles" to "authenticated";

grant delete on table "public"."public_profiles" to "service_role";

grant insert on table "public"."public_profiles" to "service_role";

grant select on table "public"."public_profiles" to "service_role";

grant update on table "public"."public_profiles" to "service_role";

grant select on table "public"."recent_results" to "authenticated";

grant delete on table "public"."recent_results" to "service_role";

grant insert on table "public"."recent_results" to "service_role";

grant select on table "public"."recent_results" to "service_role";

grant update on table "public"."recent_results" to "service_role";

grant select on table "public"."world_actors" to "authenticated";

grant delete on table "public"."world_actors" to "service_role";

grant insert on table "public"."world_actors" to "service_role";

grant select on table "public"."world_actors" to "service_role";

grant update on table "public"."world_actors" to "service_role";

grant select on table "public"."world_revision_state" to "authenticated";

grant delete on table "public"."world_revision_state" to "service_role";

grant insert on table "public"."world_revision_state" to "service_role";

grant select on table "public"."world_revision_state" to "service_role";

grant update on table "public"."world_revision_state" to "service_role";


  create policy "player_read"
  on "public"."public_profiles"
  as permissive
  for select
  to authenticated
using (true);



  create policy "player_read"
  on "public"."recent_results"
  as permissive
  for select
  to authenticated
using ((reveal_at_ms <= (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric)))::bigint));



  create policy "player_read"
  on "public"."world_actors"
  as permissive
  for select
  to authenticated
using (true);



  create policy "player_read"
  on "public"."world_revision_state"
  as permissive
  for select
  to authenticated
using (true);




















set check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.project_changed_character()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare gid uuid;
begin
  if tg_table_name='gladiators' then gid:=coalesce(new.id,old.id);
  elsif tg_table_name='activity_stages' then select gladiator_id into gid from public.activities where id=coalesce(new.activity_id,old.activity_id);
  else gid:=coalesce(new.gladiator_id,old.gladiator_id); end if;
  if gid is not null then perform private.project_character(gid); end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION private.project_character(gid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION private.projection_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin update public.world_revision_state set revision=revision+1 where singleton; return null; end $function$
;

CREATE OR REPLACE FUNCTION private.boundary_published(target bigint)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if target is null or target<0 then raise exception 'invalid published slot'; end if;
  -- Row triggers publish changed actors at transaction end; the completed phase itself also invalidates the small revision.
  update public.world_revision_state set revision=revision+1 where singleton;
  return null;
end $function$
;



-- Complete the uncommitted CLI draft: dependency order, invoker views, ACLs and existing-state backfill.
CREATE CONSTRAINT TRIGGER project_changed_character AFTER INSERT OR DELETE OR UPDATE ON public.activities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.project_changed_character();
CREATE CONSTRAINT TRIGGER project_changed_character AFTER INSERT OR DELETE OR UPDATE ON public.activity_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.project_changed_character();
CREATE CONSTRAINT TRIGGER projection_changed AFTER INSERT OR DELETE OR UPDATE ON public.activity_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.projection_changed();
CREATE CONSTRAINT TRIGGER project_changed_character AFTER INSERT OR DELETE OR UPDATE ON public.builds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.project_changed_character();
CREATE CONSTRAINT TRIGGER project_changed_character AFTER INSERT OR DELETE OR UPDATE ON public.gladiators DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.project_changed_character();
CREATE CONSTRAINT TRIGGER project_changed_character AFTER INSERT OR DELETE OR UPDATE ON public.item_instances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.project_changed_character();
CREATE CONSTRAINT TRIGGER projection_changed AFTER INSERT OR DELETE OR UPDATE ON public.public_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.projection_changed();
CREATE CONSTRAINT TRIGGER projection_changed AFTER INSERT OR DELETE OR UPDATE ON public.recent_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.projection_changed();
CREATE CONSTRAINT TRIGGER projection_changed AFTER INSERT OR DELETE OR UPDATE ON public.world_actors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.projection_changed();
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


alter view public.visible_events set (security_invoker=true);
alter view public.world_revision set (security_invoker=true);
alter view public.world_actor_reads set (security_invoker=true);
alter view public.public_profile_reads set (security_invoker=true);
insert into public.world_revision_state(singleton) values(true) on conflict do nothing;
revoke all on public.visible_events,public.world_revision,public.world_actor_reads,public.public_profile_reads from public,anon,authenticated,service_role;
grant select on public.visible_events,public.world_revision,public.world_actor_reads,public.public_profile_reads to authenticated,service_role;
revoke all on function private.project_character(uuid),private.projection_changed(),private.project_changed_character(),private.boundary_published(bigint),public.refresh_projections() from public,anon,authenticated;
grant execute on function private.project_character(uuid),private.projection_changed(),private.project_changed_character(),private.boundary_published(bigint),public.refresh_projections() to service_role;
select public.refresh_projections();
notify pgrst,'reload schema';
