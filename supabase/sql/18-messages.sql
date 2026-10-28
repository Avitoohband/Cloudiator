-- Game messages and fixed class and points (2026-10-28) reapplicable source. Committed M01-M24 are immutable; deploy only the
-- separately generated migration M25 (supabase/migrations/*_messages.sql). Spec:
-- docs/superpowers/specs/2026-10-27-game-messages-design.md ("Added 2026-10-28: fixed class and points"); plan: the next
-- patch's messages plan, Task 1. Later tasks add the message sections below this one.
--
-- 1. private.planning_command: 16-launch-feedback.sql's body, plus in the queue-build branch
--    - a class change is `invalid`: the command's classId must equal the CURRENT build's (b.current_build->>'classId');
--    - taking a point back is `invalid`: no attribute of the command's allocation may be below the CURRENT build's value.
--      The floor is the current build, not the pending one: points become fixed when a build takes effect, so a pending build
--      can still be revised down to the current values (not below) and cancelled. Stance, equipment and more points stay free;
--    - the fee rule is `fee<>0` -> `invalid` (it was `fee not in (0,100,200)`): no build change costs gold any more, because
--      respec and class changes are gone until they return as paid, real-money options (nothing of that is built here).
--    The Edge preparation refuses the same two changes first (lockedChange in supabase/functions/_shared/domain/build.ts, used by
--      prepareBuild), so SQL's check is the database's own guarantee. Builds already pending at deploy keep their fee and class
--      and apply as queued (private.apply_pending_build is unchanged and reads the held reservation); a replay of a committed
--      operation is answered from its receipt before any of this, so it is unchanged.
--
--    Section 1 changes the rules in place in v1 (docs/operations/runbook.md, "Retained-rule deployments"): no executor of a job in
--    flight reads the fee or the class.
-- 2. public.change_appearance: the free, unlimited look change of the caller's own gladiator (Task 2; described at its function).
-- 3. Game messages and read marks (Task 3; spec "Settled from the code map" and "Decisions": Storage, Posting, Unread; the owner
--    read's inbox). Messages are public text in an OPEN table, read marks are the owner's; described at each statement below:
--    private.valid_message_body, public.game_messages (RLS: visible rows only; the deferred projection_changed trigger), public.message_reads
--    (owner-only), public.read_message (service_role only, no receipt), the operator-only private.post_message and
--    private.hide_message, and public.owner_state restated from 17-appearance.sql with `inbox`.
-- 4. Notifications (Task 3b; spec "Added 2026-10-28: notifications"). What a player's own settled activities earned is read from the
--    activities the owner already reads, so nothing is stored per result; the one new thing is each account's "seen up to" time:
--    public.notification_marks (owner-only), public.see_notifications (service_role only, no receipt), and public.owner_state
--    restated once more (the last statement stands) with `inbox.newNotifications` and `inbox.notificationsSeenMs`.
--
-- Every statement is reapplicable.
begin;

-- Lock order and clock as 02-build-schedule.sql: account lock, receipt, character row, then builds, schedules, wallet and
-- items; private.planning_now_ms() sampled after the character lock. Restated from 16-launch-feedback.sql with the queue-build
-- change marked "Fixed class and points" and nothing else.
create or replace function private.planning_command(actor_id uuid, operation_id uuid, input jsonb, kind text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prep jsonb:=input->'prepared'; prior public.operation_receipts%rowtype;
  g public.gladiators%rowtype; b public.builds%rowtype; s public.schedules%rowtype;
  now_ms bigint; slot bigint; receipt uuid:=gen_random_uuid(); result jsonb; err text; fee bigint; available bigint;
  inventory jsonb; ids jsonb; next_build jsonb; effective bigint; next_version bigint; required_level integer;
  part record; parts jsonb; next_schedule jsonb;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=planning_command.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if c->>'kind' is distinct from kind or c->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(c->'expectedVersion') is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (c->>'expectedVersion')::numeric not between 1 and 9007199254740991 or trunc((c->>'expectedVersion')::numeric)<>(c->>'expectedVersion')::numeric
    then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms(); slot:=now_ms/4800000;
  -- A transient processing result is not retained: this exact operation may succeed after catch-up.
  if g.processed_slot_index<slot then return jsonb_build_object('ok',false,'code','processing','retryAfterMs',1000); end if;
  select * into b from public.builds where gladiator_id=g.id for update;
  select * into s from public.schedules where gladiator_id=g.id for update;
  perform 1 from public.wallets where gladiator_id=g.id for update;
  perform 1 from public.item_instances where gladiator_id=g.id order by id for update;
  if (c->>'expectedVersion')::bigint <> (case when kind in ('edit-schedule','edit-day-schedule') then s.version else b.version end) then err:='conflict';
  elsif kind='edit-schedule' then
    if (select count(*) from jsonb_object_keys(c))<>5 or not(c ?& array['kind','operationId','expectedVersion','phase','choice'])
      or c->>'phase' is null or c->>'phase' not in ('morning','afternoon','evening') or jsonb_typeof(c->'choice') is distinct from 'object' then err:='invalid';
    -- Arena only in the evening (RULES_V1.schedule.arenaPhases).
    elsif c->'choice'->>'kind'='arena' and c->>'phase'<>'evening' then err:='invalid';
    elsif c->'choice'->>'kind' in ('rest','training','arena') and (select count(*) from jsonb_object_keys(c->'choice'))=1 then null;
    elsif c->'choice'->>'kind'='expedition' and (select count(*) from jsonb_object_keys(c->'choice'))=2 and c->'choice' ? 'expeditionId' then
      required_level:=case c->'choice'->>'expeditionId' when 'woodland' then 1 when 'outpost' then 5 when 'mountain' then 10 else null end;
      if required_level is null or g.level<required_level then err:='invalid'; end if;
    else err:='invalid'; end if;
    if err is null then
      effective:=private.schedule_effective_slot(c->>'phase',now_ms); next_version:=s.version+1;
      update public.schedules set version=next_version,schedule=jsonb_set(schedule,array[c->>'phase'],c->'choice') where gladiator_id=g.id;
      insert into public.schedule_revisions values(g.id,next_version,c->>'phase',c->'choice',now_ms,effective);
      result:=jsonb_build_object('version',next_version,'receivedAtMs',now_ms,'effectiveSlotIndex',effective,'effectiveAtMs',effective*4800000);
    end if;
  elsif kind='edit-day-schedule' then
    if (select count(*) from jsonb_object_keys(c))<>4 or not(c ?& array['kind','operationId','expectedVersion','day'])
      or jsonb_typeof(c->'day') is distinct from 'object' then err:='invalid';
    elsif (select count(*) from jsonb_object_keys(c->'day'))<>3 or not(c->'day' ?& array['morning','afternoon','evening']) then err:='invalid';
    else
      -- Each part's choice exactly as edit-schedule checks one; any refused part refuses the whole day.
      for part in select e.key as phase,e.value as choice from jsonb_each(c->'day') e loop
        if jsonb_typeof(part.choice) is distinct from 'object' then err:='invalid';
        elsif part.choice->>'kind'='arena' and part.phase<>'evening' then err:='invalid';
        elsif part.choice->>'kind' in ('rest','training','arena') and (select count(*) from jsonb_object_keys(part.choice))=1 then null;
        elsif part.choice->>'kind'='expedition' and (select count(*) from jsonb_object_keys(part.choice))=2 and part.choice ? 'expeditionId' then
          required_level:=case part.choice->>'expeditionId' when 'woodland' then 1 when 'outpost' then 5 when 'mountain' then 10 else null end;
          if required_level is null or g.level<required_level then err:='invalid'; end if;
        else err:='invalid'; end if;
      end loop;
      -- A day with no change is invalid (values are compared, not their key order).
      if err is null and not exists(select 1 from jsonb_each(c->'day') e where e.value is distinct from s.schedule->e.key) then err:='invalid'; end if;
    end if;
    if err is null then
      -- One version for the day; a revision, at its own next occurrence, only for each part whose choice changes.
      next_version:=s.version+1; next_schedule:=s.schedule; parts:='{}'::jsonb;
      for part in select p.phase,c->'day'->p.phase as choice from unnest(array['morning','afternoon','evening']) with ordinality p(phase,n) order by p.n loop
        if part.choice is distinct from s.schedule->part.phase then
          effective:=private.schedule_effective_slot(part.phase,now_ms);
          next_schedule:=jsonb_set(next_schedule,array[part.phase],part.choice);
          insert into public.schedule_revisions values(g.id,next_version,part.phase,part.choice,now_ms,effective);
          parts:=parts||jsonb_build_object(part.phase,jsonb_build_object('effectiveSlotIndex',effective,'effectiveAtMs',effective*4800000));
        else
          parts:=parts||jsonb_build_object(part.phase,null);
        end if;
      end loop;
      update public.schedules set version=next_version,schedule=next_schedule where gladiator_id=g.id;
      result:=jsonb_build_object('version',next_version,'receivedAtMs',now_ms,'parts',parts);
    end if;
  elsif kind='queue-build' then
    if prep is null or prep='null'::jsonb then err:='invalid';
    else
      select coalesce(jsonb_agg(item order by id),'[]'::jsonb) into inventory from public.item_instances where gladiator_id=g.id;
      if prep->'baseline' is distinct from jsonb_build_object('currentBuild',b.current_build,'pendingBuild',b.pending_build,'buildVersion',b.version,
        'earnedPoints',g.earned_points,'level',g.level,'inventory',inventory) then err:='conflict';
      else
        fee:=(prep->>'fee')::bigint;
        select w.money-coalesce((select sum(r.money) from public.reservations r where r.gladiator_id=g.id and r.status='held'
          and r.operation_id is distinct from (b.pending_build->>'operationId')::uuid),0) into available from public.wallets w where w.gladiator_id=g.id;
        -- Fixed class and points: the class and every attribute are compared to the CURRENT build (b.current_build), never to the
        -- pending one, so a pending build may still be revised down to the current values (not below) and cancelled.
        if c->>'classId' is distinct from b.current_build->>'classId'
          or exists(select 1 from jsonb_each(b.current_build->'allocations') a where coalesce((c->'allocation'->a.key)<a.value,true)) then err:='invalid';
        -- No build change costs gold any more (it was fee not in (0,100,200)).
        elsif fee<>0 then err:='invalid';
        elsif available<fee then err:='insufficient-funds'; end if;
      end if;
    end if;
    if err is null then
      next_version:=b.version+1; effective:=slot+1;
      next_build:=jsonb_build_object('version',next_version,'classId',c->'classId','stance',c->'stance','allocations',c->'allocation','equipment',c->'equipment');
      select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into ids from jsonb_each(c->'equipment') where value<>'null'::jsonb;
      update public.reservations r set status='refunded' where r.gladiator_id=g.id and r.operation_id=(b.pending_build->>'operationId')::uuid and r.status='held';
      delete from public.pending_build_items where gladiator_id=g.id;
      update public.item_instances set item=jsonb_set(item,'{reservation}','null') where gladiator_id=g.id and item->'reservation'->>'kind'='pending-build';
      insert into public.reservations(gladiator_id,operation_id,money,status) values(g.id,planning_command.operation_id,fee,'held');
      insert into public.pending_build_items select value::text::uuid,g.id,planning_command.operation_id from jsonb_array_elements_text(ids);
      update public.item_instances set item=jsonb_set(item,'{reservation}',jsonb_build_object('kind','pending-build','referenceId',planning_command.operation_id))
        where gladiator_id=g.id and id in (select item_id from public.pending_build_items where gladiator_id=g.id) and item->'reservation'='null'::jsonb;
      result:=jsonb_build_object('build',next_build,'effectiveSlotIndex',effective,'reservedMoney',fee,'reservedItemIds',ids,'operationId',operation_id);
      update public.builds set version=next_version,pending_build=result where gladiator_id=g.id;
      insert into private.pending_build_preparations values(g.id,operation_id,prep->'snapshot',(prep->>'staminaMaximum')::bigint,now_ms)
        on conflict(gladiator_id) do update set operation_id=excluded.operation_id,snapshot=excluded.snapshot,stamina_maximum=excluded.stamina_maximum,received_at_ms=excluded.received_at_ms;
    end if;
  elsif kind='cancel-build' then
    if (select count(*) from jsonb_object_keys(c))<>3 then err:='invalid';
    else
      update public.reservations r set status='refunded' where r.gladiator_id=g.id and r.operation_id=(b.pending_build->>'operationId')::uuid and r.status='held';
      delete from public.pending_build_items where gladiator_id=g.id;
      update public.item_instances set item=jsonb_set(item,'{reservation}','null') where gladiator_id=g.id and item->'reservation'->>'kind'='pending-build';
      delete from private.pending_build_preparations where gladiator_id=g.id;
      update public.builds set version=version+1,pending_build=null where gladiator_id=g.id;
      result:=jsonb_build_object('buildVersion',b.version+1);
    end if;
  else err:='invalid'; end if;
  result:=case when err is null then jsonb_build_object('ok',true,'receiptId',receipt,'value',result) else jsonb_build_object('ok',false,'code',err) end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  return result;
end $$;

revoke all on function private.planning_command(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function private.planning_command(uuid,uuid,jsonb,text) to service_role;

-- 2. public.change_appearance(actor_id, operation_id, input): the free, unlimited look change of the caller's own gladiator
--    (spec Goal 4, "Change look command"). Shaped like public.set_tournament_opt_in (09-tournaments.sql): the account lock, the
--    receipt replay (a replay returns the stored result, the same operation with another body is `conflict`, both before any shape
--    check), the command's exact keys (`appearance`, `kind`, `operationId`), `private.valid_appearance` (17-appearance.sql: the same
--    look rules as creation; an invalid look is `invalid` and writes no receipt), the caller's own gladiator `for update`
--    (`not-found` for an account without one: the command names no gladiator, so no other can change), the update only when the
--    look differs, then the receipt. A legacy gladiator (appearance null) is changed like any other. The update fires the deferred
--    project_changed_character trigger (06-projections.sql), which republishes the world actor and raises the world revision; an
--    unchanged look updates nothing, so it publishes nothing. There is no count or cooldown: the Edge command rate limit is the
--    only limit. Unlike the opt-in it never answers `processing`: a look does not depend on the world clock.
--    Result: {ok:true, receiptId, value:{appearance, receivedAtMs}}. Backend only (EXECUTE for service_role).
create or replace function public.change_appearance(actor_id uuid, operation_id uuid, input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prior public.operation_receipts%rowtype; g public.gladiators%rowtype; now_ms bigint;
  receipt uuid:=gen_random_uuid(); result jsonb;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=change_appearance.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['appearance','kind','operationId']
    or c->>'kind' is distinct from 'change-appearance' or c->>'operationId' is distinct from operation_id::text
    or not private.valid_appearance(c->'appearance') then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms();
  update public.gladiators set appearance=c->'appearance' where id=g.id and appearance is distinct from c->'appearance';
  result:=jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('appearance',c->'appearance','receivedAtMs',now_ms));
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  return result;
end $$;

revoke all on function public.change_appearance(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.change_appearance(uuid,uuid,jsonb) to service_role;

-- 3. Game messages and read marks.
--
-- Messages are broadcast text, public on purpose: patch notes and notes from the admin are not secret, and a broadcast row carries no
-- owner id. The table therefore joins the access matrix's OPEN list (tests/fixtures/access.ts): anon and authenticated may SELECT the
-- visible rows only (the policy `not hidden`); nobody writes through the Data API. The operator posts and hides as postgres through
-- private.post_message and private.hide_message (no client role and not service_role may execute them; run with the linked CLI after
-- Avi's go, like cleanup_history and health_report). `kind` is patch-notes or admin; the only action is change-look. The title is
-- 1-80 characters, the preview 1-140, the body 1-20 blocks, each exactly {"p": text} or {"li": text} with non-blank text, at most 2,000
-- characters in all. The text is stored as data and rendered as plain text; nothing here builds markup from it.
-- Any change to the table (a post, a hide) raises the world revision through the deferred projection_changed trigger, so badges update
-- within one poll. Read marks do not: a mark changes nothing public, and the client re-reads its own owner state at once.
--
-- The body rules are SQL's alone (messages are written only by the operator, never by the Edge parser). The function comes before the
-- table whose CHECK calls it (AGENTS.md, M24 lesson). It answers false, never null, for anything else; the CASE keeps each test behind
-- the one before it, because SQL does not promise the order of OR terms (jsonb_object_keys fails on a scalar).
create or replace function private.valid_message_body(body jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(case
    when jsonb_typeof(body) is distinct from 'array' then false
    when jsonb_array_length(body) not between 1 and 20 then false
    else not exists(select 1 from jsonb_array_elements(body) b(block) where not case
        when jsonb_typeof(b.block) is distinct from 'object' then false
        when (select count(*) from jsonb_object_keys(b.block))<>1 then false
        when not (b.block ?| array['p','li']) then false
        when jsonb_typeof(coalesce(b.block->'p',b.block->'li')) is distinct from 'string' then false
        else coalesce(b.block->>'p',b.block->>'li') ~ '[^[:space:]]' end)
      and (select coalesce(sum(char_length(coalesce(b.block->>'p',b.block->>'li'))),0) from jsonb_array_elements(body) b(block))<=2000
  end,false)
$$;

create table if not exists public.game_messages (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('patch-notes','admin')),
  title text not null check (char_length(title) between 1 and 80 and title ~ '[^[:space:]]'),
  preview text not null check (char_length(preview) between 1 and 140 and preview ~ '[^[:space:]]'),
  body jsonb not null check (private.valid_message_body(body)),
  action text check (action is null or action='change-look'),
  published_at_ms bigint not null check (published_at_ms>=0),
  hidden boolean not null default false
);
alter table public.game_messages enable row level security;
revoke all on public.game_messages from public,anon,authenticated,service_role;
-- service_role only reads it: public.read_message looks a message up, and the owner read (owner_state, an invoker view the backend
-- also reads) counts them. It bypasses row security, so both restate `not hidden` themselves.
grant select on public.game_messages to anon,authenticated,service_role;
drop policy if exists player_read on public.game_messages;
create policy player_read on public.game_messages for select to anon,authenticated using (not hidden);
-- The identity sequence is the owner's alone: an insert by the operator needs no grant on it, and service_role has no use for it
-- (the platform's default would give it UPDATE).
revoke all on sequence public.game_messages_id_seq from public,anon,authenticated,service_role;
drop trigger if exists projection_changed on public.game_messages;
create constraint trigger projection_changed after insert or update or delete on public.game_messages
  deferrable initially deferred for each row execute function private.projection_changed();

-- One row per account and message read: the owner's own, like every owner-only relation (01-identity.sql's recipe). The account's
-- marks go with the account; they go with the message too (the operator hides a message, it never deletes one). Only service_role
-- writes them, through public.read_message (no UPDATE or DELETE: a mark is never changed). The first read time is kept.
create table if not exists public.message_reads (
  owner_id uuid not null references auth.users(id) on delete cascade,
  message_id bigint not null references public.game_messages(id) on delete cascade,
  read_at_ms bigint not null check (read_at_ms>=0),
  primary key (owner_id,message_id)
);
alter table public.message_reads enable row level security;
revoke all on public.message_reads from public,anon,authenticated,service_role;
grant select on public.message_reads to authenticated;
grant select,insert on public.message_reads to service_role;
drop policy if exists owner_read on public.message_reads;
create policy owner_read on public.message_reads for select to authenticated using (owner_id=(select auth.uid()));

-- public.read_message(actor_id, message_id): marks a visible message read for the caller's own account (the Edge function passes the
-- verified account; the command names no other). A repeat is a no-op that keeps the first read time. A hidden or missing message is
-- `not-found` (service_role bypasses row security, so `not hidden` is checked here). It writes no receipt: receipts are permanent
-- (private.guard_receipt), and one per opened message would pile up; `presence` is the precedent for a command with no receipt. An
-- account with no gladiator may hold a mark (it only changes that account's own reads).
-- Result: {ok:true, value:{messageId}} | {ok:false, code:'not-found'|'unauthenticated'}. Backend only (EXECUTE for service_role).
create or replace function public.read_message(actor_id uuid, message_id bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if message_id is null or not exists(select 1 from public.game_messages m where m.id=read_message.message_id and not m.hidden) then
    return jsonb_build_object('ok',false,'code','not-found');
  end if;
  insert into public.message_reads(owner_id,message_id,read_at_ms)
    values(actor_id,read_message.message_id,floor(extract(epoch from clock_timestamp())*1000)::bigint) on conflict do nothing;
  return jsonb_build_object('ok',true,'value',jsonb_build_object('messageId',read_message.message_id));
end $$;

-- Operator-only: post a message (the id of the new row), stamped with the time of posting (never back-dated), and hide one that was a
-- mistake (true when it was visible, false when it was already hidden or does not exist). A hidden message stays stored; its read
-- marks stay too and no longer count. The table's constraints refuse a bad kind, title, preview, action or body (23514).
create or replace function private.post_message(kind text, title text, preview text, body jsonb, action text default null) returns bigint
language plpgsql security invoker set search_path='' as $$
declare posted bigint;
begin
  insert into public.game_messages(kind,title,preview,body,action,published_at_ms)
    values(post_message.kind,post_message.title,post_message.preview,post_message.body,post_message.action,floor(extract(epoch from clock_timestamp())*1000)::bigint)
    returning id into posted;
  return posted;
end $$;
create or replace function private.hide_message(message_id bigint) returns boolean
language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  update public.game_messages set hidden=true where id=hide_message.message_id and not hidden;
  get diagnostics changed=row_count;
  return changed>0;
end $$;

-- A new function is executable by PUBLIC by default. The three private ones are operator-only (the owner always keeps EXECUTE): not
-- even service_role, which never writes this table, needs the body function for its CHECK. read_message is the backend's.
revoke all on function private.valid_message_body(jsonb), private.post_message(text,text,text,jsonb,text), private.hide_message(bigint)
  from public,anon,authenticated,service_role;
revoke all on function public.read_message(uuid,bigint) from public,anon,authenticated;
grant execute on function public.read_message(uuid,bigint) to service_role;

-- public.owner_state: 17-appearance.sql's owner view plus `inbox`: how many visible messages were published after the gladiator was
-- created and are unread by the account (`unread`), the ids of the visible messages it has read (`readIds`, ascending) and the
-- gladiator's creation time (`sinceMs`, which the client lists older messages as already read by). Older messages stay listed but
-- never count, so a new player starts at no badge. The view is an invoker view and the backend (service_role) reads it too, past row
-- security, so it filters by the account and by `not hidden` itself rather than rely on the policies. create or replace keeps the
-- grants; the WITH clause restates security_invoker (it replaces a view's options with the ones it names). Section 4 restates this
-- view once more, with the notification keys (it needs the marks table, which comes after the messages tables): the last stands.
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
  'restingUntilSlot',case when rest.signalled_at_ms is not null then rest.through_slot+1 end,
  'inbox',jsonb_build_object(
    'unread',(select count(*) from public.game_messages m where not m.hidden and m.published_at_ms>g.created_at_ms
      and not exists(select 1 from public.message_reads r where r.owner_id=g.owner_id and r.message_id=m.id)),
    'readIds',coalesce((select jsonb_agg(r.message_id order by r.message_id) from public.message_reads r
      join public.game_messages m on m.id=r.message_id and not m.hidden where r.owner_id=g.owner_id),'[]'::jsonb),
    'sinceMs',g.created_at_ms)) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id
  left join public.character_rests rest on rest.gladiator_id=g.id and rest.since_slot<=g.processed_slot_index and g.processed_slot_index<=rest.through_slot;

-- 4. Notifications.
--
-- A notification is one of the owner's own settled activities (training, expedition, Arena or tournament; a rest earns nothing and is
-- left out): its credited summary is already owner-only under row security on public.activities and is what the result screens show,
-- so nothing is stored per result. "New" is relative to one "seen up to" time per account, held here so every device agrees. It is
-- the owner's own, like the read marks (01-identity.sql's recipe): RLS on, SELECT for authenticated through the auth.uid() policy, and
-- only service_role writes it, through public.see_notifications (INSERT and UPDATE: unlike a read mark, a mark moves on; never DELETE,
-- the account's removal cascades). The account's mark goes with the account.
create table if not exists public.notification_marks (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  seen_ms bigint not null check (seen_ms>=0)
);
alter table public.notification_marks enable row level security;
revoke all on public.notification_marks from public,anon,authenticated,service_role;
grant select on public.notification_marks to authenticated;
grant select,insert,update on public.notification_marks to service_role;
drop policy if exists owner_read on public.notification_marks;
create policy owner_read on public.notification_marks for select to authenticated using (owner_id=(select auth.uid()));

-- public.see_notifications(actor_id, up_to_ms): the caller's own account has seen its results up to a time (the Edge function passes
-- the verified account; the command names no other). The stored mark is greatest(old, least(up_to_ms, now)): a lower time never moves
-- it back, and a future one is cut to the database's now, so a result that settles later is never seen in advance. The answer is the
-- mark as it stands (`seenMs`). A bad time (null or negative) is `invalid`, a missing account `unauthenticated`. It writes no receipt
-- (receipts are permanent, and one per opening would pile up; `presence` and read_message are the precedent) and changes nothing
-- public, so the world revision does not move: the client re-reads its own owner state at once. An account with no gladiator may hold
-- a mark (it only changes that account's own reads). Backend only (EXECUTE for service_role).
-- Result: {ok:true, value:{seenMs}} | {ok:false, code:'invalid'|'unauthenticated'}.
create or replace function public.see_notifications(actor_id uuid, up_to_ms bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare now_ms bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint; stored bigint;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if up_to_ms is null or up_to_ms<0 then return jsonb_build_object('ok',false,'code','invalid'); end if;
  insert into public.notification_marks as m(owner_id,seen_ms) values(actor_id,least(up_to_ms,now_ms))
    on conflict (owner_id) do update set seen_ms=greatest(m.seen_ms,excluded.seen_ms) returning m.seen_ms into stored;
  return jsonb_build_object('ok',true,'value',jsonb_build_object('seenMs',stored));
end $$;

revoke all on function public.see_notifications(uuid,bigint) from public,anon,authenticated;
grant execute on function public.see_notifications(uuid,bigint) to service_role;

-- public.owner_state: section 3's view plus two keys of `inbox`, and nothing else changed:
--   notificationsSeenMs  the later of the account's mark and the gladiator's creation (a new gladiator has no results before it, and a
--                        mark below it counts the same as none);
--   newNotifications     how many of the gladiator's results are new: completed, with a summary, of a kind that earns something (not a
--                        rest), revealed (settled at or before the database's now, the timeline's own rule: an Arena or tournament
--                        result is not counted before it is due) and settled strictly after notificationsSeenMs.
-- It is the same rule readNotifications (src/lib/api/reads.ts) lists by. Like the rest of the view it filters by the account itself
-- (the join on the marks and the owner's own gladiator), because the backend (service_role) reads it past row security.
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
  'restingUntilSlot',case when rest.signalled_at_ms is not null then rest.through_slot+1 end,
  'inbox',jsonb_build_object(
    'unread',(select count(*) from public.game_messages m where not m.hidden and m.published_at_ms>g.created_at_ms
      and not exists(select 1 from public.message_reads r where r.owner_id=g.owner_id and r.message_id=m.id)),
    'readIds',coalesce((select jsonb_agg(r.message_id order by r.message_id) from public.message_reads r
      join public.game_messages m on m.id=r.message_id and not m.hidden where r.owner_id=g.owner_id),'[]'::jsonb),
    'sinceMs',g.created_at_ms,
    'newNotifications',(select count(*) from public.activities a where a.gladiator_id=g.id and a.status='completed'
      and a.resolved_kind in ('training','expedition','arena','tournament') and a.summary is not null and a.settled_at_ms is not null
      and a.settled_at_ms<=floor(extract(epoch from statement_timestamp())*1000)::bigint
      and a.settled_at_ms>greatest(coalesce(nm.seen_ms,0),g.created_at_ms)),
    'notificationsSeenMs',greatest(coalesce(nm.seen_ms,0),g.created_at_ms))) as state
from public.gladiators g join public.builds b on b.gladiator_id=g.id join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id
  left join public.character_rests rest on rest.gladiator_id=g.id and rest.since_slot<=g.processed_slot_index and g.processed_slot_index<=rest.through_slot
  left join public.notification_marks nm on nm.owner_id=g.owner_id;

notify pgrst,'reload schema';
commit;
