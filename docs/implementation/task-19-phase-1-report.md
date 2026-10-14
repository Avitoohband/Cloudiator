# Task 19 phase 1 report: pure tournament domain

Status: **DONE_WITH_CONCERNS**. The pure tournament module and its unit tests are complete and verified. An independent review found specification Pass and code quality Pass, ready with fixes. Those fixes are applied and verified below. Phase 2 (database, boundary hook, per-bout jobs, settlement, opt-in command, projections, DB tests) is still to do. Its plan is at the end. It now starts from Task 16's corrected phase 2 design and includes the reviewer's rulings.

The concerns are two open points:
- A public-contract question for Codex and Task 20; see "Public projection". The controller raises it.
- A new, unruled recommendation in phase 2 item 4: give the public bracket placement its own one-way seed.

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19`.
- Task base: **`61b3e7b`**, the head of `claude/task-16` at the time. Branch start: `427158e`, the controller brief.
- Source commit: **`abf7cb9`**, `feat: add pure tournament bracket and reward rules`. Report: `ef73c82`.
- **`8d72abb`**: the controller merged the reviewed Task 16 phase 1 branch, which brought in `arena.ts` with Task 16's review fixes.
- Review-fix commit: **`98aeb07`**, `fix: apply Task 19 phase 1 review findings`.
- Scope: [task-19-claude-dispatch.md](task-19-claude-dispatch.md) and [task-19-brief-base.md](task-19-brief-base.md).
- Not done here, by instruction:
  - no Supabase, Docker or database commands, browser tests or dev server;
  - no push or merge, no edits to `HANDOFF.md`, no subagents.
  - The other checkouts (`Cloudiator`, `Cloudiator-replay`, `Cloudiator-arena`) were not touched.
  - `arena.ts` gained additive exports only (review fix M6).

## Files

| Path | Change |
| --- | --- |
| `supabase/functions/_shared/domain/tournament.ts` | New in `abf7cb9`: all phase 1 functions and the types they return. Review fixes in `98aeb07`. |
| `supabase/functions/_shared/domain/arena.ts` | `98aeb07` only: additive exports of `RETAINED_RULES`, `LEAGUES`, `copyFighter` and `nonEmpty`, unchanged in behavior (`arena.test.ts` 121/121). |
| `supabase/functions/_shared/domain/rules-v1.ts` | One additive constant, in `abf7cb9`: `tournament.durationMs: 4_800_000`. |
| `tests/domain/tournament.test.ts` | New. 166 cases: 157 in `abf7cb9`, net +9 from the review fixes. |

Task 2 had already versioned these tournament rules: the days (`utcWeekdays [3, 6]`), the time (`hourUtc 17`, `minuteUtc 20`), `minimumEntrants 2` and the placement bonuses. The only missing spec value was the 80-minute span used by the reveal formula and settlement. It is now `durationMs`, and a test pins it to the slot length. `SlotWindow` is Task 2's `types.ts` definition, re-exported from `tournament.ts` rather than redefined.

Nothing is reimplemented here:
- `arena.ts` supplies ratings (`applyRatingDelta`), the retained rules registry, the league order and the fighter copy.
- `clock.ts` supplies slots (`slotAt`), and `random.ts` supplies the placement order (`seededRandom`).
- Bouts run on the canonical `simulateBattle`.

## Interfaces

All functions are pure and deterministic. A malformed input throws `RangeError`. Outputs are frozen copies; caller objects are never frozen or kept.

Rules come from Arena's retained registry, `RETAINED_RULES`, which holds only `v1`. An unknown version therefore fails closed. The rules for each function come from one place:
- Functions that receive entrants take one shared rules version from the entrants' fighters and reject mixed versions.
- Graph functions use the version the graph records.
- `isTournamentSlot` receives no fighter, so it takes an optional `rules` argument that defaults to v1, as Task 16 does for such functions. The partition and the bracket pass their entrants' rules to it.
- The partition falls back to v1 only when it has no candidates.

| Export | Contract |
| --- | --- |
| `isTournamentSlot(slot: SlotWindow, rules = RULES_V1): boolean` | True for the canonical slot that starts on a tournament day at the tournament time of `rules` (v1: Wednesday or Saturday, 17:20 UTC). It uses epoch-day arithmetic on `slot.startMs` (`(floor(ms / day) + 4) % 7`, minute of day 1040), never `Date` or local time. The slot must equal `slotAt(slot.startMs)` in index, phase, start and end. Every 17:20 UTC start is an afternoon, because a day holds 18 slots. |
| `partitionTournament(slot, candidates): TournamentPartition` | The eligibility helper. Details under "Eligibility" below. |
| `buildBracket(entries: ArenaEntrant[], seed: Seed): TournamentGraph` | Seeded single elimination; details under "Bracket" below. Requires at least the rules' minimum entrants (v1: two), from one league, slot, season and rules version, on a tournament slot under those rules. |
| `readyBouts(graph): BoutJob[]` | One job per unresolved fought bout whose two entrants are known: round 1, or both parents resolved. Ordered by round, then position. Byes never appear. Jobs carry no seed. |
| `runBout(job, seed, names?): BattleLog` | Runs `simulateBattle` under the job's retained rules and `seed`. `seed` is the bout's own private seed, which phase 2 supplies from storage; the domain derives no bout seed (review fix M2). Participant ids are gladiator ids, with no `startingHealth`, so both start at full health. `names` only labels the log (default `Gladiator`, as expeditions do); a test shows it never changes the events or the winner. |
| `recordBout(graph, boutId, log): TournamentGraph` | Fenced, copy-on-write result recording; details under "Results" below. |
| `applyTournamentRatings(graph): TournamentRatings` | For a completed graph: Elo under the graph's retained rules, in round order, from the ratings left by earlier rounds. Byes are never rated. Returns `bouts` (`RatedBout`: before and after for both sides) and per-entry `ratings` (`before`, `after`, `delta`, after clamping). Fails closed if a player appears twice in a round. |
| `placementGrants(graph): RewardGrant[]` | For a completed graph: one grant per entrant, ordered by place, then rank. |
| `tournamentOutcomes(graph): TournamentOutcome[]` | For a completed graph, one settlement per entry, in rank order. Fields below the table. |

Each `TournamentOutcome` holds:
- `place`, plus `result` and `success`: `victory` and true for the winner only.
- The entrant's `bouts`, as `EntrantBout` values: `kind` (`'bye' | 'win' | 'loss'`), `renown` and `ratingDelta`.
- `wins` and `losses`, counting fought human bouts only, never byes (review fix M5).
- Its `placement` grant.
- `rewards: CreditedRewards`: placement money; fight renown plus placement renown. XP, points, items and overflow are all 0.
- The round-ordered `ratingBefore`, `ratingAfter` and `ratingDelta`.

### Types (defined beside the functions)

- `OptInRevision` = `{enabled, receivedAtMs}`; `TournamentCandidate` = `{entrant: ArenaEntrant, choice: ActivityChoice, stamina, costs: {arena, tournament}, optIn: OptInRevision[]}`.
- `TournamentRoute` = `{gladiatorId, activityId, league, route: 'tournament'|'arena'|'rest'|'other', reason, staminaDebit}`.
- `TournamentPartition` = `{slotIndex, tournamentSlot, brackets: {league, entrants}[], arena: ArenaEntrant[], routes}`.
- `TournamentGraph` = `{id, seasonId, league, slotIndex, rulesVersion, startsAtMs, settlesAtMs, size, rounds, revealAtMs[], entries: TournamentEntry[], bouts: BracketBout[]}`.
- `TournamentEntry` = `{gladiatorId, activityId, rating, fighter, rank}`.
- `BracketBout` = `{id, battleId, round, position, parentBoutIds, placed, bye, revealAtMs, result}`, with no seed.
- `BoutResult` = `{winnerId, loserId, log}`; a bye has `loserId: null` and `log: null`.
- `BoutSide` = `{gladiatorId, activityId, fighter}`.
- `BoutJob` = `{tournamentId, boutId, battleId, round, position, parentBoutIds, rulesVersion, revealAtMs, sides: [BoutSide, BoutSide]}`, with no seed.
- `RewardGrant` = `{id, tournamentId, gladiatorId, activityId, kind: 'placement', placement: 'winner'|'runner-up'|'semifinal'|'entrant', place, money, renown}`.
- `RatedBout`, `TournamentRatings`, `EntrantBout` (`{boutId, round, kind, renown, ratingDelta}`) and `TournamentOutcome`, as above.

### Eligibility (`partitionTournament`)

- **Cutoff.** The cutoff is `slot.startMs`. A slot is inclusive at its start (Task 2 clock; Task 7 `cutoff_ms = slot × 4,800,000`). This matches Task 6's rule that an edit made exactly at a cutoff belongs to the next occurrence.
- **Opt-in.** The effective opt-in is the last toggle with `receivedAtMs < cutoff`, taken in commit order (times must be non-decreasing). A character with no such toggle is opted out, matching the column default. A toggle at or after the cutoff affects only later tournaments (tested against the following Saturday). Phase 2 can supply this input from the locked column; see decision 1.
- **Rules.** All candidates share one retained rules version, and mixed versions are rejected. The days, time, minimum entrants and rating floor all come from that version.
- **Routes, in order:**
  1. A choice other than Arena → `other` / `not-arena`, debit 0. This partition neither routes nor charges it; the boundary charges its own activity.
  2. Stamina below the Arena cost → `rest` / `insufficient-stamina`, debit 0, matching boundary step 6. This holds even when the tournament costs less than Arena (tested).
  3. Eligible for a bracket → `tournament` / `bracket`, debit `costs.tournament`. Eligible means: a tournament slot, opted in before the cutoff, and stamina at least both costs (the exact cost is allowed). The league also needs at least the minimum number of eligible entrants (v1: 2).
  4. Everyone else → `arena`, debit `costs.arena`. The reason is the first that applies:
     - `not-tournament-slot`;
     - `opted-out`;
     - `insufficient-stamina` (affords Arena but not the tournament);
     - `too-few-entrants`.
- **Output.** `brackets` lists leagues from Bronze to Champion, with entrants in input order. `arena` is the `matchArena` input and contains each fallback exactly once (tested through `matchArena`). No bracket ever mixes leagues.
- **Input requirements:**
  - All entrants share the slot's index and one season.
  - Gladiator and activity ids are unique.
  - Ratings are at least the rules' floor.
  - Stamina and costs are safe nonnegative integers.
  - Each fighter is valid under its retained rules.

### Bracket (`buildBracket`)

- **Ranks.** Each entrant gets the key `seededRandom(`${seed}:tournament:${gladiatorId}`)()`. Ranks follow the key, then the id in code-unit order, so the result does not depend on input order (tested with reversed input).
- **Shape.** `size` is the next power of two above n, and `rounds` is log2(size), computed with an integer loop.
- **Byes:**
  - Round 1 uses the standard seeding positions (1-8, 4-5, 2-7, 3-6 for 8 slots).
  - Ranks above n are empty slots, so the byes go to ranks 1 … (size − n), spread across the bracket.
  - Because n > size / 2, no bout has two byes and every first-round bout has an entrant. No NPC is ever added.
  - Byes occur only in round 1. Two bye receivers can meet in round 2, and that bout is ready at once (n = 5: ranks 2 and 3).
- **Ids.** The tournament id is `tournament:<slot>:<league>`, and each bout id (also its `battleId`) is `<tournament>:<round>:<position>`. A bout's parents are positions 2p and 2p + 1 of round − 1. Ids are identical for every seed.
- **Seeds.** The bracket seed only orders the entrants, and the placement is public at start. The graph and its jobs carry no bout seed. Phase 2 stores a one-way seed for each bout and passes it to `runBout` (phase 2 item 6).
  - Removed: the earlier derivation `${seed}:bout:<round>:<position>` (review fix M2).
  - Reason: FNV-1a can be continued from a shared prefix. A brute-forced round-1 log could then have exposed later results before their reveal.
- **Times.** `startsAtMs` is the slot start. Round r of R reveals at `startsAtMs + ceil(durationMs × r / (R + 1))`, and `settlesAtMs` is the start plus `durationMs`. In v1, `durationMs` is 80 minutes (4,800,000 ms). A bye bout carries its round's reveal time.
- **Entries.** Entries are frozen copies of each entrant's arena fighter and its rating at the start. Mutating the caller's objects afterwards changes nothing (tested).

### Results (`recordBout`)

- **Preconditions.** The bout exists, is not a bye, and both of its entrants are known.
- **The log must belong to this bout:**
  - its `battleId` and `rulesVersion` match;
  - it has exactly two participants, in job order, whose ids and gladiator ids equal the known entrants;
  - each participant matches its frozen snapshot: class, stance, attributes, maximum health, armor, weapon damage, interval, `efficiencyBasisPoints` (`round(efficiency × 10,000)`, as the engine reveals it) and the equipment silhouettes in order (the last two added by review fix M3);
  - each `initialHealth` equals the snapshot's maximum health (full health);
  - `winnerId` is one of the two entrants.
- **Result.** The winner is `log.winnerId`, including a seeded simultaneous-defeat winner at 0 HP. The loser is the other entrant. The stored log is a frozen clone.
- **Retries.** If the log equals the stored one as canonical JSON (sorted keys), `recordBout` returns the same graph object, so a retried completion is a no-op. A different log for a resolved bout is refused.
- **Validation.** Every exported graph function first runs an internal `checkGraph`. It rederives the frame from the stored ranks and fails closed on any of:
  - a changed id, parent, placement, bye, reveal time or settlement time;
  - an invalid entry, fighter or rating floor, or an unknown rules version;
  - a result where the bout is not ready or the winner is not one of its entrants.

  It also applies `recordBout`'s log checks to every stored result (review fix M4). A graph holding stub or altered logs therefore fails before ratings, placements or outcomes.

## Decisions (reviewed)

The spec leaves these open. The reviewer accepted them; the rulings on decisions 1 and 8 change phase 2 and are folded into its plan.

1. **Opt-in history as input.** The helper takes the toggles with their server receipt times, in commit order, so it can apply the cutoff ±1 ms rule. The database keeps only the boolean `gladiators.tournament_opt_in`, and the Task 7 snapshot copies the live column at phase 5.
   - **Reviewer ruling:** no revision history is needed.
   - `set_tournament_opt_in` returns `processing` while `processed_slot_index < slotAt(now)`. This is the same gate as `02-build-schedule.sql:103`.
   - The boundary reads the character under the account and row lock. The live value it freezes therefore equals the value at the cutoff.
   - A toggle committing at the cutoff is resolved by locking, not by timestamps alone. Phase 2 item 3 has the details.
2. **Stamina order.** Arena affordability is checked first (Rest), then the tournament cost (otherwise regular Arena).
   - In v1 both costs are 25 and scale with overload the same way, so the second case only matters to a future rules version. It is tested with hypothetical costs 25/30.
   - The reverse case, a tournament cheaper than Arena (Arena 30, tournament 25, stamina 27), still goes to Rest, as boundary step 6 does. This is pinned by a test.
3. **Bye placement.** Byes use standard positions and go to the top seeded-random ranks (above). The spec says only "seeded randomized placement and byes".
4. **Reveal rounding.** Times are rounded up to a whole millisecond, so a reveal is never early. R = 6 gives 685,715, 1,371,429, 2,057,143, 2,742,858, 3,428,572 and 4,114,286 ms. A test fails if the times are floored.
5. **String ids.** Bout and grant ids are structured strings, not UUIDs. Phase 2 may store them as text keys or derive stable UUIDs, but must keep them stable.
6. **Places.**
   - The winner is place 1. A loser in round r of R shares place 2^(R − r) + 1 (2, 3, 5, 9 …).
   - "Semifinal losers" are the fought losers of round R − 1 (R ≥ 2). A three-entrant bracket with a bye semifinal therefore awards one semifinal placement.
   - "Other entrants" (0 money, 5 renown) is everyone else.
7. **Fight renown.**
   - Each fought bout uses the human Arena amounts from the graph's rules (`rules.arena`; v1: 10 for a win, 2 for a loss).
   - A bye is its own `kind`, never a win, and gives no renown or rating change (review fix M5).
   - `result`/`success` are `victory`/true only for the champion. Every other entrant, including the runner-up, is `defeat`/false.
8. **Names.** `runBout` labels participants `Gladiator` unless it is given names. Task 16 has the same open question for PvP replays.
   - **Reviewer ruling:** phase 2 must freeze real names with the entries or the job.
   - Reason: `recordBout`'s idempotent replay compares the whole log, names included. A rename between attempts would otherwise turn a retried completion into a conflict.
9. **Rejections.** `buildBracket` rejects a non-tournament slot and fewer than the minimum entrants; the plan says brackets exist "only when ≥ 2". The partition sends those entrants to regular Arena.
10. **Rating delta.** An outcome's `ratingDelta` is the total applied across the tournament, after each bout's clamp. It also equals the sum of the entrant's per-bout deltas (tested).

## Public projection (phase 2 guidance)

The graph is private. It holds the frozen fighter snapshots, the pre-tournament ratings and results before their reveal; the bout seeds live only in phase 2's bout rows. `TournamentView` must be an explicit whitelist built from it, never a spread.

- **At start.** The spec (§8.2) publishes the entrants and the bracket shape at start, with seeded placement and byes. They depend on no result.
  - Fields: `id`, `league`, `slotIndex`, `startsAtMs`, `endsAtMs` (= `settlesAtMs`) and `status`.
  - `entrants` comes from public profile fields only (`gladiatorId`, `name`, `classId`), never the fighter snapshots.
  - `bouts` gives the shape (`id`, `round`, `position`, `parentBoutIds`).
- **Open contract question (review finding M7).** The current `TournamentView` DTO has no field for the round-1 pairings and byes before their reveal.
  - `TournamentBout` carries only `id`, `round`, `position` and `parentBoutIds`. Participants and `bye` exist only inside `revealedResult`, which stays `null` until the bout reveals.
  - Today, therefore, the published placement cannot be shown at start without marking it a revealed result.
  - This is an open contract question for Codex (the contract owner) and Task 20 (the UI); the controller will raise it. Phase 2 must not add a field before that ruling.
  - Whatever the ruling, later-round participants stay inside `revealedResult`, because they reveal earlier winners.
- **After reveal.** A bout's `revealedResult` (`participants`, `winnerId`, `bye`, `battleLog`) is filled only once its `revealAtMs <= database time`. SQL/RLS enforces this, as Task 9 does for stages. Byes reveal at round 1's time unless the contract ruling publishes them at start.
- **Placements.** `placements` stays empty until settlement at minute 80. No place or reward appears before then.
  - `placements[].summary` is currently a full owner `ActivitySummary`.
  - Per Codex's producer note, phase 2 must reconcile a role-safe DTO: public place and identity only, with rewards, receipts and overflow owner-only.
- **Never public:** bout seeds, `entries[].fighter`, `entries[].rating`, unrevealed winners or logs.
- **Insufficient entrants.** A league whose entrants were routed `too-few-entrants` can show the status `insufficient-entrants` if phase 2 creates a view for it.

## RED and GREEN

Each cycle wrote its tests first. Runs used `npx vitest run tests/domain/tournament.test.ts` in the default sandbox.

### Phase 1 (`abf7cb9`)

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| A, slot detection | The suite failed to load (unresolved `@domain/tournament.ts`). A placeholder that always returned `false` then gave **14 failed / 6 passed of 20**; the passes were cases that expect `false`. | 20/20 |
| B, eligibility | **30 failed / 20 passed of 50**, all `partitionTournament is not a function`. The reject cases failed because a TypeError is not a RangeError. | 50/50 |
| C, bracket | **35 failed / 50 passed of 85**: `buildBracket is not a function`, and `RULES_V1.tournament.durationMs` was `undefined`. | 85/85 |
| D, jobs and results | The suite failed at collection with `readyBouts is not a function`, because the fence and tamper tables build their inputs while the suite is collected. | 119/119 |
| E, ratings | **5 failed / 119 passed of 124**, `applyTournamentRatings is not a function`. | 124/124 |
| F, placements, outcomes, Step 1 | **25 failed / 132 passed of 157**: `placementGrants` / `tournamentOutcomes is not a function`. The 8 Step 1 cases for 0 and 1 entrants already passed, because they build no bracket, so they are not counted as RED evidence. | 157/157 |

After cycle F, `tsc` reported TS2345 in `tournamentOutcomes`: `flatMap` inferred the bye branch's literal type for the whole union. Annotating the callback's return type fixed it, with no behavior change.

### Review fixes (`98aeb07`)

The suite adds a second retained version, `v1-custom`, to Arena's registry through a hoisted `vi.mock` of `@domain/arena.ts`. Production still retains v1 only.
- `v1-custom` changes Elo K to 32 and the floor to 100, fight renown to 7/1, the tournament days to Wednesday only, the minimum entrants to 3, and the placement bonuses.
- Combat is v1's, so v1 fighters stay valid under it.
- This tests non-default rules the way the Task 16 tests do (`{ ...RULES_V1, rating: { ...RULES_V1.rating, k: 32, minimum: 100 } }`). Here the custom object is reached through the registry, because graph functions take their rules from the graph's version.

| Finding | Change | RED (observed) | GREEN |
| --- | --- | --- | --- |
| M6, duplicated helpers | `arena.ts` exports `RETAINED_RULES`, `LEAGUES`, `copyFighter` and `nonEmpty`. `tournament.ts` imports them and keeps only `validCopy`, which validates and then calls Arena's copy. | "Reads retained rules from the Arena registry": **1 failed / 157 passed of 158**, `RangeError: Invalid tournament fighter snapshot`. The tournament's own registry copy lacked the version. | 158/158; `arena.test.ts` 121/121 |
| M1, rules from the graph and inputs | `applyRatingDelta(…, rules)` uses the graph's rules. The partition and the bracket take one shared version from their entrants and read the floor, minimum, clock and days from it. `isTournamentSlot` takes optional rules. `checkGraph` checks entry ratings against the floor. | **3 failed / 158 passed of 161**: `expected [ [ 1, 100, 112, 100, 88 ], …] to deeply equal [ [ 1, 100, 116, 100, 100 ], …]` (v1 Elo used); two custom entrants got a bracket; `buildBracket` accepted two custom entrants. | 161/161 |
| M2, one-way bout seeds | The bout seed derivation is removed, and `BracketBout`/`BoutJob` have no seed. `runBout(job, seed, names?)` takes the bout's own seed. The tests supply per-bout seeds; the empty-bout-seed tamper row went with the field. | **4 failed / 157 passed of 161**: bouts and jobs still had a `seed` property; `runBout` ignored the supplied seed (its log differed from the engine run under that seed); names given third were ignored. | 161/161 |
| M3, bout fence | `sameCombatant` also compares `efficiencyBasisPoints` and the equipment silhouettes. | **2 failed / 161 passed of 163**: the 5000 bp row and the foreign-silhouettes row failed with "expected function to throw an error, but it didn't". | 163/163 |
| M4, stored results | One `logBelongs` check is shared by `recordBout` and `checkGraph`. | **1 failed / 163 passed of 164**: a graph with stub logs `{battleId, winnerId}` was accepted by `tournamentOutcomes`, `placementGrants`, `applyTournamentRatings` and `readyBouts`. | 164/164 |
| M5, byes are not wins | `EntrantBout.kind` is `'bye' \| 'win' \| 'loss'`, replacing `bye`/`won`. `TournamentOutcome` adds `wins` and `losses` for fought bouts only. | **2 failed / 163 passed of 165**: `kind` was `undefined`. | 165/165 |
| Test gap, cheaper tournament | Test only: Arena 30, tournament 25, stamina 27 → Rest. | A pin of existing behavior, so no RED. Before the test existed, the mutation below left all 165 tests passing, which confirmed the gap. | 166/166 |

### Mutation checks

Each mutation was applied to `tournament.ts`, run against the owning file, and then restored. The phase 1 checks used a temporary script outside the repository, which confirmed a byte-for-byte restore. The review-fix checks were restored from a copy in the session scratchpad and confirmed identical with `cmp`.

| Mutation | Tests failed |
| --- | --- |
| Local `Date` weekday/hour instead of UTC arithmetic (cycle A, of 20) | 8 |
| Reveal times rounded down | 1 of 157 |
| Opt-in received exactly at the cutoff counts | 2 of 157 |
| Exact stamina treated as insufficient | 1 of 157 |
| Schedule choice ignored | 1 of 157 |
| A single entrant gets a bracket | 6 of 157 |
| Sequential (clustered) bye placement | 25 of 157 |
| Frozen ratings instead of round order | 1 of 157 |
| Byes earn win renown | 13 of 157 |
| Wider semifinal band | 2 of 157 |
| Two-player bracket without a runner-up | 2 of 157 |
| Full-health fence removed from `recordBout` | 1 of 157 |
| Positive HP required to win (the Task 9 defect) | 11 of 157 |
| A child bout ready with one parent | suite failed at collection |
| A different result replaces a recorded one | 1 of 157 |
| Review: Arena affordability checked against the cheaper of the two costs | 1 of 166 (the new pin) |
| Review: efficiency check dropped from `sameCombatant` | 2 of 166 (fence row, stored-results test) |
| Review: silhouette check dropped from `sameCombatant` | 1 of 166 |
| Review: `checkGraph` back to its old battle-id-only log check | 1 of 166 (stored-results test) |
| Review: `applyRatingDelta` called without the graph's rules | 1 of 166 (custom Elo test) |

## Coverage

- **Plan Step 1.** For 0, 1, 2, 3, 5 and 50 entrants in **each** league (24 cases), the harness runs the partition, one bracket per league with every bout as its own job (each with its own supplied seed), the outcomes, and `matchArena` for the leftovers. It asserts:
  - `chargesPerParticipant` = `Array(n).fill(1)`, counting debiting activities per entrant across bracket outcomes and regular-Arena sides;
  - a total stamina debit of 25 × n;
  - `bracketWinners` = 1 when n ≥ 2;
  - `ratedBouts` = n − 1 when n ≥ 2, counting tournament bouts and human regular bouts;
  - bye renown 0, summed over `kind === 'bye'`.

  A combined slot with Bronze 50, Silver 5, Gold 1 and Champion 3 gives three brackets with one winner each, and an NPC Arena bout for Gold.
- **Step 4 cases needing no database:**
  - **Eligibility:**
    - the cutoff ±1 ms for both opt-in and opt-out;
    - same-millisecond commit order;
    - a character that never opted in;
    - a post-cutoff toggle applying to the next Saturday;
    - stamina at the exact cost and one below;
    - a tournament cheaper than Arena (Rest);
    - per-league partitions, non-Arena schedules and non-tournament slots.
  - **Brackets:**
    - shapes for 2, 3, 4, 5, 8, 9, 17, 33, 50 and 64 entrants;
    - bye paths and spread;
    - no fabricated NPCs;
    - byes resolved at once.
  - **Bouts:**
    - full health at every bout, including after a 0-HP win;
    - frozen builds, against caller mutation and across every round;
    - stable ids across rebuilds and seeds;
    - no bout seed in the graph or its jobs, and `runBout` uses exactly the supplied seed;
    - reveal times for R = 1 … 6.
  - **Slot detection:** Wednesday and Saturday 17:20 UTC around the EU (2026-10-25, 2027-03-28) and US (2026-11-01) daylight-saving changes, under five `TZ` zones. Local 17:20 times are rejected, and a full week has exactly two tournament slots.
  - **Results:**
    - round-ordered ratings: the final gains 8 from the updated ratings, where the frozen ratings would give 9;
    - clamping, and n − 1 rated bouts with distinct players per round;
    - the 0-HP winner rule for both positions and in settlement;
    - placement counts and amounts for 2, 3, 5 and 50 entrants, and the two-person bracket;
    - one stable grant identity per entrant across a replay;
    - idempotent and conflicting result recording;
    - fencing, including efficiency and silhouettes;
    - graph tampering, including stub and altered stored logs;
    - byes never counted as wins, whether their receiver later wins or loses.
  - **Rules:**
    - Arena's registry is used;
    - the graph's Elo K, floor, fight renown and placements are applied;
    - the candidates' days, minimum and floor drive the partition, and mixed versions are rejected;
    - the bracket's minimum, days and floor come from its entrants;
    - `isTournamentSlot` uses the rules it is given and defaults to v1.

## Final commands

| Command | Result |
| --- | --- |
| `npm test` (baseline before phase 1) | 17 files, **480 passed**. |
| `npm test` (phase 1, `abf7cb9`) | 18 files, **637 passed** (480 + 157). |
| `npm test` (baseline before the review fixes, `8d72abb`) | 18 files, **644 passed** (637 + Task 16's 7 review-fix tests). |
| `npm test` (review fixes, `98aeb07`) | 18 files, **653 passed** (644 + 9). |
| `npm run typecheck` at `8d72abb` | **Exit 0**, re-run for this report from a temporary detached checkout, then returned to the branch. |
| `npm run typecheck` at `98aeb07` | **Exit 0**: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, Deno runtime 2 passed. |
| `npx deno check --frozen --config supabase/functions/deno.json supabase/functions/_shared/domain/tournament.ts supabase/functions/_shared/domain/arena.ts` | Exit 0. No Edge entrypoint imports `tournament.ts` yet. |
| `git diff --check`, `git diff --cached --check` | Clean (only the configured LF-to-CRLF notices). |

Correction to this report's first version: `npm run typecheck` does not fail.
- At `abf7cb9` it failed only on stale ignored `.next` validators, generated by another branch's build, which referenced `src/app/expedition/page.js`. An equivalent chain without them passed.
- The controller then removed that ignored output, and there is no `.next` directory now.
- At `8d72abb` and at `98aeb07` the command itself exits 0.

The commit message files and the mutation copy live in the session scratchpad, outside the repository. Nothing extra was staged.

## Phase 2 must do

This plan starts from Task 16's corrected phase 2 plan ([task-16-phase-1-report.md](task-16-phase-1-report.md), "Phase 2 must do", especially items 5, 6, 7 and 9). It reuses that plan's pairing job, seeds, acceptance and settlement rather than defining a second design.

1. **SQL source.**
   - Use the next free `supabase/sql/` number after the Task 10/16/18 sources (Task 16 plans `07-arena.sql`), with guarded DDL and `CREATE OR REPLACE`.
   - Private tables, with no client grants and with `guard_frozen` for immutable rows, for:
     - the immutable tournament frame and its entries, including each entry's frozen display name (decision 8);
     - one row per bout, holding the frame fields, the bout's private seed (item 6) and its result and log (written once, item 8), so bouts of one round commit concurrently.
   - There is no placement-grant table (item 10).
   - Following Task 16 item 1, the header documents every accepted exception: the bout-seed exception (item 6) and the bout-job anchor (item 7).
2. **Migration.**
   - Generate it with the CLI (`db pull <name> --local --yes`) after the Task 10/16/18 migrations; the plan's `M09a` alias is obsolete.
   - Follow the AGENTS.md completion check (ACLs, revokes, invoker views, trigger order, backfills, initialization).
   - Run a clean reset and replay, compare the replay with the source, and record the path in `docs/operations/migrations.md`. Never edit a committed migration.
3. **Opt-in command, with the decision 1 ruling.**
   - `set_tournament_opt_in(actor_id, operation_id, input jsonb)` returns a receipt.
   - It is backend-only and security invoker, and takes the common account lock order: account advisory lock, then the character row `for update`.
   - Receipt replay comes before validation.
   - It returns `processing` while `g.processed_slot_index < slotAt(now)`, with `now` from the post-lock `private.planning_now_ms()`. This is the gate at `02-build-schedule.sql:103`.
   - It updates `tournament_opt_in`, which `OwnerState.tournamentOptIn` already shows, and wires the existing `set-tournament-opt-in` validation (`backend/commands.ts`) to the RPC.
   - No revision table is needed. The boundary reads the character under the account and row lock (Task 7 phase 5, `03-activities-jobs.sql:381`), so the frozen `starting.tournamentOptIn` equals the value at the cutoff:
     - A toggle that took the lock before the cutoff commits before the boundary can read the row.
     - A toggle at or after the cutoff gets `processing` until the boundary has processed the character.
     - A toggle committing at the cutoff is resolved by this locking, not by timestamps alone.
   - The pairing job passes the frozen value to `partitionTournament` as the single revision in force at the cutoff (`[{enabled, receivedAtMs: cutoff − 1}]`). The DB tests prove the ±1 ms cases through the gate and the lock order.
4. **Partition inside Task 16's pairing job (ruling a).**
   - There is no separate tournament pairing job. At phase 7, `private.boundary_pair(bigint)` inserts Task 16's fenced pairing job for each slot and league (`pair:<slot>:<league>`).
   - The boundary waits while any of them is pending (like phase 4's `boundary_recompute`, `03-activities-jobs.sql:331-348`), returns `'operator'` if one failed, and adopts the results once all complete.
   - For its league, the worker runs, in order:
     1. `partitionTournament(slot, candidates)`;
     2. `buildBracket(bracket.entrants, …)` when the league has a bracket;
     3. `matchArena(partition.arena, history, …)`.

     No entrant can be in both a bracket and regular Arena, and SQL restates none of these rules.
   - Candidates are every activity of that slot and league whose frozen choice is Arena, built from `activity_snapshots`:
     - the entrant fighter is the arena fighter frozen by canonical TypeScript (Task 16 item 6);
     - the rating is the league-season row (Task 16 item 5);
     - the choice, the starting stamina and the snapshot costs;
     - the opt-in input from item 3.
   - **Rest.** Boundary step 6 has already resolved unaffordable Arena activities to Rest. Phase 2 asserts that the partition's `rest` routes are exactly step 6's fallback set, with debit 0, rather than recomputing or re-resolving them. The phase 1 pin shows the domain agrees with step 6 even when the tournament is cheaper than Arena.
   - Bracket activities become `resolved_kind = 'tournament'` with `stamina_debit = costs.tournament`, debited once at phase 8.
   - **Recommended, not yet ruled:** pass `buildBracket` its own one-way placement seed (for example SHA-256 of the job seed and `':bracket'`, computed by SQL into the job input), not the seed `matchArena` uses.
     - The placement is public at start.
     - FNV-1a steps can be inverted over a known suffix. A placement brute-forced back to the job seed's 32-bit hash state could therefore expose the matcher's seeded tie-break keys.
5. **Accepting the pairing result (ruling f).** `complete_job` accepts the TypeScript-built bracket only if all three hold:
   - every eligible entrant of that slot and league appears exactly once across the bracket entries, the regular-Arena assignments and the Rest routes, with the same slot, season and league;
   - each entry's fighter equals the TypeScript-frozen value from preparation (Task 16 item 6), and its rating equals the frozen league-season row;
   - the graph passes `checkGraph`. The worker runs it, through `readyBouts`, on the built graph before completing. Every bout executor and the settlement run it again on the stored graph. SQL checks the stored frame's cheap structural invariants (bout count `size − 1`, unique ids, parents, byes) but restates no bracket rule.
6. **Bout seeds (ruling b; review fix M2).**
   - Each fought bout gets a private one-way seed, computed by SQL when the bout row is written, as Task 16 item 7 does for battles. For example: `encode(extensions.digest(<pairing job seed> || ':' || boutId, 'sha256'), 'hex')`.
   - It is stored on the bout row, and the bout's simulation job carries it in `jobs.seed`, so a retry reuses it.
   - The SQL header records the exception to the per-activity seed rule (`03-activities-jobs.sql:249-250`): a tournament bout job carries its bout's seed, not its anchor activity's.
   - The domain never derives a bout seed. The worker calls `runBout(job, jobSeed, names)`.
7. **Bout jobs, anchoring and child input (ruling c).**
   - **Jobs.** One `simulation` job per fought bout, with dedupe key `tournament-bout:<boutId>` and the combat batch limit of 5. No job simulates more than one bout, and byes need no job.
   - **Dependencies.** All bout jobs are created up front. A child bout job depends on its fought parents' jobs through `private.job_dependencies`, so it cannot be claimed before both parents' results are committed.
   - **Anchor (chosen).** Every bout job of a tournament is anchored to the tournament's rank-1 entry (its `gladiator_id` and `activity_id`):
     - The anchor is known when the graph is stored and stays stable across retries.
     - It needs no relaxation beyond Task 16's, which stays limited to `pair` jobs.
     - `complete_job` locks only the job row (`05-expeditions.sql:331`), and operator state stays on job rows and slot barriers, so the anchor adds no cross-account lock.
     - The anchor is bookkeeping only. `accept_job_result` reaches its tournament branch through the anchor's `resolved_kind = 'tournament'`, then identifies the bout by `input.boutId` and its participants from the stored graph, never from the anchor.
   - **Child input.** The job input is only `{kind: 'tournament-bout', tournamentId, boutId}`. The explicit discriminator follows Task 16 item 8. After claiming, the executor reads its parents' winners through a backend-only fenced read, for example `public.tournament_bout_input(job_id, lease_token)`. That read:
     - locks the job row first, samples `private.planning_now_ms()` after the lock, and checks the current token, `leased` status and unexpired lease (the AGENTS.md concurrency override);
     - checks `dependencies_ready`;
     - returns the stored frame, the entries with their frozen names, and every stored bout result.

     The worker rebuilds the graph. It confirms with `readyBouts` that this bout is ready (which runs `checkGraph` over the stored logs), takes that `BoutJob`, and runs `runBout(job, jobSeed, names)`. The seed comes from the claimed lease.
   - **Registry.** Add the tournament branch to the v1 simulation executor, which dispatches by kind; there is no second runner. An unknown kind fails with `unsupported-executor`.
8. **Result fence.** This is a tournament branch of `private.accept_job_result`, reached from `complete_job`, which already locks first, samples post-lock time and verifies the token, status and expiry.
   - It validates the log against the bout with `recordBout`'s identity checks: battle id, rules version, participants and their `gladiatorId` in job order, full health and a winner among them. `private.safe_battle_log` shapes it.
   - It then compare-and-sets the bout row: null to result, or an identical idempotent replay; anything else is a conflict.
   - It never publishes a private result before its reveal.
   - **PairingHistory (ruling d).** Human tournament bouts count, one row per fought bout and never a bye, coordinated with Task 16. The rows can be written in the same transaction, or read by Task 16's history query from the stored bout rows.
9. **Reveals and stages.**
   - Publish only due events.
   - Each entrant activity gets:
     - a staging stage;
     - one stage per bout it fights, with the log, labelled from that entrant's `winnerId` perspective;
     - a minute-80 settlement stage.
   - An eliminated entrant stays in the tournament activity until minute 80 and never opens another activity in the slot.
   - Bump the Task 10 revision on reveals.
10. **Settlement (rulings e and g).** Each entrant activity's settlement job at minute 80 depends on every bout job and that activity's reveal jobs.
    - **Outcome.** The worker loads the complete stored graph through a fenced read and runs `tournamentOutcomes`. Its `checkGraph` refuses stub or altered stored logs (review fix M4). The worker settles this activity's outcome, `{rewards, result, success, replayExpiry, ratingDelta}`, through `private.settle_rewards(uuid)`. `ratingDelta` is the applied total.
    - **Grant identity (g).** The placement grant id travels inside that activity's single settlement outcome and receipt:
      - one settlement per activity;
      - one receipt per activity;
      - one `wallet_ledger` row per receipt (`receipt_id uuid unique`), combining fight renown with placement money and renown.

      There is no new unique grant table and no second grant guard alongside M06's settlement path (`settle_activity_core` and its `private.settled_slots` receipt).
    - **Ratings (e).** Each side settles alone, under its own account lock and the common order (Task 16 item 9, one side at a time).
      - Under that lock, assert that the entry's frozen rating equals the entrant's own live league-season rating row. Otherwise fail closed to operator state.
      - Write the round-ordered `ratingAfter`. It is a pure function of the frozen ratings and the stored results, so no cross-account lock is needed.
    - **Counters.** Standings use `outcome.wins` and `outcome.losses`. The five-human-bout season rule uses `wins + losses`. Byes never count (review fix M5).
    - **Tests.** Cover simultaneous settlement retries and the malformed-hook rollback.
11. **Projection.** Build `TournamentView` as described under "Public projection". This covers the role-safe placements DTO, empty placements until settlement and the `insufficient-entrants` status. The start-of-tournament pairings and byes wait for the M7 contract ruling.
12. **DB tests in `tests/db/tournaments.test.ts`:**
    - the Step 1 table through real SQL and jobs, for 0, 1, 2, 3, 5 and 50 entrants in each league;
    - opt-in at the cutoff ±1 ms through the processing gate and lock order, with the rollback-only clock;
    - opt-out and insufficient stamina, with the Rest set equal to step 6's;
    - bye paths;
    - a stalled child job held by its dependency;
    - a child bout reading its parents' winners through the fence;
    - a lease retry with the same bout seed;
    - distinct per-bout seeds;
    - full HP per bout;
    - placement counts and amounts, and the two-person bracket;
    - frozen builds and names after a mid-tournament build change or rename;
    - rejection of a pairing result that omits, duplicates or alters an entrant or fighter;
    - a frozen/live rating mismatch going to operator state;
    - a stub or altered stored log refused at settlement;
    - access denial for the graph, bout seeds and unrevealed results;
    - stage due-ness and empty placements before minute 80;
    - the AGENTS.md lease-expiry regression;
    - migration-only replay parity.
13. **Open dependencies.**
    - Season identity (`seasonId`): agree it with Codex (Task 21) now, per Task 16 item 3.
    - Participant names in PvP logs are shared with Task 16; decision 8 fixes the tournament side.
    - Task 20 (Claude, UI) waits for the reviewed Task 19 wire and the M7 ruling, and needs exact contract notifications before any edit.

No reusable skill change is proposed. The TDD, verification and project migration and concurrency guidance already cover this work.
