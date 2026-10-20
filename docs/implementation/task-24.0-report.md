# Task 24.0 report: the release gate's Edge refresh tolerates dependency caches (Lane A)

## Status

**DONE for the Lane A part** (Decision 10 of the Task 24 plan). The gate run of record is 11 of 12 steps passed; the one failed step
is the development browser suite, whose six failures all passed when rerun alone (see "Verification"). No database, SQL, Edge or
product change. The market-click flake (Lane B, 24.0b) is not part of this report.

Commits (branch `claude/task-24`, Cloudiator-claude, on `b1fd34e`):
- `d842208` test: make the release gate robust to dependency caches (`scripts/verify.mjs`, `tests/scripts/verify.test.ts`,
  `docs/operations/verification-gates.md`)
- this report: docs: report Task 24.0 (lane A)

## The defect

`npm run verify` sets the last-access time of every entry under `supabase/functions` before the database tests and fails the Edge
step (an infrastructure fault) when an entry's modification time changed during the walk. **Observed 2026-10-20:** a gate run
failed that step because `supabase/functions/node_modules/.deno` (Deno's dependency cache; `deno.json` has
`nodeModulesDir: "auto"`) changed its modification time mid-walk, so the database step was skipped. The writer was not identified,
and still is not (see Concerns).

## What changed

**`scripts/verify.mjs`.** `refreshAccessTimes` still sets the access time of every folder and file under the resolved root,
including everything under `node_modules`, but a changed modification time on the folder `node_modules` directly under the root
or on anything below it is counted, not thrown. The PowerShell walk now computes each entry's path relative to the root and
compares its first segment with `node_modules` (case-insensitive, whole segment, so a nested `_shared/node_modules` and a sibling
`node_modules_old` are not the cache). One walk handles both cases; a separate pass was not needed.
- Result shape: `{ ok: true, count, skipped }`, plus `tolerated: { count, examples }` only when something was tolerated
  (`examples` are the first five paths relative to the root, with `/`). Existing assertions are unchanged.
- `prepareEdge` and `settleEdge` carry `tolerated` through (the `--json` result keeps it in the step's `edge` object), and the
  Edge step note says: `modification time changed under the dependency cache (tolerated) on N entries: a, b, …`. The step is
  `passed`.
- Unchanged: Windows only; reparse points skipped and never followed; every entry asserted under the resolved root; a changed
  modification time outside the cache, and every other failure, fails the Edge step with its reason.
- Test seam: `refreshAccessTimes(directory, { concurrentWrite })` (and `prepareEdge(directory, refreshOptions)` passing it on)
  names a path relative to the root whose modification time the walk changes right after setting its access time, as a
  concurrent writer would. The gate passes none. It exists because a real race cannot be made deterministic.

**`docs/operations/verification-gates.md`**, "Database tests and the local Edge runtime": two clauses of the mitigation text
qualified ("the dependency cache excepted, below"; "outside the dependency cache"), and two new paragraphs, **Observed
2026-10-20 (Task 24.0)** and **Tested (Task 24.0, 2026-10-20; scratch folders)**. The doc test in `verify.test.ts` checks four
phrases of them.

## RED, then GREEN

Tests (Windows, scratch folders under the temp directory only):
- (a) a mid-walk change to `node_modules/.deno` inside the refreshed root passes `refreshAccessTimes` and `prepareEdge`, is
  reported, and the cache entries' access times were still refreshed; the same for `node_modules` itself and for a file below it.
- (b) a mid-walk change to `_shared`, `_shared/domain`, a file below it, `deno.json`, a nested `_shared/node_modules`, and a
  look-alike sibling `node_modules_old` still fails with `modification time changed: <path>`; `prepareEdge` fails with
  `access-time refresh failed: …`.
- (c) no change during the walk reports no `tolerated` key.
- (d) a fake runner whose Edge step carries `tolerated` still passes the gate (exit 0) and the step note names the entries
  (a note with more entries than listed examples ends with an ellipsis, a one-entry note does not).
- (e) the doc test: four new phrases.

**RED** (before the implementation; the test seam existed): 4 failed, 30 passed. The failures were the real defect and nothing
else: (a) `ok: false`, `reason: "modification time changed: …\node_modules\.deno"` (and the same for `node_modules` itself), (d) the note lacked the tolerated text, (e) the doc lacked the phrases. (b) and (c) passed already, as expected: they pin
behaviour that does not change. A first run of (b) failed on the test's own path comparison (the temp folder's 8.3 short name
`AVI_OP~1` against the long name in the message); the assertion now compares the entry's own tail.

**GREEN:** `tests/scripts/verify.test.ts` 34 of 34; `npm test` 65 files, 1259 tests; `npm run typecheck` (tsc, `deno check`, the Deno
test) passed.

**Mutation check of (b):** with the cache predicate temporarily made universal, the "still fails anywhere else" test failed
(`_shared: expected { ok: true, … }`); the file was restored from a copy (a search found no trace of the mutation).

## Verification

`node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs` (private ports 3200; 2026-10-20 16:52 to 17:36 UTC; the
Edge serve process already ran from this worktree, no second one was started; nothing was edited while the database tests or a
browser suite ran):

| Step | Result |
|---|---|
| unit, typecheck, assets, build, static | passed (11 s, 2 s, 2 s, 6 s, 1 s) |
| edge | **passed (36 s):** access times refreshed on 714 files and folders (21 links skipped); **`modification time changed under the dependency cache (tolerated) on 1 entry: node_modules/.deno`**; 612 files pre-read; container recreated while settling (`16:51:52Z -> 16:52:44Z`, the access-time refresh's known effect), settled in 34 s |
| db | passed: 300 of 300 (19 files), 8 min 55 s, Edge container unchanged (`16:52:44.87966375Z`) across the run |
| browser (development) | **failed:** 535 passed, 35 skipped, 6 failed, 33.3 min |
| browser-build, browser-static, production | passed (18 s, 1 s, 34 passed in 20 s) |
| diff | passed |

The Edge step's tolerated line is the 2026-10-20 failure recurring on a real run: with the old code that run would have failed
the Edge step and skipped all 300 database tests.

**The six development-browser failures** (none in code this task touches):
- `[desktop] identity.spec.ts` "two signed-in tabs converge…", `[desktop] identity.spec.ts` "validates names…", `[mobile]
  release.spec.ts` "pins the rail, a menu frame…": test timeout of 90 s;
- `[mobile] identity.spec.ts` "two signed-in tabs converge…", `[mobile] market.spec.ts:464` "leaves the focus and the scroll where
  they are after a pointer trade", `[desktop] release.spec.ts` "closes a private menu… when the session expires": a visibility or
  text assertion failed.
The gate labelled none of them a host network fault (no request failure was recorded). The run took 33 minutes; after it, port
3300 was listening, that is, the Cloudiator-replay worktree's own browser suite was running on the same host, so host load is the
probable cause. This is stated as probable, not proven.

**Rerun alone** (`pw-claude.config.mjs`, a separate `--output`, only those five titles, both projects): **10 of 10 passed in
27.8 s**. The mobile
`market.spec.ts:464` failure is the known flake that Lane B's 24.0b root-causes; it passed alone. This is therefore **not** a
clean 12-of-12 run: the Edge fix is shown by the Edge and database steps; the browser step needs a quiet-host rerun before the
gate is relied on as a whole.

## Concerns

1. **Not covered:** a cache entry that disappears or cannot be opened during the walk (Deno removing a file between the folder
   listing and the visit) still fails the refresh with its reason, and the pre-read step (`preRead`, which reads every file) would
   throw on a file that vanished in between. Neither happened or was tested; Decision 10 names modification times only.
2. **Interpretation:** the tolerance includes the folder `supabase/functions/node_modules` itself, not only what is below it
   (a new top-level cache entry changes that folder's own modification time). Said in the doc and tested.
3. The writer of the cache changes is still unidentified (Deno's own tooling or an editor extension are candidates; nothing was
   investigated beyond this).
4. `docs/operations/release-evidence.md` was not touched (the plan lists it for the CI run record in the 24.0 step, which is not
   this lane's part). AGENTS.md's mirror of the database-test rule does not mention the modification-time check, so it needed no
   change.
