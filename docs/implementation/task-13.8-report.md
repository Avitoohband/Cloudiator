# Task 13.8 report: replays and expeditions over the camp

- **Branch:** `claude/task-13` in `C:\Avi\Studies\Projects\Cloudiator-claude`.
- **Base:** `6ed5364`.
- **Commit:** `d6fa86c` "feat: open replays and expeditions over the camp".
- **Status:** DONE_WITH_CONCERNS (see the last section).

## What I implemented

### Scenes over the camp (spec "Scenes", plan Decision 4)

**`src/features/shell/SceneOverlay.tsx` (new)**
- Signature: `SceneOverlay({ view, gateway, state: GameUiState, onClose, fixture?, onWatch? })`.
- It is a full-window native modal `<dialog>`, labelled "Replay" or "Expedition".
- It opens with `showModal()`, so the camp keeps running beneath it but takes no input.
- "← Back to camp" (the arrow is `aria-hidden`) takes the focus first and calls `onClose`.
- Escape closes the dialog natively, and the `close` event follows that into the address. A stale `close` event from React's development remount is ignored: it finds the dialog open again.
- On unmount, the focus returns to whatever opened the scene, or else to the camp view.

**What each scene shows**
- A replay is the new `ActivityReplay`: `loadReplayView`, then `BattleReplay` with headings from h2 and the shared clock.
- An expedition is `ExpeditionView` with `overCamp`:
  - headings from h2;
  - no Camp link;
  - "Watch replay" is a button that opens the encounter's replay scene.

**Owner summaries.** For a viewer who is not a player, the overlay drops the owner `summary` from the timeline reads. The live server never sends one to a visitor, but the fixture samples carry their owner's. Visitors therefore never see rewards in a scene, including in `?as=visitor`.

**Styles.** In `shell.module.css`:
- 97% opaque, with `backdrop-filter` blur;
- the Back button is sticky at the top left;
- the body is 1008 px wide, with phone padding;
- a 0.25 s fade, which the global reduced-motion rule turns off.

**Address and history**
- `src/features/shell/scene-url.ts` (new) holds `sceneOf`, `sceneHref`, `campHref` and `sceneForResult`.
- `src/features/shell/useSceneHistory.ts` (new):
  - `open` pushes `?view=…&activity=…[&stage=…]` on the current route with `history.pushState`. The App Router integrates this (I read `01-getting-started/04-linking-and-navigating.md` § Native History API and checked the patched `pushState` and `popstate` in `app-router.js`; custom state survives traversals).
  - Each entry is marked with how many entries back the camp is. Back to camp calls `history.go(-n)`, so a nested scene (an expedition's encounter replay) still returns to the camp.
  - A scene opened from a link has no mark, so Back to camp replaces it with the camp's address.
- `src/app/game/page.tsx` parses the scene from `useSearchParams` and passes `scene` to `CampShell`. The root `/` renders the same page.

**Bridge wiring**
- `CampShell` listens to `view-replay` (whose payload gains `stageId?`), `view-expedition` and `return-camp`. The overlay's Back to camp emits `return-camp`.
- Opening a scene closes the profile card. The menus stay open beneath, to come back to.
- The emitters are:
  - Results: `onWatch(activityId, kind)`, routed by kind through `sceneForResult`. Expeditions open the expedition scene, Arena and tournament results open the replay, and Training/Rest have no replay (carried item 1).
  - `RosterPanel` away rows: "Watch expedition", labelled "Watch {name}'s expedition", emits `view-expedition`. A row with no public activity still says "On an expedition".
  - The Arena card's "Watch replay" (`ArenaPanel.tsx`): `view-replay` with its stage, instead of `router.push('/replay/…')`. This was not in the brief's file list, but spec "Scenes" applies.
- The fixture Results sample links stay as `/replay/` and `/expedition/` page deep links.

### Revision-driven expedition reads (Task 10 gate)

**`ExpeditionView` no longer polls**
- `useTimelineReads` lost its focus and visibility listeners. `readDue` and its 30-second display-time poll are gone.
- The timeline is read:
  - on entry;
  - once at each reveal mark passed (`passedRevealMark`);
  - when the `revision` prop changes from one non-null value to another.
- The world and the owner now come from props (`world`, `worldFailed`, `owner`) instead of its own `world()` and `owner()` reads. `ExpeditionReads` is now just `timeline`.

**The pages**
- `src/app/expedition/page.tsx` and `src/app/replay/page.tsx` mount `useGameState`. They pass it `null` when there is no well-formed activity, so `/replay/` with no activity reads nothing; `sync.spec` relies on that.
- The replay page waits for the shared clock (a world read, or a sync error) before showing a replay.

### Replays filtered by display time (Task 15 review Minor 2)

- `replayBattles(view, nowMs)` and `battleEndMs` in `src/game/replay.ts`. A battle ends at `stage.startedAtMs + log.durationMs`. That equals the server's published bout end; the fixture tie bout's stage runs to minute 80.
- `BattleReplay` takes an optional `clock`, through `useReplayTime`:
  - It shows only the battles that have ended, and the summary only once settled.
  - It re-renders at the next battle's end and on clock freeze or release.
  - A fight still in progress shows "This replay is not available yet: The fight is still going on…".
  - `TournamentPanel`, which has no clock, is unchanged.

### "Not available yet" (product ruling 4, Review Focus 3)

- **Expedition:** `ExpeditionView` shows `ExpeditionUnavailable reason="not-yet"` ("This expedition is not available yet", no summary) when both hold:
  - no stage is revealed by the display time;
  - no world actor is on that activity.
  It shows Loading while the world is still unknown. It never shows "Preparing" or an error page.
- **Replay:** a guessed or unrevealed replay (`not-revealed`) reads "This replay is not available yet".

### Carried items

**2. A camp click on an Arena entrant**
- `useCampClicks` skips `select-character` for a world actor with `location === 'arena' && activityId`.
- `camera.ts` exports `CLICK_TRAVEL_PX = 6` and `isClick` (≤ 6 px). `camp-scene.ts` uses `DRAG_THRESHOLD = CLICK_TRAVEL_PX`, and `CampShell` uses `isClick`. The old `< 6` versus `> 6` gap is gone.
- A regression test is in `management.spec.ts` (below).

**3.** The `expedition.spec` "without reading" title is renamed.

### Task 15 Minors: the real files (Ruling 3)

**1. Safe-point leave pose**
- `src/game/expedition-stage.ts`: the final stage's leave route after a defeat carries `rest`, the rest route it was on at the same display time.
- `src/game/expedition-path.ts`: `gladiatorPose` returns that rest pose (sit or sleep, where it rested) while the scene fades it out.
- `expedition-scene.ts` is unchanged.

**2. Encounter count**
- `EXPEDITION_ENCOUNTERS = 3` in `src/game/expedition-stage.ts`.
- It is used in:
  - `src/features/character/ExpeditionView.tsx`, `healthText`, replacing `encounter < ORDINALS.length`;
  - `journeyAt`;
  - `ENCOUNTER_INTERVAL_MS`;
  - `expeditionRevealMarks`.

**3. Test title**
- In `tests/browser/expedition.spec.ts`, "reads only the timeline, once per reveal mark and on focus…" became "reads the timeline once per reveal mark, not on focus alone, and sends no command or remote request".

## TDD evidence

### RED

**Unit**, before any code: 4 files failed, 6 tests.
- `replayBattles is not a function` (×3).
- `EXPEDITION_ENCOUNTERS` undefined.
- The leave pose: `expected … to match { action: 'sleep' }`; it was `idle`.
- `CLICK_TRAVEL_PX` undefined.
- `scene-url` module missing.

**Browser**, the targeted desktop run: 17 tests, 16 failed and 1 passed (the rename-only test).
- No overlay:
  - every `scenes.spec` test ("dialog Replay not found", heading not found, and a timeout on "Watch Varro's expedition");
  - `arena.spec:571`;
  - `management.spec:169` and `:240`.
- Expedition reads:
  - the leave pose: `Expected "sleep", Received "idle"`;
  - a read on return to the tab: 3 against 2;
  - the 30-second poll at "+30 s": 3 against 2;
  - a read on focus with an unchanged revision: 3 against 2;
  - a read on focus: 4 against 3.
- The entrant click: `__profileCards` was 1, expected 0.

### GREEN

**Unit:** 976/976 in 43 files (965 at 13.7).

**Browser**
- The targeted desktop rerun passed.
- One real bug was found on the way: the overlay closed itself at once. React's development remount fired a stale dialog `close` event. The fix is guarded and commented.
- Development-only test adjustments:
  - a profile read counted ≥1, since strict mode runs the effect twice;
  - the Arena sheet is closed before a phone camp click.
- `arena.spec` "works by keyboard alone" now opens the scene, presses Escape, and checks that the focus returns to Watch replay.

**New and changed tests**
- `tests/browser/scenes.spec.ts` (new), all 5 brief tests:
  - "opens a replay full screen over the camp and returns with Back to camp";
  - "closes the scene with the browser Back button";
  - "opens an away gladiator's expedition from the Gladiators list" (live, visitor);
  - "keeps /replay/ and /expedition/ deep links working";
  - "shows a visitor's guessed or unrevealed activity as not available yet, without a summary" (live, visitor).
- `scenes.spec.ts` also adds:
  - "opens an expedition result over the camp as its expedition scene" (with nested encounter replay, bridge emits and Escape);
  - "never shows a visitor the owner rewards in a scene".
- `tests/domain/replay.test.ts`: `replayBattles` (the brief's `endOfFirstBattle - 1 → []`; see the concerns about `b.id`).
- `tests/domain/expedition-stage.test.ts`: "keeps the rest pose while leaving from the safe point after a defeat", and the encounter-count test.
- `tests/domain/scene-url.test.ts` (new).
- `scene-layout.test.ts`: the shared click travel.
- `roster-panel.test.ts`: the away row's Watch expedition.
- `expedition-path.test.ts`: the leave pose with a rest route.
- `management.spec.ts`: "opens only the Arena card for an Arena entrant, with no profile card or profile read". It runs live as a visitor:
  - a MutationObserver counts every profile card mounted;
  - it asserts `public_profile_reads` is 0;
  - a positive control on a trainee still opens a card.
- Updated for the new behaviour:
  - `expedition.spec`:
    - the hidden tab and focus no longer re-read;
    - "never re-reads on a timer of its own…" replaces the 30-second poll test;
    - a new live test, "re-reads the timeline when the shared revision changes…";
    - the leave-pose assertion.
  - `arena.spec:571`: the replay now opens over the camp.
  - `management.spec`: two Results tests now expect the overlay.
  - `replay.spec:165`: `world_actor_reads` is allowed, since the page's shared sync now reads the world.
  - `live-routes.ts`: `setTimelines`.

## Gates (in the `verification-gates.md` order, never overlapped)

1. `npm test`: 976 passed (43 files).
2. `npm run typecheck`: `tsc` clean, `deno check` clean, `deno test` 2/2.
3. `npm run test:db`:
   - **Run 1:** 176/177. The known flake `arena.test.ts:642` failed (120915 ms against a 120000 ms bound). Edge `StartedAt` before and after: `2026-10-17T10:33:35.127158356Z`, unchanged.
   - **Run 2:** 177/177. Edge `StartedAt` before and after: `2026-10-17T10:33:35.127158356Z`, unchanged.
4. `npm run build`: 5 static routes. `npm run verify:static`: "5 fixed routes; 90 assets scanned; no forbidden backend material".
5. Full development browser suite (`pw-claude.config.mjs`, port 3200): **370 passed, 22 skipped** (6.4 min).
   - A pre-gate run gave the same result.
   - After gate 5 I changed only `scenes.spec.ts`: the screenshots now wait for the scene's fade-in, and a local variable was renamed to avoid shadowing.
   - I re-ran `scenes.spec.ts` on both projects: 14 passed.
6. Isolated production gate: the `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true` build passed. `verify:static .next/browser-test` passed with the same message. `PLAYWRIGHT_STATIC=true … playwright test` gave **16 passed, 376 skipped**.
7. `git diff --check`: clean. I also checked the new files for trailing whitespace; there was none.

## Files changed (`d6fa86c`)

**New**
- `src/features/shell/SceneOverlay.tsx`
- `src/features/shell/scene-url.ts`
- `src/features/shell/useSceneHistory.ts`
- `tests/browser/scenes.spec.ts`
- `tests/domain/scene-url.test.ts`

**Modified (source)**
- `src/app/game/page.tsx`
- `src/app/replay/page.tsx`
- `src/app/expedition/page.tsx`
- `src/features/shell/CampShell.tsx` (317 lines)
- `src/features/shell/useCampClicks.ts`
- `src/features/shell/shell.module.css`
- `src/features/character/ExpeditionView.tsx`
- `src/features/character/ExpeditionView.module.css`
- `src/features/character/RosterPanel.tsx`
- `src/features/arena/BattleReplay.tsx`
- `src/features/arena/ArenaPanel.tsx`
- `src/features/results/ResultsPanel.tsx`
- `src/game/replay.ts`
- `src/game/expedition-stage.ts`
- `src/game/expedition-path.ts`
- `src/game/camera.ts`
- `src/game/camp-scene.ts`
- `src/game/bridge.ts`

**Modified (tests)**
- `tests/browser/expedition.spec.ts`
- `tests/browser/replay.spec.ts`
- `tests/browser/arena.spec.ts`
- `tests/browser/management.spec.ts`
- `tests/browser/live-routes.ts`
- `tests/domain/replay.test.ts`
- `tests/domain/expedition-stage.test.ts`
- `tests/domain/expedition-path.test.ts`
- `tests/domain/scene-layout.test.ts`
- `tests/domain/roster-panel.test.ts`

## Screenshots (not committed)

In `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-16-task-13-full-screen-camp\shots\`:

| Screenshot | Desktop (1280×720) | Pixel 7 |
| --- | --- | --- |
| Replay overlay (pvp, fixture) | `scene-replay-desktop.png` | `scene-replay-mobile.png` |
| Expedition overlay (Varro's Ruined Outpost, live visitor, from the Gladiators list) | `scene-expedition-desktop.png` | `scene-expedition-mobile.png` |
| Expedition overlay (Woodland Path from Results, fixture) | `scene-expedition-result-desktop.png` | `scene-expedition-result-mobile.png` |
| Visitor "This expedition is not available yet" over the camp | `scene-visitor-not-available-yet-desktop.png` | `scene-visitor-not-available-yet-mobile.png` |

## Concerns

1. **Arena card Watch replay.** It now opens the replay scene over the camp. That file was outside the brief's list, but spec "Scenes" says "instead of navigating to a separate page". During a bout still in progress, the scene says "not available yet — the fight is still going on". It shows the replay by itself when the fight ends, because the filter is required.
2. **Fixture Results sample links.** They still go to the `/replay/` and `/expedition/` pages, as deep links; the expedition and replay specs' duplication tests navigate through them. Ask whether the preview should open them over the camp too.
3. **The brief's `b.id`.** `ReplayBattle` has no `id`, so the unit test uses `b.stage.id`.
4. **More reads on the deep-link pages.** `/replay/` and `/expedition/` now mount the shared sync: a revision read plus a world load, re-read on each revision change and every 30 s. A signed-in visitor also gets an owner read. This is what the plan asks for ("mount useGameState"); it is extra egress for Task 23 to measure.
5. **Expedition reads by mode.**
   - Fixture: the revision never changes, so only reveal marks read.
   - Live: a late stage or a settled summary now waits for the next 30-second revision poll (or focus), not the view's own display-time poll.
6. **Visitor replays.**
   - The "Rewards are credited when the activity settles." note still shows on any replay without a summary. That is pre-existing and slightly misleading for visitors, but it shows no reward.
   - An expired replay that a visitor deep-links reads "not available yet", because the public `completion` expiry is not used. This is pre-existing; Results offers no Replay for expired rows.
7. **Malformed activity ids in the overlay.** Unlike the expedition page, the overlay does not check the id is UUID-shaped. Its read simply fails and shows "not available".
8. **`CampShell.tsx` length.** It grew to 317 lines; 13.7 had flagged it at 294.
9. **Visual.** The scene is nearly opaque (97%) with blur, so menus beneath never read through. During the 0.25 s fade-in they do show through briefly, which is how the first phone screenshot looked. The mockup's scene is an opaque black over a zoomed camp image.
10. **Skill upkeep.** No skill change is proposed.

---

## Fix round 1 (`d6fa86c..7480cd3`)

**Commit:** `7480cd3` "fix: release scene WebGL contexts and tidy replays over the camp" (a new commit; no amend, no push).

### I1 (Important): WebGL contexts released when a scene closes

**The fix** is in `src/game/phaser-game.ts`, `startGame().destroy()`.
- Before calling `game.destroy(true)`, it registers a one-time listener for Phaser's `destroy` event.
- Phaser's `runDestroy` emits that event before `renderer.destroy()` drops `gl`. The listener reads this game's own `renderer.gl` and queues a microtask that calls `getExtension('WEBGL_lose_context')?.loseContext()`, unless the context is already lost. The microtask runs right after `runDestroy` completes, within the same step.
- Each `startGame` handle releases only its own game's context, so the camp's live context is never touched. The camp's own context is released only when the camp game itself is destroyed.
- The fake games in `phaser-game.test.ts` have no `events`, so the listener is optional-chained.

**Tests**
- **Browser:** `scenes.spec` "releases each closed scene's WebGL context, so the camp's is never the one the browser drops".
  - It records every WebGL context through a `getContext` wrapper, and every canvas that joins the page through a MutationObserver.
  - It runs 6 rounds of: a three-encounter replay (switching encounters twice), Back to camp, an expedition, Back to camp. Counting strict-mode remounts, that is more than 20 scene contexts.
  - It asserts that every closed scene's context is lost, and that exactly one camp context is live (`isContextLost() === false`) with the camp still ready.
  - It allows only Phaser's own one-time WebGL feature probe (`device/Features.js`, a canvas never attached and never released, once per page) to stay as it was.
- **Unit:** `phaser-game.test.ts` "releases the destroyed game's own WebGL context once Phaser has run its deferred destroy". It proves:
  - nothing is released before `runDestroy`;
  - the destroyed game's context is released exactly once;
  - the camp game's context is not touched.

### M3: Arena card Watch replay only after the bout

`ArenaPanel.tsx`, `ArenaCardView`:
- The button's `href` now requires `state.bout?.finished`.
- Mid-bout the button is disabled and the card says "The replay becomes available when the bout ends."
- The scene's display-time filter stays as a safety net.

Tests:
- `arena-panels.test.ts`: disabled at minute 60 with that text, enabled at minute 61.
- `arena.spec` "reveals the bout at minute 60…": disabled at 60, enabled at 61.

### M5: expired replays for spectators, and the visitor rewards note

**Expired replays**
- `replay.ts` `replayViewOf`: when there is no owner summary but `timeline.completion.replayExpiry.state === 'expired'`, it returns `{ kind: 'unavailable', reason: 'expired' }`, even if a log is still attached.
- `BattleReplay`'s `ReplayUnavailable` shows "This replay is no longer kept", with "Detailed replays are kept for seven days. The result stays in the recent results."
- The owner's own summary still wins.

**The rewards note**
- `BattleReplay`, `ActivityReplay`, `ReplayBattles` and `BattlePlayer` take `viewerId?: string | null`.
- "Rewards are credited when the activity settles." shows only when the viewer is a fighter in the bout, or when `viewerId` is left out.
- `SceneOverlay` passes the player's gladiator, or null for anyone who is not a player. The replay page passes `game.owner?.gladiatorId ?? null`.
- `TournamentPanel` is unchanged and still passes no `viewerId`, because `tournament.spec:118` expects the note there.

**Tests**
- `replay.test.ts`: the spectator's expired view, a log still attached, a kept replay, and the owner summary winning.
- `scenes.spec` (live visitor) "says a visitor's expired replay is no longer kept, not that it is coming", on both the page and the scene.
- `scenes.spec` visitor test: no "Rewards are credited".

### M6: focus moves with the scene

In `SceneOverlay`, when the scene key changes inside the same dialog (an expedition's encounter replay, or browser Back/Forward between scenes), the dialog scrolls to the top and focuses Back to camp. Focus no longer falls to `<body>`.

Test: `scenes.spec` "opens an expedition result over the camp…" checks Back to camp is focused:
- after the encounter's Watch replay;
- after the browser's Back to the expedition;
- after Forward to the replay.

### M10: fixture samples open as scenes

In `CampShell`, `ResultsMenu`'s "Sample replays" and "Sample expeditions" navs keep their accessible names. Each item is now `SampleLink`:
- a plain click calls `openScene`;
- a modified or middle click follows its `href`, `?mode=fixture&view=…&activity=…`, which opens the same scene over a new camp.

The unused `next/link` import is gone.

Test: `scenes.spec` "opens the fixture samples over the camp".

Updated specs that relied on navigating away:
- `expedition.spec` "never duplicates the scene…";
- `replay.spec` "never duplicates playback…". In both, the sample now opens over the camp (one loop, one scene canvas in the dialog, the same listener count); Back closes the scene and Back again returns to the page.
- `camp.spec` "re-entering the game keeps one canvas…". It is now entered from a replay page's Back to camp link, left with the browser's Back and re-entered with Forward. The camp has no link away from itself anymore.

### TDD evidence

**RED** (before any fix code):
- **Unit:** 2 failed.
  - Arena card at minute 60: `expected '<button …>Watch replay</button>' to contain 'disabled'`.
  - The spectator's expired view returned `not-revealed`.
- **Browser, desktop:** 8 failed.
  - Closed-scene contexts still live: `Expected: 0, Received: 16`.
  - Arena Watch replay enabled at minute 60.
  - Back to camp not focused after Watch replay.
  - The visitor saw "Rewards are credited when the activity settles.".
  - The sample did not open a scene.
  - No "This replay is no longer kept" heading.
  - The expedition and replay duplication tests had 2 scene canvases where 1 was expected (the old sample navigation).
- The `phaser-game.test.ts` unit test was written after the I1 code. The browser test above is I1's RED evidence.

**GREEN**
- The first covering run had 2 failures: one live context, Phaser's own WebGL feature probe, not a scene. I made the test distinguish attached game canvases from that never-attached probe. It then passed on both projects.

### Covering tests and gates

- **Covering run:** `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/scenes.spec.ts tests/browser/replay.spec.ts tests/browser/arena.spec.ts`, both projects: **119 passed, 1 skipped**.
- **Full development suite, run 1:** 374 passed, 2 failed (`camp.spec:408` on both projects; it relied on a sample link leaving the camp). After the fix, that test alone passed on both projects.
- **Full development suite, run 2:** **376 passed, 22 skipped** (6.5 min).
- `npm test`: **978 passed** (43 files).
- `npm run typecheck`: `tsc` clean, `deno check` clean, `deno test` 2/2.
- `git diff --check`: clean.
- No build ran in this round. The coordinator's covering list did not include a build, and none ran during a browser run.

### Files changed in fix round 1

**Source**
- `src/game/phaser-game.ts`
- `src/game/replay.ts`
- `src/features/arena/ArenaPanel.tsx`
- `src/features/arena/BattleReplay.tsx`
- `src/features/shell/SceneOverlay.tsx`
- `src/features/shell/CampShell.tsx`
- `src/app/replay/page.tsx`

**Tests**
- `tests/browser/scenes.spec.ts`
- `tests/browser/arena.spec.ts`
- `tests/browser/replay.spec.ts`
- `tests/browser/expedition.spec.ts`
- `tests/browser/camp.spec.ts`
- `tests/domain/phaser-game.test.ts`
- `tests/domain/replay.test.ts`
- `tests/domain/arena-panels.test.ts`

### Remaining concerns after fix round 1

- **Phaser's feature-probe context.** Phaser keeps its one WebGL feature-probe context per page. It is not reachable without patching Phaser, and it is a one-time cost, not per scene.
- **Tournament bracket replays.** They still show the "Rewards are credited…" note to everyone, because `TournamentPanel` passes no `viewerId`. Restricting it there would change `tournament.spec:118`, so I left it out of this round.
- **Sample links in a new tab.** A sample link's `href` drops `?as=visitor` in a new tab. This only affects a modified click in the fixture preview.
