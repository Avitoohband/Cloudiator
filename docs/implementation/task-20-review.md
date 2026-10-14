# Task 20 independent specification, quality and visual review

Date: 2026-10-14. Reviewers: two fresh Claude reviewer subagents, read-only on the worktree, with no database. The second review also covered the merge of Task 17's reviewed fixes into this branch.

## Verdict

**Specification compliant; code quality Pass; visual Pass; ready to merge.**

| Range | Content |
| --- | --- |
| `08998e6..` the head of `claude/task-20` | The whole review range |
| `c1ff143` | Feature |
| `b67a06c` | Report |
| `ffc1e2f` and `2cafdeb` | Review fix pass |
| `b7f38ad` | Merge of Task 17's fixes, resolved by a dedicated agent |
| `f654855` and `46190a1` | Docs merges |
| `b107904` | Timing note |
| `b48ce1f` | Shared request guard |
| Then this record | |

This branch combines Claude's reviewed Tasks 15, 16 and 19 phase 1, 17 and 20.

## Round 1: full review (`08998e6..b67a06c`)

**Reviewer evidence:**
- 838 unit tests passed; typecheck clean; build and static scan clean.
- No engine, fixture or test-hook strings in `out/`.
- Full dev browser suite: 217 passed. The only failures were the 6 known `arena.spec.ts` port failures; all 28 `tournament.spec.ts` tests passed.
- A probe built brackets with the real Task 19 `buildBracket` for 2 to 64 entrants. Reveal times, bracket size, round count, byes and id all matched the stage core (0 mismatches).
- The reviewer took their own desktop, mobile and 360 px captures.

**Verdicts:** spec **Fail** (two Important findings), quality Pass, visual Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| I1 | `viewerText` said "You advance." before the viewer's bout was published. | Important | `ffc1e2f`: "You advance" only after a shown win or bye by the viewer; otherwise "result is not published yet". Unit and browser cases cover `opening` at minute 25 as Aster. |
| I2 | The camp showed the "Champion" tag while the final was still being fought in its ring. | Important | `ffc1e2f`: the tag waits until the ring has finished. Kept through the merge (`b7f38ad`): the gate uses a set filled from Task 17's `statusOf`. |
| M1 | At 360 px the inline replay's table headers broke mid-word. | Minor | `ffc1e2f` |
| M2 | `BattleReplay` rendered an `h1` inside the panel. | Minor | `ffc1e2f`: an optional `headingLevel` prop (default 1). |
| M3 | Bracket rules duplicated from Task 19 with no cross-check. | Minor | `ffc1e2f`: a cross-check test against `buildBracket` for 2–64 entrants. |
| M4 | A failed first read was not retried. | Minor | `ffc1e2f`: a 30 s retry while the tab is visible. |
| M5 | `wellFormed` required matching participant order. | Minor | `ffc1e2f`: set equality, still fail-closed. |
| M6 | Preview samples did not show what their labels said. | Minor | `ffc1e2f`: the bracket card holds the sample's projection time. |
| M7 | No "replay no longer retained" note for an expired log. | Minor | Gate for Task 22. |

**Rulings on the concerns:**
- The open `TournamentView` questions are gates:
  - Round-1 pairings: an open contract question.
  - `placements[].summary` must be made role-safe on the server before live use.
  - Server time: owned by Task 13.
  - Live tournament id: comes with Task 19 phase 2.
- TDD order: recorded as a process deviation.
- Late bouts: accepted, later superseded by Task 17's real-time ring rule.
- `BattleReplay` `h1`: fixed by M2.
- The engine import through `isTournamentSlot`: tree-shaken in production. Recommendation for Task 19's owner: move it into an engine-free module.

## Round 2: scoped re-review (fix pass `b67a06c..2cafdeb`, merge `b7f38ad`, docs `f654855`, `46190a1`, `b107904`)

**Reviewer evidence:**
- 856 unit tests passed; typecheck clean; build and static scan clean.
- Full dev browser suite: **254 passed, 0 failed**.
- `tournament.spec.ts --repeat-each 2`: 72/72, no flakes.
- The diffs against each parent show both sides kept intact.

**Confirmed:**
- I1 and I2 are fixed with meaningful tests, and all seven Minors are met.
- The merge keeps both sides:
  - Task 17's invariant that no card or panel shows a completed result while that pair's ring is still fighting;
  - Task 20's champion-at-the-end and spectators;
  - no per-frame allocations;
  - tournament bouts kept out of the Arena keyboard list.
- Tournament camp fights end at the stage core's `fightEndsAtMs`, so the camp and the panel change over together.
- The two adapted tournament tests are not weakened.

**Verdicts:** spec Pass, quality Pass, visual Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| 1 | `tournament.spec.ts`'s `forbidRemote` hard-coded port 3200, so 6 tests would fail under the repo config (the same defect as Task 17's I1). | Important | `b48ce1f`: one shared guard, `tests/browser/remote.ts`, which takes the test's `baseURL`, used by both specs. A new guard test was RED on the old code for a 3100 origin. After the fix, the tournament and Arena specs gave 101 passed. |
| 2 | Stale report lines after the merge; the champion tag can also lag by up to about 1 s. | Minor | `b48ce1f`. |
| 3 | In live mode the Tournaments tab says "cannot be loaded right now" for an unbuilt read and retries every 30 s. | Minor | Integration checklist in the report. |
| 4 | `tournamentViews` is never pruned. | Minor (optional) | Deferred; on the integration checklist. |
| 5 | No browser test that a tournament ring and the panel change over at the same moment. | Minor (optional) | Deferred; on the integration checklist. |
| 6 | An unreachable "You advance. Your next result is being prepared." branch. | Nit | Deferred; on the integration checklist. |

## Gates carried forward

- **Task 19 phase 2:**
  - the opt-in RPC;
  - the live tournament lookup;
  - a role-safe public `TournamentView` (placements without other entrants' rewards);
  - a round-1 pairing field, an open contract question;
  - `isTournamentSlot` moved into an engine-free module.
- **Task 10:** live `tournament()` and the command path; the live-reader wording.
- **Task 13:** the shared sync clock (today the panel and the camp each poll tournaments).
- **Task 22:** the expired-replay note.
- **Integration:** the isolated production browser gate with the repo's `playwright.config.ts`.
