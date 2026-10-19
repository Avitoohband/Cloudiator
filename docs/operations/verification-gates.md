# Verification gate order

Approved by Avi on 2026-10-14 as a persistent project override for the Superpowers `verification-before-completion` skill. See the "Build and browser output separation" section of `AGENTS.md`.

`npm run verify` (`scripts/verify.mjs`, Task 23.6) runs the whole gate below in this order and ends with one summary. Pass
`--config <private Playwright config>` or `--dev-port <n> --static-port <n>` to run it beside another worktree's servers.

## Safe order in one worktree

1. `npm test` and `npm run typecheck` (no Next output).
2. `node assets/source/build-assets.mjs --check`.
3. `npm run build` (it also writes `out/_headers` and drops the art gallery: `scripts/build-headers.mjs`), then `npm run verify:static`.
4. The database tests: `CAPACITY_GATE=1 npm run test:db`, after the Edge runtime has settled (see "Database tests and the local Edge runtime").
5. The development browser suite (`npx playwright test`, or a private config on its own port). Wait until it has finished and its dev server has exited.
6. The isolated production gate, only after step 5: `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build` (without the test publishable key: `next.config.ts` refuses it), then `npm run verify:static -- .next/browser-test`, then `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test`. The static host applies the export's own `_headers`, and every browser spec fails on a Content-Security-Policy violation there (`tests/browser/fixtures.ts`).
7. `git diff --check`.

Never start a build in a worktree whose development browser run or dev server is still active. Run the gate steps in that worktree one after another.

`npm run verify` runs every step whose input is valid, even after another one failed, and skips a step only when a step it needs did not pass (the scan of a failed build, the production browser gate of a failed production build, the database tests on an Edge runtime that does not serve). Its exit code is 0 when every step passed, 2 when the only failures are known blockers (named in the summary, never a pass; today the database budget, owned by Task 23.7), and 1 otherwise.

## The rule

A Next.js build or export and a browser check must not use the same output directory at the same time.
- The Playwright development server runs with `CLOUDIATOR_BROWSER_TEST=true`, so its output is `.next/browser-test/dev`.
- The isolated production build writes `.next/browser-test` and removes the `dev` output inside it.
- The ordinary production build writes `.next` and `out/`.

## Database tests and the local Edge runtime

Approved by Avi on 2026-10-14 as part of this override.

- Run `npm run test:db` only while nothing else builds, runs a browser suite or edits files in the worktree whose `supabase functions serve` the Edge runtime uses.
- Record the Edge container's start time before and after the run:
  `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator`.
- If the start time changed, the container was recreated during the run. Discard that run as an infrastructure fault, and rerun once nothing else is active.

**Observed (2026-10-14, Task 16 phases 2a and 2b).** The CLI killed and recreated the Edge container a few seconds into several DB runs. One in-network request was then refused (for example 123/124). The serve log showed "File change detected (WRITE)" for Edge source files that git showed unchanged, while vitest, `tsc` or `deno check` were reading them. Other recreations coincided with a build export or the dev server.

**Tested (2026-10-14).** Every rerun with an unchanged start time passed (124/124, then 137/137). Keeping other work out of the serving worktree during the run was a precaution taken from these observations, not a proven fix.

**Observed cause (2026-10-19, controller).** NTFS last-access updates are enabled on the development host (system managed; NTFS updates a file's access time at most about once an hour). A run that reads Edge source not read within the last hour updates its access time; the `supabase functions serve` watcher (CLI 2.120.0, which has no no-watch option) reports "File change detected … (WRITE)" for the unmodified file and recreates the container. Reading every file under `supabase/functions` reproduced a recreation within 20 s.

**Mitigation in `npm run verify`.** Before the database tests it sets the last-access time of `supabase/functions` and every folder and file under it to now (Windows only; `SetFileTime` through a handle that asks only for attribute writes, so the watcher's open folders do not block it; no other timestamp or content changes), reads every file, waits until the container's start time has been stable for 30 s and the worker answers an unauthenticated request with its own refusal, then runs the tests and compares the start time before and after. A changed start time discards the run (an infrastructure fault) and the run is repeated once on a settled runtime. System settings (the last-access policy) are not changed: that is the machine owner's choice.
- **Tested once (controller, 2026-10-19):** a full read, a settled runtime, then `test:db` 275/275 with the start time unchanged.
- **Why a read alone is not enough (Task 23.6, observed):** NTFS keeps a read's access-time update only when the stored time is over an hour old. A full read at 15:08 left files read at about 14:23 unrefreshed; they aged past the hour and changed again at 15:24 and 15:26, when the next reads came. Folders behave the same when listed: a build's listing of `_shared` at 16:10:57 recreated the container. Such an entry read during a database run recreates the container mid-run.
- **Tested (Task 23.6, 2026-10-19):** setting every file's access time to now raised 37 "File change detected … (WRITE)" lines and one recreation; a full read one minute later raised none and left the start time unchanged. With folders included (735 entries) it raised 34 lines and one recreation; a full listing and read 40 s later raised none. The gate runs are in `docs/operations/release-evidence.md`.

**Host network faults in the browser steps (C21 triage).** A browser run whose every failed test names a request that failed in the host's network stack (Chrome's `net::ERR_NO_BUFFER_SPACE`, `ERR_INSUFFICIENT_RESOURCES` or `ERR_ADDRESS_IN_USE`; `tests/browser/host-faults.ts`) is no product evidence: `npm run verify` discards it and runs the step once more, and the summary reports the discarded run. Any other failure is a failure.

**The stack.** `npm run verify` never starts, stops or resets the local stack. When Docker or the stack restarts, the `supabase functions serve` process exits with it; the Edge step then fails as an infrastructure fault and names the command to start it again (in the serving worktree, output to a file, one process at a time).

## Parallel work

Separate git worktrees have separate `.next` directories. They may run gates at the same time as long as each uses its own Playwright port and its own static server port (`PLAYWRIGHT_DEV_PORT`, `PLAYWRIGHT_STATIC_PORT` for the repository configuration; `CLOUDIATOR_STATIC_PORT` for `scripts/serve-static.mjs`).

## Evidence

- **Observed 2026-10-14 (Task 15 integration):** a build during a browser run removed `.next/browser-test/dev` and caused 12 infrastructure failures.
- **Tested fix:** the serialized 22-case rerun passed, and the root build-then-browser production gate passed 8 cases.
- **How to report:** a failure caused by overlapping output is an infrastructure fault, not product evidence. Rerun the gate in order before reporting results.
