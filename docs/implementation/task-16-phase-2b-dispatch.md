# Task 16 dispatch, phase 2b: Arena bouts, settlement, public stages and standings (controller: Claude)

Phase 2b completes Task 16. Phase 2a (`d3797e7`, reviewed) delivered the schema, the season epoch, league placement, rating rows, the published combat strength, and pairing into immutable `private.arena_assignments` with battle seeds. Arena activities currently stall truthfully after pairing. Phase 2b makes them run end to end.

## Read first (binding)

- `AGENTS.md`, every section. In particular: the Supabase CLI, generated-migration completion, Postgres concurrency, and build and browser output separation overrides.
- `docs/operations/migrations.md`, `job-leases.md` and `verification-gates.md`.
- `docs/implementation/task-16-brief-base.md` (the binding plan and spec text: §7 rewards and presentation timing, §8.1 Elo, fallback).
- `docs/implementation/task-16-phase-1-report.md`, "Phase 2 must do", items 7–12, and its review.
- `docs/implementation/task-16-phase-2a-report.md`: its **"What phase 2b must do"** list is the agreed scope, including the review's additions. Read its review (`task-16-phase-2a-review.md`) too.
- The Task 7, 9 and 10 reports and reviews: the job graph, `job_dependencies`, settlement and `safe_settlement`, `activity_stages`, projections, `timeline.completion`, revision hooks.
- The Task 17 report and review: the UI already mirrors the public Arena stage sequence, the NPC id, the shared log per pair, and the standings fixtures.

## Where and how

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-16-p2`, base `d3797e7` (pushed). Record the base in your report.
- The local Supabase stack "Cloudiator" is Claude's. Its Edge functions are served in the background from this worktree, which hot-reloads on changes.
  - **Run `npm run test:db` only while no build, browser run or file edit happens in this worktree.**
  - Record the Edge container's `StartedAt` before and after, and rerun if it changed. A recreation is an infrastructure fault, not product evidence.
  - Never print `supabase status`, keys or the contents of `.env.edge.local`.
- Never write to, run commands in, or open `C:\Avi\Studies\Projects\Cloudiator`, `C:\Avi\Studies\Projects\Cloudiator-replay` or `C:\Avi\Studies\Projects\Cloudiator-arena`.
- **Do not download any package or tool.**
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents.

## Scope (from the agreed lists; binding decisions)

1. **One simulation per battle.**
   - **Job.** Exactly one simulation job per assignment, with dedupe key `arena:<battleId>`. Anchor it to the first side's activity. It carries the battle seed and the frozen assignment.
   - **Dependencies.** For each Arena activity, `private.prepare_activity_jobs` creates that activity's own reveal and settlement jobs, which keep the activity seed. Both depend on the battle's simulation job through `private.job_dependencies`.
   - **Executor.** `private.activity_executor_ready('arena')` becomes true.
   - **Header.** Document the per-activity seed exception in the SQL header.
2. **Worker executor.**
   - **Dispatch.** `v1.simulation` dispatches on an explicit discriminator. Existing expedition jobs keep their behaviour; an unknown kind fails with `unsupported-executor`.
   - **Arena branch.** It runs one `simulateBattle` from the **assignment's frozen fighters and NPC template only**. Never rebuild fighters from stored snapshots: JSONB reorders equipment keys.
   - **Participant ids.**
     - A human participant uses its `gladiatorId`.
     - The NPC uses `npc:<entrant gladiatorId>`, with `gladiatorId: null`.
   - **Limits.** The combat batch limit stays 5. Do not add a second runner.
3. **Acceptance.** `private.accept_job_result` gains a fenced Arena branch, with post-lock time, token and status checks.
   - It validates the log against the assignment: battle id, rules version, participants and their `gladiatorId`, and the winner from `winnerId`, even at 0 HP.
   - It freezes the log once for both activities.
   - It stores both sides' outcomes, as computed by `arenaOutcomes`.
4. **Settlement, one side at a time.**
   - Each side runs through its own activity's settlement, under its own account lock in the common order. SQL cannot run TypeScript, so use a prepared input: either the stored outcomes from acceptance, or a `settle_expedition`-style prepared RPC. Record which in the report.
   - **Rating check.** Compare that side's frozen rating with its live `private.arena_ratings` row (snapshot league, `season_index(slot)`). On a mismatch, fail closed to operator state.
   - **Apply.**
     - Apply the clamped delta to that row.
     - For human bouts only, update the human win or loss counter.
     - Refresh `gladiators.rating`.
   - **Credit renown only:** 10 or 2 for human bouts, 3 or 0 for NPC bouts. `ratingDelta` is the applied change, and 0 for NPC bouts. No XP or money.
   - **Outcome shape.** The outcome passes the existing `safe_settlement` whitelist.
5. **Public stages, mirroring the Task 17 UI.**
   - **Staging:** revealed and started at S, ending at S + 60 min, label `Warming up`.
   - **Bout:** revealed at S + 60 min with the log, ending at start + `durationMs`, label `Bout: victory` or `Bout: defeat` by `winnerId`.
   - **Return:** zero length at S + 80 min, label `Results credited`.

   Both entrants of a human pair carry the same log in their own timelines; the entrant is found by `gladiatorId`. The owner summary carries renown and `ratingDelta`. Spectators get only the public `completion`. No opponent identity appears before S + 60 min.
6. **Standings.** A public, paginated read model from `arena_ratings` (rating, human wins and losses) for `GameGateway.standings(league, cursor?)`, at most 50 rows per page. Wire it through Task 10's projection and revision hooks, additively. Implement the live `standings` read in the gateway and reads layer.
7. **Fail-closed history (2a review, Minor 4).**
   - Carry the history lower bound in `PairingInput`.
   - The versioned executor asserts `historyFromSlot <= slotIndex - rules.matchmaking.recentPairingSlots`.
   - Note in the SQL header that 504 restates `RULES_V1.seasons.durationSlots`.
8. **Live UI wiring (Task 17's integration checklist).**
   - Flip `src/app/game/page.tsx` so the Arena card and the Standings panel receive the live gateway once these reads work.
   - Add a test that the live panels get a reader.
   - Keep fixture mode unchanged.

## Tests (TDD: write each first, watch it fail for the right reason)

Everything in the 2a report's 2b test list, in `tests/db/arena.test.ts` and worker or unit tests:
- **Settlement:**
  - `settleNpcWin` gives `{renown: 3, ratingDelta: 0}`;
  - human win and loss renown;
  - simultaneous settlement retries;
  - a frozen/live rating mismatch goes to operator state;
  - the second side settles after the first has moved its row;
  - both sides reveal the same log, and exactly one is credited the win;
  - the malformed-hook rollback.
- **Stages:** each appears only when due.
- **Gear history and respec** (plan item 12's cases, through real Task 8 acquisitions): sold, unequipped and renown gear history; respec and banked points; promotion only at a boundary.
- **Access denial:** for `pairing_input`, plus the new tables and functions.
- **Standings:** pagination and privacy (no wallets or loot).
- **Timing:** the 2-minute target re-measured at 50 entrants with simulation included.
- **Browser:** keep every existing suite green, including the Task 17 Arena and Standings specs in fixture mode.

## Migration

- Write the SQL source as `supabase/sql/08-arena-bouts.sql`, or extend `07-arena.sql` under a new section. Its header documents every exception.
- Generate a NEW migration with the CLI after M09. Complete the draft per AGENTS.md.
- Prove it with a clean replay, a parity check against the source, all DB suites, `db lint` and the advisors.
- Record it in `migrations.md`. M01–M09 are immutable.

## Gate before committing (in the order of `verification-gates.md`)

1. `npm test`.
2. `npm run typecheck`.
3. `npm run test:db`, with a stable Edge container.
4. `npm run build` and `npm run verify:static`.
5. The development browser suite (`pw-claude.config.mjs`).
6. The isolated production gate.
7. `git diff --check`.

## Commit and report

- Commit `feat: add league-aware Arena battles and ratings` (the plan's commit name), together with the migration.
- Then commit `docs/implementation/task-16-report.md` separately: the full Task 16 report covering phases 1, 2a and 2b, the remaining gates (Task 19 tournament history, Task 22 retention, Task 24 deployment and epoch), the timing and the open items.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns.
