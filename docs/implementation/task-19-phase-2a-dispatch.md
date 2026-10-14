# Task 19 dispatch, phase 2a: tournament eligibility, opt-in, bracket and bout jobs (controller: Claude)

Phase 1 (`be28376`, reviewed) delivered the pure tournament domain in `supabase/functions/_shared/domain/tournament.ts`. Task 16 (complete at `95a48f6`) delivered the Arena backend that tournaments reuse: league placement, rating rows, the per-slot-and-league pairing job, assignments, per-battle seeds, one simulation per battle, and settlement one side at a time.

Phase 2 of Task 19 is split into two reviewable checkpoints:
- **2a (this dispatch):** items 1–7 of "Phase 2 must do" in `docs/implementation/task-19-phase-1-report.md`:
  - the SQL source and migration;
  - the opt-in command with its locking rule;
  - the partition inside Task 16's pairing job;
  - acceptance of the TypeScript-built bracket;
  - per-bout seeds;
  - bout jobs with anchoring and the child input.

  Bouts are created and can be claimed. 2a stops before results are accepted, revealed or settled.
- **2b (later):** items 8–11: the result fence, reveals and stages, settlement with placements, and the role-safe `TournamentView` projection, including the round-one placement field.

## Read first (binding)

- `AGENTS.md`, every section, including the database-test rule.
- `docs/operations/migrations.md`, `job-leases.md` and `verification-gates.md`.
- `docs/implementation/task-19-brief-base.md` (the binding plan and spec text: §8.2).
- `docs/implementation/task-19-phase-1-report.md`, in particular "Phase 2 must do", the public-projection guidance and the decisions; plus `task-19-phase-1-review.md`.
- `docs/implementation/task-16-report.md`, `task-16-phase-2a-report.md`, `task-16-review.md`: how pairing, assignments, battle seeds, simulation jobs and settlement actually work now. Reuse them; do not build a second runner or a second grant guard.
- The Task 7, 9 and 10 reports and reviews; `HANDOFF.md`.

## Where and how

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19-p2`, base `95a48f6` (pushed). Record the base in your report.
- The local Supabase stack "Cloudiator" is Claude's. Its Edge runtime is served in the background from this worktree.
- **Database-test rule:**
  - Run `npm run test:db` only while nothing else builds, browses or edits in this worktree.
  - Compare `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after the run; on a change, discard the run and rerun.
  - Never print `supabase status`, keys or `.env.edge.local`.
- Never write to, run commands in, or open:
  - `C:\Avi\Studies\Projects\Cloudiator`;
  - `C:\Avi\Studies\Projects\Cloudiator-replay`;
  - `C:\Avi\Studies\Projects\Cloudiator-arena`, where a preview dev server runs on port 3400 for Avi. Leave it alone.
- **Do not download any package or tool.**
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents.

## Controller decisions (binding)

1. **Opt-in command.**
   - Add `set_tournament_opt_in(actor_id, operation_id, input jsonb)` as a backend-only RPC, routed through the existing `game-command` handler with operation receipts.
   - It returns `processing` while `processed_slot_index < slotAt(now)`, the same gate as `02-build-schedule.sql:103`.
   - The boundary reads the opt-in under the account and row locks, so the live value equals the value at the cutoff. Pass it to the partition as a single revision at cutoff − 1 ms, as the phase 1 report records.
2. **Partition inside Task 16's pairing job.**
   - On a tournament slot, the per-slot-and-league pairing job runs `partitionTournament` before `buildBracket` and `matchArena`.
   - A league with at least two eligible entrants gets a bracket; the rest, and any league with fewer than two, go through regular `matchArena` exactly once.
   - One stamina charge for the slot.
3. **Bracket seed.**
   - `buildBracket` gets its own one-way placement seed, computed by SQL as `encode(extensions.digest(<pairing job seed> || ':bracket', 'sha256'), 'hex')`. It is never the matcher's seed.
   - Per-bout seeds are SHA-256 values derived from the pairing job seed and the bout id, stored per bout row, and never derived in the domain.
4. **Acceptance.** `complete_job` accepts the bracket only if:
   - every eligible entrant appears exactly once;
   - each fighter equals its TypeScript-frozen value;
   - the graph passes `checkGraph`.

   Bracket, bouts and entries are immutable and private.
5. **Bout jobs.**
   - One simulation job per bout, anchored to the tournament's rank-1 entry (as planned), with dedupe keys and `job_dependencies` on parent bouts.
   - A child bout reads its parents' stored winners under the job fence.
   - Byes resolve at once.
   - Bout jobs are created at phase 8, when `activity_executor_ready('tournament')` is true.
   - The claim and coordination accounting follows Task 16's (combat work; the claimed batch limit stays 5).
6. **Human tournament bouts in `PairingHistory`.** The plan wants one row per bout. `pairing_input` currently reads only `pair` assignments; extend it here, or record exactly what 2b must do if bout results are needed first.
7. **Names.** Freeze real names with the entries, because `recordBout`'s idempotent replay compares the whole log.

## Tests (TDD: write each first, watch it fail for the right reason)

Phase 2a items from item 12 of "Phase 2 must do", in `tests/db/tournaments.test.ts` (and worker or unit tests where TypeScript changes):
- **Opt-in:** the command; the processing gate; a toggle at the cutoff resolved by locking.
- **Partition:** 0, 1, 2, 3, 5 and 50 entrants per league; cutoff ±1 ms; opt-out; insufficient stamina; a cheaper tournament goes to Rest; regular Arena exactly once.
- **Acceptance:** rejects omitted, duplicated or altered entrants and fighters, and a graph that fails `checkGraph`.
- **Seeds:** the placement seed differs from the matcher's seed; per-bout seeds are stable across a retry; access to both is denied.
- **Bout jobs:** created idempotently; dependencies on parent bouts; byes resolve at once; a child bout reads its parent winners.
- **Access denial** for every new table and function.
- **Timing:** a 50-entrant tournament slot at the production cron cadence (as in Task 16's timing test), recorded honestly.
- **Regression:** keep every existing suite green.

## Migration

- Write the SQL source as `supabase/sql/09-tournaments.sql`. Its header documents every exception (the bracket and bout seeds, bout-job anchoring).
- Generate a NEW migration with the CLI after M10, and complete it per AGENTS.md.
- Prove it: clean replay, parity with the source, DB suites, `db lint` and the advisors.
- Record it in `migrations.md`. M01–M10 are immutable.

## Gate before committing (in the order of `verification-gates.md`)

`npm test`, `npm run typecheck`, `npm run test:db` (with the Edge start time stable), `npm run build`, `npm run verify:static`, the development browser suite (`pw-claude.config.mjs`, port 3200), the isolated production gate, `git diff --check`.

## Commit and report

- Commit `feat: enter league tournaments and schedule their bouts`, with the migration.
- Then commit `docs/implementation/task-19-phase-2a-report.md` separately. Cover the interfaces, decisions, RED/GREEN, the migration evidence, the timing, and exactly what 2b must do.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns.
