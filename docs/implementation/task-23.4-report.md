# Task 23.4 report: read volume and render cost (Lane B)

**Status: DONE_WITH_CONCERNS.** Everything in the brief is implemented, C5 included. The full gate passed in order on the final code. The concerns are listed at the end: the cherry-pick conflicts, mobile fps not measured, and visible changes awaiting Avi's approval.

**Commits** (on `claude/task-23-ui`, not pushed):

| Commit | What |
| --- | --- |
| `fc99367` | perf: bound reads and rendering for the release (everything except C5) |
| `659618b` | the cherry-pick of `27a9e62` (Task 23.2, M18 and the `publishedSlotIndex` contract) |
| `38e0a74` | test: carry the access fixture the cherry-picked matrix imports |
| `59036a8` | perf: use the published slot instead of the five-minute grace (C5) |
| this report | docs: report Task 23.4 |

**Setup:**
- **Worktree and branch:** `C:\Avi\Studies\Projects\Cloudiator-replay`, `claude/task-23-ui`, from `f238eda`.
- **Read first:**
  - `AGENTS.md` and `docs/operations/verification-gates.md`;
  - the brief and the context pointers;
  - the Task 13, 17 and 19 reviews (C5–C9, C11, C25), the Task 12 report (C24) and the Task 23.5 report;
  - the Next.js guides `use-search-params.md`, `static-exports.md` (browser APIs only in effects) and `server-and-client-boundary.md`.
- **Not done, as briefed:**
  - no package or tool download and no `npm ci`;
  - no database run, no `supabase status`, no push, no subagent;
  - nothing written in `Cloudiator-claude` or `Cloudiator`, and port 3400 left alone.

## What changed

### C7: a bounded tournament log cache (`src/lib/api/gateway.ts`)

- `TOURNAMENT_LOG_CACHE_LIMIT = 64`.
  - It is enough for the camp's six rings (current and next windows) and the panel's watched replay.
  - It never holds a whole slot: a 50-entrant tournament has 49 bouts, in each of four leagues.
- The cache is least recently used: a hit moves the log to the end, and an insert drops the oldest.
- A failed load is still forgotten, and concurrent callers still share one promise.

### C8: the camp pauses under an opaque scene

- **`GameViewport` `paused` prop.**
  - While it is set and the camp is ready, the Phaser game is `pause()`d: its step returns before any update or draw. `resume()` follows when the scene closes.
  - A camp opened under a shared-link scene gets ready first, then pauses.
  - Reads go on meanwhile.
- **`CampShell`** passes `paused={scene !== null}`.
- **Why it is invisible:** the scene's backdrop is 97% opaque.
- **Comments:** the "keeps running beneath" comments are updated in `SceneOverlay` and `CampShell`, and in the scenes test.

### R13: Reload for the camp, and Try again for failed replays

- **Camp fallback (`GameViewport`).**
  - The fallback is now a `<div data-camp-fallback>` holding the existing message (`role="status"`, still the camp view's description) and a **Reload** button.
  - Reload starts the camp again in place: a new game over the same world, timelines, views and logs. Menus, session and any open menu stay.
  - The keyboard moves to the camp view first, so the focus never falls to `<body>`.
  - The button uses the camera buttons' look at 44 px.
- **Unavailable replay (`BattleReplay`).**
  - "This replay cannot be loaded right now. Try again shortly." keeps its text and gains **Try again**, which `ActivityReplay` uses to read the timeline again.
  - The focus first moves to what stays: the scene's Back to camp, or the page's `main`.
  - This covers both the `/replay/` page and the scene over the camp.
- **Tournament inline replay (`TournamentPanel`).**
  - A failed log read offers **Try again**, styled like the panel's own buttons, which asks for the log again.
  - The focus goes to Close replay first.
  - It is offered only for a read failure, never for a log that disagrees with the published result.

### C9: ring order and failed ring logs (`GameViewport`, `tournament-camp.ts`)

- **Publishing views together.**
  - The tournament views read in one check are kept and published together.
  - The ring schedule keeps bouts that have entered their rings. Publishing one league's view before another's with the same reveal times therefore let arrival order decide the rings. It no longer does.
  - A hanging read holds the others back at most 5 s, and is published when it lands.
- **Failed logs.**
  - A failed ring log is asked for again after `ringLogRetryDelay(failures)`: 2 s, 4 s, 8 s, 16 s, then every 30 s.
  - The wait is measured in real time (`performance.now()`). The old 30 s was display time, so it never came while a clock was held.

### C11: "being prepared" re-reads back off (`tournament-stage.ts`, `TournamentPanel`)

- `preparingRetryDelay(sinceCutoffMs, lateRetries)`: 30 s for the first three minutes after the cutoff (`TOURNAMENT_PREPARE_FAST_MS`), then 60 s, 120 s, 240 s and every 5 minutes.
- The card counts its visible 30 s ticks toward the wait, so the timer is still not restarted by a new owner-refresh function (R2).
- The owner refresh is part of each re-read, so both reads back off together.

### C5: the published slot replaces the five-minute grace

**Contract:** cherry-picked from `27a9e62`. `RevisionState.publishedSlotIndex?: number | null`, which `readRevision` and `readWorld` now carry.

**`tournamentPreparing(id, now, processedSlotIndex, publishedSlotIndex?)`.** Within the tournament's slot:
- **published slot known:** being prepared exactly while it is before the slot, however long that takes;
- **null or left out** (before the first coordination): the old rule stays safe, with the 5-minute bound or a lagging processed slot.

**`TournamentCard`:**
- **The published slot a read started with.** A missing view is judged by the published slot as it was when the read started (`failedPublished`). So a not-found read before the publication is never taken as "no tournament".
- **Publication.** Once the shared sync shows the slot published, the card reads again at once. It reads once more if a read in flight landed just after.
- **Owner refresh.** With a published slot, re-reads no longer refresh the owner first: the revision says when the slot is published. The R2 refresh remains only for the null case.

**Wiring and test doubles:**
- `GameUiState.publishedSlotIndex` is wired to `TournamentPanel` from `CampShell`.
- The fixture gateway reports its slot as published, and `tests/api/fixture-gateway.test.ts` is updated.
- The live browser transport serves `published_slot_index`:
  - by default the server time's own slot (published);
  - `publishedSlotIndex` / `setPublishedSlotIndex` set it.
  - The preparing tests that pin the old rule now say "without a published slot" and set it to `null`.

### C6 and C25: de-duplicated owner, `/replay/` and Arena reads

- **`useGameState`: revision changes.** A new revision or slot is detected as the sync publishes it, not in a later render effect, and the owner read starts at once.
- **`useGameState`: tab returns.** A return reads the owner only after that return's revision read, and only if that read did not already read it.
  - A return to a changed world now reads the owner once instead of twice.
  - The 2 s gap rule (final review Minor 5) stays.
- **Creation (`ownerCreated`).**
  - The creation dialog's own confirming owner read is shown at once; the extra refresh is gone.
  - The world is read now (`refresh({ fresh: true })`, which waits for a refresh in flight). The new gladiator appears without waiting for the 30 s poll, and its revision change reads the owner once.
  - Owner reads per creation go from 3 to 2.
- **`/replay/` (`clockOnly`).**
  - The sync polls only the revision (`createSync(…, { actors: false })` publishes the revision as a world without actors).
  - The owner is read once per account.
  - No world is loaded on a deep link.
- **Arena timelines (Task 17 review M7).**
  - At most two timelines are read at once, in a hash order unrelated to the world's.
  - A landed timeline whose bout names an in-camp partner spares that partner's read (`arenaPartnersShown`). Both sides carry the same battle, and the wave still lands together.
  - Result: 8 reads instead of 13 for the fixture slot's entrants.
  - The Task 17 read-count test is updated to this intended change.

### Decision 2: the `?perf=1` overlay (`src/features/shell/PerfOverlay.tsx`)

- **The flag.** The game page passes `perf` from `?perf=1`. Without it nothing renders and nothing samples. The overlay is in every build, the production export included.
- **What it shows:**
  - frames in the last second;
  - since it mounted, the mean and 5th-percentile rates and the share of frames over 16.7 ms and 33.3 ms (`src/lib/frame-stats.ts`, the harness's own definitions);
  - the frame count and the WebGL renderer.
- **Hidden tabs:** a hidden tab's gap is not counted.
- **Placement.**
  - It is a manual popover, raised again whenever a modal dialog opens, so it stays visible over scenes.
  - It takes no pointer events, `aria-hidden`, and has no focusable content.
  - It sits bottom right on desktop and below the pill on touch, in the shell's glass look.

### Decision 9: the FPS harness

- `tests/performance/fps.spec.ts` and `tests/performance/playwright.perf.config.ts`, with headed Chrome and the development fixture build.
- `PLAYWRIGHT_PERF_PORT` picks the port. Results are attached, and written to `PERF_RESULTS` when set.
- The path:
  - `createDemoWorld(now, 50, 6)`'s crowd, with the slot's 13 Arena entrants at minute 60 and the `completed` tournament's 8 entrants moved into the slot (its final and spectators);
  - overview, a pan, the maximum zoom (3.00×) over the arena;
  - 20 replay and expedition open/close cycles, then the camp again.
- It checks that the camp is still ready with one canvas afterwards, and records the WebGL renderer.
- The Pixel 7 project adds CDP `Emulation.setCPUThrottlingRate` 4× and is indicative only.
- It never runs in the gates, because their `testDir` is `tests/browser`.

## Tests: RED, then GREEN

| Brief test | Where |
| --- | --- |
| keeps at most N tournament logs in the cache | `tests/api/log-cache.test.ts` (unit) |
| pauses the camp loop while an opaque scene is open and resumes after | `tests/browser/read-render.spec.ts`, counting the camp canvas's WebGL draw calls |
| backs off both preparing reads after three minutes | read-render (live) and `tests/domain/tournament-panel.test.ts` (`preparingRetryDelay`) |
| uses the published slot instead of the five-minute grace | read-render (live) and `tournament-panel.test.ts` (`tournamentPreparing`, card notice) |
| retries a failed ring log and keeps multi-league arrival order | read-render (live: two 24-entrant leagues, arrival order swapped, one log failed) and `tests/domain/tournament-camp.test.ts` (`ringLogRetryDelay`) |
| offers Reload when the camp cannot load and recovers after it | `tests/browser/release.spec.ts`; the 23.5 `test.fixme` is replaced, and it runs in development and production |
| reads the owner once per revision change | read-render (live), with a creation test and a `/replay/` test beside it |
| extra | read-render: one Arena timeline per human pair, Try again (replay page and tournament replay), the `?perf=1` overlay (development and production). Unit: `frame-stats.test.ts`, `arenaPartnersShown` in `arena-layout.test.ts`. |

### RED, before any source change

Raw logs are in the scratchpad (`t234/unit-red.txt`, `browser-red*.txt`, `c5-*-red.txt`).

**Unit: 8 failed, 63 passed.** The causes:
- the cache limit was undefined;
- `arenaPartnersShown`, `ringLogRetryDelay`, `preparingRetryDelay` and `TOURNAMENT_PREPARE_FAST_MS` were missing;
- `src/lib/frame-stats` did not exist.

The log cache's sharing and forgetting test passed, as coverage of existing behaviour.

**Browser: 20 of 20 failed, on both projects.** The failure in each:

| Test | Failure |
| --- | --- |
| C8 | 7,852 draw calls a second under the replay scene on desktop, and 664 on mobile; expected 0 |
| C11 | at tick 5 there were 7 reads, expected 6: still reading every 30 s past three minutes |
| C9 | the two arrival orders gave different ring layouts (24 lines differ) |
| Owner reads | a tab return to a new revision read the owner twice (expected 3, got 4) |
| Creation | no world load within 5 s of creation (1 load, expected 2) |
| `/replay/` | 1 world load, expected 0 |
| Arena pairs | 13 timeline reads, expected at most 11 |
| Try again, Reload, overlay | the control or element was not found |

One setup mistake of mine: the C8 test first passed a function to `page.evaluate`. I fixed the test, and it then failed for the product reason above.

**C5, after the cherry-pick:**
- **unit:** 2 failed. "null, +6 min, unpublished: expected false to be true", and the card notice said "No tournament matches".
- **browser:** 2 failed. At +420 s "being prepared" was gone, because of the old grace.

### GREEN

**First run of the new browser tests: 17 passed, 3 failed.**
- **The pair test failed on both projects** with 12 reads. Four concurrent reads took the fixture world's adjacent pair sides together. I changed the code to two at a time in hash order, which gives 8 reads.
- **The Reload test failed on mobile** on the camera buttons, which touch does not have: a test mistake, now checked on the pointer layout only.

**Pre-check before C5:** the full development suite gave 523 passed, 25 skipped, 0 failed.

**After C5:**
- the unit suite passed in full;
- `read-render.spec.ts` and `tournament.spec.ts` gave 82 passed.

## Gates, in the order of `docs/operations/verification-gates.md`

Ports 3300 and 4173 were free before and after every browser run.

### First full gate

It ran on the final code except two later edits: the tournament Try again alignment and the production menu check.

1. `npm test` passed: 53 files, 1124 tests.
2. `npm run typecheck` was clean.
3. The asset check was up to date (28 files).
4. The build and `verify:static` passed: 5 routes, 91 assets.
5. The development suite gave 525 passed, 25 skipped, 0 failed, 0 flaky.
6. The production gate's build and scan passed, but the suite gave **22 passed and 2 failed**.
   - The Reload test asked for the Schedule menu. The production export's live camp has no backend, so its viewer gets the public menus only. That is a test mistake.
   - Fixed to check Tournaments in production. The test then passed in development (2), and the production rerun gave 24 passed.
7. `git diff --check` was clean.

The FPS harness then ran (below).

### Final full gate

It reran steps 1–7 after the CSS alignment fix, on exactly the committed code:

1. `npm test`: **53 files, 1124 tests passed**.
2. `npm run typecheck`: clean (`tsc`, `deno check`, and the 2 Edge tests passed).
3. `node assets/source/build-assets.mjs --check`: assets up to date (28 files).
4. `npm run build`, then `npm run verify:static`: 5 fixed routes, 91 assets, clean.
5. **Development suite** (`npx playwright test --config node_modules/.cache/pw-replay.config.mjs`, port 3300): **525 passed, 25 skipped, 0 failed, 0 flaky** (9.5 min). Its dev server had exited before step 6.
6. **Isolated production gate:**
   - the `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true` build: exit 0;
   - `verify:static -- .next/browser-test`: 5 routes, 91 assets, clean;
   - `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test` (repo config, port 4173): **24 passed, 526 skipped, 0 failed**. That is 23.5's 20, plus the overlay and Reload tests on both projects.
7. `git diff --check` and `git diff --cached --check`: clean. `next dev` left `AGENTS.md` unchanged.

## FPS harness

The run was `PLAYWRIGHT_PERF_PORT=3300 npx playwright test --config tests/performance/playwright.perf.config.ts`. Both projects passed, and the desktop soft target (mean of at least 59 fps) held.

- **Setup:**
  - **renderer:** `ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)`;
  - **browser:** Chrome 155.0.8059.80;
  - **display:** 2560×1440 at 170 Hz, so 170 fps is the vsync ceiling;
  - **CPU:** i9-13900K.
- **The camp:** 50 in camp (46 drawn as players at the sample time; the rest were still walking in), 6 away, 6 ambient NPCs, 14 ring fights (6 in the rings) and 2 spectators.

| Phase | Desktop mean / p5 / >16.7 ms / >33.3 ms | Pixel 7 + 4× CPU (indicative) |
| --- | --- | --- |
| Camp overview | 170.1 / 166.7 / 0.0% / 0.0% | 155.8 / 84.7 / 0.0% / 0.0% |
| Pan | 170.1 / 166.7 / 0.0% / 0.0% | 160.9 / 85.5 / 0.0% / 0.0% |
| Arena at maximum zoom (3.00×) | 169.9 / 166.7 / 0.0% / 0.0% | 169.6 / 166.7 / 0.0% / 0.0% |
| 20 replay and expedition cycles | 160.0 / 166.7 / 1.2% / 0.6% | 123.2 / 56.8 / 4.0% / 2.6% |
| Camp after the cycles | 170.1 / 166.7 / 0.0% / 0.0% | 170.1 / 166.7 / 0.0% / 0.0% |

These numbers, the method and the read-volume measurements are in `docs/operations/release-evidence.md`, section "Lane B: render cost", for the controller to merge.

## Screenshots for the visual review

They are in `C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\perf-shots\`, named `<kind>-<project>-<name>[-production].png`, for both `desktop` and `mobile`.

- **The camp's Reload:**
  - `reload-*-camp-failed` and `reload-*-camp-recovered`, in development and `-production`.
- **Try again:**
  - `reload-*-replay-try-again`, the `/replay/` page;
  - `reload-*-tournament-replay-try-again`, the tournament's inline replay.
- **The overlay:**
  - `perf-*-overlay-camp`, in development and `-production`;
  - `perf-*-overlay-scene`, the overlay over the replay scene.
- **The camp paused under a scene:**
  - `perf-*-camp-paused-under-replay`. It looks the same as before.

## Self-review

**Checked:**
- **The pause is safe.** Phaser's `Game.step` checks a pending destroy before `isPaused`, so an unmount while paused still destroys the game. The pause applies only to a ready camp. A Reload's new game pauses as soon as it is ready under a scene.
- **Reload reuses the kept data.** It reuses the kept timelines, views and logs, so it adds no reads. Each attempt's locals (`failed`, `cancelled`) are new.
- **Batching cannot leak order.** Views of a batch are stored only at the flush, so a log that loads meanwhile cannot publish half a batch. A view whose entrants left meanwhile is not kept.
- **Arena partner skips are safe.**
  - A partner is marked "has bout" only after a landed timeline shows its bout.
  - A failed read leaves the partner due.
  - A partner already in flight overwrites the mark with its own result.
- **Owner reads stay one per change.** The new listener-side detection compares the same values the old effect compared, including the null resets on start and session change. The tab-return read is skipped only when an owner read actually started during that return's sync refresh.
- **C5 is conservative.**
  - A missing view is judged by the published slot at the read's start, so the shared sync's 30 s lag can only make the card say "being prepared" longer, never "No tournament matches" early.
  - The read on publication is followed by one more if a read in flight landed after it, so nothing waits for a backed-off tick.
- **The `?perf=1` overlay is opt-in.** It renders only with the flag, and samples only while mounted.
- **The perf suite stays out of the gates.** Neither gate config can reach it.

**Fixed during self-review:**
- The overlay first sat top left on touch, over the chip. It now sits below the pill.
- The tournament Try again stretched across its grid. It now sits at the start, as Standings' does.
- A read in flight when the publication arrives could have left the card waiting for its next tick. It now reads once more.

**Not changed (with reasons):**
- **C24.** The per-scene atlas split only lowers one-time load cost (about 50 KB gzip of JSON, in the lazily loaded camp chunk), and the harness shows no render cost. The diagonal-step speed is a visible movement change, which needs Avi's approval. Both are left as they were.
- **Task 17 round-3 Minor 1** (stacked labels on a clamped target) waits for real logs, as ruled.
- **Task 17 round-3 Minor 2** (the partner's end time): the camp now stages a pair from one timeline, and Task 23.5 made the bout end one definition.
- **Standings and profile re-reads per revision (C6)** are unchanged. The profile is re-read for the owner's combat strength. These are for Task 23.3's measurement.

## Concerns

1. **The cherry-pick of `27a9e62` had three conflicts.** All three are files Task 23.1 created or changed, and 23.1 is not on this branch. I resolved each with `27a9e62`'s version, as the controller instructed:
   - `docs/operations/migrations.md` (UU);
   - `supabase/sql/15-release.sql` (DU);
   - `tests/db/access-matrix.test.ts` (DU).

   That version carries 23.1's content too. `tests/db/access-matrix.test.ts` imports 23.1's `tests/fixtures/access.ts`, so the typecheck failed. I copied that file verbatim from `27a9e62` (`38e0a74`); its blob is the same as Lane A's.
   - The M17 migration itself is not on this branch.
   - No database test ran here.
   - The controller's merge should find these files identical to Lane A's.
2. **Mobile 30 fps is not measured.** The Pixel 7 project runs on the desktop GPU. Until Avi's phone is measured with `?perf=1` after Task 24, it remains a named launch blocker.
3. **Visible changes awaiting Avi's approval** (screenshots above):
   - the camp fallback's **Reload** button;
   - **Try again** on an unavailable replay and on a failed tournament replay (the existing text is unchanged);
   - the `?perf=1` overlay and where it sits: bottom right on desktop, below the pill on touch.

   The camp pausing under a scene does not show. Nothing else's look changed.
4. **Intended behaviour changes worth a reviewer's eye:**
   - **Owner refresh before a re-read (R2).** It now happens only when the revision has no published slot.
   - **Tab-return owner read.** It now waits for that return's revision round trip.
   - **After creation.** My gladiator opens at once from the dialog's confirming read, instead of after a second read.
   - **Arena timelines.** Two at a time means a 50-entrant minute-60 wave lands in about 13 round trips before the camp stages it. Before, all were read at once with twice the reads.
5. **A hanging tournament view read** delays the others in its batch by at most 5 s, a bounded trade for an order-independent ring layout.
