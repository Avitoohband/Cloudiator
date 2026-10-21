# Verification gate order

Approved by Avi on 2026-10-14 as a persistent project override for the Superpowers `verification-before-completion` skill. See the "Build and browser output separation" section of `AGENTS.md`.

## The rule

A Next.js build or export and a browser check must not use the same output directory at the same time.
- The Playwright development server runs with `CLOUDIATOR_BROWSER_TEST=true`, so its output is `.next/browser-test/dev`.
- The isolated production build (`CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`) writes `.next/browser-test` and removes the `dev` output inside it.
- The ordinary `npm run build` writes `.next` and `out/`.

## Safe order in one worktree

1. `npm test` and `npm run typecheck` (no Next output).
2. `node assets/source/build-assets.mjs --check`.
3. `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build`, then `npm run verify:static -- --origin http://127.0.0.1:54321`. Since Task 24.1 a production export without a Supabase URL fails (`scripts/build-headers.mjs`), so the gate builds `out/` for the local stack's API origin and the scan requires that origin in `connect-src`.
4. The development browser suite (`npx playwright test`, or a private config on its own port). Wait until it has finished and its dev server has exited.
5. The isolated production gate, only after step 4: the `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true` build, `npm run verify:static -- .next/browser-test`, then `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test`.
6. `git diff --check`.

Never start a build in a worktree whose development browser run or dev server is still active. Run the gate steps in that worktree one after another. Do not edit source files in a worktree while its browser suite runs (Task 23.5 lesson; approved by Avi on 2026-10-20).

## Database tests and the local Edge runtime

Approved by Avi on 2026-10-14 as part of this override.
Extended with Avi's approval on 2026-10-19 (Task 23.6): the last-access refresh before the database tests.

- Run `npm run test:db` only while nothing else builds, runs a browser suite or edits files in the worktree whose `supabase functions serve` the Edge runtime uses.
- Record the Edge container's start time before and after the run:
  `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator`.
- If the start time changed, the container was recreated during the run. Discard that run as an infrastructure fault, and rerun once nothing else is active.

**Observed (2026-10-14, Task 16 phases 2a and 2b).** The CLI killed and recreated the Edge container a few seconds into several DB runs. One in-network request was then refused (for example 123/124). The serve log showed "File change detected (WRITE)" for Edge source files that git showed unchanged, while vitest, `tsc` or `deno check` were reading them. Other recreations coincided with a build export or the dev server. The cause is not confirmed.

**Tested.** Every rerun with an unchanged start time passed (124/124, then 137/137). Keeping other work out of the serving worktree during the run is a precaution taken from these observations; it is not a proven fix.

**Observed cause (2026-10-19, controller).** NTFS last-access updates are enabled on the development host (system managed; NTFS updates an entry's access time at most about once an hour). A run that reads Edge source not read within the last hour updates its access time; the `supabase functions serve` watcher (CLI 2.120.0, which has no no-watch option) reports "File change detected … (WRITE)" for the unmodified file and recreates the container. Reading every file under `supabase/functions` reproduced a recreation within 20 s.

**Tested once (controller, 2026-10-19).** Every file under `supabase/functions` read, the runtime settled, then `test:db` passed 275/275 with the start time unchanged.

**Observed (Task 23.6, 2026-10-19): a read alone is not enough.** NTFS keeps a read's (or a folder listing's) access-time update only when the stored time is over an hour old. A full read at 15:08 left files read at about 14:23 unrefreshed; they changed at 15:24 and 15:26, when the next reads came after they passed the hour. A build's listing of the folder `_shared` recreated the container at 16:10:57. Such an entry read during a database run recreates the container mid-run, whatever the earlier read did.

**Mitigation in `npm run verify` (`scripts/verify.mjs`).** Before the database tests it prepares the Edge source, then settles the runtime:
1. On Windows it sets the last-access time of `supabase/functions` and of every folder and file under it to now: `SetFileTime` through a handle that asks only for attribute writes (so the watcher's open folders do not block it) and opens a link itself, never its target (`FILE_FLAG_OPEN_REPARSE_POINT`). A link (any reparse point: junction, symbolic link) is skipped and never descended into; every entry must lie under the resolved `supabase/functions`; every entry's modification time is checked unchanged (the dependency cache excepted, below). No content and no other timestamp changes, and no system setting (the last-access policy is the machine owner's choice).
2. It reads every file.
3. It waits until the container's start time has been stable for 30 s and the worker answers an unauthenticated request with its own refusal.

A refresh that fails (an error, an entry outside the folder, a changed modification time outside the dependency cache), or a worker that does not answer (for example after the stack restarted and `supabase functions serve` exited with it), fails the Edge step as an infrastructure fault with its reason, and the database tests do not run. The gate never starts, stops or resets the stack. Around the database run it compares the start time before and after: a changed start time discards the run (an infrastructure fault), and the run is repeated at most once, on a settled runtime. Only the database run is ever repeated; no browser step is.

**Observed 2026-10-20 (Task 24.0): the dependency cache changed during the walk.** A gate run failed its Edge step, and the database step did not run, because the modification time of `supabase/functions/node_modules/.deno` changed during the refresh walk. That folder is Deno's dependency cache (`nodeModulesDir: "auto"` in `deno.json`); the writer was not identified. The modification-time check exists to show that the refresh itself changes no source file, and a cache whose entries change during the walk cannot show that.

**Tested (Task 24.0, 2026-10-20; scratch folders).** The refresh still sets the access times of `supabase/functions/node_modules` and everything below it, but a modification-time change under `supabase/functions/node_modules` (Deno's dependency cache) is tolerated: it is reported in the Edge step note (how many entries, and the first five) and is no failure. It was tested with a simulated concurrent write to `node_modules/.deno`, to `node_modules` itself and to a file below it. The same change to any other entry, including a nested `node_modules` and a sibling whose name only starts with `node_modules`, still fails the Edge step with the entry's path: everywhere else it still fails the step. Links, the resolved-root check and the rest of the guard are unchanged. A cache entry that disappears or cannot be opened during the walk is not covered by this change and still fails the step. *(Superseded by Task 24.1, below: such a cache entry is now tolerated.)*

**Tested (Task 24.1, 2026-10-20; scratch folders).** A cache entry that vanishes during the refresh walk or the pre-read is tolerated too: it is reported in the Edge step note as gone or unreadable (how many, and the first five), and the walk does not descend into it. It was tested with a file below `node_modules/.deno`, with `.deno` and with `node_modules` itself removed right before the walk opened them, and with a cache file whose read failed. The same removal anywhere else (a folder, a file, `deno.json`, a nested `node_modules`, `node_modules_old`) fails the Edge step naming the entry (`cannot open: <path>: …`), and a failed read elsewhere fails it as `pre-read failed: <entry>: <code>`. An entry that exists but cannot be opened takes the same path; that case was not simulated separately. A junction named `node_modules` directly under the folder is still skipped as a link, with nothing tolerated and its target untouched (a pinned test, which failed when a mutation followed such a link).

**Observed in a scratch test (Task 24.1), not tested as a cause.** A folder listing can report a folder's modification time from before a recent change inside it: after the times of `_shared` were set and a folder was then created inside it, the walk read a stale time for `_shared` from the parent's listing and failed with `modification time changed`, although nothing changed during the walk; setting the times again after the creation removed it. If NTFS updates the listed time lazily, the Task 24.0 `.deno` change may have been such a stale listing rather than a concurrent writer. This is a hypothesis.

**Tested (Task 23.6, 2026-10-19).**
- Setting every file's access time to now raised 37 "File change detected … (WRITE)" lines and one recreation; a full read one minute later raised none and left the start time unchanged.
- With folders included it raised 34 lines and one recreation; a full listing and read 40 s later raised none.
- In a scratch folder: a junction inside is skipped and its target's access time is unchanged; a missing folder fails the refresh with its reason.
- The gate runs, each with the start time unchanged across the database run, are in `docs/operations/release-evidence.md`.

## Parallel work

Separate git worktrees have separate `.next` directories. They may run gates at the same time as long as each uses its own Playwright port and its own static server port.

## Evidence

- **Observed 2026-10-14 (Task 15 integration):** a build during a browser run removed `.next/browser-test/dev` and caused 12 infrastructure failures.
- **Tested fix:** the serialized 22-case rerun passed, and the root build-then-browser production gate passed 8 cases.
- **How to report:** a failure caused by overlapping output is an infrastructure fault, not product evidence. Rerun the gate in order before reporting results.
