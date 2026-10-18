# Task 22: Retention, Health Reporting and Recoverable Exports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The database prunes replay detail after 7 days and summaries after 90 days, without ever losing a grant guard, an unfinished job, a held reservation or ownership. An operator can read a secret-free health report, export the database and prove that a restore works. Players see clearly when a replay is no longer kept.

**Architecture:**
- **Retention.** An hourly, bounded, watermark-driven `private.cleanup_history(now_ms)` runs from its own cron job. Wallet ledger rows older than 90 days fold into per-gladiator checkpoints.
- **Robustness.** `cron_tick`'s market sweep and dispatch get durable error records. The M15 season-row limit gets its fix.
- **Operations.** A SQL health report behind a CLI. PowerShell export and restore-check scripts. A runbook and an environment guide.
- **Client.** Replay expiry is judged against server time, and pruned or old replays say "no longer kept".

**Tech Stack:** Supabase Postgres 17 (CLI 2.120.0), pg_cron, Deno Edge functions, Next.js 16.4 static export, React 19, Vitest, Playwright (Chrome channel), PowerShell 5.1 and Node scripts.

**Spec:** [game design §11](../specs/2026-10-11-gladiator-arena-design.md) (lines 400–414) and §6 recovery (:141, :370). This plan refines Task 22 of the [24-task plan](2026-10-11-gladiator-arena-implementation.md), with the items carried to Task 22 by earlier review records: `task-07`, `task-09`, `task-13`, `task-16`, `task-18`, `task-19`, `task-20`, `task-21`.

## Global Constraints

- "Retain detailed battle/expedition replay events seven days. Retain activity and financial summaries 90 days, with checkpointed balances and progression. Preserve account state, item ownership, season archives, prestige, and unique settled-slot checkpoints indefinitely. Pruning cannot delete unprocessed jobs, active reservations, or the information required to prevent duplicate grants. Explain retention in the recent-results interface."
- "Replay expired: show summarized outcome and rewards; clearly identify that animation is no longer retained."
- "Persist operational logs for job identity, attempts, duration, CPU measurements where available, and failures, with no tokens or provider secrets. Expose an owner-operated health view/CLI report for overdue jobs, stalled checkpoints, and resource usage; do not add another player-facing admin flow."
- "Daily cleanup expires listings and prunes safe historical data. Monitor budgets and overdue work … Weekly operator exports provide a recoverable database copy outside the free service, with a restoration check before launch."
- Budgets: below 250 MB database, 3 GB monthly egress and 300,000 monthly function invocations.
- Retention constants restate `RULES_V1.retention`: `replayMs: 604_800_000` and `summaryMs: 7_776_000_000`.
- Export and restore scripts need explicit local targets, or a private operator credential passed through an environment variable. They never print it, and they never expose a player admin endpoint.
- No package or tool downloads (no new npm packages, Docker images or CLIs).
- Read `node_modules/next/dist/docs/` before changing Next code.
- Gate order and the database-test rule: `docs/operations/verification-gates.md` and AGENTS.md.
- Generated-migration completion, the psql fallback, the stand-in restore rule and the Postgres concurrency note: AGENTS.md.
- Never print `supabase status`, keys, JWTs or `.env*` contents.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Cleanup racing a boundary, a settlement or a command.** Cleanup touches only terminal rows of slots at or below the checkpoint minus 19. It never takes the coordinator lease or account locks, and it gives up a lock after 500 ms. Test: 22.1.
- **A retried command after 90 days.** The same payload returns the stored receipt with no new grant; a changed payload returns `conflict`. Test: 22.2.
- **A service paused for several days.** Catch-up processes the slots in order, sweeps the expired listings once and returns their items once, with no duplicate grant. Cleanup running in the middle of catch-up removes nothing it still needs. Test: 22.2.
- **A replay older than 7 days.** It shows its summary with "no longer kept" everywhere: results, Arena, expeditions, tournaments. Server and client agree before and after cleanup. Test: 22.5.
- **A restore into a separate database.** Counts and checksums match the export. Ownership and grant guards are intact, and a replayed boundary grants nothing new. Test: 22.4.

---

## Decisions (controller, binding)

1. **Names.**
   - SQL source `supabase/sql/14-operations.sql`; generated migration M16.
   - `cleanup_history(now_ms bigint) returns jsonb`, following the repo's epoch-millisecond convention.
   - The 24-task plan's `10-operations.sql`, "M10" and `timestamptz` argument are obsolete.
2. **Checkpoint and horizons.** All of these are restated with comments, as `08-arena-bouts.sql:34-38` does: `604800000`, `7776000000`, slot `4800000`, pairing window 18.
   - `P = least(coordinator.published_slot, min(gladiators.processed_slot_index))`. If P is null, skip both slot passes.
   - `H7 = least(P−19, (now_ms−604800000)/4800000 − 1)`.
   - `H90 = least(P−19, (now_ms−7776000000)/4800000 − 1, detail_through_slot)`.
   - P−19 keeps the 18-slot pairing history (`09-tournaments.sql:177-185`, `08-arena-bouts.sql:461-467`) and everything a catch-up still needs.
3. **State.** These tables are backend-only (RLS `backend_only`). service_role may only SELECT them, for health.
   - **`private.retention_state`**: singleton, `detail_through_slot bigint`, `summary_through_slot bigint`, `last_run_at_ms`, `last_result jsonb`. Its seed row is DML that migra omits, so append it to M16.
   - **`private.wallet_checkpoints`**: `gladiator_id uuid primary key references public.gladiators(id)`, `money bigint`, `renown bigint`, `ledger_rows bigint`, `folded_through timestamptz`, `updated_at_ms bigint`.
     - Its guard refuses DELETE; an UPDATE must increase `ledger_rows`.
     - Invariant: `wallets.money = coalesce(cp.money,0) + Σ ledger.money_delta`, and the same for renown.
   - **`private.operations_events`**: `id bigint identity`, `at_ms bigint`, `source text check in ('market-sweep','dispatch','cleanup')`, `ok boolean`, `sqlstate text`, `detail jsonb`. It holds only a SQLSTATE, never raw error text, and is kept 30 days.
4. **The cleanup algorithm.** It is the retention design in "Retention design (binding)" below: the matrix, the guard changes, the FK-safe step order, the ledger fold, the operational windows, the caps and the return shape.
   - It is one transaction per call. It sets `lock_timeout` to 500 ms locally.
   - It raises if `now_ms > private.planning_now_ms()`.
   - It never locks the coordinator row, takes the lease or takes account locks.
   - EXECUTE is revoked from `public`, `anon`, `authenticated` and `service_role`.
5. **Cadence.** `cron.schedule('cloudiator-cleanup','23 * * * *','select private.cleanup_tick()')`.
   - `cleanup_tick` is inert unless `private.scheduler.enabled`, like `cron_tick`.
   - It records an `operations_events` row with `source 'cleanup'`. On failure that row carries `ok false` and the SQLSTATE.
   - Hourly bounded calls meet the spec's "daily" cleanup, which becomes the maximum lateness.
   - migra omits `cron.schedule`, so append it to M16 (as M03 did).
6. **`cron_tick` robustness** (carried from the Task 18 review).
   - `private.expire_listings` handles each seller in its own subtransaction. A failure records an `operations_events` row (`market-sweep`, SQLSTATE, the seller count) and the sweep continues.
   - `cron_tick` wraps `dispatch_workers()` in its own `begin … exception` block that records a `dispatch` event. A dispatch failure then can no longer roll back the coordination committed in the same tick.
7. **M15 known limit** (`migrations.md` M15).
   - Add `private.season_bounds(index bigint) returns table(starts_at_ms bigint, ends_at_ms bigint)` (immutable, from the epoch). Phase 2 and the backfill use it.
   - Phase 4 (`private.boundary_recompute_leagues`) also runs `insert into public.seasons … on conflict do nothing` for the season it rates.
   - Never edit M15.
8. **Health.** `private.health_report(now_ms bigint) returns jsonb`, owner-only (revoked from everyone). See 22.3 for its fields and alerts.
   - **Durations** come from `job_attempts` (`finished_at_ms − claimed_at_ms`).
   - **CPU** is not exposed per request by the Edge runtime, so the report says `cpu: "not available"` instead of inventing it.
   - **Egress and function invocations** are read from the hosting dashboard, as described in the runbook.
9. **Export and restore.** See 22.4.
   - Output goes to a git-ignored `.backups/` directory.
   - The restore target is a separate local database named exactly `cloudiator_restore_check`, inside the local Cloudiator container. Its label `com.supabase.cli.project=Cloudiator` is verified first, and nothing else is ever dropped.
10. **Client.** One helper, `replayKept(expiry, serverNowMs)`, and server time only; see 22.5.
    - These are copy and state changes inside existing panels with no new layout, so no mockup is needed. Avi sees screenshots in the completion summary.

## Retention design (binding)

### Kept forever

- Account and current state: gladiators, builds, schedules, wallets, item_instances, owned_cosmetics, pending_build_items, pending_build_preparations.
- `settled_slots`: the permanent grant guard.
- **`operation_receipts` rows.** Their PK is the replay and conflict guard.
  - Only the `result` of settlement receipts (`request->>'kind'='activity-settlement'`) is compacted at 90 days, to `{"compactedAtMs":n}`.
  - A new guard, `private.guard_receipt` (BEFORE UPDATE OR DELETE), refuses every DELETE. It allows only that compaction UPDATE: the key columns, `request` and `request_digest` unchanged, and the new `result` exactly `{"compactedAtMs":n}`.
- Season and standings records: arena_ratings, arena_standings, seasons, season_standings, season_awards.
- Projections: public_profiles, world_actors.
- Configuration and singletons: rules_versions, season_epoch, coordinator, scheduler, world_revision_state.

### 7-day detail

Anchor: whole slots at or below H7, advanced from `detail_through_slot`. A batch is at most 3 data slots.

- **Flip expired replays.** Set `activities.summary.replayExpiry` to `{"state":"expired"}` for completed activities whose `expiresAtMs ≤ now`. This is independent of P, capped at 300 per call, and runs first.
- **Compact `public.tournament_bout_results`.**
  - Turn `result.battleLog` into `result.fight`, keeping `durationMs`, `victoryReason` and `tieBreakReason`.
  - Its `guard_frozen` becomes `private.guard_tournament_bout_result()`. That guard allows exactly this UPDATE and refuses any other; DELETE stays allowed.
- **Delete whole rows:**
  - activity_stages, expedition_plans;
  - arena_results, arena_assignment_sides, arena_assignments (selected through their pair jobs' `slot_index`);
  - tournament_results, tournament_bouts, tournament_entries, tournaments;
  - completed jobs and their job_dependencies and job_attempts, except pair jobs referenced by a `tournament_views` row, which stay until the 90-day pass;
  - activity_snapshots, boundary_members.

### 90-day summary

Anchor: whole slots at or below H90, advanced from `summary_through_slot`, at most 3 data slots per batch.

- Compact settlement receipts, joined through `activities.receipt_id`, **before** those activities are deleted.
- Delete tournament_bout_results, tournament_placements, then tournament_views, then their pair jobs (attempts first).
- Delete completed activities. This cascades to recent_results; tournament placements were deleted in the previous step.
- Delete `boundary_work` rows marked `done`, then `boundaries` marked `complete`.

### 90-day, time-anchored

- **Fold the ledger** (at most 5,000 rows per call). One statement, ordered by `created_at, id`: delete the ledger rows older than 90 days and add their per-gladiator sums to `wallet_checkpoints`. Add an index on `wallet_ledger(created_at)`.
- **Market.** Call `private.expire_listings(now_ms)` as a backstop. Then delete the offers, followed by the listings, of terminal listings whose `expires_at_ms ≤ now−90d`. Open listings are never touched.
- **Reservations.** Delete `consumed` and `refunded` reservations whose queue-build receipt is older than 90 days. `held` reservations are never touched.
- **Schedule revisions.** Delete a revision older than 90 days (`received_at_ms`) only when a newer revision of the same (gladiator, phase) is effective at or before `processed_slot_index+1`.

### Operational

- `command_attempts`: 1 hour.
- `dispatch_log`: 48 hours.
- `operations_events`: 30 days.
- `cron.job_run_details`: 7 days, by `end_time`. Run it in its own `begin … exception` block that reports the SQLSTATE.
- `net._http_response`: left to pg_net's `pg_net.ttl`. Verify the setting locally. If it is absent, add a guarded delete of rows older than 1 day.

### Never touched

- Unfinished jobs.
- Held reservations and `pending_build_*`.
- Open listings.
- Non-completed activities.
- Any slot above P−19.

If a slot in a batch has an activity or job that is not `completed`, the batch stops below it and reports `blockedSlot`.

### Caps and idempotency

- Per call: 3 data slots per pass, 300 flips, 5,000 ledger rows, and 1,000 rows for each other time-anchored or operational step.
- Watermarks and state predicates make every step idempotent. After catch-up, a second call returns all-zero counts.
- Durations use `clock_timestamp()`.

### Projection cost

Add both changes to M16, each with a test:

- **(a)** Drop the `project_changed_character` trigger on `activity_stages`; keep `projection_changed`.
- **(b)** Make `private.project_character`'s `recent_results` upsert skip unchanged rows with an anti-join, giving the same rows as today.

### Return shape

The call returns this, and also stores it as `retention_state.last_result`:

```
{ok, nowMs, publishedSlot, durationMs, replay:{flipped,durationMs},
 detail:{fromSlot,throughSlot,more,blockedSlot,deleted:{…per table…},compacted:{tournamentBoutResults},durationMs},
 summary:{fromSlot,throughSlot,more,deleted:{…},compacted:{receipts},durationMs},
 ledger:{rows,gladiators,more}, market:{expired,listings,offers}, reservations, scheduleRevisions,
 operational:{commandAttempts,dispatchLog,operationsEvents,cronRunDetails | {ok:false,sqlstate}}}
```

## Execution

- Branch `claude/task-22` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `b4b3521`.
- One reviewed checkpoint per task. Visual review applies to 22.5.
- **Migration.** 22.1–22.3 iterate `14-operations.sql` through the psql fallback. 22.3 generates and completes M16. The first push is after 22.3.

---

### Task 22.1: Retention in the database

**Files:**
- Create: `supabase/sql/14-operations.sql`, `tests/db/retention.test.ts`
- Modify:
  - `tests/fixtures/db.ts` (`resetIdentity` truncates the new state tables and reseeds `retention_state`)
  - `docs/operations/migrations.md` (a draft M16 retention section)

**Interfaces:**
- Produces:
  - `private.cleanup_history(now_ms bigint) returns jsonb` and `private.cleanup_tick() returns jsonb`;
  - the tables `private.retention_state`, `private.wallet_checkpoints` and `private.operations_events`;
  - the guards `private.guard_receipt` and `private.guard_tournament_bout_result`;
  - the ledger index;
  - projection changes (a) and (b).

- [ ] **Step 1: Write the failing tests** in `tests/db/retention.test.ts`.
  - Age data with the `planning_now_ms` stand-in (rollback-only transactions, or `withClock` as in `tests/db/market.test.ts:121-131`), following the stand-in restore rule.
  - Build real history with the arena, tournament and expedition helpers in their test files' style.

```ts
test('flips available replays to expired once their expiry passes and reprojects recent results', ...)
test('removes replay detail of slots older than seven days and keeps their summaries and settled slots', ...)
test('compacts tournament bout logs to their fight summary and keeps the bracket', ...)
test('removes activities, recent results and tournament views of slots older than ninety days', ...)
test('never touches the last 19 slots before the checkpoint, unfinished jobs, held reservations or open listings', ...)
test('stops a batch below a slot that still has an unfinished job and reports blockedSlot', ...)
test('folds ledger rows older than ninety days into checkpoints so wallets reconcile', ...)   // every command and settlement kind first (ledger invariant)
test('refuses to delete a receipt and allows only the settlement-receipt compaction', ...)
test('refuses any tournament bout result update except the log compaction', ...)
test('returns all-zero counts on a second call after catch-up', ...)
test('caps each call and continues from its watermarks', ...)
test('prunes command attempts, the dispatch log, operations events and cron run details by their windows', ...)
test('refuses a now_ms in the future and gives no client role execute', ...)
test('keeps stage reveals bumping the world revision without reprojecting characters', ...)   // change (a)
test('reprojects the same recent results as before with the anti-join upsert', ...)          // change (b)
test('records each cleanup tick in operations events and stays inert while the scheduler is off', ...)
```

- [ ] **Step 2: Run** `npm run test:db -- tests/db/retention.test.ts`, under the Edge start-time rule. Expected: FAIL; `cleanup_history` does not exist.
- [ ] **Step 3: Implement** `14-operations.sql` per Decisions 2–5 and the retention design.
  - It must be reapplicable.
  - Its header documents the matrix, the step order, the lock behavior and the exceptions.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run test:db` (all suites). Expected: PASS, with the Edge start time unchanged.
- [ ] **Step 5: Commit** `feat: prune replay detail and old summaries safely`.

### Task 22.2: Robust ticks, season rows and recovery

**Files:**
- Modify: `supabase/sql/14-operations.sql` (Decisions 6 and 7)
- Create: `tests/db/recovery.test.ts`

**Interfaces:**
- Consumes: 22.1's cleanup and tables.
- Produces:
  - the per-seller sweep and the guarded dispatch in `cron_tick`;
  - `private.season_bounds(index)`;
  - the phase-4 season-row insert.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/db/recovery.test.ts
test('catches up a service paused for two days in slot order with no duplicate grant', ...)        // scheduler off across 36+ slots, then coordinate
test('sweeps listings that expired during the pause once and returns their items once', ...)
test('keeps everything catch-up still needs when cleanup runs in the middle of a catch-up', ...)
test('returns the stored receipt for a command retried after ninety days of cleanup and conflict for a changed payload', ...)
test('records a market-sweep failure for one seller and still expires the others', ...)
test('keeps the committed coordination when dispatch fails in the same tick', ...)
test('creates a season row in phase 4 when the epoch is set while a boundary waits at phase 4', ...)
test('derives phase 2, the backfill and phase 4 season bounds from season_bounds', ...)
```

- [ ] **Step 2: Run** `npm run test:db -- tests/db/recovery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** Decisions 6 and 7 in `14-operations.sql`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run test:db`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: keep ticks durable and seasons whole during recovery`.

### Task 22.3: Health report and migration M16

**Files:**
- Modify: `supabase/sql/14-operations.sql` (`private.health_report`)
- Create: `scripts/health.mjs`, `tests/db/health.test.ts`
- Modify: `package.json` (script `health`), `docs/operations/migrations.md` (M16 section)
- Generate: `supabase/migrations/<timestamp>_operations.sql` (M16)

**Interfaces:**
- Produces:
  - **`private.health_report(now_ms bigint) returns jsonb`**, with these fields:
    - `checkedAtMs`, `currentSlot`, `publishedSlot`, `slotsBehind`;
    - `coordinator`: `{lastError, lastFailedSlot, leaseHeld}`;
    - `scheduler`: `{enabled}`;
    - `boundaries`: waiting ones, each with slot, phase, `waitReason` and `waitingMs`, at most 20;
    - `jobs`: counts by kind and status, `overdue` (at most 20), and `operator` (at most 20, with kind, slot, attempts and `lastFailure`);
    - `attempts24h`: count, failures by code, and per-kind duration p50/p95/max;
    - `dispatch`: `{lastAtMs, lastHour}`;
    - `cleanup`: `{lastRunAtMs, detailThroughSlot, summaryThroughSlot, more}`;
    - `events`: the latest failure per source in 24 hours;
    - `resources`: `{databaseBytes, budgetBytes: 262144000, largestTables: [{name, bytes}] ×10}`;
    - `cpu: "not available"`;
    - `alerts: [{code, severity, detail}]`.
  - **Alert codes:**
    - `boundary-behind`: a published slot is behind the current slot more than 10 minutes into the slot;
    - `boundary-waiting`: a boundary has waited more than 10 minutes;
    - `operator-jobs`;
    - `overdue-jobs`: pending with `due_at_ms` more than 10 minutes ago;
    - `cleanup-stale`: the scheduler is on and there has been no cleanup for 26 hours;
    - `cleanup-backlog`: `more` for 24 hours;
    - `tick-failures`: market-sweep or dispatch failures in the last hour;
    - `database-size`: warn at 80% of the budget, alert at 100%.
  - **`node scripts/health.mjs`:**
    - It connects with `CLOUDIATOR_DB_URL` (an operator credential, never printed), or by default discovers the local stack in memory as `scripts/test-db.mjs` does. A non-loopback host needs `--remote`.
    - It prints the report as JSON.
    - Exit codes: `0` healthy, `1` alerts, `2` failure.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/db/health.test.ts
test('reports slots behind, waiting boundaries, overdue and operator jobs with their alerts', ...)
test('reports attempt durations by kind and failures by code from job attempts', ...)
test('reports cleanup state, the latest tick failures and database size against the budget', ...)
test('contains no secrets: no URLs, keys, tokens or raw error text', ...)
test('denies every client role execute on health_report', ...)
test('runs the health script against the local stack and exits 0 when healthy and 1 with an alert', ...)   // execFile, loopback only
```

- [ ] **Step 2: Run** `npm run test:db -- tests/db/health.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `health_report` and `scripts/health.mjs`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run test:db`. Expected: PASS.
- [ ] **Step 5: Generate and complete M16.** Run `db pull operations`, then complete the draft per AGENTS.md, including:
  - revokes before grants, and function ACLs;
  - the guard and trigger replacements, with functions before their triggers;
  - the `retention_state` seed row, the `cron.schedule('cloudiator-cleanup', …)` registration, the `season_bounds` users, the phase-4 and `cron_tick` replacements, and the dropped stage trigger.

  Then:
  - clean replay with `db reset --local --no-seed --yes`;
  - parity fingerprint;
  - `npm run test:db` on the replayed database;
  - lint empty, and advisors INFO only.

  Record the pg_net TTL finding and the M16 section in `migrations.md`.
- [ ] **Step 6: Commit** `feat: report operator health and ship operations migration M16`.

### Task 22.4: Export, restore check and the operator guides

**Files:**
- Create:
  - `scripts/export-db.ps1`, `scripts/restore-check.ps1`, `scripts/restore-invariants.sql`, `scripts/restore-compare.mjs`
  - `docs/operations/runbook.md`, `docs/operations/environment.md`
  - `tests/scripts/restore-invariants.test.ts`
- Modify: `.gitignore` (`.backups/`)

**Interfaces:**
- **`scripts/export-db.ps1 [-OutDir .backups] [-Remote]`**
  - **Local by default.** It verifies that the `supabase_db_Cloudiator` container carries the label `com.supabase.cli.project=Cloudiator`.
  - **With `-Remote`**, it requires `CLOUDIATOR_EXPORT_DB_URL` and never echoes it.
  - **Output.** It writes `.backups/<UTC yyyyMMddTHHmmssZ>/` with a schema dump, a data dump (including `auth.users`), and `manifest.json`. The manifest holds the git commit, the migration list, per-table row counts of every public and private table plus `auth.users`, and the SHA-256 of each file.
  - **Tools.** It uses only tools already present: the Supabase CLI `db dump`, or `pg_dump` inside the local container through `docker exec`.
- **`scripts/restore-check.ps1 -Backup <dir>`**
  - **Target.** It recreates the local database `cloudiator_restore_check` only. It refuses any other name and any non-local container, and drops nothing else.
  - **Restore.** It restores the schema and the data with `ON_ERROR_STOP`. Platform-owned objects that cannot exist outside the `postgres` database (for example `pg_cron`'s schedule) may be excluded only through a documented list.
  - **Checks.** It runs `scripts/restore-invariants.sql` and prints JSON:
    - every manifest count matches;
    - the file checksums match;
    - `settled_slots` are unique per (gladiator, slot);
    - every ledger receipt is unique;
    - the wallet and checkpoint reconciliation holds;
    - every item has one owner and the 60-item cap holds;
    - season awards are unique.
  - **Resume.** It replays the last published boundary in the restored database: `advance_boundary` returns `replayed`, with zero new grants (`duplicateGrants: 0`, `lostItems: 0`).
  - **Cleanup.** It drops `cloudiator_restore_check` at the end, unless `-Keep` is given.
- **`scripts/restore-compare.mjs`** exports `compareRestore(manifest, observed)`, which returns `{ok, mismatches: [{table, expected, actual}], checksums: {file: ok}, invariants}`. `restore-check.ps1` pipes the invariant SQL's JSON output into it.
- `tests/scripts/restore-invariants.test.ts` unit-tests `compareRestore` against fixture manifests (matching counts, a missing table, a changed count, a bad checksum, a failed invariant), with no Docker.

- [ ] **Step 1: Write the failing unit test** for `compareRestore`. Expected: FAIL.
- [ ] **Step 2: Implement** the scripts and the `.gitignore` entry.
- [ ] **Step 3: Run the real procedure locally once:**
  - export;
  - restore check, with the counts, checksums, invariants and resume result recorded in the report;
  - confirm `.backups/` is ignored and the restore database is gone afterwards.

  Then run `npm test` and `npm run typecheck`.
- [ ] **Step 4: Write the guides.**
  - **`runbook.md`:**
    - the health check and what to do for each alert code;
    - manual recovery after three failures (`resume_operator_job`, fixing deterministic errors first);
    - retained-rule deployments (`rules_versions`);
    - pausing and resuming the scheduler;
    - secret rotation: Vault `game_worker_secret` and the Edge secret, names only;
    - the weekly offline export and the restore check;
    - free-tier pausing (cron traffic is not a guarantee);
    - reading egress and invocation budgets in the hosting dashboard.
  - **`environment.md`:** local stack, ports, worktrees, hosted environment placeholders for Task 24, environment-variable names and where each secret lives (never values).
- [ ] **Step 5: Commit** `ops: export, restore check and operator guides`.

### Task 22.5: Expired replays in the game

**Files:**
- Create: `src/lib/replay-retention.ts`, `tests/domain/replay-retention.test.ts`
- Modify:
  - `src/features/results/result-text.ts:20-29`, `src/features/results/ResultsPanel.tsx` (retention explanation)
  - `src/game/replay.ts:229-237`, `src/game/arena-stage.ts:148`, `src/game/expedition-stage.ts:174,188`
  - `src/features/arena/BattleReplay.tsx:310`, `src/features/expedition/ExpeditionView.tsx:384`
  - `src/features/tournaments/TournamentPanel.tsx:155,245` and its notice
  - `src/lib/api/reads.ts` (`POLLED_RESULT` adds `fight:result->fight`; `polledResult` prefers it; `readTournamentLog` not-found after expiry)
  - the matching unit and browser specs
  - `tests/browser/live-routes.ts`, if needed

**Interfaces:**
- Produces:
  - `replayKept(expiry: ReplayExpiry, serverNowMs: number): boolean` — `available` and `expiresAtMs > serverNowMs`;
  - `tournamentReplayKept(endsAtMs: number, serverNowMs: number): boolean` — `serverNowMs < endsAtMs + RULES_V1.retention.replayMs`.
- Uses the server clock only (`reads.ts` revision `serverNowMs` and the shared display clock), never `Date.now()`.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/domain/replay-retention.test.ts
expect(replayKept({ state: 'available', expiresAtMs: 1000 }, 999)).toBe(true);
expect(replayKept({ state: 'available', expiresAtMs: 1000 }, 1000)).toBe(false);
expect(replayKept({ state: 'expired' }, 0)).toBe(false);
// browser
test('explains retention in Recent results and offers no replay once a result is older than seven days', ...)
test('shows the saved summary with "no longer kept" for an expired Arena and expedition replay', ...)
test('says a tournament replay is no longer kept after seven days and when its log was pruned', ...)
test('keeps offering a replay until its expiry by server time', ...)
```

- [ ] **Step 2: Run** the named files. Expected: FAIL.
- [ ] **Step 3: Implement** the helper and use it in every listed place.
  - The Recent results panel gains one plain line: "Detailed replays are kept for 7 days. Results and credited rewards stay here for 90 days."
  - Use the same "no longer kept" wording as the existing `BattleReplay` and `ExpeditionView` text.
  - An owner whose log was pruned while the summary still said available sees `expired`, not `missing`. A spectator sees "no longer kept", not "not available yet".
- [ ] **Step 4: Run** the full gate in the order of `verification-gates.md`. Save screenshots (`retention-` prefix) for the visual review. Expected: PASS.
- [ ] **Step 5: Commit** `feat: show when replays are no longer kept`. Then commit `docs: report Task 22` separately, with `docs/implementation/task-22-report.md`.
