# Task 23.6 report: the release gate (Lane A)

**Status:** DONE_WITH_CONCERNS. The gate is built and runs end to end; its final run exits 2 (blocked), and the only failure is
the expected database budget (Task 23.7). Concerns 1 and 2 need the controller's ruling.
Branch `claude/task-23` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base `a2ed84a`. Commits: `c9dc6f4` ops: add the release gate and
its evidence; this report, docs: report Task 23.6.

Brief: `.superpowers/sdd/2026-10-19-task-23-release-readiness/task-23.6-brief.md`, with the controller's amendments 1–9: no
push, no migration, the capacity blocker expected and named, the C22 pre-read and settle, triage of C21 and
`market.spec.ts:463`, C23 including the DB-test dumps, CSP violations failing the production gate, private ports, and this
report in place of `task-23-report.md`. The evidence is `docs/operations/release-evidence.md`, "Release gate (Task 23.6)".

## What I implemented

- **`scripts/verify.mjs` behind `npm run verify` (R3).** It runs every gate of `docs/operations/verification-gates.md` in
  order, one after another: unit, typecheck, assets, build, static scan, Edge settle, `CAPACITY_GATE=1 npm run test:db`, the
  development browser suite, the isolated production build, its scan, the production browser gate, `git diff --check`.
  - Every step whose input is valid runs after a failure. Only dependents are skipped: the scan of a failed build, the
    production gate of a failed production build, the database tests on an Edge runtime that does not serve.
  - One summary. Exit 0 when all passed, 2 when only known blockers failed, 1 otherwise.
  - Known blockers are a named table. Today it holds only the database budget: `tests/db/capacity.test.ts`, where every failure
    must be one of its four database checks. It is owned by Task 23.7. Any other failure, in that case or elsewhere, is a
    failure.
  - The database result comes from vitest's JSON report, and the browser results from Playwright's (`--reporter=list,json`).
  - Ports and configuration are options (`--config`, `--dev-port`, `--static-port`, `--results`). The repository
    configuration reads `PLAYWRIGHT_DEV_PORT` and `PLAYWRIGHT_STATIC_PORT` (defaults 3100 and 4173).
  - It never starts, stops or resets Docker or the stack, and it prints no credential.
- **C22 in the gate.** Before the database tests it sets the access time of `supabase/functions` and of every folder and file
  under it to now. This is Windows only, through `SetFileTime` on a handle that asks only for attribute writes, and each
  entry's modification time is checked unchanged. It then reads every file and waits for a start time stable for 30 s and for
  the worker's own 401. A start time that changes across the run discards it as an infrastructure fault, and the run is
  repeated once. The refresh goes beyond the ruled pre-read; Concern 1 explains why.
- **C21 in the gate.** `tests/browser/host-faults.ts` names the host network errors: `net::ERR_NO_BUFFER_SPACE`,
  `ERR_INSUFFICIENT_RESOURCES` and `ERR_ADDRESS_IN_USE`. The browser fixture adds a marked error to a failed test whose context
  saw one, and the gate discards a browser run whose every failure carries that mark, then runs it once more. Each browser step
  keeps its own results (`test-results/development`, `test-results/production`).
- **Decision 7 headers.** `npm run build` runs `next build && node scripts/build-headers.mjs`.
  - The script writes `_headers` with the exact policy. `connect-src` is `'self'` plus only the build's
    `https://<project>.supabase.co` or a loopback `http` origin; any other URL is refused before anything is written.
  - It also removes `assets/gallery.html` (Decision 2).
  - `scripts/serve-static.mjs` applies `_headers` as Cloudflare Pages does, never serves the file itself, refuses an export
    without it, and takes `CLOUDIATOR_STATIC_PORT`.
  - The private copy `node_modules/.cache/serve-static-3200.mjs` was refreshed: the same file with default port 3200.
- **Scanner (C27).** `scripts/verify-static.mjs` now requires `_headers` to be exactly the generated file for an allowed origin.
  It refuses the gallery, any JWT, and `service_role` encoded in base64 or base64url at each of the three byte alignments.
- **CSP listener.** All 22 browser specs now import `test` and `expect` from `tests/browser/fixtures.ts` (21 import lines
  changed, plus the new `csp.spec.ts`).
  - In the production gate the fixture records `securitypolicyviolation` events and Chrome's console reports, and fails the test
    on any.
  - `tests/browser/csp.spec.ts` checks the served headers on the five routes, and that the camp and a replay page load without
    a violation.
  - It also checks that a blocked `fetch` is recorded, with the automatic check switched off for that case only.
- **CI.** `.github/workflows/checks.yml`: a fresh local stack, a generated worker secret, the Edge serve, `npm run verify`, and
  the results as an artifact. Not pushed or run (amendment 1).
- **C23.**
  - The ten console dumps go through `tests/fixtures/measurements.ts`, behind `CLOUDIATOR_MEASUREMENTS=1`.
  - The capacity sections no longer print under `CAPACITY_GATE=1`.
  - `NO_COLOR` is removed from the gate's child processes.
  - vitest's caching hint is silenced by stating the default, `fsModuleCache: false`.
  - `git diff --check` runs with `core.safecrlf=false`.
- **R6.** `tests/rule-retention.test.ts` checks the migrations statically; `tests/db/rule-retention.test.ts` checks the catalog.
  No migration was added (amendment 2).
- **Docs.**
  - `verification-gates.md`: the order with `test:db` and `npm run verify`, the C22 finding and the refresh, host faults, and
    the stack rule.
  - `environment.md`: the new variables and ports.
  - `release-evidence.md`: the new section, and a corrected Lane A line on when capacity sections print.

## TDD (RED first, for the right reason)

- **New tests failed before the code existed:** the scanner, `build-headers`, `serve-static` and `verify` test files could not
  load (module not found).
- **`tests/harness.test.ts` failed on the old tree:** 21 specs bypassed the listener, and the suites made 10 console calls.
- **`tests/workflow.test.ts` failed:** there was no workflow.
- **`csp.spec.ts` failed 4 of 6 against the old static host** (no header). A temporary test that made a violation failed through
  the automatic check, and was deleted afterwards.
- **`tests/db/rule-retention.test.ts` failed 2 of 2** with a planted `v99` version row and a planted unpinned `rules_version`
  column. Both plants were removed and the test then passed.
- **`tests/rule-retention.test.ts` passes on the real history.** Its synthetic cases show each rule fires; no migration violates
  them.
- **The folder access-time test failed on the files-only refresh** ("expected 2 to be 5"), then passed.
- **Not RED first:** the browser-fault cases of `verify.test.ts` were written with `classifyBrowser` and failed on import only.

## Verification

`npm run verify -- --config node_modules/.cache/pw-claude.config.mjs`, run four times (the table is in the evidence).

| Run | Result |
|---|---|
| **Run 4 (final, 16:17–16:33)** | Exit 2 (blocked): every step passed except the known blocker. Unit 1,204. The Edge step refreshed 735 entries and settled in 34 s through one recreation; the start time was unchanged across `test:db` (276 passed, plus the blocker). Development 527/0/31, production 30/0/528, diff clean. |
| Run 3 | Exit 2: every step passed but the known blocker (unit 1,203; dev 527/0/31; production 30/0/528). |
| Run 1 | Exit 1: one production failure, an infrastructure fault (`net::ERR_NO_BUFFER_SPACE` on a framework chunk). |
| Run 2 | Exit 1: one development failure; the camp was not ready within 45 s while Docker Desktop failed. |

- **The blocker:** the four database checks, 150.6–178.6 % at 90 days and 227.7–274.5 % after one year, across runs.
- **Edge:** the start time was unchanged across every database run.
- **Unit and types:** `npm test` (1,204) and `tsc --noEmit` are clean on the final tree.
- **Audit:** `npm audit` found 0 vulnerabilities. `npm ls --all` exited 0 (2 extraneous local packages).
- **YAML:** the workflow parses (PyYAML).

## Concerns

1. **C22: the ruled pre-read leaves a gap; I added an access-time refresh. It needs a ruling.** A read, or a folder listing,
   does not refresh an access time younger than an hour (observed). Files read at about 14:23 were not refreshed by run 1's
   full read at 15:08, and changed at 15:24 and 15:26. The `_shared` folder recreated the container at 16:10:57. Setting the
   access times explicitly closed the gap when tested on its own (then 0 detections on a full listing and read) and in
   runs 3 and 4. It changes metadata only, not a setting. Keep it, or return to the read-only pre-read.
2. **C21: likely the same host network fault as run 1, not proven.** No product code is involved. The gate now names such
   faults and reruns once. A rerun is new behaviour; rule on keeping it. The cause of `ERR_NO_BUFFER_SPACE` is unknown: port
   exhaustion is not supported, with a peak of 1,488 `TIME_WAIT` sockets of 16,384 ports.
3. **Docker Desktop failed during run 2** at about 15:36, and the Edge serve exited. The gate did not cause it. I restarted the
   serve as you allowed (15:45:35; the output is in my scratchpad, not printed).
4. **`market.spec.ts:463` and `release.spec.ts:517`** are recorded; neither was reproduced.
5. **Actions are pinned to major tags, not SHAs.** The workflow will be red until Task 23.7.
6. **`verification-gates.md` is Avi's approved override.** I extended it with `npm run verify`, `test:db` in the order, and the
   C22 refresh; it needs confirmation.

## Skill upkeep

Avi, shall I update AGENTS.md — "Build and browser output separation" — to say that, before `npm run test:db`, the serving
worktree's `supabase/functions` access times are refreshed (as `npm run verify` does), because a read alone leaves entries read
within the hour to change mid-run? (Proposal only; the guide `verification-gates.md` already records it.)
