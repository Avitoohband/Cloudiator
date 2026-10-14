# Task 16 phase 1 report: pure Arena domain

Status: **DONE**. The pure domain module and its unit tests are complete and verified. An independent review found specification Pass and code quality Pass, ready to merge with fixes; those fixes are applied and verified below. Phase 2 (database, worker, settlement, projections) is still to do. Its plan, now including the reviewer's rulings, is at the end. One balance question that comes from the spec is open with Avi (see "Balance note"). Two phase-2 design points are also open, neither built nor tested: the fighter and NPC template comparison target for pairing acceptance (phase 2 item 6) and the battle-seed derivation (item 7).

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-arena`, branch `claude/task-16`.
- Task base: **`62f24cc`**, Codex's reviewed Task 9 checkpoint. Branch start: `b8ac1ce`, the controller brief.
- Source commit: **`270deb9`**, `feat: add pure Arena league, pairing and rating rules`.
- Review-fix commit: **`a60eeb2`**, `fix: apply Task 16 phase 1 review findings`.
- Scope: [task-16-claude-dispatch.md](task-16-claude-dispatch.md) and [task-16-brief-base.md](task-16-brief-base.md).
- Not done here, by instruction: no Supabase, Docker or database commands, no browser tests or dev server, no push or merge, no edits to `HANDOFF.md`, and no subagents. The other checkouts (`Cloudiator`, `Cloudiator-claude`, `Cloudiator-replay`) were not touched.

## Files

| Path | Change |
| --- | --- |
| `supabase/functions/_shared/domain/arena.ts` | New. All phase 1 functions and the types they return. |
| `supabase/functions/_shared/domain/combat.ts` | Additive exports only, in `270deb9`; behavior is unchanged (see below). The review fixes did not touch it. |
| `tests/domain/arena.test.ts` | New. 121 cases: 114 in `270deb9`, plus 7 from the review fixes. |

`rules-v1.ts` and `types.ts` are unchanged. Task 2 had already versioned every constant phase 1 needs: league thresholds and weights, `referenceAgility`, renown amounts, the NPC factor 0.85, `maximumStrengthRatio` 2, `recentPairingSlots` 18, and Elo `k`, scale, initial rating and minimum. No second stats, damage or price table was added.

## Interfaces

All functions are pure and deterministic. A malformed input throws `RangeError`. Outputs are frozen copies, and caller objects are never frozen or mutated.

Rules come from one place:
- A retained registry holds only `v1`, so a fighter frozen under any other version fails closed.
- Every function that receives fighters takes its rules from them. A pairing or bout whose fighters carry different rules versions is rejected (`Arena fighters must share one rules version`).
- `leagueFor`, `ratingDelta` and `applyRatingDelta` receive no fighter, so they take an optional `rules` argument that defaults to `RULES_V1`.

| Export | Contract |
| --- | --- |
| `leagueFor(level, earnedPoints, gearHistory, rules = RULES_V1): LeagueId` | Index = `2 × level + floor(earned / 5) + floor(gearHistory / 10)`. In v1, below 25 is Bronze, 25–59 Silver, 60–119 Gold, 120 and above Champion. `earnedPoints` counts every point ever earned, including the starting 10 and banked points. `gearHistory` is Task 8's monotonic `historicalGearScore` (stored as `peakStrength`). The current loadout is not an input. Weights, thresholds and input limits come from `rules`. Valid v1 input: level 1 to 1e9; earned points 10 to 1e9; gear history finite and ≥ 0. |
| `estimateArenaStrength(fighter): number` | Maximum health × expected outgoing damage per second. Expected damage per attack = `baseDamage × efficiency × outgoing stance × hitProbability(precision, 5) × (1 + (1.5 − 1) × criticalProbability(precision))`, then × `1000 / attackIntervalMs`. The two probabilities are the engine's own formulas, normalised to 12 significant digits. This removes their floating-point error: the engine's Precision 17 hit probability is `0.7699999999999999` for the exact 0.77. Every factor is then an exact decimal, and the result is rounded once, half-up, to hundredths. The reference target has armor 0 and incoming stance ×1, so the fighter's own armor does not count. The input must be an **arena** `makeFighter` snapshot, whose `baseDamage` already includes the bound weapon bonus. |
| `makeFallback(fighter): FighterSnapshot` | Copies attributes, arena armor, `attackIntervalMs`, `efficiency`, `weaponDamage`, equipment silhouettes and `rulesVersion` unchanged. Sets stance `balanced` and `classId: null`. `maxHealth` = `floor(0.85 × maxHealth)`, at least 1. `baseDamage` = `0.85 × baseDamage`, computed exactly. |
| `matchArena(entrants, recent, seed): ArenaAssignment[]` | Pairs within each league, processing leagues from Bronze to Champion. The rules (window, cap, rating floor) are derived once from the entrants' fighters. Details under "Pairing" below. |
| `ratingDelta(winnerRating, loserRating, rules = RULES_V1): RatingDelta` | `{ winner: gain, loser: -gain }`, where `gain = round(K × (1 − 1 / (1 + 10^((loser − winner) / scale))))`; v1 has K = 24 and scale 400. A zero loss is returned as positive zero. |
| `applyRatingDelta(winnerRating, loserRating, rules = RULES_V1): RatingUpdate` | `{ winner, loser, applied }`: the new ratings, each clamped at the rules minimum (v1: 0), plus `applied`, the change each rating actually received. Example: (0, 5) gives `{12, 0, applied {12, −5}}`. |
| `arenaOutcomes(assignment, log): ArenaOutcome[]` | One outcome per side, in assignment order: `{gladiatorId, activityId, result, success, rewards: CreditedRewards, ratingBefore, ratingAfter, ratingDelta}`. The winner is `log.winnerId`, which includes a seeded winner of a simultaneous defeat at 0 HP. Human bout: win 10 renown, loss 2, clamped Elo from the frozen side ratings. NPC bout: win 3, loss 0, `ratingDelta` 0. Never XP, money, points or items. Rejects an assignment whose fighters (both sides, or the side and the NPC template) are not all valid under one retained rules version. Rejects a log whose battle ID, rules version, participant set, participant `gladiatorId` or winner does not match: a human must be logged with its own `gladiatorId`, the NPC with `null`. |

### Pairing (`matchArena`)

- **Sort order.** Strength (cents) descending, then rating descending, then a seeded per-entrant key `seededRandom(`${seed}:arena:${gladiatorId}`)()`, then `gladiatorId` in code-unit order.
- **Choosing an opponent.** The first unpaired entrant takes the eligible opponent with, in order:
  1. the smallest strength gap;
  2. the fewest pairings in slots S − 18 to S − 1;
  3. the smallest rating gap;
  4. the seeded key.

  Both are then removed and pairing continues.
- **Eligibility.** A pair is ineligible when the larger strength exceeds 2 × the smaller, compared in integer hundredths. Exactly 2× is allowed.
- **Leftovers.** Each entrant left without an opponent gets an NPC assignment.
- **Input requirements.** All entrants must share one `slotIndex`, one `seasonId` and one rules version. Gladiator IDs and activity IDs must be unique.

### Types

Defined beside `matchArena`:
- `ArenaEntrant` = `{gladiatorId, activityId, seasonId, league, slotIndex, rating, fighter}`.
- `PairingHistory` = `{slotIndex, gladiatorIds: [a, b]}`, one row per earlier human bout.
- `ArenaSide` = `{gladiatorId, activityId, rating, strength, fighter}`.
- `ArenaAssignment`, one of:
  - `{kind:'human', battleId, seasonId, league, slotIndex, sides:[ArenaSide, ArenaSide]}`;
  - `{kind:'npc', battleId, seasonId, league, slotIndex, sides:[ArenaSide], opponent:{id, snapshot}}`.

Assignments reference each entrant's activity (`activityId`) and a whitelisted copy of its frozen arena fighter. The NPC opponent's `makeFallback` snapshot is generated once, in the assignment.

### `combat.ts` exports

- Newly exported, unchanged: `Fraction`, `decimal`, `multiply`, `fractionValue`.
- Extracted from existing code: `hitProbability(precision, defenderAgility, rules)`, `criticalProbability(precision, rules)` and `validFighter(snapshot, rules)`.
- `attack()` and `validateParticipant()` now call these with the same expressions, the same evaluation order (`random()` is still drawn before the probability) and the same short-circuiting.
- Evidence that behavior is unchanged, all re-run after the refactor:
  - the Task 3 combat suite;
  - the Task 9 expedition suite;
  - the byte-for-byte replay-fixture regeneration test.

## Decisions (reviewed)

The spec leaves these open. The reviewer accepted them; the rulings that change phase 2 are folded into its plan.

1. **Highest strength (then highest rating) is processed first.** The spec gives no sort direction. With an odd count, this means the weakest unpaired entrant usually gets the NPC. Tests pin it: weakest-first processing fails 4 tests. See the "Balance note" for the spec-level consequence.
2. **Strength is rounded to hundredths, once, half-up, from exact decimals.** This follows the project's two-decimal convention and the combat engine's single final rounding. The 2× check and the nearest-strength comparison use integer hundredths, so the exact 2× boundary is well defined. The hit and critical probabilities are the engine's formulas, normalised to exact decimals (review fix M1). The engine itself still uses its own, unnormalised probabilities.
3. **Recent-pairing window.** Pairings in slots S − 18 to S − 1 count, from any league or season. Older rows are ignored. A row at the current slot or later is rejected as corrupt input.
4. **Seeded tie-break.** Each entrant gets one seeded key, used for both the sort and opponent ties. Results therefore do not depend on input order (tested with reversed and cloned inputs).
5. **Fallback details.** Health is floored, matching the spec's health rule, and is at least 1. `classId` is null, as for expedition creatures. `weaponDamage` and silhouettes are copied unchanged, because the spec overrides only health and base damage. `weaponDamage` is display-only in combat (see the notes for Task 17 and Task 14).
6. **Battle IDs.** A human bout uses `arena:<slot>:<first>:<second>` (participant order) and is shared by both entrants. An NPC bout uses `arena:<slot>:<gladiatorId>:npc`. In the battle log, a human participant's ID is its `gladiatorId`. The NPC participant's ID is `npc:<gladiatorId>` with `gladiatorId: null`, as the dispatch specifies.
7. **Ratings in `arenaOutcomes` come from the frozen assignment.** They should equal the live rating rows, because:
   - a character has at most one Arena activity per slot;
   - the previous slot settles before the next boundary takes its snapshot (§4.1).

   Reviewer ruling: phase 2 asserts that equality under lock and fails closed to operator state if it does not hold. Each side may settle on its own under its own account lock. Its owner-only `ratingDelta` is `applied`, the change after clamping.
8. **Return types.** `matchArena` freezes each assignment but returns an ordinary array, so its declared return type `ArenaAssignment[]` stays accurate. It accepts readonly input arrays, which is a widening of the plan's parameter types.

## RED and GREEN

### Phase 1 (`270deb9`)

Each cycle wrote its tests first. Each Vitest run used `npx vitest run tests/domain/arena.test.ts` (filtered with `-t <block>` where noted) and ran in the default sandbox without escalation.

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| A, `leagueFor` | The suite failed to load: `Cannot find package '@domain/arena.ts'`. Then a placeholder that always returned `'bronze'` gave **28 failed / 5 passed of 33** (the passes were 4 Bronze rows and the monotonic loop). | 33/33 |
| B, Elo | `-t "Elo"`: **16 failed**, `ratingDelta`/`applyRatingDelta is not a function`. | 49/49 |
| C, strength | `-t "strength estimate"`: **18 failed**, `estimateArenaStrength is not a function`. After the `combat.ts` export refactor, the combat, expedition and replay-fixture files passed **66/66**. | 67/67 |
| D, fallback | `-t "NPC fallback"`: **11 failed**, `makeFallback is not a function`. | 78/78 |
| E, pairing | First run: 30 failed, but **2 failed on test-fixture preconditions**, which do not count as RED: the roster spread was 2.03×, and three-entrant weakest × 2 was below the strongest. A temporary, deleted probe measured the strengths, and the fixtures were adjusted (roster Vitality `(i × 2) % 4`; the weakest of the three got Strength 3). Rerun: **30 failed**, only because `matchArena` is missing. | 108/108 |
| F, outcomes | **6 failed**, `arenaOutcomes is not a function`. `npm run typecheck` then reported TS2532 (a union tuple not narrowed); the human branch now uses the narrowed `assignment.sides`. | 114/114 |

Mutation checks after cycle E. Each mutation was applied to `arena.ts`, run, then restored from a copy (`diff -q` confirmed the restore):

| Mutation | Arena tests failed |
| --- | --- |
| Process weakest first | 4 |
| Drop rating from the sort | 1 |
| 19-slot window | 1 |
| 17-slot window | 1 |
| Strict `<` 2× check | 1 |
| Ignore recent history | 2 |

The half-cent cases (733.075, 1319.535, 1612.765) were chosen because a Node computation of the plain floating-point product gives `733.0749999999999`, which rounds down. This was a calculation, not a mutation run.

### Review fixes (`a60eeb2`)

The review's Important finding (I1) and its rulings concern the phase 2 plan and are applied in the plan below. The code findings were fixed test-first:

| Finding | Change | RED (observed) | GREEN |
| --- | --- | --- | --- |
| M1, strength not fully exact-decimal | Normalise the engine's hit and critical probabilities to 12 significant digits before the exact-decimal product; docstring corrected. | New test (berserker, Balanced, Precision allocation 12, so effective 17; Agility 2; `sword:1:renown`; exactly 808.885): **1 failed**, `expected 808.88 to be 808.89`. | 116/116 |
| M2, rules sourced two ways | Optional `rules = RULES_V1` on `leagueFor`, `ratingDelta` and `applyRatingDelta`. `matchArena` derives its rules once from the entrants, rejects mixed versions, and reads the window, the 2× cap and the rating floor from them. `arenaOutcomes` passes its rules to Elo. | **3 failed**: `expected 'bronze' to be 'silver'` (custom thresholds ignored); `expected { winner: 12, loser: -12 } to deeply equal { winner: 16, loser: -16 }` (custom K ignored); mixed versions threw `Invalid arena fighter snapshot` instead of matching `/share one rules version/`. | 119/119 |
| M3, partial `arenaOutcomes` checks | Validate every fighter of the bout under one rules version (both sides, or the side and the NPC template). Check each logged participant's `gladiatorId`. | **2 failed**, `expected function to throw an error, but it didn't`: a corrupt second-side fighter and a human logged with `gladiatorId: null` were accepted. | 121/121 |
| M5, own armor pin | Test only: bound renown armor 7.315, no armor, and armor 60 all give 892.32. | A pin of existing behavior, so no RED. A temporary mutation (estimate × `(1 + armor / 100)`) failed it, together with 5 armor-bearing tests; restored, `diff -q` clean. | 121/121 |
| M5, respec pin | Test only. The banked-points test now walks bank → spend → paid respec → paid respec back to banking. It asserts each legal state's allocated plus banked points recover the earned 125, and that placement never drops below Silver. | A pin, so no RED. The first run failed on a **fixture precondition**, not counted as RED: the fixture's Endurance 2 made the "spend" step a paid respec (`expected 100 to be +0`). The fixture was corrected. A temporary mutation (counting only allocated points) failed it; restored, `diff -q` clean. | 121/121 |

M1 measurements:
- The reviewer found 5 of 17,712 real builds rounding the other way.
- A temporary probe in the session scratch directory (since deleted) covered a wider set: 106,272 real catalog builds (3 classes, 3 stances, 48 weapons, Precision allocations 0–40, three Agility and two Strength values). It compared the estimate with an independent exact-rational restatement used only for this check: **26 mismatches before the fix, 0 after**.
- The probe is evidence for the tested build set, not a proof for every possible snapshot. Normalising to 12 significant digits is exact while the true probability has at most 12 significant digits; v1 probabilities have at most five decimals.

## Coverage

- **Plan Step 1:**
  - `leagueFor(1, 10, 0)` is Bronze and `leagueFor(5, 25, 100)` is Silver.
  - `matchArena(twoEntrantsWithStrengthRatio(2.01), [], 's')` gives NPC assignments only.
  - `ratingDelta(1000, 1000)` equals `{12, −12}`.
  - The `db.settleNpcWin` assertion is phase 2; its pure part is covered by the NPC outcome test (3 renown, `ratingDelta` 0).
- **Pairing edge cases (Step 4, no database):**
  - no entrants, one, 3/5/7 (odd), and 50 real catalog builds;
  - exactly 2× (1466.15 against 2932.30) pairs, while 2932.31 gets the NPC;
  - repeat pairings across 18 slots, with S − 18 counted and S − 19 dropped;
  - complete ties are seeded and stable across calls and input orders;
  - no cross-league pairs;
  - mixed rules versions are rejected.
- **League placement:**
  - thresholds at 24/25, 59/60 and 119/120, crossed by each input;
  - banked points count, and a sequence of respecs (including one back to banking) never lowers placement;
  - monotonic in each input;
  - a weak current loadout stays in its historical league (history 135.2 → Gold; current gear 0 would give Silver);
  - thresholds, weights and limits come from the `rules` argument.
- **Strength estimate:**
  - hand-derived real builds;
  - stances, overload and the engine's clamps;
  - a bound weapon of 6.65 → 7.315 gives 775.04, where early rounding would give 775.43; the expedition snapshot gives 723.83;
  - the exact half cent at Precision 17 (808.885 → 808.89), while the engine's own probability stays `0.7699999999999999`;
  - the fighter's own armor does not change the estimate.
- **Fallback, against real `makeFighter` snapshots:**
  - bound armor stays at 7.315 and a 20.5 hit deals 18;
  - overload efficiency is applied once (damage 7, not 5);
  - health is floored;
  - the template is valid for the engine;
  - at least 1 HP.
- **Elo:** asymmetric cases, a positive-zero zero gain, clamping at 0, safe-integer limits, and K, scale and floor from the `rules` argument.
- **Outcomes:**
  - real engine bouts, including a 0-HP simultaneous defeat for both a human bout and an NPC bout;
  - every fighter of the bout validated under one rules version;
  - participant `gladiatorId` checked (own ID for a human, `null` for the NPC).

## Final commands

| Command | Result |
| --- | --- |
| `npm test` (baseline, before phase 1) | 16 files, **366 passed**. |
| `npm test` (phase 1, `270deb9`) | 17 files, **480 passed** (366 + 114). |
| `npm test` (review fixes, `a60eeb2`) | 17 files, **487 passed** (480 + 7). |
| `npm run typecheck` (review fixes) | Exit 0: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, Deno runtime 2 passed. |
| `npx deno check --frozen --config supabase/functions/deno.json supabase/functions/_shared/domain/arena.ts` | Exit 0. No Edge entrypoint imports the module yet. |
| `git diff --check`, `git diff --cached --check` | Clean. |

Environment slips, all cleaned up:
- Phase 1: a stray `cat > /tmp/probe.test.ts` waited on stdin until stopped. It left an empty file in the system temp directory, which was deleted.
- Phase 1: the temporary probe `tests/domain/zz-probe.test.ts` and a typecheck log outside the repository were also deleted.
- Review fixes: the first typecheck after the M3 tests reported TS18048 and TS2352 in the new test code. The tests now narrow the assignment and build the participant tuple explicitly.
- Review fixes: Git Bash `sed -i` rewrote `arena.ts`'s working-copy line endings to LF. CRLF was restored; the committed content is unaffected (`core.autocrlf=true`).

Nothing extra was staged.

## Balance note

This is raised with Avi by the controller. The pairing order is unchanged pending his decision.

- The spec's greedy rule (§8.1) pairs from the top of the sorted list, and phase 1 sorts strongest first (decision 1).
- Take a league whose roster and strengths stay stable and whose entrant count is odd. The weakest entrant is left over in every such slot and gets the NPC.
- Recent-pairing counts only break ties between equally near opponents, so they do not rotate who is left over.
- That entrant may never reach the five human bouts in a league and season that season rewards require (§8.3).
- Processing weakest first would only move the problem to the strongest entrant. The cause is the spec's greedy rule, not the sort direction.

## Notes for Task 17 (UI) and Task 14 (replay)

- **Fallback `weaponDamage`.** The NPC fallback keeps the player's `weaponDamage` (copied unchanged, decision 5) while dealing 85% of the player's base damage. A replay or profile UI must not derive damage from a combatant's `weaponDamage`; use each attack's logged `damage`.
- **NPC IDs.** The Task 14 replay fixture names its NPC `npc:fallback:<activityId>` (`tests/domain/replay-fixtures.test.ts:58`, `tests/fixtures/battles/npc.json`; `tests/domain/battle-stage.test.ts` uses `npc:fallback:1`). Production Arena logs use `npc:<gladiatorId>`. A UI must identify the NPC by `gladiatorId: null`, never by parsing its ID.
- **Fixture fallback.** Task 14's reserved `tests/domain/replay-fixtures.test.ts` keeps its own stand-in `npcFallback` (a floating-point × 0.85). The replay or UI owner may switch it to `makeFallback`. Phase 1 did not touch it.

## Phase 2 must do

The reviewer's Important finding I1 corrected the earlier version of this list. That version both copied each activity's snapshot seed onto its jobs and had both activities of a pair share one simulation. Each activity has its own seed in `activity_snapshots`, and `supabase/sql/03-activities-jobs.sql:249-250` says every job of an activity carries that activity's seed. Followed literally, the two sides of one bout would be simulated with different seeds, get different logs, and could both be credited a win. Item 7 replaces that with one simulation per battle under a private battle seed.

1. **SQL source.**
   - `supabase/sql/07-arena.sql`, or the next free number after Task 10's `06-projections.sql`, with guarded DDL and `CREATE OR REPLACE`.
   - Its header must document every accepted exception, as Task 9's `05-expeditions.sql` header documents the accepted exhausted-lease lock-order exception. That includes the battle-seed exception in item 7.
2. **Migration.**
   - Generate it with the CLI (`db pull <name> --local --yes`) after Task 10's migration. Never hand-name or edit a committed migration.
   - Follow the AGENTS.md completion check (ACLs, revokes, invoker views, trigger order, backfills).
   - Run a clean reset/replay, compare the replay with the source, and record the path in `docs/operations/migrations.md`.
3. **Season identity: agree it with Codex (Task 21) now.**
   - Persist a minimal season epoch once: the first slot boundary of the public launch (§8.3).
   - Derive the season index as `floor((activity slot − epoch slot) / 504)`. A bout belongs to the season that contains its activity's start.
   - Every entrant needs a `seasonId` from this in phase 2. Task 21 then adds season close, archives and rewards on the same epoch, not on a second definition.
4. **League placement: `private.boundary_recompute_leagues(bigint)`, phase 4.**
   - Promote from `leagueFor(level, earnedPoints, peakStrength)`, computed in TypeScript; SQL must not restate the formula.
   - One route is an additive `league` in `PreparationResult` from `prepareActivityV1`, validated by `complete_job`.
   - Placement must never decrease. Entering a new league starts that league-season rating at 1000 and keeps the old record.
5. **Ratings model and visible strength.**
   - Rating rows: one per `(character, league, season)`, starting at 1000, with a floor of 0. Human win and loss counters feed `StandingRow`; NPC bouts are excluded.
   - Reconcile `public.gladiators`' single `rating` and `league` columns (`supabase/sql/01-identity.sql:18` for `league` and `:20` for `rating`, frozen into the snapshot's `starting` at `03-activities-jobs.sql:380`) with those rows.
   - Decide:
     - whether the columns become a cache of the current league-season row or are replaced;
     - which value the snapshot freezes as `starting.rating`;
     - what `OwnerState.progression` (`league`, `rating`) and `PublicActor.league` show.
   - Decide who exposes current combat strength (§8.1, "visible separately"; `PublicProfile.combatStrength`): which task computes it from the current build's arena fighter with `estimateArenaStrength`, and which projection publishes it.
6. **Pairing inside the boundary: `private.boundary_pair(bigint)`, phase 7.**
   - **Pattern.** Follow phase 4's `boundary_recompute` (`03-activities-jobs.sql:331-348`):
     - Insert one fenced pairing job per slot and league, with dedupe key `pair:<slot>:<league>` and its own private job seed.
     - Return a wait value while any pairing job is pending, and `'operator'` if one failed.
     - Once all are complete, adopt the results.
   - **Worker.** Runs `matchArena` with:
     - entrants built from `activity_snapshots`: the fighter is `makeFighter(snapshot.build, 'arena', rules)`, plus `starting.league` and `starting.rating` (or the reconciled rating row, item 5);
     - the `PairingHistory`;
     - the job's private seed.
   - **History.** One row per earlier human bout in slots S − 18 to S − 1, in any league or season. Human tournament bouts count, one row per bout; coordinate with Task 19.
   - **Acceptance (`complete_job`).** Accept a result only if:
     - every entrant of that slot and league appears exactly once, with the same slot, season and league;
     - each fighter, and each NPC template, equals a recomputation from its frozen snapshot.

     **Open phase-2 design point (not built or tested): the comparison target.** SQL must not restate `makeFighter` or `makeFallback`, so the target for both the fighter and the NPC template must itself come from canonical TypeScript. For example, the phase 4 preparation could freeze an additive arena fighter with the snapshot, together with its `makeFallback(arenaFighter)` NPC template, and acceptance compares the pairing result with both frozen values; or the NPC template is checked against another value frozen by TypeScript.
   - **Storage.** Write immutable `private.arena_assignments` rows, one per battle, with no client grants and `guard_frozen`. Each row includes the battle seed (item 7).
   - **Schema work this needs:**
     - add `'pair'` to the `private.jobs.kind` check constraint;
     - relax `jobs.gladiator_id NOT NULL` for per-league jobs, keeping its foreign key for non-null values, with a check that only pairing jobs may omit it;
     - extend `JobKind`, `WorkerReport.byKind`, and the coordinator's dispatch counts and claim caps (`03-activities-jobs.sql:543,714`, `05-expeditions.sql:302,431`), deciding whether pairing counts as simple or combat work;
     - add `'pair'` to `public.claim_jobs`' kind whitelist (`03-activities-jobs.sql:538`, `05-expeditions.sql:298`);
     - give `public.complete_job`'s kind branch (`05-expeditions.sql:341-344`) its own `'pair'` case; otherwise a pairing result falls into `private.accept_job_result`;
     - add `'pair'` to `runWorker`'s claim order (`supabase/functions/_shared/backend/jobs.ts:110` claims settlement, prepare, then reveal as simple work; `:119-120` claims simulations only when no simple job was claimed), matching the simple-or-combat decision;
     - if `boundary_pair` introduces a new wait value, add it to `boundaries_wait_reason_check` (`03-activities-jobs.sql:81`);
     - add a `v1` registry entry for the pairing executor.
   - **Timing.** Measure the extra pairing round trip (insert, dispatch, claim, complete, adopt) against the two-minute boundary target at 50 characters (§10.4).
7. **One simulation per battle, under a private battle seed.**
   - **Seed.** Each assignment stores a private per-battle seed derived from the pairing job's seed and `battleId`. **Open phase-2 design point (not built or tested): the derivation.** For example, `encode(extensions.digest(<pairing seed> || ':' || battleId, 'sha256'), 'hex')`, computed by SQL when the assignment is written, so a retry reproduces it.
   - **Job.** Exactly one simulation job per battle:
     - dedupe key `arena:<battleId>`;
     - anchored to the first side's activity (`sides[0]`'s `activity_id` and `gladiator_id`);
     - carrying the battle seed and the frozen assignment.

     An NPC bout has the same shape with one side.
   - **Preparation.** `private.activity_executor_ready('arena')` returns true. For an Arena activity, `private.prepare_activity_jobs(uuid)`:
     - creates that activity's own reveal and settlement jobs, which keep the activity seed as today;
     - creates the battle's simulation job idempotently (`on conflict (dedupe_key) do nothing`);
     - makes both the reveal and the settlement job depend on the simulation through `private.job_dependencies`, which already works across activities.
   - **Documented exception.** The SQL header records the exception to the per-activity seed invariant (`03-activities-jobs.sql:249-250`): an Arena simulation job carries its battle's seed, not its anchor activity's.
   - **Acceptance.** `private.accept_job_result(uuid, jsonb)` is fenced, with post-lock time, token and status checks. Today it rejects every non-expedition activity (`05-expeditions.sql:199`), and `public.commit_expedition_plan` admits only expedition simulations (`05-expeditions.sql:250`). It needs an Arena branch that:
     - validates the log against the assignment, with the checks `arenaOutcomes` makes (battle ID, rules version, participants and their `gladiatorId`, winner);
     - freezes the log once, for both activities.
8. **Worker executor.**
   - The `v1.simulation` executor (`supabase/functions/_shared/backend/jobs.ts:37`) always calls `planExpedition`. Dispatch on an explicit discriminator in the job input: existing expedition jobs carry the snapshot's `choice.kind: 'expedition'`, and Arena jobs get a new explicit kind. Fail any unknown kind with `unsupported-executor`.
   - The Arena branch runs one `simulateBattle` with the assignment's `battleId` and battle seed.
   - Participant IDs: a human uses its `gladiatorId` (also as `gladiatorId`); the NPC uses `opponent.id` with `gladiatorId: null` and the frozen fallback snapshot.
   - Reuse `private.job_dependencies` (simulation → reveal → settlement) and the combat batch limit of 5; do not add a second runner.
9. **Settlement.** Each side settles through its own activity's `private.settle_rewards(uuid)` and the whitelisted outcome `{rewards, result, success, replayExpiry, ratingDelta}`.
   - **Outcome.** Build it from `arenaOutcomes`:
     - renown only;
     - `ratingDelta` = the applied change;
     - NPC bouts give `ratingDelta: 0`;
     - the winner is decided by `winnerId`.
   - **How `arenaOutcomes` reaches settlement.** `private.settle_rewards(uuid)` (`03-activities-jobs.sql:270`, called for every non-expedition kind at `05-expeditions.sql:392`) is SQL-only, so the TypeScript `arenaOutcomes` cannot run inside it. For example:
     - the Arena simulation executor returns the log plus both outcomes, `arenaOutcomes(assignment, log)`;
     - `private.accept_job_result` validates their shape, renown, winner and before-ratings against the assignment, and stores them with the frozen log;
     - each side's `settle_rewards` reads its own stored outcome.

     The alternative is a `settle_expedition`-style prepared input: the worker reads a settlement input (as `public.expedition_settlement_input` at `05-expeditions.sql:255`), computes that side's outcome in TypeScript, and passes it to a prepared-settlement RPC (as `public.settle_expedition(uuid,uuid,jsonb)` at `05-expeditions.sql:412`, called from `supabase/functions/_shared/backend/database.ts:180`), which SQL checks under the settlement lock. Neither route is built or tested.
   - **Locking.** Each side may settle on its own, under its own account lock and the common order: account advisory lock, then character, wallet and sorted items, then activity, then job. Its new rating depends only on the frozen pair ratings, so no cross-account lock is needed.
   - **Rating check.** Under its own lock, each side compares only its own frozen rating in the assignment with its own live league-season rating row, never the opponent's. The first settlement of a human bout moves that side's row, so checking both sides would make the second settlement fail. If a side's own values differ, fail closed to operator state rather than using either value.
   - **Tests.** Cover simultaneous settlement retries of both sides and the malformed-hook rollback.
10. **Public Arena stage sequence** (mirrored by Task 17):
    - stage 0, `staging`: revealed at S, ending S + 60 min, label `Warming up`;
    - stage 1, `bout`: revealed at S + 60 min with the log, label `Bout: victory` or `Bout: defeat` from that entrant's `winnerId` perspective;
    - stage 2, `return`: zero-length at S + 80 min, label `Results credited`.

    Warm-up grants no training points. Rewards and ratings arrive at minute 80.
11. **Standings.** Public standings and ratings; private wallets and loot stay owner-only. Wire them through Task 10's projection and revision hooks.
12. **DB tests in `tests/db/arena.test.ts`:**
    - `db.settleNpcWin()` matches `{renown: 3, ratingDelta: 0}`;
    - sold, unequipped and renown gear history;
    - respec and banked-point promotion at a boundary only;
    - simultaneous settlement retry;
    - no cross-league bouts;
    - both sides of a human bout reveal the same log, and exactly one is credited the win;
    - pairing job wait, operator and adopt states, and rejection of a result that omits, duplicates or alters an entrant or fighter;
    - a frozen/live rating mismatch goes to operator state;
    - the second side of a human bout settles after the first side has already moved its rating row, because each side compares only its own frozen rating;
    - access denial for private plans, assignments and seeds, including battle seeds;
    - stages appear only when due;
    - migration-only replay parity.

    Also add a backend unit test: an unknown simulation input kind fails with `unsupported-executor`.

No reusable skill change is proposed. The existing TDD, verification and migration guidance already covers this work.
