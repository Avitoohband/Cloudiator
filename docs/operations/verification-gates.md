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
3. `npm run build`, then `npm run verify:static`.
4. The development browser suite (`npx playwright test`, or a private config on its own port). Wait until it has finished and its dev server has exited.
5. The isolated production gate, only after step 4: the `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true` build, `npm run verify:static -- .next/browser-test`, then `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test`.
6. `git diff --check`.

Never start a build in a worktree whose development browser run or dev server is still active. Run the gate steps in that worktree one after another.

## Database tests and the local Edge runtime

Approved by Avi on 2026-10-14 as part of this override.

- Run `npm run test:db` only while nothing else builds, runs a browser suite or edits files in the worktree whose `supabase functions serve` the Edge runtime uses.
- Record the Edge container's start time before and after the run:
  `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator`.
- If the start time changed, the container was recreated during the run. Discard that run as an infrastructure fault, and rerun once nothing else is active.

**Observed (2026-10-14, Task 16 phases 2a and 2b).** The CLI killed and recreated the Edge container a few seconds into several DB runs. One in-network request was then refused (for example 123/124). The serve log showed "File change detected (WRITE)" for Edge source files that git showed unchanged, while vitest, `tsc` or `deno check` were reading them. Other recreations coincided with a build export or the dev server. The cause is not confirmed.

**Tested.** Every rerun with an unchanged start time passed (124/124, then 137/137). Keeping other work out of the serving worktree during the run is a precaution taken from these observations; it is not a proven fix.

## Parallel work

Separate git worktrees have separate `.next` directories. They may run gates at the same time as long as each uses its own Playwright port and its own static server port.

## Evidence

- **Observed 2026-10-14 (Task 15 integration):** a build during a browser run removed `.next/browser-test/dev` and caused 12 infrastructure failures.
- **Tested fix:** the serialized 22-case rerun passed, and the root build-then-browser production gate passed 8 cases.
- **How to report:** a failure caused by overlapping output is an infrastructure fault, not product evidence. Rerun the gate in order before reporting results.
