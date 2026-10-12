# Task 12 independent specification and quality review

Date: 2026-10-12. Reviewer: a fresh Claude reviewer subagent, read-only on the worktree. It ran `npm test`, `npm run typecheck` and the private Playwright suite (port 3200, desktop and mobile). It checked API claims against the Phaser 4.2.1 source in `node_modules/phaser/src`. The same reviewer did the re-review and the delta check.

## Verdict

**Specification compliant; code quality Pass; ready to merge.**
- Final range: `bc5b4d6..` the commit recorded in the READY TO MERGE post.
- Camp commits: `c6aeab0`, `3051531`, `ddb9bec`, `e5eb8fc`, plus the final follow-up.
- R2: `docs/implementation/task-12-request-R2-game-page.patch`. The reviewer confirmed it is byte-identical to the tested `page.tsx` change.

## Rounds

| Round | Range | Spec | Quality | Outcome |
| --- | --- | --- | --- | --- |
| 1, full review | `c6aeab0` plus R2 | Fail | Fail | With fixes, 7 Important: bridge listeners leaked on unmount (`game.destroy` emits DESTROY, not SHUTDOWN); a re-entry test that could not catch it; a late first world parading in; equipment never redrawn; trackpad and horizontal wheel zoom; tautological assertions; per-frame cost. Also about 20 Minors. Fixed in `3051531` and `ddb9bec`. |
| 2, re-review | `3051531`, `ddb9bec` | **Pass** | **Pass** | **Yes.** Every Important finding fixed and checked against the Phaser source; reverting any of them fails a test. 8 Minors, fixed in `e5eb8fc`. |
| 3, delta check | `e5eb8fc` | **Pass** | **Pass** | **Yes.** Each fix verified (context-restore repaint, Find/Follow gating, wheel line mode and idle reset, drag threshold, watchtower evidence, 50-row world). 6 Minors, addressed in the final follow-up. |

## Delta-check Minors and resolution

1. **A follow refusal was answered inside the emit loop**, so a later subscriber saw `{null}` before the request. It is now deferred with `queueMicrotask`, and dropped if a newer request was accepted. A unit test (`seen` equals `['g1', null]`) failed first.
2. **Reverting the refusal failed no test.** The browser test now brings the owner back after the refusal and checks that Follow stays unpressed. A mutation check confirms that removing the refusal fails it.
3. **`ownerInCamp` only updated on roster events.** It is now derived from the last roster and the current `focusGladiatorId` on every render.
4. **The wheel test depended on a 250 ms window.** The checks now read the camera at once, because Phaser handles wheel events as they arrive, with no frame waits inside the gesture.
5. **No browser test showed 50 players.** A new test pushes a 50-in-camp world (reduced motion places everyone at once) and checks 50 players on 50 distinct tiles.
6. **`dragged()` hard-coded 6.** It now uses `DRAG_THRESHOLD`.

The report wording was also corrected: `scene-unavailable` reaches panels mounting in the same commit, and diagonal steps can look slower or faster on screen.

## Evidence (final)

- `npm test`: 218 passed. Typecheck clean: tsc, Deno check, Deno test.
- `next build` and `verify:static`: 69 assets.
- Playwright: 57 passed, 5 skipped. The camp suite is 17 tests on desktop and mobile, 33 passed plus the desktop-only pinch case.
- Screenshots: `docs/implementation/task-12-evidence/`.

## Accepted limitations, recorded for Task 13 and later

- The scene clock re-anchors on every snapshot.
- `scene-unavailable` has no status query for panels mounting later.
- Diagonal steps look slower or faster on screen.
- `assets.ts` still inlines the expedition atlases.
- The late first world is handled by flag logic only (no browser test).
- The fps targets belong to Task 23.

Ownership: Codex owns integration into `codex/gladiator-arena`, applying R2, HANDOFF and the push.
