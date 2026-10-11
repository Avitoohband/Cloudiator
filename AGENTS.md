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
