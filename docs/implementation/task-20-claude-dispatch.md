# Task 20 dispatch: tournament countdown, brackets and camp roles (controller: Claude)

The binding plan and spec text is in `docs/implementation/task-20-brief-base.md`. Read it fully first. Where its shared-types section differs from the current contracts in `supabase/functions/_shared/contracts/`, the contracts win.

## Where and with whom

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-20`, base `7a173b8`. This base combines Claude's finished work:
  - Task 15, expeditions (reviewed);
  - Tasks 16 and 19 phase 1, the pure Arena and tournament domain (reviewed);
  - Task 17, Arena staging and standings (reviewed; its fix pass is running elsewhere).
- Other lanes run in parallel. Never write to, run commands in, reset or commit in:
  - `C:\Avi\Studies\Projects\Cloudiator` (Codex, Task 10);
  - `C:\Avi\Studies\Projects\Cloudiator-replay` (the Task 17 fix pass);
  - `C:\Avi\Studies\Projects\Cloudiator-arena`.
- **Task 17 is being fixed** in `claude/task-17`. The fix touches `camp-scene.ts`, `arena-layout.ts`, `ArenaPanel.tsx`, `StandingsPanel.tsx`, `GameViewport.*` and `tests/browser/arena.spec.ts`. Until the controller merges it into your branch, keep edits to those files minimal and additive, and do the camp-role work (decision 4) last.
- Known until that merge: `tests/browser/arena.spec.ts` hard-codes port 3300, so its page tests fail on 3200. Ignore those failures; report any others.
- **No Supabase or Docker commands.** Live data waits for Task 19 phase 2 and Task 10.
- Playwright only through `node_modules/.cache/pw-claude.config.mjs` (dev server on **port 3200**). Never ports 3000, 3100 or 3300.
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents. Never print secrets.

## Read first

- `AGENTS.md`; `docs/implementation/HANDOFF.md`.
- The Task 14, 15 and 17 reports and reviews (replay, fixture, display-clock and camp conventions).
- `task-19-phase-1-report.md` and `task-19-phase-1-review.md` (tournament domain, reveal formula, the public-view notes, the open `TournamentView` contract question).
- `docs/operations/art-review.md`.
- Contracts: `contracts/reads.ts` (`TournamentView`, `TournamentBout`, `TournamentEntrant`), `contracts/commands.ts` (`set-tournament-opt-in`), `contracts/events.ts`.
- Domain: `supabase/functions/_shared/domain/tournament.ts` (`isTournamentSlot`, `buildBracket`, `runBout`, `recordBout`, `placementGrants`, `tournamentOutcomes`) and `arena.ts`.
- Game and app code:
  - `src/game/*`, especially the Task 17 arena layout, rings and display clock;
  - `src/features/arena/*`, `src/app/game/page.tsx`;
  - `src/lib/api/gateway.ts` and `fixture-gateway.ts`;
  - `tests/fixtures/*`.

## Controller decisions (binding unless you find a spec conflict, which you must report)

1. **Pure core** `src/game/tournament-stage.ts` (no Phaser, React or engine imports), given a `TournamentView` and `displayNowMs`:
   - **Next tournament:** start time and countdown from `isTournamentSlot` on UTC slots (Wednesday and Saturday 17:20 UTC).
   - **Status:** scheduled, active, processing, completed or insufficient-entrants.
   - **Bracket shape:** the next power of two, R rounds and the bye count, from the entrants.
   - **Reveals:** the time of each round, `80 × r / (R + 1)` minutes after start, rounded up as in Task 19. A bout result shows only if both its `revealedResult` is non-null **and** the display clock has reached its round's reveal time. Otherwise show "Result preparing".
   - **Winners and roles:** the winner of every revealed bout, by `winnerId`; each entrant's role at the display time (waiting, fighting, eliminated and spectating, or champion).
   - **Placements:** only when settled (empty before).
   - Pure and deterministic.
2. **UI** `src/features/tournaments/TournamentPanel.tsx` (own CSS module), in the "Tournaments" tab:
   - **Registration:** an "Automatically enter tournaments" checkbox showing the owner's `tournamentOptIn`. Toggling sends the `set-tournament-opt-in` command through the gateway; in fixture mode commands are unavailable, so show the standard "unavailable in this preview" note and keep the box unchanged.
   - **Rules text:** explain that entry needs the opt-in, Arena scheduled for the tournament phase and enough stamina at the cutoff. Opting out keeps normal Arena. A toggle made after the cutoff affects the next tournament.
   - **Times:** the countdown and tournament time in the viewer's time zone, with the UTC time alongside.
   - **Bracket:** entrants and bracket shape at start, then round-by-round results only as revealed. A fewer-than-two-entrants explanation ("regular Arena this slot"). Placements after settlement.
   - **Replays:** completed bouts open an inline close-up replay of the revealed `battleLog` through the existing `BattleReplay` component. Tournament bouts have no activity id in the public view, so do not link to `/replay/`.
   - **Accessibility:** mobile bracket navigation (rounds as tabs or a horizontal scroller with keyboard support); names as React text; no rewards for other entrants.
3. **Fixtures, engine-generated,** in the new `tests/fixtures/tournaments.ts` (JSON next to it is fine):
   - Built with the real Task 19 domain (`buildBracket`, `runBout`, `recordBout`, `placementGrants`), with explicit per-bout seeds (Task 19 removed seed derivation from the domain) and recorded seeds.
   - A generator test compares them after `JSON.stringify`.
   - Project each one to a public `TournamentView` with an explicit whitelist: no seeds, snapshots, ratings or private outcomes; placements only once settled.
   - Cases:
     - a scheduled tournament before start;
     - an active one before round 1, mid-way and late;
     - a completed one with placements;
     - a 2-entrant bracket;
     - a 5-entrant bracket with byes;
     - an insufficient-entrants slot;
     - one where the owner loses early and spectates;
     - a 0-HP tie-break bout.
4. **Camp roles (do last)**, in the camp scene, within the population budget:
   - At display times inside a tournament slot, tournament entrants are visible as **waiting** (staging), **fighting** (their revealed bout in a Task 17 ring, seeked to the display time like Task 17's fixed playback), and **spectating** after elimination (spectator spots around the arena). The champion is marked at the end.
   - Reuse Task 17's rings and seek rule; do not duplicate the arena layout. No combat simulation.
5. **Shared files.** Avi authorized Claude on 2026-10-14 to take Codex's part as well, provided the board is kept updated, so these minimal edits are allowed in this branch:
   - `src/lib/api/fixture-gateway.ts`: `tournament(id)` returns the fixture views; an exported `FIXTURE_TOURNAMENTS` sample list. If the camp needs it, the fixture world gains tournament entrant actors.
   - `src/app/game/page.tsx`: the Tournaments tab renders `TournamentPanel`.
   - `tests/api/fixture-gateway.test.ts`.

   List every such edit in the report; the controller records them on the board. Never change contracts, the live gateway, routes, the scanner or `globals.css`. If the round-1 pairing gap in `TournamentView` blocks a requirement, use the shape-only display and record it as the open contract question, not a contract edit.

## Tests (TDD: write first, watch each fail for the right reason)

- **`tests/domain/tournament-stage.test.ts`:**
  - countdown and next-tournament times across a daylight-saving change (format with an explicit `timeZone` in tests);
  - reveal times for R = 1..6;
  - "Result preparing" before each reveal, and a non-null `revealedResult` before its reveal time staying hidden;
  - roles at each time;
  - byes;
  - insufficient entrants;
  - placements only when settled;
  - the 0-HP winner;
  - purity.
- The fixture generator test, and the fixture gateway test.
- **`tests/browser/tournament.spec.ts`** (desktop and mobile):
  - the plan's Step 1 assertions (before round 1: "Result preparing", no visible winner ids, the checkbox unchecked);
  - mobile bracket navigation;
  - local-time formatting with UTC reference;
  - the late-toggle message;
  - the 1-person fallback explanation;
  - an unavailable round;
  - own loss and spectating;
  - a selected spectator replay;
  - keyboard use; 360 px;
  - no Supabase request and no command other than the opt-in attempt;
  - camp roles through the fixture-only debug hook;
  - screenshots via `testInfo.outputPath`.
- **Before committing:**
  - `npm test`, `npm run typecheck`, `node assets/source/build-assets.mjs --check`;
  - `npm run build`, `npm run verify:static`;
  - the full dev browser suite with `pw-claude.config.mjs` (arena-spec port failures excepted, as noted above);
  - `git diff --check`.

## Commit and report

- Commit `feat: show tournament participation and brackets` with a detailed body; exact paths only.
- Then commit `docs/implementation/task-20-report.md` separately, in the Task 15/17 style:
  - files, interfaces and decisions;
  - every shared-file edit;
  - RED/GREEN, commands and results;
  - curated screenshots in `docs/implementation/task-20-evidence/`;
  - limitations and gates for Tasks 10, 13 and 19 phase 2, and the open `TournamentView` question.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns.
