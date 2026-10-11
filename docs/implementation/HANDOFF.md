# Cloudiator development handoff

Last updated: 2026-10-11. Development is in progress.

## Authority and repository

- Avi approved the [design](../superpowers/specs/2026-10-11-gladiator-arena-design.md), including proposed launch defaults, and the [24-task implementation plan](../superpowers/plans/2026-10-11-gladiator-arena-implementation.md).
- Execution method: Superpowers subagent-driven development. A fresh implementer owns each task; an independent reviewer checks specification compliance and code quality before the next task.
- Work in the current checkout on `codex/gladiator-arena`; Avi explicitly selected this instead of a worktree.
- Repository: https://github.com/Avitoohband/Cloudiator. Avi authorized committing and pushing each completed task with detailed notes so another agent can take over.
- Push reviewed task checkpoints to this feature branch. Do not force-push or merge into another branch without authorization.
- Branch starting point: `2261fb77ff38ecba5678e2f70446c593d2cdade7`.

## Resume here

Task 1 passed independent specification and quality review. Next mainline work is Task 2, versioned clock/catalog/build rules and derived stats. Claude owns the separate visual lane described below. Do not reimplement completed tasks.

Every completed task has a tracked `task-NN-report.md` with changes, interfaces, commands/results, limitations, and file-map adjustments, plus a `task-NN-review.md` containing the review verdict and any fixes. Read those before changing dependent code. The plan remains the task queue; the design binds exact behavior.

The executing controller also maintains ignored scratch artifacts under `.superpowers/sdd/2026-10-11-gladiator-arena-implementation/`. Those files are optional local process state, not the only handoff record. In a fresh checkout, reconstruct briefs from the committed plan and these reports.

## Completed tasks

| Task | Commit range | Review | Verification and limitations |
| --- | --- | --- | --- |
| 1 — Static shell and contracts | `2261fb7..096a02e` (source `9ca36d9`, report `096a02e`) | Spec compliant; quality approved; [review](task-01-review.md) | 17 unit tests; four development and four production browser checks; TypeScript, static build, and 35-asset scan passed. Fixture-only preview; authentication/backend/animations remain later tasks. |

Deferred Minor findings to carry into final review: escaped seed signatures in the supplemental static scanner, and conflicting color-variable warnings in the browser harness. Exact evidence and suggested coverage are in the Task 1 review.

## Parallel coordination with Claude

Avi explicitly authorized communication and parallel development through the [Cloudiator Message Board](https://docs.google.com/document/d/1Fz_MTVcUJkBU52wRuLQCgftMzJtTNn3l6snRQw9RSkM). Claude replied with a layer split, and Codex posted agreement and ownership refinements.

- Codex owns Tasks 1–10, 16, 18, 19, 21, and 22: root dependency/config files, `supabase/**`, `src/app/**`, `src/lib/api/**`, management features, existing domain/backend/database/browser tests, and this handoff file.
- Claude owns Tasks 11, 12, 14, and 15: `assets/source/**`, `public/assets/**`, `tests/assets/**`, `src/game/**`, `src/features/arena/BattleReplay.tsx`, and new camp/replay/expedition browser and replay/scene-layout domain tests with filenames reserved on the board. Claude may author only those task numbers' report/review files in `docs/implementation/`.
- Claude proposed `C:\Avi\Studies\Projects\Cloudiator-claude` on `claude/visual-track`. Await confirmation of actual creation and exact base SHA; the most recent local worktree inventory showed only the main checkout. Codex will post the clean reviewed/pushed Task 1 checkpoint.
- UI Tasks 13, 17, 20 and release Tasks 23–24 remain unassigned between the agents until their prerequisites land.
- Shared contract, dependency, config, or app integration changes require an exact request to the owning agent. Do not edit the other lane's files.
- Codex coordinates independent review and integration. Claude posts base/head SHAs, touched paths, actual checks, limitations, and readiness; never merges directly into the integration branch.
- If the agents share a physical checkout, serialize all Git operations and never switch/reset/stash/delete/merge concurrently. Independent branches in separate checkouts are preferred.

## Decisions and environment

- Explicit local development/test fixture mode is allowed; production static exports deny it. Task 1 verifies both cases.
- Task 1 checks TypeScript and contracts. Actual Edge entrypoints introduced in Task 4 must add Deno checking.
- Player allocations, counts, and currencies must be finite safe integers. Derived attributes and immutable item values can have two decimal places, as required by class/tier/rarity formulas.
- Task 23 builds and locally verifies release harnesses; hosted benchmarks run after Task 24 provisions infrastructure.
- Verified pins: Next 16.4.0, React/React DOM 19.3.0, TypeScript 5.9.3, Phaser 4.2.1, Vitest 5.0.3, Playwright 1.64.0, React type packages 19.3.0, Node types 22.20.5. Runtime Node 22.19.0/npm 11.8.0.
- Docker server 29.8.2 is running locally. Supabase CLI 2.120.0, client 2.117.3, and npm Deno 2.9.6 versions were verified for later installation, not yet installed.
- Supabase account is connected, but no Cloudiator project exists. Two unrelated inactive projects must not be reused or changed. Hosting, Google OAuth, real deployed flows, and measured hosted/mobile capacity remain pending.
- Default sandbox networking, Git Bash, and the native Next compiler encountered environment restrictions. Necessary approved escalations worked; these are environment issues rather than product test evidence.
- `next dev` generates `AGENTS.md`. Its local Next documentation guidance applies. Preserve Avi's standing skill-upkeep instructions as well.

## Task checkpoint protocol

1. Record the task's base commit before implementation. Pass the exact task brief, binding constraints, and relevant previous reports to a fresh implementer. Keep the Codex mainline sequential; parallel work is allowed only in Claude's explicitly reserved independent lane with agreed ownership.
2. Implement the owning task with meaningful red/green evidence. Commit exact task files and a detailed commit body; keep credentials, exports, and generated builds ignored.
3. Generate a review package for the entire base-to-head range. Obtain independent specification and quality verdicts. Fix blocking findings through the implementer and scoped review.
4. Commit the durable report/review and update this file with the task range, verdict, tests, limitations, and next task. Push the feature branch and verify the remote head before reporting it uploaded.
5. Continue all authorized tasks. Ask only for genuinely missing account choices or actions needing authorization; do not add continuation gates between tasks.

After all tasks, perform the whole-branch review and full release verification described in the plan. Do not claim a public launch based only on fixture tests or static build success.
