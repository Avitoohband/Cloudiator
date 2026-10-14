-- Task 19 phase 2b reapplicable source. Committed M01-M11 are immutable; deploy only the separately generated migration.
-- League tournaments end to end: the fenced acceptance of each bout's result (the final's with every entrant's outcome),
-- one reveal job per fought bout publishing both entrants' bout stages and the public result, each entrant's settlement
-- at minute 80 from its own frozen outcome under its own account lock, and the public tournament projection. Also the
-- Task 16 phase-8 lock-order fix (exception 1). Builds on 08-arena-bouts.sql and 09-tournaments.sql.
-- Shared lock order (Tasks 4/6/7/9/16/19): coordinator row, account advisory hashtextextended(owner,0), gladiator row, then
-- dependent rows (wallet, sorted items, the entrant's own rating row), activities, jobs; projection rows last. Database
-- time is private.planning_now_ms(), sampled after the guard locks.
--
-- Accepted exceptions:
-- 1. Phase 8 takes every member's account lock, in gladiator order, before any debit or job insert (private.boundary_start).
--    A member's jobs can reference another member's rows: Task 16's one simulation job per Arena battle is anchored to side
--    0 and created by whichever side phase 8 reaches first. Its foreign keys take KEY SHARE locks on side 0's gladiator and
--    activity rows. Before this fix they were taken before the boundary held side 0's account lock, so an owner command of
--    side 0 holding that lock and then asking for its gladiator row FOR UPDATE deadlocked with the boundary (40P01, the
--    regression in tests/db/arena.test.ts). Now the boundary waits for that account lock before any such KEY SHARE, and a
--    command holding it waits for nothing the boundary holds. The order of the locks is unchanged; only their timing moved.
-- 2. The result fence trusts canonical TypeScript amounts, as Task 16's acceptance does. private.accept_tournament_result
--    checks a bout's exact result shape and its log against the frozen entries: battle id = bout id, the graph's rules
--    version, the two entrants in order (round-one placement, otherwise the parents' stored winners), each participant's
--    id, gladiatorId, frozen name and frozen fighter values (class, stance, attributes, maximum health, initialHealth =
--    maximum, armor, weapon damage, interval, silhouettes), and a winner that is one of them and agrees with the victory
--    event (including a 0 HP tie-break). The worker's recordBout runs the full fence (efficiency included) before
--    completing. The final's outcomes (private.valid_tournament_outcomes) are checked for exact shapes, identity in rank
--    order, the frozen rating before, after = before + delta, one champion (the logged winner) with place 1, each entrant's
--    bouts equal to its stored byes, wins and losses, the counters, renown = fight renown + placement renown, the delta =
--    the sum of its bout deltas, zero XP/points/items/overflow, and a well-formed placement grant carrying the outcome's
--    place and money. SQL restates neither the placement amounts, the fight renown nor Elo.
-- 3. Stored outcomes (Task 16's route). The final's acceptance freezes every entrant's outcome once in
--    private.tournament_results, with the final's result, in one transaction. Each entrant settles from its own outcome:
--    no prepared settlement RPC, and the placement bonus travels inside that activity's single settlement outcome.
-- 4. Reveals. One reveal job per fought bout, created with the bout jobs in the rank-1 entrant's own call (09 exception 4)
--    and anchored to it with its activity seed, due at the bout's stored reveal time. It depends on its bout's job and on
--    its fought parents' reveal jobs, so stages publish in round order. It writes both entrants' bout stages (stage ordinal
--    = round, labelled from each entrant's perspective, with the shared log) and the bout's public result. Its completion
--    locks the reveal job row; the stages' foreign keys then take KEY SHARE locks on both entrants' activity rows. No cycle:
--    an entrant's settlement, the only other writer of a published activity, waits on this reveal's completion through
--    its dependencies and locks no job row of another activity, and commands never lock activity rows. Shape decided here
--    (open from the phase 1 review): an eliminated entrant gets no stage after its losing bout until its minute-80 return;
--    a bye receiver gets none for its bye, which is public from the start through the bracket slots, so its staging stage
--    runs until its first fought bout's reveal (round two).
-- 5. Settlement dependencies: each entrant's settlement waits for the final's bout job and the final's reveal job only.
--    Every other bout and reveal is their ancestor, so this gates exactly as waiting on all of them did (2a review M2: no n²
--    dependency rows). Both exist only after the rank-1 entrant's call, so they are added from both sides: the rank-1 call
--    adds them for every entrant settlement created so far, each later entrant for its own (2a review M5a).
-- 6. Lock order of an entrant's settlement: account, character, wallet, sorted items, then its own league-season rating row
--    for the tournament's league and season (a dependent row of its character), activity and job; time is sampled after all
--    of them. An entrant never locks another entrant's account or rows, so entrants settle independently. It compares only
--    its own frozen rating with its own live row: earlier entrants have already moved their own rows. A mismatch (or a
--    missing outcome) goes straight to operator state with last_failure 'rating-mismatch' ('tournament-unsettled'), before
--    any grant or checkpoint, as Task 16 exception 6 does.
-- 7. Grant identity. The placement grant id <tournamentId>:placement:<gladiatorId> is recorded in the request of that
--    activity's one settlement receipt; one wallet_ledger row (reason 'tournament') combines placement money with fight
--    and placement renown. private.settled_slots remains the only grant guard: there is no placement grant table.
-- 8. Public projection (written by the backend, read through RLS): public.tournament_views holds one row per league and
--    tournament slot, published at phase 8 by private.boundary_published: a bracket's id, slot, times, entrants (frozen
--    names and classes), its size, rounds and seeded round-one slots, its bout shapes and reveal times; or, for a league
--    below the minimum on a tournament slot, an 'insufficient-entrants' row with its qualifiers (2a review M5b). SQL knows a
--    tournament slot without restating the days: a pairing job exists only with a resolved Arena entrant, and on a
--    tournament slot no regular-Arena route carries 'not-tournament-slot'. public.tournament_bout_results holds each due
--    result: a bye's at publication, due from the start (the slots already make it public); a fought bout's written by its
--    reveal job at its round's reveal time; RLS checks database time on every read. public.tournament_placements gets an entrant's place in its own settlement. No reward, receipt,
--    rating, rank, seed or snapshot is public; owners read their rewards from their own activity summary.
-- 9. Restated presentation and frame constants: stage ordinals (staging 0, a bout its round, the return rounds + 1), the
--    round labels (Final, Semifinal, Quarterfinal, Round r), the bout ordinal size - (size >> (round - 1)) + position, and
--    604800000 (RULES_V1.retention.replayMs, as in Tasks 9 and 16).
-- 10. Lock order of a bout completion: complete_job locks the bout job row; accept_tournament_result locks it again, updates
--    its own bout row (result only, no key column) and, for the final, inserts the outcomes row, whose foreign keys take
--    KEY SHARE on the tournament row and the job row it already holds. No account, gladiator or activity row is locked.
-- Inherited (Tasks 7/9/16/19): the exhausted-lease sweep may lock expired jobs before the coordinator row; 07's and 09's
-- pairing-completion lock orders are unchanged.
begin;

-- Exception 3: the final's accepted outcomes, one per entrant in rank order, frozen once.
create table if not exists private.tournament_results (
  tournament_id text primary key references private.tournaments(id),
  final_job_id uuid not null unique references private.jobs(id),
  outcomes jsonb not null check (jsonb_typeof(outcomes)='array'),
  created_at_ms bigint not null
);
alter table private.tournament_results enable row level security;
revoke all on private.tournament_results from public,anon,authenticated,service_role;
grant select,insert,delete on private.tournament_results to service_role;
drop policy if exists backend_only on private.tournament_results;
create policy backend_only on private.tournament_results to service_role using (true) with check (true);
drop trigger if exists guard_frozen on private.tournament_results;
create trigger guard_frozen before update on private.tournament_results for each row execute function private.guard_frozen();

-- Exception 8: the public tournament projection. A row references the pairing job that decided it (retention order).
create table if not exists public.tournament_views (
  id text primary key,
  pairing_job_id uuid not null unique references private.jobs(id),
  slot_index bigint not null check (slot_index >= 0),
  league text not null check (league in ('bronze','silver','gold','champion')),
  starts_at_ms bigint not null,
  ends_at_ms bigint not null,
  status text not null check (status in ('active','insufficient-entrants')),
  entrants jsonb not null check (jsonb_typeof(entrants)='array'),
  bracket jsonb check (bracket is null or jsonb_typeof(bracket)='object'),
  bouts jsonb not null check (jsonb_typeof(bouts)='array'),
  reveal_at_ms jsonb not null check (jsonb_typeof(reveal_at_ms)='array'),
  published_at_ms bigint not null,
  unique (slot_index,league),
  check (id='tournament:'||slot_index||':'||league),
  check ((status='active')=(bracket is not null))
);
create table if not exists public.tournament_bout_results (
  bout_id text primary key,
  tournament_id text not null references public.tournament_views(id),
  ordinal integer not null check (ordinal >= 0),
  round integer not null check (round >= 1),
  position integer not null check (position >= 0),
  reveal_at_ms bigint not null,
  result jsonb not null check (jsonb_typeof(result)='object'),
  unique (tournament_id,ordinal)
);
create table if not exists public.tournament_placements (
  tournament_id text not null references public.tournament_views(id),
  gladiator_id uuid not null references public.gladiators(id) on delete cascade,
  activity_id uuid not null unique references public.activities(id) on delete cascade,
  place integer not null check (place >= 1),
  primary key (tournament_id,gladiator_id)
);
create index if not exists tournament_placements_gladiator_idx on public.tournament_placements(gladiator_id);
do $$ declare t text; begin
  foreach t in array array['tournament_views','tournament_bout_results','tournament_placements'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant select,insert,delete on public.%I to service_role',t);
    execute format('drop policy if exists player_read on public.%I',t);
    if t='tournament_bout_results' then
      -- Real database clock, for every caller and every guessed id: a result is readable only once it is due.
      execute format('create policy player_read on public.%I for select to authenticated using(reveal_at_ms<=floor(extract(epoch from clock_timestamp())*1000)::bigint)',t);
    else
      execute format('create policy player_read on public.%I for select to authenticated using(true)',t);
    end if;
    execute format('drop trigger if exists guard_frozen on public.%I',t);
    execute format('create trigger guard_frozen before update on public.%I for each row execute function private.guard_frozen()',t);
    -- Task 10's deferred revision bump: a published tournament, result or placement changes the world revision.
    execute format('drop trigger if exists projection_changed on public.%I',t);
    execute format('create constraint trigger projection_changed after insert or update or delete on public.%I deferrable initially deferred for each row execute function private.projection_changed()',t);
  end loop;
end $$;

-- Phase 8 (Task 7, 03-activities-jobs.sql), with every member's account lock taken in gladiator order before any debit or
-- job insert (exception 1).
create or replace function private.boundary_start(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare a record; now_ms bigint:=private.planning_now_ms();
begin
  -- Check every member before any debit so an unsupported executor never leaves a partially started slot.
  if exists(select 1 from public.activities x where x.slot_index=target and x.status='preparing' and not private.activity_executor_ready(x.resolved_kind)) then
    return 'integration';
  end if;
  -- Exception 1: a member's jobs can reference another member's rows (an Arena battle job is anchored to side 0, whichever
  -- side comes first), so every account lock is held before the first such foreign key takes KEY SHARE on those rows.
  for a in select bm.owner_id from public.activities x
    join private.boundary_members bm on bm.slot_index=target and bm.gladiator_id=x.gladiator_id
    where x.slot_index=target and x.status='preparing' order by x.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,0));
  end loop;
  for a in select x.id,x.gladiator_id,x.stamina_debit,x.debited,bm.owner_id from public.activities x
    join private.boundary_members bm on bm.slot_index=target and bm.gladiator_id=x.gladiator_id
    where x.slot_index=target and x.status='preparing' order by x.gladiator_id loop
    perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,0));
    perform 1 from public.gladiators where id=a.gladiator_id for update;
    if not a.debited then update public.gladiators set stamina_current=stamina_current-a.stamina_debit where id=a.gladiator_id; end if;
    perform private.prepare_activity_jobs(a.id);
    update public.activities set debited=true,status='active',published_at_ms=now_ms where id=a.id;
    update public.gladiators set processed_slot_index=target where id=a.gladiator_id and processed_slot_index=target-1;
  end loop;
  return private.boundary_published(target);
end $$;

-- Exception 8: the slot's public tournament rows, published with its activities at phase 8. Idempotent.
create or replace function private.publish_tournaments(target bigint) returns void language plpgsql security invoker set search_path='' as $$
declare now_ms bigint:=private.planning_now_ms();
begin
  insert into public.tournament_views(id,pairing_job_id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms,published_at_ms)
    select t.id,t.pairing_job_id,t.slot_index,t.league,t.starts_at_ms,t.settles_at_ms,'active',
      (select jsonb_agg(jsonb_build_object('gladiatorId',e.gladiator_id,'name',e.name,'classId',e.fighter->'classId') order by e.gladiator_id)
        from private.tournament_entries e where e.tournament_id=t.id),
      -- The seeded first round, public at start: seats 2p and 2p + 1 meet in round-one bout p; null is an empty seat (a bye).
      jsonb_build_object('size',t.size,'rounds',t.rounds,'slots',(select jsonb_agg(seat.value order by o.position,seat.ordinality)
        from private.tournament_bouts o cross join lateral jsonb_array_elements(o.placed) with ordinality seat(value,ordinality)
        where o.tournament_id=t.id and o.round=1)),
      (select jsonb_agg(jsonb_build_object('id',o.id,'round',o.round,'position',o.position,'parentBoutIds',o.parent_bout_ids) order by o.round,o.position)
        from private.tournament_bouts o where o.tournament_id=t.id),
      t.reveal_at_ms,now_ms
    from private.tournaments t where t.slot_index=target
    on conflict (id) do nothing;
  -- A bye is public from the start through the slots, so its result is due from the start too.
  insert into public.tournament_bout_results(bout_id,tournament_id,ordinal,round,position,reveal_at_ms,result)
    select o.id,t.id,t.size-(t.size>>(o.round-1))+o.position,o.round,o.position,t.starts_at_ms,
      jsonb_build_object('participants',jsonb_build_array(jsonb_build_object('gladiatorId',e.gladiator_id,'name',e.name,'classId',e.fighter->'classId')),
        'winnerId',e.gladiator_id,'bye',true)
    from private.tournaments t join private.tournament_bouts o on o.tournament_id=t.id
    join private.tournament_entries e on e.tournament_id=t.id and e.gladiator_id::text=o.result->>'winnerId'
    where t.slot_index=target and o.bye
    on conflict (bout_id) do nothing;
  -- A league below the minimum on a tournament slot: its qualifiers fought regular Arena (2a review M5b).
  insert into public.tournament_views(id,pairing_job_id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms,published_at_ms)
    select 'tournament:'||target||':'||(j.input->>'league'),j.id,target,j.input->>'league',target*4800000,(target+1)*4800000,'insufficient-entrants',
      coalesce((select jsonb_agg(jsonb_build_object('gladiatorId',g.id,'name',g.name,'classId',p.result->'arenaFighter'->'classId') order by g.id)
        from jsonb_array_elements(j.result->'tournament'->'routes') r
        join public.gladiators g on g.id=(r.value->>'gladiatorId')::uuid
        join private.jobs p on p.dedupe_key='prepare:'||target||':'||g.id
        where r.value->>'reason'='too-few-entrants'),'[]'::jsonb),
      null,'[]'::jsonb,'[]'::jsonb,now_ms
    from private.jobs j
    where j.kind='pair' and j.slot_index=target and j.status='completed' and j.result->'tournament'->'bracket'='null'::jsonb
      and exists(select 1 from jsonb_array_elements(j.result->'tournament'->'routes') r
        where r.value->>'route'='arena' and r.value->>'reason'<>'not-tournament-slot')
    on conflict (id) do nothing;
end $$;

-- Task 10's phase-8 hook (06-projections.sql), publishing the slot's tournament rows first (exception 8).
create or replace function private.boundary_published(target bigint) returns text language plpgsql security invoker set search_path='' as $$
begin
  if target is null or target<0 then raise exception 'invalid published slot'; end if;
  perform private.publish_tournaments(target);
  -- Row triggers publish changed actors at transaction end; the completed phase itself also invalidates the small revision.
  update public.world_revision_state set revision=revision+1 where singleton;
  return null;
end $$;

-- Phase 8: the activity's private jobs. Tournament: the rank-1 entrant's call creates every fought bout's simulation job
-- (09 exception 4) and its reveal job (exception 4), in round order so parents exist first, with their dependencies; each
-- settlement waits for the final's bout and reveal (exception 5); each entrant gets its staging stage. Task 16's Arena
-- and Task 9's Expedition branches are unchanged.
create or replace function private.prepare_activity_jobs(activity uuid) returns void language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype; simulation uuid; terminal uuid; reveal uuid;
  seat private.arena_assignment_sides%rowtype; x private.arena_assignments%rowtype; entry private.tournament_entries%rowtype;
  t private.tournaments%rowtype; bout private.tournament_bouts%rowtype; first_reveal integer;
begin
  select * into a from public.activities where id=activity;
  select * into s from private.activity_snapshots where activity_id=activity;
  if a.resolved_kind not in ('training','rest','expedition','arena','tournament') then raise exception 'unsupported activity executor'; end if;
  insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
    values('settlement','settlement:'||a.id,a.slot_index,a.gladiator_id,a.id,
      jsonb_build_object('activityId',a.id,'gladiatorId',a.gladiator_id,'slotIndex',a.slot_index,'resolvedKind',a.resolved_kind,'endsAtMs',a.ends_at_ms),
      s.seed,s.rules_version,a.ends_at_ms) on conflict(dedupe_key) do nothing;
  select id into terminal from private.jobs where dedupe_key='settlement:'||a.id;
  if a.resolved_kind='expedition' then
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('simulation','expedition:'||a.id,a.slot_index,a.gladiator_id,a.id,s.snapshot,s.seed,s.rules_version,a.starts_at_ms)
      on conflict(dedupe_key) do nothing;
    select id into simulation from private.jobs where dedupe_key='expedition:'||a.id;
    insert into private.job_dependencies values(terminal,simulation) on conflict do nothing;
  elsif a.resolved_kind='arena' then
    select * into seat from private.arena_assignment_sides where activity_id=a.id;
    if not found then raise exception 'unpaired arena entrant'; end if;
    select * into x from private.arena_assignments where battle_id=seat.battle_id;
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('simulation','arena:'||x.battle_id,x.slot_index,(x.assignment->'sides'->0->>'gladiatorId')::uuid,
        (x.assignment->'sides'->0->>'activityId')::uuid,
        jsonb_build_object('kind','arena','battleId',x.battle_id,'slotIndex',x.slot_index,'rulesVersion',s.rules_version,
          'startsAtMs',a.starts_at_ms,'revealAtMs',a.starts_at_ms+3600000,'assignment',x.assignment,
          'names',(select jsonb_agg(g.name order by e.ordinality) from jsonb_array_elements(x.assignment->'sides') with ordinality e(value,ordinality)
            join public.gladiators g on g.id=(e.value->>'gladiatorId')::uuid)),
        x.seed,s.rules_version,a.starts_at_ms)
      on conflict(dedupe_key) do nothing;
    select id into simulation from private.jobs where dedupe_key='arena:'||x.battle_id;
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('reveal','arena-reveal:'||a.id,a.slot_index,a.gladiator_id,a.id,jsonb_build_object('activityId',a.id,'ordinal',1),
        s.seed,s.rules_version,a.starts_at_ms+3600000) on conflict(dedupe_key) do nothing;
    select id into reveal from private.jobs where dedupe_key='arena-reveal:'||a.id;
    insert into private.job_dependencies values(reveal,simulation),(terminal,simulation),(terminal,reveal) on conflict do nothing;
    insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,0,a.starts_at_ms,jsonb_build_object(
      'id',a.id::text||':0','kind','staging','revealedAtMs',a.starts_at_ms,'startedAtMs',a.starts_at_ms,'endsAtMs',a.starts_at_ms+3600000,
      'label','Warming up')) on conflict(activity_id,ordinal) do nothing;
  elsif a.resolved_kind='tournament' then
    select * into entry from private.tournament_entries where activity_id=a.id;
    if not found then raise exception 'unbracketed tournament entrant'; end if;
    select * into t from private.tournaments where id=entry.tournament_id;
    if entry.rank=1 then
      for bout in select * from private.tournament_bouts where tournament_id=t.id and not bye order by round,position loop
        insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
          values('simulation','tournament-bout:'||bout.id,t.slot_index,a.gladiator_id,a.id,
            jsonb_build_object('kind','tournament-bout','tournamentId',t.id,'boutId',bout.id),bout.seed,t.rules_version,t.starts_at_ms)
          on conflict(dedupe_key) do nothing;
        insert into private.job_dependencies(job_id,prerequisite_id)
          select child.id,parent.id from private.jobs child
          join jsonb_array_elements_text(bout.parent_bout_ids) pid(value) on true
          join private.jobs parent on parent.dedupe_key='tournament-bout:'||pid.value
          where child.dedupe_key='tournament-bout:'||bout.id
          on conflict do nothing;
        -- Exception 4: the bout's one reveal, due at its stored reveal time, after its bout and its fought parents' reveals.
        insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
          values('reveal','tournament-reveal:'||bout.id,t.slot_index,a.gladiator_id,a.id,
            jsonb_build_object('kind','tournament-reveal','tournamentId',t.id,'boutId',bout.id),s.seed,t.rules_version,bout.reveal_at_ms)
          on conflict(dedupe_key) do nothing;
        insert into private.job_dependencies(job_id,prerequisite_id)
          select r.id,p.id from private.jobs r join private.jobs p on p.dedupe_key='tournament-bout:'||bout.id
          where r.dedupe_key='tournament-reveal:'||bout.id
          union all
          select r.id,p.id from private.jobs r
          join jsonb_array_elements_text(bout.parent_bout_ids) pid(value) on true
          join private.jobs p on p.dedupe_key='tournament-reveal:'||pid.value
          where r.dedupe_key='tournament-reveal:'||bout.id
          on conflict do nothing;
      end loop;
    end if;
    -- Exception 5: this entrant's settlement (and, from rank 1, every entrant's settlement created so far) waits for the
    -- final's bout and its reveal.
    insert into private.job_dependencies(job_id,prerequisite_id)
      select st.id,f.id from private.tournament_entries te join private.jobs st on st.dedupe_key='settlement:'||te.activity_id
      join private.jobs f on f.dedupe_key in ('tournament-bout:'||t.id||':'||t.rounds||':0','tournament-reveal:'||t.id||':'||t.rounds||':0')
      where te.tournament_id=t.id and (entry.rank=1 or te.activity_id=a.id)
      on conflict do nothing;
    -- Staging from the start until the reveal of the entrant's first fought bout: round one, or round two after a bye.
    first_reveal:=case when exists(select 1 from private.tournament_bouts o where o.tournament_id=t.id and o.round=1 and o.bye
      and o.result->>'winnerId'=a.gladiator_id::text) then 1 else 0 end;
    insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,0,a.starts_at_ms,jsonb_build_object(
      'id',a.id::text||':0','kind','staging','revealedAtMs',a.starts_at_ms,'startedAtMs',a.starts_at_ms,
      'endsAtMs',(t.reveal_at_ms->>first_reveal)::bigint,'label','Tournament staging')) on conflict(activity_id,ordinal) do nothing;
  end if;
end $$;

-- Exception 2: the final's outcomes, one per entrant in rank order, against the stored results with the final's own
-- (`winner` beat `loser` in `final_bout`). No write; true only for exact shapes consistent with storage.
create or replace function private.valid_tournament_outcomes(tournament text,final_bout text,winner text,loser text,outcomes jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare e private.tournament_entries%rowtype; oc jsonb; b jsonb; g jsonb; idx integer; won boolean; gid text; facts jsonb;
  expected jsonb; listed jsonb; wins integer; losses integer; renown numeric; delta numeric; result_value text;
begin
  if jsonb_typeof(outcomes) is distinct from 'array'
    or jsonb_array_length(outcomes)<>(select count(*) from private.tournament_entries x where x.tournament_id=tournament) then
    return false;
  end if;
  -- Every bout's result, the final's from this completion: winner, loser (null for a bye), bye, round and position.
  select jsonb_agg(jsonb_build_object('id',x.id,'round',x.round,'position',x.position,'bye',x.bye)
      ||case when x.id=final_bout then jsonb_build_object('winnerId',winner,'loserId',loser)
        else jsonb_build_object('winnerId',x.result->'winnerId','loserId',x.result->'loserId') end order by x.round,x.position)
    into facts from private.tournament_bouts x where x.tournament_id=tournament;
  for oc,idx in select value,ordinality::integer from jsonb_array_elements(outcomes) with ordinality loop
    select * into e from private.tournament_entries x where x.tournament_id=tournament and x.rank=idx;
    gid:=e.gladiator_id::text;
    if jsonb_typeof(oc) is distinct from 'object' then return false; end if;
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(oc) k) is distinct from
        array['activityId','bouts','gladiatorId','losses','place','placement','ratingAfter','ratingBefore','ratingDelta','result','rewards','success','wins']
      or oc->>'gladiatorId' is distinct from gid or oc->>'activityId' is distinct from e.activity_id::text
      or jsonb_typeof(oc->'rewards') is distinct from 'object' or jsonb_typeof(oc->'placement') is distinct from 'object'
      or jsonb_typeof(oc->'bouts') is distinct from 'array' then
      return false;
    end if;
    won:=gid=winner;
    result_value:=case when won then 'victory' else 'defeat' end;
    -- One champion, the logged winner, in first place; the frozen rating before and a consistent change.
    if oc->>'result' is distinct from result_value or oc->'success' is distinct from to_jsonb(won)
      or not private.safe_integer(oc->'place',1) or ((oc->>'place')::numeric=1) is distinct from won
      or not private.safe_integer(oc->'wins') or not private.safe_integer(oc->'losses')
      or oc->'ratingBefore' is distinct from to_jsonb(e.rating) or not private.safe_integer(oc->'ratingAfter')
      or not private.safe_integer(oc->'ratingDelta',-9007199254740991) then
      return false;
    end if;
    if (oc->>'ratingDelta')::numeric<>(oc->>'ratingAfter')::numeric-(oc->>'ratingBefore')::numeric then return false; end if;
    -- Renown and placement money only.
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(oc->'rewards') k) is distinct from
        array['attributePoints','items','money','overflowMoney','renown','xp']
      or oc->'rewards'->'xp' is distinct from '0'::jsonb or oc->'rewards'->'attributePoints' is distinct from '0'::jsonb
      or oc->'rewards'->'overflowMoney' is distinct from '0'::jsonb or oc->'rewards'->'items' is distinct from '[]'::jsonb
      or not private.safe_integer(oc->'rewards'->'money') or not private.safe_integer(oc->'rewards'->'renown') then
      return false;
    end if;
    -- The placement grant: its one identity, this entrant's place, and the money it pays.
    g:=oc->'placement';
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(g) k) is distinct from
        array['activityId','gladiatorId','id','kind','money','place','placement','renown','tournamentId']
      or g->>'id' is distinct from tournament||':placement:'||gid or g->>'tournamentId' is distinct from tournament
      or g->>'gladiatorId' is distinct from gid or g->>'activityId' is distinct from e.activity_id::text or g->>'kind' is distinct from 'placement'
      or coalesce(g->>'placement','') not in ('winner','runner-up','semifinal','entrant') or (g->>'placement'='winner') is distinct from won
      or g->'place' is distinct from oc->'place' or g->'money' is distinct from oc->'rewards'->'money' or not private.safe_integer(g->'renown') then
      return false;
    end if;
    -- Its bouts are exactly its stored ones, in round then position order: a bye it received, or a fought win or loss.
    select coalesce(jsonb_agg(jsonb_build_object('boutId',f->'id','round',f->'round','kind',
        case when (f->>'bye')::boolean then 'bye' when f->>'winnerId'=gid then 'win' else 'loss' end) order by (f->>'round')::integer,(f->>'position')::integer),'[]'::jsonb)
      into expected from jsonb_array_elements(facts) f where f->>'winnerId'=gid or f->>'loserId'=gid;
    wins:=0; losses:=0; renown:=0; delta:=0; listed:='[]'::jsonb;
    for b in select value from jsonb_array_elements(oc->'bouts') loop
      if jsonb_typeof(b) is distinct from 'object' then return false; end if;
      if (select array_agg(k order by k collate "C") from jsonb_object_keys(b) k) is distinct from array['boutId','kind','ratingDelta','renown','round']
        or not private.safe_integer(b->'renown') or not private.safe_integer(b->'ratingDelta',-9007199254740991)
        or coalesce(b->>'kind','') not in ('bye','win','loss') then
        return false;
      end if;
      -- A bye is never a win: no renown and no rating change.
      if b->>'kind'='bye' and (b->'renown' is distinct from '0'::jsonb or b->'ratingDelta' is distinct from '0'::jsonb) then return false; end if;
      wins:=wins+(b->>'kind'='win')::integer;
      losses:=losses+(b->>'kind'='loss')::integer;
      renown:=renown+(b->>'renown')::numeric;
      delta:=delta+(b->>'ratingDelta')::numeric;
      listed:=listed||jsonb_build_array(jsonb_build_object('boutId',b->'boutId','round',b->'round','kind',b->'kind'));
    end loop;
    if listed is distinct from expected or oc->'wins' is distinct from to_jsonb(wins) or oc->'losses' is distinct from to_jsonb(losses)
      or renown+(g->>'renown')::numeric<>(oc->'rewards'->>'renown')::numeric or delta<>(oc->>'ratingDelta')::numeric then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- The tournament result fence (called through accept_job_result by complete_job, which locked the job row and checked its
-- token, status and expiry under database time sampled after that lock). This branch locks the row again (a no-op),
-- samples the clock after it and re-checks status, expiry, due time and dependencies before any write. Simulation:
-- exception 2, written once into the bout row (and, for the final, the outcomes of exception 3). Reveal: exception 4.
create or replace function private.accept_tournament_result(job uuid,result jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; t private.tournaments%rowtype; o private.tournament_bouts%rowtype; e private.tournament_entries%rowtype;
  log jsonb; now_ms bigint; sides text[]; final boolean; keys text[]; winner text; loser text; p jsonb; fighter jsonb; label text; perspective text;
begin
  select * into j from private.jobs where id=job for update;
  now_ms:=private.planning_now_ms();
  if not found or j.status is distinct from 'leased' or j.lease_until_ms<=now_ms or j.due_at_ms>now_ms or not private.dependencies_ready(j.id) then
    return false;
  end if;
  select * into o from private.tournament_bouts where id=j.input->>'boutId' and tournament_id=j.input->>'tournamentId';
  if not found or o.bye then return false; end if;
  select * into t from private.tournaments where id=o.tournament_id;
  if j.kind='simulation' then
    final:=o.round=t.rounds;
    keys:=case when final then array['boutId','log','outcomes'] else array['boutId','log'] end;
    if o.result is not null or j.dedupe_key is distinct from 'tournament-bout:'||o.id or j.input->>'kind' is distinct from 'tournament-bout'
      or jsonb_typeof(result) is distinct from 'object' then
      return false;
    end if;
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(result) k) is distinct from keys or result->>'boutId' is distinct from o.id then
      return false;
    end if;
    begin
      log:=private.safe_battle_log(result->'log');
    exception when others then
      return false;
    end;
    -- The bout's two entrants, in order: its round-one placement, otherwise its parents' stored winners.
    if o.round=1 then
      sides:=array[o.placed->>0,o.placed->>1];
    else
      sides:=array[(select x.result->>'winnerId' from private.tournament_bouts x where x.id=o.parent_bout_ids->>0),
        (select x.result->>'winnerId' from private.tournament_bouts x where x.id=o.parent_bout_ids->>1)];
    end if;
    if sides[1] is null or sides[2] is null or log->>'battleId' is distinct from o.id or log->>'rulesVersion' is distinct from t.rules_version
      or log->>'winnerId' is null or log->>'winnerId' not in (sides[1],sides[2])
      or (log->'events'->-1)->>'kind' is distinct from 'victory' or (log->'events'->-1)->>'winnerId' is distinct from log->>'winnerId' then
      return false;
    end if;
    -- Each participant is its frozen entry: id and gladiatorId, the name frozen at acceptance and the frozen fighter at full health.
    for i in 0..1 loop
      p:=log->'participants'->i;
      select * into e from private.tournament_entries x where x.tournament_id=t.id and x.gladiator_id::text=sides[i+1];
      if not found then return false; end if;
      fighter:=e.fighter;
      if p->>'id' is distinct from sides[i+1] or p->>'gladiatorId' is distinct from sides[i+1] or p->'name' is distinct from to_jsonb(e.name)
        or p->'classId' is distinct from fighter->'classId' or p->'stance' is distinct from fighter->'stance'
        or p->'attributes' is distinct from fighter->'attributes' or p->'maxHealth' is distinct from fighter->'maxHealth'
        or p->'initialHealth' is distinct from fighter->'maxHealth' or p->'armor' is distinct from fighter->'armor'
        or p->'weaponDamage' is distinct from fighter->'weaponDamage' or p->'attackIntervalMs' is distinct from fighter->'attackIntervalMs'
        or p->'equipmentSilhouettes' is distinct from fighter->'equipmentSilhouettes' then
        return false;
      end if;
    end loop;
    winner:=log->>'winnerId';
    loser:=case when winner=sides[1] then sides[2] else sides[1] end;
    if final then
      if not private.valid_tournament_outcomes(t.id,o.id,winner,loser,result->'outcomes') then return false; end if;
    end if;
    -- Write once (09 exception 10): null to this result.
    update private.tournament_bouts x set result=jsonb_build_object('winnerId',winner,'loserId',loser,'log',log) where x.id=o.id and x.result is null;
    if not found then return false; end if;
    if final then
      insert into private.tournament_results(tournament_id,final_job_id,outcomes,created_at_ms) values(t.id,j.id,result->'outcomes',now_ms);
    end if;
    return true;
  elsif j.kind='reveal' then
    if j.dedupe_key is distinct from 'tournament-reveal:'||o.id or j.input->>'kind' is distinct from 'tournament-reveal' or o.result is null
      or j.due_at_ms is distinct from o.reveal_at_ms then
      return false;
    end if;
    log:=o.result->'log';
    winner:=o.result->>'winnerId';
    label:=case when o.round=t.rounds then 'Final' when o.round=t.rounds-1 then 'Semifinal' when o.round=t.rounds-2 then 'Quarterfinal'
      else 'Round '||o.round end;
    -- Exception 4: both entrants' bout stages, each labelled from its own perspective, and the bout's public result.
    for e in select x.* from jsonb_array_elements(log->'participants') with ordinality q(value,ordinality)
      join private.tournament_entries x on x.tournament_id=t.id and x.gladiator_id::text=q.value->>'gladiatorId' order by q.ordinality loop
      perspective:=case when e.gladiator_id::text=winner then 'victory' else 'defeat' end;
      insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(e.activity_id,o.round,j.due_at_ms,jsonb_build_object(
        'id',e.activity_id::text||':'||o.round,'kind','bout','revealedAtMs',j.due_at_ms,'startedAtMs',j.due_at_ms,
        'endsAtMs',j.due_at_ms+(log->>'durationMs')::bigint,'label',label||': '||perspective,'battleLog',log));
    end loop;
    insert into public.tournament_bout_results(bout_id,tournament_id,ordinal,round,position,reveal_at_ms,result)
      values(o.id,t.id,t.size-(t.size>>(o.round-1))+o.position,o.round,o.position,j.due_at_ms,jsonb_build_object(
        'participants',(select jsonb_agg(jsonb_build_object('gladiatorId',x.gladiator_id,'name',x.name,'classId',x.fighter->'classId') order by q.ordinality)
          from jsonb_array_elements(log->'participants') with ordinality q(value,ordinality)
          join private.tournament_entries x on x.tournament_id=t.id and x.gladiator_id::text=q.value->>'gladiatorId'),
        'winnerId',winner,'bye',false,'battleLog',log));
    return true;
  end if;
  return false;
end $$;

-- Task 9's expedition acceptance and Task 16's Arena dispatch, unchanged, now dispatching tournament jobs (anchored to the
-- rank-1 entrant's tournament activity) to their own fenced branch.
create or replace function private.accept_job_result(job uuid,result jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; a public.activities%rowtype; p jsonb; stage jsonb; ordinal integer:=0;
  child uuid; previous uuid; terminal uuid; offset_ms bigint;
begin
  select * into j from private.jobs where id=job;
  select * into a from public.activities where id=j.activity_id;
  if a.resolved_kind='arena' then return private.accept_arena_result(job,result); end if;
  if a.resolved_kind='tournament' then return private.accept_tournament_result(job,result); end if;
  if a.resolved_kind is distinct from 'expedition' then return false; end if;
  if j.kind='simulation' then
    if jsonb_typeof(result) is distinct from 'object' or result->>'activityId' is distinct from a.id::text
      or result->>'rulesVersion' is distinct from j.rules_version or result->>'catalogVersion' is distinct from 'v1'
      or result->>'expeditionId' is distinct from j.input->'choice'->>'expeditionId'
      or jsonb_typeof(result->'success') is distinct from 'boolean' or jsonb_typeof(result->'encounters') is distinct from 'array'
      or jsonb_typeof(result->'stages') is distinct from 'array' or jsonb_typeof(result->'rewards') is distinct from 'object'
      or jsonb_typeof(result->'rewards'->'loot') is distinct from 'array'
      or not private.safe_integer(result->'rewards'->'money') or not private.safe_integer(result->'rewards'->'xp')
      then return false; end if;
    if jsonb_array_length(result->'encounters') not between 1 and 3 or jsonb_array_length(result->'stages') not between 4 and 8 then return false; end if;
    if result->'success'='false'::jsonb and result->'rewards'<>'{"money":0,"xp":0,"loot":[]}'::jsonb then return false; end if;
    -- Validate the entire plan's stage schedule before any write, so invalid results cannot leave partial children.
    offset_ms:=-1;
    for stage in select * from jsonb_array_elements(result->'stages') loop
      if jsonb_typeof(stage) is distinct from 'object' or jsonb_typeof(stage->'label') is distinct from 'string' or jsonb_typeof(stage->'id') is distinct from 'string'
        or coalesce(stage->>'kind','') not in ('depart','travel','exploration','encounter','return')
        or not private.safe_integer(stage->'revealedAtMs') or not private.safe_integer(stage->'startedAtMs') or not private.safe_integer(stage->'endsAtMs') then return false; end if;
      if (stage->>'revealedAtMs')::bigint<a.starts_at_ms or (stage->>'revealedAtMs')::bigint>a.ends_at_ms
        or (stage->>'revealedAtMs')::bigint<offset_ms or stage->'startedAtMs'<>stage->'revealedAtMs'
        or (stage->>'endsAtMs')::bigint<(stage->>'startedAtMs')::bigint or (stage->>'endsAtMs')::bigint>a.ends_at_ms then return false; end if;
      offset_ms:=(stage->>'revealedAtMs')::bigint;
      if stage ? 'battleLog' then perform private.safe_battle_log(stage->'battleLog'); end if;
    end loop;
    insert into private.expedition_plans values(a.id,result);
    select id into terminal from private.jobs where dedupe_key='settlement:'||a.id;
    previous:=j.id;
    for stage in select * from jsonb_array_elements(result->'stages') loop
      insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
        values('reveal','expedition-reveal:'||a.id||':'||ordinal,a.slot_index,a.gladiator_id,a.id,
          jsonb_build_object('activityId',a.id,'ordinal',ordinal),j.seed,j.rules_version,(stage->>'revealedAtMs')::bigint) returning id into child;
      insert into private.job_dependencies values(child,previous),(terminal,child);
      previous:=child;ordinal:=ordinal+1;
    end loop;
    return true;
  elsif j.kind='reveal' then
    if j.due_at_ms>private.planning_now_ms() or not private.dependencies_ready(j.id) then return false; end if;
    select plan into p from private.expedition_plans where activity_id=a.id;
    stage:=p->'stages'->((j.input->>'ordinal')::integer);
    if stage is null then return false; end if;
    insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,(j.input->>'ordinal')::integer,j.due_at_ms,
      jsonb_build_object('id',stage->'id','kind',stage->'kind','revealedAtMs',stage->'revealedAtMs','startedAtMs',stage->'startedAtMs',
        'endsAtMs',stage->'endsAtMs','label',stage->'label')||case when stage ? 'battleLog' then jsonb_build_object('battleLog',private.safe_battle_log(stage->'battleLog')) else '{}'::jsonb end);
    return true;
  end if;
  return false;
end $$;

-- Exception 6: whether this entrant may be credited, decided under its settlement locks before any grant. Null when it may;
-- otherwise the failure code that retains the job for operator action. Only its own frozen rating and its own live row.
create or replace function private.tournament_settlement_failure(activity uuid) returns text language plpgsql stable security invoker set search_path='' as $$
declare a public.activities%rowtype; e private.tournament_entries%rowtype; t private.tournaments%rowtype; o jsonb; live bigint;
begin
  select * into a from public.activities where id=activity;
  select * into e from private.tournament_entries where activity_id=activity;
  if not found then return 'tournament-unbracketed'; end if;
  select * into t from private.tournaments where id=e.tournament_id;
  select r.outcomes->(e.rank-1) into o from private.tournament_results r where r.tournament_id=t.id;
  if o is null or o->>'activityId' is distinct from a.id::text or o->>'gladiatorId' is distinct from a.gladiator_id::text then
    return 'tournament-unsettled';
  end if;
  select r.rating into live from private.arena_ratings r where r.gladiator_id=a.gladiator_id and r.league=t.league and r.season_index=t.season_index;
  if live is null or live is distinct from e.rating or live is distinct from (o->>'ratingBefore')::bigint then
    return 'rating-mismatch';
  end if;
  return null;
end $$;

-- One entrant's credit, from its own frozen outcome (called by settle_rewards inside its own settlement): its rating row
-- and human counters (fought bouts only), the rating cache, placement money and fight plus placement renown, its
-- zero-length return stage and its public place. The outcome's placement grant is returned for the receipt (exception 7).
create or replace function private.tournament_rewards(activity uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; e private.tournament_entries%rowtype; t private.tournaments%rowtype; o jsonb; after bigint;
begin
  select * into a from public.activities where id=activity;
  select * into e from private.tournament_entries where activity_id=activity;
  select * into t from private.tournaments where id=e.tournament_id;
  select r.outcomes->(e.rank-1) into o from private.tournament_results r where r.tournament_id=t.id;
  if o is null or o->>'activityId' is distinct from a.id::text then raise exception 'missing tournament outcome'; end if;
  after:=(o->>'ratingAfter')::bigint;
  update private.arena_ratings set rating=after,human_wins=human_wins+(o->>'wins')::bigint,human_losses=human_losses+(o->>'losses')::bigint
    where gladiator_id=a.gladiator_id and league=t.league and season_index=t.season_index;
  if not found then raise exception 'missing tournament rating'; end if;
  update public.gladiators set rating=after where id=a.gladiator_id and league=t.league and rating is distinct from after;
  update public.wallets set money=money+(o->'rewards'->>'money')::bigint,renown=renown+(o->'rewards'->>'renown')::bigint where gladiator_id=a.gladiator_id;
  insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(a.id,t.rounds+1,a.ends_at_ms,jsonb_build_object(
    'id',a.id::text||':'||(t.rounds+1),'kind','return','revealedAtMs',a.ends_at_ms,'startedAtMs',a.ends_at_ms,'endsAtMs',a.ends_at_ms,
    'label','Results credited'));
  insert into public.tournament_placements(tournament_id,gladiator_id,activity_id,place) values(t.id,a.gladiator_id,a.id,(o->>'place')::integer);
  return jsonb_build_object('rewards',o->'rewards','result',o->'result','success',o->'success','ratingDelta',o->'ratingDelta','placement',o->'placement',
    'replayExpiry',case when private.planning_now_ms()<a.ends_at_ms+604800000
      then jsonb_build_object('state','available','expiresAtMs',a.ends_at_ms+604800000) else jsonb_build_object('state','expired') end);
end $$;

-- Task 7's Training/Rest settlement hook and Task 16's Arena, unchanged, now with the tournament kind.
create or replace function private.settle_rewards(activity uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype; points bigint := 0; earned bigint;
begin
  select * into a from public.activities where id=activity;
  if a.resolved_kind='arena' then return private.arena_rewards(activity); end if;
  if a.resolved_kind='tournament' then return private.tournament_rewards(activity); end if;
  select * into s from private.activity_snapshots where activity_id=activity;
  if a.resolved_kind='training' then
    select earned_points into earned from public.gladiators where id=a.gladiator_id;
    points := least((s.snapshot->>'trainingPoints')::bigint,1000000000-earned);
    update public.gladiators set earned_points=earned_points+points,unspent_points=unspent_points+points where id=a.gladiator_id;
  elsif a.resolved_kind='rest' then
    -- Rest restores the current maximum at slot completion; no build change has occurred inside the slot.
    update public.gladiators set stamina_current=stamina_maximum where id=a.gladiator_id;
  else
    raise exception 'unsupported settlement';
  end if;
  -- Training and Rest have no replay; the canonical contract offers no non-replay state yet (Task 10/13 gate).
  return jsonb_build_object('rewards',jsonb_build_object('money',0,'renown',0,'xp',0,'attributePoints',points,'items','[]'::jsonb,'overflowMoney',0),
    'result','completed','success',true,'replayExpiry',jsonb_build_object('state','expired'));
end $$;

-- Task 9's common settlement with Task 16's Arena rating row, now also the tournament entrant's own rating row locked as a
-- dependent row (exception 6), its fail-closed check, and the receipt carrying the placement grant id (exception 7).
create or replace function private.settle_activity_core(activity_id uuid,lease_token uuid,prepared jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; j private.jobs%rowtype; owner uuid; now_ms bigint; receipt uuid:=gen_random_uuid();
  settlement jsonb; operation uuid:=gen_random_uuid(); result_summary jsonb; outcome jsonb; inserted integer; failure text; grant_id text;
begin
  if settle_activity_core.activity_id is null or settle_activity_core.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select g.owner_id into owner from public.activities x join public.gladiators g on g.id=x.gladiator_id where x.id=settle_activity_core.activity_id;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  perform 1 from public.gladiators g join public.activities x on x.gladiator_id=g.id where x.id=settle_activity_core.activity_id for update of g;
  perform 1 from public.wallets w join public.activities x on x.gladiator_id=w.gladiator_id where x.id=settle_activity_core.activity_id for update of w;
  perform 1 from public.item_instances i join public.activities x on x.gladiator_id=i.gladiator_id where x.id=settle_activity_core.activity_id order by i.id for update of i;
  perform 1 from private.arena_ratings r join private.arena_assignment_sides s on s.activity_id=settle_activity_core.activity_id
    join private.arena_assignments x on x.battle_id=s.battle_id join public.activities y on y.id=s.activity_id
    where r.gladiator_id=y.gladiator_id and r.league=x.league and r.season_index=x.season_index for update of r;
  perform 1 from private.arena_ratings r join private.tournament_entries e on e.activity_id=settle_activity_core.activity_id
    join private.tournaments t on t.id=e.tournament_id
    where r.gladiator_id=e.gladiator_id and r.league=t.league and r.season_index=t.season_index for update of r;
  select * into a from public.activities where id=settle_activity_core.activity_id for update;
  select * into j from private.jobs where dedupe_key='settlement:'||a.id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms();
  if j.status='completed' then
    -- A lost response retries with the same token and receives the committed receipt, never a second grant.
    if j.lease_token=settle_activity_core.lease_token then return j.result||jsonb_build_object('newGrants',0,'replayed',true); end if;
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if j.status<>'leased' or j.lease_token is distinct from settle_activity_core.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if a.status<>'active' or now_ms<a.ends_at_ms then return jsonb_build_object('ok',false,'code','processing'); end if;
  if not private.dependencies_ready(j.id) or a.slot_index>coalesce((select published_slot from private.coordinator where singleton),-1)
    or exists(select 1 from public.activities earlier where earlier.slot_index<a.slot_index and earlier.status<>'completed') then
    return jsonb_build_object('ok',false,'code','processing'); end if;
  if a.resolved_kind in ('arena','tournament') and not exists(select 1 from private.settled_slots s where s.gladiator_id=a.gladiator_id and s.slot_index=a.slot_index) then
    if a.resolved_kind='arena' then failure:=private.arena_settlement_failure(a.id); else failure:=private.tournament_settlement_failure(a.id); end if;
    if failure is not null then
      -- Fail closed before any grant or checkpoint: neither the frozen nor the live value is used.
      update private.jobs set status='operator',lease_token=null,lease_owner=null,lease_until_ms=null,last_failure=failure where id=j.id;
      update private.job_attempts set finished_at_ms=now_ms,outcome='failed',failure_code=failure where job_attempts.job_id=j.id and attempt=j.attempts;
      return jsonb_build_object('ok',false,'code','operator');
    end if;
  end if;
  insert into private.settled_slots(gladiator_id,slot_index,activity_id,receipt_id,resolved_kind,settled_at_ms)
    values(a.gladiator_id,a.slot_index,a.id,receipt,a.resolved_kind,now_ms) on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then
    -- The permanent checkpoint already exists: finish the job with that receipt and grant nothing.
    select s.receipt_id into receipt from private.settled_slots s where s.gladiator_id=a.gladiator_id and s.slot_index=a.slot_index;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',0,'replayed',true);
  else
    if a.resolved_kind='expedition' then
      settlement:=private.expedition_rewards(a.id,prepared);
      if settlement is null then
        -- Raise in a subtransaction at the RPC wrapper: every tentative write/guard rolls back before stale return.
        raise exception 'stale preparation' using errcode='P0002';
      end if;
    else settlement:=private.settle_rewards(a.id); end if;
    if a.resolved_kind='tournament' then
      -- Exception 7: the placement grant's one identity, kept with this activity's receipt; the summary whitelist drops it.
      grant_id:=settlement->'placement'->>'id';
      if grant_id is null then raise exception 'missing placement grant'; end if;
    end if;
    settlement:=private.safe_settlement(settlement);
    result_summary:=settlement||jsonb_build_object('activityId',a.id,'resolvedKind',a.resolved_kind,'receiptId',receipt,'settledAtMs',now_ms);
    if a.resolved_kind in ('expedition','arena','tournament') then
      insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
        values(owner,operation,receipt,a.gladiator_id,jsonb_build_object('kind','activity-settlement','activityId',a.id)
          ||case when grant_id is null then '{}'::jsonb else jsonb_build_object('grantId',grant_id) end,
          extensions.digest(a.id::text,'sha256'),result_summary);
      insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason)
        values(a.gladiator_id,receipt,(settlement->'rewards'->>'money')::bigint+(settlement->'rewards'->>'overflowMoney')::bigint,
          (settlement->'rewards'->>'renown')::bigint,a.resolved_kind);
    end if;
    update public.activities set status='completed',receipt_id=receipt,summary=result_summary,settled_at_ms=now_ms where id=a.id;
    outcome:=jsonb_build_object('ok',true,'activityId',a.id,'receiptId',receipt,'newGrants',1,'summary',result_summary);
  end if;
  update private.jobs set status='completed',result=outcome,completed_at_ms=now_ms where id=j.id;
  update private.job_attempts set finished_at_ms=now_ms,outcome='completed' where job_attempts.job_id=j.id and attempt=j.attempts;
  return outcome;
end $$;

revoke all on function private.boundary_start(bigint),private.publish_tournaments(bigint),private.boundary_published(bigint),
  private.prepare_activity_jobs(uuid),private.valid_tournament_outcomes(text,text,text,text,jsonb),private.accept_tournament_result(uuid,jsonb),
  private.accept_job_result(uuid,jsonb),private.tournament_settlement_failure(uuid),private.tournament_rewards(uuid),private.settle_rewards(uuid),
  private.settle_activity_core(uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function private.boundary_start(bigint),private.publish_tournaments(bigint),private.boundary_published(bigint),
  private.prepare_activity_jobs(uuid),private.valid_tournament_outcomes(text,text,text,text,jsonb),private.accept_tournament_result(uuid,jsonb),
  private.accept_job_result(uuid,jsonb),private.tournament_settlement_failure(uuid),private.tournament_rewards(uuid),private.settle_rewards(uuid),
  private.settle_activity_core(uuid,uuid,jsonb)
  to service_role;
notify pgrst,'reload schema';
commit;
