# Task 16 report: league-aware Arena battles and ratings

Status: **DONE**, with one recorded timing limit. All three phases are implemented and verified locally. Phase 1 (pure
domain) and phase 2a (schema, placement, ratings, pairing) passed independent review. Phase 2b (bouts, settlement, stages,
standings) passed its independent review (spec Pass, quality Pass, ready with fixes); the review fixes are in
[Review fixes](#review-fixes-i1-m1-m2). At the real one-minute cron cadence a steady-state 50-entrant boundary now publishes
at about 61 s when the rolling dispatch window has cleared. When the window still counts the previous tick, it publishes at
about 121 s. The current worker misses that case above 40 characters. At 50 the boundary needs exactly the 100 settlement
and preparation jobs the window allows, so only a worker change with zero slack could in principle reach about 61 s; above
50 characters no worker change can (see [Timing](#timing-50-entrants-one-minute-cron-cadence), corrected in the
[re-review](#re-review-fixes)). A robust fix needs a policy decision, recorded for Task 23. Hosted proof, retention and the
tournament and season tasks remain later gates.

| Phase | Scope | Branch and commits | Review |
| --- | --- | --- | --- |
| 1 | Pure Arena domain: `leagueFor`, `estimateArenaStrength`, `makeFallback`, `matchArena`, `ratingDelta`, `applyRatingDelta`, `arenaOutcomes` | `claude/task-16`: feature `270deb9`, report `61b3e7b`, review fixes `a60eeb2`/`bec7ad2`, Minors `c30d854`/`b3c3238` | Spec Pass, quality Pass ([review](task-16-phase-1-review.md)) |
| 2a | Season epoch, league placement at phase 4, rating rows, visible combat strength, fenced pairing at phase 7, M09 | `claude/task-16-p2`: brief `cd73b1e`, feature `6e8fd57`, report `430aec3`, review record `d3797e7` | Spec Pass, quality Pass ([review](task-16-phase-2a-review.md)) |
| 2b | One simulation per battle, worker executor, fenced acceptance, settlement one side at a time, public stages, standings, live UI wiring, M10 | `claude/task-16-p2`: base `d3797e7`, brief `1d6a482`, feature **`31cfdaa`**, report `deda395`, review fixes **`337f38d`**/`a1c6732`, re-review fix **`cf325d1`**, this update | Spec Pass, quality Pass, ready with fixes (I1, M1, M2); fixes and re-review fixes below |

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`. Phase 2b base: **`d3797e7`** (pushed).
- Phase 2b scope: [task-16-phase-2b-dispatch.md](task-16-phase-2b-dispatch.md), the 2a report's "What phase 2b must do" with its
  review additions, and the binding plan and spec text in [task-16-brief-base.md](task-16-brief-base.md).
- Migrations: M09 `supabase/migrations/20261014113448_arena.sql` (2a) and M10
  **`supabase/migrations/20261014131209_arena_bouts.sql`** (2b). M01–M08 are unchanged.
- Not done, by instruction: no push or merge, no `HANDOFF.md` edit, no subagents, no downloads. No other checkout was opened
  and no hosted project was touched. No key, credential or status output was printed; CLI, reset and test output is in
  ignored `.task16-2b-*.log` files, the review-fix runs in ignored `.task16-fix-*.log` files and the re-review runs in
  ignored `.task16-rr-*.log` files.

## Phases 1 and 2a (summary)

The [phase 1 report](task-16-phase-1-report.md) and the [phase 2a report](task-16-phase-2a-report.md) hold the full
interfaces, decisions and evidence. In short:
- **Phase 1** added `supabase/functions/_shared/domain/arena.ts` with 121 unit cases: league index and thresholds from level,
  every earned point and historical gear (never the current loadout), the exact-decimal strength estimate, the 85% NPC
  fallback, strongest-first greedy pairing within a league under the 2× cap and the 18-slot history, Elo K24 with a floor of
  0, and per-side outcomes from the logged `winnerId`. Avi kept the spec's strongest-first rule (balance option A).
- **Phase 2a** added `supabase/sql/07-arena.sql` and M09: the immutable season epoch and `season_index`; placement at
  phase 4 as max(cached, frozen) with one rating row per character, league and season; the published combat strength; one
  fenced `pair` job per slot and league, strict acceptance against frozen values, and immutable assignments with per-battle
  seeds `sha256(<pairing seed>:<battleId>)`. Arena activities stalled truthfully at phase 8 until 2b.

## Phase 2b: what changed

| Path | Change |
| --- | --- |
| `supabase/sql/08-arena-bouts.sql` | New reapplicable source; its header lists the eight accepted exceptions. |
| `supabase/migrations/20261014131209_arena_bouts.sql` | M10, CLI-generated and completed (see "Migration"). |
| `supabase/functions/_shared/backend/jobs.ts` | `ArenaSimulationInput`, `ArenaSimulationResult`, `simulateArenaV1`; the explicit simulation discriminator; `PairingInput.historyFromSlot` and its fail-closed check; an operator-retained settlement counts as failed. Review fix I1: `runWorker` claims the pairing jobs its own coordination released after its simple loop; since the re-review, one at a time with the CPU budget checked before each claim. |
| `supabase/functions/_shared/backend/database.ts` | `JobOutcome` gains the `operator` code. |
| `supabase/functions/_shared/domain/arena.ts` | Additive `arenaNpcName(league)`. |
| `src/lib/api/reads.ts`, `src/lib/api/gateway.ts` | `readStandings` and the live `standings(league, cursor?)`. Review fix M2: the latest-season probe reads `public.arena_standings`. |
| `src/app/game/page.tsx` | The Arena card and the Standings panel receive the live gateway in live mode; fixture mode is unchanged. |
| `tests/db/arena.test.ts` | 13 new DB cases (28 in all); five 2a expectations updated (see "Affected existing tests"). Review fix I1: the timing case now runs at the one-minute cron cadence. Re-review: its held-window comment no longer counts the pairing jobs as simple work. |
| `tests/backend/worker.test.ts` | 13 new unit cases (2 from review fix I1, 3 from the re-review); the pairing inputs gain `historyFromSlot`. |
| `tests/reads.test.ts`, `tests/api/projection-gateway.test.ts` | 3 new unit cases for the standings read; review fix M2 updates their probe path. |
| `tests/browser/arena-live.spec.ts` | New live-mode spec: the live panels get a reader. Its fake backend answers the M2 probe path. |
| `tests/db/activities.test.ts` | One affected expectation: Arena now starts at phase 8. |
| `vitest.db.config.ts` | The same `@domain`, `@contracts` and `@` aliases as the unit config (DB tests drive the read adapters). |
| `docs/operations/migrations.md` | M10 entry, release and retention notes. Review fix M1: the release check names `prepare`, `pair` and `simulation`. |

`combat.ts`, the contracts, the fixture gateway and the Task 17 panels are unchanged.

## Interfaces (phase 2b)

### TypeScript

- **`simulateArenaV1(input, seed)`**, the `kind: 'arena'` branch of `v1.simulation`. Input: `{kind, battleId, slotIndex,
  rulesVersion, startsAtMs, revealAtMs, assignment, names}`, where `assignment` is the frozen row from
  `private.arena_assignments` and `names` are the human sides' names in side order. It runs one `simulateBattle` from the
  assignment's frozen fighters and NPC template only, then `arenaOutcomes`, and returns `{battleId, log, outcomes}`.
  - Participants: a human is `{id: gladiatorId, gladiatorId}`; the NPC is `{id: 'npc:<entrant>', gladiatorId: null}` named
    `arenaNpcName(league)` ("Bronze Sentinel", "Silver Sentinel", "Gold Sentinel", "Champion Sentinel").
  - Fails closed: another rules version is `unsupported-rules`; a battle or slot mismatch, a names mismatch, `startsAtMs`
    other than `slot × slotMs`, `revealAtMs` other than `startsAtMs + RULES_V1.arena.revealAfterMs`, or an invalid fighter is
    `invalid-input`.
- **Discriminator.** An input with `kind: 'arena'` is an Arena bout. An input without `kind` whose `choice.kind` is
  `expedition` is an expedition snapshot and keeps `planExpedition`. Anything else is `unsupported-executor`.
- **`pairArenaV1`** now requires `historyFromSlot <= slotIndex − rules.matchmaking.recentPairingSlots` (`invalid-input`
  otherwise, also when it is missing).
- **`runWorker`**: a settlement answered `{ok:false, code:'operator'}` counts as `failed` and is not failed again. After its
  simple loop, if its latest coordination left a boundary waiting on `pairing`, it claims pairing jobs one at a time, at most
  `WORKER_LIMITS.combat` (5), checking the CPU budget before each claim, then coordinates again (review fix I1, re-review).
  Simulations still run only in an invocation without simple work.
- **`readStandings(client, league, cursor?)`** returns a `StandingsPage` of the latest season with rows: at most 50 rows,
  ranked by the view, `nextCursor` `season:rank` when a page is full, `archived: false`. The latest season is the highest
  `season_index` in `public.arena_standings`, read through its index (review fix M2). `inactive` means no human bout in
  that league and season; `rewardEligible` means at least `RULES_V1.seasons.minimumHumanBouts` (5) human bouts. A
  malformed cursor or league fails before any query. With no rows at all it returns `seasonId: ''` and no rows.

### SQL (all `SECURITY INVOKER`, empty `search_path`, backend-only execution)

| Object | Contract |
| --- | --- |
| `private.activity_executor_ready(text)` | True for training, rest, expedition and arena. |
| `private.prepare_activity_jobs(uuid)` | Arena: the battle's one simulation `arena:<battleId>` (on conflict do nothing; anchored to side 0, battle seed, frozen assignment, due S), this side's reveal `arena-reveal:<activity>` (activity seed, due S + 60 min, needs the simulation), its settlement (needs the simulation and the reveal) and its warm-up stage. |
| `private.accept_arena_result(uuid, jsonb)` | Called through `accept_job_result` from `complete_job`. Locks the job again, samples the clock after that lock, re-checks status, expiry, due time and dependencies. Simulation: validates and freezes the log and both outcomes in `private.arena_results`. Reveal: writes this side's bout stage. |
| `private.accept_job_result(uuid, jsonb)` | Dispatches Arena activities first; Task 9's expedition branch is unchanged. |
| `private.arena_settlement_failure(uuid)` | Null, or `rating-mismatch` / `arena-unsimulated` / `arena-unassigned`. Checks only this side's frozen rating against its own live row. |
| `private.arena_rewards(uuid)` | One side's credit from its frozen outcome: its own rating row (the clamped delta), the human win or loss counter for human bouts only, the rating cache, renown only (10/2 human, 3/0 NPC) and its return stage. `ratingDelta` is the applied change, 0 for NPC bouts. |
| `private.settle_rewards(uuid)` | Training and Rest unchanged; Arena calls `arena_rewards`. |
| `private.settle_activity_core(uuid, uuid, jsonb)` | Locks the side's rating row before the activity and job; the operator transition; a receipt and ledger row for Arena as for Expedition. |
| `private.pairing_input(...)` | Adds `historyFromSlot: target − 18`. |
| `private.project_character(uuid)` | Task 10's projector, plus this character's `public.arena_standings` rows. |
| `private.arena_results` | Primary key `battle_id` (FK assignments), unique `simulation_job_id` (FK jobs), the sanitized `log`, the `outcomes` array, `guard_frozen`; backend-only. |
| `public.arena_standings` | `(gladiator_id, league, season_index)`: name, rating, human wins and losses. Authenticated `SELECT` only; backend writes; cascades with its gladiator. |
| `public.arena_standing_reads` | Invoker view: the columns above plus `rank` (row number per league and season by rating, human wins, fewer human losses, id) and `promoted` (a higher league's row in the same season). |

Triggers: `project_changed_character` on `private.arena_ratings` and `projection_changed` on `public.arena_standings` (both
deferred, as Task 10's), and `guard_frozen` on `private.arena_results`.

## Decisions

1. **Settlement route: stored outcomes from acceptance** (the dispatch asked which). The simulation executor returns the log
   and both sides' `arenaOutcomes`; acceptance validates and freezes them; each side's settlement reads only its own frozen
   outcome. No prepared settlement RPC was needed, because an Arena credit depends on nothing outside the bout.
2. **Acceptance restates no domain formula** (header exception 2). It checks the exact result shape and the log against the
   frozen assignment: battle id, rules version, both participants' ids, `gladiatorId`, names and frozen fighter values
   (class, stance, attributes, health at full, armor, weapon damage, interval, silhouettes), and a winner that is a
   participant and agrees with the victory event. For each outcome it checks identity, result and success against the
   logged winner, zero XP, money, points, items and overflow, a safe-integer renown, the frozen rating before, after =
   before + delta, a non-negative winner delta and non-positive loser delta, and a zero NPC delta. It trusts the canonical
   TypeScript renown amounts and Elo, as preparation and pairing acceptance trust theirs.
3. **Stage writers** (header exception 4). The warm-up is due at S, so phase 8 (which runs at or after S) writes it with the
   activity. The bout is written by the side's own reveal job at S + 60 min. The zero-length return is written by the
   side's settlement in the crediting transaction, so "Results credited" never appears before the credit; this differs
   from the expedition pattern, where a reveal job writes the return stage. Only due stages exist, and RLS still checks
   database time. Both entrants' bout stages carry the same log and the same `endsAtMs` (Task 17 review Minor 2).
4. **Rating mismatch goes straight to operator state** (exception 6), with `last_failure='rating-mismatch'`, before any grant
   or checkpoint: retrying a deterministic inconsistency would only spend attempts. The operator repairs the row and calls
   `private.resume_operator_job`; the next boundary waits with `operator` meanwhile.
5. **Restated constants** (exception 5): `3600000` (minute 60) is checked by the versioned executor through the job's
   `revealAtMs`; `18` is now passed as `historyFromSlot` and checked; `604800000` (replay retention) is as in Task 9; the 504
   in 07's `season_index` restates `RULES_V1.seasons.durationSlots`.
6. **Standings are a projection** written by Task 10's projector (exception 7). The current season is the latest season with
   rows: the launch epoch stays private. Rank is computed by the view at read time, so the page cursor is `season:rank`; a
   rating that changes between two page reads can shift rows, and the panel de-duplicates by gladiator.
7. **Page detection.** The local Data API caps every response at `max_rows = 50` (`supabase/config.toml`), so a 51-row probe
   never sees more. As Task 10's `readRecent`, a full page of 50 yields a cursor; an exact multiple of 50 rows gives one
   empty last page, which the panel handles.
8. **Ledger.** An Arena credit writes an `activity-settlement` operation receipt and a `wallet_ledger` row
   (`reason 'arena'`, renown delta, money 0), as Expedition does for money. Renown 0 still writes its row.

## RED and GREEN (phase 2b)

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| Worker units | `npx vitest run tests/backend/worker.test.ts`: **7 failed / 23 passed**. The Arena input reached `planExpedition` (`TypeError` reading `build.rulesVersion`), unknown kinds failed as `execution-failed` instead of `unsupported-executor`, a narrower history passed, and an operator outcome counted as a conflict. The expedition dispatch case passed (unchanged behaviour). | 30/30 (151 with the arena domain file) |
| Read adapter | 3 failed: `readStandings is not a function` (2) and the live gateway `unavailable` (1). | 11/11 |
| Arena DB | The first attempt failed to load: `Cannot find package '@domain/rules-v1'` (the DB config had no aliases): a configuration fault, not RED. Then **17 failed / 7 passed**: every pairing failed at the new `historyFromSlot` check (2a SQL does not pass it) and Arena had no bout path. The 7 passing were the four 2a placement cases, the 2a frozen-job case and the two new pins described below. | After `08-arena-bouts.sql`: 21/24. Two failures were test errors (a lexicographic `sort()` of numbers); one was a real finding (decision 7). The Edge container was also recreated 3 s into that run. After the fixes, **24/24** with the container stable. |
| Live UI | `npx playwright test … arena-live --project=desktop` against the committed `page.tsx`: failed; the card read "The Arena card is not available in this build yet." | 2/2 (desktop and mobile) after the flip. A first green attempt failed only on an ambiguous text locator in the test. |

Written after the SQL, so proven by mutation instead: the bout-result rejection case (32 forged results per battle, for one
human and one NPC bout) and the three lock-wait regressions. The rejection case first failed on a test error: flipping
"win" was a no-op for an NPC bout the entrant had won. Two new cases pinned existing 2a behaviour through real paths and
passed on first run: banked Training points and real Task 8 acquisitions.

### Mutations

Each SQL mutation was applied to the verified local container as a modified copy of `08-arena-bouts.sql`, its owning test
was run, and the original source was reapplied; an md5 over every public and private function definition matched the
baseline after each one (`restored: true` throughout). The runner and its list are scratch files.

| # | Mutation | Owning test failed with |
| --- | --- | --- |
| MA | Settlement skips the frozen/live rating check | the mismatched side settled (`ok: true`) |
| MB | NPC bouts count as human wins | NPC win: counters 1/0 instead of 0/0 |
| MC | Each side also checks the opponent's live row | the second side went to `operator` |
| MD | Acceptance skips the frozen fighter comparison | "an altered fighter" accepted |
| ME | Acceptance skips the result/winner consistency | "results against the logged winner" accepted |
| MP | Acceptance allows an NPC rating change | "an NPC bout changing rating" accepted |
| MF | Bout label from participant 0, not the side | "Bout: defeat" where "Bout: victory" was due |
| MG | Return stage written at the minute-60 reveal | minute 60 already showed the return stage |
| MH | Bout reveal due at the slot start | a reveal was claimable at minute 59 |
| MI | Standings ranked by rating alone | wrong order among equal ratings |
| MJ | The projector writes no standings rows | no season, no rows |
| MK | Pairing history bound S − 17 | the pairing executor failed closed |
| ML | Settlement samples time before the rating-row lock | an expired lease settled after the proven wait (`ok: true`) |
| TM1 | `prepareActivityV1` ignores gear history | the acquisitions case stayed Bronze |
| TM2 | League from allocated instead of earned points | both the Training and the acquisitions cases |

ML is the meaningful RED the concurrency override asks for: with time sampled before the new rating-row wait, settlement
used pre-wait time; the correction samples after every lock.

## Tests (phase 2b, `tests/db/arena.test.ts` unless noted)

- **`settleNpcWin`** (plan Step 1): `{renown: 3, ratingDelta: 0}`, rating 1000 and counters 0/0, money 100, no XP and no
  training point, an `arena` ledger row, the stages `Warming up` / `Bout: victory` / `Results credited`, and the NPC logged as
  `npc:<entrant>` with a null `gladiatorId` from the frozen template. The battle seed is private and random and the starter
  build beats its fallback about nine times in ten (a scratch probe over 4,000 seeds measured 0.90–0.92), so the helper
  repeats fresh slots, up to eight, until a credited win; a loss on the way must credit 0 renown.
- **Human bout:** the job graph (one simulation anchored to side 0 with the battle seed; each side's reveal and settlement
  with its activity seed, due at minutes 60 and 80, with their dependencies); no opponent id or name in any owner,
  spectator, world or profile read before the reveal; the same log in both bout stages with opposite labels and equal end
  times; 10 and 2 renown, Elo +12/−12, counters 1/0 and 0/1, the rating cache and public profiles; exactly one success;
  owners read their summary, a spectator only the public completion.
- **The second side settles after the first moved its own row** (the first settlement moves only its own row).
- **Simultaneous settlement retries:** six concurrent calls (three per side): one grant per side, two replays each, one
  ledger row and one return stage each; a later retry replays.
- **Frozen/live mismatch:** `{ok:false, code:'operator'}`, `rating-mismatch` on the job and its attempt, nothing credited to
  that side, the other side settles, boundary 301 waits with `operator`, and after repair and resume the same job settles.
- **Malformed hook:** a stand-in hook applies the real Arena writes and returns negative renown; both settlements fail and
  roll back rating rows, counters, cache, renown, ledger, return stages and checkpoints; after restoring (verified), both
  settle once.
- **Bout-result rejection:** 32 forged results per battle are refused with nothing written; the valid one is frozen once,
  replays, and cannot be updated.
- **Lock waits:** `complete_job` (job row) and `settle_activity` (job row, and the new rating row) block while their lease is
  valid, resume after database expiry, and return `conflict` with no write.
- **Stages only when due** (rollback-only transaction under database time): minute 0 only the warm-up; minute 59 no reveal or
  settlement claimable and no opponent in stages or owner state; minute 60 both bout stages; minute 79 nothing credited;
  minute 80 both credits with their return stages and `replayExpiry` available until minute 80 + 7 days.
- **Banked points by real Training settlement:** 104 → 105 earned stays Bronze after the settlement and becomes Silver only at
  the next boundary, keeping the Bronze row.
- **Real Task 8 acquisitions and a real Task 6 respec** at the current slot, then the next boundary in a rollback-only
  transaction: never-equipped light boots, bought and then sold, keep history 30 (Silver); a bound renown sword scores 30.4
  with its arena bonus and cannot be sold (Silver); a second common sword adds nothing (Bronze); a paid respec lowering
  Strength keeps 105 earned points (Silver). Every cache was still Bronze before the boundary.
- **Standings:** 52 Bronze rows of season 1 plus an older season-0 row and a promoted character: two pages (50 + 2) in exact
  spec order, the flags, the Silver and empty Champion pages, only public columns, anonymous denial, cursor rejection, and a
  rating change republished with a revision bump.
- **Access denial:** the five private Arena tables (now with `arena_results`), the standings table and view privileges, 17
  private functions including `pairing_input`, client denial of `settle_activity`, and no seed, simulation input or private
  outcome in any client read.
- **Unit:** the Arena executor (log and outcomes, NPC identity and name, frozen silhouette order kept, fail-closed inputs),
  the discriminator (five unknown inputs → `unsupported-executor`), expedition dispatch unchanged, the history bound and the
  operator outcome; the pairing claim after a spent simple budget, and none once the CPU budget is spent (review fix I1);
  the CPU check before each pairing claim, the five-job cap, and no claim when the final coordination waits on anything
  but pairing (re-review);
  the standings read (pages, cursor, flags, malformed input, empty world, the probe on `arena_standings`) and the live
  gateway read.
- **Timing at the one-minute cron cadence** (review fix I1): "times consecutive 50-entrant Arena boundaries at the one-minute
  cron cadence: steady-state publication within 120 s once the rolling dispatch window clears, within 180 s while it holds
  the previous tick, every bout before minute 60". See [Timing](#timing-50-entrants-one-minute-cron-cadence).
- **Browser** (`tests/browser/arena-live.spec.ts`, development only): a signed-in live owner with an Arena activity opens
  "Your arena bout" and sees "Warming up" from the live timeline read; the Standings tab shows live rows and the owner's
  combat strength from the live profile read.

### Affected existing tests

- `arena.test.ts` (2a): four cases expected phase 8 `integration` after pairing; Arena now publishes, so they expect phase 9
  `complete` (and, for the pairing-job case, the debit and one simulation job). The 2a 50-entrant pairing measurement is
  replaced by the timing case below, keeping its pairing assertions.
- `activities.test.ts`, "starts expeditions and Arena entrants once their executors exist…": the Arena entrant now starts
  (stamina 79, processed 300) instead of waiting at phase 8.
- `worker.test.ts`: the existing pairing inputs gain `historyFromSlot`.
- Review fix M2: `reads.test.ts` and `projection-gateway.test.ts` expected the probe on `/rest/v1/arena_standing_reads`;
  they now expect `/rest/v1/arena_standings`, then the view. The fake backend of `arena-live.spec.ts` answered the probe only
  on the view path, so the first browser run after M2 failed both of its cases (no standings rows); it now answers the new
  path, and the suite was rerun.

## Timing (50 entrants, one-minute cron cadence)

**Correction (review I1).** The first phase 2b measurement called `private.cron_tick()` once a second, and this report then
said that with cron's one-minute tick "the simulations likewise start at the next tick, about 60 s after the boundary".
That extrapolation was wrong. Production cron runs once a minute, dispatch allows at most five invocations per rolling
minute, and an invocation claims simulations only when it claimed no simple work. Measured at the real cadence (below), the
committed 2b worker published a steady-state boundary only at the third tick, about 121 s after the cutoff.

**Method.** The test is "times consecutive 50-entrant Arena boundaries at the one-minute cron cadence…" in
`tests/db/arena.test.ts`.
- It runs three consecutive slots P, P + 1 and P + 2 with the same 50 Arena entrants (40 Bronze, 10 Silver: 25 battles and
  2 pairing jobs per slot). Everything goes through the real `private.cron_tick()` and the real private Edge worker,
  reached through pg_net.
- P is a cold first boundary. P + 1 and P + 2 are steady state: the previous slot's 50 settlements fall due at their
  cutoff and must finish before phase 1 continues, under the same budget.
- Database time is a test-only stand-in, restored and verified in `finally`. Each tick happens at an exact database time:
  the clock stands still while `cron_tick()` runs, so its dispatch is sampled exactly then. The clock then runs on in real
  time while the dispatched invocations work. The next tick follows once every invocation has answered, which the minute
  between real ticks always allows. No other wall-clock time is spent: a run takes about 12 s.
- The scheduler is enabled only inside each tick's own transaction, so the real pg_cron run stays inert.
- **Two window cases.** Dispatch counts the invocations sent in the last 60 000 ms (`dispatched_at_ms > now − 60000`).
  - P + 1 ticks exactly 60 000 ms apart, so each tick sees a cleared window.
  - P + 2 ticks 59 999 ms apart, so each tick still counts the previous tick's invocations.
  - Which case a real minute sees depends on sub-second cron start and coordination timing; neither is guaranteed.
- All times below are database time from the slot's cutoff (`slot × 4 800 000`). This is the local stack, not hosted
  evidence (Task 23).

**After the fix.** The ranges cover seven passing runs, each with the Edge start time unchanged:
- four of `337f38d` (three single-case runs plus the full DB suite); a fifth single-case run passed, but its log kept no
  measurement;
- three of the re-review change `cf325d1`, which claims the pairing jobs one at a time (two single-case runs plus the full
  DB suite). One further `cf325d1` full-suite run passed but is not counted, because the Edge container was recreated as it
  ended.

The re-review's own run of `337f38d` measured 0.41, 0.49 and 0.50 s for cold P's preparation, pairing and publication. That
run is included in the cold-P ranges only. The cold first boundary varies most; the cause of its spread was not investigated.

| Boundary | Previous slot settled | Preparations done | Pairing done | Published | All 25 bouts simulated | Reveal margin |
| --- | --- | --- | --- | --- | --- | --- |
| P, cold | — | 0.11–0.41 s | 0.19–0.49 s | 0.20–0.50 s | 60.08–60.09 s | 3 540 s |
| P + 1, steady, window cleared | 1.04–1.15 s | 61.00–61.09 s | 61.06–61.15 s | **61.07–61.16 s** | 120.95–121.05 s | 3 479 s |
| P + 2, steady, window held | 1.09–1.14 s | 120.96–121.02 s | 121.02–121.08 s | **121.02–121.08 s** | 240.96–241.04 s | 3 359 s |

The dispatch log was the same in every run. Each invocation is listed by the jobs it ran.

| Boundary | Tick | Claimable simple / combat | Dispatched | Invocations |
| --- | --- | --- | --- | --- |
| P | 0 s | 50 / 0 | 3 | prepare 10; prepare 20; prepare 20 + pair 2 |
| P | 60 s | 0 / 25 | 5 | simulation 5, five times |
| P + 1 | 0 s | 50 / 0 | 3 | settlement 10; settlement 20; settlement 20 |
| P + 1 | 60 s | 50 / 0 | 3 | prepare 10; prepare 20; prepare 20 + pair 2 |
| P + 1 | 120 s | 0 / 25 | 5 | simulation 5, five times |
| P + 2 | 0 s | 50 / 0 | 3 | settlement 10; settlement 20; settlement 20 |
| P + 2 | 59.999 s | 50 / 0 | 2 (the window holds 3) | prepare 20; prepare 20 |
| P + 2 | 119.998 s | 10 / 0 | 1 | prepare 10 + pair 2 |
| P + 2 | 179.997 s | 0 / 25 | 4 | simulation 5, four times |
| P + 2 | 239.996 s | 0 / 5 | 1 | simulation 5 |

Every invocation answered HTTP 200 with no failure, conflict, unrecorded failure or deferral. The settlement, preparation,
pairing, reveal and simulation counts match the three slots exactly.

**Before the fix.** The same test against the committed 2b worker (`.task16-fix-red.log`, Edge stable) gave:

| Boundary | Published | Bouts simulated |
| --- | --- | --- |
| P | 60.05 s | 121.07 s |
| P + 1 | **120.95 s** (failed `< 120 000`) | 180.97 s |
| P + 2 | 121.10 s | 240.97 s |

In every boundary the 10-job invocation finished first. The invocation that completed the last preparation had spent its
20 simple jobs. The pairing its own coordination released therefore waited a whole tick for an invocation of its own
("pair 2").

**The fix** is TypeScript only (no SQL, no migration). After its simple loop, `runWorker` claims the pairing jobs its own
latest coordination released (`wait: 'pairing'`). Since the re-review (`cf325d1`) it claims them one at a time, at most
`WORKER_LIMITS.combat` (5), and checks the CPU budget before each claim. A spent budget therefore leaves the next pairing
job pending for another invocation, instead of leased and deferred until its lease expires. A slot has at most one pairing
job per league, so four.

**Batch limits.** The `WORKER_LIMITS` constants and the dispatch budget are unchanged. An invocation can nevertheless now
run up to 25 simple-kind jobs: 20 in its simple loop, plus up to 5 pairing jobs after it. Spec §10.4 proposes "five combat
jobs or 20 simple reward/state jobs per invocation". The controller accepted this interpretation on 2026-10-14, because
pairing jobs are cheap, the extra claim is bounded at 5, and it runs only right after the invocation's own coordination
released them.

**The held-window case.** *Correction (re-review).* This section first said the boundary needs at least 102 simple jobs
while two ticks can run only 100, "however the worker orders the work". That counted the 2 pairing jobs against the 20-job
simple cap, which the fix had moved outside it. The `337f38d` commit message keeps the old wording; this section replaces
it.
- With the fix, a steady-state 50-entrant Arena boundary must run 100 settlement and preparation jobs before it publishes:
  50 settlements, then 50 preparations. Its pairing jobs (one per league, 2 here) run outside the simple cap.
- Only two ticks fall before 120 s. When the second tick's dispatch is sampled less than 60 000 ms after the first one's,
  the window still counts the first tick's 3 invocations. Both ticks together then dispatch 5 invocations of 20 simple
  jobs: exactly the 100 the boundary needs, with no slack.
- It still misses at 50 because the global settlement barrier fragments the cutoff tick. That tick's 3 invocations have 60
  slots for 50 settlements. The spare 10 cannot run preparations: preparation jobs exist only after the last settlement
  commits, and by then the 10-job invocation has exited. The second tick's 2 invocations run 40 of the 50 preparations, so
  publication falls to the third tick (measured 121.0–121.1 s).
- Derived, not measured: with the current worker, a steady-state boundary like this one (a settlement and a preparation
  per character) misses the held case above 40 characters. Up to 40, the cutoff tick needs at most 2 invocations, which
  leaves the next tick 3.
- Derived, not measured: a worker-side change could in principle reach about 61 s at 50 characters, with zero slack. For
  example, the invocation with spare budget could wait a bounded time for the barrier. Only above 50 characters (2N > 100
  for N characters) is the held case arithmetically impossible within these limits.
- Meeting 120 s robustly in this case therefore needs a budget, batch-limit or cadence decision. None is made here (see
  Remaining gates, Task 23).

The bouts need only be simulated before the minute-60 reveal. They are, with a measured margin of at least 3 359 s (P + 2).

## Review fixes (I1, M1, M2)

| Finding | Fix | Evidence |
| --- | --- | --- |
| **I1** (Important): the 50-entrant timing test ticked cron once a second, and the report's one-minute extrapolation was wrong. | The test runs at the one-minute cadence with steady-state settlement first, in both window cases (above). `runWorker` claims the pairing that its own coordination released after its simple loop. The test name and this report now state what is measured. | Unit RED, then GREEN: the new case failed with claims `[settlement 20, prepare 20]` and no pairing claim; 32/32 after the fix, and it fails again against the old `runWorker` (stashed). DB RED: `expected 120950 to be less than 120000`; then GREEN in four measured runs and a fifth unmeasured one, each with the Edge start time unchanged. |
| **M1** (Minor): the release operator check named `pair` or `simulation` in `migrations.md` and `pair`, `prepare` or `simulation` here. | Both now name `prepare`, `pair` and `simulation`. `migrations.md` says why each is checked: M09 rejects an older worker's preparations, the new worker fails a pairing input without `historyFromSlot`, and an older worker cannot simulate. The 2a report keeps its own M09-only check (`prepare`). | Text. |
| **M2** (Minor): the latest-season probe read the ranked view, which evaluates its window function and the `promoted` check over every row. | `readStandings` reads `public.arena_standings` (`select season_index order by season_index desc limit 1`), whose index `arena_standings_rank_idx` leads with `season_index`. The ranked page still reads the view. | Unit RED: the probe read `/rest/v1/arena_standing_reads`; GREEN 10/10. The DB standings case still reads season 1 as the latest beside an older season-0 row, and passed in the 137/137 run. |

The new CPU-budget unit case ("claims no pairing beyond the simple budget once the compute budget is spent") passes both
before and after the fix; it is a guard, not a RED test.

## Re-review fixes

A scoped re-review of the timing fix (`337f38d`, `a1c6732`) found one Important and four Minor or Nit items. Code and tests
are in **`cf325d1`**; this update holds the report changes.

| Finding | Fix | Evidence |
| --- | --- | --- |
| **Important**: the held-window rationale counted the 2 pairing jobs against the 20-job simple cap. | Restated under [Timing](#timing-50-entrants-one-minute-cron-cadence): 100 settlement and preparation jobs, exactly 5 × 20; the miss at 50 comes from the settlement barrier; a zero-slack worker change could in principle reach about 61 s at 50; only above 50 characters is the case impossible. The status, Task 23 and HANDOFF notes follow. The `337f38d` message is unchanged. | Text, checked against the dispatch log and `private.dispatch_workers()`. |
| **Minor**: assess "count the budget per scheduled minute". | Assessed under Task 23 below. | Text, derived; not measured. |
| **Minor**: batch-limit wording. | Stated plainly under "Batch limits": up to 25 simple-kind jobs per invocation, and the controller's acceptance on 2026-10-14. | Text. |
| **Minor**: claiming 5 pairing jobs at once after the simple loop could strand a leased pairing job until its lease expired once the CPU budget was spent. | `runWorker` claims pairing jobs one at a time, at most 5, and checks the CPU budget before each claim. | Unit RED: 3 failed / 32 passed. The new CPU case saw `['pair', 5]` where one `['pair', 1]` was due; the cap case saw one claim of 5; the updated release case expected single claims. GREEN 35/35. |
| **Minor**: no negative test for the post-loop claim. | New case: nothing is claimed after the loop while the final coordination waits on `preparation`, although a pairing and a simulation job are claimable. | A guard: it passes before and after the change. |
| **Nit**: cold-P times given as single values. | Ranges 0.11–0.41, 0.19–0.49 and 0.20–0.50 s, including the re-review's 0.41/0.49/0.50 s run. | Three new measured runs (above). |

The DB timing case's held-window comment, which made the same miscount, was corrected in `cf325d1`; its assertions are
unchanged.

## Migration

- **Iteration.** `08-arena-bouts.sql` was applied through the documented `docker exec -i supabase_db_Cloudiator psql`
  fallback after checking the container's `com.supabase.cli.project` label. Lint found a shadowed loop variable in
  `accept_arena_result`; the declaration was removed and the source reapplied. Then lint was empty and advisors showed four
  INFO unused-index notices, all existing.
- **Generation.** `npx supabase db pull arena_bouts --local --schema public,private --yes` (CLI 2.120.0, engine `migra`)
  wrote `20261014131209_arena_bouts.sql`. It re-emits no unchanged function: 3 new and 7 changed functions.
- **Completion** (AGENTS.md), normalized to CRLF like the other migrations: the view's `security_invoker=true` and its
  grants; source-equivalent revokes before the table grants; the function revoke/grant pair; the standings backfill
  `select public.refresh_projections();`; a provenance header and `notify pgrst`.
- **Replay.** `npx supabase db reset --local --no-seed --yes` replayed M01–M10 with no source applied afterwards.
- **Comparison.** The sanitized schema fingerprint (667 entries, 687 lines: function definition hashes, search paths,
  security, volatility and ACLs; table and view ACLs, RLS, options and view definitions; policies, triggers, constraints,
  columns, indexes, the cron job and seed rows) matched the source exactly, and was identical again after the tests.
- **Tests on the replay:** **137/137** in seven files with the Edge container stable (identity 11, planning 15, activities 36,
  shops 21, expeditions 20, projections 6, Arena 28). Lint empty; advisors four INFO notices, none on the new tables;
  `migration list --local` shows M01–M10 applied.

## Final commands (in `verification-gates.md` order)

| Command | Result |
| --- | --- |
| `npm test` | **883 passed**, 36 files (872 + 11). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, 2 Deno runtime tests passed. |
| `npm run test:db` on the M01–M10 replay | **137/137**, Edge start time unchanged across the run. Two earlier replay runs also passed 137/137 but had an Edge recreation during the run, so they are not counted. After a PC reboot and stack restart, a further run passed **137/137**, Edge stable. |
| `node assets/source/build-assets.mjs --check` | Up to date (28 files). |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, 91 assets, no forbidden backend material. |
| `npx playwright test -c node_modules/.cache/pw-claude.config.mjs` (port 3200) | **260 passed, 8 skipped** (258 + the two live-panel cases). No dev server was left on 3200. |
| Isolated production gate: `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, `npm run verify:static -- .next/browser-test`, `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test` with the private config | Build and scan clean (5 routes, 91 assets); **14 passed, 254 skipped** by design. |
| `git diff --check`, `git diff --cached --check` | Clean. |

### Review-fix gate (before committing `337f38d`)

No SQL changed, so there is no new migration or replay. The local stack stayed at M01–M10.

| Command | Result |
| --- | --- |
| `npm test` | **885 passed**, 36 files (883 + the 2 new worker cases). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of both functions, 2 Deno runtime tests passed. |
| `npm run test:db` | **137/137** in seven files (Arena still 28: the timing case was replaced). Edge start time unchanged across the run. |
| `node assets/source/build-assets.mjs --check` | Up to date (28 files). |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, 91 assets, no forbidden backend material. |
| Development browser suite (`pw-claude.config.mjs`, port 3200) | First run: 258 passed, 2 failed, 8 skipped. The failures were both `arena-live` cases, whose fake backend did not answer the M2 probe path. After that spec was updated, `tsc` and the two cases passed, and the full suite was rerun: **260 passed, 8 skipped**. No dev server was left on 3200. |
| Isolated production gate (same commands as above) | Build and scan clean (5 routes, 91 assets); **14 passed, 254 skipped** by design. |
| `git diff --check`, `git diff --cached --check` | Clean. |

### Re-review gate (before committing `cf325d1`)

No SQL changed, so there is no new migration or replay. The local stack stayed at M01–M10, and its Edge runtime served
this worktree; the served `jobs.ts` was checked for the new code before the DB runs.

| Command | Result |
| --- | --- |
| `npm test` | **888 passed**, 36 files (885 + the 3 new worker cases). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of both functions, 2 Deno runtime tests passed. |
| `npm run test:db` | **137/137** in seven files, Edge start time unchanged across the run. An earlier run also passed 137/137, but the Edge container was recreated as it ended, so it is discarded. Two further single-case timing runs passed, Edge stable. |
| `node assets/source/build-assets.mjs --check` | Up to date (28 files). |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, 91 assets, no forbidden backend material. |
| Development browser suite (`pw-claude.config.mjs`, port 3200) | **260 passed, 8 skipped**. No dev server was left on 3200. |
| `git diff --check`, `git diff --cached --check` | Clean. |

The isolated production gate was not rerun: the change is to the worker only, and the controller's gate list for the
re-review did not include it.

## Environment notes

- **Edge recreations.** Three DB runs saw the Edge container recreated a few seconds after they started. The background
  `functions serve` log showed `File change detected … (WRITE)` for Edge source files (`commands.ts`, `http.ts`, `types.ts`,
  and earlier `deno.json`, `deno.lock`) whose content `git status` showed unchanged, while host tools (vitest, `tsc`, `deno
  check`) were reading them; it then restarted the runtime. This is an observation, not a confirmed cause or a tested fix.
  Every counted run had an unchanged start time.
- Git Bash `sed -i` rewrote `tests/db/arena.test.ts` to LF once; CRLF was restored with Node before anything was staged.
- A JavaScript `String.replace` used to splice a test block treated a dollar-backtick sequence in the inserted text as a
  replacement pattern; the splice failed its own uniqueness check and was redone with a replacer function before anything
  was written.
- No package or tool was downloaded. Scratch probes ran on the installed Node 22.19 from the session scratch directory.
- **Review-fix runs.** The Edge container was recreated twice between DB runs, and never during a counted run. The first
  recreation followed a host `tsc` run. The second followed the expected hot reload after `jobs.ts` changed; the served
  file was checked for the new code before the GREEN runs. Vitest 5 shows `console.info` output only for failing tests,
  so the measured runs used `--silent=false`.
- **Re-review runs.** The expected hot reload followed the `jobs.ts` edit, before any DB run. The first full DB run passed,
  but `docker inspect` right after it found no running container, and a few seconds later a new start time about 1 s
  after the run's last output. Nothing else ran in the worktree at the time; the cause is not known. That run was
  discarded under the database-test rule and the suite was rerun, Edge stable.

## Remaining gates

- **Task 19 (tournaments):** `private.boundary_pair` still returns `integration` for tournament entrants. `pairing_input`
  reads only regular `pair` assignments as history; Task 19 phase 2 must add its human tournament bouts, one row per bout.
  Tournament settlement can reuse `arena_rewards`' pattern, but bouts of a bracket apply ratings in round order.
- **Task 21 (seasons):** season close, archives and placement rewards on the same epoch; `archived: true` standings pages
  and the real reward-eligibility rule (highest league with qualifying participation). `rewardEligible` here only marks five
  human bouts in that league.
- **Task 22 (retention):** prune `private.arena_results` before its assignment and its simulation job, assignment sides and
  stages before their activities, and assignments before their pairing jobs (foreign keys). Detailed logs in stages and
  results follow the seven-day replay rule; `arena_standings` follows its gladiator.
- **Task 23 (load):** hosted timing at 50 characters, and a decision on the measured bound. The bound is local, at the
  one-minute cadence (see [Timing](#timing-50-entrants-one-minute-cron-cadence)):
  - A steady-state 50-entrant Arena boundary publishes at **61.07–61.16 s** when the rolling dispatch window has cleared.
  - It publishes at **121.02–121.08 s** when the window still counts the previous tick. Which case occurs depends on
    sub-second cron start and coordination timing.
  - The second case misses the 120 s target. Before 120 s it needs 100 settlement and preparation jobs, exactly the 5 × 20
    the rolling window allows. The settlement barrier leaves 10 of the cutoff tick's 60 slots unusable, so the current
    worker runs 90 of them by then (50 settlements, 40 preparations). The pairing jobs run outside the simple cap.
  - Derived, not measured: with the current worker this applies above 40 characters. A worker change, for example a
    bounded wait for the barrier in the invocation with spare budget, could in principle reach about 61 s at 50 with zero
    slack. Above 50 characters (2N > 100) no worker change can, within these limits.
  - Bouts finish by 241 s, with at least 3 359 s left before the minute-60 reveal. A tick simulates at most 25 bouts (five
    invocations of five), so a slot with more battles needs more ticks.
  - The options are recorded, not chosen:
    - **Count the budget per scheduled minute** instead of per rolling 60 s. Assessment (derived, not measured):
      - It would fix the held case for up to 100 characters: the tick after the cutoff tick falls in the next calendar
        minute and can dispatch up to 5 invocations.
      - It does not raise the monthly ceiling. Each cron run still dispatches at most 5 worker invocations, about 216 000
        in a 30-day month (5 × 1 440 × 30), under the spec's 300 000 internal budget and the 500 000 free-plan limit.
      - It matches spec §10.4's "dispatch up to five worker invocations" at each one-minute run.
      - Its costs: bursts of up to 10 invocations within 60 s across a minute edge, and a new migration for
        `private.dispatch_workers()`.
      - The current timing test cannot verify it. Its held schedule (cutoff + 0 ms and + 59 999 ms) puts both ticks in
        one calendar minute, because the cutoff is minute-aligned. Verifying it needs realistic offsets, for example
        + 300 ms and + 60 250 ms: 59 950 ms apart, so held under the rolling window but in separate calendar minutes.
      - Task 23 should measure the hosted `dispatch_log` spacing. Dispatch time is sampled with `clock_timestamp()` after
        `coordinate_work()` in the same tick. A cutoff tick whose coordination takes longer than the next tick's therefore
        leaves the window held, so the held case may be common.
    - Raise the simple batch limit after measuring CPU (spec §10.4 now allows only lowering it).
    - Run fewer simple jobs per boundary.
    - A sub-minute cron cadence under the same rolling budget (the spec says every minute).
  - Hosted pg_net latency and Edge cold starts add to each tick's processing time; locally that is about 1 s per wave.
- **Task 24 (deployment):** set `private.season_epoch` at launch, no later than the first boundary with members the
  coordinator will process (`select min(processed_slot_index) from public.gladiators;`). Ship M09, M10 and the worker in
  one release step, then check that no `prepare`, `pair` or `simulation` job is in operator state. M09 rejects an older
  worker's preparations, the new worker fails a pairing input without `historyFromSlot` closed, and an older worker cannot
  simulate Arena bouts. Store the Vault
  secrets, enable the scheduler and prove hosted dispatch, as Task 7 recorded.

## Open items and concerns

- **TDD deviations:** the bout-result rejection case and the three lock-wait regressions were written after the SQL; their
  power is shown by mutations MD, ME, MP and ML. The Training and acquisition cases pin 2a behaviour (TM1, TM2).
- **NPC display name** "<League> Sentinel" is a presentation choice made here; views identify the NPC by its null
  `gladiatorId`.
- **Historical slots** settle with `replayExpiry: expired` (seven days after the activity ended), as Task 9 does.
- **Empty world standings** report `seasonId: ''` until any rating row exists, because the epoch is private.
- **Balance:** the weakest entrant of a stable odd league keeps getting the NPC (Avi's option A, phase 1).
- **Deferred Minors carried:** Task 17 review Minor 1 (labels on a clamped target with real logs) and Task 10's initial
  clock-offset bias; Task 17's two-reads-per-human-pair Minor (M7) could use a pairing hint later.
- **Timing limit (review I1, corrected in the re-review), recorded for Task 23.** When the rolling dispatch window still
  counts the previous tick, the current worker publishes a steady-state boundary of more than 40 characters at about
  121 s, which misses the 120 s target. At 50 the limits leave zero slack; above 50 no worker change can meet it. The
  budget was not changed. Details are under Timing and Task 23.
- **Pairing claim scope.** The claim after the simple loop raises an invocation's maximum from 20 to 25 simple-kind jobs
  (20 simple plus up to 5 pairing), while spec §10.4 proposes five combat or 20 simple jobs. The controller accepted this
  on 2026-10-14 (see "Batch limits"). It fires only when the invocation's own latest coordination reports
  `wait: 'pairing'`, and claims one pairing job at a time with the CPU budget checked before each claim.
- **Coordinator busy race (pre-existing, not observed).** Two invocations can finish a barrier's last jobs at nearly the
  same moment. If their final `coordinate_work()` calls overlap, the later one returns `busy`, and the earlier one may not
  have seen the other's last completion. The released work would then wait for the next tick. None of the measured runs
  showed it.

### HANDOFF-ready note (for the controller)

> Task 16 review fixes `337f38d` (I1, M1, M2). The real one-minute cadence was measured locally with three consecutive
> 50-entrant Arena slots, steady state included.
> - Steady-state publication is at **61.1 s** when the rolling dispatch window has cleared, and at **121.0–121.1 s** when it
>   still counts the previous tick.
> - In the second case the boundary needs 100 settlement and preparation jobs before 120 s, exactly the 5 × 20 the rolling
>   window allows. The settlement barrier leaves 10 of the cutoff tick's slots unusable, so the current worker misses
>   above 40 characters. A zero-slack worker change could in principle reach about 61 s at 50; above 50 no worker change can.
> - Re-review fix `cf325d1`: pairing jobs are claimed one at a time with the CPU budget checked before each claim. An
>   invocation can run up to 25 simple-kind jobs (20 simple plus 5 pairing); the controller accepted this on 2026-10-14.
> - The budget is unchanged. Task 23 must choose between budget accounting, batch limit, job count and cadence, and then
>   measure hosted latency and `dispatch_log` spacing. Per-minute accounting would fix the held case up to 100
>   characters without raising the monthly ceiling; it needs realistic tick offsets to test.
> - Bouts finish by 241 s, at least 3 359 s before the minute-60 reveal.
> - Release check (Task 24): no `prepare`, `pair` or `simulation` job in operator state.

## Skill upkeep

No skill change is applied. The phase 2b observation (`supabase functions serve` restarted the Edge runtime on `WRITE`
events for unchanged Edge sources during host-side reads) is now covered by Avi's approved database-test rule in
`verification-gates.md` (`61af251`). The review and re-review fixes need no further skill change: the discarded re-review
DB run was handled exactly as that rule says.
