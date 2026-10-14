# Task 16 phase 1 report: pure Arena domain

Status: **DONE_WITH_CONCERNS**. The pure domain module and its unit tests are complete and verified. Phase 2 (database, worker, settlement, projections) is still to do; its list is at the end. The concerns are the design decisions below that the spec leaves open, which the reviewer should confirm.

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-arena`, branch `claude/task-16`.
- Task base: **`62f24cc`**, Codex's reviewed Task 9 checkpoint. Branch start: `b8ac1ce`, the controller brief.
- Source commit: **`270deb9`**, `feat: add pure Arena league, pairing and rating rules`.
- Scope: [task-16-claude-dispatch.md](task-16-claude-dispatch.md) and [task-16-brief-base.md](task-16-brief-base.md).
- Not done here, by instruction: no Supabase, Docker or database commands, no browser tests or dev server, no push or merge, no edits to `HANDOFF.md`, and no subagents. The other checkouts (`Cloudiator`, `Cloudiator-claude`, `Cloudiator-replay`) were not touched.

## Files

| Path | Change |
| --- | --- |
| `supabase/functions/_shared/domain/arena.ts` | New. All phase 1 functions and the types they return. |
| `supabase/functions/_shared/domain/combat.ts` | Additive exports only; behavior is unchanged (see below). |
| `tests/domain/arena.test.ts` | New. 114 cases. |

`rules-v1.ts` and `types.ts` are unchanged. Task 2 had already versioned every constant phase 1 needs: league thresholds and weights, `referenceAgility`, renown amounts, the NPC factor 0.85, `maximumStrengthRatio` 2, `recentPairingSlots` 18, and Elo `k`, scale, initial rating and minimum. No second stats, damage or price table was added.

## Interfaces

All functions are pure and deterministic. A malformed input throws `RangeError`. Rules are looked up through a retained registry that holds only `v1`, so a fighter frozen under any other version fails closed. Outputs are frozen copies, and caller objects are never frozen or mutated.

| Export | Contract |
| --- | --- |
| `leagueFor(level, earnedPoints, gearHistory): LeagueId` | Index = `2 × level + floor(earned / 5) + floor(gearHistory / 10)`. Below 25 is Bronze, 25–59 Silver, 60–119 Gold, 120 and above Champion. `earnedPoints` counts every point ever earned, including the starting 10 and banked points. `gearHistory` is Task 8's monotonic `historicalGearScore` (stored as `peakStrength`). The current loadout is not an input. Valid input: level 1 to 1e9; earned points 10 to 1e9; gear history finite and ≥ 0. |
| `estimateArenaStrength(fighter): number` | Maximum health × expected outgoing damage per second. Expected damage per attack = `baseDamage × efficiency × outgoing stance × hitProbability(precision, 5) × (1 + (1.5 − 1) × criticalProbability(precision))`, then × `1000 / attackIntervalMs`. The reference target has armor 0 and incoming stance ×1. Every factor is an exact decimal, and the result is rounded once, half-up, to hundredths. The input must be an **arena** `makeFighter` snapshot, whose `baseDamage` already includes the bound weapon bonus. |
| `makeFallback(fighter): FighterSnapshot` | Copies attributes, arena armor, `attackIntervalMs`, `efficiency`, `weaponDamage`, equipment silhouettes and `rulesVersion` unchanged. Sets stance `balanced` and `classId: null`. `maxHealth` = `floor(0.85 × maxHealth)`, at least 1. `baseDamage` = `0.85 × baseDamage`, computed exactly. |
| `matchArena(entrants, recent, seed): ArenaAssignment[]` | Pairs within each league, processing leagues from Bronze to Champion. Details under "Pairing" below. |
| `ratingDelta(winnerRating, loserRating): RatingDelta` | `{ winner: gain, loser: -gain }`, where `gain = round(24 × (1 − 1 / (1 + 10^((loser − winner) / 400))))`. A zero loss is returned as positive zero. |
| `applyRatingDelta(winnerRating, loserRating): RatingUpdate` | `{ winner, loser, applied }`: the new ratings, each clamped at 0, plus `applied`, the change each rating actually received. Example: (0, 5) gives `{12, 0, applied {12, −5}}`. |
| `arenaOutcomes(assignment, log): ArenaOutcome[]` | One outcome per side, in assignment order: `{gladiatorId, activityId, result, success, rewards: CreditedRewards, ratingBefore, ratingAfter, ratingDelta}`. The winner is `log.winnerId`, which includes a seeded winner of a simultaneous defeat at 0 HP. Human bout: win 10 renown, loss 2, clamped Elo from the frozen side ratings. NPC bout: win 3, loss 0, `ratingDelta` 0. Never XP, money, points or items. Rejects a log whose battle ID, rules version, participant set or winner does not match the assignment. |

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
- **Input requirements.** All entrants must share one `slotIndex` and one `seasonId`, and both gladiator IDs and activity IDs must be unique.

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

## Decisions for review

The spec leaves these open.

1. **Highest strength (then highest rating) is processed first.** The spec gives no sort direction. With an odd count, this means the weakest unpaired entrant usually gets the NPC. Tests pin it: weakest-first processing fails 4 tests.
2. **Strength is rounded to hundredths, once, half-up, from exact decimals.** This follows the project's two-decimal convention and the combat engine's single final rounding. The 2× check and the nearest-strength comparison use integer hundredths, so the exact 2× boundary is well defined. Hit and critical probabilities are the engine's own floating-point values, as the engine itself uses them.
3. **Recent-pairing window.** Pairings in slots S − 18 to S − 1 count, from any league or season. Older rows are ignored. A row at the current slot or later is rejected as corrupt input.
4. **Seeded tie-break.** Each entrant gets one seeded key, used for both the sort and opponent ties. Results therefore do not depend on input order (tested with reversed and cloned inputs).
5. **Fallback details.** Health is floored, matching the spec's health rule, and is at least 1. `classId` is null, as for expedition creatures. `weaponDamage` and silhouettes are copied unchanged, because the spec overrides only health and base damage. `weaponDamage` is display-only in combat.
6. **Battle IDs.** A human bout uses `arena:<slot>:<first>:<second>` (participant order) and is shared by both entrants. An NPC bout uses `arena:<slot>:<gladiatorId>:npc`. In the battle log, a human participant's ID is its `gladiatorId`. The NPC participant's ID is `npc:<gladiatorId>` with `gladiatorId: null`, as the dispatch specifies.
7. **Ratings in `arenaOutcomes` come from the frozen assignment.** This matches the live rating rows, because:
   - a character has at most one Arena activity per slot;
   - the previous slot settles before the next boundary takes its snapshot (§4.1).

   Phase 2 should assert that equality under lock rather than silently using either value. Its owner-only `ratingDelta` should be `applied`, the change after clamping.
8. **Return types.** `matchArena` freezes each assignment but returns an ordinary array, so its declared return type `ArenaAssignment[]` stays accurate. It accepts readonly input arrays, which is a widening of the plan's parameter types.

## RED and GREEN

Each cycle wrote its tests first. Each Vitest run used `npx vitest run tests/domain/arena.test.ts` (filtered with `-t <block>` where noted) and ran in the default sandbox without escalation.

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| A, `leagueFor` | The suite failed to load: `Cannot find package '@domain/arena.ts'`. Then a placeholder that always returned `'bronze'` gave **28 failed / 5 passed of 33** (the passes were 4 Bronze rows and the monotonic loop). | 33/33 |
| B, Elo | `-t "Elo"`: **16 failed**, `ratingDelta`/`applyRatingDelta is not a function`. | 49/49 |
| C, strength | `-t "strength estimate"`: **18 failed**, `estimateArenaStrength is not a function`. After the `combat.ts` export refactor, the combat, expedition and replay-fixture files passed **66/66**. | 67/67 |
| D, fallback | `-t "NPC fallback"`: **11 failed**, `makeFallback is not a function`. | 78/78 |
| E, pairing | First run: 30 failed, but **2 failed on test-fixture preconditions**, which do not count as RED: the roster spread was 2.03×, and three-entrant weakest × 2 was below the strongest. A temporary, deleted probe measured the strengths, and the fixtures were adjusted (roster Vitality `(i × 2) % 4`; the weakest of the three got Strength 3). Rerun: **30 failed**, only because `matchArena` is missing. | 108/108 |
| F, outcomes | **6 failed**, `arenaOutcomes is not a function`. `npm run typecheck` then reported TS2532 (a union tuple not narrowed); the human branch now uses the narrowed `assignment.sides`. | 114/114 |

### Mutation checks after cycle E

Each mutation was applied to `arena.ts`, run, then restored from a copy (`diff -q` confirmed the restore):

| Mutation | Arena tests failed |
| --- | --- |
| Process weakest first | 4 |
| Drop rating from the sort | 1 |
| 19-slot window | 1 |
| 17-slot window | 1 |
| Strict `<` 2× check | 1 |
| Ignore recent history | 2 |

The half-cent cases (733.075, 1319.535, 1612.765) were chosen because a Node computation of the plain floating-point product gives `733.0749999999999`, which rounds down. This was a calculation, not a mutation run.

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
  - no cross-league pairs.
- **League placement:**
  - thresholds at 24/25, 59/60 and 119/120, crossed by each input;
  - banked points count;
  - a respec leaves earned points, and so placement, unchanged;
  - monotonic in each input;
  - a weak current loadout stays in its historical league (history 135.2 → Gold; current gear 0 would give Silver).
- **Strength estimate:**
  - hand-derived real builds;
  - stances, overload and the engine's clamps;
  - a bound weapon of 6.65 → 7.315 gives 775.04, where early rounding would give 775.43; the expedition snapshot gives 723.83.
- **Fallback, against real `makeFighter` snapshots:**
  - bound armor stays at 7.315 and a 20.5 hit deals 18;
  - overload efficiency is applied once (damage 7, not 5);
  - health is floored;
  - the template is valid for the engine;
  - at least 1 HP.
- **Elo:** asymmetric cases, a positive-zero zero gain, clamping at 0, and safe-integer limits.
- **Outcomes:** real engine bouts, including a 0-HP simultaneous defeat for both a human bout and an NPC bout.

## Final commands

| Command | Result |
| --- | --- |
| `npm test` (baseline, before changes) | 16 files, **366 passed**. |
| `npm test` (final) | 17 files, **480 passed** (366 + 114). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, Deno runtime 2 passed. |
| `npx deno check --frozen --config supabase/functions/deno.json supabase/functions/_shared/domain/arena.ts` | Exit 0. No Edge entrypoint imports the module yet. |
| `git diff --check`, `git diff --cached --check` | Clean. |

Two environment slips, both cleaned up:
- A stray `cat > /tmp/probe.test.ts` waited on stdin until stopped. It left an empty file in the system temp directory, which was deleted.
- The temporary probe `tests/domain/zz-probe.test.ts` and a typecheck log outside the repository were also deleted.

Nothing extra was staged.

## Phase 2 must do

1. **SQL source.** `supabase/sql/07-arena.sql`, or the next free number after Task 10's `06-projections.sql`, with guarded DDL and `CREATE OR REPLACE`.
2. **Migration.** Generate it with the CLI (`db pull <name> --local --yes`) after Task 10's migration. Never hand-name or edit a committed migration. Follow the AGENTS.md completion check (ACLs, revokes, invoker views, trigger order, backfills), run a clean reset/replay, compare the replay with the source, and record the path in `docs/operations/migrations.md`.
3. **Boundary hooks (Task 7 signatures).**
   - **`private.boundary_recompute_leagues(bigint)`, phase 4.** Promote from `leagueFor(level, earnedPoints, peakStrength)`, computed in TypeScript; SQL must not restate the formula. One route is an additive `league` in `PreparationResult` from `prepareActivityV1`, validated by `complete_job`. Placement must never decrease. Entering a new league starts that league-season rating at 1000 and keeps the old record.
   - **`private.boundary_pair(bigint)`, phase 7.** `matchArena` is TypeScript, and this hook runs inside the boundary transaction. Phase 2 needs a fenced TypeScript pairing job per slot (or per league), held by a `private.boundary_work` barrier. The job's input: frozen entrants built with `makeFighter(snapshot.build, 'arena')`, ratings, and `PairingHistory` from human bouts in slots S − 18 to S − 1. A private seed. Persist the assignments immutably.
   - **`private.activity_executor_ready('arena')`** and **`private.prepare_activity_jobs(uuid)`**: copy the snapshot seed onto the jobs, as today.
   - **`private.accept_job_result(uuid, jsonb)`**: fenced, with post-lock time, token and status checks.
4. **Worker executor.** Add the Arena executor to the `v1` registry. The current `v1.simulation` assumes an expedition (`planExpedition`), so it must dispatch by snapshot choice. Reuse `private.job_dependencies` (simulation → reveal → settlement) and the combat batch limit of 5; do not add a second runner. Both activities of a human pair use **one** `simulateBattle` with one shared `battleId`. Participant IDs: human = `gladiatorId`; NPC = `opponent.id` with `gladiatorId: null` and the frozen fallback snapshot.
5. **Settlement.** Go through `private.settle_rewards(uuid)` and the whitelisted outcome `{rewards, result, success, replayExpiry, ratingDelta}`. Build it from `arenaOutcomes`:
   - renown only;
   - `ratingDelta` = the applied change;
   - NPC bouts give `ratingDelta: 0`;
   - the winner is decided by `winnerId`.

   Apply a human pair's two rating updates exactly once, atomically, under the common lock order (account advisory lock, then characters and wallets sorted, then activities, then jobs). Cover simultaneous settlement retries of both sides and the malformed-hook rollback.
6. **Public Arena stage sequence** (mirrored by Task 17):
   - stage 0, `staging`: revealed at S, ending S + 60 min, label `Warming up`;
   - stage 1, `bout`: revealed at S + 60 min with the log, label `Bout: victory` or `Bout: defeat` from that entrant's `winnerId` perspective;
   - stage 2, `return`: zero-length at S + 80 min, label `Results credited`.

   Warm-up grants no training points. Rewards and ratings arrive at minute 80.
7. **Ratings and standings.**
   - One row per `(character, league, season)`, starting at 1000, with a floor of 0.
   - Human win and loss counters for `StandingRow`; NPC bouts are excluded.
   - Public standings and ratings; private wallets and loot stay owner-only.
   - Wire them through Task 10's projection and revision hooks.
   - **Season identity is open until Task 21.** Phase 2 needs a `seasonId` for every entrant now, derived from the persisted launch epoch and 504-slot seasons.
8. **DB tests in `tests/db/arena.test.ts`:**
   - `db.settleNpcWin()` matches `{renown: 3, ratingDelta: 0}`;
   - sold, unequipped and renown gear history;
   - respec and banked-point promotion at a boundary only;
   - simultaneous settlement retry;
   - no cross-league bouts;
   - access denial for private plans, assignments and seeds;
   - stages appear only when due;
   - migration-only replay parity.
9. **Outside this lane.** Task 14's reserved `tests/domain/replay-fixtures.test.ts` keeps its own stand-in `npcFallback` (a floating-point × 0.85). The replay or UI owner may switch it to `makeFallback`. Phase 1 did not touch it.

No reusable skill change is proposed. The existing TDD, verification and migration guidance already covers this work.
