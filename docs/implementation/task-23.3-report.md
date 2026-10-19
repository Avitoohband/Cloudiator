# Task 23.3 report: capacity measurement (Lane A)

## Status

**Measured; blockers open.** I first stopped before the commit and reported BLOCKED. The controller then ruled (2026-10-19):
- commit the measurement, with the capacity case's budget assertions behind `CAPACITY_GATE=1`, so a plain
  `npm run test:db` stays green while Task 23.6's release gate enforces the budgets;
- fix the boundary latency in this task (see "Latency fix" below);
- leave retention and database sizing alone, pending Avi.

Commits:
- `a167ab9` test: measure capacity against the free-tier budgets
- `caf8ec0` docs: report Task 23.3
- `119f36b` fix: dispatch settlements released by due reveals in the same tick (M19)
- this report's "Latency fix" section

**Now:**
- Boundary latency is fixed (61.5–61.6 s in every window; see "Latency fix" at the end).
- The database blocker stays open for Avi.
- Egress is a blocker only under a hosted condition (raw with backend traffic, 113–116 %).
- Client raw egress is 77–79 %; the dispatch ceiling is a named risk (82–85 %).

- **The blockers, as first measured (before M19):**
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

Modified: `tests/fixtures/db.ts` (one export). The measurement commit (`a167ab9`) changed no schema, migration, SQL, `src/`
or Edge code. The latency fix below changed SQL and added M19, and fix round 1 added M20; `src/` and Edge code are unchanged.

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

## Latency fix

**Ruling** (controller, 2026-10-19). The boundary latency is a technical fix owned by this task:
- dispatch, in the same tick, the settlements that due reveals release;
- keep the five dispatches per scheduled minute and Task 23.2's per-scheduled-minute accounting;
- put the SQL in `15-release.sql` and generate and complete M19.
Retention and database sizing stay unchanged.

**Cause** (from the run's own dispatch log and the RED tests below).
- An expedition's settlement job depends on every reveal of its plan. Its last stage, "Arrive at camp", falls due exactly at
  the next cutoff.
- `dispatch_workers()` counted only dependency-ready jobs. At an all-expedition cutoff that is the 50 reveals: three
  invocations.
- `runWorker` claims settlements before reveals, so the released settlements waited for minute 1, and preparation for minute 2:
  publication at about 121.6 s.

**Why dispatch counting alone would not do.**
- Counting the released settlements makes the cutoff tick dispatch five invocations. But the extra two would find no ready
  settlement and exit, while the three that reveal spend their 20-job budget on reveals.
- So `claim_jobs(…,'settlement',…)` now takes a released settlement together with the reveals it waits on: reveals first,
  never splitting the group across the cap.
  - Each row is locked with SKIP LOCKED and re-checked after the lock, so a claim never waits and cannot deadlock. A reveal
    another claim holds leaves its settlement for later.
- The worker (`jobs.ts`) is unchanged. It runs each lease by its own kind, so the reveal completes before the settlement
  settles in the same invocation, and `settle_activity` still checks the dependency.
- At an all-expedition cutoff, five invocations each claim ten pairs: 100 jobs, the whole slot.

**Changes** (commit `119f36b`).
- **`supabase/sql/15-release.sql`, third part:**
  - `private.released_by_due_reveals(job, now_ms)`, new: STABLE, invoker, `search_path=""`, owner and `service_role` EXECUTE;
  - `private.dispatch_workers()`: counts released settlements and reports `releasedSettlements`; the ceiling, minute
    accounting and owner-only ACL are unchanged;
  - `public.claim_jobs`: the settlement branch; every other kind unchanged; one shared lease statement.
- **Migration:** `supabase/migrations/20261019124532_dispatch_released.sql` (M19).
- **Tests:**
  - `tests/db/activities.test.ts`, new case: claim and dispatch semantics on pinned database time, rolled back;
  - `tests/db/capacity.test.ts`, new cadence case: real tick and worker. The measurement case's boundary check is now always
    on; its budgets stay gated;
  - `tests/fixtures/capacity.ts`: per-window first ticks and cutoff-tick settlements, `measureCadence`;
  - `tests/db/access-matrix.test.ts`: one line added to the pinned `service_role` snapshot, for the helper's EXECUTE.
- **Docs:**
  - `docs/operations/migrations.md`: a new M19 section;
  - `docs/operations/release-evidence.md`: regenerated from the post-fix report run.

**RED** (on M18, before the SQL change; Edge 12:11:13.70 unchanged).
- Claim and dispatch case: `dispatched: 3, claimableSimple: 51` where 5 and 101 were expected.
- Cadence case:
  - slot 302 (after the Woodland slot) published at **121,554 ms**;
  - its cutoff tick dispatched 3 for 50 jobs and settled **0** of slot 301's 50 expeditions;
  - the Arena-only boundaries took 61.6 s.

**GREEN.**
- **On the source:**
  - claim, dispatch and pg_net dispatch cases 4/4;
  - cadence case: slot 302 at **61,535 ms**; cutoff tick 5 dispatched for 100 jobs, 50/50 settled in it; Arena-only 61.6 s
    (unchanged); no flagged report.
- **Full `npm run test:db`:**
  - on the source: 274/274;
  - on the clean M01–M19 replay: **274/274**.
- `npm test` 1,117/1,117. `npm run typecheck` clean.

**M19 generation and completion.**
1. `db reset --local --no-seed --yes` to M01–M18. The fingerprint (Task 23.2's script, 1,134 lines) matched Task 23.2's
   recorded M18 replay **byte for byte**.
2. Applied the source once with the psql fallback after the container label check (`Cloudiator`).
   - **Fingerprint diff,** exactly the expected set: the `claim_jobs` and `dispatch_workers` bodies, and the new helper's line.
   - **Lint:** one plpgsql_check warning (an untyped `'{}'` literal assigned to `uuid[]`), fixed in the source with `::uuid[]`
     and reapplied; then empty.
3. `npx supabase db pull dispatch_released --local --schema public,private --yes` (migra) wrote the draft. A copy is kept as
   `scratchpad t233/dispatch-released-draft-as-generated.sql`. It needed three completions:
   - the helper ahead of its two callers (the draft created `claim_jobs` first);
   - the function ACLs;
   - a provenance header and `notify pgrst`.
   The three function statements are as generated, line for line, and no unchanged function was re-emitted.
4. **Replay.** A clean reset replayed M01–M19, with no source applied afterwards.
   - **Fingerprint:** byte-identical to the source-applied one (1,135 lines), and again after the full test run.
   - **Inspection:**
     - `claim_jobs` and the helper `{postgres=X/postgres,service_role=X/postgres}`; `dispatch_workers` `{postgres=X/postgres}`;
     - all three invoker with `search_path=""`;
     - 44/44 triggers enabled; both cron jobs active; no function executable by anon or authenticated;
     - after the runs: scheduler off, no Vault worker secret.
   - **Lint:** empty.
   - **Advisors:** 36 INFO on the fresh replay (unused indexes, no statistics) and 1 INFO after the tests, no WARN or ERROR.
   - `migration list --local` shows M01–M19.

**Capacity report after the fix** (12:53–12:55 UTC, Edge 12:31:44.11 unchanged, exit 1 for the database budget):

| Budget | Before M19 | After M19 |
|---|---|---|
| Boundary publication, worst of 7 windows | 121.6 s, 101.3 % (blocker) | **61.6 s, 51.3 %** (every window 61.5–61.6 s) |
| Database at 90 days / after a year (mixed) | 178.1 / 274.0 % | 178.1 / 274.1 % (unchanged, pending Avi) |
| Database at 90 days / after a year (new-character schedule) | 150.6 / 227.8 % | 150.5 / 227.4 % |
| Egress raw, players and viewers (30 / 31 days) | 81.6 / 83.7 % (risk) | **77.1 / 79.0 %** |
| Egress raw with backend traffic | 117.4 / 120.6 % | 113.0 / 115.9 % (conditional, Task 24) |
| Egress gzip, players and viewers | 19.1 / 19.6 % | 18.6 / 19.0 % |
| Invocations / at the dispatch ceiling | 13.9–14.3 % / 82.0–84.7 % | the same |
| Worker, season close, standings | ≤ 9.5 % / ≤ 0.1 % / ≤ 0.9 % | ≤ 9.3 % / ≤ 0.1 % / 0.6 % |

Egress fell because the shorter boundary removes about one revision change per slot (10.5 to 9.5 in a regular slot).

**Edge StartedAt for every DB run of this phase** (all compared before and after):

| Run (UTC) | Scope | Edge before / after | Result |
|---|---|---|---|
| 12:17–12:19 | capacity file, gate unset (ruling 1) | 12:11:13.70 / same | 3/3 |
| 12:26 | RED claim and dispatch case | 12:11:13.70 / same | fails as expected |
| 12:26–12:27 | RED cadence case | 12:11:13.70 / same | fails as expected (121,554 ms) |
| 12:29 | claim, dispatch and pg_net cases (source) | 12:11:13.70 / same | 4/4 |
| 12:29–12:31 | cadence case, twice (source) | 12:11:13.70 / same | pass (61,535 ms) |
| 12:31–12:37 | full suite (source) | 12:11:13.70 / **12:31:44.11** | **discarded** |
| 12:38–12:44 | full suite (source), rerun | 12:31:44.11 / same | **274/274** |
| 12:47–12:52 | full suite on the M01–M19 replay | 12:31:44.11 / same | **274/274** |
| 12:53–12:55 | `node scripts/resource-report.mjs` | 12:31:44.11 / same | exit 1 (database), boundary 61.6 s |

**The discarded run.**
- The container was recreated 5 s into the 12:31 run, a minute after I edited two test files; no Edge file had changed.
- One creation RPC answered `creation-unavailable` in the first file, then. Both reruns passed whole.

**Self-review of the fix.**
- **Locks.** Every lock the claim takes is SKIP LOCKED, so it never waits. A settlement it locks but does not lease, because
  its reveal is held elsewhere or the group does not fit the cap, stays pending; its lock lasts only until the claim commits.
- **Non-settlement claims** select the same rows in the same order with the same lease statement as before. The arena,
  tournament and expedition suites pass unchanged.
- **The released predicate** follows one level only: a reveal must itself be dependency-ready. A catch-up chain of several
  unfinished reveals still drains over ticks, as before.
- **A failed reveal** in a pair leaves its settlement leased until the lease expires (120 s), as any failed job does. Nothing
  is settled out of order: `settle_activity` checks the dependency.
- **Not touched:** Task 23.2's deferred Minor 1 (the `security_invoker` comment in `15-release.sql`).

**Concerns** (in addition to those above).
1. **`npm run test:db` grows by about 45 s more** for the cadence case: about 6 minutes in all now.
2. **C22.** Concern 6 above needs a correction:
   - one `tsc` run (12:26) caused no recreation;
   - the 12:31:44 recreation followed edits to two test files, not a `tsc` run.
   - The trigger is still unproven. The upkeep proposal (concern 7) becomes: take the Edge baseline only after the last edit
     and typecheck, once the container has run for a minute.
3. **Hosted check (Task 24):** the cutoff-tick dispatch spacing at five invocations (C4).

## Fix round 1

**Review:** `.superpowers/sdd/2026-10-19-task-23-release-readiness/task-23.3-review.md` (range 656cdd0..a857b9c).

**Controller rulings** (2026-10-19):
- fix Important 2 in a new migration (M20);
- name Important 1 as a risk without mitigating it now, and pin the cadence case to 50 characters;
- fix Minors 3, 5, 7 and 8; leave Minors 1, 2, 4 and 6.

**Commits:**
- `76449e6` fix: lease a shared reveal once, before its settlements (M20)
- `91f3a94` test: pin the cadence case to 50 characters and print sections only in report runs
- `7ad457f` fix: report a missing capacity measurement as missing, never ok
- `7dc24fd` docs: name the zero-headroom latency risk at 50 characters
- this section (`docs: report Task 23.3 fix round 1`)

### Important 2: a reveal that several settlements share (M20)

**Change.**
- `supabase/sql/15-release.sql:216–221` (`claim_jobs`, settlement branch): the prerequisite query adds
  `and p.id<>all(picked)`, so a group adds only the reveals this claim has not taken yet. The cap check (:222) and the lock
  re-check (:227–233) see only those ids. The comments are at :1–4 and :185–190.
- `supabase/migrations/20261019132814_shared_reveal.sql` (M20): generated by `db pull shared_reveal`, then completed with the
  function ACL, a provenance header and `notify pgrst`. M01–M19 are untouched.
- `tests/db/activities.test.ts:824–876`: the new case.
- `docs/operations/migrations.md`:
  - a new M20 section (:3–80): problem, change, completions, catch-up, tests, replay evidence;
  - in M19's section, a pointer to M20 and the known trade-off (:127–133, Minor 8).

**RED** (13:21 UTC on M19's source; Edge 13:19:05.31, the same before and after).
- The case uses the tournament-final shape: a completed bout, its reveal R due at the cutoff, and settlements S1 and S2 waiting
  on both.
- **Cap 3:** received `[R, S1]`, expected `[R, S1, S2]`. S2 stayed `pending` with 0 attempts: the shared reveal counted twice
  against the cap.
- **Forced hash join, cap 20** (`enable_nestloop=off`, `enable_mergejoin=off`, `plan_cache_mode=force_custom_plan`):
  received `[S1, R, S2]`. A settlement was leased before its reveal.
- **Passed on M19 too:**
  - one lease and one attempt row per job;
  - dispatch: 3 claimable (`releasedSettlements: 2`), 1 dispatched;
  - cap 2: `[R, S1]`;
  - a second claimer takes nothing while R is leased to the first.
- The first RED attempt (13:20) failed on the test's own setup: `immutable job`, because `guard_job` allows completion only
  from a lease. The bout is now inserted as completed.

**GREEN.** On the fixed source (13:22, Edge unchanged), 4/4: the M20 case, the M19 case and both dispatch-budget cases.

**Catch-up.**
- When a shared reveal is unfinished as its N settlements fall due, `dispatch_workers()` still counts 1 + N jobs, though only
  the claim that leases the reveal can take them.
- As ruled, the accounting is unchanged. migrations.md (M20, "Catch-up") says the remaining settlements wait for the next tick.

**Generation and completion.**
1. **Reset.** `db reset --local --no-seed --yes` to M01–M19. The fingerprint (Task 23.2's script) matched Task 23.3's
   recorded M19 replay byte for byte: 1,135 lines.
2. **Source.** Applied once with the psql fallback, after the container label check (`Cloudiator`).
   - The fingerprint diff is one line: the `claim_jobs` body hash. Its ACL, security, volatility and `search_path` are
     unchanged.
   - Lint is empty.
3. **Draft.** `npx supabase db pull shared_reveal --local --schema public,private --yes` (migra) wrote the draft; a copy is
   kept as scratchpad `t233f1/shared-reveal-draft-as-generated.sql`.
   - It held only `claim_jobs`: no unchanged function was re-emitted.
   - Completions: the function ACL (the source's revoke from public, anon and authenticated, and the `service_role` grant),
     a provenance header and `notify pgrst`.
   - The body is byte-identical to the source's (4,278 bytes, compared programmatically) and to the source-applied `prosrc`.
   - Against M19's body it differs only in the new condition and two comment lines.
4. **Replay.** A clean reset replayed M01–M20, with no source applied afterwards.
   - **Fingerprint:** byte-identical to the source-applied one (1,135 lines), and again after the full test run.
   - **Inspection:**
     - `claim_jobs`: `{postgres=X/postgres,service_role=X/postgres}`, invoker, volatile, `search_path=""`, body with the fix;
     - `dispatch_workers` and `released_by_due_reveals` unchanged;
     - 44/44 triggers enabled; both cron jobs active; no function executable by anon or authenticated;
     - 20 migrations recorded;
     - after the tests: scheduler off, no Vault worker secret.
   - **Lint:** empty.
   - **Advisors:** 36 INFO `unused_index` on the fresh replay and 1 INFO after the tests; no WARN or ERROR.

### Important 1: zero headroom at 50 characters (named, not mitigated)

`docs/operations/release-evidence.md` now states it in four places:
- the status lines (:10–12);
- the budget table's boundary line (:149), now "risk: zero headroom";
- a "Headroom" paragraph and an M20 note in "Boundary latency" (:248–262);
- risk 5 (:372–389), rewritten.

**The statement:**
- at 50 all-expedition characters the cutoff tick is exactly full: 5 invocations × 20 simple jobs = 100 jobs;
- a 51st character steps publication back to about 121.6 s (derived, not measured);
- mitigation options for when active characters approach 50, none built: make the final reveal fall due before the cutoff,
  fold it into the settlement, or raise the cutoff tick's capacity;
- Task 23.7's idle pause would reduce the active cohort (designed, awaiting Avi, not built).

**The watch.** The ruling names the health report's active-character count, but the health report has no such count today.
It reports jobs, boundaries, dispatches per hour and resources. The evidence says so and names the symptoms the report does
show; see Concerns.

**The cadence case is pinned to 50** (`TARGET_CHARACTERS`, `tests/db/capacity.test.ts:24–31`, :109–132).
- It no longer depends on `CAPACITY.players`/`--players`.
- It asserts the full tick explicitly: `claimableSimple: 100, dispatched: 5`.

**Case 1's always-on boundary check now applies up to 50 characters only** (:68–71). This goes one step past the ruling's
letter, to reach its aim.
- Without it, `--players 60` would still fail the suite: scenario 2 sends every character on Woodland in slot 301, and its 120
  jobs do not fit the 100-job cutoff tick.
- Above 50, the windows are still recorded and the report's boundary line gives the verdict. The line's label now names the
  measured character count.
- **Checked** with `node scripts/resource-report.mjs --players 60 --slots 3` (13:49–13:51, Edge unchanged):
  - both suites pass (2/2 and 4/4); exit 1 for the budgets;
  - scenario 2's slot 302 published at **121,811 ms** ("boundary publication at 60 characters", 101.5 %, blocker), while
    every mixed-schedule window took about 61.6 s;
  - this measures, at 60 characters, the step the evidence derives for a 51st.

### Minor 3: no "ok" for a missing measurement

`scripts/resource-report.mjs`:
- `measured`, `verdict` and `worst` (:81–86). A share that is not a finite number is `missing`. `worst` is missing when any
  window is missing or there is none (`Math.max` had read a `null` publication as 0).
- `add` records a missing line as `used: null, percent: null, status: "missing"`, and an absent section gets a missing line
  (:89–144).
- `ok` is false on any missing or blocker line (:145). Exit-code documentation: :23–26.
- The module exports `verdict` and `report` and runs `main` only when invoked directly (:173–188), as `operator-db.mjs` does,
  so a test imports it without discovering the stack.

New `tests/scripts/resource-report.test.ts` (5 cases).
- **RED** after the import-safe refactor and before the fix, 4 failed:
  - `verdict(NaN)` was `'ok'`;
  - a window with `publishedMs: null` printed `used 61500, 51.3 %, ok`;
  - an absent `batch5Ms` was not reported as missing;
  - a missing section produced no missing line.
- **GREEN:** 5/5.

### Minor 5: no measurement dumps in normal runs

- `tests/performance/harness.ts:163–171`, `logSection`, prints a section only when `CAPACITY_REPORT_DIR` (the report) or
  `CAPACITY_GATE=1` is set.
- It replaces the five `console.info` calls: `simulation.test.ts:64`, and capacity, season close, standings and cadence in
  `capacity.test.ts`. `writeSection`'s on-disk sections are unchanged.
- **How it was checked.** In this agent environment vitest uses its `minimal` reporter (std-env `isAgent`), which hides console
  output of passing tests, so these logs were clean even before the fix. The check therefore uses `--reporter=default`, as in a
  terminal:
  - `npm test -- --reporter=default`: 1,122/1,122, no "Task 23.3" section line (the only match is a suite title);
  - with `CAPACITY_GATE=1` the worker section does print;
  - the DB season-close and standings cases with `--reporter=default` (13:53, Edge unchanged): 2 passed, no section line.

### Minor 7 and Minor 8

- **Minor 7.** The "Files" line above now says the measurement commit changed no schema, migration, SQL, `src/` or Edge code,
  and that the latency fix (M19) and this round (M20) did change SQL and migrations.
- **Minor 8.** `docs/operations/migrations.md`, M19 section, "Known trade-off": a failed reveal costs the settlement claimed with
  it one of its three attempts, and holds that settlement's lease for 120 s.

### Verification

| Gate | Result |
|---|---|
| `npm test` | 54 files, **1,122/1,122** (5 new); output clean |
| `npm run typecheck` | `tsc`, `deno check`, `deno test` 2/2: clean |
| `npm run test:db` on the source (13:29–13:35) | 17 files, **275/275**; Edge 13:19:05.31 before and after |
| `npm run test:db` on the M01–M20 replay (13:36–13:42) | 275/275, but the Edge container was recreated 4 s in (13:36:06.10): **discarded** |
| `npm run test:db` on the replay, rerun (13:42–13:48) | **275/275**; Edge 13:36:06.10 before and after |
| Replay fingerprint | identical to the source-applied one, before and after the tests |
| Lint (source, replay) | empty |
| Advisors (replay) | 36 INFO fresh, 1 INFO after the tests; no WARN or ERROR |
| `git diff --check` | clean |

During the discarded run nothing in the worktree changed; a `db reset` had restarted the stack's containers about 40 s before
it. The cause of the recreation is still unproven (C22).

### Concerns

1. **The watch named by the ruling does not exist yet.** The health report has no active-character count. Adding one (for
   example the characters with an activity in the current slot, with a warning near 50) is a small follow-up. Until then, a
   boundary still waiting after the second tick and `jobs.overdue` are the visible symptoms.
2. **The latency risk is real above 50.** At 60 characters it was measured at 121.8 s on the new-character schedule. The
   mitigation is Avi's or the controller's decision; nothing is built.
3. **Case 1's boundary check is scoped to 50 or fewer characters**, one step past the ruling's letter (see Important 1). Make it
   unconditional again if the controller prefers `--players 60` to fail the suite.
