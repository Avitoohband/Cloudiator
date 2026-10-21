# Task 24.0c report: CI leaves out render-bound browser tests; short expedition stage times (Lane B)

## Status

**DONE** (Lane B gates below, with one unrelated failure in the exclusion run, reported under "Concerns"). No database, SQL
or Edge change. Nothing pushed, and no GitHub Actions run triggered.

Commits (branch `claude/task-24-ui`, Cloudiator-replay, on `c96b660`):
- `aca99c4` ci: exclude render-bound browser tests on GPU-less runners
- `10a5e76` feat: show expedition stage times briefly
- this report: docs: report Task 24.0c

A host restart interrupted the work once (2026-10-20), while the first full development run was in progress. That run was
killed part-way. It is discarded as an interruption, not evidence. Every result below comes from runs on the committed
`10a5e76` after the restart.

## Part 1: CI leaves out the render-bound browser tests (the controller's ruling, 2026-10-20)

**The first run.** Run 39452911203 is recorded in `docs/operations/release-evidence.md` ("The first CI run and the CI render
exception"). Only the development browser step failed: 51 failed, 490 passed and 35 skipped in 63 min 49 s. 48 of the 51
were test timeouts while the camp or a scene rendered (46 at 30 s, and 2 at their own 240 s); the other 3 failures, in two
seasons tests, were not timeouts (corrected in fix round 1, below). Every other step passed, including `test:db` 300 and the
production gate 34.

**Mechanism.**
- `scripts/ci-render.mjs` (new) holds the tag `@render`, the variable `CLOUDIATOR_CI_RENDER` and
  `renderExclusion(env, { production })`.
  - `exclude` gives the pattern `(?:^|\s)@render(?:\s|$)`. It matches the tag itself, never `@rendering` or the word in a
    title.
  - Unset or empty gives nothing, and the production gate never gets the pattern.
  - Any other value throws.
- `playwright.config.ts`: the desktop and mobile projects get `grepInvert` from that module. The production gate
  (`PLAYWRIGHT_STATIC=true`) and every run without the variable are unchanged.
- `scripts/verify.mjs` reads the variable once, so an invalid value stops the gate before it starts.
  - **With the exclusion,** the development browser step sets the variable explicitly. It first lists the tagged tests with
    the same configuration (`--list --grep`, without the variable: no test runs and no web server starts) and logs the count.
    Its summary line then ends with `excluded N render-bound tests (CI, no GPU)`, beside any failure note. If the listing
    fails, the line says `count unavailable`.
  - **Without it,** the step removes the variable, so a stray value cannot narrow a local gate.
  - The production step always removes it. The JSON results carry `excluded: { tag, count }`.
- `.github/workflows/checks.yml` sets `CLOUDIATOR_CI_RENDER: exclude` on the release-gate step only. The step's comment names
  the controller's exception and the run, and says that the local gate of record and the production gate are unchanged.
- The private config `node_modules/.cache/pw-replay.config.mjs` (not committed) mirrors the repository config through the
  same module.
- `docs/operations/verification-gates.md` is unchanged. The explanation is in `release-evidence.md`.

**Tests (TDD: each was watched fail, then pass).**
- `tests/scripts/playwright-config.test.ts` (new, 5 tests) loads `playwright.config.ts` afresh for each environment. It checks:
  - no `grepInvert` when the variable is unset or empty;
  - both projects get the pattern with `exclude`, and it matches the tag but not `@rendering` or "renders";
  - the production gate gets none;
  - the value `yes` is refused;
  - Playwright's own listing loses exactly the tagged tests.

  RED before the config change: no `grepInvert`, the invalid value accepted, and 580 listed instead of 430.
- `tests/scripts/verify.test.ts` (6 new tests) checks:
  - each step's environment: set, removed, always removed for production, and the list arguments;
  - the summary line `excluded 150 render-bound tests (CI, no GPU)`;
  - the note beside a failure, and with an unknown count;
  - that nothing is counted or said without the exclusion;
  - `countListed`, and the real `countExcluded` against the repository config.

  RED before the change: no `exclude`, no count, and `countListed` missing.
- `tests/workflow.test.ts` (1 new test) checks that the variable is set on the release-gate step only, once in the file, and
  that the comment carries its phrases. RED before the workflow change.

**What is tagged: 75 tests, which is 150 runs across both projects, out of 582.** One tag covers both projects. No
assertion changed. (Fix round 1, below, untags the two seasons tests and tags the expedition stage-time case: 74 tests,
148 runs.)

*The 42 tests behind the 51 failures.* A test is listed once by title. The last column gives the projects it failed on in
run 39452911203.

| Location | Test | Failed on |
|---|---|---|
| `arena.spec.ts:78` | walks each revealed pair into its own ring, face to face, and plays its bout from the log | desktop |
| `arena.spec.ts:187` | lists the fights in the rings as buttons that find the pair | desktop |
| `arena.spec.ts:216` | selects a fighter by a click on its body in the ring | desktop, mobile |
| `arena.spec.ts:254` | keeps damage labels clear of the fighters’ nameplates and the NPC tag | desktop, mobile |
| `arena.spec.ts:296` | walks pairs into their rings within the walk-in time and back to staging after the result | desktop |
| `arena.spec.ts:325` | jogs pairs into their rings at three times the walking pace with a quicker step, and walks them back at the normal pace | desktop |
| `arena.spec.ts:404` | keeps each fight’s damage labels clear of every nameplate in the six-fight view | desktop, mobile |
| `arena.spec.ts:518` | stages, reveals, completes and credits a human bout, crediting nothing before minute 80 | desktop |
| `arena.spec.ts:552` | reports NPC and human losses with no lasting injury, crediting their reduced rewards | desktop |
| `arena.spec.ts:636` | scrolls the card into view and focuses its heading when a camp bout opens it (reduce motion) | desktop |
| `arena.spec.ts:702` | ends the ring fight when its card shows the result, never before | desktop, mobile |
| `arena.spec.ts:754` | pages league standings and shows the owner’s rating, renown and current strength apart from them | desktop |
| `arena.spec.ts:783` | opens a spectator Arena card from the camp without owner rewards | desktop |
| `camp.spec.ts:68` | opens on the owner and finds or follows them from the Gladiators menu | desktop, mobile |
| `camp.spec.ts:177` | keeps the camera inside the map after panning far beyond its edges | desktop |
| `camp.spec.ts:194` | zooms in fixed steps from buttons, keys and the wheel, and leaves browser shortcuts alone | desktop |
| `expedition.spec.ts:91` | walks the minute table for a success and for a defeat in each encounter | desktop |
| `full-screen.spec.ts:98` | names each rail icon on hover | desktop |
| `full-screen.spec.ts:144` | opens one panel at a time; the camp, Escape or the same icon closes it | desktop |
| `full-screen.spec.ts:178` | never lets a panel cover the corner chip | desktop |
| `full-screen.spec.ts:390` | fits sheets at 360×640 with no horizontal scroll | mobile |
| `management.spec.ts:42` | opens a public profile card from a camp click, the Gladiators list and the standings | desktop |
| `management.spec.ts:107` | shows management shortcuts only on the viewer’s own card | desktop |
| `market.spec.ts:262` | lists an eligible item with the fee and NPC value shown, then cancels it | desktop |
| `release.spec.ts:89` | completes a keyboard-only journey through every menu with focus never on body | desktop |
| `release.spec.ts:253` | names every focusable control and links each validation message to its field | desktop |
| `release.spec.ts:572` | meets the contrast minimums in the player forms | desktop |
| `replay.spec.ts:394` | stages both fighters facing each other inside the frame, with effects on the defender, for every action | desktop, mobile |
| `resting.spec.ts:46` | lists a resting gladiator with where it is, draws it nowhere in the camp, and says so on its profile card | desktop |
| `resting.spec.ts:107` | previews the owner resting at home: back on its schedule at the next boundary once its presence is answered | desktop, mobile |
| `retention.spec.ts:121` | says a tournament replay is no longer kept after seven days and when its log was pruned | desktop |
| `seasons.spec.ts:97` | switches to a finished season with medals, no Your standing and the promotion footnote (visitor) | desktop |
| `seasons.spec.ts:145` | shows the champion title and badges on a profile card, and nothing for a gladiator without prestige | desktop |
| `seasons.spec.ts:170` | fits the standings sheet at 360 px with no horizontal scroll | desktop, mobile |
| `seasons.spec.ts:239` | reads the current season again at each new revision, a picked finished season never, and the season list only when stale | desktop |
| `tournament.spec.ts:93` | reveals each round on the display clock, shows the owner’s loss and spectating, and replays a completed bout inline | desktop |
| `tournament.spec.ts:238` | holds each sample at the server time its view was projected at, so it shows what its label says | desktop |
| `tournament.spec.ts:288` | backs processing re-reads off from 30 s to 5 minutes, pauses them in a hidden tab, re-reads once on focus and resets when the status changes | desktop |
| `tournament.spec.ts:332` | loads a bout’s battle log only when its replay is watched, and only once | desktop |
| `tournament.spec.ts:800` | walks the eliminated out to their spots and keeps them there across world updates | desktop, mobile |
| `visitor.spec.ts:57` | lets a visitor watch the camp and open every public menu without sending a command | desktop |
| `visitor.spec.ts:127` | opens the create dialog over the running camp after sign-in without a gladiator | desktop |

*32 more tests, beyond the failure list, from the same describe blocks.* For the top-level market and visitor tests, "the
same block" means the same file. Each of these tests drives the camp or a scene, as its failing neighbours do. **The rule:**
the test passed in run 39452911203 but used at least two-thirds of its timeout on one project or both, that is 20 s of the
default 30 s. Every case qualified on the desktop project, which took a median 1.8 times as long as the mobile one on that
run. These tests are the next to time out on a GPU-less runner. The time shown is the slowest project's time in that run.

| Location | Test | CI time |
|---|---|---|
| `arena.spec.ts:57` | warms every entrant up in staging before minute 60, with no pairing or ring shown | desktop 22.3 s |
| `arena.spec.ts:500` | reveals the bout at minute 60 and discloses an NPC fallback (plan Step 1) | desktop 22.7 s |
| `arena.spec.ts:566` | says Preparing while the worker is late, invents no result, and asks again | desktop 27 s |
| `arena.spec.ts:589` | opens the selected bout as an expanded replay over the camp and returns to the camp | desktop 23.1 s |
| `arena.spec.ts:636` | scrolls the card into view and focuses its heading when a camp bout opens it (no-preference motion) | desktop 29 s |
| `arena.spec.ts:727` | opens the card from a fighting pair in the camp, by click and by keyboard | desktop 28.1 s |
| `camp.spec.ts:114` | selects the gladiator whose body is under the pointer, not a neighbour | desktop 25.5 s |
| `expedition.spec.ts:489` | follows the gladiator by default and pans freely after a drag | desktop 20.3 s |
| `expedition.spec.ts:704` | draws the gladiator on walkable tiles with the shared depth rule, and fades the tree that hides it | desktop 22.9 s |
| `full-screen.spec.ts:114` | reaches the skip link on the first Tab, reveals the rail on the next and returns focus to the icon on Escape | desktop 26.8 s |
| `market.spec.ts:181` | lets a visitor browse listings with no command and no buy or sell controls | desktop 26.6 s |
| `market.spec.ts:232` | buys a listing, shows the receipt and the item in inventory | desktop 24.2 s |
| `market.spec.ts:315` | explains sold and expired results and refreshes the page | desktop 23.7 s |
| `market.spec.ts:339` | reads the owner when the menu opens and on Refresh, after listings sold elsewhere | desktop 24 s |
| `market.spec.ts:382` | keeps a failed purchase input for a retry with the same operation | desktop 29.3 s |
| `market.spec.ts:536` | moves the focus to the outcome of each trade, never to the page | desktop 29.8 s |
| `release.spec.ts:440` | pins the rail, a menu frame, a scene and the profile card in accessibility snapshots | desktop 25.8 s |
| `release.spec.ts:518` | meets 4.5:1 contrast on panel text and 3:1 on controls | desktop 156 s (of 180 s) |
| `release.spec.ts:592` | respects reduced motion in the rail, panels and scenes | desktop 23.7 s |
| `retention.spec.ts:66` | explains retention in Recent results and offers no replay once a result is older than seven days | desktop 22.1 s |
| `seasons.spec.ts:56` | shows the current season countdown, prizes and own qualification progress | desktop 22.7 s |
| `seasons.spec.ts:97` | switches to a finished season with medals, no Your standing and the promotion footnote | desktop 29.9 s |
| `tournament.spec.ts:70` | keeps every future result hidden before round 1 (plan Step 1) | desktop 29.9 s |
| `tournament.spec.ts:136` | moves between rounds with the arrow keys, Home and End | desktop 23.3 s |
| `tournament.spec.ts:157` | rings a focused round tab and Watch replay with the panel’s gold outline | desktop 20.2 s |
| `tournament.spec.ts:200` | explains the one-entrant fallback: regular Arena this slot | desktop 24.1 s |
| `tournament.spec.ts:213` | marks a due round as preparing while its results are unpublished, and asks again | desktop 21.1 s |
| `tournament.spec.ts:360` | works by keyboard alone | desktop 20.1 s |
| `tournament.spec.ts:700` | waits every entrant in staging, then fights each revealed bout in a sparring ring | desktop 22.3 s |
| `tournament.spec.ts:739` | sends the eliminated to spectator spots outside the wall and marks the champion at the end | desktop 24.2 s |
| `tournament.spec.ts:856` | changes a tournament ring and the panel over at the same moment | desktop 29.8 s |
| `visitor.spec.ts:200` | closes a private menu and shows no private value when the session ends | desktop 25.6 s |

*1 more test, by judgment.* `arena.spec.ts:542`, "shows the warm-up reveal time short, on one line at 360 px", is Task
24.0b's new case and has not run on CI yet. It opens the Arena camp and takes 360 px page screenshots, as its failing
neighbours `:518` and `:552` do.

**Not tagged.** Some tests passed in that run at two-thirds of their timeout or more but sit outside the failing describe
blocks, so the ruling leaves them out. They remain a risk for the next CI run:
- `inventory.spec.ts`, "buys through the live gateway…": 28.8 s;
- the live Tournaments panel, "a viewer joining late…": 28.0 s;
- `live-camp.spec.ts`, "the fixture preview keeps its owner…": 27.0 s;
- `planning.spec.ts`, "queues, confirms and cancels…": 25.4 s;
- `read-render.spec.ts`: "retries a failed ring log…" 25.3 s, "offers Try again…" 22.3 s, and "backs off both preparing
  reads…" 20.6 s;
- `full-screen.spec.ts`, on any device, "closes a menu… checkVisibility": 23.3 s;
- `identity.spec.ts`: "two signed-in tabs converge…" 23.1 s, "validates names…" 21.2 s, and "retains creation draft…"
  20.1 s;
- `visitor.spec.ts`, keyboard dialog, "keeps Tab and Escape…": 22.8 s;
- `scenes.spec.ts`, "opens an expedition result over the camp…": 21.3 s.

**Three of the tagged failures, in two tests, were not timeouts.** The ruling tagged them with the rest; fix round 1 (below)
fixed both and removed their tags:
- `seasons.spec.ts:170` failed on both projects with "table 342 px in 332 px". The likely cause is the runner's fallback
  font for `system-ui`; that is inferred, not verified.
- `seasons.spec.ts:239` saw 4 season views read where 5 were expected. A timing difference under load is likely; that is
  inferred.

## Part 2: expedition stage start times in the short style

This follows Avi's 2026-10-20 decision for the activity end times (plan question 14).

- `src/features/character/ExpeditionView.tsx`: the fixed `'en'` two-digit `clockTime` is gone. A new exported `StageStart`
  renders `<time dateTime=…>{slotTimeText(startedAtMs, nowMs)}</time>`. The activity log passes `state.displayNowMs`, the
  view's existing display clock, so there is no new `Date.now()`.
- A start that cannot be shown (`slotTimeText` gives `''`) renders nothing at all: no empty `<time>`. Before, the fixed
  formatter and `toISOString()` threw a `RangeError` on a non-finite time.
- `src/features/schedule/slot-time.ts`: the doc comment lists the new caller.
- Unit test, `tests/domain/expedition-view.test.ts` (new, 2 tests): the short slot time with the exact instant as `dateTime`;
  a start before local midnight shows its date once the display time is past midnight; and NaN or Infinity starts, or a NaN
  display time, render nothing. RED against a `StageStart` that used the old formatter: `04:20 AM` received, and
  `RangeError: Invalid time value`.
- Browser test, `expedition.spec.ts:622`, "shows each stage start in the activity log short, on one line at 360 px". It opens
  the woodland fixture at minute 65 and holds the clock. Each `<time>` must equal `slotTime()` of its own `datetime`, the
  last must not be the two-digit form, and the time must stay on one line at 360 px. It also takes the review screenshot.
  RED against the old source: `Received: "01:00 AM"`, `Expected: "1:00 AM"` on both projects. GREEN on both.
- No existing test asserted the old form; none needed updating.
- **Screenshots (360 x 740):**
  - `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\task-24.0c-shots\expedition-mobile-stage-list-360.png`
  - `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\task-24.0c-shots\expedition-desktop-stage-list-360.png`

  Both show the log as "12:20 AM", "12:40 AM", "1:00 AM" and "1:20 AM".

## Verification (Lane B gate order, at `10a5e76`)

| Step | Result |
|---|---|
| `npm test` | 1271 passed (67 files; 1257 before, 14 new) |
| `npm run typecheck` | clean (tsc, deno check, deno test 2/2) |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, `npm run verify:static` | clean: 5 fixed routes, `_headers` as generated, 91 assets, no forbidden material |
| Development suite (`pw-replay.config.mjs`, port 3300, 2 workers) | **547 passed, 0 failed, 35 skipped** of 582 (10.5 min) |
| The same, with `CLOUDIATOR_CI_RENDER=exclude`, through the gate's own browser step (`runGate` of `scripts/verify.mjs`) | 432 run: **402 passed, 1 failed, 29 skipped** (7.1 min). The gate logged and summarized `excluded 150 render-bound tests (CI, no GPU)`. The failure is unrelated (see "Concerns") |
| Isolated production build (`CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true`, without the publishable key or URL), `verify:static -- .next/browser-test` | clean |
| Production gate (`PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test`, repository config, port 4173) | **34 passed, 0 failed, 548 skipped** |
| `git diff --check` | clean |

Listings: the repository config lists 582 tests without the variable and 432 with it. With the variable in the production
gate it still lists 582. The private config gives the same counts.

## Concerns

- **An unrelated failure in the exclusion run.** `[mobile] live-camp.spec.ts:234`, "a signed-in player … re-reads the owner on
  a new revision, slot or focus", failed with owner reads `1`, expected `2`, within 5 s after a new revision and a 30 s
  fake-clock step. The test is untagged and untouched by this task. It passed in the full run, and run alone afterwards it
  passed 20 of 20 (`--repeat-each=10`, both projects). Every earlier log in this task's folder, including CI run 39452911203,
  shows it passing. This looks like a load-timing flake in the revision poll. It was not rerun to turn the run green. It
  needs triage before CI is relied on.
- **Coverage.** CI now skips 150 of 582 development runs, including the mobile runs of tests that failed only on desktop.
  The local `npm run verify` still runs all of them.
- **The two non-timeout seasons failures** above are hidden on CI by the tag and still need their own fixes or triage.
- **Not yet observed:** a CI run with the exception.
- **Visible:** the log's labels no longer line up when the times differ in width ("12:40 AM", then "1:00 AM"); before, the
  fixed two-digit form kept them aligned. This is Avi's to judge from the screenshot.
- The private config edit lives under `node_modules/.cache` and is lost on `npm ci`.

## Fix round 1 (the controller's rulings, 2026-10-21)

Commits (on top of Task 24.1b's `14e56ba`, `8dd9843` and `d1f260d`, which are kept and untouched):
- `96144cf` fix: give the standings table slack at 360 px
- `2afe0d6` test: wait for the armed sync poll and the settled read counts
- `f8931e0` fix: align the expedition log times
- this update: docs: report Task 24.0c fix round 1

The concerns above about the live-camp failure, the two seasons failures and the jog in the log's labels are resolved
below. The other concerns stand.

**Important 1a: the 360 px standings table (`seasons.spec.ts:170`).** The narrowest the table can be is set by the headers
("Gladiator", "Human"), the one-line medal note ("🥇 1st · Champion", as the approved mockup shows) and the cell padding.

Reproduced locally: with Verdana forced, the archived table was 344 px wide in its 332 px box (CI: 342 px). Segoe UI fits.

The narrowest width (min-content) of the archived Bronze table at 360 px, per candidate:

| Candidate | Verdana | Segoe UI | Medal note |
|---|---|---|---|
| As it was | 344 px | 306 px | one line |
| Let the medal note wrap | fits | fits | wraps under Segoe UI too, so not taken |
| The fix | 315 px | 276 px | one line under both |

- **The fix** (`StandingsPanel.module.css`, phones only, `max-width: 480px`):
  - cell side padding 0.3 → 0.2 rem;
  - no letter spacing on the headers or the medal note;
  - medal padding 0.4 → 0.25 rem.
- **Slack:** 17 px with Verdana, 56 px with Segoe UI.
- **Test:** the assertions are unchanged. The test now runs its fit check again with `Verdana, "DejaVu Sans"` forced by a
  test-only stylesheet, on the archived season and then the current one. RED before the CSS change (344 px in 332 px, both
  projects); GREEN after. The `@render` tag is removed.
- **Screenshots** (both show the top of the sheet; the test checks the table itself):
  - `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\task-24.0c-shots\standings-mobile-archived-360.png`
  - `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\task-24.0c-shots\standings-mobile-archived-wide-font-360.png`

**Important 1b and 3: the sync-poll races (`seasons.spec.ts:239`, `live-camp.spec.ts:234`).**

*Cause.* `src/lib/api/sync.ts` arms the next 30 s poll only when a refresh finishes, and a poll that fires during a refresh
joins it. A fast-forward sent as soon as a request was seen could therefore fire nothing. In the failed live-camp run, the
trace shows two fast-forwards 9 ms apart: the first step had passed on a late start-up read, not on its own poll.

*Helper.* `tests/browser/sync-poll.ts` (test-only) adds an init script that records, inside the page:
- the poll's timers: the 30 s timeouts whose callback refreshes;
- the sync reads in flight: `world_revision` and `world_actor_reads`.

It offers two calls:
- `idle()` waits until no sync read is in flight and a poll was armed after the last read settled.
- `nextSyncPoll()` waits for an idle controller with a poll armed since the previous step, then fast-forwards 30 s.

*Test changes.* The assertions are the same in both tests.
- **live-camp** takes its baseline counts once idle and fires each poll with `nextSyncPoll()`.
- **seasons** fires each poll with `nextSyncPoll()`. Instead of reading its counters once after a fixed 500 ms, it polls
  them to the expected values and checks them again 500 ms later, so a late extra read still fails. The `@render` tag is
  removed.

*Before and after, with the same loads* (load scripts in the session scratchpad; nothing committed):

| Load | live-camp, before | live-camp, after | seasons, before | seasons, after |
|---|---|---|---|---|
| The page's CPU throttled 6x from start-up (CDP), 4 workers | **3 of 16 failed** (owner reads "Expected: 2, Received: 1", as observed) | 16 of 16 passed | 16 of 16 passed | 16 of 16 passed |
| The same at 8x | 32 of 32 passed | 32 of 32 passed | not run | not run |
| A 32-thread CPU burner, 8 workers | 40 of 40 passed | 20 of 20 passed | 40 of 40 passed | 20 of 20 passed |

The seasons race (4 view reads where 5 were expected, on CI) was not reproduced locally. The fix removes its observed
cause, the single read after a fixed 500 ms. Injecting latency into the routed reads changed the tests' behaviour beyond
timing (both versions failed), so it was not used as evidence.

**Important 2: the expedition log time column.**
- **Fix:** `.log time` gets `min-width: 5em` and `text-align: right`. It already had `flex: none` and tabular numerals.
- **Test:** the 360 px browser test now checks that every row's label left edge and time right edge are the same. RED
  before: label edges at 104 and 97 px. GREEN after.
- **Screenshot (refreshed; the desktop copy is beside it):**
  `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\task-24.0c-shots\expedition-mobile-stage-list-360.png`
- **Limit:** a start on another local day ("Oct 19, 11:50 PM") is wider than 5em, so that row's label starts further right.

**Minors.**
- **Counts corrected** here and in `release-evidence.md`: 48 timeouts (46 at 30 s, 2 at 240 s), plus 3 non-timeout
  failures in two seasons tests; 582 tests listed.
- **Newly tagged:** `expedition.spec.ts:624`, the stage-time case (formerly `:622`). It takes 360 px screenshots of the
  expedition view, with the scene on the page.
- **Tagged now:** 74 tests, 148 runs.

**Verification (Lane B gate order, at `f8931e0`):**

| Step | Result |
|---|---|
| `npm test` | 1282 passed (68 files; includes Task 24.1b's tests) |
| `npm run typecheck`, the asset check | clean; assets up to date (28 files) |
| `npm run build`, `npm run verify:static` | clean (91 assets) |
| Development suite (port 3300, 2 workers) | **547 passed, 0 failed, 35 skipped** of 582 (10.2 min) |
| The same with `CLOUDIATOR_CI_RENDER=exclude`, through the gate's browser step | 434 run: **405 passed, 0 failed, 29 skipped** (7.0 min). The summary line ends `excluded 148 render-bound tests (CI, no GPU)`, and the result is PASSED |
| Isolated production build, `verify:static -- .next/browser-test` | clean |
| Production gate (port 4173) | **34 passed, 0 failed, 548 skipped** |
| `git diff --check` | clean |

**Concerns after fix round 1.**
- The 13 untagged tests near the CI timeout (listed above) remain a risk for the next CI run.
- The CI font is inferred, not observed. The slack was checked with Verdana, a wide Windows font, and the test forces
  DejaVu Sans where Verdana is missing.
- The seasons race is fixed by construction; it was not reproduced locally.
- No CI run with the exception has been observed yet.
