# Task 19 phase 1 independent specification and quality review

Date: 2026-10-14. Reviewers: two fresh Claude reviewer subagents, read-only on the worktree, with no database. Scope: the pure tournament domain (`supabase/functions/_shared/domain/tournament.ts`, one `rules-v1.ts` constant, additive `arena.ts` exports, `tests/domain/tournament.test.ts`) and the phase 2 plan in `task-19-phase-1-report.md`.

## Verdict

**Specification compliant; code quality Pass; phase 1 ready to merge.** Phase 2 (SQL, migration, opt-in command, boundary hook shared with Task 16, per-bout jobs, settlement, projection, DB tests) is not started.
- Range: `427158e..` the head of `claude/task-19`.
  - `abf7cb9`: feature.
  - `ef73c82`: report.
  - `8d72abb` and `deefd4f`: merges of reviewed Task 16 phase 1.
  - `98aeb07` and `d317f14`: review fixes.
  - `b42097e`: re-review docs fixes.
  - Then this record.

## Round 1: full review (`427158e..8d72abb`)

**Reviewer evidence:**
- `npm test`: 644 passed. Typecheck: clean. Deno check of `tournament.ts`: clean.
- Slot detection matched a `Date.getUTC*` check on every slot from 2026 to 2030 (521 tournament slots), across EU and US daylight-saving dates in five time zones.
- Bracket sizes and byes were correct for 2, 3, 4, 5, 8, 9 and 50 entrants: never two byes in one bout, and n − 1 fought bouts.
- Reveal times matched the exact rational ceiling for R = 1..6.
- 20 random input orders gave identical graphs.
- Placement tallies were correct for 2, 3 and 50 entrants.
- Elo is applied in round order from updated ratings. The winner is `winnerId`, even at 0 HP.
- 30 mutations: 29 caught. The survivor reverses the id tie-break, which matters only on a 32-bit key collision.

**Verdicts:** spec Pass, quality Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| I1 | The phase 2 list conflicted with Task 16's corrected plan: pairing job shape, seeds, job anchoring, pairing history, rating check, bracket acceptance, grant identity, parent winners. | Important | `d317f14` rewrote the plan onto Task 16's design: `partitionTournament` inside the per-slot-and-league pairing job; per-bout one-way seeds; bout jobs anchored to the rank-1 entry; tournament bouts in `PairingHistory`; a per-side rating check; `complete_job` acceptance; grants inside each activity's settlement outcome; parent winners read under the job fence. |
| M1 | Elo and other reads used default v1 rules instead of the graph's rules. | Minor | `98aeb07` (RED: v1 Elo used for custom rules). |
| M2 | Bout seeds shared an FNV prefix, so a brute-forced round-1 log could expose later results. | Minor | `98aeb07`: the domain derives no bout seed; `runBout(job, seed, names?)` takes the stored per-bout seed. |
| M3 | The bout fence skipped `efficiencyBasisPoints` and `equipmentSilhouettes`. | Minor | `98aeb07`, with two fence rows. |
| M4 | Stored results were only lightly validated. | Minor | `98aeb07`: one `logBelongs` check shared by `recordBout` and `checkGraph`; stub logs are rejected. |
| M5 | A bye was marked `won: true`. | Minor | `98aeb07`: `EntrantBout.kind` is `'bye' \| 'win' \| 'loss'`; byes are never counted as wins. |
| M6 | Rules and helpers were duplicated from `arena.ts`. | Minor | `98aeb07`: additive exports from `arena.ts`, imported here. |
| M7 | The public view gap (round 1 pairings and byes at start). | Minor | Recorded as an open contract question, posted to Codex on 2026-10-14 (07:36 IDT). `placements` stay empty until settlement. |
| M8 | Stale typecheck text. | Minor | `d317f14`. |
| Test gap | A tournament cheaper than Arena was untested. | Minor | `98aeb07` pins that the candidate goes to Rest. |

**Rulings on the implementer's decisions:** all accepted. Decision 1 is real, and phase 2 closes it with locking: `set_tournament_opt_in` returns `processing` while the world is behind, and the boundary reads under the lock. Decision 8: phase 2 freezes real names.

## Round 2: scoped re-review (`8d72abb..d317f14`, plus merge `deefd4f`)

**Reviewer evidence:**
- `npm test`: 653 passed. Typecheck: clean.
- The `arena.ts` exports are purely additive (121/121).
- The serialized graph holds no tournament seed.
- Real logs survive a JSON round trip, while stub or altered logs are rejected by all four graph functions.
- Byes are never counted as wins (5-entrant probe).
- The `vi.mock` test seam (a test-only `v1-custom` version) cannot reach production.
- `deefd4f` has no conflict hunks, and its patch-id is identical to Task 16's `bec7ad2..cb438bc`.

**Verdicts:** spec Pass, quality Pass, ready **with fixes** (docs only).

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| 1 | Phase 2 item 10 settled through `private.settle_rewards(uuid)`, which TypeScript cannot reach. | Important | `b42097e`: a fenced `tournament_settlement_input(activity_id, lease_token)` read, then a prepared-settlement RPC through `settle_activity_core` with a tournament branch. Under the lock it checks the outcome shape, the grant id `<tournamentId>:placement:<gladiatorId>` and the entrant's own frozen rating. Marked not built or tested. |
| 2 | Items 5 and 6 cited Task 16's open design points as settled. | Minor | `b42097e`: labelled as dependent on them. |
| 3 | Task 16's second-side settlement test had no tournament counterpart. | Minor | `b42097e`. |
| 4 | The placement-seed recommendation still read as unruled. | Minor | `b42097e`: recorded as ACCEPTED (its own SHA-256 placement seed), with a test and corrected wording. |
| 5 | Bout-job creation and executor enablement were unstated. | Minor | `b42097e`: `activity_executor_ready('tournament')` and the tournament branch of `prepare_activity_jobs`; `boundary_start` returns `'integration'` until then (`03-activities-jobs.sql:403-404`). |
| 6 | Bout-row acceptance checked identity only. | Minor | `b42097e`: the executor runs `recordBout` before `complete_job`. |

**Controller check of `b42097e`:** the settlement route, the accepted placement seed and the corrected citations are present; the implementer verified every cited line against the files.

## Open for phase 2

- Task 16's open design points: the fighter and NPC comparison target, and the seed derivation.
- The exact dependency shape for later-round reveal jobs (item 9).
- The `TournamentView` round 1 placement field: a contract question for Codex and Task 20.
- The season epoch, agreed with Codex (Task 21).
- A second local Supabase stack, agreed with Codex before any DB work.
