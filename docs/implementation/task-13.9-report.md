# Task 13.9 report: live-ready tournament rings, final gates and handoff

- **Worktree and branch:** `C:\Avi\Studies\Projects\Cloudiator-claude`, `claude/task-13`.
- **Base:** `2bfac50` (docs: record the Task 13.8 review and checkpoint scenes over the camp).
- **Commits:** `427c426` feat: ready the live camp's tournament rings; `b54d361` docs: report Task 13. Not pushed.
- **Status:** DONE_WITH_CONCERNS (interface deviations and scope notes; every gate passed).

## What I implemented

### Ring schedule independent of log arrival (Task 19 R4)
- `src/game/tournament-camp.ts` `campTournamentFights` now stages every revealed fought bout between two camp entrants from its reveal, with or without its log. The polled fight summary times it (`endsAtMs` = the stage core's `fightEndsAtMs`); `battleId` is the bout id (Task 19 makes them equal); participant order is the log's, or the published result's (the server writes it in log order, `10-tournament-results.sql`).
- `src/game/arena-layout.ts`:
  - `CampFight.log` is `BattleLog | null`; `ArenaCampFight` (log always present) is what `campArenaFights` returns.
  - `scheduleArenaRings` plans fights in start, then battle-id order whatever order it is given; with `previous`, only fights that entered their ring by `knownAtMs` stay fixed, and the still-queued ones are planned again with the new ones (never before `knownAtMs`).
  - New pure `updateRingSchedule(schedule, fights, ringCount, nowMs)`: the scene's rule when its fight set changes, extracted from `camp-scene.ts`.
  - Shared comparator `byStart`.
- `src/game/camp-scene.ts`: uses `updateRingSchedule`; refreshes `fights` on every recompute so loaded logs attach without rescheduling; a fight without a log is not planned or drawn (its pair stands in the ring); its duration is the summary's; `CampSceneHandle.ringSchedule()`; debug fights report `logged`.

### Logs only for current or upcoming ring windows; one shared cache
- `tournamentLogsDue(view, nowMs, windowMs, rings)` returns the bouts of `view` that have a ring window (the scene's schedule) that is current or starts within `windowMs`, have no log yet and are not byes, soonest first.
- `TOURNAMENT_LOG_WINDOW_MS = ARENA_ENTRY_MS + ARENA_RESULT_HOLD_MS` (10 s): the shortest ring window, so each ring asks for at most its current and next bout.
- `src/game/GameViewport.tsx`: asks the scene for its ring schedule each check and loads only the due logs (still at most `LOG_LOADS` = 6 at a time, through the reader's `tournamentLog`, the gateway's session cache that the Tournaments panel shares). No scene, no log loads.

### Pruning (Task 20 review minor 4)
- New `campTournamentIds(actors)` in `tournament-camp.ts`.
- `GameViewport` forgets a tournament's view and its bouts' logs when the world has no entrant of it left (`forgetLeftTournaments`, on each world and on the test hook's `setWorld`), drops its read record in the check, and ignores a view or log that lands after its tournament was forgotten.
- Test hook `tournamentViews()`.

### Engine-free `isTournamentSlot` (Tasks 19 M5, 20)
- New `supabase/functions/_shared/domain/tournament-slot.ts` holds `isTournamentSlot` and its canonical-slot check (imports: `types.ts` types, `clock.ts`, `rules-v1.ts`).
- `tournament.ts` imports and re-exports it (`export { isTournamentSlot }`); the backend callers are unchanged.
- `src/game/tournament-stage.ts:28` imports `@domain/tournament-slot`.

### Carried Minors
1. **13.3:** `tests/browser/live-camp.spec.ts` "a visitor's live camp reads Arena timelines and tournaments anonymously…": minute 60 of the `completed` slot, the 8 tournament entrants and the Bellator–Corvina Arena pair moved into that slot. It waits until the camp stages the final and the Arena bout and has read the final's log, then asserts only public tables were read, every read was anonymous, no `/functions/v1/` request and no Auth call.
2. **13.7:** `tests/fixtures/results.ts` `oneResultASlot`: newest first, a row that repeats another (same gladiator, kind, result and time) is dropped, and a row whose gladiator already has a result in that slot moves back whole slots (with its replay expiry). Aster's duplicate "won an Arena bout" (the `ownerHumanWin` Arena sample, identical to the `pvp` replay) is dropped; Aster's other rows now fill one slot each. Assertion in `tests/api/fixture-gateway.test.ts`.
3. **13.8:** `TournamentPanel.tsx` passes `viewerId={model.viewerId ?? null}` (the owner's gladiator or null) to the bracket's `BattleReplay`; `tournament.spec.ts:118` now asserts the spectator sees no rewards line.

## TDD evidence

**RED (before the implementation):**
- `tests/domain/tournament-slot.test.ts`: 3 failed — `ENOENT … tournament-slot.ts`; "src/game/tournament-stage.ts reaches supabase/functions/_shared/domain/combat.ts"; `Cannot find package '@domain/tournament-slot'`.
- `tests/domain/tournament-camp.test.ts`: 6 failed —
  - "assigns the same rings whatever order the logs arrive in": `expected Map{ …(18) } to deeply equal Map{ …(18) }` (the two arrival orders scheduled different rings and times; this version used an inline copy of the scene's rescheduling rule, swapped for the extracted `updateRingSchedule` after GREEN);
  - "stages each revealed bout from its fight summary…": `expected [] to deeply equal [ null, null, null, null ]` (no fight without a log);
  - "asks for logs only for current and upcoming ring windows": `TOURNAMENT_LOG_WINDOW_MS` undefined;
  - "a viewer joining late…": `actors.filter is not a function` (the old `tournamentLogsDue(actors, views, now)` signature);
  - two `campTournamentIds is not a function`.
- `tests/domain/arena-layout.test.ts` (run against `HEAD`'s `arena-layout.ts`): 3 failed — input order (`expected Map{ …(7) } to deeply equal Map{ …(7) }`), queue convergence (`Map{ 'bout-a' … (10) }`), `updateRingSchedule is not a function`.
- `tests/api/fixture-gateway.test.ts`: "Aster: 373248,373248,373247,373247,373247,373246,373246,373246,373245,373244,373244,373069,373069,373010,372956: expected 8 to be 15".
- Browser, desktop, `src/` stashed to `HEAD` (the new tests in place): 4 failed, 2 passed.
  - `tournament.spec.ts:118` flipped: the spectator's Final replay contained "Rewards are credited when the activity settles.".
  - "a viewer joining late…": the camp had asked for round-1 logs whose windows had ended, and its load-order schedule differed from the windows (`- Expected - 12 / + Received + 0` against the due set).
  - "loads the battle log…": timed out waiting for `logged` (no such field; fights staged only after logs).
  - "forgets tournament views…": `window.__cloudiatorCamp.tournamentViews is not a function`.
  - Passed already (characterization, expected): "changes a tournament ring and the panel over at the same moment" and the visitor live-camp test. The changeover test was mutation-checked afterwards: adding 1 000 ms to the tournament fight's `endsAtMs` fails it at the bout's end (`Expected: "result" / Received: "fighting"`).

**GREEN:** the same files pass (unit 35/35 in the two camp files, 3/3 slot, 23/23 gateway and results panel); the 6 browser tests pass on both projects (12/12).

## Gates (in the order of `verification-gates.md`)

| # | Gate | Result |
| --- | --- | --- |
| 1 | `npm test` | 44 files, **989/989** passed. |
| 2 | `npm run typecheck` | Clean (`tsc`, `deno check` of both Edge entrypoints, `edge.deno.ts` 2/2). |
| 3 | `node assets/source/build-assets.mjs --check` | "assets up to date (28 files)". |
| 4 | `npm run test:db` | Run 1: 9 files, **177/177** passed in 142.5 s. Edge `StartedAt` before `2026-10-17T11:54:14.330615374Z`, after `2026-10-17T11:54:14.330615374Z` (unchanged). The `arena.test.ts:642` flake did not occur; one run only. |
| 5 | `npm run build`, `npm run verify:static` | Build clean (5 routes); "Static export verified: 5 fixed routes; 90 assets scanned; no forbidden backend material." |
| 6 | Development browser suite, `node_modules/.cache/pw-claude.config.mjs` (port 3200) | **384 passed, 22 skipped, 0 failed, 0 flaky** (406 cases, 6.8 min). |
| 7 | Isolated production gate with the repo's `playwright.config.ts` | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build` clean; `npm run verify:static -- .next/browser-test`: 5 routes, 90 assets, clean; `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test`: **16 passed, 390 skipped, 0 failed** (static server on 4173; no port conflict). |
| 8 | `git diff --check` | Clean before each commit. |

Runs were serialized (no build during a browser run; the DB run with nothing else active). Before the gate, the Edge container had been recreated at 11:54:14Z while I was editing files in this worktree, consistent with the recorded watcher observation; no test was running then.

## Late-joiner measurement

Live browser test `tournament.spec.ts` "a viewer joining late loads at most the logs of the current and next ring window" (both projects): a 50-entrant bronze tournament (`largeTournament`, real engine logs renamed; 64-slot bracket, 18 fought bouts in round 1, 16 in round 2) served through `routeLiveReads`, the shared clock held at 10 s after round 2's reveal from the moment the camp exists.

- **8 log reads of 34 revealed fought bouts** (6 current ring windows, 2 next), each once; the requested set equals the due windows in the camp's own ring schedule; at most 2 per ring.
- Log JSON: 73 631 bytes, against 304 662 bytes for the 34 logs Task 19's camp would have loaded.
- On `HEAD` (RED) the camp had asked for round-1 logs whose windows were long over.
- The panel then replayed one of those 8 bouts with no second `tournament_bout_results?bout_id=` read (the shared gateway cache), and every read was anonymous.
- Unit-level, same rule and tournament: joining at minute 12 asks 8 of 18; 23: 8 of 34; 30: 0 of 34; 35: 0 of 42; 46: 4 of 46; 58: 0 of 48; 70: 0 of 49. A viewer present all slot loads each of the 49 logs once (436 697 bytes in all), at most 6 due in one check.

## Files changed

- **New:** `supabase/functions/_shared/domain/tournament-slot.ts`, `tests/domain/tournament-slot.test.ts`.
- **Source:** `supabase/functions/_shared/domain/tournament.ts`, `src/game/tournament-stage.ts`, `src/game/tournament-camp.ts`, `src/game/arena-layout.ts`, `src/game/camp-scene.ts`, `src/game/GameViewport.tsx`, `src/features/tournaments/TournamentPanel.tsx`.
- **Tests and fixtures:** `tests/domain/tournament-camp.test.ts`, `tests/domain/arena-layout.test.ts`, `tests/api/fixture-gateway.test.ts`, `tests/browser/tournament.spec.ts`, `tests/browser/live-camp.spec.ts`, `tests/fixtures/tournament-build.ts` (`largeTournament`), `tests/fixtures/results.ts`.
- **Docs (second commit):** `docs/implementation/task-13-report.md`. `docs/operations/migrations.md` needed nothing for M13. `HANDOFF.md` not edited (controller ruling).

## Concerns

1. **Interface deviation: `tournamentLogsDue(view, nowMs, windowMs, rings)`.** The brief names `(view, nowMs, windowMs)`. A bout's ring window depends on the whole camp's ring schedule (Arena bouts share the six rings), so the function takes the scene's schedule (`CampSceneHandle.ringSchedule()`) as a fourth argument rather than recomputing a second, possibly different schedule.
2. **Interface deviation: `isTournamentSlot(slot: SlotWindow, rules?)`.** The brief writes `isTournamentSlot(slotIndex: number)`. I moved the existing function unchanged, because the backend (`jobs.ts`, `tournament.ts`) and all tests call it with a slot window and optional retained rules; `tournament.ts` re-exports the same function object (tested).
3. **Behaviour change beyond R4 in `scheduleArenaRings`.** Fights still queued in staging at `knownAtMs` are now planned again together with newly learned fights (start, then battle-id order). Fights that have entered a ring never move (existing test unchanged). This also applies to Arena bouts. It makes a queue converge when its fights become known in different batches before the queue enters; it cannot make two viewers equal once some fights have entered.
4. **A tournament bout whose log has not loaded** (slow or failed read, retried every 30 s) now stands in its ring with its pair idle, then plays from its real position when the log arrives. Before, such a bout was not staged at all.
5. **Fixture Results:** the `ownerHumanWin` Arena sample no longer appears in Results (it said exactly what the `pvp` replay says at the same time). `fixture-gateway.test.ts` now checks the `pvp` row against its timeline and asserts the duplicate is listed once. Retimed rows move only in the feed; their timelines keep their times.
6. **TDD order.** For the arena-layout tests and the browser tests I wrote the implementation before running the new tests; I then verified RED against `HEAD` (`git show HEAD:src/game/arena-layout.ts`, and `git stash push -- src/` for the browser run), and GREEN after restoring. Two browser tests (the ring/panel changeover and the visitor live camp) are characterization tests that already passed on `HEAD`; the changeover test was mutation-checked.
7. **Scratch mishap, corrected.** Once a chained command copied an old Oct-14 scratch file over `src/game/arena-layout.ts`; I restored it from `HEAD` and reapplied the edits before any gate. All gates ran on the committed content.
8. **Brief vs controller:** the brief's Step 5 says to update HANDOFF; I did not, per the controller's ruling. `migrations.md` needed nothing for M13 (its entry already covers the source, completions, release order and replay evidence).
9. The late-joiner test holds the clock by defining a setter on `window.__cloudiatorCamp` in an init script, which freezes the shared clock the moment the hook is created (fixture-enabled builds only).
