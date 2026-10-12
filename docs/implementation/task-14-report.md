# Task 14 implementation report: battle-log replay with consistent controls

Status: **DONE_WITH_CONCERNS**. Implemented, independently reviewed (spec Pass, quality Pass, visual Pass, ready to merge; see `task-14-review.md`), and its review Minors fixed. The concerns are listed under "Limitations".

- Date: 2026-10-12, Asia/Jerusalem. Owner: Claude (fresh implementer; the controller reviews and integrates).
- Branch: `claude/task-14`, worktree `C:\Avi\Studies\Projects\Cloudiator-replay`. Base: `9b39edc`, the pushed integration checkpoint (Tasks 1–6, 11 and 12 reviewed).
- Commits:
  - `344521b`: `feat: animate authoritative battle replays` (source, art, tests, the art-review note).
  - `6607017`: this report and `task-14-evidence/`.
  - The review-fix commit recorded in `task-14-review.md`: the `startGame` boot race and `window.onblur`/`onfocus` restore, local-day dates, reward keys, a development-only warning when a non-gladiator matches no creature art, and the review record. After it: 296 unit tests, build, static scan (4 routes, 81 assets) and the development browser suite all green.
- Nothing was pushed or merged. No Supabase command, database, `supabase/**` file or other checkout was touched.

## Delivered behaviour

**Replay core** (`src/game/replay.ts`): pure, and never imports Phaser, React or the combat engine.
- Events with the same `elapsedMs` form one group and are applied whole.
- Health comes from the logged `healthAfter`, never from damage, starting at each participant's `initialHealth`.
- The frozen `ReplayFrame` holds:
  - HP and maximum HP;
  - the latest applied group;
  - the applied-event count;
  - a finished flag;
  - the result (winner, loser, victory reason, tie-break cause).

  It never holds rewards.
- The controller's only clock is `tick(realMs)`, scaled by the speed (normal 1×, fast 4×). Its position is in log milliseconds, so the state does not depend on frame rate and is identical at every speed.
- The controller runs 2 s past the log's end, so the defeat and victory poses can finish.
- `seek` clamps to the playable range. `restart` plays from 0, `skipToResult` jumps to the end and stops, and `play` at the end starts again.
- Subscribers are told only about discrete changes: the group, the result, play/pause and the speed.

**Choreography** (`src/game/battle-stage.ts`): pure. `stageAt(plan, position, layout)` returns the whole picture, and the scene only draws it.
- **Attacks.** Each attack's wind-up starts early, so its impact frame (frame 2 of every attack animation) begins exactly at the logged time. A swing outranks reactions until its impact frame ends.
- **Reactions.** The defender plays `hit`, `defend` (a landed attack mitigated by Defensive stance) or `evade` (a miss), as logged. A fighter struck while landing an equal-time blow reacts right after its own swing.
- **Result.** The loser plays `defeat` once its last reaction ends, then the winner plays `victory`. Both hold their last frame.
- **Effects.**
  - `hit`, `critical`, `defend` and `evade` land on the defender, facing the attacker.
  - The evade puff touches the floor.
  - Bows (and the raider archer) fire an `arrow`.
  - Circling `defeat` stars sit over the fallen fighter's head; a `victory` sparkle surrounds the winner.
- **Damage labels.** They read `-N`, `-N CRIT`, `-N GUARD` or `MISS` from the logged damage and flags. They rise and fade, and at most two show per fighter.
- **Criticals.** A critical hit adds a 3 px shake of the fighters and effects (the backdrop never moves) and a short white flash.
- **Reduced motion.** No shake and no flash; labels stay still, and only the newest per fighter shows. Sprite animation and effects remain, so the fight stays readable.

**Close-up view (Task 11's deferred criteria).**
- **Backdrop.** `assets/source/generators/closeups.mjs` paints four 320×128 backdrops:
  - the arena: sand floor with a raked circle, a stone podium wall that curves up towards the centre, team banners and braziers, crowd stands under a striped awning, and a dark editor's box behind the fighters for contrast;
  - a woodland clearing, a ruined outpost and a mountain snowfield for expedition encounters.

  `build-assets.mjs` packs them into `public/assets/battle/closeups.png` (atlas `closeups`, kind `backdrop`). `manifest.closeups` records the scale (3), the floor row `groundY` (104) and the stand positions `fighterX` ([142, 178]). Both files have provenance records, and `--check` covers them.
- **Fighters.** They reuse the gladiator and creature atlases with the camp's layers and multiply tints. `tintFor(gladiatorId)` was extracted from the camp, so a player looks the same in both views.
  - Battle-log catalog ids map through `layersFor`.
  - Spears use `thrust` and bows `shoot`.
  - Everything is drawn at exactly 3× (container scale ±3, `pixelArt: true`), so the backdrop, fighters and effects share one art-pixel grid.
- **Placement.** The left fighter faces se and the right one is mirrored to face sw. Both stay inside every stage from 320 to 960 px wide, for every frame of every combat animation.
- **Arena or expedition backdrop.** Arena bouts use the arena close-up. An encounter uses the creature's expedition close-up.

**Who is drawn how** (documented in `creatureFor` and `fighterLook`):
- A participant with a `gladiatorId` is a gladiator, in its own colours.
- A participant with `gladiatorId: null` is a creature when one of these matches, in this order:
  - its id has the form `creature:<manifest creature id>[:…]`;
  - its name matches a creature name (case-insensitive);
  - its name is a catalog expedition enemy name: Wild beast → dire wolf, Armed raider → raider, Dangerous creature → rock troll.
- Any other null-gladiator participant is an NPC fallback, drawn as a gladiator in its mirrored equipment with neutral steel-grey cloth and labelled "NPC opponent".

**Scene and host.**
- `src/game/battle-scene.ts` is loaded lazily, like the camp, and calls `stageAt` with the controller's position in every `update()`.
- `BattleViewport.tsx` probes WebGL, imports Phaser, the assets and the scene, and creates the game through `startGame`.
- Lifecycle:
  - `dispose()` runs on unmount and on the scene `DESTROY` event;
  - a disposed scene never draws again;
  - the test hook is removed on unmount.
- Without WebGL, failed art, or a runtime error in `update()`, the host shows a note. The controls, HP meters, result and log keep working, because playback is driven by React, not by Phaser.
- **Phaser leak, fixed for both scenes.** Phaser 4.2.1 adds a document `visibilitychange` listener in `Game.start` and never removes it, so every mounted game leaked one listener that held the dead game's emitter. `src/game/phaser-game.ts` (`startGame`) captures that listener from the `postBoot` callback, which Phaser calls just before, and removes it on destroy. The camp's `GameViewport` uses it too.

**Panel** (`src/features/arena/BattleReplay.tsx`):
- **Scene and health.** The close-up, with both fighters' HP as labelled `meter`s.
- **Controls.**
  - Play/Pause (the label switches);
  - `Fast ×4` with `aria-pressed`;
  - Restart, Skip to result, and a labelled position slider.
  - With focus inside the replay, K plays or pauses, F toggles fast, R restarts and End skips to the result.
  - Every button is at least 44 px tall.
- **Fighters table.** Built from both `RevealedCombatant` snapshots: type (class, NPC opponent or creature), stance, starting health, weapon damage, armour, attack interval, efficiency, the five attributes and equipment.
- **Result.** It appears when the fight ends or on Skip, and gives the winner and the reason:
  - defeat;
  - the time limit, won on health share;
  - a seeded tie-break, either simultaneous defeat or equal health share.
- **Rewards.** Credited rewards and the rating change come only from the `ActivitySummary`. When there is no summary yet, the panel says "Rewards are credited when the activity settles". It also states the replay's retention date.
- **Combat log.** It is revealed up to the current group, so the outcome is not spoiled; the current group is highlighted with `aria-current`. After Skip it lists every event with the logged names, times, damage and health.
- **Encounter selector.** An expedition with several revealed encounters gets an "Encounters" button group with `aria-pressed`.
- **Hidden tab.** Playback pauses while the tab is hidden and resumes when it returns.
- **Expired or missing log.** `summary.replayExpiry.state === 'expired'` (even if a log is still attached), or no battle stage, shows the saved outcome and credited rewards. It states that the animation is no longer kept and explains the 7-day and 90-day retention.
- **Text.** Names render as React text everywhere.

**Route** (`src/app/replay/page.tsx`): a fixed page that reads `?activity=` (and an optional `&stage=`), with `Suspense` and `useSearchParams` as in `game/page.tsx`.
- Fixture mode (`?mode=fixture`, with fixtures enabled in the build) imports the fixture gateway behind a direct `NEXT_PUBLIC_FIXTURE_ENABLED` check, so production exports drop it.
- Live mode calls `createLiveGateway().timeline(id)`, which is unavailable until Task 10. The page then shows "This replay is not available".
- A "Back to camp" link returns to the right game page.
- The fixture game page lists the five samples under "Sample replays". Live mode is unchanged.
- `verify:static` now requires `replay/index.html`.

**Fixtures** (`tests/fixtures/battles/*.json`): written by the real reviewed `makeFighter` and `simulateBattle`. `tests/domain/replay-fixtures.test.ts` regenerates them and compares them byte for byte; `UPDATE_REPLAY_FIXTURES=1` rewrites them. The seeds come from deterministic first-match searches and are recorded in that test only, never in the logs or the bundle.

| Fixture | Seed | Shape |
| --- | --- | --- |
| `pvp` | `fixture-pvp-1` | Aster (guardian, defensive; sword, shield, helmet, light armour) beats Varro (berserker, offensive; spear, hood, heavy armour) by defeat at 20.57 s with 4 HP left. It has criticals, evades and 13 guarded hits. |
| `npc` | `fixture-npc-1` | Aster (bow) beats the NPC fallback "Iron Warden". Fifteen equal-time exchanges. |
| `expedition-1..3` | `fixture-expedition-21` | Three woodland encounters (dire wolf, timber wolf, dire wolf), all won, with carried health (encounter 2 starts at 130/134). |
| `tie` | `fixture-tie-16` | Mirror duelists fall at the same moment; the seeded tie-break names Aster (`simultaneous-defeat`). |

`src/lib/api/fixture-gateway.ts` `timeline(id)` returns `RevealedTimeline`s for:
- the four fights: staging, then a revealed bout or encounter stages carrying the logs, then settlement;
- one expired arena bout, with no stages and a 90-day summary (Defeat, +2 renown, rating −9).

The tie bout is revealed at minute 60 and checked at minute 65, so it has no summary yet. Unknown ids still throw `unavailable`.

## Interfaces

- **`src/game/replay.ts`**
  - Constants and types: `REPLAY_SPEEDS` (`normal` 1, `fast` 4), `ReplaySpeed`, `REPLAY_OUTRO_MS` (2000), `ReplayGroup`, `ReplayResult`, `ReplayFrame`.
  - `groupReplay(log)`.
  - `reduceReplay(log, throughMs): ReplayFrame`.
  - `createReplayController(log, { speed? }): ReplayController`.
    - Read-only properties: `log`, `endMs`, `positionMs`, `playing`, `speed`, `frame`.
    - Controls: `play`, `pause`, `restart`, `seek`, `setSpeed`, `skipToResult`.
    - Clock and listeners: `tick(realMs)`, `subscribe`, `listenerCount`.
  - `replayLines(log): ReplayLine[]`.
  - `ReplayView` and `replayViewOf(timeline, stageId?)`, giving `replay`, `summary` (expired or missing) or `unavailable`.
  - `loadReplayView(gateway, activityId, stageId?)`, which reads the timeline once and sends no commands.
- **`src/game/battle-stage.ts`**
  - Types: `FighterLook`, `StageLayout`, `StagePlan`, `StageFrame`.
  - Functions: `creatureFor(participant, creatures)`, `fighterLook(participant, manifest)`, `backdropFor(log, manifest)`, `stageLayout(manifest, width, height)`, `planStage(log, manifest)`, `stageAt(plan, positionMs, layout, { reducedMotion })`, `frameIndex`.
  - Constants: `NPC_CLOTH`, `IMPACT_FRAME`.
- **`src/game/battle-scene.ts`**: `createBattleScene(P, deps)` returns `{ scene, handle }`, where the handle is `{ setReducedMotion, dispose, debug }`.
- **`src/game/BattleViewport.tsx`**: `BattleViewport({ log, position, reducedMotion, bridge, label })`.
- **`src/features/arena/BattleReplay.tsx`**: `BattleReplay({ view, bridge? })`. Task 17 can embed it with the page bridge.
- **Helpers**
  - `src/game/phaser-game.ts`: `startGame(P, config)`.
  - `src/game/webgl.ts`: `supportsWebGL`, `prefersReducedMotion`, shared with the camp.
  - `src/game/actors.ts`: `tintFor(gladiatorId)`.
- **Manifest**: `closeups` `{ atlas, width, height, scale, groundY, fighterX, backdrops, notes }`, and the atlas kind `backdrop`.
- **Fixture-only test hooks**
  - `window.__cloudiatorReplay`: `state`, `listeners`, `loops`, `seek`, `pause`.
  - `window.__cloudiatorBattle`: `debug`, `canvases`.
- **Fixtures**: `REPLAY_FIXTURES` (`tests/fixtures/replay-ids.ts`); `FIXTURE_BATTLE_LOGS`, `REPLAY_TIMELINES` and `REPLAY_SAMPLES` (`tests/fixtures/battles.ts`); `FIXTURE_REPLAYS` (fixture gateway).
- **Bridge**: unchanged. `view-replay` stays reserved for Task 17. The replay listens to `scene-unavailable`.

## Controller decisions and how they were resolved

All six dispatch decisions are implemented as written. Where the dispatch left a choice open:

1. **Creature mapping:** by id prefix, then name, then catalog enemy name, as above. NPC fallbacks are the remaining null-gladiator participants. Task 8 should emit `creature:<manifest creature id>:…` ids, or rely on the name fallbacks.
2. **NPC fallback fixture:** no Task 3 or Task 9 helper exists, so the test builds the spec template from a real `makeFighter` snapshot:
   - effective attributes, armour, attack interval and efficiency are mirrored (efficiency applies once);
   - stance is Balanced and `classId` is null;
   - maximum health is `floor(0.85 × player)`, and pre-stance base damage is `0.85 × player`.
3. **Expedition fixture:** the catalog enemy's listed `damage` is used as base damage, with efficiency 1 and no equipment. Healing between encounters is `floor(20% of maximum)`, capped at maximum (plan Task 8). These are fixture assumptions until Task 8.
4. **Outro:** the controller plays 2 s past `durationMs` so the result poses finish. `finished` and the result become true at `durationMs`.
5. **Spoilers:** the log is revealed up to the current group, and the result and rewards appear when the fight ends or on Skip. Both show in full after Skip.
6. **Close-up scope:** besides the required arena close-up, encounters get their own expedition close-ups, so an expedition replay is not staged in an arena.
7. **Extra changes, made deliberately:**
   - `verify:static` requires the new fixed route.
   - The camp viewport uses `startGame`, because the camp ↔ replay navigation test exposed Phaser's listener leak in both.
   - The PvP fixture opponent is named Varro, not Brutus, to avoid confusion with the camp NPC "Brutus the Smith".

No spec conflict was found.

## RED and GREEN evidence

1. **Fixture generator.**
   - It failed first because `tests/fixtures/battles.ts` did not exist.
   - With placeholder `{}` files, all 8 tests failed: the guessed seeds were wrong and the content did not match.
   - The searches recorded `fixture-pvp-1`, `fixture-npc-1`, `fixture-expedition-21` and `fixture-tie-16`. After `UPDATE_REPLAY_FIXTURES=1`, all 8 pass.
2. **Replay core.**
   - `tests/domain/replay.test.ts` failed first because `@/game/replay` did not exist. Then 34 passed.
   - Mutation checks:
     - recomputing health as `hp -= damage` fails 14 of 34 tests, including "takes health from the logged healthAfter";
     - using `<` instead of `<=` in the group search fails 22 of 34.
3. **Fixture gateway.** The 3 new tests failed (timeline unavailable), then all 7 pass.
4. **Close-up assets.**
   - The 4 new tests failed (`manifest.closeups` undefined).
   - After the generator, the opacity test still failed: the woodland backdrop had 23 transparent pixels on the tree-line base row. The fill was fixed, and 37 pass.
5. **Battle stage.**
   - It failed first because the module was missing.
   - Then 6 tests failed: an attacker's recovery frame hid the defender's reaction. Fix: a swing only outranks reactions until its impact frame ends. The test's own skip condition was then narrowed to the defender's own nearby swings.
   - Then 2 failed: in equal-time final exchanges, `defeat` started before the loser's post-swing reaction. Fix: the result waits for all reaction windows.
   - A later assertion that the stars sit over the fallen body failed while it compared the effect centre. It now compares the drawn top.
   - 27 pass.
6. **Static scanner.** "refuses an export without the fixed replay page" failed, then passed once the route was required.
7. **Browser.**
   - Before the page existed, the first subset failed: 5 tests.
   - The first full desktop run passed 17 of 18. The listener test found document `visibilitychange` listeners going from 3 to 5 after one camp round trip.
   - Stack traces showed Phaser's `VisibilityHandler`, called from `Game.start` after `texturesReady`. A first fix that captured the listener while the constructor ran did nothing, because `start` runs asynchronously. Capturing from `postBoot` fixed it. The counts stay equal across navigation, remount and reload.
8. **Visual review.** Screenshots and the review sheet led to five fixes:
   - labels were lowered from 60 to 50 art px above the feet, which puts them just over the heads;
   - the evade effect's built-in puff floated at waist height, so the effect was lowered and the extra dust removed;
   - the Fighters table squashed the second column on desktop ("Creatur e"), fixed with a fixed table layout;
   - the defeat stars moved onto the fallen head (humanoids fall backwards, wolves forwards);
   - a repeated eyebrow was trimmed.

## Commands and results (final, at `344521b`)

```text
npm test                                       13 files, 296 passed
npm run typecheck                              tsc clean; Deno check and Deno test 1 passed
node assets/source/build-assets.mjs --check    assets up to date (28 files)
node assets/source/tools/review-sheets.mjs     closeups.png added; the other 13 images unchanged
npm run build                                  static: /, /_not-found, /auth/callback, /game, /replay
npm run verify:static                          4 fixed routes; 81 assets scanned; no forbidden material
grep -rl <fixture names and ids> out/          0 files (Iron Warden, Varro, Cassia, fixture-bout, fixture-receipt, creature:timber)
npx playwright test -c node_modules/.cache/pw-replay.config.mjs
                                               99 passed, 5 skipped (the existing skips); replay 18 tests x desktop and mobile
git diff --cached --check                      clean
```

The replay browser suite checks:
- all four fixture fights and the expired summary: snapshots, final HP, winner, and every log line with its names, time, damage and health;
- the NPC, creature, reward, rating and tie-break wording;
- the unknown-activity and live-mode states;
- normal-speed playback in real time;
- fast, pause, restart and skip each reaching the logged final HP and winner;
- keyboard control;
- equal-time group highlighting;
- pausing while hidden and resuming;
- reduced motion: no shake or flash, readable labels;
- repeated navigation, remount and reload: one canvas, one playback loop, the same bridge, controller and visibility listener counts, and a 1× clock rate;
- without WebGL and without art: the result and log still work;
- a 360 px screen: no horizontal scroll, all controls inside it and at least 40 px tall;
- the drawn scene at every logged moment of the PvP and creature fights: integer ±3 scale, facing each other, inside the canvas, and effects on the defender.

## Evidence (`docs/implementation/task-14-evidence/`)

| File | Shows |
| --- | --- |
| `desktop-replay-start.png` | Arena close-up, both fighters in idle, facing each other |
| `desktop-replay-critical.png` | A critical burst on the defender, `-13 CRIT` and `MISS` labels, an evade on the other fighter |
| `desktop-replay-evade.png` | An evade with whoosh and `MISS` |
| `desktop-replay-result.png` | Full page: victory pose over the fallen opponent with stars, result, rewards, rating, the Fighters table, and the log with the final group highlighted |
| `desktop-replay-expedition-result.png` | Woodland close-up, the encounter selector, creature labels, the expedition rewards |
| `width360-replay-hit.png`, `width360-replay-result.png` | 360 px-wide screen: a guarded hit with labels, and the full result page |
| `mobile-replay-critical.png` | Pixel 7 (412 px): critical hit |
| `mobile-replay-reduced-motion-critical.png` | Pixel 7, reduced motion: the same critical, no shake or flash |
| `mobile-replay-expired.png` | Pixel 7: saved outcome of an expired replay |

The art review image is `docs/operations/art-review/closeups.png` (see the "Task 14 delivered" note in `docs/operations/art-review.md`). The small "N" in the screenshots is the Next.js development indicator.

## Files

- Replay core and stage: `src/game/replay.ts`, `src/game/battle-stage.ts`.
- Scene and host: `src/game/battle-scene.ts`, `src/game/BattleViewport.tsx`, `src/game/BattleViewport.module.css`.
- Shared helpers: `src/game/phaser-game.ts`, `src/game/webgl.ts`.
- Updated game files: `src/game/actors.ts` (`tintFor`), `src/game/assets.ts` (closeups type and atlas data), `src/game/GameViewport.tsx` (shared helpers).
- Panel and route: `src/features/arena/BattleReplay.tsx`, `src/features/arena/BattleReplay.module.css`, `src/app/replay/page.tsx`.
- Updated app files: `src/app/game/page.tsx` (sample replays, fixture only), `src/app/globals.css`.
- Fixture gateway: `src/lib/api/fixture-gateway.ts`.
- Art pipeline:
  - `assets/source/generators/closeups.mjs`, `assets/source/build-assets.mjs`, `assets/source/tools/review-sheets.mjs`;
  - `assets/source/provenance.json`, `assets/source/README.md`;
  - `public/assets/manifest.json`, `public/assets/battle/closeups.{png,json}`.
- Static scanner: `scripts/verify-static.mjs`.
- Tests:
  - `tests/domain/replay.test.ts`, `tests/domain/replay-fixtures.test.ts`, `tests/domain/battle-stage.test.ts`;
  - `tests/browser/replay.spec.ts`;
  - `tests/api/fixture-gateway.test.ts`, `tests/assets/manifest.test.ts`, `tests/static.test.ts`.
- Fixtures: `tests/fixtures/battles.ts`, `tests/fixtures/replay-ids.ts`, `tests/fixtures/battles/*.json` and `.gitattributes` (`-text`, so the byte comparison survives checkout).
- Docs: `docs/operations/art-review.md`, `docs/operations/art-review/closeups.png`.

`HANDOFF.md` is unchanged.

## Limitations

- **Live replays** are unavailable until Task 10 provides `timeline()`. Not part of this task:
  - camp click-to-replay and arena staging (Task 17);
  - the expedition view (Task 15).
- **Fixture assumptions.** The NPC and creature snapshots follow the assumptions above. Task 9's fallback factory and Task 8's encounter factory may differ: rounding, creature base damage and participant ids.
- **Creature ids.** Producers must emit `creature:<manifest id>` participant ids for expedition enemies. A non-gladiator that matches nothing is drawn as an NPC fallback, with a development-only console warning. This is recorded in HANDOFF as a Task 8/9 rule.
- **Bundle size.**
  - `assets.ts` still inlines every atlas and map JSON in the lazy scene chunk, so the replay also loads camp and expedition map data. Splitting it per scene is still open.
  - The panel chunk embeds `manifest.json` (about 66 KB raw) to label creatures.
- **Fast speed.** A damage label lasts 0.8 s of log time, which is 0.2 s of real time at 4×. The log is the durable record.
- **Defeat pose.** A time-limit or tie-break loser plays the full defeat collapse; no kneel animation exists.
- **Fallen head.** The head position used for the stars is a per-kind offset, not measured from the art.
- **Scale.**
  - On desktop the integer 3× scale shows the whole 960×384 backdrop, so the fighters are small within it.
  - The canvas is sized in CSS pixels. On high-DPR phones the browser scales it by the device ratio (2.625 on a Pixel 7) with `image-rendering: pixelated`.
- **Production gate.** The replay browser suite is fixture-only and skips in production. The production export was checked with `build`, `verify:static` and a grep for fixture data, not with a production browser run.
- **Tracked elsewhere.** The fps targets remain Task 23. The known colour-variable warnings remain a deferred harness Minor.
