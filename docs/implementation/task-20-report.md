# Task 20 implementation report: tournament countdown, brackets and visible camp roles

Status: **DONE_WITH_CONCERNS** (concerns at the end: the open `TournamentView` questions; the Task 17 port gate was cleared by the merge `b7f38ad` and the shared request guard). Everything in the dispatch is implemented, tested and committed in this branch; nothing was pushed or merged.

- Date: 2026-10-14, Asia/Jerusalem. Owner: Claude (fresh implementer; the controller reviews and integrates).
- Branch: `claude/task-20`, worktree `C:\Avi\Studies\Projects\Cloudiator-claude`. Task base `7a173b8` (Tasks 15, 16/19 phase 1 and 17 merged); branch head before this work `08998e6` (the controller brief).
- Commits:
  - `c1ff143`: `feat: show tournament participation and brackets` (source, fixtures, tests, the shared edits).
  - `b67a06c`: this report and `task-20-evidence/`.
  - `ffc1e2f`: `fix: apply Task 20 review findings` (the review fix pass below).
  - The next commit: `docs: record Task 20 review fix pass` (this update and the refreshed 360 px screenshot).
- Scope: [task-20-claude-dispatch.md](task-20-claude-dispatch.md) and [task-20-brief-base.md](task-20-brief-base.md).
- Not done, by instruction: no Supabase or Docker command, no push or merge, no `HANDOFF.md` edit, no subagent, no download or package install. The other checkouts (`Cloudiator`, `Cloudiator-replay`, `Cloudiator-arena`) were not touched; no command ran in them. Playwright ran only through `node_modules/.cache/pw-claude.config.mjs` (port 3200).

## Delivered behaviour

**Pure core** (`src/game/tournament-stage.ts`). No Phaser, React or engine import (it imports `isTournamentSlot` from `@domain/tournament`; the production build tree-shakes the engine away, checked below). Given a `TournamentView` and the display clock:
- **Next tournament:** `nextTournament(t)` is the first slot after `t` for which `isTournamentSlot` holds (Wednesday and Saturday 17:20 UTC), with its countdown; `tournamentWindowAt(t)` is the tournament running now; `latestTournament(t)` the running or most recent one (the live default).
- **Status:** `scheduled` before the start; `insufficient-entrants` from the view; `active` within the slot; `processing` when a due round is unpublished, when the view says so, or when minute 80 has passed without placements; `completed` once the view is settled.
- **Bracket shape:** next power of two, rounds and byes from the entrant count, shown from the start only (before it, no entrants or shape show, even if the view holds them).
- **Reveals:** round r of R at `start + ceil(80 min × r / (R + 1))`, as Task 19 computes it. A bout's result shows only when the view carries a well-formed `revealedResult` **and** the display clock has reached its round's reveal time. A fought bout then plays for its logged duration (`fighting`) before its winner shows (`decided`); byes advance at round 1 with no fight. Before its reveal a bout is `preparing` ("Result preparing"); due without a published result it is `delayed`. A result whose winner is not a participant or disagrees with its log is never shown; its participants may list the log's two gladiators in either order (review fix 7), anything else fails closed.
- **Winners and roles:** the winner of every shown bout is `winnerId` (a seeded tie-break with both fighters at 0 HP included). Each entrant's role: `waiting`, `fighting` (with its bout), `spectating` (with its elimination round) or `champion` (the final's winner once it has ended).
- **Later rounds:** sides are named from the winners already shown; round 1 pairings stay hidden until their reveal (see "Open questions").
- **Placements:** only when the status is `completed`; place and public name only. The viewer's own credited summary is returned separately, never anyone else's.
- **Reveal marks:** the start, each round's reveal and the settlement still ahead, for re-reads.
- Deep-frozen output; the caller's view is untouched; revealed logs are shared by reference; no clock, randomness or browser state.

**Tournaments panel** (`src/features/tournaments/TournamentPanel.tsx`, its CSS module and `tournament-text.ts`), in the "Tournaments" tab:
- **Schedule:** the next tournament in the viewer's time zone with the UTC time beside it (`Wed 28 Oct, 18:20 GMT+1 (Wed 28 Oct, 17:20 UTC)`; a UTC+0 viewer sees one UTC time), the countdown, and a "running now" line during a tournament.
- **Registration:** an "Automatically enter tournaments" checkbox showing `OwnerState.tournamentOptIn`. Toggling sends `set-tournament-opt-in` through the gateway, reusing the operation id on transient failures. The box always shows the saved setting; in fixture mode the command is refused, the note reads "Registration changes are unavailable in this preview. Your setting is unchanged." and the box stays as it was. Rules: entry needs automatic entry on, Arena scheduled for the afternoon and at least 25 stamina at the 17:20 UTC cutoff; opting out keeps a normal Arena bout; a change after a cutoff applies from the next tournament; fewer than two qualifiers fight regular Arena; one stamina charge; full health per bout; the eliminated stay to spectate. A contextual note says which tournament a change made now applies to, and during a tournament that its entries were fixed at the cutoff. The owner's checklist shows the setting, the afternoon schedule ("Expedition: Woodland Path (not Arena)") and current stamina.
- **Bracket:** league and start time, status and its meaning, the viewer's own line ("You are entered…", "You advance…" only after a shown win or bye in every due round, "Your Quarterfinals result is not published yet…" while the viewer's due result is unpublished (review fix 1), "You were eliminated in the Quarterfinals. You stay in the tournament as a spectator until it ends at …; this slot has no other activity for you.", "You are the champion…"), the champion, the shape (`8-slot bracket · 3 rounds · 3 byes`), the entrants with their roles, and rounds as tabs (Quarterfinals, Semifinals, Final; `role="tablist"`, roving tabindex, arrow keys, Home and End; a horizontal scroller on phones). The round panel has one status line ("Result preparing", "Bouts in progress", "Results revealed"), a reveal or delay note, and bout cards (sides, "Bout in progress", "Winner: …" with how it was won, "… advances on a bye", "Not published yet"). Placements after settlement show place and name only, plus the viewer's own "Credited: +7 renown." Names render as React text.
- **Replays:** a completed bout's "Watch replay" opens the existing `BattleReplay` inline with its revealed log (no `/replay/` link: the public view has no activity id), its title at h6 under the card's h4 and the replay section's h5 (review fix 4). On phones (≤ 540 px) the replay runs to the card's edges, so its fighter table keeps whole words (review fix 3).
- **Reads:** on open, at each reveal mark, every 30 s while processing, every 30 s while a first read has failed (visible tab only, review fix 6), and on focus. Fixture mode lists the samples; live mode opens the owner's league tournament of the running or latest slot (`tournamentIdFor`; the live gateway still says unavailable).
- **Fixture samples** (review fix 8): each sample carries the server time its view was projected at (`asOfMs`); opening one holds its bracket card there, so "before round 1", "mid-way" and "late" show what their labels say. The schedule, registration, camp and Arena keep the running clock; the test hook's `freeze` releases the hold.
- Fixture-only hook `window.__cloudiatorTournaments { state, freeze, reads, commands, open }`.

**Camp roles** (`src/game/tournament-camp.ts`, additive edits to `camp-scene.ts`, `GameViewport.tsx`, `actors.ts`):
- Tournament entrants (public location `tournament`) wait in the arena staging spots: `actors.ts` no longer gives them random ring pairs.
- **Fighting:** `campTournamentFights` turns each shown bout of two camp entrants into Task 17's `CampFight` (participant 0 on ring side a, starting at the round's reveal time). The scene merges them with the Arena fights, so they share the six rings through `scheduleArenaRings`, walk in, play from the log through `battle-stage` seeked to the ring window, hold the result and walk out. No second layout and no simulation; no NPC is ever added.
- **Spectating:** an eliminated entrant walks to a spectator spot outside the arena wall: 62 walkable tiles 0.6–2.6 tiles beyond the wall before NPC posts are removed (at least 49 are tested), none on a station, NPC post, another zone or the gate approach; sides first, facing the arena. Spots are assigned by elimination round, then id, so earlier spectators never move; world updates leave them in place.
- **Champion:** a gold "Champion" tag once the final has ended **and** its ring has finished playing it (no bout of the champion queued, walking in or fighting; review fix 2). The camp starts a bout after its walk-in, so the tag follows the stage core's decision by about the walk-in time.
- **Population:** no actor is added; tournament bouts are not listed among the "Arena bouts in the rings" buttons (they have no Arena card).
- **Reads:** `GameViewport` (new optional `tournaments` reader) reads each camp entrant's tournament during its slot: once, after each reveal mark, and every 30 s while a read failed or a due round is unpublished; paused in hidden tabs. Fixture hook additions: `tournamentReads()`, `setTournaments(views)`; debug state `tournament { roles, champion, spectators }`.

## Interfaces

- `src/game/tournament-stage.ts`: `TOURNAMENT_DURATION_MS`, `TournamentWindow`, `NextTournament`, `tournamentWindowAt(t)`, `nextTournament(t)`, `latestTournament(t)`, `roundRevealTimes(start, rounds)`, `BracketShape`, `bracketShape(n)`, `tournamentIdFor(slot, league)`, `TournamentRole`, `TournamentStatus`, `TournamentBoutState`, `TournamentRoundState`, `TournamentEntrantState`, `TournamentPlacementState`, `TournamentStageState`, `renderTournament(view, t, { viewerId? })`, `tournamentRevealMarks(state)`.
- `src/game/tournament-camp.ts`: `TOURNAMENT_RETRY_MS`, `tournamentIdOfActor`, `mergeCampFights`, `campTournamentFights(actors, views, t)`, `CampTournamentRole`, `campTournamentRoles(actors, views, t)`, `SpectatorSpot`, `spectatorSpots(map, reserved)`, `assignSpectators(spectators, spots)`, `TournamentRead`, `tournamentReadsDue(actors, known, t)`.
- `src/features/arena/BattleReplay.tsx` (review fix 4): `HeadingLevel`; `BattleReplay({ view, bridge?, headingLevel? })`, default 1.
- `src/features/tournaments/TournamentPanel.tsx`: `TournamentReads`, `TournamentSample` (`{ id, label, asOfMs? }`), `TournamentTestHook`, `TournamentScheduleView`, `RegistrationModel`/`RegistrationView`, `BracketModel`/`TournamentBracketView`, `TournamentPanel({ reads, owner, clock, fixture, samples?, refresh? })`.
- `src/features/tournaments/tournament-text.ts`: `tournamentTimeText(ms, timeZone?)`, `timeWithUtc`, `countdownText`, `CUTOFF_UTC`, `ENTRY_STAMINA`, `ENTRY_RULES`, `registrationNote`, `afternoonText`, `statusText`, `statusDetail`, `shapeText`, `roundStatus`, `roundNote`, `victoryText`, `roleText`, `ordinal`, `creditedText`, `viewerText`.
- `CampSceneHandle.setTournaments(map)`; `CampDebugState.tournament`; `GameViewport` prop `tournaments?`; `CampTestHook.tournamentReads()`/`setTournaments(views)`.
- Fixtures: `tests/fixtures/tournament-ids.ts` (cases, ids, looks; no JSON), `tournament-build.ts` (`projectTournament`, `scheduledView`, `insufficientView`, `tournamentCampActors`; domain types only), `tournaments.ts` (`TOURNAMENT_VIEWS`, `TOURNAMENT_VIEWS_BY_ID`, `TOURNAMENT_SAMPLES` with `asOfMs`), `tournaments/*.json`.

## Fixtures

Each case is its own tournament slot, built with the real Task 19 domain (`buildBracket` with a placement seed, `readyBouts`, `runBout` with an explicit recorded seed per bout, `recordBout`, `tournamentOutcomes`) and projected at its server time. `tests/domain/tournament-fixtures.test.ts` re-runs the deterministic first-match seed searches and compares each committed JSON byte for byte (`UPDATE_TOURNAMENT_FIXTURES=1` rewrites; `*.json -text`). The builds are the Arena fixtures' builds; seeds stay in the test.

| Case | Slot (17:20 UTC) | Entrants | Projected at | Shape |
| --- | --- | --- | --- | --- |
| `upcoming` | Sat 10 Oct | none yet | before the cutoff | `scheduled`, no entrants or bouts |
| `opening` | Wed 7 Oct | 8 incl. Aster | minute 5 | before round 1, no result |
| `midway` | Sat 3 Oct | 5 | minute 45 | three byes; rounds 1 and 2 revealed; the final not yet |
| `late` | Wed 30 Sep | 8 | minute 75 | every round revealed, placements pending |
| `completed` | Sat 26 Sep | 8 incl. Aster | minute 85 | Aster loses round 1 (seed n = 1), Varro wins; placements |
| `pair` | Wed 23 Sep | Aster, Severus | minute 85 | one-round final, both at 0 HP, seeded tie-break to Aster (n = 16) |
| `insufficient` | Sat 19 Sep | Valeria (Gold) | minute 85 | `insufficient-entrants`, no bracket |

The projection whitelist (`projectTournament`): `id`, `league`, `slotIndex`, `startsAtMs`, `endsAtMs`, `status`; entrants (`gladiatorId`, `name`, `classId`) sorted by name, never in the private seeded rank order; bouts (`id`, `round`, `position`, `parentBoutIds`, `revealedResult` only from the round's reveal time: participants, `winnerId`, `bye`, the log for a fight); placements only once settled, with an `ActivitySummary` (no `ratingDelta`, no grant). A test walks every key outside the battle logs and rejects seeds, ratings, ranks, fighter snapshots and grants, and checks no bout carries an activity id.

## Controller decisions and how they were resolved

All five decisions are implemented. Where they left room:
1. **`isTournamentSlot` and "no engine imports".** The function lives in `tournament.ts`, which imports the combat engine. The core imports only that function; `npm run build` then contains none of the engine's or the tournament graph's strings (`Invalid private combat snapshot`, `Invalid battle input`, `Invalid tournament graph`: 0 files in `out/`), so the bundle carries no engine. The purity test forbids direct Phaser, React, combat and Arena imports.
2. **Reveal-time gating plus fight duration.** A revealed fought bout shows "Bout in progress" for its logged duration and names its winner after it, as Task 17 does for Arena; this is stricter than the dispatch's two conditions, never looser. Replays open only for completed bouts.
3. **"Result preparing" once per round.** The plan's Step 1 locator (`getByText('Result preparing')`) needs exactly one match, so the round panel carries the single status line and only the selected round renders.
4. **Fixtures as separate tournaments.** The fixture gateway has no clock, and a view has no server time, so "before round 1", "mid-way" and "late" are three tournaments, each projected at its own time. Viewed later, a partial view honestly shows its missing rounds as processing; since the review fix pass the preview opens each sample at its own projection time (fix 8).
5. **Placement summaries.** The contract's `placements[].summary` is a full `ActivitySummary`; the fixtures fill it from the outcome without the rating delta, and the core and panel show rewards only for the viewer's own placement (the role-safe DTO is open, below).
6. **Live tournament id.** `tournamentIdFor(slot, league)` uses the Task 19 graph id, which the fixture views keep; the live gateway is unchanged and still unavailable.
7. **Spectator spots.** The map has no spectator stations, so `spectatorSpots` derives them from the arena circle; no asset changed.
8. **Late camp knowledge.** A bout the camp learns after its reveal plays from then, Task 17's ring rule (a running fight is never moved). With the 1 s check and the reveal-mark reads this should lag by about a second (expected, not measured); the panel keeps the logged times.

## Shared-file edits (to record on the board)

Under Avi's 2026-10-14 authorization (dispatch decision 5):
1. `src/lib/api/fixture-gateway.ts`: imports the tournament fixtures; exports `FIXTURE_TOURNAMENTS`; `tournament(id)` returns a copy of the fixture view for its id, every other id stays unavailable.
2. `src/app/game/page.tsx`: imports `TournamentPanel`; keeps the fixture sample list; the Tournaments tab renders `TournamentPanel` (live mode passes the live gateway and `refreshPlanning`); `GameViewport` gets `tournaments={fixtureReads}` in fixture mode.
3. `tests/api/fixture-gateway.test.ts`: one new test (views by id as copies, unknown ids unavailable, the opt-in command refused with the owner's flag unchanged).

No contract, live gateway, route, scanner or `globals.css` change. Edits to Task 17's files under its fix pass are additive: `camp-scene.ts` (+63/−7: tournament fights merged into the ring schedule, a spectator skip in `applyWorld`, `placeTournamentEntrant`, `setTournaments`, debug state, tournament bouts left out of the Arena fight buttons) and `GameViewport.tsx` (+48/−3: the reader prop, its effect and the hook). `arena-layout.ts`, `ArenaPanel.tsx`, `StandingsPanel.tsx` and `arena.spec.ts` are unchanged. `actors.ts` (Task 12) changes one line.

Review fix pass (`ffc1e2f`), to record on the board as well:
4. `src/lib/api/fixture-gateway.ts`: the `FIXTURE_TOURNAMENTS` type gains `asOfMs` (the samples' projection times); nothing else.
5. `src/game/camp-scene.ts` (Task 17, still additive, +8/−4): `updateArena` collects the fighters whose ring bout is queued, walking in or fighting, and `placeTournamentEntrant(v, now, inRing)` shows the champion tag only when that is false.
6. `src/features/arena/BattleReplay.tsx` and `BattleReplay.module.css` (Task 14, Claude-owned): the optional `headingLevel` prop (default 1) and heading selectors that match any level (the same rules for h1 and h2, so the replay route renders as before; `replay.spec.ts` unchanged and green).

`src/app/game/page.tsx` and `tests/api/fixture-gateway.test.ts` were not changed in the fix pass.

## RED and GREEN

Each cycle wrote its tests first, except where stated. Unit runs used `npx vitest run <file>`; browser runs used the private config.

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| Fixture generator | `Cannot find module '../fixtures/tournaments.ts'`; then the JSON imports were missing; with placeholder `{}` views, **10 failed / 5 passed of 15**: the empty seed table (the diff listed the 26 searched seeds), every view differing, and the `pair` placements (Severus won under seed n = 0). | Seeds recorded, `UPDATE_TOURNAMENT_FIXTURES=1`, then **15/15**. |
| Core | I wrote the module before running the new test, so the module-missing RED was shown afterwards by moving the two new files aside: `Cannot find package '@/game/tournament-stage'`. First run: **16/17**; the failure was my test (two bye receivers had already lost in round 2 at minute 45), moved to minute 30. | **17/17**. |
| `latestTournament` | **1 failed / 17 passed**: `latestTournament is not a function`. | **18/18**. |
| Fixture gateway | **1 failed / 11 passed**: `expected undefined to deeply equal [...]` (no `FIXTURE_TOURNAMENTS`, views unavailable). | **12/12**. |
| Panel | `Cannot find package '@/features/tournaments/TournamentPanel'`. First run **10/11**: my expectation said "Sep"; en-GB writes "Sept". | **11/11**. |
| Camp layout core | `Cannot find package '@/game/tournament-camp'`. | **8/8**. |
| Staging only | **1 failed / 8 passed**: `expected 'arena-ring' to be 'arena-staging'` (the old random ring pairs). | `actors.ts` one line; **9/9**, and `scene-layout.test.ts` unchanged (43 together). |
| Browser, panel | Written after the panel, so the plan's Step 2 RED ("missing presentation") was not observed. First run **6 passed / 14 failed**: Chrome's ICU writes UTC+0 as `GMT+0` where Node writes `GMT` (fixed in `tournament-text.ts`, with a Europe/London unit case); `name: 'Final'` also matched the other tabs (test: `exact`); the pair final lists Severus first (test). Then **18/20**: `dt`/`dd` text has no space between them (test). | **20/20**. |
| Browser, camp roles | Written after the scene edit. First run **4 passed / 4 failed**, both my tests: a 10.2 s bout is already decided at reveal + 12 s, and jumping from minute 30 to 79 makes the camp learn rounds 2 and 3 late (decision 8). Checked roles at + 5 s and stepped the clock through the reveals. Against the base `camp-scene.ts` all four time out (it lacks `setTournaments`, so the camp never starts): a crash, not counted as behavioural RED. | **8/8**. |

**Mutation checks** (each applied, run against the owning file, then restored and compared with `cmp`):

| Mutation | Result |
| --- | --- |
| Core: results shown without waiting for the round's reveal time | 3 of 17 failed |
| Core: reveal times rounded down | 1 failed |
| Core: winner shown at the reveal (no fighting window) | 2 failed |
| Core: placements shown before settlement | 1 failed |
| Core: malformed results accepted | 1 failed |
| Core: bye receivers counted as eliminated | 2 failed |
| Core: entrants shown before the start | 1 failed |
| Panel: box enabled while a change is being sent | 1 of 11 failed |
| Panel: a running tournament's toggle treated as before the cutoff | 1 failed |
| Panel: replay offered for a bout still being fought | **survived**; the test now asserts no replay or winner tag while fighting, and it fails 1 |
| Panel: a winner tag while fighting | **survived**; fixed by the same assertion, now fails 1 |
| Scene: tournament bouts left out of the ring schedule | 2 of 4 camp tests failed |
| Scene: no spectator placement | 2 failed |
| Scene: world updates pull spectators back (no `applyWorld` skip) | 1 failed |

## Review fix pass (2026-10-14)

An independent review passed code quality and visuals but failed the specification on two Important defects, with seven minor items. All were fixed in `ffc1e2f`, each test written first and watched failing; "fix reverted" means the fix was set aside for the RED run and restored (compared with `cmp`).

| # | Finding | Fix | RED (observed) | GREEN |
| --- | --- | --- | --- | --- |
| 1 (Important) | `viewerText` told an entrant "You advance." while their due bout was unpublished. | "You advance" only after a shown win or bye in every due round; otherwise "Your <round> result is not published yet. It appears here as soon as it is revealed." | Unit: `opening` at minute 25 as Aster rendered "You advance. Your next bout is revealed at Wed 7 Oct, 18:00 UTC." Browser case (fix reverted): the same text on desktop and mobile. | Unit 12/12 (also Varro and a bye receiver advancing, both mid-way finalists waiting on the unpublished final, a bout in progress); the browser case passes on both projects. |
| 2 (Important) | The camp tagged the champion when the core decided the final, while its ring was still fighting. | `placeTournamentEntrant` also needs no ring bout of the entrant queued, walking in or fighting. | New camp test at final reveal + 14 716 ms + 1 s: ring `fighting`, yet Varro carried the marker (desktop and mobile). | No marker while the ring fights; only Varro's once it shows the result. The minute-79 champion test still passes. |
| 3 | 360 px replay table split "Endurance" and "Equipment". | At ≤ 540 px the replay runs to the card's edges (`margin-inline: -0.5rem`) and `.brackets` padding is 0.35rem. | A new no-split-word check in the 360 px test failed on both projects. | Passes on both; a probe measured the narrowest slack at 5.1 px ("Equipment") and 7.2 px ("Endurance"). Screenshot refreshed. |
| 4 | `BattleReplay` rendered its own `h1` inside the panel. | Optional `headingLevel` (default 1); sections take the next level (at most h6); the panel uses 6. | Unit: the card's headings included an h1 title and h2 sections. | Unit: h4 card, h5 Entrants and Replay, h6 title, Result, Fighters and Combat log; a standalone replay still h1/h2; `replay.spec.ts` unchanged and green. |
| 5 | The core restates Task 19's private bracket frame and id format. | Cross-check test against the real `buildBracket` for 2 to 64 entrants across the four leagues: reveal times, size, rounds, byes, tournament id, settlement and each bout's id, round and reveal time. | Passes on the current core (a guard). Mutations fail it: id format (n = 2), reveal times rounded down (n = 33), byes off by one (n = 3). | 20/20 in `tournament-stage.test.ts`. |
| 6 | A failed first read was retried only on focus. | Every 30 s while `failure && !view`, visible tab only. | With the interval disabled: no read 30.5 s later (2, expected 3), desktop and mobile. | Reads at 30 s and 60 s, none over 65 s in a hidden tab, one again once visible (Playwright `page.clock`). |
| 7 | `wellFormed` required the result's participants in the log's order. | Set equality of the two gladiator ids; still fails closed on another entrant, a repeated fighter, one or three fighters, or a duplicate. | Swapped order rendered `delayed` with no winner. | `decided` with the logged winner, sides in the result's order. Mutations dropping the distinct-ids or the length check each fail the new test. |
| 8 | Under the running preview clock, `opening`, `midway` and `late` all read "Processing results". | Samples carry `asOfMs`; opening a sample holds its bracket card there (fixture only). The browser helper now opens a sample before setting the clock. | Unit: samples had no `asOfMs`. Browser: `opening` showed "Processing results", expected "In progress" (both projects). | Each sample shows its label's state (In progress ×3, Completed ×2, Not held, Scheduled) and stays held; the hook's clock still overrides. |
| 9 | Spec §11 expired replays. | Recorded as a Task 22 gate (below); no code change. | — | — |

The hold in fix 8 is scoped to the bracket card rather than the shared display clock: freezing the shared clock at a past sample time would also move the camp and the Arena samples (whose server-time sync a frozen clock ignores) to that day.

## Commands and results (final)

All on the final source (`ffc1e2f` content), in this worktree:
- `npm test`: 32 files, **843 passed** (838 before the fix pass; baseline before this task: 28 files, 784).
- `npm run typecheck`: **exit 0** (tsc, frozen Deno check of both Edge entrypoints, 2 Deno runtime tests).
- `node assets/source/build-assets.mjs --check`: up to date (28 files).
- `npm run build`, then `npm run verify:static`: 5 fixed routes, 91 assets, no forbidden backend material. A grep of `out/` for `Invalid private combat snapshot`, `Invalid battle input`, `Invalid tournament graph`, `fixture-season` and a fixture slot id found 0 files: no engine and no fixture data in the export.
- `git diff --check` and `git diff --cached --check`: clean (only the configured LF-to-CRLF notices).
- Full development browser suite through `pw-claude.config.mjs` (port 3200), desktop and mobile: **225 passed, 6 failed, 7 skipped** of 238 (before the fix pass: 217/6/7 of 230). The 6 failures are exactly the known `arena.spec.ts` page tests at lines 273, 287 and 407 on both projects; each fails at `expect(remote).toEqual([])` (spec lines 284, 306 and 430) listing only `http://127.0.0.1:3200/...` URLs (the spec allows port 3300 until Task 17's fix is merged). `tournament.spec.ts` passed 36/36 inside this run.
- Not run: the isolated production gate (the tournament tests skip in production by design) and anything needing Supabase or Docker.

## Evidence (`task-20-evidence/`)

All from the final full browser run (`testInfo.outputPath`), copied unchanged; `width360-bracket-replay.png` was refreshed from the fix pass's full run (mobile project), the others are from the first run:

| Image | Shows |
| --- | --- |
| `desktop-before-round-1.png` | The plan's Step 1: a view holding every result, one second before round 1: "Result preparing", "To be revealed" cards, no winner, everyone waiting. |
| `desktop-spectator-replay.png` | The owner eliminated and spectating at minute 79; the champion; entrant roles; the final replayed inline, seeked to its end (no rewards). |
| `desktop-placements.png` | Minute 85: placements by place and name, and only the owner's "Credited: +7 renown." |
| `mobile-byes-midway.png` | Five entrants: three byes, round tabs on a phone. |
| `desktop-unavailable-round.png` | A due final not yet published: "Processing results", "Result preparing" and the delay note, its sides from the semifinal winners. |
| `desktop-one-entrant.png` | One qualifier: "regular Arena this slot". |
| `desktop-local-time-new-york.png` | The schedule in America/New_York after the daylight-saving change, with the UTC time beside it. |
| `width360-registration.png`, `width360-bracket-replay.png` | 360 px phone: registration, rules and checklist; the bracket with an inline replay running to the card's edges, every fighter-table word whole, no horizontal scroll. |
| `desktop-camp-round-1.png` | The camp at round 1: four tournament bouts in the rings, effects from the logs. |
| `desktop-camp-spectators.png` | Minute 30: the four first-round losers outside the wall, the winners waiting in staging. |
| `desktop-camp-champion.png`, `mobile-camp-champion.png` | Minute 79: seven spectators around the wall and the champion's tag. |

## Files

Plan Files list: `src/features/tournaments/TournamentPanel.tsx`, `tests/browser/tournament.spec.ts`; extended camp scene, bridge (the `GameViewport` host and hook; `bridge.ts` itself needed no change) and gateway.

Outside that list: `src/game/tournament-stage.ts`, `src/game/tournament-camp.ts`, `src/features/tournaments/TournamentPanel.module.css`, `src/features/tournaments/tournament-text.ts`, `src/game/actors.ts` (one line); the fixture modules and JSON; `tests/domain/tournament-stage`, `tournament-fixtures`, `tournament-panel` and `tournament-camp` tests.

## After merging Task 17's fixes (controller, 2026-10-14)

Merge `b7f38ad` brought Task 17's review fixes into this branch. That pass and its follow-up changed the ring timing. The camp now plays every bout at its real time: a jog walk-in of about 4 s, then the log seeked to `displayNow − bout.startedAtMs`, so the ring, the card and the Tournaments panel reach the result together. Statements earlier in this report about pairs "walking in", a ring "still fighting" after the decision, or the camp playing a bout "from the moment it learns of it" describe the timing before that merge.

- The champion tag lags the panel while the final is queued or its pair is still jogging in, and otherwise by up to about 1 s (`ARENA_REFRESH_MS`); it never appears early. `tests/browser/tournament.spec.ts` was adapted for this.
- Tournament camp fights carry `endsAtMs` equal to the stage core's `fightEndsAtMs`.
- After the merge: `npm test` 856 passed; typecheck, the asset check, build and `verify:static` passed; the full dev browser suite on port 3200 gave 254 passed, 0 failed, 8 skipped.

## Limitations and gates

- **Task 19 phase 2:** the views, opt-in RPC, stages and settlement; publish the live lookup of a league's tournament for a slot (this branch assumes the graph id); answer the open questions below.
- **Task 10:** the live `tournament()` read and `set-tournament-opt-in` in the live gateway (today "unavailable"); world polling that moves entrants to location `tournament` during their slot.
- **Task 13:** own the shared sync clock (the panel and the camp each poll tournaments today) and show the camp outside fixture mode. A confirmed toggle already re-reads the owner through `refreshPlanning`.
- **Task 22 gate (spec §11, expired replays):** a decided bout whose `revealedResult` has no `battleLog` (the log expired) shows its winner but no "Watch replay" button and no "replay no longer retained" note. Task 22 should add that note (and decide its wording) wherever a decided tournament bout lacks its log; nothing in this branch tests an expired tournament log.
- At 360 px the replay's fighter table now keeps every header word whole with about 5 px to spare ("Equipment"). Its value cells use Task 14's fixed layout, so an unusually long word there (for example a rarity such as "uncommon)," in a gear name) could still wrap mid-word at that width; the fixtures carry only common gear.
- Physical FPS with tournament fights and spectators is a Task 23 measurement, not claimed.

## Open questions

- **`TournamentView` round 1 pairing (Task 19 phase 1 review M7).** Unchanged contract: before round 1 reveals, the panel shows entrants and shape only ("Pairings are revealed with the round"). If the contract later publishes the placement at start, the core can name round 1 sides from it.
- **Role-safe placements.** `placements[].summary` is a full `ActivitySummary` (rewards, receipt) for every entrant in a public view; the UI shows only the viewer's own. Phase 2 should reduce it to place and identity, with rewards owner-only.
- **Server time on the view.** `TournamentView` has no `serverNowMs`, so a client cannot tell a stale view from a delayed round; the panel re-reads at marks and every 30 s while processing.
- **Tournament id lookup** (above) and whether placement summaries carry entrants' activity ids.

## Integration checklist (for Codex)

- Live readers: the Tournaments tab gets the live gateway for the opt-in command, whose `tournament()` read is the `unavailable` stub. Live mode therefore says brackets "cannot be loaded right now" and retries every 30 s. When Task 10 or Task 19 phase 2 builds the read, it works as is. Until then, consider the Task 17 pattern: a separate bracket reader that is null in live mode, so the panel says "not available in this build yet".
- Deferred minors: forget `tournamentViews` entries whose entrants left the world (`GameViewport.tsx`, like Task 17's `forgetLeft`); add a browser test that a tournament ring and the panel change over at the same moment; remove the unreachable "You advance. Your next result is being prepared." branch (`tournament-text.ts`).
- Run the isolated production gate with the repo's `playwright.config.ts`.

## Concerns

- Resolved: the 6 `arena.spec.ts` port-3300 failures are gone since the merge `b7f38ad`. The final re-review found the same hard-coded-port guard in `tournament.spec.ts`. Both specs now use one shared guard, `tests/browser/remote.ts`, which takes the test's `baseURL`. A new guard test failed on the old code for a 3100 origin.
- The open `TournamentView` questions above (round 1 pairing, role-safe placements, no server time, the id lookup) are recorded, not decided; no contract changed.
- The plan's Step 2 RED for the browser suite and the camp tests' RED were not observed as written (both specs followed the code); the unit cycles, the observed browser failures and the behavioural mutations above stand in for them.
- Superseded by the merge `b7f38ad`: the camp now plays every bout at its real time (see "After merging Task 17's fixes"). The champion tag waits for the ring, so it can follow the panel while the final is queued or its pair is still jogging in, and otherwise by up to about 1 s (roles are recomputed once a second).
- Fix 5's cross-check passed on the existing core, so its RED is the three mutations, not a failing first run.
- Fix 6's first browser run failed for a test reason (the panel was remounted when the owner loaded under the installed fake clock); the test now waits for the owner, and its behavioural RED was then observed with the interval disabled.

No reusable skill change is proposed: the TDD, verification and project guidance already cover this work.
