# Task 23.10 report: shorter slot times (Lane B, UI only)

## Status

**DONE** (Lane B gates below). No database, SQL or Edge change.

Commits (branch `claude/task-23-time`, Cloudiator-replay, on `81a57d7`):
- `4a8b670` feat: show slot times briefly
- this report: docs: report Task 23.10

Approved by Avi on 2026-10-20: slot times printed `new Date(ms).toLocaleString()` (full date and seconds, for example
`10/10/2026, 4:20:00 AM`). Boundaries fall on whole minutes, so they now show briefly.

## What changed

**The rule (`src/features/schedule/slot-time.ts`).** `slotTimeText(ms, nowMs)`, in the viewer's locale and local time zone
(`Intl.DateTimeFormat(undefined, …)`, `hour: 'numeric', minute: '2-digit'`; never seconds). The day of `ms` is compared with
the day of `nowMs` by local calendar day (the local date's midnight in UTC, so whole days apart are exact through a
daylight-saving change), not by 24-hour differences:

| `ms` is | Shows | Example |
|---|---|---|
| the same local day as `nowMs` (earlier or later in it) | the time | `4:20 AM` |
| the next local day | `tomorrow` and the time ("tomorrow" stays English) | `tomorrow 4:20 AM` |
| the 2nd to the 6th local day ahead | short weekday and time | `Sat 4:20 AM` |
| the 7th day ahead or later, or on an earlier day | short month, day and time | `Oct 26, 4:20 AM` |

A past time on the same local day takes the first row (the order of the rule); only an earlier day is "in the past".

**The display time.** Every caller passes the clock its screen already uses; nothing calls `Date.now()`.
- `src/features/schedule/use-minute-now.ts` (new): `useMinuteNow(clock)`, the shared display clock's time to the minute. It
  checks once a second while the tab is visible and on clock freeze or move (as `SchedulePanel`'s own tick), and renders
  again only when the minute changes. The wording depends on the local day, so a line that said "tomorrow" must turn into
  the time at midnight; a time computed once would go stale.
- `SchedulePanel`: "Estimated next start" uses `slotTimeText(nextPhaseStart(…), nowMs)`. The saved message keeps the server's
  `effectiveAtMs` and the phase (`message` is `{ phase, effectiveAtMs } | null`, not text) and builds its words each render,
  so it also follows the clock.
- `BuildPanel` gets the shared `clock` (a new prop, passed by `CharacterPanel`, which already had it): "Effective …" for the
  pending build.
- `activity-status.ts`: `ownRestingText(restingUntilSlot, nowMs)` (`ownRestingText(null)` needs no time and takes none);
  `activityStatus` passes its own `nowMs`, which My gladiator ticks every second from the clock.
- `CampShell`: `ownPlace` (the owner's row and card in Gladiators) is built with `useMinuteNow(clock)`, so the line the
  Gladiators list and profile card show follows the clock too. `RosterPanel` and `ProfileCard` only display the string.

## Every `toLocaleString(` in `src`, and the other time displays

Changed:
- `src/features/schedule/slot-time.ts:5` (the old `slotTimeText`): replaced by the rule.
- `src/features/schedule/SchedulePanel.tsx:73` ("Effective … for … and future occurrences"): `slotTimeText`, against the clock.
- `src/features/schedule/SchedulePanel.tsx:102` ("Estimated next start", through `slotTimeText` already): now with `nowMs`.
- `src/features/build/BuildPanel.tsx:88` ("Effective …"): `slotTimeText`, against the clock.
- `src/features/character/activity-status.ts:14` (the resting line): now with `nowMs` (My gladiator, and the owner's own
  Gladiators row and profile card through `CampShell`'s `ownPlace`).

Left:
- `src/features/market/market-text.ts:29` `value.toLocaleString('en-US')`: a money amount with thousands separators, not a time.
- Other time displays do not use `toLocaleString` and are not slot-boundary times of this kind: the activity end
  `· ends HH:MM` in `CharacterPanel.tsx:21` and `ArenaPanel.tsx:50`, and `ExpeditionView.tsx:66–67`, `BattleReplay.tsx:45`
  (fixed `en` 2-digit time or medium date); the tournament, result and season texts (`tournament-text.ts`, `result-text.ts`,
  `season-text.ts`) are `en-GB` with an explicit zone and UTC beside it by design. Not part of the approved change; say if
  any should follow the same rule.

## Tests

Watched failing first for the right reason:
- `tests/domain/slot-time.test.ts` (new, 8 cases): the zone pinned to America/New_York through `process.env.TZ` (with a guard
  that it took effect; restored afterwards) and the locale to en-US through a spy on `Intl.DateTimeFormat` that supplies it
  only when the code names none (and a case that the code never names one). Same day (including 12:00 AM and 11:59 PM, and
  an earlier time on the same day), tomorrow across midnight (23:59 → 00:01, 23:00 → 01:00), the 2nd and the 6th day ahead at both
  ends of the day, the 7th day, a past day and a past month, seconds in the input never shown, and daylight-saving
  days (a 25-hour day where 24 hours later is still today; a 23-hour day where seven calendar days is under seven times 24
  hours). They failed on the old one-argument `toLocaleString()` output (`7/14/2026, 4:20:59 AM` and so on) and, once, on my
  own mistake (times built before the zone was set), fixed in the test.
- `tests/domain/activity-status.test.ts`, `character-panel.test.ts`: the resting line against the display time, including
  that a day or more ahead the wording is not the time alone; `profile-card.test.ts` and `roster-panel.test.ts` now use the
  new wording in their sample line.
- `tests/browser/slot-time.ts` (new): an oracle worked out in the page (its own locale and zone) apart from the code under test,
  using separate day arithmetic.
- `tests/browser/planning.spec.ts` (desktop and mobile): the pending build's "Effective …" and the saved
  "Effective … for morning and future occurrences." are the exact new text with no seconds or numeric date; the three
  estimated starts after the clock moves one slot; and a new case with the zone held to New York (en-US) and the clock frozen at
  22:00 and then 00:30: `10:40 PM`, `tomorrow 12:00 AM`, `tomorrow 1:20 AM`, then `1:20 AM`, `2:40 AM`, `4:00 AM`, written out literally.
- `tests/browser/resting.spec.ts`: the owner's line in the fixture preview and in live mode, against the fixture world's time.
  Both specs ran against the old source with the updated tests first (desktop project): 6 of the 11 cases failed with
  `10/10/2026, 4:20:00 AM`, `10/20/2026, 12:20:00 PM` and so on.

## Gates (Lane B, no database)

Run in the documented order (`docs/operations/verification-gates.md`), one after another in this worktree:

| Step | Result |
|---|---|
| `npm test` | 1,249 passed (65 files), 0 failed |
| `npm run typecheck` | passed (tsc, deno check, 2 Edge deno tests) |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, `npm run verify:static` | passed: 5 fixed routes, `connect-src 'self'`, no fixture preview data |
| Dev browser suite (private config, port 3300) | 541 passed, 35 skipped, 0 failed (11.0 min) |
| `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, `verify:static -- .next/browser-test` | passed (no test publishable key in the environment) |
| Production gate (`PLAYWRIGHT_STATIC=true`, port 4173) | 34 passed, 542 skipped, 0 failed |
| `git diff --check` | clean |

The counts moved as the new cases do: 8 new unit cases; the dev browser suite has 2 more (the new midnight case, desktop and
mobile), and the production gate skips those 2 (live UI with development-only transport), as it skips the rest of `planning.spec.ts`.

## Screenshots for Avi (360 x 740)

In the session scratchpad, `task-23.10-shots/` (desktop and mobile projects; the mobile ones are at the device's pixel ratio):
- `resting-*-owner-line-360.png`, `resting-*-own-gladiators-row-360.png`, `resting-*-own-profile-card-360.png`,
  `resting-*-gladiators-row-360.png`, `resting-*-profile-card-360.png`: the five resting shots from `resting.spec.ts`,
  regenerated; the owner's line reads `Resting at home: back on your schedule at 4:20 AM` (the fixture boundary in the
  test browser's zone).
- `planning-*-schedule-saved-360.png`: the Schedule panel with an "Estimated next start: 1:40 PM" and the saved
  "Effective 3:00 PM for morning and future occurrences." (the real clock, so the times differ on each run).
- `planning-*-schedule-tomorrow-360.png`: the "Estimated next start: tomorrow 12:00 AM" line (the clock held at 22:00 in New York).
- `planning-*-build-effective-360.png`: the Build panel's pending "Effective 12:20 PM" line.

The Schedule and Build panels' planning lines exist only in the live UI (the fixture preview shows "This preview cannot
change the build" and a sample schedule), so these three come from `planning.spec.ts`, whose transport is intercepted.

## Notes and concerns

- **A lone "AM" can wrap at 360 px.** In Chrome the space before AM or PM is an ordinary space, so a long line can break
  before it (the owner line in My gladiator reads `…schedule at 4:20` then `AM`). A no-break space in the time would stop it,
  but that changes the text and the literal tests; not done. Say if Avi wants it.
- **The shell renders once a minute.** `CampShell` (for the owner's resting line in Gladiators) uses `useMinuteNow`, which sets
  state at most once a minute; the camp scene is its own component. The browser suites passed with it.
- **The same-day rule includes earlier times of the day.** A boundary earlier today (for example after the clock is moved
  back) shows as a time alone; only an earlier calendar day shows month and day.
- **Browser expectations are worked out in the page.** The only race is a clock within a second of local midnight when a case
  reads it; the midnight case holds the zone and clock.
- **Skill upkeep.** Nothing reusable to change in a skill came out of this task.
