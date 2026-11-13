-- Supabase CLI 2.120.0, db pull feedback_mcp --local --schema public,private --diff-engine pg-delta --yes.
-- Generated from supabase/sql/30-feedback-mcp.sql on M01-M35. Completed from the source: its statements in its order (the draft
-- had no backfill of answered_via for the items answered before M36, which the CHECK feedback_answered_by_check requires, added
-- the column CHECKs after the function, and restated the grants role by role); the function body equals the source's,
-- character for character. Supabase owns the transaction.
SET local check_function_bodies = off;

-- Patch 1.9 (M36): Claude suggests answers to feedback through the Game Info MCP; only the owner sends them. Reapplicable on M35 for
-- local iteration; deploy only the separately generated migration M36, completed from this file (committed M01-M35 are immutable).
-- Local only: it joins the one 1.9 push of M33-M35, never before M35, on Avi's go; the game-info function must then run this code,
-- which calls the new signature (the release order is in docs/operations/migrations.md). Spec: Avi, 2026-11-12, "You can directly
-- reply but only I approve" (the binding ruling for Task 23b, .superpowers/sdd/2026-11-12-1.9-additions/task-23b-brief.md).
--
-- 1. public.feedback gains Claude's suggestion and who wrote the sent answer. suggested_answer is a suggested answer (1 to 2,000
--    characters, trimmed) and suggested_at_ms its database time, both or neither, and never on an answered item (the answer clears
--    them). answered_via says who wrote the text the player got: 'owner' (the editor's own words) or 'claude-approved' (the
--    editor sent Claude's suggestion, as it was or edited); it is set exactly when the item is answered. Every item answered before
--    M36 was written by an editor, so it is backfilled 'owner' before the CHECK that requires it. The player's six readable columns
--    are unchanged: a player never reads a suggestion (it is the team's until an editor sends it) or who answered.
-- 2. public.review_feedback takes the caller kind, as public.edit_game_info does: (actor_id, mcp, input). M34's (actor_id, input) is
--    dropped, so there is one entry point. The game-info Edge function passes either a verified Google account with mcp false, or
--    no account with mcp true for the separately configured MCP credential (Claude). A Game Info editor (private.game_info_editors)
--    may list, mark read and answer; the MCP credential may list, mark read and suggest. Each may not use the other's action
--    (forbidden), and an unknown caller kind, an account with mcp true, or a non-editor is forbidden for everything.
--      list and mark-read: exactly as M34's (the same rules, limits and answers for both callers); each item also carries
--        answeredVia ('owner', 'claude-approved' or null), suggestion (the text or null) and suggestedAtMs (or null).
--      suggest (MCP only): {tab:'feedback', action:'suggest', id, text}, the text 1 to 2,000 characters once trimmed. It saves the
--        trimmed text as the item's one suggestion, replacing any earlier one, at the database time; status and the player's rows
--        do not change, and nothing is posted. An answered item is conflict. Answers {ok, id, status, suggestedAtMs}.
--      answer (editor only): M34's answer, with an optional fromSuggestion: true (any other value, or the key on another action,
--        is invalid). The text sent is the editor's (`text`), never the stored suggestion: "Approve and send" passes the suggestion
--        it showed, and "Edit" the edited text. With fromSuggestion the item must still hold a suggestion (else conflict, nothing
--        sent) and answered_via is 'claude-approved'; without it, 'owner'. The team reply is posted exactly as in M34 (the same
--        insert as service_role, so M35's guard admits only a current team reply for that one account), and the answer clears the
--        suggestion. Answers {ok, id, status:'answered', messageId}.
--    The MCP credential gains no message power: it never inserts a message, never answers and still never publishes the Wiki or
--    Future Updates (edit_game_info, unchanged). Lock order as M34: the one feedback row (for update); the database time is sampled
--    after it, just before the write (for an answer, just before the team reply's insert, as M34 and M35 expect).
-- 3. The backend may update the three new columns (column grants); no client role reads or writes them.
--
-- Rules, prices, the daily cap, player commands and every other function are unchanged. The function is SECURITY INVOKER with an
-- empty search path, executable by the backend (service_role) only.


-- 1. The suggestion and who answered.
alter table public.feedback add column if not exists suggested_answer text check (suggested_answer is null or char_length(suggested_answer) between 1 and 2000);
alter table public.feedback add column if not exists suggested_at_ms bigint check (suggested_at_ms is null or suggested_at_ms>=0);
alter table public.feedback add column if not exists answered_via text check (answered_via is null or answered_via in ('owner','claude-approved'));
-- Before M36 only an editor could answer.
update public.feedback set answered_via='owner' where status='answered' and answered_via is null;
alter table public.feedback drop constraint if exists feedback_answered_by_check;
alter table public.feedback add constraint feedback_answered_by_check check ((status='answered')=(answered_via is not null));
alter table public.feedback drop constraint if exists feedback_suggestion_check;
alter table public.feedback add constraint feedback_suggestion_check
  check ((suggested_answer is null)=(suggested_at_ms is null) and (suggested_answer is null or status<>'answered'));
grant update (suggested_answer,suggested_at_ms,answered_via) on public.feedback to service_role;

-- 2. One review path for the editor and the MCP credential.
drop function if exists public.review_feedback(uuid,jsonb);
create or replace function public.review_feedback(actor_id uuid, mcp boolean, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare act text:=input->>'action'; wanted text; f public.feedback%rowtype; items jsonb; reply text; heading text; teaser text;
  blocks jsonb; posted bigint; now_ms bigint; approved boolean;
begin
  -- The caller first: the MCP credential (no account) never answers; an editor never suggests; anyone else nothing.
  if mcp is true then
    if actor_id is not null or act='answer' then return '{"ok":false,"code":"forbidden"}'::jsonb; end if;
  elsif mcp is distinct from false or actor_id is null or not exists(select 1 from private.game_info_editors e where e.user_id=actor_id)
    or act='suggest' then
    return '{"ok":false,"code":"forbidden"}'::jsonb;
  end if;
  if jsonb_typeof(input) is distinct from 'object' or input->>'tab' is distinct from 'feedback' then
    return '{"ok":false,"code":"invalid"}'::jsonb;
  end if;
  if act='list' then
    wanted:=input->>'filter';
    if input-array['tab','action','filter']<>'{}'::jsonb or jsonb_typeof(input->'filter') is distinct from 'string'
      or wanted not in ('new','answered','all') then return '{"ok":false,"code":"invalid"}'::jsonb; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'category',x.category,'text',x.text,'details',x.details,'status',x.status,
        'createdAtMs',x.created_at_ms,'gladiatorName',x.name,'answer',x.answer,'answeredAtMs',x.answered_at_ms,'answeredVia',x.answered_via,
        'suggestion',x.suggested_answer,'suggestedAtMs',x.suggested_at_ms) order by x.id desc),'[]'::jsonb)
      into items
      from (select b.id,b.category,b.text,b.details,b.status,b.created_at_ms,g.name,b.answer,b.answered_at_ms,b.answered_via,b.suggested_answer,
          b.suggested_at_ms from public.feedback b
        left join public.gladiators g on g.id=b.gladiator_id where wanted='all' or b.status=wanted order by b.id desc limit 100) x;
    return jsonb_build_object('ok',true,'items',items,'newCount',(select count(*) from public.feedback b where b.status='new'));
  end if;
  if coalesce(act not in ('mark-read','answer','suggest'),true) or not private.safe_integer(input->'id',1)
    or input-(case act when 'answer' then array['tab','action','id','text','fromSuggestion'] when 'suggest' then array['tab','action','id','text']
      else array['tab','action','id'] end)<>'{}'::jsonb
    or (act='answer' and input ? 'fromSuggestion' and input->'fromSuggestion' is distinct from 'true'::jsonb) then
    return '{"ok":false,"code":"invalid"}'::jsonb;
  end if;
  approved:=(act='answer' and input ? 'fromSuggestion');
  if act in ('answer','suggest') then
    if jsonb_typeof(input->'text') is distinct from 'string' then return '{"ok":false,"code":"invalid"}'::jsonb; end if;
    reply:=regexp_replace(input->>'text','^[[:space:]]+|[[:space:]]+$','','g');
    if char_length(reply) not between 1 and 2000 then return '{"ok":false,"code":"invalid"}'::jsonb; end if;
  end if;
  select * into f from public.feedback b where b.id=(input->>'id')::bigint for update;
  if not found then return '{"ok":false,"code":"not-found"}'::jsonb; end if;
  if act='mark-read' then
    update public.feedback b set status='read' where b.id=f.id and b.status='new';
    return jsonb_build_object('ok',true,'id',f.id,'status',case when f.status='new' then 'read' else f.status end);
  end if;
  if f.status='answered' or (approved and f.suggested_answer is null) then return '{"ok":false,"code":"conflict"}'::jsonb; end if;
  if act='suggest' then
    now_ms:=private.planning_now_ms();
    update public.feedback b set suggested_answer=reply,suggested_at_ms=now_ms where b.id=f.id;
    return jsonb_build_object('ok',true,'id',f.id,'status',f.status,'suggestedAtMs',now_ms);
  end if;
  heading:=case f.category when 'bug' then 'Answer to your bug report' when 'idea' then 'Answer to your idea'
    when 'balance' then 'Answer to your balance report' else 'Answer to your feedback' end;
  teaser:=regexp_replace(reply,'[[:space:]]+',' ','g');
  if char_length(teaser)>140 then teaser:=left(teaser,139)||'…'; end if;
  with lines as (
    select row_number() over (order by s.n) as n,s.line from (
      select t.n,regexp_replace(t.line,'^[[:space:]]+|[[:space:]]+$','','g') as line
      from regexp_split_to_table(reply,'\n') with ordinality t(line,n)) s
    where s.line<>'')
  select jsonb_agg(jsonb_build_object('p',p.line) order by p.n) into blocks from (
    select l.n,l.line from lines l where l.n<20
    union all
    select 20,string_agg(l.line,' ' order by l.n) from lines l where l.n>=20 having count(*)>0) p;
  now_ms:=private.planning_now_ms();
  insert into public.game_messages(kind,title,preview,body,published_at_ms,recipient_id)
    values('team-reply',heading,teaser,blocks,now_ms,f.owner_id) returning id into posted;
  update public.feedback b set status='answered',answer=reply,answered_at_ms=now_ms,answer_message_id=posted,
    answered_via=case when approved then 'claude-approved' else 'owner' end,suggested_answer=null,suggested_at_ms=null where b.id=f.id;
  return jsonb_build_object('ok',true,'id',f.id,'status','answered','messageId',posted);
end $$;
revoke all on function public.review_feedback(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.review_feedback(uuid,boolean,jsonb) to service_role;

notify pgrst, 'reload schema';
