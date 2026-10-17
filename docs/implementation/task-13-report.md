# Task 13 report: full-screen camp and visitor viewing

- **Branch:** `claude/task-13` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `b301aff` (the plan commit on `claude/preview`).
- **Range:** `b301aff..427c426` (13.1–13.9), then this report.
- **Plan:** [Task 13 plan](../superpowers/plans/2026-10-16-task-13-full-screen-camp.md). **Spec:** [full-screen camp design](../superpowers/specs/2026-10-14-full-screen-camp-design.md), approved with its clickable mockup on 2026-10-16.
- **Reviews:** [review record](task-13-review.md). Steps 13.1–13.8 each had a fresh implementer and an independent reviewer. 13.9 awaits the controller's final whole-branch review.
- **Status:** every gate in the plan's registry is closed (below). HANDOFF is updated by the controller after the final review.

## What each checkpoint delivered

| Step | Commits | Delivered | Report |
| --- | --- | --- | --- |
| 13.1 Visitor read access (M13) | `43af136` | `anon` may SELECT exactly the 14 sanitized public projections, read-only. `tournament_views` is granted column by column, so `pairing_job_id` and `published_at_ms` are readable by no client. The 9 select policies were altered in place to `anon, authenticated`. Source `11-visitor-access.sql`, migration M13 and `visitor-access.test.ts`. | [13.1](task-13.1-report.md) |
| 13.2 Public reads without a session | `f8d6fc3`, `6fed6b0` | The 8 public gateway reads use `publicRead` (no session; retried once on an account change). A visitor's timeline never queries owner-only `activities`. The fixture gateway gained `recent()` with the live cursor rules. The tournament log cache is shared and cleared on an account change (Task 19 R1). | [13.2](task-13.2-report.md) |
| 13.3 Shared game state, sync clock, live camp | `5bb3452`, `46fd8c3` | `useGameState` owns the one sync controller, the shared display clock and the owner reads. The sync offset comes from a timed revision round trip (Task 10 bias). `activityStatus` combines `currentActivity` with `processedSlotIndex`. The camp mounts live, reports its scene status, and a stale stored session signs out locally. `tests/browser/live-routes.ts` serves visitors and seeded sessions. | [13.3](task-13.3-report.md) |
| 13.4 Panels on the shared clock and revision | `c035491`, `d9a0d27` | Schedule estimates follow the shared clock (Task 6). Standings re-read on a revision change (`standings-refresh.ts` deleted). The Tournaments panel holds one 30 s retry (R2), says "being prepared" for 5 minutes after the cutoff (R3 ruling), has a card test (R5), follows the owner's league and offers visitors a league picker. | [13.4](task-13.4-report.md) |
| 13.5 Full-screen shell | `5c109f6`, `6bbbdbe` | The camp fills the window. A hidden rail on the left holds seven menus (no Marketplace), each a floating panel; the corner chip shows the gladiator. Touch layouts get ☰, one scrollable row of icons and bottom sheets. Every world click has a keyboard path, and the panels work without the canvas. | [13.5](task-13.5-report.md) |
| 13.6 Visitors watch and join | `6f5730c`, `0332c2a` | A visitor sees the camp, the five public menus and a "Sign in with Google to join" chip. After sign-in without a gladiator, a modal "Create your gladiator" dialog opens over the camp; "Not now" keeps the draft. Cancelled or failed sign-ins return with a short message. A session change closes private menus. | [13.6](task-13.6-report.md) |
| 13.7 Results, profile cards, merchants | `2268aff` | A Results menu pages public results 50 at a time. Training and Rest never offer a replay. A click on a gladiator opens its public profile card (keyboard paths from Gladiators and the standings). A click on a merchant opens the matching shop tab. | [13.7](task-13.7-report.md) |
| 13.8 Replays and expeditions over the camp | `d6fa86c`, `7480cd3` | Replays and expeditions open as full-window scenes over the running camp, as history entries on `/game/`. The reserved bridge events are wired, `ExpeditionView` follows the controller instead of polling, the replay shows only battles that have ended by display time, and closed scenes release their WebGL context. | [13.8](task-13.8-report.md) |
| 13.9 Live-ready tournament rings, final gates | `427c426` | See "13.9" below. | this report |

### 13.9: live-ready tournament rings

- **Ring schedule independent of log arrival (Task 19 R4).** A revealed tournament bout is now a camp fight from its reveal, timed by its polled fight summary; its battle log attaches when it loads (`CampFight.log` is null until then, and the pair stands in its ring). A whole round is therefore known at once, so the order in which its logs arrive never changes the rings. `scheduleArenaRings` also plans its input in start, then battle-id order, and plans fights still queued in staging again with newly learned ones, so a queue converges on one order; the scene's update rule is now the pure, tested `updateRingSchedule`.
- **Logs only for current or upcoming ring windows.** `tournamentLogsDue(view, nowMs, windowMs, rings)` returns the bouts whose ring window is current or starts within `windowMs`, soonest first, using the scene's ring schedule (`CampSceneHandle.ringSchedule()`). The window is `TOURNAMENT_LOG_WINDOW_MS` = 10 s, the shortest ring window (jog-in plus result hold), so each ring asks for at most its current and next bout.
- **One shared log cache.** The camp and the Tournaments panel read logs through the same gateway, whose session cache serves the second reader without a request (tested live). The camp keeps only the logs of the views it holds.
- **Pruning.** The camp forgets a tournament view, its logs and its read record once the tournament has no entrant left in the world (`campTournamentIds`, Task 20 review minor 4).
- **Engine-free `isTournamentSlot`.** It lives in `supabase/functions/_shared/domain/tournament-slot.ts` (clock, rules and types only); `tournament.ts` re-exports it, and the client stage core imports it directly. A static import walk proves no combat engine in its graph or in the stage core's, the camp's or the Tournaments panel's.
- **Carried Minors.** A visitor live-camp test with Arena and tournament entrants (13.3); the fixture Results feed deduplicated and retimed to one result per gladiator a slot (13.7); tournament bracket replays tell only a fighter "Rewards are credited when the activity settles." (13.8).

## Gate registry outcomes

| Gate (source) | Closed in | Outcome and evidence |
| --- | --- | --- |
| Visitor-access migration and access-denial tests (spec; HANDOFF) | 13.1 | M13 plus `visitor-access.test.ts`; the reviewer's live catalog shows `anon` with SELECT on exactly the 14 projections and no write or execute privilege anywhere. |
| `tournament_views.pairing_job_id` client-readable (Task 19 M1) | 13.1 | Closed: column grants for `anon` and `authenticated` on 10 columns; `pairing_job_id` and `published_at_ms` readable by no client; JSON-path reads of `result` still work. |
| Public reads blocked without a session; `readTimeline` queries owner-only `activities` | 13.2 | Closed: `publicRead` for the 8 public reads; the visitor timeline never queries `activities` (unit and DB tests). |
| Log cache cleared only by `subscribeSession`; a cached hit skips the session check (Task 19 R1) | 13.2, 13.3 | Closed: the shared cache is public-only and cleared on an account change (13.2); the live page mounts the sync controller, which subscribes to session changes (13.3). |
| Mount the sync controller and the shared clock (Tasks 10, 12, 17, 20) | 13.3 | Closed: one controller and one clock in `useGameState`. |
| Initial-load clock-offset bias (Task 10 review) | 13.3 | Closed: the offset comes from a timed revision round trip; the bias test is RED at 1 950 ms off and GREEN under 50 ms. |
| `currentActivity` with `processedSlotIndex` (Processing results / Preparing) (Task 7) | 13.3 | Closed: `activityStatus`, robust to a stale slot index since 13.5. |
| Camp outside fixture mode; live reader flips; Phaser chunks load live; late first world (Tasks 12, 17, 19, 20) | 13.3 | Closed: `live-camp.spec.ts`. |
| Scene-availability status query (Task 12) | 13.3 | Closed: `GameViewport` reports loading, ready or unavailable; the shell shows it (13.5). |
| Stale schedule clock (Task 6) | 13.4 | Closed: estimates follow the shared clock. |
| Replace `standingsRefreshDue`; owner refresh for "Your standing" (Task 17) | 13.4 | Closed: standings and the strength read follow the revision. |
| Tournament retry timer and R2; R3; R5; lookup league after promotion; `tournamentLookupIdOrNull`; unreachable "You advance…" branch (Tasks 19, 20) | 13.4 | Closed; R3 by the 5-minute grace ruling. |
| Keyboard equivalents; mobile sheets; panels usable without the canvas (old Task 13) | 13.5 | Closed: `full-screen.spec.ts`. |
| Visitor mode, joining, sign-out (spec) | 13.6 | Closed: `visitor.spec.ts` and `identity.spec.ts`. |
| `select-character` profile card; selection from roster and standings (Task 17) | 13.7 | Closed: `management.spec.ts`. |
| `open-merchant` opens the right shop tab (Task 8) | 13.7 | Closed. |
| Non-replay result state for Training and Rest (Tasks 7, 9) | 13.7 | Closed: no replay offered, never "no longer kept". |
| Reserved bridge events `view-replay`, `view-expedition`, `return-camp`; roster links to expeditions (Tasks 12, 15) | 13.8 | Closed: `scenes.spec.ts`. |
| Replace `ExpeditionView`'s own polling with the controller (Task 10) | 13.8 | Closed. |
| Replay page without a display clock (Task 15 review) | 13.8 | Closed: only battles ended by display time are offered. |
| Task 15 Minors: safe-point leave pose, encounter-count constant, test title | 13.8 | Closed in their real files (Ruling 3). |
| Ring schedule independent of log load order (R4); logs only for current or upcoming ring windows; one shared log cache; late-joiner measurement (Task 19) | 13.9 | Closed: `tournament-camp.test.ts` (two arrival orders give equal schedules; windowed log requests) and `tournament.spec.ts` (live late joiner and the shared cache). Measurement below. |
| Prune `tournamentViews` with `forgetLeft`; ring and panel change over together (Task 20) | 13.9 | Closed: `tournament.spec.ts` "forgets tournament views whose entrants have left the camp" and "changes a tournament ring and the panel over at the same moment" (mutation-checked: a 1 s offset fails it). |
| Engine-free `isTournamentSlot` (Tasks 19 M5, 20) | 13.9 | Closed: `tournament-slot.test.ts` import walk. |
| Isolated production gate with the repo's `playwright.config.ts` (Tasks 17, 20) | 13.9 | Closed: 16 passed, 390 skipped as development-only, 0 failed, with the repo’s `playwright.config.ts` serving `.next/browser-test` on port 4173 after the `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true` build and `verify:static -- .next/browser-test` (5 routes, 90 assets). |

## Measurements

**Late joiner (Task 19 gate).** A 50-entrant tournament (a 64-slot bracket: 18 fought bouts in round 1, 16 in round 2), joined 10 s after round 2 shows:

| | Logs asked for | Log JSON |
| --- | --- | --- |
| Task 19's camp (every revealed bout of camp entrants) | 34 | 304 662 bytes |
| Now (live browser test, `tournament.spec.ts`) | **8** (6 current windows, 2 next) | 73 631 bytes |

- The bound is two windows per ring, so at most 12 logs at any moment, whatever the bracket size.
- Joining at other minutes of the same tournament (unit-level, same rule): minute 12: 8 of 18 revealed; 23: 8 of 34; 30: 0 of 34; 35: 0 of 42; 46: 4 of 46; 58: 0 of 48; 70: 0 of 49.
- A viewer present for the whole slot loads each of the 49 fought bouts' logs once (436 697 bytes in all, spread over the slot), never more than 6 in one check.
- Polled view sizes are unchanged from Task 19 (late 50-entrant view about 39 KB); this task changes only when logs load.

**Gates at 13.9.** Unit 989/989 (44 files); database 177/177, with the Edge container’s start time unchanged across the run; build and static scan: 5 routes, 90 assets, clean; development browser suite 384 passed, 22 skipped, 0 failed (private config, port 3200); isolated production gate with the repo config 16 passed, 390 skipped, 0 failed; `git diff --check` clean.

## File-map adjustments against the old plan

The old plan's Task 13 ("Complete owner management over the animated world") named `CharacterPanel.tsx`, `ResultsPanel.tsx`, `RosterPanel.tsx`, `useGameState.ts` and `management.spec.ts`. All five exist with those names (plan Decision 1). The rebuilt task added:
- **Backend:** `supabase/sql/11-visitor-access.sql` and migration M13 (`20261016141628_visitor_access.sql`); `supabase/functions/_shared/domain/tournament-slot.ts`.
- **Shell (`src/features/shell/`):** `CampShell`, `MenuRail`, `MenuSurface`, `CornerChip`, `SceneOverlay`, `menus.ts`, `rail-reveal.ts`, `scene-url.ts`, `useSceneHistory.ts`, `useCampClicks.ts`, `useJoining.ts`.
- **Features:** `activity-status.ts`, `ProfileCard.tsx`, `actor-text.ts`, `ArenaMenu.tsx`, `result-text.ts`.
- **Changed interfaces:** `useGameState(gateway, { fixture, previewAs })` instead of `useGameState(gateway)`; `readTimeline` takes a required `{ ownerSummary }`; `TournamentPanel` takes `syncError` (not a revision slot); `tournamentLogsDue(view, nowMs, windowMs, rings)` instead of `(actors, views, nowMs)`; `CampSceneHandle.ringSchedule()`; `CampFight.log` may be null.
- **Outside a step's own list, recorded in its report:** `camp-scene.ts` touch-press handling (13.5); `page.tsx`, `SignIn.tsx` and `TournamentPanel.tsx` (13.6); the Arena card's Watch replay (13.8); the Task 15 Minors in `expedition-stage.ts` and `expedition-path.ts` (13.8, Ruling 3).
- **Deleted:** `src/features/arena/standings-refresh.ts` and its test (13.4).
- **Tests added:** `tests/browser/{live-routes.ts, live-camp, full-screen, visitor, management, scenes}.spec.ts`, `shell-helpers.ts`; `tests/db/visitor-access.test.ts`; unit tests for activity status, menus, rail reveal, scene URLs, results and the tournament slot module; the `largeTournament` builder in `tests/fixtures/tournament-build.ts`.
- The old commit name `feat: connect accessible gladiator management panels` is superseded by the step commits.

## Rulings

From the plan's pre-flight scan, the review record and the ledger:
1. `tests/browser/live-routes.ts` serves both a signed-out visitor and a seeded signed-in session.
2. The 13.5 Tab test also pins the focus order: rail icons, then the corner chip.
3. The Task 15 leave-pose and encounter-count Minors were fixed wherever the logic lives.
4. **The Marketplace is deferred to Task 18.** No Marketplace icon until Task 18 builds the panel; Task 18 adds the menu entry and the `anon` grant on its listing objects.
5. **A stale session signs out locally.** A public read that fails `unauthenticated` because the server rejects a stale stored token signs the browser out (`scope=local`), and the camp keeps running for a visitor.
6. `activityStatus` itself takes the later of the revision's slot and the slot of the display time, so every caller is safe from a slot index up to 30 s old.
7. **The five-minute "being prepared" grace.** A not-found tournament reads "Tournament being prepared" for every viewer for 300 s after its slot starts (`TOURNAMENT_PREPARE_GRACE_MS`), and longer while a player's processed slot lags. Afterwards it reads "No tournament matches this selection". A server published-slot field is Task 23/24 scope.
8. A card that never gets the server's time says brackets cannot be loaded (13.4 M1).
9. **The touch layout below 481 px.** Windows narrower than 481 px pointer width use the phone layout (☰ and sheets), and the fixture pill sits where 13.5 placed it.
10. The phone menu is one horizontally scrollable row of menu icons; touch zooms by pinching.
11. The 360×740 dialog overflow check joined 13.6.
12. **A click on an Arena entrant opens the bout card.** A camp click on an Arena entrant keeps opening its Arena bout card, not the profile card; other gladiators open the profile card, and an entrant's profile card opens from the Gladiators list and the standings.
13. **An unknown expedition shows "not available yet".** A guessed or unknown live expedition shows "This expedition is not available yet" with no summary, never an endless "Preparing" or an error page.
14. Four small user-facing 13.8 Minors joined its fix round: Watch replay enabled mid-bout; the expired visitor replay wording and the visitors' rewards line; focus on a scene change; the fixture sample links.
15. The 13.9 implementer writes this report; the controller updates HANDOFF after the final whole-branch review.

## Left for later tasks

**Task 18 (Marketplace).** The Marketplace menu entry, its panel and the `anon` grant on its listing objects (Ruling 4). The rail's other icons keep their names.

**Task 22 (retention).** Once battle logs are pruned after 7 days, a tournament's "Watch replay" must say the replay is no longer kept, not "cannot be loaded right now" (Task 19 gate).

**Task 23 (release, accessibility, capacity).**
- The coordinator busy race behind the flaky production-cadence test `arena.test.ts:642`, and the held-window 121 s publication policy.
- Hosted compression and real egress: the camp's log loads (now bounded as measured above), the linear growth of the polled tournament view, the owner re-read on every revision change, `/replay/` deep-link reads, the "being prepared" back-off.
- fps and visitor-load measurement; diagonal-step speed and per-scene atlas splitting (Task 12); Task 17 round-3 Minors 1–2 and M7.
- Hardening noted in 13.1: `anon` MAINTAIN on the eight M01 owner tables (not reachable through the Data API).
- Its release test expects `getByRole('button', { name: 'Schedule' })` enabled when actor art fails; the rail icon's accessible name stays exactly "Schedule".
- Deferred Minors in the [review record](task-13-review.md) that are polish or test gaps (for example `CampShell.tsx` size, Results refresh while open, the double-open history race).

**Task 24 (provisioning).** M09–M12 deploy with the worker in one step; M13 ships with or after them and before the signed-out reads reach a public origin. A server published-slot signal for "being prepared" (R3) and local Google sign-in also wait for Task 24.
