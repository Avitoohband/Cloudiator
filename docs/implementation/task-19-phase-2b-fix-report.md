# Task 19 phase 2b review fixes report

Status: **DONE_WITH_CONCERNS**. The Important finding (I1) and the three Minors (M2, M3, M4) of the phase 2b review are
fixed and verified locally. The concerns are listed under [Concerns](#concerns); none blocks the push.

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19-p2`.
- Base: **`b3a8a80`** (the dispatch `1c5190c` sits on it and changes only its own document).
- Fix commit: **`477f673`** `fix: load tournament logs on demand and bound tournament re-reads`.
- **No migration.** M01–M12 are unchanged; no SQL source changed. The contract gains one optional field (decision 1).
- Not done, by instruction: no push or merge, no `HANDOFF.md` edit, no subagents, no downloads; no other checkout was
  opened; no key, status output or `.env.edge.local` was printed. Logs are in ignored `.task19-fix-*.log` files.
- Next.js: the bundled client-component and client-data-fetching guides were read; no Next API changed (only client
  component state and effects).

## What changed

| Path | Change |
| --- | --- |
| `src/lib/tournament-id.ts` (new) | Pure ids (M3): `TOURNAMENT_ID`, `TOURNAMENT_BOUT_ID`, `tournamentLookupId` (throws), `tournamentLookupIdOrNull` (never throws), `tournamentSlotOf`. Imports only a contract type. |
| `supabase/functions/_shared/contracts/reads.ts` | `TournamentFightSummary = Pick<BattleLog, 'durationMs' \| 'victoryReason' \| 'tieBreakReason'>`; `revealedResult.fight?`. A polled read carries `fight`, never `battleLog`. |
| `src/lib/api/reads.ts` | `readTournament` selects `bout_id, ordinal, participants, winnerId, bye` and the three fight fields by JSON path on `result` (I1.1). New `readTournamentLog(client, boutId)`: bout-id check before any query, sampled server time plus RLS, `not-found` when not due, unpublished or a bye (I1.2). |
| `src/lib/api/gateway.ts` | `GameGateway.tournamentLog(boutId)`; the live gateway keeps one promise per bout for the session, forgets a failure, and clears on an account change. |
| `src/lib/api/fixture-gateway.ts` | Mirrors the live read: views without logs (`withoutTournamentLogs`), each revealed log on demand. |
| `src/game/tournament-stage.ts` | Imports the pure id (M3). Fight timing and the new `fight` bout field come from the log or the fight summary (a malformed summary fails closed). `withoutTournamentLogs`, `withTournamentLogs` (merges a log only into its own published bout when it agrees), `processingRetryDelay`, `TOURNAMENT_RETRY_MS`, `tournamentPreparing` (M4). |
| `src/features/tournaments/tournament-text.ts` | `victoryText` reads the fight summary, so the tie-break note needs no log. |
| `src/features/tournaments/TournamentPanel.tsx` | Watch replay on every decided bout, its log loaded on click ("Loading the replay…" / "cannot be loaded"); processing back-off, hidden-tab pause, one focus re-read; `TournamentNotice` with "Tournament being prepared" (M4); test hook `logReads()`. |
| `src/game/tournament-camp.ts` | `tournamentIdOfActor` returns null for an invalid slot or league (M3); `recordTournamentRead` and the back-off in `tournamentReadsDue` (with `focused`); `tournamentLogsDue`. |
| `src/game/GameViewport.tsx` | Camp: back-off, one re-read of a processing tournament on focus, on-demand logs (at most 6 in flight, a failure retried after 30 s, each kept for the session); test hooks `tournamentLogReads()`, `tournamentLogs()`. |
| Tests | `tests/domain/tournament-id.test.ts` (new); new cases in `tournament-camp`, `tournament-stage`, `tournament-panel`, `reads`, `projection-gateway`, `fixture-gateway`, `live-gateway`; `tests/db/tournaments.test.ts` (two new cases, one updated); `tests/browser/tournament.spec.ts` (three new cases); `tests/fixtures/db.ts` `recordingClient`. |

## Decisions

1. **A fight summary replaces the log in polled reads (contract addition).** Without the log the stage core could not
   time "Bout in progress" (the bout's logged duration) or say how a winner won (tie-break text), and the panel would
   name a winner while the camp's ring still plays the bout, breaking Task 20's rule that both show the result at the
   same moment. `fight` (about 100 bytes per fought result) keeps that behaviour exact; the full log loads only when a
   bout is watched or animated. It is beyond the literal brief, so it is called out here.
2. **One gateway read per bout log** (`tournamentLog`), cached by the live gateway for the session, so no caller fetches
   a log twice. The panel also keeps the logs it loaded; the camp keeps its own per session.
3. **The fixture gateway mirrors the live read**, so the browser specs exercise on-demand loading in the panel and the
   camp rather than reading logs from the views.
4. **Back-off rule** (panel and camp): while the view is processing, re-reads wait 30 s, 60 s, 120 s, 240 s, then 5 min
   each; a reveal mark still reads at once; any non-processing status resets to the normal schedule; a hidden tab never
   reads; coming back re-reads once (focus and visibility usually fire together, so the panel skips a focus read while
   one is in flight). The failure retry stays at 30 s.
5. **M4 is a UI-level state; no contract change.** A `not-found` read is "Tournament being prepared" when the display
   time is inside that tournament's slot and the viewer's own `processedSlotIndex` is still behind it (phase 8 has not
   published the slot). It retries every 30 s and, while being prepared, re-reads the owner each time, so a published
   slot whose league has no tournament falls back to "No tournament matches this selection". The panel's failure state
   now holds the latest failure code (before: the first), so a transient `unavailable` cannot mask a later `not-found`.
6. **Incremental results (optional I1.3) not done.** Without logs a full re-read of the late 50-entrant view is about
   39 KB; an incremental scheme would have to re-request missing bouts because reveals land out of ordinal order. Left
   to Task 23 if measured egress calls for it.
7. **The camp loads every staged bout's log**, decided ones included: the ring scheduler keeps earlier fights in their
   windows, so dropping logs of finished fights would move later rings. That is about 0.55 MB once per 50-entrant
   tournament per camp viewer (the camp is fixture-only until Task 13).

## RED and GREEN

| Test | RED (observed before the fix) | GREEN |
| --- | --- | --- |
| Unit (8 files) | 3 files could not load (missing `@/lib/tournament-id`, `withoutTournamentLogs`) and 12 cases failed (`tournamentPreparing`, `TournamentNotice`, `withoutTournamentLogs`, `gateway.tournamentLog` missing). | 106/106 in the 9 affected files; `npm test` 922/922. |
| DB size and no-log (50 entrants) | Polled late view **576,640 bytes** in 5 responses, with battle logs (`not.toMatch(/battleLog/)` failed). | Late view **39,430 bytes**, no log, under the bound; each log on demand equals the stored one. |
| DB public view (updated) | The polled result carried `battleLog`, no `fight`. | `fight` summary; `readTournamentLog` returns the stored log. |
| DB M2 (future-dated row) | `readTournamentLog is not a function`. Its client reads by id and by tournament already returned nothing: the policy was correct, so this is a regression test; its discriminating proof is below. | 1/1. |
| Browser back-off (old panel restored for the run) | At the 60 s step: expected 4 reads, received 5 (the old 30 s retry). | 1/1 desktop and mobile. |
| Browser panel and camp on-demand logs | New hooks; not run against the old code. | 2/2 per project. |

The first DB RED run is discarded: the Edge container was recreated 2 s into it (start time 18:38:00 → 18:50:16),
the pattern `verification-gates.md` records. The counted rerun had the start time unchanged.

### M2: the due-time policy is what hides the row

- **In the test, rolled back:** as `authenticated`, the same read by id and by tournament returns 0 rows; after
  `alter policy player_read … using (true)` inside the transaction it returns the row twice (by id and by tournament);
  the transaction rolls back and the policy text is unchanged.
- **Recorded mutation run:** `using (true)` committed on the verified container (project label `Cloudiator`), the M2 test
  run alone: it **failed** at `owner by id` (the row was returned). The policy was restored with its source expression;
  `pg_get_expr(polqual, polrelid)` matched the captured text byte for byte, and the policy is still `SELECT`,
  permissive, role `authenticated`. Edge start time unchanged.

## Measured bytes

Polled read = every response of one `readTournament` call, decoded JSON (what the review called raw).

| | Before (counted RED run) | After (gate run) |
| --- | --- | --- |
| Late 50-entrant view (all rounds but the final revealed, processing) | **576,640 bytes**, 5 responses | **39,430 bytes**, 5 responses |
| Settled 50-entrant view (placements and completions) | not reached (RED stopped earlier) | **58,926 bytes**, 7 responses |
| One bout's log on demand (with its clock read) | in every poll | 8,742–14,949 bytes, once per bout |

- **Bound: 80 KiB (81,920 bytes) per polled read.** A 64-slot bracket has at most 63 result rows; without logs the read
  scales with entrants and bouts only (about 1.2 KB per entrant settled). Test names use 16 of the 20 allowed
  characters, so the longest names add under 1 KB (162 name occurrences). 80 KiB leaves about a third of headroom and
  is a seventh of one poll before the fix. The no-log assertion catches even a single log.
- **Per viewer.** A panel open through a 50-entrant slot reads about 8 times (open, six reveals, minute 80): at most
  about 0.47 MB, against up to 0.58 MB per poll before. A stuck settlement re-read every 30 s cost about 69 MB per
  viewer per hour before; with the back-off the first hour holds about 15 reads, about 0.9 MB.
- Run-to-run sizes vary by about 100 bytes (random names); the earlier GREEN run measured 39,330 and 58,826 bytes.

## Gates (in `verification-gates.md` order)

| Command | Result |
| --- | --- |
| `npm test` | **922 passed**, 37 files (904 + 18). |
| `npm run typecheck` | Exit 0: `tsc`, frozen Deno check of both Edge entrypoints, 2 Deno runtime tests. |
| `node assets/source/build-assets.mjs --check` | Up to date (28 files). |
| `npm run test:db` | **172/172**, eight files (170 + 2), Edge start time unchanged across the run. |
| `npm run build`, `npm run verify:static` | 5 fixed routes, 90 assets, no forbidden backend material. |
| Development browser suite (`pw-claude.config.mjs`, port 3200) | **266 passed, 8 skipped** (260 + 6), including the Task 20 tournament and Task 17 Arena specs. No dev server left on 3200. |
| Isolated production gate (`CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true` build, `verify:static -- .next/browser-test`, static run on the private config) | Build and scan clean; **14 passed, 260 skipped** by design. |
| `git diff --check`, `git diff --cached --check` | Clean. |

## Concerns

- **Contract addition** (`revealedResult.fight`, decision 1) beyond the literal brief, made to keep Task 20's fight
  timing and tie-break text without the log.
- **Owner re-reads while "being prepared"** (decision 5): one owner read per 30 s retry, normally for the 61–121 s
  window; for as long as a stuck boundary keeps the slot unpublished, at the failure retry's cadence.
- **The camp loads every staged bout's log once** (decision 7): about 0.55 MB per 50-entrant tournament per camp viewer.
  For Task 23's egress budget and Task 13's live camp.
- **M2 is a regression test of an already-correct policy**; its RED is the rolled-back mutation in the test and the
  recorded committed mutation run, not a failing first run.
- **Not changed (out of M3's camp scope):** the panel's live id still uses the throwing `tournamentIdFor` with the
  owner's league, which the database constrains.
- All evidence is local; nothing hosted was touched or measured.

## Skill upkeep

No skill change is proposed: the TDD, verification, migration and database-test guidance covered this work.
