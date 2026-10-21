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
