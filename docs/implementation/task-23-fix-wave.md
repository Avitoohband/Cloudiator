# Task 23 final fix wave

The controller's ruling on the Task 23 final whole-branch review
(`.superpowers/sdd/2026-10-19-task-23-release-readiness/final-review.md`, `b6bd8c7..d75e3fc`): Important 1, Minors 2–5 and the
M21 `guard_job` note. Every other deferred minor is left as it is. No migration is added, and no committed migration or
function body is changed.

Branch `claude/task-23`, from `d75e3fc`. Commits:
- `d88a27c` fix: render an unknown slot time safely (Minor 4)
- `753af22` test: catch up across the 14-day line in one run (Minor 5)
- `ba07e5a` docs: say why the release views stay security_invoker (Minor 3)
- `e4fb389` docs: renormalize old Windows clones; note the jobs guard follow-up (Minor 2, M21 note)
- `7260b59` docs: bring the release evidence up to the gate of record (Important 1)
- this report (with a one-line reflow in `release-evidence.md`)

## Per item

### 1. Important 1: docs currency

`docs/operations/release-evidence.md` (the review's line numbers checked against `d75e3fc`; new line numbers below):
- `:24` (was `:24`): idle pausing is Task 23.8, built and reviewed (M22); the Task 23.7 figures do not count it.
- `:76–80` (was `:75–78`, also the Task 23.7 review's M5): the gate enforces the database budget at 90 days (both scenarios),
  invocations and raw egress; the one-year figures are recorded as a risk. "Stays green while the blockers are open" is now
  "a plain run never fails on a budget".
- `:89–91` (was `:87`): the release gate passes since Task 23.7 (82.0 % and 69.2 % at 90 days); the one-year figures
  (129.9 %, 107.9 %) remain a named risk with the after-launch compactions.
- `:452–454` (was `:448–449`): the idle pause is built (M22) and shown (23.9); the health report counts
  `cohort.restingCharacters`.
- `:530–546` (new): Lane B subsection for Task 23.9 (presence and resting screens; 360 px shots sent to Avi 2026-10-20, who
  kept the wording) and Task 23.10 (short slot times, Avi's decision 2026-10-20; the time kept on one line, `d75e3fc`).
- `:549–550` (above the old `:527` status): the gate-of-record status, passed at `d75e3fc`, 12 of 12.
- `:737–739` (was `:713–714`): CI has no known blocker; exit 2 is reserved for named known blockers, none listed.
- `:750–751` (was `:725`): Tasks 23.8–23.10 done and reviewed.
- `:850–872` (new): "Gate of record (d75e3fc, 2026-10-20)", the controller's figures (12/12, exit 0: units 1,251, test:db
  299 with `CAPACITY_GATE=1` and the Edge start time unchanged, dev 541/0/35, production 34/0/542, diff clean; Edge 714
  entries refreshed, settled through one recreation), and the earlier `81a57d7` run (11/12; one dev failure beside a
  probable host fault while another worktree's browser suite ran; 3/3 alone).

`.github/workflows/checks.yml:5–6`: exit 2 is reserved for failures that are all named known blockers; none is listed, so
any failure exits 1. `tests/workflow.test.ts` does not pin that comment (4/4 pass), so it is unchanged.

### 2. Minor 2: CRLF in older Windows clones

`docs/operations/migrations.md:1415–1430`, "Fresh checkout": a clone made before `.gitattributes` keeps CRLF working files
after a merge with `git status` clean; with a clean tree run `git rm -r --cached . -q` then `git reset --hard` (or re-clone),
check that `git ls-files --eol` shows `w/lf` for every text file, and apply SQL or run Task 24's `db push` only from an LF
copy. This worktree: 540 `w/lf`, 85 `w/-text` (binary), none CRLF.

### 3. Minor 3: security_invoker comments

`supabase/sql/15-release.sql:110–112` (`public.world_revision`) and `:998–1000` (`public.owner_state`): the view stays
`security_invoker` because its `WITH (security_invoker=true)` clause restates it, not because `create or replace` keeps it.
Both comments sit between top-level statements, outside every function body (the first after the backfill `update`, the
second after `end $$;` of the preceding function). Comments only; no migration changes.

### 4. Minor 4: an unknown slot time

- `src/features/schedule/slot-time.ts:40`: `slotTimeText` returns `''` when `ms` or `nowMs` is not a finite number. `''`
  for both: a time that cannot be placed against the display day is left out by each caller rather than guessed (an
  unknown `nowMs` would otherwise pick a wording from a broken clock; `undefined` formatted the current moment and `null`
  1970).
- Callers render without it:
  - `src/features/character/activity-status.ts:17–18`: the owner's line falls back to "Resting at home." (also used by the
    own Gladiators row and profile card through `CampShell`'s `ownPlace`).
  - `src/features/build/BuildPanel.tsx:63, :95`: the pending build's "Effective …" line is left out.
  - `src/features/schedule/SchedulePanel.tsx:92–97, :114, :118`: a phase's "Estimated next start" line is left out; the
    saved message reads "Saved for {phase} and future occurrences." Not unit-reachable (the estimate and the message exist
    only after mount and a save); by inspection, and the browser gates' normal path is unchanged.
- Tests:
  - `tests/domain/slot-time.test.ts:142` NaN, ±Infinity, `undefined`, `null`, `undefined × slot` and `Number(undefined)`,
    as the time and as the display time;
  - `:151–169` the Build panel renders "Effective {time}" for a real slot and no "Effective" for NaN or `undefined`;
  - `tests/domain/activity-status.test.ts:108` "Resting at home." for NaN, Infinity and `undefined` slots and a NaN or
    Infinity display time; a real time still shown.
- **RED** (before the change): 3 failed, each `RangeError: Invalid time value` from `formatToParts` (slot-time.ts:18) via
  `slotTimeText`, `ownRestingText` and `BuildPanel` render. **GREEN:** 23/23 in those three files.

### 5. Minor 5: one catch-up across the 14-day line

`tests/db/idle.test.ts:227`: one coordinator lease runs boundaries S..S+3 in a row (`runBoundary`, settling between them as
the catch-up's worker does), all decades after their scheduled starts. A character whose last signal puts its 14-day line
exactly at S+2's start is a member of S and S+1 and rests at S+2 and S+3; a recently signalled character plays all four;
both processed slots advance S, S+1, S+2, S+3; one rest row (since S+2, through S+3, no signal).
- Passes on the current code (14/14 in the file).
- **Meaningful:** with the cohort predicate's `>=idle_ms` made `>idle_ms` in `private.boundary_apply_changes` locally (the
  container label checked: `Cloudiator`), the case failed: the crossing character was still a member at S+2. The original
  definition (saved from `pg_get_functiondef` first) was then restored: body md5 `fdf4729d…` before, broken `1ddd6eb6…`,
  restored `fdf4729d…`, with `search_path=""`, the ACL `{postgres=X/postgres,service_role=X/postgres}`, owner and volatility
  unchanged; the file passed 14/14 again.

### 6. M21 note

`docs/operations/migrations.md:160–165`, under `private.guard_job()`: the compaction branch compares the other 19 columns of
`private.jobs` by name (the table has 21, checked on the local database); the next schema change to `private.jobs` must
switch it, in a new migration, to `to_jsonb(new)-'input'-'result' = to_jsonb(old)-'input'-'result'`.

## Verification

Unit and type checks before the gate: `npm test` 1,254 passed (1,251 + the 3 new cases); `npm run typecheck` passed (tsc,
deno check, deno test 2/2). Targeted runs: the three unit files 23/23; `npm run test:db -- tests/db/idle.test.ts` 14/14.

The full gate, `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs --json <scratchpad>/verify-<n>.json`,
on `claude/task-23` at `7260b59` (clean tree, every fix-wave commit but this report), with no other worktree's browser suite
running (only the 3400 preview dev server of another worktree):

| Step | Run 1 (10:46–10:58 UTC) | Run 2 (10:59–11:19 UTC) |
|---|---|---|
| `npm test` | 1,254 passed | 1,254 passed |
| typecheck, assets, build, `verify:static` | passed | passed |
| Edge settled | **infrastructure fault**: the refresh stopped on "modification time changed" for `supabase/functions/node_modules/.deno`; the container had been recreated at 10:47:05, as the step began | 714 files and folders refreshed, 21 links skipped, 612 files read; 34 s; recreated while settling (10:47:05 → 11:00:18) |
| `CAPACITY_GATE=1 npm run test:db` | not run (the Edge step failed) | **passed**: 300; Edge container unchanged (11:00:18) |
| Development browser suite | **failed**: 540 / 1 / 35 | **passed**: 541 / 0 / 35 |
| Production build, its scan, production gate | passed; 34 / 0 / 542 | passed; 34 / 0 / 542 |
| `git diff --check` | clean | clean |
| Exit | 1 | **0 (passed), 12 of 12** |

- **Run 1, Edge step.** The refresh's guard (an entry's modification time read again after its access time is set) found
  `node_modules/.deno` changed during the walk, so the gate failed the step as an infrastructure fault and skipped the
  database tests, as designed. The writer is not established: the Edge container was recreated at 10:47:05, one second into
  the step, and after run 2 the folder's modification time (11:00:06 UTC) falls inside run 2's typecheck (Deno), not at its
  recreation (11:00:18). No product evidence either way.
- **Run 1, development suite.** One failure, `[mobile] market.spec.ts:464` ("leaves the focus and the scroll where they are
  after a pointer trade"): after a pointer click at the Buy button's box the "Confirm purchase" dialog was not visible within
  5 s. The gate did not label it a probable host fault (no request failed in the host's network stack). Run alone
  (`--repeat-each=3`, both projects) it passed 6/6. The fix wave changes no market code (the Market panel uses neither
  `slotTimeText` nor `ownRestingText`). Its trace is kept in this task's scratchpad. Recorded as an unreproduced flake for
  the controller's flake triage, not as product evidence; the gate's no-rerun rule stands, so run 2 is a whole new run.
- Run 2 is the fix wave's evidence: every step passed, with the database run on a settled runtime.

## Concerns

- The Edge refresh can fail when a writer touches `supabase/functions/node_modules/.deno` during its walk (run 1). The guard
  behaved correctly; whether the gate should tolerate that folder is a question for the controller, not changed here.
- The `[mobile] market.spec.ts:464` failure did not reproduce alone; a second occurrence would deserve a look at the click
  timing (the bounding box is read before the click, and the list may re-render between).
- `ownRestingText(slot, undefined)` still takes its `nowMs = 0` default (23.10 M2, left deferred), so an undefined display
  time there shows a 1970-relative wording rather than "Resting at home."; a NaN or Infinity display time is covered.
