# Task 24.2b report: the bench seed and the deployed-check minors (Lane A)

## Status

**DONE** for Task 24.2b (plan `docs/superpowers/plans/2026-10-20-task-24-launch.md`, Decision 4; the Task 24.2 review's minors
M1–M4). No migration, Edge function or SQL kit changed; no account, key or secret was used; nothing hosted was contacted.

Commits (branch `claude/task-24`, Cloudiator-claude, on `d1d3364`):
- `836b4eb` ops: add the bench seed generator
- `3bb8e87` test: harden the deployed checks
- this report: docs: report Task 24.2b

## Part 1: `scripts/bench-seed.mjs`

`node scripts/bench-seed.mjs [--count 50] [--seed bench] [--out <file>]` writes one SQL file, by default `bench-seed.sql` in the
repository root (new `.gitignore` entry `/bench-seed.sql`), and prints only its path, count, seed and SHA-256. The same options
always write the same bytes: every id is a version 8 UUID derived from the seed, and nothing depends on the time. The runbook's
new "Bench seed" section says how Avi runs it, what to paste back (one row of counts and a slot number), what each refusal
means, and that the bench is deleted afterwards.

**Owners.** Every game table that names an owner (`gladiators`, `operation_receipts`, `private.owner_signals`,
`private.command_attempts`) has a foreign key to `auth.users`, so the game's functions cannot run for a synthetic actor id
alone, and no SQL function of the Auth server creates an account. The SQL therefore inserts the two Auth rows directly, shaped
like the fixtures' real-looking accounts (`tests/fixtures/db.ts`: a Google identity whose provider id and `sub` are the
account id): an address on the reserved `.invalid` domain (`bench-001@bench.invalid`, …), an empty password, and the
token columns the Auth server reads set to empty strings. The DB test checks that each column is null, empty or set exactly as
for an account the Auth admin API makes, except the password (empty). No real Google sign-in can land on these accounts: no
Google account carries a `.invalid` address, and a Google subject is numeric, never a UUID.
- **Trade-off:** these rows bypass the Auth server. A hosted Auth schema that differs from the local one could make the
  insert fail (atomically), and the hosted owner's INSERT on `auth.users`/`auth.identities` is **untested** until the bench run.

**Characters.** Everything else goes through the game's own functions, in the Edge handler's order (`commands.ts`): the rate
check of every command (which records the owner's activity signal), creation's own rate check, `public.create_gladiator` with
the exact input `prepareCreation` gives the Edge function, then two `public.edit_schedule` commands (morning and evening to
Woodland; the afternoon already is). Each command passes `parseCommand` in the generator. The build comes with creation:
classes rotate, allocations vary with the seed, and endurance stays 2 (104 stamina), so all characters go on three
expeditions, then rest once, in step. No `queue_build` is sent: it would charge a fee and apply only at a boundary. The only
direct writes are the two Auth inserts (commented in the SQL).

**Refusal guards** (one `raise`, listing every reason with its count, before any write, under an advisory lock so two runs
cannot both pass): accounts that are not bench seed accounts; bench seed accounts (already seeded); characters; the season
epoch set; the scheduler enabled. The whole seed is one DO block, so a refusal or any failure (a refused insert, a slot boundary
passing between a creation and its edits, `processing`) saves nothing. A second run refuses.

## Part 2: the Task 24.2 review minors

- **M1:** the `operation_receipts` DELETE probe filters `owner_id` (NOT NULL, in the primary key). The private RPC probe now
  calls the STRICT `schedule_effective_slot` with null arguments; `cleanup_tick` (a zero-argument acting function) is no
  longer called. New unit tests read the migrations: every update and delete filters a NOT NULL primary-key column that is
  never relaxed (both generated styles; non-vacuous checks on a nullable and a non-key column), and every RPC probe sends null
  for each argument of a real signature, with at least one argument. Still 14 probes.
- **M2:** `maskKeys` masks `sb_publishable_…` in `consoleError`, `pageerror` and the keyed-request error messages.
- **M3:** the runbook says never to pass `--trace` or open the UI mode. The deployed config also refuses to load with either
  (`recordingFlags`), because a flag overrides `trace: 'off'`.
- **M4:** each check records one `evidence` annotation before its verdict, and `tests/browser/deployed-reporter.ts` prints
  them after the list reporter's summary as `deployed evidence | <project> | <check> | …` (masked). Deviation: one line printed
  per check from the spec failed `tests/harness.test.ts` ("no console output of the suites themselves"), so a reporter prints
  them, at the end, which also leaves the list reporter's lines intact.

## Verification

- **RED:** the bench unit file failed on the missing module; the deployed tests failed 8 (missing exports, the nullable
  filter, the zero-argument probe, the runbook rule, the `--trace` listing). **Mutations:** removing the character and epoch
  guards and making one token column null failed 3 of the 4 bench DB cases.
- **`npm test`:** 1360/1360 (1328 before: 25 bench, 7 deployed). **`npm run typecheck`:** passed.
- **`npm run test:db`:** after the Edge refresh and settle (714 entries refreshed, settled in 35 s), **310/310** (21 files), Edge
  start time unchanged across the run (`10:00:09.042Z`). The bench cases' last check confirms the local counts are as before.
- **Deployed config:** `--list` lists 12 checks; `--list --trace on` refuses to load.
- **Local stand-in** (served `out/` on a free port; outputs in the scratchpad): the evidence block printed for every check. With a
  made-up key injected into a scratch copy, `anonDenied` passed 14/14 against the local PostgREST (the new probes included), and
  the key was in no output or output file.
- `git diff --check`: clean; all files LF.

## Concerns

1. **Untested on a hosted project:** the owner's INSERT on the two Auth tables, and the hosted Auth server (and its dashboard
   list) reading these accounts.
2. **The seed cannot tell an empty production project from an empty bench.** The project-name check and Decision 4's order
   are the guard.
3. **14-day window:** owners signal once, at seeding, so after 14 days without a signal the characters rest at home (Task
   23.8). 24.9 and 24.11 must run within 14 days of seeding.
4. **Activation soon after seeding:** until `all_expedition_from_slot` (1–3 slots after seeding), the creation schedule
   applies.
5. **The bench DB test truncates `auth.users` (CASCADE) inside a rolled-back transaction.** That locks the Auth and game tables
   for about a second per case. Another lane using the local stack waits (lock timeout 15 s here). Sequences a creation
   advances are not restored, as in every DB test.
6. **First `.mjs` script that imports TypeScript** (`commands.ts`, `database.ts`) through Node's type stripping (Node ≥ 22.18;
   the project pins 22.19.0).

## Fix round 1

The controller's rulings on the review (two Important, one minor), on `590ac6e`. Commits:
- `f5b4651` fix: report the bench's first boundary and refuse unmarked databases
- `56902b9` test: always print the deployed evidence line
- this section: docs: report Task 24.2b fix round 1

**Important 1, the bench's first boundary.** Creation records the creation slot S as each character's processed slot. The
coordinator starts at `min(processed_slot_index) + 1`, and a boundary with members before the immutable epoch waits for it
forever. The seed's final SELECT now also reports `seeded_slot`, `seeded_at_utc` and `first_member_boundary`
(`scripts/bench-seed.mjs:224-227`). The runbook's "Bench seed" (`docs/operations/runbook.md:586`) says:
- the bench's epoch must be at most `first_member_boundary`, even if that slot has passed;
- "next full slot" applies to the empty production project only;
- activate soon after seeding: every boundary since S is replayed, up to 6 a tick;
- the paste-back now includes the three new columns, so the 14-day idle window can be checked.

The DB test asserts `seeded_slot` = the creation slot, `first_member_boundary` = `min(processed_slot_index) + 1` = S + 1, and
`seeded_at_utc` against `min(created_at_ms)` (`tests/db/bench-seed.test.ts:110-114`). This rule was not exercised by a
coordinator run here. It rests on the reviewer's reading of the coordinator, which the ruling adopted.

**Important 2, refuse unmarked databases.** The seed checks for a bench marker before any write, as the first refusal reason,
"this database is not marked as the bench" (`scripts/bench-seed.mjs:161`). Either marker suffices: the database comment
`cloudiator-bench` (exact match) or the schema `cloudiator_bench_marker` (`to_regnamespace`). The seed file never sets either; a
unit test pins that. The runbook adds a separate bench-only step 1 (`runbook.md:554`):
- try `comment on database postgres is 'cloudiator-bench';` first, since it creates no object;
- if the comment is refused (ownership), use `create schema cloudiator_bench_marker;`. Neither marker appears in the access
  audit or the schema fingerprint, which read `public` and `private` only.

It also adds a one-line check for production's parity step, which must print `false` (`runbook.md:594`).
`scripts/hosted-checks.sql` is unchanged. In the DB tests, the success path marks the database with the comment inside the
rolled-back transaction (COMMENT is transactional; locally `postgres` owns the database). New cases: an unmarked database and
a near-miss comment (`'cloudiator-bench '`) both refuse; the schema marker seeds 50 (`tests/db/bench-seed.test.ts:177`, `:191`).
The last case also compares the database comment and the marker schema with their state before the run.

**Minor, the evidence line.** `statusProblem` (`tests/browser/deployed-checks.ts:58`) names a status other than 200 or a
missing response. `fixedRoutesReload` (`tests/browser/deployed.spec.ts:100`) collects it, plus a page that does not render,
among its problems, and goes on to its evidence line. `securityHeaders` (`deployed.spec.ts:136`) does the same with a failed
crawl and a missing chunk. On a stand-in copy of `out/` without `game/index.html`, both lines printed: "3 of 5 routes loaded
and reloaded with 200; problems 8" and "5 paths checked against _headers; 3 problems".

**Verification.**
- RED: the unit tests failed 3 (the marker guards, the new columns, `statusProblem`) and the bench DB file failed 2 (the new
  columns, the unmarked refusal).
- Mutation: removing the marker refusal failed the unmarked case.
- `npm test`: 1363/1363. `npm run typecheck`: passed.
- `npm run test:db`, after the Edge refresh and settle: **312/312** (21 files). Edge start time unchanged
  (`10:24:52.817Z`).
- `git diff --check`: clean.

**Concerns.**
- Whether the hosted owner may comment on the database is untested; the marker schema is the documented fallback.
- The epoch rule for a seeded bench depends on Avi setting the epoch from the pasted `first_member_boundary`.
