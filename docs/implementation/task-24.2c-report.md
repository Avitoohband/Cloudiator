# Task 24.2c report: the Lane A hardening checkpoint

## Status

**DONE** for Task 24.2c (the deferred review minors that help the hosted steps; plan
`docs/superpowers/plans/2026-10-20-task-24-launch.md`). No migration, Edge function or workflow changed; no account, key or
secret was used; nothing hosted was contacted; the other worktrees were not touched; nothing was pushed.

Commits (branch `claude/task-24`, Cloudiator-claude, on `715e2a7`):
- `65e9dd7` ops: report a bench marker in the hosted checks (item 1)
- `3e71c62` fix: state the CI-skipped step at the top of verify.json (item 2)
- `00ff77d` docs: tidy the Task 24 wording and env advice (items 3, 4 and 5)
- this report: docs: report Task 24.2c

## Item 1: the production "no bench marker" row (Task 24.2b review)

`scripts/hosted-checks.sql` gains the `parity` row 14, `bench marker`. It reads `absent`, or `present (comment)`,
`present (schema)` or `present (comment, schema)`. The comment test is exactly the seed's (`= 'cloudiator-bench'`, an empty
comment counted as none); the schema test is `to_regnamespace('cloudiator_bench_marker')`. Any other comment text is never
printed (the platform's default comment on `postgres` is one: the local database carries `default administrative connection
database`, which the row does not show). It is one more branch of the same single SELECT, so the kit stays read-only.

- **RED:** `npm run test:db -- tests/db/hosted-checks.test.ts`: 1 failed, 5 passed. `markerRow(absent)` was `[]`, expected the
  row `bench marker | absent` (Edge start time `2026-10-22T08:44:18.011471249Z` before and after).
- **GREEN:** 6 passed. The new case checks: absent by default; `present (comment)` and `present (schema)` and `present
  (comment, schema)` with the marks planted inside a transaction that always rolls back; a random other comment and the near
  miss `'cloudiator-bench '` read `absent` and the random text never appears in any row; the row is in `parity` only and all nine
  sections are still printed; the local database is unmarked before and after (queried outside the transaction).
- Also run once through the container with `psql --csv`: the row printed `parity,bench marker,absent`, exit 0.
- **Docs:** `docs/operations/deployment.md`, Parity step 2, no longer asks Avi for a separate query: the kit's row is the check
  (Claude reads it in step 3, which now lists `bench marker` `absent` and says anything else stops the run). The old one-liner
  stays there as the fallback "only if that kit cannot run on production". `docs/operations/runbook.md` ("Production must carry
  neither marker") and its kit description say the same. The bench is marked only later, in its seeding step, so at the Parity
  step the row reads `absent` on both projects.

## Item 2: `verify.json` states the CI not-run step (Task 24.0d, M2)

`scripts/verify.mjs` now builds the `--json` document with a new exported `gateReport(results, summary, startedAt, finishedAt)`.
Its top level keeps `startedAt`, `finishedAt`, `status` and `exitCode`, and gains `resultLine` (the summary's own last line, for
example `Result: PASSED (development browser suite not run on CI); exit 0`) and `notRun` (`[{ id: 'browser', label: 'development
browser suite', note: '…not run on CI (runner too slow); the local gate of record runs it' }]`, and `[]` when every step ran).
`status` stays `passed`, so a consumer that reads it alone sees what it always saw; one that reads the top level sees the rest.
`summarize()` now also returns `resultLine`. `results` is unchanged.

- **RED:** 3 new cases in `tests/scripts/verify.test.ts` failed with `TypeError: gateReport is not a function`.
- **GREEN:** the CI document's top level equals the expected object and mentions `not run on CI`; the same beside a failed
  production gate (`FAILED (1 step failed; …)`, exit 1) and a known blocker (`BLOCKED (…); 1 known blocker`, exit 2); a local run
  has `notRun: []` and `Result: PASSED; exit 0`.
- `docs/operations/release-evidence.md` (CI workflow) says it in one sentence. Not run: the real gate in CI mode (as in 24.0d).

## Item 3: the render-tag wording (Task 24.0d, M3)

"74 `@render` annotations" and "74 `@render` tags" now read "74 tests (72 annotations, 148 runs)" in the 24.0d report,
`docs/operations/release-evidence.md` and `docs/implementation/HANDOFF.md` (24.0c entry). Checked 2026-10-22 with
`npx playwright test --list --grep @render` (148 tests in 13 files, so 74 tests in two projects) and a count of
`tag: '@render'` (72). Other places already said "74 tests" or "148 runs" and were not touched.

## Item 4: the `.env` warning (Task 24.1 minor)

The `scripts/build-headers.mjs` error now says "Any .env file that next build reads (.env.production.local, .env.local,
.env.production, .env) is also read by the isolated browser-test build, whose bundle and _headers would then carry that URL.
Keep the URL in the shell variable, out of those files." The shell variable is still the first recommendation. The
`docs/operations/environment.md` row for `NEXT_PUBLIC_SUPABASE_URL` says the same.

- **RED:** the pinned message test in `tests/scripts/build-headers.test.ts` failed (the old text named only
  `.env.production.local`). The test now pins the new sentence and that neither the old "Avoid .env.production.local for this"
  nor "`.env.production.local` is also read" remains.
- **GREEN:** 72 passed in the two script test files (verify and build-headers).

## Item 5: the runbook fingerprint provenance (Task 24.1 minor)

`docs/operations/runbook.md` keeps "the fingerprint the migration replays compared since Task 13" and adds the caveat: since
Task 24.1 its `fn`, `rel` and `cron` lines print names and md5 hashes (settings and options as names plus an md5 of the values,
a cron job's command as an md5), so compare it only with an output of the same script, never with a scratch copy's lines from
before. Checked against `scripts/schema-fingerprint.sql` (lines 32–41 and 78).

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 70 files, 1394 tests passed |
| `npm run typecheck` | exit 0 (`tsc`, `deno check`, 3 Edge deno tests) |
| `npm run test:db` | 21 files, 313 tests passed. Edge refresh and settle first (`recreatedWhileSettling: true`, the expected one recreation, then 33 s stable, worker answering); start time `2026-10-22T08:48:12.042608508Z` before and after, so the run stands |
| `git diff --check` | clean |

`npm test`, `npm run typecheck` and `npm run test:db` ran on the tree with items 1, 2 and 4 complete; items 3 and 5 are
documentation only, which no test reads (`tests/deployed.test.ts` reads only the runbook's "Running the deployed checks" section,
and `tests/scripts/verify.test.ts` reads `verification-gates.md`). `npm test` and `git diff --check` were repeated on the final
tree. No browser suite ran, as the task said. No file was edited while `test:db` ran.

## Concerns

- **Hosted privileges.** `shobj_description` and `pg_database` are readable by any role, and `to_regnamespace` returns null for
  a missing schema, so the new row should run wherever the kit runs. Like the rest of the kit it has not run on a hosted project.
- **Exact comparison.** A comment that only resembles the marker (a trailing space, another case) reads `absent`, as the seed
  would also refuse it. A production comment of that kind would not be flagged; none is expected.
- **`resultLine` and `notRun` are new top-level fields.** No consumer exists in the repository (the workflow only uploads the
  file as an artifact).
