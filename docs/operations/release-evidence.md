# Release evidence

Task 23's record of what was measured, on what, and what remains open before the public release. Each lane writes its own
section; the controller merges them.

## Lane A: capacity

**Status: the database budget fails (a blocker, pending Avi), egress fails only under a hosted condition (Task 24), and the
dispatch ceiling is a named risk.**
- The boundary-latency blocker this measurement found is fixed (M19, corrected by M20; "Boundary latency" below), but with
  **zero headroom**: at 50 all-expedition characters the cutoff tick is exactly full, and a 51st character would bring the
  121.6 s publication back (derived, not measured). It is a named risk (risk 5).
- Task 23.3, measured on 2026-10-19 on the local stack. Nothing here is a hosted measurement: hosted CPU, compression and billing
  are Task 24 checks.

### How it was measured

- **Command:** `node scripts/resource-report.mjs` (defaults `--players 50 --viewers 50 --slots 4`). It discovers the local
  stack in memory, refuses anything that is not loopback, and runs two suites:
  - `tests/performance/simulation.test.ts` (pure code, also in `npm test`);
  - `tests/db/capacity.test.ts` (also in `npm run test:db`).
  The arithmetic is in `tests/performance/capacity-model.ts`, pinned by `tests/performance/capacity-model.test.ts`.
- **Gate** (controller ruling, 2026-10-19): `tests/db/capacity.test.ts` enforces the database, invocation and raw-egress
  budgets only with `CAPACITY_GATE=1`.
  - Without the flag (a plain `npm run test:db`), the case still measures and records every number and checks the run itself.
    The suite therefore stays green while the blockers are open.
  - The boundary-publication check (every window under 120 s) has been on since the fix, at up to 50 characters (spec §10.4's
    load). With `--players` above 50 the windows are still recorded, and the report's boundary line gives their verdict.
  - The cadence case (`publishes within 120 s after a slot of expeditions …`) always runs 50 characters, whatever `--players`
    is (fix round 1).
  - The measured sections are printed on the console only in a report or `CAPACITY_GATE=1` run; a plain `npm test` or
    `npm run test:db` prints none of them (fix round 1). A measurement the suites did not produce is reported as `missing`
    and fails the report, never `ok`.
  - Task 23.6's release gate runs the file with the flag, and fails until every blocker below is resolved.
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

The output of `node scripts/resource-report.mjs` (exit 1: the database budget), condensed. The `measured` block (every table's
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
| Database at 90 days, mixed schedules | 445.4 MiB | 250 MiB | 178.1 % | **blocker (pending Avi)** |
| Database after one year, mixed schedules | 685.2 MiB | 250 MiB | 274.1 % | **blocker (pending Avi)** |
| Database at 90 days, new-character schedule | 376.2 MiB | 250 MiB | 150.5 % | **blocker (pending Avi)** |
| Database after one year, new-character schedule | 568.5 MiB | 250 MiB | 227.4 % | **blocker (pending Avi)** |
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

1. **Database (blocker, pending Avi).** The 7-day detail and 90-day summaries of 50 characters with an activity every slot
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
   - **Watch:** the number of active characters (those with an activity in a slot). The health report does not count them yet;
     until it does, its `boundaries` section (a boundary still waiting after the second tick) and `jobs.overdue` show the
     symptom, and the count is a direct query.
   - **Mitigation options when active characters approach 50 (none built):**
     - make the final reveal fall due before the cutoff, so an earlier tick completes it and the cutoff tick carries only the
       settlements (100 characters fit);
     - fold the final reveal into the settlement job (one job per character at the cutoff);
     - or raise the cutoff tick's capacity: a larger simple batch, or more invocations in the cutoff minute, within the
       invocation budget (risk 3).
   - Task 23.7's planned idle pause (a character whose owner has sent no activity signal for 14 days leaves the boundary
     cohort) reduces the active cohort. Its design awaits Avi's approval; nothing of it is built.
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
  - The overlay shows the same four numbers with the WebGL renderer, so that measurement can be added to this table.

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
