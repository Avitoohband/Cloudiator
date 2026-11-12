-- Supabase CLI 2.120.0, db pull team_reply_guard --local --schema public,private --diff-engine pg-delta --yes.
-- Generated from supabase/sql/29-team-reply-guard.sql on M01-M34. Completed from the source: its four statements in its order
-- (the draft created the trigger before revoking, and restated the owner's own EXECUTE); the function body equals the source's,
-- character for character. Supabase owns the transaction.
SET local check_function_bodies = off;

-- Patch 1.9 (M35): the backend may insert a current team reply only. It closes the gap M34 left
-- (supabase/sql/28-feedback-buyback.sql, section 1): M34 granted service_role INSERT on six columns of public.game_messages so
-- that public.review_feedback can post a team reply, and that grant alone would also let the backend's key insert an admin note
-- or a patch note for every player, at any published_at_ms. That would break M25's operator-only posting
-- (18-messages.sql, section 3) and the contract's "never back-dated" (GameMessage.publishedAtMs). Reapplicable on M34 for local
-- iteration; deploy only the separately generated migration M35, completed from this file. Local only: it ships with M34.
--
-- private.guard_team_reply, a BEFORE INSERT trigger on public.game_messages: a row inserted as service_role must be a team reply
-- (kind team-reply) with its one recipient, dated by the database clock: published_at_ms from 5,000 ms before
-- private.planning_now_ms() (sampled in the trigger) to 1,000 ms after it. review_feedback samples the same clock just before its
-- insert, in the same transaction, so its reply is a few milliseconds old at most. The 5 seconds absorb a slow statement between
-- that sample and the insert, and nothing older passes: a back-dated reply would sort under older messages and could read as
-- already read. A future date can only be forged, and the 1 second only absorbs a clock step; anything later would sort above
-- messages posted after it. Every other role is untouched: the operator (postgres) posts and hides broadcasts as before (no client
-- role holds INSERT). A refused insert raises 42501 ("backend may insert only a current team reply"). The function is SECURITY
-- INVOKER with an empty search path, and no API role may execute it (a trigger needs no EXECUTE to fire); as service_role it
-- calls private.planning_now_ms(), which the backend already executes. The trigger fires before the table's CHECKs, so a team
-- reply without a recipient is refused here first.

create or replace function private.guard_team_reply() returns trigger
language plpgsql security invoker set search_path='' as $$
declare now_ms bigint;
begin
  if current_user='service_role' then
    now_ms:=private.planning_now_ms();
    if new.kind is distinct from 'team-reply' or new.recipient_id is null
      or new.published_at_ms is null or new.published_at_ms<now_ms-5000 or new.published_at_ms>now_ms+1000 then
      raise exception 'backend may insert only a current team reply' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_team_reply() from public,anon,authenticated,service_role;
drop trigger if exists guard_team_reply on public.game_messages;
create trigger guard_team_reply before insert on public.game_messages for each row execute function private.guard_team_reply();
