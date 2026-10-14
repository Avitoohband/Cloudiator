# Task 16 independent review: phase 2b and the timing fix rounds

Date: 2026-10-14. Reviewers: two fresh Claude reviewer subagents, read-only on the worktree, using the local Supabase stack "Cloudiator" for a clean replay and the DB suites. The earlier phases have their own records: [phase 1](task-16-phase-1-review.md) and [phase 2a](task-16-phase-2a-review.md).

## Verdict

**Task 16 is complete: specification Pass, code quality Pass, ready to merge.** One limit is recorded for Task 23: boundary publication at 50 characters takes 121 s in the held-window case.

Range on `claude/task-16-p2`, from `1d6a482`:
- `31cfdaa`: feature, with migration M10 `20261014131209_arena_bouts.sql`.
- `deda395`: report.
- `61af251`: the approved database-test rule.
- `337f38d` and `a1c6732`: the timing fix.
- `cf325d1` and `ee44626`: the scoped re-review fixes.
- The commit that adds this record.

## Round 1: full review of phase 2b (`1d6a482..deda395`)

**Reviewer evidence:**
- `npm test` 883 passed; typecheck clean.
- Clean replay of M01–M10. All 10 M10 function bodies are byte-identical to `08-arena-bouts.sql`: security invoker, empty `search_path`, ACL `{postgres, service_role}`.
  - `arena_results`: RLS, backend only, `guard_frozen`.
  - `arena_standings`: RLS, authenticated read only.
  - The standings view is `security_invoker`.
- `db lint` clean; advisors INFO only.
- `test:db` 137/137 with a stable Edge container.
- Build and static scan: 5 routes, 91 assets. Dev browser: 260 passed. Production gate: 14 passed.

**Strengths named:**
- One simulation per battle, run from the frozen assignment only.
- The worker dispatches on an explicit kind, and anything else fails as `unsupported-executor`.
- Strict fenced acceptance that freezes the log and outcomes once.
- Settlement one side at a time:
  - lock order account, gladiator, wallet, items, the side's own rating row, activity, job;
  - the clock is sampled after all locks;
  - a frozen-versus-live rating mismatch goes to operator state;
  - counters move for human bouts only;
  - renown only, through `safe_settlement`.
- Stages match the Task 17 UI exactly.
- Standings are an invoker view with public columns only and a `season:rank` cursor.
- The tests are real: 32 forged results rejected per battle, lock-wait regressions proved with `pg_blocking_pids`, and real Task 6 and Task 8 commands.

**Verdicts:** spec Pass, quality Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| I1 | The timing was measured with a 1 s scheduler tick. Production runs once a minute and dispatches at most 5 invocations per rolling minute. | Important | `337f38d`: a new DB test runs three consecutive 50-entrant slots through the real `cron_tick()` and Edge worker, with the clock stepping one minute per tick. The steady-state slots settle the previous slot first. `runWorker` now claims the pairing jobs its own coordination released (RED: P+1 at 120 950 ms). Measured: cleared window, published at 61.1 s; held window, published at 121.0 s. |
| M1 | The post-release operator check named the job kinds inconsistently. | Minor | `a1c6732`: `prepare`, `pair` and `simulation` everywhere. |
| M2 | The latest-season probe read the ranked view. | Minor | `337f38d`: it reads `arena_standings`. |

**Rulings:**
- The TDD deviations are accepted: 13 SQL and 2 TypeScript mutations were caught, including the required pre-lock-clock RED.
- Edge recreations: an infrastructure fault.
- Accepted design choices:
  - outcomes stored at acceptance are used for settlement;
  - the "Results credited" stage is written by the crediting settlement;
  - a rating mismatch goes straight to operator state;
  - NPCs are named "<League> Sentinel";
  - `seasonId ''` until the first rating row exists;
  - the DB test aliases;
  - 50-row page detection.
- M09, M10 and the worker must ship together (Task 24).

## Round 2: scoped re-review of the timing fix (`61af251..a1c6732`)

**Reviewer evidence:**
- `npm test` 885 passed; typecheck clean.
- `test:db` 137/137 with Edge stable. Timings reproduced: P published at 0.50 s, P+1 at 61.14 s, P+2 at 121.06 s.
- `arena-live` browser 2/2; build and static scan clean.

**Verdicts:** spec Pass, quality Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| 1 | The held-window rationale was wrong: the "102 jobs" count put pairing against the simple cap, which the fix had moved outside it. | Important | `ee44626`. With the fix, the held window needs exactly 100 jobs, which is 5 × 20. It misses at N = 50 because the global settlement barrier fragments the cutoff tick. A zero-slack worker change could in principle reach about 61 s. Only above 50 characters is it arithmetically impossible. A robust fix needs a policy decision (Task 23). |
| 2 | The "count the budget per scheduled minute" option was not assessed. | Minor | `ee44626`. It fixes the held case up to 100 characters without raising the monthly ceiling (about 216 000 invocations per 30 days, under both the 300 000 and 500 000 limits). It matches spec §10.4. Its costs are bursts of up to 10 invocations within 60 s and a new migration. The test needs realistic tick offsets to verify it. |
| 3 | The batch-limit wording was inaccurate. | Minor | `ee44626`: an invocation can now run up to 25 simple-kind jobs, 20 simple plus up to 5 pairing. **The controller accepted this interpretation on 2026-10-14:** pairing jobs are cheap, capped at 5, and run only right after their own coordination. |
| 4 | Claiming 5 pairing jobs at once could strand one on its lease after a deferral. | Minor | `cf325d1`: one pairing job is claimed at a time, with the CPU check before each (RED: one claim of 5). |
| 5 | No negative test for the claim made after the simple loop. | Minor | `cf325d1`: nothing is claimed when the coordination waits on `preparation`. |
| 6 | Cold-P times were reported as single values. | Nit | `ee44626`: given as ranges. |

**Controller check of `cf325d1` and `ee44626`:**
- The implementer's gate: 888 unit tests, typecheck, `test:db` 137/137 with a stable Edge (one passing run discarded after a recreation), build and static scan, dev browser 260 passed.
- Measured publication times: cold 0.20–0.40 s, cleared 61.12–61.13 s, held 121.04–121.05 s.
- The controller then ran the isolated production gate on `ee44626`: 14 passed, 254 skipped by design.

## Gates carried forward

- **Task 23:**
  - decide the held-window policy; per-minute budget accounting is the assessed option;
  - measure the hosted `dispatch_log` spacing and CPU per invocation (up to 25 jobs).
- **Task 24:**
  - ship M09, M10 and the worker in one release step, then check for `prepare`, `pair` and `simulation` jobs in operator state;
  - set the season epoch no later than the first boundary with members.
- **Task 19 phase 2:** human tournament bouts must enter the pairing history.
- **Task 21:** season close builds on the epoch and the rating rows.
- **Task 22:** retention order: results, sides, assignments, pairing jobs.
