-- Gladiator appearance (2026-10-26) reapplicable source. Committed M01-M23 are immutable; deploy only the separately generated
-- migration M24 (supabase/migrations/*_appearance.sql). Spec: docs/superpowers/specs/2026-10-26-gladiator-appearance-design.md
-- ("Decisions": Storage, Command, Reads); plan: docs/superpowers/plans/2026-10-26-gladiator-appearance.md, Task 3.
--
-- 1. private.valid_appearance(jsonb): SQL's restatement of validAppearance (supabase/functions/_shared/domain/appearance.ts).
--    Exactly {body, hair, skin, hairColor, cloth}: body male|female, hair short|long|ponytail|bald, and whole palette indices
--    skin 0-4 (SKIN_TONES), hairColor 0-5 (HAIR_COLOURS), cloth 0-11 (CLOTH_COLOURS). It answers false, never null, for
--    anything else (SQL null included): a CHECK passes on null. The CASE keeps every cast behind its type test.
-- 2. public.gladiators.appearance jsonb, nullable with no default, CHECK (appearance is null or valid_appearance(appearance)).
--    Null is the legacy look (male body, short hair, colours from the gladiator's id; the client's case). Existing gladiators
--    stay null (no backfill), so nobody's look changes.
-- 3. public.create_gladiator: 04-inventory-shops.sql's body plus the optional sixth command key `appearance`. Present, it must
--    be a valid look (else `invalid`, checked with the command shape, so like every other shape error it stores no receipt and
--    no gladiator) and is stored; absent (an open tab from before the release), the gladiator is stored with no appearance.
--    The receipt keeps the whole command, look included, and its replay compares the whole command as before.
-- 4. private.project_character: 15-release.sql's projector plus the actor's `appearance` (null for the legacy look).
-- 5. public.owner_state: 15-release.sql's owner view plus `appearance`.
-- 6. Every actor republished, so existing ones carry `appearance: null`.
--
-- Cosmetic only: no snapshot, battle log, job input or rules version reads the look. Every statement is reapplicable.
begin;

create or replace function private.valid_appearance(look jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(case
    when jsonb_typeof(look) is distinct from 'object' then false
    when (select count(*) from jsonb_object_keys(look))<>5 or not (look ?& array['body','hair','skin','hairColor','cloth']) then false
    when jsonb_typeof(look->'body') is distinct from 'string' or look->>'body' not in ('male','female') then false
    when jsonb_typeof(look->'hair') is distinct from 'string' or look->>'hair' not in ('short','long','ponytail','bald') then false
    when jsonb_typeof(look->'skin') is distinct from 'number' or jsonb_typeof(look->'hairColor') is distinct from 'number'
      or jsonb_typeof(look->'cloth') is distinct from 'number' then false
    else (look->>'skin')::numeric between 0 and 4 and trunc((look->>'skin')::numeric)=(look->>'skin')::numeric
      and (look->>'hairColor')::numeric between 0 and 5 and trunc((look->>'hairColor')::numeric)=(look->>'hairColor')::numeric
      and (look->>'cloth')::numeric between 0 and 11 and trunc((look->>'cloth')::numeric)=(look->>'cloth')::numeric
  end,false)
$$;

-- A nullable column with no default is a catalog change only; the CHECK validates existing rows, all null.
alter table public.gladiators add column if not exists appearance jsonb
  constraint gladiators_appearance_check check (appearance is null or private.valid_appearance(appearance));

-- 04-inventory-shops.sql's creation, unchanged except the optional appearance.
create or replace function public.create_gladiator(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare command jsonb := input->'command'; allocation jsonb; total numeric; value jsonb; stat jsonb;
  existing public.operation_receipts%rowtype; result jsonb; gid uuid := gen_random_uuid(); receipt uuid := gen_random_uuid();
  weapon_id uuid := gen_random_uuid(); body_id uuid := gen_random_uuid(); now_ms bigint; slot bigint; item jsonb; item_id uuid; n integer := 0;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(input) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (select count(*) from jsonb_object_keys(input)) <> 4 or not (input ?& array['command','starterItems','staminaMaximum','peakStrength'])
    or jsonb_typeof(command) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  -- One account lock covers all its operation IDs. Name's unique index also serializes different accounts.
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into existing from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=create_gladiator.operation_id;
  if found then
    if existing.request <> command then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return existing.result;
  end if;
  -- Gladiator appearance (M24): an optional sixth key, exactly a valid look.
  if (select count(*) from jsonb_object_keys(command)) <> (case when command ? 'appearance' then 6 else 5 end)
    or not (command ?& array['kind','operationId','name','classId','allocation'])
    or (command ? 'appearance' and private.valid_appearance(command->'appearance') is not true)
    or command->>'kind' is distinct from 'create-character' or command->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(command->'name') is distinct from 'string' or command->>'name' <> btrim(command->>'name')
    or not (command->>'name' ~ '^[A-Za-z0-9 _-]{3,20}$')
    or jsonb_typeof(command->'classId') is distinct from 'string' or command->>'classId' not in ('berserker','guardian','duelist') then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  allocation := command->'allocation';
  if jsonb_typeof(allocation) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (select count(*) from jsonb_object_keys(allocation)) <> 5
    or not (allocation ?& array['strength','agility','vitality','endurance','precision']) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  total := 0;
  for value in select v from jsonb_each(allocation) e(k,v) loop
    if jsonb_typeof(value) <> 'number' or value::text::numeric < 0 or value::text::numeric > 10 or trunc(value::text::numeric) <> value::text::numeric then
      return jsonb_build_object('ok',false,'code','invalid');
    end if;
    total := total + value::text::numeric;
  end loop;
  if total <> 10 or jsonb_typeof(input->'staminaMaximum') is distinct from 'number'
    or jsonb_typeof(input->'starterItems') is distinct from 'array' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (input->>'staminaMaximum')::numeric not between 90 and 122
    or trunc((input->>'staminaMaximum')::numeric) <> (input->>'staminaMaximum')::numeric
    or jsonb_array_length(input->'starterItems') <> 2 then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  -- Catalog rolls come only from the backend's canonical v1 domain catalog, never from the player's command.
  for item in select * from jsonb_array_elements(input->'starterItems') loop
    if jsonb_typeof(item) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select count(*) from jsonb_object_keys(item)) <> 6 or not (item ?& array['catalogId','catalogVersion','tier','rarity','stats','binding'])
      or item->>'catalogId' is distinct from (case when n=0 then 'sword:1:common' else 'light-armor:1:common' end)
      or item->>'catalogVersion' is distinct from 'v1' or item->'tier' is distinct from '1'::jsonb
      or item->>'rarity' is distinct from 'common' or item->>'binding' is distinct from 'tradable'
      or jsonb_typeof(item->'stats') is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    stat := item->'stats';
    if (select count(*) from jsonb_object_keys(stat)) <> 5 or not (stat ?& array['damage','armor','weight','intervalMs','attributes'])
      or jsonb_typeof(stat->'attributes') is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select count(*) from jsonb_object_keys(stat->'attributes')) <> 5
      or not ((stat->'attributes') ?& array['strength','agility','vitality','endurance','precision']) then return jsonb_build_object('ok',false,'code','invalid'); end if;
    for value in select v from jsonb_each(stat-'attributes') e(k,v) union all select v from jsonb_each(stat->'attributes') e(k,v) loop
      if jsonb_typeof(value) is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
      if value::text::numeric not between 0 and 1000000000 or trunc(value::text::numeric*100) <> value::text::numeric*100 then
        return jsonb_build_object('ok',false,'code','invalid'); end if;
    end loop;
    if trunc((stat->>'intervalMs')::numeric) <> (stat->>'intervalMs')::numeric then return jsonb_build_object('ok',false,'code','invalid'); end if;
    n := n+1;
  end loop;
  if input->'peakStrength' is distinct from '28'::jsonb then return jsonb_build_object('ok',false,'code','invalid'); end if;
  now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  slot := now_ms / 4800000;
  begin
    -- The look as sent, or null (the legacy look) when the command has none.
    insert into public.gladiators(id,owner_id,name,stamina_current,stamina_maximum,processed_slot_index,created_at_ms,orientation_end_ms,peak_strength,appearance)
      values(gid,actor_id,command->>'name',(input->>'staminaMaximum')::bigint,(input->>'staminaMaximum')::bigint,slot,now_ms,(slot+1)*4800000,(input->>'peakStrength')::numeric,
        command->'appearance');
    insert into public.builds(gladiator_id,current_build) values(gid,jsonb_build_object('version',1,'classId',command->>'classId','stance','balanced','allocations',allocation,
      'equipment',jsonb_build_object('weapon',weapon_id,'body',body_id,'offHand',null,'head',null,'feet',null)));
    insert into public.schedules(gladiator_id,schedule) values(gid,'{"morning":{"kind":"training"},"afternoon":{"kind":"expedition","expeditionId":"woodland"},"evening":{"kind":"rest"}}');
    insert into public.wallets(gladiator_id) values(gid);
    n := 0;
    for item in select * from jsonb_array_elements(input->'starterItems') loop
      item_id := case when n=0 then weapon_id else body_id end;
      insert into public.item_instances(id,gladiator_id,item) values(item_id,gid,item || jsonb_build_object('id',item_id,'ownerId',gid,'quantity',1,'origin','starter',
        'reservation',jsonb_build_object('kind','equipment','referenceId',gid)));
      n := n+1;
    end loop;
    result := jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('gladiatorId',gid));
  exception when unique_violation then
    gid := null;
    result := jsonb_build_object('ok',false,'code','conflict');
  end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,gid,command,sha256(convert_to(command::text,'UTF8')),result);
  if gid is not null then insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason) values(gid,receipt,100,0,'creation'); end if;
  return result;
end $$;

-- 15-release.sql's projector, unchanged except the actor's appearance.
create or replace function private.project_character(gid uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare g public.gladiators%rowtype; b jsonb; a public.activities%rowtype; actor jsonb; silhouettes jsonb; awarded_prestige jsonb;
  resting boolean;
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
  -- Combined combat strength/league score belongs to Task 16. Never label gear history as that score.
  insert into public.public_profiles(gladiator_id,rating,prestige) values(gid,g.rating,awarded_prestige) on conflict(gladiator_id) do update
    set rating=excluded.rating,prestige=excluded.prestige
    where (public_profiles.rating,public_profiles.prestige) is distinct from (excluded.rating,excluded.prestige);
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

-- 15-release.sql's owner view, unchanged except appearance. create or replace keeps its grants; the WITH clause restates
-- security_invoker (CREATE OR REPLACE VIEW replaces a view's options with the ones it names).
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
  'restingUntilSlot',case when rest.signalled_at_ms is not null then rest.through_slot+1 end) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id
  left join public.character_rests rest on rest.gladiator_id=g.id and rest.since_slot<=g.processed_slot_index and g.processed_slot_index<=rest.through_slot;

-- valid_appearance is new (a function is executable by PUBLIC by default). Every role that writes a gladiator needs EXECUTE on it,
-- because the CHECK's function is checked when the write prepares the constraint: service_role (create_gladiator, boundaries,
-- settlements) and postgres (its owner). The other two are restated as their sources grant them.
revoke all on function private.valid_appearance(jsonb), public.create_gladiator(uuid,uuid,jsonb), private.project_character(uuid)
  from public, anon, authenticated;
grant execute on function private.valid_appearance(jsonb), public.create_gladiator(uuid,uuid,jsonb), private.project_character(uuid)
  to service_role;

-- Every actor republished with its appearance (null for every existing gladiator).
select public.refresh_projections();

notify pgrst,'reload schema';
commit;
