# Release evidence

Task 23's record of what was measured, on what, and what remains open before the public release. Each lane writes its own
section; the controller merges them.

## Lane A: capacity

**Status (Task 23.7, 2026-10-19): the database is within its 500 MB budget at 90 days in both scenarios; after a year it is a
named risk, with the after-launch compaction plan. Egress fails only under a hosted condition (Task 24), and the dispatch
ceiling is a named risk.** Task 23.3 measured the database as a blocker against 250 MB. Avi then chose A + C + D (the
[database budget design](../superpowers/specs/2026-10-19-database-budget-design.md)), and Task 23.7 built A.1 and D ("Task
23.7: the database re-measured" below).
- The boundary-latency blocker this measurement found is fixed (M19, corrected by M20; "Boundary latency" below), but with
  **zero headroom**: at 50 all-expedition characters the cutoff tick is exactly full, and a 51st character would bring the
  121.6 s publication back (derived, not measured). It is a named risk (risk 5).
- Task 23.3, measured on 2026-10-19 on the local stack. Nothing here is a hosted measurement: hosted CPU, compression and billing
  are Task 24 checks.

### Task 23.7: the database re-measured (M21)

Avi's decision (2026-10-19):
- The internal database budget is 500 MB (524,288,000 bytes), and the health report warns at 400 MB.
- Completed jobs' payloads are emptied once their slot has settled (M21; `docs/operations/migrations.md`).
- Idle characters pausing (C) is Task 23.8, built and reviewed since (M22). These figures do not count it: every character
  stays active.

**Command and run.**
- `node scripts/resource-report.mjs` (50 players, 50 viewers, 4 slots), 18:30:56–18:33:24 UTC on the M01–M21 replay.
- The Edge container's start time was unchanged (18:30:24). Both suites passed (2/2 and 4/4).
- Exit 1 only because of the egress lines with backend traffic (risk 2, a Task 24 condition, as before).
- An earlier run on the source-applied database (17:56–17:58) agrees with it within 0.1 % on every database figure.
- Raw client egress came out at 80.7–82.7 % in this run, against 76.4–78.3 % at 17:56: run-to-run variance of the egress
  measurement, which the trim does not touch (it runs after the reads are measured). It sits at the risk line, as before.

| Database (50 characters, all active every slot, 10 commands a day) | Task 23.3 | After M21 | Share of 500 MB | Verdict |
|---|---|---|---|---|
| 90 days, mixed schedules | 445.4 MiB | 409.8 MiB | 82.0 % | under the budget; risk (over 80 %) |
| One year, mixed schedules | 685.2 MiB | 649.7 MiB | 129.9 % | **risk** (after-launch compactions) |
| 90 days, new-character schedule | 376.2 MiB | 346.1 MiB | 69.2 % | ok |
| One year, new-character schedule | 568.5 MiB | 539.3 MiB | 107.9 % | **risk** (after-launch compactions) |

- **The trim** saves about 35 MiB (mixed) and 29 MiB (new-character schedule) at 90 days.
  - A job row is modeled at 2,109 B with its payloads and 867 B compacted (mixed; 2,061 and 866 B on the new-character
    schedule). The fixed columns, the seed and the seven indexes stay.
  - A job keeps its payloads for 20 slots: 19 behind the checkpoint, plus the hourly tick's lag
    (`JOB_PAYLOAD_SLOTS` in `tests/performance/capacity-model.ts`).
  - The detail class at 90 days falls from 139.5 to 104.2 MiB (mixed), and from 111.3 to 81.8 MiB.
- **Cross-check (in the test only).** The capacity case compacts the run's settled slots through `private.cleanup_history`:
  three calls, of 757, 278 and 0 jobs, in 31, 5 and 1 ms. The unsettled last slot's 280 jobs keep their payloads. The case
  then rewrites `private.jobs` with `VACUUM FULL`. Per row, for that mix of 1,035 compacted and 280 full rows:
  - modeled live size 943 B;
  - measured live size 910 B;
  - file growth 829 B, 12 % under the model (the rebuilt indexes are fuller than the model's 75 %).
  The case asserts the file growth within 25 % of the model.
- **The gate.**
  - `CAPACITY_GATE=1` now enforces both 90-day figures. The one-year figures are recorded and reported as a risk, never a
    blocker.
  - The release gate passed end to end (`npm run verify`, exit 0; "Release gate (Task 23.6)", the Task 23.7 run).
- **The 400 MB warning** (419,430,400 bytes):
  - At the mixed worst case it comes before day 90: 409.8 MiB is 429.7 million bytes.
  - On the new-character schedule it comes after about 5½ months: about 2.6 months past day 90, at 21 MiB a month of
    permanent rows.
  - Real figures are lower by every idle or unscheduled character.
  - The warning is the trigger for the structural compactions: settled slots as per-character ranges, and command receipts
    older than 90 days as a fingerprint (Avi's decision, 2026-10-19: after launch).
- **Physical size** can run above the modeled figures until autovacuum reuses the space a compaction frees. The health
  report's warning and alert read the physical `pg_database_size`.

### How it was measured

- **Command:** `node scripts/resource-report.mjs` (defaults `--players 50 --viewers 50 --slots 4`). It discovers the local
  stack in memory, refuses anything that is not loopback, and runs two suites:
  - `tests/performance/simulation.test.ts` (pure code, also in `npm test`);
  - `tests/db/capacity.test.ts` (also in `npm run test:db`).
  The arithmetic is in `tests/performance/capacity-model.ts`, pinned by `tests/performance/capacity-model.test.ts`.
- **Gate** (controller ruling, 2026-10-19): `tests/db/capacity.test.ts` enforces the database budget at 90 days (both
  scenarios), the invocation budget and the raw-egress budget only with `CAPACITY_GATE=1`. Since Task 23.7 the one-year
  database figures are recorded and reported as a risk, never enforced.
  - Without the flag (a plain `npm run test:db`), the case still measures and records every number and checks the run itself.
    A plain run therefore never fails on a budget.
  - The boundary-publication check (every window under 120 s) has been on since the fix, at up to 50 characters (spec §10.4's
    load). With `--players` above 50 the windows are still recorded, and the report's boundary line gives their verdict.
  - The cadence case (`publishes within 120 s after a slot of expeditions …`) always runs 50 characters, whatever `--players`
    is (fix round 1).
  - The measured sections are printed on the console only in a report run (or with `CLOUDIATOR_MEASUREMENTS=1`); a plain
    `npm test` or `npm run test:db` prints none of them (fix round 1), and since Task 23.6 neither does the gate's
    `CAPACITY_GATE=1` run, whose failed checks name their numbers (C23). A measurement the suites did not produce is reported
    as `missing` and fails the report, never `ok`.
  - Task 23.6's release gate runs the file with the flag. Since Task 23.7 it passes: at 90 days the database is at 82.0 % and
    69.2 % of 500 MB. The one-year figures (129.9 % and 107.9 %) remain a named risk, with the structural compactions after
    launch (risk 1; "Gate of record" below).
  - The report's verdicts and exit code do not depend on the flag.
- **Environment:**
  - 13th Gen Intel Core i9-13900K (32 logical cores, 32 GiB), Windows 11 Pro 10.0.26200;
  - Node 22.19.0 (V8 12.4);
  - PostgreSQL 17.11 in the Supabase CLI 2.120.0 stack (M01–M19 replayed), Docker Desktop.
  - The recorded run is 12:53–12:55 UTC (exit 1: the database budget), with the Edge container's start time unchanged
    (12:31:44.11).
  - Pre-fix runs (M18) at 11:55–11:57 and 12:07–12:09 recorded the same verdicts but the boundary's.
- **Measurement world (scenario 1, the upper bound):**
  - 50 real characters (real creation, then placed at historical slots by the operator, as the Arena tests do);
  - three rotating schedules with no Rest: Arena / Arena / Woodland, Woodland / Arena / Training, Training / Arena / Arena;
  - every character opted in and starting rested, so no slot of the run falls back to Rest.
  Each regular slot mixes 17 Arena, 17 Woodland expedition and 16 Training. Slot 301 (Saturday 17:20 UTC) is a tournament
  slot, where all 50 enter one Bronze bracket.
- **Scenario 2 (the default):** the same 50 characters on the new-character schedule, Training / Woodland / Rest.
- **Cadence:**
  - a warm-up slot, then the measured slots;
  - each ticked every minute of database time for all 80 minutes, 300 ms into the minute;
  - each tick runs pg_cron's `private.cron_tick()` and the real private Edge worker through pg_net, and waits until every
    invocation answers.
  That is 400 ticks (67.3 s of wall time) for scenario 1 and 320 ticks (22.7 s) for scenario 2.
- **What the run counts:** dispatches per tick, revision changes per tick, and rows added per slot in every table.
- **Row sizes** are modeled from the live rows:
  - the tuple as `pg_column_size(row)` gives it (TOAST values compressed);
  - plus a line pointer;
  - plus one entry per index at 75 % leaf fill;
  - then a 20 % allowance for autovacuum's equilibrium.
  The `VACUUM FULL` cross-check (tables with at least 200 rows) puts the live estimate within 15 % of the compact file size
  per row. Examples (modeled live / compact): jobs 1,761 / 1,819 B; activities 788 / 852 B; receipts 860 / 931 B; settled slots
  229 / 246 B. The run's own file growth per row is 1.6 to 2.7 times larger, because of dead row versions and first pages.
- **Read sizes** are real local Data API responses of the app's own read adapters (`src/lib/api/reads.ts`), as a visitor
  (anon) and as a signed-in player. Bodies are compressed with node zlib (gzip level 6, brotli quality 5), and headers are
  counted uncompressed. Local Kong does not compress, so hosted compression is a Task 24 check.

### The report

Task 23.3's output of `node scripts/resource-report.mjs` (exit 1: the database budget), before M21 and against the 250 MB
budget (Task 23.7's re-measured database figures are above), condensed. The `measured` block (every table's
rows and row sizes, the per-tick record) is left out. Database figures are bytes; read sizes are raw / gzip / brotli body
bytes, before their headers.

```json
{
  "ok": false,
  "target": "local",
  "options": {"players":50,"viewers":50,"slots":4},
  "database": {"bytesPerSlot":1297693,"steadyStateBytes":466985714,"atOneYearBytes":718527796,"budgetBytes":262144000,"permanentBytesPerMonth":27399294,"defaultSchedule":{"bytesPerSlot":1034846,"steadyStateBytes":394485422,"atOneYearBytes":596105288,"permanentBytesPerMonth":21953234}},
  "invocations": {"perSlot":{"regularPerSlot":21.5,"tournamentPerSlot":23.5,"weighted":21.5},"perMonth":{"30d":{"worker":11628,"commands":30000,"total":41628,"ceiling":246000},"31d":{"worker":12015,"commands":31000,"total":43015,"ceiling":254200}},"budget":300000},
  "egress": {
    "perRead": {
      "revision": {"visitor":[115,114,83],"player":[115,114,82]},
      "world": {"visitor":[29069,3975,3691],"player":[29069,3975,3692]},
      "ownerStarter": {"visitor":[0,0,0],"player":[2611,882,830]},
      "timelineArena": {"visitor":[17150,1614,1375],"player":[17152,1616,1376]},
      "timelineOwn": {"visitor":[12945,1659,1470],"player":[13443,1998,1773]},
      "timelineTraining": {"visitor":[318,296,233],"player":[320,298,235]},
      "timelineTournament": {"visitor":[18955,1980,1677],"player":[19360,2280,1937]},
      "profile": {"visitor":[655,394,369],"player":[655,394,369]},
      "recent": {"visitor":[18775,3545,3206],"player":[18775,3545,3206]},
      "seasons": {"visitor":[81,81,67],"player":[81,81,67]},
      "standings": {"visitor":[8897,1880,1741],"player":[8897,1880,1741]},
      "standingOf": {"visitor":[215,198,172],"player":[215,198,172]},
      "tournament": {"visitor":[60252,10203,9301],"player":[60252,10203,9301]},
      "tournamentLog": {"visitor":[12844,1341,1128],"player":[12844,1341,1128]},
      "market": {"visitor":[24107,2862,2533],"player":[24107,2862,2533]},
      "command": {"visitor":[0,0,0],"player":[116,116,96]},
      "authLookup": {"visitor":[0,0,0],"player":[1446,426,381]},
      "authRefresh": {"visitor":[0,0,0],"player":[2646,1326,1281]},
      "owner": {"visitor":[0,0,0],"player":[26908,3036,2840]}
    },
    "perMonthPlayers": {"30d":{"raw":1289869463,"gzip":310796279,"brotli":293174249},"31d":{"raw":1323088333,"gzip":319054334,"brotli":300984719}},
    "perMonthViewers": {"30d":{"raw":1023625646,"gzip":245800877,"brotli":230675923},"31d":{"raw":1047969722,"gzip":251892419,"brotli":236403115}},
    "perMonthBackend": {"30d":{"raw":1075160697,"gzip":194266707,"brotli":181493579},"31d":{"raw":1107204008,"gzip":200370102,"brotli":187236429}},
    "budget": 3000000000
  },
  "worker": {"worstCombatMs":6.7,"batch5Ms":18.4,"bracket50Ms":2.7,"tournamentBatch5Ms":185.8},
  "seasonClose": {"ms50":11,"ms500":26},
  "standings": {"pageMs":4.5,"oneRowMs":4.5},
  "boundary": {"targetMs":120000,"publishedMs":{"mixed":[[300,61600],[301,61587],[302,61547],[303,61578]],"defaultSchedule":[[300,61494],[301,61510],[302,61503]]}},
  "budgets": [
    ["database at 90 days, mixed schedules",178.1,"blocker"],
    ["database after one year, mixed schedules",274.1,"blocker"],
    ["database at 90 days, new-character schedule",150.5,"blocker"],
    ["database after one year, new-character schedule",227.4,"blocker"],
    ["invocations, 30-day month",13.9,"ok"],
    ["invocations, 31-day month",14.3,"ok"],
    ["invocations at the dispatch ceiling, 30-day month",82,"risk"],
    ["invocations at the dispatch ceiling, 31-day month",84.7,"risk"],
    ["egress raw, players and viewers, 30-day month",77.1,"ok"],
    ["egress raw, players and viewers, 31-day month",79,"ok"],
    ["egress gzip, players and viewers, 30-day month",18.6,"ok"],
    ["egress gzip, players and viewers, 31-day month",19,"ok"],
    ["egress raw with backend traffic, 30-day month",113,"blocker"],
    ["egress raw with backend traffic, 31-day month",115.9,"blocker"],
    ["boundary publication at 50 characters (worst window)",51.3,"ok"],
    ["worker worst 120 s fight",0.3,"ok"],
    ["worker batch of 5",0.9,"ok"],
    ["worker 50-entrant bracket",0.1,"ok"],
    ["worker tournament bout batch",9.3,"ok"],
    ["season close, 4 leagues x 50",0,"ok"],
    ["season close, 4 leagues x 500",0.1,"ok"],
    ["standings page at 1,000 rows (Data API)",0.6,"ok"],
    ["one standing row at 1,000 rows (Data API)",0.6,"ok"]
  ]
}
```

### Budgets

| Budget | Used | Limit | Share | Verdict |
|---|---|---|---|---|
| Database at 90 days, mixed schedules (Task 23.7, M21) | 409.8 MiB (Task 23.3: 445.4) | 500 MiB | 82.0 % (Task 23.3: 178.1 % of 250) | risk, under the budget |
| Database after one year, mixed schedules (Task 23.7, M21) | 649.7 MiB (Task 23.3: 685.2) | 500 MiB | 129.9 % (Task 23.3: 274.1 % of 250) | **risk** (after-launch compactions; Avi's decision) |
| Database at 90 days, new-character schedule (Task 23.7, M21) | 346.1 MiB (Task 23.3: 376.2) | 500 MiB | 69.2 % (Task 23.3: 150.5 % of 250) | ok |
| Database after one year, new-character schedule (Task 23.7, M21) | 539.3 MiB (Task 23.3: 568.5) | 500 MiB | 107.9 % (Task 23.3: 227.4 % of 250) | **risk** (after-launch compactions; Avi's decision) |
| Boundary publication at 50 characters (worst of 7 windows) | 61.6 s (before M19: 121.6 s) | 120 s | 51.3 % (before: 101.3 %) | **risk: zero headroom** (fixed by M19 at exactly 50; a 51st all-expedition character steps back to about 121.6 s, derived; risk 5) |
| Egress raw, players and viewers, 31-day month | 2.371 GB | 3 GB | 79.0 % | ok, at the risk line |
| Egress gzip, players and viewers, 31-day month | 0.571 GB | 3 GB | 19.0 % | ok |
| Egress raw with backend traffic, 31-day month | 3.478 GB | 3 GB | 115.9 % | **blocker if hosted counts it uncompressed** |
| Invocations, 31-day month (10 commands a player a day) | 43,015 | 300,000 | 14.3 % | ok |
| Invocations at the dispatch ceiling, 31-day month | 254,200 | 300,000 | 84.7 % | risk |
| Worker: worst 120 s fight / batch of 5 / bracket / bout batch | 6.7 / 18.4 / 2.7 / 185.8 ms | 2,000 ms | ≤ 9.3 % | ok (this machine) |
| Season close, 4 × 50 / 4 × 500 rows | 11.0 / 26.0 ms | 43,950 ms | ≤ 0.1 % | ok |
| Standings page / one row at 1,000 rows (Data API) | 4.5 / 4.5 ms | 750 ms | 0.6 % | ok |

For the 30-day month:
- raw egress is 77.1 %, and 113.0 % with backend traffic;
- the dispatch ceiling is 82.0 %;
- invocations are 13.9 %.

### Database

**Retention windows** (14-operations.sql's matrix):
- detail: 126 slots (7 days);
- summaries: 1,620 slots (90 days);
- permanent: settled slots, receipts (a settlement receipt compacted at 90 days), season archives;
- operational: the dispatch log for 48 hours, cron's run log for 7 days, pg_net for 6 hours.

A week has 124 regular slots and 2 tournament slots; a tournament slot's rows are its own window plus its settlement.

**Per slot (scenario 2), the main rows:**

| Table (class) | Rows | Modeled bytes/row | Bytes/slot |
|---|---|---|---|
| jobs (detail) | 250 | 2,052 | 513 KB |
| activity_stages (detail) | 133 | 952 | 127 KB |
| expedition_plans (detail) | 17 | 5,484 | 91 KB |
| activity_snapshots (detail) | 50 | 1,802 | 90 KB |
| activities (summary) | 50 | 903 | 45 KB |
| recent_results (summary) | 50 | 506 | 25 KB |
| settled_slots (permanent) | 50 | 274 | 14 KB |
| operation_receipts, settlement (permanent) | 17 | 1,016, then 306 compacted | 17 KB |

**Arithmetic at 90 days** (scenario 2; scenario 1 in brackets):
- **Detail** (126 × the detail bytes a slot): 111.3 MiB (139.5). Jobs alone are about 62 MiB: 250 × 126 × 2,052 B.
- **Summaries** (1,620 × the summary bytes a slot): 117.0 MiB (130.5). Activities are about 70 MiB: 50 × 1,620 × 903 B; recent
  results about 39 MiB.
- **Permanent:** 47.3 MiB (74.3). Settled slots are about 21 MiB: 50 × 1,620 × 274 B.
- **Commands** (10 a player a day): 80.8 MiB.
  - Receipts: 50 × 10 × 90 × 787 B, permanent, never compacted.
  - 90-day rows: one beside each receipt, at the largest of a listing with its offer, a ledger row or a superseded schedule
    revision (1,095 B).
- **System:** 15.8 MiB.
  - The catalogs, extensions and empty tables. The local catalog is bloated by tests, so this is conservative.
  - Cron's 7-day run log, pg_net's 6 hours, and Auth's rows for 50 accounts.
- **Player state** with a full 60-item inventory each: 3.5 MiB. **Seasons:** 0.1 MiB.

**After one year:** permanent rows grow by 20.9 MiB a month (26.1 in scenario 1), and command receipts by about 11.3 MiB a
month at 10 commands. A season adds 37 KB.

**Command-rate sensitivity** (scenario 2, 90 days / one year):

| Commands a player a day | 90 days | One year |
|---|---|---|
| 0 | 295.4 MiB | 384.5 MiB |
| 5 | 335.8 | 476.5 |
| 10 | 376.2 | 568.5 |
| 20 | 457.0 | 752.5 |

Even with no commands and no autovacuum allowance (÷ 1.2), the year is over budget. This budget is Avi's decision (controller
ruling: retention and database sizing are not changed in Task 23.3).

### Boundary latency (spec §10.4, Global Constraints)

**Observed before M19** (M18; runs at 11:40–11:57, both scenarios):

| Run | Publication after the cutoff |
|---|---|
| Scenario 1, slots 300 / 301 / 302 / 303 | 121.6 / 121.6 / 61.8 / 121.6 s |
| Scenario 2, slots 300 / 301 / 302 | 61.6 / 61.6 / 121.6 s |

Every boundary whose previous slot had expeditions took a third tick.
- An expedition's settlement job depends on its last reveal, the "Arrive at camp" stage, which falls due exactly at the next
  cutoff.
- The cutoff tick's `dispatch_workers()` counted only dependency-ready jobs: 50 reveals at an all-expedition cutoff, so three
  invocations.
- `runWorker` claims settlements before reveals, so the released settlements waited for minute 1 and preparation for minute 2.

**Fixed by M19** (`supabase/sql/15-release.sql`, third part; `docs/operations/migrations.md`, M19):
- `dispatch_workers()` also counts a settlement whose every unfinished prerequisite is a claimable due reveal.
- `claim_jobs(…,'settlement',…)` leases such a settlement together with those reveals, reveals first and never split across the
  cap. The unchanged worker completes the reveal, then settles.
- Unchanged: the five invocations per scheduled minute and their per-scheduled-minute accounting (Task 23.2).

| After M19 (12:53–12:55 run) | Publication after the cutoff |
|---|---|
| Scenario 1, slots 300 / 301 / 302 / 303 | 61.6 / 61.6 / 61.5 / 61.6 s |
| Scenario 2, slots 300 / 301 / 302 | 61.5 / 61.5 / 61.5 s |

- In scenario 1 the cutoff tick now dispatches 4 invocations for 67 claimable jobs (it was 3 for 50), and settles all 50
  activities of the previous slot.
- The dedicated cadence test (`tests/db/capacity.test.ts`, 50 characters) publishes the post-expedition boundary at 61.5 s (it
  was 121.6 s): 5 invocations for 100 jobs, all 50 settled in the cutoff tick. The Arena-only boundaries stay at 61.6 s.

**Headroom: none at 50 all-expedition characters** (Task 23.3 review, Important 1).
- On the new-character schedule every character runs Woodland in the same slot, so the next cutoff tick carries two simple
  jobs per character: the final "Arrive at camp" reveal and the settlement it releases.
- That tick can take at most 5 invocations (the per-minute ceiling) × 20 simple jobs (`WORKER_LIMITS.simple`) = **100 jobs**.
  At 50 characters it is exactly full: the cadence test measures `claimableSimple: 100, dispatched: 5`.
- A **51st** character leaves one reveal and its settlement for minute 1, and preparation for minute 2: publication about
  **121.6 s** (101 % of the target), as before M19. This is derived from the mechanism measured before M19, not measured.
- The mixed schedules of scenario 1 put about a third of the characters on an expedition per slot (67 claimable jobs at the
  cutoff, 4 invocations), so they have room; only a cohort that all goes on expedition together reaches the edge.
- Risk 5 below names the watch and the mitigation options.

**M20 (fix round 1).** When several settlements share one due reveal (every tournament entrant's settlement waits on the
final's reveal), M19's claim listed that reveal once per settlement: it counted against the cap once per settlement and, under
a hash-join plan, came back after the first settlement. M20 lists it once, before them. It changes nothing in the windows
above (expedition settlements each wait on their own reveal); `docs/operations/migrations.md`, M20.

### Egress

**Measured responses** (raw bytes / gzip / requests):

| Read | Size |
|---|---|
| revision | 115 / 114 B / 1 |
| world (50 actors, its two revision checks) | 29,069 / 3,975 / 4 |
| owner, full inventory | 26,908 / 3,036 / 1 |
| owner, starter inventory | 2,611 / 882 / 1 |
| arena timeline | 17,150 / 1,614 / 3 |
| own expedition timeline | 13,443 / 1,998 / 4 |
| results page | 18,775 / 3,545 / 1 |
| market page (50 offers) | 24,107 / 2,862 / 1 |
| standings page | 8,897 / 1,880 / 2 |
| standing row | 215 / 198 / 2 |
| profile | 655 / 394 / 1 |
| seasons | 81 / 81 / 1 |
| tournament view, late, 50 entrants (C10) | 60,252 / 10,203 / 7 |
| tournament log (mean of 49) | 12,844 / 1,341 / 2 |
| command (preflight and response) | 116 / 116 / 2 |
| the function's session lookup in Auth | 1,446 / 426 / 1 |

Headers are about 470 bytes a response.

**Usage model**, per person with the camp visible 30 minutes a day:
- **Polls:** 2 revision reads a minute.
- **Re-reads:** the world (and, for a player, the owner state, the standings page and its own row; the panel is assumed open
  all session) at every revision change it sees. The run measured 9.5 changes in a regular slot and 7.5 in a tournament slot,
  plus one for the slot index. A split factor of 1.040 covers commits that straddle a poll.
- **Arena timelines:** the camp reads each Arena entrant's timeline once per slot whose minute-60 to minute-80 window the
  session overlaps: 17 entrants × (30 + 20) / 80.
- **Entry loads.**
- **A player's own traffic:** 10 commands a day with their preflights, and one session refresh a day.
- **Tournaments:** the 9 tournament days a month at 30/80 coverage, each with 16 view reads (camp and panel) and all 49 logs
  (676,254 B raw incl. headers).

**Month** (31 days, 9 tournaments):
- players 1.323 GB raw (0.319 gzip);
- 50 visitors 1.048 GB raw (0.252 gzip);
- together 2.371 GB raw (79.0 %), 0.571 GB gzip (19.0 %).

**Backend traffic (an estimate):** the worker's own Data API responses (claimed job inputs, tournament graph reads, owner state
for expedition settlements), plus each command's session lookup, owner read and RPC responses. That is 1.107 GB raw
(0.200 gzip) a month; it counts only if hosted egress includes Edge-to-API traffic (Task 24).
- Within it, each tournament bout's fenced read returns the whole stored graph with every earlier log.
- At 50 entrants that is about 12 MB for the final when every bout runs to the 120 s cap.

**Always-on visitors:** 50 of them, round the clock, would need 24.9 GB raw (7.0 gzip) a month. The raw budget leaves room
beside the players for 3 always-on visitors.

### Invocations

- **Worker:** the real worker dispatches measured 21.5 a regular slot and 23.5 a tournament slot in scenario 1 (17.3 in
  scenario 2). That is 12,015 a 31-day month (11,628 for 30 days).
- **Commands:** 10 a player a day, each with its CORS preflight (no `Access-Control-Max-Age`): 31,000.
- **Total:** 43,015 (14.3 %).
- **Ceiling:** the dispatch ceiling of 5 a scheduled minute is 223,200 a 31-day month (216,000 for 30 days). Plus commands it
  is 254,200 (84.7 %), reached only if work were due every minute.

### Worker, season close and standings

- **Worker** (the budget is 1,500 ms: cpuMs 2,000 less 25 %):
  - worst 120 s fight (961 events): 6.7 ms at worst, the cold first run included;
  - five of them: 18.4 ms;
  - five long Mountain expeditions: 10.5 ms;
  - the 50-entrant pairing job (partition, bracket, graph check): 2.7 ms;
  - five final-bout jobs, each parsing a 12.2 MB graph read: 185.8 ms.
  This machine is fast. Hosted Edge CPU is C4, a Task 24 check.
- **Season close (C14),** one statement with its commit-time projections:
  - 4 leagues × 50 rows, 12 awards: 11.0 ms;
  - 4 × 500 rows, 12 awards: 26.0 ms.
  The budget is 43,950 ms (what the 120 s boundary target leaves after a 61.4 s publication, less 25 %). The synchronous close
  stays.
- **Standings (C13)** at 1,000 rows of one league and season, through the Data API as a visitor:
  - a page and one row each take 4.5 ms (medians of 15);
  - their plans execute in 1.9 ms and 1.8 ms;
  - both evaluate the window over the whole league-season (WindowAgg over `arena_standings_rank_idx`, 6,688 shared buffer
    hits).
  Recommendation: no rank cache now. Revisit when one league-season passes about 10,000 rows, or when the plan's execution
  passes 100 ms.

### Risks and mitigations

1. **Database (Task 23.7: within the budget at 90 days; the year is a risk).**
   - Avi chose A + C + D on 2026-10-19: the trim of settled jobs' payloads (M21), idle characters pausing (Task 23.8) and a
     500 MB budget with a 400 MB warning.
   - At 90 days the database is at 82.0 % and 69.2 % of 500 MB; after one year at 129.9 % and 107.9 %. The structural
     compactions wait until after launch, when the warning appears ("Task 23.7: the database re-measured").
   - Task 23.3's finding, kept for the record, follows.

   The 7-day detail and 90-day summaries of 50 characters with an activity every slot
   already exceed 250 MB, and permanent rows add about 21 MB a month. Options for Avi, none built (the ruling keeps retention
   and sizing unchanged here):
   - delete or empty completed jobs' inputs and results once their slot settles (about −60 MiB);
   - keep `recent_results` 7 days, or one completion copy only (about −35 MiB);
   - shorten summaries to 30 days (about −78 MiB);
   - fold settled slots into per-character ranges, and drop compacted settlement receipts that a settled slot guards
     (the year's growth; this reverses a Task 22 ruling);
   - stop scheduling characters whose owner has not signed in for N days;
   - or raise the internal budget toward the free plan's 500 MB.
2. **Egress.**
   - Raw client egress is at 79.0 % (77.1 % in a 30-day month), within a point of the risk line, and it rests on stated
     assumptions (the standings panel open all session, 16 tournament view reads, 10 commands a day). Compressed it is about
     19 %.
   - With backend traffic: 115.9 % raw, but about 26 % compressed. A blocker only if hosted is uncompressed and bills
     Edge-to-API traffic.
   - Task 24 verifies both.
   - Code options (none built): the bout input could carry only its parents' results rather than the whole graph; delta world
     reads; `Access-Control-Max-Age` on the command function.
   - Visitor reads stay unthrottled and monitored (Decision 2); only about 3 always-on visitors fit raw.
3. **Dispatch ceiling (risk).** It is reached only if work were due every minute. The health report and the hosting dashboard
   watch invocations.
4. **Command receipts (carried from Task 22).** 787 B each, permanent: about 11 MiB a month at 10 commands a player a day.
   Part of risk 1.
5. **Boundary latency: fixed at 50 characters with zero headroom (risk).**
   - Measured: 61.5–61.6 s in every window after M19 (51.3 %).
   - At 50 all-expedition characters the cutoff tick is exactly full: 5 invocations × 20 simple jobs = 100 jobs, the 50 final
     reveals and the 50 settlements they release.
   - A 51st character steps publication back to about 121.6 s (101 %): one pair waits for minute 1 and preparation for minute 2.
     This is derived, not measured.
   - **Watch:** the number of active characters (those with an activity in a slot). Since M21 (Task 23.7) the health report
     counts them for the current slot as `cohort.activeCharacters`. Its `boundaries` section (a boundary still waiting after
     the second tick) and `jobs.overdue` show the symptom.
   - **Mitigation options when active characters approach 50 (none built):**
     - make the final reveal fall due before the cutoff, so an earlier tick completes it and the cutoff tick carries only the
       settlements (100 characters fit);
     - fold the final reveal into the settlement job (one job per character at the cutoff);
     - or raise the cutoff tick's capacity: a larger simple batch, or more invocations in the cutoff minute, within the
       invocation budget (risk 3).
   - The idle pause (a character whose owner has sent no activity signal for 14 days leaves the boundary cohort) reduces the
     active cohort. Avi approved it on 2026-10-19 (the database budget design, C). Task 23.8 built it (M22) and Task 23.9
     shows it in the camp, both reviewed; the health report counts the resting characters as `cohort.restingCharacters`.
   - Hosted dispatch spacing is still C4 (Task 24).

## Lane B: render cost

Task 23.4, measured 2026-10-19 on branch `claude/task-23-ui`.

### How it was measured

- **Harness:** `tests/performance/fps.spec.ts`, run with its own config:
  `PLAYWRIGHT_PERF_PORT=3300 npx playwright test --config tests/performance/playwright.perf.config.ts`.
  It never runs in the development or production gates: their `testDir` is `tests/browser`.
- **Build:** the development fixture build (`next dev` with `NEXT_PUBLIC_FIXTURE_ENABLED=true`), so the camp's test hook can set up the scene.
- **Browser:** headed Google Chrome 155.0.8059.80 (Playwright 1.64, `channel: 'chrome'`).
- **WebGL renderer:** `ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)`.
- **Machine:** Intel Core i9-13900K; the display runs at 2560×1440, 170 Hz. The frame rate is capped by vsync, so 170 fps is the ceiling here, not 60.
- **Desktop project:** Playwright's Desktop Chrome device, a 1280×720 viewport.
- **Sampler:** a `requestAnimationFrame` loop injected with `addInitScript` records every frame's timestamp. Each phase uses the definitions in `src/lib/frame-stats.ts`, which the `?perf=1` overlay shares:
  - **mean fps:** frames divided by elapsed time;
  - **p5 fps:** the rate of the 95th-percentile frame interval, by nearest rank;
  - **frames over 16.7 ms and over 33.3 ms:** shares of intervals above each budget by more than 1 ms. The 1 ms allows for timer jitter, since rAF timestamps are coarsened and vsync drifts.
- **The path** (plan Decision 9):
  1. The fixture camp holds `createDemoWorld(now, 50, 6)`'s crowd. That is 50 gladiators in camp and 6 away, joined by the camp's 6 ambient NPCs.
  2. The current slot's 13 Arena entrants fight at minute 60.
  3. The `completed` tournament's 8 entrants are moved into the same slot, so its final is in a ring and the eliminated spectate.
  4. The camp shows 14 ring fights: 6 in the rings, the rest queued.
  5. Phases follow:
     - 6 s of overview;
     - 6 s of panning on every frame;
     - 6 s at the maximum zoom (3.00×) over the arena;
     - 20 open/close cycles of the replay scene and the expedition scene;
     - 6 s of camp afterwards.
- **Pixel 7 project:** Pixel 7 emulation (412×839 CSS px, touch) with 4× CPU throttling through CDP `Emulation.setCPUThrottlingRate`. It runs on the same desktop GPU, so it is **indicative only**.

### Results

| Phase | Desktop mean | Desktop p5 | Desktop >16.7 ms | Desktop >33.3 ms | Pixel 7, 4× CPU mean | Pixel 7 p5 | Pixel 7 >16.7 ms | Pixel 7 >33.3 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Camp overview (default zoom) | 170.1 | 166.7 | 0.0% | 0.0% | 155.8 | 84.7 | 0.0% | 0.0% |
| Pan | 170.1 | 166.7 | 0.0% | 0.0% | 160.9 | 85.5 | 0.0% | 0.0% |
| Arena at maximum zoom, fights and spectators | 169.9 | 166.7 | 0.0% | 0.0% | 169.6 | 166.7 | 0.0% | 0.0% |
| 20 replay and expedition scene cycles | 160.0 | 166.7 | 1.2% | 0.6% | 123.2 | 56.8 | 4.0% | 2.6% |
| Camp after the cycles | 170.1 | 166.7 | 0.0% | 0.0% | 170.1 | 166.7 | 0.0% | 0.0% |

- **Frame counts:**
  - desktop: 1,020–1,023 per 6 s phase, and 4,656 over the 29.1 s of cycles;
  - Pixel 7: 937–1,022 per 6 s phase, and 4,892 over 39.7 s of cycles.
- **Long frames in the cycles phase** come from each scene's start: a new Phaser game and its art. The camp is paused under the scene and is the same afterwards: ready, one canvas, and no lost WebGL context after 40 scene starts.
- **Desktop target (60 fps):** met in every phase. The harness checks it softly, at a mean of at least 59 on the camp phases.
- **Mobile target (at least 30 fps on the test device):** not measured. The Pixel 7 emulation runs on this desktop's GPU, so it says nothing about a phone's GPU.
  - It stays a named launch blocker until Avi's phone is measured with `?perf=1` on the deployed production build (Task 24, plan Decision 2).
  - The overlay shows the same four numbers per phase and over the last 10 s, with the WebGL renderer (Task 24.1b below), so
    that measurement can be added to this table.

### Render-cost changes this measurement covers

- **Opaque scene (C8).** The camp's Phaser loop stops updating and drawing under an opaque scene, and resumes after.
  - Before the change, the camp issued 7,852 WebGL draw calls a second (desktop) and 664 (Pixel 7 project) under the replay scene. Now it issues none.
- **Culling and hidden tabs (R8, unchanged).** Actors outside the camera view stay hidden. A hidden tab draws nothing.

### Read volume measured by the browser specs

The `tests/browser/read-render.spec.ts` checks:

| Read | Before | Now |
| --- | --- | --- |
| Arena timelines for a slot's 13 entrants (5 human pairs) | 13 | 8: one per pair, NPC bout or boutless entrant |
| Owner reads for a tab return to a changed revision | 2 | 1 |
| Owner reads for a creation and its revision change | 3: confirm, refresh, next poll | 2: confirm, revision change. The new world loads at once, not at the next poll. |
| `/replay/` deep link: world loads | 1 per revision change | 0. It polls only the revision. |
| `/replay/` deep link: owner reads | 1 per revision change or tab return | 1 |
| "Being prepared" re-reads, each with an owner refresh when the revision has no published slot | every 30 s for the whole slot | every 30 s for 3 minutes after the cutoff, then after 60 s, 120 s, 240 s and every 5 minutes |
| "Being prepared" with a published slot (C5) | owner refresh plus tournament read per retry, and "No tournament matches" from +300 s even while unpublished | tournament read only; "being prepared" until the slot is published, then one read at once |
| Tournament logs cached by the gateway | unbounded for the session | at most 64, least recently used dropped first |
| A failed ring log | asked again after 30 s of display time (never with a held clock) | after 2 s, then 4, 8 and 16 s, then every 30 s, by real time |
| Late joiner, 50-entrant bracket (Task 13.9 measure, unchanged) | 8 of 34 revealed bout logs | 8 of 34 |

### Tasks 23.9 and 23.10: the resting screens and short slot times

UI only, on Task 23.8's contract: no database, SQL or Edge change. Both are built and reviewed, and integrated in
`claude/task-23` (`docs/implementation/task-23.9-report.md`, `task-23.10-report.md`).
- **Task 23.9: the presence and the resting screens.**
  - A player's page sends a presence (`{kind: 'presence'}`, no receipt) once its gladiator is shown, then every 6 hours
    while the page is visible.
  - Others see a resting gladiator as "Resting at home: back when {name}'s owner returns."
  - The owner sees "Resting at home: back on your schedule at {time}" on My gladiator, its own Gladiators row and its own
    profile card; "Resting at home." while its return is not known yet.
  - Screenshots at 360 px were sent to Avi on 2026-10-20. Avi kept the resting wording and asked for shorter slot times.
- **Task 23.10: short slot times** (Avi's decision, 2026-10-20).
  - One rule, `slotTimeText`, for the Schedule panel's estimates and saved message, the Build panel's effective time and
    the owner's resting line. It gives `4:20 AM` on the same local day, `tomorrow 4:20 AM`, a short weekday within the
    week (`Sat 4:20 AM`), else the short month and day (`Oct 26, 4:20 AM`), never seconds.
  - The time is kept on one line (`d75e3fc`): its pieces are joined by no-break spaces, checked at 360 px.

### Task 24.1b: the `?perf=1` overlay for the device run (23.4 M3)

UI only, branch `claude/task-24-ui` (`14e56ba`). Plan Decision 11; it lands before Avi's phone run (Task 24.11).
- **What it shows, once a second:**
  1. the phase, its age and the frames of the last second (`camp · 42 s · 60 fps`);
  2. the phase's mean and p5 rates and its frame count;
  3. the phase's shares of frames over 16.7 ms and over 33.3 ms;
  4. the last 10 seconds, whatever the phase (`10 s: mean … · p5 … · >33.3 ms …%`);
  5. the WebGL renderer, wrapped onto as many lines as it needs (it was cut short before).
- **Phases.** `loading`, then `camp` from camp-ready. Each scene open starts `replay` or `expedition`; another scene or replay
  stage is a new phase, and closing it starts `camp` again. `camp unavailable` if the camp view fails. Pan and zoom are not
  phases: for those, read the 10 s line after at least 10 s of each.
- **How it counts.** `FrameMeter` (`src/lib/frame-stats.ts`) does constant work per frame. It fills two 1 ms histograms:
  one per phase, and one for the frames whose intervals ended in the last 10 s. The rolling window is a ring of at most
  5,000 frames. Memory is fixed: about 130 KB. Before, it sorted up to 200,000 intervals every second, counted from the
  overlay's mount.
- **Accuracy, tested** against the sort-based `frameStats` (the FPS harness's definitions, unchanged) on 40 seeded random sets
  and 15 adversarial sets (bucket edges, the exact budget-plus-jitter thresholds, nearest-rank boundaries, invalid values):
  - frame count, mean and both over-budget shares are equal;
  - the 95th-percentile interval is within 1 ms (the mean of the 1 ms bucket holding the nearest-rank interval).
  - An interval of 2 s or more falls in one top bucket, so a p95 that long reads as at most 0.5 fps.
- **Browser check** (`read-render.spec.ts`, both projects): the phase restarts at the replay's open and at its close; the
  renderer line at 360 px is the whole string, `white-space: normal` and not clipped; this machine's renderer takes two lines.
  Before the fix, the same check read `nowrap`, clipped, one line. Off without `?perf=1`, as before.

### Task 24.1b: the `__next.*.txt` prefetch 404s (23.5 M7)

**Observed** (`npm run build` on this Windows host, then `scripts/serve-static.mjs` and Chrome, 2026-10-21). The `/replay/` and
`/expedition/` pages prefetch the camp for their links to `/game/`. Two of those requests fail:
- 200: `/__next._tree.txt`, `/__next.__PAGE__.txt`, `/game/__next._tree.txt`;
- **404: `/game/__next.game.__PAGE__.txt`** (twice), each with a console error.
- After a click on the link, the page lands on `/game/` through a fallback read of `/game/index.txt` (200).

**Cause: a Windows-only path separator in Next 16.4.0's export.** The client names a segment file with
`convertSegmentPathToStaticExportFilename(segmentPath)`, which replaces each `/` with `.`, giving `__next.game.__PAGE__.txt`.
The export builds `segmentPath` from `path.relative` over the build's segment folder (`next/dist/export/index.js`,
`collectSegmentPaths`). On Windows that gives `game\__PAGE__`, so the backslash survives the replacement, and `path.join`
writes `out/game/__next.game/__PAGE__.txt`, a folder.
- **Affected:** every route below the root (`/game/`, `/replay/`, `/expedition/`, `/auth/callback/`, `/_not-found/`), and only
  their page segment: 5 of this build's 18 exported segment files. The `_tree` and `_full` files and the root's `__PAGE__`
  are named alike either way. Replayed with POSIX path rules, the same code gives `__next.game.__PAGE__.txt`, the name
  the client asked for.
- **Not `trailingSlash`.** The client strips the route's trailing slash before adding the file name, and the export writes
  the files into the route's own folder, so `/game/` and `out/game/` agree.

**Tested: with the POSIX names the requests succeed.** A copy of `out` with only those 5 files renamed to the POSIX names (what
the same Next code writes on Linux), served and probed the same way, answered every `.txt` request with 200. The click on
the link used the prefetch: no `index.txt` fallback. The only 404 left in either run is `/favicon.ico`, a separate gap: the
export has no favicon.

**Effect:** harmless. A failed segment prefetch is a cache miss. Navigation still works, at the cost of one 404, one console
error and one extra read per prefetch.

**Hosting.**
- The Pages Git integration (Decision 3) builds on Linux, as does CI (`ubuntu-24.04`), so their exports should carry the
  POSIX names. Expected, not yet observed: no export has been built on Linux in this task.
- Any static host serves these names as ordinary files, and `serve-static.mjs` serves the POSIX copy. Cloudflare Pages is
  not verified for them yet.
- A Windows-built export (this host's production gate, or a direct upload from Windows) keeps the 404s.

**Decision:** no change. No documented Next option renames segment files. Turning prefetch off for the links
(`prefetch={false}`) would only hide the defect and lose the working prefetch on the Linux build.

**To check on the deployed origin (Task 24.2 or 24.8):** loading `/replay/` and `/expedition/` gives no `__next.*.txt` 404.
Deploy only exports built by the Pages integration.

## Release gate (Task 23.6)

**Status (gate of record, 2026-10-20): passed.** The gate exited 0 at `d75e3fc`, the finished branch with Tasks 23.7–23.10
built and reviewed: 12 of 12 steps passed ("Gate of record" below). No known blocker is listed.
**Status (after the final fix wave, 2026-10-20): passed.** The final fix wave changed `src` (an unknown slot time renders
safely) and added one catch-up test; `npm run verify` then passed 12 of 12 again at `7260b59` (units 1254, `test:db` 300 with
the Edge start time unchanged, development 541/0/35, production 34/0/542). Its first run exited 1 on two gate issues carried
to Task 24 preparation ([fix-wave report](../implementation/task-23-fix-wave.md)).
**Status (Task 23.8): passed.** `npm run verify` exited 0 on the M01–M22 replay at `46f176e` ("Task 23.8 runs" below, run 2;
run 1 failed on one browser flake). The database budget is no longer a known blocker.
**Status (Task 23.7): passed.** `npm run verify` exited 0 on the M01–M21 replay ("Task 23.7 run" below): the database budget
blocker is resolved at 90 days. Task 23.6's status, kept for the record:
**blocked by the database budget, as expected; every other step passed in the final run.** `npm run verify` exits 2
(known blockers only): its single failure is the capacity case's database budget, owned by Task 23.7 (Avi's decision
A + C + D). The gate names the blocker and never counts it as a pass. Nothing was pushed: the controller pushes after the Task
23 final review and records the first GitHub Actions run then.

### Environment

- 13th Gen Intel Core i9-13900K (32 logical cores, 32 GiB), Windows 11 Pro 25H2 (10.0.26200).
- Node 22.19.0, npm 11.8.0, git 2.41.0.windows.3.
- Next.js 16.4.0, Phaser 4.2.1, vitest 5.0.3, Playwright 1.64.0 with Google Chrome 155.0.8059.80 (`channel: 'chrome'`), Deno 2.9.6.
- Supabase CLI 2.120.0, PostgreSQL 17.11 (M01–M20 applied), Docker Desktop 4.94.0 with Engine 29.8.2.
- Branch `claude/task-23` at `a2ed84a` (lanes A and B integrated) with the Task 23.6 changes, uncommitted during the runs.
- Command: `npm run verify -- --config node_modules/.cache/pw-claude.config.mjs --json <scratchpad>/verify-<n>.json`, the
  private Playwright configuration (port 3200 for the dev server and for the static host), beside another worktree's dev
  server on 3400 and this worktree's `supabase functions serve`.

### Commands and results

Four end-to-end runs on 2026-10-19 (UTC) before the review. Runs 1 and 2 ran the first version of the gate. Run 3 added the
access-time refresh of the Edge files, a host-fault rerun (removed in fix round 1) and separate browser results; run 4 the
refresh of folders too. Run 5, after fix round 1, is under "Fix round 1" below. Browser counts are passed / failed / skipped.

| Step | Run 1 (15:08–15:25) | Run 2 (15:26–15:44) | Run 3 (15:52–16:11) | Run 4 (16:17–16:33) |
|---|---|---|---|---|
| `npm test` | 1,197 passed | 1,197 passed | 1,203 passed | 1,204 passed |
| `npm run typecheck` (tsc, deno check, deno test 2/2) | passed | passed | passed | passed |
| `node assets/source/build-assets.mjs --check` | passed | passed | passed | passed |
| `npm run build` (`_headers` written, gallery removed) | passed | passed | passed | passed |
| `npm run verify:static` (91 assets) | passed | passed | passed | passed |
| Edge settled before the database tests | read 612 files; 32 s; not recreated | read 612 files; 34 s; recreated while settling | refreshed 612 files, read 612; 34 s; recreated while settling | refreshed 735 files and folders, read 612; 34 s; recreated while settling |
| `CAPACITY_GATE=1 npm run test:db` | **blocked**: 276 passed, 1 blocked | **blocked**: 276, 1 | **blocked**: 276, 1 | **blocked**: 276, 1 |
| Edge start time across the database run | unchanged (15:08:28) | unchanged (15:26:53) | unchanged (15:52:49) | unchanged (16:17:14) |
| `npx playwright test` (development) | 527 / 0 / 31 | 526 / **1** / 31 | 527 / 0 / 31 | 527 / 0 / 31 |
| `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build` | passed | passed | passed | passed |
| `npm run verify:static -- .next/browser-test` (91 assets) | passed | passed | passed | passed |
| Production browser gate | 29 / **1** / 528 | 30 / 0 / 528 | 30 / 0 / 528 | 30 / 0 / 528 |
| `git diff --check` | clean | clean | clean | clean |
| Exit | 1 | 1 | 2 (blocked) | 2 (blocked) |

- **The blocker, every run:** the capacity case's four database checks and nothing else in it. Database at 90 days: 177.7–178.6 %
  (mixed schedules) and 150.6–151.3 % (new-character schedule) of the 250 MB budget; after one year 273.7–274.5 % and
  227.7–228.2 %. Its invocation and raw-egress checks passed. No budget constant was changed.
- **Run 1, production:** `[desktop] expedition.spec.ts:761` timed out at 5 s with the page still on "Loading the expedition…".
  Its trace shows the framework chunk `turbopack-….js` failed with `net::ERR_NO_BUFFER_SPACE` (Windows WSAENOBUFS, before any
  request was sent), so the page never hydrated: an infrastructure fault ("Flake triage").
- **Run 2, development:** `[desktop] release.spec.ts:517` (the contrast check) waited 45 s for the fixture camp at about 15:37,
  while Docker Desktop failed. The production run then reused the output folder and deleted the trace; since run 3 each
  browser step keeps its own results.
- **Docker, run 2 (observed, cause unknown):** at about 15:36 the local stack's containers restarted with Docker Desktop (its
  processes and the containers started again at 15:43), and `supabase functions serve` exited with it. The gate never starts,
  stops or resets Docker or the stack. Once the stack was healthy, `npx supabase functions serve --env-file .env.edge.local`
  was started again in this worktree, its output to a file in the task's scratchpad; the worker answered at 15:45:35.

### What the gate adds

- **`scripts/verify.mjs` (`npm run verify`):** the order of `docs/operations/verification-gates.md`; every step whose input is
  valid runs after a failure; one summary; exit 0 (passed), 2 (known blockers only), 1 (anything else).
  `tests/scripts/verify.test.ts` pins the order against the guide, the environments, the classifications and the reruns.
- **Security headers (Decision 7):** `scripts/build-headers.mjs` writes `_headers` after `next build` and removes
  `assets/gallery.html` (Decision 2). The policy is exactly Decision 7; `connect-src` adds only the build's Supabase origin,
  which must be `https://<project>.supabase.co` (or loopback `http` for a local build). These runs' exports have no Supabase
  URL, so `connect-src 'self'`.
- **Scanner (C27):** `scripts/verify-static.mjs` also requires `_headers` to be exactly the generated file for an allowed origin,
  refuses the gallery, any JWT (three base64url segments after `eyJ`) and `service_role` base64- or base64url-encoded at each of
  its three byte alignments. The real exports passed (91 assets each): no false positive.
- **Static host:** `scripts/serve-static.mjs` applies the export's `_headers` as Cloudflare Pages does, never serves `_headers`,
  refuses an export without it, and takes its port from `CLOUDIATOR_STATIC_PORT`.

### Content Security Policy

- **No violation** in any production run: 30 tests in each of the four gate runs, 5 more full production runs, 40 repeats of the
  C21 case and a 300-test stress run (8 workers, 10 repeats). The policy needed no change and no `'unsafe-eval'`: Phaser's
  `new Function('return this')` fallback sits behind `typeof globalThis === 'object'`, which Chrome satisfies.
- **The listener** (`tests/browser/fixtures.ts`, every spec's `test`; `tests/harness.test.ts` checks that no spec bypasses it)
  records each page's `securitypolicyviolation` events and Chrome's console reports and fails the test on any.
  - RED: against the previous static host (no headers), `tests/browser/csp.spec.ts` failed 4 of 6 (no policy header; the blocked
    `fetch` recorded nothing).
  - A temporary test that made a violation without opting out failed with both records ("Connecting to
    'https://csp-probe.invalid/' violates … connect-src 'self'"). Since fix round 1 this is a committed case:
    `csp.spec.ts` "fails a test whose page breaks the policy" runs under `test.fail()`. With the teardown check removed it
    failed ("Expected to fail, but passed") on both projects; with the check it passes.
- **Recorded exception:** `'unsafe-inline'` for scripts and styles: a static export has no per-request nonce (Next.js
  content-security-policy guide, "How nonces work"), and its framework scripts are inline.

### Edge recreations (C22)

**Observed cause and tested once (controller, before this task):** NTFS last-access updates are on; a read of Edge source not
read within an hour makes the CLI watcher report "File change detected … (WRITE)" and recreate the container. A pre-read, a
settle, then `test:db` passed 275/275 with the start time unchanged.

**Observed in this task** (container start times, UTC):

| Time | What happened |
|---|---|
| 14:37:54 | Recreated as I first read Edge source files (no run active). |
| 15:06:30 | Recreated during a development-server stress run of `market.spec.ts` (Next compiles modules of `supabase/functions/_shared`). |
| 15:08:28 | Recreated in run 1 before its pre-read (the unit tests and type checks read Edge source). |
| 15:24:47 | Five Edge files' access times updated during run 1's production build, 16 minutes after its full pre-read (no recreation visible). |
| 15:26:53 | Recreated while run 2 settled: its pre-read updated 573 files' access times, 18 minutes after run 1's. |
| 16:10:57 | Recreated after run 3's database run, during its production build: the watcher reported the folder `_shared` (a listing updated its access time; run 3 refreshed files only). |

**Finding (observed):** a read (or a folder listing) does not refresh an access time younger than an hour, so a full pre-read
leaves such entries unrefreshed, and they change on the next read once they pass the hour. One read during `test:db` then
recreates the container mid-run, whatever the pre-read did. Zero-length files never change (a read reads no data).

**Newly tested (Task 23.6),** with the serve log in this task's scratchpad:
- Setting every file's access time to now raised 37 detections and one recreation (15:46:19); a full read one minute later raised
  none, and later unit and type-check runs raised none.
- With folders included (735 entries, then counting the contents of 21 junctions; since fix round 1 the links are skipped: 714 entries; through a handle that asks only for attribute writes, since the watcher holds the folders
  open), the refresh raised 34 detections and one recreation (16:15:15); a full listing and read 40 s later raised none.
  Modification times were checked unchanged entry by entry, and `git status` was identical before and after.
- The gate runs: runs 3 and 4 refreshed, then settled through one recreation, then kept the start time through the database run.
  Run 4's whole gate raised 33 detections, all from its refresh while settling, and none afterwards: not in the database run, the development suite or either build.

### Flake triage

- **C21, `[mobile] shell.spec.ts:42` (production, first run after a build).** Not reproduced: 5 full production runs, 40 repeats on
  mobile (4 workers), and 10 repeats in the 8-worker stress run all passed; the four gate runs passed it too. No artifact of the
  original failure exists. **Likely cause, not proven:** run 1's production step, which ran straight after a development suite
  as C21's first run did, failed its first expedition page because a framework chunk failed with `net::ERR_NO_BUFFER_SPACE`
  and the page never hydrated; C21's assertions are the same kind of first-page wait. Socket sampling every 5 s during runs
  2–4 found at most 1,488 `TIME_WAIT` sockets against 16,384 dynamic ports, so port exhaustion is not supported, and the host
  error's cause is unknown. **Changes (no product code):** `tests/browser/host-faults.ts` and the browser fixture name a request
  that failed in the host's network stack on a failed test. Since fix round 1, `npm run verify` labels such a failure a
  probable host fault in its summary, beside the test's own first error, and the gate still fails; nothing is rerun (runs
  3 and 4 had a rerun, which never fired). Each browser step keeps its traces (`test-results/development`,
  `test-results/production`).
- **`[mobile] market.spec.ts:463`** (the purchased row still listed 5 s after "Purchase confirmed", once, in the integration dry
  run). Not reproduced: 40 repeats on mobile at 8 workers, the whole spec 8 times at 16 workers (256 cases, 16 of this one), and
  the four gate runs. The failure record shows the row on 14 polls over 5 s. The row leaves only when the re-read after the
  purchase answers, and reading `MarketPanel.tsx` found no stale-read path (each read has a generation, and an older one is
  dropped). Its trace was not kept. No change.
- **`[desktop] release.spec.ts:517`** (run 2, above): coincided with Docker Desktop's failure; it passed in runs 1, 3 and 4.

### Harness noise (C23)

- The ten console calls of the gate suites (`arena.test.ts:629`, `recovery.test.ts:397, 494`, `restore-world.test.ts:170`,
  `tournaments.test.ts:1077, 1106, 1635`, `tests/performance/harness.ts:170`, `read-render.spec.ts:348`,
  `tournament.spec.ts:652`) now go through `tests/fixtures/measurements.ts`: printed only with `CLOUDIATOR_MEASUREMENTS=1`, or in
  a `scripts/resource-report.mjs` run. The capacity sections no longer print under `CAPACITY_GATE=1`; the failed checks name
  their numbers. `tests/harness.test.ts` keeps new console calls out.
- `NO_COLOR` is removed from the gate's child processes (Playwright sets `FORCE_COLOR=1`, and Node warns when both are set).
  vitest's caching hint is off (`fsModuleCache: false`, its default, stated). `git diff --check` runs with
  `core.safecrlf=false`, which silences only the line-ending notices of a Windows checkout.
- What remains in the gate's output is each tool's own report: vitest, Deno's test lines, the Next build, Playwright's list.

### Rule retention across migrations (R6)

- `tests/rule-retention.test.ts` checks every migration's top-level statements. None deletes, truncates, drops, retypes or renames
  in-progress state (jobs and their dependencies, snapshots, boundaries and their cohorts and work, plans, assignments,
  tournaments, entries and bouts, pending preparations, settled slots, activities and stages). The only top-level backfills are
  the two reviewed ones (M05 peak strength, M18 published slot). `private.rules_versions` only ever gets
  `insert … on conflict do nothing`. A dropped guard trigger is replaced in the same migration. Every seeded rules version
  (`v1`) has the worker's executors for every job kind. It passes on all 20 migrations; its synthetic cases show each rule fires.
- `tests/db/rule-retention.test.ts` checks the migrated catalog. The four `rules_version` columns (snapshots, boundaries, jobs,
  tournaments) each have a validated foreign key with NO ACTION to `private.rules_versions`; nothing deletes a version row on its
  own; and the worker has executors for every stored version and job kind. RED with a planted version row `v99` and a planted
  table with an unpinned `rules_version` column; both were removed, leaving only `v1`.
- Limit: this checks the migrations and the catalog, not an in-progress world replayed through a migration (pg_cron exists only
  in the `postgres` database, so a scratch database cannot replay M03). The runtime guards (`guard_job`, the per-version
  executors) are covered by the existing activity tests.

### Dependency audit

- `npm audit`: 0 vulnerabilities in 152 dependencies (30 production, 85 development, 79 optional, 33 peer).
- `npm ls --all`: exit 0. Two extraneous packages in this worktree's `node_modules` only (`@emnapi/runtime@1.11.3`,
  `@img/sharp-wasm32@0.35.5`, not in the lockfile; `npm ci` removes them, not run here because it also deletes the private
  configurations in `node_modules/.cache`). 94 unmet optional dependencies, all other platforms' binaries.
- `package-lock.json` (version 3): 152 entries, each with an integrity hash and resolved from `registry.npmjs.org`. Every direct
  dependency is pinned to an exact version equal to the lockfile's.
- The workflow's actions are pinned to full commit SHAs (fix round 1), each resolved with read-only `gh api` lookups
  (`repos/<action>/commits/<tag>`). The latest v4 release and the v4 major tag resolved to the same commit for each action:
  `actions/checkout` v4.4.0 `11d5960a…77262`, `actions/setup-node` v4.4.0 `49933ea5…20020`, `actions/upload-artifact` v4.6.2
  `ea165f8d…fa02`. `tests/workflow.test.ts` requires a 40-character SHA and a `# vX.Y.Z` comment on every `uses:`.

### CI workflow

`.github/workflows/checks.yml` runs on pushes, pull requests and by hand, with read-only permissions, on `ubuntu-24.04`: Node
22.19.0, `npm ci`, a fresh local stack (`npx supabase start` with the documented exclusions, so every migration replays; its
output, which holds the local keys, goes to a file in `RUNNER_TEMP`), a random worker secret written to `.env.edge.local`
without printing it, `npx supabase functions serve` in the background, then `npm run verify -- --json "$RUNNER_TEMP/verify.json"`,
and the results and traces as an artifact. Validated locally: the YAML parses (PyYAML 6.0.3), and `tests/workflow.test.ts`
checks the order, that every `npm run` script and `node` file it calls exists, and that it prints no credential. **Not run:**
the controller pushes and records the first run. No known blocker remains: Task 23.8 emptied `KNOWN_BLOCKERS`, so any failed
step exits 1. Exit 2 is reserved for named known blockers, and none is listed. **Since Task 24.0d** the release-gate step sets
`CLOUDIATOR_CI=github`, and the gate does not run the development browser suite there: it reports the step as `not run on CI`,
never silently ("The second CI run and the development browser step (Task 24.0d)", below). Every other step runs. **Since Task
24.2c** `verify.json` says it at its top level too: `notRun` lists the step (empty when every step ran) and `resultLine` is the
summary's result line, so a reader that never opens `results` does not see a bare pass.

### The first CI run and the CI render exception (Tasks 24.0 and 24.0c)

**Run 39452911203** (2026-10-20, the gate from 15:57 to 17:10 UTC; the push of `codex/gladiator-arena`, then at `0d4a1b0`):
**exit 1, one step failed.** The development browser suite: **51 failed, 490 passed, 35 skipped** in 63 min 49 s. Every other
step passed: `npm test` 1,251 (3 Windows-only cases skipped), typecheck, the asset check, the build and its scan, the Edge
settle (612 files read, 31 s, not recreated), `CAPACITY_GATE=1 npm run test:db` **300 passed** with the Edge start time
unchanged, the isolated production build and its scan, the **production gate 34 passed** (59 s), and `git diff --check`.

- **Observed:** 48 of the 51 failures were test timeouts while the camp or a scene rendered: 46 at 30 s (for example a
  `page.screenshot` still waiting at `arena.spec.ts:119`), and `release.spec.ts:89` and `:253` at their own 240 s.
  **Attributed (the controller):** the GitHub-hosted runner has no GPU, so Chrome renders WebGL in software. A case passed on both projects took a median 1.8
  times as long on the desktop project as on the mobile one (187 cases over 3 s; for example 29.0 s against 13.7 s).
- **Three failures, in two tests, were not timeouts**, and these tests are not render-bound: `seasons.spec.ts:170` "fits
  the standings sheet at 360 px" on both projects (the archived table 342 px wide in its 332 px box: the runner's
  `system-ui` font is wider than Segoe UI), and `seasons.spec.ts:239` on desktop (live mode: 4 season view reads, expected
  5; its counters were read once after a fixed 500 ms). Task 24.0c fix round 1 fixed both and left them untagged: the table
  has slack at 360 px (checked with Verdana forced: 315 px of 332), and the test polls for its counts.
- **Ruling (the controller's CI exception, 2026-10-20):** CI's development browser step leaves out the render-bound tests.
  The local `npm run verify` stays the gate of record and still runs every test. No test's assertions changed.
- **Mechanism (Task 24.0c; removed by Task 24.0d, below, which keeps the tags):** the render-bound tests carry the Playwright tag `@render`. `.github/workflows/checks.yml` sets
  `CLOUDIATOR_CI_RENDER=exclude` on the release-gate step only. `playwright.config.ts` (through `scripts/ci-render.mjs`) then
  gives the desktop and mobile projects `grepInvert` for the tag in the development suite; never in the production gate, and
  never without the variable. Any other value is refused. `scripts/verify.mjs` lists the tagged tests (`--list --grep`, no
  test runs) and ends the browser step's summary line with "excluded N render-bound tests (CI, no GPU)", never silently.
- **What is tagged: 74 tests (148 with both projects, of 582 listed).** The 40 render-bound tests behind the 48 timeouts (a
  tag covers both projects), 32 tests of the same describe blocks (for the top-level market and visitor cases, the same
  file) that passed in the run but used at least two-thirds of their timeout in either project (20 s of 30 s; 156 s of 180 s
  for `release.spec.ts:518`), and two cases that have not run on CI yet and screenshot the camp or a scene like their
  failing neighbours: Task 24.0b's Arena card case and Task 24.0c's expedition stage-time case. The list, with each reason,
  is in [the Task 24.0c report](../implementation/task-24.0c-report.md).
- **Risk, not tagged:** 13 passing tests outside those describe blocks also used two-thirds of their 30 s on that run (the
  slowest: `inventory.spec.ts` 28.8 s, the live Tournaments panel 28.0 s, `live-camp.spec.ts` 27.0 s). They may still time
  out on a later run; they are listed in the report.
- **Observed afterwards:** run 39588134783 (below) was the first with the exception. It excluded 148 runs, still failed 50
  development tests, and led the controller to the ruling that replaces this mechanism (Task 24.0d).

### The second CI run and the development browser step (Task 24.0d)

**Run 39588134783** (2026-10-21, the push of `codex/gladiator-arena` at `f3e7bf1`; the gate ran from 10:57 to 12:00 UTC):
**exit 1, two steps failed** (`Result: FAILED (2 steps failed)`). Every other step passed: typecheck, the asset check, the build
and its scan, the Edge settle (612 files read, not recreated), `CAPACITY_GATE=1 npm run test:db` **312 passed** with the Edge
start time unchanged (7 min 33 s), the isolated production build and its scan, the **production gate 34 passed** (1.7 min), and
`git diff --check`.

- **unit: 1 failed, 1,380 passed, 10 skipped (of 1,391).** `tests/domain/expedition-view.test.ts` "is the short slot time against
  the display time, with its exact instant as the machine-readable time": `expect(markup).not.toContain('04:20')`. **Observed:**
  the assertion reads the whole markup, and the `dateTime` attribute is the instant in UTC, `2026-10-20T04:20:00.000Z` on the
  runner (UTC), against `01:20Z` in Asia/Jerusalem, where the development host passes. **Tested (Task 24.0d):** `TZ=UTC npx
  vitest run tests/domain/expedition-view.test.ts` failed with that message before the change. The file now pins its zone
  (`process.env.TZ`, restored afterwards, as `tests/domain/slot-time.test.ts` does) and checks the shown text only; it passed
  under `TZ=UTC`, Asia/Jerusalem, America/Los_Angeles, Pacific/Auckland and Asia/Kolkata.
- **browser (development suite): 50 failed, 355 passed, 29 skipped in 52.0 min**, with the 148 `@render` runs already left out
  (its summary line said so). The failures are in 19 of the files (tournament 7; read-render 5; full-screen 5; scenes 4;
  live-camp 4; planning, market, identity, arena 3 each; seasons, replay, management 2 each; one each in visitor, shell,
  retention, release, inventory, expedition and camp). **40 were 30 s test timeouts**; 10 were assertions on timing-sensitive
  state (a poll count, a focus, a rail reveal, a replay attribute). **Attributed (the controller):** the free runner is too
  slow for the development suite in general (`next dev` compiles each route on demand), not only for WebGL. Not tested on the
  runner.
- **Ruling (the controller, 2026-10-21):** CI's release gate does not run the development browser step, and says so. The
  production gate and every other step still run on CI; the local `npm run verify` runs everything and is the gate of record.
- **Mechanism (Task 24.0d).** `.github/workflows/checks.yml` sets `CLOUDIATOR_CI=github` on the release-gate step only (any other
  value is refused before the gate starts; GitHub's own `CI` and `GITHUB_ACTIONS` change nothing). `scripts/verify.mjs` then marks
  the `browser` step `not run on CI` without running it: its summary line reads "development browser suite not run on CI (runner
  too slow); the local gate of record runs it", and the result line is `Result: PASSED (development browser suite not run on
  CI); exit 0` (beside failures: `FAILED (1 step failed; development browser suite not run on CI)`). Never a bare PASSED. The
  exit code is 0 when everything else passes. Tested with a fake runner (`tests/scripts/verify.test.ts`, "the CI exception"); the
  real gate was not run in CI mode.
- **The Task 24.0c exclusion is removed:** `scripts/ci-render.mjs`, the `grepInvert` in `playwright.config.ts` and the count in
  `scripts/verify.mjs` are gone. No test's assertions changed. The 74 `@render` tests (72 annotations, 148 runs) remain tagged as documentation of which tests are
  render-bound, and as a manual filter: `npx playwright test --list --grep @render` lists 148 of the 582 tests, and
  `--grep-invert @render` the other 434.
- **Time zone (Task 24.0d).** Besides the unit test above, the 360 px stage-time test of `tests/browser/expedition.spec.ts`
  depended on the host zone (found in the Task 24.0c review). **Observed:** under a scratch host zone of Europe/Berlin it failed
  (the fixture's first stages start at 11:20 PM on 9 October there, the display time is after midnight, so those starts read
  "Oct 9, 11:20 PM" and their wider rows shift the label edges: 3 distinct left edges instead of 1); UTC, America/New_York,
  Asia/Tokyo and Asia/Jerusalem passed. **Tested:** the test now sits in its own describe with `timezoneId: 'Asia/Jerusalem'` and
  `locale: 'en-US'`, and passed under all five host zones, Berlin included.
- **Not yet observed:** a CI run with this change. The controller pushes and records it.

### Device metrics and the budget arithmetic

- Device metrics are Lane B's ("Lane B: render cost"): desktop at the 170 Hz vsync ceiling in every phase; the Pixel 7 emulation
  with 4× CPU throttling is indicative only. The mobile 30 fps target is unmeasured.
- The budget arithmetic is Lane A's ("Lane A: capacity"); the four gate runs reproduce its database shares (above).

### Before the public release

- **Task 23.7:** done (M21). The database budget is met at 90 days, and the gate passes ("Task 23.7 run" below).
- **Tasks 23.8–23.10:** done and reviewed. Idle characters rest at home (M22), the camp shows the presence and the resting
  screens (23.9), and slot times are short (23.10). The gate of record passes ("Gate of record" below).
- **Task 24 blockers:**
  1. mobile 30 fps on the device (`?perf=1` on the deployed production build);
  2. hosted CPU and dispatch spacing (C4);
  3. hosted egress and compression (Lane A, risk 2);
  4. CORS parity: the hosted `GAME_ALLOWED_ORIGINS` and Auth redirects for the exact Pages origin;
  5. the remote export rehearsal (`scripts/export-db.ps1 -Remote`, then the restore check).
- **Also open:** a passing GitHub Actions run (the first, 39452911203, failed only in the development browser step; the second,
  39588134783, in that step and one unit test: "The first CI run and the CI render exception" and "The second CI run and the
  development browser step" above; Task 24.0d answers both, and its own run is not yet observed); the hosted `connect-src` origin (the
  production build sets `NEXT_PUBLIC_SUPABASE_URL`, and the scanner then names that origin); Lane A's risk 5 (boundary headroom
  at 50 characters).

### Fix round 1 (Task 23.6 review)

The review found three Important issues in the gate's verdicts and one in its doc test. All four are fixed, each with a
RED-then-GREEN test, and the gate was run end to end once more (run 5).

- **The known blocker could hide real database failures (Important 1).** vitest's JSON reporter does not show a failed
  describe-level hook (its tests are only skipped) or an unhandled error, so exit 2 could cover them. The database step now
  reads `scripts/vitest-gate-reporter.mjs`, which writes every module error, every failed suite with its own errors, every
  failed test, and the unhandled errors. `blocked` now needs every failed test to be a database-budget check with a finite
  share of at least 1, every failed suite to enclose one and have no error of its own, and no module or unhandled error.
  - On a real vitest run, a scratch capacity test failing beside a failing `beforeAll` and an unhandled error: the old
    classifier said `blocked`; the new one says `failed` with both reasons.
- **The refresh followed links and swallowed its own guard (Important 2).** The handle now opens with
  `FILE_FLAG_OPEN_REPARSE_POINT`. Links are skipped and never descended into, every entry is checked to be under the resolved
  `supabase/functions`, and any failure (including a changed modification time) fails the Edge step as an infrastructure
  fault with its reason.
  - In a scratch folder, the junction test failed on the old behaviour (7 entries touched, through the link) and passes now
    (5 entries, 1 link skipped, the target's access time unchanged).
- **The host-fault rerun was decided by co-occurrence (Important 3).** Removed. A failed test whose context saw a host
  network fault is labelled "probable host fault" in the summary beside its own first error, and fails the gate (exit 1).
  The database rerun on a changed Edge start time stays, fixed at exactly one (the `--db-retries` option is gone).
- **The doc test depended on unapproved edits (Important 4).** `docs/operations/verification-gates.md` is back to the
  approved a2ed84a text, except the "Database tests and the local Edge runtime" section. Avi approved extending that section
  on 2026-10-19 with the last-access refresh, and the test now checks the approved "Safe order" list and that section.
- **Minors taken:** the blocker needs a finite share of at least 1; the comment at `tests/db/capacity.test.ts:21` is
  corrected; a committed `test.fail()` CSP case; the JWT scan catches tokens after `%20`, `\n`, `\t`, `\u0022` and `\x22`
  (the real exports still pass, 91 assets each); the actions are SHA-pinned.

**Run 5 (16:58–17:15 UTC, after fix round 1): exit 2 (blocked); every step passed except the known blocker.**

| Step | Run 5 |
|---|---|
| `npm test` | 1,216 passed |
| typecheck, assets, build, `verify:static` (91 assets) | passed |
| Edge settled | 714 files and folders refreshed, 21 links skipped (the junctions in `supabase/functions/node_modules`), 612 files read; 34 s; recreated while settling (16:17:14 → 16:58:48) |
| `CAPACITY_GATE=1 npm run test:db` | **blocked**: 276 passed, 1 blocked (90 days 178.4 % / 151.0 %, one year 274.3 % / 227.8 %); Edge start time unchanged (16:58:48) |
| Development browser suite | 527 / 0 / 33 (the new `test.fail()` CSP case is production-only: skipped on both projects) |
| Production build, its scan (91 assets), production gate | passed; 32 / 0 / 528 (the `test.fail()` case passed on both projects) |
| `git diff --check` | clean |

The watcher logged 33 detections in the whole run, all from the refresh while settling; the container's start time was the
same at the end of the run.

### Task 23.7 run

`npm run verify -- --config node_modules/.cache/pw-claude.config.mjs --json <scratchpad>/verify-1.json`, 18:13–18:29 UTC on
2026-10-19, on branch `claude/task-23` at `51875a7` with the Task 23.7 changes uncommitted, the database the clean M01–M21
replay. **Exit 0 (passed): every step passed, and no known blocker was hit.**

| Step | Task 23.7 run |
|---|---|
| `npm test` | 1,218 passed |
| typecheck, assets, build, `verify:static` | passed |
| Edge settled | 714 files and folders refreshed, 21 links skipped, 612 files read; 35 s; recreated while settling (17:59:30 → 18:13:32) |
| `CAPACITY_GATE=1 npm run test:db` | **passed**: 284 passed (the database at 90 days under 100 % in both scenarios); Edge start time unchanged (18:13:32) |
| Development browser suite | 527 / 0 / 33 |
| Production build, its scan, production gate | passed; 32 / 0 / 528 |
| `git diff --check` | clean |

`scripts/verify.mjs` still listed the database budget as a known blocker (`KNOWN_BLOCKERS`, owner Task 23.7) at that run. It
no longer fired: the case's only database checks are now the two 90-day shares, both under 1. **Task 23.8 retired it**
(`8db6700`): the list is empty, so a 90-day budget failure is an ordinary failure (exit 1). The mechanism and its tests stay,
the tests with their own fixture list (`tests/scripts/verify.test.ts`).

### Task 23.8 runs

`npm run verify -- --config node_modules/.cache/pw-claude.config.mjs --json <scratchpad>/verify-<n>.json` on 2026-10-20, on
branch `claude/task-23` at `46f176e` (M22 committed, clean tree), the database the clean M01–M22 replay.

| Step | Run 1 (08:11–08:31 UTC) | Run 2 (08:32–08:50 UTC) |
|---|---|---|
| `npm test` | 1,222 passed | 1,222 passed |
| typecheck, assets, build, `verify:static` | passed | passed |
| Edge settled | 714 refreshed, 21 links skipped, 612 files read; 35 s; recreated while settling | 714 refreshed, 21 links skipped, 612 files read; 36 s; recreated while settling |
| `CAPACITY_GATE=1 npm run test:db` | **passed**: 299; Edge start time unchanged | **passed**: 299; Edge start time unchanged |
| Development browser suite | **failed**: 526 / 1 / 33 | **passed**: 527 / 0 / 33 |
| Production build, its scan, production gate | passed; 32 / 0 / 528 | passed; 32 / 0 / 528 |
| `git diff --check` | clean | clean |
| Exit | 1 | **0 (passed)** |

Run 1's one failure was `[mobile] release.spec.ts:517` ("meets 4.5:1 contrast on panel text and 3:1 on controls"). In the
expedition scene, "Returned to camp" was measured at text alpha 0.03 (ratio 1.09). The text was caught while fading in:
`settled()` (release.spec.ts:39) waits only for the animations already running when it is called.
- Run alone with `--repeat-each=6` on both projects, it passed 12/12.
- Task 23.8 changes no scene or style.
- It is recorded as a load-timing flake for the final review's flake triage, not as product evidence; the gate's no-rerun
  rule stands, so run 2 is a whole new run.

### Gate of record (d75e3fc, 2026-10-20)

`node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs` on branch `claude/task-23` at `d75e3fc` (Tasks
23.1–23.10 integrated; M01–M22, no migration since Task 23.8), with no other worktree's browser suite running. **Exit 0
(passed): 12 of 12 steps.**

| Step | Gate of record |
|---|---|
| `npm test` | 1,251 passed |
| `npm run typecheck` (tsc, deno check, deno test) | passed |
| `node assets/source/build-assets.mjs --check` | passed |
| `npm run build`, `npm run verify:static` | passed |
| Edge settled | 714 files and folders refreshed; settled through one recreation before the run |
| `CAPACITY_GATE=1 npm run test:db` | **passed**: 299; the Edge container's start time unchanged across the run |
| Development browser suite | 541 / 0 / 35 |
| Production build, its scan, production gate | passed; 34 / 0 / 542 |
| `git diff --check` | clean |

**The earlier integration run at `81a57d7`** (23.9 integrated, before 23.10): 11 of 12 steps passed. The development suite
had one failure, `[desktop] retention.spec.ts:157` ("keeps offering a replay until its expiry by server time"), beside a
probable host fault (`net::ERR_NO_BUFFER_SPACE`), while another worktree's browser suite (Task 23.10's) ran at the same time.
Run alone it passed 3/3. It is recorded as a probable host fault, not product evidence; the gate's no-rerun rule stands,
and the run above, with no other browser suite active, is the gate of record.

## Task 24: the hosted launch

Sanitized evidence of the deployment checklist (`docs/operations/deployment.md`); names, counts, codes and origins only.
The full step log is the Task 24 ledger. Remaining for 24.12: the real journey (24.8), the measured budgets (24.9), the
hosted restore rehearsal (24.10: checks done, the hosted export still open; see "Hosted recovery (24.10)"), the phone frame rate (24.11)
and closing the bench.

### Gate of record (1b4fdbf, 2026-10-24)

`node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs` at `1b4fdbf` (Next.js 16.4.3; the hosted
restore tooling; six test-race fixes), on a quiet host, with the local stack on the linked project's service versions
(PostgREST v14.18). **Exit 0, 12 of 12:** unit, typecheck, assets, build, static, Edge settled, `test:db` 317 passed with the
Edge start time unchanged, development browser suite 547 passed / 57 skipped, the browser build and its scan, the
production gate 34 passed, `git diff --check`.

The nine runs before it used plain `npm run verify`, the repository config: 16 browser workers on this 32-core host and a
30 s test budget. They failed on load and host faults (an Android emulator and a game sharing the GPU, `ERR_NO_BUFFER_SPACE`,
native `0xC0000005` crashes). Each failing test passed alone; six that also showed real timing races were fixed
(`8ca535f`, `ad1c10d`, `11235af`, `13d27e3`, `db99bf6`, `1b4fdbf`). The gate of record runs with the private two-worker
config, as on 2026-10-20.

**The local Data API version.** After `supabase link`, `supabase start` builds the local stack from the linked project's
versions in `supabase/.temp` (PostgREST v14.18, as hosted) instead of the CLI's default v16.4. PostgREST 14.18 runs a
deadlock victim's rolled-back transaction again, so the residual purchase-versus-boundary deadlock completes the purchase
once instead of answering `processing`; `tests/db/market.test.ts` accepts either and proves exactly one sale (`13d27e3`).

### Bench (`uukrqribdfqovahzjsrx`, `https://bench.cloudiator-arena.pages.dev`)

- Seeded 2026-10-23 21:20 UTC: 50 accounts and characters, all on the Woodland expedition; epoch 373499; scheduler on.
- First night: 6 boundaries with 50 members each, publication p50 62.5 s, p95 62.9 s, max 63.0 s, 0 over 120 s; at most 5
  dispatches in any minute (0 over the budget); 2,550 job attempts, 0 failed, 0 expired; 155 worker responses, all 200;
  `duplicateGrants` 0; health without alerts; database 29.5 MB of 500 MB.
- Deployed checks on `1b4fdbf`: 9 of 9 (Google only, sign-up open).

### Production (`djkblzbnritgbmctsvob`, `https://cloudiator-arena.pages.dev`)

| Step | Result |
|---|---|
| Project | Free organization, Central EU (Frankfurt), Postgres 17.11.0.003, PostgREST v14.18; signing key ECC (P-256) (Decision 9) |
| Data API, Auth | `public` only, max rows 50, auto-expose off; Google only (Email and Phone off), sign-ups on, CAPTCHA off, token expiry 3600 s; site URL and the one redirect `/auth/callback/` |
| Migrations | `db push`: the 22 migrations M01–M22, `migration list` 22 local and remote |
| Parity with the bench | schema fingerprint 1,157 rows each, 3 differing rows all bench activity data; access audit 583 rows, identical |
| Edge | `GAME_ALLOWED_ORIGINS` the site; worker secret and both Vault names set together; both functions deployed (Docker bundler) |
| Probes | site preflight 204 with `Max-Age 7200`, foreign preflight 403, worker without its secret 401, unauthenticated command 401 |
| Client | `release` fast-forwarded to `1b4fdbf`; Pages build success; deployed checks 9 of 9 |
| Activation | 2026-10-25: epoch 373525 (guard: no gladiator, next full slot), scheduler on (guard: both Vault names), cleanup tick ok |
| First boundary | 373525 published in 40 ms (no members); health without alerts, `slotsBehind` 0, `duplicateGrants` 0, 15 MB |

### Real journey (24.8, production, 2026-10-25)

Avi on his own desktop and phone (Decision 8), Claude reading `scripts/hosted-checks.sql` through the Management API.

| Check | Result |
|---|---|
| Desktop Google sign-in, create, reload `/game/` | the same gladiator, still signed in |
| Schedule edit, reload | the change persists |
| Phone, same account | the same gladiator, no second one |
| Accounts | 2 accounts, 2 with a character, 0 with more than one, identities `google` only (`persistedCharactersForNewGoogleAccount` = 1 each) |
| Two-account trade at P = 11 | 1 sale; buyer paid 11; seller received 11 in one credit; fee 0 (5 % of 11 floored), fee right; the item has one owner, the buyer (`twoAccountTrade {owners: 1, feeCorrect: true}`) |
| First boundary with members | slot 373529, 2 members, published in 2.69 s (0 over 120 s); prepare jobs 2 completed, 0 failed |
| Grants | `duplicateGrants` 0 (`completedRealBoundary.duplicateGrants` = 0); health without alerts, `slotsBehind` 0 |

Avi's decisions from this run, for the next change (not yet built): Arena only in the evening for now, tournaments move to
the evening slot, a minimum sale fee of 1 gold; and UI notes on character creation, the schedule and equipped gear.

## Launch feedback (M23), 2026-10-26

The change built from those decisions ([design](../superpowers/specs/2026-10-25-launch-feedback-design.md), plan
`docs/superpowers/plans/2026-10-25-launch-feedback.md`): creation points, one save for the whole day with Arena only in the
evening and the running-part notice, tournaments at 18:40 UTC, the gear view, and the 1-gold minimum market fee with a
lowest price of 2. Seven tasks, each with a spec and quality review (three needed one fix round), a whole-branch review and
one fix wave. Production was pre-approved by Avi ("approved for production once it passes"); the rules changed in place
under the runbook's M23 exception.

**Gate of record (1724a79).** `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs` on a quiet host:
**exit 0, 12 of 12**, `test:db` 334 passed with the capacity gate on and the Edge start time unchanged.

| Step | Bench (`uukrqribdfqovahzjsrx`) | Production (`djkblzbnritgbmctsvob`) |
|---|---|---|
| Pre-check (`scripts/launch-feedback-check.sql`) | all 0, no open boundary | all 0, no open boundary |
| `db push --dry-run` | only `20261025201936_launch_feedback` | only `20261025201936_launch_feedback` |
| `db push` | applied | applied (Monday 08:05 UTC, outside Wed/Sat 17:20–20:00) |
| Functions | `game-worker`, `game-command` deployed (Docker bundler; `--use-api` cannot bundle the import map) | both deployed, Edge source identical to `1724a79` |
| Post-check | all 0 | all 0 |
| Parity | 23 migrations, functions digest `6f6616377df7245d90060a410f7a23b4` = local | 23 migrations, digest `6f6616377df7245d90060a410f7a23b4` = local; bench marker absent |
| Client | `bench` fast-forwarded to `1724a79`; deployed checks 9 of 9 | `release` fast-forwarded to `1724a79`; deployed checks 9 of 9 |
| Health | boundary 373542 under M23: 50 members, prepare/simulation/reveal/settlement 0 failed, `boundaries open` 0, `duplicateGrants` 0 | 0 failed jobs, `boundaries open` 0, `duplicateGrants` 0 |

Before 24.11 the bench's 50 characters moved from the all-Woodland seed plan to camp plans (deployment.md, 24.11 step 0).

## Waiting expedition monsters, 2026-10-26

Avi on the bench: "in the wood expedition, I didn't see the monster or enemies they fight with". Encounter battles last
5 s on average (2–12 s, bench data), three per 80-minute trip, so a creature was on screen under 1% of the time. Avi approved
the mockup ("approved, build the monsters too"; [design](../superpowers/specs/2026-10-26-waiting-monsters-design.md)): each
encounter's creature now waits idling at its spot, named over its head, until its fight; a beaten one fades, a winner stays.
Client only (no migration, no Edge change: `supabase/` unchanged since `1724a79`). One task with a spec and quality review
and one fix round (the mockup's name label).

- Gate of record at `84f2d44`: **exit 0, 12 of 12**, `test:db` 334 passed with the Edge start time unchanged.
- Bench: `bench` fast-forwarded to `84f2d44`; deployed checks 9 of 9.
- Production (Avi's go in chat, 2026-10-26): `release` fast-forwarded to `84f2d44`; Pages build live; deployed checks 9 of 9.

## Gladiator appearance at creation (M24), 2026-10-27

Avi, 2026-10-26: "I want option to change the look of my gladiator, male, female, white, black, hair, long short".
Approved mockup, then "approved, build it" ([design](../superpowers/specs/2026-10-26-gladiator-appearance-design.md),
plan `docs/superpowers/plans/2026-10-26-gladiator-appearance.md`): a "Choose a look" step at creation (body male/female;
hair short/long/ponytail/bald; 5 skin tones, 6 hair colours, 12 clothes colours; Random look; live preview), stored on
the gladiator (`appearance`, `null` = the legacy look, no backfill) and drawn in the camp, expeditions and replays. New
code-generated art (female body and clothes, long hair, ponytail) on the same skeleton; Avi kept the art as drawn. Six
tasks with spec and quality reviews, a whole-branch review and one fix wave (content-addressed atlas image names, with
the 84f2d44 images kept at their old paths for open tabs), plus Codex's polish (6b63209, 6dc5047, d86ec71, 4cf873a,
754e78f). Two mobile gate failures were fixed at their cause first (189a702, 86af8c8).

- Gate of record at `86af8c8`: **exit 0, 12 of 12**, `test:db` 344 passed with the Edge start time unchanged.
- Bench: M24 pushed just after a boundary; both functions deployed; `bench` → `86af8c8`; deployed checks 9 of 9 (a first
  run right after the build went live saw a mixed-version moment; a rerun two minutes later passed); 50 actors with
  `appearance: null`; a visitor's replay read `world_actor_reads?select=gladiator_id,appearance:actor->appearance` → 200;
  a bench gladiator set to female/ponytail drew that look in a hosted replay; the old-path atlas equals the 84f2d44 bytes.
- Production (Avi's go in chat, 2026-10-27): M24 pushed mid-slot (no open boundary) — 8 actors, all `appearance: null`;
  both functions deployed from `86af8c8`; `release` → `86af8c8`; deployed checks 9 of 9; 24 migrations, functions digest
  `a1d376a5235b0833f326b623cdfd1371` = local; 0 failed jobs, `duplicateGrants` 0; old-path atlas sha `9f4d3fdf…` = 84f2d44.

## Hosted budgets (24.9), 2026-10-27

Production, about two days after activation (2026-10-25), 9 accounts and 8 characters; read by Claude through the
Management API (`scripts/hosted-checks.sql`) and from the organization's usage page and the worker's invocation list in the
dashboard (Avi's signed-in Chrome, read only). The bench numbers are in the Task 24 bench section above.

| Measure (last 24 h unless stated) | Result | Budget |
|---|---|---|
| Dispatches | 87; at most 2 in any minute; 0 minutes over | 5 per minute |
| Boundaries | 18; latency p50 5.5 s, p95 61.5 s, max 61.8 s; 0 over 120 s | 120 s |
| Job attempts since launch | prepare 142, simulation 49, reveal 390, settlement 140; 0 failed, 0 expired | 0 failed |
| Job p95 | prepare 639 ms, simulation 561 ms, reveal 1,690 ms, settlement 2,623 ms | recorded |
| Worker responses (pg_net, retained 23) | all 200; 0 timed out, 0 without a status | — |
| `game-worker` invocations (dashboard) | 85 in 24 h; 0 with a 5xx status (so no CPU-limit 546) | 0 |
| Commands | 61 receipts in 24 h, 108 since launch | — |
| `duplicateGrants` | 0 | 0 |

Usage page, billing cycle 15 Oct – 15 Nov 2026, the whole organization (production and bench), Free plan:

| Resource | Used | Included | Month projection (production, from the peak day) |
|---|---|---|---|
| Egress | 0.048 GB (peak day about 16 MB) | 5 GB | about 0.5 GB (10 %) |
| Edge Function invocations | 1,642 (peak day about 609) | 500,000 | about 18,000 (4 %) |
| Database size | production 35.5 MB, bench 99.7 MB | 0.5 GB per project | production 7 % now; `pg_database_size` 21 MB, up from 15 MB at activation |
| Monthly active users | 9 | 50,000 | — |

No budget is near 80 %. The dashboard's Free-plan quotas (5 GB egress, 500,000 invocations) are higher than the 3 GB and
300,000 the plan budgeted for (C6), so those budgets keep their margin. Egress per service and Edge-to-API billing were not
separated (the totals are under 1 % of the quota, so the question does not change any decision). Re-read the database size
at 14 days, after the cleanup job's retention has run for a full window.

## Hosted recovery (24.10), 2026-10-27: checks done, hosted export still open

The hosted export and the bench disaster-restore rehearsal (deployment checklist 24.10 steps 3 to 5) did **not** run. What
was proven instead, on the bench, by Claude, with no credential unless stated:

- **Local rehearsal** (step 1, 2026-10-24, the Task 24 ledger): export through `host.docker.internal` with
  `sslmode=disable`, exit 0 (56 tables, 1,059 rows, 22 migrations); its restore check exit 0 (`duplicateGrants` 0,
  `lostItems` 0, resume `replayed`, 0 mismatches); the hosted-restore load into a reset local database exit 0, and a second
  run refused with `target-not-fresh` (runbook "Hosted restore", "Tested locally").
- **CA** (step 2): Database settings → SSL configuration gives `Supabase Root 2021 CA` (self-signed root, valid until
  2031-04-26). Saved as `<private folder>\<bench-ref>-ca.crt` and copied to `/root/.postgresql/root.crt` in the local
  container.
- **Which host**: the direct host `db.<bench-ref>.supabase.co` resolves to IPv6 only; it is unreachable from this PC (TCP 5432)
  and does not resolve inside the container. The session pooler (IPv4, port 5432, user `postgres.<bench-ref>`) is this
  PC's export path.
- **TLS**: through the session pooler with `sslmode=verify-full` and that CA, the handshake and the host-name check pass (a
  probe with an unknown user reached the pooler's own `FATAL` after TLS). With `channel_binding=require` the pooler offers no
  channel-binding method, so authentication is plain SCRAM-SHA-256.
- **Dump preconditions**: the hosted `postgres` has `SELECT` on every relation outside the system schemas (0 without), and the
  server is PostgreSQL 17.11, the same as the container's `pg_dump`.
- **CLI**: `db query --linked` and `db push --linked --dry-run` connect without the database password (the CLI's temporary
  login role), so the bench reset should not prompt for one (the reset itself did not run).
- **The export**: four attempts with the passwords supplied, through a guarded one-run wrapper (not committed). Each stopped
  at its connection probe, before anything was written, with `password authentication failed for user "postgres"`
  (bench pooler log; the wrapper's message keeps no host, address or password). The bench's `pg_stat_statements` records
  one `postgres` password change, by `supabase_admin` at project creation (2026-10-23 10:25 UTC), and none since. The
  dashboard resets tried during the session never reached the database. Nothing changed on the bench: the scheduler stayed
  on, and its data and Vault secrets were untouched.

**Still to run:** steps 3 to 5 once the operator has a working database password. Reset it under Database settings → Reset
password, typing the new password in the box, and wait until the change shows as saved. If the bench is deleted first (24.12),
the first production weekly export (`verify-full` through the session pooler, the same CA) becomes the hosted test of the
export, and the restore check on that backup the hosted test of the restore.

## Keyboard focus while commands are pending, 2026-10-27

Release `1b57ba5`, client only (no migration, Edge function or art change), on top of `86af8c8`:
- Codex `b3ba441`, `e07fdc5`, `b8aa588`: Build, Market, Inventory and Shop command buttons are `aria-disabled` while
  their command is sent (the `86af8c8` Schedule pattern). They keep the keyboard focus and ignore repeated activation.
- Claude `1b57ba5`, from the review of those three: busy Build buttons looked fully available (only the schedule actions
  and the inventory panel styled `aria-disabled`). The rule now covers the whole planning form, and every busy button dims to
  `.7`. The contrast helper skips `aria-disabled` buttons as it skips disabled ones (inactive controls, WCAG 1.4.3). The
  busy-focus tests assert the `not-allowed` cursor and `.7` opacity; they failed before the fix on Build and List for sale,
  desktop and mobile.

Gate of record at `1b57ba5` (`node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs`), exit 0, 12/12:
db 344 passed with the Edge container unchanged; dev browser 683 passed, 57 skipped; production gate 34 passed.
`bench` and `release` fast-forwarded from `86af8c8` (production with Avi's go in chat); production served the new CSS from
15:30:07 UTC. Deployed checks without `@attested`, run after the build was live: bench 9/9 and production 9/9.
`fixedRoutesReload` desktop and mobile showed 5 of 5 routes, and the favicon 404 was recorded, not failed. `anonDenied` 14 of 14,
`shippedAssetsClean` 44 assets (25 JavaScript), 0 problems. Production after the release: scheduler on, published slot = current slot
373565, 0 open boundaries.

Follow-up, not in this release: Enter in a Build attribute field submits the form, and the busy fieldset then drops that
field's focus. This existed before; the review suggested a capturing `focusout` rescue in `useFocusRescue`.
