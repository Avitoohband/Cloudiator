# Task 19 dispatch, phase 2b: tournament results, reveals, settlement, public view, and the Task 16 lock fix (controller: Claude)

Phase 2b completes Task 19. Phase 2a (`81dc36b` with M11, report `f9e3d97`, review fixes `a9f25d3`) is reviewed: specification and quality Pass.
- **What 2a delivered:** the opt-in command, the partition inside Task 16's pairing job, bracket acceptance, the one-way bracket and per-bout seeds, and bout jobs with parent dependencies.
- **What is still missing:** bout jobs can be claimed, but nothing accepts their results yet.
- **Release rule:** 2a and 2b are pushed and deployed together, never 2a alone.

## Read first (binding)

- `AGENTS.md`, every section, including the database-test rule.
- `docs/operations/migrations.md`, `job-leases.md`, `verification-gates.md`.
- `docs/implementation/task-19-brief-base.md` (binding spec §8.2: reveal round r of R at 80 × r / (R + 1) minutes, settlement at minute 80, placement bonuses, byes grant no wins).
- `docs/implementation/task-19-phase-1-report.md`: "Phase 2 must do" items 8–12, "Public projection (phase 2 guidance)", the decisions, and its review.
- `docs/implementation/task-19-phase-2a-report.md`: its list of what 2b must do.
- **The 2a review findings below.**
- `docs/implementation/task-16-report.md`, `task-16-review.md`, `task-16-phase-2a-report.md`: Arena acceptance, settlement one side at a time, stages, standings. Reuse them.
- The Task 7, 9, 10 and 20 reports and reviews. Task 20's `TournamentPanel` and camp roles consume what you build.

## Where and how

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19-p2`, base `a9f25d3`. Record the base in your report.
- The local Supabase stack "Cloudiator" is Claude's, and its Edge runtime is served in the background from this worktree.
- **Database-test rule:** run `npm run test:db` only while nothing else builds, browses or edits in this worktree. Compare `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after, and discard and rerun on a change.
- Never print `supabase status`, keys or `.env.edge.local`.
- Never write to, run commands in, or open:
  - `C:\Avi\Studies\Projects\Cloudiator`;
  - `C:\Avi\Studies\Projects\Cloudiator-replay`;
  - `C:\Avi\Studies\Projects\Cloudiator-arena` (a preview dev server runs there on port 3400; leave it alone).
- **Do not download any package or tool.**
- When you need a test-only function stand-in, restore it from the `pg_get_functiondef` text captured before installing it. Never restore it through a shell tool that may rewrite line endings. Verify byte equality afterwards.
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents.

## Scope

1. **Result fence (item 8).** Add a tournament branch of `private.accept_job_result`, reached from `complete_job`, with post-lock time, token and status checks.
   - Validate each bout log against the frozen entries: battle id, participants, `gladiatorId`, the names frozen in 2a, and the winner from `winnerId` (even at 0 HP).
   - The executor runs `recordBout` before `complete_job`.
   - Store each result once, immutably.
   - Children read parent winners under the fence.
2. **Reveals and stages (item 9).**
   - Reveal round r at its stored reveal time.
   - Each entrant's timeline gets public stages: tournament staging, each fought bout with its log when due, and a zero-length return when credited.
   - **Reveal-job dependencies must be added from both sides**, the same way settlement's are, or created in rank 1's call. Entrants prepared before rank 1 cannot depend on bout jobs that do not exist yet (2a review M5a).
   - Decide the later-round reveal shape for eliminated and bye-path entrants, which is open from the phase 1 review, and record it.
3. **Settlement (item 10).** Each entrant activity settles once at minute 80, one side at a time under its own account lock, through the Task 16 path (stored outcomes, frozen-versus-live rating check, applied deltas).
   - Fight renown: 10 per win, 2 per loss, 0 for byes.
   - Placement bonuses travel inside that activity's single settlement outcome; there is no second grant guard. Winner: 100 money and 50 renown. Runner-up: 60 and 30. Semifinal losers: 30 and 15. Others: 5 renown.
   - Elo is applied in round order from updated ratings, and only for human bouts.
   - **Settlement depends on the final's bout job only**, not on every bout (2a review M2: n² dependency rows). That is equivalent gating, because every fought bout is an ancestor of the final.
4. **Public view and contracts (item 11).** Claude owns the contracts now. The smallest additive shape:
   - **Seeded first round.** `TournamentView` gains `bracket: { size: number; rounds: number; slots: (GladiatorId | null)[] }`. `slots` is the seeded round-one order, one entry per position, with `null` for a bye. It is public at start, with no results.
   - **Role-safe placements.** `placements` become `{ gladiatorId; place; completion: PublicActivitySummary }[]`, using Task 10's six safe fields. Public placements never carry rewards or receipts.
   - **Owner rewards** come only from the owner's own timeline `summary`, under RLS.
   - **Placements are empty until settlement.**
   - **Insufficient entrants.** A league below the minimum gets a public `insufficient-entrants` status row for the slot (2a review M5b).
   - Implement the live `tournament(id)` read and the lookup id `tournament:<slot>:<league>` in the reads layer and the gateway.
   - Update Task 20's `TournamentPanel`, camp roles and fixtures to the new shape: the viewer's own rewards come from the owner timeline. Keep its browser suite green.
   - Update the fixture gateway accordingly.
5. **Task 16 deadlock fix (2a review I1, Important, pre-existing).** In phase 8, the Arena branch inserts `arena:<battleId>` anchored to side 0. Its foreign keys take KEY SHARE on side 0's gladiator and activity rows before the boundary holds side 0's account lock. An owner command that holds that account lock and then asks for `FOR UPDATE` deadlocks with it, and PostgreSQL aborts one side.
   - **Minimal fix:** in `private.boundary_start`, after the `integration` check, take every preparing member's account advisory lock in gladiator order before the debit loop. The order is unchanged; only the timing moves.
   - Correct `08-arena-bouts.sql` exception 3 and the header of the new source file.
   - **Regression test in `tests/db/arena.test.ts`:**
     1. Pair two entrants so that the higher-id one is side 0.
     2. Session B holds side 0's owner advisory lock.
     3. Session A calls `advance_boundary`; wait until `pg_blocking_pids(A)` shows B.
     4. B runs `set local lock_timeout='3s'` and then `select … for update` on side 0's gladiator row.
     5. Expected: B succeeds, B commits, and A completes with no 40P01.

     The test must fail before the fix with 40P01.
6. **2a header (M3).** Header exception 9 must also cover the entry foreign keys' KEY SHARE on entrants' gladiator rows during `complete_job`, and state why no cycle exists.

## Tests (TDD: write each first, watch it fail for the right reason)

Item 12's remaining cases, in `tests/db/tournaments.test.ts`:
- **Bracket runs:** 0, 1, 2, 3, 5 and 50 entrants end to end (one stamina charge each, full HP every bout, round-ordered ratings).
- **Bouts:** byes grant no win, renown or rating; placement counts and amounts; a two-person bracket gives only winner and runner-up.
- **Reveals:** each reveal only when due, with stored reveal times.
- **Failures:** a stalled child job; lease retry; the malformed-result rollback; forged results refused with nothing written.
- **Settlement:**
  - the second and later entrants settle after earlier ones moved their own rating rows;
  - each entrant compares only its own frozen rating;
  - a mismatch goes to operator state.
- **Public view:**
  - spectators never see rewards or receipts;
  - placements stay empty until settlement;
  - `bracket.slots` is public at start with no results;
  - the `insufficient-entrants` status;
  - access denial for every new object.
- **Timing:** a 50-entrant tournament through all rounds at the production cron cadence, as in Task 16's timing test. Measure publication and how far each round's simulation finishes before its reveal, and record it honestly.
- **Deadlock:** the Task 16 regression above.
- **Regression:** every existing suite stays green, including the Task 20 tournament and Task 17 Arena browser specs.

## Migration

- Write the source as a new section or `supabase/sql/10-tournament-results.sql`, and document every exception in its header.
- Generate a NEW migration with the CLI after M11. It must also carry the `boundary_start` fix. Complete it per AGENTS.md.
- Prove it with a clean replay, a parity check against the source, the DB suites, `db lint` and the advisors.
- Record it in `migrations.md`. M01–M11 are immutable.

## Gate before committing (in the order of `verification-gates.md`)

1. `npm test`.
2. `npm run typecheck`.
3. `npm run test:db`, with a stable Edge start time.
4. `npm run build` and `npm run verify:static`.
5. The development browser suite (`pw-claude.config.mjs`, port 3200).
6. The isolated production gate.
7. `git diff --check`.

## Commit and report

- Commit `feat: run automatic league tournaments`, the plan's commit name, together with the migration.
- Then commit `docs/implementation/task-19-report.md` separately. It is the full Task 19 report: phases 1, 2a and 2b, the contract changes, the deadlock fix, the timing, and the gates for Tasks 21, 22, 23 and 24.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns.
