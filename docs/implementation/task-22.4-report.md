# Task 22.4 report: export, restore check and the operator guides

Branch `claude/task-22` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base 074dcf3. Plan
`docs/superpowers/plans/2026-10-18-task-22-retention-operations.md`: Decision 9, the Review Focus "A restore into a separate
database", the Task 22.4 text, and the carried Task 22.3 review items M1–M3 plus the egress/invocation runbook note.

Commits:
- `8c2d01d` fix: parse operator connections once and classify EPIPE as a network failure (M1, M2)
- `30d27b1` ops: export, restore check and operator guides
- `c83981c` fix: refuse a loopback URL for a remote export and correct the runbook (self-review)
- the controller's `9e56dbf` (docs, Docker start note) landed in this worktree between them.

**Interruption.** The host rebooted during the first run, after `8c2d01d` and with the scripts written but uncommitted. After
the controller restored the runtime (Engine 29.8.2, stack up, Edge serve restarted 05:49:33Z), I re-checked every uncommitted
file (all complete), confirmed the local database was unchanged (published slot 373406, 1 character, 787 Auth users, 16
migrations), and found no `cloudiator_restore_check` database, container temp directory or host temp directory left behind.

## What was implemented

### Export: `scripts/export-db.ps1 [-OutDir .backups] [-Remote]`
- Verifies that `supabase_db_Cloudiator` carries `com.supabase.cli.project=Cloudiator` and is running. It uses
  `{{json .Config.Labels}}`, because the `{{index … "…"}}` template breaks under Windows PowerShell 5.1 (see Concerns).
- Writes `.backups/<UTC yyyyMMddTHHmmssZ>/` with three files:
  - `schema.dump`: `pg_dump --format=custom --schema-only` of the whole database.
  - `data.dump`: `--data-only`, including `auth.users`.
  - `manifest.json`: the git commit, `dirty`, the server version, the applied migrations, the excluded table data, the row
    count of every public and private table plus `auth.users`, and the SHA-256 of both dumps. The counts are the COPY rows of
    `data.dump` itself, streamed through `pg_restore -f -`, so they describe exactly that file. Live counts taken in a
    separate transaction could drift on a busy hosted database.
- Tools: only `pg_dump`/`psql` 17.11, run inside the container with `docker exec`, and `docker cp`. It creates no container
  or image and downloads nothing.
- `-Remote`:
  - It first runs `node scripts/operator-db.mjs check CLOUDIATOR_EXPORT_DB_URL`, which parses and validates the URL and
    prints only a code.
  - Each libpq tool then runs through `operator-db.mjs exec`, which sets only the parsed `PG*` variables
    (`docker exec -e PGHOST …` reads the values from the environment, never from arguments). It drops the URL variable and
    discards libpq's stderr, which names the host.
  - A loopback URL is refused (`remote-is-local`).
- A failure prints `{"ok":false,"code":…}` and exits 2. The run removes the backup directory it created and both temp
  directories.

### Restore check: `scripts/restore-check.ps1 -Backup <dir> [-Database cloudiator_restore_check] [-Keep]`
- **Before anything changes:**
  - It refuses any `-Database` other than exactly `cloudiator_restore_check` (case-sensitive), a missing backup or a
    missing manifest.
  - It verifies the container label.
  - It verifies the SHA-256 of both dumps against the manifest. A mismatch exits 1 with nothing restored. The manifest must
    list exactly `schema.dump` and `data.dump`, which a self-review test added.
- **Database.** It drops and recreates only `cloudiator_restore_check` (from `template0`) over a maintenance connection to
  `postgres`. It never changes the `postgres` database's data, roles or extensions, and never resets or stops the stack.
- **Restore.** It runs `pg_restore -l`, filters the listing (`RESTORE_EXCLUSIONS`, below) and generates SQL with
  `pg_restore -L`. psql then applies it with `-v ON_ERROR_STOP=1 --single-transaction`: the schema first, then the data under
  `session_replication_role = replica`. No error is suppressed.
- **Checks.**
  - `scripts/restore-invariants.sql`, a single read-only statement: the counts and nine invariants.
  - `scripts/restore-resume.sql`, which refuses to run in any other database. It takes the coordinator lease exactly as
    `public.coordinate_work()` does: a fresh token, 120 s from `planning_now_ms()`, only when no live lease is held. It then
    calls `public.advance_boundary(published_slot, token)`, releases the lease, and compares settled slots, receipts, ledger
    rows, items, awards and wallet balances before and after.
    - **Corrected in Fix round 1.** For a published slot, `advance_boundary` returns before any grant table, so this
      before/after comparison is structural only. Zero duplicate grants here is not proof that a replay grants nothing new.
      The behavioural proof is the guard probes added in Fix round 1, below.
- **Finish.** It drops the database unless `-Keep`, then prints the report from `node scripts/restore-compare.mjs compare`.
  Exit 0 when everything matches, 1 when a check fails, 2 when the procedure fails. On a failure the script still drops the
  database (unless `-Keep`) and removes its temp files.

### `scripts/restore-compare.mjs`
- `compareRestore(manifest, observed)` returns `{ok, mismatches: [{table, expected, actual}], checksums: {file: ok},
  invariants}`, plus `resume` when the observation has one.
  - A table on only one side is a mismatch, with `null` on the other side.
  - A missing invariant, or one whose `ok` contradicts its `violations`, fails (fail closed).
  - A resume must be `replayed` with `duplicateGrants: 0` and `lostItems: 0`.
  - A malformed manifest throws instead of passing.
- `filterRestoreList` and `RESTORE_EXCLUSIONS`, `countCopyRows`/`copyRowCounter`, `manifestCounts`,
  `EXPORT_DATA_EXCLUSIONS`.
- The CLI verbs used by the two scripts: `dump-args`, `manifest`, `exclude`, `verify`, `compare`. They print only counts,
  booleans, hex checksums, table names and short codes.

### Carried fixes (Task 22.3 review)
- **M1.** `scripts/operator-db.mjs` holds `parseDatabaseUrl`, `operatorTarget`, `postgresOptions` and `libpqEnvironment`.
  - The parser refuses:
    - an authority with `,` or more than one `@`;
    - whitespace or control characters, backslashes and fragments;
    - a missing user;
    - socket paths, and hosts that are not a plain name, IPv4 address or bracketed IPv6 literal (percent-encoded hosts
      included);
    - a nested database path;
    - a port outside 1–65535;
    - any query parameter except `sslmode` (`disable`, `allow`, `prefer`, `require`, `verify-full`).
  - WHATWG must report the same host and port as the raw authority.
  - `health.mjs` now hands postgres.js `host: [h], port: [p], user, pass, database, ssl`, never the string. Arrays are used
    because postgres.js would re-split a host string on `:` and `,`.
  - Local discovery parses the status DB URL with the same parser and returns `discovery-not-local` for a non-loopback host.
  - The export uses the same parser through `PG*` variables.
  - The runbook ("Connections and TLS") notes that `require` encrypts but does not verify, and how to add
    `sslmode=verify-full` with the hosted CA: `NODE_EXTRA_CA_CERTS` for health, `/root/.postgresql/root.crt` in the container
    for the export.
- **M2.** `describeFailure` tests the network set first, and a SQLSTATE must contain a digit. `EPIPE` is now
  `connection-failed`.
- **M3.** The runbook's health section documents every CLI failure code, `discovery-not-local` and `database-missing`
  included, and what to do about each.
- **Budgets.** The runbook covers reading egress (3 GB) and Edge Function invocations (300,000) in the hosting dashboard.

### Guides
- `docs/operations/runbook.md` covers:
  - the health check, each alert and what to do, and the CLI failure codes;
  - connections and TLS;
  - manual recovery after three failures (`private.resume_operator_job`, deterministic errors fixed first);
  - retained-rule deployments (`rules_versions`);
  - pausing and resuming the scheduler;
  - secret rotation (Vault `game_worker_url`/`game_worker_secret` and the Edge `GAME_WORKER_SECRET`, names only);
  - the weekly export and the restore check, with both exclusion lists and every failure code;
  - free-tier pausing;
  - the dashboard budgets.
- `docs/operations/environment.md` covers:
  - the local stack (versions, containers, disabled services, ports);
  - the four worktrees and the shared-stack rule;
  - placeholders for the hosted environment (Task 24);
  - every environment variable and secret name, with where it lives.
- `docs/operations/migrations.md`:
  - The M16 health section points to the runbook.
  - The PowerShell label check is fixed.

## Files

- New:
  - `scripts/operator-db.mjs`, `scripts/export-db.ps1`, `scripts/restore-check.ps1`, `scripts/restore-compare.mjs`;
  - `scripts/restore-invariants.sql`, `scripts/restore-resume.sql`;
  - `tests/scripts/operator-db.test.ts`, `tests/scripts/restore-invariants.test.ts`, `tests/db/restore-world.test.ts`;
  - `docs/operations/runbook.md`, `docs/operations/environment.md`.
- Changed: `scripts/health.mjs`, `.gitignore` (`.backups/`), `docs/operations/migrations.md`.
- Additions beyond the brief's file list:
  - `operator-db.mjs`, the shared parser required by M1.
  - `restore-resume.sql`, which keeps the resume step separate from the read-only invariant statement.
  - `restore-world.test.ts`, the seed world, which also tests the invariant SQL on real data.

## The exclusion lists and why

**Restore (`RESTORE_EXCLUSIONS`). This is the only thing left out, and no error is suppressed.**
- Why: pg_cron can only be created in the database named by `cron.database_name` (`postgres`). A trial restore of the full
  schema into `cloudiator_restore_check` failed with exactly 15 errors, all of them pg_cron's: `can only create extension in
  database postgres`, then `extension "pg_cron" does not exist`, then `schema "cron" does not exist` for each `cron` ACL.
- The rules leave out:
  - the `pg_cron` extension and its comment;
  - `ACL - SCHEMA cron` (and, if a dump lists them, the `cron` schema and its comment);
  - every entry whose schema is `cron`: its function and table ACLs, default privileges, `cron.job` and
    `cron.job_run_details` data, and the two sequence values.
- The real run left out 15 schema entries and 4 data entries. They are listed in the JSON below.
- Unaffected: `pg_net`, `supabase_vault`, `pgcrypto`, `uuid-ossp` and `pg_stat_statements` restore normally. Nothing in
  `public`, `private` or `auth` is excluded.

**Export (`EXPORT_DATA_EXCLUSIONS`, table data only; recorded in each manifest).** This is my design decision; please
review it.
- `vault.secrets`: the ciphertext is bound to the source server's root key and would not decrypt elsewhere. The runbook
  re-creates the secrets by name.
- `auth.sessions`, `auth.refresh_tokens`, `auth.mfa_amr_claims`, `auth.one_time_tokens`, `auth.flow_state` and
  `auth.saml_relay_states`: live sessions, refresh tokens and short-lived sign-in flow tokens. They are bearer material with
  no game state, and the set is closed under its foreign keys. After a restore, players sign in again.

## Seeding, and the real procedure (evidence)

A fresh local database had no world to replay: published slot 373406 left over from tests, 0 settled slots and a test lease.
So I seeded first, through the existing helpers.
- **The seed.** `tests/db/restore-world.test.ts` builds:
  - four characters (two Arena, one woodland expedition, one trainee) through real creation;
  - one open listing through the real `create_listing` command;
  - a scheduler catch-up through boundary 1009, made of `cron_tick` plus the real `runWorker` with the session clock
    stand-in, restored byte for byte. It closes season 1 at boundary 1008.
- **Left in place.** The file deliberately does not reset in `afterAll`.
- **The seeded world.** `{"published":1009,"leaseReleased":true,"gladiators":4,"activities":40,"settledSlots":40,"receipts":31,
  "ledger":30,"items":13,"awards":2,"seasons":2,"openListings":1,"arenaResults":8,"checkpoints":0,
  "kinds":{"arena":16,"training":9,"rest":7,"expedition":8}}`.
- **Sequence.** `npm run test:db -- tests/db/restore-world.test.ts` (4/4, Edge 05:49:33Z unchanged), then
  `scripts/export-db.ps1`, then `scripts/restore-check.ps1 -Backup .backups/20261019T060545Z`. This was the final run with
  the final code. An earlier identical run (backup `20261019T055459Z`, 54 tables and 1849 rows) also passed. It was redone
  after the verify guard changed `restore-compare.mjs`.

The export printed this (exit 0, 3 s):
```json
{"ok":true,"backup":"20261019T060545Z","source":"local","commit":"9e56dbf1ab3a9f21d2eeceb4acfec57c20ce89ec","tables":54,"rows":2653,
 "migrations":16,"files":{"data.dump":"e9d3c88327d5ec144f4a78b5ffa2ef370884b7c1de053deff3d8b25b78fba798",
 "schema.dump":"3bd80760b7b4d5a4cfa8a3dd47d703d431b7c4fcf44e7216e6ef3f852457dfd1"}}
```
The manifest's keys are `format, createdAt, source, commit, dirty, serverVersion (17.11), migrations (16), excludedData (7),
tables (54), files`.

The restore check printed this (exit 0, 10 s). `excluded.entries` is abbreviated here; the full list is in the first run's
output, ids differ:
```json
{"ok":true,
 "backup":{"name":"20261019T060545Z","createdAt":"2026-10-19T06:05:47.828Z","source":"local","commit":"9e56dbf1ab3a9f21d2eeceb4acfec57c20ce89ec","migrations":16},
 "counts":{"tables":54,"rows":2653,"restoredTables":54,"restoredRows":2653,"mismatched":0},
 "mismatches":[],
 "checksums":{"data.dump":true,"schema.dump":true},
 "invariants":{"settledSlotsUnique":{"ok":true,"violations":0},"completedActivitiesGuarded":{"ok":true,"violations":0},
   "ledgerReceiptsUnique":{"ok":true,"violations":0},"walletReconciliation":{"ok":true,"violations":0},
   "itemsSingleOwner":{"ok":true,"violations":0},"inventoryCap":{"ok":true,"violations":0},
   "seasonAwardsUnique":{"ok":true,"violations":0},"foreignKeys":{"ok":true,"violations":0},"guardsIntact":{"ok":true,"violations":0}},
 "resume":{"slot":1009,"status":"replayed","ok":true,
   "result":{"ok":true,"phase":9,"status":"complete","replayed":true,"slotIndex":1009},
   "before":{"items":13,"money":1360,"awards":2,"ledger":30,"renown":256,"receipts":31,"settledSlots":40},
   "after":{"items":13,"money":1360,"awards":2,"ledger":30,"renown":256,"receipts":31,"settledSlots":40},
   "duplicateGrants":0,"lostItems":0},
 "duplicateGrants":0,"lostItems":0,
 "excluded":{"schema":15,"data":4,"entries":[
   {"type":"EXTENSION","schema":"-","name":"pg_cron"},{"type":"COMMENT","schema":"-","name":"EXTENSION pg_cron"},
   {"type":"ACL","schema":"-","name":"SCHEMA cron"},
   "… 7 ACL cron FUNCTION entries (alter_job, job_cache_invalidate, schedule ×2, schedule_in_database, unschedule ×2) …",
   {"type":"ACL","schema":"cron","name":"TABLE job"},{"type":"ACL","schema":"cron","name":"TABLE job_run_details"},
   "… 3 DEFAULT ACL cron entries (SEQUENCES, FUNCTIONS, TABLES) …",
   {"type":"TABLE DATA","schema":"cron","name":"job"},{"type":"TABLE DATA","schema":"cron","name":"job_run_details"},
   {"type":"SEQUENCE SET","schema":"cron","name":"jobid_seq"},{"type":"SEQUENCE SET","schema":"cron","name":"runid_seq"}]},
 "database":{"name":"cloudiator_restore_check","state":"dropped"}}
```

- **Afterwards:**
  - `pg_database` is `_supabase, postgres, template0, template1`, so the restore database is gone.
  - No `/tmp/cloudiator-*` remains in the container and no host temp directory remains.
  - `git status --short --ignored` shows only `!! .backups/`, and `git check-ignore` matches `.gitignore:17:.backups/`.
- **Further real runs:**
  - A tampered copy (one byte appended to `data.dump`) exited 1 before any restore:
    `{"ok":false,"code":"checksum-mismatch","checksums":{"data.dump":false,"schema.dump":true}}`.
  - `-Keep` kept the database (`"state":"kept"`). I then dropped that exact name by hand. `cron.job` is absent in the copy,
    as documented.
  - Refusals:
    - `-Database postgres` → `database-not-allowed`;
    - `-Database Cloudiator_Restore_Check` → `database-not-allowed`;
    - a missing backup → `backup-missing`;
    - `-Remote` without a URL → `remote-needs-url`;
    - `-Remote` with the review's evil URL → `invalid-url`;
    - `-Remote` with an unreachable `.invalid` host → `schema-dump-failed`;
    - `-Remote` with a loopback URL → `remote-is-local`.
  - None of the refusal runs leaked a marker or the host into stdout or stderr, and none left a backup directory behind.

## Tests (RED/GREEN)

- **RED 1:** both new unit files fail to import (`Cannot find module '../../scripts/operator-db.mjs'` and
  `'../../scripts/restore-compare.mjs'`).
- **RED 2: the review bugs, shown on the unchanged 22.3 logic.** I moved that logic into `operator-db.mjs` verbatim as a
  first stage. 5 of 10 tests failed:
  - M1: the evil URL was accepted (`expected 'none' to be 'invalid-url'`);
  - M2: `EPIPE` → `query-failed` with sqlstate `EPIPE`;
  - an encoded `%2Ftmp` host was accepted;
  - the IPv6 brackets were kept twice.
- **GREEN:** 10/10 after the fix. Then `restore-invariants.test.ts`: 14/14 for compareRestore (matching, missing table,
  extra table, changed count, bad or missing checksum and hex case, failed invariant, missing or contradicting invariant,
  resume, malformed manifest), the listing filter, COPY counting and manifestCounts.
- **Self-review additions:**
  - `verify` CLI test, 1 case. RED by mutation: with the manifest-files guard removed, a manifest listing only one dump
    verified with exit 0, so `expected { status: +0 … } to deeply equal { status: 2 … }`. Restored byte-identical (SHA-256
    `f6ccf853…` before and after).
  - `operator-db.mjs` CLI tests, 2 cases: `check`, and `exec` passes only the parsed `PG*` variables.
- **DB test `restore-world.test.ts`** (4 cases):
  - the world;
  - every invariant holds on it, and the counts cover every public and private table plus `auth.users`;
  - wallet reconciliation with and without a folded checkpoint;
  - a lost settled-slot guard, an orphan item, a stray listing, 61 items and a disabled guard, each caught.
  - RED by mutation: with the orphan count forced to 0, the orphan case failed (`expected 0 to be greater than 0`).
    Restored byte-identical (SHA-256 `99a39dc9…`).
- **Gates:**
  - `npm test`: 1083/1083 in 49 files (1056 before, plus 27 new).
  - `npm run typecheck`: passes (tsc, deno check, the Deno smoke test).
  - `npm run test:db`, full suite: 256/256 in 15 files (252 plus 4), Edge start time 05:49:33Z before and after.
  - `npm run test:db` on `health.test.ts` plus `restore-world.test.ts`: 10/10, Edge unchanged. The health CLI's loopback,
    refused, remote and usage cases pass on the new parser.
  - `git diff --check`: clean.

## Self-review

- **Fixed: the verify gate.** `verify` trusted whatever files the manifest listed, while `restore-check.ps1` restores
  `schema.dump` and `data.dump` regardless. A manifest listing only one dump would have let the other restore unverified.
  Both are now required (test above).
- **Fixed: a loopback URL with `-Remote`.** Such a URL would have made `pg_dump` connect to the container itself; it is now
  refused (`remote-is-local`).
- **Runbook corrections:**
  - Hosted direct hosts may be IPv6-only while Docker often has no IPv6 route, so the runbook now names the session pooler
    (port 5432) as the fallback.
  - I removed an unverified claim about which traffic counts as project activity.
- **Checked:**
  - No output path prints a connection string, password or raw tool text.
  - Every psql run uses ON_ERROR_STOP.
  - The only database ever dropped or created is the constant `cloudiator_restore_check`.
  - `restore-resume.sql` refuses other databases.
  - All temp paths are generated from a UTC stamp and removed in `finally`.

## Concerns

1. **The remote export is untested past the connection.** No hosted project exists yet; Task 24 runs it. Two risks:
   - The hosted `postgres` role must be able to `pg_dump` every schema. It worked locally, where `postgres` holds
     `pg_read_all_data`, but that is unverified on the host.
   - IPv6-only direct hosts (see the runbook).
2. **The restore check is a separate database in the local cluster.** Roles come from that cluster and pg_cron is absent.
   It proves the backup's completeness and consistency, not a hosted disaster recovery. Task 24 owns the real restore of a
   project.
3. **Export data exclusions.** Excluding the session and flow-token data is my decision. The brief asked only for a data
   dump including `auth.users`. If Avi prefers full Auth data, remove those names from `EXPORT_DATA_EXCLUSIONS`.
4. **The seed world is left in the local database** by `restore-world.test.ts` when it runs alone. The full suite's later
   files reset it as usual. The local `.backups/20261019T060545Z` (git-ignored, local test data) remains as evidence.
5. **Observed doc failure, fixed in `migrations.md`.** The PowerShell form
   `docker inspect -f '{{index .Config.Labels "com.supabase.cli.project"}}'` fails under Windows PowerShell 5.1 with
   `function "com" not defined`, because the embedded quotes are stripped. The `{{json .Config.Labels}}` form was tested in
   both shells.
   - **Proposed skill update (not made).** Avi, shall I update the AGENTS.md **Supabase CLI** override's psql-fallback
     paragraph to say "verify the label with `{{json .Config.Labels}}` (the `index … "…"` template fails in Windows
     PowerShell 5.1)"? Every future label check in PowerShell would then work the first time.
6. **The Edge container was not recreated** during any counted DB run (05:49:33Z throughout).

## Fix round 1 (review: `.superpowers/sdd/2026-10-18-task-22-retention-operations/task-22.4-review.md`)

Commit `cdeb641` fix: probe grant guards in the restore check and keep credentials out of history. The review's Minor items
are deferred to the final review and were not changed.

### I1: the resume comparison could not fail

**What was wrong.** `public.advance_boundary(published_slot, token)` returns `replayed` right after it takes the coordinator
row lock and reads the clock (`03-activities-jobs.sql:450-452`). It never reaches a phase function or a grant table. The
before/after counts therefore measured a no-op, and `duplicateGrants: 0` / `lostItems: 0` were true by construction. The
original report and runbook described this step as proving "no second grant". That was an overclaim, now corrected in both.

**What changed:**
- `scripts/restore-resume.sql`
  - **The replay** stays, labelled `"replayCheck":"structural"`. It proves that the checkpoint was restored, that the lease
    can be taken and released, and that the function runs.
  - **Three probes** follow. Each runs in its own PL/pgSQL subtransaction that is always rolled back: an accepted write
    raises this script's marker `RC001` to undo it. They target the latest settled slot at or below the published slot:

    | Probe | The write | Expected refusal |
    |---|---|---|
    | `secondSettlement` | Insert a second `private.settled_slots` row for the same (character, slot), with a fresh activity and receipt id | `primary-key`: SQLSTATE `23505` on constraint `settled_slots_pkey` |
    | `deleteSettledSlot` | Delete that settled slot | `guard`: `P0001` with `guard_frozen`'s message |
    | `deleteReceipt` | Delete the newest operation receipt | `guard`: `P0001` with `guard_receipt`'s message |

  - **What a probe reports.** An accepted write reports `accepted`, nothing to probe reports `no-row`, and any other refusal
    reports its bare SQLSTATE. No error message is ever printed.
  - **Counts.** The before counts are taken before the replay and the after counts after the probes, so the new
    `countsUnchanged` must be `true`.
- `scripts/restore-compare.mjs`
  - `PROBES` fixes the expected outcome of each probe. `compareRestore` judges every probe against `PROBES`, not against
    the expectation the SQL reports.
  - A missing probe, any other outcome, or `countsUnchanged` not `true` sets `resume.ok` to `false`, and with it the overall
    `ok` (exit 1).
  - The report shows each probe as `{expected, observed, ok}`.
- `tests/scripts/restore-invariants.test.ts`
  - The resume case now carries the probes and `countsUnchanged`.
  - A new case covers each failure mode: an accepted second settlement, a receipt delete refused by a foreign key (`23503`)
    instead of the guard, `no-row`, a missing probe, a probe that relabels its own expectation, and `probes` absent.
- The runbook (restore check step 5, "What the check proves") and the script headers now describe the replay as
  structural, and the probes as the behavioural proof.

### I2: credentials in shell history and in the SQL editor's history

- **Connection strings.** A new runbook section, "Entering a connection string", replaces the `$env:… = '<owner connection
  string>'` lines in the health and export blocks and in the export script's `.EXAMPLE`.
  - **PowerShell.** It reads the string with `Read-Host -AsSecureString`, converts it through a BSTR into the session
    variable, zero-frees the BSTR and removes both variables. That input is neither echoed nor written to PSReadLine's
    history file.
  - **Git Bash.** The equivalent is `read -rs` and `unset`.
  - **Aftercare.** Clear the clipboard after pasting. If a string ever reached a command line, delete that history line and
    rotate the password.
- **The Vault value.** Secret rotation step 4 now says: run the `vault.update_secret` statement in a new, unsaved query,
  never save it as a snippet, then delete the query and its history entry and clear the clipboard.

### Covering checks

- **RED.** I updated `tests/scripts/restore-invariants.test.ts` first and ran it against the old `compareRestore`: 2 of 16
  tests failed (`expected { ok: true, … } to match object { ok: false, … }`). After the change: 16/16.
  `npx vitest run tests/scripts` passes 28/28.
- **The real restore check with the probes.** I ran it twice on the existing backup `.backups/20261019T060545Z` (54 tables,
  2653 rows), the second time after the final header edits. Both exited 0, and the database was dropped afterwards.
  Secret-free excerpt:
  ```json
  {"ok":true,"mismatched":0,"replayCheck":"structural","status":"replayed",
   "probes":{"secondSettlement":{"expected":"primary-key","observed":"primary-key","ok":true},
     "deleteSettledSlot":{"expected":"guard","observed":"guard","ok":true},
     "deleteReceipt":{"expected":"guard","observed":"guard","ok":true}},
   "countsUnchanged":true,"duplicateGrants":0,"lostItems":0,"resumeOk":true,"database":"dropped"}
  ```
- **The mutation proof (the check can fail).**
  1. I restored with `-Keep`, captured `invariants.json` from the unmutated copy, and copied the two SQL files to
     `/tmp/cloudiator-restore-mutation` in the container (label verified).
  2. Inside `cloudiator_restore_check` only, I removed one guard at a time and reran `restore-resume.sql`.
  3. For each case I ran the real `node scripts/restore-compare.mjs compare .backups/20261019T060545Z <work dir> kept`.

  | Mutation in the restored copy | Probe outcome | `compare` |
  |---|---|---|
  | none (baseline) | all three as expected; `countsUnchanged=true` | exit 0, `ok=true`, `resume.ok=true` |
  | `drop constraint settled_slots_pkey` | `secondSettlement: accepted` | exit 1, `ok=false`, `resume.ok=false`; only `secondSettlement` false |
  | `disable trigger guard_frozen` on `private.settled_slots` (PK restored) | `deleteSettledSlot: accepted` | exit 1, `resume.ok=false`; only `deleteSettledSlot` false |
  | `disable trigger guard_receipt` on `public.operation_receipts` (guard_frozen re-enabled) | `deleteReceipt: 23503` (the ledger foreign key refused it, not the guard) | exit 1, `resume.ok=false`; only `deleteReceipt` false |

  - **The probes leave nothing behind.** `countsUnchanged` stayed `true` in every case: the accepted writes were rolled
    back.
  - **Cleanup.** Afterwards I removed the container temp directory, dropped `cloudiator_restore_check` (that exact name),
    and `pg_database` is back to `_supabase, postgres, template0, template1`.
  - **A failed first attempt.** It ran from Git Bash without `MSYS_NO_PATHCONV=1`, so MSYS rewrote the container `/tmp`
    paths and the psql output files were not written. It touched only the throwaway database, and its ALTERs were dropped
    with it. I reran with path conversion off.
- **The I2 snippet.** I ran it non-interactively in Windows PowerShell 5.1.26100, with `ConvertTo-SecureString` standing in
  for the prompt and a dummy URL:
  - the variable was set and both helper variables were removed;
  - `node scripts/health.mjs --remote` printed only `{"ok":false,"code":"connection-failed"}` for the dummy host;
  - `Remove-Item` cleared the variable.

  I did not exercise `Read-Host -AsSecureString` itself, because no terminal is attached.
- **Gates.**
  - `npm test`: 1084/1084 in 49 files.
  - `npm run typecheck`: passes.
  - `git diff --check`: clean.
  - Refusals still work: `-Database postgres` → `database-not-allowed`; `-Remote` without a URL → `remote-needs-url`.
  - No database test files changed, so `npm run test:db` was not rerun.

### Remaining limit

The probes show that the restored copy keeps its grant guards and that the primary key refuses a second settlement. They
do not drive a real settlement through `settle_activity`'s `inserted=0` path. On a fully settled world no leased settlement
job exists to drive it with.

## Final fix wave (final review: `.superpowers/sdd/2026-10-18-task-22-retention-operations/final-review.md`)

Commits: `1a1cf70` (`docs: create worker secrets after a restore and keep credentials off command lines`, F1, F2 and F4) and
`85fe838` (`fix: record the repository commit in restore manifests`, F3).

### F1 (Important 1): secrets after a restore, and the private file

Changes in `docs/operations/runbook.md`, "Secret rotation":
- **Step 4 is rotation on a live database only.** It now warns that `update_secret` with no `game_worker_secret` row updates
  nothing without an error. It adds a check that prints names and times only:
  `select name, updated_at from vault.secrets where name = 'game_worker_secret'`.
- **New paragraph "After a restore, create both Vault secrets".** `vault.secrets` is excluded from the export, so both
  secrets are created after a restore with `vault.create_secret('<worker url>', 'game_worker_url')` and
  `vault.create_secret('<worker secret>', 'game_worker_secret')`. The secret must equal the Edge function's
  `GAME_WORKER_SECRET`, and the scheduler is paused first. The same SQL-editor rules apply: a new unsaved query, never a
  snippet, the query and its history entry deleted, the clipboard cleared, the private file deleted. A names-only check must
  list both secrets. The old sentence "step 4 is also the step that re-creates the secrets after a restore" is gone. The
  `vault.secrets` exclusion bullet now points to the new paragraph.
- **Step 2.** Node now writes the private file, with the path as an argument and `{ flag: 'wx' }`. The PowerShell 5.1 `>`
  redirect is gone; the step says why (UTF-16LE that `--env-file` cannot parse).

Check: I ran step 2's exact command in Windows PowerShell 5.1 to a scratch file and printed no value. It exited 0 and wrote
63 bytes beginning `GAME_WORKER_SECRET=`: UTF-8 with no BOM (first bytes 71, 65) and a final LF. A second run on the same
path exited 1, because `wx` refuses to overwrite. I then deleted the file. `vault.create_secret` and `update_secret` were not
run (no hosted database; Task 24).

### F2 (Minor 1): no inline connection strings

`docs/operations/migrations.md` (M16 release notes) and the header comment of `scripts/health.mjs` no longer show
`CLOUDIATOR_DB_URL=… command`. Both point to the runbook's "Entering a connection string".

### F3 (Minor 2): the manifest's commit

- `scripts/restore-compare.mjs`: `git()` now runs with `cwd` set to the repository root,
  `fileURLToPath(new URL('..', import.meta.url))`.
- The manifest's `commit`/`dirty` come from a new exported `repositoryCommit()`.
- The extra blank line at the end of the file is removed; it was the gate's only `git diff --check b4b3521..HEAD` finding.

Covering test: `tests/scripts/restore-invariants.test.ts`, "records this repository's commit wherever the operator runs the
script from". It imports the module in a child node process whose working directory is a fresh temp directory, and expects
`{ commit: <git rev-parse HEAD>, dirty: <boolean> }`.
- RED: with the `cwd` removed, it failed with `expected { commit: null, dirty: null } to deeply equal { …(2) }`.
- GREEN: restored from a byte copy, 29/29.

### F4 (Minor 3): restore-check codes, resume statuses, error text and backup contents

In `docs/operations/runbook.md`:
- **Failure codes.** The list adds the comparison module's `usage`, `verify-failed` and `compare-failed`, each with an action.
- **Resume statuses.** Each status other than `replayed` now has an action:
  - `not-replayed`: read `resume.result`; `invalid` means a clock problem.
  - `no-published-slot`: seed a world locally; hosted, publish a boundary first.
  - `lease-held`: rerun after the 120 s lease.
- **Error text.** A failed restore's psql error text can echo row values (`Failing row contains (…)` for `auth.users`) and
  must not be shared.
- **Backup contents.** The export section names the `auth.users` password hashes and the `auth.mfa_factors` secrets.

### Commands and output

All were run after the gate's `DONE`:
- `npx vitest run tests/scripts`: 29/29.
- `npm test`: 1102/1102 in 50 files.
- `npm run typecheck`: passes.
- `npm run test:db`: 256/256 in 15 files (213 s). Edge `StartedAt` was `2026-10-19T06:52:03.084601932Z` both before and
  after, so the run is valid.
- `git diff --check` and `git diff --check b4b3521..HEAD`: clean.
