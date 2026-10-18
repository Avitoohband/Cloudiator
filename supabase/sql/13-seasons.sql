-- Tasks 21.1 and 21.2 reapplicable source. Committed M01-M14 are immutable; deploy only the separately generated migration
-- M15, which covers both.
-- Seasons (game design §8.3 and §11; plan 2026-10-18-task-21-seasons, Decisions 3-6): the public season rows, the frozen
-- public standings archive, the private award records with their receipts and ledger rows, prestige on public profiles, the
-- live view's reward eligibility, frozen ratings of a closed season, private.close_season, and boundary phase 2
-- (private.boundary_close_season), which closes every earlier open season and then opens the boundary's own season row.
--
-- Season rows. Phase 2 of a boundary inserts its season's row (bounds from the epoch: slots epoch + 504 × index, times
-- 4,800,000 ms, as seasonAt in supabase/functions/_shared/domain/season.ts) before phase 4 creates that season's rating rows,
-- so every season with ratings has a row. The backfill at the end of this source gives the seasons rated before it one.
-- Phase 2 closes by season row, not by "the first boundary of a season": a boundary that coordinate_work skips (nobody due)
-- leaves the close to the next boundary that runs.
--
-- Ranking. Within one season and league: rating descending, then human wins descending, then fewer human losses, then the
-- gladiator id (spec 8.3), exactly public.arena_standing_reads' order.
-- Eligibility. A rating row qualifies with at least minimumHumanBouts (5) human bouts, human_wins + human_losses; NPC bouts
-- are never counted. It is reward-eligible when it qualifies and no higher league row of the same character and season also
-- qualifies (private.league_rank): a character is rewarded only in its highest qualifying league. Award places 1-3 go to the
-- eligible rows of each league in ranking order, so a promoted character placing fourth in its higher league gets nothing and
-- the lower league's places go to its next eligible rows; a league with fewer eligible rows awards only those places. A row
-- is promoted when the character holds a higher league row in that season, and inactive when it has no human bout.
--
-- Lock order of a close (private.close_season): the coordinator row and the boundary row (held by advance_boundary, whose
-- phase 2 calls it), then the season row FOR UPDATE, then, for each award in gladiator_id order, that account's advisory lock
-- hashtextextended(owner_id::text,0) (as the boundary phases and every command take it) and then its wallet row. The receipt,
-- ledger and award inserts follow; their foreign keys take KEY SHARE on the gladiator row (and the receipt's auth.users row)
-- while the account lock is held, as a settlement's receipt does. Projection rows come last, through the deferred
-- project_changed_character trigger at commit. The archive insert reads ratings and names before any account lock and locks
-- nothing but its own new rows. Phase 2 samples database time once, after the coordinator lock, and closes the earlier open
-- seasons in ascending order with it; the new season row is inserted last.
--
-- Errors. Any error in a close rolls back the whole boundary subtransaction (coordinate_work keeps only the SQLSTATE), and the
-- next coordination retries the boundary: no partial archive and no second award. A completed boundary is never rerun, and
-- a later boundary's phase 2 finds the season closed (close_season returns 0 for it).
--
-- No foreign key on the archive. public.season_standings and public.seasons reference nothing: archives outlive everything
-- (spec §11 keeps season archives and prestige indefinitely), as private.settled_slots does. A foreign key to a character
-- would either block a later removal or cascade the history away, and each archive row carries the name frozen at close.
-- private.season_awards keeps its foreign keys: an award is a grant tied to its character and its receipt.
--
-- Grants follow 03-activities-jobs.sql and 07-arena.sql. The boundary runs as service_role when the worker coordinates, so
-- service_role executes the private functions (revoked from public, anon and authenticated) and holds only the DML the close
-- needs: seasons select, insert and update; season_standings and season_awards select and insert (their guards refuse any
-- update or delete). Clients read seasons and season_standings only, and nothing of season_awards or the functions.
--
-- Accepted exceptions:
-- 1. Restated rule constants. private.season_rules() restates RULES_V1.seasons' minimumHumanBouts and placements (a DB test
--    compares them). The view restates the 5 and the league order, because a visitor's invoker read cannot call a private
--    function; 2419200000 in public.seasons is RULES_V1.seasons.durationMs; phase 2 and the backfill restate its 504 slots
--    (durationSlots) of 4800000 ms (clock.slotMs). A rules version that changes them needs a new source.
-- 2. guard_arena_rating reads the season row without locking it. Locking it would order a rating row before the season row,
--    against the close's season-row-then-account order, and could deadlock a settlement with the close. The close cannot race
--    a settlement of its own season: phase 2 runs only after boundary phase 1 proved slot target - 1 settled, and settlement
--    is globally ordered (settle_activity_core refuses a slot while an earlier one is unsettled), so every Arena and
--    tournament settlement of the closing season, including a tournament's minute-80 credits, committed before the close.
begin;

-- One row per season, created by boundary phase 2 (Task 21.2). Bounds are fixed; the row closes once.
create table if not exists public.seasons (
  season_index bigint primary key check (season_index >= 0),
  starts_at_ms bigint not null,
  ends_at_ms bigint not null check (ends_at_ms = starts_at_ms + 2419200000),
  closed_at_ms bigint
);
-- The frozen archive: every rating row of a closed season, ranked and flagged at close (no foreign key, see the header).
create table if not exists public.season_standings (
  season_index bigint not null check (season_index >= 0),
  league text not null check (league in ('bronze','silver','gold','champion')),
  rank bigint not null check (rank >= 1),
  gladiator_id uuid not null,
  name text not null,
  rating bigint not null check (rating between 0 and 9007199254740991),
  human_wins bigint not null check (human_wins >= 0),
  human_losses bigint not null check (human_losses >= 0),
  promoted boolean not null,
  inactive boolean not null,
  reward_eligible boolean not null,
  award_place smallint check (award_place between 1 and 3),
  check (award_place is null or reward_eligible),
  primary key (season_index,league,gladiator_id),
  unique (season_index,league,rank)
);
-- One award per character and season; money and renown are the amounts actually credited (capped at the wallet maximum).
create table if not exists private.season_awards (
  season_index bigint not null check (season_index >= 0),
  gladiator_id uuid not null references public.gladiators(id),
  league text not null check (league in ('bronze','silver','gold','champion')),
  place smallint not null check (place between 1 and 3),
  money bigint not null check (money between 0 and 9007199254740991),
  renown bigint not null check (renown between 0 and 9007199254740991),
  title text check (title = 'champion'),
  badge text not null check (badge in ('gold','silver','bronze')),
  receipt_id uuid not null unique references public.operation_receipts(receipt_id),
  awarded_at_ms bigint not null,
  primary key (season_index,gladiator_id),
  unique (season_index,league,place)
);
create index if not exists season_awards_gladiator_idx on private.season_awards(gladiator_id);

-- Revoke all from everyone first. Seasons and the archive: anyone reads; the backend writes only what the close needs.
do $$ declare t text; begin
  foreach t in array array['seasons','season_standings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to anon,authenticated',t);
    execute format('grant %s on public.%I to service_role',case t when 'seasons' then 'select,insert,update' else 'select,insert' end,t);
    execute format('drop policy if exists player_read on public.%I',t);
    execute format('create policy player_read on public.%I for select to anon,authenticated using (true)',t);
  end loop;
end $$;
alter table private.season_awards enable row level security;
revoke all on private.season_awards from public,anon,authenticated,service_role;
grant select,insert on private.season_awards to service_role;
drop policy if exists backend_only on private.season_awards;
create policy backend_only on private.season_awards to service_role using (true) with check (true);

-- RULES_V1.seasons' qualification minimum and placements (exception 1).
create or replace function private.season_rules() returns jsonb language sql immutable security invoker set search_path='' as $$
  select '{"minimumHumanBouts":5,"placements":[{"money":500,"renown":100,"title":"champion","badge":"gold"},
    {"money":300,"renown":60,"title":null,"badge":"silver"},{"money":200,"renown":40,"title":null,"badge":"bronze"}]}'::jsonb
$$;

-- A season row is never deleted, its bounds never change, and closed_at_ms changes only once, from null to a value.
create or replace function private.guard_season() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'immutable season'; end if;
  if old.closed_at_ms is not null or new.closed_at_ms is null
    or (new.season_index,new.starts_at_ms,new.ends_at_ms) is distinct from (old.season_index,old.starts_at_ms,old.ends_at_ms) then
    raise exception 'immutable season';
  end if;
  return new;
end $$;
drop trigger if exists guard_season on public.seasons;
create trigger guard_season before update or delete on public.seasons for each row execute function private.guard_season();
drop trigger if exists guard_frozen on public.season_standings;
create trigger guard_frozen before update or delete on public.season_standings for each row execute function private.guard_frozen();
drop trigger if exists guard_frozen on private.season_awards;
create trigger guard_frozen before update or delete on private.season_awards for each row execute function private.guard_frozen();

-- 07-arena.sql's rating guard, and a closed season's rating rows are frozen with its archive (exception 2).
create or replace function private.guard_arena_rating() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'immutable arena rating'; end if;
  if new.gladiator_id<>old.gladiator_id or new.league<>old.league or new.season_index<>old.season_index
    or new.human_wins<old.human_wins or new.human_losses<old.human_losses then raise exception 'immutable arena rating'; end if;
  if exists(select 1 from public.seasons s where s.season_index=old.season_index and s.closed_at_ms is not null) then
    raise exception 'immutable arena rating';
  end if;
  return new;
end $$;

-- 08-arena-bouts.sql's projector, unchanged, plus the character's prestige from its season awards, oldest season first.
create or replace function private.project_character(gid uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare g public.gladiators%rowtype; b jsonb; a public.activities%rowtype; actor jsonb; silhouettes jsonb; awarded_prestige jsonb;
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
  insert into public.world_actors(gladiator_id,actor,processed_slot_index) values(gid,actor,g.processed_slot_index)
    on conflict(gladiator_id) do update set actor=excluded.actor,processed_slot_index=excluded.processed_slot_index
    where (world_actors.actor,world_actors.processed_slot_index) is distinct from (excluded.actor,excluded.processed_slot_index);
  -- Task 21: prestige, one entry per season award.
  select coalesce(jsonb_agg(jsonb_build_object('seasonIndex',x.season_index,'league',x.league,'place',x.place,'badge',x.badge,'title',x.title)
    order by x.season_index),'[]'::jsonb) into awarded_prestige from private.season_awards x where x.gladiator_id=gid;
  -- Combined combat strength/league score belongs to Task 16. Never label gear history as that score.
  insert into public.public_profiles(gladiator_id,rating,prestige) values(gid,g.rating,awarded_prestige) on conflict(gladiator_id) do update
    set rating=excluded.rating,prestige=excluded.prestige
    where (public_profiles.rating,public_profiles.prestige) is distinct from (excluded.rating,excluded.prestige);
  insert into public.recent_results(activity_id,gladiator_id,name,reveal_at_ms,summary)
    select x.id,gid,g.name,x.settled_at_ms,jsonb_build_object('activityId',x.id,'resolvedKind',x.resolved_kind,
      'result',x.summary->'result','success',x.summary->'success','settledAtMs',x.settled_at_ms,
      'replayExpiry',case when x.summary->'replayExpiry'->>'state'='available' then jsonb_build_object('state','available','expiresAtMs',x.summary->'replayExpiry'->'expiresAtMs') else jsonb_build_object('state','expired') end)
    from public.activities x where x.gladiator_id=gid and x.status='completed' and x.summary is not null and x.settled_at_ms is not null
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
-- Task 10's deferred hook: an award republishes its character's prestige.
drop trigger if exists project_changed_character on private.season_awards;
create constraint trigger project_changed_character after insert or update or delete on private.season_awards
  deferrable initially deferred for each row execute function private.project_changed_character();

-- 08-arena-bouts.sql's live standings view, with reward eligibility as its last column (highest qualifying league; the
-- literals are exception 1). Still security_invoker; the grants are restated because a generated migration omits them.
create or replace view public.arena_standing_reads with (security_invoker=true) as
  select s.league,s.season_index,s.gladiator_id,s.name,s.rating,s.human_wins,s.human_losses,
    row_number() over (partition by s.league,s.season_index order by s.rating desc,s.human_wins desc,s.human_losses,s.gladiator_id) as rank,
    exists(select 1 from public.arena_standings h where h.gladiator_id=s.gladiator_id and h.season_index=s.season_index
      and array_position(array['bronze','silver','gold','champion'],h.league)>array_position(array['bronze','silver','gold','champion'],s.league)) as promoted,
    s.human_wins+s.human_losses>=5 and not exists(select 1 from public.arena_standings h where h.gladiator_id=s.gladiator_id
      and h.season_index=s.season_index and h.human_wins+h.human_losses>=5
      and array_position(array['bronze','silver','gold','champion'],h.league)>array_position(array['bronze','silver','gold','champion'],s.league)) as reward_eligible
  from public.arena_standings s;
revoke all on public.arena_standing_reads from public,anon,authenticated,service_role;
grant select on public.arena_standing_reads to anon,authenticated,service_role;

-- Close a season once (Decision 5): archive every league's standings, pay each award once, and mark the season closed at
-- now_ms. Returns the number of awards paid; 0 for a season already closed. Lock order and rules: see the header.
create or replace function private.close_season(season bigint,now_ms bigint) returns integer
language plpgsql security invoker set search_path='' as $$
declare s public.seasons%rowtype; rules jsonb:=private.season_rules(); minimum bigint; award record; prize jsonb;
  balance public.wallets%rowtype; credit_money bigint; credit_renown bigint; receipt uuid; awarded integer:=0;
begin
  if season is null or now_ms is null then raise exception 'invalid season close'; end if;
  select * into s from public.seasons where season_index=season for update;
  if not found then raise exception 'unknown season'; end if;
  if s.closed_at_ms is not null then return 0; end if;
  minimum:=(rules->>'minimumHumanBouts')::bigint;
  -- Every rating row of the season, ranked and flagged, with the character's name at close.
  insert into public.season_standings(season_index,league,rank,gladiator_id,name,rating,human_wins,human_losses,promoted,inactive,
      reward_eligible,award_place)
    with rated as (
      select r.league,private.league_rank(r.league) as league_order,r.gladiator_id,g.name,r.rating,r.human_wins,r.human_losses,
        r.human_wins+r.human_losses>=minimum as qualifies
      from private.arena_ratings r join public.gladiators g on g.id=r.gladiator_id where r.season_index=season
    ), flagged as (
      -- One pass per character (window aggregates): promoted when its highest league this season is above this row's, and
      -- eligible when this row qualifies and is its highest qualifying league.
      select x.*,
        max(x.league_order) over character_rows>x.league_order as promoted,
        x.qualifies and x.league_order=max(case when x.qualifies then x.league_order end) over character_rows as eligible
      from rated x window character_rows as (partition by x.gladiator_id)
    ), ranked as (
      select f.*,
        row_number() over (partition by f.league order by f.rating desc,f.human_wins desc,f.human_losses,f.gladiator_id) as standing,
        row_number() over (partition by f.league,f.eligible order by f.rating desc,f.human_wins desc,f.human_losses,f.gladiator_id) as eligible_rank
      from flagged f
    )
    select season,k.league,k.standing,k.gladiator_id,k.name,k.rating,k.human_wins,k.human_losses,k.promoted,
      k.human_wins+k.human_losses=0,k.eligible,case when k.eligible and k.eligible_rank<=3 then k.eligible_rank end
    from ranked k;
  -- Pay each award once, in gladiator_id order, under its account lock and wallet row; credit up to the wallet maximum.
  for award in select x.gladiator_id,x.league,x.award_place as place,g.owner_id from public.season_standings x
    join public.gladiators g on g.id=x.gladiator_id
    where x.season_index=season and x.award_place is not null order by x.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(award.owner_id::text,0));
    select * into balance from public.wallets where gladiator_id=award.gladiator_id for update;
    if not found then raise exception 'missing wallet'; end if;
    prize:=rules->'placements'->(award.place-1);
    credit_money:=least((prize->>'money')::bigint,9007199254740991-balance.money);
    credit_renown:=least((prize->>'renown')::bigint,9007199254740991-balance.renown);
    receipt:=gen_random_uuid();
    insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
      values(award.owner_id,gen_random_uuid(),receipt,award.gladiator_id,
        jsonb_build_object('kind','season-award','seasonIndex',season,'league',award.league,'place',award.place),
        extensions.digest('season:'||season||':'||award.gladiator_id,'sha256'),
        jsonb_build_object('seasonIndex',season,'league',award.league,'place',award.place,'money',credit_money,'renown',credit_renown,
          'title',prize->'title','badge',prize->'badge'));
    update public.wallets set money=money+credit_money,renown=renown+credit_renown where gladiator_id=award.gladiator_id;
    insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason)
      values(award.gladiator_id,receipt,credit_money,credit_renown,'season');
    insert into private.season_awards(season_index,gladiator_id,league,place,money,renown,title,badge,receipt_id,awarded_at_ms)
      values(season,award.gladiator_id,award.league,award.place,credit_money,credit_renown,prize->>'title',prize->>'badge',receipt,now_ms);
    awarded:=awarded+1;
  end loop;
  update public.seasons set closed_at_ms=now_ms where season_index=season;
  return awarded;
end $$;

-- Boundary phase 2 (Decision 6), replacing Task 7's stub with the same signature. Runs under advance_boundary's coordinator
-- and boundary row locks. Closes every earlier open season in ascending order at one database time sampled after those
-- locks, then opens the boundary's own season row (bounds as seasonAt). Never holds the phase: it always returns null, and
-- without an epoch covering the slot it does nothing (phase 4 then waits with 'epoch').
create or replace function private.boundary_close_season(target bigint) returns text
language plpgsql volatile security invoker set search_path='' as $$
declare current_season bigint:=private.season_index(target); first_slot bigint; now_ms bigint; earlier bigint;
begin
  if current_season is null then return null; end if;
  now_ms:=private.planning_now_ms();
  for earlier in select s.season_index from public.seasons s where s.closed_at_ms is null and s.season_index<current_season
    order by s.season_index loop
    perform private.close_season(earlier,now_ms);
  end loop;
  select e.epoch_slot+504*current_season into first_slot from private.season_epoch e where e.singleton;
  insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(current_season,first_slot*4800000,(first_slot+504)*4800000)
    on conflict do nothing;
  return null;
end $$;

-- Backfill (Decision 6): a row for every season already rated before this source, with its epoch bounds. Reapplicable.
insert into public.seasons(season_index,starts_at_ms,ends_at_ms)
  select r.season_index,(e.epoch_slot+504*r.season_index)*4800000,(e.epoch_slot+504*(r.season_index+1))*4800000
  from (select distinct season_index from private.arena_ratings) r cross join private.season_epoch e where e.singleton
  on conflict do nothing;

revoke all on function private.season_rules(),private.guard_season(),private.guard_arena_rating(),private.project_character(uuid),
  private.close_season(bigint,bigint),private.boundary_close_season(bigint) from public,anon,authenticated;
grant execute on function private.season_rules(),private.guard_season(),private.guard_arena_rating(),private.project_character(uuid),
  private.close_season(bigint,bigint),private.boundary_close_season(bigint) to service_role;
notify pgrst,'reload schema';
commit;
