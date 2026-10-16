-- Task 13.1 reapplicable source. Committed M01-M12 are immutable; deploy only the separately generated migration (M13).
-- Visitor read access (full-screen camp spec, "Visitor access (backend)"): the `anon` role may SELECT the existing sanitized
-- public projections, read-only, and nothing else. Private reads and every command still require a verified Google session.
--
-- Opened to anon (SELECT only):
--   base tables  world_revision_state, world_actors, public_profiles, recent_results, activity_stages, arena_standings,
--                tournament_bout_results, tournament_placements;
--   views        visible_events, world_revision, world_actor_reads, public_profile_reads, arena_standing_reads;
--   columns      tournament_views(id, slot_index, league, starts_at_ms, ends_at_ms, status, entrants, bracket, bouts,
--                reveal_at_ms).
--
-- Why the base tables are opened too: the five read views are `security_invoker=true`, so a read through them runs with the
-- caller's own privileges and row security on every table beneath them. A visitor therefore needs SELECT and a select policy
-- on each base table, or the view refuses (no grant) or silently returns no rows (a grant without a policy).
--
-- Policies are not duplicated: each existing select policy (`player_read`, and `due_read` on activity_stages) has its role
-- list altered to anon and authenticated, with its USING expression unchanged. A second permissive policy would trip the
-- `multiple_permissive_policies` advisor. The due-time predicates (`reveal_at_ms <= clock_timestamp()` on recent_results,
-- activity_stages and tournament_bout_results) apply to visitors exactly as to signed-in readers, by guessed id included.
--
-- Accepted exceptions:
-- 1. Column grants on tournament_views (Task 19 review M1). It is granted column by column to anon and authenticated, and the
--    table-level SELECT from authenticated is revoked, so `pairing_job_id` (a private job id) and `published_at_ms` are
--    readable by no client. A client `select('*')` on it is refused; the read adapter names its columns. The backend
--    (service_role) keeps its table-level access.
-- 2. The owner view loses anon's leftover privileges. On the replayed database anon held TRUNCATE, REFERENCES, TRIGGER and
--    MAINTAIN on public.owner_state: the platform's default table privileges granted them when M01 created the view, and
--    M01's generated revokes covered only its tables. None is reachable through the Data API, but a visitor must hold no
--    write privilege on any public relation, so they are revoked here. anon never had SELECT on it.
begin;

-- Revoke before grant, so a reapplication leaves exactly these privileges.
revoke all on public.world_revision_state,public.world_actors,public.public_profiles,public.recent_results,public.activity_stages,
  public.arena_standings,public.tournament_bout_results,public.tournament_placements,
  public.visible_events,public.world_revision,public.world_actor_reads,public.public_profile_reads,public.arena_standing_reads
  from anon;
grant select on public.world_revision_state,public.world_actors,public.public_profiles,public.recent_results,public.activity_stages,
  public.arena_standings,public.tournament_bout_results,public.tournament_placements,
  public.visible_events,public.world_revision,public.world_actor_reads,public.public_profile_reads,public.arena_standing_reads
  to anon;

-- Exception 1. Revoking the table privilege also revokes any column privileges, so this is reapplicable.
revoke all on public.tournament_views from anon,authenticated;
grant select (id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms) on public.tournament_views
  to anon,authenticated;

-- Exception 2.
revoke all on public.owner_state from anon;

-- Guarded: each policy must already exist as a permissive select policy; it is never created here.
do $$ declare p record; begin
  for p in select * from (values ('world_revision_state','player_read'),('world_actors','player_read'),('public_profiles','player_read'),
    ('recent_results','player_read'),('activity_stages','due_read'),('arena_standings','player_read'),('tournament_views','player_read'),
    ('tournament_bout_results','player_read'),('tournament_placements','player_read')) v(tbl,pol) loop
    if not exists (select 1 from pg_policy where polrelid=format('public.%I',p.tbl)::regclass and polname=p.pol
      and polcmd='r' and polpermissive) then
      raise exception 'missing select policy % on public.%',p.pol,p.tbl;
    end if;
    execute format('alter policy %I on public.%I to anon,authenticated',p.pol,p.tbl);
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
