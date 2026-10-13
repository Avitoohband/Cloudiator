# Task 15 dispatch: followable expedition scenes (controller: Claude)

The binding plan and spec text is in `docs/implementation/task-15-brief-base.md`. Read it fully first.

## Where and with whom

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/visual-track`. Base: `708688b` (the pushed integration checkpoint `05b1ea0` with reviewed Tasks 1–8, 11, 12 and 14, plus the Task 14 Minor fix). Record the base in your report.
- Codex is implementing **Task 9 (expedition plans and settlement)** in parallel in `C:\Avi\Studies\Projects\Cloudiator`. Never write to, run tools in, reset or commit in that folder. Never touch `supabase/**`, the local database or the Edge runtime. Task 15 needs no Supabase command.
- Never touch `C:\Avi\Studies\Projects\Cloudiator-replay`.
- Ports: the private Playwright config `node_modules/.cache/pw-claude.config.mjs` runs a dev server on **port 3200**. Never use ports 3000, 3100 or 3300.
- Do not push, merge, or dispatch subagents. The controller reviews and integrates.

## Read first

- In the worktree: `AGENTS.md` (read the relevant `node_modules/next/dist/docs/` guide before writing Next code); `docs/implementation/HANDOFF.md`; `docs/implementation/task-11-report.md`, `task-12-report.md`, `task-14-report.md` and `task-14-review.md` (asset, scene and replay conventions, and the lessons learned); `docs/operations/art-review.md`; `assets/source/README.md`.
- Contracts: `supabase/functions/_shared/contracts/events.ts` (`RevealedStage`, `RevealedTimeline`, `BattleLog`, `ActivitySummary`), `contracts/reads.ts` (`PublicActor`, `WorldSnapshot`).
- Domain: `supabase/functions/_shared/domain/combat.ts` (`makeFighter`, `simulateBattle`), `catalog-v1.ts` (`expeditions`), `rules-v1.ts` (clock).
- Game code: `src/game/*` — especially `GameViewport.tsx`, `camp-scene.ts` (map drawing, depth, occlusion, camera, dispose, fixture test hook), `BattleViewport.tsx`, `battle-scene.ts`, `battle-stage.ts` (`creatureFor`, `fighterLook`), `replay.ts` (`createReplayController`, `replayViewOf`), `phaser-game.ts` (`startGame`), `camera.ts`, `paths.ts`, `depth.ts`, `assets.ts`, `bridge.ts`.
- App: `src/app/replay/page.tsx` (the fixed-route pattern to copy), `src/app/game/page.tsx`, `src/lib/api/gateway.ts`, `src/lib/api/fixture-gateway.ts`, `tests/fixtures/battles.ts` (engine-generated fixture logs and their generator test).
- Maps: `public/assets/expeditions/{woodland,outpost,mountain}-map.json`. Each has `expedition.route`, three `encounters` (player and enemy tiles, facings, assigned `creature`), `searchSpots` and `safePoint`.

## The stage sequence the backend will publish (mirror it exactly)

Codex's uncommitted Task 9 `planExpedition` (read by the controller; do not open Codex's folder yourself) publishes, for an expedition whose slot starts at `S` (slot length `rules.clock.slotMs` = 80 minutes):

| Stage | kind | revealedAtMs = startedAtMs | endsAtMs | label |
| --- | --- | --- | --- | --- |
| 0 | `depart` | S | S + 20 min | `Depart for <expedition name>` |
| encounter N (N = 1..3) | `encounter`, with `battleLog` | S + N × 20 min | start + `battleLog.durationMs` | `Encounter N: victory` or `Encounter N: defeat` |
| after a won encounter 1 or 2 | `exploration` | end of that battle | S + (N + 1) × 20 min | `Recover and continue exploring` |
| after a won encounter 3 | `travel` | end of that battle | S + 80 min | `Return to camp` |
| after a lost encounter (no later encounters) | `return` | end of that battle | S + 80 min | `Rest at the safe return point` |
| last | `return` (zero length) | S + 80 min | S + 80 min | `Arrive at camp` |

- Stage ids are `<activityId>:<index in the stages array>`.
- The gladiator is participant 0 (`id` = gladiatorId). The creature is participant 1 with id `creature:<manifest creature id>:<N>`, `gladiatorId: null`, and the catalog enemy name. The creature for encounter N equals the map's `expedition.encounters[N-1].creature`.
- **The winner is always the log's `winnerId`** (Codex's Task 9 review fix, 2026-10-13): a simultaneous-defeat tie-break winner with 0 HP still wins; a non-final such win heals by the floored 20% and continues, and a final one succeeds. Scene labels and poses follow `winnerId`, never health alone. HP carries: encounter N+1 starts at `min(maxHp, finalHp + floor(maxHp × 0.2))` after a won non-final encounter; encounter 1 starts at full HP.
- The server publishes a stage only once `revealedAtMs <= server time`. Rewards appear only in `RevealedTimeline.summary`, after settlement at minute 80 or later, and **only for the owner**: Codex confirmed that public (spectator) timelines exclude another owner's loot, currency and reward details, and the owner's completion summary is a separate scoped read. A spectator's timeline therefore has no `summary`.
- Codex confirmed this sequence and the creature ids on the board (2026-10-13). If it changes before Task 9 is committed, the controller will tell you.

## Controller decisions (binding unless you find a spec conflict, which you must report)

1. **Pure stage core: `src/game/expedition-stage.ts`** (new; no Phaser, React or combat engine imports). It exports `renderExpeditionStage(timeline: RevealedTimeline, displayNowMs: number): ExpeditionSceneState`. Put the Phaser scene in `src/game/expedition-scene.ts` as the plan names it; record this split in the report.
   - Only stages with `revealedAtMs <= displayNowMs` exist for the state, even if the timeline holds later ones (a fast server clock or a fixture must never leak early).
   - Phases: `depart`/travel, `exploration` (searching or pausing), `encounter` (in progress), `safe-return` (after a defeat), `returning` (after encounter 3), `arrived`, `preparing` and `settled`. `preparing` means the display clock has passed the end of the last visible stage but the next stage has not been published (a worker delay): show "Preparing", never a fabricated encounter. After the final `Arrive at camp` stage, the expedition is complete: show success or failure from the revealed encounter stages. With a summary (owner only), also show the result and the credited rewards **only from the summary**; an owner's timeline at or after minute 80 without a summary shows "Processing results". A spectator's view never shows rewards and never waits for a summary.
   - While an encounter is in progress (`displayNowMs < endsAtMs`), the state exposes the battle log and the elapsed time for playback but does **not** reveal its outcome in text: the log line shows `Encounter N` (in progress) and switches to the server label once the battle has ended.
   - The state also exposes: the visible stage list in order (for the log), the current stage, progress along the 80-minute strip, route progress (which route segment and how far, for the scene), the current search spot when exploring, the gladiator's HP **read from the battle logs only** (`initialHealth`, `finalHp`; never compute the 20% heal), and replay availability per revealed encounter (a `battleLog` is present and `summary?.replayExpiry.state !== 'expired'`).
   - It must be deterministic and pure; the same inputs always give the same state.
2. **Scene: `src/game/expedition-scene.ts`**, loaded lazily like the camp, with a viewport component `src/game/ExpeditionViewport.tsx` modeled on `BattleViewport.tsx` and `GameViewport.tsx` (use `startGame`).
   - Draws the expedition's map (environment from the activity, see 5) with the camp's map conventions: ground, props, depth slices and the alpha-mask occlusion.
   - The gladiator walks the route automatically from the state's route progress, pauses with a search animation at search spots during exploration, and rests (sit/sleep) at the safe point after a defeat. Use the actor atlases, `layersFor`, and the tint for the gladiator id. Use the gladiator's look from the expedition's `PublicActor` (world snapshot) when known, else from the first revealed battle log's participant 0, else a default look.
   - **Revealed encounter playback:** during an encounter, the creature stands at the encounter's enemy tile and both fighters animate the battle log in the iso scene, seeked to `displayNowMs - startedAtMs` with `createReplayController`. After the battle, a defeated creature stays down or fades. Effects come from the effects atlas. No combat simulation in the browser.
   - Camera: **Follow** (default) and **free** pan with drag, wheel/zoom buttons and bounds, reusing `camera.ts`. Reduced motion, pause in hidden tabs, `dispose()` on unmount and on the scene DESTROY event, no duplicate scene on remount. A WebGL or asset failure leaves the strip, log and result usable with a clear notice.
3. **UI: `src/features/character/ExpeditionView.tsx`** (with its own CSS module; do not edit `globals.css`):
   - the scene; a progress strip with markers at minutes 0, 20, 40, 60 and 80 and the current position; the current phase text; HP from the logs; an activity log of visible stages with local times; a **Watch replay** link per revealed, available encounter to `/replay/?activity=<id>&stage=<stage id>` (keep `mode=fixture` in fixture mode); Follow / free camera and zoom buttons; and a **Camp** button back to `/game/` (keep `mode=fixture`).
   - Failure copy: after a defeat, show `Returning without rewards` and the safe-point stage.
   - Names and labels render as React text. Keyboard and mobile usable (360 px wide). Nothing in this view sends commands.
4. **Route: a fixed page `src/app/expedition/page.tsx`**, a copy of the replay route pattern, reading `?activity=<id>` with `Suspense` and `useSearchParams`. **Ownership:** `src/app/**` and `scripts/**` are Codex's. **Codex APPROVED (board, 2026-10-13)** the three edits in this decision (the new route file, the `verify-static.mjs` route entry, the fixture-only sample list in `game/page.tsx`) plus only the necessary updates in `tests/static.test.ts` for the fifth route, preserving every escaped `seed`/`privateSeed` and other security case. Conditions: use the existing production fixture-denial rule, not just the public env flag; the `minute` clock is fixture-only, inside the existing development fixture guard, and grants no live time or reward authority; keep query-id validation; keep unavailable, expired and scene-failure states accessible; no outcome simulation or private plan in the renderer; no style, live gateway or contract changes. READY TO MERGE must list the route, scanner and tests as explicit shared scope, with a fresh five-route scan, production fixture-denial evidence and exact route screenshots.
   - Live mode calls `createLiveGateway().timeline(id)` and `world()`. Until Task 10 these are unavailable: show a clear unavailable state.
   - Fixture mode only (`mode=fixture` and `NEXT_PUBLIC_FIXTURE_ENABLED`): an optional `minute=<0..90>` parameter sets the display clock to that minute of the fixture activity and lets it advance in real time. Ignore `minute` outside fixture builds.
   - The gladiator's look: the view may call `world()` and use the `PublicActor` whose activity id matches; fixture `world()` stays unchanged, so fixture runs fall back to the battle-log participant.
   - Re-fetch the timeline when the display clock passes the next expected reveal (the current stage's `endsAtMs`, and each 20-minute mark), at most once per mark, and on tab focus. Task 10 later replaces this with the shared sync controller; keep the fetch logic in one small function so it can be swapped.
   - Add `expedition/index.html` to the route list in `scripts/verify-static.mjs` (5 fixed routes). The production export must not contain fixture data.
   - In the fixture-only area of `src/app/game/page.tsx`, add a small **Sample expeditions** list next to **Sample replays**. Live mode stays unchanged.
5. **Fixtures:** engine-generated, as in Task 14. Never run the combat engine in the browser.
   - A generator test builds each fixture expedition with the real `makeFighter` and `simulateBattle`, mirroring the stage sequence above (catalog enemy templates, HP carry, creature ids, labels), and asserts the committed JSON equals the regenerated data after `JSON.stringify`. Record the seeds.
   - Cases: the owner's full Woodland success with a summary; an Outpost defeat in encounter 2 (minute 65 shows `Returning without rewards`); a Mountain run; a delayed reveal (encounter 2 not published although minute 40 has passed); an expired replay (summary `replayExpiry` expired, encounter stages without `battleLog`); and **another character's** expedition viewed as a spectator (no `summary`, no reward details anywhere).
   - Put the fixtures and their timelines in the new `tests/fixtures/expeditions.ts` (JSON next to it is fine). **Approved shared edit (Codex, 2026-10-13):** in `src/lib/api/fixture-gateway.ts`, only a minimal import of the expedition fixture timelines and their addition to the `timeline(id)` lookup, plus an exported sample list for the fixture page (like `FIXTURE_REPLAYS`). Keep the production fixture denial and the existing fixtures intact. No signature change, no `world()` change, no clock in the gateway: the fixture timeline holds every stage, and the pure core's `revealedAtMs <= displayNowMs` rule hides the future ones. Report this as a fixture limitation; server-side reveal filtering is Task 10's.
   - Extend `tests/api/fixture-gateway.test.ts` (expedition ids resolve; unknown ids still throw `unavailable`).
6. **Bridge:** `view-expedition` and `return-camp` already exist in `src/game/bridge.ts`. Opening an expedition from the camp's roster or character card is Task 13; do not edit the camp scene for it.

## Tests (TDD: write first, watch each fail for the right reason, then implement)

- `tests/domain/expedition-stage.test.ts`: the minute table 19/20/39/40/59/60/79/80 for success and for a defeat after each encounter; a stage present in the timeline but not yet due stays hidden; `preparing` on a missing due stage; no outcome text before a battle ends; HP equals the logs; replay availability and expiry; summary only from the timeline; purity and determinism.
- The fixture generator test, and the fixture gateway test (clock filtering, unknown ids still throw `unavailable`).
- `tests/browser/expedition.spec.ts` (desktop and mobile): the plan's Step 1 assertions; the minute table; reload jumps to the current visible progress; Watch replay opens the right stage; leave and return with no duplicate playback or leaked listeners; another character's expedition; follow versus free camera; reduced motion; the no-WebGL fallback; 360 px layout; no command or Supabase request from the page (record requests); sprites inside the map and depth-correct, checked through a fixture-only debug hook as in `camp.spec.ts`; screenshots via `testInfo.outputPath`.
- Before committing, run: `npm test`; `npm run typecheck`; `node assets/source/build-assets.mjs --check` (and the review sheets only if you change art); `npm run build` and `npm run verify:static`; the full dev browser suite with `pw-claude.config.mjs`; the isolated production gate from `task-05-report.md` (shell, camp, replay and expedition against `.next/browser-test`); `git diff --check`.

## Commit and report

- Commit `feat: follow automatic isometric expeditions` with a detailed body. Stage exact paths only.
- Then `docs/implementation/task-15-report.md` (task-14 style: files, interfaces, controller decisions, every file outside the plan's Files list, RED/GREEN, commands and results, curated screenshots copied to `docs/implementation/task-15-evidence/`, limitations and gates for Tasks 9, 10 and 13) in a separate commit. Do not edit `HANDOFF.md`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Return only: status (DONE / DONE_WITH_CONCERNS / BLOCKED), the commit SHAs, a one-line test summary, and concerns (including any spec ambiguity you resolved).

## Pause state (2026-10-13, about 19:45 IDT)

Avi paused Claude for the day. The implementer was stopped mid-task; its partial work is commit `7c57106` on `claude/task-15-wip` (unreviewed). Present: the pure stage core, route path helper, scene, viewport, part of `ExpeditionView`, engine-generated fixtures with their generator test, unit tests and the approved fixture-gateway lookup. Missing: the rest of `ExpeditionView` and its CSS module, the browser spec, the approved route/scanner/sample-link edits, full suites, the report, and the independent review (which must also cover `708688b`). On resume: re-read the board, re-check the WIP tests against the winner rule above (the WIP was written against the older 0-HP-is-defeat wording), then dispatch a fresh implementer to finish from this branch.
