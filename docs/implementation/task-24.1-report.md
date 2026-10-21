# Task 24.1 report: hosted-readiness fixes (Lane A)

## Status

**DONE for the Lane A part** of Task 24.1 (plan `docs/superpowers/plans/2026-10-20-task-24-launch.md`, Decisions 1, 9 and 12,
and the carried Task 23.1 M4/M6 and Task 24.0 M1/M3/M6). The frame overlay and the `__next.*.txt` triage are Lane B's and are
not part of this report. No migration was needed or added; no browser suite was run (Lane B may run one; the controller runs the
full gate at integration).

Commits (branch `claude/task-24`, Cloudiator-claude, on `bb2f74d`):
- `75d5369` fix: print setting names only in the access audit
- `e511c3c` ops: load the build env for the security headers
- `7bb8eb4` fix: cache command preflights
- `edc7e2f` ops: add the read-only hosted check kits
- `67fc6d8` test: harden the Edge refresh around the dependency cache
- `5be34b3` ops: note the ledger fold in the hosted trade check (comment only)
- this report: docs: report Task 24.1 (lane A)

## 1. The access audit prints setting names only (23.1 M4, M6)

`scripts/access-audit.sql`'s two finding rows printed raw values: `not-security-invoker` the view's `reloptions`
(`security_barrier=true`), `search-path` the function's `proconfig` (`search_path=public,work_mem=64kB,application_name=…`). They
now print the names only, sorted with collation "C" (`security_barrier`; `application_name,search_path,work_mem`), or
`no options` / `unset`.

- **RED** (`tests/db/access-matrix.test.ts`, the new case "names the settings in a finding row, never their values" and the
  updated search-path expectation): 2 failed on the printed values above.
- **GREEN:** access-matrix 12/12, Edge start time unchanged. The new case also checks that no row of any section contains a
  planted setting value or any `=`.

**Runbook** ("Release access audit"): the hosted comparison now runs step by step in a new folder under the user's temp
directory (never the repository), writes the local CSV with `Set-Content -Encoding utf8` (`>` writes UTF-16 in Windows
PowerShell 5.1), reads both files with `Import-Csv` (so quoting differences do not matter), checks both headers and row counts,
compares with `Compare-Object -CaseSensitive`, lists the differences by section, prints any finding row, and removes the folder.
It compares `select current_schemas(false)` instead of `show search_path`: locally `show search_path` prints
`"\$user", public, extensions` (the local stack stores the backslash), while `current_schemas(false)` prints the resolved
`{public,extensions}`. **Rehearsed** locally with a "hosted" file made from the local one by `Export-Csv` (every field quoted),
one policy hash changed and one platform row added: 619 and 620 rows, and the comparison listed exactly those three lines.

## 2. The security headers load the build environment (Decision 12)

`scripts/build-headers.mjs` read `NEXT_PUBLIC_SUPABASE_URL` from `process.env` only, while `next build` also inlines it from
`.env*` files; a deploy built from `.env.production.local` would have shipped `connect-src 'self'` alone. It now calls Next's own
`@next/env` `loadEnvConfig(cwd, false)` as `next build` does (shell first, then `.env.production.local`, `.env.local`,
`.env.production`, `.env`), prints only the loaded files' names, and refuses a production export without the URL before writing or
removing anything. The browser-test export (`CLOUDIATOR_BROWSER_TEST=true`) keeps its self-only policy. `@next/env` 16.4.0
resolved from `node_modules` (installed with Next); nothing was installed.

`scripts/verify-static.mjs --origin <url>` (before or after the export folder): `_headers`' `connect-src` must name exactly that
origin; another project's origin or none fails, as does an invalid `--origin`, a missing value or an unknown option.

- **RED:** 3 build-headers cases (a production export without a URL exited 0; `.env.production.local` was not read, twice),
  6 static cases (`--origin` ignored) and 2 gate-step cases failed.
- **GREEN:** 108/108 in `tests/scripts/build-headers.test.ts`, `tests/static.test.ts` and `tests/scripts/verify.test.ts`. The
  tests run the script in an empty temporary project folder, so the repository's own `.env*` files never reach them, and pin
  the load order (shell over `.env.production.local` over the others; `.env.development.local` not read).
- **Consequence for the gate:** a plain `npm run build` now exits 1 with "NEXT_PUBLIC_SUPABASE_URL is not set: …" (observed).
  The gate's `out/` build therefore sets the local stack's API origin, and its scan requires it:
  `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build`, then
  `npm run verify:static -- --origin http://127.0.0.1:54321` (`scripts/verify.mjs`; the "Safe order" step 3 of
  `docs/operations/verification-gates.md` says the same; the order is unchanged). `docs/operations/environment.md` documents
  the variable's new role. CI runs `npm run verify`, so it needs no change.

## 3. The command preflight is cacheable (Decision 9)

`supabase/functions/_shared/backend/http.ts` gains `preflightResponse(origin)`: the 204 with the exact-origin grant plus
`Access-Control-Max-Age: 7200` (Chrome's maximum), used by `handleCommand` for OPTIONS. Another origin still gets 403 with no
CORS header; an OPTIONS without an Origin gets no grant and no Max-Age; command answers carry no Max-Age.

- **RED:** the new Node case in `tests/backend/commands.test.ts` (three access-control headers, no Max-Age) and a new Deno case
  in `tests/backend/edge.deno.ts` ("Preflight cache grant failed") failed.
- **GREEN:** `tests/backend` 61/61 under vitest; `edge.deno.ts` 3/3 under the pinned Deno (part of `npm run typecheck`).

## 4. The read-only SQL kits (Decision 1)

- `scripts/schema-fingerprint.sql`: the fingerprint the migration replays compared since Task 13 (scratch copies until now),
  committed as one SELECT that prints one `line` per entry, exactly as the scratch psql copy printed it (`\pset` unaligned,
  `|`, booleans `t`/`f`, NULL empty), in a collation-independent order. Sections: `fn rel col pol trg con idx nsp defacl cron`
  and the seed lines. On the local stack it printed the same 1,160 lines as Task 23.8's scratch copy (sorted, byte-identical),
  and those equal Task 23.8's recorded M01–M22 replay fingerprint (after tests).
- `scripts/hosted-checks.sql`: `section | item | value` rows in nine labelled sections: `parity` (migrations, server version,
  resolved schemas, `pg_net.ttl`, object counts and a function digest), `scheduler` (flag, budget, epoch, current and next
  slot, coordinator, open boundaries, cron jobs, the two Vault secrets by name, lowest processed slot), `dispatch` (per
  scheduled minute over 24 h), `job-attempts` (outcomes, p50/p95/max per kind, failure codes), `boundary-latency`,
  `http-responses` (status codes and counts), `duplicate-grants` (six counts and their total), `characters` (counts,
  identities per provider, newest characters by `md5(account id)` prefix) and `trades` (fee and owner per sale). It prints no
  secret, key, token, email, body or error text.
- `tests/db/hosted-checks.test.ts`: both files run inside `begin read only` (and the harness is shown to refuse a write), every
  section present in order; the hosted checks also run over a real two-account trade (price 101) with both Vault secrets
  planted in a rolled-back transaction: `fee 5`, `seller received 96`, `owners 1, owner buyer`, both secrets `present`, two
  characters for two accounts, `duplicateGrants` 0; a one-coin change to the seller's ledger row is reported; no row contains
  the secret values, an account, character, item or listing id, or `@`.
- **RED:** the test file failed to load (ENOENT: the kits did not exist). **GREEN:** 4/4, Edge start time unchanged.
- The runbook lists both files. Their hosted privileges (`vault.secrets`, `auth.users`, `auth.identities`, `net._http_response`,
  `cron.job` read by the owner in the SQL editor) are untested: there is no hosted project yet.

## 5. Task 24.0 follow-ups (M3, M1, M6)

- **M3:** `scripts/verify.mjs` and `verification-gates.md` say the cache's writer "was not identified".
- **M1:** a pinned test: a junction named `node_modules` directly under the refreshed root is skipped (`skipped: 1`, no
  `tolerated`), its target's access and modification times unchanged, also with the write and removal seams aimed at it. It
  passed as a pin; a mutation that followed links named `node_modules` failed it (count 7 instead of 5, skipped 0).
- **M6:** a cache entry under `node_modules` that vanishes or cannot be opened, read back or listed during the refresh walk, or
  cannot be read during the pre-read, is tolerated and reported (`unavailable`; the note says "dependency cache entries gone or
  unreadable during the walk (tolerated) on N entries: …") and not descended into. Anywhere else the refresh fails naming the
  entry (`cannot open: <path>: …`), and a failed pre-read fails the Edge step as `pre-read failed: <entry>: <code>` instead of
  throwing out of the gate. Test seams: `concurrentRemove` (the walk removes the entry right before opening it) and `read`
  (the pre-read's reader). An entry that exists but cannot be opened takes the same path; it was not simulated separately.
- **RED** (the new tests against the previous `verify.mjs`): 4 failed; the vanished cache file failed the refresh with "The
  system cannot find the file specified". **GREEN:** `verify.test.ts` 40/40 (scratch folders under the temp directory only).

## Verification (2026-10-21, after the host restart)

| Step | Result |
|---|---|
| `npm test` | 65 files, 1275 tests passed |
| `npm run typecheck` | passed (tsc, `deno check`, Deno tests 3/3) |
| `node assets/source/build-assets.mjs --check` | passed (2026-10-20) |
| `npm run build` (no URL) | exit 1 with the new message, as designed |
| `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build` | passed: `connect-src 'self' http://127.0.0.1:54321`, gallery removed |
| `npm run verify:static`, and with `--origin http://127.0.0.1:54321` | both passed, 91 assets |
| `npm run test:db` (Edge refreshed and settled first) | 305 of 305 (20 files), 6 min 46 s; Edge container unchanged across the run (`08:30:08.948Z`) |
| `git diff --check` | clean |

**Discarded runs (infrastructure, not product evidence).** A full database run on 2026-10-20 was killed by the host restart
mid-run. It left a test-only stand-in for `private.planning_now_ms()` installed (a fixed test clock; the test that installs it
restores it in its own cleanup, which never ran). The next run, 2026-10-21 08:21–08:28Z with the Edge start time unchanged,
failed 50 of 305 in 14 files, all on clock-dependent assertions (`nowMs` about 1.49e9 instead of 1.79e12, "cleanup time is in
the future"). The committed fingerprint showed the cause: against Task 23.8's recorded M01–M22 replay, only the
`planning_now_ms` body hash differed (plus the `seed-owner-signals` data count). The function was restored from its
pre-run `pg_get_functiondef` text, reconstructed byte for byte and checked against the hash this session captured on 2026-10-20
before any interrupted run (`b7cc78e6…`; the recorded body has CRLF line endings, as in the Task 23.8 replay), written by node
and applied through the container's psql after the label check. Afterwards its hash, its ACL and the whole fingerprint matched
the record again (data line aside), and the rerun above passed 305/305; the hash was unchanged after it.

## Concerns

- **The gate's `out/` build now carries the local API origin.** It follows from the required loud failure; the verified order
  is unchanged, but the text of step 3 in the approved "Safe order" changed (a command, not a rule). Any developer
  `npm run build` without a URL now fails by design.
- `@next/env` is used through Next's own dependency, not listed in `package.json` (no new package). If a future install stopped
  hoisting it, the import would fail loudly.
- Plan Task 24.4 says "`show search_path` matches"; the runbook now compares `current_schemas(false)` (reason in item 1).
- **Hypothesis, not tested:** in a scratch test a folder listing reported a folder's modification time from before a change
  inside it (a stale time read from the parent's listing), which the walk reported as a change. If NTFS updates listed times
  lazily, Task 24.0's `.deno` change may have been such a stale listing rather than a concurrent writer. Recorded in
  `verification-gates.md` as an observation.
- Both SQL kits are untested on a hosted project (privileges, the SQL editor's row limit).
- A killed database run can leave the clock stand-in behind (above). The fingerprint found it at once; checking
  `planning_now_ms` before a database run after any crash or restart would catch it earlier.
- The local database's `planning_now_ms` body carries CRLF line endings (recorded so in Task 23.8's replay); a clean LF
  replay will hash it differently. Worth knowing before 24.4 compares local and hosted fingerprints.

## Fix round 1 (2026-10-21)

The controller's rulings after review, on `claude/task-24` after Task 24.2's commits (`4e1351c`, `b06d10e`, `6f20661`, kept as
they are). Commits:
- `58904f9` fix: count every seller credit in the hosted checks
- `f0181f6` docs: mark the Task 24.0 vanished-entry limit as superseded
- `6c81c22` fix: recommend the shell URL and resolve @next/env through next
- `4678633` fix: print no setting values or cron commands in the fingerprint
- `726942e` test: give the Edge refresh cases room under the full unit suite
- this section: docs: report Task 24.1 fix round 1

**Important: a sale credited twice aborted the hosted checks.** `scripts/hosted-checks.sql` read the seller's market-sale
credit with a scalar subquery, and market-sale receipts are not unique per listing, so the case duplicate-grants check 6
exists for aborted the whole kit with SQLSTATE 21000. Each sale now sums and counts its seller credits (`:56-63`). A sale reads
"fee right" only with exactly one credit of the price less the fee (`:185-188`), and its row says
`seller received N in K credits`.
- **RED:** a second market-sale receipt and ledger row planted for a sold listing in a rolled-back transaction made the kit fail
  with "more than one row returned by a subquery used as an expression" (psql).
- **GREEN:** the trade case of `tests/db/hosted-checks.test.ts` now plants the same pair in a rolled-back transaction. The kit
  prints every section, check 6 = 1, the total 1, and `seller received 192 in 2 credits, fee right false`.

**Minor 3.** `docs/operations/verification-gates.md:52` keeps the Task 24.0 sentence that a vanished or unopenable cache entry
still fails the step, marked *superseded by Task 24.1*. RED: the doc test's new check that the sentence precedes the 24.1
paragraph failed (the sentence was missing). GREEN: 40/40.

**Minor 4.** The missing-URL error (`scripts/build-headers.mjs:155-161`) and the `NEXT_PUBLIC_SUPABASE_URL` row of
`docs/operations/environment.md` now recommend the shell variable for a local build. Both say `.env.production.local` is also
read by the isolated browser-test build, whose bundle and `_headers` would then carry that URL. RED: the refusal case lacked
both sentences.

**Minor 5.** `@next/env` is now loaded through next's own package (`createRequire` on `next/package.json`,
`scripts/build-headers.mjs:26-31`). That is the copy `next build` uses, with no `package.json` entry and no bare import. The
resolved path is exported as `NEXT_ENV_PATH`. RED: `NEXT_ENV_PATH` was undefined. GREEN: build-headers 22/22; with the static
and deployed tests, 126/126.

**Minor 6.** `scripts/schema-fingerprint.sql` printed function settings (`search_path=""`), view options
(`security_invoker=true`) and every cron job's full command. It now prints:
- the settings and options as their sorted names with an md5 of the values (`search_path md5:<hash>`; `:33-34`, `:39-40`), so
  a changed value still shows;
- only Cloudiator's two cron jobs, with the command hashed (`:78-79`).

RED: the updated fingerprint case and a new rolled-back probe (a function with a planted `application_name`, a
`security_barrier` view and a third cron job) failed on the printed values. GREEN: 5/5; no line contains `search_path=`,
`security_invoker=`, a cron command, the probe's value or the probe job. **The local fingerprint is still 1,160 lines** (both
cron jobs are ours). Its `fn`, `rel` and `cron` lines differ from the scratch fingerprints recorded in Tasks 13–23.8, so a
replay is compared with this file's output from now on.

**Unit-suite timing (observed, fixed).** The first `npm test` of this round failed one Task 24.0 refresh case with "Test timed
out in 5000ms", under the full suite's load. Its seven PowerShell walks take 2.7 s alone, and a rerun passed. The refresh block
now allows 30 s (test-only).

**Verification (2026-10-21).**
- `npm test`: 66 files, 1328 tests.
- `npm run typecheck`: passed (Deno tests 3/3).
- `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build`, `npm run verify:static` and
  `npm run verify:static -- --origin http://127.0.0.1:54321`: passed.
- `npm run test:db`, after the Edge refresh and settle: 306 of 306 (20 files), with the Edge container's start time unchanged
  (`09:16:34.152Z`) across the run. Before it, the `planning_now_ms` hash was still the restored `b7cc78e6…`.
- `git diff --check`: clean.
- No browser suite was run.
