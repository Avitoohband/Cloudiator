# Task 15 independent specification, quality and visual review

Date: 2026-10-14. Reviewers: two fresh Claude reviewer subagents, read-only on the worktree, no database. The same record covers `708688b`, which closes the two Task 14 Minors left open by `task-14-final-delta-review.md`.

## Verdict

**Specification compliant; code quality Pass; visual Pass; ready to merge.**
- Range: `05b1ea0..ab78457` on `claude/task-15-wip`.
  - `708688b`: Task 14 Minors.
  - `7c57106`: the stopped implementer's WIP.
  - `6ceb5e8`: the controller brief.
  - `b31136b` and `7c2ee9b`: the completion.
  - `2a102b4`: the report.
  - `fa27a50` and `85f48ee`: the review fix pass.
  - `ab78457`: one wording fix.

## Round 1: full review (range `05b1ea0..2a102b4`)

**Reviewer evidence:**
- `npm test`: 397 passed. `npm run typecheck`: clean (tsc, both Deno checks, Deno runtime tests). `build-assets --check`: up to date. `git diff --check`: clean.
- `npm run build` plus `verify:static`: 5 fixed routes, 90 assets, clean. Grepping `out/` for fixture ids, receipts, creature ids, names, stage labels and `createFixtureGateway` found 0 files.
- Dev browser suite on port 3200: 145 passed, 7 expected skips.
- Isolated production gate (shell, camp, replay, expedition against `.next/browser-test`): 8 passed, 110 fixture-only skips.
- An occlusion probe over the shipped map alpha found no fighter's encounter tile hidden by a prop.
- The reviewer's own desktop and 360 px screenshots: fighters face each other inside the frame, effects land on the defender, and the page has no horizontal scroll.

**Strengths named:**
- The fixture generator mirrors Codex's Task 9 planner (`545a82d`) line by line: stage sequence, labels, ids, seeds, the "Gladiator" participant name, `creature:<id>:N`, the floored 20% carry and the `winnerId`-only rule. The map creatures equal the planner's list.
- The stage core is pure, deterministic and reveal-safe. Only due stages exist, the summary is gated by `settledAtMs`, no outcome shows before a battle ends, health comes from the logs only, and Preparing never invents an encounter.
- No combat engine is in the bundle. The page sends no command and makes no Supabase call, and production fixture denial is real.
- Lifecycle is solid: dispose on unmount and DESTROY, page-scoped bridge listeners, the `startGame` cleanup, and no duplicate canvas.
- The shared edits stay inside Codex's approval, and every existing scanner and security case is preserved.
- Item 1 closes both Task 14 Minors with meaningful tests.

**Verdicts:** spec Pass, quality Pass, visual Pass, ready to merge **Yes**. No Critical or Important finding.

| # | Minor | Resolution |
| --- | --- | --- |
| 1 | The interim read cadence can stall: no re-read after arrival while the owner awaits the summary; a late reveal waits for the next 20-minute mark. | Fixed in `fa27a50`. `readDue` adds a 30 s poll while the tab is visible and the view is Preparing or awaiting the owner's summary, and stops once the stage or summary arrives. Spectators poll only while Preparing. Task 10's sync replaces it (gate). |
| 2 | The replay page lists every battle in a timeline without a display clock: in fixture mode, future encounters and rewards; in live mode, an in-progress bout under its server label. | **Gate for Tasks 10 and 14.** Filter replay battles to those ended at server time, or label in-progress ones neutrally. |
| 3 | After arrival the text said "Back at camp" while the scene still showed the gladiator. | Fixed in `fa27a50`. The gladiator fades out over 1.5 s (at once with reduced motion), and a "Returned to camp" banner shows over the scene. |
| 4 | Health read 0 while exploring after a 0-HP tie-break win. | Fixed in `fa27a50` (label names the encounter the value comes from, plus a static recovery note) and `ab78457` (the note no longer implies a full heal). |
| 5 | No hidden-tab pause test for the scene. | Fixed in `fa27a50`. The new test showed the scene kept drawing for 811 ms while hidden; `update()` now does nothing while hidden and resumes at the current display time. |
| 6 | Plan Step 4's network-payload inspection cannot run against in-process fixtures. | **Gate for Task 10:** inspect live payloads for future enemy, loot and outcome leakage. |
| 7 | `kept` read the ungated summary. | Fixed in `fa27a50`. |
| 8 | The default zoom is fractional (1.5625). | Accepted. It uses the camp's zoom ladder with `smoothPixelArt`, and the screenshots are crisp. |

**Rulings on the implementer's seven concerns:**
- (1) Fixture timelines holding future stages: accepted as a fixture limitation (see Minor 2).
- (2) UUID-only `activity` and a fixture-only `minute`: accepted. Gate: Task 10 activity ids stay UUIDs.
- (3) Owner versus spectator: accepted, and it fails safe. Gate: spectators never receive a summary.
- (4) Health between encounters shows the last log's value: accepted (see Minor 4).
- (5) Reads only at marks and on focus: superseded by fix 1.
- (6) The private static mode in ignored tooling: accepted. The integrator re-runs the gate with the repo config.
- (7) No `CreditedRewards.overflow`: accepted. Gate: decide on per-item overflow lines once Task 9's contract is in the base.

**Declined to judge:**
- The replay route has no UUID validation (Task 14 code).
- The dev-only NPC-fallback warning repeats in the replay specs (pre-existing).
- The backend publishes an encounter's outcome label at its start (Task 9 design).
- The fps targets (Task 23).
- The map-diamond corners inside the camera bounds (accepted in Task 12).
- Live reads and server-side reveal filtering (Task 10), and opening an expedition from the roster (Task 13).
- Task 9 stores `replayExpiry` at settlement (Tasks 9, 10 and 22).
- `startGame` with two overlapping games destroyed in reverse order (pre-existing).

## Round 2: scoped re-review of the fix pass (range `2a102b4..85f48ee`)

**Reviewer evidence:**
- `npm test`: 399 passed. Typecheck: clean.
- Expedition, camp and replay browser specs (desktop and mobile): 115 passed, 3 production-only skips.
- `build` plus `verify:static`: 5 routes, 90 assets, clean, with 0 fixture strings in `out/`.
- `git diff --check`: clean, and `git status` was clean after all runs.

**Confirmed:**
- All five fixes meet their requirements, and each new test fails without its fix.
- The hidden-tab guard causes no state drift: every frame, fade and battle position comes from display time.
- Polling is bounded, restarts on any read, discards superseded results, stops on unmount and runs only while visible.
- The extra scope is justified: the `'leave'` route value, the `onRead` callback, and the oak test sampling one second before arrival.
- The report's "Review fix pass" section matches the code.
- Visuals: the banner is readable at desktop and mobile width and overlaps no control; the health labels fit at 360 px.

**Verdicts:** spec Pass, quality Pass, visual Pass, ready to merge **Yes**.

| # | Minor | Resolution |
| --- | --- | --- |
| 1 | "Health recovers before the next encounter." can read as a full heal (the spec restores 20%). | Fixed in `ab78457`: "Some health recovers before the next encounter." RED on desktop and mobile, then GREEN (expedition spec 46 passed, 2 production-only skips; `npm test` 399 passed). |
| 2 | After a defeat, at minute 80 the gladiator stands up from rest at full opacity, then fades. | Deferred polish (Task 13 or final triage): keep the rest pose while fading when leaving from the safe point. |
| 3 | "Non-final encounter" is `encounter < ORDINALS.length`, which ties a rule to a word list. | Deferred nit: use a named encounter-count constant. |
| 4 | A test title, "reads only the timeline, once per reveal mark and on focus", no longer mentions polling. | Deferred nit. |

**Declined to judge:**
- Two reads on returning to a tab (unchanged; Task 10 replaces the hook).
- The camera glides after a hidden tab (existing follow behavior).
- Phaser renders identical frames while the hidden state is mocked (real browsers stop frames).
- Polls read the whole timeline, not a revision record (interim by design).
- Spectators poll while Preparing (required).
- The scene's aria-label after the gladiator leaves (existing copy).
- No test that the banner animation is off under reduced motion (trivial).
- Replay page and zoom (out of scope).
- An old ignored probe file from 2026-10-12.

## Gates carried forward

- **Task 10:**
  - live `timeline()`, `world()` and `owner()`;
  - server-side reveal filtering, and a payload inspection for future leakage (Minor 6);
  - spectator completion through `timeline.completion`;
  - activity ids stay UUIDs;
  - the sync controller replaces `readDue`.
- **Tasks 10 and 14:** the replay page's display clock and in-progress labels (Minor 2).
- **Task 9 contract:** per-item overflow lines once `CreditedRewards.overflow` is in the base.
- **Task 13:** open an expedition from the roster or character card; the safe-point leave pose (round 2 Minor 2).
- **Integration:** re-run the isolated production gate with the repo's `playwright.config.ts`.
