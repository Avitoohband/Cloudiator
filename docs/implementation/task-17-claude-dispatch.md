# Task 17 dispatch: Arena staging, selection and standings (controller: Claude)

The binding plan and spec text is in `docs/implementation/task-17-brief-base.md`. Read it fully first. Where its shared-types section differs from the current contracts in `supabase/functions/_shared/contracts/`, the contracts win.

## Where and with whom

- **Work only in** `C:\Avi\Studies\Projects\Cloudiator-replay`, branch `claude/task-17`, base `708688b` (the reviewed checkpoint `05b1ea0` plus the Task 14 Minor fix). Record the base in your report.
- Other lanes run in parallel. Never write to, run commands in, reset or commit in:
  - `C:\Avi\Studies\Projects\Cloudiator` (Codex's live checkout; Codex is doing Task 10);
  - `C:\Avi\Studies\Projects\Cloudiator-claude` (Task 15 fix pass);
  - `C:\Avi\Studies\Projects\Cloudiator-arena` (Task 16 backend).
- Never run Supabase commands; Task 17 needs no database. Live data waits for Task 16 (league, pairing, ratings), which another implementer is building.
- Playwright only through `node_modules/.cache/pw-replay.config.mjs` (dev server on **port 3300**). Never ports 3000, 3100 or 3200. First check that its `webServer.env` still matches the repo's `playwright.config.ts`, and fix the private config if not.
- Do not push, merge, edit `HANDOFF.md`, or dispatch subagents. Never print secrets.

## Read first

- `AGENTS.md` (read the relevant `node_modules/next/dist/docs/` guide before writing Next code); `docs/implementation/HANDOFF.md`; the Task 11, 12, 14 reports and reviews; `docs/operations/art-review.md`; `assets/source/README.md`.
- Contracts: `contracts/events.ts` (`RevealedStage`, `RevealedTimeline`, `BattleLog`, `ActivitySummary`), `contracts/reads.ts` (`PublicActor`, `WorldSnapshot`, `PublicProfile`, `StandingRow`, `StandingsPage`, `CursorPage`).
- Domain: `combat.ts` (`makeFighter`, `simulateBattle`), `rules-v1.ts`, `catalog-v1.ts`.
- Game code: `src/game/*`, especially `camp-scene.ts` (actors, depth, occlusion, camera, dispose, the fixture-only test hook), `actors.ts` (the `arena-staging` and `arena-ring` variants, `PAIRED`), `demo-world.ts`, `battle-stage.ts`, `replay.ts`, `GameViewport.tsx`, `bridge.ts`.
- App: `src/app/game/page.tsx` (tabs, fixture path, Sample replays list), `src/app/replay/page.tsx`, `src/lib/api/gateway.ts`, `src/lib/api/fixture-gateway.ts`, `tests/fixtures/battles.ts` (engine-generated fixture logs and their generator test).
- Task 15 is being finished in another branch with a similar pattern (pure stage core, fixtures, route). You may read it read-only with `git -C C:\Avi\Studies\Projects\Cloudiator-replay show claude/task-15-wip:<path>` for ideas; do not merge it or copy whole files.

## The public Arena stage sequence (proposed to Codex for Task 16; mirror it)

Spec §7: stage and warm up during minutes 0–60, reveal the fight log at minute 60, show the completed bout and replay afterwards, grant rewards and rating at minute 80. For one entrant's activity with slot start `S`:

| Stage | kind | revealedAtMs = startedAtMs | endsAtMs | label |
| --- | --- | --- | --- | --- |
| 0 | `staging` | S | S + 60 min | `Warming up` |
| 1 | `bout`, with `battleLog` | S + 60 min | start + `battleLog.durationMs` | `Bout: victory` or `Bout: defeat` by `winnerId` |
| 2 | `return` (zero length) | S + 80 min | S + 80 min | `Results credited` |

- Stage ids are `<activityId>:<index>`. Participant 0 is the entrant. A human opponent keeps its `gladiatorId`; an NPC fallback has `gladiatorId: null` and id `npc:<entrant gladiatorId>`. Both entrants of a human pair carry the same `battleId` in their own timelines.
- No opponent identity, outcome or log before S + 60 min. The owner's `summary` (renown, and `ratingDelta` only for human bouts) only for the owner; spectators never get rewards. Codex's Task 10 adds an optional spectator-safe `completion` field later; you need not use it now.
- If Codex answers on the board with another shape, the controller tells you.

## Controller decisions (binding unless you find a spec conflict, which you must report)

1. **Pure core** in `src/game/arena-stage.ts` (no Phaser, React or engine imports): from a `RevealedTimeline` (or a `PublicActor.visibleStage`) and `displayNowMs`, derive the phase (`warming-up`, `preparing` when minute 60 has passed but no bout is published, `bout` in progress, `completed`, `credited` with an owner summary), the opponent (only after reveal), the NPC disclosure, replay availability, and the result text. Hide every stage with `revealedAtMs > displayNowMs`; no outcome text before the bout's `endsAtMs`; the winner is always `winnerId`, even at 0 HP. Pure and deterministic.
2. **Camp scene** (`src/game/camp-scene.ts` and helpers): bounded simultaneous staging and sparring positions in the arena. Before reveal, arena actors warm up in staging spots (no pairing shown). After reveal, each revealed pair moves to its own ring position, facing each other, and animates its bout from the log, seeked to the display time (the Task 15 encounter playback pattern; no combat simulation). Keep the fights inside the arena wall, depth-correct, readable when several fights run at once (bounded positions; extra pairs queue in staging). NPC opponents appear as a visibly different NPC (the existing NPC tint plus a small marker) and never as another player. Clicking a fighting pair, or a keyboard-equivalent button, emits a bridge event the page uses to open the Arena card. Respect reduced motion, the hidden-tab pause, dispose and the existing camp tests.
3. **UI**:
   - `src/features/arena/ArenaPanel.tsx` (own CSS module): the selected activity's phase (`Warming up`, `Preparing`, the bout, `Completed`), opponent name, class and current rating when known, `NPC opponent — reduced renown, no rating change` for a fallback, a **Watch replay** button to `/replay/?activity=<id>&stage=<stage id>` (keep `mode=fixture` in fixture mode) enabled only after reveal, and, for the owner only, credited renown and rating change from the summary. Never pre-credit a win.
   - `src/features/arena/StandingsPanel.tsx` (own CSS module): paginated league standings (at most 50 rows per page, cursor "More"), with rating, human wins and losses, promoted and inactive markers; separately the owner's rating, renown (owner wallet) and current combat strength (`PublicProfile.combatStrength`, which becomes `number | null` in Task 10; show "not available" for null); and a short league explanation from the spec thresholds (never compute another player's index). Refresh after the boundary from credited results only.
   - Names render as React text; keyboard and 360 px mobile usable; nothing sends commands.
4. **Fixtures, engine-generated as in Task 14/15**, in the new `tests/fixtures/arena.ts` (JSON next to it is fine), with a generator test that rebuilds them with the real `makeFighter`/`simulateBattle` and compares after `JSON.stringify`. Record seeds. Cases: a human pair (both timelines), an NPC fallback (build the fallback from the spec template in §7; note it is a fixture approximation until Task 16's `makeFallback` lands), several simultaneous pairs, a delayed bout (minute 60 passed, no bout stage), a 0-HP tie-break winner, an owner summary (human win 10 renown and an Elo K24 rating delta; NPC win 3 renown, no rating change; losses 2 and 0), and a spectator timeline without a summary. Standings fixture pages for at least two leagues, one with more than 50 rows.
5. **Shared files (owned by Codex).** The controller has asked Codex on the board for: the arena fixture timelines in the fixture gateway's `timeline(id)` lookup, `standings(league)` returning the fixture pages, an exported `FIXTURE_ARENA` sample list, and in `src/app/game/page.tsx` the Standings tab rendering `StandingsPanel` plus an `ArenaPanel` card opened from the camp selection and for the owner's own arena activity. The camp's fixture world also needs arena actors with activity ids and visible stages; that is **not yet requested**. Build everything else first behind small seams, then write down the exact minimal diff you need in each shared file (including any fixture `world()` change) and **stop with status BLOCKED** before touching them, unless the controller has relayed Codex's approval by then. Never change contracts, the live gateway, routes, the scanner or `globals.css`.

## Tests (TDD: write first, watch each fail for the right reason)

- `tests/domain/arena-stage.test.ts`: minutes 0, 59, 60, mid-bout, after the bout, 79 and 80 for human and NPC cases; hidden future stages; `preparing`; no outcome before the bout ends; winner by `winnerId` at 0 HP; owner versus spectator; purity.
- Camp scene layout tests (extend `tests/domain/scene-layout.test.ts` or a new file) for bounded ring positions, facing and pairing.
- The fixture generator test; extend `tests/api/fixture-gateway.test.ts` once the shared edit is approved.
- `tests/browser/arena.spec.ts` (desktop and mobile): the plan's Step 1 assertions; staged, preparing, revealed and completed; several simultaneous fights; NPC and human losses with no lasting injury; selected replay and return; no-result worker delay; keyboard selection; 360 px; reduced motion; no command or Supabase request; screenshots via `testInfo.outputPath`.
- Keep `tests/browser/camp.spec.ts` and the other suites green.
- Before committing: `npm test`, `npm run typecheck`, `node assets/source/build-assets.mjs --check`, `npm run build`, `npm run verify:static`, the full dev browser suite with `pw-replay.config.mjs`, `git diff --check`.

## Commit and report

- Commit `feat: present Arena activity and standings` with a detailed body; exact paths only. Then `docs/implementation/task-17-report.md` (Task 14/15 style: files, interfaces, decisions, every file outside the plan's Files list, RED/GREEN, commands and results, curated screenshots in `docs/implementation/task-17-evidence/`, limitations and gates for Tasks 10, 13 and 16) in a separate commit.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Return

Status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit SHAs, a one-line test summary, concerns, and for BLOCKED the exact shared-file diffs you need.
