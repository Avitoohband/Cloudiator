<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Skill upkeep — Avi, all current and future skills

Avi's standing instruction, 2026-09-25. Applies to every skill used with Avi:
existing or future, project-specific or general, local or vendor-provided, and
across Codex, Claude, Cursor and other agents.

## When to propose an update

When Avi's feedback, a correction, a changed tool/workflow, a lesson from use,
or a concrete general improvement should change a skill's reusable guidance,
ask Avi in the same response. Name the relevant skill, section and precise
change, for example:

> Avi, shall I update [skill] — [section] — to [specific improvement]?

Group related updates to multiple skills into one question. Explain the
practical improvement briefly. Do not ask again when the skill already says
the right thing or nothing reusable needs changing.

## Existing authorization and scope

If Avi has already explicitly requested or approved that skill update, make
it and report the result without asking again. This standing rule itself is
authorized; it is not advance approval for all future substantive changes.

Continue already-authorized work while a proposed skill update awaits Avi.
Do not create an extra approval gate for routine task work, or use upkeep
permission as permission for paid generation, publication or unrelated actions.

A one-off exception belongs in the task record unless Avi wants it generalized.
Keep a proposed improvement, observed failure and tested fix distinct; do not
claim an untested mitigation is verified.

## After approval

Update the relevant SKILL.md and affected supporting guides, scripts or
templates; reconcile necessary mirrored rules or bibles. Validate the changed
material appropriately and follow the repository's commit/push policy.
Do not leave an approved durable change only in chat.

## Existing, vendor and future skills

Every newly authored skill must include a Skill upkeep section containing
this behavior or a durable link to this policy. Check for it before delivery.
When adopting or installing a third-party skill, keep this policy in the
agent/project instructions or a persistent local override. Do not rely on
editing generated package caches that an update may replace.

Repository-maintained vendor copies may include a clearly labeled local
upkeep section; preserve their unrelated execution instructions and provenance.
Use the same rule when a skill is renamed, replaced or moved.

The maintained source is indigo-channel-ops/.agents/SKILL-UPKEEP.md, currently:
C:\Users\Avi_OP_PC\Documents\Youtube Channel Videos\.agents\SKILL-UPKEEP.md.
User-level Codex and Claude instructions mirror this policy so it applies
outside this repository too; keep those copies consistent when it changes.

# Supabase CLI — persistent project override

Avi approved this local override on 2026-10-12 for the `supabase:supabase`
skill's **Supabase CLI** and **Making and Committing Schema Changes** sections.
Keep vendor skill caches unchanged; this project instruction survives package
updates and supplements their existing CLI discovery and migration workflow.

Observed with Supabase CLI **2.120.0**: `db query --local --file` rejects the
multi-statement identity SQL source with `cannot insert multiple commands into
a prepared statement`. Single-statement queries work. Check the installed
version and current `--help` before treating this as a continuing limitation.

For a multi-statement source, use the tested local-container `psql` fallback
documented in [the migration guide](docs/operations/migrations.md). Confirm
the named container belongs to the intended local test stack, pipe the source
to `docker exec -i ... psql -v ON_ERROR_STOP=1`, and check the exit status.
Never apply this fallback to an unrelated or hosted database. It iterates SQL
without adding migration history; CLI migration generation, inspection,
advisors and clean reset/replay remain separate required checks.

Keep status output, gateway configuration and credential-bearing files out of
diagnostic output. Record commands and sanitized results, never key values.

Avi approved on 2026-10-27 (Task 24.10 lesson): pass `--agent no` to any
`db query --output-format json` whose output a script parses. Observed with CLI
2.120.0: the CLI detects an agent session and then wraps the rows in an object
(`boundary`, `rows`, `warning`). In Avi's own PowerShell window it prints the
plain JSON array of rows. A script written against the agent-session shape
stopped there with an `ArgumentException`. Tested fix: the script passed
`--agent no` and parsed the plain array, and its read-only self-test then
passed in a normal window. `scripts/set-worker-secret.mjs` matches its count
with a pattern that reads both shapes, so it needs no change. The rule as a
general practice is adopted, not separately tested.

## Windows Docker startup — approved local guidance

Avi approved this extension on 2026-10-14 for **Supabase CLI**. Before retrying
local Supabase startup, distinguish a stopped daemon from a failed Docker
Desktop startup. Inspect the bounded diagnostic fields in Docker's
`backend.error.json`; never print raw settings, credentials or status output.

Observed on Docker Desktop4.94.0: Windows error1920 while renaming an orphaned
`docker-secrets-engine/engine.sock` prevented startup. After the documented
Docker force-stop confirmed no Desktop/backend processes, metadata proved its
parent contained only one zero-byte AF_UNIX reparse-point socket. Preserving
that exact directory under a fresh sibling backup name and launching Desktop
hidden restored Engine29.8.2. The backup remains intact; no database volume,
VM disk, settings or credentials were deleted or reset.

Use this recovery only for the matching diagnostic and verified socket-only
directory. Verify resolved paths and stopped processes before renaming; never
overwrite a backup, follow a socket/reparse target or broaden to AppData/VM
directories. Confirm daemon availability, then verify the intended local
Cloudiator stack before resuming tests. An unknown error or directory contents
requires further diagnosis. See [local runtime recovery](docs/operations/local-runtime.md)
for the exact guards, observed evidence and limits; vendor caches are unchanged.

## Generated migration completion — approved local guidance

Avi approved this extension on 2026-10-12 for **Making and Committing Schema
Changes**. With CLI **2.120.0** and its `migra` diff, Task 6 generation omitted
function/table ACLs and existing-character data backfills, and placed triggers
before their private functions. The first clean replay exposed inherited
client mutation privileges; completing the uncommitted draft from the tested
source made all 26 database/Auth/Edge tests pass. Task 7 also observed omitted
function ACLs and initialization/scheduler statements. These are recorded
version-specific observations, not a claim that every generated diff omits
the same statements.

Before committing a generated draft, compare it with the tested source for
grants/revocations, RLS and invoker-view settings, function/trigger/constraint
dependency order (each trigger and CHECK constraint after the functions it
calls), required data backfills, and initialization statements. Complete
omissions in that draft. If the generator re-emits unchanged functions, confirm their bodies match the previous migration. Then clean-reset/replay the migrations alone and inspect the replayed database: function bodies/search_path, role ACLs, policies, triggers and invoker-view settings. Run
the owning and affected access-denial tests, lint and advisors. Reapplying
source after reset is not migration-artifact proof. Never edit an already
committed migration; generate a new one for subsequent corrections. Follow
the exact local workflow and evidence in [the migration guide](docs/operations/migrations.md).
Avi approved on 2026-10-20 (Task 23.1 lesson): when `db pull` or `db diff` reports no change for a
privilege-only source change (grants and revokes), create the file with `supabase migration new` and
complete it verbatim from the tested source; after every migration, run the access audit
(`scripts/access-audit.sql` and `tests/db/access-matrix.test.ts`). The `migration new` completion was
tested in Task 23.1; the rule as a general practice is adopted, not separately tested.
Avi approved one more rule on 2026-10-14: restore any test-only function
stand-in from the `pg_get_functiondef` text captured before it was installed,
never by replaying a migration or source statement through a shell tool that
may rewrite line endings, and verify byte equality afterwards; otherwise the
next generated draft can re-emit an unchanged function.
Avi approved on 2026-10-27 (M24 lesson): check that every CHECK constraint
comes after the functions it calls. Observed with CLI 2.120.0: the generated M24
draft added `gladiators_appearance_check` before creating
`private.valid_appearance`, and on an M23-shaped schema it stopped with
`function private.valid_appearance(jsonb) does not exist` (`check_function_bodies
= off` does not cover a CHECK). Tested fix for M24: the function statement moved,
unchanged, before the column, and `tests/db/appearance.test.ts` pins the order;
see the M24 record in [the migration guide](docs/operations/migrations.md). The
rule as a general practice is adopted, not separately tested.
Avi approved on 2026-10-29 (M25 lesson): before committing a generated
migration, compare the replayed database's schema fingerprint
(`scripts/schema-fingerprint.sql`, which includes every constraint definition)
with the fingerprint of the tested source applied on the previous migrations;
they must be byte-equal. Observed with CLI 2.120.0: the generated M25 draft
emitted the source's `between … and …` inside an AND as deparsed text that
re-parses as one flat AND, a different stored (though equivalent) CHECK
expression, and the fingerprints differed by two lines. Tested fix for M25:
restate the source's CHECK expression in the draft; the replay then matched the
source byte for byte (1,210 lines); see the M25 record in
[the migration guide](docs/operations/migrations.md). The rule as a general
practice is adopted, not separately tested.

# Postgres concurrency — persistent project override

Avi approved this supplement on 2026-10-13 for the
`supabase:supabase-postgres-best-practices` skill's **Concurrency & Locking**
category. Keep vendor caches unchanged; this project instruction survives
plugin updates and supplements the short-transaction/queue guidance.

For a time-limited mutation, acquire the established guard locks first, then
sample current database time with `clock_timestamp()` (or a verified helper
that uses it). Revalidate the current lease token, status and expiry under the
lock before accepting new work. A timestamp captured before a lock wait,
`now()` or `statement_timestamp()` is not a fresh post-wait expiry check.
Keep immutable committed receipt replay separate from authorizing a new write.
Return the authoritative renewed expiry to the worker and use that response.

Add a regression that holds the row lock, starts the contender while its lease
is valid, lets expiry pass before releasing the lock, and proves completion
and renewal cannot use pre-wait time. Distinguish the observed defect from
newly tested fixes and migration-only replay evidence. See
[the lease guide](docs/operations/job-leases.md) for the exact scope and
verification checklist. Task 9's final verification was still pending when
this approved guidance was added; do not treat this note as a passed test.

# Build and browser output separation — persistent project override

Avi approved this override on 2026-10-14 for the Superpowers
`verification-before-completion` skill's **The Gate Function**. Keep vendor
caches unchanged; this project instruction survives plugin updates and
supplements the skill's run-the-full-command-before-claiming rule.

A Next.js build or export and a browser check must never share an output
directory at the same time. Either give them separate, non-overlapping output
directories, or run them one after the other in the same worktree. The
Playwright dev server and the isolated production build both use
`.next/browser-test` (`CLOUDIATOR_BROWSER_TEST=true` in `next.config.ts`), so
a build started while a development browser run is active deletes the dev
server's `.next/browser-test/dev` output underneath it.

Observed 2026-10-14 (Codex, Task 15 integration): a build during a browser
run removed `.next/browser-test/dev` and caused 12 infrastructure failures.
A serialized 22-case rerun then passed, and the root build-then-browser
production gate passed 8 cases. Infrastructure failures caused by overlapping
output are not product evidence: rerun serialized before reporting.

Follow the exact gate order in
[the verification gate guide](docs/operations/verification-gates.md). Avi
approved its database-test rule on 2026-10-14: run `npm run test:db` only
while nothing else builds, browses or edits in the worktree that serves Edge,
compare the Edge container's start time before and after, and discard and
rerun a run during which it was recreated. Avi extended it on 2026-10-19:
first refresh the last-access times of the Edge source and wait for a settled
runtime (`npm run verify` does this), because the host's NTFS last-access
updates otherwise make the Edge watcher recreate the container mid-run. Never
change the host's last-access setting. Separate
worktrees each have their own `.next` and may run in parallel on their own
Playwright ports.

# React effects/state (async data) — persistent project override

Avi approved this correctness supplement to `vercel:react-best-practices` on
2026-10-26. Keep vendor caches unchanged.

Scope reload-preservation flags to the record version that set them. Add a
regression where a background update arrives before the conflict response.

Observed 2026-10-26: an unscoped flag survived a same-version reload and kept a
stale conflict alert on the next background version. Tested fix `6dc5047` scopes
the guard to the command's expected version; the ordered
[planning regression](tests/browser/planning.spec.ts) failed before the fix and
passed afterward on desktop and mobile.
