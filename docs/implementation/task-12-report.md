# Task 12 implementation report: living isometric camp

Status: **DONE_WITH_CONCERNS**. Implemented, fixed after independent review, and verified locally. The concerns are listed under "Limitations".

- Dates: 2026-10-12, Asia/Jerusalem. Owner: Claude (visual lane).
- Branch: `claude/visual-track`, worktree `C:\Avi\Studies\Projects\Cloudiator-claude`.
- Commits:
  - `c6aeab0`: feat, the camp scene.
  - `3051531`: fixes for the independent review (shared with the Task 11 re-review fixes).
  - `ddb9bec`: adopts the C1 contract types.
  - The follow-up commit recorded in `task-12-review.md`: fixes for the re-review Minors (shared with the Task 11 second re-review fixes).
- Merged Codex checkpoints: `3d41ae9` (Task 4) and `ad1b7e8` (Task 5).
- Integration request: R2 (`docs/implementation/task-12-request-R2-game-page.patch`) is rebased on `ad1b7e8` and applies cleanly to it (`git apply --cached --check` against a temporary index). Codex owns `src/app/game/page.tsx` and applies it. In this worktree it exists only as an uncommitted change, used for testing.

## Delivered behaviour

`GameViewport` (React) lazy-loads Phaser 4.2.1, the asset manifest and `createCampScene` in the browser. The static build never touches WebGL. The scene renders public world state only. It never decides outcomes, rewards or schedules.

**Population**
- Every in-camp `PublicActor` is drawn with layered, tinted equipment from `equipmentSilhouettes`. Up to 50 players are supported, plus 6 ambient NPCs.
- The fixture world stays within the 50-row public world: the fixture owner, 43 demo gladiators in camp and 6 away.
- Gladiators on expeditions are counted as away and reported in a `roster` bridge event.
- Zones come from `location` (`CampLocation`):
  - training, rest and arena (tournament also uses the arena);
  - orientation, at the expedition gate;
  - camp, which means browsing the merchants.
- Each gladiator gets a deterministic station or a free tile and a variant, from `(gladiatorId, slotIndex)`. Animation offsets keep neighbours out of sync. Sparring pairs face each other.
- Players are kept off every NPC post tile.
- When one gladiator arrives or leaves, everyone else keeps their spot. Only a departing gladiator's sparring partner may re-pair.

**Arrivals and departures**
- The first world places everyone directly.
- In later worlds, arrivals walk in from the map's `gate` station and departures walk out to it, using A* on the walkable grid (octile distance, no corner cutting). Walk speed comes from the manifest, at 1 tile/s.
- When public equipment or colours change, that player's layer sprites are rebuilt.

**NPCs**
- Six routines run on the shared server clock, so every viewer sees the same thing.
- Paired NPCs meet face to face on shared periods: smith with armorer, cook with healer, and healer with trainer. More than 70% of NPC talking time is spent facing a partner.
- The guard's patrol passes behind the watchtower.
- Every walk leg fits its schedule, so nobody teleports (tested).

**Camera**
- Drag pans, the wheel zooms, two fingers pinch, and the arrow keys and + / − / 0 work once the camp has focus. Clicking the camp gives it focus.
- Zoom moves through fixed levels (`ZOOM_STEP` 1.25, from 0.5 to 3), shared by the buttons, keys and wheel:
  - wheel deltas accumulate in 100px steps, and a line-mode notch (3 × 40px) is one step;
  - horizontal scroll is ignored;
  - a direction reversal or a 250 ms pause starts a fresh gesture.
- The camera always stays inside the map bounds. It opens on the owner's gladiator, given by `focusGladiatorId`.
- The **Find** and **Follow** buttons centre on and follow the owner. They are disabled while the owner is not in camp.
- A press becomes a drag only after 6px, so a jittery click keeps a follow going. Dragging ends a follow.
- The scene answers any follow it cannot apply, after every listener has seen the request, so the toggle's `aria-pressed` always matches what the scene is doing.
- Ctrl, Meta and Alt shortcuts are left to the browser.

**Depth and occlusion**
- Actors sort at their feet. Wide props and the arena wall segments draw as slices, using the Task 11 depth rule (`src/game/depth.ts`). Actors win ties.
- Buildings fade whole while their *opaque pixels* cover the selected or followed character's body (`hidesActor`, using an alpha mask read once per frame name). Only the faded buildings are restored.

**Lighting and reduced motion**
- Phase tints for morning, afternoon and evening, blended over the last three minutes of a slot. Torches glow and flicker.
- With `prefers-reduced-motion`:
  - NPCs hold their first post;
  - arrivals are placed instead of walking;
  - torches and animated props hold still;
  - following snaps instead of easing.
- Activities and labels remain.

**Performance work**
- Ground tiles are baked into four render textures, replacing 2,116 images. The ground is repainted after a WebGL context restore, which would otherwise leave the render textures empty.
- Depth, frames, flips, label visibility and the lighting overlay are touched only when they change.
- Off-screen actors are culled.
- The fps targets themselves are Task 23.

**Failure paths**
- Without WebGL, failed art, or a runtime error in `update()`: the viewport shows a readable fallback, management panels stay usable, and `scene-unavailable` is emitted once. It is deferred, so panels mounting in the same commit still hear it.
- The WebGL probe context is released.

**Lifecycle**
- `handle.dispose()` removes the scene's bridge listeners synchronously on unmount and again on Phaser's scene `DESTROY`. `game.destroy` never emits `SHUTDOWN`.
- Bridge handlers are inert until the scene is ready, and after it is disposed.

## Interfaces

- `GameViewport({ world, bridge, focusGladiatorId? })`. The page owns one `SceneBridge` (`useState(createSceneBridge)`).
- `SceneBridge` events:
  - scene to UI: `select-character`, `open-merchant`, `follow-character`, `roster`, `scene-unavailable`;
  - UI to scene: `camera-zoom`, `camera-pan`, `find-character`, `follow-character`;
  - reserved for Tasks 14 and 15: `view-expedition`, `view-replay`, `return-camp`.
- Fixture builds only (`NEXT_PUBLIC_FIXTURE_ENABLED === 'true'`, which `next.config.ts` forces off in production): `window.__cloudiatorCamp` exposes state, props, listeners, emit, centerOn, screenOf, world/setWorld and freezeClock, for browser tests and evidence captures.
- `withDemoCrowd(world)` adds 49 in-camp and 6 away demo gladiators around the real fixture actor. It is used only by the fixture page (R2).

## Files

All in the reserved visual lane:
- `src/game/`: `camp-scene.ts`, `GameViewport.tsx`, `GameViewport.module.css`, `actors.ts`, `npcs.ts`, `camera.ts`, `iso.ts`, `paths.ts`, `lighting.ts`, `bridge.ts`, `demo-world.ts`, `depth.ts` (shared with Task 11);
- `tests/domain/scene-layout.test.ts` (29 tests);
- `tests/browser/camp.spec.ts` (14 tests, desktop and mobile);
- the R2 patch.

No shared files, dependencies or configs were changed.

## RED evidence and corrections

1. **NPC schedules.** The new "enough walking time" and "no teleporting" tests failed on the healer (−3.7 s slack; it jumped 3.3 tiles at 64 s) and the trainer (−5.8 s). The schedules were retimed, and both tests pass.
2. **`stepZoom` test.** It failed with `stepZoom is not a function`, then passed after the implementation.
3. **`hidesActor` test.** It failed with "not a function", then passed.
4. **Dispose test.** It was written after `dispose()`. A mutation check (removing the unsubscribe loop) makes it fail.
5. **Browser wheel test.** It failed: after a trackpad zoom-in, one mouse notch out did nothing, because the remainder kept its sign. Fix: a reversal resets the accumulator.
6. **Browser fade test.** It found no gladiator behind any building in the fixture slot, nor in 40 other slots, because layout keeps players clear of building backs. The test now finds, from the shared routines, a moment when an NPC walks behind an occluder, and freezes the clock there.
7. **Visual check.** It caught a fade false positive: the healer stood above a tent's transparent bounding-box area, and the tent faded. Occlusion now samples opaque pixels.
8. **Mobile.** A touch-emulated phone does not deliver mouse wheel events to Phaser. The wheel checks became desktop-only, and a real two-finger CDP pinch test was added for the phone.
9. **After merging `ad1b7e8`.** Typecheck failed on the C1 unions. The demo world and tests now use `CampLocation` and `EquipmentSilhouette`, and battle-log catalog ids are tested through `layersFor`.
10. **Re-review Minors.** Six new or changed browser tests failed for the expected reasons before the fixes:
    - the 56-row demo world;
    - a jittery click ending a follow;
    - Find and Follow enabled for an absent owner;
    - a line-mode notch and stale wheel deltas;
    - the players count;
    - the ground left blank after a context loss and restore (measured, not just read from the source).

    Each passed after its fix. The one-tile tie test also failed first.
11. **Codex's scoped review of `8f83ba8`.** It found that a disposed scene's queued follow refusal could cancel a replacement scene's follow. The regression test "drops a refusal queued by a scene that is disposed before it is sent" failed first, receiving `['g1', null]`. The fix adds a `disposed` check.

## Verification (2026-10-12, final commit plus the R2 page change)

```text
npm test                         10 files, 218 passed (scene-layout 32, assets 33)
npm run typecheck                tsc clean; Deno check and Deno test 1 passed
npm run build                    compiled; static routes /, /_not-found, /auth/callback, /game
npm run verify:static            3 fixed routes; 69 assets scanned; no forbidden backend material
node assets/source/build-assets.mjs --check   assets up to date (26 files)
npx playwright test -c <private config, port 3200, repo env>
                                 57 passed, 5 skipped. Camp: 17 tests x desktop and mobile = 33 passed
                                 plus the desktop-only pinch skip. Codex's shell and identity suites are included.
```

The camp browser tests check real behaviour:
- each gladiator's zone and tile bounds for its location, and no gladiator on an NPC post;
- a full 50-gladiator camp, each gladiator on its own tile;
- opening on the owner, and Find, Follow and drag;
- camera bounds;
- fixed zoom steps from the buttons, keys and wheel, with browser shortcuts left alone;
- the phone pinch;
- out-of-sync animation;
- every prop slice depth as Phaser holds it, compared with an independent `drawSlices` computation from the shipped JSON;
- the guard behind the watchtower, with its fade and restore;
- Find and Follow disabled for an absent owner, and a refused follow shown as not pressed;
- the ground repainted after a WebGL context loss and restore;
- morning, afternoon and evening lighting as applied;
- departure, arrival and equipment redraw, with no reshuffle;
- reduced motion;
- re-entry;
- the art-failure and no-WebGL fallbacks.

Evidence screenshots are committed in `docs/implementation/task-12-evidence/`:
- the overview in morning light (desktop and mobile);
- the guard behind the watchtower, plain and faded (desktop);
- afternoon (desktop) and evening (desktop and mobile).

## Limitations

- A first world that arrives after the scene is ready is handled by an explicit `worldApplied` flag (the first world never walks in). This is not browser-tested, because the fixture always loads its world first.
- Players are never placed behind buildings, so the occluder fade shows mainly for walking NPCs and arrivals.
- The 60 fps desktop and 30 fps mobile targets are unmeasured (Task 23).
- `assets.ts` inlines every atlas and map JSON (about 50 KB gzip in total, of which the camp is about 31 KB). Splitting it per scene is left for Tasks 14 and 15, when those scenes load.
- The expedition-gate click target has no bridge event yet; Task 15 adds one with the expedition view.
- Every step moves at the same world speed, so on screen (isometric projection) grid diagonals look different from straight steps: (1,1) steps look about 37% slower and (1,−1) steps about 26% faster.
- Before Task 13 wires up the live world:
  - the scene clock re-anchors on every snapshot (live mode should use the shared sync clock);
  - `scene-unavailable` is an event only, so a panel that mounts later needs a status query.
- `smoothPixelArt` replaces `pixelArt`, so fractional pinch zooms stay crisp. Zoom levels themselves remain powers of 1.25.
- The demo crowd and test hook are fixture-only. Live public projections are Codex's Task 10.
