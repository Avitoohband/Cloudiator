# Task 16 phase 1 independent specification and quality review

Date: 2026-10-14. Reviewers: two fresh Claude reviewer subagents, read-only on the worktree, with no database. Scope: the pure Arena domain only (`supabase/functions/_shared/domain/arena.ts`, additive `combat.ts` exports, `tests/domain/arena.test.ts`) and the phase 2 plan in `task-16-phase-1-report.md`.

## Verdict

**Specification compliant; code quality Pass; phase 1 ready to merge.** Phase 2 (SQL, migration, worker executor, settlement, projections, DB tests) is not started.
- Range: `b8ac1ce..` the head of `claude/task-16`.
  - `270deb9`: feature.
  - `61b3e7b`: report.
  - `a60eeb2` and `bec7ad2`: review fixes.
  - `c30d854` and `b3c3238`: re-review Minors.
  - Then this record.

## Round 1: full review (`b8ac1ce..61b3e7b`)

**Reviewer evidence:**
- `npm test`: 480 passed. `npm run typecheck`: clean. A direct Deno check of `arena.ts`: clean.
- An independent exact-decimal strength estimate over 17,712 real `makeFighter` arena builds: 17,707 matched; the 5 that differed are M1 below.
- An independent §8.1 pairing reference on 300 random trials: identical every time, and independent of input order.
- 23 mutants of `arena.ts`: all caught.
- Hand checks:
  - league thresholds 24/25, 59/60 and 119/120;
  - the starter berserker estimate, 1038.99;
  - the bound weapon at 6.65 × 1.1 = 7.315;
  - exactly 2× pairs, while 2× + 0.01 gets the NPC;
  - the S − 18 history window;
  - the fallback at 85% (with efficiency applied once);
  - Elo: `ratingDelta(1000, 1000)` = {12, −12};
  - renown 10/2 and 3/0, with the winner taken from `winnerId` even at 0 HP.
- The `combat.ts` extractions were compared line by line. The Task 3, Task 9 and byte-for-byte replay fixture tests pass, and the fixture JSON is unchanged.

**Verdicts:** spec Pass, quality Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| I1 | The phase 2 list contradicted itself on the bout seed: each activity has its own seed, but both sides of a human bout must share one simulation. | Important | `bec7ad2`: a private per-battle seed stored on the assignment; one `arena:<battleId>` simulation job anchored to the first side's activity; both activities' reveal and settlement jobs depend on it through `private.job_dependencies`; a documented SQL-header exception. |
| M1 | The strength estimate was not fully exact-decimal: the engine's float probabilities flipped 5 of 17,712 builds by a half cent. | Minor | `a60eeb2`: each probability is normalised to 12 significant digits (RED on 808.88 → 808.89). `c30d854` adds a Precision 40 case that catches both the hit and the critical normalisation. |
| M2 | Rules came from two sources, and `matchArena` accepted mixed rules versions. | Minor | `a60eeb2`: optional `rules` parameters; `matchArena` derives one rules object from the entrants and rejects mixed versions. |
| M3 | `arenaOutcomes` validated only side 0 and never checked the logged participants' `gladiatorId`. | Minor | `a60eeb2`: both fighters are validated, and exact participant identity is checked. |
| M4 | The phase 2 list had gaps: rating and league columns, combat-strength exposure, tournament bouts in history, the 2-minute target. | Minor | `bec7ad2`. |
| M5 | Two test pins were missing: own armor, and respecs not lowering placement. | Minor | `a60eeb2`, checked by mutation. |

**Rulings on the implementer's eleven decisions:** all accepted. Pairing is strongest first; integer-hundredths comparison; window S − 18..S − 1; one seeded key per entrant; fallback flooring, no class and the player's `weaponDamage`; battle ids; frozen ratings. Decisions 8–10 are real phase 2 design issues, now in the plan: a fenced pairing job per slot and league from `boundary_pair`; an executor discriminator; a season epoch with Task 21. Decision 11 stays with the Task 14/17 owner.

**Balance note, raised with Avi:** under the spec's greedy rule, the weakest entrant in a stable, odd-sized league keeps getting the NPC. That could cost them the five human bouts needed for season rewards. This comes from the spec; the pairing order is unchanged pending Avi's decision.

## Round 2: scoped re-review (`61b3e7b..bec7ad2`)

**Reviewer evidence:**
- `npm test`: 487 passed. Typecheck: clean.
- An exact-rational sweep of every hundredths Precision from 0 to 3000 found 0 mismatches after normalisation; the raw floats were off in 2,595 hit and 3,564 critical cases.
- A 565,920-fighter exact comparison found 0 mismatches.
- Combat and replay are untouched.

**Verdicts:** spec Pass, quality Pass, ready **with fixes** (cheap).

| # | Minor | Resolution |
| --- | --- | --- |
| 1 | The critical normalisation was untested: at Precision 17 it is already exact. | `c30d854`: the Precision 40 case (576.14). Removing the critical normalisation fails it (576.13). |
| 2 | The rating check was ambiguous: read as both sides, the second settlement would fail. | `b3c3238`: each side compares only its own frozen rating with its own live row. The controller added the matching phase 2 DB test case. |
| 3 | The route from `arenaOutcomes` to SQL settlement was unstated. | `b3c3238`: the executor returns the log and both outcomes; `accept_job_result` validates and stores them; each side's `settle_rewards` reads its own. |
| 4 | Two concerns read as settled examples. | `b3c3238`: the fighter comparison target (now also covering the NPC template) and the digest seed derivation are labelled open phase 2 design points. |
| 5 | Schema list gaps and two citations. | `b3c3238`: `claim_jobs` kinds, the `complete_job` branch, `runWorker` order and the wait-reason check added; citations corrected and verified. |

**Controller check of `c30d854` and `b3c3238`:** the diff matches the requested changes, and the implementer's mutation check is recorded in the commit body.

## Open for phase 2

- The fighter and NPC comparison target, and the seed derivation: design points, not built.
- The season epoch: agree with Codex (Task 21).
- The pairing round trip against the 2-minute target at 50 characters.
- The balance decision from Avi.
- A second local Supabase stack, agreed with Codex before any DB work.
