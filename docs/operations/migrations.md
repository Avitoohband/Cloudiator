# Local identity backend and migrations

## Task 23.3: settlements released by due reveals (M19)

M19 is `supabase/migrations/20261019124532_dispatch_released.sql`, the latency fix found by Task 23.3's capacity run.
- **Generation.** CLI 2.120.0, `db pull dispatch_released --local --schema public,private --yes` (engine `migra`). The input
  was the tested third part of `supabase/sql/15-release.sql`, applied once to a clean M01–M18 reset.
- **Completion.** The draft was completed from that source; M01–M18 are unchanged.
- **Decision.** The controller's ruling on the Task 23.3 report (2026-10-19).

**Source iteration.** As for M17 and M18: the psql fallback after the container label check (Git Bash:
`docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < supabase/sql/15-release.sql`). The
whole file is reapplicable.

**The problem.** Every boundary after a slot of expeditions published at about 121.6 s, over spec §10.4's 120 s. Task 23.2's
Arena-only cadence tests (about 61 s) could not see it.
- An expedition's settlement depends on every reveal job of its plan, and its last stage, "Arrive at camp", falls due exactly
  at the next cutoff.
- `dispatch_workers()` counted only dependency-ready jobs, so at an all-expedition cutoff it dispatched three invocations for
  the 50 reveals.
- `runWorker` claims settlements before reveals, so the settlements those reveals released waited for the minute-1 tick, phase
  1 with them, and preparation for minute 2.

**What M19 changes.**
- **`private.released_by_due_reveals(job, now_ms)`** (new, STABLE, invoker, `search_path=""`). A settlement is released when it
  has an unfinished prerequisite, and every unfinished prerequisite is a reveal that is due, claimable (pending, or leased with
  an expired lease and attempts left) and dependency-ready itself. EXECUTE is held by the owner and `service_role`, because
  `claim_jobs` runs as `service_role`. The access matrix's pinned `service_role` snapshot gains this one line.
- **`private.dispatch_workers()`.** It counts a released settlement as claimable simple work beside its reveals, and reports
  `releasedSettlements`.
  - Unchanged: the five invocations per scheduled minute and the per-scheduled-minute accounting (Task 23.2, Decision 5); the
    batch limits; owner-only.
  - At an all-expedition cutoff it now dispatches five (100 simple jobs) where it dispatched three.
- **`public.claim_jobs`.**
  - Every kind but settlement is claimed as before.
  - A settlement claim walks the due settlements in due order and takes a released one only together with every reveal it
    waits on. Each row is locked with SKIP LOCKED and re-checked after the lock, so a reveal another claim holds leaves its
    settlement for later. A group is taken only while it fits the batch cap.
  - Leases come back reveals first.
  - The worker (`supabase/functions/_shared/backend/jobs.ts`, unchanged) runs each lease by its own kind, so the reveal
    completes before the settlement settles in the same invocation. `settle_activity` still refuses a settlement whose
    dependencies are unfinished.
  - The lease statement is shared by every kind. It is the 07-arena.sql statement, fed from the ordered list.
- **Result.** The cutoff tick settles the whole slot, and the boundary publishes in the next tick (61.5 s measured), as an
  Arena-only boundary does.

**The draft needed three completions** (checked one by one against the source):
1. The order: the draft created `claim_jobs` first. The helper now comes before the two functions that call it, as in the source.
2. The function ACLs: the source's revoke from public, anon and authenticated (and `service_role` for dispatch), and the
   `service_role` grant for the claim and the helper.
3. A provenance header and `notify pgrst`.

The three function statements are as generated, line for line. M19 re-emits no unchanged function.

**Tests.**
- `tests/db/activities.test.ts` "claims a settlement with the due reveals it waits on, never splits them, and dispatches for it
  in the same tick (M19)", on pinned database time in a rolled-back transaction:
  - dispatch counts 101 (50 reveals, a ready settlement, 50 released) and stays at five;
  - a claim with a cap of 4 takes the ready settlement and one pair, never half a pair;
  - a later claim takes ten pairs, reveal first;
  - a settlement whose reveal is not due, or is held by another worker, never comes;
  - RED before M19: 3 dispatched for 51.
- `tests/db/capacity.test.ts` "publishes within 120 s after a slot of expeditions, by the tick after the cutoff as an
  Arena-only boundary does", with the real scheduled tick and Edge worker (50 characters each):
  - Training, Woodland and Rest slots, then an Arena-only world;
  - RED before M19: slot 302 published at 121,554 ms; the cutoff tick dispatched 3 for 50 jobs and settled none of slot 301's
    50 expeditions;
  - after M19: 61,535 ms; the cutoff tick dispatched 5 for 100 jobs and settled all 50; Arena-only 61.6 s, as before.
- The capacity measurement's boundary check (every window of both scenarios under 120 s) is now always on; its budget checks
  stay behind `CAPACITY_GATE=1`.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` to M01–M18 matched Task 23.2's recorded M18 replay fingerprint byte for byte (1,134
  lines).
- The source-applied fingerprint differs from it only in the `claim_jobs` and `dispatch_workers` bodies and the new helper's
  line.
- A clean reset replayed M01–M19, with no source applied afterwards. Its fingerprint matched the source-applied one byte for
  byte (1,135 lines).
- Inspection of the replay:
  - `claim_jobs` and `released_by_due_reveals`: `{postgres=X/postgres,service_role=X/postgres}`; `dispatch_workers`:
    `{postgres=X/postgres}`;
  - all three invoker with `search_path=""`, the helper STABLE;
  - 44/44 `public`/`private` triggers enabled; both cron jobs active; no function executable by anon or authenticated.
- Lint is empty on the source and on the replay.
- Advisors on the fresh replay: 36 INFO `unused_index` notices (no statistics yet), no warnings or errors.
- `migration list --local` shows M01–M19.

**Release (Task 24).** Deploy M19 with or after M18. It changes no client contract and no Edge code. Task 24 still measures the
hosted `dispatch_log` spacing and worker CPU (C4).

## Task 23.2: timing correctness (M18)

M18 is `supabase/migrations/20261019102324_timing.sql`. It was generated with CLI 2.120.0 by
`db pull timing --local --schema public,private --yes` (engine `migra`) from the tested second part of
`supabase/sql/15-release.sql`, applied once to a clean M01–M17 reset, and completed from that source. M01–M17 are unchanged.
The plan is `docs/superpowers/plans/2026-10-19-task-23-release-readiness.md`, Task 23.2, Decisions 3–6.

**Source iteration.** As for M17: the psql fallback after the container label check (Git Bash:
`docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < supabase/sql/15-release.sql`). The
whole file is reapplicable: its Task 23.1 statements are idempotent revokes.

**What M18 changes.**
- **Dispatch budget per scheduled minute (Decision 5, C3).** `private.dispatch_workers()` counts the invocations dispatched in
  the scheduled minute the tick runs in, `[minute start, minute start + 60 s)` of database time sampled after the dispatch lock,
  instead of those of the last rolling 60 s. pg_cron starts each tick a few hundred ms late and dispatch is sampled after
  coordination, so the tick after a slower cutoff tick (for example +300 ms, then +60 250 ms) found the rolling window still
  holding the cutoff tick's invocations; at 50 characters publication then waited for a third tick (121 s). The ceiling stays
  five per scheduled minute (about 216 000 in a 30-day month, 5 × 1 440 × 30). Two consecutive minutes can now send up to ten
  invocations within 60 s across their edge. The function stays owner-only (`{postgres=X}`).
- **Published slot in the public revision state (Decision 6, C5).** `public.world_revision_state.published_slot_index` (bigint,
  null before the first coordination) is a copy of `private.coordinator.published_slot`. It is written by
  `private.mirror_published_slot()` through the deferred constraint trigger `mirror_published_slot` (after update of
  `published_slot`, when it changed), so it changes exactly when the coordinator's transaction commits, never on a rollback,
  and it takes the global revision row last, as every projection write does. A publication already holds that row from phase 8;
  the other changes of `published_slot` (first coordination, skipped empty boundaries, an operator) take it only at commit.
  `public.world_revision` appends the column (`create or replace`, so its grants and `security_invoker` stay), and visitors and
  players read it as `RevisionState.publishedSlotIndex` (optional and additive; `src/lib/api/reads.ts`). A slot with
  `publishedSlotIndex < slotIndex` is still being prepared; Task 23.4 replaces the client's five-minute grace with it. The
  trigger function is owner-only: a trigger fires without an EXECUTE grant, including when the worker coordinates as
  `service_role` (tested). The access matrix's `service_role` snapshot is unchanged; no new public object, so `OPEN` is
  unchanged too.
- **Not in M18:** the worker's bounded retry of a busy coordination (Decision 4, `supabase/functions/_shared/backend/jobs.ts`)
  and the test timeouts (Decision 3). See "Worker and tests" below.

**The draft needed four completions** (checked one by one against the source):
1. Its `create or replace view "public"."world_revision"` named no options. CREATE OR REPLACE VIEW replaces a view's options with
   the ones it names, so it would have dropped `security_invoker`. It is replaced by the source's statement, verbatim.
2. It omitted both function ACLs; the source's two `revoke all … from public, anon, authenticated, service_role` are added.
3. It omitted the backfill of `published_slot_index` from the coordinator; the source's statement follows the trigger.
4. A provenance header and `notify pgrst`.

The column, both functions and the constraint trigger are as generated, and the trigger follows its function. It re-emits no
unchanged function: the two function bodies are byte-identical to the source's (compared programmatically).

**Worker and tests (not migration content).**
- **Bounded retry of a busy coordination (Decision 4, C2).** In `runWorker`, a coordination after the invocation's own work
  that answers `busy` is retried at most three times, at least 250 ms apart; a coordination still busy then is left to the next
  tick and counted in the report's `deferred`. Two refinements, each from an observed failure of the literal rule: the opening
  coordination (before any work) is asked once, and each wait adds up to 250 ms of random jitter (`COORDINATION_RETRY`). The
  invocations of one tick start and often finish together, and retries in step admit one of them per round, so the fifth of
  five exhausted its retries (twice) although each coordination held the coordinator for milliseconds.
- **Stable-slot waits (Decision 3, C16).** `tests/stable-slot-waits.test.ts` scans `tests/db/*.test.ts` statically for every
  `stableRealSlot(margin)` call and every inline `if (remaining < margin) … setTimeout(resolve, remaining + 1_000)` wait,
  through helpers, and fails with file and line unless the test's (or hook's) timeout covers the longest sleep plus the default
  test (or hook) timeout for its own work. It found the two named causes (`arena.test.ts` 121 s in 60 s, `tournaments.test.ts`
  61 s in the 20 s default) and two hooks (`market.test.ts` 181 s in 200 s, `shops.test.ts` 121 s in 150 s); their timeouts are
  now written as the sum.
- The production-cadence tests (`arena.test.ts`, `tournaments.test.ts`) tick at realistic offsets, +300 ms every minute
  ("cleared") and alternately +300/+250 ms ("held", 59 950 ms after the cutoff tick), and require publication within 120 s in
  both. The access matrix's write probe now updates an updatable column where the relation has one, because
  `world_revision`'s new plain column made the view auto-updatable and the probe's first (computed) column answered 0A000
  before any privilege check.

**Replay evidence.**
- The clean `db reset --local --no-seed --yes` to M01–M17 matched Task 23.1's recorded M17 replay fingerprint byte for byte
  (1127 lines).
- The source-applied fingerprint differs from it only in the `dispatch_workers` body, the new function (owner-only), the
  `world_revision` definition (same ACL and `security_invoker=true`), the two new columns, the trigger, its constraint row and
  its enabled state, plus the extension line below.
- A clean `db reset --local --no-seed --yes` replayed M01–M18, with no source applied afterwards. Its fingerprint (the M17
  coverage plus one line, the coordinator's published slot equals its public copy; 1134 lines) matched the source-applied
  fingerprint byte for byte, and again after the full test runs.
- Inspection of the replay: both functions `{postgres=X/postgres}`, invoker, `search_path=""`; `world_revision`
  `{security_invoker=true}` with anon, authenticated and service_role SELECT only; the trigger enabled, deferrable and initially
  deferred; all 44 `public`/`private` triggers enabled; both cron jobs active; no function executable by anon or authenticated.
- The backfill cannot act on an empty replay (no published slot), so it was checked on the replay inside a `DO` block that
  always raises: with the trigger disabled and the coordinator at slot 12345, the verbatim statement set the copy from null to
  12345, and a second run changed no row. Afterwards both were null and the trigger enabled.
- `npm run test:db` passed **269/269** in 16 files on the replay, with the Edge container's start time unchanged across the run.
- Lint is empty. Advisors report one INFO unused-index notice (`jobs_gladiator_idx`) after the tests and no warnings or errors.
  `migration list --local` shows M01–M18.

**Release (Task 24).** Deploy M18 and the `game-worker` together, and before a client that reads `published_slot_index`:
`readRevision` selects the column, which an M17 database refuses, so the revision read would fail. Task 24 still measures the
hosted `dispatch_log` spacing and worker CPU (C4).

## Task 23.1: release access matrix and hardening (M17)

M17 is `supabase/migrations/20261019075634_release.sql`. It was created with CLI 2.120.0 by `migration new release`, because
`db pull release --local --schema public,private --yes` (engine `migra`) on the source-applied database reported "No schema
changes found" and wrote no draft. It was then completed from the tested `supabase/sql/15-release.sql`. M01–M16 are unchanged.

**Source iteration.** The source was applied with the psql fallback documented under M16 below, after the container label
check (Git Bash: `docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <
supabase/sql/15-release.sql`). Source application is iteration evidence only; the replay below is the migration-artifact proof.

**The access matrix** (`tests/db/access-matrix.test.ts`). Every expectation comes from the catalog through the exported operator
audit `scripts/access-audit.sql`, one read-only SELECT (see the runbook's "Release access audit"). The only hand-written lists
are the OPEN visitor projections (`tests/fixtures/access.ts`, shared with `tests/db/visitor-access.test.ts`) and a pinned
`service_role` snapshot. It checks, for PUBLIC, anon and authenticated:
- every relation, column and sequence privilege of every kind in `public` and `private`, MAINTAIN, REFERENCES and TRIGGER
  included: anon holds exactly SELECT on the OPEN objects (column by column on `tournament_views`); authenticated holds only
  SELECT, only in `public`, and every table it can read has a SELECT policy for it; PUBLIC holds nothing;
- that every permissive read policy for authenticated or PUBLIC on a table outside OPEN references `auth.uid()` (Task 23.1
  review I1), and that a second account with a gladiator of its own reads, through the Data API and from every relation
  authenticated can read outside OPEN, its own account, gladiator and activity ids and never the owner's;
- USAGE on schema `public` only (the private schema is not exposed), no role membership, no CREATE on the database;
- row security on every table and `security_invoker` on every view in both schemas, and no materialized view;
- for every function in both schemas (extension members excluded): not SECURITY DEFINER, `search_path=""`, and no EXECUTE;
- the default privileges of the role that owns our objects (postgres) in `public`, `private` and globally, as PostgreSQL
  combines them; and, in practice, that a new table, sequence and function postgres creates in either schema (inside a
  transaction that rolls back) gives no client role anything;
- `service_role`'s whole effective set against the pinned snapshot; drift fails and lists the lines added and removed;
- through the Data API as the owner, another account and a visitor: every write to every public relation is refused (42501,
  or 55000 where a view cannot take the command at all), every public RPC is refused (42501), every private table and function
  is unreachable (PGRST106, exposure), and no base table changes;
- that private seeds, plans and snapshots (activity snapshots and seeds, expedition plans, job inputs and seeds, Arena
  assignment seeds, build preparations) never appear in anything their owner can read.

The visitor, row-security, function, default-privilege and owner-policy cases also prove, in a transaction that always rolls
back, that the audit reports the violation they guard against. The audit's policy rows carry each policy's permissive flag and
an md5 of its USING and WITH CHECK expressions, so the hosted comparison also sees a changed policy body.
`anonWritable` in `tests/db/visitor-access.test.ts` now also counts REFERENCES, TRIGGER and MAINTAIN.

**What the matrix found on the M01–M16 replay, and M17 revokes** (the two named items and controller rulings A–C):
1. anon's MAINTAIN on the eight M01 owner tables (`builds`, `gladiators`, `item_instances`, `operation_receipts`,
   `reservations`, `schedules`, `wallet_ledger`, `wallets`). M01's generated revokes covered REFERENCES, TRIGGER and TRUNCATE.
2. M01's default `GRANT UPDATE ON SEQUENCES` to anon and authenticated in `public`.
- A. authenticated's MAINTAIN on the same eight tables.
- B. authenticated's MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on the `owner_state` view (recorded under M13 below).
- C. postgres's default table privileges in `public`: anon and authenticated TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on
  every new table.

M17 runs `revoke all` on the eight tables and `owner_state` from anon; revokes INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
TRIGGER and MAINTAIN on the same nine relations from authenticated, which keeps SELECT; and runs `alter default privileges for
role postgres in schema public revoke all on tables` (and on sequences and on functions) from anon and authenticated. The
statements name every non-SELECT kind and are idempotent, so they also clear fuller platform defaults on a hosted project. On
the replay the function defaults held no client grant, so that revoke changes nothing there. After M17 a client role holds only
SELECT (anon on the OPEN objects; authenticated on those and on its owner-filtered tables) and USAGE on schema `public`.

**Accepted exceptions** (controller rulings):
- **D, backend.** `service_role` keeps MAINTAIN on the eight tables; MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on
  `owner_state`; and the defaults UPDATE on new `public` sequences and TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on new
  `public` tables. All are pinned in the matrix's snapshot.
- **E, platform.** Outside the matrix; the audit lists them in its `platform-default` and `database` sections for Task 24:
  - supabase_admin's default privileges in `public`, `graphql`, `graphql_public` and `supabase_functions`: anon,
    authenticated and service_role receive every privilege on its new tables, sequences and functions. postgres is not a
    member of supabase_admin and cannot change them; none of our objects is created by supabase_admin.
  - postgres's platform-provided defaults in schema `storage` (the same grants). Unlike supabase_admin's, postgres could revoke
    these; the controller ruled them an accepted, harmless exception, because we create nothing in `storage`.
  - PUBLIC's USAGE on schema `public`, and CONNECT and TEMPORARY on the database (so anon, authenticated and service_role
    hold them too). No client role may CREATE on the database.

**Completion.** The generator wrote nothing: its diff did not see MAINTAIN, the owner view's privileges or default privileges.
Every M17 statement is the source's, verbatim apart from the transaction, which the CLI supplies (statement equality checked).
A provenance header and `notify pgrst` were added. There is no function, trigger, policy, table, backfill or initialization
change. The CLI's other diff engine, `pg-delta`, was not tried: the established engine is migra, and this task allows no
downloads.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` to M01–M16 matched Task 22.3's recorded M16 replay fingerprint byte for byte
  (1127 lines, the M16 coverage).
- The source-applied fingerprint differs from it only in the nine relation ACLs and the two `public` default rows (tables,
  sequences) above.
- A clean `db reset --local --no-seed --yes` replayed M01–M17, with no source applied afterwards. Its fingerprint matched the
  source-applied fingerprint byte for byte (1127 lines), and again after the full test run. The audit's output was identical on
  the source-applied database and on the replay.
- Inspection of the replay: the eight tables are `authenticated=r`, `service_role=arwdm`; `owner_state` is `authenticated=r`,
  `service_role=rDxtm`; postgres's `public` defaults are `{postgres=arwdDxtm, service_role=Dxtm}` (tables),
  `{postgres=rwU, service_role=w}` (sequences) and `{postgres=X}` (functions); all 43 `public`/`private` triggers are enabled;
  both cron jobs are active.
- `npm run test:db` passed **265/265** in 16 files on the replay, with the Edge container's start time unchanged across the run.
- Lint is empty. Advisors report four INFO unused-index notices (`boundary_members_gladiator_idx`, `jobs_gladiator_idx`,
  `market_listings_buyer_idx`, `market_listings_receipt_idx`) and no warnings or errors. `migration list --local` shows
  M01–M17.

**Release (Task 24).** M17 needs PostgreSQL 17 (`maintain` is a PostgreSQL 17 privilege; the audit uses it too) and no client
or worker change. After deploying it, run the release access audit against the hosted project and compare it with a local
replay, as the runbook's "Release access audit" describes. Any difference outside the platform sections blocks the release
until explained; a difference inside them is recorded as the hosted platform's state.

## Tasks 22.1–22.3: retention, durable ticks, whole seasons and operator health (M16)

M16 is `supabase/migrations/20261018191110_operations.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull operations --local --schema public,private --yes` from the tested `supabase/sql/14-operations.sql`, applied once
to a clean M01–M15 reset. It covers Tasks 22.1, 22.2 and 22.3 together; 22.1 and 22.2 had no migration of their own.
M01–M15 are unchanged.

**Source iteration.** During Tasks 22.1–22.3 the source was applied to the local stack with the psql fallback documented in
"SQL source iteration and deployment artifact" below, after confirming that the container belongs to the local Cloudiator
stack:

```powershell
(docker inspect -f '{{json .Config.Labels}}' supabase_db_Cloudiator | ConvertFrom-Json).'com.supabase.cli.project'   # must print Cloudiator
Get-Content supabase/sql/14-operations.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
```

From Git Bash the label check can be `docker inspect -f '{{index .Config.Labels "com.supabase.cli.project"}}' supabase_db_Cloudiator`
and the input `docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <
supabase/sql/14-operations.sql`; check the exit status. Do not use the `index … "…"` template in Windows PowerShell 5.1: it
strips the embedded quotes and docker fails with `function "com" not defined` (observed 2026-10-19, Task 22.4). Source
application is iteration evidence only; the replay below is the migration-artifact proof.

**A first draft was discarded.** The first draft, `20261018190708_operations.sql`, replayed cleanly, but `db lint` on it
reported plpgsql_check warnings in three new function bodies: an untyped `'{}'` array initializer in `expire_listings`,
`health_alerts` marked IMMUTABLE although `jsonb_build_object` is STABLE, and `health_report` marked STABLE although
`pg_database_size` and `pg_total_relation_size` are VOLATILE. It was never committed. It was removed with local
`migration repair --status reverted 20261018190708` and exact-file removal. The source was fixed, the database reset to
M01–M15, the source applied once more and M16 generated again. The new draft differs from the first only in those three lines.

It adds ([plan](../superpowers/plans/2026-10-18-task-22-retention-operations.md), Decisions 2–8 and the retention design):
- **State.** Three backend-only tables. RLS is on, and `service_role` may only SELECT them (`backend_only` policy):
  - `private.retention_state`, a singleton holding the two watermarks (`detail_through_slot`, `summary_through_slot`, seed
    `-1`), `last_run_at_ms` and `last_result`;
  - `private.wallet_checkpoints`, the folded part of each wallet. Invariant: `wallets.money = coalesce(cp.money,0) +
    Σ wallet_ledger.money_delta`, and the same for renown. Its guard refuses a delete and any update that does not increase
    `ledger_rows`;
  - `private.operations_events` (`cleanup`, `market-sweep` and `dispatch` events), holding a SQLSTATE and never raw text, kept
    30 days.
- **Indexes.** `wallet_ledger(created_at)` for the fold, a partial `activities(slot_index)` index on still-available replays
  for the flip, and `operations_events(at_ms)` for the window prune and the health report.
- **Guards.**
  - `private.guard_receipt` (BEFORE UPDATE OR DELETE on `public.operation_receipts`) refuses every delete. It allows one update
    only: a settlement receipt's `result`, once, to `{"compactedAtMs":n}`.
  - `private.guard_tournament_bout_result` replaces `guard_frozen` on `public.tournament_bout_results`. It allows only the
    compaction of `result.battleLog` to `result.fight` (`durationMs`, `victoryReason`, `tieBreakReason`). Deletes stay allowed.
- **Projection cost.** (a) `project_changed_character` is dropped from `public.activity_stages`; `projection_changed` stays.
  (b) `private.project_character` is M15's body with an anti-join before the `recent_results` upsert: the same rows, but an
  unchanged row is no longer written or locked.
- **Cleanup.** `private.cleanup_history(now_ms bigint) returns jsonb` is one bounded transaction with `lock_timeout` 500 ms,
  never ahead of `private.planning_now_ms()`. `private.cleanup_tick()` is inert while the scheduler is disabled; otherwise it
  writes one `cleanup` event per call (ok, or the failure's SQLSTATE). `cron.schedule('cloudiator-cleanup','23 * * * *',
  'select private.cleanup_tick()')` registers it hourly; pg_cron 1.6.4 upserts a job by name.
- **Durable ticks.**
  - `private.expire_listings` closes each seller's due listings in its own subtransaction. It sweeps at most 50 sellers per
    call, the longest due first; the rest wait for the next minute. That keeps one tick's subtransactions below PostgreSQL's
    64 cached sub-XIDs.
  - A sweep with failed sellers writes one `market-sweep` event: the first SQLSTATE, plus `{"failedSellers": n, "sqlstates":
    [...]}` with every distinct SQLSTATE.
  - `private.cron_tick` runs `dispatch_workers()` in its own block and records a `dispatch` event on failure. It also records a
    `market-sweep` event (SQLSTATE, no detail) when its whole sweep fails, so pg_cron's "succeeded" is not the only trace.
  - A failure to record either event is contained, so it never rolls back the tick's coordination.
- **Whole seasons.** `private.season_bounds(index)` (STABLE: it reads `private.season_epoch`) gives boundary phase 2
  (`private.boundary_close_season`), phase 4 (`private.boundary_recompute_leagues`) and the season row backfill their bounds.
  Phase 4 also inserts the row of the season it rates, which removes M15's known limit (M15 itself is unchanged).
- **Health (Task 22.3).** `private.health_report(now_ms bigint) returns jsonb` and `private.health_alerts(report jsonb)`;
  see "Operator health report" below.
- **Grants.**
  - Nobody may EXECUTE `cleanup_history`, `cleanup_tick`, `expire_listings`, `cron_tick`, `health_report` or `health_alerts`,
    including `service_role`. Only the owner may: pg_cron and the operator.
  - The three guards, the projector, `season_bounds` and the two boundary phases keep `service_role` EXECUTE, because the worker
    coordinates boundaries as `service_role`.

**The draft needed seven completions before commit** (the generator's omissions recorded from M03 to M15, checked one by one
against the tested source):
- It created the `guard_receipt` and `guard_tournament_bout_result` triggers at the top, before either function existed; both
  now follow `private.guard_tournament_bout_result()`. (`guard_wallet_checkpoint` was already after its function.)
- It omitted the `retention_state` seed row; `insert into private.retention_state(singleton) values(true) on conflict do
  nothing` now follows the table's constraints.
- It only added table grants. Source-equivalent `revoke all … from public, anon, authenticated, service_role` statements now
  precede them on all three tables.
- It omitted every function ACL. The source's revoke/grant pairs for the thirteen new or replaced functions are appended.
- It omitted the season row backfill. The source's statement is appended after `private.season_bounds` exists (the
  `tests/db/recovery.test.ts` case "ships the season row backfill in M16 after season_bounds exists" checks the text and its
  position).
- It omitted the `cloudiator-cleanup` pg_cron registration, which is appended.
- A provenance header and `notify pgrst` were added.

The draft did contain both dropped triggers (`project_changed_character` on `activity_stages`, `guard_frozen` on
`tournament_bout_results`), the RLS, the three `backend_only` policies, the indexes and `set check_function_bodies = off`.
It re-emits no unchanged function: its thirteen functions are exactly the source's. Their bodies are byte-identical to the
source text (compared function by function), including the five replaced ones: `project_character`, `expire_listings`,
`cron_tick`, `boundary_close_season` and `boundary_recompute_leagues`.

**Retention order and pg_net.** The cleanup's FK-safe step order, table by table, is in the header of
`supabase/sql/14-operations.sql` ("Step order of one call"). The 90-day pass deletes activities last, so a forgotten
referencing row fails the whole call closed. `net._http_response` is left to pg_net. On the local stack (pg_net 0.20.4),
`pg_net.ttl` is `6 hours`, so cleanup adds no delete for it. The hosted value is a Task 24 check.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M16, with no source applied afterwards. Before generation, the
  M01–M15 reset matched M15's recorded fingerprint byte for byte (1029 lines).
- The schema fingerprint (1127 lines) matched the source-applied fingerprint byte for byte. It extends M15's coverage with
  every `public`/`private` trigger's enabled state and the `retention_state` seed row. It was identical again after the test
  run.
- Inspection of the replay:
  - ACLs: the six owner-only functions grant only `postgres`; the seven backend functions also grant `service_role`.
  - Triggers: all are enabled (`O`). `activity_stages` keeps only `projection_changed`.
  - The three tables have RLS and `service_role=r` only.
  - Both cron jobs are active (`cloudiator-coordinate` every minute, `cloudiator-cleanup` at minute 23).
  - The retention seed row is present.
- The backfill cannot run on an empty replay (no ratings), so it was checked separately on the replayed database, verbatim
  from M16, inside a `DO` block that always raises. With ratings in seasons 0, 1, 3 and 7 at epoch 0, it created exactly those
  four rows with `seasonAt`'s bounds. Run again, it added nothing. Afterwards the database had no epoch, season, character or
  rating row.
- `npm run test:db` passed **252/252** in 14 files on the replay, with the Edge container's start time unchanged across the
  run.
- Lint is empty. Advisors report four INFO unused-index notices (`jobs_gladiator_idx`, `tournament_entries_gladiator_idx`,
  `market_listings_buyer_idx`, `market_listings_receipt_idx`), none on M16's tables, and no warnings or errors.
  `migration list --local` shows M01–M16.

### Operator health report

`npm run health` (`node scripts/health.mjs`) prints `private.health_report(private.planning_now_ms())` as JSON.
- **Exit codes.** `0` healthy, `1` alerts, `2` failure. On a failure it prints `{"ok":false,"code":…}`, plus a SQLSTATE when
  the database gave one. It never prints the connection string, a key or raw error text.
- **Connection.**
  - By default it discovers this checkout's local stack in memory, as `scripts/test-db.mjs` does, and refuses a non-loopback
    database.
  - An operator connection is passed only through `CLOUDIATOR_DB_URL`, the database owner's connection string. A non-loopback
    host also needs `--remote`, and then SSL is required unless the URL sets `sslmode`.
  - Since Task 22.4 the URL is parsed once (`scripts/operator-db.mjs`) and the driver receives only the parsed fields; an
    authority with `,` or more than one `@` is refused. `require` encrypts without verifying the server; the runbook's
    "Connections and TLS" adds `sslmode=verify-full` with the hosted CA. Every failure code and what to do about each alert
    are in `docs/operations/runbook.md` ("Health check").
  - The report runs in one read-only transaction (`statement_timeout` 30 s, `lock_timeout` 5 s).

The report holds:
- the checkpoint: `checkedAtMs`, `currentSlot`, `publishedSlot`, `slotsBehind`;
- `coordinator` (`lastError` as a SQLSTATE, `lastFailedSlot`, `leaseHeld`) and `scheduler.enabled`;
- `boundaries`: up to 20 incomplete boundaries with their phase, wait reason and time since they opened;
- `jobs`: counts by kind and status; up to 20 overdue jobs and up to 20 operator jobs, with their totals and job ids (for
  `private.resume_operator_job`);
- `attempts24h`: count, failures by code, and per-kind p50/p95/max durations of completed attempts;
- `dispatch`: `lastAtMs`, `lastHour`;
- `cleanup`: the watermarks, the last run's durations and `more` flags, `moreSinceMs`, and the current failure streak;
- `events`: per source, the latest failure in 24 hours and the last hour's failures with their distinct SQLSTATEs;
- `resources`: database size against the 250 MB budget and the ten largest tables;
- `cpu: "not available"`;
- `alerts`.

Alerts:
- `boundary-behind`: the next slot is more than 10 minutes late, or nothing is published while the scheduler is on;
- `boundary-waiting`: a boundary has been open for more than 10 minutes;
- `operator-jobs`;
- `overdue-jobs`: pending more than 10 minutes past due, or leased with a lease expired more than 10 minutes ago;
- `cleanup-stale`: the scheduler is on and no successful cleanup for 26 hours, or never;
- `cleanup-failures`: the last three or more cleanup ticks failed;
- `cleanup-backlog`: `more` for 24 hours;
- `tick-failures`: sweep or dispatch failures in the last hour, aggregated;
- `database-size`: a warning from 80 % of the budget, an alert from 100 %.

Free-text columns appear only as SQLSTATEs or failure codes, otherwise as `unrecognized`. Monthly egress (3 GB) and function
invocations (300,000) are read from the hosting dashboard; the Edge runtime exposes no per-request CPU.

**Release (Task 24).**
- Deploy M16 together with Task 22.5's client change. After seven days, the cleanup turns a public bout result's `battleLog`
  into `fight`, and `src/lib/api/reads.ts` must read `fight` before then.
- Set the season epoch first (M09's note). Enable `private.scheduler` only after the epoch is set.
- Then verify that `select jobname, schedule, active from cron.job` lists `cloudiator-coordinate` (`* * * * *`) and
  `cloudiator-cleanup` (`23 * * * *`), both active.
- Check the hosted `current_setting('pg_net.ttl', true)`. If it is absent, add the guarded `net._http_response` delete from the
  retention design.
- Set `CLOUDIATOR_DB_URL` as in the runbook's "Entering a connection string" (`docs/operations/runbook.md`; never on a command
  line), then run `npm run health -- --remote` and remove the variable. `cleanup-stale` stays on until the first hourly
  cleanup, unless the operator runs `select private.cleanup_tick()` once after enabling the scheduler.

## Tasks 21.1 and 21.2: seasons (M15)

M15 is `supabase/migrations/20261018123715_seasons.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull seasons --local --schema public,private --yes` from the tested `supabase/sql/13-seasons.sql`, applied once to a clean
M01–M14 reset. It covers Tasks 21.1 and 21.2 together; 21.1 had no migration of its own. M01–M14 are unchanged.

It adds 28-day seasons of 504 slots ([plan](../superpowers/plans/2026-10-18-task-21-seasons.md), Decisions 3–6):
- `public.seasons`, one row per season: its index, start, end (start + 2,419,200,000 ms) and close time. The `guard_season`
  trigger refuses a delete, keeps the bounds fixed and lets `closed_at_ms` change once, from null to a value.
- `public.season_standings`, the frozen archive: every rating row of a closed season with its rank, counters, the
  promoted, inactive and reward-eligible flags, and its award place. It has no foreign key (archives outlive characters), and
  `guard_frozen` refuses updates and deletes.
- `private.season_awards`, one award per character and season: the money and renown actually credited, the title, the badge
  and the receipt. `guard_frozen` protects it, and the deferred `project_changed_character` trigger republishes the
  character's `public_profiles.prestige`.
- Grants. `anon` and `authenticated` may SELECT `seasons` and `season_standings` (`player_read … using (true)`), nothing else.
  `service_role` has select, insert and update on `seasons`, and select and insert on `season_standings` and
  `season_awards`. `season_awards` is backend-only.
- New functions: `private.season_rules()`, `private.guard_season()` and `private.close_season(bigint,bigint)`. Replaced:
  `private.guard_arena_rating()` (a closed season's rating rows are frozen), `private.project_character(uuid)` (prestige)
  and `private.boundary_close_season(bigint)` (phase 2, now `plpgsql volatile`). `public.arena_standing_reads` gains a last
  column, `reward_eligible`, and stays `security_invoker`. Only `service_role` may EXECUTE the six functions, because the
  worker coordinates boundaries as `service_role`.

**Phase 2.** `boundary_close_season(T)` runs under `advance_boundary`'s coordinator and boundary row locks. It returns null
and does nothing when no epoch covers slot T; phase 4 then waits with `epoch`. Otherwise it samples
`private.planning_now_ms()` once and closes every open season with an index below `season_index(T)`, in ascending order. It
then inserts T's own season row with the epoch bounds (`on conflict do nothing`), before phase 4 creates that season's rating
rows. It always returns null and never holds the phase. It closes by season row, not at "the first boundary of a season", so
when `coordinate_work` skips a season's first boundary because nobody is due, the next boundary it runs still closes the
season. Phase 1 has already proven slot T − 1 settled. Settlement is globally ordered, so every Arena and tournament credit
of the closing season, including a tournament's minute-80 settlement, committed before the close. An error rolls back the
whole boundary subtransaction, and the next coordination retries it.

The draft needed six completions before commit:
- It created the `guard_season` trigger on `public.seasons` before `private.guard_season()`. The trigger now follows its
  function.
- Its `create or replace view public.arena_standing_reads` had no options. PostgreSQL replaces a view's options on
  `CREATE OR REPLACE VIEW`, so the view would have lost `security_invoker`. `with (security_invoker=true)` is restored.
- It only added table grants. Source-equivalent `revoke all … from public, anon, authenticated, service_role` statements now
  precede them on all three tables. Without them the new public tables would keep the platform's default client privileges.
- It had no view privileges, so the source's revoke/grant pair for `arena_standing_reads` is added.
- It omitted every function ACL. The source's revoke/grant pair is appended for the six new or replaced functions.
- It omitted the backfill (below). The backfill, a provenance header and `notify pgrst` were added.

The draft re-emits no unchanged function: the six functions above are the only ones. Its other triggers reference the
existing `private.guard_frozen()` and `private.project_changed_character()`.

**Backfill.** M15 inserts a season row for every distinct season already in `private.arena_ratings`, with bounds
`(epoch + 504 × index) × 4,800,000` ms (as `seasonAt` in `supabase/functions/_shared/domain/season.ts`) and `on conflict do
nothing`. On a database without ratings, such as a fresh replay or production before Task 24 sets the epoch, it inserts
nothing. The replay could not exercise it, so it was run separately on the replayed database, verbatim from M15, inside a
`DO` block that always raises at its end. With ratings in seasons 0, 1, 3 and 7, it created exactly those four rows with the
epoch-0 bounds. Run again, it added nothing. With the epoch at 10, the bounds followed the epoch.

**Release (Task 24).** M15 needs no worker change: the close runs inside boundary phase 2. On a database whose ratings span
earlier seasons, the next boundary after M15 closes, archives and awards every backfilled earlier season. Production
deploys M15 before Task 24 sets the epoch, so nothing is backfilled there, and the first launch boundary creates season 0's
row. `public_profiles.prestige`, always `[]` before, now holds award objects (`seasonIndex`, `league`, `place`, `badge`,
`title`). Task 21.3 changes the `PublicProfile.prestige` type from `string[]`; no client reads it before then.

**Known limit (carried to M16).** Phase 2 creates a season's row only when the epoch is set at that boundary, so "every season
with ratings has a row" holds only when the epoch is set before any boundary with members reaches phase 2. If the epoch is set
while a boundary with members waits at phase 4 (`'epoch'`), phase 4 can rate a season before its row exists. M16, the next
schema change (Task 22), adds a defensive `insert into public.seasons … on conflict do nothing` to phase 4
(`private.boundary_recompute_leagues`) and a `private.season_bounds(index)` helper that phase 2, the backfill and phase 4
share. M15 is never edited; Task 24's launch step sets the epoch before any boundary with members exists.

**Retention (Task 22).** Keep `season_standings`, `seasons` and `season_awards` indefinitely (spec §11). A season award
references its character and its receipt, so removing a character or a receipt must account for the award first.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M15, with no source applied afterwards.
- The schema fingerprint (1029 lines, M14's coverage) matched the tested source byte for byte. It was identical again after
  each test run, so the tests' `season_index` stand-in and injected failure trigger were removed. The fingerprint does not
  record whether a trigger is enabled; a separate check found all 42 `public` and `private` triggers enabled.
- `npm run test:db` passed **216/216** in eleven files on the replay, with the Edge container's start time unchanged across
  the run.
- Lint is empty. Advisors report five INFO unused-index notices, none on the new tables, and no warnings or errors.
  `migration list --local` shows M01–M15.

## Task 18.1: marketplace listings (M14)

M14 is `supabase/migrations/20261017144347_market.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull market --local --schema public,private --yes` from the tested `supabase/sql/12-market.sql`. M01–M13 are unchanged.
A first draft, `20261017142821_market.sql`, was discarded before commit with local `migration repair --status reverted` and
exact-file removal. A review before commit narrowed the purchase's item lock to the listed item while the seller still owns it.
The source was changed, reapplied after a reset to M13 and retested, and M14 was generated again. The new draft differs from
the first only in that statement.

It adds fixed-price listings ([plan](../superpowers/plans/2026-10-17-task-18-marketplace.md), Decisions 2–9):
- `private.market_listings`, the authoritative rows (`open`, `sold`, `cancelled` or `expired`). Backend-only, with a guard
  trigger: only an open row changes, and only its terminal fields. `item_id` has no foreign key, because a sold item may
  later be sold to an NPC or discarded.
- `public.market_offers`, the sanitized projection of open listings: seller id and name, the item's catalog fields, stats and
  quantity, the price and the times. `anon` and `authenticated` may SELECT it; only the backend writes it. Its one select
  policy hides an offer from its expiry time on, before any sweep. It has no `projection_changed` trigger, so offers never
  bump `world_revision`.
- `public.create_listing`, `cancel_listing` and `buy_listing` `(actor_id uuid, operation_id uuid, input jsonb)`. They are
  security invoker with an empty search path, and only `service_role` may EXECUTE them. Each is backed by
  `private.market_command`.
- `private.expire_listings(now_ms bigint)`, the sweep, granted to nobody. `private.cron_tick()` now calls it in its own
  `begin … exception` block after coordination; its result gains an `expiry` field.

**Lock order.** Create and cancel take the actor's account lock, then the gladiator row, the wallet, the items in id order
and the listing row. Buy first reads the listing's seller without a lock. It then takes both account locks in gladiator
order, then both gladiator rows, both wallets, the buyer's items and the listed item (while the seller still owns it), and
the listing row. `private.planning_now_ms()` is sampled after all of these locks. Each command expires its seller's own due
listings first. The sweep try-locks each seller's account lock, skips a busy seller, and uses `FOR UPDATE SKIP LOCKED`.

**Deadlocks (corrected by Task 18.2).** The purchase's account-lock order matches `boundary_start`'s order; a residual
deadlock aborts atomically and the same operation can be retried. A boundary does not always take its account locks in
global `gladiator_id` order, so PostgreSQL may still abort one side with SQLSTATE 40P01. The aborted transaction writes no
receipt and moves no money or item. The backend's `market` adapter answers 40P01 (and 40001) with
`{ ok: false, code: 'processing', retryAfterMs: 1000 }`, and the client sends the same `operationId` again.
- `tests/db/market.test.ts` produces a real deadlock through the adapter, then checks the retry. It holds the higher
  account's lock and lets the purchase take the lower one. It then asks for the lower lock, so the purchase is the aborted
  side.
- The older comment "a purchase cannot deadlock a boundary" in `private.market_command` (`12-market.sql` line 166, M14
  line 271) overstates this. It is left as it is: M14 is immutable, and the source must stay identical to it.

**Transfer.** A sale is two UPDATEs: clear the reservation, then change `gladiator_id` and `item.ownerId` together. This is
required by `guard_reserved_item` and the item CHECK.

**Receipts and ledger.** A purchase writes the buyer's receipt and a seller receipt (`request {kind:'market-sale',
listingId}`). It writes two ledger rows: `market-purchase` (−price) and `market-sale` (+price − fee). The fee is
`price*5/100` in integer division. Prices are whole numbers from 1 to 1,000,000,000 (`RULES_V1.marketplace.maximumPrice`).

**Rule literals.** The SQL repeats the market rules as literals: the fee `5/100` (`RULES_V1.fees.marketRate`), the expiry
`604800000` (`marketplace.expiryMs`), the price cap `1000000000` (`maximumPrice`) and the five-listing limit
(`maximumListings`). The panel and the Edge parser read the rules, so changing any of them needs a new migration.

The draft needed four completions before commit:
- It created `public.market_offers` and its foreign key to `private.market_listings(id)` before that table existed. The private
  table's block (create, RLS, indexes, constraints) now comes first.
- It only added table grants. Source-equivalent `revoke all … from public, anon, authenticated, service_role` statements now
  precede them on both tables. Without them the new public table would keep the platform's default client privileges.
- It omitted every function ACL. The source's revoke/grant pair is appended, covering the eight new functions and the
  replaced `cron_tick`. Only `service_role` may EXECUTE the commands and helpers; nobody may EXECUTE the sweep or the tick.
- A provenance header and `notify pgrst` were added.

The draft re-emits no unchanged function: the eight new functions and `cron_tick` are the only ones. The public SQL wrappers
come before `private.market_command`, which is safe under the draft's `check_function_bodies = off`. The guard trigger follows
its function. No backfill or initialization is needed: both tables are new and nothing wrote a listing before M14. The
existing `cloudiator-coordinate` cron job already runs `cron_tick`, so no registration changes.

**Release (Task 24).** M14 does not depend on the worker. Ship it before (or with) the Task 18.2 command routing. Before
18.2, the handler answered the three market commands with `unavailable`; 18.2 routes them to these functions and serves the
public `market` read. The sweep runs only once Task 24 enables
`private.scheduler`. Until then, each seller's own commands and any purchase expire due listings, and the offers policy
hides them from readers.

**Retention (Task 22).** Delete an offer before its listing (foreign key). A listing references its seller and buyer
gladiators and its terminal receipt, so prune it before those. Its item may already be gone.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M14, with no source applied afterwards.
- The schema fingerprint (956 lines, the M13 coverage plus the singleton counts) matched the tested source exactly. It was
  identical again after the tests.
- `npm run test:db` passed **190/190** in ten files on the replay, with the Edge container's start time unchanged across
  the run.
- Lint is empty. Advisors, run after that test run, report eight INFO unused-index notices, four of them on the new tables
  (`market_listings_buyer_idx`, `market_listings_receipt_idx`, `market_offers_listed_idx` for Task 18.2's page order, and
  `market_offers_seller_idx`). There are no warnings or errors. `migration list --local` shows M01–M14.
- Two mutations of the source each failed their owning test: sampling the clock before the row locks (the purchase then
  sold an expired listing), and taking the buyer's account lock first (it held an account lock while waiting for the
  lower one). The restored source passed both tests again.

## Task 13.1: visitor read access

M13 is `supabase/migrations/20261016141628_visitor_access.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull visitor_access --local --schema public,private --yes` from the tested `supabase/sql/11-visitor-access.sql`.
M01–M12 are unchanged.

It lets the `anon` role (visitors who have not signed in) SELECT the sanitized public projections, read-only, and nothing
else ([full-screen camp spec](../superpowers/specs/2026-10-14-full-screen-camp-design.md#visitor-access-backend)):
- the base tables `world_revision_state`, `world_actors`, `public_profiles`, `recent_results`, `activity_stages`,
  `arena_standings`, `tournament_bout_results` and `tournament_placements`;
- the views `visible_events`, `world_revision`, `world_actor_reads`, `public_profile_reads` and `arena_standing_reads`;
- `tournament_views`, column by column: `id`, `slot_index`, `league`, `starts_at_ms`, `ends_at_ms`, `status`, `entrants`,
  `bracket`, `bouts` and `reveal_at_ms`, for `anon` and `authenticated`. The table-level SELECT from `authenticated` is
  revoked, so `pairing_job_id` and `published_at_ms` are readable by no client (Task 19 review M1). A client
  `select('*')` on it is refused, so name the columns, as `readTournament` already does.

The five views are `security_invoker=true`, so every base table beneath them needs the anon grant and a select policy too:
a grant without a policy silently returns no rows. Each existing select policy (`player_read`, and `due_read` on
`activity_stages`) has its role list altered to `anon, authenticated` with its USING expression unchanged. The due-time
rule `reveal_at_ms <= clock_timestamp()` therefore applies to visitors by guessed id too, and no second permissive policy
exists. M13 also revokes anon's leftover TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on `public.owner_state`: the platform's
default table privileges granted them when M01 created the view, and M01's generated revokes covered only its tables.
anon never had SELECT on it. Private tables, owner tables and views, functions and commands stay denied to anon.

The draft needed five completions before commit:
- It only added table grants. Source-equivalent `revoke all ... from anon` statements now precede them.
- It had no view privileges, so the five views' anon revoke/grant pair is added.
- It revoked `authenticated`'s table SELECT on `tournament_views` but omitted the column grants and the matching anon
  revoke. Both are added.
- It omitted the owner view's anon revoke.
- It dropped and re-created all nine select policies. That is replaced by the source's in-place
  `alter policy … to anon, authenticated`, which leaves each USING expression untouched. A provenance header and
  `notify pgrst` were added.

It changes no function, trigger or data, and needs no backfill or initialization.

**Release (Task 24).** M13 does not depend on the worker. Ship it before (or with) the signed-out reads of Task 13.2
onward. The current read adapters already name `tournament_views` columns, so signed-in reads are unaffected.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M13, with no source applied afterwards.
- The schema fingerprint (900 lines) matched the tested source exactly, and was identical again after the tests. It
  covers function definitions, search paths, security, volatility and ACLs; relation ACLs, RLS, options and view
  definitions; columns with their column ACLs; policies, triggers, constraints and indexes; schema and default ACLs; the
  cron job and the seed rows.
- `npm run test:db` passed **176/176** in nine files on the replay, with the Edge container's start time unchanged across
  the run.
- Lint is empty. Advisors report four INFO unused-index notices and no warnings or errors (no
  `multiple_permissive_policies`). `migration list --local` shows M01–M13.

**Observed, not changed here.** anon keeps MAINTAIN on the eight M01 owner tables (`builds`, `gladiators`,
`item_instances`, `operation_receipts`, `reservations`, `schedules`, `wallet_ledger`, `wallets`). `authenticated` and
`service_role` keep TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on `owner_state`. The replayed default privileges for new
`public` tables still give anon, `authenticated` and `service_role` TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, so every new
public table needs its explicit `revoke all`, as every source already has. None of these is reachable through the Data
API, and none is a read or a row write. M17 (Task 23.1, top of this guide) revokes the anon and `authenticated` leftovers and
the client default privileges; `service_role`'s are kept and pinned as an accepted backend exception.

## Task 19 phase 2b: tournament results, reveals, settlement and the public view

M12 is `supabase/migrations/20261014174629_tournament_results.sql`, generated with CLI 2.120.0 (engine `migra`) by
`db pull tournament_results --local --schema public,private --yes` from the tested `supabase/sql/10-tournament-results.sql`.
M01–M11 are unchanged. It also carries the Task 16 phase-8 lock-order fix (`private.boundary_start` takes every member's
account lock, in gladiator order, before any debit or job insert).

The draft needed three completions before commit:
- It only added table grants. Source-equivalent revokes on `public.tournament_views`, `public.tournament_bout_results`,
  `public.tournament_placements` and `private.tournament_results` now precede them (without them the new public tables would
  inherit the platform's default client privileges).
- It omitted every function ACL: the source's revoke/grant pair is appended, so the new and changed functions keep backend
  `EXECUTE` only.
- A provenance header and `notify pgrst` were added. No backfill or initialization is needed: the four tables are new, and no
  tournament exists before this migration ships.

It re-emits no unchanged function. The changed existing functions are `boundary_start`, `boundary_published`,
`prepare_activity_jobs`, `accept_job_result`, `settle_rewards` and `settle_activity_core`; the new ones are
`publish_tournaments`, `valid_tournament_outcomes`, `accept_tournament_result`, `tournament_settlement_failure` and
`tournament_rewards`. Its triggers reference the existing `private.guard_frozen()` and `private.projection_changed()`.

**Release (Task 24).** Ship M11, M12 and the worker in one release step, then check that no `prepare`, `pair`, `simulation`,
`reveal` or `settlement` job is in operator state. An older worker returns a final bout without `outcomes`, which M12 refuses
(the job then fails into operator state); M11 alone cannot complete a tournament bout at all.

**Retention (Task 22).** Prune `public.tournament_bout_results` and `public.tournament_placements` before their
`public.tournament_views` row, that row before its pairing job, `private.tournament_results` before its tournament and its
final bout job, and placements before their activities (foreign keys). Bout logs in stages and public results follow the
seven-day replay rule.

**Replay evidence.**
- A clean `db reset --local --no-seed --yes` replayed M01–M12, with no source applied afterwards.
- The schema fingerprint (863 lines, the same coverage as M11's) matched the tested source exactly, and was identical again
  after the tests, so every test-only stand-in was removed.
- `npm run test:db` passed **170/170** in eight files on the replay, with the Edge container's start time unchanged across the
  run.
- Lint is empty. Advisors, run after that test run, report four INFO unused-index notices, none on the new tables, and no
  warnings or errors. `migration list --local` shows M01–M12.

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
`pg_get_functiondef` text captured before it was installed, not from a migration through `sed`. **Avi approved this as a
standing rule on 2026-10-14:** restore every test-only function stand-in from the `pg_get_functiondef` text captured before
it was installed, never by replaying a migration or source statement through a shell tool that may rewrite line endings,
and verify byte equality with the captured text afterwards. Observed once (Git Bash `sed` dropped carriage returns, so
`db pull` re-emitted an unchanged function); the byte-exact restore was tested in Task 19 phases 2a and 2b.

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

**Coordinator and dispatch.** `coordinate_work()` takes the coordinator row with `SKIP LOCKED` and respects an unexpired external lease. It advances at most six boundaries per call, skips provably empty boundaries, and starts at the earliest existing checkpoint on its first run. `private.cron_tick()` is registered every minute and stays inert until `private.scheduler.enabled` is true. When enabled, it coordinates and then calls `private.dispatch_workers()`. Dispatch sends at most five `net.http_post` calls per rolling minute (per scheduled minute since M18, Task 23.2), and only for claimable work. It authenticates with the Vault secrets `game_worker_url` and `game_worker_secret`; without both, nothing is sent. Locally, the cron registration and execution, the dispatch budget and a real pg_net delivery to the local `game-worker` were tested. **Task 24 must** store the hosted Vault secrets, set `GAME_WORKER_SECRET` as a function secret, deploy `game-worker` with JWT verification disabled (the handler checks the secret), enable `private.scheduler`, and verify hosted scheduling and dispatch. None of that is claimed here.

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

`public.owner_state` has `owner_id` and `state` columns. Select only `state`; ownership is enforced by the security-invoker view's underlying owner-only RLS policies. A no-character account returns zero rows; other owners see zero rows; anonymous callers lack SELECT permission. The same owner restrictions cover every base game table holding a character's private state. Since M13, only the sanitized public projections are readable without a session, read-only (see "Task 13.1: visitor read access" at the top of this guide). All client mutations and both command RPCs are denied to `anon`/`authenticated`. `private` is not exposed and grants no client USAGE. The service-role client is backend-only and calls SECURITY INVOKER RPCs. Creation results are `{ok:true, receiptId, value:{gladiatorId}}`; query `owner_state` afterward.

`create_gladiator(actor_id uuid, operation_id uuid, input jsonb)` consumes trusted backend preparation containing `{command, starterItems, staminaMaximum}`. HTTP accepts only canonical `GameCommand`; players cannot submit the prepared envelope, owner IDs, authoritative inventory, rolls, or stamina. `prepareCreation` uses the reviewed domain allocation/build/catalog/stats functions. SQL revalidates exact shapes, name/allocation/integer/catalog constraints, serializes each account, enforces global case-insensitive names, and writes initial state/items/ledger/receipt atomically. Account-scoped operation replay compares the original JSON command; a changed payload returns conflict. Successful and business-conflict receipts are durable. Invalid requests do not create receipts. Separate database-backed rolling limits count 60 authenticated attempts/minute and five creation attempts/minute; retries count too. The handler charges the general limit once and then the creation limit by parsed kind, including invalid creation payloads.

`loadOwnedInventory(actor)` queries the verified actor's gladiator and items on the server; later build commands must use it. Other valid command kinds return `unavailable` until their owning tasks implement transactions. No frontend read adapter is added here. Task 5 owns live owner loading; Task 10 owns public reads. Task 7 must replace the initial orientation projection with real activities and preserve the stored slot boundary. Task 8 owns progression/peak-strength processing. Pending builds and fee reservations have storage now; activation/refunds belong to Tasks 6–7. Future plans/seeds must remain in `private`, not owner-readable tables or receipts.

## CORS and hosting follow-up

The handler requires exact origins from backend `GAME_ALLOWED_ORIGINS`, emits an exact matching allow-origin header, rejects other Origin values before Auth/database work, and uses bearer JWTs rather than cookies. Missing Origin supports non-browser authenticated clients. Local configuration has no hosted credentials; Google OAuth credentials, provider enablement, callback, exact production redirects and origins remain Task 24.

Observed local exception: CLI 2.120.0's Kong 2.8.1 `functions-v1` route installs its default CORS plugin and rewrites the handler's allow-origin header to `*`. Official [CLI configuration](https://supabase.com/docs/guides/local-development/cli/config) and CLI help did not expose a supported gateway CORS override; official [Edge CORS guidance](https://supabase.com/docs/guides/functions/cors) places header handling in the function. No generated gateway configuration was changed. Controller-approved tests preserve exact headers and denial behavior through direct Edge HTTP, characterize the gateway wildcard, and prove gateway bad-origin POST returns 403 with no state change. **Task 24 must verify hosted exact-origin headers and origin denial before launch**; a hosted mismatch requires a documented supported boundary or explicit options, not silently accepting wildcard CORS. This local exception is not a production release approval.

Advisors can report informational unused FK/ownership indexes immediately after a reset. Keep the indexes: they support required ownership queries and FK maintenance, and a new database's statistics are not workload evidence. No warning/error or SQL lint finding is accepted for this checkpoint. Detailed run evidence lives in `docs/implementation/task-04-report.md`.
