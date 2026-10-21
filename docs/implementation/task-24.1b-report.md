# Task 24.1b report: the frame overlay per phase in constant time; the `__next.*.txt` 404s (Lane B)

## Status

**DONE.** Every Lane B gate below passed on the first run. Part 1 is built test-first. Part 2 is a documented finding: a
Windows-only Next export defect, harmless, with no configuration change.

Commits (branch `claude/task-24-ui`, Cloudiator-replay, on `b2ed5ac`; nothing pushed):
- `14e56ba` perf: measure the frame overlay per phase in constant time
- `8dd9843` docs: trace the export's __next.*.txt 404s to a Windows path separator
- this report: docs: report Task 24.1b (with the overlay's evidence section in `release-evidence.md`)

No database, SQL or Edge change. Task 24.0c's files (`playwright.config.ts`, `scripts/verify.mjs`, `checks.yml`,
`ExpeditionView.tsx`, the browser specs' tags) are untouched.

## Part 1: the `?perf=1` overlay's measurement quality (Task 23.4 M3, plan Decision 11)

**Before.** The overlay kept up to 200,000 intervals, sorted them all every second (`frameStats`), counted from its mount, and
cut the renderer line short with an ellipsis.

**Now.**
- `src/lib/frame-stats.ts` (`frameStats` unchanged; the FPS harness still uses it):
  - `FrameHistogram`: 1 ms buckets with their sums, 2,001 of them (2 s, then one top bucket). `add` and `remove` are constant
    time. The frame count, the mean and the over-16.7 ms and over-33.3 ms shares are exact: each interval is tested against
    `frameStats`'s own budget-plus-jitter thresholds as it comes in. The 95th-percentile interval is the mean of the bucket
    that holds `frameStats`'s nearest-rank interval, so it is within 1 ms while under 2 s. A p95 of 2 s or more reads as at
    most 0.5 fps.
  - `FrameMeter`: each frame's timestamp goes into a phase histogram and a rolling one, in constant time. `resetPhase`
    clears the phase. The rolling histogram holds the frames whose intervals ended in the last 10 s, kept in a ring of at
    most 5,000 frames (10 s at 500 Hz; past it, the oldest leave first). `gap` (a hidden tab) makes the next frame carry no
    interval. `current` counts the frames of the last second. Memory is fixed, about 130 KB.
- `src/features/shell/PerfOverlay.tsx`:
  - `perfPhaseOf(campStatus, scene)` gives the phase label and a key that changes when the camp gets ready (or fails) and at
    each scene open or close; another scene or replay stage is a new phase.
  - `CampShell` passes it from the status and scene it already holds: no new event or global.
  - The meter resets when the key changes.
  - `PerfReadout` shows five lines: `camp · 42 s · 60 fps`, the phase's `mean · p5 · frames`, its over-budget shares,
    `10 s: mean · p5 · >33.3 ms`, and the renderer.
- `shell.module.css`: `.perf .perfRenderer` wraps (`white-space: normal; overflow-wrap: anywhere`). It needs two classes to
  outrank `.perf p`, which keeps the number lines on one line each. The ellipsis is gone.
- Still opt-in: nothing renders or samples without `?perf=1` (the existing browser check is kept).

**Tests (TDD).**
- `tests/domain/frame-stats.test.ts`, 8 new tests:
  - the histogram against the sort on 40 seeded random sets (up to 5,000 intervals: vsync jitter, dropped frames, stalls)
    and 15 adversarial sets: bucket edges and just under them, the exact thresholds 17.7 and 34.3 ms and just over them,
    one bucket holding both sides of the p95, nearest-rank boundaries at 19, 20 and 21 frames, tiny intervals, a long
    stall, invalid values, all equal, descending;
  - the top bucket at 2 s or more;
  - removals, and `clear`;
  - the meter: a phase reset clears the counts; the rolling window drops older frames (and the phase keeps them); the
    last second and a hidden-tab gap; the ring's capacity.
- `tests/domain/perf-overlay.test.ts`, 3 new tests: phase keys for camp-ready and each scene open or close; the readout's
  lines with the whole renderer string; the CSS rule that wraps it.
- `tests/browser/read-render.spec.ts`, the existing overlay test, extended (its tags unchanged):
  - the phase line and the 10 s line;
  - at 360 px the renderer line is the whole WebGL string, `white-space: normal`, not clipped, and on more than one line
    whenever it is wider than the box;
  - the camp phase runs at least 6 s, the replay's open shows `replay · 0–4 s`, and its close shows `camp · 0–4 s`.
- **RED:**
  - unit, before the implementation: 11 failed (`FrameHistogram is not a constructor`, `perfPhaseOf is not a function`,
    the CSS rule missing), the 3 existing `frameStats` tests passing;
  - browser, the new spec on the old source: failed at the phase line (`170 fps · mean 143.9 · …`, no phase);
  - browser, the new overlay with the old CSS: `{"whiteSpace":"nowrap","clipped":true,"lines":1,"needed":true}`.
- **GREEN:** the unit tests pass (14 in the two files), and the browser test passes on both projects.

**Screenshots** (360 px over the fixture camp, and the other review shots of the same test):
`C:\Users\AVI_OP~1\AppData\Local\Temp\claude\C--Avi-Studies-Projects-Cloudiator\3db047ee-76dd-4924-8e1d-0104fb108aef\scratchpad\task-24.1b-shots\`
(`perf-mobile-overlay-camp-360.png`, `perf-desktop-overlay-camp-360.png`, `perf-*-overlay-camp.png`, `perf-*-overlay-scene.png`).
On this machine the renderer, `ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)`, takes
two lines.

**For Avi's phone run (24.11).** Screenshot each phase's line after its 30 s. For pan and maximum zoom, which are not phases,
use the `10 s:` line after at least 10 s of each.

## Part 2: the `__next.*.txt` 404s (Task 23.5 M7)

Read first: `node_modules/next/dist/docs/01-app/02-guides/static-exports.md`, `prefetching.md`, the `trailingSlash` and
`prefetchInlining` references. None of them documents the segment-file names. They are an internal protocol, written by
`next/dist/export/index.js` and requested by `next/dist/client/components/segment-cache/cache.js`
(`addSegmentPathToUrlInOutputExportMode`).

**Finding: a Windows-only defect in Next 16.4.0's export.** It is harmless, it does not come from `trailingSlash`, and the
Linux builds (Pages, CI) should not have it. **No change.** The evidence is in `docs/operations/release-evidence.md`,
"Task 24.1b: the `__next.*.txt` prefetch 404s".
- **Observed.** A fresh `npm run build` here, served by `scripts/serve-static.mjs` and loaded in Chrome:
  - `/replay/` and `/expedition/` prefetch `/game/` for their links back to the camp;
  - `/game/__next.game.__PAGE__.txt` gets a 404 (twice), with a console error each time;
  - the root's and `/game/`'s `_tree` files and the root's `__PAGE__` answer 200;
  - a click on the link lands on `/game/` through a fallback read of `/game/index.txt`.
- **Cause.**
  - The client names the file `convertSegmentPathToStaticExportFilename('/game/__PAGE__')`, which replaces each `/` with `.`:
    `__next.game.__PAGE__.txt`.
  - The export builds that segment path with `path.relative`, which on Windows is `game\__PAGE__`. The backslash survives
    the replacement, and `path.join` then writes the file as `out/game/__next.game/__PAGE__.txt`, in a folder.
  - This hits the page segment of the 5 routes below the root, 5 of 18 exported segment files.
- **Not `trailingSlash`.** The client strips the route's trailing slash before adding the name, and the export writes the
  files into the route's own folder.
- **Tested.** A copy of `out` with only those 5 files renamed to the POSIX names (what the same code writes on Linux),
  served and probed the same way, answers every `.txt` request with 200. The link navigation uses the prefetch, with no
  fallback read.
- **Hosting.**
  - Pages' Git integration (Decision 3) and CI (`ubuntu-24.04`) build on Linux. Expected, not observed: no Linux export
    was built in this task.
  - A Windows-built export keeps the harmless 404s: this host's production gate, or a direct upload.
- **Why no fix.** No documented Next option renames the files. `prefetch={false}` on the links would only hide the defect
  and lose a working prefetch on the Linux build.

The probes (`node_modules/.cache/probe-next-txt.mjs` and `segment-names.mjs`, not committed) were deleted after use. The
POSIX-named copy is in the scratchpad (`out-posix-names`).

## Verification (Lane B)

All runs were on `14e56ba`'s source (the later commits change documents only), in the safe order of
`docs/operations/verification-gates.md`. No source was edited while a browser suite ran.

| Step | Result |
|---|---|
| `npm test` | 68 files, **1,282 passed** (11 new) |
| `npm run typecheck` | `tsc` clean; `deno check` clean; `deno test` 2 passed |
| `node assets/source/build-assets.mjs --check` | up to date (28 files) |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, `_headers` as generated (`connect-src 'self'`), 91 assets scanned, clean |
| Development suite (`--config node_modules/.cache/pw-replay.config.mjs`, port 3300, 2 workers) | **547 passed, 35 skipped, 0 failed** of 582 (10.2 min) |
| Isolated production build, then `verify:static -- .next/browser-test` | clean (same scan) |
| Production gate (`PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test`, port 4173) | **34 passed**, 548 skipped (15.0 s) |
| `git diff --check` | clean |

The production gate's overlay check also passed: `perf-*-overlay-camp-360-production.png` in the same screenshot folder shows
the live camp's `camp` phase with the renderer on two lines.

## Concerns

- **Not observed on Linux.** The `__next.*.txt` names on the Pages build are inferred from Next's code and the POSIX-named
  copy. Recommended for 24.2 or 24.8: on the deployed origin, `/replay/` and `/expedition/` show no `__next.*.txt` 404.
- **`/favicon.ico` gets a 404** on every export (no favicon). It is harmless, outside this task, and logged as a console
  error.
- **Records for the controller.** `HANDOFF.md:219` still says to fix the overlay's measurement quality first. The plan's
  Task 24.1 Step 1 lists "histogram stats equal sort-based stats within 1 ms and reset on a scene change", and this task
  covers it. I left both for the integration.
- **The browser check relies on the overlay's 1 s tick.** The phase's age must show 0–4 s on open and close, so a main
  thread blocked over 4 s would fail it. It passed here; under load, rerun it alone before judging.
