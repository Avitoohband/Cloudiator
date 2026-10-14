# Task 17 implementation report: shared Arena staging, selection and standings

Status: **BLOCKED** on the owner's approval of three shared files. Everything in Claude's lane is implemented, tested and committed; the exact shared diff is in `task-17-request-shared.patch` (summary below). It was validated only in a throwaway copy of this branch, never applied to the branch.

- Date: 2026-10-14, Asia/Jerusalem. Owner: Claude (fresh implementer; the controller reviews and integrates).
- Branch: `claude/task-17`, worktree `C:\Avi\Studies\Projects\Cloudiator-replay`. Base: `708688b` (reviewed checkpoint `05b1ea0` plus the Task 14 Minor fix); the controller brief is `95eb764`.
- Commits:
  - `98284aa`: `feat: present Arena activity and standings` (source, fixtures, tests).
  - The next commit: this report, `task-17-evidence/` and `task-17-request-shared.patch`.
- Nothing was pushed or merged. No Supabase command, database, `supabase/**` file, contract, route, scanner, `globals.css` or shared file was changed. No other checkout was written to or had a command run in it (see "Concerns" for one read-only look).

## Delivered behaviour

**Pure Arena core** (`src/game/arena-stage.ts`). From a `RevealedTimeline` (or a `PublicActor.visibleStage`) and the display clock it returns:
- the phase: `warming-up`, `preparing` (minute 60 has passed, no bout published), `bout`, `completed`, `credited` (owner summary visible);
- the entrant and opponent, only once the bout is revealed, with the NPC fallback disclosed (`gladiatorId: null`);
- the bout (log, start, end, display elapsed time) and the replay link (`activityId`, stage id), unless the owner's summary says the log expired;
- the result only from the bout's `endsAtMs`, always by the logged `winnerId` (0 HP tie-breaks included), entrant first;
- the owner's summary only when `owner` is set and `settledAtMs` has passed; `awaitingSummary` after minute 80 without one.

Stages with `revealedAtMs > displayNowMs` do not exist in the state, even when the timeline holds them. While a bout runs, its label reads "Bout in progress", never the published "Bout: victory/defeat". The core is deep-frozen and deterministic and reads no clock or randomness. `arenaRevealMarks` gives minutes 60 and 80 while they can still reveal something.

**Camp** (`src/game/arena-layout.ts`, `src/game/camp-scene.ts`):
- Arena entrants always stage now (`actors.ts`: no random ring pairs before reveal) and play the `practice` warm-up until minute 60, then idle. Ring tiles are kept free of staging.
- `campArenaFights` finds revealed bouts whose fighters are both arena entrants in camp (either timeline suffices, since both carry the battle), or an entrant and its NPC fallback.
- `scheduleArenaRings` gives each fight one of the map's six rings and a window: enter at max(bout start, ring free), walk in (11 s bound, tested against every arena tile), fight from the log, the 2 s replay outro plus a 6 s result hold, then back to staging. Extra pairs queue in staging. A late reveal never moves a running fight (`previous` + `knownAtMs`).
- The scene plays each fight through `battle-stage` (`planStage`/`stageAt`) seeked to the ring window, the Task 15 pattern: poses, hit effects (all fights) and damage labels (only the selected or followed fight, so busy rings stay readable). Reduced motion: no walking, shake or flash.
- NPC fallback opponents walk in through the arena gate as `arena-npc:<battleId>` in the entrant's mirrored gear, neutral NPC grey and an always-visible "NPC" tag; they are never players or roster entries.
- A click on an arena entrant (or its NPC opponent) emits `open-arena`; `GameViewport` lists ring fights as buttons ("Bellator vs Corvina", "Valeria vs Iron Warden (NPC)") that find the pair and emit the same event.
- `GameViewport` reads entrants' timelines once their bout is due (`arenaReadsDue`: minute 60, or at once when the public stage shows a bout; retried every 30 s while missing; never after the slot; none while the tab is hidden), lands a batch together, and shares the display clock.

**Display clock** (`src/game/display-clock.ts`): anchors at the first server time, then only moves forward (a static or slower read never replays reveals); fixture tests can freeze it. The camp and both panels share it when the page passes one.

**Arena card** (`src/features/arena/ArenaPanel.tsx`, CSS module, `arena-text.ts`):
- Opens from `open-arena`, from "Your arena bout" when `OwnerState.currentActivity.kind === 'arena'`, and (fixture) from sample buttons.
- Shows the phase (`Warming up`, `Preparing`, `Bout in progress`, `Completed`), the minute, the opponent's name, class and current rating (public profile; "not available" otherwise) and, for a fallback, exactly `NPC opponent — reduced renown, no rating change`.
- **Watch replay** is a button, disabled until the reveal, that opens `/replay/?[mode=fixture&]activity=<id>&stage=<stage id>`.
- After the bout: Victory/Defeat with how the logged winner won, and for losses "no lasting injury and no gear lost". Only for the owner, only from the summary: "+10 renown / Rating +13", "+3 renown / No rating change", "+2 renown / Rating −13", "No renown / No rating change". Spectators read "Rewards are private to the gladiator's owner." Nothing is credited before minute 80.
- It reads the timeline on open, at the reveal marks, every 30 s while the bout or results are missing, and on focus; then the opponent's profile once. Owner is `viewer id === entrant id` (selection, own activity or sample).

**Standings** (`src/features/arena/StandingsPanel.tsx`, CSS module): league buttons; 50-row pages with **More** (de-duplicated, and stops if a reader ignores the cursor); rank, name, rating, human W–L and You/Promoted/Inactive markers; a separate "Your standing" block with league, rating and renown (owner state) and current combat strength (public profile, `number | null`, "not available"); and a league explanation from the spec thresholds (never another player's index). It re-reads after each slot boundary (credited results only) and on focus.

## Interfaces

- `src/game/arena-stage.ts`: `ARENA_SLOT_MS`, `ARENA_REVEAL_MS`, `ArenaPhase`, `ArenaFighter`, `ArenaVisibleStage`, `ArenaBout`, `ArenaResult`, `ArenaStageState`, `ArenaStageOptions { entrantId?, owner?, startsAtMs? }`, `renderArenaStage(timeline, displayNowMs, options)`, `arenaStageOfActor(actor, displayNowMs)`, `arenaRevealMarks(state)`.
- `src/game/arena-layout.ts`: `ARENA_ENTRY_MS` (11 000), `ARENA_RESULT_HOLD_MS` (6 000), `ARENA_RETRY_MS` (30 000), `arenaRings(map)`, `ringTiles(map)`, `CampFight`, `campArenaFights(actors, timelines, t)`, `RingSlot`, `scheduleArenaRings(fights, rings, { previous?, knownAtMs? })`, `fightStatus(slot, durationMs, t)`, `arenaReadsDue(actors, known, t)`.
- `src/game/display-clock.ts`: `DisplayClock { now, synced, sync, freeze, frozen, subscribe }`, `createDisplayClock(perf?, wall?)`.
- `src/game/bridge.ts`: `'open-arena': { activityId, gladiatorId | null }`, `'arena-fights': { fights: ArenaFightSummary[] }`.
- `CampSceneHandle.setTimelines(map)`; debug state gains `arena { fights, effects, labels }`, actor `kind: 'arena-npc'`, `flip`, `marker`.
- `GameViewport` props: `clock?: DisplayClock`, `timelines?: Pick<GameGateway, 'timeline'> | null`. Fixture hook adds `arenaReads()`, `arenaTimelines()`, `setArenaTimelines(map)`.
- `ArenaPanel({ bridge, reads, owner, world, clock, fixture, samples? })`, `ArenaCardView`, `ArenaReads`, `ArenaSample`, `window.__cloudiatorArena { state, freeze, reads, open }`.
- `StandingsPanel({ reads, owner, clock })`, `StandingsView`, `StandingsReads { standings(league, cursor?), profile? }`, `window.__cloudiatorStandings { reads, league, rows }`.
- Fixtures: `tests/fixtures/arena-ids.ts` (ids, bouts, activities, sample and camp keys), `arena-build.ts` (`buildArenaFixtures(logs)`, `ARENA_SAMPLES`, `ARENA_STANDINGS`, `arenaStandingsPage`, `ARENA_BOUT_RATINGS`; no JSON imports, so specs can use it), `arena.ts` (the committed logs and built `ARENA_TIMELINES`, `ARENA_WORLD_ACTORS`, `ARENA_PROFILES`).

## Fixtures

Twelve logs from the real `makeFighter`/`simulateBattle`; `tests/domain/arena-fixtures.test.ts` re-runs the deterministic first-match seed searches and compares the JSON byte for byte (`UPDATE_ARENA_FIXTURES=1` rewrites; `*.json -text`). Seeds stay in the test.

| Bout | Seed | Shape |
| --- | --- | --- |
| ownerHumanWin | `arena-ownerHumanWin-0` | Aster beats Varro (defeat), +10 renown, Elo +13 (1000 vs 1040) |
| ownerHumanLoss | `arena-ownerHumanLoss-33` | Cassia beats Aster, +2 renown, −13 (1013 vs 990) |
| ownerNpcWin / ownerNpcLoss | `-0` / `-21` | Aster vs her fallback (Iron Warden / Bronze Sentinel): +3 / 0 renown, no rating delta |
| ownerTieBreak | `arena-ownerTieBreak-8` | Mirror builds, both at 0 HP, seeded tie-break names Aster, +15 |
| campOne, campThree, campFour, campFive | `-0`, `-4`, `-5`, `-0` | Current-slot human pairs, 15–21 s |
| campTieBreak | `arena-campTieBreak-16` | Faustina vs Gallus, both 0 HP, Gallus wins |
| campNpcOne / campNpcTwo | `-0` / `-7` | Valeria beats Iron Warden; Stone Gladius beats Cato |

Timelines follow the dispatch table (stage ids `<activity>:0/1/2`, labels `Warming up`, `Bout: victory|defeat`, `Results credited`). Seven owner-or-spectator samples sit in past slots (including `varroSpectator`, the same log from Varro's side, and `ownerDelayed`, a worker delay with no bout). Thirteen current-slot entrants (seven bouts, more than the six rings, plus delayed Ardea) are public camp actors at minute 40 whose visible stage is the warm-up without a log. Standings: bronze 58 rows (two pages), silver 12, gold 3, champion empty; profiles carry the standings rating. NPC fallbacks approximate the spec §7 template until Task 16's `makeFallback`.

## Controller decisions, ambiguities and conflicts

All five decisions are implemented. Where they left room:
1. **"Participant 0 is the entrant" cannot hold for both entrants of a human pair** if both timelines carry the same battle (one engine run has one participant order). The fixtures share one engine log; the core finds the entrant by `entrantId` (falling back to participant 0), so it works whether Task 16 publishes one shared log or per-entrant copies. Codex should confirm the shape.
2. **No cursor in `GameGateway.standings(league)`** although `StandingsPage` has `nextCursor`. `StandingsReads` takes an optional cursor (a `GameGateway` is assignable to it), the fixture gateway implements it, and the panel stops when a reader ignores it. Task 10/16 should add `cursor?: string` to the interface.
3. **The camp projection omits battle logs**, so the camp reads each arena entrant's timeline once its bout is due (at most one per entrant per 30 s while missing). A pairing hint in the projection would avoid those reads.
4. **Queued pairs animate late in camp.** The seventh and later pairs fight when a ring frees; the card and replay keep the logged times. This is presentation only.
5. **Warm-up is `practice`**, the closest existing loop; it grants nothing.

## Files

Plan Files list: `src/features/arena/ArenaPanel.tsx`, `StandingsPanel.tsx`, `tests/browser/arena.spec.ts`; extended camp scene. Gateway standings and replay navigation are the shared request.

Outside that list (all in Claude's lane): `src/game/arena-stage.ts`, `arena-layout.ts`, `display-clock.ts`, `bridge.ts`, `GameViewport.tsx` and `.module.css`, `actors.ts`, `battle-stage.ts`, `demo-world.ts`; `src/features/arena/arena-text.ts` and both CSS modules; the fixture modules and JSON; `tests/domain/arena-stage`, `arena-layout`, `arena-fixtures`, `arena-panels`, `display-clock` tests; additions to `scene-layout.test.ts`, `battle-stage.test.ts` and `tests/browser/camp.spec.ts`.

## Defects found and fixed

- **Camp click targets were offset half an actor up and left.** Phaser adds a container's display origin (13, 23) to hit tests, so `Rectangle(-13, -46, 26, 46)` covered a box above-left of each actor; a body click could select the neighbour (observed: a click on Lucilla's left side selected Gallus). The rectangle is now `(0, -23, 26, 46)`. Regression: camp "selects the gladiator whose body is under the pointer" fails with the old rectangle (selected stayed `npc:smith` at the body centre) and passes now.
- **`npc:` participants** no longer reach the creature lookup or its development warning (part of a deferred Task 14 Minor).
- **The demo crowd** filled 43 in-camp rows from the start of its location list, so the default preview had no merchant browsers; it now fills to 50 rows with a coprime stride over every zone, and keeps out of the arena when the fixture world has its own entrants (whose timelines exist).

## RED and GREEN

1. Fixture generator: failed first (module missing), then with placeholder logs (crash); wrong guessed seeds failed 9 tests; after recording the searched seeds and `UPDATE_ARENA_FIXTURES=1`, 39 pass.
2. Arena core: failed first (module missing), then 12 pass. Mutations: unmasked bout label fails 2; winner by HP fails 1; revealing by start time fails 6.
3. Layout: three mutations (random arena pairs, ring tiles in staging overflow, ignoring `knownAtMs`) each fail a test; the third first passed unnoticed, so the late-reveal test was tightened to leave rings free.
4. Display clock: failed first (module missing), then 3 pass. NPC creature lookup: the new battle-stage test failed (`timber-wolf` returned) before the fix. Demo crowd: the new test failed (missing zones) before the fix.
5. Panels: render tests written after the first component draft (not a module-missing RED); mutations (always-enabled replay, NPC rating text) fail 2 and 1.
6. Browser: the plan's Step 2 RED is recorded below: in this branch the 12 page tests per project fail on the missing Arena section ("Arena bouts" heading), missing fight buttons and an empty fixture arena. The camp-scene tests (8 per project) passed on their first run; screenshots were reviewed. A test-only defect (clicks on fighters off a phone's view) and the click-target defect above were fixed. The Standings notes cell broke row borders (flex `td`) and was fixed after the screenshot review.

## Commands and results (final)

- `npx vitest run`: 438 passed (21 files).
- `npm run typecheck`: tsc, Deno check of both Edge entrypoints, 2 Deno tests pass.
- `node assets/source/build-assets.mjs --check`: up to date (28 files).
- `npm run build`; `npm run verify:static`: 4 fixed routes, 81 assets, no forbidden material.
- `git diff --cached --check`: clean.
- Dev browser suite through `node_modules/.cache/pw-replay.config.mjs` (port 3300), this branch: **125 passed, 24 failed, 5 skipped**. The 24 failures are exactly the 12 Arena card/standings tests on desktop and mobile awaiting the shared patch. One earlier full run had one extra desktop failure in `replay.spec.ts` ("labels the NPC opponent…"), which passed alone (36/36) and in the final run; recorded as a load flake, not fixed.
- **Shared patch validated in a throwaway copy** (`git ls-files -co` of this branch plus `task-17-request-shared.patch`, under the ignored `.next/integrated`, deleted afterwards): `tsc` clean, 440 unit tests, `npm run build` + `verify:static` (4 routes, 81 assets, no forbidden material), and the full dev browser suite **149 passed, 5 skipped** (arena 40/40). To run that copy on the same port, the private config gained an optional `PW_REPLAY_ROOT` (default unchanged). The isolated production gate was not run; Arena tests skip in production by design.

## Evidence (`task-17-evidence/`, from the validated copy)

`desktop-camp-minute-40-warm-up.png`, `desktop-camp-six-simultaneous-fights.png`, `mobile-camp-six-simultaneous-fights.png`, `desktop-card-human-credited.png`, `desktop-card-npc-loss.png`, `desktop-card-worker-delay.png`, `desktop-standings-bronze.png`, `width360-card.png`, `width360-standings.png`. All were captured from the final code (arena spec 40/40 on that copy).

## Shared-file request (`task-17-request-shared.patch`)

Apply with `git apply docs/implementation/task-17-request-shared.patch` (or `patch -p1`); both were checked against `98284aa`. Blank context lines are stored empty so the repository's whitespace check passes; both tools accept that and produce exactly the validated files.

1. `src/lib/api/fixture-gateway.ts`: `FIXTURE_ARENA` (samples with entrant ids); `world()` adds `ARENA_WORLD_ACTORS`; `timeline(id)` adds `ARENA_TIMELINES`; `profile(id)` returns `ARENA_PROFILES`; `standings(league, cursor?)` returns `arenaStandingsPage`.
2. `src/app/game/page.tsx`: one `createDisplayClock()`; keep the fixture gateway in state; pass `clock` and `timelines={fixtureReads}` to `GameViewport`; render `ArenaPanel` in the aside when an owner is visible; the Standings tab renders `StandingsPanel` (live mode reads the live gateway, which reports "not available").
3. `tests/api/fixture-gateway.test.ts`: 14 world actors without battle logs; profile/standings no longer unavailable; two new tests (paired timelines, standings pages and profiles).

## Limitations and gates

- **Task 16:** confirm the stage shape, battle ids, the one-log-per-pair question and the NPC id/name; provide `makeFallback`; ratings, standings and promotion. `ratingDelta` is shown only when present.
- **Task 10:** the live `timeline`, `profile` and `standings` reads; `standings` cursor; `combatStrength: number | null` (accepted already); optional spectator `completion` (unused); a lighter pairing hint in the projection would replace per-entrant reads.
- **Task 13:** own the shared sync clock and world polling (this display clock is the seam); show the camp outside fixture mode; combine `currentActivity` with `processedSlotIndex` for Processing states; a profile card from `select-character`.
- Physical FPS with six fights and 50 actors is a Task 23 measurement, not claimed. Tournament layout (Task 20) still uses its earlier random ring pairs.

## Concerns

- One read-only look outside this worktree: to learn whether the camp projection carries battle logs, I searched (Grep tool, no shell command) Codex's uncommitted `supabase/sql/06-projections.sql` and `contracts` in `C:\Avi\Studies\Projects\Cloudiator`. Nothing there was written or run. Decision 3 above relies on it.
- `arena.spec.ts` is committed with its 12 page tests red in this branch until the patch is applied.
