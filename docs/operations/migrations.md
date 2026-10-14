# Local identity backend and migrations

## Task 19 phase 2a: tournament entry, brackets and bout jobs

M11 is `supabase/migrations/20261014160257_tournaments.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull tournaments --local --schema public,private --yes` from the tested `supabase/sql/09-tournaments.sql`.
M01–M10 are unchanged.

The draft needed three completions before commit:
- It only added table grants. Source-equivalent revokes on `private.tournaments`, `private.tournament_entries` and
  `private.tournament_bouts` now precede them.
- It omitted every function ACL: the source's revoke/grant pair is appended, so the new and changed functions keep backend
  `EXECUTE` only.
- A provenance header and `notify pgrst` were added. No backfill or initialization is needed: the tables are new, and a
  pairing input frozen before M11 keeps its regular path in `accept_pairing`.

It re-emits no unchanged function. The changed existing functions are `pairing_input`, `boundary_pair`, `accept_pairing`,
`activity_executor_ready` and `prepare_activity_jobs`; the new ones are `public.set_tournament_opt_in`,
`public.tournament_bout_input`, `private.valid_bracket`, `private.tournament_graph` and `private.guard_tournament_bout`.
Its triggers follow their functions.

A first draft, `20261014160119_tournaments.sql`, was discarded before commit with local `migration repair --status reverted`
and exact-file removal. It re-emitted `private.planning_now_ms()`: an interrupted RED run had left a test-only clock
stand-in installed, and the manual restore had used M02's text through Git Bash `sed`, which dropped the carriage returns
that the replayed definition (last written by M05) keeps. The function was restored byte for byte from M05 with Node, and
the regenerated draft re-emits nothing unchanged. The fix used here was to restore the stand-in from the
`pg_get_functiondef` text captured before it was installed, not from a migration through `sed`. Making that a standing rule
is a proposal awaiting Avi's approval (2026-10-14); it is not yet approved guidance.

**Release (Task 24).** Ship M11 with the Task 19 worker and with phase 2b, never alone. In phase 2a a tournament bout job
can be claimed but not completed (`complete_job` has no tournament acceptance yet), so the real worker fails it into operator
state and the boundary after a tournament slot waits. A pairing job frozen before M11 on a tournament slot fails closed in the
new worker (`invalid-input`); check that no `pair` or `simulation` job is in operator state after the release.

**Retention (Task 22).** Prune bout rows and entries before their tournament, tournaments before their pairing job, entries
before their activities, and bout jobs (anchored to the rank-1 entry's activity) before that activity (foreign keys).

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M11, with no source applied afterwards.
- The schema fingerprint (752 entries, 772 lines, the same coverage as M10's) matched the tested source exactly, and was
  identical again after the tests.
- `npm run test:db` passed **151/151** in eight files on the replay, with the Edge container's start time unchanged across
  the run. One earlier replay run also passed 151/151, but the Edge container was recreated as it ended, so it does not count.
- Lint is empty. Advisors report 25 INFO unused-index notices on the freshly reset database (two on the new foreign-key
  indexes `tournament_entries_gladiator_idx` and `tournaments_rules_idx`), and no warnings or errors.

## Task 16 phase 2b: Arena bouts, settlement, stages and standings

M10 is `supabase/migrations/20261014131209_arena_bouts.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull arena_bouts --local --schema public,private --yes` from the tested `supabase/sql/08-arena-bouts.sql`.
M01–M09 are unchanged.

The draft needed five completions before commit:
- The `arena_standing_reads` view lacked `security_invoker=true` and every grant; both are restored from the source.
- It only added table grants. Source-equivalent revokes on `public.arena_standings` and `private.arena_results` now precede them.
- It omitted every function ACL: the source's revoke/grant pair is appended, so the three new private functions get the
  backend `EXECUTE` that `complete_job` and settlement need.
- It omitted the standings backfill: `select public.refresh_projections();` publishes every existing rating record.
- A provenance header and `notify pgrst` were added.

It re-emits no unchanged function. The changed existing functions are `activity_executor_ready`, `prepare_activity_jobs`,
`accept_job_result`, `settle_rewards`, `settle_activity_core`, `pairing_input` and `project_character`; the new ones are
`accept_arena_result`, `arena_settlement_failure` and `arena_rewards`. The new tables are `private.arena_results` (one
frozen log and both outcomes per battle) and `public.arena_standings` (the public standings projection), with the invoker
view `public.arena_standing_reads`.

**Release (Task 24).** Ship M09, M10 and the worker in one release step, then check that no `prepare`, `pair` or `simulation`
job is in operator state. M09 rejects an older worker's preparations (phase 2a), the new worker fails a pairing input without
`historyFromSlot` (written only by M10) closed, and an older worker cannot simulate an Arena bout (its simulation executor is
the expedition planner).

**Retention (Task 22).** Prune `private.arena_results` before its assignment and its simulation job, stages before their
activities, and assignment sides before their activities (foreign keys). `public.arena_standings` follows its gladiator.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M10, with no source applied afterwards.
- The schema fingerprint (667 entries, 687 lines: function definitions, search paths, security, volatility and ACLs; table
  and view ACLs, RLS, options and definitions; policies, triggers, constraints, columns, indexes, the cron job and the seed
  rows) matched the tested source exactly, and was identical again after the tests.
- `npm run test:db` passed **137/137** in seven files on the replay, with the Edge container's start time unchanged across
  the run. Two earlier replay runs also passed 137/137 but had an Edge recreation during the run, so they do not count.
- Lint is empty. Advisors report four INFO unused-index notices, none on the new tables, and no warnings or errors.
- Observed with those recreations: the background `functions serve` logged `File change detected … (WRITE)` and restarted
  the runtime for Edge source files whose content `git status` showed unchanged, while host tools (vitest, `tsc`, `deno
  check`) were reading them. This is an observation, not a confirmed cause or a tested fix. Details are in the
  [Task 16 report](../implementation/task-16-report.md).

## Task 16 phase 2a: Arena placement, ratings and pairing

M09 is `supabase/migrations/20261014113448_arena.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull arena --local --schema public,private --yes` from the tested `supabase/sql/07-arena.sql`.
M01–M08 are unchanged.

The draft needed three completions before commit:
- It created the `guard_league` trigger before `private.guard_league()`; the trigger now follows its function.
- It only added table grants. Source-equivalent revokes on the four new private tables now precede the grants.
- It omitted every function ACL, so the new private functions would have lacked the backend `EXECUTE` that
  `complete_job` and the boundary phases need. The source's revoke/grant pair is appended.

It re-emits no unchanged function. The changed existing functions are `claim_jobs`, `complete_job`, `guard_job`,
`valid_preparation`, `boundary_recompute_leagues` and `boundary_pair`; the new ones are `season_index`, `league_rank`,
`guard_league`, `guard_arena_rating`, `pairing_input` and `accept_pairing`. No backfill or initialization is needed:
the season epoch is deliberately left unset, and phase 4 creates each character's league-season rating row at its
first boundary.

**Season epoch.** `private.season_epoch` holds one immutable row: the slot of the first launch boundary. Without it,
any boundary with members waits at phase 4 with `wait:'epoch'`. **Task 24 must set it at launch**, no later than the
first boundary with members the coordinator will process (check `select min(processed_slot_index) from
public.gladiators;` first): boundaries run in order and the row is immutable, so a late epoch stalls every later
boundary. The DB test fixture
(`resetIdentity`) sets it to slot 0. A developer using the local stack outside the tests sets it once:

```powershell
'insert into private.season_epoch(epoch_slot) values(0);' | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
```

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M09, with no source applied afterwards.
- A fingerprint of 625 schema entries matched the tested source exactly. It covers function definitions,
  search paths, security, volatility and ACLs; table and view ACLs, RLS and options; policies, triggers, constraints,
  columns and indexes; the cron job and the seed rows.
- The replayed database passed `npm run test:db`: **124/124** in seven files. That includes the 15 Arena cases and
  their real pg_net dispatch to the Edge worker.
- The fingerprint was identical again after the tests, so the test-only triggers and stand-ins were all removed.
- Lint is empty. Advisors report six INFO unused-index notices, none on the new tables, and no warnings or errors.
- The first replay run had one infrastructure fault: the background `functions serve` recreated the Edge container
  one second into the run, and one Edge HTTP case could not connect. A rerun with the container stable throughout
  passed 124/124. Details are in the [phase 2a report](../implementation/task-16-phase-2a-report.md).

## Task 10 delayed-preparation correction

M08 is `supabase/migrations/20261014100253_projection_preparation_status.sql`,
generated with CLI 2.120.0 `db pull projection_preparation_status --local --schema public,private --yes`
from the corrected `supabase/sql/06-projections.sql`. Committed M01–M07 remain
unchanged. The draft was completed with the existing-character checkpoint
backfill and explicit invoker-view/function ACL preservation.

The projection retains the authoritative published-slot checkpoint. When the
previous activity is completed but the current database slot is unpublished,
world/profile reads return a generic camp `processing` actor with no activity
identity, destination choice, timestamps or stage. The old completed result
remains available separately through the authorized timeline/recent reads.
The new slot's published activity replaces that waiting state atomically.

Clean migration-only replay matched all 303 captured schema/ACL/column records
against tested source. See [Task 10's correction report](../implementation/task-10-report.md#review-correction-round-1--delayed-next-slot-preparation)
for exact regression, replay and advisor results.

## Task 10 safe projection migration

M07 is `supabase/migrations/20261014045856_projections.sql`, generated with
CLI 2.120.0 `db pull projections --local --schema public,private --yes` from
the tested `supabase/sql/06-projections.sql`. M01–M06 remain immutable.
The uncommitted draft needed private functions before their triggers,
explicit table/view/function ACLs, `security_invoker` view options, the
singleton revision row, and an existing-character projection backfill.
The only redefined pre-existing function is `private.boundary_published(bigint)`.

Clean `db reset --local --no-seed --yes` replay passed without reapplying
SQL source. All 302 schema entries matched the source snapshot, including
function bodies/search paths/ACLs, table/view ACLs and invoker settings,
RLS policies, triggers and constraints. The replayed database passed the
107 owning/affected DB/Auth/Edge tests; the expanded final projection suite
passed five cases. Lint and warning/error advisors were clear. Full evidence
and query contracts are in [Task 10's report](../implementation/task-10-report.md).

For the approved local Docker startup diagnosis and recovery procedure,
see [local runtime operations](local-runtime.md). Startup repair is separate
from migration and test evidence; never print credential-bearing status output.

## Required generated-artifact review

The persistent Supabase skill override in [AGENTS.md](../../AGENTS.md) was
extended with Avi's approval on 2026-10-12. CLI 2.120.0's observed omissions
and the tested corrections below support this workflow:

1. Iterate the intended SQL source on the verified local stack and generate
   the draft through the CLI after checking its installed version and help.
2. Compare the draft with the tested source: ACLs, RLS, invoker-view options,
   function/trigger dependencies, data backfills, extensions, seed rows and
   scheduler initialization. A schema diff cannot stand in for required DML.
3. Complete omissions before committing that draft. Keep already committed
   migrations immutable; later corrections belong in a new migration.
4. Clean-reset/replay the migrations without applying SQL source afterward.
   Compare the replayed database with the source for function bodies/search_path, role ACLs, policies, triggers and invoker-view settings; confirm any re-emitted unchanged function bodies match their previous migration. Run owning and affected access-denial tests against that artifact, then
   lint and advisors. Document actual evidence and remaining limitations.

Task 6's corrected draft passed 26 database/Auth/Edge tests after clean replay.
Task 7 separately verified M01–M04 with 61 tests. These are observed results,
not verification of an untested future migration or a hosted deployment.

## Task 9 expeditions

M06 is **`supabase/migrations/20261013125213_expeditions.sql`**, generated by
CLI **2.120.0** from `supabase/sql/05-expeditions.sql`. The continuation retained
the prior worker's generated draft and completed it from the tested source;
M01–M05 are unchanged. The draft now includes current post-lock lease checks,
dependency-aware dispatch, safe reward/replay projection, and explicit function
and table ACLs. It changes eight existing functions and adds ten; it re-emits
no unchanged functions. Its private triggers reference the existing immutable
`guard_frozen` function; no new initialization/backfill/view change is needed.

The verified `supabase_db_Cloudiator` container's project label was `Cloudiator`.
`db reset --local --no-seed --yes` replayed M01–M06 successfully. No SQL source
was applied after reset. **258 schema entries matched exactly** between tested
source and replay: function bodies/definitions/search paths/security/ACLs,
table/view ACLs/RLS/options, policies, triggers and constraints. The replay
passed **103/103 database/Auth/Edge tests**, including real worker HTTP,
expiry after proven row-lock waits, atomic settlement and client denial.
Four subsequently strengthened privacy/current-token tests also passed.
Post-replay lint was empty; advisors returned six INFO unused-index notices
and no warnings/errors. Full provenance and commands are recorded in
[task-09-report.md](../implementation/task-09-report.md).

Only due `activity_stages` rows are signed-in readable; plans and dependencies
remain private. Completed reward and overflow details stay owner-scoped.
Settlement combines the current inventory grant, XP, money, ledger, receipt
and permanent settled-slot checkpoint in one fenced transaction. The inherited
`complete_job` and `renew_job` clock checks now sample database time after
locking the current job; stale tokens/status/expiry are rejected. Earlier
migrations remain immutable; use a new migration for future corrections.

## Task 8 inventory and shops

M05 is **`supabase/migrations/20261013065108_inventory_shops.sql`**, generated on
2026-10-13 by CLI **2.120.0**, engine `migra`, from the tested reapplicable
`supabase/sql/04-inventory-shops.sql`. The plan's original M04 alias was already
occupied by the reviewed Task 7 correction; M01–M04 remain unchanged.

```powershell
# Verify this container's com.supabase.cli.project label is Cloudiator first.
Get-Content supabase/sql/04-inventory-shops.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
npx supabase db lint --local --schema public,private --fail-on warning
npx supabase db advisors --local --type all --level info --fail-on warn
npx supabase db pull inventory_shops --local --schema public,private --yes
npx supabase migration list --local
# Complete and inspect the generated draft before this migration-only replay.
npx supabase db reset --local --no-seed --yes *> .task8-clean-replay.log
npm run test:db
```

The draft omitted new-function revocations/grants, complete new-table privilege
revocations, the owner view's explicit invoker option and starter-history
backfill. Its three triggers also preceded their private function definitions.
Before committing, the draft was completed from the tested source and those
triggers moved after their functions. All **39** re-emitted unchanged function
bodies match the latest earlier migration exactly. Only `create_gladiator` and
`boundary_recompute` change existing functions; eight functions are new.

The clean replay succeeded without applying the SQL source afterwards. An exact
comparison of **228** schema entries matched tested source state to replayed
state: function bodies/definitions/search paths/security/ACLs, table and view
ACLs/RLS/options, view definition, policies, triggers and constraints. First full
DB run: **82 passed, one affected test expected the older reservation error**.
The new equipment immutability trigger rejects the same illegal quantity change
first. Updating that specific expectation and adding explicit private-function
and cosmetic mutation denial assertions produced **36/36** shops/planning tests;
the 36 activity and 11 identity tests had passed against the same replay. No
production or migration change was needed after replay. Lint returned no issues;
advisors returned four INFO unused-index notices only. Full details and the
distinction between inherited and newly observed evidence are in
[task-08-report.md](../implementation/task-08-report.md).

Shop RPCs remain backend-only, security invoker, with an empty search path and
no anonymous/authenticated execution. `private.apply_inventory_plan` applies a
trusted canonical grant under account/character/wallet/item locks; it does not
credit money or provide its own replay guard. Task 9 must combine it with XP,
overflow money, ledger and permanent settlement receipt atomically. The legacy
`peak_strength` field stores only monotonic historical legal equipment score.
The 50-renown banner uses separate owner-only, account-bound cosmetic storage,
consumes no inventory slot and has no combat/history effect.

## Task 7 review fixes: exhausted-lease sweep, terminal jobs, isolated boundaries

M04 is **`supabase/migrations/20261012143533_task7_review_fixes.sql`**, generated with CLI 2.120.0 (engine `migra`) from the updated reapplicable source `supabase/sql/03-activities-jobs.sql`. M01–M03 are unchanged and remain immutable:

```powershell
Get-Content supabase/sql/03-activities-jobs.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
npx supabase db lint --local --schema public,private --fail-on warning
npx supabase db advisors --local --type all --level info --fail-on warn
npx supabase db pull --help
npx supabase db pull task7_review_fixes --local --schema public,private --yes
npx supabase migration list --local
npx supabase db reset --local --no-seed --yes *> .task7-fix-reset.log
npm run test:db
```

The draft captured the two new columns (`private.coordinator.last_failed_slot`, `private.boundaries.last_error`), the widened `boundaries_wait_reason_check` (now also `'error'`), the new `private.sweep_exhausted_leases(bigint)` and every changed function body. It omitted the function ACL of the new private function, which would otherwise keep PostgreSQL's default `EXECUTE` for `PUBLIC`; the source's revoke/grant pair was appended verbatim. The draft also re-emits every unchanged private function as `CREATE OR REPLACE`; sampled bodies are byte-identical to M03, so they were left in place. The clean replay (M01–M04) then passed all 61 database tests; lint was clean; advisors reported only the same four INFO unused-index notices as M03.

**Source changes behind M04:**
- `private.sweep_exhausted_leases(now_ms)` moves every lease that expired at its attempt limit to `operator` state (with `last_failure='lease-expired'` and the attempt row closed as `expired`), using `FOR UPDATE SKIP LOCKED`. It runs at the start of `claim_jobs`, `advance_boundary` and `coordinate_work` (before the coordinator's busy check, so it is independent of the coordinator lease). A worker killed on its final attempt therefore surfaces as `wait:'operator'` at phase 1 or 4 without any further claim.
- `private.guard_job` is now a status machine: `pending→leased`, `leased→completed|pending|operator`, `operator→pending`, any status may renew itself. A `completed` row rejects every update, and `result` changes only on the `leased→completed` transition.
- `public.coordinate_work` runs each `advance_boundary` call in its own subtransaction. A failing boundary rolls back only itself; earlier boundaries of the same pass stay committed. The failure is reported as `{ok:false, code:'boundary-failed', slotIndex, sqlstate}` (SQLSTATE only, never raw text), persisted on the boundary row as `wait_reason='error'` with `last_error`, and on the coordinator as `last_error`/`last_failed_slot`. Both clear on the next failure-free pass or phase advance.
- `private.settle_rewards(uuid)` now returns the settlement outcome `{rewards, result, success, replayExpiry, ratingDelta?}`; `settle_activity` validates it (fail closed) and adds `activityId`, `resolvedKind`, `receiptId` and `settledAtMs` to form the stored `ActivitySummary`.
- `private.prepare_activity_jobs` copies the frozen `activity_snapshots.seed` onto every job of that activity; the snapshot seed is the authoritative activity seed. `prepare` jobs have no activity and keep a job-local seed that v1 preparation never reads.

## Task 7 activity boundaries, fenced jobs and worker

M03 is **`supabase/migrations/20261012135526_activities_jobs.sql`**, generated with CLI 2.120.0 from the reapplicable source `supabase/sql/03-activities-jobs.sql`:

```powershell
Get-Content supabase/sql/03-activities-jobs.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
npx supabase db lint --local --schema public,private --fail-on warning
npx supabase db advisors --local --type all --level info --fail-on warn
npx supabase db pull activities_jobs --local --schema public,private --yes
npx supabase migration list --local
npx supabase db reset --local --no-seed --yes *> .task7-reset.log
npm run test:db
```

The `migra` draft needed reviewed completion before commit, as in M02. It omitted the `pg_net` (schema `extensions`) and `pg_cron` extensions, the seed rows (`private.rules_versions` v1 active, the `private.coordinator` and `private.scheduler` singletons), the `cron.schedule('cloudiator-coordinate', '* * * * *', 'select private.cron_tick()')` registration, every function ACL, the complete public/private table revocations, and the view's `security_invoker` option. All are appended verbatim from the source. Public PL/pgSQL functions precede the private tables in the draft. That order is safe because their bodies are validated at first call. The SQL-language functions and triggers follow their tables. The clean replay (M01, M02, M03) then passed all 55 database tests. Lint was clean. Advisors reported only four INFO unused-index notices on FK/ownership indexes in a fresh database.

**Lock order** (shared with Tasks 4/6): coordinator row, then the account advisory lock `hashtextextended(owner,0)`, then the gladiator row, builds/schedules/wallet/items, activities and jobs. `private.planning_now_ms()` is the single database clock. Tests replace it only inside rollback-only operator transactions.

**Boundary state.** `private.coordinator.published_slot` is the global checkpoint: the last slot whose eight phases completed for every member. `private.boundaries` persists the next phase (1–8, 9 = complete), the wait reason, the cutoff `slot*4800000` and the rules version recorded when the boundary opened. `private.boundary_members` freezes the cohort (`processed_slot_index = slot-1`) at phase 3, after previous settlement and season close. `private.boundary_work(slot, phase, key, status)` is an explicit barrier for later tasks: any pending row holds its phase.

**Phases.** `advance_boundary` runs them in the spec order:
1. All previous-slot activities are settled, and no job is in operator state.
2. `private.boundary_close_season` (Task 21 hook).
3. Freeze the cohort and call `private.apply_pending_build(gid, slot)` under the common locks.
4. Create one fenced `prepare` job per member, holding the frozen BuildView, equipped items, level and earned points. Then adopt the recomputed stamina capacity, keeping absolute stamina and clamping it down, and call `private.boundary_recompute_leagues` (Task 16 hook).
5. Snapshot the latest `schedule_revisions` row effective by the slot, with the frozen build and the starting resources.
6. Replace an unaffordable choice with Rest.
7. `private.boundary_pair` (Tasks 16/19 hook).
8. Check `private.activity_executor_ready` for every member before any debit. Then debit stamina once, call `private.prepare_activity_jobs`, publish the activity and advance `processed_slot_index`, then run `private.boundary_published` (Task 10 hook).

Later tasks replace these exact hook signatures, along with `private.settle_rewards(uuid)` and `private.accept_job_result(uuid,jsonb)`. An activity kind without an executor (Arena at phase 7, Expedition at phase 8) is an `integration` wait: no debit, no job, no checkpoint advance and no attempts consumed.

**Jobs.** `private.jobs` has the kinds `prepare`, `simulation`, `reveal` and `settlement`, a unique `dedupe_key`, and an immutable input/seed/rules version, enforced by the `guard_job` trigger (since M04 also a status machine with terminal `completed` rows). Unfinished jobs cannot be deleted. `claim_jobs` uses `FOR UPDATE SKIP LOCKED` and caps a claim at 20 simple jobs or 5 simulation jobs. Each claim issues a fresh token and a 120-second lease. `renew_job` extends a lease without rotating its token. `complete_job`, `fail_job` and `settle_activity` require the current token. A completed job replays only to its own token. Attempts are counted per claim. A third failure, or a third expired lease, retains the job in `operator` state with the sanitized `last_failure`; since M04 the expired case is swept by every claim, boundary step and coordination pass, not only by a later claim. `private.resume_operator_job(id)` (direct SQL only) resumes the same seed and input. `private.job_attempts` logs worker, timing, outcome and failure code, never tokens. `private.settled_slots(gladiator, slot)` is the permanent grant guard. It deliberately has no activity FK, so summary retention can never remove it.

**Coordinator and dispatch.** `coordinate_work()` takes the coordinator row with `SKIP LOCKED` and respects an unexpired external lease. It advances at most six boundaries per call, skips provably empty boundaries, and starts at the earliest existing checkpoint on its first run. `private.cron_tick()` is registered every minute and stays inert until `private.scheduler.enabled` is true. When enabled, it coordinates and then calls `private.dispatch_workers()`. Dispatch sends at most five `net.http_post` calls per rolling minute, and only for claimable work. It authenticates with the Vault secrets `game_worker_url` and `game_worker_secret`; without both, nothing is sent. Locally, the cron registration and execution, the dispatch budget and a real pg_net delivery to the local `game-worker` were tested. **Task 24 must** store the hosted Vault secrets, set `GAME_WORKER_SECRET` as a function secret, deploy `game-worker` with JWT verification disabled (the handler checks the secret), enable `private.scheduler`, and verify hosted scheduling and dispatch. None of that is claimed here.

**Edge worker.** `supabase/functions/game-worker/index.ts` requires `GAME_WORKER_SECRET`, at least 32 characters, and compares bearer digests in constant time. Locally the secret is an ignored line in `.env.edge.local`, generated randomly and never printed. `scripts/test-db.mjs` passes it to the tests in memory only. After adding it, restart `npx supabase functions serve --env-file .env.edge.local` from this checkout.

## Task 6 planning migration and worker boundary

M02 is **`supabase/migrations/20261012121232_build_schedule.sql`**, generated with CLI 2.120.0:

```powershell
Get-Content supabase/sql/02-build-schedule.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
npx supabase db lint --local --schema public,private --fail-on warning
npx supabase db advisors --local --type all --level info --fail-on warn
npx supabase db pull build_schedule --local --schema public,private --yes
npx supabase migration list --local
npx supabase db reset --local --no-seed --yes *> .task6-reset.log
npm run test:db -- tests/db/build-schedule.test.ts tests/db/identity.test.ts
```

The CLI-generated uncommitted `migra` diff required review completion: move cross-schema triggers after their private functions, retain explicit function and table revocations/grants, preserve the view's security-invoker option, and add the source's existing-character schedule-history backfill. Schema diffing does not capture that data backfill. The first replay's security regression found inherited mutation privileges on `pending_build_items` and `schedule_revisions`; explicit source-equivalent revoke/regrant statements corrected the draft. A second clean replay passed both suites (26 tests), real Edge HTTP, lint, and advisors (only two INFO unused indexes). M01 was unchanged. Once committed, M02 is immutable.

All three public backend-only RPCs are `(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`: `edit_schedule`, `queue_build`, and `cancel_build`. `input` is the server-only `{command, prepared}` envelope; HTTP accepts only canonical `GameCommand`. Cancellation includes the canonical expected version despite the plan's abbreviated two-argument signature. `OwnerState.buildVersion` is the queue/replace/cancel revision; `currentBuild.version` stays unchanged until activation. `PendingBuildView.reservedItemIds` records the reserved item IDs.

Mutation lock order is account advisory lock `hashtextextended(actor_id::text,0)`, then its gladiator row, builds/schedules/wallet and item rows in ID order. Read the database clock after acquiring the account/character lock. Task 7 must share this order and the common slot cutoff. A new mutation returns transient, unrecorded `processing` while `processed_slot_index` is behind database time; a matching committed receipt replays before that check and before new preparation validation. Defined business failures are retained; changed payload reuse returns conflict.

`schedule_revisions` retains phase, version, choice, received milliseconds and effective slot. For historical snapshots, select the latest revision for that character and phase with `effective_slot_index <= slot`, ordered by effective slot then version descending. The baseline contains all three initial choices; future edits never rewrite it. `schedules.schedule` is the owner's latest repeating plan, not historical activity authority.

`private.pending_build_preparations` stores the canonical validated snapshot (including rules version), derived stamina maximum, operation ID and received time. It has no client schema/table access and is excluded from owner DTOs and public base tables. `private.apply_pending_build(gid uuid,boundary_slot bigint) returns boolean` is a backend-only atomic application primitive: it takes the common locks, refuses earlier slots, returns false when nothing is pending, consumes the held fee once, writes one ledger row, switches item reservations/current build, preserves absolute stamina with a downward clamp, computes unspent points from current earned points, and clears pending state. Task 7 alone owns chronological settlement, the global cutoff/barrier and checkpoint advancement; call this primitive after prior-slot settlement and before new-slot snapshots. It does not advance a checkpoint, award rewards or implement a scheduler.

Task 8 sale/list/discard commands must take the same locks and require no active or pending item reservation. `pending_build_items` tracks every selected item even when it is also currently equipped; the item guard rejects deletion, transfer, quantity/stat changes while reserved. Replacement/cancel releases only pending reservations, retaining current equipment. Wallet money includes held funds; spendable money is money minus held reservations. Fees leave the wallet only at activation.

The controller authorized the deliberate local reset/replay exception to service preservation. The existing Edge runtime remained up (no manual serve restart), real Edge tests passed afterward, and preview port 3000 returned HTTP 200. Capture reset/startup output to ignored logs and never publish raw credentials.

Task 4 uses Supabase CLI **2.120.0**, supabase-js **2.117.3**, npm Deno **2.9.6**, and PostgreSQL test driver **postgres 3.4.7**, all pinned. Node **22.19.0** and Docker **29.8.2** were verified; the local database image is PostgreSQL **17.11.0.004**. The test driver provides independent pooled SQL transactions and trusted local fixture setup; production mutations use Supabase RPC, not this driver.

Only the local `Cloudiator` stack is used here. Do not link, reset, or otherwise reuse unrelated hosted projects. Never print `supabase status` credentials, gateway configuration, or local environment files. The test runner reads status into memory and refuses non-loopback URLs. CLI status/telemetry and Docker may require the approved Windows sandbox escalation.

## Fresh checkout

```powershell
npm ci
npx supabase --help
npx supabase start --help
npx supabase start --exclude studio,realtime,storage-api,imgproxy,mailpit,logflare,vector,supavisor *> .supabase-start.log
npx supabase db reset --help
npx supabase db reset --local --no-seed --yes
```

The ignored startup log contains local credential output. Inspect only sanitized errors, never paste the complete log. In a second terminal, start the local Edge function:

```powershell
'GAME_ALLOWED_ORIGINS=http://127.0.0.1:3000' | Set-Content .env.edge.local
# Task 7: append a random worker secret without displaying it.
node -e "require('fs').appendFileSync('.env.edge.local','GAME_WORKER_SECRET='+require('crypto').randomBytes(32).toString('base64url')+'\n')"
npx supabase functions serve --help
npx supabase functions serve --env-file .env.edge.local
```

Then run:

```powershell
npm run test:db -- tests/db/identity.test.ts
npm test
npm run typecheck
```

The database suite resets **game tables in the local stack**, creates real Auth test users through the admin API, installs Google identities using trusted operator SQL, and signs only local test JWTs. This exercises real Auth `getUser`, PostgREST/RLS, SQL transactions, and the running Edge HTTP endpoint. It does not test Google's hosted OAuth exchange. `directEdge` uses the local database container's curl client to reach the Edge container through Docker networking, with bearer credentials passed on stdin. Local test users are disposable and removed by the next database reset. No test identity or clock-control endpoint exists in production code.

`npm run typecheck` must pass TypeScript, pinned Deno `check --frozen` on the actual Edge entrypoint, and an actual Deno runtime smoke test. The app compiler excludes only the Deno entrypoint and Deno test; their imported shared modules remain covered by both compilers. `supabase/functions/deno.lock` pins Deno's dependency graph separately from npm's lockfile.

## SQL source iteration and deployment artifact

Source: `supabase/sql/01-identity.sql` uses guarded DDL and replaceable functions/view/policies for controlled local reapplication. The deployable **M01 is `supabase/migrations/20261012050952_identity.sql`**. It was generated by the CLI from tested database state, inspected, reset/reapplied, and tested. Committed migrations are immutable; create a new migration for future changes.

Discover flags before use:

```powershell
npx supabase db query --help
npx supabase db advisors --help
npx supabase db pull --help
npx supabase migration list --help
```

The tested CLI 2.120.0 invocation `npx supabase db query --local --file supabase/sql/01-identity.sql` fails with `cannot insert multiple commands into a prepared statement`. This is a version-scoped observed limitation. Single-statement `db query --local` works. For this multi-statement source, the verified local psql fallback is:

```powershell
Get-Content supabase/sql/01-identity.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
npx supabase db advisors --local --type all --level info
npx supabase db lint --local --schema public,private --fail-on warning
npx supabase db pull identity --local --schema public,private --yes
npx supabase migration list --local
```

Inspect the exact generated path, grants, function privileges, security-invoker view, RLS, constraints, and private schema before staging. Never invent timestamps. Do not use the source file as a second migration on deployment. `db pull` can label the local database as “remote” in its progress/history messages; `--local` selects the local stack. Replaying with `db reset --local --no-seed --yes`, rerunning the integration suite, and rerunning advisors is a separate required check from source iteration. The initial uncommitted drafts `20261012050407` and `20261012050628` were discarded using local `migration repair --status reverted` and exact-file removal before the final M01; they were never committed or deployed.

## Protected owner query and command boundary

Task 5 can call the authenticated publishable-key client:

```typescript
const { data, error } = await client.from('owner_state').select('state').maybeSingle();
// error: surface the read failure; never interpret it as "no character".
// data === null: verified account has no gladiator; show creation.
// data.state: the canonical OwnerState DTO, ready for the management UI.
```

`public.owner_state` has `owner_id` and `state` columns. Select only `state`; ownership is enforced by the security-invoker view's underlying owner-only RLS policies. A no-character account returns zero rows; other owners see zero rows; anonymous callers lack SELECT permission. The same owner restrictions cover all base game tables. All client mutations and both command RPCs are denied to `anon`/`authenticated`. `private` is not exposed and grants no client USAGE. The service-role client is backend-only and calls SECURITY INVOKER RPCs. Creation results are `{ok:true, receiptId, value:{gladiatorId}}`; query `owner_state` afterward.

`create_gladiator(actor_id uuid, operation_id uuid, input jsonb)` consumes trusted backend preparation containing `{command, starterItems, staminaMaximum}`. HTTP accepts only canonical `GameCommand`; players cannot submit the prepared envelope, owner IDs, authoritative inventory, rolls, or stamina. `prepareCreation` uses the reviewed domain allocation/build/catalog/stats functions. SQL revalidates exact shapes, name/allocation/integer/catalog constraints, serializes each account, enforces global case-insensitive names, and writes initial state/items/ledger/receipt atomically. Account-scoped operation replay compares the original JSON command; a changed payload returns conflict. Successful and business-conflict receipts are durable. Invalid requests do not create receipts. Separate database-backed rolling limits count 60 authenticated attempts/minute and five creation attempts/minute; retries count too. The handler charges the general limit once and then the creation limit by parsed kind, including invalid creation payloads.

`loadOwnedInventory(actor)` queries the verified actor's gladiator and items on the server; later build commands must use it. Other valid command kinds return `unavailable` until their owning tasks implement transactions. No frontend read adapter is added here. Task 5 owns live owner loading; Task 10 owns public reads. Task 7 must replace the initial orientation projection with real activities and preserve the stored slot boundary. Task 8 owns progression/peak-strength processing. Pending builds and fee reservations have storage now; activation/refunds belong to Tasks 6–7. Future plans/seeds must remain in `private`, not owner-readable tables or receipts.

## CORS and hosting follow-up

The handler requires exact origins from backend `GAME_ALLOWED_ORIGINS`, emits an exact matching allow-origin header, rejects other Origin values before Auth/database work, and uses bearer JWTs rather than cookies. Missing Origin supports non-browser authenticated clients. Local configuration has no hosted credentials; Google OAuth credentials, provider enablement, callback, exact production redirects and origins remain Task 24.

Observed local exception: CLI 2.120.0's Kong 2.8.1 `functions-v1` route installs its default CORS plugin and rewrites the handler's allow-origin header to `*`. Official [CLI configuration](https://supabase.com/docs/guides/local-development/cli/config) and CLI help did not expose a supported gateway CORS override; official [Edge CORS guidance](https://supabase.com/docs/guides/functions/cors) places header handling in the function. No generated gateway configuration was changed. Controller-approved tests preserve exact headers and denial behavior through direct Edge HTTP, characterize the gateway wildcard, and prove gateway bad-origin POST returns 403 with no state change. **Task 24 must verify hosted exact-origin headers and origin denial before launch**; a hosted mismatch requires a documented supported boundary or explicit options, not silently accepting wildcard CORS. This local exception is not a production release approval.

Advisors can report informational unused FK/ownership indexes immediately after a reset. Keep the indexes: they support required ownership queries and FK maintenance, and a new database's statistics are not workload evidence. No warning/error or SQL lint finding is accepted for this checkpoint. Detailed run evidence lives in `docs/implementation/task-04-report.md`.
