# Task 22.3 report: health report and migration M16

Branch `claude/task-22` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `61065ee`. Brief:
`.superpowers/sdd/2026-10-18-task-22-retention-operations/task-22.3-brief.md`.

Commits:
- `0f86b3e` feat: report operator health and ship operations migration M16
- `402b641` test: state the recovery cases' order dependence precisely (self-review fix)

## What was implemented

### Health (Decision 8)

**`private.health_report(now_ms bigint) returns jsonb`** (`supabase/sql/14-operations.sql`, exception 8 in its header) reports,
at database time `now_ms`:
- `checkedAtMs`, `currentSlot`, `publishedSlot` and `slotsBehind`;
- `coordinator: {lastError, lastFailedSlot, leaseHeld}` and `scheduler: {enabled}`;
- `boundaries`: up to 20 incomplete boundaries, lowest slot first, with `slot`, `phase`, `status`, `waitReason`, `lastError`
  and `waitingMs`;
- `jobs`:
  - `counts` by kind and status;
  - `overdue` (up to 20, oldest due first) with `overdueTotal`;
  - `operator` (up to 20, lowest slot first, with kind, slot, attempts and `lastFailure`) with `operatorTotal`;
  - every listed job carries its `jobId`, for `private.resume_operator_job`;
- `attempts24h: {count, failed, failuresByCode, durations: {kind: {count, p50Ms, p95Ms, maxMs}}}`. The durations are
  `finished_at_ms − claimed_at_ms` of the completed attempts claimed in the last 24 hours (`percentile_disc`);
- `dispatch: {lastAtMs, lastHour}`;
- `cleanup`:
  - the watermarks and `lastRunAtMs`;
  - `more`, together with the last run's `durationMs`, `detail {more, blockedSlot, durationMs}`, `summary {more, durationMs}` and
    `ledger {more}` (22.1 M8);
  - `moreSinceMs`: since when every cleanup tick has still had more to do;
  - `failures {consecutive, sqlstates}`: the failed cleanup ticks since the last successful one;
- `events`, per source (`market-sweep`, `dispatch`, `cleanup`):
  - `latestFailure`, the latest failure in 24 hours, with its SQLSTATEs and `failedSellers`;
  - `lastHour {failures, sqlstates}`, aggregated over the last hour, never one entry per row (22.2 M2);
- `resources: {databaseBytes, budgetBytes: 262144000, largestTables: [{name, bytes}] ×10}`;
- `cpu: "not available"`;
- `alerts: [{code, severity, detail}]`.

**`private.health_alerts(report jsonb)`** derives the alerts from the report alone, so every threshold is tested on its own.
The alerts come in this order:
- `boundary-behind`: the next slot is more than 10 minutes into its slot, or nothing is published while the scheduler is on;
- `boundary-waiting`: a listed boundary has been open for more than 10 minutes;
- `operator-jobs`;
- `overdue-jobs`;
- `cleanup-stale`: the scheduler is on and there has been no successful cleanup for 26 hours, or ever. It reads
  `retention_state.last_run_at_ms`, so it also covers a canceled (57014) tick that recorded nothing (22.1 M7);
- **`cleanup-failures`** (controller ruling): the last three or more cleanup ticks failed;
- `cleanup-backlog`: `more` for 24 hours;
- `tick-failures`: market-sweep or dispatch failures in the last hour, one alert with a per-source aggregate;
- `database-size`: `warn` from 80 % of the budget, `alert` from 100 %.

Severity is `alert` for the boundary, job and staleness alerts, and `warn` for the others.

**Secret safety.**
- Every value is a number, boolean, slot, time, job id or code.
- A free-text column (coordinator and boundary `last_error`, `jobs.last_failure`, `job_attempts.failure_code`) is reported only
  when it has the shape of a SQLSTATE or failure code; anything else is `unrecognized`.
- An event's detail contributes only `failedSellers` and its SQLSTATEs.
- The report never reads Vault, pg_net responses or cron run messages.

**Grants.** EXECUTE on both functions is revoked from `public`, `anon`, `authenticated` and `service_role`.

**`scripts/health.mjs`** (`npm run health`):
- **Connection.**
  - By default it discovers this checkout's stack in memory, as `scripts/test-db.mjs` does, and refuses a non-loopback
    database.
  - Otherwise it uses `CLOUDIATOR_DB_URL`. A non-loopback host needs `--remote`, and then `ssl: 'require'` unless the URL sets
    `sslmode`.
- **Execution.** It runs `private.health_report(private.planning_now_ms())` in one read-only transaction
  (`statement_timeout` 30 s, `lock_timeout` 5 s) and prints the JSON.
- **Exit codes.** `0` healthy, `1` alerts, `2` failure.
- **Failures** print `{"ok":false,"code":…}` with a code from a fixed list (`usage`, `invalid-url`, `remote-not-allowed`,
  `remote-needs-url`, `discovery-failed`, `connection-failed`, `auth-failed`, `report-missing`, `permission-denied`, `timeout`,
  `lock-timeout`, `query-failed`, `report-invalid`, `report-failed`), plus a SQLSTATE when there is one. Nothing else of an error
  is ever printed.
- It uses only the `postgres` driver already in `package.json`.

### Carried SQL changes

**`private.expire_listings`** (22.2 M2 and M3):
- One call sweeps at most 50 sellers, ordered by their oldest due listing, then by gladiator id. The rest wait for the next
  minute.
- Busy (try-locked) sellers are skipped and do not count toward the 50.
- The cap keeps a tick below the 64 cached sub-XIDs. The worst case is 59 blocks: the coordination block and its 6 boundary
  blocks, the sweep block and its 50 sellers, and the dispatch block.
- The event's detail is now `{"failedSellers": n, "sqlstates": [distinct SQLSTATEs in order of occurrence]}`.

**`private.cron_tick`** (controller ruling):
- When the whole sweep fails, it records a `market-sweep` event with the SQLSTATE and a null detail.
- Hardening: a failure to insert that event, or the 22.2 `dispatch` event, is contained in its own nested block. Recording a
  failure can therefore never turn a contained failure into a whole-tick rollback of the coordination.

## Files

- `supabase/sql/14-operations.sql`: the health section, the sweep and tick changes, the ACLs and the header (Task 22.3,
  exception 6 extended, exception 8 new).
- `scripts/health.mjs` (new), and `package.json` (`"health": "node scripts/health.mjs"`).
- `tests/db/health.test.ts` (new): the brief's six cases.
- `tests/db/recovery.test.ts`:
  - 22.2 M4, M5 and M6;
  - the sweep event detail;
  - two new cases, the sweep cap and the whole-sweep event (with the contained recording failure);
  - the M16 backfill case.
- `tests/db/retention.test.ts`: 22.2 M1.
- `supabase/migrations/20261018191110_operations.sql` (M16, new).
- `docs/operations/migrations.md`: the final M16 section replaces the draft (22.1 M9), with the operator health report and the
  Task 24 release notes.

## Carried test items

- **22.2 M1** (`retention.test.ts`, busy owner). The held case now asserts that no `market-sweep` failure was recorded during the
  call.
  - **Mutation check.** I moved the account lock inside the per-seller block as a waiting `pg_advisory_xact_lock`. The case
    then failed exactly on the new assertion (`retention.test.ts:700`, "expected 1 to be 0"), while the old assertions
    (expired 0, listing open, under 5 s) still passed.
  - The function was captured with `pg_get_functiondef` first and restored from that text. Its md5 was equal afterwards
    (`fee9b13e…`), per the AGENTS.md stand-in rule.
- **22.2 M4.** A new case, "ships the season row backfill in M16 after season_bounds exists". It reads the single
  `*_operations.sql` migration and asserts:
  - the source's backfill statement (read by its marker) occurs exactly once in M16;
  - it comes after `CREATE OR REPLACE FUNCTION private.season_bounds(`.
- **22.2 M5.** "Returns their items once" also counts the seller's rows with the listed `catalogId` and `origin` against the
  setup snapshot.
- **22.2 M6.**
  - The describe block states the order dependence; corrected in `402b641`.
  - The market-sweep, sweep-cap and whole-sweep cases check their preconditions first: no open listing, and
    `published_slot = LATER`.
  - So does the dispatch case: `published_slot = LATER`.

## M16: how the draft differed from the source, and what was completed

**Generation.**
1. `db reset --local --no-seed --yes` to M01–M15. Its fingerprint matched Task 21.2's recorded M15 replay fingerprint byte for
   byte (1029 lines).
2. Applied `14-operations.sql` once with the psql fallback, after the container label check.
3. Took the source fingerprint.
4. Ran `npx supabase db pull operations --local --schema public,private --yes` (CLI 2.120.0, engine `migra`).

**The first draft was discarded.**
- The first draft, `20261018190708_operations.sql`, was completed and replayed with a matching fingerprint. Then
  `db lint --fail-on warning` reported plpgsql_check warnings in my three new or changed bodies:
  - an untyped `'{}'` initializer for `text[]` in `expire_listings`;
  - `health_alerts` marked IMMUTABLE, although `jsonb_build_object` is STABLE;
  - `health_report` marked STABLE, although `pg_database_size` and `pg_total_relation_size` are VOLATILE.
- I fixed the source: `'{}'::text[]`, `health_alerts` STABLE and `health_report` VOLATILE. I adjusted the denial test's
  `provolatile` expectations to match, and confirmed lint is empty on the source.
- I discarded the uncommitted draft (local `migration repair --status reverted 20261018190708`, exact-file removal), reset to
  M15 (fingerprint unchanged), applied the source once and pulled again: `20261018191110_operations.sql`.
- The new draft differs from the first only in those three lines (diff checked).

**Completions** (scratch script `complete-m16.cjs`, which refuses any anchor that does not match exactly once):
1. The draft created the `guard_receipt` and `guard_tournament_bout_result` triggers at the top, before either function. Both
   now follow `private.guard_tournament_bout_result()`. `guard_wallet_checkpoint` was already after its function.
2. The `retention_state` seed row (`insert … on conflict do nothing`) now follows that table's constraints.
3. `revoke all … from public, anon, authenticated, service_role` now comes before the generated grants on all three tables.
4. Every function ACL was missing. I appended the source's revoke/grant pairs for the thirteen functions:
   - nobody: `cleanup_history`, `cleanup_tick`, `expire_listings`, `cron_tick`, `health_report`, `health_alerts`;
   - `service_role` only: the three guards, `project_character`, `season_bounds`, `boundary_close_season`,
     `boundary_recompute_leagues`.
5. The season row backfill, verbatim from the source, is appended after `season_bounds` exists.
6. `cron.schedule('cloudiator-cleanup','23 * * * *','select private.cleanup_tick()')` is appended.
7. A provenance header and `notify pgrst` were added.

**Already in the draft:** both trigger drops (`project_changed_character` on `activity_stages`, `guard_frozen` on
`tournament_bout_results`), RLS, the three `backend_only` policies, the indexes (`wallet_ledger_created_idx`,
`activities_replay_available_idx`, `operations_events_time_idx`) and `set check_function_bodies = off`.

**No unchanged function was re-emitted.** The draft's thirteen functions are exactly those of the source. A function-by-function
comparison of the text between the dollar quotes (`compare-bodies.cjs`) found all 13 byte-identical to the source, including the
five replaced bodies: `project_character`, `expire_listings`, `cron_tick`, `boundary_close_season` and
`boundary_recompute_leagues`.

## Tests

Every `npm run test:db` run was made with nothing else building, browsing or editing this worktree. The Edge runtime serves
`C:\Avi\Studies\Projects\Cloudiator-claude\supabase\functions` (mount checked). Its start time was read with
`docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after each run.

| Run | Command | Result | Edge StartedAt before | after |
|---|---|---|---|---|
| RED 1 | `npm run test:db -- tests/db/health.test.ts tests/db/retention.test.ts tests/db/recovery.test.ts` | **discarded**: Edge recreated 4 s into the run; the recovery `beforeAll` failed with `worker-database-unavailable` | 2026-10-18T18:45:06.626241524Z | 2026-10-18T18:52:09.339032588Z |
| RED 2 | same | **10 failed, 24 passed** (34) | 2026-10-18T18:52:09.339032588Z | 2026-10-18T18:52:09.339032588Z |
| GREEN 1 | same, source applied | 32/34: one wrong test expectation (fixed); the M16 case needs M16 | 2026-10-18T18:52:09.339032588Z | 2026-10-18T18:52:09.339032588Z |
| GREEN 2 | `npm run test:db -- tests/db/health.test.ts` | 6/6 | 2026-10-18T18:52:09.339032588Z | 2026-10-18T18:52:09.339032588Z |
| mutation | `npm run test:db -- tests/db/retention.test.ts -t "never waits"` with the mutant | failed at `:700`, as intended | 2026-10-18T18:52:09.339032588Z | 2026-10-18T18:52:09.339032588Z |
| full, source | `npm run test:db` | **251/252**, 14 files (289.8 s); the only failure is the M16 case, before M16 existed | 2026-10-18T19:00:08.998946795Z | 2026-10-18T19:00:08.998946795Z |
| full, replay | `npm run test:db` on the M01–M16 replay | **252/252**, 14 files (294.9 s) | 2026-10-18T19:00:08.998946795Z | 2026-10-18T19:00:08.998946795Z |

**RED evidence (RED 2).** Every new-behaviour case failed for the missing feature:
- four health cases: `function private.health_report(unknown) does not exist`;
- the denial case: no `health_report`/`health_alerts` functions (`[]`);
- the CLI case: exit 1 instead of 0 (no script);
- the sweep case: the event detail had no `sqlstates`;
- the cap case: "expected 51 to be 50";
- the whole-sweep case: no event (`[]`);
- the M16 case: no `*_operations.sql`.

The M1, M5 and M6 strengthenings passed on the old code, because they strengthen tests of existing behaviour. M1 was shown
meaningful by the mutation above.

**GREEN 1 iteration.** The test expected only `boundary-behind` with the scheduler on and nothing published. With no cleanup
ever run, `cleanup-stale` correctly fires too, as designed. The expectation was corrected; the SQL was not changed.

**Other gates:**
- `npm test`: 1056/1056, 47 files.
- `npm run typecheck`: `tsc`, `deno check --frozen` and the Deno Edge smoke test (2/2) passed. `npx tsc --noEmit` passed again
  on the final commit.
- `git diff --check` was clean.

**Edge recreation (observation only).** The container was recreated:
- at 18:45:06Z, while I was editing test files, before any run;
- 4 s into RED 1 (discarded and rerun);
- at 19:00:08Z, during `npm test`/`npm run typecheck`.

No file under `supabase/functions` was changed by this task. This matches the unconfirmed observation in
`docs/operations/verification-gates.md`. Every counted run had an unchanged start time.

## Replay, parity, lint and advisors

**Replay.** A clean `db reset --local --no-seed --yes` replayed M01–M16 (16 migrations), with no source applied afterwards. The
Edge start time was unchanged by both resets.

**Parity fingerprint** (scratch `fingerprint.sql`: M15's 1029-line coverage plus every `public`/`private` trigger's enabled state
and the `retention_state` seed row):
- source-applied: 1127 lines;
- replay: **byte-identical**;
- after the full replay test run: **byte-identical** again.

All `public`/`private` triggers are enabled.

**Inspection of the replay** (sanitized, `replay-inspection2.txt`):
- The six owner-only functions grant only `postgres`; the seven backend functions grant `postgres` and `service_role`.
- `health_alerts` is `s`, `health_report` `v` and `season_bounds` `s`. Every function has `search_path=""` and none is
  security definer.
- Triggers: `guard_receipt`, `guard_tournament_bout_result` and `guard_wallet_checkpoint` are enabled. `activity_stages` keeps
  only `projection_changed`.
- The three tables have RLS, ACL `postgres` plus `service_role=r`, and one `backend_only` SELECT policy each.
- cron: `cloudiator-cleanup` (`23 * * * *`, `select private.cleanup_tick()`) and `cloudiator-coordinate` (`* * * * *`), both
  active.
- The `retention_state` seed row is `(true, -1, -1, null, null)`.

**Backfill check.** It was run on the replayed database, verbatim from M16, inside a `DO` block that always raises:
- with ratings in seasons 0, 1, 3 and 7 at epoch 0, it created exactly those four rows with `seasonAt`'s bounds (for example
  `1:2419200000-4838400000`);
- run again, it added nothing (count 4);
- afterwards there was no epoch, season, character or rating row.

**After the runs:**
- the scheduler is off;
- there is no Vault worker secret and no fabricated (negative) cron run row;
- `planning_now_ms` contains no `test_now_ms`.

**Lint** (`db lint --local --schema public,private --fail-on warning`): "No schema errors found" on the corrected source and on
the replay.

**Advisors** (`db advisors --local --type all --level info`): four INFO `unused_index` notices (`jobs_gladiator_idx`,
`tournament_entries_gladiator_idx`, `market_listings_buyer_idx`, `market_listings_receipt_idx`). None is on M16's tables;
`operations_events_time_idx` is now used. There are no warnings or errors.

`migration list --local` shows M01–M16, local equal to remote.

**pg_net TTL.** It is `6 hours` locally (pg_net 0.20.4, re-read on this stack). Cleanup has no `net._http_response` delete. The
hosted value is a Task 24 check, recorded in `migrations.md`.

## Self-review

- **Fixed (`402b641`).** The order-dependence comment said the whole-sweep case relied on "no open listing" and that a case
  "cannot run alone". It relies on `published_slot = LATER`, and `-t` still runs `beforeAll`. The comment now names each
  dependency.
- **Checked against the brief:**
  - every health field and alert code;
  - the CLI contract (env var, loopback rule, `--remote`, exit codes, no secret output, `package.json` script);
  - every carried item (22.1 M7–M9, 22.2 M1–M6, both controller rulings);
  - the M16 completion list item by item;
  - M01–M15 untouched (`git show --stat`).
- **Secret checks:**
  - The report case plants raw text with a URL, a JWT-like token, `Bearer`, a password, an API-key shape and a Vault secret
    value. None appears in the report.
  - The CLI case checks that neither the local DB URL nor its credential appears in stdout or stderr. A fake remote URL with a
    unique password never echoes the password, both on `remote-not-allowed` and on `connection-failed`.
- **Locks.** The report takes no row lock and never the coordinator lease. Like every relation open,
  `pg_total_relation_size` takes AccessShareLock on each table. A concurrent TRUNCATE or DDL therefore makes the CLI wait up to
  its 5 s `lock_timeout` and exit 2 with `lock-timeout`.

## Interpretations (recorded for review)

1. **`waitingMs`** is measured from `boundaries.opened_at_ms`. `updated_at_ms` is rewritten on every coordination pass, so the
   time the wait started is not stored.
2. **`overdue-jobs`** also counts a `leased` job whose lease expired more than 10 minutes ago. The brief's definition says
   "pending"; such a job is stalled work that no worker reclaimed.
3. **`boundaries`** lists every incomplete boundary (`status <> 'complete'`), not only `waiting` ones. `running` cannot persist
   past a commit, so this lists the same rows and stays robust.
4. **`cleanup-stale`** also fires when the scheduler is on and no cleanup has ever succeeded. This is the case right after
   Task 24 enables the scheduler, until minute 23 or a manual `select private.cleanup_tick()` (release note in
   `migrations.md`).
5. **The new `cleanup-failures` alert** (controller ruling) fires at three or more consecutive failed cleanup ticks, counted by
   event id since the last successful one, with severity `warn`.
6. **The dispatch handler's event insert is now nested too.** This changes 22.2's reviewed `cron_tick` body by one nested block.
   It is tested: with the listings, the operations log and the dispatch lock all held, the tick still returns ok with both
   failures reported.
7. **The whole-sweep event's detail is null**, like the dispatch event. Per-seller events keep
   `{failedSellers, sqlstates}`.

## Concerns

1. **Edge recreation** during the first RED run. It was discarded and rerun, and the cause is still unconfirmed (Task 23
   triage, 22.2 M7).
2. **The CLI "healthy" case** requires the local database to stay under 80 % of 250 MB. It is about 40 MB; Auth test users
   accumulate between resets, and a `db reset` clears them.
3. **The local database now holds M01–M16 and the full test run's reset state.** Task 22.4's restore check starts from this
   replay.
4. **Proposed skill update (not made; for Avi through the controller).** "Avi, shall I update the Supabase skill override in
   AGENTS.md — Generated migration completion — to run `db lint --fail-on warning` on the source-applied database before
   `db pull`, and to add trigger enablement and singleton seed rows to the parity fingerprint?"
   - **Observed failure:** lint caught three warnings only after the first draft existed, which forced a discard and
     regeneration.
   - **Tested here:** the extended fingerprint, which matched source, replay and post-test.
   - **Untested as a general rule:** running lint before every pull.
