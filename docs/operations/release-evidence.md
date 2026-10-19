# Release evidence

Task 23's record of what was measured, on what, and what remains open before the public release. Each lane writes its own
section; the controller merges them.

## Lane A: capacity

**Status: three budgets fail (blockers for Avi), two are named risks.** Task 23.3, measured on 2026-10-19 on the local
stack. Nothing here is a hosted measurement: hosted CPU, compression and billing are Task 24 checks.

### How it was measured

- **Command:** `node scripts/resource-report.mjs` (defaults `--players 50 --viewers 50 --slots 4`). It discovers the local
  stack in memory, refuses anything that is not loopback, and runs two suites:
  - `tests/performance/simulation.test.ts` (pure code, also in `npm test`);
  - `tests/db/capacity.test.ts` (also in `npm run test:db`).
  The arithmetic is in `tests/performance/capacity-model.ts`, pinned by `tests/performance/capacity-model.test.ts`.
- **Gate:** `tests/db/capacity.test.ts` enforces the budgets below only with `CAPACITY_GATE=1` (controller ruling, 2026-10-19).
  Without it (a plain `npm run test:db`) the case still measures and records every number and checks the run itself, so the
  suite stays green while the blockers are open. Task 23.6's release gate runs it with the flag, and fails until every
  blocker below is resolved. The report's verdicts and exit code do not depend on the flag.
- **Environment:** 13th Gen Intel Core i9-13900K (32 logical cores, 32 GiB), Windows 11 Pro 10.0.26200, Node 22.19.0 (V8 12.4),
  PostgreSQL 17.11 in the Supabase CLI 2.120.0 stack, Docker Desktop. The Edge container's start time was unchanged across
  the report run (11:31:38.55 UTC, run 11:55-11:57). A later rerun of `tests/db/capacity.test.ts` reproduced every verdict
  within 0.3 percentage points (Edge 12:05:29.19 UTC unchanged, run 12:07-12:09).
- **Measurement world (scenario 1, the upper bound):**
  - 50 real characters (real creation, then placed at historical slots by the operator, as the Arena tests do);
  - three rotating schedules with no Rest: Arena / Arena / Woodland, Woodland / Arena / Training, Training / Arena / Arena;
  - every character opted in and starting rested, so no slot of the run falls back to Rest.
  Each regular slot mixes 17 Arena, 17 Woodland expedition and 16 Training. Slot 301 (Saturday 17:20 UTC) is a tournament
  slot, where all 50 enter one Bronze bracket.
- **Scenario 2 (the default):** the same 50 characters on the new-character schedule, Training / Woodland / Rest.
- **Cadence:** a warm-up slot, then the measured slots, each ticked every minute of database time for all 80 minutes, 300 ms
  into the minute. Each tick runs pg_cron's `private.cron_tick()` and the real private Edge worker through pg_net, and waits
  until every invocation answers. That is 400 ticks (70.6 s of wall time) for scenario 1 and 320 ticks (29.8 s) for scenario 2.
- **What the run counts:** dispatches per tick, revision changes per tick, and rows added per slot in every table.
- **Row sizes** are modeled from the live rows: the tuple as `pg_column_size(row)` gives it (TOAST values compressed), plus a
  line pointer, plus one entry per index at 75 % leaf fill, then a 20 % allowance for autovacuum's equilibrium.
  - **Cross-check** (`VACUUM FULL`, tables with at least 200 rows): the live estimate is within 15 % of the compact file size
    per row.
  - Examples (modeled live / compact): jobs 1,761 / 1,807 B; activities 790 / 852 B; receipts 861 / 931 B; settled slots
    229 / 246 B.
  - The run's own file growth per row is 1.6 to 2 times larger, because of dead row versions and first pages.
- **Read sizes** are real local Data API responses of the app's own read adapters (`src/lib/api/reads.ts`), as a visitor
  (anon) and as a signed-in player. Bodies are compressed with node zlib (gzip level 6, brotli quality 5), and headers are
  counted uncompressed. Local Kong does not compress, so hosted compression is a Task 24 check.

### The report

The output of `node scripts/resource-report.mjs` (exit 1: blockers), condensed. The `measured` block (every table's rows and
row sizes, the per-tick record) is left out. Database figures are bytes; read sizes are raw / gzip / brotli body bytes, before their headers.

```json
{
  "ok": false,
  "target": "local",
  "options": {"players":50,"viewers":50,"slots":4},
  "database": {"bytesPerSlot":1297926,"steadyStateBytes":466946625,"atOneYearBytes":718385894,"budgetBytes":262144000,"permanentBytesPerMonth":27388078,"defaultSchedule":{"bytesPerSlot":1040407,"steadyStateBytes":394700873,"atOneYearBytes":597144418,"permanentBytesPerMonth":22043090}},
  "invocations": {"perSlot":{"regularPerSlot":21.5,"tournamentPerSlot":23.5,"weighted":21.5},"perMonth":{"30d":{"worker":11628,"commands":30000,"total":41628,"ceiling":246000},"31d":{"worker":12015,"commands":31000,"total":43015,"ceiling":254200}},"budget":300000},
  "egress": {
    "perRead": {
      "revision": {"visitor":[115,113,82],"player":[115,114,82]},
      "world": {"visitor":[29069,3989,3681],"player":[29069,3989,3681]},
      "ownerStarter": {"visitor":[0,0,0],"player":[2612,883,834]},
      "timelineArena": {"visitor":[19404,1701,1418],"player":[19406,1703,1421]},
      "timelineOwn": {"visitor":[12688,1652,1452],"player":[13296,2017,1780]},
      "timelineTraining": {"visitor":[318,295,233],"player":[320,297,235]},
      "timelineTournament": {"visitor":[15004,1807,1532],"player":[15409,2107,1792]},
      "profile": {"visitor":[656,393,368],"player":[656,393,368]},
      "recent": {"visitor":[18775,3567,3215],"player":[18775,3567,3215]},
      "seasons": {"visitor":[81,81,67],"player":[81,81,67]},
      "standings": {"visitor":[8899,1904,1748],"player":[8899,1904,1748]},
      "standingOf": {"visitor":[215,196,182],"player":[215,196,182]},
      "tournament": {"visitor":[60246,10181,9270],"player":[60246,10181,9270]},
      "tournamentLog": {"visitor":[12852,1342,1133],"player":[12852,1342,1133]},
      "market": {"visitor":[24107,2892,2515],"player":[24107,2892,2515]},
      "command": {"visitor":[0,0,0],"player":[116,116,96]},
      "authLookup": {"visitor":[0,0,0],"player":[1446,425,381]},
      "authRefresh": {"visitor":[0,0,0],"player":[2646,1325,1281]},
      "owner": {"visitor":[0,0,0],"player":[26909,3025,2828]}
    },
    "perMonthPlayers": {"30d":{"raw":1365383791,"gzip":320134963,"brotli":301119377},"31d":{"raw":1401118196,"gzip":328705843,"brotli":309196006}},
    "perMonthViewers": {"30d":{"raw":1082998183,"gzip":252444640,"brotli":235955277},"31d":{"raw":1109319735,"gzip":258759176,"brotli":241859769}},
    "perMonthBackend": {"30d":{"raw":1074788427,"gzip":193052610,"brotli":181011394},"31d":{"raw":1106824966,"gzip":199133994,"brotli":186741179}},
    "budget": 3000000000
  },
  "worker": {"worstCombatMs":6.9,"batch5Ms":17.3,"bracket50Ms":2.8,"tournamentBatch5Ms":190.9},
  "seasonClose": {"ms50":14.1,"ms500":29.3},
  "standings": {"pageMs":6.2,"oneRowMs":6.4},
  "boundary": {"targetMs":120000,"publishedMs":{"mixed":[[300,121568],[301,121590],[302,61790],[303,121573]],"defaultSchedule":[[300,61619],[301,61571],[302,121569]]}},
  "budgets": [
    ["database at 90 days, mixed schedules",178.1,"blocker"],
    ["database after one year, mixed schedules",274,"blocker"],
    ["database at 90 days, new-character schedule",150.6,"blocker"],
    ["database after one year, new-character schedule",227.8,"blocker"],
    ["invocations, 30-day month",13.9,"ok"],
    ["invocations, 31-day month",14.3,"ok"],
    ["invocations at the dispatch ceiling, 30-day month",82,"risk"],
    ["invocations at the dispatch ceiling, 31-day month",84.7,"risk"],
    ["egress raw, players and viewers, 30-day month",81.6,"risk"],
    ["egress raw, players and viewers, 31-day month",83.7,"risk"],
    ["egress gzip, players and viewers, 30-day month",19.1,"ok"],
    ["egress gzip, players and viewers, 31-day month",19.6,"ok"],
    ["egress raw with backend traffic, 30-day month",117.4,"blocker"],
    ["egress raw with backend traffic, 31-day month",120.6,"blocker"],
    ["boundary publication at 50 characters (worst window)",101.3,"blocker"],
    ["worker worst 120 s fight",0.3,"ok"],
    ["worker batch of 5",0.9,"ok"],
    ["worker 50-entrant bracket",0.1,"ok"],
    ["worker tournament bout batch",9.5,"ok"],
    ["season close, 4 leagues x 50",0,"ok"],
    ["season close, 4 leagues x 500",0.1,"ok"],
    ["standings page at 1,000 rows (Data API)",0.8,"ok"],
    ["one standing row at 1,000 rows (Data API)",0.9,"ok"]
  ]
}
```

### Budgets

| Budget | Used | Limit | Share | Verdict |
|---|---|---|---|---|
| Database at 90 days, mixed schedules | 445.3 MiB | 250 MiB | 178.1 % | **blocker** |
| Database after one year, mixed schedules | 685.1 MiB | 250 MiB | 274.0 % | **blocker** |
| Database at 90 days, new-character schedule | 376.4 MiB | 250 MiB | 150.6 % | **blocker** |
| Database after one year, new-character schedule | 569.5 MiB | 250 MiB | 227.8 % | **blocker** |
| Boundary publication at 50 characters (worst window) | 121.6 s | 120 s | 101.3 % | **blocker** |
| Egress raw, players and viewers, 31-day month | 2.51 GB | 3 GB | 83.7 % | risk |
| Egress gzip, players and viewers, 31-day month | 0.59 GB | 3 GB | 19.6 % | ok |
| Egress raw with backend traffic, 31-day month | 3.62 GB | 3 GB | 120.6 % | **blocker if hosted counts it uncompressed** |
| Invocations, 31-day month (10 commands a player a day) | 43,015 | 300,000 | 14.3 % | ok |
| Invocations at the dispatch ceiling, 31-day month | 254,200 | 300,000 | 84.7 % | risk |
| Worker: worst 120 s fight / batch of 5 / bracket / bout batch | 6.9 / 17.3 / 2.8 / 190.9 ms | 2,000 ms | ≤ 9.5 % | ok (this machine) |
| Season close, 4 × 50 / 4 × 500 rows | 14.1 / 29.3 ms | 43,950 ms | ≤ 0.1 % | ok |
| Standings page / one row at 1,000 rows (Data API) | 6.2 / 6.4 ms | 750 ms | ≤ 0.9 % | ok |

The 30-day month reads 81.6 % raw egress, 117.4 % raw with backend traffic and 82.0 % at the dispatch ceiling.

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
| jobs (detail) | 250 | 2,053 | 513 KB |
| activities (summary) | 50 | 902 | 45 KB |
| recent_results (summary) | 50 | 506 | 25 KB |
| activity_stages (detail) | 133 | 955 | 127 KB |
| expedition_plans (detail) | 17 | 5,512 | 92 KB |
| activity_snapshots (detail) | 50 | 1,803 | 90 KB |
| settled_slots (permanent) | 50 | 274 | 14 KB |
| operation_receipts, settlement (permanent) | 17 | 1,014, then 308 compacted | 17 KB |

**Arithmetic at 90 days** (scenario 2; scenario 1 in brackets):
- **Detail** (126 × the detail bytes a slot): 111.9 MiB (139.5). Jobs alone are 61.7 MiB: 250 × 126 × 2,053 B.
- **Summaries** (1,620 × the summary bytes a slot): 116.6 MiB (130.6). Activities are 69.7 MiB: 50 × 1,620 × 902 B; recent
  results 39.1 MiB.
- **Permanent:** 47.0 MiB (74.4). Settled slots are 21.1 MiB: 50 × 1,620 × 274 B.
- **Commands** (10 a player a day): 80.8 MiB.
  - Receipts: 50 × 10 × 90 × 787 B, permanent, never compacted.
  - 90-day rows: one beside each receipt, at the largest of a listing with its offer, a ledger row or a superseded schedule
    revision (1,095 B).
- **System:** 15.9 MiB. The catalogs, extensions and empty tables (the local catalog is bloated by tests, so this is
  conservative), plus cron's 7-day run log, pg_net's 6 hours and Auth's rows for 50 accounts.
- **Player state** with a full 60-item inventory each: 3.6 MiB. **Seasons:** 0.1 MiB.

**After one year:** permanent rows grow by 21.0 MiB a month (26.1 in scenario 1), and command receipts by about 11.3 MiB a
month at 10 commands. A season adds 37 KB.

**Command-rate sensitivity** (scenario 2, 90 days / one year): 0 a day 295.7 / 385.5 MiB; 5 a day 336.0 / 477.5; 10 a day
376.4 / 569.5; 20 a day 457.2 / 753.5. Even with no commands and no autovacuum allowance (÷ 1.2) the year is over budget.

### Boundary latency (spec §10.4, Global Constraints)

| Run | Publication after the cutoff |
|---|---|
| Scenario 1, slots 300 / 301 / 302 / 303 | 121.6 s / 121.6 s / 61.8 s / 121.6 s |
| Scenario 2, slots 300 / 301 / 302 | 61.6 s / 61.6 s / 121.6 s |

Every boundary whose previous slot had expeditions takes a third tick.

**Why.** An expedition's settlement job depends on its last reveal, the "Arrive at camp" stage, which falls due exactly at
the next cutoff (10-tournament-results.sql's plan acceptance links the settlement to every reveal).
- At the cutoff tick, `dispatch_workers()` counts only dependency-ready jobs: the other settlements and the due reveals,
  50 in scenario 2. It dispatches 3 invocations of at most 20 simple jobs each.
- `runWorker` claims settlements before reveals, so the expedition settlements released by those reveals wait for the next
  tick. Preparation waits one more.
- The Arena-only cadence tests of Task 23.2 (about 61 s) have no expeditions in the previous slot.

**Not fixed here.** Reordering the worker alone cannot fit 100 simple jobs into the 3 invocations dispatched. A fix needs a
dispatch count that includes the settlements due reveals release (SQL, so a new migration), or a final reveal folded into
its settlement, or larger batches. Each is a design decision.

### Egress

**Measured responses** (raw bytes / gzip / requests):

| Read | Size |
|---|---|
| revision | 115 / 113 B / 1 |
| world (50 actors, its two revision checks) | 29,069 / 3,989 / 4 |
| owner, full inventory | 26,909 / 3,025 / 1 |
| owner, starter inventory | 2,612 / 883 / 1 |
| arena timeline | 19,404 / 1,701 / 3 |
| own expedition timeline | 13,296 / 2,017 / 4 |
| results page | 18,775 / 3,567 / 1 |
| market page (50 offers) | 24,107 / 2,892 / 1 |
| standings page | 8,899 / 1,904 / 2 |
| standing row | 215 / 196 / 2 |
| profile | 656 / 393 / 1 |
| seasons | 81 / 81 / 1 |
| tournament view, late, 50 entrants (C10) | 60,246 / 10,181 / 7 |
| tournament log (mean of 49) | 12,852 / 1,342 / 2 |
| command (preflight and response) | 116 / 116 / 2 |
| the function's session lookup in Auth | 1,446 / 425 / 1 |

Headers are about 470 bytes a response.

**Usage model**, per person with the camp visible 30 minutes a day:
- **Polls:** 2 revision reads a minute.
- **Re-reads:** the world (and, for a player, the owner state, the standings page and its own row; the panel is assumed open
  all session) at every revision change it sees. The run measured 10.5 changes in a regular slot and 7.5 in a tournament
  slot, plus one for the slot index. A 1.039 split factor covers commits that straddle a poll: 11.5 / 80 × 1.039 is 0.149
  re-reads a minute.
- **Arena timelines:** the camp reads each Arena entrant's timeline once per slot whose minute-60 to minute-80 window the
  session overlaps: 17 entrants × (30 + 20) / 80.
- **Entry loads.**
- **A player's own traffic:** 10 commands a day with their preflights, and one session refresh a day.
- **Tournaments:** the 9 tournament days a month at 30/80 coverage, each with 16 view reads (camp and panel) and all 49 logs
  (676,636 B raw incl. headers).

**Per day:** a player 707 KB raw (181 KB gzip). A visitor 505 KB raw (127 KB gzip).

**Month** (31 days, 9 tournaments):
- players 1.401 GB raw (0.329 gzip, 0.309 brotli);
- visitors 1.109 GB raw (0.259 gzip);
- together 2.51 GB raw (83.7 %), 0.59 GB gzip (19.6 %).

**Backend traffic (an estimate):** the worker's own Data API responses (claimed job inputs, tournament graph reads, owner
state for expedition settlements), plus each command's session lookup, owner read and RPC responses. That is 1.107 GB raw
(0.199 gzip) a month; it counts only if hosted egress includes Edge-to-API traffic (Task 24).
- Within it, each tournament bout's fenced read returns the whole stored graph with every earlier log.
- At 50 entrants that is about 12 MB for the final when every bout runs to the 120 s cap.

**Always-on visitors:** 50 of them, round the clock, would need 27.1 GB raw (7.2 gzip) a month. The raw budget leaves room
beside the players for 2 always-on visitors.

### Invocations

- **Worker:** the real worker dispatches measured 21.5 a regular slot and 23.5 a tournament slot (21.3 in scenario 2). That
  is 12,015 a 31-day month (11,628 for 30 days).
- **Commands:** 10 a player a day, each with its CORS preflight (no `Access-Control-Max-Age`): 31,000.
- **Total:** 43,015 (14.3 %).
- **Ceiling:** the dispatch ceiling of 5 a scheduled minute is 223,200 a 31-day month (216,000 for 30 days). Plus commands
  it is 254,200 (84.7 %), reached only if work were due every minute.

### Worker, season close and standings

- **Worker** (the budget is 1,500 ms: cpuMs 2,000 less 25 %):
  - worst 120 s fight (961 events): 6.9 ms cold, 3.7 ms median;
  - five of them: 17.3 ms;
  - five long Mountain expeditions: 11.0 ms;
  - the 50-entrant pairing job (partition, bracket, graph check): 2.8 ms;
  - five final-bout jobs, each parsing a 12.2 MB graph read: 190.9 ms.
  This machine is fast. Hosted Edge CPU is C4, a Task 24 check.
- **Season close (C14),** one statement with its commit-time projections:
  - 4 leagues × 50 rows, 12 awards: 14.1 ms;
  - 4 × 500 rows, 12 awards: 29.3 ms.
  The budget is 43,950 ms (what the 120 s boundary target leaves after a 61.4 s publication, less 25 %). The synchronous close
  stays.
- **Standings (C13)** at 1,000 rows of one league and season, through the Data API as a visitor:
  - a page takes 6.2 ms and one row 6.4 ms (medians of 15);
  - both plans execute in 2.6 ms and 1.8 ms;
  - both evaluate the window over the whole league-season (WindowAgg over `arena_standings_rank_idx`, 6,688 shared buffer
    hits).
  Recommendation: no rank cache now. Revisit when one league-season passes about 10,000 rows, or when the plan's execution
  passes 100 ms.

### Risks and mitigations

1. **Database (blocker).** The 7-day detail and 90-day summaries of 50 characters with an activity every slot already exceed
   250 MB, and permanent rows add about 21 MB a month. Options for Avi, none built:
   - delete or empty completed jobs' inputs and results once their slot settles (about −60 MiB);
   - keep `recent_results` 7 days, or one completion copy only (about −35 MiB);
   - shorten summaries to 30 days (about −78 MiB);
   - fold settled slots into per-character ranges, and drop compacted settlement receipts that a settled slot guards
     (the year's growth; this reverses a Task 22 ruling);
   - stop scheduling characters whose owner has not signed in for N days;
   - or raise the internal budget toward the free plan's 500 MB.
2. **Boundary latency (blocker).** About 121.6 s after any slot with expeditions. See "Boundary latency" for the cause; the
   fix is a design decision (dispatch counting, or folding the final reveal into the settlement).
3. **Egress raw (risk), with backend traffic (blocker if uncompressed and billed).** Compressed, the total is about 26 %.
   Mitigations:
   - Task 24 verifies that hosted responses are compressed and whether Edge-to-API traffic is billed;
   - the bout input could carry only its parents' results rather than the whole graph;
   - delta world reads;
   - `Access-Control-Max-Age` on the command function.
   Visitor reads stay unthrottled and monitored (Decision 2); only about 2 always-on visitors fit raw.
4. **Dispatch ceiling (risk).** It is reached only if work were due every minute. The health report and the hosting dashboard
   watch invocations.
5. **Command receipts (carried from Task 22).** 787 B each, permanent: about 11 MiB a month at 10 commands a player a day.
   Part of risk 1.
