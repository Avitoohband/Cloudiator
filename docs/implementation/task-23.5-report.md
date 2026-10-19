# Task 23.5 report: accessibility and the release browser spec (Lane B)

**Status: DONE_WITH_CONCERNS.** Every gate passed in order. The concerns are judgment calls, plus one fix that no test can order (see Concerns).

**Commits:** `3d119f2` feat: make the release accessible by keyboard and screen reader, then this report as `docs: report Task 23.5`. Not pushed.

- **Worktree and branch:** `C:\Avi\Studies\Projects\Cloudiator-replay`, `claude/task-23-ui`, from `b6bd8c7`.
- **Scope:** the Task 23.5 brief (plan `docs/superpowers/plans/2026-10-19-task-23-release-readiness.md`), with the controller's clarifications: no new package; Playwright 1.64 role and name queries, `toMatchAriaSnapshot`, an in-page accessible-name check and a WCAG contrast check from computed styles; reduced motion stays OS-driven (Decision 2); the camp's Reload (R13) stays with Task 23.4; "last known camp" stays (Decision 2).
- **Read first:** `AGENTS.md`, `docs/operations/verification-gates.md`, the brief and the context pointers, the Task 13, 14, 18 and 21 review records, and the Next.js guides `03-architecture/accessibility.md` and `03-api-reference/03-file-conventions/layout.md` (the root layout stays a Server Component and renders a small Client Component).
- **Not done, as briefed:** no package or tool download, no `npm ci`, no database run, no push, no change to `src/game/GameViewport.tsx` (Task 23.4's file), no `supabase status`, and no subagent.

## What changed

### 1. The skip link is the first Tab stop on every page (C19)

- **Before:** the camp shell took the first Tab from `<body>` and focused the first rail icon, so the skip link in the root layout was never reached. The link was a plain `#main` fragment link to a `<main>` that could not take the focus, so activating it left the focus on `<body>`, and it pushed a `#main` history entry the App Router does not know.
- **Now:**
  - `src/features/shell/SkipLink.tsx` (new, a Client Component) renders the same "Skip to content" link. A click or Enter moves the focus to `#main` itself and adds no history entry.
  - `src/app/layout.tsx` renders it; every `<main id="main">` takes the focus (`tabIndex={-1}`): the camp, `/replay/`, `/expedition/`, the auth callback and the three Suspense fallbacks.
  - `src/app/globals.css`: the focused landmark shows no outline (it is not a control).
  - `CampShell.tsx` no longer handles Tab. The browser's order applies: the skip link, then the rail's first icon, whose focus reveals the rail as before.

### 2. The focus is never left on `<body>` (C19), and moves to a trade's outcome (C18)

- **`src/features/shell/useFocusRescue.ts` (new), used by `CampShell`.**
  - When the focused control leaves the page or becomes unusable, the browser drops the focus to `<body>`. Examples: a bought listing's row, a dismissed sign-in notice, a menu the viewer lost at a sign-out, expiry or account switch, or the chip's Sign out replaced by the sign-in button.
  - A `MutationObserver` notices this and puts the focus back near where it was. The order is: the nearest container that takes the focus (a menu panel, a card), else the first control of the nearest part of the page that still has one, else the open modal's first focusable element, else the camp view.
  - It leaves alone a focus the player moved on purpose (a press on the page) and a focus that leaves for the browser. It also leaves alone a dialog that has closed, which returns the focus itself.
- **`src/features/shell/focus-lost.ts` (new).** After a command settles, a panel can move the focus to its outcome:
  - **Trades** (Marketplace buy, list and cancel; Inventory sell, discard and shop purchase): the receipt or the reason takes the focus unless the player moved it out of the panel.
  - **Build and Schedule:** the outcome takes the focus only when the focus was lost, for example when Cancel pending build removes its section.
  - The outcome paragraphs take the focus with `tabIndex={-1}`, as the creation dialog's reason already did.
- **`SceneOverlay.tsx`.** Escape no longer closes the scene's dialog natively. That would drop the focus to `<body>` until the route changed, and React's commit-time focus restore then undid the opener's focus. Escape now asks the scene to close, and the scene gives the focus back to its opener when it unmounts, as Back to camp does.

### 3. Validation messages are linked to their fields

All of these use `aria-invalid` and `aria-describedby`.
- **Build** (`BuildPanel.tsx`): "Review your build: …" marks the attribute fields (reason `points`) or the equipment fields (`item`, `slot`, `level`, `reserved`, `two-handed`) invalid and describes them; it also describes Queue build.
- **Schedule** (`SchedulePanel.tsx`): a refused save describes that phase's activity field and its Save button. The field is marked invalid only when the server refused the choice itself; `processing`, `conflict`, `unavailable` and `rate-limited` do not mark it.
- **Shop** (`ShopPanel.tsx`): "Choose a whole quantity from 1 to 60." and "Inventory full for this purchase…" mark and describe the quantity field and describe the Buy buttons. Each offer's "Requires level N" and "Not enough available …" describe its Buy button.
- **Marketplace** (`MarketPanel.tsx`): a disabled Buy is described by "Not enough available money" or "Your inventory is full". The price field is marked invalid and described by its hint and "Enter a whole price from 1 to 1,000,000,000."; List for sale is described by that message or by the listing limit.
- **Create** (`CreateCharacter.tsx`): a refusal about the name (the name rule, a taken name, `invalid`) marks the name field invalid and describes it after its help text. While the points do not add up to 10, every point field is marked invalid and described by the count.

### 4. Seasons (C17)

- The progress bar reads "3 of 5 human bouts" (`aria-valuetext`).
- The picker's name ("Season") and the medal pill's name ("1st · Champion", medal hidden) were already right; an accessibility snapshot now pins them.
- The picker's border failed 3:1 (see 5).

### 5. Contrast (WCAG 1.4.3 text, 1.4.11 controls)

The checks found three real misses, now fixed with the smallest colour change:
- **Form field edges:** 1.83:1 (`--line` `#39455c`) for the season picker, the Build and Schedule fields and the creation form, and 1.67:1 for the Gladiators filter. A new `--field-line: #7a86a0` gives at least 3:1 against the panels and the Schedule's coloured slots. The shop and price fields, which used `#65718a`, use it too.
- **The chosen merchant (Weaponsmith or Armorer):** gold text on the default button grey, 3.28:1. It is now gold on `#2f2a1e` (8.8:1).
- Every other panel, scene, card and chip text already met its minimum, and so did the focus rings that were checked.

### 6. One definition of an ended bout (C19)

- **Before:** the Arena card and the camp's rings ended a bout at its stage's published `endsAtMs`, and the replay at its start plus the log's duration. The server publishes the second as the first (`08-arena-bouts.sql:239`), but hand-made fixtures differ: the replay fixtures' bout stage runs to minute 80.
- **Now:** `boutEndMs` in `src/game/replay.ts` is the one definition: the logged end when the log is known, else the published end. `arena-stage.ts` uses it for the card's result, "Bout in progress" and the `bout.endsAtMs` that the rings schedule from, and the replay uses it for the battles it offers.
- **Test changes:** the Task 15 test (a stage that runs to minute 80) is unchanged. The Task 17 test "changes ring and card over together…" keeps its invariant (ring and card change over together) but now at the logged end when a stage publishes another one. That is the judgment call this item needed; see Concerns.

### 7. The scene history and remount races (C19)

- **Double open** (`useSceneHistory.ts`): `open` and `close` read the address itself. Two requests before the router has followed the first (a double click, two bridge events) push one entry, so Back to camp returns at once. A Back to camp already in flight ignores a second press, which would otherwise go back past the camp.
- **Remount on the first viewer change** (`SceneOverlay.tsx`): a scene's view mounts once the viewer is known (`viewer !== 'loading'`). A signed-in deep link no longer mounts as a visitor's view and remounts as the player's, reading its timeline twice and restarting the replay. The account-change remount (final review Minor 1) stays on purpose.
- **Stale closure after a refresh** (`useGameState.ts`): after a session refresh, the owner is read through the latest `loadOwner` (a ref), not the one captured before the `await`. No browser test can order those events, because a refresh restores the account it refreshed. This is a code-level fix and is not test-proven (see Concerns).

### 8. Tests

- **New `tests/browser/a11y-helpers.ts`.**
  - `watchFocus` and `focusDrops`: a page-side watch for the focus left on `<body>` after a key or a DOM change.
  - `expectNamedControls`: every Tab-reachable control has an accessible name, by Playwright's accessible-name computation.
  - `contrastIssues`: WCAG ratios from computed styles. Backgrounds and opacity are composited up the ancestors onto the camp colour, and a gradient counts its worst stop. It checks text at 4.5:1 or 3:1 for large text, and form-field edges, progress fills and focus outlines at 3:1.
  - `a11yShot` and `noHorizontalScroll`.
- **New `tests/browser/release.spec.ts`:** the seven brief tests and the gap tests (listed under Tests).
- **`tests/browser/market.spec.ts`:** five C18 tests; `openMarket` takes the expected offer count.
- **`tests/browser/full-screen.spec.ts`:** the first-Tab test now expects the skip link first, then the rail.
- **`tests/domain/arena-stage.test.ts`:** the one-definition test.
- **`tests/domain/arena-layout.test.ts`:** the Task 17 test updated as above.
- **`tests/domain/market-panel.test.ts`, `tests/domain/arena-panels.test.ts`:** markup tests for the linked Buy reason and the progress value text.

## Each gap, how it is closed and how it is tested

| Gap | Closed by | Test |
| --- | --- | --- |
| R2: Schedule enabled and named "Schedule" when actor art fails | Already true; now pinned | release: *keeps Schedule enabled…* (art aborted, the camp says so, Schedule opens) |
| R10: keyboard, touch, reduced motion | Sections 1 and 2; reduced motion stays OS-driven | release: the desktop keyboard journey, the touch keyboard journey, and *respects reduced motion…* |
| R13: camp Reload | Task 23.4 (`GameViewport.tsx`), not here | `test.fixme` *offers a working Reload…*, with the pointer |
| C17: season picker, progress bar, medal pills | Section 4; contrast in section 5 | release: *names the season picker, progress bar and medal pills* and the contrast test; unit: the value-text markup |
| C18: focus after a trade, linked validation, disabled Buy and List, bad prices, fixture Marketplace, My listings Refresh | Sections 2 and 3 | market: the five new tests; release: the names-and-links test; unit: the linked Buy reason |
| C19: focus to `<body>` | Section 2 | release: the journey, the expiry and account-switch tests; the market trade test. Each checks that `focusDrops` is empty. |
| C19: skip link bypassed by the first Tab | Section 1 | release: the journey and *reaches the skip link first… on every route* (also in production); the full-screen first-Tab test |
| C19: two "bout ended" definitions | Section 6 | unit: *ends a bout for the Arena card exactly when its replay offers the fight*; the Task 17 ring and card test, updated |
| C19: double-open history race | Section 7 | release: *opens a scene once when asked twice, so Back to camp returns at once* |
| C19: scene remount on a viewer change | Section 7 | release: *reads a replay scene once while the owner loads* (no timeline read while the owner read is held) |
| C19: stale-closure race after a refresh | Section 7 | None possible (see Concerns); the existing rejected-session tests pass |
| C19: "last known camp" wording | Unchanged (Decision 2) | — |
| C20: in-progress replay | Coverage | release: *shows an in-progress replay as not available yet until the fight ends* |
| C20: 360 px scene | Coverage | release: *fits every sheet at 360 px…* |
| C20: expiry and account switch | Section 2 | release: the two live-mode tests |
| C20: narrow pointer window | Coverage | release: *uses the touch layout in a narrow pointer window* (470 px, desktop) |
| C20: positive rewards line | Coverage | release: *tells only a fighter that the rewards are credited…* (a player sees it, a visitor does not) |
| C20 and Task 14 review item 6: the replay suite skips in production | Coverage | release: *shows an unavailable replay in the production build* (runs in the production gate) |
| Every control named | Already true; now pinned | release: `expectNamedControls` on the surfaces listed below |

What the broader tests cover:
- **The desktop keyboard journey:** every menu, the corner chip, the sign-in notice, a replay scene, a profile card and the skip link.
- **Reduced motion:** the camp, battle and expedition scenes report it; the rail, panel and scene animations are off; and nothing on the page is animating.
- **The 360 px check:** all 8 menus, a profile card, and the replay and expedition scenes.
- **`expectNamedControls`:** the rail, the corner chip, all 8 menus, an Arena card, a profile card, both scenes, the player forms, the creation dialog and the replay page.

## Tests: RED, then GREEN

**RED**, before any source change (private config, port 3300, both projects). `release.spec.ts`, `market.spec.ts` and `full-screen.spec.ts` gave **32 failed, 60 passed, 16 skipped**. The failures, by cause:
- **Skip link:**
  - the full-screen first-Tab test, the journey (a soft check) and *every route* failed: the first Tab focused the rail icon;
  - on mobile, Enter on the skip link left the focus on `<body>`.
- **Focus to `<body>`:** the journey's Dismiss check, and the expiry and account-switch tests, found the focus on `body`.
- **Trade focus:** the receipt was not focused.
- **Links:** `aria-invalid` was missing on the Build strength field and the creation name field; the Spear's Buy had no description.
- **Contrast:** field edges at 1.83:1 (Build, Schedule, the season picker), the roster filter at 1.67:1, the chosen merchant at 3.28:1.
- **C17:** no `aria-valuetext`.
- **Double open:** `history.length` grew by 2.
- **Remount:** the scene made 3 timeline reads.
  - Development StrictMode reads twice per mount, so the test now holds the owner read and expects no read before the viewer is known.
  - That version failed too: reads had already been made.
- **Setup mistakes in my own new tests** (fixed before GREEN; not product evidence):
  - two market tests counted the offers before adding listings;
  - the reduced-motion and contrast tests used a replay-fixture expedition that has no scene;
  - some contrast checks ran before the panel animations had settled.

A rerun of the adjusted tests gave 8 failures, all for the product reasons above. *refreshes My listings…* and *respects reduced motion…* then passed (coverage tests; no defect).

**Passed at RED** (coverage; no defect found): R2, the touch keyboard journey, the 360 px sheets and scenes, the in-progress replay, the positive rewards line, the narrow pointer window, the production unavailable replay (on the dev server) and the fixture Marketplace.

**Unit RED:**
- *ends a bout for the Arena card…* failed with "at 0 ms from the logged end: expected false to be true".
- The two markup tests failed against the stashed old `MarketPanel.tsx` and `StandingsPanel.tsx`; the stash was then restored.

**GREEN:** everything above passes (see Gates).

One finding while going GREEN: closing a scene with Escape closed it natively and dropped the focus. React's commit-time focus restore then put the focus on the camp instead of the opener. This is fixed in `SceneOverlay` (section 2).

## Gates, in the order of `docs/operations/verification-gates.md`

The private config's webServer env matched the repo `playwright.config.ts` env. Ports 3300 and 4173 were free before each browser run and after it.

1. `npm test`: **50 files, 1105 tests passed**.
2. `npm run typecheck`: clean (`tsc`, `deno check`, and the 2 Edge tests passed).
3. `node assets/source/build-assets.mjs --check`: assets up to date (28 files).
4. `npm run build`, then `npm run verify:static`: 5 fixed routes, 91 assets, clean.
5. **Development browser suite** (`npx playwright test --config node_modules/.cache/pw-replay.config.mjs`, port 3300): **489 passed, 27 skipped, 0 failed, 0 flaky** (8.5 min). Its dev server had exited before step 6.
   - An earlier full run also gave 489 passed. I made a comment-only edit to `useFocusRescue.ts` during it, so I discarded that run and reran steps 1–6 from the start.
6. **Isolated production gate:**
   - `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`: exit 0.
   - `npm run verify:static -- .next/browser-test`: 5 routes, 91 assets, clean.
   - `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test` (repo config, port 4173): **20 passed, 496 skipped, 0 failed**. That is the previous 16 plus the two new production tests on both projects.
   - The first production run failed *shows an unavailable replay…* on its "the timeline was asked for" check. This export has no usable Supabase client, so it reads nothing (a probe saw no Supabase request) and still shows the same unavailable state. That check now runs on the development server only.
7. `git diff --check` and `git diff --cached --check`: clean. `next dev` left `AGENTS.md` unchanged.

## Screenshots for the visual review

They are in `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\a11y-shots\`, named `a11y-<project>-<name>.png`, for both `desktop` and `mobile` unless marked.

**Visible changes:**
- `skip-link` (desktop): the skip link, shown on the first Tab.
- The new field edge (`--field-line`), with focused fields' rings: `form-my`, `form-schedule`, `form-inventory`, `form-market-sell`, `market-sell-valid`, `creation-dialog`, `season-picker-focus`, `roster-filter-focus`.
- `shops-merchants`: the chosen merchant, gold on dark.
- `market-receipt-focused`: the receipt focused after a keyboard purchase, with the browser's focus ring.

**States whose look is unchanged:** `art-failed-schedule`, `360-replay`, `360-expedition`, `narrow-pointer` (desktop), `replay-unavailable`, `replay-unavailable-production`.

No layout or wording changed; the only new copy is screen-reader text (`aria-valuetext`). A signed-in deep link to a scene shows the existing "Loading the replay…" until the owner has loaded.

## Self-review

**Checked:**
- **Scope:** no change to `GameViewport.tsx`, the database, packages or Edge.
- **Descriptions:** every new `aria-describedby` points to an element that is rendered in the same state. Ids come from `useId`, plus a listing or catalog id where those are already unique.
- **The focus rescue's cost:** it watches only `disabled`, `hidden`, `inert` and `open` changes and child lists, and returns at once unless the focus is on `<body>`.
- **Trade outcomes:** the outcome takes the focus only while the player's focus is in that panel or lost, never from elsewhere.
- **Escape on a scene:** it still closes the scene through the same `return-camp` path, so the history rules (Decision 4) and the existing scene tests hold.

**Fixed during self-review:**
- My first rescue moved the focus out of a closing scene to the camp, and React's commit restore then kept it there. The rescue now leaves dialogs that have closed alone, and the scene no longer closes natively on Escape.
- My first Shop change briefly merged the two reason lines into one. They are back as two paragraphs, so the layout is unchanged.
- A guard stops a second Back to camp, pressed before the first has landed, from going back past the camp.

**Not changed:** the static export logs 404s for the App Router's prefetch of `__next.*.txt` payloads (seen in the production probe). This was already the case and is outside this task.

## Concerns

1. **The single bout-end definition changes a Task 17 test's edge case.** Ring and card still change over together. When a stage publishes an end that differs from its log's, they now change at the logged end, which the replay already used and the server publishes as the stage's end.
   - The Task 15 test (a stage that runs to minute 80) is unchanged.
   - If the published end should win instead, the replay fixtures' bout stages (60–80 min) would have to be made server-shaped.
2. **The stale-closure fix after a session refresh (C19) is not test-proven.** A refresh restores the account it refreshed, so a browser test cannot change the account between the refresh and the owner read. The fix reads through the latest `loadOwner`. The rejected-session tests still pass, but they do not prove the race.
3. **Visible changes for Avi's approval:**
   - the skip link now shows on the first Tab in the camp;
   - the lighter field edges (`#7a86a0`);
   - the dark fill on the chosen merchant;
   - the browser's focus ring on a trade's receipt.

   All are contrast, focus or label changes within the brief's allowance; the screenshots are listed above.
4. **The contrast check composites translucent panels onto the camp's own colour (`#1c3f24`).** The real pixels behind a panel are the Phaser scene, which no computed style reads. A bright sprite behind a panel would be lighter than that backdrop.
5. **A proposed process note, for the controller to put to Avi** (not a skill change): `docs/operations/verification-gates.md` could add "do not edit source files while the development browser suite runs (Fast Refresh reloads the pages under test); after any edit, rerun the gate". I hit this once and reran the whole gate.
