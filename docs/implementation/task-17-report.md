# Task 17 implementation report: shared Arena staging, selection and standings

Status: **DONE.** The implementer stopped, as briefed, before the three shared files. On 2026-10-14 the controller applied the exact patch `task-17-request-shared.patch` to this branch. That was under Avi's instruction that Claude may take Codex's part, and it was recorded on the board at 07:36 IDT; Codex reviews the edits at integration. The original BLOCKED text is kept below for the record: **BLOCKED** on the owner's approval of three shared files. Everything in Claude's lane is implemented, tested and committed; the exact shared diff is in `task-17-request-shared.patch` (summary below). It was validated only in a throwaway copy of this branch, never applied to the branch.

- Date: 2026-10-14, Asia/Jerusalem. Owner: Claude (fresh implementer; the controller reviews and integrates).
- Branch: `claude/task-17`, worktree `C:\Avi\Studies\Projects\Cloudiator-replay`. Base: `708688b` (reviewed checkpoint `05b1ea0` plus the Task 14 Minor fix); the controller brief is `95eb764`.
- Commits:
  - `98284aa`: `feat: present Arena activity and standings` (source, fixtures, tests).
  - `88e2e58`: this report, `task-17-evidence/` and `task-17-request-shared.patch`.
  - `1f01531`: the controller applied the shared patch (fixture gateway, game page, fixture gateway test).
  - `e3392fb`: `fix: apply Task 17 review findings`; the next commit records that pass here ("Review fix pass").
  - `6df1b78`: `fix: jog into Arena rings and polish Task 17 follow-ups`; the next commit records it here ("Follow-up fix pass").
- Nothing was pushed or merged. No Supabase command, database, `supabase/**` file, contract, route, scanner or `globals.css` was changed. The three shared files were changed only by the controller's patch (`1f01531`) and, as listed under "Review fix pass", by the review fixes. No other checkout was written to or had a command run in it (see "Concerns" for one read-only look).

## Delivered behaviour

**Pure Arena core** (`src/game/arena-stage.ts`). From a `RevealedTimeline` and the display clock it returns:
- the phase: `warming-up`, `preparing` (minute 60 has passed, no bout published), `bout`, `completed`, `credited` (owner summary visible);
- the entrant and opponent, only once the bout is revealed, with the NPC fallback disclosed (`gladiatorId: null`);
- the bout (log, start, end, display elapsed time) and the replay link (`activityId`, stage id), unless the owner's summary says the log expired;
- the result only from the bout's `endsAtMs`, always by the logged `winnerId` (0 HP tie-breaks included), entrant first;
- the owner's summary only when `owner` is set and `settledAtMs` has passed; `awaitingSummary` after minute 80 without one.

Stages with `revealedAtMs > displayNowMs` do not exist in the state, even when the timeline holds them. While a bout runs, its label reads "Bout in progress", never the published "Bout: victory/defeat". The core is deep-frozen and deterministic and reads no clock or randomness. `arenaRevealMarks` gives minutes 60 and 80 while they can still reveal something.

**Camp** (`src/game/arena-layout.ts`, `src/game/camp-scene.ts`):
- Arena entrants always stage now (`actors.ts`: no random ring pairs before reveal) and play the `practice` warm-up until minute 60, then idle. Ring tiles are kept free of staging.
- `campArenaFights` finds revealed bouts whose fighters are both arena entrants in camp (either timeline suffices, since both carry the battle), or an entrant and its NPC fallback.
- `scheduleArenaRings` gives each fight one of the map's six rings and a window: enter at max(bout start, ring free), jog in at 3 tiles/s (4 s bound, tested against every arena tile and the arena gate; follow-up 1), fight from the log until the bout stage's end, the 2 s replay outro plus a 6 s result hold, then walk back to staging at 1 tile/s. Extra pairs queue in staging. A late reveal never moves a running fight (`previous` + `knownAtMs`).
- The scene plays each fight through `battle-stage` (`planStage`/`stageAt`) seeked to the bout's real time (display time minus the logged start) once the pair stands in its ring, so the ring fight ends when the Arena card shows the result (review fix I3), the Task 15 pattern: poses, hit effects (all fights) and damage labels (only the selected or followed fight, so busy rings stay readable). Reduced motion: no walking, shake or flash.
- NPC fallback opponents walk in through the arena gate as `arena-npc:<battleId>` in the entrant's mirrored gear, neutral NPC grey and an always-visible "NPC" tag; they are never players or roster entries.
- A click on an arena entrant (or its NPC opponent) emits `open-arena`; `GameViewport` lists ring fights as buttons below the camp view ("Bellator vs Corvina", "Valeria vs Iron Warden (NPC)", the gladiator first whichever side the NPC is logged on) that find the pair and emit the same event. The card then scrolls into view by the shortest way (a card already in view stays put; follow-up 2) and takes the focus.
- `GameViewport` reads entrants' timelines once their bout is due (`arenaReadsDue`: minute 60, or at once when the public stage shows a bout; retried every 30 s while missing; never after the slot; none while the tab is hidden), lands a batch together, and shares the display clock.

**Display clock** (`src/game/display-clock.ts`): anchors at the first server time, then only moves forward (a static or slower read never replays reveals); fixture tests can freeze it. The camp and both panels share it when the page passes one.

**Arena card** (`src/features/arena/ArenaPanel.tsx`, CSS module, `arena-text.ts`):
- Opens from `open-arena`, from "Your arena bout" when `OwnerState.currentActivity.kind === 'arena'`, and (fixture) from sample buttons.
- Shows the phase (`Warming up`, `Preparing`, `Bout in progress`, `Completed`), the minute, the opponent's name, class and current rating (public profile; "not available" otherwise) and, for a fallback, exactly `NPC opponent — reduced renown, no rating change`.
- **Watch replay** is a button, disabled until the reveal, that opens `/replay/?[mode=fixture&]activity=<id>&stage=<stage id>`.
- After the bout: Victory/Defeat with how the logged winner won, and for losses "no lasting injury and no gear lost". Only for the owner, only from the summary: "+10 renown / Rating +13", "+3 renown / No rating change", "+2 renown / Rating −13", "No renown / No rating change". Spectators read "Rewards are private to the gladiator's owner." Nothing is credited before minute 80.
- It reads the timeline on open, at the reveal marks, every 30 s while the bout or results are missing, and on focus; then the opponent's profile once. Owner is `viewer id === entrant id` (selection, own activity or sample).

**Standings** (`src/features/arena/StandingsPanel.tsx`, CSS module): league buttons; 50-row pages with **More** (de-duplicated, and stops if a reader ignores the cursor); rank, name, rating, human W–L and You/Promoted/Inactive markers; a separate "Your standing" block with league, rating and renown (owner state) and current combat strength (public profile, `number | null`, "not available"); and a league explanation from the spec thresholds (never another player's index). After each slot boundary it re-reads the pages it shows every 30 s for five minutes while results settle (credited results only), and on focus; a failed read offers a retry (review fixes I4, M8, M12).

## Interfaces

- `src/game/arena-stage.ts`: `ARENA_SLOT_MS`, `ARENA_REVEAL_MS`, `ArenaPhase`, `ArenaFighter`, `ArenaVisibleStage`, `ArenaBout`, `ArenaResult`, `ArenaStageState`, `ArenaStageOptions { entrantId?, owner? }`, `renderArenaStage(timeline, displayNowMs, options)`, `arenaRevealMarks(state)` (`arenaStageOfActor` and `startsAtMs` were removed in the review fix pass).
- `src/game/arena-layout.ts`: `ARENA_JOG_PACE` (3), `ARENA_GATE`, `ARENA_ENTRY_MS` (4 000; 11 000 before the follow-up pass), `ARENA_RESULT_HOLD_MS` (6 000), `ARENA_RETRY_MS` (30 000), `arenaRings(map)`, `ringTiles(map)`, `CampFight` (with `endsAtMs`), `campArenaFights(actors, timelines, t)`, `RingSlot` (with `boutStartMs`, `boutEndsAtMs`), `scheduleArenaRings(fights, rings, { previous?, knownAtMs? })`, `fightStatus(slot, durationMs, t, arrived?)`, `arenaFightButton(summary)`, `arenaReadsDue(actors, known, t)`.
- `src/features/arena/standings-refresh.ts`: `STANDINGS_REFRESH_MS`, `STANDINGS_SETTLE_WINDOW_MS`, `standingsRefreshDue(refresh)`, `readStandingsPages(reader, league, pages)`, `readNextPage(reader, loaded)`.
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
| ownerHumanWin | `arena-ownerHumanWin-0` | Aster beats Varro (defeat), +10 renown, Elo +13 (1002 vs 1040) |
| ownerHumanLoss | `arena-ownerHumanLoss-33` | Cassia beats Aster, +2 renown, −13 (1015 vs 990) |
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
4. **Queued pairs wait for a ring.** The seventh and later pairs walk in when a ring frees and show the bout at its real position or, when it is over, its end state (review fix I3); the card and replay keep the logged times. This is presentation only.
5. **Warm-up is `practice`**, the closest existing loop; it grants nothing.

## Files

Plan Files list: `src/features/arena/ArenaPanel.tsx`, `StandingsPanel.tsx`, `tests/browser/arena.spec.ts`; extended camp scene. Gateway standings and replay navigation are the shared request.

Outside that list (all in Claude's lane): `src/game/arena-stage.ts`, `arena-layout.ts`, `display-clock.ts`, `bridge.ts`, `GameViewport.tsx` and `.module.css`, `actors.ts`, `battle-stage.ts`, `demo-world.ts`; `src/features/arena/arena-text.ts`, `standings-refresh.ts` (review fix pass) and both CSS modules; the fixture modules and JSON; `tests/domain/arena-stage`, `arena-layout`, `arena-fixtures`, `arena-panels`, `display-clock`, `standings-refresh` tests; additions to `scene-layout.test.ts`, `battle-stage.test.ts` and `tests/browser/camp.spec.ts`.

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

## Shared edits applied (controller, 2026-10-14)

- `git apply docs/implementation/task-17-request-shared.patch` changes `src/lib/api/fixture-gateway.ts`, `src/app/game/page.tsx` and `tests/api/fixture-gateway.test.ts`. No contract, live gateway, route, scanner or style change.
- Verified on the branch: `npm test` 440 passed; `npm run typecheck` exit 0; `npm run build` exit 0; `npm run verify:static` with 4 fixed routes and 81 assets clean; the full development browser suite on port 3300 with 149 passed, 5 skipped and 0 failed. The 24 page tests that were red before the patch now pass.
- Not run on the branch: the isolated production gate.

## Review fix pass (2026-10-14)

An independent review found spec Pass (conditional on I2 and I3), quality Pass and visual Pass, ready with fixes. A fresh implementer applied every listed Important and Minor finding (M7, deduplicating the per-entrant timeline read, was out of scope) on `1f01531`, commit `e3392fb` (`fix: apply Task 17 review findings`). RED runs for the browser tests used the instrumented scene with the previous `arena-layout.ts`, `StandingsPanel.tsx` and guard restored temporarily; the RED results below come from those runs or from the unit tests written first.

### Important

- **I1, request guard port.** `forbidRemote(page, baseURL)` now compares each request's origin with the test's own `baseURL` (Playwright fixture) through `remoteRequest(url, origin)`, and still flags `54321`, `supabase`, `/functions/v1/` and `/rest/v1/` on any origin. RED: the new pure test "flags only requests that leave the test origin or reach Supabase, on any dev port" failed with the old check (`http://127.0.0.1:3100/_next/static/chunks/app.js` flagged). GREEN: it passes for 3100, 3300 and 4173 and flags the Supabase URLs. The repo config (port 3100) was not run in this lane; the pure test is the proof.
- **I2, feedback when the camp opens the card.** Each `open-arena` from the camp (a fighter click or a bout button) carries a focus request. Once the card's heading has rendered, the card's top is scrolled into view (`block: start`, smooth; a jump with reduced motion) and the heading (`tabIndex={-1}`, a focus-visible ring) takes the focus. The panel's own sample and "Your arena bout" buttons do not scroll. RED: the new test "scrolls the card into view and focuses its heading when a camp bout opens it" (reduce and no-preference motion, desktop and mobile) failed: the heading was not focused. GREEN: focused and in the viewport after a bout button and after a fighter click; with reduced motion it is already in view when focused. Two existing click tests now scroll the camp back into view before clicking, because the card scroll moves the canvas (seen as a click on Titus selecting nobody).
- **I3, the card before the ring.** Decision: ring playback is the bout's real time. Once the pair stands in its ring (both fighters on their spots, or at the latest the 11 s walk-in bound), the position is `displayNow - bout.startedAtMs`; what the bout showed during the walk-in is skipped. The ring fights only until the bout's `endsAtMs`, the moment the card shows the result, then holds the end (2 s outro, 6 s hold) and leaves at `max(walk-in bound, end + outro) + hold`. A pair that reaches its ring after its bout ended (the seventh, queued pair) shows only the end state. `RingSlot` gained `boutStartMs`, `fightStatus` an `arrived` flag. Trade-off: with the 12–21 s fixture bouts and walks of up to about 10 s, the camp shows the last part of each bout (with reduced motion, where pairs step in at once, the whole bout); the full bout is in the replay. RED: the layout tests (position 0 where 11 000 was expected, leave time, end state) and the page test "ends the ring fight when its card shows the result, never before" ("the card shows a result 15696 ms in, while the ring still fights"). GREEN: unit invariants over every fixture fight (fighting only while the card has no result, the result exactly from the bout's end, real positions), and the page test on both projects, which checks that ring and card change over between `end - 1` and `end`. The scene tests now play the bouts at their real times; the queued test asserts the end state.
- **I4, standings refresh.** `standingsRefreshDue` in `src/features/arena/standings-refresh.ts` is the one swappable rule (Task 13's sync replaces it): read when the display clock crosses a boundary, then every 30 s for five minutes while the tab is visible, stop early once the owner's `processedSlotIndex` covers the slot that ended (with one read after that is seen), and read nothing later in the slot. RED: the unit test (module missing) and the browser test "keeps re-reading standings every 30 s for five minutes after the boundary, then stops", which timed out waiting for the read at 31 s with the previous panel. GREEN: 5 unit tests; in the browser one read at 1 s, none at 20 s, then 31 s, 62 s and 4:59, and none at 5:01 or 9:00. **Task 13 gate:** "Your standing" reads rating and renown from `OwnerState`, which only Task 13's shared owner/world sync refreshes; this panel re-reads the standings rows and the owner's profile (combat strength) only.

### Minor

- **M1.** The bout buttons sit below the camp view in a wrapping row (a grid wrapper around the viewport), so they never cover nameplates or take canvas clicks; keyboard use is unchanged. RED: the group's top (261 px) was above the canvas bottom (678 px). GREEN: below the view, every button within the row on desktop and mobile.
- **M2.** `GameViewport` drops the timelines and read bookkeeping of activities no longer in the world (on world updates, landed reads and the fixture hook); the scene drops the stage plans of bouts no longer in camp (debug `arena.plans`). RED: 22 timelines were kept after the entrants left. GREEN: none kept, no fights, no plans.
- **M3.** The scene keeps what the rings drew in reused arrays, and `debug()` builds the Arena report only when asked; ring fight summaries are built and emitted only when the list or a status changes (element-wise check, no signature string). A refactor without a behavioural RED; the scene and bout-button tests that read `arena.fights`, `arena.effects` and the buttons cover it.
- **M4.** `arenaStageOfActor`, the label parser `labelOutcome` and the then unused `startsAtMs` option were removed; a bout stage without its log has no result. RED: the new stage test still got "victory" from the label. GREEN.
- **M5.** The owner's rating history chains: 1000, tie-break +15 (vs Severus 1100), 1015, loss −13 (1015 vs Cassia 990), 1002, win +13 (1002 vs Varro 1040), 1015. `ARENA_OWNER` (the owner fixture with rating 1015 and renown 25 = 10 + 0 + 3 + 2 + 10) is what the fixture gateway's `owner()` returns; Aster's profile and standings row are 1015 (2–1); Varro is 1027 (1040 − 13), Cassia 1003, Severus 1085. RED: the new generator test "chains the owner's credited bouts…" failed ("ownerHumanLoss: … expected 1013 to be 1015"), and the gateway test got owner `[1000, 0]`. GREEN; regenerated with `UPDATE_ARENA_FIXTURES=1` through the generator test, with no log changes (the logs do not depend on ratings). The Task 14 replay samples keep their own sample deltas and are not part of this chain.
- **M6.** Damage labels rise from above the higher of the pair's nameplate and NPC-tag stack (3 px gap, measured from the text heights; `LABEL_BASE` is exported from `battle-stage`). RED: "-10 over Iron Warden at 12000 ms". GREEN: no label box of the selected pair crosses either fighter's nameplate or tag, with and without reduced motion. At that point a label could still cross the nameplate of a fighter in the ring behind whenever other fighters' nameplates show (zoom 1.4 and above); follow-up 5 removed that (see "Follow-up fix pass").
- **M8.** A read failure shows "The standings could not be loaded right now." with **Try again**; a failed refresh keeps the rows shown with a short out-of-date notice. "Standings are not available in this build yet." appears only without a reader, which is the live game for now (see the shared edits). RED: the panel test. GREEN.
- **M9.** Preparing without a known slot start says only that the bout is not published yet. RED: the card test found "Minute 60 has passed". GREEN.
- **M10.** The card's minute, credited heading and replay hint, and the standings note, take 60 and 80 from `RULES_V1` (`REVEAL_MINUTE`, `SLOT_MINUTES`). A refactor; the card tests cover it.
- **M11.** `CampFight.fighters` is `[string | null, string | null]` without a cast; `arenaFightButton` names the gladiator first and the NPC second and opens the gladiator's card, whichever side the NPC is logged on. RED: the new layout test (helper missing). GREEN.
- **M12.** A refresh reloads as many pages as are shown (`readStandingsPages`); **More** appends with `readNextPage`. RED: the browser test expected two page reads after the boundary and got one, with the rows back at 50. GREEN: 58 rows kept.
- **M13.** The header bullet above now names the shared-file changes.

### Shared files changed in this pass

- `src/lib/api/fixture-gateway.ts`: `owner()` returns `ARENA_OWNER` (M5).
- `src/app/game/page.tsx`: the Standings tab gets a reader only in fixture mode, so live mode says "not available in this build yet" until Task 10 provides the live standings read (M8). Codex should pass the live gateway once that read exists.
- `tests/api/fixture-gateway.test.ts`: Aster's profile rating 1015 and the owner's rating and renown (M5).

No contract, live gateway, route, scanner or `globals.css` change.

### Commands and results (review fix pass, final code)

- `npm test`: 451 passed (22 files).
- `npm run typecheck`: exit 0 (tsc, Deno check of both Edge entrypoints, 2 Deno tests).
- `node assets/source/build-assets.mjs --check`: up to date (28 files).
- `npm run build`: exit 0; `npm run verify:static`: 4 fixed routes, 81 assets scanned, no forbidden backend material.
- Full dev browser suite through `node_modules/.cache/pw-replay.config.mjs` (port 3300): **165 passed, 5 skipped, 0 failed**. Earlier in the pass (before the card scroll targeted the whole card and the label close-up was added), the click, scroll, label and ring/card tests passed with `--repeat-each 2` (24/24).
- `git diff --check` and `git diff --cached --check`: clean.

### Evidence refreshed

From the final suite run: `desktop-camp-minute-40-warm-up.png`, `desktop-camp-six-simultaneous-fights.png` and `mobile-camp-six-simultaneous-fights.png` (real-time poses, bout buttons below the view), `desktop-card-human-credited.png` (Varro 1027), `desktop-standings-bronze.png`, `width360-card.png` and `width360-standings.png` (rating 1015, renown 25). New: `mobile-camp-bout-buttons-below-view.png` (M1), `desktop-camp-labels-clear-of-nameplates.png` (M6), `desktop-card-opened-from-camp.png` and `mobile-card-opened-from-camp.png` (I2). `desktop-card-npc-loss.png` and `desktop-card-worker-delay.png` were unchanged.

### Concerns from this pass

- An `npx tsx` call to print the ring schedule asked npm to fetch `tsx@4.23.15` into the npm cache; the schedule was then printed through a temporary Vitest file instead (deleted). Nothing in the repository or lockfile changed.

## Follow-up fix pass (2026-10-14)

A scoped re-review found every finding Pass and recommended six presentation-only follow-ups. A fresh implementer applied all six on `ff01dba`, commit `6df1b78` (`fix: jog into Arena rings and polish Task 17 follow-ups`). Real-time ring playback and the card/ring hand-over rule are unchanged. Each test below was written first and seen failing; the RED and GREEN runs used the private Playwright config on port 3300.

1. **Jog into the ring** (`arena-layout.ts`, `camp-scene.ts`). Pairs, and NPC fallbacks coming from the arena gate, jog into their ring at `ARENA_JOG_PACE` = 3 times the manifest walk (3 tiles/s). The walk loop's frames step three times as fast too. The walk back to staging stays at 1 tile/s. `ARENA_ENTRY_MS` drops from 11 000 to 4 000: the longest jog, 10.07 tiles from a staging tile or the gate, takes 3.36 s. Each walk carries a `pace`; `walkTo` takes `{ from, remove, pace }`. `ARENA_GATE` moved to `arena-layout.ts` so the every-tile test covers the NPC's jog in as well. RED: the every-tile test first failed with no jog pace ("expected NaN to be ≥ 2.5"). With pace 3 and the old bound it failed on the new slack check ("expected 7642.98 to be less than 1000"). The new browser test "jogs pairs into their rings at three times the walking pace…" failed on both projects ("Nerva jogs in: expected > 2.2, received 1.0"). GREEN: the jog in measures about 3 tiles/s in a straight line, with at least 5 walk-frame changes in 240 ms. The walk back measures about 1 tile/s, with at most 3.
2. **Scroll** (`ArenaPanel.tsx`). A camp opening now uses `scrollIntoView({ block: 'nearest' })`, so a card that is already in view leaves the page, and the camp, where they are. The focus behaviour is unchanged. RED: the new desktop test "leaves the page where it is when a camp bout opens a card that is already in view" failed ("the page did not scroll: expected 1142, received 1281"). GREEN: it passes, and the existing scroll-and-focus tests (both motion settings, desktop and mobile) still pass.
3. **One end time** (`arena-layout.ts`). `CampFight` carries the bout stage's `endsAtMs` and `RingSlot` its `boutEndsAtMs` (also in the debug fight). `scheduleArenaRings` leaves after that end. `fightStatus` fights until it, held just short of the logged result if the stage outlasts the log. From that end it shows the logged result and its outro. RED: the new unit test shifts the stage end by −1 500 and +1 500 ms; it failed ("expected undefined to be 1791594014196": no `endsAtMs`). GREEN: in both shifts the ring and the card change over together at the stage end, and a fighting ring never reaches the result poses.
4. **Stale walk** (`camp-scene.ts`). The clock can carry a bout past its end while a fighter, or its NPC opponent, is still jogging in (a hidden tab coming back, or a late read). The fighter is then placed on its ring spot first, so the walk back starts from the ring and not mid-path. RED: the new browser test "puts a fighter still walking in on its ring spot once its bout is over…" uses the debug hook to jump the clock from 500 ms into the jog to after every leave time. It failed on both projects ("Nerva starts back from its ring spot: expected [true, arena-ring-0-a], received [false, null]"). GREEN: it passes. With the jog in place, a mutation without the two placements still fails ("received null").
5. **Damage labels** (`camp-scene.ts`). Each label starts above its own target's nameplate and NPC tag (`plateTop(fight, l.target, …)`), not the pair's highest. A human's labels in an NPC bout are no longer lifted by the tag. In the six-ring layout, two rings stand 32 px in front of another ring's fighter, which leaves about one label height between the target's nameplate and the nameplate behind. A label therefore rises, as in the replay, only as far as the room under a nameplate or tag shown above it in its column (`headroom`, from where the plates were drawn the frame before). RED: the new browser test "keeps each fight's damage labels clear of every nameplate in the six-fight view" selects each of the six ring fights in turn. The view is the evidence capture's (zoom 2, where every fighter's nameplate shows). It checks every label box against every nameplate and tag shown, every 100 ms through the bout, in both motion settings. It found 292 crossings per project: Valeria's labels over Corvina in both settings, and Lucilla's over Decimus with full motion. Per-target heights alone left 182, all rising labels (Valeria over Corvina 84, Lucilla over Decimus 98). GREEN: no crossing on either project, and the existing pair label test still passes.
6. **Live-mode wording** (`arena-text.ts`, `ArenaPanel.tsx`, `page.tsx`). `arenaUnavailableText(reason)` holds the card's three messages. Without a reader the card says "The Arena card is not available in this build yet." A real read failure keeps "Arena activity cannot be loaded right now. Only revealed stages are ever shown." (the card reads again on focus). As M8 did for Standings, the game page passes the Arena reader only in fixture mode until Task 10's live timeline read lands. RED: the new panel test failed ("arenaUnavailableText is not a function"). GREEN: it passes. The page wiring has no browser test, because live mode needs a signed-in owner with an Arena activity; typecheck and build cover it.

### Shared files changed in this pass

- `src/app/game/page.tsx`: `ArenaPanel` gets `reads={fixture ? reads : null}`, with a comment (follow-up 6). No contract, live gateway, route, scanner or `globals.css` change.

### Commands and results (follow-up pass, final code)

- `npm test`: 453 passed (22 files).
- `npm run typecheck`: exit 0 (tsc, Deno check of both Edge entrypoints, 2 Deno tests).
- `node assets/source/build-assets.mjs --check`: up to date (28 files).
- `npm run build`: exit 0. `npm run verify:static`: 4 fixed routes, 81 assets scanned, no forbidden backend material.
- Full dev browser suite through `node_modules/.cache/pw-replay.config.mjs` (port 3300): **172 passed, 6 skipped, 0 failed**. The one new skip is the desktop-only scroll test on mobile.
- `git diff --check` and `git diff --cached --check`: clean.

### Evidence refreshed

- `desktop-camp-labels-clear-of-nameplates.png` was refreshed from the final suite run. It is the zoom 2.5 close-up of Valeria's ring. Valeria's "-8" now sits just above her own nameplate and below Corvina's, in the ring behind. Iron Warden's label sits above its NPC tag.
- Caption, the remaining case: zoom does not change where labels and nameplates overlap. It only decides whether other fighters' nameplates show (zoom 1.4 and above). In the fixture's six-fight view (zoom 2) and this close-up, no damage label crosses any nameplate or tag. Labels over a fighter with a ring fighter directly behind (Valeria and Lucilla here) therefore barely rise. The rule does not cover a nameplate level with a label's start that overlaps it sideways; no such case occurs in the fixture. A nameplate that appears during a label's life is avoided only from the next frame.

### Concerns from this pass

- The first full suite run was stopped part-way because a comment-only tidy of the scene was saved while its dev server was running. Its next dev server and Playwright workers were left running, and I stopped them by process id after checking that each command line was this worktree's port-3300 run. The full suite was then rerun on the final code (above).
- One shell command was started with a stray `python -` heredoc, which hung and was stopped; it changed nothing.

## Integration checklist (for Codex)

- `src/app/game/page.tsx`, Standings tab (about line 155): `reads={fixture ? reads : null}`. Give live Standings the live gateway once Task 10's standings read (with the `cursor` argument) lands.
- `src/app/game/page.tsx`, `ArenaPanel` (about line 143): `reads={fixture ? reads : null}`. Give the live Arena card the live gateway once Task 10's `timeline` (and `profile`) reads land.
- Review the controller's shared edits (`1f01531`, the review fix pass and the line above) in `fixture-gateway.ts`, `page.tsx` and `tests/api/fixture-gateway.test.ts`.


## Limitations and gates

- **Task 16:** confirm the stage shape, battle ids, the one-log-per-pair question and the NPC id/name; provide `makeFallback`; ratings, standings and promotion. `ratingDelta` is shown only when present.
- **Task 10:** the live `timeline`, `profile` and `standings` reads; `standings` cursor; `combatStrength: number | null` (accepted already); optional spectator `completion` (unused); a lighter pairing hint in the projection would replace per-entrant reads.
- **Task 13:** own the shared sync clock and world polling (this display clock is the seam); replace `standingsRefreshDue`; refresh `OwnerState`, which "Your standing" reads for rating and renown (only Task 13's shared state refreshes it); show the camp outside fixture mode; combine `currentActivity` with `processedSlotIndex` for Processing states; a profile card from `select-character`.
- Physical FPS with six fights and 50 actors is a Task 23 measurement, not claimed. Tournament layout (Task 20) still uses its earlier random ring pairs.

## Concerns

- One read-only look outside this worktree: to learn whether the camp projection carries battle logs, I searched (Grep tool, no shell command) Codex's uncommitted `supabase/sql/06-projections.sql` and `contracts` in `C:\Avi\Studies\Projects\Cloudiator`. Nothing there was written or run. Decision 3 above relies on it.
- `arena.spec.ts` is committed with its 12 page tests red in this branch until the patch is applied.
