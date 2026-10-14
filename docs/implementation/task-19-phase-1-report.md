# Task 19 phase 1 report: pure tournament domain

Status: **DONE_WITH_CONCERNS**. The pure tournament module and its unit tests are complete and verified. Phase 2 (database, boundary hook, per-bout jobs, settlement, opt-in command, projections, DB tests) is still to do; its complete list is at the end. The concerns are the design decisions the spec leaves open (below), for the reviewer to confirm, and one environment problem: stale ignored `.next` files break `npm run typecheck` in this worktree.

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19`.
- Task base: **`61b3e7b`**, the head of `claude/task-16` (Task 16 phase 1, under independent review). Branch start: `427158e`, the controller brief.
- Source commit: **`abf7cb9`**, `feat: add pure tournament bracket and reward rules`.
- Scope: [task-19-claude-dispatch.md](task-19-claude-dispatch.md) and [task-19-brief-base.md](task-19-brief-base.md).
- Not done here, by instruction: no Supabase, Docker or database commands, no browser tests or dev server, no push or merge, no edits to `HANDOFF.md`, and no subagents. The other checkouts (`Cloudiator`, `Cloudiator-replay`, `Cloudiator-arena`) were not touched. `arena.ts` was consumed, not changed.

## Files

| Path | Change |
| --- | --- |
| `supabase/functions/_shared/domain/tournament.ts` | New. All phase 1 functions and the types they return. |
| `supabase/functions/_shared/domain/rules-v1.ts` | One additive constant: `tournament.durationMs: 4_800_000`. |
| `tests/domain/tournament.test.ts` | New. 157 cases. |

Task 2 had already versioned the tournament days (`utcWeekdays [3, 6]`), time (`hourUtc 17`, `minuteUtc 20`), `minimumEntrants 2` and the placement bonuses. The only spec value missing was the 80-minute span of the reveal formula and settlement, now `durationMs`; a test pins it to the slot length. `SlotWindow` is Task 2's `types.ts` definition, re-exported from `tournament.ts` rather than redefined. Ratings use `arena.ts` (`applyRatingDelta`), slots use `clock.ts` (`slotAt`), seeds use `random.ts` (`seededRandom`), and bouts use the canonical `simulateBattle`. There is no second rating, clock or combat implementation.

## Interfaces

All functions are pure and deterministic. A malformed input throws `RangeError`. Rules come from a retained registry that holds only `v1`, so an unknown version fails closed. Outputs are frozen copies; caller objects are never frozen or kept.

| Export | Contract |
| --- | --- |
| `isTournamentSlot(slot: SlotWindow): boolean` | True for the canonical slot starting Wednesday or Saturday at 17:20 UTC. It uses epoch-day arithmetic on `slot.startMs` (`(floor(ms / day) + 4) % 7`, minute of day 1040), never `Date` or local time. The slot must equal `slotAt(slot.startMs)` (index, phase, start and end). Every 17:20 UTC start is an afternoon, because a day holds 18 slots. |
| `partitionTournament(slot, candidates): TournamentPartition` | The eligibility helper. Details under "Eligibility" below. |
| `buildBracket(entries: ArenaEntrant[], seed: Seed): TournamentGraph` | Seeded single elimination; details under "Bracket" below. Requires at least two entrants from one league, slot and season, on a tournament slot, with one rules version. |
| `readyBouts(graph): BoutJob[]` | One job per unresolved fought bout whose two entrants are known: round 1, or both parents resolved. Round, then position, order. Byes never appear. |
| `runBout(job, names?): BattleLog` | `simulateBattle` under the job's retained rules and private bout seed. Participant ids are gladiator ids, with no `startingHealth`, so both start at full health. `names` only labels the log (default `Gladiator`, as expeditions do); a test shows it never changes events or winner. |
| `recordBout(graph, boutId, log): TournamentGraph` | Fenced, copy-on-write result recording; details under "Results" below. |
| `applyTournamentRatings(graph): TournamentRatings` | For a completed graph: Elo in round order from the ratings left by earlier rounds; byes are never rated. Returns `bouts` (`RatedBout`: before and after for both sides) and per-entry `ratings` (`before`, `after`, `delta`, after clamping). Fails closed if a player appears twice in a round. |
| `placementGrants(graph): RewardGrant[]` | For a completed graph: one grant per entrant, ordered by place then rank. |
| `tournamentOutcomes(graph): TournamentOutcome[]` | For a completed graph, one settlement per entry in rank order: `place`, `result` and `success` (`victory`/true for the winner only), the entrant's `bouts` (`EntrantBout`: `bye`, `won`, `renown`, `ratingDelta`), its `placement` grant, `rewards: CreditedRewards` (placement money; fight renown plus placement renown; XP, points, items and overflow all 0) and the round-ordered `ratingBefore`/`ratingAfter`/`ratingDelta`. |

### Types (defined beside the functions)

- `OptInRevision` = `{enabled, receivedAtMs}`; `TournamentCandidate` = `{entrant: ArenaEntrant, choice: ActivityChoice, stamina, costs: {arena, tournament}, optIn: OptInRevision[]}`.
- `TournamentRoute` = `{gladiatorId, activityId, league, route: 'tournament'|'arena'|'rest'|'other', reason, staminaDebit}`. `TournamentPartition` = `{slotIndex, tournamentSlot, brackets: {league, entrants}[], arena: ArenaEntrant[], routes}`.
- `TournamentGraph` = `{id, seasonId, league, slotIndex, rulesVersion, startsAtMs, settlesAtMs, size, rounds, revealAtMs[], entries: TournamentEntry[], bouts: BracketBout[]}`.
- `TournamentEntry` = `{gladiatorId, activityId, rating, fighter, rank}`.
- `BracketBout` = `{id, battleId, round, position, parentBoutIds, placed, bye, seed, revealAtMs, result}`.
- `BoutResult` = `{winnerId, loserId, log}`; a bye has `loserId: null` and `log: null`.
- `BoutSide` = `{gladiatorId, activityId, fighter}`; `BoutJob` = `{tournamentId, boutId, battleId, round, position, parentBoutIds, rulesVersion, seed, revealAtMs, sides: [BoutSide, BoutSide]}`.
- `RewardGrant` = `{id, tournamentId, gladiatorId, activityId, kind: 'placement', placement: 'winner'|'runner-up'|'semifinal'|'entrant', place, money, renown}`.
- `RatedBout`, `TournamentRatings`, `EntrantBout`, `TournamentOutcome` as above.

### Eligibility (`partitionTournament`)

- **Cutoff.** The cutoff is `slot.startMs`. A slot is inclusive at its start (Task 2 clock, Task 7 `cutoff_ms = slot × 4,800,000`), matching Task 6's rule that an edit exactly at a cutoff belongs to the next occurrence.
- **Opt-in.** The effective opt-in is the last toggle with `receivedAtMs < cutoff`, taken in commit order (times must be non-decreasing). With no such toggle the character is opted out, matching the column default. A toggle at or after the cutoff affects only later tournaments (tested against the following Saturday).
- **Routes, in order:**
  1. A choice other than Arena → `other` / `not-arena`, debit 0. This partition neither routes nor charges it; its own activity is charged by the boundary.
  2. Stamina below the Arena cost → `rest` / `insufficient-stamina`, debit 0, matching boundary step 6.
  3. Eligible for a bracket → `tournament` / `bracket`, debit `costs.tournament`. Eligible means: a tournament slot, opted in before the cutoff, and stamina ≥ both costs (exact cost allowed). The league also needs at least `minimumEntrants` (2) eligible entrants.
  4. Everyone else → `arena`, debit `costs.arena`. The reason is the first that applies: `not-tournament-slot`, `opted-out`, `insufficient-stamina` (affords Arena but not the tournament) or `too-few-entrants`.
- **Output.** `brackets` lists leagues Bronze to Champion, with entrants in input order. `arena` is the `matchArena` input and contains each fallback exactly once (tested through `matchArena`). No bracket ever mixes leagues.
- **Input requirements.** All entrants share the slot's index and one season; gladiator and activity ids are unique. Stamina and costs are safe nonnegative integers, and the fighter is valid for its retained rules.

### Bracket (`buildBracket`)

- **Ranks.** Each entrant gets the key `seededRandom(`${seed}:tournament:${gladiatorId}`)()`. Ranks follow the key, then the id in code-unit order, so the result does not depend on input order (tested with reversed input).
- **Shape.** `size` is the next power of two of n, and `rounds` is log2(size), computed by an integer loop.
- **Byes.** Round 1 uses standard seeding positions (1-8, 4-5, 2-7, 3-6 for 8 slots). Ranks above n are empty slots, so the byes go to ranks 1 … (size − n), spread across the bracket. Because n > size / 2, no bout has two byes, every first-round bout has an entrant, and no NPC is ever added. Byes occur only in round 1. Two bye receivers can meet in round 2; that bout is ready at once (n = 5: ranks 2 and 3).
- **Ids.** The tournament id is `tournament:<slot>:<league>`, and each bout id (also its `battleId`) is `<tournament>:<round>:<position>`. Parents are round − 1 positions 2p and 2p + 1. Ids are identical for every seed.
- **Seeds.** Each bout has a private seed `${seed}:bout:<round>:<position>`: distinct per bout and stable for the tournament seed.
- **Times.** `startsAtMs` = slot start. Round r of R reveals at `startsAtMs + ceil(4,800,000 × r / (R + 1))`. `settlesAtMs` = start + 80 minutes. A bye bout carries its round's reveal time.
- **Entries.** Entries are frozen copies of each entrant's arena fighter and rating at the start; mutating the caller's objects afterwards changes nothing (tested).

### Results (`recordBout`)

- **Preconditions.** The bout exists, is not a bye, and both entrants are known.
- **The log must belong to this bout:**
  - its `battleId` and `rulesVersion` match;
  - it has exactly two participants, in job order, with ids and gladiator ids equal to the known entrants;
  - each participant's class, stance, attributes, maximum health, armor, weapon damage and interval equal the frozen snapshot;
  - each `initialHealth` equals the snapshot's maximum health (full health);
  - `winnerId` is one of the two entrants.
- **Result.** The winner is `log.winnerId`, including a seeded simultaneous-defeat winner at 0 HP. The loser is the other entrant. The stored log is a frozen clone.
- **Retries.** Recording a log equal, as canonical JSON (sorted keys), to the stored one returns the same graph object, so a retried completion is a no-op. A different log for a resolved bout is refused.
- **Validation.** Every exported graph function first runs an internal `checkGraph`. It rederives the frame from the stored ranks and fails closed on any changed id, parent, placement, bye, reveal time, settlement time, missing seed, invalid entry or fighter, unknown rules version, or a result where the bout is not ready or the winner is not one of its entrants.

## Decisions for review

The spec leaves these open.

1. **Opt-in history as input.** The helper needs the toggles with server receipt times, in commit order, so the cutoff ±1 ms rule can be applied. Today the database keeps only the boolean `gladiators.tournament_opt_in`, and the Task 7 snapshot copies the live column at phase 5. A boundary running late could therefore read a toggle made after the cutoff. Phase 2 must persist opt-in revisions or prove the equivalence (see the phase 2 list).
2. **Stamina order.** Arena affordability is checked first (Rest), then the tournament cost (otherwise regular Arena). In v1 both costs are 25 and overload-scaled the same way, so the second case only matters to a future rules version; it is tested with hypothetical costs 25/30.
3. **Bye placement.** Standard positions with byes for the top seeded-random ranks (above). The spec says only "seeded randomized placement and byes".
4. **Reveal rounding.** Times are rounded up to a whole millisecond, never early (R = 6 gives 685,715, 1,371,429, 2,057,143, 2,742,858, 3,428,572 and 4,114,286 ms). A test fails on floor.
5. **String ids.** Bout and grant ids are structured strings, not UUIDs. Phase 2 may store them as text keys or derive stable UUIDs, but must keep them stable.
6. **Places.** The winner is place 1. A loser in round r of R shares place 2^(R − r) + 1 (2, 3, 5, 9 …). "Semifinal losers" are the fought losers of round R − 1 (R ≥ 2), so a three-entrant bracket with a bye semifinal awards one semifinal placement. "Other entrants" (0 money, 5 renown) is everyone else.
7. **Fight renown.** Each fought bout uses the human Arena amounts from `rules.arena` (10 for a win, 2 for a loss); byes give 0. `result`/`success` are `victory`/true only for the champion; every other entrant, the runner-up included, is `defeat`/false.
8. **Names.** `runBout` labels participants `Gladiator` unless given names. Task 16 has the same open question for PvP replays.
9. **Rejections.** `buildBracket` rejects a non-tournament slot and fewer than two entrants (the plan says brackets exist "only when ≥ 2"); the partition sends those entrants to regular Arena.
10. **Rating delta.** An outcome's `ratingDelta` is the applied total across the tournament, after each bout's clamp. It also equals the sum of the entrant's per-bout deltas (tested).

## Public projection (phase 2 guidance)

The graph is private. It holds seeds, frozen fighter snapshots, pre-tournament ratings and results before their reveal. `TournamentView` must be an explicit whitelist built from it, never a spread:

- **At start:** `id`, `league`, `slotIndex`, `startsAtMs`, `endsAtMs` (= `settlesAtMs`) and `status`. `entrants` comes from public profile fields only (`gladiatorId`, `name`, `classId`), never the fighter snapshots. `bouts` gives only the shape (`id`, `round`, `position`, `parentBoutIds`) with `revealedResult: null`.
- **After reveal:** a bout's `revealedResult` (`participants`, `winnerId`, `bye`, `battleLog`) is filled only once its `revealAtMs <= database time`, enforced in SQL/RLS as Task 9 does for stages. This includes byes, which reveal at round 1's time. Revealing a later bout's participants reveals earlier winners, so participants must stay inside `revealedResult`, as the DTO comment requires.
- **Never public:** seeds, `entries[].fighter`, `entries[].rating`, unrevealed winners or logs.
- **Placements:** `placements[].summary` is currently a full owner `ActivitySummary`. Per Codex's producer note, phase 2 must reconcile a role-safe DTO: public place and identity only, with rewards, receipts and overflow owner-only.
- **Insufficient entrants:** a league whose entrants were routed `too-few-entrants` can show status `insufficient-entrants` if phase 2 creates a view for it.

## RED and GREEN

Each cycle wrote its tests first. Runs used `npx vitest run tests/domain/tournament.test.ts` in the default sandbox.

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| A, slot detection | The suite failed to load (unresolved `@domain/tournament.ts`). A placeholder that always returned `false` then gave **14 failed / 6 passed of 20**: the passes were cases that expect `false`. | 20/20 |
| B, eligibility | **30 failed / 20 passed of 50**, all `partitionTournament is not a function`. Reject cases failed because a TypeError is not a RangeError. | 50/50 |
| C, bracket | **35 failed / 50 passed of 85**: `buildBracket is not a function`, and `RULES_V1.tournament.durationMs` was `undefined`. | 85/85 |
| D, jobs and results | The suite failed at collection with `readyBouts is not a function`: the fence and tamper tables build their inputs while the suite is collected. | 119/119 |
| E, ratings | **5 failed / 119 passed of 124**, `applyTournamentRatings is not a function`. | 124/124 |
| F, placements, outcomes, Step 1 | **25 failed / 132 passed of 157**: `placementGrants` / `tournamentOutcomes is not a function`. The 8 Step 1 cases for 0 and 1 entrants already passed, because they build no bracket; they are not counted as RED evidence. | 157/157 |

After cycle F, `tsc` reported TS2345 in `tournamentOutcomes`: `flatMap` inferred the bye branch's literal `bye: true` for the whole union. Annotating the callback's return type fixed it, with no behavior change.

### Mutation checks

Each mutation was applied to `tournament.ts` by a temporary scratch script (outside the repository), run against the owning file, and restored; the script confirmed a byte-for-byte restore.

| Mutation | Tests failed (of 157) |
| --- | --- |
| Local `Date` weekday/hour instead of UTC arithmetic (cycle A, of 20) | 8 |
| Reveal times rounded down | 1 |
| Opt-in received exactly at the cutoff counts | 2 |
| Exact stamina treated as insufficient | 1 |
| Schedule choice ignored | 1 |
| A single entrant gets a bracket | 6 |
| Sequential (clustered) bye placement | 25 |
| Frozen ratings instead of round order | 1 |
| Byes earn win renown | 13 |
| Wider semifinal band | 2 |
| Two-player bracket without a runner-up | 2 |
| Full-health fence removed from `recordBout` | 1 |
| Positive HP required to win (the Task 9 defect) | 11 |
| A child bout ready with one parent | suite failed at collection |
| A different result replaces a recorded one | 1 |

## Coverage

- **Plan Step 1:** for 0, 1, 2, 3, 5 and 50 entrants in **each** league (24 cases), the harness runs the partition, one bracket per league with every bout as its own job, the outcomes, and `matchArena` for leftovers. It asserts `chargesPerParticipant` = `Array(n).fill(1)` (debiting activities per entrant across bracket outcomes and regular-Arena sides), total stamina debit 25 × n, `bracketWinners` (1 when n ≥ 2), `ratedBouts` (n − 1 when n ≥ 2, counting tournament bouts and human regular bouts) and bye renown 0. A combined slot with Bronze 50, Silver 5, Gold 1 and Champion 3 gives three brackets, one winner each, and an NPC Arena bout for Gold.
- **Step 4 cases needing no database:**
  - **Eligibility:** the cutoff ±1 ms for both opt-in and opt-out; same-millisecond commit order; never opted in; a post-cutoff toggle applying to the next Saturday; stamina at the exact cost and one below; per-league partitions; non-Arena schedules; non-tournament slots.
  - **Brackets:** shapes for 2, 3, 4, 5, 8, 9, 17, 33, 50 and 64 entrants; bye paths and spread; no fabricated NPCs; byes resolved at once.
  - **Bouts:** full health at every bout, including after a 0-HP win; frozen builds against caller mutation and across every round; stable ids across rebuilds and seeds; distinct, stable bout seeds; reveal times for R = 1 … 6.
  - **Slot detection:** Wednesday and Saturday 17:20 UTC around the EU (2026-10-25, 2027-03-28) and US (2026-11-01) daylight-saving changes, under five `TZ` zones, with local 17:20 times rejected; a full week has exactly two tournament slots.
  - **Results:** round-ordered ratings (the final gains 8 from updated ratings, where the frozen ratings would give 9), clamping and n − 1 rated bouts with distinct players per round; the 0-HP winner rule for both positions and in settlement; placement counts and amounts for 2, 3, 5 and 50 entrants; the two-person bracket; one stable grant identity per entrant across a replay; idempotent and conflicting result recording; fencing; graph tampering.

## Final commands

| Command | Result |
| --- | --- |
| `npm test` (baseline, before changes) | 17 files, **480 passed**. |
| `npm test` (final) | 18 files, **637 passed** (480 + 157). |
| `npm run typecheck` | **Fails before reaching Deno**, only on ignored stale files: `.next/types/validator.ts` and `.next/browser-test/dev/types/validator.ts` reference `src/app/expedition/page.js`, which this branch does not have. The files were generated at 09:12–09:15 today, before this session, by a build of another branch. I did not delete them. |
| Equivalent chain: `tsc --noEmit -p <scratch tsconfig>`, the repository config with `.next` excluded, then the exact `deno check --frozen … game-command/index.ts game-worker/index.ts` and `deno test --frozen … tests/backend/edge.deno.ts` | Exit 0: `tsc` clean, both entrypoints checked, Deno runtime 2 passed. |
| `npx deno check --frozen --config supabase/functions/deno.json supabase/functions/_shared/domain/tournament.ts` | Exit 0. No Edge entrypoint imports the module yet. |
| `git diff --check`, `git diff --cached --check` | Clean (only the configured LF-to-CRLF notices). |

The scratch tsconfig, mutation script and commit message files live in the session scratchpad, outside the repository. Nothing extra was staged.

## Phase 2 must do

1. **SQL source.** `supabase/sql/09-tournaments-seasons.sql` (tournament portion), or the next free number after the Task 10/16/18 sources, with guarded DDL and `CREATE OR REPLACE`. Private tables, with no client grants, for:
   - the immutable graph frame and entries;
   - one row per bout (result, log, reveal time), so bouts of one round commit concurrently;
   - the tournament seed (256-bit, server-side);
   - placement grant identities.
2. **Migration.** Generate it with the CLI after the Task 10/16/18 migrations (the plan's `M09a` alias is obsolete) using `db pull <name> --local --yes`. Follow the AGENTS.md completion check (ACLs, revokes, invoker views, trigger order, backfills, initialization). Run a clean reset/replay, compare the replay with the source, and record the path in `docs/operations/migrations.md`. Never edit a committed migration.
3. **Opt-in command.** `set_tournament_opt_in(actor_id, operation_id, input jsonb)` returns a receipt:
   - backend-only, security invoker, under the common account lock order;
   - receipt replay before validation; `processing` while the character is behind;
   - append an opt-in revision (enabled, receipt time read with post-lock `clock_timestamp`, commit order) and keep `tournament_opt_in` / `OwnerState.tournamentOptIn` as the current value;
   - wire the existing `set-tournament-opt-in` command validation (`backend/commands.ts`) to it.

   The boundary must pass `partitionTournament` the revisions effective at the cutoff, not the live column copied into the Task 7 snapshot, unless phase 2 proves the two can never differ.
4. **Boundary hook `private.boundary_pair(bigint)`** (Task 7 signature, shared with Task 16):
   - On every slot, run one fenced TypeScript pairing job, held by a `private.boundary_work` barrier. It runs `partitionTournament` and then `matchArena(partition.arena, …)`, so no entrant can be in both. SQL must not restate either rule.
   - Candidates come from activity snapshots:
     - entrant `fighter` = `makeFighter(snapshot.build, 'arena')`;
     - `rating` = the league-season rating;
     - `choice` = `snapshot.choice`;
     - `stamina` = `starting.stamina.current`;
     - `costs` = `snapshot.costs`;
     - the opt-in revisions.
   - Bracket activities become `resolved_kind = 'tournament'` with `stamina_debit = costs.tournament`. Debit once at phase 8. Persist the graph immutably.
5. **Jobs** (`private.activity_executor_ready('tournament')`, `private.prepare_activity_jobs(uuid)`):
   - One simulation job per fought bout, combat batch limit 5. No job simulates more than one bout.
   - Child bouts depend on their parents through `private.job_dependencies`. Byes need no job.
   - Job input is immutable, so a child's input should be its bout id. The executor derives its `BoutJob` from the committed graph (`readyBouts`) under the lease and runs `runBout(job, names)` with character names.
   - Retries reuse the bout seed and snapshots.
   - Round reveal jobs run at `revealAtMs`. Each entrant activity's settlement job at minute 80 depends on every bout and reveal.
   - Add the executor to the v1 registry, dispatching by kind; no second runner.
6. **Result fence.** `private.accept_job_result` or a `commit_tournament_bout` RPC:
   - lock first, then sample `private.planning_now_ms()` and verify the current token, status and expiry (the AGENTS.md concurrency override);
   - apply `recordBout`'s semantics as a compare-and-set on the bout row: null to result, or an identical idempotent replay, otherwise a conflict;
   - never publish a private result before its reveal.
7. **Reveals and stages.** Publish only due events. Each entrant activity gets a staging stage, one stage per bout it fights (with the log, labelled from that entrant's `winnerId` perspective) and a minute-80 return/settlement stage. An eliminated entrant stays in the tournament activity until minute 80 and never opens another activity in the slot. Bump the Task 10 revision on reveals.
8. **Settlement.** `private.settle_rewards(uuid)` for `tournament`, from `tournamentOutcomes`, gives `{rewards, result, success, replayExpiry, ratingDelta}` (the applied total):
   - The placement grant id is the unique ledger identity, settled once, with no second grant path alongside M06.
   - Apply the round-ordered ratings exactly once per entrant under the common lock order. Write each entrant's `ratingAfter` from the full graph rather than re-deriving per activity.
   - Count human wins and losses per fought bout, never byes, for `StandingRow`.
   - Cover simultaneous settlement retries.
9. **Projection.** Build `TournamentView` as described under "Public projection", including the role-safe placements DTO and the `insufficient-entrants` status.
10. **DB tests in `tests/db/tournaments.test.ts`:**
    - the Step 1 table through real SQL and jobs, for 0, 1, 2, 3, 5 and 50 entrants in each league;
    - opt-in at the cutoff ±1 ms with the rollback-only clock;
    - opt-out and insufficient stamina;
    - bye paths;
    - a stalled child job held by its dependency;
    - a lease retry with the same seed;
    - full HP per bout;
    - placement counts and amounts, and the two-person bracket;
    - frozen builds after a mid-tournament build change;
    - access denial for the graph, seeds and unrevealed results;
    - stage due-ness;
    - the AGENTS.md lease-expiry regression;
    - migration-only replay parity.
11. **Open dependencies.** Season identity (`seasonId`) is open until Task 21. Participant names in PvP logs are shared with Task 16. Task 20 (Claude, UI) waits for the reviewed Task 19 wire and needs exact contract notifications before any edit.

No reusable skill change is proposed from this work: the TDD, verification and project migration guidance already cover it. The controller may want to note one possible operational lesson. A worktree reused across branches can carry stale ignored `.next` validators that fail `npm run typecheck`. Any change to standing guidance would need Avi's approval.
