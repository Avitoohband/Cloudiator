# Task 22.2 report: robust ticks, season rows and recovery

Branch `claude/task-22` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `8faf0c4`. Brief:
`.superpowers/sdd/2026-10-18-task-22-retention-operations/task-22.2-brief.md`.

Commits:
- `782facc` feat: keep ticks durable and seasons whole during recovery
- `7e1d272` test: tighten the Task 22.1 retention cases (review minors M1–M5)
- `f16c377` test: sweep past a failing seller between two sound ones (self-review fix)

## What was implemented

`supabase/sql/14-operations.sql` (reapplicable source, no migration: M16 is Task 22.3). It was applied to the local stack with
the psql fallback after the container label `com.supabase.cli.project=Cloudiator` was confirmed:
`docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < supabase/sql/14-operations.sql`
(exit 0). The header gains exceptions 6 and 7.

**Decision 6, durable ticks.**
- `private.expire_listings(now_ms)` is 12-market.sql's body. Only these parts changed:
  - each seller's listing loop runs in its own `begin … exception` block;
  - the account try-lock stays outside that block, so it still never waits;
  - a failure rolls back only that seller's work and counts it;
  - after the loop, a sweep with any failure inserts one `operations_events` row: `source 'market-sweep'`, `ok false`, the
    first failure's SQLSTATE, and detail `{"failedSellers": n}`. No message and no id is kept.
- `cleanup_history`'s backstop call benefits with no change of its own: a single inconsistent listing no longer fails the
  whole cleanup call. This is tested.
- `private.cron_tick()` is 12-market.sql's body. Only the dispatch changed:
  - `dispatch_workers()` runs in its own block;
  - a failure returns `dispatch: {ok:false, code:'dispatch-failed', sqlstate}` and inserts a `dispatch` event (SQLSTATE only,
    `at_ms` = database time);
  - the coordination and the sweep committed by the same tick are kept.
- The ACLs are restated: both functions are revoked from `public`, `anon`, `authenticated` and `service_role`, as in
  12-market.sql.

**Decision 7, whole seasons.**
- `private.season_bounds(index bigint) returns table(starts_at_ms bigint, ends_at_ms bigint)`:
  - the bounds are `(epoch + 504·index)·4800000` and `(epoch + 504·(index+1))·4800000`;
  - no row without an epoch or for a negative index;
  - it is **STABLE**, not immutable, because it reads `private.season_epoch` (as the controller's clarification allows);
  - its search_path is pinned; it is revoked from `public`, `anon` and `authenticated` and granted to `service_role`, which
    runs the boundary.
- Phase 2 (`private.boundary_close_season`, the body from 13-seasons.sql) now takes its own season row's bounds from
  `season_bounds`. The unused `first_slot` variable is gone.
- Phase 4 (`private.boundary_recompute_leagues`, the body from 07-arena.sql:186-208) gains one statement after its `'epoch'`
  check: `insert into public.seasons … select season, b.* from private.season_bounds(season) b on conflict do nothing`.
  - The season it rates therefore has its row even when the epoch was set while the boundary waited at phase 4. This removes
    M15's known limit.
  - The insert runs under advance_boundary's coordinator and boundary locks, before any account lock. That is the close's
    order: season row, then accounts.
- The season row backfill (M15's, now through `season_bounds`) is a reapplicable statement in the source, marked
  `-- Season row backfill (Decision 7)`. A generated migration omits it, so it is added to the M16 completion list.
- Diffs of every replaced body against its latest source show only these changes (checked with `diff`).

**Review minors from Task 22.1:**
- **M1:** the account-lock case now holds a due listing of the busy owner. The test asserts a fast return, `market.expired = 0`
  and the listing still open. A free-lock control expires the same listing (`expired = 1`).
- **M2:** the cron contention case commits a fabricated run row (runid −1000003, `end_time` 1970) and asserts that the holder
  locked it. The row is deleted in `finally`.
- **M3:** an `afterAll` calls `resetIdentity()` before `sql.end()`.
- **M4:** `resetIdentity` reseeds the singleton with `insert … values(true,-1,-1,null,null) on conflict (singleton) do
  update …`.
- **M5:** the RPC probes are labelled as exposure checks.

**Docs.** `docs/operations/migrations.md` gains a "Task 22.2" paragraph in the M16 draft section, and the backfill is added to
the expected draft completions.

## The recovery tests (`tests/db/recovery.test.ts`)

**The world, built once.**
- Four characters made by real creation, then placed at checkpoint 999: two Arena fighters, one expedition fighter and one
  trainee.
- Three listings made through the real `create_listing` at session-clock times. Two expire during the pause, at slots 1010
  and 1020. One does not expire before both catch-ups (slot 1125).

**The pause.** No tick and no coordination run for 37 boundaries (1000–1036; two days are 36 slots).

**Catch-up** = what the resumed scheduler does, round after round:
1. one `private.cron_tick()` with the scheduler enabled only inside its own transaction, so the real pg_cron run stays inert;
2. one real `runWorker` invocation over the real worker adapter (`createWorkerDatabase(admin)`).

The two clocks:
- The coordinator calls (the tick's, and the worker's `coordinate`, as `service_role`) read "the present" from the session
  clock stand-in (`withClock`: captured `pg_get_functiondef`, restored, byte-equal check).
- Claims, executions and settlements run on the real clock, which is already past every 1970 slot.

Guards on the run:
- `beforeAll` asserts that no Vault worker secret exists, so a tick never invokes a real worker coordinating at real time.
- Every tick asserts `dispatch.reason = 'unconfigured'`.
- Each coordination report (at most six boundaries, none failed) and each worker report (no failures, conflicts or unrecorded
  jobs) is checked.

The measured run: 37 boundaries in 342 rounds and 1114 coordination calls. Activities: 60 Arena (30 human battles),
28 expedition, 31 training and 29 rest. 88 financial settlements. Season 1 closed at boundary 1008, with 4 archive rows and
2 awards.

| Test | Proves |
|---|---|
| catches up a service paused for two days … | Boundaries completed exactly once, in order: the reports and the boundary rows equal 1000..1036. One settled activity and its `settled_slots` row per (character, slot), 148 of them. Settlement order: each slot's first `settled_at_ms` ≥ the previous slot's last. One settlement receipt per activity and exactly one ledger row per receipt. Wallets reconcile. Season 1 is closed at the present and season 2 opened, both with `seasonAt` bounds; at most one award per character and season. A further round, a replayed boundary (`replayed: true`) and a lost-response settlement retry (`newGrants: 0, replayed: true`) leave the whole grant state unchanged. |
| sweeps listings that expired during the pause once … | The first tick expired exactly 2 listings and no later tick expired any. Both are `expired` with no receipt, buyer or offer. Each item is the same single row with its seller, released, otherwise unchanged. The fresh listing stays open, offered and reserved. A further sweep expires 0. |
| keeps everything catch-up still needs when cleanup runs in the middle … | A second 37-slot pause. When the catch-up published 1056, cleanup ran to completion at real database time, committed, 13 calls. Both watermarks reached 1037 = P−19 with no `blockedSlot`. The detail of 1000–1037 is gone (688 jobs, 418 stages, 152 activities, 38 boundaries …) and every settlement receipt of those slots is compacted. Unchanged: the detail of 1038–1073 (pairing history included), every unfinished job, activity and boundary, and the grant state. Catch-up then completed 1037–1073 in order. 296 `settled_slots` rows (4 × 74). Ledger one row per receipt; wallets reconcile. |
| returns the stored receipt for a command retried after ninety days … | Real commands at real time: a shop purchase (sword, 40), then a queued build applied by `apply_pending_build`, which consumes its reservation. In a rollback-only transaction at real time + 91 days: the ledger folds into a checkpoint equal to the wallet over 3 rows, the consumed reservation is deleted, and the receipts are unchanged. The same operations, retried with the backend's preparation of the current state, return the stored results; changed payloads return `conflict`. No grant changes and the wallets reconcile. |
| records a market-sweep failure for one seller … | An inconsistent due listing (item gone) of the seller that sorts between two sound sellers. The sweep returns 2, both sound items are released, the failing seller's listing stays open, and one event `{market-sweep, false, P0001, {failedSellers:1}}` is written. Then, with a second failing seller added, `cleanup_history` succeeds (`market.expired 1`) and writes one event with `failedSellers: 2`. |
| keeps the committed coordination when dispatch fails in the same tick | A second session holds `dispatch_workers`' advisory lock; the tick runs in its own transaction with `lock_timeout` 200 ms. The tick returns ok: its coordination opened boundary 1074 (waiting for preparation), its expiry is ok and dispatch failed with 55P03. Read back from another session: the boundary, its 4 prepare jobs and the `dispatch` event (SQLSTATE only). The next rounds complete boundary 1074. |
| creates a season row in phase 4 when the epoch is set … | In a rollback-only transaction, the epoch is removed with TRUNCATE (no trigger disabled). Boundary 3000 runs phase 2 without a season, then waits at phase 4 with `'epoch'` and no season-5 row. Once the epoch is inserted, phase 4 rates season 5 and inserts its row with `seasonAt(3000, 0)`'s bounds. |
| derives phase 2, the backfill and phase 4 season bounds from season_bounds | The values match `seasonAt` for indexes 0, 1, 2 and 7 at epoch 0, and for epoch 10. There is no row for −1 or without an epoch. The function is STABLE with search_path pinned, and only `service_role` may execute it. A rollback-only stand-in shifts every season by one slot; then phase 2, the backfill (the statement read from the source by its marker) and phase 4 all write the shifted bounds. The definition is byte-equal afterwards. |

## Deviations and interpretations

1. **"Nothing at or above P−19 is touched"** (controller clarification). By Decision 2, `H = least(P−19, …)` and slots at or
   below H are pruned, so slot P−19 itself is prunable. That also matches the Review Focus: "slots at or below the checkpoint
   minus 19". The test therefore proves that nothing **above** P−19 (from P−18 up) and nothing unfinished is touched.
2. **Event granularity.**
   - The sweep writes one `market-sweep` event per sweep with failures, holding the first failure's SQLSTATE and
     `failedSellers: n`. It does not write one event per seller.
   - A `dispatch` event is written only on failure, with a null detail. A per-minute success row would add 1,440 rows a day.
3. **The retry case uses real-time commands**, not commands at an old session time.
   - `wallet_ledger.created_at` and `operation_receipts.created_at` are real `clock_timestamp()` values. Only a cleanup at
     real time + 90 days or later folds their ledger rows and deletes their reservation.
   - The cleanup and the retries therefore run at real time + 91 days, in a rollback-only transaction.
   - The build is a stance change (fee 0): a new character's 100 money cannot pay both a purchase and the 100 class-change fee.
     The consumed reservation still exercises the 90-day reservation prune.
4. **Catch-up mixes two clocks.** The coordinator runs at the pinned present; settlement runs on the real clock. The worker
   therefore also settles the present slot's activities, whose 1970 end is past on the real clock, so each catch-up ends with
   every activity settled.
   - `runWorker` is given `cpuNow: () => 0`, so an invocation never defers a claimed job. Deferral would leave a lease to
     expire for 120 s; compute budgeting is covered by the worker tests.
5. **The dispatch failure is a real lock timeout.** It is injected by holding the dispatch advisory lock, with no function
   stand-in. The tick commits for real, and the test then finishes that slot, so the world stays consistent.
6. **The backfill test reads the statement from the source** by its marker comment. Task 22.3 must keep the marker, and M16
   must carry the statement.
7. **`13-seasons.sql`'s header is unchanged.** It is already qualified ("when the epoch is set before the first boundary with
   members", Task 21's final fix wave), so it does not overstate the limit.
8. **`docs/operations/migrations.md` was updated** although the brief's file list does not name it. 22.3 needs the backfill on
   its completion list.

## Tests and results

Every `npm run test:db` run was made with nothing else building, browsing or editing this worktree. The Edge runtime serves
`C:\Avi\Studies\Projects\Cloudiator-claude\supabase\functions` (mount checked). Its start time was read with
`docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after each run.

| Run | Command | Result | Edge StartedAt before | after |
|---|---|---|---|---|
| RED 1 | `npm run test:db -- tests/db/recovery.test.ts` (before the source change) | 5 failed, 3 passed: the four new-behaviour cases, plus the retry case's own setup bug (a renown purchase a new character cannot afford) | 2026-10-18T17:33:56.719839151Z | 2026-10-18T17:33:56.719839151Z |
| RED 2 | same, retry setup fixed | **4 failed, 4 passed** | 2026-10-18T17:33:56.719839151Z | 2026-10-18T17:33:56.719839151Z |
| GREEN | same, after applying the source | **8/8** | 2026-10-18T17:33:56.719839151Z | 2026-10-18T17:33:56.719839151Z |
| targeted | recovery + retention + market (with M1–M5) | 41/41, 3 files | 2026-10-18T17:33:56.719839151Z | 2026-10-18T17:33:56.719839151Z |
| verbose | recovery (statistics above) | 8/8 | 2026-10-18T17:33:56.719839151Z | 2026-10-18T17:33:56.719839151Z |
| full 1 | `npm run test:db` | 243/243: **discarded**, Edge recreated during the run | 2026-10-18T17:40:27.894364101Z | 2026-10-18T17:43:48.122198771Z |
| full 2 | `npm run test:db` | 243/243: **discarded**, Edge recreated during the run | 2026-10-18T17:43:48.122198771Z | 2026-10-18T17:45:45.524770075Z |
| full 3 | `npm run test:db` | **243/243, 13 files** (195.0 s), valid | 2026-10-18T17:47:40.504540918Z | 2026-10-18T17:47:40.504540918Z |
| after self-review fix | recovery | 8/8 | 2026-10-18T17:53:21.067836341Z | 2026-10-18T17:53:21.067836341Z |
| full 4 (final) | `npm run test:db` | **243/243, 13 files** (196.9 s), valid | 2026-10-18T17:53:21.067836341Z | 2026-10-18T17:53:21.067836341Z |

**RED evidence (RED 2).** The four new-behaviour cases failed for the missing feature:
- market sweep: `PostgresError: listed item missing` (P0001), raised by `expire_listings` at the inconsistent listing;
- dispatch: `canceling statement due to lock timeout`, raised by `cron_tick` itself, so the whole tick rolled back;
- phase 4: the expected season-5 row was missing (`[]`);
- season_bounds: `function private.season_bounds(unknown) does not exist`.

The catch-up, sweep, mid-catch-up cleanup and retry cases passed on the old functions. They are regression coverage of
existing behaviour and of 22.1's cleanup.

**Other gates:**
- `npm test`: 1056/1056, 47 files.
- `npm run typecheck`: `tsc`, `deno check --frozen` and the Deno Edge smoke test (2/2) passed. `npx tsc --noEmit` passed again
  after the last test change.
- `npx supabase db lint --local --schema public,private --fail-on warning`: no schema errors.
- `npx supabase db advisors --local --type all --level info`: the same 4 INFO unused-index notices as 22.1 (`jobs_gladiator_idx`,
  two market indexes, `operations_events_time_idx`). No warnings or errors.
- `git diff --check`: clean.

**After the runs:**
- `planning_now_ms` contains no `test_now_ms`, and `season_bounds` is the source definition.
- No `public` or `private` trigger is disabled.
- The scheduler is off and the epoch is 0.
- No fabricated (negative) cron run row and no Vault worker secret remains.
- `afterAll` resets the world.

## Self-review

- **Fixed (`f16c377`).** The sweep case first used two failing sellers and one sound seller, in random id order, so it did not
  prove that the sweep continues *past* a failure. The failing seller now sorts between two sound sellers
  (`failedSellers: 1`). The cleanup backstop part adds a second failing seller (`failedSellers: 2`).
- **Checked:**
  - each replaced body against its latest source (only the intended lines differ);
  - the ACLs restated for M16;
  - the phase-4 insert's lock position (before the account locks, as in the close);
  - `season_bounds` matching `private.season_index` and `seasonAt`.
- **The pairing window survives a mid-catch-up cleanup.** The next boundary reads arena assignments from target−18 ≥ P−17. The
  unchanged-detail snapshot of 1038–1073, which includes those assignments, shows they were kept, and catch-up then paired and
  settled every later slot.
- **Committed side effects of the mid-catch-up cleanup** (test 3, real time) on this local stack, as the hourly tick would
  produce them: it pruned `cron.job_run_details` older than 7 days, `dispatch_log` older than 48 hours and `command_attempts`
  older than 1 hour. Its market backstop also expired the fresh listing, now due at real time, and deleted the three terminal
  1970 listings. Their items stay with their sellers, which the test asserts.

## Concerns

1. **Edge recreation.** The Edge container was recreated during two full DB runs (discarded and rerun, as the rule requires)
   and once during `npx tsc --noEmit`. No file under `supabase/functions` changed (checked with `find -newermt`). This matches
   the unconfirmed observation in `docs/operations/verification-gates.md`. The two valid full runs had unchanged start times.
2. **One subtransaction per due seller per sweep.** More than 64 XID-assigning subtransactions in one transaction overflow the
   subxid cache, which can slow concurrent snapshots. Sweeps run per minute over due sellers only, so this is acceptable at
   current scale; noted for 22.3's health view.
3. **Pre-existing limitation.** A seller with an inconsistent listing still cannot run their own market commands:
   `expire_seller_listings` raises inside the command. This is outside Decision 6. The new `market-sweep` event makes such a
   listing visible to the operator, and 22.3's health report could alert on it.
4. **`cron_tick`'s expiry block is unchanged.** It follows "change only these parts". A failure of the sweep as a whole (not
   per seller, for example a failure of the seller query itself) is still reported only in the tick's return value, with no
   event. PL/pgSQL `OTHERS` also does not trap `query_canceled` (57014), so a canceled tick records nothing.
5. **For Task 22.3 (M16):**
   - append the season row backfill (DML);
   - check the restated ACLs: `expire_listings` and `cron_tick` revoked from everyone; `season_bounds`,
     `boundary_close_season` and `boundary_recompute_leagues` executable by `service_role` only;
   - keep the backfill marker that `recovery.test.ts` reads.
