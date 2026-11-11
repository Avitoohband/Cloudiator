-- Supabase CLI 2.120.0, db pull game_info --local --schema public,private --diff-engine pg-delta --yes.
-- Generated from supabase/sql/26-game-info.sql on M01–M31. Completed from the source for exact ACL order and public seeds.
SET local check_function_bodies = off;

-- Game Info stores public player material separately from editable drafts.
-- A trusted Edge request verifies the Google account or MCP credential before calling the backend-only RPC.

create or replace function private.valid_game_info_document(tab text, document jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare
  entry jsonb;
  video jsonb;
  entry_id text;
  seen_ids text[] := array[]::text[];
begin
  if tab is null or tab not in ('wiki', 'future') or jsonb_typeof(document) is distinct from 'object'
    or jsonb_typeof(document->'entries') is distinct from 'array' or octet_length(document::text) > 14000 then
    return false;
  end if;
  if jsonb_array_length(document->'entries') > 40 then return false; end if;

  if tab = 'wiki' then
    if document - array['entries', 'videos'] <> '{}'::jsonb
      or jsonb_typeof(document->'videos') is distinct from 'array' then return false; end if;
    if jsonb_array_length(document->'videos') <> 2 then return false; end if;
    for video in select value from jsonb_array_elements(document->'videos') loop
      if video <> 'null'::jsonb and (jsonb_typeof(video) <> 'string' or
        (video #>> '{}') !~ '^https://((www[.])?youtube[.]com/watch[?]v=|youtu[.]be/)[A-Za-z0-9_-]{11}$') then return false; end if;
    end loop;
  elsif document - 'entries' <> '{}'::jsonb then
    return false;
  end if;

  for entry in select value from jsonb_array_elements(document->'entries') loop
    if jsonb_typeof(entry) is distinct from 'object'
      or jsonb_typeof(entry->'id') is distinct from 'string'
      or jsonb_typeof(entry->'title') is distinct from 'string'
      or jsonb_typeof(entry->'body') is distinct from 'string' then return false; end if;
    if entry - array['id', 'title', 'body', 'patch'] <> '{}'::jsonb
      or char_length(entry->>'title') > 80 or (entry->>'title') !~ '[^[:space:]]'
      or char_length(entry->>'body') > 4000 or (entry->>'body') !~ '[^[:space:]]' then return false; end if;
    if entry ? 'patch' and (tab <> 'future' or jsonb_typeof(entry->'patch') <> 'string'
      or (entry->>'patch') !~ '^(0|[1-9][0-9]{0,2})[.](0|[1-9][0-9]{0,2})([.][1-9][0-9]{0,2})?$') then return false; end if;
    entry_id := entry->>'id';
    if entry_id !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(entry_id) > 48 or entry_id = any(seen_ids) then
      return false;
    end if;
    seen_ids := array_append(seen_ids, entry_id);
  end loop;
  return true;
end $$;
revoke all on function private.valid_game_info_document(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.valid_game_info_document(text,jsonb) to service_role;

create table private.game_info_editors (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table private.game_info_drafts (
  tab text primary key check (tab in ('wiki', 'future')),
  version integer not null check (version >= 0),
  document jsonb not null check (private.valid_game_info_document(tab, document))
);

create table public.game_info_reads (
  tab text primary key check (tab in ('wiki', 'future')),
  version integer not null check (version >= 0),
  document jsonb not null check (private.valid_game_info_document(tab, document))
);

alter table private.game_info_editors enable row level security;
alter table private.game_info_drafts enable row level security;
alter table public.game_info_reads enable row level security;
revoke all on private.game_info_editors,private.game_info_drafts,public.game_info_reads from public,anon,authenticated,service_role;
grant select on private.game_info_editors to service_role;
grant select,update on private.game_info_drafts,public.game_info_reads to service_role;
grant select on public.game_info_reads to anon,authenticated;
create policy backend_read on private.game_info_editors for select to service_role using (true);
create policy backend_read on private.game_info_drafts for select to service_role using (true);
create policy backend_update on private.game_info_drafts for update to service_role using (true) with check (true);
create policy published_read on public.game_info_reads for select to anon,authenticated,service_role using (true);
create policy backend_update on public.game_info_reads for update to service_role using (true) with check (true);

insert into public.game_info_reads(tab, version, document) values
  ('wiki', 0, $wiki$
  {
    "entries": [
      {"id":"schedule","title":"Daily schedule","body":"Plan an activity for morning, afternoon and evening. Your schedule repeats until you change it."},
      {"id":"stamina","title":"Stamina and Rest","body":"Activities use stamina, and Rest restores it. An overloaded gladiator uses more stamina, so check your equipment before you go."},
      {"id":"training","title":"Training","body":"Training earns attribute points up to your level’s Training cap. Schedule up to two training sessions per game day. A third becomes Rest."},
      {"id":"combat","title":"Combat","body":"Precision helps you hit, while the defender’s Agility makes them harder to hit. Precision also increases the chance that a landed attack deals critical damage."},
      {"id":"attributes","title":"Attributes","body":"Strength raises damage. Agility helps you attack faster and avoid hits. Vitality raises health. Endurance improves stamina and gear capacity. Precision improves hit and critical chance."},
      {"id":"arena","title":"Arena","body":"Schedule Arena in the evening. Rated bouts can change your rating and earn renown. NPC and Ludus Nimbus bouts are unranked."},
      {"id":"dungeons","title":"Dungeons","body":"Enter in the afternoon with up to three fighters. Wolf Den opens first, followed by Raider Stronghold and Troll Hall. You keep the rewards from fights your party wins while you take part."}
    ],
    "videos": [null, null]
  }$wiki$::jsonb),
  ('future', 0, $future$
  {
    "entries": [
      {"id":"parties","title":"Dungeon party invitations","body":"Invite chosen teammates for a specific dungeon run."},
      {"id":"friends","title":"Friends","body":"Send friend requests and keep a friends list."},
      {"id":"items","title":"Inventory item art","body":"Recognize swords, armor and other gear by their pixel art in a grid."},
      {"id":"seasonal","title":"Seasonal camp themes","body":"Look for timed events and seasonal decorations around camp."}
    ]
  }$future$::jsonb);
insert into private.game_info_drafts(tab, version, document)
  select tab, version, document from public.game_info_reads;

create function public.edit_game_info(actor_id uuid, mcp boolean, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  action text := input->>'action';
  target_tab text := input->>'tab';
  requested_version numeric;
  current_version integer;
  next_version integer;
  current_document jsonb;
begin
  if mcp is true then
    if actor_id is not null or action = 'publish' then return '{"ok":false,"code":"forbidden"}'::jsonb; end if;
  elsif mcp is distinct from false or actor_id is null
    or not exists (select 1 from private.game_info_editors e where e.user_id = actor_id) then
    return '{"ok":false,"code":"forbidden"}'::jsonb;
  end if;
  if jsonb_typeof(input) is distinct from 'object' or coalesce(target_tab, '') not in ('wiki', 'future')
    or coalesce(action, '') not in ('read', 'save', 'publish') then return '{"ok":false,"code":"invalid"}'::jsonb; end if;

  if action = 'read' then
    if input - array['action', 'tab'] <> '{}'::jsonb then return '{"ok":false,"code":"invalid"}'::jsonb; end if;
    select d.version, d.document into current_version, current_document from private.game_info_drafts d where d.tab = target_tab;
    if not found then return '{"ok":false,"code":"unavailable"}'::jsonb; end if;
    return jsonb_build_object('ok', true, 'version', current_version, 'document', current_document);
  end if;

  if not private.safe_integer(input->'expectedVersion', 0) then return '{"ok":false,"code":"invalid"}'::jsonb; end if;
  requested_version := (input->>'expectedVersion')::numeric;
  if requested_version > 2147483647 then return '{"ok":false,"code":"invalid"}'::jsonb; end if;
  if action = 'save' then
    if input - array['action', 'tab', 'expectedVersion', 'document'] <> '{}'::jsonb
      or not private.valid_game_info_document(target_tab, input->'document') then return '{"ok":false,"code":"invalid"}'::jsonb; end if;
  elsif input - array['action', 'tab', 'expectedVersion'] <> '{}'::jsonb then
    return '{"ok":false,"code":"invalid"}'::jsonb;
  end if;

  select d.version, d.document into current_version, current_document from private.game_info_drafts d where d.tab = target_tab for update;
  if not found or current_version = 2147483647 then return '{"ok":false,"code":"unavailable"}'::jsonb; end if;
  if current_version <> requested_version then return '{"ok":false,"code":"conflict"}'::jsonb; end if;
  next_version := current_version + 1;

  if action = 'save' then
    current_document := input->'document';
  else
    update public.game_info_reads set version = next_version, document = current_document where tab = target_tab;
    if not found then return '{"ok":false,"code":"unavailable"}'::jsonb; end if;
  end if;
  update private.game_info_drafts set version = next_version, document = current_document where tab = target_tab;
  return jsonb_build_object('ok', true, 'version', next_version, 'document', current_document);
end $$;
revoke all on function public.edit_game_info(uuid,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.edit_game_info(uuid,boolean,jsonb) to service_role;

notify pgrst, 'reload schema';
