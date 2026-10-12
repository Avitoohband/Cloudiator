# Task 7 implementation report

Status: **DONE_WITH_CONCERNS**. Ordered boundaries, Training/Rest settlement, fenced jobs, worker authentication and bounded recovery are complete and verified locally. The concerns are:
- Expedition, Arena, Tournament, season close and projections remain explicit integration gates for Tasks 9, 16, 19, 21 and 10.
- Hosted scheduling and dispatch proof remains a Task 24 gate.

Date: 2026-10-12, Asia/Jerusalem. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/visual-track`.
Base: `9b39edc2fc103f87bfead19993ae4ba37c5ace51` (contains reviewed Tasks 1–6 and 11/12).
Source: **`0dea40c2401a678b1d8e9d4b32cac628d27261da`**, `feat: process recoverable authoritative activity slots`.
M03: **`supabase/migrations/20261012135526_activities_jobs.sql`**. M01 and M02 are unchanged.

The controller owns independent review, the HANDOFF update and the push. I spawned no helper or reviewer, and I did not push, merge or change branches. Codex's checkout `C:\Avi\Studies\Projects\Cloudiator` was only read, using `git --no-optional-locks ... diff` and file reads. Preview port 3000 was not touched.

## Delivered behavior

### Boundary order

`public.advance_boundary(target_slot bigint, coordinator_token uuid) returns jsonb` executes the spec 4.1 order. Each slot's phase is persisted in `private.boundaries`. Every phase's effects and its phase increment commit in the same transaction, so a crash rolls back only the current call and the next call resumes from the last committed phase.

1. **Settle the previous slot.** Wait until every activity of `slot-1` is settled. Any job of that slot in operator state is reported as `operator`.
2. **Season close.** `private.boundary_close_season(slot)` is the Task 21 hook; it is empty because no season work exists.
3. **Freeze the cohort and apply builds.** The cohort (`processed_slot_index = slot-1`) is frozen in `private.boundary_members`. `private.apply_pending_build(gid, slot)` runs under the shared lock order: account advisory `hashtextextended(owner,0)`, then the gladiator row. Schedule edits need no application, because snapshots read history.
4. **Recompute derived stats.** One fenced `prepare` job per member carries the frozen cutoff inputs: current BuildView, equipped item instances, level and earned points. The canonical TypeScript validation and stats then derive the snapshot, avoiding a second SQL stats engine (controller ruling).
   - Once all preparations complete, the boundary adopts the recomputed stamina maximum. Absolute stamina is preserved and clamped down, never refilled.
   - It then calls `private.boundary_recompute_leagues(slot)`, the Task 16 hook, which retains the current league.
5. **Snapshot.** Insert the unique `(gladiator, slot)` activity and its frozen private snapshot. The choice comes from the latest `schedule_revisions` row with `effective_slot_index <= slot`, ordered by effective slot then version descending, never from the latest-plan row. The snapshot also records the build, derived stats, costs, training points and starting resources.
6. **Stamina check.** A choice whose versioned cost exceeds current stamina becomes Rest with `fallback = true` and a debit of 0.
7. **Pairing.** `private.boundary_pair(slot)` is the Tasks 16/19 hook. Today any Arena or Tournament entrant produces an `integration` wait.
8. **Start.** First `private.activity_executor_ready(kind)` is checked for **every** member, before any debit. Then stamina is debited once, `private.prepare_activity_jobs(activity)` creates the minute-80 settlement job, the activity is published (`active`), `processed_slot_index` advances, and `private.boundary_published(slot)` (Task 10 hook) runs.

### Coordinator and cohort rules

- **Global checkpoint and barrier.** The global checkpoint is `private.coordinator.published_slot`. A boundary target must be exactly `published+1` and no later than database time.
- **Coordinator lease.** The coordinator token is a fenced lease, so a stale coordinator receives `conflict`.
- **Extension barrier.** `private.boundary_work(slot, phase, key, status)` lets later tasks register work, such as season close, that holds a phase while pending.
- **Late-committed characters.** A never-started character whose creation committed after an earlier cohort froze joins the next cohort; its orientation extends to that cutoff. A *participating* straggler stops the boundary with `straggler` for operator action.
- **`public.coordinate_work()`.** It takes the coordinator row with `SKIP LOCKED` and respects an unexpired external lease. It advances at most six boundaries per call, so catch-up is bounded and continues across calls. It skips provably empty boundaries. On its first run it starts at the earliest existing checkpoint, so offline slots are never skipped.

### Settlement

`public.settle_activity(activity_id uuid, lease_token uuid) returns jsonb` follows the common lock order: account, character, activity, then job. In one transaction it:
- verifies the current lease token;
- inserts the permanent `private.settled_slots(gladiator, slot)` checkpoint;
- applies `private.settle_rewards`: Training adds one earned and unspent point (versioned `trainingPoints`), and Rest sets current stamina to the current maximum;
- writes the receipt and the canonical `ActivitySummary`;
- completes the activity and the job.

A retry of a committed settlement with the same token returns the stored receipt with `newGrants: 0` and `replayed: true`. A stale or foreign token returns `conflict`.

### Jobs

`private.jobs` has the kinds `prepare`, `simulation`, `reveal` and `settlement`, a unique `dedupe_key`, and a SQL-generated 256-bit seed. The `guard_job` trigger makes input, seed, rules version and identity immutable, forbids decreasing attempts and refuses deletion of unfinished jobs. Leases and tokens work as follows:
- `public.claim_jobs(worker_id uuid, kind text, batch_limit integer) returns jsonb` uses `FOR UPDATE SKIP LOCKED` and caps each claim at 20 simple or 5 simulation jobs. Each claim gets a fresh token and a 120-second lease, and the retry keeps the same seed and input. Invalid arguments raise an error.
- `public.renew_job(job_id, lease_token)` extends the lease without rotating the token.
- `public.complete_job(job_id uuid, lease_token uuid, result jsonb) returns jsonb` validates preparation results:
  - shape and ranges;
  - versions;
  - a rest cost of zero;
  - that the echoed class, stance, allocations and equipment IDs equal the frozen input.
  It rejects settlement jobs, and simulation/reveal results go to the `private.accept_job_result` hook, which accepts none in Task 7.
- `public.fail_job(job_id, lease_token, failure_code)` keeps only a sanitized `[a-z0-9-]` code.

Attempts are counted per claim. The third failure, or the third expired lease, retains the job as `operator` with `last_failure`, and no fourth attempt happens. `private.resume_operator_job(id)` resumes the same seed and input; it is reachable through direct SQL only, because the private schema is not exposed. `private.job_attempts` logs job, attempt, worker, timing, outcome and failure code, never tokens or messages.

### Dispatch

`private.cron_tick()` is registered with pg_cron as `cloudiator-coordinate` (`* * * * *`). It returns `{skipped:'disabled'}` until `private.scheduler.enabled` is true. Once enabled, it coordinates, catching and recording only the SQLSTATE of a failure, and then calls `private.dispatch_workers()`. Dispatch:
- counts only due, claimable jobs;
- sends at most `ceil(simple/20) + ceil(combat/5)` invocations, capped at five per rolling minute through `private.dispatch_log`;
- sends `net.http_post` to the Vault secret `game_worker_url`, with `Authorization: Bearer <Vault game_worker_secret>`;
- sends nothing without both secrets.

### Worker Edge function

`supabase/functions/game-worker/index.ts` requires `GAME_WORKER_SECRET` of at least 32 characters, the service-role client and `SUPABASE_URL`. `handleWorker`:
- compares SHA-256 digests of `Bearer <secret>` in constant time before any database work;
- answers 401 for a missing, publishable or near-miss credential, and 405 for a non-POST with the secret;
- returns an uncached report without CORS headers, and a masked 503 on failure;
- reads no body, time or seed input.

`config.toml` sets `[functions.game-worker] verify_jwt = false`, so the explicit secret is the only authority.

### Owner projection

`public.owner_state` keeps every DTO field and now projects `currentActivity` from the latest activity:
- `preparing` is shown as `queued`;
- an active activity is `active` before its end and `processing` after it, until settled;
- a settled activity is `completed`;
- before the first activity, the character shows the existing orientation.

The label is Training / Resting / Resting (not enough stamina) / Expedition / Arena / Tournament, and the frontend renders only that label.

## Interfaces for later consumers

### SQL RPCs

All RPCs are backend-only (`service_role`), `SECURITY INVOKER`, with an empty `search_path`, and PUBLIC/anon/authenticated execution is revoked.

| Function | Returns |
| --- | --- |
| `advance_boundary(target_slot bigint, coordinator_token uuid) returns jsonb` | `{ok, slotIndex, phase, status:'complete'|'waiting', wait?, replayed?}`. Waits are `settlement`, `extension`, `preparation`, `integration`, `operator` or `straggler`. Errors are `{ok:false, code:'invalid'|'conflict'}`. |
| `coordinate_work() returns jsonb` | `{ok, busy?, publishedSlot, currentSlot, boundaries[]}`. |
| `claim_jobs(worker_id uuid, kind text, batch_limit integer) returns jsonb` | An array of `JobLease`. |
| `renew_job(job_id uuid, lease_token uuid) returns jsonb` | `{ok:true, expiresAtMs}` or `conflict`/`not-found`. |
| `complete_job(job_id uuid, lease_token uuid, result jsonb) returns jsonb` | `{ok:true, jobId, replayed?}` or `conflict`/`invalid`/`not-found`. |
| `fail_job(job_id uuid, lease_token uuid, failure_code text) returns jsonb` | `{ok:true, status:'pending'|'operator', attempts}` or `conflict`. |
| `settle_activity(activity_id uuid, lease_token uuid) returns jsonb` | `{ok:true, activityId, receiptId, newGrants, summary?, replayed?}` or `conflict`/`processing`/`not-found`. |

The plan named four of these; `renew_job`, `fail_job` and `coordinate_work` are necessary additions.

### Hooks to replace

Later tasks replace these with exactly the same signatures in their own SQL sources:

| Hook | Owner | Contract |
| --- | --- | --- |
| `private.boundary_close_season(bigint)` | Task 21 | Return text or null. |
| `private.boundary_recompute_leagues(bigint)` | Task 16 | Return text or null; runs after preparation completes, with frozen level, earned points and current league/history in the snapshot. |
| `private.boundary_pair(bigint)` | Tasks 16/19 | May convert opted-in Arena entrants to `tournament` on tournament slots. |
| `private.activity_executor_ready(text)` and `private.prepare_activity_jobs(uuid)` | Tasks 9/16/19 | Add expedition, arena and tournament job creation; return the readiness of each kind. |
| `private.accept_job_result(uuid,jsonb)` | Tasks 9/16/19 | Validate and accept simulation/reveal results, or use their own `commit_*` RPCs that call the same fencing checks. |
| `private.settle_rewards(uuid)` | Tasks 9/16/19 | Add their kinds; return `CreditedRewards`. |
| `private.boundary_published(bigint)` | Task 10 | Projection rows and revision. |

### Barrier and new tables

- **Barrier:** insert a pending `private.boundary_work(slot, phase, key)` row to hold a phase, then mark it `done`.
- **Tables:** `public.activities` is owner-readable. Its columns are `id`, `gladiator_id`, `slot_index`, `starts_at_ms`, `ends_at_ms`, `requested`, `schedule_version`, `resolved_kind`, `fallback`, `stamina_debit`, `debited`, `status`, `published_at_ms`, `receipt_id`, `summary` and `settled_at_ms`; it has no seed, snapshot or costs. The private tables are `activity_snapshots`, `coordinator`, `rules_versions` (exactly one active; `v1`), `boundaries`, `boundary_members`, `boundary_work`, `jobs`, `job_attempts`, `settled_slots` (permanent, with no activity FK so pruning cannot remove it), `scheduler` and `dispatch_log`. All private tables have RLS, a `backend_only` policy, no client grants and minimal `service_role` grants.

### TypeScript

- **Domain types** (`_shared/domain/types.ts`): `ActivityKind`, `ActivityCosts`, `JobKind`, `PreparationInput`, `PreparationResult`, the frozen `ActivitySnapshot`, `SettlementInput`, `JobInput`, `JobLease<Input>` (id, token, expiry, kind, activity/gladiator/slot, immutable `snapshot` input, seed, rules version, attempt), `BoundaryReport`, `CoordinatorReport` and `WorkerReport`.
- **RPC port** (`_shared/backend/database.ts`): `WorkerDatabase`, `JobOutcome`, `RenewOutcome`, `JobExecutor`, `ExecutorRegistry`, `WorkerDependencies { database, workerId, executors?, now? }` and `createWorkerDatabase(client)`.
- **Worker** (`_shared/backend/jobs.ts`): `runWorker(deps: WorkerDependencies): Promise<WorkerReport>`, `prepareActivityV1(input)`, `DEFAULT_EXECUTORS` (`{ v1: { prepare } }`, keyed by persisted rules version; keep old versions registered), `WORKER_LIMITS`, `WorkerFailure` and `handleWorker(request, { secret, run })`.
- **For Task 9:** the expedition `simulation`/`reveal` executors go into the registry, and `planExpedition(snapshot: ActivitySnapshot, seed, rules)` can read `snapshot.build`, `derived`, `costs` and `starting`.

## File map

The plan's Files list:
- `supabase/sql/03-activities-jobs.sql`
- `supabase/functions/game-worker/index.ts`
- `supabase/functions/_shared/backend/jobs.ts`
- `tests/db/activities.test.ts` (29 tests)
- `tests/backend/worker.test.ts` (13 tests)
- generated M03

Interface files named by the plan: `supabase/functions/_shared/backend/database.ts` and `supabase/functions/_shared/domain/types.ts`.

Shared files outside the Files list, each minimal:
- `package.json`: `typecheck` also Deno-checks `game-worker/index.ts`.
- `tsconfig.json`: excludes the Deno-global worker entrypoint from app TypeScript, as for `game-command`.
- `supabase/config.toml`: `[functions.game-worker] verify_jwt = false`.
- `scripts/test-db.mjs`: passes `GAME_WORKER_SECRET` from the ignored `.env.edge.local` in memory as `LOCAL_WORKER_SECRET`.
- `tests/backend/edge.deno.ts`: a second actual-Deno smoke test for preparation and worker-secret rejection.
- `docs/operations/migrations.md`: the M03 path, workflow, completed diff omissions and Task 24 gate.
- `tests/db/build-schedule.test.ts`: corrects a **pre-existing order-dependent assertion** (evidence below).

`deno.lock` and the dependencies are unchanged; no package was installed. The ignored `.env.edge.local` gained a random `GAME_WORKER_SECRET`, which was never printed. There are no Task 11/12 visual, HANDOFF or other-report changes.

## Codex's partial work

I read it and judged it critically. Codex left no SQL source, migration or report. These parts were reused:
- the RPC naming and shape of `createWorkerDatabase`;
- the digest-compare idea in `handleWorker`;
- `verify_jwt = false`;
- the idea of a `prepare` job kind;
- several test scenarios: nine slots, Rest at 19, stolen/renewed/reclaimed leases, three failures, cohort barrier and integration gate.

These parts were rewritten:
- the types, now with distinct `PreparationInput`/`PreparationResult`, `WorkerReport` with replay counts, and a versioned executor registry;
- `runWorker`, which now has a total 20-job simple budget across settlement, preparation and reveal, coordinates between batches, and does not rotate the token before every job;
- all SQL;
- all tests, which now use the real `runWorker` through the real RPC adapter.

Controller rulings from Codex's ledger were adopted as context:
- private fenced preparation jobs in the recompute phase;
- unsupported Arena/Expedition as integration waits;
- the explicit empty season hook;
- the league hook that does not invent a formula.

## RED and GREEN evidence

1. **Unit RED.** `npm test -- tests/backend/worker.test.ts` failed to load because `_shared/backend/jobs.ts` did not exist (missing module). **GREEN:** 13/13 after implementation.
2. **Database RED.** Before the SQL existed, after the TypeScript port and with the worker secret configured, `npm run test:db -- tests/db/activities.test.ts` showed **28 failed**, every one with `relation "private.boundaries" does not exist`. This was a missing lifecycle schema, not a configuration error.
3. **First run after applying the source: 12 failed / 16 passed.** Settlements ended in `operator` waits. A rollback-only reproduction showed `missing FROM-clause entry for table "settle_activity"`: PL/pgSQL does not label DECLARE variables with the function name. Renaming the variable fixed it, and the suite then showed **28/28**. The worker had correctly turned the database error into a sanitized `execution-failed` failure, and no grant occurred.
4. **Pre-existing flake.** In the full `npm run test:db`, Task 6's `serializes concurrent queue requests…` failed **1 of 54** with `expected 2 to be less than or equal to 1`.
   - Repeated alone, it failed 3 of 6 runs.
   - With the Task 6 `owner_state` view temporarily restored on the local test database, it still failed **2 of 8**, so the flake is pre-existing.
   - When the different-operation request takes the account lock first, both copies of the first operation correctly receive the same `conflict` receipt.
   - The assertion now accepts both legal serializations: exactly one of the two operations commits, and there is one conflict if the first operation wins or two if the second does. It passed 8 of 8, and the source was reapplied afterwards.
5. **Self-review RED.** `valid_preparation` required the TypeScript stamina maximum to *equal* the stored one. That would stall a future rules version that recomputes capacity, which phase 4 must do. The new test `recomputes the derived stamina maximum under a newer rules version without refilling` failed (`wait: 'operator'`): the v2 preparation was rejected as invalid. With the recompute implemented (maximum 80, stamina clamped to 80, a training debit of 20 leaving 60), the suite showed **29/29**.
6. **Tooling corrections, not RED:**
   - TS2428 in the test matcher augmentation, corrected to Vitest 5's `Matchers<R, T>`.
   - The first `functions serve` restart raced the removal of the old container ("container is marked for removal"); waiting for removal and restarting succeeded.

## Final commands and results

The final verification ran after a clean reset/replay. No source SQL was applied after the reset.

| Command | Result |
| --- | --- |
| `npx supabase functions serve --env-file .env.edge.local` (background, from the worktree) | Serves `game-command` and `game-worker` from the worktree's `supabase/functions` mount (`supabase-edge-runtime-1.77.4`). |
| `npx supabase db pull activities_jobs --local --schema public,private --yes` | Wrote `supabase/migrations/20261012135526_activities_jobs.sql`. `npx supabase migration list --local` shows M01, M02 and M03. |
| `npx supabase db reset --local --no-seed --yes *> .task7-reset.log` | Applied all three migrations; containers restarted; the Edge runtime stayed up. After the replay: `cron.job` has `cloudiator-coordinate`; `rules_versions` has v1 active; the coordinator singleton exists; `pg_net` is in `extensions`. |
| `npm run test:db` (all suites) | **55 passed**: 11 identity, 15 planning, 29 activities. This includes real Auth/RLS/Edge HTTP for commands and the worker, a real pg_cron run (`cron.job_run_details`: 1 succeeded run since the reset), and real pg_net delivery. |
| `npm test` | **232 passed**, 11 files (219 before, plus 13). |
| `npm run typecheck` | `tsc` clean; frozen Deno check of both `game-command` and `game-worker`; Deno runtime 2 passed. |
| `npm run build`, then `npm run verify:static` | 3 fixed routes; 69 assets scanned; no forbidden backend material. Unchanged. |
| `npx playwright test -c node_modules/.cache/pw-claude.config.mjs` (port 3200) | **63 passed, 5 skipped**, the same as before. |
| `npx supabase db lint --local --schema public,private --fail-on warning` | `results=[]`. |
| `npx supabase db advisors --local --type all --level info --fail-on warn` | No WARN or ERROR. Four INFO `unused_index` notices: `operation_receipts_gladiator_idx` (existing), `boundary_members_gladiator_idx`, `jobs_activity_idx` and `jobs_gladiator_idx`. These FK/ownership indexes are retained; a fresh database's statistics are not workload evidence. |
| `git diff --check`, then `git diff --cached --check` | Clean (only the configured LF-to-CRLF notices). |

**Credential scan.** An in-memory comparison checked the local `supabase status` key/secret values and the worker secret against all 182 tracked and new files. It found zero matches for the six key/secret values. The seventh value is the stack's default database password, the literal word `postgres`. It appears as an ordinary word in package names, docs and a fake connection string in the unit test; it is not a secret. Status output, gateway configuration and env files were never printed. CLI, reset, serve and test output is in the ignored `.task7-*.log` files.

## Test coverage

**Named Step 1 assertions:**
- `advanceTrainingRestSchedule(9)` returns `{completedSlots: 9, trainingPoints: 6}`. Stamina returns to 104 and the kinds are T, T, R ×3.
- `startTrainingWithStamina(19)` returns `{resolvedKind: 'rest', staminaDebit: 0}`; stamina refills only at settlement.
- `commitThenLoseResponse` followed by `retrySameSettlement` returns `{newGrants: 0}`.
- `completeWithStolenLease` has code `conflict`.

**Step 4 and supporting cases:**
- Recovery and coordination:
  - partial-boundary crash with an injected trigger: rollback to phase 4, no duplicate activities, debits or jobs, unique `(gladiator, slot)`;
  - a replacement coordinator fences the stale one;
  - chronological, present-bounded and fenced targets.
- Leases and jobs:
  - a stale worker after renewal and reclaim, keeping the same seed and input;
  - immutable seed, input and rules version;
  - concurrent settlement retries produce one grant and one receipt;
  - SKIP LOCKED disjoint claims, with caps of 20 and 5;
  - three failures lead to operator state, and resume works after repair;
  - three expired leases lead to operator state with no fourth attempt.
- Rules versions: an old rules version stays on its boundary, an unknown version fails closed, and a newer version recomputes capacity.
- Schedules and cohort:
  - historical schedule revisions, including a late edit during the started slot;
  - new-character orientation after the cutoff;
  - late-committed admission, and a participating straggler stall;
  - previous-settlement and season-close barriers.
- Builds and locks: the pending build applies once before the snapshot (one fee, `buildVersion` 2 and active version 2), with the rollback-only operator clock restored; the boundary waits behind an in-flight account lock.
- Integration gates: Expedition at phase 8 and Arena at phase 7, with no debit or attempts; an unaffordable Arena falls back to Rest.
- Offline catch-up: real-clock catch-up with no player session, while commands return `processing` (no receipt) until caught up.
- Access: negative access for the owner, other owner, anonymous client, direct RPCs, private tables and `prosecdef`.
- Scheduling and HTTP: cron registered, inert and executed; the dispatch budget of 2, then 3, then 0 (five per minute, only with work); the real Edge worker rejects anonymous, publishable and near-miss credentials directly and through the gateway, and its secret runs a full boundary; real pg_net delivery.

## Concerns and deferred gates

1. **Integration gates halt the world truthfully.** Without Tasks 9 and 16, any cohort member with an affordable Expedition or Arena stops that boundary at phase 8 or 7, and the whole cohort waits. The default schedule's afternoon Woodland Expedition means a live world stalls at its first afternoon boundary until Task 9. Owners see `queued` and `processing`, never invented rewards. A public preview before Task 9 would need Training/Rest schedules or this gate.
2. **Hosted scheduling is a Task 24 gate.** Task 24 must:
   - store the Vault `game_worker_url` and `game_worker_secret`;
   - set `GAME_WORKER_SECRET` as a function secret;
   - deploy `game-worker` with JWT verification disabled;
   - enable `private.scheduler`;
   - prove hosted pg_cron and pg_net dispatch to the function URL.
   Locally, cron registration and execution, the dispatch budget and real pg_net delivery are proven. Hosted behavior is not claimed.
3. **Ambiguity: `ActivitySummary.replayExpiry` for Training/Rest.** These activities never have replay events, and the canonical type offers only `available(expiresAtMs)` or `expired`. I store `{state:'expired'}`. Cost if wrong: Task 10/13 may special-case non-combat kinds in the summary UI.
4. **`currentActivity` after settlement.** While the next boundary is still processing, `currentActivity` shows the last settled activity as `completed`. "Behind" is visible via `processedSlotIndex` compared with server time. Task 13 should combine the two for the Processing results / Preparing states.
5. **Global barrier.** A single job in operator state stalls every later boundary, as the spec's cohort barrier and three-failure rule intend. It is visible as `wait: 'operator'`, the job status and `job_attempts`. Alerts, health and the runbook are Task 22. Retention must also prune `cron.job_run_details` (one row per minute) and completed jobs. It must never prune `settled_slots`, unfinished jobs or the needed revisions.
6. **Late-commit edge.** A creation whose clock was read before a cutoff but committed after that cohort froze joins the next slot instead of stalling the world. The rule is "participate next slot"; the race is unlikely, and the orientation end is updated to stay truthful.
7. **Performance is unmeasured.** The two-minute, 50-character target was not measured. A boundary needs roughly one worker round for settlement and one for preparation per 20 characters. The estimate under cron plus at most five dispatches per minute is about two minutes, but that is an estimate, not evidence. Hosted measurement is Task 23.
8. **Design choices for review:**
   - Renewal extends a lease without rotating its token; fencing tokens change only on a claim or reclaim.
   - Completion requires an unexpired lease.
   - Failures retry immediately (no backoff) until the third attempt.
9. **Edge runtime hot-loading.** The running Edge runtime served the new function before my restart. I restarted serving anyway, as the dispatch addendum required, and all final HTTP evidence ran after that restart and the replay.
