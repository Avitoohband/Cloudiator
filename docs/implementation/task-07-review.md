# Task 7 independent specification and quality review

Date: 2026-10-12. Reviewer: a fresh Claude reviewer subagent, read-only on the worktree, running the local Supabase stack only. The same procedure was used for the scoped re-review of the fix pass, by a second fresh reviewer.

## Verdict

**Specification compliant; code quality Pass; ready to merge** after the fix pass recorded below.
- Range: `9b39edc..92eec27` (source `0dea40c`, report `5919999`, review fixes `8aa29e5` with migration M04 `20261012143533_task7_review_fixes.sql`, report update `92eec27`).

## Round 1 (range `9b39edc..5919999`)

**Reviewer evidence:** `npm test` 232 passed; typecheck clean (tsc, Deno check of `game-command` and `game-worker`, 2 Deno runtime tests); clean `db reset` replaying M01–M03 followed by `npm run test:db` 55/55, including the real Edge HTTP, pg_cron and pg_net tests; `db lint` clean; advisors only the 4 INFO unused-index notices; `git diff --check` clean. M03 was compared with the SQL source after the replay: all 29 function bodies, volatility, `STRICT`, empty `search_path`, no `SECURITY DEFINER`, ACLs (`postgres` and `service_role` only; `dispatch_workers`/`cron_tick` `postgres` only), table columns and defaults, the three triggers, the 11 private `backend_only` policies and the `owner_read` policy, table ACLs, `owner_state` `security_invoker=true`, the seed rows, the `cloudiator-coordinate` cron job and the extension schemas. Nothing was missing.

**Strengths named:** the eight boundary phases are persisted and each phase commits atomically (an injected-crash test proves rollback); a real global barrier (phase 1 waits for every previous-slot activity; the cohort freezes only after season close; one cutoff per slot; snapshots read `schedule_revisions` by effective slot); once-only charging with a permanent `settled_slots` checkpoint; solid fencing (`SKIP LOCKED`, 120 s leases, token rotation on reclaim, immutable job identity/input/seed/version, idempotent replay with `newGrants: 0`); constant-time worker auth that rejects the publishable key directly and through the gateway; tests that drive the real SQL, the real worker through the real RPC adapter, real Edge HTTP, real pg_cron and real pg_net.

**Verdicts:** spec Pass with one gap, quality Pass, ready **with fixes**.

| # | Finding | Severity | Resolution in `8aa29e5` |
| --- | --- | --- | --- |
| I1 | A job whose third lease expired never reached operator state: the sweep lived only in `claim_jobs`, `dispatch_workers` ignored exhausted jobs, and the barriers checked only `status='operator'`, so a crash on attempt 3 stalled the world as `wait:'settlement'`; the test hid it with a manual 4th claim. | Important | `private.sweep_exhausted_leases(now_ms)` (SKIP LOCKED) runs at the start of `claim_jobs`, `advance_boundary` and `coordinate_work`, before the busy check. The test now asserts `advance` reports `wait:'operator'` with no extra claim; it failed first. |
| M1 | `settle_activity` hard-coded `completed/success/expired`; the `settle_rewards` hook returned only `CreditedRewards`, so Tasks 9 and 16 would have had to replace the public RPC. | Minor | Implemented: the hook returns `{rewards, result, success, replayExpiry, ratingDelta?}`; `settle_activity` validates it fail-closed and adds the identity fields. |
| M2 | No job dependency ids or gating (spec 10.3); the worker claims settlement before reveal. | Minor | Recorded as a Task 9/19 gate. |
| M3 | Two independent seeds (`activity_snapshots.seed`, `jobs.seed`). | Minor | Implemented: the snapshot seed is authoritative and is copied onto activity jobs. |
| M4 | `guard_job` allowed `completed` back to `pending` and result changes after completion. | Minor | A status machine: `completed` is terminal and the result is writable only on `leased→completed`. Tested. |
| M5 | `coordinate_work` ran up to 6 boundaries in one transaction; one deterministic failure rolled back all of them, left `wait_reason` stale, and made every worker return 503. | Minor | Per-boundary subtransaction reporting `{ok:false, code:'boundary-failed', slotIndex, sqlstate}`; the boundary row records `wait_reason='error'` and a sqlstate, never raw error text; cleared on the next clean pass. `runWorker` catches a coordinate failure and still claims. Tested. |
| M6 | Lease renewal happens only before execution and uses the worker clock. | Minor | Recorded as a Task 9 combat gate. |
| M7 | `replayExpiry {state:'expired'}` on Training/Rest reads as "animation no longer kept". | Minor | Recorded as a Task 10/13 contract gate (a non-replay state). |
| M8 | Test gaps: no coordinator-level stamina-clamp test with a pending build; `report.failed` counted even when the `fail` RPC threw; the relaxed Task 6 concurrency assertion was weak in one branch. | Minor | A coordinator-level clamp test (expected 100/80 versus the no-clamp 104/84); `WorkerReport.unrecorded`; exactly one `operation_receipts` row per operation id. |

The reviewer judged the earlier relaxation of the Task 6 concurrency test correct: any of three concurrent requests may take the account lock first, so "exactly one of two distinct operations commits" plus the reserved fees and held reservation is the right assertion.

**Declined to judge:** the 2-minute target at 50 characters (Task 23 hosted benchmark); hosted pg_cron/pg_net dispatch and Vault provisioning (Task 24); retention and pruning (Task 22); the browser suite (excluded by the dispatch); whether the "TypeScript prepare job in phase 4" ruling is the right architecture (an accepted controller ruling, implemented consistently).

## Round 2: scoped re-review of the fix pass (range `5919999..92eec27`)

A second fresh reviewer reproduced: `npm test` 234 passed; typecheck clean; clean `db reset` replaying M01–M04 then `npm run test:db` 61 passed; `db lint` clean; advisors only the 4 INFO unused-index notices.

**Confirmed:** Important 1 is fixed. `private.sweep_exhausted_leases` touches only `leased` jobs whose lease expired with `attempts >= max_attempts`, runs before the busy check in `coordinate_work`, and the phase 1, phase 4 and busy-path tests were RED on the old code. M4, M5, M8a–c, M1 and M3 each have a discriminating test. After the replay, all 30 Task 7 function bodies match across source, M04 and the database; every one of the 24 functions M04 re-emits is identical to M03; `anon`/`authenticated` lack EXECUTE and `service_role` has it; the widened `wait_reason` check is validated; the migrations directory gained only the new file. The two inherited test corrections are right (104 −20 Training, +1 point with no refill, −20 Training = 64; a collation-independent receipt map). The sweep introduces no race: unexpired leases are never touched, and expired ones were already fenced.

**Verdicts:** spec Pass, quality Pass, **ready to merge: Yes.**

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | `settle_activity` stores every key the hook returns in the owner-readable summary, and the inner `rewards` shape, `ratingDelta` type and `replayExpiry` variants are not checked. Not a live leak: the Task 7 hook returns only known keys. | Recorded as a **Task 9 gate**: before Task 9 adds its hook, project a whitelist with `jsonb_build_object` and validate the inner shapes. |
| 2 | The fail-closed branch of the summary validation has no test. | Recorded with gate 1: Task 9 adds a malformed-hook test (RPC throws, no `settled_slots` row, no grant, job fails). |
| 3 | When a boundary fails before its row is inserted, only the coordinator records the failure. | Accepted behaviour; the report's wording was too absolute and is noted here. |
| 4 | The `coordinate_work` sweep locks job rows before the coordinator row. No cycle exists today. | Recorded: document this lock-order exception in the SQL header with the next change to that source. |
| 5 | A test replaces a production function in the shared local database; a killed run leaves the stand-in until the next reset. | Accepted test-hygiene risk; every verification starts from a clean reset. |

**Declined to judge:** the browser suite (not run), hosted cron/pg_net (Task 24), the per-minute sweep cost on a large jobs table (unmeasured), the M7 `replayExpiry` presentation.

## Accepted limitations (from the report)

- Expedition and Arena boundaries stall truthfully until Tasks 9 and 16 add executors; a live world with the default afternoon Woodland expedition stalls at its first afternoon boundary until Task 9.
- Hosted scheduling (Vault secrets, function secret, `verify_jwt=false` deploy, enabling `private.scheduler`, proving hosted pg_cron and pg_net dispatch) is Task 24.
- Performance is unmeasured (Task 23). Pruning of `cron.job_run_details` and completed jobs is Task 22.
