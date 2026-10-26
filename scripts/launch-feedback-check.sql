-- Launch feedback deploy check (M23; docs/operations/runbook.md, "Exception: the launch feedback rules changed in place").
-- READ-ONLY: one SELECT returning one row; it writes nothing and sets nothing, so `supabase db query --linked --file` (one
-- statement) and the hosted SQL editor both run it as the database owner. Run it right before `db push` and again after the
-- functions deploy. Every column but the all-time count must be 0; otherwise stop and ask Avi (the runbook gives the remedy).
-- Columns, each a count:
--   arena_pickable_outside_evening           morning or afternoon Arena a boundary can still pick, by the rules of M23's
--                                            backfill (the marked span in supabase/sql/16-launch-feedback.sql): per character
--                                            and part, the revision its next boundary (processed slot + 1) picks, latest
--                                            effective slot then latest version, when it is Arena; plus each later Arena
--                                            revision (effective after processed slot + 1) that no higher version at its own
--                                            effective slot overrides
--   arena_in_saved_schedule_outside_evening  morning and afternoon parts of the latest plan (public.schedules) holding Arena
--   arena_revisions_outside_evening_all_time information only: every morning or afternoon Arena revision ever written. The
--                                            backfill adds Rest revisions and removes none, so this never drops to 0
--   open_listings_below_2                    open Marketplace listings below M23's lowest price
--   tournaments_formed                       tournaments ever formed
--   open_boundary                            boundaries not complete
-- tests/db/launch-feedback-backfill.test.ts runs it in a read-only transaction, and over seeded Arena before and after the
-- backfill span.
select
  (select count(*) from public.gladiators g
     cross join lateral (
       select distinct on (r.phase) r.choice from public.schedule_revisions r
       where r.gladiator_id = g.id and r.phase in ('morning', 'afternoon') and r.effective_slot_index <= g.processed_slot_index + 1
       order by r.phase, r.effective_slot_index desc, r.version desc) c
     where c.choice ->> 'kind' = 'arena')
  + (select count(*) from public.schedule_revisions f join public.gladiators g on g.id = f.gladiator_id
     where f.phase in ('morning', 'afternoon') and f.choice ->> 'kind' = 'arena' and f.effective_slot_index > g.processed_slot_index + 1
       and not exists (select 1 from public.schedule_revisions o where o.gladiator_id = f.gladiator_id and o.phase = f.phase
         and o.effective_slot_index = f.effective_slot_index and o.version > f.version)) as arena_pickable_outside_evening,
  (select count(*) from public.schedules y cross join unnest(array['morning', 'afternoon']) k(phase)
     where y.schedule -> k.phase ->> 'kind' = 'arena') as arena_in_saved_schedule_outside_evening,
  (select count(*) from public.schedule_revisions r
     where r.phase in ('morning', 'afternoon') and r.choice ->> 'kind' = 'arena') as arena_revisions_outside_evening_all_time,
  (select count(*) from private.market_listings l where l.status = 'open' and l.price < 2) as open_listings_below_2,
  (select count(*) from private.tournaments) as tournaments_formed,
  (select count(*) from private.boundaries b where b.status <> 'complete') as open_boundary;
