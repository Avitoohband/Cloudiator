# Task 19 phase 2b review fixes (controller: Claude)

The phase 2b review of `2025dc6..e4df403` (tested at `b3a8a80`) gave specification Pass and quality Pass, ready to merge with fixes. This dispatch fixes its Important finding and three Minors before Task 19 is pushed. The review text is quoted where it binds.

## Read first (binding)

- `AGENTS.md`, every section, including the database-test rule and the stand-in restore rule.
- `docs/operations/verification-gates.md`, `migrations.md`.
- Spec §10.5 in `docs/superpowers/specs/2026-10-11-gladiator-arena-design.md`: replay logs load on demand; polled projections stay small.
- `docs/implementation/task-19-report.md`, and Task 10's projection report (how `06-projections.sql` keeps bulky logs out of polled reads).
- The code the review cites:
  - `src/lib/api/reads.ts` (`readTournament`, `tournamentLookupId`);
  - `src/features/tournaments/TournamentPanel.tsx` (the re-read at each mark and every 30 s while `processing`);
  - `src/game/tournament-camp.ts` and `src/game/tournament-stage.ts`;
  - `supabase/functions/_shared/contracts/reads.ts` (`revealedResult.battleLog` is already optional).

## Where and how

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19-p2`, base `b3a8a80`. Record the base in your report.
- The local Supabase stack "Cloudiator" is Claude's; its Edge runtime is served in the background from this worktree.
- **Database-test rule:** run `npm run test:db` only while nothing else builds, browses or edits in this worktree. Compare `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after; discard and rerun on a change.
- Never print `supabase status`, keys or `.env.edge.local`.
- Never write to, run commands in, or open `C:\Avi\Studies\Projects\Cloudiator`, `Cloudiator-replay` or `Cloudiator-arena` (a preview server runs there on port 3400).
- **Do not download any package or tool.**
- **No migration.** M12 is committed and immutable. If you find a fix truly needs schema change, stop and report instead (status BLOCKED with the reason).
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents.

## Scope

### I1 (Important): keep battle logs out of polled tournament reads

Review: "Every tournament read carries every revealed battle log, re-read on each poll." A late 50-entrant view is about 0.5 MB raw, re-read 15–20 times per viewer per slot, and indefinitely every 30 s while a stuck settlement keeps the status at `processing`.

1. **Polled reads carry no logs.** `readTournament` selects only the result fields the view needs (participants, winner, bye), for example with PostgREST JSON-path selection on `result`. No `battleLog` crosses in a polled read.
2. **Logs load on demand.** Add a gateway read that loads one bout's log when it is played (watched in the panel, or animated in the camp), under the same RLS due-time filter. Results are immutable, so cache each loaded log in the client for the session and never fetch it twice.
3. **Optional incremental results.** If you also make result reads incremental, the scheme must stay correct when reveal rows are written out of ordinal order (one reveal job per fought bout). A plain `ordinal > last seen` cursor is unsafe in that case. Prove the order guarantee, or re-request only the bouts still missing.
4. **Bound the `processing` re-read.** While `processing`, back off: 30 s, then 60 s, 120 s, capped at 5 minutes. Pause while the tab is hidden and re-read once on focus. Reset to the normal schedule when the status changes. Apply the same rule to the camp's per-tournament reads.
5. **Measure.** Add a test that reads a late 50-entrant view through the live reads layer against the local stack and asserts that:
   - the polled responses contain no battle log;
   - their total size stays under a stated bound you choose and justify (record the measured bytes before and after the fix);
   - the on-demand read returns the stored log only when due.

### M2: regression for the RLS due-time filter

Add a client read (owner, another account and anonymous) of a future-dated `tournament_bout_results` row, by id and by tournament. It must return nothing. Prove it fails if the policy were `using (true)`: mutate the policy inside a rolled-back transaction, or record a mutation run, and restore under the stand-in rule if you use a stand-in.

### M3: pure lookup id

- Move `tournamentLookupId` (and the `TOURNAMENT_ID` pattern if shared) into a pure module that imports neither the API layer nor Supabase. `src/game/tournament-stage.ts` imports it from there.
- The camp must never throw for one actor: if `tournamentIdFor` meets an invalid slot or league, it returns no tournament for that actor and the camp continues. Add a unit test for this.

### M4: "being prepared" between cutoff and publication

Between the tournament cutoff and phase-8 publication (about 61–121 s), the live read answers `not-found`, and the panel says "No tournament matches this selection". Show "Tournament being prepared" for the current tournament slot during that window, and retry on the normal schedule. Prefer a UI-level state without a contract change; record your choice. Cover it with a component or browser test.

### Not in scope

- **M1** (the client-readable `pairing_job_id`): deferred to Task 13's visitor-access migration, which re-grants the public projections column by column.
- **M5** (the engine-free `isTournamentSlot` gate): reassigned to Task 13 in HANDOFF by the controller.
- **The coordinator busy race:** a separate Task 16 follow-up under Task 23.

## Tests (TDD)

Write each new test first and watch it fail for the right reason: the size and no-log test against the current code, the backoff test, the throw test, the "being prepared" test. Every existing suite stays green, including the Task 20 tournament and Task 17 Arena browser specs.

## Gate before committing (in the order of `verification-gates.md`)

1. `npm test`.
2. `npm run typecheck`.
3. `npm run test:db`, with a stable Edge start time.
4. `npm run build` and `npm run verify:static`.
5. The development browser suite (`pw-claude.config.mjs`, port 3200).
6. The isolated production gate.
7. `git diff --check`.

## Commit and report

- Commit `fix: load tournament logs on demand and bound tournament re-reads`.
- Then commit `docs/implementation/task-19-phase-2b-fix-report.md` separately: what changed, the RED/GREEN evidence, the measured bytes before and after, and the gates.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, the measured bytes, concerns.
