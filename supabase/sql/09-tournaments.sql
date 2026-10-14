-- Task 19 phase 2a reapplicable source. Committed M01-M10 are immutable; deploy only the separately generated migration.
-- League tournaments: the automatic-entry command, spec 8.2's partition and seeded bracket inside Task 16's per-slot,
-- per-league pairing job, fenced acceptance of the TypeScript-built bracket, one-way placement and bout seeds, and one
-- simulation job per fought bout with parent dependencies and a fenced read of the parents' stored winners. Phase 2a
-- stops before bout results are accepted, revealed or settled (phase 2b). Builds on 07-arena.sql and 08-arena-bouts.sql.
-- Shared lock order (Tasks 4/6/7/9/16): coordinator row, account advisory hashtextextended(owner,0), gladiator row, then
-- dependent rows, activities, jobs; projection rows last. Database time is private.planning_now_ms(), sampled after the
-- guard locks.
--
-- Accepted exceptions:
-- 1. The partition runs inside the pairing job (no second tournament job). Every slot's pairing input now carries its
--    league's tournament candidates: each Arena request of the slot and league (resolved Arena, or Rest by boundary step 6)
--    with its frozen choice, starting stamina, Arena and tournament costs and opt-in, plus the bracket seed. Canonical
--    TypeScript decides tournament days, opt-in, eligibility, the minimum and the seeded ranks; SQL restates none of them.
--    Acceptance checks the routes against the frozen state only: Rest exactly for step 6's fallbacks at no cost, a bracket at
--    the frozen tournament cost, regular Arena at the frozen Arena cost, every request routed once.
-- 2. Bracket (placement) seed. boundary_pair generates the pairing job's seed itself and freezes
--    encode(extensions.digest(<pairing job seed>||':bracket','sha256'),'hex') into the job input. The placement is public at
--    start; a one-way seed keeps it from revealing the matcher's seeded tie-break keys, which still use the job seed.
-- 3. Bout seeds. Each fought bout row stores encode(extensions.digest(<pairing job seed>||':'||boutId,'sha256'),'hex'),
--    computed when the row is written, so a retried pairing reproduces it; byes have none. A bout's simulation job carries
--    its bout seed, the second exception (after 07-arena.sql exception 2) to 03-activities-jobs.sql's rule that every job of
--    an activity carries the activity snapshot seed. The domain never derives a bout seed.
-- 4. Bout jobs. One simulation job `tournament-bout:<boutId>` per fought bout, anchored to the tournament's rank-1 entry
--    (its gladiator and activity). It is bookkeeping only: the job input names the bout, and the participants come from the
--    stored graph. Phase 8 creates them inside the rank-1 entrant's own prepare_activity_jobs call, under that entrant's
--    account and character locks, so their foreign keys lock no other account's rows. Each child depends on its fought
--    parents' jobs; each entrant's settlement job depends on every bout job of its tournament.
-- 5. The bracket frame is checked given its ranks. The ranks are the seeded decision and are trusted, as 07-arena.sql
--    trusts matchArena's pairs; everything else has exactly one valid value, as 07 checks battle ids: size the next power
--    of two, ids and parents, standard seeding positions, byes and their results, reveal times and settlement. This restates
--    the frame: 4800000 is RULES_V1.tournament.durationMs (pinned to the slot length), round r of R reveals at
--    ceil(4800000 * r / (R + 1)) after the start, and the seeding order is 1-8, 4-5, 2-7, 3-6. A rules version that changes
--    the frame needs a new source.
-- 6. Opt-in. public.set_tournament_opt_in takes the planning lock order and processing gate (02-build-schedule.sql): a
--    toggle sampled after its locks at or after an unprocessed cutoff answers processing, unrecorded. Phase 5 reads the
--    character under the same locks, so the frozen starting.tournamentOptIn equals the value at the cutoff; the pairing input
--    passes it to partitionTournament as one revision received at cutoff - 1 ms. No revision history is kept.
-- 7. Pairing history counts human tournament bouts, one row per fought bout: round one from the stored placement (known at
--    build), later rounds from the stored result (phase 2b writes it). Byes never count.
-- 8. Adoption. Once every pairing job of the slot completed, phase 7 turns the bracket entrants' activities into the slot's
--    tournament activity, charged once at the frozen tournament cost, under the coordinator lease without account locks,
--    as phase 6 resolves preparing activities.
-- 9. Lock order of a pairing completion with a bracket: as 07-arena.sql exception 3, complete_job locks the pairing job
--    row, then the entry rows' foreign keys take KEY SHARE locks on entrant activity and gladiator rows (job before
--    activity). No cycle: nothing locks those preparing activities while phase 7 waits for that job.
-- 10. Bout rows are immutable except their result, which phase 2b's fence writes once (null to a value); byes carry
--     theirs from the start.
-- Phase 2a limit: complete_job accepts no bout result yet (accept_job_result reaches no tournament branch), so a claimed
-- bout cannot complete and a tournament activity cannot settle (settle_rewards fails closed). Ship with phase 2b.
-- Inherited (Tasks 7/9/16): the exhausted-lease sweep may lock expired jobs before the coordinator row; unchanged here.
begin;

-- The immutable frame of one league's bracket for one slot, written once by an accepted pairing job.
create table if not exists private.tournaments (
  id text primary key,
  pairing_job_id uuid not null unique references private.jobs(id),
  slot_index bigint not null check (slot_index >= 0),
  league text not null check (league in ('bronze','silver','gold','champion')),
  season_index bigint not null check (season_index >= 0),
  rules_version text not null references private.rules_versions(version),
  starts_at_ms bigint not null,
  settles_at_ms bigint not null,
  size integer not null check (size >= 2),
  rounds integer not null check (rounds >= 1),
  reveal_at_ms jsonb not null check (jsonb_typeof(reveal_at_ms)='array'),
  created_at_ms bigint not null,
  unique (slot_index,league),
  check (id='tournament:'||slot_index||':'||league)
);
create index if not exists tournaments_rules_idx on private.tournaments(rules_version);
-- Each entrant's frozen tournament snapshot: its seeded rank, its rating before the tournament, its arena fighter and the
-- display name every bout log of the tournament carries.
create table if not exists private.tournament_entries (
  tournament_id text not null references private.tournaments(id),
  gladiator_id uuid not null references public.gladiators(id),
  activity_id uuid not null unique references public.activities(id),
  rank integer not null check (rank >= 1),
  rating bigint not null check (rating between 0 and 9007199254740991),
  fighter jsonb not null check (jsonb_typeof(fighter)='object'),
  name text not null,
  primary key (tournament_id,gladiator_id),
  unique (tournament_id,rank)
);
create index if not exists tournament_entries_gladiator_idx on private.tournament_entries(gladiator_id);
-- One row per bout: the frame, the private one-way seed of a fought bout (exception 3) and its result (exception 10).
create table if not exists private.tournament_bouts (
  id text primary key,
  tournament_id text not null references private.tournaments(id),
  round integer not null check (round >= 1),
  position integer not null check (position >= 0),
  parent_bout_ids jsonb not null check (jsonb_typeof(parent_bout_ids)='array'),
  placed jsonb check (placed is null or jsonb_typeof(placed)='array'),
  bye boolean not null,
  reveal_at_ms bigint not null,
  seed text,
  result jsonb check (result is null or jsonb_typeof(result)='object'),
  unique (tournament_id,round,position),
  check ((round=1)=(placed is not null)),
  check (bye=(seed is null)),
  check (not bye or result is not null)
);
do $$ declare t text; begin
  foreach t in array array['tournaments','tournament_entries','tournament_bouts'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
    execute format('grant %s on private.%I to service_role',case t when 'tournament_bouts' then 'select,insert,update,delete' else 'select,insert,delete' end,t);
    execute format('drop policy if exists backend_only on private.%I',t);
    execute format('create policy backend_only on private.%I to service_role using (true) with check (true)',t);
  end loop;
end $$;

-- Exception 10: a bout's frame and seed never change; its result is written at most once, from null.
create or replace function private.guard_tournament_bout() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.result is not null or new.result is null
    or (new.id,new.tournament_id,new.round,new.position,new.parent_bout_ids,new.placed,new.bye,new.reveal_at_ms,new.seed)
      is distinct from (old.id,old.tournament_id,old.round,old.position,old.parent_bout_ids,old.placed,old.bye,old.reveal_at_ms,old.seed) then
    raise exception 'immutable tournament_bouts';
  end if;
  return new;
end $$;
drop trigger if exists guard_frozen on private.tournaments;
create trigger guard_frozen before update on private.tournaments for each row execute function private.guard_frozen();
drop trigger if exists guard_frozen on private.tournament_entries;
create trigger guard_frozen before update on private.tournament_entries for each row execute function private.guard_frozen();
drop trigger if exists guard_tournament_bout on private.tournament_bouts;
create trigger guard_tournament_bout before update on private.tournament_bouts for each row execute function private.guard_tournament_bout();

-- Exception 6: the automatic-entry flag, with receipts, the account lock order and the processing gate of planning commands.
create or replace function public.set_tournament_opt_in(actor_id uuid,operation_id uuid,input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c jsonb:=input->'command'; prior public.operation_receipts%rowtype; g public.gladiators%rowtype; now_ms bigint;
  receipt uuid:=gen_random_uuid(); result jsonb;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(c) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into prior from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=set_tournament_opt_in.operation_id;
  if found then
    if prior.request<>c then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return prior.result;
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['enabled','kind','operationId']
    or c->>'kind' is distinct from 'set-tournament-opt-in' or c->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(c->'enabled') is distinct from 'boolean' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into g from public.gladiators where owner_id=actor_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  now_ms:=private.planning_now_ms();
  -- A transient processing result is not retained: after catch-up this exact operation applies to later tournaments.
  if g.processed_slot_index<now_ms/4800000 then return jsonb_build_object('ok',false,'code','processing','retryAfterMs',1000); end if;
  update public.gladiators set tournament_opt_in=(c->>'enabled')::boolean where id=g.id and tournament_opt_in is distinct from (c->>'enabled')::boolean;
  result:=jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('enabled',c->'enabled','receivedAtMs',now_ms));
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,g.id,c,sha256(convert_to(c::text,'UTF8')),result);
  return result;
end $$;

-- 08-arena-bouts.sql's pairing input with the league's tournament candidates (exceptions 1 and 6) and the human tournament
-- bouts in its history (exception 7). boundary_pair adds the bracket seed.
create or replace function private.pairing_input(target bigint,league_id text,season bigint,rules text) returns jsonb
language sql stable security invoker set search_path='' as $$
  with requested as (
    select a.id as activity_id,a.gladiator_id,a.resolved_kind,s.snapshot,jsonb_build_object('gladiatorId',a.gladiator_id,'activityId',a.id,
      'seasonId',season::text,'league',league_id,'slotIndex',target,'rating',s.snapshot->'starting'->'rating','fighter',p.result->'arenaFighter') as entrant
    from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    join private.jobs p on p.dedupe_key='prepare:'||target||':'||a.gladiator_id and p.status='completed'
    where a.slot_index=target and a.status='preparing' and a.requested->>'kind'='arena' and a.resolved_kind in ('arena','rest')
      and s.snapshot->'starting'->>'league'=league_id),
  entrants as (select * from requested where resolved_kind='arena'),
  history as (
    select x.slot_index,x.battle_id as id,x.assignment->'sides'->0->>'gladiatorId' as a,x.assignment->'sides'->1->>'gladiatorId' as b
    from private.jobs pj join private.arena_assignments x on x.pairing_job_id=pj.id
    where pj.kind='pair' and pj.slot_index between target-18 and target-1 and x.kind='human'
    union all
    select t.slot_index,o.id,case when o.round=1 then o.placed->>0 else o.result->>'winnerId' end,
      case when o.round=1 then o.placed->>1 else o.result->>'loserId' end
    from private.tournaments t join private.tournament_bouts o on o.tournament_id=t.id
    where t.slot_index between target-18 and target-1 and not o.bye)
  select jsonb_build_object('slotIndex',target,'league',league_id,'seasonId',season::text,'rulesVersion',rules,'historyFromSlot',target-18,
    'entrants',coalesce((select jsonb_agg(e.entrant order by e.gladiator_id) from entrants e),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(jsonb_build_object('slotIndex',h.slot_index,'gladiatorIds',jsonb_build_array(h.a,h.b)) order by h.slot_index,h.id)
      from history h where h.a in (select e.gladiator_id::text from entrants e) and h.b in (select e.gladiator_id::text from entrants e)),'[]'::jsonb),
    'tournament',jsonb_build_object(
      'rested',coalesce((select jsonb_agg(r.entrant order by r.gladiator_id) from requested r where r.resolved_kind='rest'),'[]'::jsonb),
      'candidates',coalesce((select jsonb_agg(jsonb_build_object('gladiatorId',r.gladiator_id,'choice',r.snapshot->'choice',
        'stamina',r.snapshot->'starting'->'stamina'->'current',
        'costs',jsonb_build_object('arena',r.snapshot->'costs'->'arena','tournament',r.snapshot->'costs'->'tournament'),
        'optIn',jsonb_build_array(jsonb_build_object('enabled',r.snapshot->'starting'->'tournamentOptIn','receivedAtMs',target*4800000-1)))
        order by r.gladiator_id) from requested r),'[]'::jsonb)))
$$;

-- Phase 7: Task 16's one fenced pairing job per slot and league, now also partitioning tournaments with its own placement
-- seed (exception 2), then adopting the accepted brackets (exception 8) before checking every entrant has its one bout.
create or replace function private.boundary_pair(target bigint) returns text language plpgsql security invoker set search_path='' as $$
declare b private.boundaries%rowtype; season bigint; l text; now_ms bigint:=private.planning_now_ms(); seed text; input jsonb;
begin
  if not exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena') then return null; end if;
  select * into b from private.boundaries where slot_index=target;
  season:=private.season_index(target);
  if season is null then return 'epoch'; end if;
  for l in select distinct s.snapshot->'starting'->>'league' from public.activities a join private.activity_snapshots s on s.activity_id=a.id
    where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena'
      and not exists(select 1 from private.jobs j where j.dedupe_key='pair:'||target||':'||(s.snapshot->'starting'->>'league')) loop
    seed:=encode(extensions.gen_random_bytes(32),'hex');
    input:=jsonb_set(private.pairing_input(target,l,season,b.rules_version),'{tournament,bracketSeed}',
      to_jsonb(encode(extensions.digest(seed||':bracket','sha256'),'hex')));
    insert into private.jobs(kind,dedupe_key,slot_index,gladiator_id,activity_id,input,seed,rules_version,due_at_ms)
      values('pair','pair:'||target||':'||l,target,null,null,input,seed,b.rules_version,now_ms)
      on conflict (dedupe_key) do nothing;
  end loop;
  if exists(select 1 from private.jobs j where j.kind='pair' and j.slot_index=target and j.status='operator') then return 'operator'; end if;
  if exists(select 1 from private.jobs j where j.kind='pair' and j.slot_index=target and j.status<>'completed') then return 'pairing'; end if;
  update public.activities a set resolved_kind='tournament',stamina_debit=(s.snapshot->'costs'->>'tournament')::bigint
    from private.tournament_entries e join private.tournaments t on t.id=e.tournament_id join private.activity_snapshots s on s.activity_id=e.activity_id
    where t.slot_index=target and a.id=e.activity_id and a.status='preparing' and a.resolved_kind='arena';
  if exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='arena'
    and not exists(select 1 from private.arena_assignment_sides x where x.activity_id=a.id)) then
    raise exception 'unpaired arena entrant';
  end if;
  if exists(select 1 from public.activities a where a.slot_index=target and a.status='preparing' and a.resolved_kind='tournament'
    and not exists(select 1 from private.tournament_entries e where e.activity_id=a.id)) then
    raise exception 'unbracketed tournament entrant';
  end if;
  return null;
end $$;

-- Exception 5: the TypeScript-built bracket of a pairing job, given its seeded ranks, against the frozen values of its
-- bracket entrants (`entrants`: gladiator id -> {activityId, rating, fighter}). No write; true only for the one valid frame.
create or replace function private.valid_bracket(job uuid,bracket jsonb,entrants jsonb) returns boolean language plpgsql stable security invoker set search_path='' as $$
declare j private.jobs%rowtype; n integer:=(select count(*) from jsonb_object_keys(entrants)); size integer; rounds integer; starts bigint; tid text;
  ranked text[]; seats integer[]:=array[1]; grown integer[]; v integer; e jsonb; x jsonb; o jsonb; gid text; r integer; p integer; bout_id text;
  a text; c text; due jsonb; seen jsonb:='{}'::jsonb; bouts jsonb:='{}'::jsonb;
begin
  select * into j from private.jobs where id=job;
  if n=0 then return bracket is null or bracket='null'::jsonb; end if;
  if jsonb_typeof(bracket) is distinct from 'object' or n<2
    or (select array_agg(k order by k collate "C") from jsonb_object_keys(bracket) k) is distinct from
      array['bouts','entries','id','league','revealAtMs','rounds','rulesVersion','seasonId','settlesAtMs','size','slotIndex','startsAtMs']
    or jsonb_typeof(bracket->'entries') is distinct from 'array' or jsonb_typeof(bracket->'bouts') is distinct from 'array'
    or jsonb_typeof(bracket->'revealAtMs') is distinct from 'array' or not private.safe_integer(bracket->'size',2)
    or not private.safe_integer(bracket->'rounds',1) then return false; end if;
  -- The next power of two: n <= size < 2n, so no first-round bout has two byes.
  if (bracket->>'size')::numeric<n or (bracket->>'size')::numeric>=2*n or (bracket->>'rounds')::numeric>30 then return false; end if;
  size:=(bracket->>'size')::integer; rounds:=(bracket->>'rounds')::integer; starts:=j.slot_index*4800000;
  tid:='tournament:'||j.slot_index||':'||(j.input->>'league');
  if 1<<rounds<>size or bracket->'id' is distinct from to_jsonb(tid) or bracket->'league' is distinct from j.input->'league'
    or bracket->'slotIndex' is distinct from to_jsonb(j.slot_index) or bracket->'seasonId' is distinct from j.input->'seasonId'
    or bracket->'rulesVersion' is distinct from to_jsonb(j.rules_version) or bracket->'startsAtMs' is distinct from to_jsonb(starts)
    or bracket->'settlesAtMs' is distinct from to_jsonb(starts+4800000) or jsonb_array_length(bracket->'entries')<>n
    or jsonb_array_length(bracket->'bouts')<>size-1 or jsonb_array_length(bracket->'revealAtMs')<>rounds then return false; end if;
  for step in 1..rounds loop
    if bracket->'revealAtMs'->(step-1) is distinct from to_jsonb(starts+(4800000::bigint*step+rounds)/(rounds+1)) then return false; end if;
  end loop;
  -- Entries in rank order, each a bracket entrant exactly once with its frozen activity, rating and fighter.
  ranked:=array_fill(null::text,array[n]);
  for e,r in select value,ordinality::integer from jsonb_array_elements(bracket->'entries') with ordinality loop
    if jsonb_typeof(e) is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(e) k) is distinct from array['activityId','fighter','gladiatorId','rank','rating']
      or jsonb_typeof(e->'gladiatorId') is distinct from 'string' or e->'rank' is distinct from to_jsonb(r) then return false; end if;
    gid:=e->>'gladiatorId'; x:=entrants->gid;
    if x is null or seen ? gid or e->'activityId' is distinct from x->'activityId' or e->'rating' is distinct from x->'rating'
      or e->'fighter' is distinct from x->'fighter' then return false; end if;
    ranked[r]:=gid; seen:=seen||jsonb_build_object(gid,true);
  end loop;
  -- Standard seeding positions: the ranks beyond n are empty slots, so the byes go to the top ranks, spread apart.
  while cardinality(seats)<size loop
    grown:='{}';
    foreach v in array seats loop grown:=grown||v||(2*cardinality(seats)+1-v); end loop;
    seats:=grown;
  end loop;
  for o in select value from jsonb_array_elements(bracket->'bouts') loop
    if jsonb_typeof(o) is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(o) k)
        is distinct from array['battleId','bye','id','parentBoutIds','placed','position','result','revealAtMs','round']
      or not private.safe_integer(o->'round',1) or not private.safe_integer(o->'position') then return false; end if;
    if (o->>'round')::numeric>rounds or (o->>'position')::numeric>=size then return false; end if;
    r:=(o->>'round')::integer; p:=(o->>'position')::integer;
    bout_id:=tid||':'||r||':'||p;
    if p>=size>>r or o->'id' is distinct from to_jsonb(bout_id) or o->'battleId' is distinct from to_jsonb(bout_id) or bouts ? bout_id
      or o->'revealAtMs' is distinct from bracket->'revealAtMs'->(r-1) then return false; end if;
    if r=1 then
      a:=ranked[seats[2*p+1]]; c:=ranked[seats[2*p+2]];
      -- PL/pgSQL ends an IF condition at its first THEN, so a bye's due result is computed first.
      due:=case when a is null or c is null then jsonb_build_object('winnerId',coalesce(a,c),'loserId',null,'log',null) else 'null'::jsonb end;
      if o->'parentBoutIds' is distinct from '[]'::jsonb or o->'placed' is distinct from jsonb_build_array(a,c)
        or o->'bye' is distinct from to_jsonb(a is null or c is null) or o->'result' is distinct from due then return false; end if;
    elsif o->'parentBoutIds' is distinct from jsonb_build_array(tid||':'||(r-1)||':'||(2*p),tid||':'||(r-1)||':'||(2*p+1))
      or o->'placed' is distinct from 'null'::jsonb or o->'bye' is distinct from 'false'::jsonb or o->'result' is distinct from 'null'::jsonb then
      return false;
    end if;
    bouts:=bouts||jsonb_build_object(bout_id,true);
  end loop;
  return true;
end $$;

-- Completion of a pairing job (called by complete_job under the current lease). Since Task 19 a pairing input carries its
-- league's tournament candidates, and the result their routes and the league's bracket (exceptions 1 and 5). Fails closed
-- unless every Arena request is routed once against its frozen state, the bracket holds exactly its bracket entrants and
-- every other Arena entrant is assigned exactly once; only then writes the assignments, the bracket and its seeds.
create or replace function private.accept_pairing(job uuid,result jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; frozen jsonb; expected jsonb; bracketed jsonb:='{}'::jsonb; routed jsonb:='{}'::jsonb; seen jsonb:='{}'::jsonb;
  e jsonb; s jsonb; x jsonb; r jsonb; gid text; human boolean; keys text[]; sides integer; league_id text; season bigint;
  now_ms bigint:=private.planning_now_ms(); partitioned boolean; bracket jsonb; tid text;
begin
  select * into j from private.jobs where id=job;
  partitioned:=j.input ? 'tournament';
  keys:=case when partitioned then array['assignments','tournament'] else array['assignments'] end;
  if j.kind is distinct from 'pair' or jsonb_typeof(result) is distinct from 'object' or jsonb_typeof(result->'assignments') is distinct from 'array'
    or (select array_agg(k order by k collate "C") from jsonb_object_keys(result) k) is distinct from keys then return false; end if;
  league_id:=j.input->>'league';
  season:=private.season_index(j.slot_index);
  if season is null or j.input->>'seasonId' is distinct from season::text then return false; end if;
  -- The frozen values of every Arena request of this slot and league: resolved Arena, or Rest by step 6.
  select coalesce(jsonb_object_agg(a.gladiator_id::text,jsonb_build_object('activityId',a.id,'kind',a.resolved_kind,
      'rating',sn.snapshot->'starting'->'rating','strength',p.result->'arenaStrength','fighter',p.result->'arenaFighter','npc',p.result->'npcTemplate',
      'costs',sn.snapshot->'costs')),'{}'::jsonb) into frozen
    from public.activities a join private.activity_snapshots sn on sn.activity_id=a.id
    join private.jobs p on p.dedupe_key='prepare:'||a.slot_index||':'||a.gladiator_id and p.status='completed'
    where a.slot_index=j.slot_index and a.status='preparing' and a.requested->>'kind'='arena' and a.resolved_kind in ('arena','rest')
      and sn.snapshot->'starting'->>'league'=league_id;
  select coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb) into expected from jsonb_each(frozen) f where f.value->>'kind'='arena';
  if partitioned then
    if jsonb_typeof(result->'tournament') is distinct from 'object'
      or (select array_agg(k order by k collate "C") from jsonb_object_keys(result->'tournament') k) is distinct from array['bracket','routes']
      or jsonb_typeof(result->'tournament'->'routes') is distinct from 'array' then return false; end if;
    for r in select value from jsonb_array_elements(result->'tournament'->'routes') loop
      if jsonb_typeof(r) is distinct from 'object'
        or (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k)
          is distinct from array['activityId','gladiatorId','league','reason','route','staminaDebit']
        or jsonb_typeof(r->'gladiatorId') is distinct from 'string' then return false; end if;
      gid:=r->>'gladiatorId'; x:=frozen->gid;
      if x is null or routed ? gid or r->'activityId' is distinct from x->'activityId' or r->'league' is distinct from to_jsonb(league_id)
        or (x->>'kind'='rest') is distinct from (r->>'route'='rest') then return false; end if;
      -- Rest is exactly step 6's fallback at no cost; a bracket costs the frozen tournament price, regular Arena the Arena price.
      if not coalesce((r->>'route'='rest' and r->'reason'='"insufficient-stamina"'::jsonb and r->'staminaDebit'='0'::jsonb)
          or (r->>'route'='tournament' and r->'reason'='"bracket"'::jsonb and r->'staminaDebit'=x->'costs'->'tournament')
          or (r->>'route'='arena' and r->>'reason' in ('not-tournament-slot','opted-out','insufficient-stamina','too-few-entrants')
            and r->'staminaDebit'=x->'costs'->'arena'),false) then return false; end if;
      routed:=routed||jsonb_build_object(gid,true);
      if r->>'route'='tournament' then
        bracketed:=bracketed||jsonb_build_object(gid,jsonb_build_object('activityId',x->'activityId','rating',x->'rating','fighter',x->'fighter'));
        expected:=expected-gid;
      end if;
    end loop;
    if (select count(*) from jsonb_object_keys(routed))<>(select count(*) from jsonb_object_keys(frozen)) then return false; end if;
    bracket:=result->'tournament'->'bracket';
    if not private.valid_bracket(j.id,bracket,bracketed) then return false; end if;
  end if;
  for e in select value from jsonb_array_elements(result->'assignments') loop
    if jsonb_typeof(e) is distinct from 'object' or e->'kind' is null or e->'kind' not in ('"human"'::jsonb,'"npc"'::jsonb)
      or jsonb_typeof(e->'sides') is distinct from 'array' then return false; end if;
    human:=e->>'kind'='human';
    -- PL/pgSQL ends an IF condition at its first THEN, so the kind-dependent shape is computed first.
    keys:=case when human then array['battleId','kind','league','seasonId','sides','slotIndex']
      else array['battleId','kind','league','opponent','seasonId','sides','slotIndex'] end;
    sides:=case when human then 2 else 1 end;
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(e) k) is distinct from keys
      or e->'slotIndex' is distinct from to_jsonb(j.slot_index) or e->'league' is distinct from to_jsonb(league_id)
      or e->'seasonId' is distinct from to_jsonb(season::text) or jsonb_array_length(e->'sides')<>sides then return false; end if;
    for s in select value from jsonb_array_elements(e->'sides') loop
      if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'gladiatorId') is distinct from 'string'
        or (select array_agg(k order by k collate "C") from jsonb_object_keys(s) k) is distinct from array['activityId','fighter','gladiatorId','rating','strength']
        then return false; end if;
      gid:=s->>'gladiatorId';
      x:=expected->gid;
      if x is null or seen ? gid or s->'activityId' is distinct from x->'activityId' or s->'rating' is distinct from x->'rating'
        or s->'strength' is distinct from x->'strength' or s->'fighter' is distinct from x->'fighter' then return false; end if;
      seen:=seen||jsonb_build_object(gid,true);
    end loop;
    if human then
      if e->'battleId' is distinct from to_jsonb('arena:'||j.slot_index||':'||(e->'sides'->0->>'gladiatorId')||':'||(e->'sides'->1->>'gladiatorId')) then
        return false;
      end if;
    else
      gid:=e->'sides'->0->>'gladiatorId';
      if e->'battleId' is distinct from to_jsonb('arena:'||j.slot_index||':'||gid||':npc') or jsonb_typeof(e->'opponent') is distinct from 'object' then
        return false;
      end if;
      if (select array_agg(k order by k collate "C") from jsonb_object_keys(e->'opponent') k) is distinct from array['id','snapshot']
        or e->'opponent'->'id' is distinct from to_jsonb('npc:'||gid) or e->'opponent'->'snapshot' is distinct from expected->gid->'npc' then
        return false;
      end if;
    end if;
  end loop;
  -- Complete: every regular-Arena entrant appeared, each exactly once (duplicates were refused above).
  if (select count(*) from jsonb_object_keys(seen))<>(select count(*) from jsonb_object_keys(expected)) then return false; end if;
  for e in select value from jsonb_array_elements(result->'assignments') loop
    insert into private.arena_assignments(battle_id,pairing_job_id,slot_index,league,season_index,kind,seed,assignment,created_at_ms)
      values(e->>'battleId',j.id,j.slot_index,league_id,season,e->>'kind',
        encode(extensions.digest(j.seed||':'||(e->>'battleId'),'sha256'),'hex'),e,now_ms);
    insert into private.arena_assignment_sides(activity_id,battle_id,side)
      select (side.value->>'activityId')::uuid,e->>'battleId',(side.ordinality-1)::smallint
      from jsonb_array_elements(e->'sides') with ordinality side(value,ordinality);
  end loop;
  if jsonb_typeof(bracket)='object' then
    tid:=bracket->>'id';
    insert into private.tournaments(id,pairing_job_id,slot_index,league,season_index,rules_version,starts_at_ms,settles_at_ms,size,rounds,reveal_at_ms,created_at_ms)
      values(tid,j.id,j.slot_index,league_id,season,j.rules_version,(bracket->>'startsAtMs')::bigint,(bracket->>'settlesAtMs')::bigint,
        (bracket->>'size')::integer,(bracket->>'rounds')::integer,bracket->'revealAtMs',now_ms);
    -- The display name is frozen with the entry: every bout log of the tournament carries the same names (decision 7).
    insert into private.tournament_entries(tournament_id,gladiator_id,activity_id,rank,rating,fighter,name)
      select tid,(t.value->>'gladiatorId')::uuid,(t.value->>'activityId')::uuid,(t.value->>'rank')::integer,(t.value->>'rating')::bigint,t.value->'fighter',g.name
      from jsonb_array_elements(bracket->'entries') t join public.gladiators g on g.id=(t.value->>'gladiatorId')::uuid;
    insert into private.tournament_bouts(id,tournament_id,round,position,parent_bout_ids,placed,bye,reveal_at_ms,seed,result)
      select o.value->>'id',tid,(o.value->>'round')::integer,(o.value->>'position')::integer,o.value->'parentBoutIds',nullif(o.value->'placed','null'::jsonb),
        (o.value->>'bye')::boolean,(o.value->>'revealAtMs')::bigint,
        case when (o.value->>'bye')::boolean then null else encode(extensions.digest(j.seed||':'||(o.value->>'id'),'sha256'),'hex') end,
        nullif(o.value->'result','null'::jsonb)
      from jsonb_array_elements(bracket->'bouts') o;
  end if;
  return true;
end $$;

-- The stored private graph of one tournament, shaped as the domain's TournamentGraph (entries in rank order, bouts in round
-- then position order, every stored result), with no seed. Backend-only; read under a job fence.
create or replace function private.tournament_graph(tournament text) returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',t.id,'seasonId',t.season_index::text,'league',t.league,'slotIndex',t.slot_index,'rulesVersion',t.rules_version,
    'startsAtMs',t.starts_at_ms,'settlesAtMs',t.settles_at_ms,'size',t.size,'rounds',t.rounds,'revealAtMs',t.reveal_at_ms,
    'entries',(select jsonb_agg(jsonb_build_object('gladiatorId',e.gladiator_id,'activityId',e.activity_id,'rating',e.rating,'fighter',e.fighter,
      'rank',e.rank) order by e.rank) from private.tournament_entries e where e.tournament_id=t.id),
    'bouts',(select jsonb_agg(jsonb_build_object('id',o.id,'battleId',o.id,'round',o.round,'position',o.position,'parentBoutIds',o.parent_bout_ids,
      'placed',o.placed,'bye',o.bye,'revealAtMs',o.reveal_at_ms,'result',o.result) order by o.round,o.position) from private.tournament_bouts o where o.tournament_id=t.id))
  from private.tournaments t where t.id=tournament
$$;

-- The fenced read of a bout job's tournament (exception 4's child input): the job row is locked first and its token,
-- leased status and expiry checked against database time sampled after that lock, then its due time and dependencies.
-- Returns the stored graph with every stored result and the frozen names; never a seed (the lease carries its own).
create or replace function public.tournament_bout_input(job_id uuid,lease_token uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j private.jobs%rowtype; now_ms bigint; tid text;
begin
  if tournament_bout_input.job_id is null or tournament_bout_input.lease_token is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  select * into j from private.jobs where id=tournament_bout_input.job_id for update;
  now_ms:=private.planning_now_ms();
  if not found then return jsonb_build_object('ok',false,'code','not-found'); end if;
  if j.kind<>'simulation' or j.input->>'kind' is distinct from 'tournament-bout' or j.dedupe_key is distinct from 'tournament-bout:'||(j.input->>'boutId') then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  if j.status<>'leased' or j.lease_token is distinct from tournament_bout_input.lease_token or j.lease_until_ms<=now_ms then
    return jsonb_build_object('ok',false,'code','conflict');
  end if;
  if j.due_at_ms>now_ms or not private.dependencies_ready(j.id) then return jsonb_build_object('ok',false,'code','processing'); end if;
  select o.tournament_id into tid from private.tournament_bouts o where o.id=j.input->>'boutId' and o.tournament_id=j.input->>'tournamentId' and not o.bye;
  if tid is null then return jsonb_build_object('ok',false,'code','invalid'); end if;
  return jsonb_build_object('ok',true,'graph',private.tournament_graph(tid),
    'names',(select jsonb_object_agg(e.gladiator_id::text,e.name) from private.tournament_entries e where e.tournament_id=tid));
end $$;

create or replace function private.activity_executor_ready(kind text) returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(kind in ('training','rest','expedition','arena','tournament'),false)
$$;

-- Phase 8: the activity's private jobs. Tournament (exception 4): the rank-1 entrant's call creates every fought bout's
-- simulation job, in round order so parents exist first, with its parent dependencies; every entrant's settlement job
-- waits for every bout job. Task 16's Arena and Task 9's Expedition branches are unchanged.
create or replace function private.prepare_activity_jobs(activity uuid) returns void language plpgsql security invoker set search_path='' as $$
declare a public.activities%rowtype; s private.activity_snapshots%rowtype; simulation uuid; terminal uuid; reveal uuid;
  seat private.arena_assignment_sides%rowtype; x private.arena_assignments%rowtype; entry private.tournament_entries%rowtype;
  t private.tournaments%rowtype; bout private.tournament_bouts%rowtype;
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
      end loop;
    end if;
    -- This entrant's settlement (and, from rank 1, every entrant's settlement created so far) waits for every bout job.
    insert into private.job_dependencies(job_id,prerequisite_id)
      select st.id,bj.id from private.tournament_entries te join private.jobs st on st.dedupe_key='settlement:'||te.activity_id
      join private.tournament_bouts tb on tb.tournament_id=te.tournament_id and not tb.bye
      join private.jobs bj on bj.dedupe_key='tournament-bout:'||tb.id
      where te.tournament_id=t.id and (entry.rank=1 or te.activity_id=a.id)
      on conflict do nothing;
  end if;
end $$;

revoke all on function private.guard_tournament_bout(),public.set_tournament_opt_in(uuid,uuid,jsonb),private.pairing_input(bigint,text,bigint,text),
  private.boundary_pair(bigint),private.valid_bracket(uuid,jsonb,jsonb),private.accept_pairing(uuid,jsonb),private.tournament_graph(text),
  public.tournament_bout_input(uuid,uuid),private.activity_executor_ready(text),private.prepare_activity_jobs(uuid)
  from public,anon,authenticated;
grant execute on function private.guard_tournament_bout(),public.set_tournament_opt_in(uuid,uuid,jsonb),private.pairing_input(bigint,text,bigint,text),
  private.boundary_pair(bigint),private.valid_bracket(uuid,jsonb,jsonb),private.accept_pairing(uuid,jsonb),private.tournament_graph(text),
  public.tournament_bout_input(uuid,uuid),private.activity_executor_ready(text),private.prepare_activity_jobs(uuid)
  to service_role;
notify pgrst,'reload schema';
commit;
