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
grants/revocations, RLS and invoker-view settings, function/trigger dependency
order, required data backfills, and initialization statements. Complete
omissions in that draft. If the generator re-emits unchanged functions, confirm their bodies match the previous migration. Then clean-reset/replay the migrations alone and inspect the replayed database: function bodies/search_path, role ACLs, policies, triggers and invoker-view settings. Run
the owning and affected access-denial tests, lint and advisors. Reapplying
source after reset is not migration-artifact proof. Never edit an already
committed migration; generate a new one for subsequent corrections. Follow
the exact local workflow and evidence in [the migration guide](docs/operations/migrations.md).
