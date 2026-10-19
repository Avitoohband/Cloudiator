# Task 22.5 report: expired replays in the game

Branch `claude/task-22-client` in `C:\Avi\Studies\Projects\Cloudiator-replay`, from `074dcf3`. Brief:
`.superpowers/sdd/2026-10-18-task-22-retention-operations/task-22.5-brief.md`, read from the main worktree.

Commits:
- `b343209` feat: show when replays are no longer kept
- this report: docs: report Task 22.5

A first run was interrupted by a host reboot before any file changed. This run started again from Step 1 at `074dcf3`. The
worktree was clean, and nothing was listening on 3300 or 4173, so there was no stale run to stop.

## What was implemented

### One helper, server time only (Decision 10)

`src/lib/replay-retention.ts` provides three pure functions:
- `replayKept(expiry, serverNowMs)`: true when the expiry state is `available` and `expiresAtMs > serverNowMs`.
- `tournamentReplayKept(endsAtMs, serverNowMs)`: true when `serverNowMs < endsAtMs + RULES_V1.retention.replayMs`.
- `tournamentEndsAtMs(id)`: the end of a tournament's slot, read from a tournament id or a bout id; null when the id is
  malformed. This is what lets an old link be judged without reading its view.

Every caller passes the server's time, never `Date.now()`. The time comes from either:
- a read's `serverNowMs` (the timeline, or the revision read inside `readTournamentLog`); or
- the shared `DisplayClock`, used only once it is synced or held.

The client compares the expiry with the server's time instead of trusting the stored state. Between an expiry and the next
hourly cleanup, the server still holds the log and the summary still says `available`. Because of the time comparison, the
client agrees with the server both before and after cleanup.

### Where it is used

**Recent results** (`result-text.ts`, `ResultsPanel.tsx`, `CampShell.tsx`):
- The panel has one plain line under the eyebrow: "Detailed replays are kept for 7 days. Results and credited rewards stay
  here for 90 days."
- `resultLine(row, serverNowMs)` decides with `replayKept`. Past its expiry, a row says "· replay no longer kept" and has no
  Replay button.
- The panel reads the shared clock (`useServerTime`). It re-reads the clock when the clock is held or released, at the next
  listed expiry (checked at least once a minute), and every second until the clock has the server's time.
- Until the clock has the server's time, rows show without a Replay button and without "no longer kept". This avoids an
  endless "Loading" if the revision can never be read.

**Arena and expedition replays** (`replay.ts`):
- `replayViewOf` decides at the timeline's `serverNowMs`.
- An owner's summary past its expiry gives the saved outcome ("The animation for this fight is no longer kept…"). This holds
  even while the log is still held, and after the stages were pruned (`expired`, never `missing`).
- A spectator whose completion is past its expiry sees "This replay is no longer kept", never "not available yet".

**BattleReplay**:
- A loaded replay keeps playing.
- The "This replay is kept until …" note follows the display clock. `useReplayTime` also wakes up at the expiry.

**Arena card** (`arena-stage.ts:148`):
- `replayExpired` is decided by display time.
- It reads the owner's summary, or, for any viewer, the settled public completion.
- Spectators now get the existing "The detailed replay is no longer kept; the saved result remains." line, with no Watch
  replay.

**Expeditions** (`expedition-stage.ts`, `ExpeditionView.tsx`):
- The state gains `replayExpired`, from the settled summary or completion at display time. Encounter replay links follow it.
- The Result note says "Encounter replays are no longer kept…" once the replay has expired by time.
- A spectator's Result card gains "Encounter replays are no longer kept; the result stays in the recent results."
- After cleanup there is no stage left. The view used to say "This expedition is not available yet". It now shows the
  existing `ExpeditionUnavailable` card with reason `expired`:
  - title "This expedition’s replays are no longer kept";
  - for the owner, the saved verdict, the credited rewards, and "Detailed replays are kept for seven days; the result and
    the credited rewards stay in your history for 90 days.";
  - for a spectator, "Detailed replays are kept for seven days. The result stays in the recent results."

**Tournaments** (`TournamentPanel.tsx`):
- Once `tournamentReplayKept(endsAtMs, displayNowMs)` is false:
  - each decided bout says "Replay no longer kept" instead of Watch replay;
  - the round panel adds one line: "These bout replays are no longer kept. Detailed replays are kept for seven days; the
    results stay.";
  - no log is requested.
- A watched replay whose log is not loaded says "This replay is no longer kept. Detailed replays are kept for seven days.
  The result stays in the recent results." This covers a `not-found` log read after that time. Before that time, a failed
  read still says "cannot be loaded right now".
- `TournamentCardNotice` maps a `not-found` read to "This tournament is no longer kept" once the slot carried by the
  tournament id is seven days or more past its end. An `unavailable` read stays a load error.

**Reads** (`reads.ts`):
- `POLLED_RESULT` adds `fight:result->fight`. `polledResult` prefers the compacted summary and copies only its three fields.
  It falls back to the log path for uncompacted rows.
- `readTournamentLog` returns `not-found` once the tournament is seven days or more past its end, by the sampled server
  time. It does so without querying `tournament_bout_results`, whether or not cleanup has compacted the log yet.

### Fixtures

All fixture data runs in fixture mode:
- **`tests/fixtures/replay-ids.ts` and `battles.ts`:**
  - `lastDay`: the PvP log, in the slot 126 slots (7 days) ago. Kept until the end of the current slot, which is fixture
    `now + 40 min`.
  - `lapsed`: the NPC log, one slot older. Its expiry passed at `now − 40 min`, but its summary still says `available` and
    its log is still held, as before cleanup.
  - `cleared`: an expedition nine days old, after cleanup. It has no stages and an expired summary with its rewards.
  - All three appear in Recent results and the sample replays. The existing 26 and 23 September tournament results also now
    read "no longer kept" at fixture time: they say `available` but are 9 and 12 days past their expiry.
- **Engine-generated `aged` tournament** (`tournament-ids.ts`, `tournament-build.ts`, `tournament-fixtures.test.ts`,
  `tournaments/aged.json`):
  - Silver league, 16 Sep, 4 entrants (Aster is not one), projected ten days after its start.
  - `projectTournament` now models the view after cleanup once `asOf ≥ settles + 7 days`: each fought result carries
    `fight` instead of `battleLog`, and the completions say `expired`.
  - It was regenerated with `UPDATE_TOURNAMENT_FIXTURES=1`. Only `aged.json` is new; every other fixture JSON is
    byte-identical.
  - The fixture test records its seeds and checks the compaction.
- **`tests/browser/live-routes.ts`** (needed by a live test): a stored bout result is now kept in the shape cleanup leaves.
  Before, a `fight` without a log was turned into a fake `battleLog`, which hid whether the read selects `result->fight`.
  No existing live test used that shape.

## Tests: RED then GREEN

**Step 1 RED (unit).** I ran the 7 named files before any implementation: 15 failed, 114 passed, and
`replay-retention.test.ts` could not import the helper. The failures were:
- the `reads` select list and log expiry;
- the arena and expedition expiry by time;
- `replayViewOf` for the owner and the spectator;
- the result lines, the fixture rows, the retention line and the unsynced clock;
- the four tournament cases (time-based Watch replay, the aged fixture, the replay text after expiry, the old-link notice).

**RED (browser).** `tests/browser/retention.spec.ts` first failed to load because the fixture was missing. With the fixtures
added and the UI unchanged, all 14 runs (7 tests × desktop and mobile) failed on missing behavior:
- no retention line;
- no saved outcome for `lapsed`;
- the lapsed row still offering Replay at expiry;
- no "no longer kept" note or notice;
- no fight summary from compacted bouts in the live read, which proves the `fight:result->fight` select is needed.

**GREEN.** The named unit files pass: 133 tests (the unsynced-clock case was rewritten later and kept the same count). The
retention spec passes 14 of 14, within the full runs below.

The new tests, by brief name:
- `tests/domain/replay-retention.test.ts`: the brief's three `replayKept` cases (999 kept, 1000 not, `expired` never), the
  tournament boundary at exactly 7 days, and `tournamentEndsAtMs` with malformed ids.
- **"explains retention in Recent results and offers no replay once a result is older than seven days"**: fixture Results.
  Checks the exact line, the lapsed row and the two old tournament rows ("no longer kept", no button), and that the last-day
  row still offers Replay.
- **"shows the saved summary with "no longer kept" for an expired Arena and expedition replay"**:
  - the lapsed bout's saved outcome on `/replay/`;
  - the cleaned-up expedition on `/expedition/` and as a camp scene.
- **"says a tournament replay is no longer kept after seven days and when its log was pruned"**:
  - the aged sample: fight summaries, placements, no Watch replay;
  - held a minute before expiry: the final's Watch replay; its compacted log fails as "cannot be loaded right now";
  - at expiry: the same text becomes "no longer kept", and still exactly one log read.
- **"keeps offering a replay until its expiry by server time"**: the shared clock is held a minute before the last-day expiry,
  Replay is offered and plays; at the expiry the same row says "no longer kept" without a new read.
- Live (development only):
  - "decides by the server time of the read, before and after cleanup": a visitor's bout before cleanup and after pruning;
    a pruned expedition; an uncleaned expedition, whose replay links disappear and whose spectator note appears; and Recent
    results;
  - "shows a compacted tournament’s fight summaries and says an old tournament link is no longer kept".
- "fits the retention line and the expired rows of Recent results" at 360 px.
- Unit additions in `results-panel`, `replay`, `arena-stage`, `expedition-stage`, `tournament-panel`, `reads` and
  `tournament-fixtures`.

## Gate (verification-gates.md order, final code)

The first full development run exposed one test-order consequence of the new fixture. `tournament.spec.ts` "works by keyboard
alone" tabs past the sample buttons after `pair`, and `aged` adds one (3 → 4 Tab presses; the comment now says so). In the
same pass I removed the "Loading until synced" state from Recent results. The whole gate was then rerun in order:

1. `npm test`: 48 files, **1073 passed**. `npm run typecheck`: tsc, deno check and deno test (2 passed), exit 0.
2. `node assets/source/build-assets.mjs --check`: assets up to date (28 files).
3. `npm run build`: exit 0. `npm run verify:static`: 5 fixed routes, 90 assets, no forbidden material, no fixture data.
4. Development browser suite, private `node_modules/.cache/pw-replay.config.mjs` on port 3300. Its webServer env was checked
   against the repo `playwright.config.ts` and matched, so it was left unchanged. Result: **444 passed, 22 skipped, 0
   failed** (8.0 min). The dev server exited before step 5.
5. Isolated production gate:
   - `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`: exit 0;
   - `npm run verify:static -- .next/browser-test`: verified;
   - `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test` with the repo config on port
     4173 (free immediately before): **16 passed, 450 skipped, 0 failed**.
6. `git diff --check` (new files included with `git add -N`): clean.

No database, Edge or Docker step was needed or run.

## Screenshots

Saved in `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\retention-shots\`,
each for desktop and mobile:
- `retention-results-top-*`: the Recent results panel with the retention line.
- `retention-results-expired-*`: the expired rows (the lapsed bout, the 9- and 12-day-old results).
- `retention-arena-replay-*`: the lapsed Arena bout's saved outcome with "no longer kept" and its credited rewards.
- `retention-expedition-*`: the cleaned-up expedition's saved outcome card.
- `retention-tournament-*`: the 16 Sep tournament older than 7 days: fight summary, "Replay no longer kept", the explanation
  line and the placements.
- `retention-tournament-replay-gone-*`: a watched bout whose log was pruned, after the expiry.
- `retention-phone-results-top-*` and `retention-phone-results-expired-*`: the 360 px phone view.

## Self-review

- Every listed place uses the helper. Nothing calls `Date.now()`. `DisplayClock` is consulted only when it is synced or held.
- A replay already loaded keeps playing past its expiry, in BattleReplay and in the tournament panel. Only offers, notes and
  new log reads follow the clock, so a viewer is never cut off mid-fight.
- The `fight` select copies only `durationMs`, `victoryReason` and `tieBreakReason`. A unit test proves that an extra field in
  the compacted JSON does not cross.
- Copy reuses the existing BattleReplay and ExpeditionView sentences. The only new sentences are the Recent results line
  (verbatim from the brief), the short "Replay no longer kept" bout label, the round-panel explanation and the old-link
  notice.
- No new CSS or layout. The expedition card reuses its existing classes. The verdict is a `<strong>` so that the card's muted
  paragraph colour does not override it.

## Concerns

- **90-day boundary:** activity ids carry no time. After 90 days a deleted activity still reads as "not available yet" on
  `/replay/` and `/expedition/`. Tournament ids carry their slot, so only tournaments get the old-link notice.
- **Notice threshold:** following the controller, a missing tournament reads "no longer kept" from seven days after its end.
  Between 7 and 90 days a missing view really means "no tournament in that league". The notice text is written to be true in
  both cases.
- **Fixture panel and stored state:** the fixture gateway has no clock and keeps serving logs for held samples, which are
  shown at their projection time. Because of this, the `completed` and `pair` samples still replay at their own time, although
  Recent results (at fixture time) calls their results no longer kept.
- **Fixture realism:** `lastDay` reuses the PvP log with `ratingDelta: 0`; a real PvP bout would carry a rating change. This
  is cosmetic and asserted nowhere.
- **Proposed process note, not applied:** element screenshots taken inside the scrolling menu surface captured the wrong
  region. A page screenshot after `scrollIntoViewIfNeeded` and the animations settling works. This could go into the
  browser-testing guidance if the controller wants it.
