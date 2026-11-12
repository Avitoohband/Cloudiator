-- Patch 1.9 (M34): Feedback and Buy back. Reapplicable on M33 for local iteration; deploy only the separately generated
-- migration M34, completed from this file (committed M01-M33 are immutable). Local only: it ships with or after the Task 23
-- client, on Avi's go. Spec: the approved mockups (.superpowers/design/2026-11-12-feedback-buyback/notes.md, 2026-11-12) and
-- the task brief (.superpowers/sdd/2026-11-12-1.9-additions/task-22-brief.md).
--
-- 1. Team replies. public.game_messages gains recipient_id (null = everyone, as before) and the kind team-reply, which always
--    names its one recipient (game_messages_recipient_check; a broadcast never does). Row security shows a row to everyone or to
--    its recipient only. public.read_message is restated from 18-messages.sql: another account's reply is not-found, like a
--    hidden message. The backend posts a reply (public.review_feedback, section 2): it may insert exactly the columns a reply sets,
--    and it executes the body CHECK's function. Posting a broadcast stays the operator's (private.post_message, unchanged).
-- 2. Feedback. public.feedback holds what a signed-in account sends: its category, the trimmed text (10 to 1,000 characters), the
--    optional game details (private.valid_feedback_details, before the table whose CHECK calls it: AGENTS.md, M24 lesson), the
--    status new -> read -> answered and the team's one answer. A player reads its own rows through row security, six columns
--    only; every write goes through two functions. public.send_feedback is the command send-feedback (receipts; at most 5 per
--    account and game day; the game day is floor(planning time / 14,400,000), three 80-minute slots). public.review_feedback
--    serves the Game Info editors (private.game_info_editors) through the game-info Edge function: list, mark read, answer.
-- 3. Buy back. public.npc_sales stores a snapshot of each gear sale: the item as it was, the gold paid, the sale time and the
--    sale's receipt (salvage is never stored). private.inventory_command is restated from 21-economy.sql: a gear sale stores its
--    snapshot and removes the gladiator's sales of earlier game days. public.buy_back is the command buy-back: sell-item's lock
--    order, receipt and processing check, the same item back for exactly the gold it was sold for (ledger reason npc-buy-back).
--    private.titles_on_ledger is restated from 22-titles.sql: an NPC sale of an item the gladiator bought back counts no gold
--    earned (its first sale counted; a sale and buy-back loop would otherwise count the same gold again and again).
-- 4. public.owner_state is restated from 24-dungeons.sql with exactly two changes: inbox.unread counts only the messages for
--    everyone or for this account, and buyBack lists this gladiator's last 10 gear sales of the current game day not yet bought
--    back, newest first.
--
-- Prices, sell values, the bag limit, the rules and the catalog are unchanged. Every function is SECURITY INVOKER with an empty
-- search path; the new ones are executable by the backend (service_role) only.
--
-- Lock order: every command takes the account advisory lock first (hashtextextended(owner_id::text,0)), then reads its receipt.
-- buy_back then follows sell-item exactly: the gladiator row, the processing check, the wallet, the items by id, and last the
-- sale row. send_feedback locks nothing else (nothing of the gladiator changes; the account lock serializes the daily count).
-- review_feedback locks the one feedback row it changes; a reply's insert raises the world revision at commit through the
-- messages table's deferred projection_changed trigger, as an operator's post does.
begin;

-- 1. Team replies.

alter table public.game_messages add column if not exists recipient_id uuid references auth.users(id) on delete cascade;
alter table public.game_messages drop constraint if exists game_messages_kind_check;
alter table public.game_messages add constraint game_messages_kind_check check (kind in ('patch-notes','admin','team-reply'));
alter table public.game_messages drop constraint if exists game_messages_recipient_check;
alter table public.game_messages add constraint game_messages_recipient_check check ((kind='team-reply')=(recipient_id is not null));
create index if not exists game_messages_recipient_idx on public.game_messages(recipient_id);
-- Visitors (no account) read the broadcasts; a signed-in player reads the broadcasts and its own replies. service_role bypasses row
-- security, so the owner read (owner_state) and read_message restate the recipient filter themselves.
drop policy if exists player_read on public.game_messages;
create policy player_read on public.game_messages for select to anon,authenticated
  using (not hidden and (recipient_id is null or recipient_id=(select auth.uid())));
-- The backend writes a reply's own columns only (never hidden, action or id), and runs the body CHECK's function as itself.
grant insert (kind,title,preview,body,published_at_ms,recipient_id) on public.game_messages to service_role;
grant execute on function private.valid_message_body(jsonb) to service_role;

-- public.read_message: 18-messages.sql's (section 3; no later source restates it), unchanged except that a message is found only
-- when it is for everyone or for the caller's own account, so another account's team reply is not-found, as a hidden one is.
create or replace function public.read_message(actor_id uuid, message_id bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if message_id is null or not exists(select 1 from public.game_messages m where m.id=read_message.message_id and not m.hidden
      and (m.recipient_id is null or m.recipient_id=actor_id)) then
    return jsonb_build_object('ok',false,'code','not-found');
  end if;
  insert into public.message_reads(owner_id,message_id,read_at_ms)
    values(actor_id,read_message.message_id,floor(extract(epoch from clock_timestamp())*1000)::bigint) on conflict do nothing;
  return jsonb_build_object('ok',true,'value',jsonb_build_object('messageId',read_message.message_id));
end $$;

-- 2. Feedback.

-- The game details a player may attach: exactly patch, screen, device and window (strings of at most 80 characters) and sentAtMs
-- (a whole time from 0). It answers false, never null, for anything else; the CASE keeps each test behind the one before it (SQL
-- does not promise the order of OR terms). The CHECK on public.feedback.details calls it, so it comes before the table, and the
-- backend, which inserts feedback, executes it (as private.valid_appearance for gladiators).
create or replace function private.valid_feedback_details(details jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(case
    when jsonb_typeof(details) is distinct from 'object' then false
    when details-array['patch','screen','device','window','sentAtMs']<>'{}'::jsonb then false
    when not (details ?& array['patch','screen','device','window','sentAtMs']) then false
    when jsonb_typeof(details->'patch')<>'string' or jsonb_typeof(details->'screen')<>'string'
      or jsonb_typeof(details->'device')<>'string' or jsonb_typeof(details->'window')<>'string' then false
    when char_length(details->>'patch')>80 or char_length(details->>'screen')>80
      or char_length(details->>'device')>80 or char_length(details->>'window')>80 then false
    else private.safe_integer(details->'sentAtMs',0)
  end,false)
$$;
revoke all on function private.valid_feedback_details(jsonb) from public,anon,authenticated,service_role;
grant execute on function private.valid_feedback_details(jsonb) to service_role;

-- One row per feedback a signed-in account sends: its account (the reply goes to it, and its rows go with it), its gladiator when
-- it had one, the category, the trimmed text (stored and shown as plain text only), the details or null, the status and the
-- team's one answer: the text, its posting time and its team-reply message (all three exactly when answered).
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  gladiator_id uuid references public.gladiators(id),
  category text not null check (category in ('bug','idea','balance','other')),
  text text not null check (char_length(text) between 10 and 1000),
  details jsonb check (details is null or private.valid_feedback_details(details)),
  status text not null default 'new' check (status in ('new','read','answered')),
  created_at_ms bigint not null check (created_at_ms>=0),
  answer text check (answer is null or char_length(answer) between 1 and 2000),
  answered_at_ms bigint check (answered_at_ms is null or answered_at_ms>=0),
  answer_message_id bigint unique references public.game_messages(id),
  constraint feedback_answered_check check ((status='answered')=(answer is not null and answered_at_ms is not null and answer_message_id is not null))
);
create index if not exists feedback_owner_time_idx on public.feedback(owner_id,created_at_ms);
create index if not exists feedback_gladiator_idx on public.feedback(gladiator_id);
alter table public.feedback enable row level security;
revoke all on public.feedback from public,anon,authenticated,service_role;
-- The player's own rows, six columns (never its account, gladiator, details or the answer's text and message: the answer arrives as
-- a message, posted at answered_at_ms). The backend inserts (send_feedback), reads and answers (review_feedback).
grant select (id,category,text,status,created_at_ms,answered_at_ms) on public.feedback to authenticated;
grant select,insert on public.feedback to service_role;
grant update (status,answer,answered_at_ms,answer_message_id) on public.feedback to service_role;
drop policy if exists owner_read on public.feedback;
create policy owner_read on public.feedback for select to authenticated using (owner_id=(select auth.uid()));
-- The identity sequence is the owner's alone (an identity insert needs no grant on it; the platform's default would give UPDATE).
revoke all on sequence public.feedback_id_seq from public,anon,authenticated,service_role;

-- public.send_feedback(actor_id, operation_id, input): the command send-feedback. Shaped like public.wear_title (22-titles.sql): the
-- account lock; the receipt replay (a replay returns the stored result, another body under the same operation is conflict, both
-- before any shape check); exactly the keys category (bug, idea, balance or other), details (null or valid game details), kind,
-- operationId (the call's own, as text) and text (a string of 10 to 1,000 characters once leading and trailing white space is
-- trimmed; stored trimmed); then at most 5 per account and game day: the account's rows created in the current game day
-- (floor(planning time / 14,400,000)) are counted under the account lock, and a sixth is daily-limit. Any signed-in account may
-- send; its gladiator's id is stored when it has one (nothing of the gladiator changes, so its row is not locked). No refusal
-- writes a receipt, so a refused operation may be sent again (on the next game day). It never answers processing.
-- Result: {ok:true, receiptId, value:{feedbackId, leftToday}}. Backend only (EXECUTE for service_role).
create or replace function public.send_feedback(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prior public.operation_receipts%rowtype; gid uuid; now_ms bigint; day_start bigint; sent bigint;
  trimmed text; attached jsonb; posted bigint; receipt uuid:=gen_random_uuid(); result jsonb;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=send_feedback.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  -- Each term is true or false, never null (a null term would let the OR chain fall through).
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['category','details','kind','operationId','text']
    or c->>'kind' is distinct from 'send-feedback' or c->>'operationId' is distinct from operation_id::text
    or coalesce(c->>'category' not in ('bug','idea','balance','other'),true) or jsonb_typeof(c->'text') is distinct from 'string'
    or coalesce(jsonb_typeof(c->'details') not in ('null','object'),true) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  trimmed:=regexp_replace(c->>'text','^[[:space:]]+|[[:space:]]+$','','g');
  attached:=case when c->'details'='null'::jsonb then null else c->'details' end;
  if char_length(trimmed) not between 10 and 1000 or (attached is not null and not private.valid_feedback_details(attached)) then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  select g.id into gid from public.gladiators g where g.owner_id=actor_id;
  now_ms:=private.planning_now_ms();
  day_start:=now_ms-now_ms%14400000;
  select count(*) into sent from public.feedback f where f.owner_id=actor_id and f.created_at_ms>=day_start and f.created_at_ms<day_start+14400000;
  if sent>=5 then return jsonb_build_object('ok',false,'code','daily-limit'); end if;
  insert into public.feedback(owner_id,gladiator_id,category,text,details,created_at_ms)
    values(actor_id,gid,c->>'category',trimmed,attached,now_ms) returning id into posted;
  result:=jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('feedbackId',posted,'leftToday',4-sent));
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,gid,c,sha256(convert_to(c::text,'UTF8')),result);
  return result;
end $$;
revoke all on function public.send_feedback(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.send_feedback(uuid,uuid,jsonb) to service_role;

-- public.review_feedback(actor_id, input): the Game Info editors' feedback tab, behind the game-info Edge function, which passes the
-- verified Google account and never the MCP credential (this function has no MCP path). As in public.edit_game_info, an account
-- outside private.game_info_editors, or none, is forbidden. The input is exactly one of:
--   {tab:'feedback', action:'list', filter:'new'|'answered'|'all'}: the newest 100 with that status (all: any status), newest
--     first, each {id, category, text, details, status, createdAtMs, gladiatorName (its gladiator's name now, or null), answer,
--     answeredAtMs}, and newCount (how many are new in all). Answers {ok, items, newCount}.
--   {tab:'feedback', action:'mark-read', id}: new -> read; read and answered stay. Answers {ok, id, status}.
--   {tab:'feedback', action:'answer', id, text}: the text is 1 to 2,000 characters once trimmed. In one transaction: one team-reply
--     message for that item's account only (titled by its category; the preview is the text on one line, cut to 140 characters;
--     the body is one paragraph per non-blank line, at most 20, the last holding any further lines) and the item answered with the
--     text, the message and its posting time (so the item's answered_at_ms is the message's published_at_ms). One answer per item:
--     a second is conflict. Answers {ok, id, status:'answered', messageId}.
-- A missing item is not-found; any other input is invalid. Backend only (EXECUTE for service_role).
create or replace function public.review_feedback(actor_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare act text:=input->>'action'; wanted text; f public.feedback%rowtype; items jsonb; reply text; heading text; teaser text;
  blocks jsonb; posted bigint; now_ms bigint;
begin
  if actor_id is null or not exists(select 1 from private.game_info_editors e where e.user_id=actor_id) then
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
        'createdAtMs',x.created_at_ms,'gladiatorName',x.name,'answer',x.answer,'answeredAtMs',x.answered_at_ms) order by x.id desc),'[]'::jsonb)
      into items
      from (select b.id,b.category,b.text,b.details,b.status,b.created_at_ms,g.name,b.answer,b.answered_at_ms from public.feedback b
        left join public.gladiators g on g.id=b.gladiator_id where wanted='all' or b.status=wanted order by b.id desc limit 100) x;
    return jsonb_build_object('ok',true,'items',items,'newCount',(select count(*) from public.feedback b where b.status='new'));
  end if;
  if coalesce(act not in ('mark-read','answer'),true) or not private.safe_integer(input->'id',1)
    or input-(case when act='answer' then array['tab','action','id','text'] else array['tab','action','id'] end)<>'{}'::jsonb then
    return '{"ok":false,"code":"invalid"}'::jsonb;
  end if;
  if act='answer' then
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
  if f.status='answered' then return '{"ok":false,"code":"conflict"}'::jsonb; end if;
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
  update public.feedback b set status='answered',answer=reply,answered_at_ms=now_ms,answer_message_id=posted where b.id=f.id;
  return jsonb_build_object('ok',true,'id',f.id,'status','answered','messageId',posted);
end $$;
revoke all on function public.review_feedback(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.review_feedback(uuid,jsonb) to service_role;

-- 3. Buy back.

-- One row per NPC sale of gear: the item exactly as it was before the sale (its id and jsonb: level, rarity, stats, origin; never
-- reserved, never salvage), the gold paid (the price it can be bought back for), the database time of the sale and the sale's
-- receipt; and, once bought back, when and under which receipt. Receipts are permanent, so both references hold. The owner reads
-- its gladiator's rows (01-identity.sql's owner_read recipe); the backend inserts them (a sale), marks one bought back and removes
-- a gladiator's rows of earlier game days at its next gear sale (none of them can be bought back any more).
create table if not exists public.npc_sales (
  id bigint generated always as identity primary key,
  gladiator_id uuid not null references public.gladiators(id),
  item_id uuid not null,
  item jsonb not null check (jsonb_typeof(item)='object' and item ?& array['id','ownerId','catalogId','quantity','reservation']
    and item->>'id'=item_id::text and item->>'ownerId'=gladiator_id::text and item->>'catalogId'<>'salvage'
    and item->'quantity'='1'::jsonb and item->'reservation'='null'::jsonb),
  price bigint not null check (price between 1 and 9007199254740991),
  sold_at_ms bigint not null check (sold_at_ms>=0),
  sale_receipt_id uuid not null unique references public.operation_receipts(receipt_id),
  bought_back_at_ms bigint check (bought_back_at_ms is null or bought_back_at_ms>=0),
  buy_back_receipt_id uuid unique references public.operation_receipts(receipt_id),
  constraint npc_sales_bought_back_check check ((bought_back_at_ms is null)=(buy_back_receipt_id is null))
);
create index if not exists npc_sales_gladiator_idx on public.npc_sales(gladiator_id,id);
alter table public.npc_sales enable row level security;
revoke all on public.npc_sales from public,anon,authenticated,service_role;
grant select on public.npc_sales to authenticated;
grant select,insert,delete on public.npc_sales to service_role;
grant update (bought_back_at_ms,buy_back_receipt_id) on public.npc_sales to service_role;
drop policy if exists owner_read on public.npc_sales;
create policy owner_read on public.npc_sales for select to authenticated using
  (gladiator_id in (select id from public.gladiators where owner_id=(select auth.uid())));
revoke all on sequence public.npc_sales_id_seq from public,anon,authenticated,service_role;

-- private.inventory_command: 21-economy.sql's (section 7; no later source restates it), unchanged except the last block before its
-- return: a gear sale (never salvage) that succeeded stores its snapshot (the item read under the locks before it was deleted, the
-- gold credited, the planning time and the sale's receipt, which is inserted before it), after removing the gladiator's sales of
-- earlier game days. The sale's own answer, its prices and checks are unchanged. CREATE OR REPLACE keeps its owner and ACL.
create or replace function private.inventory_command(actor_id uuid, operation_id uuid, input jsonb, kind text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prep jsonb:=input->'prepared'; prior public.operation_receipts%rowtype;
  g public.gladiators%rowtype; w public.wallets%rowtype; item jsonb; offer jsonb; result jsonb; applied jsonb;
  receipt uuid:=gen_random_uuid(); err text; quantity bigint; cost numeric; money_delta bigint:=0; renown_delta bigint:=0;
  remaining bigint; available numeric; target uuid; unit_value numeric;
  prepared_version text; active_version text; sold_ms bigint;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=inventory_command.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if c->>'kind' is distinct from kind or c->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(c->'quantity') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (c->>'quantity')::numeric not between 1 and 999 or trunc((c->>'quantity')::numeric)<>(c->>'quantity')::numeric
    then return jsonb_build_object('ok',false,'code','invalid'); end if;
  quantity:=(c->>'quantity')::bigint;
  if kind='buy-shop' then
    if (select count(*) from jsonb_object_keys(c))<>5 or not(c ?& array['kind','operationId','catalogId','catalogVersion','quantity'])
      or jsonb_typeof(c->'catalogId') is distinct from 'string' or jsonb_typeof(c->'catalogVersion') is distinct from 'string'
      then return jsonb_build_object('ok',false,'code','invalid'); end if;
  elsif kind in ('sell-item','discard-item') then
    if (select count(*) from jsonb_object_keys(c))<>4 or not(c ?& array['kind','operationId','itemId','quantity'])
      or jsonb_typeof(c->'itemId') is distinct from 'string' or c->>'itemId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then return jsonb_build_object('ok',false,'code','invalid'); end if;
    target:=(c->>'itemId')::uuid;
  else return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if g.processed_slot_index<private.planning_now_ms()/4800000 then return jsonb_build_object('ok',false,'code','processing','retryAfterMs',1000); end if;
  select * into w from public.wallets where gladiator_id=g.id for update;
  perform 1 from public.item_instances where gladiator_id=g.id order by id for update;
  if kind='buy-shop' and c->>'catalogId'='banner' then
    offer:=prep->'offer';
    if quantity<>1 or prep->'cosmetic' is distinct from 'true'::jsonb or c->>'catalogVersion'<>'v1'
      or offer->>'catalogId' is distinct from 'banner' or offer->>'catalogVersion' is distinct from 'v1'
      or offer->>'currency' is distinct from 'renown' or jsonb_typeof(offer->'unitPrice') is distinct from 'number' then err:='invalid';
    elsif exists(select 1 from public.owned_cosmetics where gladiator_id=g.id and catalog_id='banner') then err:='conflict';
    else
      cost:=(offer->>'unitPrice')::numeric;
      select w.renown-coalesce(sum(r.renown),0) into available from public.reservations r where r.gladiator_id=g.id and r.status='held';
      if cost not between 1 and 9007199254740991 or trunc(cost)<>cost then err:='invalid';
      elsif cost>available then err:='insufficient-funds';
      else
        insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version) values(g.id,'banner','v1');
        renown_delta:=-cost::bigint;
        result:=jsonb_build_object('cosmeticId','banner','catalogVersion','v1','renownDebit',cost,'moneyDebit',0,'bound',true);
      end if;
    end if;
  elsif kind='buy-shop' then
    offer:=prep->'offer';
    if prep is null or prep='null'::jsonb or jsonb_typeof(offer) is distinct from 'object'
      or offer->>'catalogId' is distinct from c->>'catalogId' or offer->>'catalogVersion' is distinct from c->>'catalogVersion'
      or offer->>'currency' not in ('money','renown') or jsonb_typeof(offer->'unitPrice') is distinct from 'number'
      or jsonb_typeof(offer->'requiredLevel') is distinct from 'number' then err:='invalid';
    elsif (offer->>'requiredLevel')::numeric>g.level or (offer->>'unitPrice')::numeric not between 1 and 9007199254740991
      or trunc((offer->>'unitPrice')::numeric)<>(offer->>'unitPrice')::numeric then err:='invalid';
    elsif (select count(*) from public.item_instances where gladiator_id=g.id)+quantity>60 then err:='inventory-full';
    else
      cost:=(offer->>'unitPrice')::numeric*quantity;
      if cost>9007199254740991 then err:='invalid';
      else
        select (case when offer->>'currency'='money' then w.money else w.renown end)
          -coalesce(sum(case when offer->>'currency'='money' then r.money else r.renown end),0) into available
          from public.reservations r where r.gladiator_id=g.id and r.status='held';
        if cost>available then err:='insufficient-funds'; end if;
      end if;
    end if;
    if err is null then
      if jsonb_array_length(prep->'plan'->'retained')<>quantity or prep->'plan'->'stacked'<>'[]'::jsonb
        or prep->'plan'->'overflowMoney'<>'0'::jsonb then err:='invalid';
      else
        applied:=private.apply_inventory_plan(g.id,prep);
        if applied is null then err:='conflict';
        else
          if offer->>'currency'='money' then money_delta:=-cost::bigint; else renown_delta:=-cost::bigint; end if;
          result:=jsonb_build_object('itemIds',applied->'itemIds','catalogId',c->'catalogId','catalogVersion',c->'catalogVersion','quantity',quantity,
            'currency',offer->'currency','moneyDebit',-money_delta,'renownDebit',-renown_delta,'bound',offer->>'currency'='renown','peakStrength',applied->'peakStrength');
        end if;
      end if;
    end if;
  else
    select i.item into item from public.item_instances i where i.id=target and i.gladiator_id=g.id;
    if not found then err:='not-found';
    elsif item->'reservation' is distinct from 'null'::jsonb or exists(select 1 from public.pending_build_items where item_id=target)
      or quantity>(item->>'quantity')::bigint then err:='invalid';
    elsif kind='sell-item' then
      if item->>'origin'='renown' or item->>'binding'<>'tradable' or prep is null or prep='null'::jsonb
        or prep->>'catalogId' is distinct from item->>'catalogId' or prep->>'catalogVersion' is distinct from item->>'catalogVersion'
        or jsonb_typeof(prep->'unitValue') is distinct from 'number' then err:='invalid';
      else
        unit_value:=(prep->>'unitValue')::numeric;
        if item->>'catalogId'='salvage' then
          if prep ? 'rulesVersion' and prep->'rulesVersion' not in ('"v1"'::jsonb,'"v2"'::jsonb) then err:='invalid';
          else
            -- The legacy unstamped preparation carries v1's price. Only committed receipts replay across versions.
            prepared_version:=coalesce(prep->>'rulesVersion','v1');
            -- A separate read after the account guard sees any switch that committed while this sale waited.
            select private.active_rules_version() into active_version;
            if active_version is distinct from prepared_version then
              return jsonb_build_object('ok',false,'code','unavailable');
            elsif unit_value<>(case active_version when 'v1' then 10 when 'v2' then 4 end) then err:='invalid';
            end if;
          end if;
        end if;
        if err is null then
          cost:=unit_value*quantity;
          if unit_value not between 1 and 9007199254740991 or trunc(unit_value)<>unit_value or cost>9007199254740991
            or w.money::numeric+cost>9007199254740991 then err:='invalid'; else money_delta:=cost::bigint; end if;
        end if;
      end if;
    end if;
    if err is null then
      remaining:=(item->>'quantity')::bigint-quantity;
      if remaining=0 then delete from public.item_instances where id=target;
      else update public.item_instances i set item=jsonb_set(i.item,'{quantity}',to_jsonb(remaining)) where i.id=target; end if;
      result:=jsonb_build_object('itemId',target,'quantity',quantity,'remainingQuantity',remaining);
      if kind='sell-item' then result:=result||jsonb_build_object('moneyCredit',money_delta); end if;
    end if;
  end if;
  result:=case when err is null then jsonb_build_object('ok',true,'receiptId',receipt,'value',result) else jsonb_build_object('ok',false,'code',err) end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  if err is null and kind<>'discard-item' then
    update public.wallets set money=money+money_delta,renown=renown+renown_delta where gladiator_id=g.id;
    insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason)
      values(g.id,receipt,money_delta,renown_delta,case kind when 'buy-shop' then 'shop-purchase' else 'npc-sale' end);
  end if;
  -- M34: a gear sale's snapshot, after its receipt; first the gladiator's sales of earlier game days go (none can be bought back).
  if err is null and kind='sell-item' and item->>'catalogId'<>'salvage' then
    sold_ms:=private.planning_now_ms();
    delete from public.npc_sales n where n.gladiator_id=g.id and n.sold_at_ms<sold_ms-sold_ms%14400000;
    insert into public.npc_sales(gladiator_id,item_id,item,price,sold_at_ms,sale_receipt_id) values(g.id,target,item,money_delta,sold_ms,receipt);
  end if;
  return result;
end $$;

-- public.buy_back(actor_id, operation_id, input): the command buy-back, {kind, operationId, saleId}. It follows sell-item
-- (private.inventory_command) step by step: the account lock; the receipt replay (a replay returns the stored result, another body
-- under the same operation is conflict); the exact shape (invalid, not recorded); the caller's own gladiator for update (not-found
-- without one: the command names no gladiator, so no other's sale can be bought back); processing while the world is behind (not
-- recorded, so the same operation succeeds after catch-up); the wallet, then every item by id, then the sale row, all for update.
-- The sale must be this gladiator's (else not-found), not yet bought back, of the current game day (floor(planning time /
-- 14,400,000)) and among its last 10 gear sales of that day, bought back or not (else expired). A full bag (60) is inventory-full;
-- spendable gold (money less held fees) under the sale's price is insufficient-funds. The backend's preparation names the item it
-- scored and the historical strength before and after it returns (as buy-listing's, 12-market.sql); without one, for another item
-- or from another baseline it is conflict. Each decided outcome is recorded under its operation, as a sale's is. On success: the
-- same item instance (id and jsonb, reservation null) is inserted again, the sale is marked bought back, exactly its price is
-- debited with ledger reason npc-buy-back, and historical strength rises to the preparation's.
-- Result: {ok:true, receiptId, value:{itemId, moneyDebit}}. Backend only (EXECUTE for service_role).
create or replace function public.buy_back(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prep jsonb:=input->'prepared'; prior public.operation_receipts%rowtype;
  g public.gladiators%rowtype; w public.wallets%rowtype; s public.npc_sales%rowtype; result jsonb; err text;
  receipt uuid:=gen_random_uuid(); now_ms bigint; day_start bigint; available numeric; baseline numeric; next_peak numeric;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=buy_back.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['kind','operationId','saleId']
    or c->>'kind' is distinct from 'buy-back' or c->>'operationId' is distinct from operation_id::text
    or not private.safe_integer(c->'saleId',1) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  -- The preparation: none (JSON null or absent), or exactly the scored item and the historical strength before and after. Nested
  -- checks, because jsonb_object_keys fails on a scalar and SQL does not promise the order of OR terms.
  if prep='null'::jsonb then prep:=null; end if;
  if prep is not null then
    if jsonb_typeof(prep) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(prep) k) is distinct from array['baselinePeakStrength','itemId','nextPeakStrength']
      or jsonb_typeof(prep->'itemId') is distinct from 'string'
      or coalesce(prep->>'itemId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',true)
      or jsonb_typeof(prep->'baselinePeakStrength') is distinct from 'number'
      or jsonb_typeof(prep->'nextPeakStrength') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    baseline:=(prep->>'baselinePeakStrength')::numeric; next_peak:=(prep->>'nextPeakStrength')::numeric;
    if baseline<0 or next_peak<baseline or next_peak>9007199254740991 or trunc(next_peak*100)<>next_peak*100 then
      return jsonb_build_object('ok',false,'code','invalid');
    end if;
  end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms();
  if g.processed_slot_index<now_ms/4800000 then return jsonb_build_object('ok',false,'code','processing','retryAfterMs',1000); end if;
  select * into w from public.wallets where gladiator_id=g.id for update;
  perform 1 from public.item_instances where gladiator_id=g.id order by id for update;
  day_start:=now_ms-now_ms%14400000;
  select * into s from public.npc_sales n where n.id=(c->>'saleId')::bigint and n.gladiator_id=g.id for update;
  if not found then err:='not-found';
  elsif s.bought_back_at_ms is not null or s.sold_at_ms<day_start or s.sold_at_ms>=day_start+14400000
    or (select count(*) from public.npc_sales n where n.gladiator_id=g.id and n.sold_at_ms>=day_start
      and n.sold_at_ms<day_start+14400000 and n.id>s.id)>=10 then err:='expired';
  elsif exists(select 1 from public.item_instances i where i.id=s.item_id) then err:='conflict';
  elsif (select count(*) from public.item_instances i where i.gladiator_id=g.id)>=60 then err:='inventory-full';
  else
    select w.money-coalesce(sum(r.money),0) into available from public.reservations r where r.gladiator_id=g.id and r.status='held';
    if s.price>available then err:='insufficient-funds';
    elsif prep is null or prep->>'itemId' is distinct from s.item_id::text or baseline<>g.peak_strength then err:='conflict';
    else result:=jsonb_build_object('itemId',s.item_id,'moneyDebit',s.price);
    end if;
  end if;
  result:=case when err is null then jsonb_build_object('ok',true,'receiptId',receipt,'value',result) else jsonb_build_object('ok',false,'code',err) end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  if err is null then
    insert into public.item_instances(id,gladiator_id,item) values(s.item_id,g.id,s.item);
    update public.npc_sales n set bought_back_at_ms=now_ms,buy_back_receipt_id=receipt where n.id=s.id;
    update public.wallets set money=money-s.price where gladiator_id=g.id;
    insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason) values(g.id,receipt,-s.price,0,'npc-buy-back');
    update public.gladiators set peak_strength=next_peak where id=g.id and peak_strength<>next_peak;
  end if;
  return result;
end $$;
revoke all on function public.buy_back(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.buy_back(uuid,uuid,jsonb) to service_role;

-- private.titles_on_ledger: 22-titles.sql's (no later source restates it; 24-dungeons.sql recreated only its trigger), unchanged
-- except one more early return: an NPC sale of an item the gladiator bought back (the item's id in the gladiator's own successful
-- buy-back receipts) earns no gold-earned progress and no sale award. Its first sale counted; without this, selling and buying
-- back the same item would count the same gold again and again. Receipts are permanent, so the rule holds after the sale
-- snapshots are removed. CREATE OR REPLACE keeps its owner and ACL (executable by nobody but the owner) and its trigger.
create or replace function private.titles_on_ledger() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.reason='npc-sale' and exists(select 1 from public.operation_receipts sale join public.operation_receipts bought
      on bought.gladiator_id=new.gladiator_id and bought.request->>'kind'='buy-shop' and bought.result->>'ok'='true'
      where sale.receipt_id=new.receipt_id and bought.result->'value'->'itemIds' ? (sale.request->>'itemId')) then
    return null;
  end if;
  if new.reason='npc-sale' and exists(select 1 from public.operation_receipts sale join public.operation_receipts returned
      on returned.gladiator_id=new.gladiator_id and returned.request->>'kind'='buy-back' and returned.result->>'ok'='true'
      where sale.receipt_id=new.receipt_id and returned.result->'value'->>'itemId'=sale.request->>'itemId') then
    return null;
  end if;
  perform private.add_title_count(new.gladiator_id,
    case when private.active_rules_version()='v1' then 'gold-v1' else 'gold-v2' end,new.money_delta);
  if new.reason='npc-sale' then
    perform private.award_titles(new.gladiator_id,floor(extract(epoch from clock_timestamp())*1000)::bigint,null,'sale',null);
  end if;
  return null;
end $$;

-- 4. public.owner_state: 24-dungeons.sql's view (no later source restates it), with exactly two changes:
--   - inbox.unread counts only the messages for everyone or for this account (m.recipient_id null or the owner), as the row
--     security of public.game_messages shows them (the backend reads this view past row security, so it filters itself);
--   - buyBack: this gladiator's last 10 gear sales of the current game day (by id, newest first; the database time of the read,
--     as currentActivity's), leaving out those bought back: {saleId, item (as sold), price, soldAtMs, expiresAtMs (the next game
--     day's start)}. A sale bought back keeps its place among the 10, as public.buy_back counts it.
-- Every other key is unchanged. create or replace keeps the grants; the WITH clause restates security_invoker.
create or replace view public.owner_state with (security_invoker=true) as
select g.owner_id,jsonb_build_object(
  'gladiatorId',g.id,'name',g.name,'appearance',g.appearance,'currentBuild',b.current_build,'pendingBuild',b.pending_build,'buildVersion',b.version,
  'schedule',s.schedule,'scheduleVersion',s.version,'wallets',jsonb_build_object('money',w.money,'renown',w.renown),
  'reservedFees',jsonb_build_object('money',coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0),
    'renown',coalesce((select sum(r.renown) from public.reservations r where r.gladiator_id=g.id and r.status='held'),0)),
  'inventory',coalesce((select jsonb_agg(i.item order by i.id) from public.item_instances i where i.gladiator_id=g.id),'[]'::jsonb),'inventoryCapacity',60,
  'buyBack',coalesce((select jsonb_agg(jsonb_build_object('saleId',x.id,'item',x.item,'price',x.price,'soldAtMs',x.sold_at_ms,
      'expiresAtMs',x.sold_at_ms-x.sold_at_ms%14400000+14400000) order by x.id desc)
    from (select n.id,n.item,n.price,n.sold_at_ms,n.bought_back_at_ms from public.npc_sales n where n.gladiator_id=g.id
      and n.sold_at_ms/14400000=floor(extract(epoch from statement_timestamp())*1000)::bigint/14400000 order by n.id desc limit 10) x
    where x.bought_back_at_ms is null),'[]'::jsonb),
  'ownedCosmetics',coalesce((select jsonb_agg(jsonb_build_object('catalogId',c.catalog_id,'catalogVersion',c.catalog_version,'binding',c.binding) order by c.catalog_id) from public.owned_cosmetics c where c.gladiator_id=g.id),'[]'::jsonb),
  'progression',jsonb_build_object('level',g.level,'xp',g.xp,'earnedAttributePoints',g.earned_points,'unspentAttributePoints',g.unspent_points,'league',g.league,'peakStrength',g.peak_strength,'rating',g.rating),
  'stamina',jsonb_build_object('current',g.stamina_current,'maximum',g.stamina_maximum),'tournamentOptIn',g.tournament_opt_in,'processedSlotIndex',g.processed_slot_index,
  'currentActivity',case when rest.gladiator_id is null then coalesce((select jsonb_build_object('id',a.id,'kind',coalesce(a.resolved_kind,a.requested->>'kind'),
      'status',case when a.status='completed' then 'completed' when a.status='preparing' then 'queued'
        when extract(epoch from statement_timestamp())*1000<a.ends_at_ms then 'active' else 'processing' end,
      'startsAtMs',a.starts_at_ms,'endsAtMs',a.ends_at_ms,
      'label',case coalesce(a.resolved_kind,a.requested->>'kind') when 'training' then 'Training'
        when 'rest' then case when a.fallback then 'Resting (not enough stamina)' else 'Resting' end
        when 'expedition' then 'Expedition' when 'dungeon' then 'Dungeon' when 'arena' then 'Arena' else 'Tournament' end)
    from public.activities a where a.gladiator_id=g.id order by a.slot_index desc limit 1),
    jsonb_build_object('id',g.id,'kind','orientation','status',case when extract(epoch from statement_timestamp())*1000<g.orientation_end_ms then 'active' else 'processing' end,
      'startsAtMs',g.created_at_ms,'endsAtMs',g.orientation_end_ms,'label','Orientation')) end,
  'restingUntilSlot',case when rest.signalled_at_ms is not null then rest.through_slot+1 end,
  'wornTitle',g.worn_title,
  'titles',coalesce((select jsonb_agg(jsonb_build_object('id',t.title_id,'earnedAtMs',t.earned_at_ms,'activityId',t.activity_id,
      'source',t.source,'detail',t.detail) order by t.earned_at_ms,t.title_id)
    from public.gladiator_titles t where t.gladiator_id=g.id),'[]'::jsonb),
  'titleProgress',coalesce((select jsonb_object_agg(c.counter,c.value) from public.title_counters c where c.gladiator_id=g.id),'{}'::jsonb)
    ||jsonb_build_object('gold-earned',
      coalesce((select c.value from public.title_counters c where c.gladiator_id=g.id and c.counter='gold-v2'),0)
      +coalesce((select c.value from public.title_counters c where c.gladiator_id=g.id and c.counter='gold-v1'),0)/4,
      'days-in-camp',(floor(extract(epoch from statement_timestamp())*1000)::bigint-g.created_at_ms)/86400000),
  'inbox',jsonb_build_object(
    'unread',(select count(*) from public.game_messages m where not m.hidden and m.published_at_ms>g.created_at_ms
      and (m.recipient_id is null or m.recipient_id=g.owner_id)
      and not exists(select 1 from public.message_reads r where r.owner_id=g.owner_id and r.message_id=m.id)),
    'readIds',coalesce((select jsonb_agg(r.message_id order by r.message_id) from public.message_reads r
      join public.game_messages m on m.id=r.message_id and not m.hidden where r.owner_id=g.owner_id),'[]'::jsonb),
    'sinceMs',g.created_at_ms,
    'newNotifications',(select count(*) from public.activities a where a.gladiator_id=g.id and a.status='completed'
      and a.resolved_kind in ('training','expedition','arena','tournament','dungeon') and a.summary is not null and a.settled_at_ms is not null
      and a.settled_at_ms<=floor(extract(epoch from statement_timestamp())*1000)::bigint
      and a.settled_at_ms>greatest(coalesce(nm.seen_ms,0),g.created_at_ms))
      +(select count(*) from (select distinct t.source,t.earned_at_ms from public.gladiator_titles t where t.gladiator_id=g.id
        and t.activity_id is null and t.source<>'joined' and t.earned_at_ms>greatest(coalesce(nm.seen_ms,0),g.created_at_ms)) n),
    'notificationsSeenMs',greatest(coalesce(nm.seen_ms,0),g.created_at_ms))) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id
  left join public.character_rests rest on rest.gladiator_id=g.id and rest.since_slot<=g.processed_slot_index and g.processed_slot_index<=rest.through_slot
  left join public.notification_marks nm on nm.owner_id=g.owner_id;

notify pgrst, 'reload schema';
commit;
