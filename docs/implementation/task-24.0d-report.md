# Task 24.0d report: CI skips the development browser suite; time zones pinned in the expedition time tests (Lane B)

## Status

**DONE.** Lane B gates below, all green. No database, SQL or Edge change. Nothing pushed, no branch switched, and no GitHub
Actions run triggered (the CI run 39588134783 was only read, with `gh run view`).

Commits (branch `claude/task-24-ui2`, Cloudiator-replay, on `f3e7bf1`):
- `cdc97c4` ci: run every gate step except the development browser suite on GitHub
- `f55ee59` test: pin the time zone in the expedition time tests
- this report: docs: report Task 24.0d (with the CI note in `docs/operations/release-evidence.md` and a line in `HANDOFF.md`)

## Evidence

CI run 39588134783 on `f3e7bf1` failed in two steps; every other step passed (db 312, production 34). The run's results are
recorded in [release-evidence.md](../operations/release-evidence.md) ("The second CI run and the development browser step").
In short: the unit step failed one test (`tests/domain/expedition-view.test.ts`, 1 failed, 1,380 passed, 10 skipped), and the
development browser step failed 50 tests in 52.0 min (355 passed, 29 skipped) with the 148 `@render` runs already left out:
40 were 30 s test timeouts and 10 were assertions on timing-sensitive state, in 19 files.

## Part 1: CI does not run the development browser suite (the controller's ruling, 2026-10-21)

**Switch.** One variable, `CLOUDIATOR_CI=github`, set by `.github/workflows/checks.yml` on the release-gate step only (the
renamed `CLOUDIATOR_CI_RENDER`, which no longer describes what it does). `onCi()` in `scripts/verify.mjs` reads it: unset or
empty is every other run; any other value throws before the gate starts. GitHub's own `CI` and `GITHUB_ACTIONS` change
nothing, so a local run with `CI=true` still runs every step.

**Behaviour.** `gateSteps({ ci: true })` marks the `browser` step `notRun: { label: 'development browser suite', reason:
'runner too slow' }`. `runGate` reports it without running it: status `not run on CI`, duration 0, note "development browser
suite not run on CI (runner too slow); the local gate of record runs it", and a log line at its place in the order. The result
line names it beside any failures, never a bare PASSED. Every other step runs, the isolated production build and the
production browser gate included. The exit code is 0 when everything else passes (1 or 2 as before otherwise).

The summary from a fake-runner run (every step passing) in CI mode:

```
  passed         db              CAPACITY_GATE=1 npm run test:db  [0 s]  312 passed; Edge container unchanged (t)
  not run on CI  browser         npx playwright test  [0 s]  development browser suite not run on CI (runner too slow); the local gate of record runs it
  passed         browser-build   CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build  [0 s]
  passed         production      PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test  [0 s]
Result: PASSED (development browser suite not run on CI); exit 0
```

(Excerpt: the other steps are `passed` as usual. The real gate was not run in CI mode; this is the fake-runner output of the
unit tests' own path, printed by a scratch script, and `tests/scripts/verify.test.ts` pins every line.)

**The 24.0c tag mechanism: removed; the tags kept as documentation.** Deleted `scripts/ci-render.mjs`; `playwright.config.ts`
is back to its pre-24.0c form (no `grepInvert`); `scripts/verify.mjs` lost `exclude`, `excludeRender`, `countExcluded` and
`countListed`. This was the smaller clean change: the 74 `{ tag: '@render' }` annotations in 13 spec files stay (no spec
edit beyond the one test below), they document which tests are render-bound, and Playwright filters on them natively:
`npx playwright test --list --grep @render` lists 148 of the 582 tests, `--grep-invert @render` the other 434 (run
2026-10-21, matching the Task 24.0c count). Nothing reads them in a gate, so there is no half-used path.

**Tests.**
- `tests/scripts/verify.test.ts`: the "CI render exclusion" block (6 cases) is replaced by "the CI exception" (7 cases, fake
  runner): only the browser step is marked and only when asked, and no other step differs; the step is not executed, its line
  and the result line say so, exit 0; beside a failed production gate the result is `FAILED (1 step failed; development
  browser suite not run on CI)`; beside a known blocker `BLOCKED (...)`, exit 2; without the exception every step runs and
  nothing is said; `onCi` accepts `github` only, refuses `true`, `1`, `yes`, `GitHub` and `exclude`, and ignores `CI` and
  `GITHUB_ACTIONS`; no step carries the variable.
- `tests/scripts/playwright-config.test.ts`: reduced to the invariant that no test is ever left out of a run that happens: no
  `grep` or `grepInvert` on the config or either project in a local run, the production gate, `CLOUDIATOR_CI=github`, and the
  retired `CLOUDIATOR_CI_RENDER=exclude`; only `deployed.spec.ts` is ignored.
- `tests/workflow.test.ts`: `CLOUDIATOR_CI: github` on the release-gate step only, set once, no `CLOUDIATOR_CI_RENDER`; the
  step's comment says why (controller's CI exception, too slow, not run on CI, never silently, 39588134783, gate of record,
  production gate).

`docs/operations/verification-gates.md` is unchanged: its Avi-approved rule text does not contain the summary wording.

## Part 2: the time zone in the expedition time tests

**Unit test** (`tests/domain/expedition-view.test.ts`). **RED:** `TZ=UTC npx vitest run tests/domain/expedition-view.test.ts`
failed with CI's message (`expected '<time dateTime="2026-10-20T04:20:00.0…' not to contain '04:20'`; received
`<time dateTime="2026-10-20T04:20:00.000Z">4:20 AM</time>`). Cause: the assertion read the whole markup, and the machine-readable
instant holds `04:20` in UTC. **Fix:** the file sets `process.env.TZ = 'Asia/Jerusalem'` at load (restored in `afterAll`, with a
`beforeAll` check of the offset, as `slot-time.test.ts` does) and the assertion now compares the shown text only (tags
stripped), which also checks it equals `slotTimeText`. **GREEN:** passed under `TZ=UTC`, Asia/Jerusalem,
America/Los_Angeles, Pacific/Auckland and Asia/Kolkata.

**Browser test** (`tests/browser/expedition.spec.ts`, "shows each stage start in the activity log short, on one line at 360
px"). Playwright's browser takes its zone from `timezoneId`, not from `TZ` on Windows, so a scratch config gave five desktop
projects one zone each (Berlin, UTC, Tokyo, New York, Jerusalem). **RED:** only Berlin failed: the fixture's first stages start
at 11:20 PM on 9 October there and the display time is past midnight, so the starts read "Oct 9, 11:20 PM", their rows are
wider, and the label edges differ (3 distinct left edges instead of 1). **Fix:** the test moved into a nested describe
`the stage times in the activity log` with `test.use({ timezoneId: 'Asia/Jerusalem', locale: 'en-US' })` (in Jerusalem all
stages and the display time are on 10 October). **GREEN:** the same five projects all passed, Berlin included (the describe's
`use` overrides the project's). The test keeps its `@render` tag; its stale "(the CI exception)" comment words were dropped.

## Verification (Lane B, after the changes; the runs used the working tree that the two commits hold, plus the docs)

| Gate | Result |
| --- | --- |
| `npm test` | 70 files, **1,391 passed** |
| `TZ=UTC npm test` (CI's zone; the log's clock read 12:35 against 15:34 local) | 70 files, **1,391 passed** |
| `npm run typecheck` | passed (exit 0; the Deno edge tests 3 passed) |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build`, `npm run verify:static -- --origin http://127.0.0.1:54321` | passed; 5 fixed routes, `connect-src 'self' http://127.0.0.1:54321`, 91 assets scanned |
| development browser suite, private config on port 3300 | **547 passed, 57 skipped**, 10.1 min, exit 0 |
| isolated production gate (build, `verify:static .next/browser-test`, port 4173) | **34 passed** (548 skipped), scan passed |
| `git diff --check` | clean |

`npm run test:db` was not run: no SQL or Edge change, and the gate's database step is untouched. The private Playwright config
(`node_modules/.cache/pw-replay.config.mjs`, untracked) imported the deleted `scripts/ci-render.mjs`; it was edited to drop that
import (and the scratch five-zone config was deleted afterwards).

## Concerns

- **Not observed on CI.** No GitHub Actions run with this change exists. The controller pushes and records it. Expect the
  release gate's summary to show `not run on CI` for the browser step and `Result: PASSED (development browser suite not run on
  CI)`.
- **What CI no longer proves.** The development browser suite (547 tests locally) runs only in the local gate of record. The
  production gate (34) still runs on CI and covers the exported build only.
- **The 10 non-timeout failures of run 39588134783** (poll counts in the live-camp, tournament and read-render tests, a focus, a
  rail reveal, a replay attribute) are attributed by the controller to the slow runner. They did not occur in this lane's
  local run (547 passed); they have not been reproduced under load either, so a real timing flake is not excluded.
- **Other host-zone dependence.** The unit suite passed under `TZ=UTC`, but only the one browser test with a known dependence
  was run under other zones; other browser tests may still assume the host zone (many already pin one with `test.use`).
- **Status string.** The JSON results (`--json`) carry `status: "not run on CI"` for that step, and a `label`; a consumer that
  assumed only `passed`, `failed`, `infrastructure`, `blocked` and `skipped` would see a new value. None exists in the repository.
