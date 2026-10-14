# Task 19 independent review: phases 2a, 2b and the review fixes

Date: 2026-10-14. Reviewers: fresh Claude reviewer subagents, read-only on the worktree, using the local Supabase stack "Cloudiator" for clean replays and the DB suites. Phase 1 has its own record: [phase 1](task-19-phase-1-review.md).

## Verdict

**Task 19 is complete: specification Pass, code quality Pass, ready to push.** The last round left five non-blocking Minors, recorded below as gates for Tasks 13, 22 and 23.

Range on `claude/task-19-p2`, from `95a48f6`:
- `81dc36b`: phase 2a feature, with migration M11 `20261014160257_tournaments.sql`; `f9e3d97`: its report; `a9f25d3`: its review corrections.
- `2025dc6`: the phase 2b brief.
- `505b2b3`: phase 2b feature, with migration M12 `20261014174629_tournament_results.sql`; `e4df403`: the full Task 19 report.
- `b3a8a80`: Avi's approved stand-in restore rule.
- `1c5190c`: the review-fix brief; `477f673` and `fa0f7a2`: the fixes and their report.
- The commit that adds this record.

M11 and M12 ship together, never M11 alone: phase 2a's bout jobs have no result acceptance until phase 2b.

## Round 1: phase 2a (`95a48f6..f9e3d97`)

**Verdicts:** spec Pass, quality Pass. Two report statements were corrected in `a9f25d3` (the stand-in rule was then a proposal; the report understated what SQL trusts).

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| I1 | Pre-existing Task 16 deadlock: in phase 8, the Arena branch inserts `arena:<battleId>` anchored to side 0, whose foreign keys take KEY SHARE on side 0's rows before the boundary holds side 0's account lock. An owner command holding that lock and asking for `FOR UPDATE` deadlocks with it. | Important | Phase 2b (M12): `boundary_start` takes every preparing member's account lock, in gladiator order, before the debit loop. A regression in `tests/db/arena.test.ts` fails with 40P01 without the fix. |
| M2 | Settlement depended on every bout (n² dependency rows). | Minor | Phase 2b: settlement depends on the final only (equivalent gating; every fought bout is its ancestor). |
| M3 | Header exception 9 did not cover the entry foreign keys' KEY SHARE during `complete_job`. | Minor | Phase 2b: header corrected, with the reason no cycle exists. |
| M5a | Entrants prepared before rank 1 cannot depend on reveal jobs that do not exist yet. | Minor | Phase 2b: reveal jobs are created in rank 1's call. |
| M5b | A league below the minimum had no public status. | Minor | Phase 2b: an `insufficient-entrants` status row. |

## Round 2: phase 2b (`2025dc6..e4df403`, tested at `b3a8a80`)

**Reviewer evidence:**
- `npm test` 904 passed; typecheck clean.
- Clean replay of M01–M12. The 11 M12 function bodies are textually identical to `10-tournament-results.sql`. A rolled-back apply of the source onto the replay left all 864 fingerprint entries unchanged. None of the 6 changed functions is re-emitted unchanged.
- `db lint` empty; advisors INFO `unused_index` only.
- `test:db` 170/170 with a stable Edge container.
- The deadlock RED reproduced independently: with the lock loop removed, 40P01 inside `advance_boundary`; the function was restored byte-equal.
- Timing at the one-minute cron: cleared window published at 120.999 s (the coordinator race), held at 121.12 s; credited 4801.05 / 4860.97 s; 49 bouts, 49 reveals, 245 dependencies.
- Build and static scan: 5 routes, 90 assets. Dev browser 260 passed, 8 skipped. Production gate 14 passed.

**Strengths named:** the full dispatch scope; placement amounts proven end to end for 0, 1, 2, 3, 5 and 50 entrants; a strict fail-closed fence exercised by 19 forged bout results and 21 forged outcomes; a minimal deadlock fix; a clean migration; the lock analysis of exceptions 4, 6 and 10.

**Verdicts:** spec Pass, quality Pass, ready **with fixes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| I1 | Every tournament read carried every revealed battle log, re-read at each mark and every 30 s while `processing`: about 0.5 MB raw per late 50-entrant read, indefinitely when a settlement is stuck. Against §10.5 (logs load on demand). | Important | `477f673`: polled reads select only participants, winner, bye and a fight summary; `readTournamentLog` loads one due log on demand, cached per session and cleared on account change; processing re-reads back off 30/60/120/240 s then every 5 minutes and pause in hidden tabs. Polled read 576,640 → 39,430 bytes; bound 80 KiB with a no-log assertion. |
| M1 | `public.tournament_views.pairing_job_id` is the only client-readable private job id. Harmless (no RPC accepts it without a lease token). | Minor | Deferred to Task 13's visitor-access migration, which re-grants the public projections column by column. |
| M2 | No regression for the RLS due-time filter on `tournament_bout_results`. | Minor | `477f673`: owner, other and anonymous reads of a future row return nothing, by id and by tournament; a rolled-back `using (true)` policy returns it. |
| M3 | The pure stage core imported the API reads layer, and `tournamentIdFor` could throw for one camp actor. | Minor | `477f673`: `src/lib/tournament-id.ts`; an invalid actor has no tournament. |
| M4 | The live read answers `not-found` between cutoff and publication (61–121 s). | Minor | `477f673`: "Tournament being prepared", UI-level, retried every 30 s. |
| M5 | The engine-free `isTournamentSlot` gate from Task 20 is still open (tree-shaken in production). | Minor | Reassigned to Task 13 in HANDOFF. |

**Rulings on the implementer's concerns:**
- **Coordinator busy race:** real and pre-existing (`coordinate_work` answers busy under SKIP LOCKED; the next tick recovers). Latency only; no new worst case beyond the accepted 121 s held window. Not fixed in Task 19: a separate, tested Task 16 follow-up under Task 23 (a bounded coordination retry after a completed prepare or settlement job). The relaxed timing assertion is accepted.
- **Decisions beyond the dispatch wording, all accepted:** settlement also waits for the final's reveal (otherwise placements could publish the champion before the final is public); one reveal job per fought bout, created in rank 1's call; no later stage for eliminated entrants or byes; byes public from the start; the live opt-in command for Task 20's toggle.
- **RED evidence:** accepted under the database-test rule.
- **Assets 91 → 90:** benign.

## Round 3: the review fixes (`1c5190c..fa0f7a2`)

**Reviewer evidence:**
- `npm test` 922/922; typecheck clean; assets up to date.
- `test:db` 172/172 with the Edge start time unchanged; the two new focused cases also passed alone.
- A read-only check confirmed the `player_read` policy on `tournament_bout_results` is unchanged (authenticated, `reveal_at_ms <= clock_timestamp()`).
- Build and static scan: 5 routes, 90 assets. The tournament, arena and camp browser specs on port 3200: 142 passed, 2 skipped. Production gate: 14 passed. `git diff --check` clean.
- The implementer's full development browser run (266 passed, 8 skipped) was not repeated.
- Measured polled sizes: late 50-entrant view 39,330 bytes in 5 responses; settled 58,826 bytes in 7; one log on demand 9,302–13,830 bytes. Bound 81,920 bytes.

**Strengths named:** polled reads select only JSON paths from `result`, and the test checks the raw response text; the on-demand read validates the bout id before any query and filters by server time as well as RLS; merging a log fails closed unless the winner and both gladiators match; the fixture gateway matches the live one; the back-off is bounded, resets on any status change, never reads in a hidden tab and re-reads a stuck status at least every 5 minutes; the M2 evidence discriminates (0 rows under the policy, 2 under `using (true)`); `src/lib/tournament-id.ts` is pure; "being prepared" relies on `processed_slot_index` and publication committing in the same transaction.

**Verdicts:** spec Pass, quality Pass, ready to push **yes**.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| R1 | The live log cache is cleared only by `subscribeSession`, which the live game page does not call yet, and a cached hit skips the session check (`src/lib/api/gateway.ts`). No data can leak: a log is cached only after a due read, which any signed-in player may make. | Minor | Task 13 (it mounts the sync controller): route cached hits through the session check or key the cache by user, with a test that does not call `subscribeSession`. |
| R2 | The panel's 30 s retry timer restarts whenever the unstable `refreshOwner` prop changes, and the owner and tournament reads race on the publication tick, so "No tournament matches" can show for up to 30 s. | Minor | Task 13: keep `refreshOwner` in a ref; while preparing, await the owner refresh before the tournament read. |
| R3 | "Being prepared" misses a gladiator created between cutoff and publication (its `processed_slot_index` already equals the slot). | Minor | Task 13: base the check on a slot-wide published signal, such as the revision's slot. |
| R4 | The camp stages a fought bout only once its log loads, so ring assignment now depends on load order for rounds with 11 or more in-camp fights; viewers could see different layouts. Not visible in the 5-entrant fixtures. | Minor | Task 13 gate before the live camp: schedule rings from the fight summary and attach logs as they arrive. |
| R5 | The M4 card wiring (`preparing`, the owner re-read) has no component test; the parts are tested alone. | Minor | Task 13: add a card test with a `not-found` gateway and a lagging `processedSlotIndex`. |

**Rulings on the implementer's concerns:**
- **`revealedResult.fight?` (duration, victory reason, tie-break reason): accepted.** It is public-safe and minimal: three values from a log that is already public for that row, null while the bout is still fighting, about 100 bytes per result. The duration keeps the panel and the camp ring in step; the reasons explain tie-breaks.
- **Re-reading the owner every 30 s while "being prepared": acceptable.** Normally 2–4 small reads. Recommended for Task 23: apply the processing back-off to both reads once preparation runs past about 3 minutes.
- **The camp loading every staged bout's log (about 0.55 MB per 50-entrant tournament per viewer): acceptable now** (the camp gets a reader only in fixture mode, so no live traffic today). A gate for Tasks 13 and 23, listed below.
- **Skipping incremental reads: accepted.** A poll is 39–59 KB at 50 entrants and grows about 1.2 KB per settled entrant. If Task 23 needs it, re-request the missing bouts, never an ordinal cursor.
- **The panel's live id can still throw for an invalid owner league: acceptable** (the database constrains the league). Optional: `tournamentLookupIdOrNull` at `TournamentPanel.tsx:488`.

## Gates carried forward

- **Task 13:**
  - the M1 column grants in the visitor-access migration. The re-grant must keep JSON-path selection of `result` working, or provide an equivalent summary column;
  - the engine-free `isTournamentSlot` (M5);
  - R1–R5 above;
  - before the live camp ships: rings scheduled from the fight summary, logs loaded only for current or upcoming ring windows, one shared log cache for the panel and the camp, and a measurement for a viewer who joins late;
  - the sync clock should govern the panel's lookup league after a promotion and its visibility handling.
- **Task 22:** "Watch replay" shows on every decided bout. Once logs are pruned after 7 days, the panel must say the replay is no longer retained, not "cannot be loaded right now".
- **Task 23:** the coordinator busy race follow-up; the held-window 121 s policy; hosted compression and real egress, including the camp's log loads and the linear growth of the polled view; the "being prepared" back-off.
- **Task 24:** M11 and M12 deploy with the worker in one step.
