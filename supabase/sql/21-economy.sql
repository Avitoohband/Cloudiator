-- Reapplicable source; M27 generation/replay is separate, after the remaining economy source lands.
-- Task 4 foundation: retain inactive v2, publish the active version, freeze season prizes and publish banner ownership.
-- Lock order: existing coordinator/boundary, account advisory, gladiator, wallet/receipt locks are preserved;
-- deferred mirrors/projectors update the global revision last. Trigger functions are not directly executable.
-- Accepted rules restatement: season_prizes reproduces the retained v1/v2 season tables exactly (unknowns return null).
-- Training history and free-tournament routing are the next serial Task 4 slice; this file does not activate v2.
begin;

-- 1. Retained version and its public copy. Table-level SELECT and RLS already cover the new public columns.
insert into private.rules_versions(version,active) values('v2',false) on conflict do nothing;
alter table public.world_revision_state add column if not exists rules_version text not null default 'v1'
  check (rules_version ~ '^v[0-9]+$');
create or replace function private.mirror_rules_version() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  update public.world_revision_state r set rules_version=v.version from private.rules_versions v
    where r.singleton and v.active and r.rules_version is distinct from v.version;
  return null;
end $$;
revoke all on function private.mirror_rules_version() from public,anon,authenticated,service_role;
drop trigger if exists mirror_rules_version on private.rules_versions;
create constraint trigger mirror_rules_version after insert or update of active on private.rules_versions
  deferrable initially deferred for each row when (new.active) execute function private.mirror_rules_version();
update public.world_revision_state r set rules_version=private.active_rules_version()
  where r.singleton and r.rules_version is distinct from private.active_rules_version();

-- 19-patches.sql's complete invoker read, with only the version appended.
create or replace view public.world_revision with(security_invoker=true) as
  select r.revision::text||':'||floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint::text||':'||
    coalesce((select max(reveal_at_ms) from public.visible_events),0)::text as revision,
    floor(extract(epoch from statement_timestamp())*1000)::bigint as server_now_ms,
    floor(extract(epoch from statement_timestamp())*1000/4800000)::bigint as slot_index,
    r.published_slot_index,
    (select p.number from public.patches p order by p.sort_key desc limit 1) as latest_patch,
    r.rules_version
  from public.world_revision_state r where singleton;
revoke all on public.world_revision from public,anon,authenticated,service_role;
grant select on public.world_revision to anon,authenticated,service_role;

-- 2. Seasons retain their opening boundary's version. Historical rows default to v1.
-- No FK: an unknown, well-formed version is retained, and payout refuses it atomically.
alter table public.seasons add column if not exists rules_version text not null default 'v1'
  check (rules_version ~ '^v[0-9]+$');
create or replace function private.guard_season() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'immutable season'; end if;
  if old.closed_at_ms is not null or new.closed_at_ms is null
    or (new.season_index,new.starts_at_ms,new.ends_at_ms,new.rules_version) is distinct from (old.season_index,old.starts_at_ms,old.ends_at_ms,old.rules_version) then
    raise exception 'immutable season';
  end if;
  return new;
end $$;

create or replace function private.season_prizes(version text, league text) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select case
    when version='v1' and league in ('bronze','silver','gold','champion') then '[{"money":500,"renown":100,"title":"champion","badge":"gold"},{"money":300,"renown":60,"title":null,"badge":"silver"},{"money":200,"renown":40,"title":null,"badge":"bronze"}]'::jsonb
    when version='v2' then case league
      when 'bronze' then '[{"money":200,"renown":100,"title":"champion","badge":"gold"},{"money":120,"renown":60,"title":null,"badge":"silver"},{"money":80,"renown":40,"title":null,"badge":"bronze"}]'::jsonb
      when 'silver' then '[{"money":300,"renown":100,"title":"champion","badge":"gold"},{"money":180,"renown":60,"title":null,"badge":"silver"},{"money":120,"renown":40,"title":null,"badge":"bronze"}]'::jsonb
      when 'gold' then '[{"money":400,"renown":100,"title":"champion","badge":"gold"},{"money":240,"renown":60,"title":null,"badge":"silver"},{"money":160,"renown":40,"title":null,"badge":"bronze"}]'::jsonb
      when 'champion' then '[{"money":500,"renown":100,"title":"champion","badge":"gold"},{"money":300,"renown":60,"title":null,"badge":"silver"},{"money":200,"renown":40,"title":null,"badge":"bronze"}]'::jsonb
    end
  end
$$;
revoke all on function private.season_prizes(text,text) from public,anon,authenticated;
grant execute on function private.season_prizes(text,text) to service_role;

-- 13-seasons.sql's latest payout body; only its prize lookup/refusal changes.
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
    prize:=private.season_prizes(s.rules_version,award.league)->(award.place-1);
    if prize is null then raise exception 'unknown season prizes'; end if;
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

-- 14-operations.sql's latest phase 2 and phase 4 bodies. Both insert from the frozen boundary, never the active row.
create or replace function private.boundary_close_season(target bigint) returns text
language plpgsql volatile security invoker set search_path='' as $$
declare current_season bigint:=private.season_index(target); now_ms bigint; earlier bigint;
begin
  if current_season is null then return null; end if;
  now_ms:=private.planning_now_ms();
  for earlier in select s.season_index from public.seasons s where s.closed_at_ms is null and s.season_index<current_season
    order by s.season_index loop
    perform private.close_season(earlier,now_ms);
  end loop;
  insert into public.seasons(season_index,starts_at_ms,ends_at_ms,rules_version)
    select current_season,b.starts_at_ms,b.ends_at_ms,(select frozen.rules_version from private.boundaries frozen where frozen.slot_index=target)
    from private.season_bounds(current_season) b
    on conflict do nothing;
  return null;
end $$;

create or replace function private.boundary_recompute_leagues(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare season bigint:=private.season_index(target); m record; g public.gladiators%rowtype; placed text; current_rating bigint;
begin
  if not exists(select 1 from private.boundary_members bm where bm.slot_index=target) then return null; end if;
  if season is null then return 'epoch'; end if;
  insert into public.seasons(season_index,starts_at_ms,ends_at_ms,rules_version)
    select season,b.starts_at_ms,b.ends_at_ms,(select frozen.rules_version from private.boundaries frozen where frozen.slot_index=target)
    from private.season_bounds(season) b
    on conflict do nothing;
  for m in select bm.gladiator_id,bm.owner_id,j.result->>'league' as computed,(j.result->>'arenaStrength')::numeric as strength
    from private.boundary_members bm join private.jobs j on j.dedupe_key='prepare:'||target||':'||bm.gladiator_id
    where bm.slot_index=target order by bm.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(m.owner_id::text,0));
    select * into g from public.gladiators where id=m.gladiator_id for update;
    placed:=case when private.league_rank(m.computed)>private.league_rank(g.league) then m.computed else g.league end;
    insert into private.arena_ratings(gladiator_id,league,season_index) values(m.gladiator_id,placed,season) on conflict do nothing;
    select r.rating into current_rating from private.arena_ratings r
      where r.gladiator_id=m.gladiator_id and r.league=placed and r.season_index=season;
    if g.league is distinct from placed or g.rating is distinct from current_rating then
      update public.gladiators set league=placed,rating=current_rating where id=m.gladiator_id;
    end if;
    insert into public.public_profiles(gladiator_id,rating,combat_strength) values(m.gladiator_id,current_rating,m.strength)
      on conflict (gladiator_id) do update set combat_strength=excluded.combat_strength
      where public_profiles.combat_strength is distinct from excluded.combat_strength;
  end loop;
  return null;
end $$;

revoke all on function private.guard_season(),private.close_season(bigint,bigint),
  private.boundary_close_season(bigint),private.boundary_recompute_leagues(bigint) from public,anon,authenticated;
grant execute on function private.guard_season(),private.close_season(bigint,bigint),
  private.boundary_close_season(bigint),private.boundary_recompute_leagues(bigint) to service_role;

-- 3. Publish ownership without changing the current rich profile projector or exposing the ownership table.
alter table public.public_profiles add column if not exists banner boolean not null default false;
create or replace function private.publish_banner() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  update public.public_profiles set banner=true where gladiator_id=new.gladiator_id and not banner;
  return null;
end $$;
revoke all on function private.publish_banner() from public,anon,authenticated,service_role;
drop trigger if exists publish_banner on public.owned_cosmetics;
create trigger publish_banner after insert on public.owned_cosmetics for each row
  when (new.catalog_id='banner') execute function private.publish_banner();
update public.public_profiles p set banner=true where not p.banner
  and exists(select 1 from public.owned_cosmetics c where c.gladiator_id=p.gladiator_id and c.catalog_id='banner');

-- 20-profile-card.sql's complete invoker read, retaining build, joinedAtMs and arenaRecord, with banner added.
create or replace view public.public_profile_reads with(security_invoker=true) as
  select p.gladiator_id,jsonb_build_object('actor',w.actor,'combatStrength',p.combat_strength,'rating',p.rating,'prestige',p.prestige,
    'build',p.build,'joinedAtMs',p.joined_at_ms,'arenaRecord',(select jsonb_build_object(
      'wins',coalesce(sum(s.human_wins),0)::bigint,'losses',coalesce(sum(s.human_losses),0)::bigint)
      from public.arena_standings s where s.gladiator_id=p.gladiator_id),'banner',p.banner) as profile
  from public.public_profiles p join public.world_actor_reads w using(gladiator_id);
revoke all on public.public_profile_reads from public,anon,authenticated,service_role;
grant select on public.public_profile_reads to anon,authenticated,service_role;

notify pgrst, 'reload schema';
commit;
