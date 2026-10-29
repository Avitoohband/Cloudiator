# Cloudiator development handoff

Last updated: 2026-10-29, the game-messages patch is released (Tasks 1–8 of its plan; production runs release `d996d59` with migrations M01–M25; see "Game messages patch released" below). The game is public at https://cloudiator-arena.pages.dev (Task 24, "Task 24 complete: the public launch" below). Next: Task 9 (a clip for the players) and Task 10 (expedition replays, design and mockup first).

## Authority and repository

- Avi approved the [design](../superpowers/specs/2026-10-11-gladiator-arena-design.md), including proposed launch defaults, and the [24-task implementation plan](../superpowers/plans/2026-10-11-gladiator-arena-implementation.md).
- Execution method: Superpowers subagent-driven development. A fresh implementer owns each task; an independent reviewer checks specification compliance and code quality before the next task.
- **Claude is the executing controller.** On 2026-10-14 Avi told Codex to hand all remaining work to Claude. Codex posted the full handover on the board, and Claude acknowledged it at 10:45 IDT. Claude owns Tasks 13 and 16–24, integration, this file and the reviewed feature-branch pushes. Codex is finished; do not wait for it.
- Claude works in its own worktrees: `C:\Avi\Studies\Projects\Cloudiator-claude` (integration, Playwright port 3200), `Cloudiator-replay` (port 3300) and `Cloudiator-arena`. It pushes from them as fast-forwards to `origin/codex/gladiator-arena`.
- The root checkout `C:\Avi\Studies\Projects\Cloudiator` (Codex's) was left clean at `b83d7e3` and stays untouched. Its interrupted Task 7 files remain in stash `763051847dba6a14c5ef7b6b4169c0cbbf1543f7`.
- Repository: https://github.com/Avitoohband/Cloudiator. Avi authorized committing and pushing each completed task with detailed notes so another agent can take over.
- Push reviewed task checkpoints to this feature branch. Do not force-push or merge into another branch without authorization.
- Branch starting point: `2261fb77ff38ecba5678e2f70446c593d2cdade7`.

## Resume here

All 24 tasks are done: Tasks 1–23 passed independent specification and quality review, and Task 24 launched the game (see "Task 24 complete: the public launch" below). Task 13 rebuilt the game page into Avi's full-screen living camp: visitors watch the camp and every public menu without signing in (migration M13), and players manage their gladiator from a hidden-rail shell, with replays and expeditions opening over the camp. Task 18 added the fixed-price marketplace (M14): atomic listings, purchases and expiry, and the 💰 Marketplace menu that visitors can browse. Task 21 added seasons (M15): 28-day seasons close at the boundary into a frozen public archive with one-time top-3 rewards, titles and badges, and seasons live inside Arena standings. Task 22 added retention and operations (M16): an hourly bounded cleanup prunes replay detail after 7 days and summaries after 90 days without touching a grant guard or an unfinished job, `npm run health` reports operator health with alerts, a scripted export and restore check proves a backup is recoverable, and the client says when a replay is no longer kept. Task 23 hardened and measured the release (M17–M22): a catalog-driven access matrix revokes every client privilege beyond SELECT, slot timing no longer depends on when a run starts, boundaries publish in about 61.6 s at 50 characters, the static export ships CSP headers, `npm run verify` runs the whole release gate (also in CI), keyboard and screen-reader players can use every menu, and, on Avi's decision, settled jobs are trimmed, the database budget is 500 MB and idle characters rest at home after 14 days without an activity signal.
- Codex pushed Task 6 at `ec6939386e7fd0e2f997d0389238bce4d068cc64`; Claude pushed the first takeover checkpoint at `9b39edc` (Task 6 merged with Tasks 11/12, R2 applied) and the second at `9f2b69d` (Tasks 7 and 14; see the checkpoint sections below).
- M01–M25 are committed and immutable (M23 `20261025201936_launch_feedback` and M24 `20261026160844_appearance` came with Task 24; M25 `20261028165017_messages` came with the game-messages patch): `20261012050952_identity`, `20261012121232_build_schedule`, `20261012135526_activities_jobs`, `20261012143533_task7_review_fixes`, `20261013065108_inventory_shops`, `20261013125213_expeditions`, `20261014045856_projections`, `20261014100253_projection_preparation_status`, `20261014113448_arena`, `20261014131209_arena_bouts`, `20261014160257_tournaments`, `20261014174629_tournament_results`, `20261016141628_visitor_access`, `20261017144347_market` (M14), `20261018123715_seasons` (M15), `20261018191110_operations` (M16), `20261019075634_release` (M17), `20261019102324_timing` (M18), `20261019124532_dispatch_released` (M19), `20261019132814_shared_reveal` (M20), `20261019180659_job_payloads` (M21), `20261020075858_idle_rest` (M22). M09–M12 deploy together with the matching worker in one step (Task 24); M13 (visitor read access) ships with or after them. M18 and the worker deploy before or with the client; M22 deploys before the Edge function and with the client that sends `presence` (see "Task 23 checkpoint" below).
- **Next:** Task 9 (a clip for the players) and Task 10 (expedition replays, design and mockup first) of the [game-messages plan](../superpowers/plans/2026-10-28-game-messages.md); its Tasks 1–8 are released (see "Game messages patch released" below).
- **Future patch (Avi, 2026-10-29, keep in mind; not planned yet):** a few bot gladiators (AI players) that each have a
  name and play as one team, more of them over time, so the camp and the arena feel livelier. Design it (fair play against
  real players, schedules, rewards, how players can tell they are bots) when Avi asks to plan it. **Earlier (Task 24 start):** Tasks 13, 18, 21, 22 and 23 are complete ([Task 13 report](task-13-report.md) and [reviews](task-13-review.md); [Task 18 report](task-18-report.md) and [reviews](task-18-review.md); [Task 21 report](task-21-report.md) and [reviews](task-21-review.md); [Task 22 report](task-22-report.md) and [reviews](task-22-review.md); [Task 23 report](task-23-report.md) and [reviews](task-23-review.md)); their carried items for Task 24, and Avi's open product choices, are listed at the end of each review record. Task 24 continues from "Task 24 progress (Claude, 2026-10-21)" below and [the deployment checklist](../operations/deployment.md).
- Task 13 consumes the reviewed Inventory/Shop, Arena/Standings and Tournament panels and mounts Task 10's sync controller.
- Do not reimplement completed tasks.

Every completed task has a tracked `task-NN-report.md` with changes, interfaces, commands/results, limitations, and file-map adjustments, plus a `task-NN-review.md` containing the review verdict and any fixes. Read those before changing dependent code. The plan remains the task queue; the design binds exact behavior.

The executing controller also maintains ignored scratch artifacts under `.superpowers/sdd/2026-10-11-gladiator-arena-implementation/`. Those files are optional local process state, not the only handoff record. In a fresh checkout, reconstruct briefs from the committed plan and these reports.

## Completed tasks

| Task | Commit range | Review | Verification and limitations |
| --- | --- | --- | --- |
| 1 — Static shell and contracts | `2261fb7..096a02e` (source `9ca36d9`, report `096a02e`) | Spec compliant; quality approved; [review](task-01-review.md) | 17 unit tests; four development and four production browser checks; TypeScript, static build, and 35-asset scan passed. Fixture-only preview; authentication/backend/animations remain later tasks. |
| 2 — Versioned rules and stats | `275625f..f668893` (source `a361ecd`, report `f668893`) | Spec compliant; quality approved; [review](task-02-review.md) | 82 owning tests, 99 full-suite tests, TypeScript/whitespace passed. Clock/catalog/build validation and fixed-point stats complete. Backend must supply verified inventory and perform reservation/fee/boundary transactions. |
| 3 — Deterministic combat | `190d8c7..9fffaf5` (source `f6d9081`, report `f385221`, fix `9fffaf5`) | One Important corrected; focused re-review approved; [review](task-03-review.md) | 110 affected and 146 full-suite tests, TypeScript/whitespace passed. Fixed named PRNG, simultaneous events, exact damage/tie handling, immutable sanitized log. Seeds, timed reveals and settlement remain backend tasks. |
| 4 — Protected persistent identity | `b739870..4a2ee84` (source `6bf2d97`, UUID fix `0769a12`, report `4a2ee84`) | Spec compliant; quality approved; [review](task-04-review.md) | 151 units, 11 real DB/Auth/RLS/Edge tests, TypeScript+Deno compile/runtime passed. CLI-generated M01 reset/replay and lint clean; one unused-index INFO. Hosted Google/CORS/configuration proof remains Task24. |
| 5 — Google login and character creation | `3d41ae9..a003751` (source `8fcb9c3`, stale-owner fix `5b3c2a5`, report `a003751`) | Spec compliant; quality approved; [review](task-05-review.md) | 153 units; 22 development browser checks plus 8 final affected checks; 6 production checks; TypeScript/Deno compile/runtime, fresh build/static37asset scan passed. Real Google/provider/CORS proof remains Task24; browser identity transport is test-only. |
| 6 — Schedule revisions and pending builds | `ad1b7e8..ec69393` (source `f35c9ac`, report `1b45b20`) | Spec compliant; quality approved; [review](task-06-review.md) | 153 units, 26 real DB/Auth/Edge tests on a clean M01/M02 replay, 30 development and 6 production browser tests. Details under "Task 6 reviewed planning checkpoint". |
| 11 — Production pixel art and manifest (Claude) | `b739870..8f83ba8` on `claude/visual-track` (`edd78ab`, `6f99f50`, `bc5b4d6`, `3051531`, `e5eb8fc`, `8f83ba8`) | Round 3: spec Pass, quality Pass; [review](task-11-review.md) | Code-generated original art (Avi-approved route): 10 atlases, 1,719 frames, 116 animations, 4 maps; `build-assets --check` deterministic; 33 asset tests. Close-up battle view deferred to Task 14 with acceptance criteria ([report](task-11-report.md)). |
| 7 — Ordered boundaries, Training/Rest, fenced jobs | `9b39edc..92eec27` (source `0dea40c`, report `5919999`, review fixes `8aa29e5` with M04, report update `92eec27`) | Spec Pass, quality Pass, ready with fixes; scoped re-review of the fixes Pass; [review](task-07-review.md) | 234 units, 61 real DB/Auth/Edge tests on a clean M01–M04 replay (real pg_cron, pg_net and worker HTTP), typecheck incl. both Deno entrypoints, build/static scan, 63 dev browser checks. Expedition/Arena boundaries stall truthfully until Tasks 9/16; hosted scheduling is a Task 24 gate ([report](task-07-report.md)). |
| 12 — Living isometric camp (Claude) | `bc5b4d6..33016d6` (`c6aeab0`, `3051531`, `ddb9bec`, `e5eb8fc`, `8f83ba8`, fix `33016d6`) | Rounds 2–3: spec Pass, quality Pass; Codex scoped review of `8f83ba8` Pass plus one Minor (fixed in `33016d6`); [review](task-12-review.md) | 33 scene-layout tests; 17 camp browser tests on desktop and mobile; R2 applied at this checkpoint. Task 13 must add the shared sync clock and a scene-availability status ([report](task-12-report.md)). |
| 14 — Battle-log replay (Claude) | `9b39edc..3283feb` on `claude/task-14` (source `344521b`, report `6607017`, review fixes `3283feb`), merged at `9f2b69d` | Spec Pass, quality Pass, visual Pass, ready; [review](task-14-review.md) | Pure replay core, close-up battle scene meeting the four Task 11 criteria, `/replay/?activity=` fixed route, engine-generated fixture logs (PvP, NPC, expedition, tie-break, expired). 296 units, 99 dev browser checks in its worktree. Live replays wait for Task 10's `timeline()` ([report](task-14-report.md)). |
| 8 — Inventory, rewards planner and NPC shops | `8195ff5..28d1fee` (preserved WIP merge `4be59b3`, source `801eea1`, report `28d1fee`) | Spec compliant; quality Approved; [review](task-08-review.md) | 352 units; all 83 DB tests covered green across final replay runs; 67 affected browser checks/1 skip; production 6/2 skips; TypeScript/Deno; fresh 81-asset scan; M05 replay and 228-entry parity. See [report](task-08-report.md) for exact run split, grants/XP/history/cosmetic contracts and remaining integrations. |
| 9 — Timed expeditions and fenced rewards | `05b1ea0..545a82d` (source `e96e0f1`, report `5dbf34e`, fix `545a82d`) | One Important corrected; scoped review Approved; [review](task-09-review.md) | 103 DB/Auth/HTTP +4 focused privacy/token cases, 297 affected units, 258-entry M06 parity, fresh81-asset scan; fix2RED→75 focused passes and TS/Deno. See [report](task-09-report.md) for distinct runs and remaining read-model/hosted gates. |
| 10 — Safe projections and revision polling | `62f24cc..8b4464e` (source `36fd2b4`, report `7f413e5`, fix `a699384`, correction report `8b4464e`) | One Important corrected; scoped review Approved; [review](task-10-review.md) | Final M01–M08 replay109 DB/Auth/Edge and303 parity; earlier376 units plus final12 focused,22 browser, compile/static81. See [report](task-10-report.md) for distinct runs and deferred offset/UI/hosted gates. |
| 15 — Followable expedition scenes (Claude) | `05b1ea0..59e0db7`, root merge `930c2c7` | Full/scoped spec, quality and visual Pass; [review](task-15-review.md) | Claude399 units,153 dev browser passes/7 skips; root combined74 focused units, TS/Deno, fresh5-route90-asset scan and repo-config production8 passes/118 expected skips. [Integration evidence](task-15-integration.md) records distinct runs and UI/hosted gates. |
| 17 — Arena staging, selection and standings (Claude) | `708688b..26acc23` on `claude/task-17` (brief `95eb764`, source `98284aa`, report `88e2e58`, approved shared edits `1f01531`, fixes `e3392fb`/`ff01dba`, follow-up `6df1b78`/`f429c83`, review `26acc23`) | Three rounds: spec, quality and visual Pass; [review](task-17-review.md) | 453 units; 172 dev browser passes on port 3300. Camp rings play each bout at its real time, after a ~4 s jog walk-in; Arena card and standings. Live reads wait for Task 10/16 wiring ([report](task-17-report.md), integration checklist). |
| 20 — Tournament countdown, brackets and camp roles (Claude) | `08998e6..7182196` on `claude/task-20` (source `c1ff143`, report `b67a06c`, fixes `ffc1e2f`/`2cafdeb`, Task 17 merge `b7f38ad`, shared guard `b48ce1f`, review `7182196`) | Full review: spec Fail (2 Important) then fixed; scoped re-review spec, quality and visual Pass; [review](task-20-review.md) | 856 units; 256 dev browser passes / 0 failures on the combined branch. Role-safe `TournamentView` placements, round-1 placement field and the opt-in RPC are Task 19 phase 2 gates ([report](task-20-report.md)). |
| 16 — Leagues, Arena pairing, bouts and ratings (Claude) | phase 1 `claude/task-16` `fc4832b`; phases 2a and 2b on `claude/task-16-p2` (`6e8fd57` M09, `430aec3`, `d3797e7`; `31cfdaa` M10, `deda395`; timing fix `337f38d`/`a1c6732`; re-review fixes `cf325d1`/`ee44626`) | Spec and quality Pass in every round; [phase 1](task-16-phase-1-review.md), [2a](task-16-phase-2a-review.md), [2b and timing](task-16-review.md) | 888 units; 137 DB/Auth/Edge on a clean M01–M10 replay with Edge stable; 260 dev browser, 14 production. 50 characters at production cron cadence: publication 61 s with a cleared dispatch window, 121 s with a held one (a Task 23 policy decision); bouts finish at least 3 359 s before the minute-60 reveal ([report](task-16-report.md)). |
| 19 — Automatic league tournaments (Claude) | phase 1 `claude/task-19` `be28376`; phase 2 on `claude/task-19-p2` (`81dc36b` M11, `f9e3d97`, `a9f25d3`; `505b2b3` M12, `e4df403`; review fixes `477f673`/`fa0f7a2`) | Spec and quality Pass in every round; [phase 1](task-19-phase-1-review.md), [2a, 2b and fixes](task-19-review.md) | 922 units; 172 DB/Auth/Edge on a clean M01–M12 replay with Edge stable; 266 dev browser, 14 production. Includes the Task 16 phase-8 deadlock fix (40P01 regression). Polled tournament reads carry no battle logs (39–59 KB at 50 entrants); logs load on demand. 50 entrants at production cron cadence: publication 61 s with a cleared window (121 s in 4 of 9 runs, the coordinator race) and 121 s with a held one; all credited about 1 s after minute 80 (about 60 s later with a held window) ([report](task-19-report.md)). |
| 13 — Full-screen camp, visitor viewing and live management (Claude) | `claude/task-13` `6f118cc..30257f1` (checkpoints 13.1–13.9, final fix wave `30257f1`; M13 `20261016141628_visitor_access`) | Nine task reviews plus a final whole-branch review: spec and quality Pass, ready to merge; [reviews](task-13-review.md) | 995 units; 177 DB/Auth/Edge on a clean M01–M13 replay with Edge stable; 394 dev browser, 16 production (repo config). Visitors read public projections as `anon`; a late tournament joiner loads 8 of 34 logs ([report](task-13-report.md)). |
| 18 — Fixed-price marketplace (Claude) | `claude/task-18` `925d125..248debe` (18.1 `b052ea0` with M14 `20261017144347_market`; 18.2 `ae5d0c3`; 18.3 `32e73cf`; report `78104fd`; final fix wave `248debe`) | Three task reviews plus a final whole-branch review: spec and quality Pass, ready after one fix; [reviews](task-18-review.md) | 1020 units; 193 DB/Auth/Edge on a clean M01–M14 replay with Edge stable; 412 dev browser, 16 production (repo config). Purchases are atomic (two-account locks in gladiator order, 40P01 retried), the 5 % fee is floored, offers are public and read-only for visitors ([report](task-18-report.md)). |
| 21 — Seasons, rewards and prestige (Claude) | `claude/task-21` `69ed674..c7f724a` (21.1 `ab4b1a0`/`61274dd`; 21.2 `c615091` with M15 `20261018123715_seasons`; 21.3 `479583f`; 21.4 `f4c118f`/`35cefb8`/`bab7580`; final fix wave `1ef320f`/`ce9f4fa`; reports `2b1a4ab` and `c7f724a`) | Four task reviews plus a final whole-branch review: spec and quality Pass (21.4 after one fix round), ready to merge; [reviews](task-21-review.md) | 1056 units; 218 DB/Auth/Edge with Edge stable and a clean M01–M15 replay with an identical fingerprint (216/216 at 21.2); 430 dev browser, 16 production (repo config). 28-day seasons close at the boundary into a frozen public archive; the top three of each league are paid once, with titles and badges; seasons sit inside Arena standings. A launch-order limit (epoch before any boundary with members) is carried to Task 24 and M16 ([report](task-21-report.md)). |
| 22 — Retention, health reporting and recoverable exports (Claude) | `claude/task-22` `b4b3521..b0a2e8e` (22.1 `34dae0a`; 22.2 `782facc`; 22.3 `0f86b3e` with M16 `20261018191110_operations`; 22.4 `30d27b1`/`cdeb641`; 22.5 `e5d0f2d`; final fix wave `4eab68b`/`1a1cf70`/`85fe838`; records `b0a2e8e`) | Five task reviews plus a final whole-branch review: spec and quality Pass (22.4 after one fix round), ready after one documentation fix; [reviews](task-22-review.md) | 1102 units; 256 DB/Auth/Edge with Edge stable and a clean M01–M16 replay with an identical 1127-line fingerprint at 22.3; 444 dev browser, 16 production (repo config); a real export → restore check (54 tables and 2653 rows matched, nine invariants and three guard probes passed). An hourly bounded cleanup keeps 7-day replay detail and 90-day summaries, folds the old ledger into wallet checkpoints and never deletes a receipt, a grant guard or an unfinished job; 22.5 was built in a parallel lane and integrated by cherry-pick. Deploy M16 with the 22.5 client; hosted `pg_net.ttl`, the cron-details privilege, the untested `-Remote` export and Vault secrets after a restore are carried to Task 24 ([report](task-22-report.md)). |
| 23 — Release security, accessibility and measured capacity (Claude) | `claude/task-23` `b6bd8c7..b87949a` plus the records commit (plan `8e04214`; 23.1 `9316d51` with M17 `20261019075634_release`, fixes `f7e6534`/`68f7511`; 23.2 `27a9e62` with M18 `20261019102324_timing`; 23.3 `a167ab9`, `119f36b` with M19 `20261019124532_dispatch_released`, `76449e6` with M20 `20261019132814_shared_reveal`; 23.4 `f16c8cf`/`54e8aa2`/`199b86e`; 23.5 `4e778da`/`ad0a316`; 23.6 `c9dc6f4`/`6bb7380`; 23.7 `694fe7b` with M21 `20261019180659_job_payloads`; 23.8 `8db6700`/`f1cf073`/`46f176e` with M22 `20261020075858_idle_rest`; 23.9 `8e3ce98`/`dffec51`; LF rule `7d36068`; 23.10 `4a8b670`/`d75e3fc`; final fix wave `d88a27c`..`b87949a`; records: the commit that adds this row) | Ten task reviews plus a final whole-branch review: spec and quality Pass (23.1 after two fix rounds; 23.3, 23.4, 23.5, 23.6 and 23.9 after one), ready to push after one fix wave; [reviews](task-23-review.md) | 1251 units; 299 DB/Auth/Edge with `CAPACITY_GATE=1` and Edge stable; a clean M01–M22 replay with an identical 1160-line fingerprint at 23.8; 541 dev browser, 34 production; `npm run verify` 12/12 at `d75e3fc`; after the final fix wave, 12/12 again at `7260b59` (1254 units, 300 DB/Auth/Edge, 541 dev, 34 production). Every client privilege beyond SELECT revoked and proven by a catalog-driven access matrix; per-minute dispatch and a published-slot signal; boundaries publish in about 61.6 s at 50 characters (zero headroom, a named risk); CSP headers, the full release gate and CI; keyboard and screen-reader fixes; the database inside a 500 MB budget at 90 days (Avi's A + C + D: settled job payloads trimmed, idle characters rest after 14 days); shorter slot times. Lane B was built in `Cloudiator-replay` and moved onto the branch. Mobile 30 fps, hosted CPU, egress, CORS and the remote export are Task 24 blockers ([report](task-23-report.md)). |

Deferred Minors: Task 19's gates for Tasks 13, 22 and 23 are listed at the end of its [review](task-19-review.md); the existing browser color warning and expected-diagnostic assertions (Tasks 1/8, Task 23/final triage); Task 6's stale estimated schedule clock (Task 13); Task15's safe-point leave pose/encounter-count/test-title Minors and Task10's initial-load clock-offset bias (Task13/final triage). Task14's two remaining Minors are resolved in reviewed708688b and the Task15 integration. The escaped-seed scanner gap is resolved in the reviewed supplement below.

## Coordination history (Codex and Claude)

**Current state:** Codex handed all remaining work to Claude on 2026-10-14 (Avi's instruction). The split history below is kept for the record only.

Avi explicitly authorized communication and parallel development through the [Cloudiator Message Board](https://docs.google.com/document/d/1Fz_MTVcUJkBU52wRuLQCgftMzJtTNn3l6snRQw9RSkM). Claude replied with a layer split, and Codex posted agreement and ownership refinements.

- Codex owns Tasks 1–10, 16, 18, 19, 21, and 22: root dependency/config files, `supabase/**`, `src/app/**`, `src/lib/api/**`, management features, existing domain/backend/database/browser tests, and this handoff file.
- Claude owns Tasks11/12/14/15 and subsequently ACKed13/17/20: `assets/source/**`, `public/assets/**`, `tests/assets/**`, `src/game/**`, `src/features/arena/BattleReplay.tsx`, and `src/features/character/ExpeditionView.tsx`. Reserved tests: `tests/assets/manifest.test.ts`, `tests/assets/png-tools.test.ts`, `tests/domain/scene-layout.test.ts`, `tests/domain/replay.test.ts`, `tests/browser/camp.spec.ts`, `tests/browser/replay.spec.ts`, `tests/browser/expedition.spec.ts`. Claude may author only those task numbers' report/review files in `docs/implementation/`.
- Claude confirmed `C:\Avi\Studies\Projects\Cloudiator-claude` on `claude/visual-track`, initially based at `096a02e`; Claude confirmed fast-forward to reviewed `190d8c7`. Codex verified the actual worktree in Git inventory. Later reviewed contracts are posted on the board before integration.
- Claude ACKed UI Tasks13/17/20 with exact reserved new files after reviewed prerequisites: CharacterPanel/RosterPanel/useGameState, ResultsPanel, ArenaPanel/StandingsPanel, TournamentPanel and management/arena/tournament browser tests. Existing auth/create/schedule/build/inventory/shop, routes/styles/gateway/contracts remain Codex-owned; exact requests precede shared-file edits. Codex retains marketplace18 and release23/24.
- Shared contract, dependency, config, or app integration changes require an exact request to the owning agent. Do not edit the other lane's files.
- Codex coordinates independent review and integration. Claude posts base/head SHAs, touched paths, actual checks, limitations, and readiness; never merges directly into the integration branch.
- If the agents share a physical checkout, serialize all Git operations and never switch/reset/stash/delete/merge concurrently. Independent branches in separate checkouts are preferred.

## Decisions and environment

- Explicit local development/test fixture mode is allowed; production static exports deny it. Task 1 verifies both cases.
- Task 1 checks TypeScript and contracts. Actual Edge entrypoints introduced in Task 4 must add Deno checking.
- Player allocations, counts, and currencies must be finite safe integers. Derived attributes and immutable item values can have two decimal places, as required by class/tier/rarity formulas. Arena modifiers preserve additional intermediate precision until final damage rounding (Task3 regression: armor6.65×1.1=7.315).
- Task 2 controller ruling: an empty weapon contributes zero item damage and uses a 1000 ms base interval; later combat can still add Strength damage. The specification does not define unarmed stats. Cost if wrong: revisit unarmed balance.
- Task 2 controller ruling: named versioned upper bound 1,000,000,000 for player level/point inputs and total earned/allocation budgets, alongside safe-integer checks. The plan requires oversized rejection without exact caps. Cost if wrong: raise this administrative limit for future legitimate progression.
- Task 3 controller ruling: identity is supplied by private BattleInput, keeping the specified makeFighter signature unchanged. Revealed logs add initialHealth, event sequence/defend/evade, participant-order finalHp tuple, and explicit tie-break cause. Expedition carried HP and read-only replay need these fields. Cost if wrong: revise additive renderer fixtures/contracts. Claude was notified before replay work.
- Task6 controller ruling: add required OwnerState.buildVersion as a monotonic build-command edit revision. Queue/replace/cancel use it for expectedVersion while currentBuild.version remains the active build identity until activation; pending build.version identifies its eventual revision. The specification preserves current snapshots but the original DTO lacked a visible cancellation revision. Cost if wrong: additive DTO/projection/fixture/consumer reconciliation. Producer passed review at 1b45b20; consumers must use the reviewed Task6 report and actual controller checkpoint.
- Task6 controller ruling: the service-only cancel_build RPC also receives the canonical expectedVersion command input, extending the plan's two-argument shorthand. Version checks must occur inside the locked transaction; an adapter-only check would race. Cost if wrong: reconcile the internal RPC signature in later callers/tests. The reviewed signature and canonical command input are recorded in task-06-report.md; no player may invoke this backend-only RPC directly.
- Task 6 controller ruling: supported CLI clean migration reset/replay may temporarily restart the verified isolated local Cloudiator Edge service, followed by restoration and HTTP/owning-test verification. Required migration proof takes precedence over continuous availability of an idle local test service. Cost: brief local backend downtime. Keep preview port3000 and unrelated/hosted services untouched; capture credential-bearing output in ignored logs and inspect sanitized errors only.
- Task 11 controller ruling: allow original pixel art authored by deterministic source-code generators as a third production route. Claude lacks an image-generation tool; reproducible original sources can meet the binding asset outcome. All frame, direction, action, equipment, provenance, and colorful fantasy requirements remain mandatory, including independent visual review against reference A. Cost if wrong: rework assets with generated/licensed sources if visual quality fails. Claude had asked Avi about this route; any subsequent human preference overrides the controller's method choice. Codex can supply generated sources if later review requires them.
- Task 7 controller rulings (Claude): derived stats come from fenced TypeScript `prepare` jobs in phase 4 (adopting Codex's ledger ruling); phase 4 recomputes the stamina maximum, clamps down and never refills; renewal extends a lease without rotating its token; completion requires an unexpired lease; three failures or three expired leases put a job in `operator` state (resumable through `private.resume_operator_job`); unsupported activity kinds (Expedition before Task 9, Arena before Task 16) stall their boundary with no debit, job or checkpoint advance, and are never settled as Training/Rest; `private.scheduler` is off by default; the worker secret is a server-only value of at least 32 characters compared in constant time. Cost if wrong: later executors must keep the hook signatures in `task-07-report.md`.
- Task 7 review-fix rulings: `private.settle_rewards` returns `{rewards, result, success, replayExpiry, ratingDelta?}` and `settle_activity` validates it fail-closed; the activity snapshot seed is authoritative and copied onto jobs; `coordinate_work` isolates each boundary in a subtransaction and persists only a sqlstate, never raw error text. Recorded gates: job dependency ids and reveal-before-settlement claiming (Tasks 9/19), lease renewal during long jobs (Task 9), a non-replay `replayExpiry` state for Training/Rest (Tasks 10/13), and Task 13 combining `currentActivity` with `processedSlotIndex` for the Processing/Preparing states.
- Task 14 controller rulings (Claude): the replay core is pure and reads HP only from the log; fighters draw at an integer 3× scale from the shared atlases; expedition enemies must carry `creature:<manifest creature id>` participant ids (Tasks 8/9), otherwise the replay draws an NPC fallback with a development-only warning; camp click-to-replay belongs to Task 17; live replays need Task 10's `timeline()`.
- Migration generation note (Tasks 6, 7 and the Task 7 fix): the CLI's `db pull` draft omitted extensions, seed rows, `cron.schedule`, function ACLs, table revokes and a view's `security_invoker`. Avi approved a standing check on 2026-10-12, now in the AGENTS.md Supabase override: diff every generated migration against its SQL source, append the omissions, then verify the replayed database.
- Task 23 builds and locally verifies release harnesses; hosted benchmarks run after Task 24 provisions infrastructure.
- Verified pins: Next 16.4.0, React/React DOM 19.3.0, TypeScript 5.9.3, Phaser 4.2.1, Vitest 5.0.3, Playwright 1.64.0, React type packages 19.3.0, Node types 22.20.5. Runtime Node 22.19.0/npm 11.8.0.
- Docker Desktop is installed locally (Engine 29.9.1 after the 2026-10-20 host restart; 29.8.2 before). Supabase CLI2.120.0, client2.117.3, npmDeno2.9.6 and test-driver postgres3.4.7 are pinned/installed. LocalPG17.11, real Edge runtime and Deno checks passed Task4; see migration guide for sanitized setup.
- Supabase account is connected, but no Cloudiator project exists. Two unrelated inactive projects must not be reused or changed. Hosting, Google OAuth, real deployed flows, and measured hosted/mobile capacity remain pending.
- Default sandbox networking, Git Bash, and the native Next compiler encountered environment restrictions. Necessary approved escalations worked; these are environment issues rather than product test evidence.
- `next dev` generates `AGENTS.md`. Its local Next documentation guidance applies. Preserve Avi's standing skill-upkeep instructions as well.

## Task checkpoint protocol

1. Record the task's base commit before implementation. Pass the exact task brief, binding constraints, and relevant previous reports to a fresh implementer. Keep the mainline sequential. Independent tasks may run in parallel only in separate checkouts with declared file ownership.
2. Implement the owning task with meaningful red/green evidence. Commit exact task files and a detailed commit body; keep credentials, exports, and generated builds ignored.
3. Generate a review package for the entire base-to-head range. Obtain independent specification and quality verdicts. Fix blocking findings through the implementer and scoped review.
4. Commit the durable report/review and update this file with the task range, verdict, tests, limitations, and next task. Push the feature branch and verify the remote head before reporting it uploaded.
5. Continue all authorized tasks. Ask only for genuinely missing account choices or actions needing authorization; do not add continuation gates between tasks.

After all tasks, perform the whole-branch review and full release verification described in the plan. Do not claim a public launch based only on fixture tests or static build success.

### Task4 local tooling findings (reviewed; hosted gate remains)

- Current CLI2.120.0 rejects multi-statement SQL through db query --file; the local-container psql fallback and exact commands are verified in task04 report/migration guide, including generated M01 clean replay and advisors.
- Local Kong functions gateway overrides handler Access-Control-Allow-Origin with wildcard, with no supported CLI config found. Controller permits characterization only for this local tooling limitation: exact-origin handler and direct-Edge HTTP tests plus actual gateway bad-origin403/no-state-change tests remain required. Task24 must verify hosted header parity before launch; a failure needs a supported boundary or concrete user options. Cost: hosted proof deferred; possible additional boundary work.
- A diagnostic accidentally printed isolated local development keys in tool output. No hosted project/credentials were involved. No key values belong in reports/board/commits; a sanitized tracked/staged scan is required. This records the observed failure, not a rotation or public exposure claim.
- Avi approved the Supabase skill-upkeep override on2026-10-12. The persistent project guidance is appended to rootAGENTS.md, referencing the tested local CLI2.120.0/psql workflow in migrations.md. Existing Next/upkeep rules remain intact; vendor caches are unchanged. Whitespace/content markers checked; the update was committed and pushed in reviewed checkpoint3d41ae9.


Claude marked Tasks 11/12 ready at `8f83ba889fb0f13341776afb7c55e1fb69a9b01a`, including the reviewed Codex checkpoint `ad1b7e8`.
- A fresh scoped Codex review of `8f83ba8` confirmed every prior Minor addressed. It reproduced one new Minor: a disposed scene's queued refusal could cancel a replacement scene's follow.
- Claude fixed it in `33016d6`. A lifecycle regression failed first, receiving `['g1', null]`.
- Claude then integrated it with Task 6 (next section). C1 machine types are consumed; battle catalog-ID silhouettes are unchanged.

Task14 retains the recorded close-up replay acceptance criteria: reproducible arena backdrop, layered fighters at integer3x scale facing each other, no action clipping, correctly placed effects and readable desktop/mobile screenshots at360px width. Task13 must use the shared live sync clock and provide a scene-availability status for late panels. Physical FPS remains Task23; those later requirements are not claimed by camp screenshots.

### Takeover and integration checkpoint (Claude, 2026-10-12)

**What it contains**
- The merge of reviewed Task 6 `ec69393` into `claude/visual-track` (merge commit `362ed34`), which was clean.
- The Task 12 fix `33016d6`.
- **R2 applied** to `src/app/game/page.tsx`. The rebased patch no longer applied verbatim after Task 6 added imports, so the same six edits were re-applied by hand. In fixture mode only, the page now:
  - mounts `GameViewport` with a page-scoped `SceneBridge`;
  - loads `gateway.world()` next to `owner()`, plus the demo crowd (world kept within 50 rows);
  - passes `focusGladiatorId` as the owner's id;
  - corrects the fixture note.
- Live and production mode still show the placeholder. Task 6's `SchedulePanel` and `BuildPanel` mounting is unchanged.

**Verification, from the worktree, after this file's update**
- `npx supabase db reset --local --no-seed --yes`: a clean replay of M01 and M02, with output captured in an ignored log.
- `npx supabase functions serve --env-file .env.edge.local`, run from the worktree. This replaced Codex's earlier serve container, so the real Edge tests exercise this checkpoint's code, not Codex's uncommitted files.
- `npm test`: 219 passed.
- `npm run typecheck`: tsc, frozen Deno check and Deno test all pass.
- `npm run test:db`: 26 passed.
- `npm run build` and `npm run verify:static`: 3 routes, 69 assets, no forbidden material. The 69 assets include two lazy chunks that the fixture-only camp import makes Turbopack emit: Phaser, about 1.37 MB, and the atlas data, about 0.73 MB. The production `game/index.html` never loads them, so they cost only deploy size. Task 13 will load them in live mode.
- Development Playwright, desktop and mobile: 63 passed, 5 skipped. This includes the shell, identity, planning and camp suites.
- Isolated production gate (`CLOUDIATOR_BROWSER_TEST=true` build, `verify:static -- .next/browser-test`, `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test` with shell and camp): 6 passed. The rest are skipped by design: the camp is fixture-only, plus the 2 shell skips.
- A broader production run, which also included the identity and planning suites, failed 7 tests. Those suites need the development-only test identity transport and are not part of the production gate (Task 5 report). That run is excluded from evidence.

**Environment notes.** The Edge runtime now serves the worktree's `supabase/functions` (`.env.edge.local` is ignored). The preview on port 3000 belongs to Codex's checkout and was not touched.

### Second takeover checkpoint: Tasks 7 and 14 (Claude, 2026-10-12)

**What it contains**
- Task 7 (`0dea40c`, `5919999`), its review fixes with M04 (`8aa29e5`, `92eec27`), and the merge of `claude/task-14` (Task 14 at `3283feb`) into `claude/visual-track`.
- Avi switched the executing model to Fable 5.1 partway through (the Task 7 fix pass, the Task 14 review and the Task 7 re-review ran on it; both stopped agents restarted from committed state with nothing lost), then back to Opus 5.5.

**Verification, from the worktree, after the merge**
- Clean `npx supabase db reset --local --no-seed --yes` replaying M01–M04; Edge served from the worktree with `GAME_WORKER_SECRET` in the ignored env file.
- `npm test`: 311 passed. `npm run typecheck`: tsc, Deno check of `game-command` and `game-worker`, Deno runtime tests.
- `npm run test:db`: 61 passed.
- `npm run build` and `npm run verify:static`: 4 fixed routes (`/replay` added), 81 assets, no forbidden material.
- Development Playwright, desktop and mobile: 99 passed, 5 skipped (shell, identity, planning, camp, replay).
- Isolated production gate (shell and camp against `.next/browser-test`): 6 passed; the rest skip by design.

### Claude integration checkpoint after the full handover — 2026-10-14

**What it contains**
- Origin `b83d7e3` (Codex's reviewed Tasks 10 and 15) merged into `claude/task-20` as `eeaf606`, with no conflicts.
- `claude/task-20` combines Claude's reviewed work: Task 17, Task 20, and the Task 16 and 19 phase 1 domain. Task 15 is the same `59e0db7` Codex integrated, so it is not duplicated.
- `938c34d`: Avi's approved build and browser output separation override, in `AGENTS.md` and `docs/operations/verification-gates.md`.
- `3bd7e63`: the Arena fixture test accepts Task 10's nullable `combatStrength`.
- `d25f2f0`: `planning.spec.ts` gets the production skip that `identity.spec.ts` and `inventory.spec.ts` already have, because it uses the same development-only identity transport. Without it, a full static run reported 6 infrastructure failures.

**Runtime**
- Codex's root `functions serve` process (serving the root checkout with Codex's secret) was stopped.
- A clean `db reset --local --no-seed --yes` replayed M01–M08.
- Edge is now served from `Cloudiator-claude` with its own ignored `.env.edge.local`.
- No root files were touched.

**Verification, in the order of `docs/operations/verification-gates.md`**
- `npm test`: 867 passed. `npm run typecheck`: tsc, both frozen Deno entrypoints and the Deno runtime tests.
- `npm run test:db`: 109 passed on the clean M01–M08 replay.
- `npm run build` and `npm run verify:static`: 5 fixed routes, 91 assets, no forbidden material.
- Development Playwright on port 3200, desktop and mobile: 258 passed, 8 skipped.
- Isolated production gate (`.next/browser-test`, run after the development run): 14 passed, 252 skipped by design.
- One infrastructure fault happened during this checkpoint. A first gate run had a type error, and its failed builds left a stale `out/` that the static scan read. After the fix, every build-dependent step was rerun in order; the numbers above come from that rerun.

### Task 19 checkpoint (Claude, 2026-10-14)

- **Shipped together:** M11 and M12 (phase 2a's bout jobs have no result acceptance without phase 2b; never deploy M11 alone).
- **Contract changes:** `TournamentView.bracket {size, rounds, slots}` (the seeded first round, public from the start); placements `{gladiatorId, place, completion: PublicActivitySummary}`, empty until every entrant settles; an `insufficient-entrants` status; the live `tournament(id)` read with lookup id `tournament:<slot>:<league>` (pure, in `src/lib/tournament-id.ts`); `TournamentBout.revealedResult.fight?` (duration, victory reason, tie-break reason); `GameGateway.tournamentLog(boutId)` for on-demand logs. Owner rewards come only from the owner's own timeline.
- **Task 16 fix inside M12:** `private.boundary_start` takes every preparing member's account lock, in gladiator order, before the debit loop.
- **Reassigned:** the engine-free `isTournamentSlot` gate (Task 20) now belongs to Task 13. The client-readable `tournament_views.pairing_job_id` is closed by Task 13's column-by-column visitor-access grants. The coordinator busy race is a Task 16 follow-up under Task 23.

### Task 24 progress (Claude, 2026-10-21)

**Status.** [The Task 24 plan](../superpowers/plans/2026-10-20-task-24-launch.md) (Avi accepted all 17 recommended answers on 2026-10-20) has its local steps done, each with an independent review and fix round, and pushed as `0d4a1b0..7ccc990`. The gate of record at `7ccc990` passed 12/12 (units 1391; `test:db` 312 with `CAPACITY_GATE=1` and the Edge start time unchanged; development 547 passed; production 34). The hosted steps (24.3 onwards) need Avi's accounts; Claude never handles a credential.

**What the local steps added**
- **24.0:** the Edge refresh tolerates Deno's dependency cache changing mid-walk (still refreshing it); the mobile market flake's cause (a bottom sheet still rising when the Buy button was measured) is fixed; activity end, reveal and expedition stage times use the short slot-time format (Avi, 2026-10-20).
- **24.0c:** CI (`.github/workflows/checks.yml`, no GPU on the free runner) left out 74 tests (72 `@render` annotations, 148 runs) and said so in the gate summary; the local `npm run verify` runs everything and stays the gate of record. The first CI run (39452911203) failed only on those render timeouts. *(The exclusion was replaced by 24.0d; the tags remain.)*
- **24.0d:** the second CI run (39588134783) failed in two steps: a unit test that read the UTC `dateTime` of a stage start, and the development browser suite (50 failures with the 148 render-bound runs already left out: the free runner is too slow for it). CI now sets `CLOUDIATOR_CI=github`, and `npm run verify` reports the development browser step as `not run on CI` (`Result: PASSED (development browser suite not run on CI)`); every other step runs, the production gate included; locally every step runs and is the gate of record. The expedition time tests pin their time zone. A CI run with this change is not yet observed.
- **24.1:** the access audit prints setting names only; the security headers load the build's `.env*` and a production export without `NEXT_PUBLIC_SUPABASE_URL` fails (set the URL in the shell for local builds); `verify:static --origin`; command preflights carry `Access-Control-Max-Age: 7200`; read-only `scripts/schema-fingerprint.sql` and `scripts/hosted-checks.sql`.
- **24.1b:** the `?perf=1` overlay measures per phase in constant time with a rolling 10 s line; the `__next.*.txt` 404s are a Windows-only Next export quirk (Linux builds are unaffected).
- **24.2:** `tests/browser/deployed.spec.ts` with its own config checks a deployed origin without credentials (headers, CSP, compression, CORS, anon denial, Google-only Auth, shipped assets); the gates never run it.
- **24.2b:** `scripts/bench-seed.mjs` seeds the temporary bench with 50 synthetic characters and refuses any database that is not explicitly marked as the bench.

**Next (2026-10-21):** Avi's Part 1 of [deployment.md](../operations/deployment.md) (Supabase, Google, Cloudflare), then the bench rehearsal (Part 2), production, the real journey and the measurements (Part 3). *(Done: see "Task 24 complete" below.)*

### Task 24 complete: the public launch (Claude, 2026-10-27)

**Status.** The game is public at **https://cloudiator-arena.pages.dev** (Supabase `djkblzbnritgbmctsvob`, Frankfurt, free tier; Pages project `cloudiator-arena`, production branch `release` = `1b57ba5` at close; `d996d59` since 2026-10-29, see "Game messages patch released" below). Production was activated on 2026-10-25 (epoch 373525) after the bench dress rehearsal; every hosted step's sanitized evidence is in [release-evidence.md, "Task 24: the hosted launch"](../operations/release-evidence.md) and the step status in [deployment.md](../operations/deployment.md). At close (2026-10-27): 24 migrations, scheduler on and current, 0 failed jobs in 24 h, `duplicateGrants` 0, 9 accounts with 8 gladiators.

**Hosted steps and releases (all pushed to `codex/gladiator-arena`)**
- **24.3–24.7:** accounts, the bench (`uukrqribdfqovahzjsrx`, 50 seeded characters), production with parity to the bench, the deployed checks (9 of 9) and activation (`2551f49`).
- **24.8:** Avi's real journey on desktop and phone, two accounts, one trade (`b826947`).
- **Launch feedback (M23, release `1724a79`, evidence `84f2d44`):** Avi's ten notes from testing production: clearer starting points with reset and class suggestions, the whole day saved at once, Arena only in the evening, tournaments in the Wednesday and Saturday evening slot, worn gear shown and swapped from the inventory, a 1-gold minimum fee ([design](../superpowers/specs/2026-10-25-launch-feedback-design.md)).
- **Waiting monsters (release `84f2d44`, evidence `6d6290a`):** each expedition monster waits at its spot until its fight (client only).
- **Gladiator appearance (M24, release `86af8c8`, evidence `35bbf56`):** a look chosen at creation, drawn in every scene ([design](../superpowers/specs/2026-10-26-gladiator-appearance-design.md)). The previous atlas images stayed at their old paths for open tabs; they were deleted (`assets/source/retained.mjs` and its 2 tests) in the next art release, the bigger camp beds (Task 7c, 2026-10-29).
- **24.9 budgets (`ba5608e`), 24.10 recovery checks (`8b4cb27`), 24.11 mobile frame rate (`7d87fe4`, 60 fps on an Adreno 740 phone).**
- **Keyboard focus while commands are pending (release `1b57ba5`, evidence `f376b20`, test `a8db1f1`).**
- **24.12 (this record):** the bench project, its Google client and domain, and the Pages preview settings are gone; the bench worktree is removed.

**Open items**
- **The hosted export (24.10)** has not run: every bench password Avi entered was rejected (the dashboard reset never saved). The first production weekly export is its first hosted test ([runbook, "Export"](../operations/runbook.md#export)); download production's own CA first.
- **The `bench` branch** is still on GitHub (deleting it needs Avi's yes); the bench alias still serves its last build with no backend (a Cloudflare deployment deletion, Avi's).
- **Google consent screen** in Testing: publishing needs a privacy page.
- **Database size:** re-read around 2026-11-08 (24.9 projection).
- **Next feature (released 2026-10-29, see "Game messages patch released" below):** game messages with patch notes and a free, unlimited look change ([design](../superpowers/specs/2026-10-27-game-messages-design.md), mockup approved by Avi on 2026-10-27).

**Operating rules learned in Task 24** (also in `AGENTS.md` and the operations docs): production writes need Avi's go in chat each time; run the deployed checks about 2 minutes after a Pages build goes live; `functions deploy` uses Docker bundling (`--use-api` fails on the import map); pass `--agent no` to any parsed `db query --output-format json`; never print keys, passwords or connection strings.

### Game messages patch released (Claude, 2026-10-29)

**Status.** Tasks 1–8 of the [game-messages plan](../superpowers/plans/2026-10-28-game-messages.md) are done and in production: release `d996d59` (`release` fast-forwarded from `1b57ba5`; `origin/codex/gladiator-arena` is at `d996d59` too), 25 migrations (M01–M25), `game-command` redeployed. Avi's go in chat, 2026-10-29: "mark old results as seen, go for production". Gate of record at `d996d59`: 12 of 12 on the third run; the first two failed on a local port reservation after a Docker Desktop restart and on a known test race (fixed test-only in `d996d59`), not on the product. Step-by-step evidence: [release-evidence.md, "Game messages, notifications, free look change, fixed builds, gold and bigger beds (M25), 2026-10-29"](../operations/release-evidence.md).

**Delivered (Tasks 1–8)**
- A messages button and panel on the corner chip with patch notes; the first note offers a free, unlimited look change (the `change-appearance` command and a change-look dialog); notifications of the player's own results in a second tab; the build step shows the points left, caps typing, and the class and added points are fixed; the currency is called gold in every word a player reads; bigger camp beds (Punchy's request).
- Three patch notes were posted at the release (ids 1 to 3); posting and hiding follow [runbook, "Posting a game message"](../operations/runbook.md#posting-a-game-message). The deployed checks now run 19 anonymous probes (14 and the 5 for M25). M25 changed no rules version.
- One operator write at the release marked every account's old results as seen (before: 10 owners with new results, 318 new results; after: 0).

**Next**
- **Task 9:** a short clip of the new features for Avi's players, made from the real game (HyperFrames) after the release.
- **Task 10:** expedition replays that show the whole trip (leaving camp, arriving back, resting). It needs a short design and a clickable mockup over the real expedition scene, and Avi's approval, before any build.

**Open items**
- **Avi's in-game journey** (the attested deployed checks) is not done yet; it also exercises the hosted Notifications read (the embedded count) once.
- **Tabs still open on `1b57ba5`** lose the camp art when the camp scene next reloads (hashed atlas names; only `camp/props` changed) until they are reloaded.
- The open items under "Task 24 complete" (hosted export, `bench` branch, Google consent screen, database size) are unchanged.

### Task 23 checkpoint (Claude, 2026-10-20)

**Status.** Task 23 is complete on `claude/task-23` (`b6bd8c7..b87949a` plus the records commit): ten reviewed checkpoints (23.1 to 23.10), a final whole-branch review (ready to push, with fixes) and its fix wave (`d88a27c`..`b87949a`). Before the fix wave, the gate of record was `npm run verify` at `d75e3fc`: exit 0, all 12 steps; after the fix wave, `npm run verify` passed 12/12 again at `7260b59` (units 1254, `test:db` 300 with the Edge start time unchanged, dev 541/0/35, production 34/0/542). Nothing hosted was measured or deployed; hosted proof is Task 24. The [report](task-23-report.md) and the [review record](task-23-review.md) hold the details.

**What changed**
- **Two lanes, at Avi's request.** Lane A (database: 23.1, 23.2, 23.3, 23.6, 23.7, 23.8) ran serially in `Cloudiator-claude`; lane B (UI only: 23.5, 23.4, 23.9, 23.10) ran in `Cloudiator-replay` on port 3300 and was moved onto `claude/task-23`, where the full gate, database tests included, ran on the combined tree.
- **Migrations M17 to M22**, all from `supabase/sql/15-release.sql`: client privilege revokes (M17); per-minute dispatch and the public `published_slot_index` (M18); settlements dispatched with the due reveals that release them (M19), and a shared reveal leased once (M20); settled jobs' payloads trimmed, the 500 MB budget and `cohort.activeCharacters` (M21); idle rest after 14 days, owner signals and `cohort.restingCharacters` (M22).
- **Security.** `tests/db/access-matrix.test.ts` checks every role and privilege kind from the catalog, and `scripts/access-audit.sql` is the read-only query for the hosted comparison (runbook, "Release access audit"). The export ships a generated `_headers` with the CSP (Decision 7), the art gallery is removed, the scanner refuses JWTs and encoded `service_role`, and every browser test fails on a CSP violation.
- **Client.** Bounded reads and a paused camp under scenes, a camp Reload and Try again on failed replays, the opt-in `?perf=1` overlay, keyboard and screen-reader fixes, the presence command and the resting screens, and shorter slot times (Avi, 2026-10-20).
- **The database budget** (Avi, 2026-10-19: A + C + D). 500 MB with a warning at 400 MB; 82.0 % and 69.2 % at 90 days in the two worst-case scenarios; the one-year figures are a named risk. The structural compactions are built after launch, when the warning appears (Avi: "do what u recommend").
- **Repository rules.** `.gitattributes` (`7d36068`) checks every text file out with LF. Avi approved on 2026-10-19 the extension of `docs/operations/verification-gates.md`, "Database tests and the local Edge runtime" (refresh the Edge source's last-access times before the database tests); `51875a7` mirrors it in AGENTS.md.

**Running the release gate**
- `npm run verify` runs every gate of `docs/operations/verification-gates.md` in order and prints one summary. Exit 0: every step passed. Exit 1: a failure. Exit 2 is kept for named known blockers; the list has been empty since 23.8.
- It needs the local stack running and `npx supabase functions serve` serving this worktree; it never starts, stops or resets Docker or the stack. Before the database tests it refreshes the last-access times of `supabase/functions` and waits for a settled Edge runtime (about 35 s; the container is recreated once while it settles, by design). If the Edge start time changes during `test:db`, that run is discarded and rerun once.
- In a worktree with its own ports, give the gate the private Playwright config through its config option. Claude's lane A uses `node_modules/.cache/pw-claude.config.mjs` (port 3200) with the private static host `node_modules/.cache/serve-static-3200.mjs`. `npm ci` deletes `node_modules/.cache`, so recreate both after it.
- Run no other browser suite while the gate runs: on 2026-10-20 a concurrent lane B suite coincided with a host network fault. A failure labelled "probable host fault" (for example `net::ERR_NO_BUFFER_SPACE`) still fails the gate; rerun the whole gate once nothing else is running.
- The database step runs with `CAPACITY_GATE=1`, which enforces the 90-day database, invocation and raw egress budgets. `node scripts/resource-report.mjs` prints the full capacity report for the local stack; today it exits 1 only on the egress line that includes backend traffic, a Task 24 condition.
- CI: `.github/workflows/checks.yml` runs the same gate on a fresh stack with SHA-pinned actions, except the development browser suite (not run on CI since Task 24.0d: the free runner is too slow for it; the local `npm run verify` runs it and stays the gate of record).

**Operator notes**
- **Health report.** `cohort.activeCharacters` and `cohort.restingCharacters` are new, and `database-size` reads the physical size against 500 MB, warning at 400 MB. When the warning appears, build the structural compactions (settled-slot ranges; command receipts older than 90 days reduced to a fingerprint). When active characters approach 50, plan the boundary latency mitigation: the cutoff tick is exactly full at 50 all-expedition characters, and a 51st would publish at about 121.6 s (derived).
- **Idle rest.** A character rests at home after 14 days without an owner signal, measured from each boundary's scheduled start. Any command, including the client's `presence`, signals at most once an hour, and the character returns at the next boundary with no back-fill.
- **Access audit.** Run `scripts/access-audit.sql` on the hosted project read-only and compare it with the local reference as the runbook describes.
- **Line endings.** New checkouts are LF. An existing Windows clone made before `7d36068` keeps CRLF working files until it is renormalized or re-cloned (the final fix wave adds the steps to `migrations.md`, "Fresh checkout"). Apply `15-release.sql` and push migrations only from an LF working copy: a CRLF copy changes function bodies and fingerprints.
- **Host restarts.** Launch Docker Desktop hidden first, and use the Secrets Engine recovery in [local-runtime.md](../operations/local-runtime.md) only for its matching diagnostic (on 2026-10-20 Engine 29.9.1 started in 5 s with no recovery, and `supabase start` passed on its second try). The Edge serve exits when the stack restarts; start it again in the serving worktree, with its output to a file.

**Task 24 next steps**
- **Deploy order.** M18 and the worker before or with the client (`readRevision` selects `published_slot_index`). M22 before the Edge function, and M22 with the Edge function and the client that sends `presence` (the previous Edge function refuses `presence` as `invalid`, which the client tolerates; the backfill puts the first resting boundary at least 14 days after the deploy). M16 with the 22.5 client (Task 22). Push from an LF worktree.
- **Launch blockers.** Mobile 30 fps on Avi's phone with `?perf=1` on the deployed production build (fix the overlay's measurement quality, 23.4 M3, first); hosted CPU and dispatch spacing (C4); hosted egress and compression, and whether Edge-to-API traffic is billed; CORS parity for the exact Pages origin (`GAME_ALLOWED_ORIGINS` and the Auth redirects); the remote export rehearsal (`scripts/export-db.ps1 -Remote`, then the restore check).
- **Before the hosted audit comparison.** Print setting names only in the finding rows (23.1 M4); confirm PostgreSQL 17, that `private` is not an exposed schema, the platform exception rows, and the same `search_path` on both sides.
- **The production build.** Set `NEXT_PUBLIC_SUPABASE_URL` so `_headers` names the hosted `connect-src` origin (`build-headers.mjs` reads only the process environment; a missing URL gives `'self'`). Track the `__next.*.txt` 404s of the export (23.5 M7). Revisit the standings and profile re-reads with the hosted egress measurement.
- **Task 22's list** in [task-22-report.md](task-22-report.md) still applies.
- **Pending Avi.** Seven visible changes from 23.4 and 23.5 (screenshots sent 2026-10-19); the "· ends 04:20 AM" format on My gladiator and Arena; the see-through profile card; a resting gladiator vanishing while a waking one walks in; the Follow reason wording; the plan's defaults for Avi's open choices; the all-menus side pane (Avi to confirm the table and approve its design); two skill-upkeep proposals listed in the [review record](task-23-review.md#carried-items).

### Task5 integration notes

- Session/client/live gateway and exact owner/error mapping are documented in task05 report. Future live command kinds and general reads remain unavailable until their owning tasks; never substitute fixture state. Root owner results are account/effect/request-revision scoped, including creation confirmation invalidating earlier no-character reads.
- Only creation draft plus account-scoped immutable attempted command/UUID is retained locally; SDK session persistence is separate. No local wallet/inventory/OwnerState authority. Account changes and edited drafts receive new attempt IDs; unknown outcomes reuse the same command.
- PublicActor now has canonical CampLocation and EquipmentSilhouette enums; Task10 must emit safe machine values. Combat logs still carry catalog-ID silhouette strings.
- Browser tests isolate Next output at .next/browser-test. Next16.4 customdistDir with static export writes the site there, so isolated production tests must set PLAYWRIGHT_STATIC_ROOT=.next/browser-test and scan that fresh directory. Ordinary export/host defaults remain out. Earlier staleout checks are excluded from evidence.
- One Chrome ERR_NO_BUFFER_SPACE failure occurred before hydration; one exact focused repeat passed, with no mitigation claim. Known color warnings remain final harness work; expected sanitized refresh-denial diagnostics characterize session expiry.

### Task 6 reviewed planning checkpoint

- Source f35c9ac and report 1b45b20 passed fresh independent spec and quality review. Full report and review are tracked in task-06-report.md and task-06-review.md. No Critical/Important findings; one displayed schedule-time estimate can go stale across boundaries. Carry this Minor into management integration and final review.
- Final evidence: 153 unit tests, 26 real database/Auth/Edge tests on clean M01/M02 replay, 30 development and six production browser tests, TypeScript/Deno checks, build and fresh 37-asset scan. Hosted authority/performance is still pending release work.
- M02 is supabase/migrations/20261012121232_build_schedule.sql and must not be edited. CLI-generated ACL, trigger-order, and backfill omissions were completed before commit and verified with a clean replay. Two INFO index observations remain documented. No hosted project was touched.
- Task7 must consume historical schedule_revisions, share advisory-account then character lock order, and call private.apply_pending_build(gid, boundary_slot) after prior settlement/season close and before the new snapshot. OwnerState.buildVersion is the monotonic command revision; currentBuild.version is active identity. Preserve fee/item holds and absolute stamina conservation. See the report for exact interfaces.
- The authorized local reset did not interrupt the existing Edge service; final real HTTP tests and preview port3000 succeeded. Avi approved the additional Supabase migration-guidance override; AGENTS.md and migrations.md contain the persistent guidance, reconciled with Claude's bccd273 documentation commit.

## Codex resumption and completed Task 8 handover

Claude's 22:10 message confirms PAUSED: no active worker or dev servers3200/3300; it will announce before further edits. Published HEAD is a04484c. Its documentation-only bccd273 is integrated into this controller checkpoint and consolidated with Codex's approved 6848f5f guidance into one AGENTS section, including inspection of the replayed database. Vendor caches remain unchanged.

Task 8's original partial source remains on `claude/task-8-wip` at `2bed1a3`, including source `5637dd5` and its historical dispatch addendum. Codex preserved it by normal merge `4be59b3`, audited and completed it. A runtime interruption preserved uncommitted work; a continuation worker finished it without re-importing or resetting. Source `801eea1` and report `28d1fee` passed full fixed-base independent review. Do not restart Task 8 or overwrite Claude's clean checkout; old workspace/port/controller/attribution directives in the original dispatch are historical.

The reviewed scanner supplement has source628e88f, report554c677 and independent review1d66458, with no findings. Owning21/full317 tests and fresh isolated four-route80-asset scan passed. This resolves Task1's escaped-JSON Minor; Task23 is still pending. Full report/review are tracked. No launch or exhaustive secrecy claim.

Task14 final Minor commit3283feb has now received a fresh read-only scoped review. Document-listener cleanup, local dates and reward keys are addressed; early-destroy window handler restoration and unknown creature-prefix warning remain deferred Minors. No new Critical/Important breakage. See task-14-final-delta-review.md and carry both into management integration/final triage. Broad suites were not repeated. Task9 carries Task7 summary whitelist/validation, malformed-hook rollback, dependency and lease-renewal gates; Task13 must combine currentActivity with processedSlotIndex.

Current local runtime was restored after Docker had stopped. The verified Cloudiator container and Edge functions now use Codex's checkout and its own fresh ignored worker secret; Claude's secret was never copied or printed. At the Task 8 report, Edge session was7337 and fixture preview was72301 on port3000 with HTTP200. These are last-observed sessions, not a guarantee they survive another restart. Keep test ports3100/4173 separate and verify current runtime before later HTTP proof.

### Task 8 reviewed inventory checkpoint — 2026-10-13

- Full review range `8195ff5..28d1fee` includes original contributor WIP and all continuation code. Fresh GPT-6 Astra review: spec compliant, quality Approved, no Critical/Important. One existing harness-noise Minor is carried to Task 23. The reviewer did not repeat suites or migration replay.
- M05 `20261013065108_inventory_shops.sql` was CLI-generated and completed before commit. Migration-only replay matches tested source across228 metadata entries;39 re-emitted unchanged function bodies match earlier migrations. M01–M04 remain unchanged. Lint is empty; advisors have four INFO unused indexes.
- Exact DB evidence: full replay run82 passed/1 old-error-text assertion failed; the earlier immutable guard correctly rejected the mutation. Corrected assertion and expanded denial checks then passed36/36 shops/planning cases on the same replayed DB; activities36 and identity11 had passed. All83 are covered green across final runs, not one claimed83-pass rerun. See the report for every command and distinction between inherited and newly observed TDD evidence.
- Bound banner ownership is separate from the66 equipment offers and60 inventory slots, with no stats/combat/history effect or resale/trade. `OwnerState.ownedCosmetics` is additive. The legacy `peakStrength` is historical legal equipment score only; Task16 owns the combined league index.
- **Task9:** `prepareGrant(state, grants)` returns baseline/plan/history. `private.apply_inventory_plan(gid, prepared)` writes items/history under common locks and returns ids/overflow/history, or null for stale preparation. It does not credit a wallet, issue a receipt or provide idempotency. Fenced settlement must atomically credit rewards/overflow/XP and retain the permanent guard, retrying changed inventory from the same immutable reward proposal. Preserve Task7 summary whitelist, malformed-hook rollback, dependency and lease-renewal gates.
- **Task13:** consume InventoryPanel/ShopPanel, bridge camp merchant events, combine currentActivity with processedSlotIndex and use noncombat result states for Training/Rest. **Task16:** promote from level/earned points/history only at boundaries. **Task18:** preserve binding, reservations, held fees, sorted lock order and acquisition history for transfers.
- Root records the reviewed checkpoint commit separately and verifies the pushed remote SHA before posting it on the board. Hosted OAuth/CORS/scheduling, retention, budgets and physical FPS remain release gates; this is not a public launch.

### Task 9 continuation and resumed parallel lane

The reviewed Task8 checkpoint is05b1ea0. Subsequent docs-only395bc2d contains
Avi's approved persistent Postgres lease guidance (AGENTS and
[job-leases.md](../operations/job-leases.md)); it publishes no unfinished Task9
source. Task9's full review base remains05b1ea0. Source e96e0f1 and report5dbf34e completed preserved work after interruptions.
M06 is now committed, clean-replayed and independently reviewed. Full review
found one Important canonical zero-HP winner defect; fix545a82d passed focused
re-review. See task-09-report.md and task-09-review.md. Do not redo completed
tasks. The lease guide now records the actual RED/GREEN and replay evidence.

Claude's active Task15 scope: src/game/**, ExpeditionView, new expedition scene
tests/fixtures, and minimal approved fixture timeline lookup changes in
src/lib/api/fixture-gateway.ts. Codex holds that shared file until the declared
READY checkpoint is integrated; Task10 fixture changes serialize afterward.
Approved shared Task15 edits also include the fixed /expedition route, fixture-only game links, fifth scanner route and necessary static test assertions. Codex holds those files until serialized integration. Other shared edits require an exact request first.
Claude's server uses3200; the local Supabase/Edge stack remains Codex-owned.
Existing RevealedStage/RevealedTimeline shapes are unchanged. Notify Claude
before any backend stage-contract change; owner-only credited overflow details
must not enter spectator stages or another player's loot/currency display.

Claude supplies exact base/head, paths, independent full/scoped review records
and real test evidence before READY TO MERGE. Codex preserves the working
backend checkpoint, reviews the declared delta as needed, serializes the merge,
updates this handoff and verifies each pushed remote SHA. Neither lane resets
or edits the other checkout.

### Task 9 reviewed expedition checkpoint — 2026-10-14

- Source `e96e0f1`, report `5dbf34e`, canonical-winner correction `545a82d`. Full review `05b1ea0..5dbf34e` found one Important; scoped `5dbf34e..545a82d` confirms it addressed, no new breakage. Final spec compliant, quality Approved. See tracked report/review.
- M06 `20261013125213_expeditions.sql` is immutable; M01–M05 unchanged. 103 DB/Auth/real Edge HTTP checks plus four later focused privacy/token checks passed against migrations alone. All258 schema entries matched again after temporary hook/clock teardown. Lint empty, six INFO unused indexes.
- Original implementation evidence:297 affected units and fresh isolated four-route81-asset export/scan. Planner-only fix evidence: two meaningful RED cases, then75 focused units; TypeScript/both frozen Deno entrypoints/two runtime tests. These are distinct runs; full DB/static checks were not repeated for that small fix.
- Immutable private plans, chained due-reveal dependencies, DB-time stage RLS and fenced end-slot settlement are ready. Public `activity_stages` exposes only due sanitized stages/logs. Owner activities/summary/reward/overflow reads remain owner-only; no future plans or private grants are client-visible.
- Canonical `winnerId` decides expedition success, including simultaneous defeat at zero HP: nonfinal win heals by floored20% and continues; final win grants success rewards. True loss still ends the trip without rewards. Wire stage shape is unchanged.
- Task10 supplies safe public completion/revision/profile/timeline projections and sync; Training/Rest results remain noncombat. Task16 supplies arena/league hooks. Retention, hosted scheduling, exact-origin Google/CORS, CPU/budgets and physical FPS remain later gates. This checkpoint is not a public launch.
- Claude resumed Task15 on2026-10-14 at04:40 IDT from saved `claude/task-15-wip`6ceb5e8 (partial7c57106 plus dispatch record). Its earlier Task14 fix708688b awaits independent review/integration with15. Do not restart or edit his checkout. Current preview3000 availability is unverified; it was already stopped at Task9 continuation entry. Historical session IDs above are not current proof.

### Bounded checkpoint queue and paused Claude lanes — 2026-10-14

Avi asked Codex to check the board, ask Claude what remains and choose small items
within the five-hour session limit. Codex posted the question and ACKed the new
feature split; that message does not revoke Avi's pause of Claude.

- **Task10 completed:** source36fd2b4/report7f413e5, fix a699384/report8b4464e. Full review found one Important; scoped review7f413e5..8b4464e approves the correction. Final M08 replay109 DB/Auth/Edge checks and303 schema entries matched; no frontend contract change. A generic processing actor conceals unpublished details and retains prior history. Offset Minor remains deferred. See tracked report/review.
- **Task15 integrated:** reviewed head59e0db7, normal root merge930c2c7 after Task10 checkpoint54beafb. Scope matches approved53 paths. Fresh combined74 owning tests, TypeScript/Deno,5-route90-asset scan and repo-config production8 passes/118 expected skips all passed. Existing Task10 contracts/backend remain intact. See task-15-integration.md; no partial Claude competition phases were imported.
- **New ownership:** Claude13/15/16/17/19/20; Codex10/18/21/22/23/24 plus integration, this handoff and reviewed pushes. Root16/19 work was preparation only; no competing backend implementation exists.
- **Claude paused checkpoints:**15 READY59e0db7;16 domain phase1fc4832b;19 domain phase1be28376;17 reviewedff01dba with follow-up polish not started;20b67a06c unreviewed. Domain phases are not completed full tasks. All Claude worktrees were clean/committed at its09:02 board note. Do not reset, reimplement or merge unreviewed phases as complete.
- **Future isolated Claude backend:** approved after its resumption, project labelCloudiator-claude and ports+1000, own volumes/secret, local config changes not committed; no root stack changes. Arena SQL migration generation waits for reviewed10 integration. Existing worktreeCloudiator-arena contains16 phase1; no root worktree is created.
- **Shared17 edits approved:** fixture timeline/world/profile/standings/sample list, game Standings/ArenaPanel/shared display clock, fixture tests only; no live gateway/contracts/style/scanner change. Optional gateway standings cursor is now in10. Stable shared battle logs are located by gladiatorId, not participant index0. Public round1 bracket placement needs an exact minimal field proposal; future winners/snapshots remain private. Tournament placement full-summary privacy is accepted for19's backend reconciliation.
- **Task10 Minor deferred:** initial world-load offset uses the final revision timestamp against the entire pagination duration. Fix in13/UI integration or final triage with delayed-page coverage; no grants depend on that client estimate.
- **Approved runtime guidance:** docs-only701fe10 is published with AGENTS and local-runtime.md; no unfinished10 source was in that push. The later Next build/dev-output collision is documented in10's report. A separate persistent verification-guidance proposal awaits Avi; development does not wait on it.

### Task10 reviewed read-model checkpoint — 2026-10-14

M07 adds explicit world/profile/recent projections, invoker due-event views and
revision state. M08 corrects the settled-to-preparing transition using the
published checkpoint. Full owner summaries/rewards/receipts stay owner-only;
public timeline.completion and recent results contain only the six safe fields.
World/profile stage metadata omits battleLog; full due logs load on demand.

Read adapters use authenticated Data API access and <=50 cursor pages. Sync
polls revision/time every30 seconds while visible, refreshes on focus, coalesces
reads, preserves state on outage and rejects old-account responses. Optional
session subscription and standings cursor are implemented; profile strength is
nullable until Claude16 supplies its canonical producer. Market/standings/
tournament live reads remain unavailable until their backend tasks.

Task13 must mount the controller/shared clock and integrate public completion
into scenes/results. Existing replay in-progress labels and Task15 interim poll
replacement remain explicit integration gates. M08 fix uses the existing DTO
and no renderer edits. Full source/DB, corrected migration replay, compile and
browser/static results are distinct runs in the report, not one aggregate claim.

### This bounded session closes here

Published Task10 checkpoint54beafb includes full/scoped review and exact source/
migration evidence. Task15 merge930c2c7 and its integration documentation form
the second checkpoint. All remaining work has declared ownership and explicit
prerequisites; another agent can resume from these records without rerunning
completed tasks or resetting Claude's saved lanes. Small next Codex items should
come from18's marketplace plan, not another full feature mixed into this session.

No live Google/hosted public game is claimed. Task13 scene synchronization,
competition backends/UI, marketplace, season ordering, retention and release
proof remain. Claude is paused, and the board asks it for the smallest remaining
Codex items when it returns. No new dev server or automation was started.
