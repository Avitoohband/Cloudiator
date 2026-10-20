# Task 24.0b report: short end times and the market pointer flake (Lane B, UI only)

## Status

**DONE** (Lane B gates below). No database, SQL or Edge change.

Commits (branch `claude/task-24-ui`, Cloudiator-replay, on `b1fd34e`):
- `cbf1f89` feat: show activity end times briefly
- `950a59b` test: make the market pointer-trade spec deterministic
- this report: docs: report Task 24.0b

## Checkpoint 1: "· ends 04:20 AM" in the short slot-time style

Approved by Avi on 2026-10-20 (plan question 14: "move 'ends' to the shared `slotTimeText`").

**Changed call sites.**
- `src/features/character/CharacterPanel.tsx` (My gladiator): the fixed `'en'` two-digit `time()` helper (was :21) is gone.
  The activity line reads `{label} · ends {slotTimeText(status.endsAtMs, now)}`. `now` is the panel's existing display clock
  (`useNow(clock)`, the shared clock read every second and on freeze or move); no new `Date.now()`.
- `src/features/arena/ArenaPanel.tsx` (the Arena card): its `time()` helper (was :50) had one use, and it is not an "ends"
  time: the warm-up line's reveal time, "until the bout is revealed at minute 60 (04:20 AM)". It now uses
  `slotTimeText(startMs + ARENA_REVEAL_MS, state.displayNowMs)`, the card's own display time (`renderArenaStage` of the
  card's `now`, from the shared clock).
- `src/features/schedule/slot-time.ts`: the doc comment lists the two new callers.

**Empty case.** A time `slotTimeText` cannot show (not a finite number gives `''`) leaves the suffix out: My gladiator shows
`In progress`, never `In progress · ends `; the Arena line drops the brackets. Before, the fixed formatter threw a
`RangeError` (`Invalid time value`) on such a time during render (the new unit tests showed it).

**Left unchanged (reported).**
- `src/features/character/ExpeditionView.tsx:66` `clockTime`: the same fixed `'en'` two-digit form, for each stage's start in
  the expedition scene's stage list. Not on My gladiator or the Arena panel, and a stage start rather than a slot boundary;
  outside the approved change.
- `ExpeditionView.tsx:67` and `BattleReplay.tsx:45` `day()`: dates (`dateStyle: 'medium'`) for replay retention, not times.
- `result-text.ts`, `tournament-text.ts`, `season-text.ts`: `en-GB` 24-hour times with an explicit time zone (local and UTC)
  by design; not activity end times.

**Tests (TDD).** No existing test asserted the old `ends 04:20 AM` form (none found by search), so none needed updating.
- Units (watched fail, then pass): `tests/domain/character-panel.test.ts` "ends the activity line with its end time in the short
  slot-time style" (In progress, and Scheduled two days ahead, which must name the weekday) and "leaves '· ends' out when the
  end time cannot be shown" (NaN, Infinity); `tests/domain/arena-panels.test.ts` "shows the warm-up reveal time in the short
  slot-time style, or leaves it out when it cannot be shown". RED: `ends 04:20 AM` and `(02:40 AM)` received, and
  `RangeError: Invalid time value` for the non-finite cases.
- Browser (dev, fixture preview; skipped in production, which has no fixture preview): `shell.spec.ts` "My gladiator ends its
  activity line with a short end time, on one line at 360 px" and `arena.spec.ts` "shows the warm-up reveal time short, on
  one line at 360 px". Each checks the exact text against `slotTime()` and runs `expectTimeOnOneLine` (23.10) at 360 px.
  RED against the old source (stashed): `In progress · ends 04:20 AM` and `(02:40 AM)` received; GREEN on both projects.

**Screenshots (360 x 740, for Avi's review)** in the session scratchpad folder `task-24.0b-shots/` (outside the repository):
`ends-mobile-my-gladiator-360.png` ("In progress · ends 4:20 AM"), `ends-mobile-arena-reveal-360.png` ("revealed at minute
60 (2:40 AM)"), and the desktop-project copies `ends-desktop-…-360.png`.

## Checkpoint 2: root cause of the mobile market flake (Decision 10)

`tests/browser/market.spec.ts` [mobile] "leaves the focus and the scroll where they are after a pointer trade" (`:463/464`,
three failures under full-suite load before this task, never alone).

**Root cause (observed).** On a phone the menu is a bottom sheet that rises into place when it opens
(`shell.module.css`: `.surface { animation: rise 0.2s ease }`, from `translateY(40%)`, about 208 CSS px on a Pixel 7). The
spec read the Axe Buy button's `boundingBox()` while the sheet could still be rising, then sent `page.mouse.click` at that
point. Whenever the sheet moved more than half the button's 36 px height between the two, the click landed below the button.
The row list does not re-render in that window: the leading hypothesis is not supported.

**Evidence.**
1. The kept fix-wave trace (`[mobile] market.spec.ts:464`, run 1 of the Task 23 fix wave): the click at (375.6, 779.7)
   was sent 52 ms after the Marketplace dialog became visible. Its screencast frames show the sheet still rising at the click:
   its handle is at y 506 in the frame of the click and settles at y 430, so the sheet moved another 76 CSS px up after it.
   No confirmation opened.
2. Reproduction before the fix: **6 of 40 failed** (mobile, `--repeat-each=40 --workers=8`, with a 32-thread CPU burner on
   the 32-logical-processor host), each "Confirm purchase" not visible.
3. Instrumented run (not committed; it recorded the sheet's animations, the button's top at measurement and at
   `pointerdown`, and the `pointerdown` target): 40 of 40 passed (the extra round trips moved the timing), but in **4 of 40**
   the sheet's `rise` was still running when the box was read (current time 112 to 200 ms). In two, the button moved 9 and
   8 px between the box and the press (top 695 then 686, 690 then 682; settled at 681 in every run). The press target was
   the Axe Buy in all 40, and the list had all 7 rows before the measurement in every run.
4. The new assertion without the wait (RED, same load): **6 of 40 failed**; 3 at the new check, where the element at the
   click point was the Axe row's own `<li>` beside its Buy button, and 3 at the click, which missed after the check passed.
5. Why only [mobile]: on desktop the menu's opening animation (`pop`) is a horizontal 8 px shift, which cannot move the point
   off the button.

The other recorded failure ("the purchased row still listed 5 s after 'Purchase confirmed'", `:463`) fits the same cause with
a box read earlier in the rise: the point then falls on the next row's Buy (Heavy boots), which is bought instead. That is
inferred, not observed (its trace was not kept); the new dialog check now fails that case before it confirms.

**The app is not wrong.** The rise is intentional, and a person aims at a button they can see; no product change.

**Fix (in the test).** Before measuring, the spec waits for the sheet's animations to finish
(`market.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)))`, as the spec's 360 px test already does). It
then asserts that `document.elementFromPoint` at the click point is the Axe Buy button (or inside it), clicks, and asserts
that the confirmation says "Buy Axe (Level 5 · Common) from Severus for 90 money?" before confirming.

**After the fix.** **40 of 40 passed** under the same load (8 workers, 32-thread burner). A second run at 12 workers and 48
repeats passed 36; its 12 failures were all in the first wave of 12 simultaneous cold page loads (the owner chip not shown
within 45 s, or `page.goto` timing out), none of which reached the click: the cold development compile overloaded, not this
race. So 76 of 76 runs that reached the click passed. The whole market spec passed 32 of 32 on both projects unloaded.

## Verification (Lane B gate order)

Run at `950a59b`, one step after another in this worktree (no edits during a browser run):

| Step | Result |
|---|---|
| `npm test` | 1257 passed (65 files; 1254 before, +3 new) |
| `npm run typecheck` | clean (exit 0) |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, `npm run verify:static` | clean: 5 fixed routes, `_headers` as generated, no forbidden material |
| Development suite (`pw-replay.config.mjs`, port 3300, 2 workers) | **545 passed, 0 failed, 35 skipped** (11.1 min; 541 at the Task 23 gate of record, +4 new cases) |
| Isolated production build (`CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true`, no test publishable key), `verify:static -- .next/browser-test` | clean |
| Production gate (`PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test`, repo config, port 4173) | **34 passed, 0 failed, 546 skipped** (the 4 new cases are development-only) |
| `git diff --check` | clean |

No host fault was seen, and nothing listened on Lane A's port 3200 when the runs started. The loaded reproductions above ran
a 32-thread CPU burner (a bounded scratchpad script) beside the development server; no gate step ran under it.

## Concerns

- The 12-worker loaded run's first-wave setup timeouts are a development-server cold-start limit under extreme CPU load, not
  product evidence; the gate's own worker counts are unchanged.
- `ExpeditionView`'s stage start times still use the fixed two-digit form (left, above); moving them would be a separate
  visible change for Avi.
- The suite's other `page.mouse.click` calls (arena, camp, full-screen, management specs) aim at the camp canvas, not into a rising
  sheet; none was changed.
- The Arena card's reveal time now shows the day wording too (for example `tomorrow 12:00 AM` for a slot that crosses local
  midnight), as every slot time does.
