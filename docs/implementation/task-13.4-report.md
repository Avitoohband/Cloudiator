# Task 13.4 report: panels follow the shared clock and revision

Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-13`, base `52c697f`.
Commit: `c035491 feat: drive panels from the shared clock and revision` (not pushed).

## What was implemented

`src/features/schedule/SchedulePanel.tsx` (the Task 6 stale-clock gate)
- New `clock` prop: `SchedulePanel({ owner, gateway, refresh, clock })`.
- The panel keeps the shared clock's slot index. It updates it:
  - every second while the tab is visible;
  - on `clock.subscribe` (a hold or release);
  - on `visibilitychange`.
- Estimates are `nextPhaseStart(phase, slot * SLOT_MS)`. They move past a boundary, so no estimate is ever in the past. The mount-time `Date.now()` is gone.

`src/features/arena/StandingsPanel.tsx`; `standings-refresh.ts` deleted
- New props: `StandingsPanel({ reads, owner, clock, revision })`.
- The shown pages are re-read when `revision` changes from one non-null value to another. Nothing else re-reads them: no 1 s tick, no boundary or settle-window logic, no focus listener. On focus the sync controller reads the revision anyway.
- The owner's combat-strength profile read follows `revision` instead of the slot.
- `clock` is accepted to match the interface, but unused: standings follow the revision only.
- `readNextPage`, `readStandingsPages` and their types moved into the panel. `standings-refresh.ts` (with `standingsRefreshDue`) and `tests/domain/standings-refresh.test.ts` are deleted. The two page-reader tests moved unchanged into `tests/domain/arena-panels.test.ts`.

`src/game/tournament-stage.ts`
- `tournamentPreparing(id, nowMs, publishedSlotIndex)`: the same rule, with the parameter now named as a published slot.
- New pure `publishedSlotEstimate(revisionSlotIndex, processedSlotIndex)`. It returns the lower of the known values; anything that is not a nonnegative safe integer counts as unknown. See Concern 1.

`src/features/tournaments/TournamentPanel.tsx`
- New prop `revisionSlotIndex: number | null`, passed down to the card.
- New exports:
  - `readTournamentCard(reads, id)`, which never throws: `{view}`, or `not-found` / `unavailable`;
  - `TournamentCardNotice`, the card's notice for a failed read: being prepared, not found or unavailable. The card itself renders it.
- R2:
  - `refreshOwner` and "preparing" live in refs. The retry interval depends only on `[failure, view, read]`, so a new refresh function from the parent does not restart it.
  - While preparing, every re-read (the 30 s retry and focus) awaits the owner refresh before the tournament read.
- R3: "being prepared" uses `tournamentPreparing(id, now, publishedSlotEstimate(revisionSlotIndex, owner?.processedSlotIndex))`.
- Live id: `tournamentLookupIdOrNull(latestTournament(now).slotIndex, league)`.
  - The league is the owner's or, with no owner, the picked one.
  - A null id shows "No tournament matches this selection."
  - The old "Create a gladiator to follow…" line is gone.
- League picker: with no owner, in live mode, a `group` labelled "League" with Bronze, Silver, Gold and Champion buttons (`aria-pressed`). Bronze is the default. Styles are in `TournamentPanel.module.css`.
- The live id waits until the shared clock has the server's time (`synced()`) or is held (`frozen()`). Until then the card area says "Loading the tournament…".
  - The panel reads `now` and readiness together at each tick (`readClock`).
  - Without this, the first render after the sync used a stale wall-clock `now`, which read a different slot's tournament. A browser test caught it (see TDD).

`src/features/tournaments/tournament-text.ts`
- The unreachable "You advance. Your next result is being prepared." branch is removed. A waiting viewer who won every due round always has an undue round left; otherwise they are the champion, handled above.

`src/features/arena/ArenaPanel.tsx` and `src/app/game/page.tsx` (spectator mode)
- The page renders `ArenaPanel` for every viewer. Before, it rendered only when an owner was shown.
- With `owner: null`, "Your arena bout" stays hidden; cards open from the camp (`open-arena`) and the samples.
- A card the viewer does not own is rendered without the timeline's `summary`. It shows only public stages and the result: no Credited lines, even if a reader returned a summary (the fixture gateway does).
- The page passes `clock` to `SchedulePanel`, `revision={game.revision}` to `StandingsPanel` and `revisionSlotIndex={game.slotIndex}` to `TournamentPanel`. The layout is unchanged.

`src/features/character/useGameState.ts` (test plumbing)
- `window.__cloudiatorShell` gains `renewRefreshOwner()`, in fixture-enabled builds only. It gives `refreshOwner` a new identity, as a parent re-rendering with a new function would.
- The renewal count is 0 unless the hook is called. So in production `refreshOwner` is still `loadOwner` itself, and it adds no reads.

`tests/browser/live-routes.ts`: `setStandings(pages)` and `setTournaments(views)`.

## TDD evidence

RED, unit: `npx vitest run tests/domain/tournament-panel.test.ts tests/domain/arena-panels.test.ts`. Result: 4 failed, 36 passed.
- `estimates the published slot …`: `TypeError: publishedSlotEstimate is not a function`.
- `renders the card with a not-found gateway and a lagging processed slot` (R5): `TypeError: readTournamentCard is not a function`.
- The two moved `standings pages` tests: `readStandingsPages is not a function`, because the panel did not export it yet.

RED, browser: `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/planning.spec.ts tests/browser/arena.spec.ts tests/browser/tournament.spec.ts -g "<the 7 new titles>"`. Result: 14 failed, all 7 cases on desktop and mobile.
- `re-estimates the next start after a boundary passes…`: `toHaveText` failed; one estimate stayed at the old value, and the others matched.
- `re-reads standings when the revision changes, and not on its own timer`: `Expected: 2, Received: 3`. The old timer re-read after the boundary.
- `keeps the rows loaded with More when a new revision re-reads them`: `Expected: 5, Received: 3`. A revision change read nothing.
- `keeps one 30 s retry while preparing even when the owner refresh prop changes` (R2): `Expected: 3, Received: 2`. The renewed prop restarted the interval, so no retry came at 30 s.
- `shows "Tournament being prepared" for a gladiator created after the cutoff` (R3): the status was not found. The old code showed "No tournament matches".
- `lets a visitor pick a league…`: no `group "League"`.
- `opens a spectator Arena card from the camp without owner rewards`: no `region "Arena bouts"` for a visitor.

The R2 hook and the transport setters were added before the RED run, so each failure is a behaviour failure, not a missing hook.

GREEN
- Unit: both files, 40 of 40.
- First browser GREEN run: 13 of 14 passed. The visitor test on desktop failed: its id set held an extra `eq.tournament:373333:bronze`. That id came from the browser's wall clock before the shared clock synced.
  - First fix (the readiness gate only): both projects still showed the stray read, because of the stale `now` state.
  - Final fix: read `now` and readiness together. Then 14 of 14 passed.
- Named files in full (`planning`, `arena`, `tournament` specs): 120 passed, 1 skipped, 1 failed.
  - The failure was `arena.spec.ts:494` on mobile: `__cloudiatorArena` was undefined right after `openGame`.
  - Cause: the Arena section now mounts at the first render, so its heading can be visible before the hook's passive effect runs, and before the owner loads.
  - `openGame` now waits for the fixture owner's heading and the hook. Then `arena.spec.ts` passed 63 of 63, with 1 skipped (desktop-only).
- Extra characterization test: `follows the owner’s league after a promotion, from the owner read on a new revision`. It covers the plan's "lookup league after promotion" gate and passes on both projects. It would also pass before this change, because the 13.3 owner re-reads already provide the behaviour.

## Gate results

Order follows `verification-gates.md`. Builds and browser runs never overlapped.

| Gate | Result |
| --- | --- |
| `npm test` | 37 files, 938 tests passed. One file and 5 tests fewer than 13.3 (`standings-refresh.test.ts` deleted); 2 moved and 2 new unit tests. Rerun after the last test edit: same |
| `npm run typecheck` | exit 0 (tsc, deno check, 2 Deno tests); rerun at the end: exit 0 |
| `npm run test:db`, run 1 | 176 of 177. Edge `StartedAt` `2026-10-16T16:29:22.263696452Z` before and after (the run counts). The failure is `arena.test.ts:642`: `expected 120992 to be less than 120000` (cleared-window `publishedMs`) |
| `npm run test:db`, run 2 | 176 of 177, the same assertion: `120991`. `StartedAt` unchanged |
| That test alone (`-- tests/db/arena.test.ts -t "times consecutive"`) | passed. `StartedAt` unchanged |
| `npm run test:db`, run 3 (after the production gate, nothing else running) | 9 files, 177 of 177 passed. `StartedAt` `2026-10-16T16:29:22.263696452Z` before and after |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, then `npm run verify:static` | built with no warnings; "Static export verified: 5 fixed routes; 91 assets scanned; no forbidden backend material." |
| Full dev browser suite (`pw-claude.config.mjs`, port 3200) | 284 passed, 8 skipped. After the added promotion test, rerun in full: 286 passed, 8 skipped, 0 failed. Port 3200 was confirmed free afterwards |
| Isolated production gate | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`: exit 0, no warnings. `verify:static -- .next/browser-test`: 5 routes, 91 assets. Static Playwright run: 14 passed, 280 skipped |
| `git diff --cached --check` | clean |

About the `test:db` failure in runs 1 and 2:
- The test exercises only `supabase/`, `tests/db/` and `src/lib/`. `git diff --stat 52c697f -- supabase tests/db src/lib tests/fixtures scripts vitest.db.config.ts` is empty.
- In run 2 the boundary settled at 1 042 ms but prepared at 61 063 ms. So the pairing job waited a tick and the slot published at the next tick, as in the pre-existing "coordinator busy race" in `docs/implementation/task-19-report.md`. Task 23 owns that follow-up.
- The Edge container was recreated between my first check at task start (`16:03:06Z`) and the first DB run (`16:29:22Z`), while I was editing files in this worktree. This matches the recorded watcher observation. It did not change during any DB run.

## Files changed

- `src/app/game/page.tsx`
- `src/features/arena/ArenaPanel.tsx`
- `src/features/arena/StandingsPanel.tsx`
- `src/features/arena/standings-refresh.ts` (deleted)
- `src/features/character/useGameState.ts`
- `src/features/schedule/SchedulePanel.tsx`
- `src/features/tournaments/TournamentPanel.tsx`, `TournamentPanel.module.css`
- `src/features/tournaments/tournament-text.ts`
- `src/game/tournament-stage.ts`
- `tests/browser/arena.spec.ts`:
  - 3 timer tests removed: "re-reads standings after the slot boundary…", "keeps re-reading standings every 30 s for five minutes…" and "keeps the rows loaded with More when it re-reads after the boundary";
  - 1 spectator test and 2 live standings tests added;
  - `openGame` now waits for the owner and the hook.
- `tests/browser/live-routes.ts`, `planning.spec.ts`, `tournament.spec.ts`. The last gains 4 live tests: R2, R3, the visitor, and the promotion test.
- `tests/domain/arena-panels.test.ts`, `tournament-panel.test.ts`
- `tests/domain/standings-refresh.test.ts` (deleted)

## Concerns

1. **R3 deviates from the brief's literal rule, because the revision's slot is not a publication signal.**
   - `world_revision.slot_index` is `floor(statement_timestamp / 4 800 000)` (`supabase/sql/06-projections.sql:116-121`). It is the server's slot by time, at the last 30 s poll. It reaches the tournament slot at the cutoff, not at publication. The real slot-wide signal, `private.coordinator.published_slot`, is not client-readable.
   - So "revision slot < tournament slot" holds only until the first poll after the cutoff, at most 30 s. Used alone, it would show existing players "No tournament matches" for about 30–90 s of the 61–121 s window. Today they see "being prepared" for the whole window, because their processed slot lags.
   - I therefore used `min(revision slot, owner's processed slot)` (`publishedSlotEstimate`). The brief said "not the owner's processedSlotIndex". The R5 test pins the case: the revision slot is current, the processed slot lags, and the card shows "being prepared".
   - Remaining limit: a gladiator created after the cutoff, and every visitor, see "being prepared" only until the next poll. Then they see "No tournament matches" until publication.
   - A full fix needs a public published-slot field, for example on `world_revision`. That is a backend change for a later task.
2. **Test-only hook.** `__cloudiatorShell.renewRefreshOwner()` exists only because 13.3 already made `refreshOwner` stable, so the page alone can no longer change the prop. Without the hook, R2's "prop changes" half cannot be exercised end to end. The production code path is unchanged.
3. **Visitors still see the Registration section:** a disabled box, "Create a gladiator to register for tournaments." and the entry rules. The spec's visitor column says "Countdown and brackets". I left it for 13.6, the visitor-mode presentation, to avoid adding or removing chrome here.
4. **"No owner" also covers a signed-in player with no gladiator, and the moment before the owner loads.** These viewers see the league picker. The panel is keyed by gladiator id, so it remounts with the owner's league once the owner loads.
5. **Focus while preparing reads the owner twice:** once from `useGameState`'s focus refresh, and once from the card's owner-first re-read. This costs one small read, only during the at most 2 minutes of preparation.
6. **`ArenaCard` still calls `clock.sync(timeline.serverNowMs)`** after each timeline read. It is forward-only, like the `GameViewport` minor deferred in 13.3. I left it unchanged: removing it was outside the spectator scope.
7. **`StandingsPanel` lost its own focus re-read.** On focus the sync reads the revision, and a changed revision re-reads the standings. A failed read still offers "Try again".
8. **The DB cadence test failed in two of three full runs** on the known coordinator busy race. The third full run passed 177 of 177, as did the test alone. No backend file changed.


## Fix round 1 (review I1 and M1)

Commit: `d9a0d27 fix: hold "being prepared" for five minutes and report a failed sync` (new commit on `c035491`, no amend, not pushed).

### I1, R3: a time bound for "Tournament being prepared"

Fixed per the controller ruling.
- `src/game/tournament-stage.ts`:
  - New `TOURNAMENT_PREPARE_GRACE_MS = 300_000`.
  - `tournamentPreparing(id, nowMs, processedSlotIndex)` is true when:
    - the display time is inside the tournament's slot, and
    - either `now − slotStart < TOURNAMENT_PREPARE_GRACE_MS`, or the owner's processed slot is non-null and below the tournament's slot.
  - So every viewer (visitor, new gladiator, player) reads "Tournament being prepared" for 300 s after the cutoff. After that, only a lagging owner slot still does. Otherwise the panel shows "No tournament matches this selection."
- `publishedSlotEstimate` is removed, along with the `revisionSlotIndex` prop of `TournamentPanel`, `TournamentCard` and `TournamentCardNotice`.
  - The revision's slot is the slot by time. It is behind the tournament's slot for at most 30 s after the cutoff, which is inside the grace, so it adds nothing.
  - Nothing else used it.
  - `TournamentCardNotice` now takes `{ id, failure, now, processedSlotIndex }`.
  - The page no longer passes `game.slotIndex`.
  - This departs from the brief's interface (`revisionSlotIndex`, `publishedSlotIndex`), as the ruling allows. 13.5 should not pass `revisionSlotIndex`.
- The R2 behaviour is unchanged: the owner refresh is kept in a ref, and is awaited before each re-read while preparing.
- The local `window` variable in `tournamentPreparing` is named `running`, because `tournament-stage.test.ts`'s purity check rejects `window.` in that file.

### M1: no endless "Loading the tournament…"

- `TournamentPanel` gains `syncError: 'unavailable' | 'unauthenticated' | null`. The page passes `game.syncError`.
- Live order:
  1. No reader: "Tournament brackets cannot be shown in this build yet."
  2. No id yet, clock not ready, sync error: "Tournament brackets cannot be loaded right now. Only revealed results are ever shown."
  3. No id yet, clock not ready, no error: "Loading the tournament…".
  4. Clock ready, no valid id: "No tournament matches this selection."
  5. Otherwise: the card.
- Fixture order is unchanged: no selection gives "Choose a sample tournament…", then the no-reader check, then the card.
- The clock-readiness gate is kept. Once the clock is synced, a later failed revision read does not hide the card; the card handles its own read failures.

### Tests, written first

- `tests/domain/tournament-panel.test.ts`:
  - `treats a missing view as being prepared for five minutes after the cutoff, for every viewer`:
    - the constant is 300 000;
    - "being prepared" holds at the cutoff, +1 min and +299.999 s for a visitor (`null`), a new gladiator (`slot`) and a lagging player (`slot − 1`);
    - at +300 s only the lagging player is still preparing, and stays so to +80 min − 1 ms;
    - never before the cutoff, after the slot, for another slot or for a malformed id.
  - `renders the card with a not-found gateway and a lagging processed slot`, rewritten:
    - a lagging player at +6 min sees "being prepared", and a published one sees "No tournament matches";
    - a visitor and a new gladiator see "being prepared" at +1 min, and "No tournament matches this selection." at +300 s and +360 s;
    - this replaces the old line 311 assertion.
  - The `publishedSlotEstimate` test is removed.
  - New SSR describe `the live Tournaments panel before the shared clock has the server’s time (Task 13.4 review M1)`, rendering `TournamentPanel` itself with an unsynced clock:
    - no reader gives "cannot be shown in this build yet", with or without a sync error;
    - `syncError` `unavailable` or `unauthenticated` gives "cannot be loaded right now";
    - no error gives "Loading the tournament…";
    - a synced clock with a sync error renders the card.
- `tests/browser/tournament.spec.ts`:
  - The R3 test is rewritten as two tests:
    - `shows "Tournament being prepared" for a gladiator created after the cutoff, for five minutes` (signed in, processed slot = the tournament's);
    - `shows a visitor "Tournament being prepared" for five minutes after the cutoff` (also checks the league picker and that every read is anonymous).
  - Both run the server's time on from 40 s after the cutoff, and advance it together with the page clock. Every revision read reports the tournament's slot; the test asserts `floor(serverNowMs / SLOT_MS)` is that slot and that more revision polls happened after the cutoff. The tests assert:
    - "being prepared" at +120 s and +290 s;
    - "No tournament matches this selection." at +302 s.
  - New: `says brackets cannot be loaded when the world revision cannot be read`. It uses `live.fail('world_revision')` and asserts:
    - the panel shows "cannot be loaded right now", and never "Loading the tournament";
    - no tournament read happens.

RED, against `c035491` with only the tests changed:
- `npx vitest run tests/domain/tournament-panel.test.ts tests/domain/tournament-stage.test.ts`: 4 failed, 43 passed.
  - `expected undefined to be 300000` (the constant was missing).
  - `null at +1 min: expected ' No tournament matches this selection…' to contain 'Tournament being prepared'`.
  - The two M1 SSR cases: the panel showed "Loading the tournament…" instead of "cannot be shown in this build yet" or "cannot be loaded right now".
- `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/tournament.spec.ts -g "for five minutes|cannot be loaded when the world revision"`: 6 failed (3 tests × desktop and mobile).
  - Both R3 variants failed at their first assertion (line 500): `expect(preparing).toBeVisible()`, element not found. The old rule gave "No tournament matches" once the revision named the slot.
  - The M1 test failed at line 536: the "cannot be loaded right now" status was not found; the old code showed "Loading the tournament…".

GREEN
- First implementation run: 1 unit failure, the purity check on the local name `window`. After the rename, both unit files passed 47 of 47.

### Covering runs

| Command | Result |
| --- | --- |
| `npx vitest run tests/domain/tournament-panel.test.ts tests/domain/tournament-stage.test.ts` | 2 files, 47 passed |
| `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/tournament.spec.ts` (both projects) | 56 passed |
| `npm test` | 37 files, 939 passed. Versus 938: −1 `publishedSlotEstimate` test, +2 M1 SSR tests |
| Full dev browser suite (`pw-claude.config.mjs`, port 3200) | 290 passed, 8 skipped, 0 failed |
| `npm run typecheck` | exit 0 |
| `git diff --cached --check` | clean |

No build ran during the browser runs. As directed, no build, production gate or `test:db` was run this round. No backend, SQL or Edge file changed.

### Files changed in this round

- `src/game/tournament-stage.ts`
- `src/features/tournaments/TournamentPanel.tsx`
- `src/app/game/page.tsx`
- `tests/domain/tournament-panel.test.ts`
- `tests/browser/tournament.spec.ts`

### Concerns after this round

- The earlier R3 concern (Concern 1) is superseded by the time bound. Remaining limit: if phase 8 publishes later than 300 s after the cutoff, a visitor or a new gladiator sees "No tournament matches" until the next 30 s retry reads the view. A lagging player still sees "being prepared".
- The brief's interface names (`revisionSlotIndex`, `publishedSlotIndex`) no longer exist; 13.5 consumes `syncError` instead.
- Concerns 2–8 above are unchanged.
