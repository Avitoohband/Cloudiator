# Task 16 dispatch, phase 1: pure Arena domain (controller: Claude)

The binding plan and spec text, plus Codex's reviewed producer notes for Tasks 7–10, are in `docs/implementation/task-16-brief-base.md`. Read it fully first.

Avi moved Task 16 to Claude on 2026-10-14 (board entry 05:55 IDT). This dispatch covers **phase 1 only: the pure TypeScript domain module and its unit tests, with no database.** Phase 2 (SQL source, generated migration, worker executor, settlement hook, projections, DB tests) is dispatched separately once a second local Supabase stack is agreed with Codex and Task 10 is integrated.

## Where and with whom

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-arena`, branch `claude/task-16`, base `62f24cc` (Codex's pushed, reviewed Task 9 checkpoint). Record the base in your report.
- Other lanes run in parallel. Never write to, run commands in, reset or commit in `C:\Avi\Studies\Projects\Cloudiator` (Codex's live checkout; Codex is doing Task 10 and owns the only Supabase stack), `C:\Avi\Studies\Projects\Cloudiator-claude` (Task 15) or `C:\Avi\Studies\Projects\Cloudiator-replay` (Task 17).
- **No Supabase or Docker commands at all**, and no `npm run test:db`. No browser tests, no dev server.
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents. Never print secrets.

## Read first

- `AGENTS.md`; `docs/implementation/HANDOFF.md`; `task-02-report.md` (rules and catalog), `task-03-report.md` and `task-03-review.md` (combat engine, fighter snapshots), `task-07-report.md` (boundary hooks; note them for phase 2, do not implement them), `task-08-report.md` (`historicalGearScore` and the gear-history contract), `task-09-report.md` and `task-09-review.md` (the job graph and the 0-HP winner rule).
- Code: `supabase/functions/_shared/domain/{types,rules-v1,catalog-v1,stats,combat,build,inventory,expedition,random}.ts` and `contracts/*.ts`.

## Scope of phase 1

Create `supabase/functions/_shared/domain/arena.ts` and `tests/domain/arena.test.ts`, plus additive types in `domain/types.ts` and rule constants in `rules-v1.ts` only where the spec's proposed values belong in the versioned rules (league thresholds, renown amounts, Elo K, the 2× pairing cap, the 18-slot history window, the NPC template factors). Never a second stats, damage or price table; reuse `makeFighter`, the `stats.ts` helpers and the Task 8 gear score.

Exports, exactly as the plan names them:
- `leagueFor(level, earnedPoints, gearHistory): LeagueId`, using the spec progression index `2 × level + floor(earned allocatable points / 5) + floor(historical gear strength / 10)` and the thresholds below 25, 25–59, 60–119, and 120 and above. Banked (unallocated) earned points count; the starting 10 count. Monotonic: never decreases with gear removal, sale or respec, because its inputs never decrease.
- `estimateArenaStrength(fighter: FighterSnapshot): number`: `max health × expected outgoing damage per second` per spec §8.1 (base damage, efficiency, stance, hit probability against reference Agility 5, expected critical multiplier `1 + 0.5 × critical probability`, divided by the attack interval in seconds; reference armor 0 and incoming stance 1; arena-specific item modifiers included). Reuse the engine's own formulas rather than restating them; if they are not exported, export them additively from `combat.ts` without changing behavior, and prove unchanged behavior with the existing Task 3 tests.
- `matchArena(entrants: ArenaEntrant[], recent: PairingHistory[], seed: Seed): ArenaAssignment[]`: within one league only; sort by current strength, then rating, then a seeded tie-break; take the first unpaired entrant and choose the opponent with nearest strength, then fewest recent pairings in the preceding 18 slots, then nearest rating, then a seeded tie-break; remove both and continue; reject a pair whose larger estimate exceeds twice the smaller (exactly 2× is allowed); any unmatched entrant gets an NPC assignment. Deterministic for the same inputs and seed. Define `ArenaEntrant`, `PairingHistory` and `ArenaAssignment` beside the function; assignments reference frozen builds and one season, league and slot.
- `makeFallback(fighter: FighterSnapshot): FighterSnapshot`: mirror the entrant's effective attributes, armor and weapon interval; Balanced stance; maximum health and pre-stance base damage at 85% of the player's; retain the player's overload efficiency, applied once (no double class, damage or overload modifiers, per the producer notes). No rewards of its own.
- `ratingDelta(winnerRating, loserRating): RatingDelta`: Elo, K = 24, expectation `1 / (1 + 10^((loser − winner) / 400))`, winner gain `round(24 × (1 − expected))`, loser the negative, each rating clamped at 0 when applied (provide the clamped application too). `ratingDelta(1000, 1000)` is `{ winner: 12, loser: -12 }`. NPC bouts never produce a rating change.
- A pure reward helper for regular Arena outcomes: human win 10 renown, loss 2; NPC win 3, loss 0; no XP or money. The winner is the log's `winnerId`, even at 0 HP.

## Tests (TDD: write each first, watch it fail for the right reason)

The plan's Step 1 unit assertions (not the `db.` one), plus the Step 4 cases that need no database: no entrants, one, odd counts, 50 entrants, the exact 2× boundary and just above it, repeat-pairing ties across 18 slots (and slot 19 dropping out), seeded tie-breaks stable across calls, no cross-league pairs, league thresholds at 24/25, 59/60, 119/120, banked points, a weak current loadout staying in its historical league, bound renown gear modifiers in the strength estimate with precision preserved until final rounding (the producer notes cite armor 6.65 × 1.1 = 7.315), the fallback template against a real `makeFighter` snapshot, and Elo clamping at 0. Use real domain inputs from the catalog and rules, not hand-made numbers, where possible.

Before committing: `npm test`, `npm run typecheck`, `git diff --check`.

## Commit and report

- Commit `feat: add pure Arena league, pairing and rating rules` with a detailed body; exact paths only.
- Write `docs/implementation/task-16-phase-1-report.md` (interfaces, decisions, RED/GREEN, commands and results, and an explicit list of what phase 2 must do: SQL source `07-arena.sql` or the next free number, the migration after Task 10's, the boundary hooks named in the brief, the worker executor and job graph reuse, settlement through the whitelisted `settle_rewards` outcome, the public Arena stage sequence, standings and rating rows, DB tests) in a separate commit.
- The public Arena stage sequence the UI lane (Task 17) mirrors, for your phase-2 notes: stage 0 `staging` revealed at S, ending S + 60 min, label `Warming up`; stage 1 `bout` revealed at S + 60 min with the log, label `Bout: victory` or `Bout: defeat` by `winnerId`; stage 2 a zero-length `return` at S + 80 min, label `Results credited`; an NPC fallback participant has `gladiatorId: null` and id `npc:<entrant gladiatorId>`; both entrants of a human pair share one `battleId`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns.
