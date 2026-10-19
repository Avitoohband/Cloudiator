# Task 23.1 report: access matrix and hardening (Lane A, M17)

Branch `claude/task-23` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `8e04214`. Commits:
- `9316d51` feat: lock every privilege behind a release access matrix (M17)
- `aabb810` test: name which access-matrix cases probe the audit (self-review fix)
- the commit adding this report

Status: **DONE**. One NEEDS_CONTEXT round came first: the matrix found privileges beyond the two named items. The controller
ruled on them (findings A–C revoked, D and E accepted and documented), and the work then continued from Step 3.

## What I implemented

- **`scripts/access-audit.sql`**: the exported catalog query. It is one read-only SELECT, so it works from psql, postgres.js
  and the hosted SQL editor. Each row is `section | object | grantee | privilege`, for PUBLIC (raw ACLs, with the built-in
  default when an ACL is null) and anon, authenticated and service_role (their effective privileges through `has_*_privilege`,
  so a PUBLIC grant or a role membership shows up under them too). Sections:
  - listing: `relation` (all eight privilege kinds, MAINTAIN included), `column` (column-only grants), `sequence`, `function`
    (extension members excluded via `pg_depend`), `schema`, `default`, `membership` and `policy`. `default` is the effective
    default ACL of the role that owns our objects: the global entry, or the built-in default when there is none, combined with
    the schema's entry, as PostgreSQL combines them.
  - platform (exception E, outside the matrix): `platform-default` (other roles' entries, and the owner's entries for other
    schemas) and `database`.
  - findings: `rls-disabled`, `not-security-invoker`, `materialized-view`, `security-definer` and `search-path`.
- **`tests/db/access-matrix.test.ts`**: nine cases. The eight from the brief, plus the controller's new-object case:
  1. *grants visitors SELECT on the open projections only and nothing else on any relation.* anon's whole effective set
     (outside policies, defaults and the platform sections) must be exactly SELECT on OPEN, column SELECT on the ten public
     `tournament_views` columns and USAGE on schema public. PUBLIC holds only USAGE on schema public. No client role holds
     CREATE on the database. A probe proves the audit sees MAINTAIN, REFERENCES, TRIGGER, column grants, sequences and PUBLIC.
  2. *grants authenticated users no write on any table and no execute on any function.* SELECT only, only in public. No
     sequence, function or membership; USAGE on public only. Every OPEN object is readable. Every readable table has a SELECT
     policy for authenticated or PUBLIC. No client policy has a command other than SELECT.
  3. *enables RLS on every public table and security_invoker on every view.* No finding rows. A probe proves detection in both
     schemas, including materialized views.
  4. *defines no SECURITY DEFINER function and pins search_path on every function.* No definer or search-path finding and no
     client EXECUTE. A coverage count shows that backend plus owner-only functions equal every non-extension function. A probe
     proves the audit reports a definer function, an unpinned path, an unset path, and EXECUTE for anon, authenticated and
     PUBLIC.
  5. *leaves no default privileges to anon or authenticated.* No client `default` row. A probe proves per-schema and global
     default grants are reported.
  6. *gives anon and authenticated nothing on a new table, sequence or function the owner creates* (the controller's added
     case). postgres creates one of each in public and private, in a rolled-back transaction. service_role's defaults reaching
     them proves the audit saw them, and no client role holds anything on them or their columns.
  7. *matches the pinned service_role privilege set.* 157 lines, one per object. Drift fails with `{ added, removed }`, and the
     literal must stay sorted. Exception D is documented in its comment.
  8. *denies direct writes and private RPCs through the Data API as owner, other account and visitor.*
     - Every public relation gets an insert, and an update and delete whose filter matches no row. Each must fail with 42501,
       or with 55000 where `pg_relation_is_updatable` shows the view cannot take that command at all.
     - Every public RPC is called with null arguments and must fail with 42501.
     - Four real writes aimed at the owner's own rows (money, an item, receipts, a forged creation) must fail with 42501.
     - Every private table and function must answer PGRST106 (labelled "exposure").
     - Every public and private base table must hash the same before and after.
  9. *keeps seeds, plans and snapshots unreadable even by their owner.*
     - It plants a unique marker in five places: an activity snapshot and its seed, an expedition plan, a job's input and seed,
       an Arena assignment's seed and a build preparation snapshot.
     - The owner then reads every relation the catalog lets authenticated read, page by page, with column-granted relations
       read by their granted columns. The marker never appears, while the owner's gladiator and activity ids do.
     - Each private table answers PGRST106 to the owner, and no client role can SELECT any private relation.
  - Each probe runs `auditAfter` on a connection of its own in a transaction that always rolls back. The connection is then
    closed (see Concerns 1).
- **`tests/fixtures/access.ts`**: the OPEN list and the public tournament columns, moved verbatim out of
  `tests/db/visitor-access.test.ts` and shared by both files. Importing them from another test file would have re-registered
  its tests.
- **`tests/db/visitor-access.test.ts`**: `anonWritable` now also counts REFERENCES (any column), TRIGGER and MAINTAIN.
- **`supabase/sql/15-release.sql`** and **M17 `supabase/migrations/20261019075634_release.sql`**: the revocations below.
- **Docs**:
  - `docs/operations/migrations.md` has a new M17 section at the top (format of M16) and a pointer in M13's "Observed, not
    changed here".
  - `docs/operations/runbook.md` has a new "Release access audit" section: the local reference, the hosted SQL editor run, the
    comparison, the expected platform rows and what blocks the release. There was no release section before; this creates it.

## Every privilege the matrix found (M01–M16 replay) and what M17 does

Client roles, beyond the expected SELECT on OPEN and USAGE on public:

| # | Finding | Rows | M17 |
|---|---|---|---|
| 1 (named, C1) | anon MAINTAIN on `builds`, `gladiators`, `item_instances`, `operation_receipts`, `reservations`, `schedules`, `wallet_ledger`, `wallets` | 8 | revoked (`revoke all … from anon`, owner_state included) |
| 2 (named) | default `postgres:public:sequences` UPDATE for anon and authenticated (M01 :800-801) | 2 | revoked |
| A (ruling i) | authenticated MAINTAIN on the same 8 tables | 8 | revoked |
| B (ruling i) | authenticated MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on `owner_state` | 4 | revoked |
| C (ruling i) | default `postgres:public:tables` TRUNCATE, REFERENCES, TRIGGER, MAINTAIN for anon and authenticated | 8 | revoked |

The audit diff between the M16 replay and the source-applied database is exactly those 30 rows. The M17 statements name every
non-SELECT kind for authenticated and use `revoke all` for anon, so they are idempotent and would also clear fuller platform
defaults on a hosted project. Two statements change nothing locally and are recorded as hardening: the anon revoke on
`owner_state` (M13 already did it) and the default-function revoke (no client grant there). Nothing else was revoked.

Accepted and documented (ruling ii, iii):
- **D (backend, pinned in the snapshot):** service_role MAINTAIN on the 8 tables; MAINTAIN, REFERENCES, TRIGGER and TRUNCATE
  on `owner_state`; the default UPDATE on public sequences and TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on public tables.
- **E (platform, audit sections `platform-default` and `database`):**
  - supabase_admin's defaults in `public`, `graphql`, `graphql_public` and `supabase_functions`: anon, authenticated and
    service_role get every table privilege; SELECT, UPDATE and USAGE on sequences; EXECUTE on functions;
  - postgres's platform-provided defaults in `storage` (the same grants). I found these while inspecting the replay, and they
    are listed in E;
  - PUBLIC USAGE on schema public;
  - PUBLIC CONNECT and TEMPORARY on the database.
  - postgres is not a superuser and not a member of supabase_admin (checked). None of our objects is created by supabase_admin
    or in those schemas.

Also checked, and clean, on M16 already:
- no SECURITY DEFINER function;
- all 101 functions pin `search_path=""` (none is an extension member);
- no client EXECUTE;
- RLS on all 53 tables and `security_invoker` on all 6 views;
- client policies are SELECT only;
- no role membership for the three API roles;
- no materialized view, foreign table or user-defined type in public or private;
- no publication covering our tables.

## M17: generation and completion

- Reset to M01–M16 (`db reset --local --no-seed --yes`). The fingerprint (Task 22.3's `fingerprint.sql`, 1127 lines) matched
  Task 22.3's recorded M16 replay byte for byte.
- Applied the source once with the psql fallback, after the container label check (`Cloudiator`). The source fingerprint
  differs only in the 9 relation ACLs and 2 default rows. Lint on the source was empty.
- `npx supabase db pull release --local --schema public,private --yes` (CLI 2.120.0, migra) exited 1:
  `DbPullInSyncError: No schema changes found`. No file was written and no history recorded. Its diff saw none of this
  source's changes: MAINTAIN, the owner view's privileges and default privileges.
- I therefore created the file with `npx supabase migration new release`, which supplies the timestamp `20261019075634`, and
  completed it from the source:
  - every statement verbatim, except `begin`/`commit` (the CLI supplies the transaction); a scripted diff of the statement
    lines is identical;
  - a provenance header;
  - `notify pgrst`.
- No function, trigger, policy, table, backfill or initialization change, so no re-emitted functions to compare.
- `pg-delta` (`--diff-engine`) was not tried: the established engine is migra, and I could not rule out a download.

## Tests, RED/GREEN, and the Edge start time

Every `npm run test:db` ran with nothing else building, browsing or editing in this worktree. The Edge container serves
`C:\Avi\Studies\Projects\Cloudiator-claude\supabase\functions` (mount checked). Times are
`docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator`.

| Run | Command | Result | Edge before | Edge after |
|---|---|---|---|---|
| RED 1 | `npm run test:db -- tests/db/access-matrix.test.ts tests/db/visitor-access.test.ts` (M16 state) | 5 failed, 8 passed. Four privilege failures, plus one test-design failure: views that cannot take a command answer 55000 before the privilege check. Fixed with `pg_relation_is_updatable`. | 2026-10-19T07:35:42.495553145Z | 2026-10-19T07:35:42.495553145Z |
| RED 2 | same | **4 failed, 9 passed**: anon MAINTAIN on 8 tables (case 1); authenticated MAINTAIN and owner_state extras (case 2); 10 client default rows (case 5); `anonWritable` = the 8 tables (visitor) | 2026-10-19T07:35:42.495553145Z | 2026-10-19T07:35:42.495553145Z |
| GREEN 1 | same, source applied | **14/14** (9 matrix + 5 visitor) | 2026-10-19T07:35:42.495553145Z | 2026-10-19T07:35:42.495553145Z |
| full, source 1 | `npm run test:db` | 264/265, see Concerns 1 | 2026-10-19T07:40:18.932567314Z | 2026-10-19T07:40:18.932567314Z |
| full, source 2 | `npm run test:db` | **265/265**, 16 files (314.2 s) | 2026-10-19T07:40:18.932567314Z | 2026-10-19T07:40:18.932567314Z |
| full, replay 1 | `npm run test:db` on M01–M17 | **265/265** (299.5 s) | 2026-10-19T07:40:18.932567314Z | 2026-10-19T07:40:18.932567314Z |
| GREEN 2 | matrix + visitor, after adding the platform sections | **14/14** | 2026-10-19T07:40:18.932567314Z | 2026-10-19T07:40:18.932567314Z |
| full, replay 2 | `npm run test:db` | 265/265 but **discarded**: Edge recreated during the run | 2026-10-19T08:07:26.927669759Z | 2026-10-19T08:10:56.808741083Z |
| full, replay 3 | `npm run test:db` (final test code) | **265/265** (219.9 s) | 2026-10-19T08:10:56.808741083Z | 2026-10-19T08:10:56.808741083Z |
| GREEN 3 | matrix + visitor, after the self-review wording fix | **14/14** | 2026-10-19T08:10:56.808741083Z | 2026-10-19T08:10:56.808741083Z |

**RED evidence for the added new-object case.** It was added after RED. The equivalent check ran in a transaction that rolled
back:
- with M16's default rows restored, a new public table and its identity sequence gave anon and authenticated MAINTAIN,
  TRUNCATE and sequence UPDATE (`t|t|t`);
- on the M17 replay they gave nothing (`f|f|f`);
- the default rows were unchanged afterwards.

The probes inside cases 1, 3, 4, 5 and 6 are the sensitivity checks; all passed.

**Other gates:**
- `npm test`: 1102/1102 in 50 files (twice).
- `npm run typecheck`: tsc, `deno check --frozen`, and the Deno smoke test 2/2 (twice). One `npx tsc` invocation segfaulted
  inside npx before running and passed on retry.
- `git diff --check` was clean.

**Edge recreations outside counted runs:**
- 07:35:42Z, while I edited test files;
- 07:40:18Z and 08:07:26Z, during `npm test` / `npm run typecheck`;
- 08:10:56Z, during the discarded run.

No file under `supabase/functions` changed. This matches the unconfirmed pattern in `verification-gates.md`.

## Replay, parity, lint and advisors

- A clean `db reset --local --no-seed --yes` replayed M01–M17 (17 migrations), with no source applied afterwards. Edge was
  unchanged by both resets.
- **Parity fingerprint** (1127 lines, M16 coverage):
  - replay is byte-identical to the source-applied database;
  - identical again after the full replay runs (replay 1 and replay 3).
  - The audit output was identical on source and replay. That was before the platform sections were added; afterwards the
    non-platform rows were re-checked as unchanged.
- **Inspection of the replay:**
  - the 8 tables: `authenticated=r`, `service_role=arwdm`;
  - `owner_state`: `authenticated=r`, `service_role=rDxtm`;
  - postgres's public defaults: tables `{postgres=arwdDxtm, service_role=Dxtm}`, sequences `{postgres=rwU, service_role=w}`,
    functions `{postgres=X}`;
  - all 43 public/private triggers enabled;
  - both cron jobs active;
  - after the runs: scheduler off, no Vault worker secret, no `matrix_probe` object, no amcheck extension.
- **Lint** (`db lint --local --schema public,private --fail-on warning`): `{"results":[]}` on the source and on the replay.
- **Advisors** (`db advisors --local --type all --level info --fail-on warn`): 4 INFO `unused_index` notices
  (`boundary_members_gladiator_idx`, `jobs_gladiator_idx`, `market_listings_buyer_idx`, `market_listings_receipt_idx`), no
  WARN, no ERROR.
- `migration list --local`: M01–M17, local equal to remote.
- The runbook's PowerShell audit command was run as written: label `Cloudiator`, a 609-line CSV.

## Self-review

- **Fixed (`aabb810`).** The test header and `migrations.md` said "each catalog case" probes the audit; cases 2 and 7 do not.
  Both now name the cases that do.
- **Hardened during the work:**
  - Case 8 got four real owner-targeted writes beside the no-row sweep.
  - The audit names functions as `schema.name(types)` (`oidvectortypes`) instead of `regprocedure`, whose text depends on the
    session's search_path.
  - The audit got the platform sections, so Task 24 can compare E.
- **Checked against the brief and rulings:**
  - every brief test name exists;
  - the RED run failed on MAINTAIN and on the default ACL, as Step 2 expected;
  - the matrix shows no client privilege beyond SELECT and USAGE on public;
  - D is pinned and commented, E is listed in the source, migrations.md and runbook;
  - the new-object test exists;
  - M01–M16 are untouched (`git show --stat`).
- **Secrets.** No key, JWT, password, `.env*` content or status output was printed. DB logs were read only with filters that
  drop credential-looking lines.

## Concerns

1. **A transient PostgreSQL error in the first full source run (observed, not explained).**
   - `truncate public.gladiators cascade` in `resetIdentity` (`beforeEach` of the RLS case) failed with
     `MultiXactId 129660 has not been created yet -- apparent wraparound`.
   - The DB log shows it ran on backend 35780. Just before, that backend had run case 1's rolled-back probe (create table and
     sequence, grants).
   - The value cannot be a real multixact: the next multixact was about 28,300 while the current xid was about 130,000, so a
     plain xid was read as one.
   - Every later TRUNCATE succeeded; three later full runs (source 2, replay 1, replay 3) passed with no repeat in the log.
   - `amcheck`'s `verify_heapam` found no problem in `pg_class`, `pg_attribute`, `pg_type`, `pg_depend`, `pg_default_acl`,
     `pg_constraint` or any public/private table. It ran with the extension created inside a transaction that rolled back;
     none is left installed.
   - A one-session reproduction of the probe followed by TRUNCATE did not fail.
   - **Untested precaution:** `auditAfter` now uses its own connection and closes it, so no later statement shares a backend
     with rolled-back DDL. This is a mitigation, not a verified fix. If it recurs (PostgreSQL 17.11 image), it needs a
     PostgreSQL-level investigation.
2. **Edge recreation** discarded one full run again (replay 2). Cause still unconfirmed.
3. **Hosted comparison untested.**
   - The runbook's hosted step (SQL editor CSV export, then `Compare-Object`) has not been tried; the CSV quoting may differ.
   - The audit and M17 need PostgreSQL 17 (MAINTAIN); Task 24 must confirm the hosted major version.
4. **M17 had no generated draft.** The completion rule is met trivially (all statements are the source's). The empty diff is
   the CLI 2.120.0 migra behaviour for privilege-only changes. pg-delta was not evaluated.
5. **Proposed skill update (not made; for Avi through the controller):** "Avi, shall I update the Supabase skill override in
   AGENTS.md (Generated migration completion) as follows?
   - When `db pull` reports 'No schema changes found' for a privilege-only source, create the file with
     `migration new <name>` and complete it verbatim from the source, then replay and fingerprint as usual.
   - Run `scripts/access-audit.sql` (`tests/db/access-matrix.test.ts`) after every migration."
   - **Observed:** migra's empty diff for MAINTAIN, view privileges and default privileges.
   - **Tested here:** the `migration new` completion, whose replay matched the source fingerprint.
   - **Untested as a general rule:** whether other privilege-only changes behave the same.
