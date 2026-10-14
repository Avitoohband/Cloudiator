# Task 15 implementation report: followable expedition scenes using only revealed stages

Status: **DONE_WITH_CONCERNS**. Implemented and verified; the independent review (which must also cover `708688b`) is still to come. The concerns are listed under "Limitations".

- Date: 2026-10-14, Asia/Jerusalem. Owner: Claude (a fresh implementer finishing a stopped one; the controller reviews and integrates).
- Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-15-wip`.
- Base: `708688b` (pushed checkpoint `05b1ea0` plus the Task 14 Minor fix). Stopped WIP: `7c57106`. Controller brief: `6ceb5e8`.
- Commits:
  - `b31136b`: `feat: follow automatic isometric expeditions` (source, fixtures, tests and the approved shared edits);
  - `7c2ee9b`: `fix: name nobody in the expedition header before identity is revealed` (found while writing this report; see RED/GREEN 7);
  - the commit that adds this report and `task-15-evidence/`.
- Nothing was pushed or merged. No Supabase command, database, `supabase/**` file or other checkout was touched. Codex's planner was read only from the shared object store (`git show 545a82d:supabase/functions/_shared/domain/expedition.ts`, plus its test and the M06 settlement result for the summary shape).

## Delivered behaviour

**Stage core** (`src/game/expedition-stage.ts`, pure; no Phaser, React, clock or combat engine): `renderExpeditionStage(timeline, displayNowMs)`.
- Only stages with `revealedAtMs <= displayNowMs` exist. A summary exists only once `settledAtMs <= displayNowMs`.
- Phases are `depart`, `exploration`, `encounter`, `safe-return`, `returning`, `arrived`, `preparing` and `settled`.
  - `preparing`: the display clock has passed the end of the last visible stage, but the next stage has not been published. No encounter is invented.
- **Encounter outcomes follow the logged `winnerId` alone** (Task 9 rule, below). Health never decides them.
  - Without a log, the next stage decides: exploration or travel means a victory, a non-zero `return` means a defeat. The published label is the last fallback.
- While a battle is in progress, its log line reads `Encounter N` (marked "in progress"), and nothing reveals its result.
- The state also exposes:
  - progress on the 80-minute strip;
  - route progress: the journey point it walks from and to, the time walked, and what it does on arrival;
  - the search spot;
  - the latest revealed battle with its elapsed time;
  - health read only from the logs: running health during a fight, then `finalHp`, never a computed 20% heal;
  - replay availability: a kept log, and a summary that is not expired;
  - `complete` and `outcome`; `awaitingSummary`.
- The gladiator is identified only by its log id and gear. The logged name is not kept, because Task 9 names participant 0 "Gladiator".
- The result is deep-frozen and deterministic.
- `expeditionRevealMarks(state)`: the moments when a fresh read can reveal more.

**Journey geometry** (`src/game/expedition-path.ts`, WIP, kept): journey points on each map, walkable paths between them, and the gladiator's pose at the manifest walking speed (walk, search, idle, fight, then sit/sleep at the safe point).

**Scene** (`src/game/expedition-scene.ts` and `ExpeditionViewport.tsx`, WIP, kept; loaded lazily through `startGame`):
- **Map.** Each of the three expedition maps is drawn with the camp conventions: baked ground, depth-sliced props, alpha-mask occlusion fades, lights and phase lighting.
- **Journey.** The gladiator walks, searches, waits, fights and rests from the state.
- **Encounters.** During an encounter, the creature stands on the map's enemy tile. Both fighters play the revealed log through `createReplayController` (seeked to display time) and `stageAt`, with effects and damage labels.
  - After the 2 s result poses, the creature fades over 1.5 s; with reduced motion it disappears at once.
  - A 0-HP tie-break winner plays its victory pose, and the creature its defeat pose.
- **Camera and lifecycle.** Follow is the default. A drag or the arrow keys free the camera, and wheel, pinch and buttons zoom within the map bounds. The scene snaps with reduced motion, pauses with a hidden tab, and disposes on unmount and on DESTROY.
- **Failures.** Without WebGL or art, a notice appears; the strip, log and result keep working.
- **Change in this task.** Damage labels sit 14 px higher, because they covered the name label in the first screenshots.

**View** (`src/features/character/ExpeditionView.tsx` with `ExpeditionView.module.css`):
- **Header.** The expedition name, then `EXPEDITION · <name>`. A spectator sees `Another gladiator's journey`.
- **Panels.** The scene with the camera controls, the current phase, a `Gladiator health` meter, and a progress strip with markers at 0, 20, 40, 60 and 80 and the current position. The activity log has local times, "in progress" badges and a `Watch replay` link for each revealed, available encounter (`/replay/?[mode=fixture&]activity=…&stage=…`). A **Camp** button leads to `/game/` (keeping `mode=fixture`).
- **Failure copy.** While resting after a defeat, the phase title reads `Returning without rewards` (the only element with that text), the log ends on `Rest at the safe return point`, and the result card says no rewards.
- **Completion.** Once the expedition arrives, the result shows Success or Defeated from the revealed encounters.
  - Owner only: before the summary is visible, the result reads `Processing results…`. Afterwards, the credited rewards and the replay retention come only from the summary.
  - A spectator never sees rewards or a wait.
- **Identity.**
  - The name and gear come from the world actor whose `activityId` matches. Otherwise the name comes from the world actor with the log's gladiator id, or from the owner's own `owner()` record.
  - Ownership means a summary is visible in the state (only once `settledAtMs` has passed), or `owner().gladiatorId` equals the expedition's gladiator id.
  - Before either is known (a fixture before its first encounter), the header reads just `EXPEDITION`.
  - `world()` and `owner()` are read once, after the timeline exists. In live mode today, neither runs.
- **Reads.** The view reads the timeline on entry, once per reveal mark passed (`passMarks`, now `readDue` with a 30-second poll; see "Review fix pass"), and on focus or visibility. A later failed read keeps the last timeline. The display clock never runs backwards, and a server ahead of it moves it forward.
- **What it never does.** The view never sends a command. All names and labels are React text.

**Route** (`src/app/expedition/page.tsx`, approved shared edit): a fixed page copying the replay pattern (`Suspense` with `useSearchParams`).
- `src/features/character/expedition-query.ts` parses the query:
  - `activity` must be UUID-shaped; anything else shows "This expedition is not available" without a read;
  - fixture mode needs `mode=fixture` in a fixture-enabled build. `next.config.ts` forces `NEXT_PUBLIC_FIXTURE_ENABLED` to `false` in production exports, so this is the existing production denial rule.
  - `minute=<0..90>` (up to three decimals) is read only in fixture mode. It sets where the fixture display clock starts and grants nothing else.
- Fixture mode imports the fixture gateway behind the build flag. Otherwise the page uses `createLiveGateway()`, whose `timeline()` is unavailable until Task 10, so the page shows the unavailable state.

**Fixtures** (`tests/fixtures/expeditions/*.json`, engine-generated by `tests/domain/expedition-fixtures.test.ts`):
- The generator mirrors `planExpedition` at `545a82d`:
  - stage building, labels and stage ids `<activity>:<index>`;
  - battle ids `<activity>:encounter:N` and seeds `<seed>:encounter:N`;
  - participant 0 named `Gladiator`, with `startingHealth` always passed;
  - `creature:<manifest id>:N` (the map's encounter creature) and the canonical enemy template;
  - the floored 20% carry.
- Its summaries mirror the M06 expedition settlement result:
  - `victory` or `defeat`;
  - the catalog XP and money, retained gear then stacked salvage;
  - nothing after a defeat;
  - replays available until the activity's end plus 7 days.

| Fixture | Seed | Shape (opened at) |
| --- | --- | --- |
| `woodland` | `fixture-woodland-17` | 3 wins (134→104, 130→105, 131→116 of 134); settled, +20 money, +100 XP, light boots, salvage (minute 200) |
| `outpost` | `fixture-outpost-78` | win, then a defeat in encounter 2; no summary (minute 65) |
| `mountain` | `fixture-mountain-0` | win, win, defeat in encounter 3; settled with no rewards (minute 95) |
| `delayed` | `fixture-delayed-0` | encounter 2 not published at minute 45 (only 3 stages) |
| `expired` | `fixture-expired-0` | 10 days old: logs pruned, summary `replayExpiry: expired` |
| `spectator` | `fixture-spectator-17` | Varro, defeated in encounter 1; no summary and no reward words (minute 30) |
| `tiebreak` | `fixture-tiebreak-148` | encounter 1 is a simultaneous defeat whose tie-break names the gladiator at 0/100 HP; encounter 2 starts at 20 and is lost (5 s before encounter 1 ends) |
| `laststand` | `fixture-laststand-565` | wins 100→64 and 84→39; encounter 3 is a 0-HP tie-break win; settled success (+120 money, +500 XP, salvage ×3) |

Both tie-break fixtures use the canonical spear at 20 effective Agility (1000 ms, the Mountain enemy's interval), a technique taken from Codex's regression. The seeds are this generator's own deterministic first matches:
- `tiebreak` uses Strength 5;
- `laststand` uses Strength 34. With Strength 30, the first matching seed was n = 16597, which is too slow to search in a test.

The fixture gateway serves all eight timelines. `FIXTURE_EXPEDITIONS` feeds the fixture-only "Sample expeditions" list on `/game/`.

## Interfaces

- `src/game/expedition-stage.ts`:
  - functions: `renderExpeditionStage`, `expeditionRevealMarks`;
  - constants: `EXPEDITION_MS`, `ENCOUNTER_INTERVAL_MS`, `EXPEDITION_APPROACH_MS`, `JOURNEY`;
  - types: `ExpeditionSceneState`, `VisibleStage`, `ExpeditionBattle`, `RouteProgress`, `JourneyPoint`, `ExpeditionPhase`.
- `src/game/expedition-path.ts`:
  - functions: `journeyMap`, `legPath`, `gladiatorPose`;
  - constant: `REST_PATTERN`.
- `src/game/expedition-scene.ts`: `createExpeditionScene(P, deps)` returns `{ scene, handle }`. The handle is `{ setReducedMotion, setLook, dispose, debug, props }`.
- `src/game/ExpeditionViewport.tsx`: `ExpeditionViewport({ environment, state, look, bridge, reducedMotion, label })`.
- `src/features/character/ExpeditionView.tsx`:
  - `ExpeditionView({ reads, activityId, fixture, startMinute })`;
  - `ExpeditionUnavailable({ fixture, reason })`;
  - `ExpeditionReads = Pick<GameGateway, 'timeline' | 'world' | 'owner'>`.
- `src/features/character/expedition-query.ts`: `expeditionQuery(params, fixtureBuild)` returns `{ requested, fixture, activityId, minute }`.
- Fixture-only test hooks:
  - `window.__cloudiatorExpedition`: `state`, `freeze`, `reads`, `listeners`, `loops`;
  - `window.__cloudiatorExpeditionScene`: `debug`, `props`, `canvases`.
- Fixtures:
  - `EXPEDITION_FIXTURES` and `EXPEDITION_GLADIATORS` (`tests/fixtures/expedition-ids.ts`, no JSON imports, so browser specs can use them);
  - `EXPEDITION_FIXTURE_TIMELINES`, `EXPEDITION_TIMELINES` and `EXPEDITION_SAMPLES` (`tests/fixtures/expeditions.ts`);
  - `FIXTURE_EXPEDITIONS` (fixture gateway).
- Bridge: unchanged. The page-scoped bridge carries `camera-zoom`, `camera-pan`, `follow-character` and `scene-unavailable`; `view-expedition` and `return-camp` stay for Task 13.

## Controller decisions, the addendum and how they were resolved

All six dispatch decisions are implemented as written, with the stage core and the scene split as decision 1 asks.

**Addendum 1, the winner rule.** Fixed test-first in both WIP places; see RED/GREEN 1 and 2. Both tie-break fixtures exercise the stage core, the log labels, health and the scene poses.

**Addendum 2, mirroring.** Covered under "Fixtures": ids, labels, the "Gladiator" name and the settlement result.

**Addendum 3, approved shared edits.** Each condition is met:
- the existing production denial rule (`next.config.ts`), not just the URL flag;
- `minute` is parsed only inside the fixture guard;
- query-id validation (UUID shape);
- unavailable, expired and scene-failure states that stay accessible;
- no outcome simulation and no private plan in the renderer;
- no style, live gateway or contract edits. `globals.css` is untouched; the route reuses existing global classes such as `replay-page` and `sample-replays`.

The evidence these edits require is under "Commands and results" and "Evidence".

**Ambiguities resolved.**
1. **Summary timing.** The fixture timeline holds every stage and summary. A summary counts only once its `settledAtMs` has passed on the display clock, so a fixture can never show results early.
2. **Owner or spectator.** The state cannot know who is watching, so the view decides (see "Identity" above). The expired fixture has no logs; its summary makes it the owner's.
3. **Health between encounters.** It shows the last log's `finalHp`, which is 0 after a tie-break win. The next encounter's log then shows the server's healed `initialHealth`. Showing the heal earlier would mean computing it in the browser. *Review fix pass:* the label now names the encounter the value comes from, with a static recovery note; still no computed heal.
4. **After minute 80.** The scene leaves the gladiator waiting at the trail's end (the way back to camp), while the text says "Back at camp". *Superseded by the review fix pass:* the gladiator now leaves the scene and the scene shows "Returned to camp".
5. **A defeat's creature.** After the result poses, the creature fades out whether it won or lost.
6. **Text uniqueness.** Phase titles never contain "Encounter N", so the plan's `getByText('Encounter 1')` and `'Returning without rewards'` assertions each match exactly one element.
7. **Production gate harness.** The dispatch allows Playwright only through `pw-claude.config.mjs`. That config therefore gained a static mode: with `PLAYWRIGHT_STATIC=true` it serves `PLAYWRIGHT_STATIC_ROOT` on port 3200 through a private copy of `scripts/serve-static.mjs` (`node_modules/.cache/serve-static-3200.mjs`). This replaces the repository config's port 4173. Both files are ignored local tooling.

No spec conflict was found.

## WIP audit (`7c57106`)

Every WIP test was checked for a meaningful RED by breaking the behaviour it guards, then restored.

| WIP item | Verdict | What changed |
| --- | --- | --- |
| `expedition-stage.ts` | **Fixed** | `logOutcome` used the old 0-HP-is-defeat rule (replaced by `winnerId` alone). The logged name was removed from `gladiator`, which now uses `gladiatorId`. Everything else is kept. |
| `expedition-stage.test.ts` | **Kept and extended** | 15 WIP tests, all with a RED (see the mutations below). One type error (a readonly cast) failed `tsc` and was fixed. 4 tests added (two tie-break rules, the poses, identity). |
| `expedition-fixtures.test.ts` and JSON | **Replaced** | It now mirrors the committed planner instead of the board description: battle and seed ids, the "Gladiator" name and the settlement result. `won` was fixed, all seeds re-searched and two tie-break fixtures added. |
| `expedition-ids.ts`, `expeditions.ts` | **Extended** | Two fixtures and the comments. |
| `expedition-path.ts` and its test | **Kept** | The test's hand-written fixture-to-map table now comes from `EXPEDITION_FIXTURES`. |
| `expedition-scene.ts` | **Kept, one fix** | Damage labels were lifted 14 px. |
| `ExpeditionViewport.tsx` and its CSS | **Kept** | Verified by the browser suite. |
| `ExpeditionView.tsx` (stopped mid-edit) | **Reworked and completed** | Identity and ownership, world and owner read after the timeline, phase and result copy, `ExpeditionUnavailable`, `passMarks`, test-hook fields, and the missing CSS module. |
| fixture gateway and its tests | **Kept** | Mutation-verified. |

## RED and GREEN evidence

1. **Generator winner rule.** The new test "labels a zero-HP tie-break win a victory…", with the WIP `won` (`winnerId && finalHp > 0`), failed: `expected 'Encounter 1: defeat' to be 'Encounter 1: victory'` (`fixture-tiebreak-148`). With `won = winnerId` it passed, and all 12 generator tests pass. Because ids and seed derivation changed, the seed search reported new first seeds. They were recorded and the JSON regenerated with `UPDATE_EXPEDITION_FIXTURES=1`.
   - Mutation: one label byte edited in `woodland.json` made 1 test fail.
   - Mutation: the heal as `ceil(21%)` made 7 tests fail.
2. **Stage-core winner rule.** The two new tie-break tests failed against the WIP `logOutcome`: `outcome` was `"defeat"` while the server label already read `Encounter N: victory`. Both pass with `winnerId` alone. The pose test failed when `planStage`'s winner was derived from `finalHp`.
3. **WIP test mutations** (31 tests in the stage, path and gateway files). Each mutation made the named tests fail; every file was then restored:

   | Mutation | Failed |
   | --- | --- |
   | No reveal filter | 10 |
   | No in-progress label | 2 |
   | A 20% heal computed in the browser | 3 |
   | Expiry ignored | 1 |
   | Summary not gated | 5 |
   | No `preparing` | 1 |
   | `freeze` a no-op | 1 (purity) |
   | Approach timing doubled | 3 |
   | No stage-end mark | 1 |
   | Arrival without the tile centre | 1 |
   | Sit and sleep swapped | 1 |
   | Straight-line legs | 1 (walkable) |
   | Gateway without expedition timelines | 2 |
4. **Identity.** The new test failed while the state carried the logged name, then passed.
5. **Query and route.**
   - `expedition-query.test.ts` failed first because the module did not exist; then 3 tests passed.
   - "scanner refuses an export without the fixed expedition page" failed (`expected 0 to be 1`) before `verify-static.mjs` required the route; then all 22 static tests passed.
6. **Browser.**
   - With `src/app/expedition/page.tsx` removed, the plan's Step 1 test timed out waiting for the view: no journey, no current stage.
   - With the reveal filter removed, Step 1 failed on `getByText('Encounter 2')` (expected 0, received 1), and the reads test failed too.
   - With the WIP's 0-HP rule restored, the tie-break browser test failed on `laststand` at minute 80: `"ResultDefeatedProcessing results…"`, where Success was expected.
   - The first full desktop run passed 17 of 19. Two expectations were wrong:
     - Outpost has 5 log items at minute 65, not 4.
     - Development React runs the entry effect twice, so the first read count can be 2.

     The spec now allows 1 or 2 and checks increments from there.
   - The first production run failed on the exported router's same-origin `HEAD` link prefetches. That assertion now allows same-origin `GET` and `HEAD` only.
7. **Header identity** (`7c2ee9b`). Ownership read the raw `timeline.summary`, which a fixture holds before it is due, so the owner's name showed from minute 0. The new minute-table assertion expected `EXPEDITION` at minute 10 and received `EXPEDITION · Aster`. It passed once ownership read the state's gated summary.

## Commands and results (final source, `7c2ee9b`)

```text
npm test                                        20 files, 397 passed
npm run typecheck                               tsc clean; Deno check; Deno test 2 passed
node assets/source/build-assets.mjs --check     assets up to date (28 files); no art changed, review sheets not rerun
npm run build                                   static: /, /_not-found, /auth/callback, /expedition, /game, /replay
npm run verify:static                           Static export verified: 5 fixed routes; 90 assets scanned; no forbidden backend material.
grep -rl <fixture data> out/                    0 files each: expedition activity ids, fixture-receipt, creature:dire-wolf:1, Varro,
                                                "Recover and continue exploring", light-boots:1:uncommon, the fixture gateway's text
npx playwright test -c node_modules/.cache/pw-claude.config.mjs          (dev, port 3200, desktop + mobile)
                                                145 passed, 7 skipped (expected: shell production-only 4, camp pinch on desktop 1,
                                                expedition production-only 2); expedition.spec 19 tests x 2 projects
CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build
npm run verify:static -- .next/browser-test     5 fixed routes; 90 assets; no forbidden backend material; same fixture greps 0 files
PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test -c node_modules/.cache/pw-claude.config.mjs
  tests/browser/shell.spec.ts tests/browser/camp.spec.ts tests/browser/replay.spec.ts tests/browser/expedition.spec.ts
                                                8 passed, 110 skipped (fixture-only suites)
git diff --cached --check                       clean
```

In the export, "Sample expeditions" appears only as the game page's JSX `aria-label`, beside the existing "Sample replays". The fixture data and the fixture gateway are absent.

**Production fixture denial** (the exported-route test, both projects):
- `/expedition/?mode=fixture&activity=<woodland or spectator>&minute=39` shows "Fixture preview is unavailable in this build." and "This expedition is not available";
- there is no canvas and no test hook;
- no fixture names, expedition names or labels appear;
- Camp leads to `/game/`;
- the exported `/game/?mode=fixture` has no Sample expeditions;
- every request is a same-origin `GET` or `HEAD`, with none to Supabase.

**The expedition browser spec covers:**
- the plan's Step 1 assertions (minute 39, failure at minute 65);
- the 19/20/39/40/59/60/79/80 table for the success and for a defeat in each encounter;
- Preparing for the delayed reveal, with the gladiator waiting at encounter 2's tile;
- reload and new navigation landing on the current progress, with the scene pose equal to `gladiatorPose` at that time;
- Watch replay opening the named stage (by the replay hook's `battleId`), no link while a battle runs, none for pruned logs;
- leaving for the camp, returning through a sample link, back/back and reload, with equal bridge listeners, clock loops, canvases and document `visibilitychange` listeners, and a 1× clock;
- the spectator view, with no reward text at minutes 30, 80 and 85 and no Processing results;
- owner settlement only from the summary (Processing results one millisecond before `settledAtMs`, then the reward lines) and `laststand`;
- the 0-HP tie-break (log, meter at 0, victory and defeat animations, exploring on);
- Follow by default, free after a drag, Follow again, and zoom within bounds;
- reduced motion (the creature disappears at once and the camera snaps) and the fade without it;
- without WebGL and without art;
- a 360 px screen and the keyboard;
- reads only once per mark and on focus, with no remote, non-GET or Supabase request, and no later-stage text at minute 39;
- unknown, malformed and live ids;
- prop slices by the shared depth rule, the gladiator on walkable tiles and at the depth of its feet, both fighters on their encounter tiles, and the oak that hides the waiting gladiator at the trail's end faded (checked against the shipped PNG alpha);
- all three environments with their creatures.

## Evidence (`docs/implementation/task-15-evidence/`)

| File | Shows |
| --- | --- |
| `desktop-expedition-woodland-minute-39.png` | Mid-slot entry: Aster searching at search spot 2, Exploring, health 104/134 |
| `desktop-expedition-woodland-encounter-1.png` | Revealed encounter playback in the Woodland: Aster against a dire wolf, a MISS label above |
| `desktop-expedition-outpost-encounter-2.png` | Ruined Outpost environment: the raider archer fight, damage labels |
| `desktop-expedition-mountain-encounter-2.png` | Mountain Pass environment: the frost troll fight |
| `desktop-expedition-outpost-minute-65-safe-point.png` | Failure: `Returning without rewards`, resting at the safe point by the tent, health 0/155 |
| `desktop-expedition-tiebreak-victory-at-0hp.png` | The 0-HP tie-break winner in its victory pose, the troll down with stars, health 0/100, Exploring |
| `mobile-expedition-tiebreak-victory-at-0hp.png` | The same on a Pixel 7 |
| `desktop-expedition-delayed-preparing.png` | Preparing at minute 45: waiting at encounter 2's tile, no creature |
| `desktop-expedition-spectator.png` | Another gladiator's journey: "Gladiator" asleep at the safe point, no rewards |
| `desktop-expedition-woodland-arrival-behind-oak.png` | The trail's end at minute 85: the oak in front of the gladiator faded; evening light (refreshed in the review fix pass: one second before arrival, because the gladiator has left by minute 85) |
| `desktop-expedition-woodland-settled.png` | Full page: Success, credited rewards from the summary, retention note, the full log with Watch replay links |
| `width360-expedition-mountain-encounter.png` | A 360 px screen, full page during Mountain encounter 3 |
| `production-expedition-fixture-refused.png` | The exported route refusing `mode=fixture&minute=39` |

The small "N" in development screenshots is the Next.js development indicator. The development screenshots come from the `b31136b` run. The `7c2ee9b` fix changes only the header before identity is known, which no screenshot captures. The production screenshot comes from the final `7c2ee9b` gate. The review fix pass refreshed every development screenshot above (see that section); the production one is unchanged.

## Files

**Named in the plan's Files list:** `src/game/expedition-scene.ts`, `src/features/character/ExpeditionView.tsx`, `tests/browser/expedition.spec.ts`, and the fixture-gateway timelines (`src/lib/api/fixture-gateway.ts`). The bridge already had `view-expedition` and `return-camp`, so it is unchanged.

**Outside the plan's Files list:**
- Controller-decided (dispatch decisions 1–3 and 5):
  - `src/game/expedition-stage.ts`, `src/game/ExpeditionViewport.tsx`, `src/game/ExpeditionViewport.module.css`;
  - `src/features/character/ExpeditionView.module.css`;
  - `tests/fixtures/expeditions.ts`, `tests/api/fixture-gateway.test.ts`, `tests/domain/expedition-stage.test.ts`, `tests/domain/expedition-fixtures.test.ts`.
- WIP helpers kept: `src/game/expedition-path.ts`, `tests/domain/expedition-path.test.ts`, `tests/fixtures/expedition-ids.ts`, `tests/fixtures/expeditions/*.json` (8) and `.gitattributes` (`-text`, so byte comparison survives checkout).
- Added by this implementer: `src/features/character/expedition-query.ts` and `tests/domain/expedition-query.test.ts`.
- Shared, approved by Codex: `src/app/expedition/page.tsx`, `scripts/verify-static.mjs`, `tests/static.test.ts`, `src/app/game/page.tsx` (the fixture-only list).
- Local and ignored (not committed): `node_modules/.cache/pw-claude.config.mjs` (static mode) and `node_modules/.cache/serve-static-3200.mjs`.

`HANDOFF.md`, `globals.css`, contracts, the live gateway and `supabase/**` are unchanged.

## Limitations

- **Fixtures hold every stage.** The fixture gateway has no clock, so each fixture timeline contains its future stages and summary. Only the pure core's `revealedAtMs` and `settledAtMs` rules hide them. Server-side reveal filtering is Task 10's.
  - A side effect: a fixture replay opened from the view lists every encounter in that fixture timeline, including encounters not yet due on the expedition's display clock. With real published timelines, only due stages exist.
- **Live mode** shows the unavailable state until Task 10 provides `timeline()` and `world()`.
- **Refetch cadence.** The dispatch rule refetches at the marks and on focus only. A stage published late, while Preparing shows, appears at the next 20-minute mark or on focus, not at once. Task 10's 30-second revision poll closes this. *Closed in the review fix pass by an interim 30-second poll while Preparing or awaiting the owner's summary.*
- **The world fixture is unchanged.** Fixture expeditions therefore never match an actor by activity, so the look comes from the first log.
  - The owner's name comes from the world actor with the log's gladiator id, or from `owner()`. Before the first revealed log, the fixture view cannot tell the owner from a spectator, so it names nobody.
  - Before the first encounter is revealed, the owner's gladiator draws in default gear (a fixture-only effect).
- **Scene approximations.**
  - At minute 80 and later, the gladiator stays at the trail's end in the scene. *Fixed in the review fix pass: it leaves the scene.*
  - A creature that won also fades after the result poses.
  - Follow glides at a fixed 0.12 per frame.
  - Fps targets remain Task 23.
- **The `CreditedRewards.overflow?` field** from Task 9 (`e96e0f1`) is not in this base. The view lists `overflowMoney` only; per-item overflow lines can be added once the contract is merged.
- **The `visibleThroughMs` timeline field is not used.**

## Gates for later tasks

- **Task 9 (integration).** If the merged planner changes stage ids, labels, battle ids, the participant name, creature ids, heal or carry, or the settlement result shape, regenerate with `UPDATE_EXPEDITION_FIXTURES=1` after updating the generator. The generator and its tests must keep the `winnerId`-only rule. Confirm Task 9's public stage rows keep the whitelisted log fields this view reads: `initialHealth`, `finalHp`, `winnerId`, `tieBreakReason` and `equipmentSilhouettes`.
- **Task 10.**
  - Implement live `timeline(id)` (only due stages, `reveal_at <= database time`), `world()` and `owner()` for this page.
  - Keep the owner/spectator split: no summary on another owner's timeline.
  - Replace `useTimelineReads` and `readDue` (formerly `passMarks`) in `ExpeditionView.tsx` with the shared sync controller (revision poll, hidden-tab pause, focus refresh).
  - Decide whether the view should use `visibleThroughMs`.
- **Task 13.**
  - Open `/expedition/?activity=<id>` from the camp roster or character card (`view-expedition`), and emit `return-camp` if the camp needs it.
  - Give the camp's away indicator a link here.
  - Use the shared live sync clock and the scene-availability status for late panels.

## Review fix pass

Status: **DONE**. The independent review found spec, quality and visual Pass, ready to merge, with Minors only. The controller chose five Minors to fix now; each was fixed test-first.

- Date: 2026-10-14, Asia/Jerusalem. A fresh implementer, same worktree and branch, on top of `2a102b4`.
- Commits:
  - `fa27a50`: `fix: apply Task 15 review Minors` (source and tests);
  - the commit that adds this section and the refreshed evidence.
- Not changed, as instructed: the replay page's behaviour (`src/game/replay.ts`) and the default zoom. Both remain later gates.
- Nothing was pushed or merged. No Supabase command was run. `HANDOFF.md` is untouched. Playwright ran only through `node_modules/.cache/pw-claude.config.mjs` on port 3200.

### What changed

| # | Minor | Change | Files |
| --- | --- | --- | --- |
| 1 | After arrival, the text says the gladiator is back at camp, but the scene still shows it on the trail or at the safe point. | **Core.** `RouteProgress.then` gains `'leave'`. Once the final `Arrive at camp` stage is current, the route is `{ from: X, to: X, then: 'leave' }`, where X is `end` after a success and `safe` after a defeat; `walkedMs` counts from the arrival.<br>**Scene.** The gladiator and its name label fade out over 1.5 s (`HERO_LEAVE_MS`); with reduced motion they disappear at once. Props no longer fade for a gladiator who has left. A new `onReturned` callback tells the viewport.<br>**Viewport.** A "Returned to camp" banner appears over the scene, but only while the scene is ready (never in a WebGL or art fallback). It fades in through CSS, with no animation under reduced motion.<br>**Debug hook (fixture-only).** New fields `returned`, `gladiator.alpha` and `gladiator.labelVisible`. | `src/game/expedition-stage.ts`, `expedition-scene.ts`, `ExpeditionViewport.tsx`, `ExpeditionViewport.module.css` |
| 2 | Health reads 0 while exploring after a tie-break win. | **Label.** The health label now says which encounter the value comes from: "Health during/after the first/second/third encounter", taken from `hp.encounter` and whether that stage is still in progress. The meter's `aria-valuetext` says the same.<br>**Note.** After a won encounter 1 or 2, a static note reads "Some health recovers before the next encounter." No heal is computed.<br>**Ordinal words.** The label uses "first, second, third" rather than "encounter 1". Playwright's `getByText` matches a case-insensitive substring by default, so "Health after encounter 1" would also match the plan's `getByText('Encounter 1')`. That would break the text-uniqueness rule (ambiguity 6). | `src/features/character/ExpeditionView.tsx`, `ExpeditionView.module.css` |
| 3 | No hidden-tab test for this scene. | **Test.** A hidden/visible test modelled on the one in `replay.spec.ts`.<br>**Defect found.** The scene kept drawing while hidden. The cause is Phaser 4.2.1's `HIDDEN` handler, `Game.onHidden` → `TimeStep.pause()`, which only records the pause time. The animation-frame loop and `update()` keep running whenever the browser keeps delivering frames.<br>**Fix.** `update()` now returns early while `document.visibilityState === 'hidden'`. The first frame back reads the current display time. | `src/game/expedition-scene.ts` |
| 4 | `kept` reads the ungated summary. | `kept` now comes from the `settledAtMs`-gated summary, like every other summary field. | `src/game/expedition-stage.ts` |
| 5 | The interim re-read cadence can stall for up to 20 minutes. | **Function.** `passMarks` became `readDue(schedule, state, owner)`. It is still the one small function Task 10's sync controller replaces, and it keeps the mark reads.<br>**Poll.** While the tab is visible and the phase is `preparing`, or the owner's summary is awaited (`owner && awaitingSummary`), a read is due once `POLL_MS` (30 s, spec 10.5) of display time have passed since the last read.<br>**Restart.** Every read restarts the interval: entry, schedule or focus/visibility. `useTimelineReads` reports reads through a new `onRead` callback. The first tick after entry starts the interval, and a fixture clock held back in time restarts it.<br>**Owner.** Ownership reaches the tick through `ownerRef`. A spectator never polls for a summary.<br>**Hidden tab.** The tick already returns early while hidden, so polling pauses. | `src/features/character/ExpeditionView.tsx` |

### RED and GREEN

1. **Arrival.**
   - New unit test "has the gladiator leave the scene once it arrives at camp, from where it last was". RED: `then: "wait"` where `"leave"` was expected. Three existing assertions were updated to `then: 'leave'` and failed the same way (minute table after a defeat, `laststand` at minute 80, the journey at minute 85).
   - New browser test "has the gladiator leave the scene once the expedition is back at camp, and says so in the scene". RED: `returned` was `undefined`.
   - The reduced-motion test's new arrival check failed too: the gladiator was still shown.
   - GREEN, for the Woodland success and the Outpost defeat:
     - 1 s before arrival: in full view at the trail's end or the safe point;
     - 0.75 s after: alpha between 0.2 and 0.8, `returned: true`;
     - 5 s after: invisible, label hidden, no prop faded, "Returned to camp" visible;
     - the phase still reads "Back at camp" or "Back at camp after a defeat";
     - mid-journey: no banner;
     - reduced motion: hidden 0.1 s after arrival;
     - without WebGL: no banner, and "Back at camp" in the text.
   - Two `expedition-path` assertions (a `leave` route poses idle at its point) passed at once, because `gladiatorPose` already treated other arrival actions as idle. They guard that behaviour; they were not a RED.
2. **Health.** New browser test "names the encounter the shown health comes from, and notes the recovery after a non-final win".
   - RED: "Health after the first encounter" was not found.
   - GREEN:
     - `tiebreak` after encounter 1: 0/100, labelled "after the first encounter", with the note (also at minute 39.9);
     - during encounter 2: "during the second encounter", no note;
     - after the encounter 2 defeat: "after the second encounter", no note;
     - Woodland at minute 59: "after the second encounter" with the note;
     - Woodland at minute 70: "after the third encounter", no note;
     - `getByText('Encounter 1')` still matches exactly one element at minute 39.
3. **Hidden tab.** New browser test "pauses the scene while the tab is hidden and shows the current moment when it returns". It opens Woodland at minute 5, while the gladiator walks.
   - RED: while hidden, the scene's `displayNowMs` moved from …100855.6 to …101666.9 (811 ms). This confirmed the scene did not pause.
   - GREEN while hidden: `displayNowMs`, the gladiator debug state and the camera stay identical for 800 ms, with no read.
   - GREEN once visible again: exactly one refresh. The scene then jumps more than 800 ms ahead, to within 500 ms of the view's clock, with the pose that `gladiatorPose` gives for that time.
4. **`kept`.** New unit test "reads replay expiry only from a summary that is settled by the display time". It uses a Woodland timeline whose summary says the replays expired.
   - RED: minute 39 gave `[]` where `[1]` was expected.
   - GREEN: `[1]` at minute 39, `[1, 2, 3]` at minute 80 and at `settledAtMs - 1`, and `[]` at `settledAtMs`.
   - The old assertion `replays(at(expired, 39)) = []` encoded the ungated read, so it was removed.
5. **Cadence.** New browser test "re-reads every 30 seconds while a due stage or the owner's summary is awaited, and stops once it arrives". It uses the fixture clock: `freeze` through the debug hook, 0.7 s of ticks per step.
   - RED: in the `delayed` fixture at +30 s, the count stayed at 2 where 3 was expected.
   - GREEN, `delayed`, Preparing from minute 46:00: no read at +10, +20 or +29.5 s. One read each at +30 s and +60 s, none at +45 or +89.5 s.
   - GREEN, Woodland held 2 minutes before departure (Preparing, nothing revealed): one read at +30 s. When the departure appears, the reads stop: none at +31, +61 or +91 s.
   - GREEN, the owner's Woodland at minute 80 (Processing results): one read at 80:30. None once the summary settles at 80:45, nor 30, 60 or 90 s later.
   - GREEN, spectator at minute 85: no read over 90 s.

### Commands and results (final source, `fa27a50`)

```text
npm test                                        20 files, 399 passed (was 397: +2 stage tests)
npm run typecheck                               tsc clean; Deno check; Deno test 2 passed
node assets/source/build-assets.mjs --check     assets up to date (28 files); no art changed
npm run build                                   static: /, /_not-found, /auth/callback, /expedition, /game, /replay
npm run verify:static                           Static export verified: 5 fixed routes; 90 assets scanned; no forbidden backend material.
grep -rlE <fixture data> out/                   0 files: expedition activity ids, fixture-receipt, creature:dire-wolf:1, Varro, Aster,
                                                "Recover and continue exploring", light-boots:1:uncommon, the fixture gateway's text
npx playwright test -c node_modules/.cache/pw-claude.config.mjs          (dev, port 3200, desktop + mobile)
                                                153 passed, 7 skipped (the same expected skips); expedition.spec 23 tests x 2 projects
CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build
npm run verify:static -- .next/browser-test     5 fixed routes; 90 assets; no forbidden backend material; same fixture greps 0 files
PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test -c node_modules/.cache/pw-claude.config.mjs
  tests/browser/shell.spec.ts tests/browser/camp.spec.ts tests/browser/replay.spec.ts tests/browser/expedition.spec.ts
                                                8 passed, 118 skipped (fixture-only suites)
git diff --check / git diff --cached --check    clean
```

The new UI strings "Returned to camp" and "Some health recovers before the next encounter." appear in one exported JavaScript chunk, as view copy. No fixture data appears.

### Evidence refreshed (`docs/implementation/task-15-evidence/`)

Every development screenshot was replaced from the final `fa27a50` dev run, because the health label appears in all of them. The production screenshot is unchanged.

| File | Shows now |
| --- | --- |
| `desktop-expedition-woodland-returned-to-camp.png` (new) | Minute 85: the gladiator gone, "Returned to camp" over the scene, "Back at camp", health after the third encounter |
| `mobile-expedition-woodland-returned-to-camp.png` (new) | The same on a Pixel 7 |
| `desktop-expedition-woodland-settled.png` | Full page at settlement: the banner over an empty trail's end, Success, credited rewards, the full log |
| `desktop-expedition-woodland-arrival-behind-oak.png` | One second before arrival: the waiting gladiator behind the faded oak, "Returning to camp" |
| `desktop-expedition-tiebreak-victory-at-0hp.png`, `mobile-…` | Exploring after the tie-break: "Health after the first encounter 0 / 100" and the recovery note |
| `desktop-expedition-woodland-minute-39.png` | Searching at spot 2; health after the first encounter with the note |
| `desktop-expedition-outpost-minute-65-safe-point.png` | Returning without rewards; "Health after the second encounter 0 / 155", no note |
| `desktop-expedition-delayed-preparing.png`, `desktop-expedition-spectator.png` | As before, with the qualified health label |
| `desktop-expedition-{woodland-encounter-1,outpost-encounter-2,mountain-encounter-2}.png`, `width360-expedition-mountain-encounter.png` | The fights, with "Health during the … encounter" |

### Notes and remaining limitations

- **Banner as DOM text.** The "Returned to camp" banner is DOM text over the canvas, not drawn by Phaser. It stays crisp at every zoom step and uses the app's type. Without a scene, the phase text alone says the gladiator is back.
- **Display-time polls.** The interim poll counts display time, which runs in real time while the tab is visible. In live mode, a read that finds the server clock ahead moves the display clock forward. While a stage is still awaited, that can make the next tick's poll due at once: one extra read, after which the interval restarts. Live reads stay unavailable until Task 10.
- **Fixture summaries.** As before, a fixture's summary "arrives" when the display clock passes `settledAtMs`. The extra reads return the same full fixture timeline.
- **Unchanged later gates.** The replay page's behaviour and the default zoom, as instructed.
