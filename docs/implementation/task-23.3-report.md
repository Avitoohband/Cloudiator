# Task 23.3 report: capacity measurement (Lane A)

## Status

**Measured; blockers open.** I first stopped before the commit and reported BLOCKED. The controller then ruled (2026-10-19):
- commit the measurement, with the capacity case's budget assertions behind `CAPACITY_GATE=1`, so a plain
  `npm run test:db` stays green while Task 23.6's release gate enforces the budgets;
- fix the boundary latency in this task (see "Latency fix" below);
- leave retention and database sizing alone, pending Avi.

Commits: `test: measure capacity against the free-tier budgets` and this report (`docs: report Task 23.3`).

- **The blockers, as first measured:**
  1. **Database.** 50 always-scheduled characters reach 376–445 MiB at 90 days and 570–685 MiB after a year, against
     250 MiB (151–274 %). Even with no commands the 90-day figure is 296–365 MiB.
  2. **Boundary latency.** About 121.6 s after any slot that had expeditions, against the 120 s target (101.3 %). Spec §10.4
     and the Global Constraints set the target; Task 23.2's Arena-only cadence tests could not see this.
  3. **Egress (conditional).** Raw egress including the backend's own Data API traffic is 117–121 %. It is a blocker only if
     hosted responses are uncompressed and Edge-to-API traffic is billed. Compressed, the total is about 26 %.
- **Within budget:** invocations (14 %), worker CPU on this machine (at most 9.5 %), the season close, standings.
- **Named risks:** raw client egress (82–84 %) and the theoretical dispatch ceiling (82–85 %).

Brief: `.superpowers/sdd/2026-10-19-task-23-release-readiness/task-23.3-brief.md`.
Evidence: `docs/operations/release-evidence.md`, "Lane A: capacity".

## What I implemented

**Pure-code worker benchmarks, under `npm test`.**
- `tests/performance/harness.ts` builds the heaviest v1 jobs and times them as one Edge invocation runs them: parse the lease
  JSON, freeze it as `runWorker` does, run the v1 executor, serialize for `complete_job`. The jobs:
  - the engine's worst 120 s fight: 250 ms intervals both sides and 20,100 health, so 961 events, asserted;
  - a long Mountain expedition;
  - the 50-entrant tournament pairing job (partition, bracket, `checkGraph`);
  - the bracket's final bout job over a graph read carrying 48 worst-case logs (12.2 MB).
- `tests/performance/simulation.test.ts` holds the brief's two tests:
  - cold first run and warm runs;
  - single runs and batches of five;
  - each asserted at or under 1,500 ms;
  - the machine recorded.

**The projection arithmetic.**
- `tests/performance/capacity-model.ts` holds:
  - the retention windows from the rules (126, 1,620, 36 and 540 slots);
  - 30- and 31-day months (540/558 slots, dispatch ceilings 216,000/223,200, at most 9 tournament slots each);
  - the budgets;
  - a retention class for every game table;
  - `projectDatabase` (windows, compaction, permanent, seasons, commands, system);
  - `projectInvocations` (dispatches, then commands with their preflight);
  - `projectEgress` (players, visitors, always-on visitors, backend).
- `tests/performance/capacity-model.test.ts` pins it on synthetic inputs.

**The DB measurement, in `tests/db/capacity.test.ts` with its harness `tests/fixtures/capacity.ts`.**
1. **The measurement world** (case 1):
   - **Scenario 1:** 50 real characters on three rotating no-Rest schedules, all opted in. They run a warm-up slot and
     `CAPACITY_SLOTS` (default 4) measured slots, slot 301 being a tournament slot. Each slot is ticked every database minute
     through `private.cron_tick()` and the real Edge worker via pg_net (the 23.2 cadence pattern: vault secrets and a clock
     stand-in, both restored and verified).
   - **Per slot it records:** dispatches, revision changes, publication time, and rows in every table.
   - **Row sizes:** modeled as live tuple, line pointer and index entries at 75 % fill, times 1.2 for autovacuum. This
     replaced the run's raw file growth (see Self-review). A `VACUUM FULL` cross-check runs on the tables with at least 200
     rows.
   - **Read sizes:** every read kind through the app's read adapters, as a visitor and as a player; gzip and brotli via zlib.
   - **Extras:**
     - a market page from 10 present-slot sellers, using the real `create_listing`;
     - a real command through the gateway, with its preflight and the function's Auth lookup;
     - a full 60-item inventory;
     - one season's archive.
   - **Scenario 2:** a second world on the new-character schedule.
   - Everything is projected and written before soft budget assertions, so one run names every failing budget.
2. **`closes a season of four 50-player leagues within one boundary budget`** (C14): 200 real characters with one rating row
   each, and a stress season of 500 rows a league (2,000), 12 awards each.
3. **`reads a standings page and one standing row within their budgets at 1,000 rows`** (C13): Data API medians as a
   visitor, and `EXPLAIN (ANALYZE, BUFFERS)` as the anon role.

**`scripts/resource-report.mjs`.**
- **Usage:** `--players/--viewers/--slots`.
- **Discovery:** in memory, through `operator-db.mjs`'s `parseDatabaseUrl`/`isLoopback`. Status output, keys and URLs are
  never printed, a non-loopback host is refused, and `CLOUDIATOR_DB_URL` is stripped from the child environment.
- **Runs:** both suites, with their output on stderr.
- **Prints:** one JSON report with the brief's shape plus `boundary`, `budgets` (each with percent and verdict) and `measured`.
- **Exit codes:** 0 when every budget is under 100 %, 1 for a blocker or a failed suite, 2 for usage or discovery.

**Small change.** `tests/fixtures/db.ts` exports `serverClockFetch` (it was module-private).

## Files

Created:
- `tests/performance/harness.ts`
- `tests/performance/simulation.test.ts`
- `tests/performance/capacity-model.ts`
- `tests/performance/capacity-model.test.ts`
- `tests/fixtures/capacity.ts`
- `tests/db/capacity.test.ts`
- `scripts/resource-report.mjs`
- `docs/operations/release-evidence.md`
- this report

The budget checks of the measurement case run only with `CAPACITY_GATE=1` (documented in the test header, in
`release-evidence.md` and in the script header).

Modified: `tests/fixtures/db.ts` (one export). No schema, migration, SQL, `src/` or Edge change.

## RED and GREEN

**RED.**
- `npx vitest run tests/performance`: 2 files failed (`Cannot find module './harness.ts'` and `'./capacity-model.ts'`).
- `node scripts/test-db.mjs tests/db/capacity.test.ts`: failed (`Cannot find module '../fixtures/capacity.ts'`). Edge
  11:09:46.98 before and after.

**GREEN, where the product allows it.**

| Gate | Result |
|---|---|
| `npm test` | 53 files, 1,117/1,117 (7 new) |
| `npm run typecheck` | `tsc`, `deno check`, `deno test` 2/2: clean |
| `tests/performance` | 7/7 |
| Season close and standings DB cases | pass |
| Capacity file without the gate (12:17–12:19, Edge 12:11:13.70 unchanged) | **3/3** (the measurement case records, the budgets are not checked) |
| Measurement case with the budget checks (before the gate existed) | **fails on the real blockers** (soft checks name them all): boundaries at or after 120 s ([300, 121,580], [301, …], [303, …] and scenario 2's [302, 121,569]); database 177.9 %, 273.8 %, 150.6 %, 227.6 % |
| Full `npm run test:db` | **271 passed, 1 failed (the measurement case)**: 17 files, 272 tests; the 269 earlier tests all pass |
| `git diff --check` | clean |

## Edge StartedAt for every DB run

`docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator`. The container serves this worktree's
`supabase/functions` (mount checked).

| Run (UTC) | Scope | Edge before / after | Result |
|---|---|---|---|
| 11:21 | throwaway probe (account-creation throughput, file deleted) | 11:09:46.98 / same | 100 characters ≈ 1.3 s |
| 11:26 | RED capacity | 11:09:46.98 / same | import failure |
| 11:40 | standings case | 11:31:38.55 / same | pass |
| 11:40 | season close and standings | 11:31:38.55 / same | 2 pass |
| 11:40–11:42 | world, first version | 11:31:38.55 / same | publication 121.7 s found |
| 11:44–11:46 | world (projections before checks) | 11:31:38.55 / same | fails on publication |
| 11:52–11:53 | world with both scenarios | 11:31:38.55 / same | fails on publication |
| 11:55–11:57 | **`node scripts/resource-report.mjs`** (both suites) | 11:31:38.55 / same | exit 1, the recorded JSON |
| 11:58–12:04 | **full `npm run test:db`** | 11:58:23.18 / same | 271 / 272 |
| 12:05–12:07 | capacity file | **0001-01-01 (recreating) / 12:05:29.19** | **discarded** |
| 12:07–12:09 | capacity file, rerun | 12:05:29.19 / same | 2 pass, 1 fails on the blockers (soft checks) |
| 12:17–12:19 | capacity file, `CAPACITY_GATE` unset (ruling 1) | 12:11:13.70 / same | 3/3 |

Edge recreations happened only between runs:
- 11:31:38, 11:58:23, 12:05:29 and 12:11:13. Each followed a `tsc --noEmit` (or `npm run typecheck`) run within seconds; no
  file under `supabase/functions` changed.
- This is a strong correlation for C22, not a proven cause.
- The 12:05 run started while the container was being recreated and was discarded as the gate requires.

## Measured numbers and each budget

Scenario 1 is the mixed no-Rest schedules; scenario 2 the new-character schedule. 50 players, 50 visitors, 4 measured slots.

| Budget | Share | Verdict |
|---|---|---|
| Database at 90 days: scenario 1 445.3 MiB / scenario 2 376.4 MiB | 178.1 % / 150.6 % | **blocker** |
| Database after one year: 685.1 / 569.5 MiB | 274.0 % / 227.8 % | **blocker** |
| Boundary publication, worst of 7 windows: 121.6 s (61.6–61.8 s when the previous slot had no expedition) | 101.3 % | **blocker** |
| Invocations, 30 / 31-day month: 41,628 / 43,015 | 13.9 % / 14.3 % | ok |
| Invocations at the dispatch ceiling: 246,000 / 254,200 | 82.0 % / 84.7 % | risk |
| Egress raw, players + 50 visitors: 2.45 / 2.51 GB | 81.6 % / 83.7 % | risk |
| Egress gzip, players + visitors: 0.57 / 0.59 GB | 19.1 % / 19.6 % | ok |
| Egress raw with backend traffic (estimate): 3.52 / 3.62 GB | 117.4 % / 120.6 % | **blocker if hosted counts it uncompressed** |
| Worker worst 120 s fight 6.9 ms; batch of 5 17.3 ms; 50-entrant pairing 2.8 ms; final-bout batch 190.9 ms | ≤ 9.5 % of 2,000 ms | ok (i9-13900K) |
| Season close 4 × 50: 14.1 ms; 4 × 500: 29.3 ms | ≤ 0.1 % of 43,950 ms | ok |
| Standings page 6.2 ms; one row 6.4 ms (plans 2.6 / 1.8 ms) | ≤ 0.9 % of 750 ms | ok |

Other measured figures:
- **Rows and bytes per slot:** 1.24 MiB a slot in scenario 1, 0.99 MiB in scenario 2. The detail class is 1,134 / 906 KB of
  that; jobs alone are 250–280 rows × 2.05–2.1 KB.
- **Permanent growth:** 21.0–26.1 MiB a month, plus about 11 MiB a month of command receipts at 10 commands a player a day.
- **Dispatches:** 21.5 a regular slot and 23.5 a tournament slot (21.3 in scenario 2).
- **Revision changes:** 10.5 a regular slot and 7.5 a tournament slot; split factor 1.039.
- **Read sizes (raw / gzip):**
  - world 29,069 / 3,989 B;
  - owner, full inventory 26,909 / 3,025 B;
  - arena timeline 19,404 / 1,701 B;
  - 50-entrant tournament view 60,246 / 10,181 B;
  - mean bout log 12,852 / 1,342 B; all 49 logs 676,636 B raw including headers.
- **Receipts:** a settlement receipt is a 779-byte tuple. Command receipts are 384–560-byte tuples, 787 B modeled as stored.
- Every arithmetic step is in the evidence section.

## Risks and mitigations

Recommended options are not built; the full list is in the evidence.

1. **Database (blocker).** The retention design already exceeds 250 MiB at 50 characters with an activity every slot.
   - **At 90 days (scenario 2):**
     - detail 111.9 MiB, of which jobs 61.7, stages 15.3, plans 11.0 and snapshots 10.8;
     - summaries 116.6 MiB, of which activities 69.7 and recent results 39.1;
     - permanent 47.0 MiB;
     - commands 80.8 MiB.
   - **Options for Avi:**
     - empty completed jobs' payloads at settlement;
     - one completion copy, or `recent_results` for 7 days;
     - 30-day summaries;
     - settled-slot ranges, and pruning compacted settlement receipts that `settled_slots` guards (this reverses a Task 22
       ruling);
     - pausing the schedules of idle characters;
     - raising the internal budget toward the 500 MB free plan.
   - Most of these need SQL and a migration (outside this task: M17/M18 are immutable and no schema change was expected).
2. **Boundary latency (blocker).**
   - **Cause:** an expedition settlement depends on its "Arrive at camp" reveal, which falls due exactly at the cutoff.
     `dispatch_workers()` counts only dependency-ready jobs (50 in scenario 2: three invocations of 20), and `runWorker`
     claims settlements before reveals. The released settlements wait for minute 1 and preparation for minute 2, so
     publication comes at about 121.6 s. Dispatch per minute in the database confirms it.
   - **Fix options** (proposed, not tested):
     - count the settlements that due reveals release in `dispatch_workers()` (SQL, so a new migration), together with
       reveal-before-settlement ordering in `runWorker`;
     - fold the final reveal into the settlement;
     - change the batch limits.
   - Reordering `runWorker` alone cannot fit 100 simple jobs into the 3 invocations dispatched.
3. **Egress.**
   - Raw client egress is at 82–84 %; compressed it is about 20 %.
   - The backend estimate covers worker job inputs, tournament graph reads and each command's lookups. Raw it adds about
     1.1 GB a month (0.2 GB gzip).
   - **Task 24** verifies hosted compression and whether Edge-to-API traffic is billed.
   - **Code options** (none built):
     - bout inputs carrying only their parents' results (the final's read is 12.2 MB at the worst case);
     - delta world reads;
     - `Access-Control-Max-Age` on the command function.
   - Visitor reads are unthrottled and monitored (Decision 2): 50 always-on visitors would need 27 GB raw (7.2 GB gzip).
4. **Dispatch ceiling (risk).** 223,200 dispatches plus commands is 85 %, reached only if work were due every minute. The
   measured load is 12,015.
5. **Command-receipt growth** (carried from Task 22): about 11 MiB a month at 10 commands a player a day. Sensitivity at 0, 5,
   10 and 20 commands is in the evidence.

## Self-review (and what it changed)

- **Raw file growth overstated row sizes 1.6 to 2 times.** The first DB projection used it: dead row versions from status
  updates (and, in this 1970-slot run, every job's lease renewal) and first-page effects on small tables. It is replaced by
  the modeled live size. The `VACUUM FULL` cross-check agrees within 15 %; for example jobs are 1,761 B modeled against
  1,807 B compact. The verdict did not change; the numbers fell by roughly half.
- **Command 90-day rows were 3.3 KB from tiny tables.** They are now modeled (1,095 B).
- **The 20 commands a day assumption was too heavy for a primary figure.** The primary is now 10, and 0, 5, 10 and 20 are
  reported.
- **The measurement case failed before writing anything.** It now projects and writes first, and checks every budget softly
  across both scenarios.
- **The cold timing was not cold.** The benchmark's probe warmed the JIT before the timed runs; it is now timed explicitly.
- **A fixture comment overclaimed** stamina clamping; it is corrected.
- **Checked:** no secret in any output (the JSON excerpt was scanned); the clock stand-in and vault secrets are restored and
  verified; every case resets the world, and the file resets at the end.

## Concerns

1. **The blockers above need Avi** (database retention or budget; boundary dispatch design). Egress also needs Task 24's
   hosted checks.
2. **Assumptions that move the numbers.** They are all stated in the evidence; I chose each conservatively.
   - commands per player per day (10);
   - the standings panel open all session;
   - 16 tournament view reads (camp and panel);
   - visitors at 30 minutes a day (always-on shown separately);
   - the 20 % autovacuum allowance;
   - the backend estimate's per-call envelope sizes.
3. **The 1970-slot run makes the Edge worker renew every lease twice.** The worker's `Date.now()` is far from database time.
   This changes neither the dispatch counts nor the modeled sizes, but inflated the raw file sizes I first used.
4. **Local CPU is not hosted CPU (C4).** The i9-13900K is far faster than a hosted Edge isolate; the margins (at most 9.5 %)
   leave room for that.
5. **`npm run test:db` grows by about 2 minutes** (the capacity file takes about 2 minutes). Each run also adds about 1,600
   local `auth.users` rows.
6. **C22.** Four `tsc` runs today were each followed within seconds by an Edge recreation, and one discarded run started
   during one.
7. **Upkeep proposal (pending Avi):** `docs/operations/verification-gates.md`, "Database tests and the local Edge runtime".
   Add "run `npm run typecheck` (and any `tsc`) before taking the Edge baseline, never during a DB run", with today's four
   observed recreations as the evidence. It is an observed correlation, not a tested fix.
