-- Patch 1.9 (M37): the Marketplace seller band, every gladiator's history (Arena, tournaments, expeditions) and a guard on approving
-- Claude's suggestion. Reapplicable on M36 for local iteration; deploy only the separately generated migration M37, completed from this
-- file (committed M01-M36 are immutable). Local only: it joins the one 1.9 push of M33-M36, never before M36, on Avi's go (the release
-- order is in docs/operations/migrations.md). Specs: .superpowers/design/2026-11-12-market-grid/notes.md ("Revision 2026-11-13": the
-- seller band) and .superpowers/design/2026-11-12-gladiator-history/notes.md ("Server: what a new public read must expose"); Task 25's
-- brief (.superpowers/sdd/2026-11-12-1.9-additions/task-25-brief.md). No game number, price, fee, limit, reward or command changes.
--
-- 1. public.market_offer_reads: the open offers of public.market_offers, each with its seller gladiator's class, league and level as of
--    the read, joined from the seller's public actor projection (public.world_actors, which every change to the gladiator row or its
--    build re-projects in the same transaction). No copy is stored: a seller the projection does not know reads null. The offer
--    columns and their row security (an offer is hidden from its expiry time on) are market_offers' own; the commands still write
--    market_offers, unchanged.
-- 2. public.result_details: what a settled Arena bout or expedition shows on any card that its public result row
--    (public.recent_results) lacks: the Arena bout's league and the time it was fought, and the expedition's destination. One row per
--    activity, written once when the activity is completed with a summary (a bot's activity has none, so it never gets one), by
--    the trigger result_details_on_activity: the league comes from the bout's private assignment, which is deleted after seven days,
--    so it is kept here; the destination is the activity's own request. Immutable (guard_frozen); it goes with its activity at the
--    90-day pass (on delete cascade). Readable by visitors and players once its time has come (the same due rule as recent_results).
--    Every existing completed Arena bout and expedition is backfilled: an Arena bout older than seven days has no assignment left,
--    so its league is null, and its fought time is the slot's minute 60 (rules v1 and v2: arena.revealAfterMs 3,600,000) when its
--    bout stage is gone.
-- 3. public.gladiator_history_reads: one gladiator's settled history, by kind, for any reader (visitor, player or owner). An Arena or
--    expedition row is one settled activity; a tournament row is one fought bout (never a bye) of a settled tournament run. Each row:
--    gladiator_id, kind ('arena', 'tournament' or 'expedition'), entry_id (the activity id, or the tournament bout id), activity_id
--    (the replay: timeline(activity_id)), fought_at_ms (Arena: the bout's reveal; tournament: the bout's reveal; expedition: the
--    slot's start), settled_at_ms, result ('victory' or 'defeat'; a tournament row's is that bout's), success, replay_expires_at_ms
--    (the replay's expiry while it is kept at the read's database time, else null), arena_mode ('unranked' or null), league (Arena:
--    the bout's; tournament: the tournament's), tournament_id, round ('Final', 'Semifinal', 'Quarterfinal' or 'Round n'), place (the
--    run's final place, already public in tournament_placements), expedition_id, and opponent ({name, npc, botTeam?}) only while the
--    replay is kept. Nothing of an activity before it has settled (every row joins its public result, whose due rule applies), and
--    never a reward, renown, rating change, gold, item, loot, receipt, schedule, plan or stamina: none of them is in any table it
--    reads. The opponent comes from the public bout stage (Arena) or bout result (tournament), and is null once the replay expires.
--    The due rules are stated in the view too (a public result and a bout result count only once their time has come), so the
--    backend, which row security does not filter, reads exactly what a player reads.
-- 4. public.gladiator_history_counts: per gladiator, how many rows of each kind the history has, and how many of them are a
--    'victory' (an expedition's is its success). A gladiator without history has no row.
--    Both views are security_invoker: a reader needs, and has, SELECT on each table beneath (all open projections), and their row
--    security applies (tournament_views through its granted columns only). No function is callable by a client.
-- 5. public.review_feedback (M36's, restated): approving Claude's suggestion carries the suggestion's time. An answer with
--    fromSuggestion must also carry suggestedAtMs (a whole number; either key alone is invalid), and it is conflict, with nothing
--    sent, unless the item still holds a suggestion saved at exactly that time: Claude may have replaced it after the owner loaded
--    the list. Everything else is M36's, line for line.
--
-- Lock order: the trigger runs inside the settlement that completes the activity, after its locks, and only inserts its one row
-- (key-share locks on the activity and gladiator rows the settlement already holds). The views take no lock beyond their reads.
begin;

-- 1. The seller band.
create or replace view public.market_offer_reads with (security_invoker=true) as
  select o.id,o.seller_gladiator_id,o.seller_name,o.item,o.price,o.listed_at_ms,o.expires_at_ms,
    w.actor->>'classId' as seller_class_id,w.actor->>'league' as seller_league,
    case when jsonb_typeof(w.actor->'level')='number' then (w.actor->>'level')::numeric::integer end as seller_level
  from public.market_offers o left join public.world_actors w on w.gladiator_id=o.seller_gladiator_id;
revoke all on public.market_offer_reads from public,anon,authenticated,service_role;
grant select on public.market_offer_reads to anon,authenticated,service_role;

-- 2. The details a public result lacks, kept with the activity.
create table if not exists public.result_details (
  activity_id uuid primary key references public.activities(id) on delete cascade,
  gladiator_id uuid not null references public.gladiators(id) on delete cascade,
  kind text not null check (kind in ('arena','expedition')),
  fought_at_ms bigint not null,
  reveal_at_ms bigint not null,
  league text check (league is null or (kind='arena' and league in ('bronze','silver','gold','champion'))),
  expedition_id text check (expedition_id is null or kind='expedition')
);
create index if not exists result_details_history_idx on public.result_details(gladiator_id,kind,fought_at_ms desc);
alter table public.result_details enable row level security;
revoke all on public.result_details from public,anon,authenticated,service_role;
grant select on public.result_details to anon,authenticated;
grant select,insert on public.result_details to service_role;
drop policy if exists player_read on public.result_details;
-- Real database clock, as recent_results: a row is readable once its activity's result is.
create policy player_read on public.result_details for select to anon,authenticated
  using (reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint);
drop trigger if exists guard_frozen on public.result_details;
create trigger guard_frozen before update on public.result_details for each row execute function private.guard_frozen();

-- Written once, when a settlement completes an Arena bout or an expedition with its summary (or a completed row is inserted).
create or replace function private.result_details_on_activity() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.status is distinct from 'completed' or new.summary is null or new.settled_at_ms is null
    or coalesce(new.resolved_kind not in ('arena','expedition'),true) or (tg_op='UPDATE' and old.status='completed') then
    return null;
  end if;
  insert into public.result_details(activity_id,gladiator_id,kind,fought_at_ms,reveal_at_ms,league,expedition_id)
    values(new.id,new.gladiator_id,new.resolved_kind,
      case when new.resolved_kind='arena' then coalesce((select s.reveal_at_ms from public.activity_stages s
        where s.activity_id=new.id and s.stage->>'kind'='bout' order by s.ordinal desc limit 1),new.starts_at_ms+3600000)
        else new.starts_at_ms end,
      new.settled_at_ms,
      case when new.resolved_kind='arena' then (select x.league from private.arena_assignment_sides d
        join private.arena_assignments x on x.battle_id=d.battle_id where d.activity_id=new.id) end,
      case when new.resolved_kind='expedition' then new.requested->>'expeditionId' end)
    on conflict (activity_id) do nothing;
  return null;
end $$;
revoke all on function private.result_details_on_activity() from public,anon,authenticated,service_role;
drop trigger if exists result_details_on_activity on public.activities;
create trigger result_details_on_activity after insert or update of status on public.activities for each row
  execute function private.result_details_on_activity();

-- Every Arena bout and expedition settled before M37, as the trigger would have written it.
insert into public.result_details(activity_id,gladiator_id,kind,fought_at_ms,reveal_at_ms,league,expedition_id)
  select a.id,a.gladiator_id,a.resolved_kind,
    case when a.resolved_kind='arena' then coalesce((select s.reveal_at_ms from public.activity_stages s
      where s.activity_id=a.id and s.stage->>'kind'='bout' order by s.ordinal desc limit 1),a.starts_at_ms+3600000)
      else a.starts_at_ms end,
    a.settled_at_ms,
    case when a.resolved_kind='arena' then (select x.league from private.arena_assignment_sides d
      join private.arena_assignments x on x.battle_id=d.battle_id where d.activity_id=a.id) end,
    case when a.resolved_kind='expedition' then a.requested->>'expeditionId' end
  from public.activities a
  where a.status='completed' and a.summary is not null and a.settled_at_ms is not null and a.resolved_kind in ('arena','expedition')
  on conflict (activity_id) do nothing;

-- 3. One gladiator's history: Arena bouts and expeditions, then the fought bouts of its settled tournament runs.
create or replace view public.gladiator_history_reads with (security_invoker=true) as
  select d.gladiator_id,d.kind,d.activity_id::text as entry_id,d.activity_id,d.fought_at_ms,r.reveal_at_ms as settled_at_ms,
    r.summary->>'result' as result,(r.summary->'success')='true'::jsonb as success,
    case when k.kept then (r.summary->'replayExpiry'->>'expiresAtMs')::numeric::bigint end as replay_expires_at_ms,
    case when d.kind='arena' and r.summary->>'arenaMode'='unranked' then 'unranked' end as arena_mode,
    d.league,null::text as tournament_id,null::text as round,null::integer as place,d.expedition_id,
    -- The bout's other participant, while the replay is kept: exactly two, exactly one of them this gladiator (an NPC has no id).
    case when k.kept and d.kind='arena' then (select case when jsonb_array_length(l.ps)=2
        and (select count(*) from jsonb_array_elements(l.ps) q where q->>'gladiatorId'=d.gladiator_id::text)=1 then
        (select jsonb_build_object('name',q->>'name','npc',q->>'gladiatorId' is null)
          ||case when r.summary->>'arenaMode'='unranked' and q->>'gladiatorId' is not null and q->>'botTeam'='ludus-nimbus'
            then jsonb_build_object('botTeam','ludus-nimbus') else '{}'::jsonb end
          from jsonb_array_elements(l.ps) q where q->>'gladiatorId' is distinct from d.gladiator_id::text
            and jsonb_typeof(q->'name')='string' and q->>'name'<>'' limit 1) end
      from (select s.stage->'battleLog'->'participants' as ps from public.activity_stages s
        where s.activity_id=d.activity_id and s.stage->>'kind'='bout' and jsonb_typeof(s.stage->'battleLog'->'participants')='array'
          and s.reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
        order by s.ordinal desc limit 1) l) end as opponent
  from public.result_details d
  join public.recent_results r on r.activity_id=d.activity_id and r.reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
  cross join lateral (select coalesce(r.summary->'replayExpiry'->>'state'='available' and case when jsonb_typeof(r.summary->'replayExpiry'->'expiresAtMs')='number'
    then (r.summary->'replayExpiry'->>'expiresAtMs')::numeric>floor(extract(epoch from clock_timestamp())*1000) else false end,false) as kept) k
  union all
  select p.gladiator_id,'tournament',b.bout_id,p.activity_id,b.reveal_at_ms,r.reveal_at_ms,
    case when b.result->>'winnerId'=p.gladiator_id::text then 'victory' else 'defeat' end,b.result->>'winnerId'=p.gladiator_id::text,
    case when k.kept then (r.summary->'replayExpiry'->>'expiresAtMs')::numeric::bigint end,
    null::text,v.league,p.tournament_id,
    case when jsonb_typeof(v.bracket->'rounds')<>'number' then 'Round '||b.round
      when b.round=(v.bracket->>'rounds')::integer then 'Final' when b.round=(v.bracket->>'rounds')::integer-1 then 'Semifinal'
      when b.round=(v.bracket->>'rounds')::integer-2 then 'Quarterfinal' else 'Round '||b.round end,
    p.place,null::text,
    case when k.kept then (select jsonb_build_object('name',q->>'name','npc',false) from jsonb_array_elements(b.result->'participants') q
      where q->>'gladiatorId' is distinct from p.gladiator_id::text and jsonb_typeof(q->'name')='string' and q->>'name'<>'' limit 1) end
  from public.tournament_placements p
  join public.recent_results r on r.activity_id=p.activity_id and r.reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
  join public.tournament_views v on v.id=p.tournament_id
  join public.tournament_bout_results b on b.tournament_id=p.tournament_id and b.result->>'bye'='false'
    and b.reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
    and case when jsonb_typeof(b.result->'participants')='array' then jsonb_array_length(b.result->'participants')=2 else false end
    and b.result->'participants' @> jsonb_build_array(jsonb_build_object('gladiatorId',p.gladiator_id))
  cross join lateral (select coalesce(r.summary->'replayExpiry'->>'state'='available' and case when jsonb_typeof(r.summary->'replayExpiry'->'expiresAtMs')='number'
    then (r.summary->'replayExpiry'->>'expiresAtMs')::numeric>floor(extract(epoch from clock_timestamp())*1000) else false end,false) as kept) k;
revoke all on public.gladiator_history_reads from public,anon,authenticated,service_role;
grant select on public.gladiator_history_reads to anon,authenticated,service_role;

-- 4. The chips' counts, over the same rows (no opponent is read).
create or replace view public.gladiator_history_counts with (security_invoker=true) as
  select x.gladiator_id,
    count(*) filter (where x.kind='arena') as arena,count(*) filter (where x.kind='arena' and x.won) as arena_won,
    count(*) filter (where x.kind='tournament') as tournament,count(*) filter (where x.kind='tournament' and x.won) as tournament_won,
    count(*) filter (where x.kind='expedition') as expedition,count(*) filter (where x.kind='expedition' and x.won) as expedition_won
  from (
    select d.gladiator_id,d.kind,r.summary->>'result'='victory' as won
    from public.result_details d
    join public.recent_results r on r.activity_id=d.activity_id and r.reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
    union all
    select p.gladiator_id,'tournament',b.result->>'winnerId'=p.gladiator_id::text
    from public.tournament_placements p
    join public.recent_results r on r.activity_id=p.activity_id and r.reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
    join public.tournament_bout_results b on b.tournament_id=p.tournament_id and b.result->>'bye'='false'
      and b.reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint
      and case when jsonb_typeof(b.result->'participants')='array' then jsonb_array_length(b.result->'participants')=2 else false end
      and b.result->'participants' @> jsonb_build_array(jsonb_build_object('gladiatorId',p.gladiator_id))
  ) x
  group by x.gladiator_id;
revoke all on public.gladiator_history_counts from public,anon,authenticated,service_role;
grant select on public.gladiator_history_counts to anon,authenticated,service_role;

-- 5. M36's review path, with the suggestion's time on an approval.
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
  -- M37: an approval names the suggestion it approves by its time (fromSuggestion and suggestedAtMs together, or neither).
  if coalesce(act not in ('mark-read','answer','suggest'),true) or not private.safe_integer(input->'id',1)
    or input-(case act when 'answer' then array['tab','action','id','text','fromSuggestion','suggestedAtMs'] when 'suggest' then array['tab','action','id','text']
      else array['tab','action','id'] end)<>'{}'::jsonb
    or (act='answer' and input ? 'fromSuggestion' and input->'fromSuggestion' is distinct from 'true'::jsonb)
    or (act='answer' and (input ? 'fromSuggestion')<>(input ? 'suggestedAtMs'))
    or (act='answer' and input ? 'suggestedAtMs' and not private.safe_integer(input->'suggestedAtMs')) then
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
  -- M37: the approved suggestion must still be the one the owner saw (Claude may have replaced it since the list was read).
  if f.status='answered' or (approved and (f.suggested_answer is null
    or f.suggested_at_ms is distinct from (input->>'suggestedAtMs')::bigint)) then return '{"ok":false,"code":"conflict"}'::jsonb; end if;
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
commit;
