-- Supabase CLI 2.120.0, db pull game_info_guides --local --schema public,private --diff-engine pg-delta --yes.
-- Generated from supabase/sql/27-game-info-guides.sql on M01–M32. Completed from the source: its function statement
-- and the two updates the generator does not emit, after the function. Replacing the validator keeps its owner and ACL.
SET local check_function_bodies = off;

-- Patch 1.9 (M33): each Wiki topic may carry one YouTube guide, and the Wiki's two document-level video slots go.
-- A Wiki entry may have `video` (a bare YouTube link, M32's pattern) and `videoLength` (m:ss under an hour, only with a
-- video). Both are optional: an absent key means no guide, and null is refused. Neither is allowed on the Future tab, and
-- `videos` is refused on both tabs. Every other M32 rule (size, entry count, ids, titles, bodies, patch) is unchanged.
-- Replacing the validator keeps its owner, ACL, language, volatility, invoker mode and empty search path. It comes first
-- because M32's validator requires `videos` on the Wiki; the slots were always null, so the versions stay as they are.

create or replace function private.valid_game_info_document(tab text, document jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare
  entry jsonb;
  entry_id text;
  seen_ids text[] := array[]::text[];
begin
  if tab is null or tab not in ('wiki', 'future') or jsonb_typeof(document) is distinct from 'object'
    or jsonb_typeof(document->'entries') is distinct from 'array' or octet_length(document::text) > 14000 then
    return false;
  end if;
  if jsonb_array_length(document->'entries') > 40 then return false; end if;
  if document - 'entries' <> '{}'::jsonb then return false; end if;

  for entry in select value from jsonb_array_elements(document->'entries') loop
    if jsonb_typeof(entry) is distinct from 'object'
      or jsonb_typeof(entry->'id') is distinct from 'string'
      or jsonb_typeof(entry->'title') is distinct from 'string'
      or jsonb_typeof(entry->'body') is distinct from 'string' then return false; end if;
    if entry - array['id', 'title', 'body', 'patch', 'video', 'videoLength'] <> '{}'::jsonb
      or char_length(entry->>'title') > 80 or (entry->>'title') !~ '[^[:space:]]'
      or char_length(entry->>'body') > 4000 or (entry->>'body') !~ '[^[:space:]]' then return false; end if;
    if entry ? 'patch' and (tab <> 'future' or jsonb_typeof(entry->'patch') <> 'string'
      or (entry->>'patch') !~ '^(0|[1-9][0-9]{0,2})[.](0|[1-9][0-9]{0,2})([.][1-9][0-9]{0,2})?$') then return false; end if;
    if entry ? 'video' and (tab <> 'wiki' or jsonb_typeof(entry->'video') <> 'string'
      or (entry->>'video') !~ '^https://((www[.])?youtube[.]com/watch[?]v=|youtu[.]be/)[A-Za-z0-9_-]{11}$') then return false; end if;
    if entry ? 'videoLength' and (not (entry ? 'video') or jsonb_typeof(entry->'videoLength') <> 'string'
      or (entry->>'videoLength') !~ '^([0-9]|[1-5][0-9]):[0-5][0-9]$') then return false; end if;
    entry_id := entry->>'id';
    if entry_id !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(entry_id) > 48 or entry_id = any(seen_ids) then
      return false;
    end if;
    seen_ids := array_append(seen_ids, entry_id);
  end loop;
  return true;
end $$;

update public.game_info_reads set document = document - 'videos' where tab = 'wiki';
update private.game_info_drafts set document = document - 'videos' where tab = 'wiki';
