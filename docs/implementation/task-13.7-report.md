# Task 13.7 report: Results, profile cards and merchants

- **Status:** DONE_WITH_CONCERNS
- **Branch:** `claude/task-13` in `C:\Avi\Studies\Projects\Cloudiator-claude`
- **Base:** `8b423f7`
- **Commit:** `2268aff feat: add results, profile cards and merchant shortcuts`

## What I implemented

### Results (`src/features/results/`)
- `result-text.ts`:
  - `resultLine(row)` returns `{ text, replay }` from the six public fields only.
  - Arena: "won / lost an Arena bout". Expedition: "returned victorious from / was defeated on / returned from an expedition". Tournament: "won a tournament" or "was knocked out of a tournament".
  - Training and Rest: "finished training" and "finished resting". They never offer a replay and never say "no longer kept", even if a summary claims a kept replay.
  - Any other expired replay adds " · replay no longer kept".
  - `resultKind` and `resultTime` (local time, e.g. "Sat 10 Oct, 14:40") give the second line.
- `ResultsPanel.tsx`:
  - `readResults(reader, loaded)` reads 50 rows at a time. It never repeats a row, and it ends the list when a page brings nothing new.
  - `ResultsView` is the pure view: rows, a gold "You" tag on the viewer's rows, a "Replay" button (accessible name `Replay: <line>`) only for a kept replay, "More", and loading, empty and failed states.
  - `ResultsPanel({ reads, viewerId, onWatch })` reads once each time the menu opens and never sends a command.
- `CampShell`'s Results menu shows the panel for every viewer, live or fixture. The fixture "Sample replays" and "Sample expeditions" navs stay below it, in fixture mode only.
- `onWatch` goes to `/replay/?activity=` (with `mode=fixture&` in fixture mode) through `useRouter().push`. It stays a callback, so 13.8 can change the target.

### Profile card (`src/features/character/ProfileCard.tsx`, `ProfileCard.module.css`, `actor-text.ts`)
- **`ProfileCard`** (the brief's interface plus some optional props: `profileFailed`, `record`, `followReason`, `following`) renders from the public actor at once:
  - name, then class · level · league;
  - Now;
  - Rating (Loading… / the profile's rating / Not available), or "Rating · record" when a standings row opened it;
  - Equipped, from the public equipment silhouettes;
  - Follow, disabled with an `aria-describedby` reason when the camera cannot follow;
  - Watch bout, for an Arena entrant;
  - on the viewer's own card only: a "YOUR GLADIATOR" eyebrow and the gold "My gladiator" and "Schedule" shortcuts. It adds no private value.
- **`ProfileLayer`** is the non-modal `role="dialog"` (`Profile: <name>`), with a "Close profile" × button:
  - It finds the actor in the world, or uses `profile.actor` for someone who is not in it (a standings row), and loads `gateway.profile(id)` on demand.
  - Until that profile arrives, an actor missing from the world shows the row's name and record with "Loading the profile…". If the read fails, it says "This profile is not available right now."
  - Placement: `placeCard` positions it on desktop. Beside a camp click it sits above the head (64 px over the body centre), or below the feet (+44 px) when there is no room above. A list row places it beside the menu panel. It always stays right of the rail and below the chip.
  - On touch (`COMPACT_QUERY`), CSS makes it a sheet above the ☰ button (bottom 76 px, as in the mockup).
  - A list row gives it the focus; a camp click leaves the focus with the camp.
- `actor-text.ts` now holds the place, class-line and gear words that RosterPanel and the card share.

### Camp clicks and merchants
- **Bridge and camp scene:**
  - `bridge.ts`: the `select-character` payload gains `screen: Point | null`.
  - `camp-scene.ts`: the payload comes from a new `screenOfView(v)`, which the handle's `screenOf` now also uses (same formula, no behaviour change).
- **`src/features/shell/useCampClicks.ts`** (new) holds the card state and both listeners:
  - `select-character` opens the card beside the click.
  - `openRow` opens it from a row, with the focus. Closing it with × or Escape returns the focus to that row, or else to the camp view.
  - One surface at a time: any change of the open menu closes the card. A camp click closes it too, before Phaser's mouseup opens the next one, because the pointerup comes first.
  - `open-merchant` opens Inventory and shops at `weaponsmith` or `armorer` for a player, and My gladiator (the sign-in or creation prompt) for anyone else. A request counter remounts the shops on every merchant click.
- **ShopPanel and InventoryPanel:**
  - Both take `initialMerchant?: Merchant`.
  - InventoryPanel also takes `merchantRequest`, which keys the ShopPanel.
  - On a merchant click, ShopPanel scrolls its nearest scrolling ancestor so the shops sit at the top of the menu.
- **Keyboard paths:**
  - The names in the Gladiators list (`RosterPanel`, `onProfile`) and in the standings (`StandingsView` / `StandingsPanel` / `ArenaMenu`, `onProfile(row)`) are buttons named `Profile: <name>`. They open the same card.
  - The standings path passes the row's win–loss record.
- **Escape** (in CampShell's key handler) closes the card first when the focus is inside it or no menu is open. Otherwise it closes the menu as before.

### Carried minors
- **13.2 (fixture slots):**
  - `plainRow` now counts `slotsAgo` the way `ARENA_ACTIVITIES` does.
  - Varro's Training is now 3 slots ago and Cassia's Rest 4 slots ago. Their bouts, and Varro's spectator expedition, are 1 and 2 slots ago.
  - The fixture stays deterministic and still has at least one row each of Arena, expedition, tournament, Training and Rest (asserted by the existing test).
  - New test: `fixture Training and Rest results fall in slots where their gladiators did nothing else`. It derives every gladiator's busy slots on its own, from the fixture timelines, `ARENA_ACTIVITIES`, `EXPEDITION_FIXTURES` and battle-log participants.
- **13.5 (Gladiators row reason):** a row that is neither drawn in the camp nor away shows "Not in the camp right now." under its name. Its disabled Find and Follow point to that text with `aria-describedby`. Tested in `tests/domain/roster-panel.test.ts`.
- **13.6 (CampShell size):**
  - The joining state (`creating`, `offered`, `created`) moved to `src/features/shell/useJoining.ts`.
  - The new camp-click wiring lives in `useCampClicks.ts`.
  - `CampShell.tsx` is 294 lines; it was 271 (counting the header comment). No other restructuring.

## TDD evidence

### RED (before any implementation)

**Domain tests:** `npx vitest run tests/domain/results-panel.test.ts tests/domain/profile-card.test.ts tests/domain/roster-panel.test.ts tests/api/fixture-gateway.test.ts`

| Test | How it failed |
| --- | --- |
| `results-panel.test.ts` | Failed to load: `Cannot find package '@/features/results/result-text'` |
| `profile-card.test.ts` | Failed to load: `ProfileCard` is missing |
| `fixture-gateway.test.ts` (new test) | `Varro training in slot -1: expected true to be false`, the real collision |
| `roster-panel.test.ts`, reason test | `Find Brutus: expected undefined to be truthy`: no `aria-describedby` |
| `roster-panel.test.ts`, profile test | No `aria-label="Profile: Aster"` |

**Browser:** `management.spec.ts` on the base, port 3200. Five tests failed because the element was missing:
- camp click: `profileCard('Aster')`;
- own card: the "My gladiator" button;
- merchant: the Inventory dialog;
- visitor merchant: the My gladiator dialog;
- Results: the list items.

**The slot-end test** (the old Task 13 Step 1) **passed on the base.** The behaviour already existed (13.3/13.5), so it is a characterization test. I checked that it can fail: I removed the Processing rule in `activity-status.ts` and it failed with `Expected: "Processing results" / Received: "Completed"`. Then I restored the file with `git checkout`.

**Written after the code:** the `placeCard` placement test and the `ProfileLayer` dialog test in `profile-card.test.ts`. I added them when I split the dialog frame from the card content. They passed at once, so they are not RED evidence.

### GREEN
- **Domain:** 5 files, 64 of 64 passed (including `scene-layout.test.ts`, updated for the `screen` payload).
- **Browser:**
  - `management.spec.ts`: 14 of 14 (desktop and mobile; 7 tests, including a live visitor Results test added afterwards).
  - `inventory.spec.ts`, `camp.spec.ts`, `arena.spec.ts` and every other spec passed in the full suites below.
- **Fixes during GREEN:**
  - The mobile merchant test first failed: the Inventory sheet covered the second click, so the test closes the sheet first on touch.
  - The live Results test first expected one `recent_results` read. It saw two, because React Strict Mode double-mounts effects in development, so it now asserts at least one.
  - A word-boundary fix in my own regex (`expedition` contains `xp`).

## Gate results

Run in order; no build overlapped a browser run; nothing else ran during `test:db`.

| Gate | Result |
| --- | --- |
| `npm test` | 42 files, 965 of 965 passed |
| `npm run typecheck` | tsc, deno check and deno test (2 of 2) passed |
| `node assets/source/build-assets.mjs --check` (verification-gates step) | assets up to date (28 files) |
| `npm run test:db` | Run 1 (only run): 9 files, 177 of 177 passed. The Edge container (`supabase_edge_runtime_Cloudiator`, mounting `Cloudiator-claude/supabase/functions`) had `StartedAt` `2026-10-17T09:10:13.620987064Z` before and after, unchanged, so the run counts. The `arena.test.ts:642` race did not occur. |
| `npm run build`, then `npm run verify:static` | build OK; "Static export verified: 5 fixed routes; 90 assets scanned; no forbidden backend material." |
| Full development browser suite (`pw-claude.config.mjs`, port 3200) | 352 passed, 22 skipped, 0 failed (6.2 min) |
| Isolated production gate | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build` OK; `verify:static -- .next/browser-test` verified 5 routes and 90 assets; `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test` 16 passed, 358 skipped, 0 failed |
| `git diff --check` (staged and unstaged) | clean |

An earlier full development run, before I added the live Results test, gave 350 passed and 22 skipped.

## Files changed

**Created**
- `src/features/results/result-text.ts`
- `src/features/results/ResultsPanel.tsx`
- `src/features/results/ResultsPanel.module.css`
- `src/features/character/ProfileCard.tsx`
- `src/features/character/ProfileCard.module.css`
- `src/features/character/actor-text.ts`
- `src/features/shell/useCampClicks.ts`
- `src/features/shell/useJoining.ts`
- `tests/browser/management.spec.ts`
- `tests/domain/results-panel.test.ts`
- `tests/domain/profile-card.test.ts`
- `tests/domain/roster-panel.test.ts`

**Modified**
- `src/game/bridge.ts`
- `src/game/camp-scene.ts`
- `src/features/shell/CampShell.tsx`
- `src/features/character/RosterPanel.tsx`
- `src/features/character/CharacterPanel.module.css`
- `src/features/arena/ArenaMenu.tsx`
- `src/features/arena/StandingsPanel.tsx`
- `src/features/arena/StandingsPanel.module.css`
- `src/features/inventory/InventoryPanel.tsx`
- `src/features/shops/ShopPanel.tsx`
- `tests/fixtures/results.ts`
- `tests/api/fixture-gateway.test.ts`
- `tests/domain/scene-layout.test.ts`

## Screenshots (not committed; the SDD folder is git-ignored)

All are in `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-16-task-13-full-screen-camp\shots\`:
- `results-menu-desktop.png` and `results-menu-pixel7.png`: the fixture player preview.
- `profile-camp-click-desktop.png` and `profile-camp-click-pixel7.png`: the visitor preview, Aster clicked in the camp.
- `profile-own-card-desktop.png`: the player preview, the own card.

## Concerns

1. **An Arena entrant's camp click shows its Arena card, not a profile card.**
   - The scene still emits `open-arena` after `select-character`, which is existing Task 10 behaviour that `arena.spec` relies on. The Arena menu then opens, and "one surface at a time" closes the card.
   - The mockup shows a profile card with "Watch bout" for Arena people. Here that card, and its Watch bout, is reached from the Gladiators list or the standings.
   - If Avi wants the mockup's flow from the camp too, the scene's entrant click must stop opening the Arena card, and several `arena.spec` tests change. That needs a ruling.
2. **Record:** `PublicProfile` has no win–loss record, so the card shows "Rating · record" only when a standings row opened it (the row's `humanWins–humanLosses`). Otherwise it shows "Rating". Showing it everywhere would need a backend field, which is out of scope ("no new game features").
3. **Aster's fixture overlaps remain.** The independent sample sets (Arena samples, replays, expeditions) still give Aster two or three results in some slots, visible in the Results preview. Only the synthetic Training and Rest rows moved, as the brief's bullets ask. Retiming engine-generated fixtures was out of scope; `results.ts`'s header says so.
4. **Results freshness:** Results reads once per menu open and does not re-read on a new world revision. The brief's props have no `revision`. In development, React Strict Mode makes the first read twice.
5. **Placement:**
   - The card is anchored where it opened (a later drag leaves it, as in the mockup).
   - Its gap above the body centre is fixed at 64 px, so at zoom 3 it can touch the head.
   - The own card's three buttons wrap to two rows at 272 px (the mockup also wraps).
6. **Watch actions until 13.8:**
   - Watch bout opens the Arena menu card through `open-arena`.
   - Results "Replay" goes to `/replay/` for every kind, expeditions included (the replay page shows their encounter battles). 13.8 may want to send expeditions to the expedition scene instead.
7. **Test-after:** the `placeCard` and `ProfileLayer` tests (see TDD evidence).
8. **Skill upkeep:** none proposed. No skill guidance changed in this task.
