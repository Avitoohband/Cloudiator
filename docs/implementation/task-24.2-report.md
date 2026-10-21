# Task 24.2 report: the deployed acceptance harness (Lane A)

## Status

**DONE** for plan Task 24.2 (`docs/superpowers/plans/2026-10-20-task-24-launch.md`, Decisions 1, 8 and 9), except the
deployment checklist: `docs/operations/deployment.md` is the controller's (drafted separately), so "Running the deployed checks"
is in `docs/operations/runbook.md`, and the checklist should link to it. No SQL, Edge or migration file changed; no database test
was needed or run; no account, key or secret was used.

Commits (branch `claude/task-24`, Cloudiator-claude, on `67130ac`):
- `4e1351c` ops: share the release scan patterns and the _headers reader
- `b06d10e` test: add the deployed acceptance checks
- this report: docs: report Task 24.2

## What was built

- `tests/browser/deployed.spec.ts` and `tests/browser/playwright.deployed.config.ts`: baseURL from the required
  `CLOUDIATOR_DEPLOYED_ORIGIN` (the config refuses to load without it, naming it); desktop and mobile (the phone runs the
  `@browser` check only); no web server; traces, screenshots and video off. Under any other config every check skips.
- The repository config (`playwright.config.ts`) ignores `**/deployed.spec.ts`, so `npm run verify` never runs it.
- Automatic checks (`@automatic`): `fixedRoutesReload`, `securityHeaders`, `connectSrc`, `compression`, `cors`, `anonDenied`,
  `authProvidersGoogleOnly`, `shippedAssetsClean`. Attested (`@attested`): `persistedCharactersForNewGoogleAccount`,
  `completedRealBoundary` (boundaries completed, over 120 s, `duplicateGrants`), `twoAccountTrade` (owners, fee right), read from
  `CLOUDIATOR_ATTEST_*` set from named `scripts/hosted-checks.sql` rows. A missing value fails, naming the variable and row.
- The pure pieces are in `tests/browser/deployed-checks.ts`: env validation, the header comparison against the generated
  `_headers`, the CSP parser, the compression, CORS, worker, denial and Auth-settings verdicts, the chunk crawl's reference
  finder, the publishable-key finder, the shipped-asset scan and the attested values.
- Shared, not copied: the release scan's routes and patterns moved to `scripts/release-scan.mjs` (`forbiddenMaterial`), used by
  `verify-static.mjs` and the deployed scan; the `_headers` reader moved from `serve-static.mjs` to `build-headers.mjs`
  (`parseHeaders`, `headersFor`). Both moves are unchanged code.
- CSP listener: `tests/browser/fixtures.ts` has a `listenForCsp` option (default: the production gate, as before); the deployed
  config turns it on, so every page of every check is watched.
- `anonDenied` probes 14 requests chosen from `tests/db/access-matrix.test.ts` so that none changes anything even if a privilege
  were granted: 7 backend-only or owner RPCs with null arguments, 3 empty inserts, a no-row update and delete, and the `private`
  schema (table and RPC). Zero-argument functions that act (`coordinate_work`, `refresh_projections`) are left out.

## Verification

- **TDD.** The unit tests failed first on the missing modules and exports (`release-scan.mjs`, `parseHeaders`, `consoleError`),
  then passed. A mutation that removed `testIgnore` failed the config test ("development: … to not include 'deployed.spec.ts'").
- **`npm test`:** 1327/1327 (1275 before; 50 new in `tests/deployed.test.ts`, 1 in `tests/static.test.ts`, 1 in
  `tests/scripts/build-headers.test.ts`). The config test runs `playwright test --list` on the gate in both modes and on the
  deployed config, with and without an origin.
- **`npm run typecheck`:** passed (tsc, deno check, 3 Edge tests); the Edge start time was unchanged.
- **Builds and scans:** `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build`, then
  `npm run verify:static -- --origin http://127.0.0.1:54321`: verified, 91 assets. The browser-test export, then
  `npm run verify:static -- .next/browser-test`: verified, 91 assets.
- **`git diff --check`:** clean; every new file is LF.

## Local stand-in results

`scripts/serve-static.mjs` on free ports, with `CLOUDIATOR_SUPABASE_ORIGIN=http://127.0.0.1:54321` (no other browser run in this
worktree).

| Check | `.next/browser-test` (4580) | `out/` (4581) | Hosted expectation |
|---|---|---|---|
| fixedRoutesReload (desktop, mobile) | fail | fail | fails until 23.5 M7 is fixed |
| securityHeaders | pass | pass | to be shown (Pages may add or join headers) |
| connectSrc | fail: `'self'` only | pass | pass with the project build |
| compression | fail: nothing compressed | fail | Pages compresses (24.6 shows it) |
| cors | fail | fail | to be shown in 24.5 |
| anonDenied | fail: no key in the bundle | fail: no key | runs with the deployed key |
| authProvidersGoogleOnly | fail: no key | fail: no key | Google only after 24.3 |
| shippedAssetsClean | pass | pass | pass |
| attested (3) | fail: not attested | fail: not attested | set after 24.8 |

- **fixedRoutesReload:** the only errors were 404s for `/game/__next.game.__PAGE__.txt` (an App Router prefetch) on `/replay/`
  and `/expedition/`, on every load: the known Task 23.5 M7 (Lane B's `__next.*.txt` triage). The export has
  `game/__next.game/__PAGE__.txt` instead. The check also found the browser's `/favicon.ico` 404 (the site has no icon). That
  one is recorded as an annotation, not failed (see Concerns).
- **cors:** the local Kong gateway (2.8.1) answers every preflight to `/functions/v1/game-command` itself with 200,
  `Access-Control-Allow-Origin: *` and no Max-Age, before the function, for any origin. So the local stack cannot stand in for
  this check, and the handler's exact-origin grant and Max-Age (Task 24.1) never reach a browser locally. The worker part
  passed: 401 `unauthenticated` without a secret.
- **anonDenied, end to end, with a made-up key:** I injected an invented `sb_publishable_…` string into a scratch copy of `out/`
  and served it on 4582. `anonDenied` passed against the local stack, and `authProvidersGoogleOnly` failed only on "Google is not
  enabled". Against a closed port, both failed with one masked line. The key was in no output or `test-results` file.
  Unmasked, Playwright's error printed the key: its call log lists `apikey: …`. The masking is therefore needed, and it works.
  A keyless script also ran all 14 probes against the local PostgREST (local Kong serves the Data API without a key): 12 got
  42501 and 2 got PGRST106.
- **Attested, with made-up values:** the three pass with the acceptance values. `duplicateGrants: 2` failed as
  "duplicateGrants is 2, expected 0".

## Concerns

1. **Favicon.** The deployed site will 404 `/favicon.ico`. It is recorded, not failed. Adding an icon is a product choice
   for Avi (it would remove the 404).
2. **23.5 M7 blocks `fixedRoutesReload`** (the `__next.*.txt` prefetch 404s) until Lane B's triage lands.
3. **Hosted header joining is untested.** If Pages adds its own `nosniff` or `Referrer-Policy` beside `_headers`', the
   exact comparison fails ("nosniff, nosniff"). Judge that from 24.6's evidence.
4. **Private Playwright configs** that do not spread the repository config (for example `pw-claude`, `pw-replay`) now list the
   deployed checks as skipped. They are not run: a scratch config with another baseURL skipped all 11, with or without
   `CLOUDIATOR_DEPLOYED_ORIGIN` set.
5. Data API compression (plan 24.6) is not checked. Small responses may legitimately come back uncompressed; 24.9's egress
   measurement covers it.
