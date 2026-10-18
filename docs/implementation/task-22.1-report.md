# Task 22.1 report: retention in the database

Branch `claude/task-22` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `e5ea022`. Brief:
`.superpowers/sdd/2026-10-18-task-22-retention-operations/task-22.1-brief.md`.

Commits:
- `34dae0a` feat: prune replay detail and old summaries safely
- `0f7587d` test: bound the real-clock wait of the ledger fold case (self-review fix)

## What was implemented

`supabase/sql/14-operations.sql` (new, reapplicable). It was applied to the local stack with the psql fallback after the
container label `com.supabase.cli.project=Cloudiator` was confirmed. There is no migration: M16 is Task 22.3.

**State (Decision 3).** Three backend-only tables. RLS is on, and `service_role` may only SELECT them through a select policy:
- `private.retention_state` is a singleton. Its watermarks `detail_through_slot` and `summary_through_slot` are seeded at `-1`,
  with the check `summary ≤ detail`. It also holds `last_run_at_ms` and `last_result`.
- `private.wallet_checkpoints` has the columns from Decision 3. Its guard `private.guard_wallet_checkpoint` refuses a delete
  and any update that does not increase `ledger_rows`.
- `private.operations_events` has the columns from Decision 3. `source` is `market-sweep`, `dispatch` or `cleanup`; `sqlstate`
  must have the SQLSTATE shape. It is indexed on `at_ms`.

**Indexes.**
- `wallet_ledger(created_at)`, for the fold.
- A partial `activities(slot_index) where summary->'replayExpiry'->>'state'='available'`, so step 0 never scans expired
  summaries. Both are used by the planner (EXPLAIN checked).

**Guards.**
- `private.guard_receipt` runs BEFORE UPDATE OR DELETE on `public.operation_receipts`. It refuses every delete. It allows one
  update only:
  - only a receipt whose request kind is `activity-settlement`;
  - the key columns, `request`, `request_digest` and `created_at` unchanged;
  - a new result of exactly `{"compactedAtMs": <safe integer>}`;
  - only once.
- `private.guard_tournament_bout_result` replaces `guard_frozen` on `public.tournament_bout_results`. It allows exactly the
  `battleLog` → `fight {durationMs, victoryReason, tieBreakReason}` update; deletes stay allowed.

**Projection changes.**
- (a) `drop trigger project_changed_character on public.activity_stages`; `projection_changed` stays.
- (b) `private.project_character` is 13's body, unchanged except that the `recent_results` upsert first filters out rows that
  already match (anti-join). An unchanged row is neither written nor locked, and the resulting rows are those of the old
  upsert.

**`private.cleanup_history(now_ms bigint) returns jsonb`** follows Decisions 2 and 4 and the binding design, in the exact step
order of the clarifications:
- step 0, the flip (cap 300);
- the seven-day pass, steps (1)–(15), with three data slots and `blockedSlot`;
- the ninety-day pass, steps (1)–(8);
- the ledger fold in one statement (cap 5,000);
- reservations, then schedule revisions (cap 1,000 each);
- the market backstop, then terminal offers and listings (cap 1,000);
- the operational windows, with `cron.job_run_details` in its own `begin … exception` block.

It sets `lock_timeout` to 500 ms locally, locks the `retention_state` row first, and raises (22023) on a null or future
`now_ms`. Database time is sampled after that lock. The function returns the binding shape and stores it in `last_result`
and `last_run_at_ms`. EXECUTE is revoked from `public`, `anon`, `authenticated` and `service_role`.

**`private.cleanup_tick()`** (Decision 5) is inert while the scheduler is disabled. Otherwise it runs `cleanup_history` inside
a `begin … exception` block and inserts one `operations_events` row with `source 'cleanup'`. On success that row is ok, with
the result as its detail. On failure it is `ok=false` with the SQLSTATE only.
`select cron.schedule('cloudiator-cleanup','23 * * * *','select private.cleanup_tick()')` is in the source. pg_cron 1.6.4
upserts a job by name: tested inside a rolled-back transaction, and the same as M03's registration.

The other files:
- `tests/db/retention.test.ts` (new) has the 16 listed cases plus one for the Review Focus lock behavior.
- `tests/fixtures/db.ts` changes `resetIdentity` to truncate `private.operations_events` and `private.wallet_checkpoints`, and
  to reset the `retention_state` watermarks to `-1` and `last_*` to null. Its existing behavior is unchanged.
- `docs/operations/migrations.md` gains a draft M16 section: the contents, the completions to expect in Task 22.3, and the
  pg_net TTL.

## Where the code forced or justified a reading of the design

None of these contradicts the code. They are interpretations, or strict strengthenings, recorded for review.

1. **P when nothing is published.** SQL `least()` ignores nulls, so `least(published_slot, min(processed))` is null only
   when both are. The function treats P as null whenever `coordinator.published_slot` is null, and skips both slot passes.
   That is stricter: no slot history exists before the first publication.
2. **Seven-day step (1)** flips every still-`available` replay of A, without the `expiresAtMs ≤ now` predicate.
   - Every activity in R has `expiresAtMs = ends_at + 7 d ≤ now`, so in normal operation the two are identical (a no-op after
     step 0).
   - Dropping the predicate guarantees that no `available` summary outlives its detail, even for an anomalous summary.
   - Step (1) flips are added to `replay.flipped`.
3. **Schedule revisions.** A revision is deleted only when the newer revision of the same (gladiator, phase) is effective at
   or before `processed_slot_index+1`, **and** no earlier than the old one (`newer.effective_slot_index ≥
   old.effective_slot_index`). Phase 5 orders by effective slot first, then version. Without the second condition, an older
   revision with a later effective slot could still be the one a future boundary reads.
4. **Return shape.**
   - `publishedSlot` is the coordinator's published slot. A `checkpointSlot` (P) field is added.
   - `fromSlot` and `throughSlot` are null when the watermark did not move.
   - A call that only advances its watermark across empty slots reports that range, with zero deletions.
   - On failure, `retention_state` is not touched: the call rolled back. Only the tick's `operations_events` row records it.
5. **Order of the time-anchored steps** (the design gives none). Ledger, reservations and schedule revisions run first. Then
   `SET CONSTRAINTS ALL IMMEDIATE` fires every deferred projection trigger inside the call, under its lock budget. A trigger
   failure, or a 500 ms wait on `world_revision_state`, is therefore this call's failure and is caught by the tick. The hot
   revision row is held only for the call's tail. Then come the market and the operational steps.
6. **`command_attempts`** is selected `for update skip locked`, so cleanup never waits on rows a concurrent
   `consume_command_rate` is deleting.
7. **Guard functions** keep `service_role` EXECUTE, as every earlier guard does. Only `cleanup_history` and `cleanup_tick` are
   revoked from everyone.
8. **Two indexes not named in the design:** the partial replay index and `operations_events(at_ms)`.

## pg_net TTL finding

Local stack: pg_net **0.20.4**, pg_cron **1.6.4**, PostgreSQL 17.11. `current_setting('pg_net.ttl', true)` returns
**`6 hours`** (`pg_settings` agrees). The setting is present, so `net._http_response` is left to pg_net and cleanup has no
delete for it. Task 24 should confirm the hosted value.

## Ledger-invariant evidence

The case "folds ledger rows older than ninety days into checkpoints so wallets reconcile" runs every wallet-moving kind first.
- The history (real boundaries and fenced settlements) contributes `creation`, `expedition`, `arena` and `tournament`.
- Real-clock commands contribute:
  - `season` (a real `private.close_season`);
  - `build` (`queue_build` with a 100 class-change fee, then `private.apply_pending_build`);
  - `shop-purchase` (money twice, plus the renown banner);
  - `npc-sale`;
  - `market-sale` and `market-purchase`.
- The test asserts all ten reasons are present.

Committed state after the run: 9 characters and 35 ledger rows (`arena` 12, `build` 1, `creation` 9, `expedition` 3,
`market-purchase` 1, `market-sale` 1, `npc-sale` 1, `season` 1, `shop-purchase` 3, `tournament` 3). There are 0 mismatches of
`wallets = Σ ledger` for money and renown.

Inside a rolled-back transaction:
- A fold at `split + 90 d` folds exactly the history's 25 rows of all 7 history characters. The invariant
  `wallets = coalesce(checkpoint) + Σ remaining ledger` holds for every character.
- A fold at `now + 91 d` folds the remaining 10 rows into the existing checkpoints and two new ones, and empties the ledger.
  The invariant still holds. The seller's checkpoint is money 468 and renown 50 over 8 rows, which equals its wallet.
- The consumed build-fee reservation goes with its 90-day-old queue-build receipt.
- A checkpoint delete, and an update that does not increase `ledger_rows`, are refused.

The cap case adds 5,001 zero-delta rows: 5,000 fold on the first call (`more: true`) and the rest on the second. The invariant
holds after both.

## Tests and results

All `npm run test:db` runs were made with nothing else building, browsing or editing the worktree. The Edge container's start
time was read with `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after each run.

| Run | Command | Result | Edge StartedAt before | after |
|---|---|---|---|---|
| RED | `npm run test:db -- tests/db/retention.test.ts` (before 14-operations.sql) | 17/17 failed (exit 1) | 2026-10-18T16:42:24.612546157Z | 2026-10-18T16:42:24.612546157Z |
| iterate | same, after applying the source | 15 passed, 2 failed (test expectations, fixed) | 2026-10-18T16:42:24.612546157Z | 2026-10-18T16:42:24.612546157Z |
| GREEN | same | 17/17 passed | 2026-10-18T16:42:24.612546157Z | 2026-10-18T16:42:24.612546157Z |
| full | `npm run test:db` | **235/235 passed, 12 files** (236.5 s) | 2026-10-18T16:47:52.441391679Z | 2026-10-18T16:47:52.441391679Z |
| after self-review fix | `npm run test:db -- tests/db/retention.test.ts` | 17/17 passed | 2026-10-18T16:47:52.441391679Z | 2026-10-18T16:47:52.441391679Z |

**RED output.** The world build in `beforeAll` succeeded: 21 completed activities, one bracket on slot 301, and two fought bout
logs. Every case then failed for the missing feature:
- 10 cases failed with `function private.cleanup_history(unknown) does not exist`.
- The receipt guard case: the delete got the foreign-key error, not `immutable operation_receipts`.
- The bout guard case: the allowed compaction was refused by `guard_frozen` (`immutable tournament_bout_results`).
- The operational case failed with `relation "private.operations_events" does not exist`.
- The future-time case: the cleanup function was missing.
- The tick case: the `cloudiator-cleanup` job was missing.
- Projection (a): `['project_changed_character','projection_changed']` instead of `['projection_changed']`.
- Projection (b): `canceling statement due to lock timeout`. The old ON CONFLICT upsert locks an unchanged row another session
  holds.

**Iteration.** Two test expectations were wrong, not the SQL:
- A call with nothing in range still advances the watermark across empty slots and reports that range.
- `postgres` may not use pg_cron's `runid_seq`, so the fabricated run rows now carry explicit run ids.

**Other gates:**
- `npm test`: 1056/1056 passed.
- `npm run typecheck`: `tsc`, `deno check --frozen` and the Deno Edge smoke test passed.
- `npx supabase db lint --local --schema public,private --fail-on warning`: no schema errors.
- `npx supabase db advisors --local --type all --level info`: 4 INFO unused-index notices (`jobs_gladiator_idx`, two market
  indexes, and the new `operations_events_time_idx`), with no warnings or errors.
- `git diff --cached --check` was clean.

**Edge recreation (observation only).** The Edge container was recreated twice, both outside any DB run:
- once at 16:42:24, while `npx tsc --noEmit` read the Edge sources;
- once at 16:47:52, during `npm run typecheck` (deno check).

This matches the observation in `docs/operations/verification-gates.md`. No DB run was affected: each run's start time was
unchanged.

**Stand-in rule.** The cases that need a database time after the real clock use the session-clock stand-in `withClock`, as in
`market.test.ts`. It captures `pg_get_functiondef('private.planning_now_ms()')` first, restores it in `finally`, and asserts byte
equality. After the runs, `pg_get_functiondef` contains no `test_now_ms`. No `public` or `private` trigger is disabled, and
the scheduler is off. Every case that writes runs in a rollback-only transaction. The exception is the ledger case: it commits
real commands, and the next suite's `resetIdentity` clears them.

**How the history is aged.** One real history is built once (slots 300–302, seven characters). Each activity is settled at its
own minute 80 under the session clock, so Arena, tournament and expedition replays are `available` for seven days, as on a
live server. Inside the rolled-back transactions, the operator then moves the checkpoint: `coordinator.published_slot` and
every `processed_slot_index`. This avoids running 20 more boundaries; it is a test world control, not product code.

## Self-review

- **Fixed** (`0f7587d`): the ledger case waited for a "stable" real slot with a 240 s margin, which could exceed its 180 s
  timeout. The margin is now 60 s.
- Checked against the binding design:
  - matrix, step order, caps and return shape;
  - every FK into `private.jobs` and `public.activities`, reviewed against the source;
  - the guards against every existing writer (no existing code updates or deletes receipts or bout results);
  - the readers of `schedule_revisions` (only phase 5);
  - the readers of the deleted tables for slots at or below P−19.
- Verified with EXPLAIN that the flip and the fold use their new indexes.

## Issues and concerns

1. **The account-lock rule against the market backstop.**
   - Decision 4 and the Review Focus say cleanup never takes account locks. The design also asks cleanup to call
     `private.expire_listings(now_ms)`, which try-locks each due seller's account lock and holds the ones it obtains until
     commit.
   - It never waits (and so never deadlocks), and the step runs after every other data step to keep the hold short.
   - It is recorded as exception 1 in the source header. Please confirm this reading.
2. **One bad listing stalls retention until 22.2.** If `expire_listings` raises (for example `listed item missing` on an
   inconsistent listing), the whole cleanup fails every hour until the listing is repaired. Decision 6 (22.2) moves each
   seller into its own subtransaction, which removes this.
3. **Contention on the revision row.** The cleanup's projection triggers update `world_revision_state` at the end of the call.
   While a boundary holds that row (phase 8 until it commits), the call gives up after 500 ms and the next hourly tick
   retries. Under sustained load, repeated `55P03` cleanup events are possible. The 22.3 health report should alert on
   consecutive cleanup failures.
4. **Per-row revision bumps.** Deleting N stage, result or placement rows bumps `world_revision_state` N times in one
   transaction (existing per-row `projection_changed` design). Change (a) removed the per-row reprojection; the revision bumps
   remain.
5. **`SET CONSTRAINTS ALL IMMEDIATE` and `lock_timeout = 500ms`** stay in effect for the rest of the caller's transaction
   (documented in the header). Only the tick and tests call the function.
