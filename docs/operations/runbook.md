# Operator runbook

Task 22.4 (plan `docs/superpowers/plans/2026-10-18-task-22-retention-operations.md`, Decisions 8 and 9). This is the
owner-operated runbook for the Cloudiator backend: the health check, recovery, rules and scheduler changes, secret rotation,
the weekly export and its restore check, and the hosted budgets. There is no player-facing admin flow: everything here runs
as the database owner, from the operator's own shell or the hosting dashboard's SQL editor.

Ground rules for every section:
- Never print `supabase status`, keys, JWTs, connection strings or `.env*` contents. Secrets are named here, never shown.
- Connection strings live only in the operator's shell environment (`CLOUDIATOR_DB_URL`, `CLOUDIATOR_EXPORT_DB_URL`), never in
  a file in the repository, a command argument or a chat.
- Where this guide says "SQL", run it as the database owner (`postgres`) in the hosted SQL editor, or locally with
  `docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1` after checking the container's
  `com.supabase.cli.project` label is `Cloudiator` (see `docs/operations/environment.md`).

### Entering a connection string

Never type or paste a connection string into a command line. Windows PowerShell 5.1's PSReadLine saves every interactive
command line in plain text (`(Get-PSReadLineOption).HistorySavePath`, by default
`%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`), and Git Bash keeps `~/.bash_history`. Read it
at a prompt that neither echoes it nor records it, set the variable for this session only, and remove it when done:

```powershell
$secure = Read-Host -AsSecureString 'Owner connection string'   # paste at the prompt; nothing is echoed or saved
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:CLOUDIATOR_DB_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); Remove-Variable secure, bstr }
# … the commands that need it …
Remove-Item Env:CLOUDIATOR_DB_URL
```

Use `CLOUDIATOR_EXPORT_DB_URL` in place of `CLOUDIATOR_DB_URL` for the export. In Git Bash the equivalent is
`read -rs CLOUDIATOR_DB_URL && export CLOUDIATOR_DB_URL`, then `unset CLOUDIATOR_DB_URL`. After pasting from the dashboard's
copy button, clear the clipboard. If a connection string ever reached a command line, delete that line from the history file
and rotate the database password in the dashboard.

## Health check

```powershell
npm run health                                   # the local stack, discovered in memory
# The hosted database: set CLOUDIATOR_DB_URL as in "Entering a connection string", then
npm run health -- --remote
Remove-Item Env:CLOUDIATOR_DB_URL
```

`scripts/health.mjs` prints `private.health_report(private.planning_now_ms())` as JSON from one read-only transaction
(`statement_timeout` 30 s, `lock_timeout` 5 s). Exit `0` healthy, `1` alerts, `2` failure. The fields are listed in
`docs/operations/migrations.md` ("Operator health report"). Run it daily, after every deployment, after a pause and after any
recovery below.

`cohort.activeCharacters` (M21) counts the characters with an activity in the current slot. Boundary latency has no headroom
at 50 such characters (`docs/operations/release-evidence.md`, risk 5): as it approaches 50, plan one of that risk's
mitigations before a boundary publishes later than 120 s. In the first minutes of a slot, before its boundary has run, the
count can still be 0.

`cohort.restingCharacters` (M22) counts the characters resting at home in the current slot: their owners have sent no
activity signal for 14 days (spec §4.3). They are outside the boundary cohort, so they add neither latency nor rows. Like
`activeCharacters`, it can read 0 early in a slot, before its boundary has run.

### Alerts and what to do

| Alert | Meaning | Action |
|---|---|---|
| `boundary-behind` | The next slot is more than 10 minutes late, or nothing is published while the scheduler is on. | Check `scheduler.enabled` and `coordinator.lastError`/`lastFailedSlot` in the report. Check the hosted project is not paused (see "Free-tier pausing"). If `lastError` is set, a boundary failed in isolation: see `boundary-waiting`. Catch-up runs at most 6 boundaries per tick, so a long pause shows `slotsBehind` falling by up to 6 a minute. |
| `boundary-waiting` | A boundary has been open more than 10 minutes. The report gives its phase and `waitReason`. | `preparation`/`pairing`/`settlement`/`integration`/`straggler`: jobs are not draining; see `overdue-jobs` and `operator-jobs`. `extension`: registered boundary work (for example a season close) is still pending. `operator`: an operator job holds it; see "Manual recovery". `error`: the report holds only the SQLSTATE; fix the cause (a deterministic data error, a missing rules version) and let the next tick retry. `epoch`: the season epoch is not set (`docs/operations/migrations.md`, M09 and M16 notes). |
| `operator-jobs` | Jobs retained after three failures (or three expired leases). The report lists their ids and `lastFailure` codes. | "Manual recovery after three failures" below. |
| `overdue-jobs` | A pending job is more than 10 minutes past due, or a lease expired more than 10 minutes ago without a reclaim. | The worker is not being invoked or is failing before it claims: check the scheduler, the Vault secrets and the Edge `GAME_WORKER_SECRET` match (see "Secret rotation"), and the function-invocation budget. `dispatch.lastAtMs` and `lastHour` show whether pg_net dispatched at all. |
| `cleanup-stale` | The scheduler is on and no cleanup succeeded for 26 hours (or ever). | Right after enabling the scheduler this is expected until minute 23; run `select private.cleanup_tick();` once. Otherwise look at `events.cleanup` and `cleanup-failures`. |
| `cleanup-failures` | The last three or more cleanup ticks failed. | The events carry only a SQLSTATE. `55P03` (lock timeout) means cleanup kept yielding to boundaries (it gives up a lock after 500 ms); it should clear when the backlog of boundaries ends. Anything else: run `select private.cleanup_history(private.planning_now_ms());` as the owner in a transaction you roll back, read the error there, fix the cause. |
| `cleanup-backlog` | Cleanup has reported `more` for 24 hours. | Usually a long pause: each hourly call handles at most 3 slots per pass. If `blockedSlot` is set, an unfinished activity or job in that slot stops it: resolve the job first (see `operator-jobs`). |
| `tick-failures` | Market-sweep or dispatch failures in the last hour, aggregated with their SQLSTATEs. | A sweep failure for one seller does not stop the others; repeated failures for the same SQLSTATE point to a data problem in that seller's listings. Dispatch failures usually mean pg_net or Vault problems. |
| `database-size` | Warning from 80 % of the 500 MB budget (400 MB; Avi's decision, 2026-10-19), alert from 100 %, both on the physical database size. | Check `resources.largestTables`. Confirm cleanup is running (the 7-day detail and 90-day summary passes free most space, and the trim of settled jobs' payloads keeps `private.jobs` small). The warning is the trigger for the after-launch compactions of the database budget design (`docs/superpowers/specs/2026-10-19-database-budget-design.md`: settled slots as per-character ranges, command receipts older than 90 days as a fingerprint); plan that task when it appears. At 100 % the free plan's 500 MB is reached: plan the paid tier or a retention change before writes fail. |

### Failure codes of the health CLI

On exit `2` the CLI prints `{"ok":false,"code":…}` and, when the database gave one, a `sqlstate`. Nothing else of an error is
printed, by design.

| Code | Meaning | Action |
|---|---|---|
| `usage` | An argument other than `--remote`. | Run `npm run health` or `npm run health -- --remote`. |
| `invalid-url` | `CLOUDIATOR_DB_URL` is not a plain `postgres://` or `postgresql://` URL: whitespace, a fragment, no user, a socket path, a `,` (host list) or more than one `@` in the authority, an unusual or percent-encoded host, a nested database path, a port outside 1–65535, or a query parameter other than `sslmode` (`disable`, `allow`, `prefer`, `require`, `verify-full`). | Percent-encode special characters in the password (`@` as `%40`, `:` as `%3A`). Use the direct database host, one host only. |
| `remote-not-allowed` | The host is not loopback (`127.0.0.1`, `localhost`, `::1`) and `--remote` was not given. | Add `--remote` if the hosted database is intended. |
| `remote-needs-url` | `--remote` without `CLOUDIATOR_DB_URL`. | Set the variable in the shell first. |
| `discovery-failed` | Local discovery could not read the local stack (the CLI failed, or its output was unusable). | Start the local stack (`docs/operations/environment.md`); see `docs/operations/local-runtime.md` if Docker does not start. |
| `discovery-not-local` | The local CLI reported a database that is not on a loopback host. | Refused on purpose: the default mode only reports on this checkout's local stack. Check the CLI configuration; use `CLOUDIATOR_DB_URL` with `--remote` for a hosted database. |
| `connection-failed` | Network or TLS failure: refused, DNS, unreachable, timed out, connection closed or a broken pipe. | Check the host, port and that the project is not paused. With `sslmode=verify-full`, check the CA (see "Connections and TLS"). |
| `auth-failed` | SQLSTATE `28P01`/`28000`: wrong user or password. | Copy the owner connection string again from the dashboard. |
| `database-missing` | SQLSTATE `3D000`: the database name in the URL does not exist. | Use `postgres`. |
| `report-missing` | SQLSTATE `42883`/`3F000`: `private.health_report` or the `private` schema is missing. | Migration M16 is not applied there (`docs/operations/migrations.md`). |
| `permission-denied` | SQLSTATE `42501`: the role may not run the report (it is owner-only). | Connect as the database owner, not `service_role` or a client role. |
| `timeout` | SQLSTATE `57014`: the report exceeded 30 s. | Retry; if repeated, the database is overloaded or very large (see `database-size`). |
| `lock-timeout` | SQLSTATE `55P03`: a lock was not granted within 5 s. | Retry after the current boundary finishes. |
| `query-failed` | Any other SQLSTATE (shown). | Look the SQLSTATE up; run the report in the SQL editor to see the message. |
| `report-invalid` | The report returned no `alerts` array. | The function is not the M16 version; check the migration history. |
| `report-failed` | Anything else (no detail by design). | Run the report in the SQL editor: `select private.health_report(private.planning_now_ms());`. |

### Connections and TLS

`scripts/health.mjs` and `scripts/export-db.ps1 -Remote` parse the connection string once (`scripts/operator-db.mjs`) and
hand the drivers only the parsed host, port, user, password and database, so the loopback guard and the driver can never read
different hosts. For a non-loopback host without `sslmode`, TLS is `require`: **the connection is encrypted but the server
certificate is not verified**. To verify the hosted server:
- Download the project's CA certificate from the hosting dashboard's database settings (SSL configuration).
- Health (postgres.js): add `?sslmode=verify-full` to `CLOUDIATOR_DB_URL` and set `NODE_EXTRA_CA_CERTS` to the CA file's
  path for that shell.
- Export (libpq inside the local container, running as root): copy the CA to the path libpq reads by default,
  `docker cp <ca file> supabase_db_Cloudiator:/root/.postgresql/root.crt` (create the directory first with
  `docker exec supabase_db_Cloudiator mkdir -p /root/.postgresql`), and add `?sslmode=verify-full`. The copy lasts until the
  container is recreated.

**Which connection string.** The hosted project's direct database host may resolve to IPv6 only, and the export's `pg_dump`
runs inside a Docker container, which often has no IPv6 route. If the direct string gives `connection-failed` (health) or
`schema-dump-failed` (export), use the dashboard's session-pooler connection string instead (session mode, port 5432; its
user has the form `postgres.<project ref>`). The transaction pooler (port 6543) is not suitable for `pg_dump`.

Not yet tested against a hosted project (none exists before Task 24); Task 24 verifies the TLS settings and the connection
string choice.

## Manual recovery after three failures

A job that fails three times (or whose lease expires three times) stays in `operator` status with a short `last_failure` code;
its boundary waits (`waitReason: operator`). Its seed and input are immutable, so a retry recomputes exactly the same result.

1. Read the job ids and failure codes from the health report (`jobs.operator`), or:
   `select id, kind, slot_index, attempts, last_failure from private.jobs where status = 'operator' order by slot_index;`
   and the attempts: `select attempt, outcome, failure_code, finished_at_ms - claimed_at_ms as ms from private.job_attempts where job_id = '<id>' order by attempt;`
2. **Fix deterministic errors first.** A code such as `unsupported-rules`, `unsupported-executor`, `invalid-input` or an
   invalid result will fail again with the same input: deploy the missing executor (see "Retained-rule deployments") or fix
   the data or code that produced it. Only transient causes (timeouts, an outage, `lease-expired`) can be resumed as they are.
3. Resume: `select private.resume_operator_job('<id>');` returns `{"ok":true}` and sets the job back to `pending` with three
   more attempts. It answers `{"ok":false,"code":"invalid"}` for a job that is not in `operator` status.
4. The next tick dispatches a worker; run the health check until `operator-jobs` and `boundary-waiting` clear.

Never delete or edit a job, a settled slot or a receipt to "unstick" a boundary: the guards refuse it, and the settled-slot
guard is what prevents a second grant.

## Retained-rule deployments

Every boundary, snapshot and job records its rules version (`private.rules_versions`, today only `v1`, active). A job always
runs with the executors of its own version (`DEFAULT_EXECUTORS` in `supabase/functions/_shared/backend/jobs.ts`); a worker
without that version fails it with `unsupported-rules`, and after three attempts it waits for an operator.

To ship changed rules:
1. Add the new version (for example `v2`) alongside the old one in the worker's executor registry and deploy the Edge
   function. **Keep `v1`** until no unfinished job, boundary or snapshot uses it.
2. Insert the version row: `insert into private.rules_versions(version, active) values ('v2', false);`
3. Switch at a quiet moment, in one transaction and in this order (one version may be active):
   `begin; update private.rules_versions set active = false where version = 'v1'; update private.rules_versions set active = true where version = 'v2'; commit;`
   Boundaries opened afterwards use `v2`; jobs already created keep `v1`.
4. Never delete a `rules_versions` row: boundaries, snapshots and jobs reference it. Remove `v1`'s executors only when
   `select count(*) from private.jobs where rules_version = 'v1' and status <> 'completed';` is `0` and no boundary is open.

## Pausing and resuming the scheduler

pg_cron runs `cloudiator-coordinate` every minute and `cloudiator-cleanup` at minute 23. Both are inert while the scheduler is
disabled:

```sql
update private.scheduler set enabled = false where singleton;   -- pause
update private.scheduler set enabled = true  where singleton;   -- resume
select jobname, schedule, active from cron.job;                 -- both jobs present and active
```

While paused, nothing coordinates, dispatches, sweeps the market or cleans up; commands still work. A worker invoked by hand
still coordinates (`coordinate_work` does not read the flag), so do not invoke it while you want a full pause. After resuming,
catch-up processes the missed slots in order (at most 6 boundaries per tick), sweeps the expired listings once and returns
their items once; cleanup catches up hourly. Run the health check until `slotsBehind` is `0`. Do not unschedule the cron
jobs to pause: re-registration is a migration step.

## Secret rotation

Names only; never print the values.
- **Database (Vault):** `game_worker_url` (the worker endpoint) and `game_worker_secret`, read by `private.dispatch_workers`.
  Without both, dispatch reports `unconfigured` and sends nothing.
- **Edge function secrets:** `GAME_WORKER_SECRET` (at least 32 characters; the worker refuses any request without it) and
  `GAME_ALLOWED_ORIGINS` (configuration, not a secret). Locally they live in the git-ignored `.env.edge.local`.
  `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.

Rotating the worker secret on a live database (both sides must hold the same value):
1. Pause the scheduler.
2. Generate a new value without displaying it into a private, git-ignored file outside the repository. Let node write the file,
   with its path as an argument: never redirect with `>`, which in Windows PowerShell 5.1 writes UTF-16LE that
   `supabase secrets set --env-file` cannot parse. (`wx` refuses to overwrite an existing file.)
   `node -e "require('fs').writeFileSync(process.argv[1], 'GAME_WORKER_SECRET=' + require('crypto').randomBytes(32).toString('base64url') + '\n', { flag: 'wx' })" <private file>`
3. Set the Edge secret from that file: `npx supabase secrets set --env-file <private file> --project-ref <ref>` (check the
   current `--help` first). The function picks it up on its next start.
4. Update Vault with the same value in the SQL editor:
   `select vault.update_secret((select id from vault.secrets where name = 'game_worker_secret'), '<value>');`
   `update_secret` changes an existing secret only: with no `game_worker_secret` row it updates nothing and reports no error,
   so check `select name, updated_at from vault.secrets where name = 'game_worker_secret';` shows the new time. The editor
   keeps query text in its history and in saved snippets. Run it in a new, unsaved query; never save it as a snippet;
   afterwards delete that query and its history entry, and clear the clipboard. Then delete the private file.
5. Resume the scheduler and run the health check: `overdue-jobs` must stay clear and `attempts24h` must grow. A mismatch shows
   as jobs that stop draining, not as a SQL failure.

The publishable key, the service-role key and the JWT secret are rotated in the hosting dashboard; afterwards update the
frontend build variable (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) and redeploy.

**After a restore, create both Vault secrets.** A restored database never carries Vault values (`vault.secrets` is in the
export exclusions), so it has no `game_worker_url` or `game_worker_secret` row and step 4's `update_secret` would silently
update nothing. `update_secret` is for rotation on a live database only. Pause the scheduler (the restored row keeps the
source's setting), then create both secrets by name in the SQL editor: the URL is the worker endpoint, and the secret is the
same value as the Edge function's `GAME_WORKER_SECRET` (if that value is not at hand, generate and set a new one with steps 2
and 3 first).

```sql
select vault.create_secret('<worker url>', 'game_worker_url');
select vault.create_secret('<worker secret>', 'game_worker_secret');
```

Follow step 4's editor rules for this query (new and unsaved, never a snippet, deleted with its history entry, clipboard
cleared, private file deleted). `select name from vault.secrets where name in ('game_worker_url', 'game_worker_secret');`
must list both names; then resume the scheduler and run the health check as in step 5. Without both secrets dispatch reports
`unconfigured` and sends nothing, which shows only as `overdue-jobs`.

## Weekly export and the restore check

Once a week (and before launch), export the hosted database to storage outside the free service, then prove the copy
restores. `.backups/` is git-ignored; keep the copies on encrypted storage the operator controls, because a backup contains
the players' accounts and their credential material, not only game state: `auth.users` with its password hashes, the
identities, and `auth.mfa_factors` with each factor's secret. Treat a backup like the database password.

### Export

```powershell
# Hosted: set CLOUDIATOR_EXPORT_DB_URL as in "Entering a connection string" (never an argument, never a command line), then
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-db.ps1 -Remote
Remove-Item Env:CLOUDIATOR_EXPORT_DB_URL
# Local stack (default):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-db.ps1 [-OutDir .backups]
```

It writes `.backups/<UTC yyyyMMddTHHmmssZ>/`:
- `schema.dump`: `pg_dump --format=custom --schema-only` of the whole database (application, Auth and platform schemas).
- `data.dump`: `pg_dump --format=custom --data-only`, including `auth.users`.
- `manifest.json`: the git commit (and whether the tree was dirty), the server version, the applied migrations, the
  excluded table data, the row count of every public and private table plus `auth.users` (counted from the COPY rows of
  `data.dump` itself, so it describes exactly that file) and the SHA-256 of both dumps.

The tools are the PostgreSQL 17 `pg_dump`/`psql` inside the local container `supabase_db_Cloudiator` (label verified first),
so the local stack must be running even for a hosted export. In `-Remote` mode `scripts/operator-db.mjs` validates the URL
first, then runs `pg_dump` with only `PG*` variables (`docker exec -e PGHOST …` takes the values from the environment, never
from arguments) and discards libpq's error text, which names the host; a failure prints a short code
(`schema-dump-failed`, `data-dump-failed`, …). The remote mode has been exercised only up to the connection (an unreachable
host gives `schema-dump-failed` without printing it); Task 24 runs it against the hosted project. The schema and data dumps
are two `pg_dump` runs: export outside a deployment window so no migration lands between them.

**Excluded table data** (`EXPORT_DATA_EXCLUSIONS` in `scripts/restore-compare.mjs`, recorded in every manifest):
- `vault.secrets`: Vault ciphertext is bound to the source server's root key and would not decrypt elsewhere; create the
  two secrets by name after a restore ("Secret rotation", "After a restore, create both Vault secrets").
- `auth.sessions`, `auth.refresh_tokens`, `auth.mfa_amr_claims`, `auth.one_time_tokens`, `auth.flow_state`,
  `auth.saml_relay_states`: sign-in sessions, refresh tokens and short-lived sign-in flow tokens. They are bearer material
  with no game state, and the set is closed under its foreign keys. After a restore, players sign in again.

Export failure codes (exit `2`): `remote-needs-url`, `invalid-url` (and the other URL codes above), `remote-is-local` (a
loopback URL with `-Remote`: inside the container that host is the container itself, so use the default local mode), `backup-exists`,
`container-missing`, `container-not-verified`, `container-not-running`, `container-work-failed`, `exclusions-failed`,
`schema-dump-failed`, `data-dump-failed`, `facts-failed`, `copy-failed`, `manifest-failed`, `export-failed`. A failed run
removes the backup directory it created and its temporary files.

### Restore check

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-check.ps1 -Backup .backups/<stamp> [-Keep]
```

It restores the backup into a separate database named exactly `cloudiator_restore_check` inside the local container
`supabase_db_Cloudiator` (label `com.supabase.cli.project=Cloudiator` verified first). It refuses any other name (`-Database`
must be exactly that), drops and creates only that database, never touches the `postgres` database's data, roles or
extensions, never resets the stack and downloads nothing. Steps:
1. Verify the SHA-256 of both dumps against the manifest. A mismatch stops here with exit `1` and
   `{"ok":false,"code":"checksum-mismatch","checksums":{…}}`; nothing is restored.
2. `drop database if exists cloudiator_restore_check with (force)`, then create it from `template0`.
3. Restore the schema, then the data, each as one transaction with `psql -v ON_ERROR_STOP=1 --single-transaction` (any error
   stops and rolls back). The data loads with `session_replication_role = replica`, so no trigger or foreign-key trigger fires
   during the load; step 4 then checks every foreign key and guard explicitly.
4. `scripts/restore-invariants.sql` (read-only): the row count of every public and private table plus `auth.users`, and the
   invariants: settled slots unique per (character, slot), activity and receipt; every completed activity guarded by its
   settled slot; one ledger row per receipt and every ledger receipt present; wallets equal checkpoint plus ledger; every
   item names its owner, pending builds and open listings hold only their own character's items, one open listing per item;
   at most 60 items per character; season awards unique; no orphan under any public or private foreign key; the grant and
   ownership guard triggers present and no trigger disabled.
5. `scripts/restore-resume.sql` (it refuses to run in any database but `cloudiator_restore_check`):
   - **Structural replay** (`"replayCheck":"structural"`): it takes the coordinator lease exactly as
     `public.coordinate_work()` does, calls `public.advance_boundary(published_slot, token)` and releases the lease. It must
     answer `replayed`. For a published slot that function returns right after taking the coordinator row lock and reading
     the clock, before any phase or grant table, so this step only proves the checkpoint was restored and the lease and the
     function work; on its own it cannot show that no second grant happens.
   - **Guard probes** (`resume.probes`), each in a subtransaction that is always rolled back, on the latest settled slot at
     or below the published slot: a second settlement of that (character, slot) with a fresh activity and receipt must be
     refused by the `private.settled_slots` primary key (`primary-key`); deleting that settled slot must be refused by
     `guard_frozen` (`guard`); deleting an operation receipt must be refused by `guard_receipt` (`guard`). Anything else
     (`accepted`, `no-row`, or another SQLSTATE such as a foreign key's `23503`) fails the check. These probes are what show
     that the restored copy cannot grant a slot twice or lose its grant guards.
   - **Counts:** settled slots, receipts, ledger rows, items, awards and wallets before the replay and after the probes must
     be equal (`countsUnchanged`, `duplicateGrants: 0`, `lostItems: 0`).
6. Drop `cloudiator_restore_check` (unless `-Keep`; drop it later with the same `drop database … with (force)` statement,
   that exact name only), then print the report: `counts`, `mismatches`, `checksums`, `invariants`, `resume`,
   `duplicateGrants`, `lostItems`, the excluded entries and the database state. Exit `0` when everything matches, `1` when a
   check fails.

**The one exclusion list** (`RESTORE_EXCLUSIONS` in `scripts/restore-compare.mjs`; nothing else is ever left out, and no
error is suppressed): pg_cron can only be created in the database named by `cron.database_name` (`postgres`), so
`CREATE EXTENSION pg_cron` fails in `cloudiator_restore_check` with "can only create extension in database postgres". The
restore therefore leaves out exactly: the `pg_cron` extension and its comment, the `cron` schema's ACL (and the schema and its
comment if a dump lists them), and every entry inside the `cron` schema: its function and table ACLs, default privileges, the
`cron.job` schedule and `cron.job_run_details` data, and the two sequence values. The local run left out 15 schema entries
and 4 data entries. The schedules stay in the backup; a restore into a real `postgres` database (Task 24) keeps them.
`pg_net`, `supabase_vault`, `pgcrypto`, `uuid-ossp` and `pg_stat_statements` restore normally.

Restore-check failure codes (exit `2`): `database-not-allowed`, `backup-missing`, `manifest-missing`, `manifest-invalid`,
`file-missing`, `json-invalid`, `container-missing`, `container-not-verified`, `container-not-running`,
`container-work-failed`, `copy-failed`, `drop-failed`, `create-failed`, `list-failed`, `exclude-failed`, `sql-failed`,
`schema-restore-failed`, `data-restore-failed`, `invariants-failed`, `resume-failed`, `restore-check-failed`, and the
comparison module's own codes: `usage` (`scripts/restore-compare.mjs` was called with the wrong arguments, so the scripts in
the checkout do not match: use a clean checkout), `verify-failed` (the checksum step failed otherwise, for example on a backup
file it could not read: check the files' permissions, then rerun) and `compare-failed` (the report step failed otherwise, for
example on a work file it could not read: rerun the check). On a failure the script still drops the database (unless
`-Keep`) and removes its temporary files. A failed schema or data restore leaves psql's own error text on the console, and
that text can echo row values, for example `Failing row contains (…)` with an `auth.users` row: read it on the operator's
console only and never paste it into an issue, a chat or a log.

The resume status (`resume.status` in the report) must be `replayed`; any other status fails the check with exit `1`:
- `not-replayed`: the lease was taken but `advance_boundary` refused, and `resume.result` carries its code. `invalid` means
  the published slot is ahead of this machine's clock: correct the clock and rerun the check on the same backup. For any
  other code, do not trust the backup: run the health check on the source and export again.
- `no-published-slot`: the source never published a boundary, so there is nothing to replay. Locally, seed a world first
  ("Seeding a local world for the check" below). For the hosted database, enable the scheduler (after the season epoch),
  wait until the health check shows `slotsBehind` `0`, and export again.
- `lease-held`: the copy carries an unexpired coordinator lease, because the export caught a coordinator run (a lease lasts
  120 s). Rerun the check on the same backup two minutes later; if it persists, this machine's clock is behind the source's.

If a check fails, do not trust that backup: run `scripts/restore-invariants.sql` against the source inside a read-only
transaction to see whether the source itself violates the invariant, fix that first, and export again.

**What the check proves and what it does not.** It proves the files are intact, every row came back, the invariants hold in
the copy, the restored checkpoint is published and replays structurally, and the grant guards (the settled-slot primary key,
`guard_frozen` and `guard_receipt`) refuse a second settlement and a deletion in the copy. The replay alone is not that
proof; the guard probes are. It is a separate database in the
local cluster, so roles come from that cluster and pg_cron is absent. Restoring the hosted service itself (a new project,
migrations, the data, the Vault secrets, the cron jobs) is Task 24's procedure.

**Seeding a local world for the check.** A fresh local database has no published boundary to replay. Build a small real world
first with `npm run test:db -- tests/db/restore-world.test.ts` (four characters, an open listing and a catch-up through
boundary 1009 that closes season 1); that file deliberately leaves its world in place. Follow the database-test rule in
`docs/operations/verification-gates.md`.

## Free-tier pausing

The free tier can pause a project that looks inactive. pg_cron's own traffic runs inside the database and is not a guarantee
that the project counts as active; do not rely on the scheduler to keep it awake. A paused project serves nothing: the health
check fails with `connection-failed` and players cannot load the game.
- Check the project's status in the hosting dashboard during the weekly export and the daily health check. Which traffic
  counts as activity is the host's rule, not ours; confirm the current policy in the hosting documentation at Task 24.
- After a restore from pause, run the health check. Catch-up processes the missed slots in order (tested in
  `tests/db/recovery.test.ts`), sweeps the listings that expired during the pause once and returns their items once; cleanup
  catches up hourly. Expect `boundary-behind` and possibly `cleanup-backlog` until it has caught up.
- A long pause (weeks) means a long catch-up at 6 boundaries a minute; plan the paid tier before launch if that is not
  acceptable.

## Budgets in the hosting dashboard

The free-tier budgets are 500 MB database (warning at 400 MB; Avi's decision, 2026-10-19), **3 GB monthly egress** and
**300,000 monthly Edge Function invocations**. The
health report covers only the database size (`resources`, the `database-size` alert); the Edge runtime exposes no
per-request CPU (`cpu: "not available"`), and egress and invocations are read in the dashboard:
- Open the organization's usage page in the Supabase dashboard for the current billing cycle.
- **Egress:** compare the cycle's total with 3 GB, and the daily trend with 3 GB divided by the days in the cycle (about
  100 MB a day). A sudden rise usually means a client polling too often or large replays being read.
- **Edge Function invocations:** compare with 300,000 (about 10,000 a day). Dispatch sends at most 5 worker invocations a
  minute (`private.scheduler.max_dispatch_per_minute`, at most 7,200 a day) and only for claimable work; the rest is player
  commands. If the trend crosses the daily share, lower `max_dispatch_per_minute` (1–5) and check for clients retrying commands.
- Record the three numbers with each weekly export.

## Release access audit

Task 23.1 (M17; `docs/operations/migrations.md`, "Task 23.1"). `scripts/access-audit.sql` is one SELECT over the catalog and
changes nothing. Each row is `section | object | grantee | privilege | detail`: every privilege PUBLIC, anon, authenticated and
service_role hold on the relations, columns, sequences, functions and schemas of `public` and `private`; the default
privileges of the role that owns those objects; role memberships; every policy (its detail is `permissive` or `restrictive`
and `md5:` of its USING and WITH CHECK expressions, so a changed policy body changes the row); any table without row
security, view without `security_invoker`, materialized view, SECURITY DEFINER function or function without
`search_path=""`; and, in the `platform-default` and `database` sections, the platform's own settings. Only policy rows
have a detail. A finding row names a view's options or a function's settings, never their values (Task 24.1). The file's
header describes each section. It needs PostgreSQL 17 (MAINTAIN). `tests/db/access-matrix.test.ts` holds the expectations.

Run it after deploying M17, after any later migration and before launch. The comparison needs no connection string, key or
password, and the two CSV files hold only catalog names, privileges and hashes. Work in Windows PowerShell, in the
repository root, one step after another:
1. **A work folder outside the repository**, new for this run:
   ```powershell
   $work = Join-Path ([IO.Path]::GetTempPath()) ('cloudiator-audit-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
   New-Item -ItemType Directory -Path $work | Out-Null
   ```
2. **Local reference.** On the local stack, at the commit being deployed, with `migration list --local` showing the same
   migrations as the hosted project and no SQL source applied since the last `db reset --local --no-seed --yes` (a reset
   guarantees both and deletes local data), after the label check. `Set-Content -Encoding utf8` is used because `>` in
   Windows PowerShell 5.1 writes UTF-16.
   ```powershell
   (docker inspect -f '{{json .Config.Labels}}' supabase_db_Cloudiator | ConvertFrom-Json).'com.supabase.cli.project'   # must print Cloudiator
   'select current_schemas(false);' | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -At   # {public,extensions}
   Get-Content scripts/access-audit.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1 --csv |
     Set-Content -Encoding utf8 -LiteralPath (Join-Path $work 'local-access-audit.csv')
   "psql exit $LASTEXITCODE"                                                                                   # must print psql exit 0
   ```
3. **Hosted.** In the hosted SQL editor, as the database owner, run `select current_schemas(false);` and check that it prints
   the same schemas as step 2. The policy hashes come from deparsed expressions, which qualify names by the session's search
   path, so a different path changes every policy hash, not one. `current_schemas` lists the existing schemas the path
   resolves to; `show search_path` prints its text, which can differ in form while resolving to the same schemas (locally,
   observed 2026-10-20, it reads `"\$user", public, extensions`, with a stored backslash). Then, in a new query, run the whole
   of `scripts/access-audit.sql` (if the editor offers a row limit, choose none) and download the result as CSV into `$work`
   as `hosted-access-audit.csv`.
4. **Read both files.** `Import-Csv` reads a field the same way however the export quoted it:
   ```powershell
   $row = { '{0} | {1} | {2} | {3} | {4}' -f $_.section, $_.object, $_.grantee, $_.privilege, $_.detail }
   $local = @(Import-Csv -LiteralPath (Join-Path $work 'local-access-audit.csv') | ForEach-Object $row)
   $hosted = @(Import-Csv -LiteralPath (Join-Path $work 'hosted-access-audit.csv') | ForEach-Object $row)
   foreach ($name in 'local', 'hosted') { (Get-Content -LiteralPath (Join-Path $work "$name-access-audit.csv") -TotalCount 1) }
   "local: $($local.Count) rows; hosted: $($hosted.Count) rows"
   ```
   Both header lines must be `section,object,grantee,privilege,detail` (with or without quotes) and both counts above zero;
   otherwise the export is not the audit's, so download it again.
5. **Compare** them as sets of rows, case-sensitively, and list the differences by section:
   ```powershell
   $diff = @(Compare-Object -CaseSensitive $local $hosted | Sort-Object InputObject)
   $diff | ForEach-Object { '{0} {1}' -f $(if ($_.SideIndicator -eq '<=') { 'local only: ' } else { 'hosted only:' }), $_.InputObject }
   $diff | Group-Object { $_.InputObject.Split('|')[0].Trim() } | ForEach-Object { "$($_.Name): $($_.Count)" }
   $findings = 'rls-disabled', 'not-security-invoker', 'materialized-view', 'security-definer', 'search-path'
   @($local + $hosted) | Where-Object { $findings -contains $_.Split('|')[0].Trim() }                          # must print nothing
   ```
   - Any difference in `relation`, `column`, `sequence`, `function`, `schema`, `default`, `membership` or `policy`, or any row
     in a finding section (`rls-disabled`, `not-security-invoker`, `materialized-view`, `security-definer`, `search-path`)
     on either side, blocks the release until it is explained and fixed by a new migration.
   - A difference in `platform-default` or `database` is the hosted platform's state: record it in the release evidence and
     check that it touches nothing of ours.
6. **Record and clean up.** Record the two counts and every difference line in the release evidence, then remove the folder:
   `Remove-Item -LiteralPath $work -Recurse`.

Expected platform rows (accepted exception E; the local replay shows exactly these):
- `platform-default supabase_admin:<schema>:tables|sequences|functions` for `public`, `graphql`, `graphql_public` and
  `supabase_functions`: anon, authenticated and service_role receive every table privilege, SELECT, UPDATE and USAGE on
  sequences, and EXECUTE on functions. postgres cannot alter them, and nothing of ours is created by supabase_admin.
- `platform-default postgres:storage:tables|sequences|functions`: the same grants, in the platform's `storage` schema, where we
  create nothing.
- `database postgres`: CONNECT and TEMPORARY for PUBLIC (and therefore for anon, authenticated and service_role). No client role
  may CREATE.
- Also expected outside the platform sections: `schema public PUBLIC USAGE` (PostgreSQL's default), and service_role's pinned
  privileges (exception D: MAINTAIN on the eight M01 owner tables, MAINTAIN, REFERENCES, TRIGGER and TRUNCATE on
  `owner_state`, and its `public` table and sequence defaults).
- Policy rows: every policy of ours is `permissive`, with command SELECT for anon and authenticated (`player_read` and
  `due_read` on the open projections, `owner_read` on owner data, which filters by `auth.uid()`) or ALL or SELECT for
  service_role (`backend_only`). Each `md5:` must equal the local reference's.

Not yet run against a hosted project (none exists before Task 24); Task 24 verifies the export format and the comparison.
Rehearsed locally in Task 24.1: steps 1, 2, 4, 5 and 6 with a "hosted" file made from the local one, re-quoted, with one row
changed and one added; step 5 listed exactly those three lines.

## Schema fingerprint and hosted checks

Task 24.1 (plan Decision 1). Two more read-only files, each one SELECT, for the hosted steps of Task 24; each file's header
lists its sections and how to run it (the hosted SQL editor as the database owner, no row limit, downloaded as CSV; or
locally through the container after the label check). Neither prints a secret, key, token or email.
- `scripts/schema-fingerprint.sql`: one `line` per function, relation, column, policy, trigger, constraint, index, schema ACL,
  default ACL and cron job, plus the seed counts. It is the fingerprint the migration replays compared since Task 13; compare
  the hosted output with a clean local replay of the same commit right after `db push`, as sets of lines (step 4 above reads
  a `line` column the same way), with the same `current_schemas(false)` on both sides.
- `scripts/hosted-checks.sql`: `section | item | value` rows for migration parity, the scheduler and epoch, dispatches per
  scheduled minute, job-attempt durations per kind, boundary publication latency, pg_net response codes, duplicate grants,
  one character per account and the trade fee and owner checks.
`tests/db/hosted-checks.test.ts` runs both inside a read-only transaction. Neither has been run against a hosted project yet:
the hosted owner's privileges on `vault.secrets`, `auth.users`, `auth.identities`, `net._http_response` and `cron.job` are
untested.

## Running the deployed checks

Task 24.2 (plan Decisions 1, 8 and 9). `tests/browser/deployed.spec.ts` checks the public origin with its own config,
`tests/browser/playwright.deployed.config.ts`; the release gate's config ignores it, so `npm run verify` never runs it. The
per-project deployment checklist (`docs/operations/deployment.md`, Tasks 24.5, 24.6 and 24.8) says when to run which set. No
check signs in or sends a credential: the worker is asked without its secret, and the Data API and Auth are asked anonymously
with the publishable key the deployed bundle carries (public by design; kept in memory, never printed; traces are off).

```powershell
$env:CLOUDIATOR_DEPLOYED_ORIGIN = 'https://cloudiator.pages.dev'        # required: the config refuses to load without it
$env:CLOUDIATOR_SUPABASE_ORIGIN = 'https://<project>.supabase.co'      # for connectSrc, cors, anonDenied, authProvidersGoogleOnly
npx playwright test --config tests/browser/playwright.deployed.config.ts --grep-invert '@attested'   # the automatic checks
npx playwright test --config tests/browser/playwright.deployed.config.ts                             # all, after the journey
```

- **Automatic** (`@automatic`): `fixedRoutesReload` (desktop and phone: each fixed route loads and reloads with 200 and no
  console error; a 404 for `/favicon.ico` is recorded, not failed: the site has no icon), `securityHeaders` (each route and a
  `/_next/static/` chunk carry exactly what the generated `_headers` gives that path), `connectSrc` (exactly `'self'` and the
  project), `compression` (every route's HTML and crawled chunk `br` or `gzip`), `cors` (the command preflight from the site:
  204 or 200, exactly the site's grant, never `*`, `Access-Control-Max-Age: 7200`; from another origin 403 with no grant; the
  worker without its secret 401 `unauthenticated`), `anonDenied` (14 anonymous probes from `tests/db/access-matrix.test.ts`
  that change nothing even if granted: backend-only and owner RPCs with null arguments, empty inserts, a no-row update and
  delete, the unexposed `private` schema), `authProvidersGoogleOnly` (`/auth/v1/settings`: Google alone, sign-up open),
  `shippedAssetsClean` (the release scan's patterns, `scripts/release-scan.mjs`, over every asset the routes reference or load).
  Every page runs under the CSP-violation listener.
- **Attested** (`@attested`, Decision 8): after the real journey, Avi runs `scripts/hosted-checks.sql` and pastes the sanitized
  rows; set each variable from its row (a check fails, naming the variable and row, until it is set):
  `CLOUDIATOR_ATTEST_NEW_ACCOUNT_CHARACTERS` (`characters / account <hash>` of the new account, expected 1),
  `CLOUDIATOR_ATTEST_BOUNDARIES_COMPLETED` (`boundary-latency / last 24 h boundaries`, at least 1),
  `CLOUDIATOR_ATTEST_BOUNDARIES_OVER_120S` (0), `CLOUDIATOR_ATTEST_DUPLICATE_GRANTS` (`duplicate-grants / total`, 0),
  `CLOUDIATOR_ATTEST_TRADE_OWNERS` (the trade's `trades / sale <hash>` owners, 1), `CLOUDIATOR_ATTEST_TRADE_FEE_CORRECT`
  (its `fee right`, true).

**Local stand-in** (Task 24.2): serve an export with `scripts/serve-static.mjs` on a free port and point
`CLOUDIATOR_DEPLOYED_ORIGIN` at it, with `CLOUDIATOR_SUPABASE_ORIGIN=http://127.0.0.1:54321`. Expected to differ from hosted:
`compression` fails (the local host does not compress); `cors` fails (the local Kong gateway answers every preflight itself
with `*` and no Max-Age, before the function); `connectSrc` fails on the browser-test export (built without a project URL);
`anonDenied` and `authProvidersGoogleOnly` fail (a local build carries no publishable key), and the latter would also find
Google off. `fixedRoutesReload` fails on the `__next.*.txt` prefetch 404s (Task 23.5 M7) until that triage lands.
