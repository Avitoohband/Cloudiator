# Task 13.5 report: the full-screen shell, rail, panels and chip

Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-13`, base `1cd64eb`.
Commit: `5c109f6 feat: open the camp full screen with a hidden menu rail` (not pushed). The session was interrupted by a PC restart before the gates; the uncommitted work survived, and every gate below was run after the restart.

## What was implemented

**Shell** (`src/features/shell/`)
- `CampShell({ fixture, previewAs, fixtureRefused? })` replaces the dashboard. It owns `useGameState`, the scene bridge, the fixture samples and the menus' contents. `fixtureRefused` is one optional addition to the brief's interface: it carries "Fixture preview is unavailable in this build." to the same pill position.
- `src/app/game/page.tsx` only reads `mode` and `as` and renders `CampShell`. `src/app/page.tsx` renders the same page, so `/` and `/game/` open the same camp.
- DOM order is: rail, chip, pill and notices, menu surfaces, then `<main id="main">` with the camp. This makes the Tab order rail icons → zoom buttons → corner chip.
- The first Tab from the page body reveals the rail and focuses its first icon. Escape closes the open menu and returns the focus to its icon (or to ☰ when the touch row is hidden). Escape inside a native `<dialog>` (the discard confirmation) is left to that dialog.
- A click on the camp (pointer moved under 6 px) closes the menu and hides the rail. A drag leaves menus open. `open-arena` from the camp opens the Arena menu.
- `menus.ts`: `MENUS` lists the seven menus in the brief's order, with the exact labels. There is no Marketplace. `menusFor(viewer)` gives a player all seven and everyone else the five public ones.
- `rail-reveal.ts`: the pure `railReducer` (`EDGE_PX = 12`, `RAIL_HIDE_MS = 300`, `COMPACT_QUERY`). `MenuRail` turns pointer, focus and timer signals into its events.
- `MenuRail` has:
  - a 12 px edge zone and the 5 px grip at the vertical middle;
  - the icon column with tooltips (`role="tooltip"`, beside the icon) and Zoom in / Zoom out / Reset zoom at the bottom, hidden while the scene is unavailable;
  - the ☰ button (`aria-label="Menus"`).
  The icons' accessible names are the exact `MENUS` labels, so the Schedule icon is exactly "Schedule".
- `MenuSurface`: a labelled `role="dialog"` at `left 66px; top 64px; width min(380px, 100vw - 96px)`. It takes the focus on open, scrolls internally, and has a × button. On touch it is a bottom sheet (62% high) that a swipe down on its handle closes. Surfaces render outside the camp view's element.
- `CornerChip`:
  - A player sees name, stamina, money, renown and an m:ss countdown to the next slot boundary of the shared clock. On touch they see only the name and the countdown. The chip opens a small "Account" menu with "Sign out" (live) or a preview note (fixture).
  - For 13.5 only, a visitor's chip "Sign in with Google to join" opens My gladiator, where Google sign-in lives. Task 13.6 makes it start sign-in.
- Fixture mode keeps the pill "Fixture mode — progress is not saved online" at the top centre. On touch it sits below the chip row; in a narrow pointer window it sits beside the rail.

**Menu contents**
- **My gladiator** — `src/features/character/CharacterPanel.tsx`:
  - A player gets a summary (name, class, level, league, the activity label plus the `activityStatus` line, a stamina bar, money, renown) and `BuildPanel`. Fixture mode shows "This preview cannot change the build."
  - Without a gladiator it shows the old joining content: "A legend awaits", SignIn, the creation form and the session and owner-load states.
- **Schedule:** `SchedulePanel` in live mode; the read-only sample plan in fixture mode.
- **Inventory and shops:** `InventoryPanel` (with `ShopPanel`).
- **Arena** — `src/features/arena/ArenaMenu.tsx`:
  - It holds the "Arena bouts in the rings" group (from the bridge `arena-fights` event, kept by the shell), `ArenaPanel` and `StandingsPanel`.
  - `ArenaPanel` stays mounted while the menu is closed, so camp clicks still open its card and its test hook exists.
  - `StandingsPanel` mounts, and reads, only while the menu is open.
- **Tournaments:** `TournamentPanel`.
- **Results:** in fixture mode, the "Sample replays" and "Sample expeditions" navs. In live mode, "Recent results are not available in this build yet." (Task 13.7 adds the list.)
- **Gladiators** — `src/features/character/RosterPanel.tsx`:
  - All world actors, sorted, with a "Filter by name" search box.
  - Each row has a Find button (`Find <name>`) and a Follow button (`Follow <name>`, `aria-pressed`). A player also gets "Find my gladiator" / "Follow my gladiator".
  - Away rows say "On an expedition".
  - While the scene is unavailable or still opening, the buttons are disabled and described by the reason.
  - Find and Follow hand the view back to the camp: the menu closes and the camp view takes the keyboard focus (as in the mockup).

**Other changes**
- `GameViewport` gets `chrome?: 'framed' | 'none'`. `none` fills its parent and drops the camera controls and the fights group. The fallback notice sits in the upper part of the screen, so a bottom sheet does not cover it.
- `src/game/camp-scene.ts` (not in the brief's file list): a press that begins or ends off the game canvas is never a camp click, and never pans or pinches.
  - Phaser also listens on `window`. On the mobile project, a tap on a sheet's title over the owner selected the owner. A tap on the Arena icon over an Arena entrant opened Arena; the click's own toggle then closed it again.
- `next.config.ts`: `devIndicators: false`. The Next dev indicator sat at the bottom left, over the ☰ button, and blocked clicks in dev browser runs. Compile and runtime errors still show.
- `globals.css`: removed the `.dashboard`, `.fighter-card`, `.management`, `.panel-nav`, `.scene-placeholder` and `.day-strip` rules. I also removed rules nothing uses any more:
  - the fighter-card helpers (`.fighter-class`, `.activity-box`, `.stamina-label`, `.wallets`, global `progress`);
  - the old header status (`.world-status`, `.status-dot`, `.signout-button`);
  - `.world-note`, `.panel-content`, `.scene-label` and `.scene-caption`;
  - the landing page rules.
- `ArenaPanel.module.css`: the ring-button styles; no top divider when the card section comes first.

**Carried Minors (ruling 4)**
- (a) `activityStatus` uses `current = Math.max(slotIndex, Math.floor(nowMs / SLOT_MS))`, with `SLOT_MS = RULES_V1.clock.slotMs`. The stale-slot unit test is added. Three old assertions encoded the stale-slot behaviour; they now use a checkpoint at the next slot (see TDD).
- (b) Live failures are visible:
  - a sync error shows "Connection lost — showing the last known camp" below the chip (`role="status"`), and the world stays;
  - when the scene is unavailable, the camp's notice stays in view while the menus work;
  - a failed owner refresh with an owner kept shows "Your gladiator could not be refreshed. Showing the last loaded details." with a Retry button in My gladiator.
- (c) `useGameState` makes one local sign-out attempt per completed sync publish that still reports `unauthenticated` while signed in. It never starts two at once and never runs on a refresh in progress. `live-routes.ts` records Auth calls (`authRequests`) and adds `failLogout(times)` and `fail(table, false)`. The tests assert `scope=local`. See the observation below.
- (d) `TournamentPanel` takes `viewer`. The league picker shows only for `visitor` and `no-gladiator`. A `loading` player gets "Loading your gladiator’s tournament…" and no read. An `unavailable` viewer gets the "cannot be loaded" notice.

**Observed (not a tested fix): the 13.3 premise for (c) does not reproduce for a 5xx sign-out.**
- With supabase-js 2.117.3, `_signOut` removes the local session even when `/auth/v1/logout` returns 503, before returning the error.
- So one attempt is enough there. A new test pins this: "drops the rejected session locally even when the server refuses its sign-out".
- The retry matters when the sign-out fails and keeps the session. The retry test produces that case by making the browser storage refuse the first removal of the session key.

## TDD evidence

**RED, unit:** `npx vitest run tests/domain/menus.test.ts tests/domain/rail-reveal.test.ts tests/domain/activity-status.test.ts tests/domain/tournament-panel.test.ts`.
- `menus.test.ts` and `rail-reveal.test.ts`: `Cannot find package '@/features/shell/...'`.
- The stale-slot test: `0 ms after the end: expected { status: 'completed' } to deeply equal { status: 'processing' }`.
- The league-picker test: `expected '<section …' not to contain 'aria-label="League"'` for the `loading` viewer.
- Total: 2 failed, 26 passed in the two loadable files.

**GREEN, unit:** 4 files, 35 of 35. The full suite: 39 files, 948 tests.

**RED, browser.** I ran a representative subset of `full-screen.spec.ts` and the new `live-camp` retry test before the shell existed.
- `shows only the grip…` and `opens menus from the ☰…`: `chip-name` not found.
- `opens the same camp at / and /game/`: no `application`.
- `says when the connection is lost…`: the notice was not found.
- The retry test: `expect.poll(logouts).toBe(2)`, Received 1. There was no retry after the failed sign-out.

**RED, regression test for the camp-scene fix.** With `src/game/camp-scene.ts` stashed, `never passes a click on a menu through to the camp below it` failed on mobile: `selected` Expected `"npc:smith"`, Received the owner's id. Desktop passed even without the fix. After `git stash pop`: 2 of 2 passed.

**GREEN, browser, during development.**
- `full-screen.spec.ts` and `live-camp.spec.ts`: first desktop-only, then all.
- Full suite run 1: 313 passed, 5 failed.
  - The tournament 360 px test on desktop: 15 words split in a 264 px panel. Narrow pointer windows now use the touch layout; see Concern 1.
  - The arena flip test on mobile: see Concern 2.
  - `replay.spec` (twice): its sample link moved into Results.
  - `shell.spec` on mobile: the row is hidden while a sheet is open.
- Full suite run 2: 317 passed, 1 failed. In `camp.spec` on mobile, a stale 300 ms hover timer from the mouse hid the touch row after ☰ opened it. The touch layout now ignores hover and focus-out.
- Then the gate run below: 318 passed.

## Gate results (in order; builds and browser runs never overlapped)

| Gate | Result |
| --- | --- |
| `npm test` | 39 files, 948 tests passed |
| `npm run typecheck` | exit 0 (tsc, deno check, 2 Deno tests ok) |
| `npm run test:db` | 9 files, 177 of 177 passed, first run. Edge `StartedAt` `2026-10-17T06:57:37.682955275Z` before and after (unchanged; the run counts). The known `arena.test.ts:642` race did not occur. |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, then `npm run verify:static` | built 7 static pages, no warnings; "Static export verified: 5 fixed routes; 91 assets scanned; no forbidden backend material." |
| Full dev browser suite (`pw-claude.config.mjs`, port 3200) | 318 passed, 18 skipped, 0 failed (5.6 min). Port 3200 free before and after. |
| Isolated production gate | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`: exit 0. `verify:static -- .next/browser-test`: 5 routes, 91 assets, clean. Static Playwright run: 16 passed, 320 skipped (13.4 had 14; the new `/` and `/game/` test runs there). |
| `git diff --cached --check` | clean |

## Files changed

- **New:**
  - `src/features/shell/{CampShell,MenuRail,MenuSurface,CornerChip}.tsx`, `menus.ts`, `rail-reveal.ts`, `shell.module.css`;
  - `src/features/character/CharacterPanel.tsx`, `RosterPanel.tsx`, `CharacterPanel.module.css`;
  - `src/features/arena/ArenaMenu.tsx`;
  - `tests/browser/shell-helpers.ts`, `tests/browser/full-screen.spec.ts` (17 cases);
  - `tests/domain/menus.test.ts`, `tests/domain/rail-reveal.test.ts`.
- **Modified, source:**
  - `src/app/game/page.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `next.config.ts`;
  - `src/game/GameViewport.tsx`, `GameViewport.module.css`, `src/game/camp-scene.ts`;
  - `src/features/character/useGameState.ts`, `activity-status.ts`;
  - `src/features/tournaments/TournamentPanel.tsx`, `src/features/arena/ArenaPanel.module.css`.
- **Modified, tests:**
  - `tests/domain/activity-status.test.ts`, `tournament-panel.test.ts`;
  - `tests/browser/live-routes.ts`;
  - the specs `shell`, `camp`, `arena`, `arena-live`, `inventory`, `planning`, `tournament`, `identity`, `live-camp`, `expedition`, `replay` and `sync`.
  - The last four are outside the brief's list, but they depended on the old page: the Results links, the `/` route and the moved buttons.

## Screenshots (not committed)

In `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-16-task-13-full-screen-camp\shots\`:
- **Required:** `desktop-1280x720-arena-panel.png` (a panel open) and `pixel7-arena-sheet.png` (a sheet open).
- **Extra:** `desktop-1280x720-at-rest.png`, `desktop-1280x720-rail-tooltip.png`, `desktop-1280x720-my-gladiator-panel.png`, `pixel7-at-rest.png`, `pixel7-menu-row.png`.

## Concerns

1. **Narrow pointer windows use the touch layout.** Below 481 px, a window with a pointer gets ☰, the icon row and sheets (`COMPACT_QUERY = '(hover: none), (max-width: 480px)'`). This extends Decision 3.
   - At 360 px the brief's panel formula gives a 264 px panel. There, the existing tournament test found 15 words of the replay fighter table split across lines.
   - The panel formula still applies from 481 px.
2. **Assertions adapted to the full-screen layout.** No assertion was dropped.
   - `arena.spec` "lists the fights…": "below the camp view" (impossible when the camp fills the window) became "inside the Arena menu, and the menu leaves the corner chip clear". The "every button fits" checks stay.
   - "leaves the page where it is…" now measures the Arena menu's own scroll, not `window.scrollY`; its title changed to "leaves the menu where it is…".
   - The arena flip test now centres each ring before reading it. The scene skips frame and flip updates for actors outside the view, and the full-screen phone viewport changed which rings were on screen.
   - `camp.spec` "re-entering the game" leaves through a Results sample replay; the header brand link is gone.
   - `sync.spec` loads `/replay/` instead of `/`, because `/` is now the live camp and would read the local Supabase.
3. **Find and Follow close the menu (mockup behaviour).** Follow's pressed state is visible only when Gladiators is reopened. The mockup's "Following X — Stop" pill is not in the brief and was not built.
4. **`devIndicators: false` is a project-wide dev-config change.**
5. **The `camp-scene.ts` change is outside the brief's file list.** It was needed for the shell to be safe on touch, where taps on sheets and the icon row reached the scene through Phaser's window listeners.
6. **Interim chip states before Task 13.6.**
   - A visitor's "Sign in with Google to join" opens My gladiator.
   - A signed-in viewer without a gladiator sees "Signed in · no gladiator yet" with Sign out.
   - The fixture chip menu has no Sign out, only "Local preview: no account is signed in."
7. **Standings re-read each time Arena opens.** Pages loaded with More are not kept across a close, as with the old tab switch.
8. **A test-environment note.** `Input.synthesizeScrollGesture` with `gestureSourceType: 'touch'` does not scroll in this Chrome. The sheet-scroll test uses `Input.dispatchTouchEvent`.
   - Probe specs under `node_modules/.cache` must be `.mjs`: Node cannot strip TypeScript there.
   - The local-testing memory could record both. That is a note for the controller to decide; I did not change any memory or skill.

## Fix round 1 (review I1 and controller Finding 2)

Commit: `6bbbdbe fix: guard checkVisibility and show the touch menus as one row`. It is a new commit on `5c109f6`, with no amend, not pushed. The touch layout below 481 px and the placement of the fixture pill stay as ratified.

**I1: `checkVisibility` broke closing a menu on Safari 16.4–17.3.**
- **Fix.** `shown()` in `src/features/shell/CampShell.tsx` feature-detects `Element.checkVisibility`. Without it, an element counts as shown when `getClientRects().length > 0` and its computed `visibility` is not `hidden`. Both of its callers are covered: the focus return after every close, and the first-Tab handler.
- **Sweep.** I grepped `src` for other APIs newer than the Safari 16.4 floor. `checkVisibility` was the only one. The others used are older than the floor:
  - `structuredClone`, `Array.prototype.at` and `Object.hasOwn` (Safari 15.4);
  - `width: fit-content` and `overscroll-behavior` (Safari 16).
- **RED.** The new test `closes a menu without an error where checkVisibility is missing (Safari 16.4 to 17.3)` deletes `Element.prototype.checkVisibility` in an init script.
  - It failed on both projects. The dev server logged `Uncaught TypeError: element.checkVisibility is not a function` (CampShell.tsx:37).
  - The rail was gone after the × close: "Results" icon not found.
- **GREEN.** The test passes on both projects. It checks that:
  - × closes the sheet or panel;
  - the focus returns to the Results icon;
  - the camp `application` stays, and so does ☰ (touch) or the revealed rail (desktop);
  - Escape from Gladiators returns the focus to its icon;
  - no `pageerror` occurs.

**Finding 2: the touch row.**
- **Fix** (in `shell.module.css`):
  - ☰ now shows one row with the seven menu icons only (`flex-wrap: nowrap`, `flex: none` icons).
  - The row scrolls sideways inside its own box (`overflow-x: auto`, `overscroll-behavior-x: contain`), with `max-width: calc(100% - 80px)`.
  - The touch layout has no separator and no zoom buttons, because touch pinches. A pointer window under 481 px still has the wheel and keys.
- **RED.** The new test `shows the menu icons as one row that scrolls sideways when it does not fit, without zoom buttons` runs at 360×640 on the mobile project. It failed with `icon tops 494, 494, 494, 494, 494, 494, 538`: seven icons in two rows.
- **GREEN.** The test now checks, at 360×640:
  - all icons share one `top`, and there is no Zoom in button;
  - the row's `scrollWidth > clientWidth`, and the row box ends inside 360 px;
  - no document overflow, before or after scrolling the row to its end;
  - the last icon sits inside the row box and opens its sheet.
- **`camp.spec`.** The zoom test (12 steps to 3×) and the re-entry test (one step to 1.25×) now take each step through a `zoomInStep` helper. On desktop it clicks the rail's Zoom in button; in the touch layout it presses the camp's own `+` key. The assertions are unchanged.
- **Screenshots.** I re-captured `shots/pixel7-menu-row.png`: one row, all seven icons visible. A new `shots/phone-360x640-menu-row.png` shows the row at 360 px, with the seventh icon cut at the edge as the scroll cue.

**Covering runs**

| Check | Result |
| --- | --- |
| `full-screen.spec.ts` (both projects) | 27 passed, 11 skipped |
| Full development browser suite (`pw-claude.config.mjs`, port 3200; run alone, no build during it) | 321 passed, 19 skipped, 0 failed (5.6 min) |
| `npm run typecheck` | exit 0 |
| `git diff --check` / `git diff --cached --check` | clean |

No build or `test:db` run was needed in this round: no backend file changed, and the brief did not ask for them.
