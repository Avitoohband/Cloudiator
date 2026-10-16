# Task 13: Full-Screen Camp, Visitor Viewing and Live Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard game page with Avi's full-screen living camp, with hidden-rail menus, visitor read-only viewing, Google joining and scenes over the camp, and close every gate earlier tasks left for Task 13.

**Architecture:**
- **Data.** One new migration (M13) opens the sanitized public projections to `anon`, read-only. The live gateway serves public reads without a session.
- **State.** A single `useGameState` hook owns the sync controller, the shared display clock, the owner state and the viewer kind. Panels and the camp only consume it.
- **Shell.** A `CampShell` renders `GameViewport` full-window, with a rail, floating panels (bottom sheets on touch), a corner chip, a profile card and scene overlays. The existing panels are re-housed, not rewritten.

**Tech Stack:** Next.js 16.4 static export, React 19, Phaser 4.2.1, Supabase Postgres 17 (CLI 2.120.0), Vitest, Playwright (Chrome channel).

**Spec:** [full-screen camp design](../specs/2026-10-14-full-screen-camp-design.md) (approved with its [mockup](../specs/references/2026-10-14-full-screen-camp-mockup.html) on 2026-10-16), amending the [game design](../specs/2026-10-11-gladiator-arena-design.md). This plan replaces the text of Task 13 in the [24-task plan](2026-10-11-gladiator-arena-implementation.md).

## Global Constraints

- Public game, English interface, responsive desktop and mobile browsers, Google sign-in only.
- "Public projections are readable by anyone, including visitors who have not signed in. Private reads and all commands require Google sign-in, and the acting character is bound to the verified account."
- Visitors never see wallets, inventories, schedules, owner-only summaries, seeds or private plans. The guessed-ID rule `reveal_at <= database time` applies to visitors exactly as to signed-in readers.
- The browser holds no authority over wallet, inventory or `OwnerState`. Unimplemented live reads stay "unavailable"; never substitute fixture state.
- Polling stays at the 30-second revision read; details and logs load on demand; cursor pages hold at most 50 rows.
- Fixture mode (`?mode=fixture`) exists only when `NEXT_PUBLIC_FIXTURE_ENABLED=true`, and never in production.
- Rail: a 5 px grip at the vertical middle of the left edge; the rail appears within 12 px of the edge; Tab order is the rail icons, then the corner chip.
- At 360 px wide there is no horizontal scroll, and sheets fit the viewport. Honor `prefers-reduced-motion`. Names render as React text.
- No package or tool downloads. Read `node_modules/next/dist/docs/` before changing Next code (AGENTS.md).
- Gate order and the database-test rule follow `docs/operations/verification-gates.md` and AGENTS.md.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Typing inside a menu never moves the camera.** Arrow keys, `+`, `-` and `0` typed in a panel field (the Gladiators filter, the creation name) leave the camp camera unchanged. Test: Task 13.5.
- **A session change with a private menu open.** Sign-out, expiry or an account switch closes Schedule, Inventory and My gladiator management, flips the chip to the visitor state and leaves no private value on screen. Test: Task 13.6.
- **A visitor deep link to an unrevealed or someone else's activity.** `/replay/?activity=<guessed id>` shows "not available yet" with no summary or rewards, and never an error page. Test: Task 13.8.
- **The camp scene is unavailable** (no WebGL, art failure). Rail, panels and chip still work over a plain background, and Find/Follow say why they are disabled. Test: Task 13.5.
- **Touch scrolling inside a sheet.** Scrolling a long sheet (standings, results) scrolls the sheet, never pans or zooms the camp. Test: Task 13.5.

---

## Decisions (controller, binding)

1. **File map.**
   - The four files the old plan reserved keep their names: `src/features/character/CharacterPanel.tsx`, `RosterPanel.tsx`, `useGameState.ts` and `src/features/results/ResultsPanel.tsx`.
   - New shell chrome lives in `src/features/shell/`.
   - The old commit name `feat: connect accessible gladiator management panels` is superseded by the task commits below.
2. **Marketplace.** Task 18 has not built it, so no Marketplace icon is shown. Task 18 adds the menu entry, its panel and the `anon` grant on its listing objects.
3. **Phones.** Touch mode is chosen by `@media (hover: none)`, which the Playwright `mobile` project (Pixel 7) matches. It gives a ☰ button, a row of icons and bottom sheets.
4. **Scenes.** An overlay pushes a history entry on the current route: `?view=replay&activity=<id>[&stage=<id>]` or `?view=expedition&activity=<id>`. Back and "Back to camp" close it. `/replay/` and `/expedition/` remain deep links.
5. **Fixture visitor preview.** In fixture mode only, `?mode=fixture&as=visitor` shows the visitor view with the fixture world and no owner.
6. **Sign-in result.** `AuthCallback` returns failures and cancellations to `/game/?signin=cancelled` or `?signin=failed`. The shell shows a short message, then removes the parameter with `history.replaceState`.

## Gate registry (every gate recorded for Task 13 and where it closes)

| Gate (source) | Closes in |
| --- | --- |
| Visitor-access migration and access-denial tests (spec; HANDOFF) | 13.1 |
| `tournament_views.pairing_job_id` client-readable (Task 19 M1; JSON-path reads of `result` must keep working) | 13.1 |
| Public reads blocked without a session; `readTimeline` queries owner-only `activities` | 13.2 |
| Log cache cleared only by `subscribeSession`, and a cached hit skips the session check (Task 19 R1) | 13.2, 13.3 |
| Mount the sync controller and the shared clock (Tasks 10, 12, 17, 20) | 13.3 |
| Initial-load clock-offset bias (Task 10 review) | 13.3 |
| Combine `currentActivity` with `processedSlotIndex` (Processing results / Preparing) (Task 7) | 13.3 |
| Show the camp outside fixture mode; live reader flips; Phaser chunks load live; late first world (Tasks 12, 17, 19, 20) | 13.3 |
| Scene-availability status query (Task 12) | 13.3 |
| Stale schedule clock (Task 6) | 13.4 |
| Replace `standingsRefreshDue`; owner refresh for "Your standing" (Task 17) | 13.4 |
| Tournament retry timer and owner/tournament race (R2); slot-wide "being prepared" signal (R3); card test (R5); lookup league after promotion; `tournamentLookupIdOrNull`; unreachable "You advance…" branch (Tasks 19, 20) | 13.4 |
| Keyboard equivalents for every world click; mobile sheets; panels usable without the canvas (old Task 13) | 13.5 |
| Visitor mode, joining, sign-out (spec) | 13.6 |
| `select-character` profile card; selection from roster and standings (Task 17) | 13.7 |
| `open-merchant` opens the right shop tab (Task 8) | 13.7 |
| Non-replay result state for Training and Rest (Tasks 7, 9) | 13.7 |
| Reserved bridge events `view-replay`, `view-expedition`, `return-camp`; roster links to expeditions (Tasks 12, 15) | 13.8 |
| Replace `ExpeditionView`'s own polling with the controller (Task 10) | 13.8 |
| Replay page without a display clock (Task 15 review) | 13.8 |
| Task 15 Minors: safe-point leave pose, encounter-count constant, test title | 13.8 |
| Ring schedule independent of log load order (R4); logs only for current or upcoming ring windows; one shared log cache; late-joiner measurement (Task 19) | 13.9 |
| Prune `tournamentViews` with `forgetLeft`; ring and panel change over together (Task 20) | 13.9 |
| Engine-free `isTournamentSlot` (Tasks 19 M5, 20) | 13.9 |
| Isolated production gate with the repo's `playwright.config.ts` (Tasks 17, 20) | 13.9 |

**Not in Task 13:** diagonal-step speed and per-scene atlas splitting (Task 12; Task 23 performance), owner overflow lines (Task 15; later refinement), Task 17 round-3 Minors 1–2 and M7, fps, egress and visitor-load measurement (Task 23).

**Note for Task 23:** its release test expects `getByRole('button', { name: 'Schedule' })` to be enabled when actor art fails. The rail icon's accessible name stays exactly "Schedule".

## Execution

- Work in `C:\Avi\Studies\Projects\Cloudiator-claude` on a new branch `claude/task-13`, created from the commit that adds this plan on `claude/preview`.
- The Edge runtime is served from that worktree, so the database-test rule applies.
- Browser runs use the private config `node_modules/.cache/pw-claude.config.mjs` on port 3200.
- Each task is one reviewed checkpoint: a fresh implementer, an independent spec and quality reviewer (visual for 13.5–13.8), a report and a review record. Push after each review.

---

### Task 13.1: Visitor read access (M13)

**Files:**
- Create: `supabase/sql/11-visitor-access.sql`; `tests/db/visitor-access.test.ts`
- Generate: `supabase/migrations/<timestamp>_visitor_access.sql` (M13)
- Modify (flip "anon denied" on opened objects): `tests/db/expeditions.test.ts:358`, `tests/db/projections.test.ts:77-78`, `tests/db/arena.test.ts:708-721,1286`, `tests/db/tournaments.test.ts:1024,1118-1122,1457-1464,1478` (explicit columns instead of `select('*')`)
- Modify docs: `docs/operations/migrations.md` (M13 entry; replace the line 476 statement); `docs/superpowers/specs/2026-10-11-gladiator-arena-design.md` §10.5 (line 376), §10.6 (line 382), §13 item 11 (line 436), using the approved wording in the full-screen spec; `docs/superpowers/plans/2026-10-11-gladiator-arena-implementation.md:23`

**Interfaces:**
- Produces: `anon` SELECT on exactly these objects. Base tables: `world_revision_state`, `world_actors`, `public_profiles`, `recent_results`, `activity_stages`, `arena_standings`, `tournament_bout_results`, `tournament_placements`. Views: `visible_events`, `world_revision`, `world_actor_reads`, `public_profile_reads`, `arena_standing_reads`. Plus column-level SELECT on `tournament_views`.
- Column-level SELECT on `tournament_views(id, slot_index, league, starts_at_ms, ends_at_ms, status, entrants, bracket, bouts, reveal_at_ms)` for `anon` and `authenticated`. The table-level SELECT from `authenticated` is revoked, so `pairing_job_id` and `published_at_ms` are readable by no client.
- Each existing select policy (`player_read`, and `due_read` on `activity_stages`) is altered to `to anon, authenticated` with its USING expression unchanged. No second policy is added, which avoids the `multiple_permissive_policies` advisor.

- [ ] **Step 1: Write the failing tests** in `tests/db/visitor-access.test.ts`:

```ts
test('lets visitors select exactly the public projections, read-only', async () => {
  // OPEN = the 13 objects above plus tournament_views (column grants)
  expect(await anonSelectable()).toEqual(OPEN.sort());          // every public-schema relation anon may SELECT
  expect(await anonWritable()).toEqual([]);                      // INSERT, UPDATE, DELETE, TRUNCATE on any relation
  expect(await anonExecutable()).toEqual([]);                    // EXECUTE on any public or private function
});
test('never exposes the tournament pairing job to any client', async () => {
  for (const c of [anonymous, other.client]) {
    expect((await c.from('tournament_views').select('pairing_job_id')).error).not.toBeNull();
    expect((await c.from('tournament_views').select(PUBLIC_TOURNAMENT_COLUMNS)).error).toBeNull();
  }
});
test('hides future-dated rows from visitors even by guessed id', async () => {
  // a future recent_results row, activity_stages row and tournament_bout_results row, each read by its id
  expect(await anonRows('recent_results', { activity_id: futureActivity })).toEqual([]);
  expect(await anonRows('visible_events', { id: futureStage })).toEqual([]);
  expect(await anonRows('tournament_bout_results', { bout_id: futureBout })).toEqual([]);
});
test('keeps owner management and private schemas denied to visitors', async () => {
  for (const t of ['owner_state', 'activities']) expect((await anonymous.from(t).select('*')).error).not.toBeNull();
});
```

`anonSelectable`, `anonWritable`, `anonExecutable` and `anonRows` are defined in this test file:
- `anonSelectable` and `anonWritable` query `pg_class` with `has_any_column_privilege('anon', …)`, because `has_table_privilege` misses column-only grants. `anonWritable` also checks DELETE and TRUNCATE with `has_table_privilege`.
- `anonExecutable` queries `pg_proc` with `has_function_privilege('anon', …)`.
- `anonRows` reads one object as `anonymous`, filtered by the given column.

- [ ] **Step 2: Run** `npm run test:db -- tests/db/visitor-access.test.ts`, with the Edge start time stable. Expected: FAIL, since `anonSelectable()` returns `[]`.
- [ ] **Step 3: Implement** `supabase/sql/11-visitor-access.sql`. It must be reapplicable: guarded `alter policy`, revoke before grant, and a header documenting the column-grant exception (Task 19 M1) and why base tables must be opened under `security_invoker` views. Iterate with the tested `docker exec … psql -v ON_ERROR_STOP=1` fallback.
- [ ] **Step 4: Flip** the listed existing assertions to "visitor reads succeed"; owner-only and write denials stay.
- [ ] **Step 5: Run** `npm run test:db`. Expected: all suites PASS with the Edge start time unchanged.
- [ ] **Step 6: Generate and complete M13**
  - Generate with `npx supabase db pull visitor_access --local --schema public,private --yes`, then check `migration list --local`.
  - Complete the draft per AGENTS.md: revokes before grants, the column grants, policy role lists, and `notify pgrst, 'reload schema'`.
  - Clean replay with `npx supabase db reset --local --no-seed --yes`, then a parity fingerprint against the source and `npm run test:db`.
  - `db lint` must be empty; advisors may show INFO notices only.
- [ ] **Step 7: Amend** the design spec, the old plan's constraint and `migrations.md` as listed in Files.
- [ ] **Step 8: Commit** `feat: let visitors read the public projections`, with the source, M13, tests and docs.

### Task 13.2: Public reads without a session

**Files:**
- Modify: `src/lib/api/gateway.ts:30-103`, `src/lib/api/reads.ts:48-67`, `src/lib/api/fixture-gateway.ts:47-49`
- Create: `tests/fixtures/results.ts`
- Test: `tests/api/projection-gateway.test.ts`; `tests/db/visitor-access.test.ts` (one more case)

**Interfaces:**
- Consumes: 13.1's grants.
- Produces:
  - **Public reads need no session:** `world()`, `revision()`, `timeline(id)`, `profile(id)`, `standings(league, cursor?)`, `tournament(id)`, `tournamentLog(boutId)` and `recent(cursor?)`.
  - **These still require a session:** `owner()` and `command()`, which throw or return `unauthenticated` without one.
  - **Account change mid-read:** a public read retries once if the account changed during it; a second change throws `GatewayReadError('unavailable')`.
  - `readTimeline(client, id, options: { ownerSummary: boolean })`. The gateway passes `ownerSummary: false` when signed out, and then never queries `activities`.
  - The fixture gateway's `recent(cursor?)` serves `RESULTS_FIXTURE: ResultsPage[]` from `tests/fixtures/results.ts`, built from the existing fixture timelines. It needs at least one Arena, expedition, tournament, Training and Rest row.
  - The log cache is shared by all viewers. Logs are public once due, so a cached hit needs no session check; `subscribeSession` still clears it on an account change. This closes Task 19 R1.

- [ ] **Step 1: Write the failing tests** in `tests/api/projection-gateway.test.ts`, with a fake Supabase client:

```ts
test('reads every public projection without a session', ...)            // world, revision, timeline, profile, standings, tournament, tournamentLog, recent resolve
test('refuses owner() and commands without a session', ...)             // owner() rejects { code: 'unauthenticated' }; command() -> { ok: false, code: 'unauthenticated' }
test('a visitor timeline never queries activities and has no summary', ...) // fake client records tables; 'activities' absent; result.summary undefined
test('retries a public read once when the account changes during it', ...)
```

Also add to `tests/db/visitor-access.test.ts`: `test('serves a visitor the same world, profile, standings and tournament as a signed-in spectator')`. It runs the real reads layer with `anonymous` and with `other.client`, and expects deep-equal results.

- [ ] **Step 2: Run** `npx vitest run tests/api/projection-gateway.test.ts`. Expected: FAIL, with `unauthenticated` thrown for `world()`.
- [ ] **Step 3: Implement** `publicRead` beside `read` in `gateway.ts`, the `ownerSummary` option in `readTimeline`, and the fixture `recent`.
- [ ] **Step 4: Run** the unit tests, then `npm run test:db -- tests/db/visitor-access.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: read public projections without signing in`.

### Task 13.3: One shared game state, sync clock and live camp

**Files:**
- Create: `src/features/character/useGameState.ts`, `src/features/character/activity-status.ts`
- Modify:
  - `src/lib/api/sync.ts:21-45` (the time sample);
  - `src/game/GameViewport.tsx` (`onStatus`; no `clock.sync` when a shared clock is passed, lines 117-123);
  - `src/app/game/page.tsx` (adopt the hook in the current layout, mount the camp live);
  - `tests/browser/live-routes.ts` (create: PostgREST routes from fixture DTOs, extracted from `arena-live.spec.ts`)
- Test: `tests/sync.test.ts`, `tests/domain/activity-status.test.ts`, `tests/browser/live-camp.spec.ts`

**Interfaces:**
- Consumes: 13.2's public reads.
- Produces:

```ts
export type Viewer = 'loading' | 'unavailable' | 'visitor' | 'no-gladiator' | 'player';
export type GameUiState = {
  viewer: Viewer; session: SessionState; world: WorldSnapshot | null; owner: OwnerState | null;
  ownerError: 'unavailable' | null; syncError: 'unavailable' | 'unauthenticated' | null;
  revision: string | null; slotIndex: number | null; clock: DisplayClock;
  sceneStatus: 'loading' | 'ready' | 'unavailable';
  refreshOwner(): Promise<void>; setSceneStatus(status: GameUiState['sceneStatus']): void;
};
// Fixture-enabled builds only (as the other test hooks): window.__cloudiatorShell = { clock } for browser tests.
export function useGameState(gateway: GameGateway | null, options: { fixture: boolean; previewAs?: 'visitor' | 'player' }): GameUiState;

export type ActivityStatus = 'scheduled' | 'in-progress' | 'processing' | 'preparing' | 'completed';
export function activityStatus(owner: Pick<OwnerState, 'currentActivity' | 'processedSlotIndex'>, slotIndex: number, nowMs: number):
  { status: ActivityStatus; label: string; endsAtMs: number | null };
```

**Rules:**
- `useGameState` starts one `createSync`, which wires `subscribeSession`.
- On each publish with `offsetMs !== null` it calls `clock.sync(Date.now() + offsetMs)`.
- It re-reads the owner when the session user changes, the revision changes, the slot advances or the tab regains focus. Fixture mode reads the fixture gateway the same way, adding `withDemoCrowd`.
- `activityStatus` labels:
  - "Processing results" when the activity has ended and is not completed while `processedSlotIndex < slotIndex`;
  - "Preparing your next activity" when the last activity is completed and `processedSlotIndex < slotIndex`;
  - otherwise Scheduled, In progress or Completed by time.
- `GameViewport` gains `onStatus?(status: 'loading' | 'ready' | 'unavailable'): void`.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/sync.test.ts
test('anchors the clock offset to the revision request, not to a slow multi-page world load', ...)
// world() resolves after 4000 ms, revision() after 100 ms with serverNowMs = T; expect |offsetMs - (T - midpoint(revision))| < 50
// tests/domain/activity-status.test.ts — one case per rule, at nowMs = endsAtMs - 1, endsAtMs and endsAtMs + 1:
expect(activityStatus(endedNotCompleted, slot + 1, end + 1).label).toBe('Processing results');
expect(activityStatus(completedPrev, slot + 1, end + 1).label).toBe('Preparing your next activity');
// tests/browser/live-camp.spec.ts (routes from live-routes.ts, signed-out)
test('mounts the camp from live public reads, polling only the revision every 30 s', ...)
test('shows the camp when the first world arrives late', ...)   // world route delayed 3 s; __cloudiatorCamp ready after it
```

- [ ] **Step 2: Run** each new test file. Expected: FAIL. The offset is off by about 2 s; `activityStatus` is not defined; live mode shows `.scene-placeholder`.
- [ ] **Step 3: Implement:**
  - `sync.ts`: on the first refresh, call `revision()` alone and time it, then `world()`. The offset comes only from timed `revision()` round trips.
  - `activity-status.ts` and `useGameState.ts`.
  - The page renders `GameViewport` in live mode with `timelines` and `tournaments` set to the live gateway.
- [ ] **Step 4: Run** the three tests, then the existing `sync.spec.ts`, `arena-live.spec.ts` and `camp.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: share one sync clock and show the live camp`.

### Task 13.4: Panels follow the shared clock and revision

**Files:**
- Modify:
  - `src/features/schedule/SchedulePanel.tsx:23` (`clock` prop, re-render on clock ticks and boundaries);
  - `src/features/arena/StandingsPanel.tsx:178` (`revision` prop drives re-reads); delete `src/features/arena/standings-refresh.ts` (`standingsRefreshDue` and its tests);
  - `src/features/tournaments/TournamentPanel.tsx:322-336,408-515`;
  - `src/game/tournament-stage.ts` (`tournamentPreparing`);
  - `src/features/tournaments/tournament-text.ts:179` (remove the unreachable "You advance…" branch);
  - `src/features/arena/ArenaPanel.tsx` (spectator mode)
- Test: `tests/domain/tournament-panel.test.ts`, `tests/domain/arena-panels.test.ts`, `tests/browser/tournament.spec.ts`, `tests/browser/arena.spec.ts`, `tests/browser/planning.spec.ts`

**Interfaces:**
- Consumes: `GameUiState` from 13.3.
- Produces:
  - `SchedulePanel({ owner, gateway, refresh, clock })` and `StandingsPanel({ reads, owner, clock, revision })`.
  - `TournamentPanel({ reads, owner, clock, fixture, samples?, refresh?, revisionSlotIndex: number | null })`. It keeps `refreshOwner` in a ref (R2). While preparing, it awaits the owner refresh before the tournament read. With no owner it shows a league picker that defaults to Bronze.
  - `tournamentPreparing(id: string, nowMs: number, publishedSlotIndex: number | null): boolean`. It uses the revision's `slotIndex`, not the owner's `processedSlotIndex` (R3).
  - The live id uses `tournamentLookupIdOrNull`, falling back to "No tournament matches this selection".
  - `ArenaPanel` accepts `owner: OwnerState | null`. With null, "Your arena bout" is hidden; cards opened from the camp show public stages and `completion` only.

- [ ] **Step 1: Write the failing tests:**

```ts
test('re-estimates the next start after a boundary passes while the panel stays open', ...)   // planning.spec: advance clock 80 min; text changes; no past time shown
test('re-reads standings when the revision changes, and not on its own timer', ...)          // arena.spec: count standings requests
test('keeps one 30 s retry while preparing even when the owner refresh prop changes', ...)   // R2; tournament.spec
test('shows "Tournament being prepared" for a gladiator created after the cutoff', ...)      // R3; publishedSlotIndex < slot
test('renders the card with a not-found gateway and a lagging processed slot', ...)          // R5; tournament-panel.test.ts (SSR)
test('lets a visitor pick a league and see its countdown and bracket', ...)                  // owner null
test('opens a spectator Arena card from the camp without owner rewards', ...)                // owner null; no credited lines
```

- [ ] **Step 2: Run** the named files. Expected: FAIL for each new case.
- [ ] **Step 3: Implement** the prop changes, R2, R3 and the league picker. Remove `standings-refresh.ts` and the unreachable branch.
- [ ] **Step 4: Run** the named unit and browser files. Expected: PASS.
- [ ] **Step 5: Commit** `feat: drive panels from the shared clock and revision`.

### Task 13.5: The full-screen shell, rail, panels and chip

**Files:**
- Create in `src/features/shell/`: `CampShell.tsx`, `MenuRail.tsx`, `MenuSurface.tsx`, `CornerChip.tsx`, `rail-reveal.ts`, `menus.ts`, `shell.module.css`
- Create: `src/features/character/CharacterPanel.tsx`, `src/features/character/RosterPanel.tsx`, `src/features/arena/ArenaMenu.tsx`
- Modify:
  - `src/app/game/page.tsx`, which now only reads `mode` and `as` and renders `CampShell`;
  - `src/app/page.tsx`, which renders the same client page;
  - `src/game/GameViewport.tsx` (`chrome?: 'framed' | 'none'`; `none` fills its parent and omits its controls and fights group);
  - `src/app/globals.css` (remove the `.dashboard`, `.fighter-card`, `.management`, `.panel-nav`, `.scene-placeholder` and `.day-strip` rules)
- Create: `tests/browser/shell-helpers.ts`, `tests/browser/full-screen.spec.ts`, `tests/domain/rail-reveal.test.ts`, `tests/domain/menus.test.ts`
- Modify (move to `openMenu`, keeping every assertion): `shell.spec.ts`, `camp.spec.ts`, `arena.spec.ts`, `inventory.spec.ts`, `planning.spec.ts`, `tournament.spec.ts`, `identity.spec.ts`, `arena-live.spec.ts`

**Interfaces:**
- Consumes: `useGameState` (13.3), the 13.4 panel props, `activityStatus`.
- Produces:

```ts
export type MenuId = 'gladiator' | 'schedule' | 'inventory' | 'arena' | 'tournaments' | 'results' | 'gladiators';
export type MenuDef = { id: MenuId; icon: string; label: string; visitor: boolean };
export const MENUS: readonly MenuDef[];   // order and labels: 🛡 My gladiator (visitor), 🗓 Schedule, 🎒 Inventory and shops,
                                          // ⚔ Arena (visitor), 🏆 Tournaments (visitor), 📜 Results (visitor), 👥 Gladiators (visitor)
export function menusFor(viewer: Viewer): MenuDef[];   // player: all seven; every other viewer: the five visitor menus
export type RailState = { revealed: boolean; open: MenuId | null };
export function railReducer(state: RailState, event: 'edge-enter' | 'leave' | 'leave-timeout' | 'focus-in' | 'focus-out' | { toggle: MenuId } | 'escape' | 'camp-click'): RailState;
export function CampShell(props: { fixture: boolean; previewAs?: 'visitor' | 'player' }): ReactElement;
// tests/browser/shell-helpers.ts
export async function openMenu(page: Page, label: string): Promise<Locator>;  // desktop: pointer to x=2; touch: ☰; returns the dialog named label
```

**Layout rules (spec "Screen" and the mockup):**
- **Rail.** It slides away 300 ms after the pointer leaves unless a panel is open. Zoom buttons ("Zoom in", "Zoom out", "Reset zoom") sit at its bottom.
- **Panels.** A panel is a labelled `role="dialog"` at `left: 66px; top: 64px`, starting below the chip row, width `min(380px, 100vw - 96px)`, scrolling internally. Panels render outside the viewport host element, so camp key handlers never see their keystrokes.
- **Corner chip.** A player sees name, stamina, money, renown and the slot countdown; on touch only the name and countdown. The chip opens a small menu with "Sign out".
- **Fixture mode.** The pill "Fixture mode — progress is not saved online" stays at the top centre. The sample replay and expedition navs ("Sample replays", "Sample expeditions") move into Results.
- **Menu contents:**
  - **My gladiator:** `CharacterPanel`, with a summary (name, class, level, league, stamina, wallets, the `activityStatus` line) and `BuildPanel`.
  - **Arena:** `ArenaMenu`, holding the "Arena bouts in the rings" list (from the `arena-fights` bridge event), `ArenaPanel` and `StandingsPanel`.
  - **Gladiators:** `RosterPanel`, listing world actors with a filter box, "Find" and "Follow" per row, and "Find my gladiator" / "Follow my gladiator" for a player. Away rows say "On an expedition" (the link arrives in 13.8).
  - **Results:** in this task, the fixture sample navs only (13.7 adds the list).

- [ ] **Step 1: Write the failing tests** in `tests/domain/rail-reveal.test.ts` and `menus.test.ts` (reducer transitions, visitor menu list), plus `tests/browser/full-screen.spec.ts`:

```ts
test('shows only the grip and the corner chip at rest', ...)                 // rail box right edge <= 0; grip 5 px wide
test('reveals the rail within 12 px of the left edge and hides it after the pointer leaves', ...)
test('names each rail icon on hover', ...)                                  // tooltip text equals the MENUS label
test('reveals the rail on the first Tab and returns focus to the icon on Escape', ...)
test('opens one panel at a time; the camp, Escape or the same icon closes it', ...)
test('never lets a panel cover the corner chip', ...)                        // 1280x720 and 1024x640: boxes do not intersect
test('typing in a menu field never moves the camera', ...)                  // Review Focus 1: Gladiators filter, type '+0' and ArrowLeft; camera state unchanged
test('keeps the menus usable when the camp scene is unavailable', ...)      // Review Focus 4: no-WebGL init script; Find disabled with its reason
test('opens menus from the ☰ button as bottom sheets and closes them by swipe or ×', ...)   // mobile project
test('shrinks the player chip to the name and countdown on touch', ...)
test('scrolling inside a sheet never pans the camp', ...)                   // Review Focus 5: touch-scroll Standings; camera unchanged
test('fits sheets at 360×640 with no horizontal scroll', ...)
test('shows the rail and panels without sliding when reduced motion is preferred', ...)
test('opens the same camp at / and /game/', ...)
```

- [ ] **Step 2: Run** `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/full-screen.spec.ts`. Expected: FAIL; the rail does not exist.
- [ ] **Step 3: Implement** the shell, the menu registry, `CharacterPanel`, `RosterPanel`, `ArenaMenu` and the `GameViewport` `chrome` prop, following the mockup's layout.
- [ ] **Step 4: Migrate** the existing browser specs to `openMenu`. A changed selector is allowed; a removed assertion is not.
- [ ] **Step 5: Run** the full development browser suite, then `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: open the camp full screen with a hidden menu rail`.

### Task 13.6: Visitors watch and join

**Files:**
- Modify: `src/features/shell/CampShell.tsx`, `src/features/shell/CornerChip.tsx`, `src/features/character/CharacterPanel.tsx` (visitor prompt), `src/features/character/CreateCharacter.tsx` (dialog mode), `src/features/auth/AuthCallback.tsx` (Decision 6)
- Test: `tests/browser/visitor.spec.ts` (create), `tests/browser/identity.spec.ts`, `tests/browser/shell.spec.ts`

**Interfaces:**
- Consumes: `Viewer`, `menusFor`, `startGoogleSignIn()` and `signOut()`.
- Produces:
  - **Visitor.** The chip button is "Sign in with Google to join" ("Sign in to join" on touch). The visitor My gladiator panel shows "Sign in with Google to create your gladiator".
  - **Signed in, no gladiator.** The My gladiator panel and the chip offer "Create your gladiator", which reopens the dialog.
  - **Creation.** With `viewer === 'no-gladiator'`, the `CreateCharacter` dialog (`role="dialog"`, name "Create your gladiator") opens over the camp. "Not now" closes it, and the chip then offers "Create your gladiator".
  - **Session change.** When the viewer leaves `player`, any open private menu closes.

- [ ] **Step 1: Write the failing tests** in `tests/browser/visitor.spec.ts`, using `live-routes.ts` with no session:

```ts
test('lets a visitor watch the camp and open every public menu without sending a command', ...)
// menu labels exactly ['My gladiator','Arena','Tournaments','Results','Gladiators']; no request to /functions/v1/game-command
test('starts Google sign-in from the corner chip', ...)                       // request to /auth/v1/authorize observed
test('opens the create dialog over the running camp after sign-in without a gladiator', ...)   // camp ready behind the dialog
test('returns a cancelled sign-in to the visitor view with a short message', ...)
test('closes a private menu and shows no private value when the session ends', ...)          // Review Focus 2: Inventory open, sign out; dialog gone; owner name and money absent
```

- [ ] **Step 2: Run** the file. Expected: FAIL, with no "Sign in with Google to join" button.
- [ ] **Step 3: Implement** the visitor chip and prompt, the creation dialog, the close-on-viewer-change effect and the AuthCallback redirect.
- [ ] **Step 4: Run** `visitor.spec.ts`, `identity.spec.ts` and `shell.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: let visitors watch and join from the camp`.

### Task 13.7: Results, profile cards and merchants

**Files:**
- Create: `src/features/results/ResultsPanel.tsx`, `src/features/character/ProfileCard.tsx`, `src/features/results/result-text.ts`
- Modify: `src/game/camp-scene.ts:450` (`select-character` payload gains `screen`), `src/game/bridge.ts:3-22`, `src/features/shell/CampShell.tsx`, `src/features/inventory/InventoryPanel.tsx` and `src/features/shops/ShopPanel.tsx` (an initial merchant tab prop)
- Test: `tests/domain/results-panel.test.ts`, `tests/browser/management.spec.ts` (create)

**Interfaces:**
- Consumes: `gateway.recent(cursor?)`, `gateway.profile(id)`, the bridge events `select-character` and `open-merchant`.
- Produces:
  - `ResultsPanel({ reads: Pick<GameGateway, 'recent'>, viewerId: string | null, onWatch(activityId: string): void })`. It shows pages of 50 with "More" and marks the viewer's own rows "You".
  - `resultLine(row: ResultRow): { text: string; replay: boolean }`. Training and Rest never offer a replay and never say "no longer kept" (Tasks 7, 9).
  - `ProfileCard({ actor: PublicActor, profile: PublicProfile | null, own: boolean, onFollow(id), onWatch?(activityId), onOpenMenu(id: MenuId) })`.
    - It renders from `actor` at once and loads `profile` on demand.
    - The viewer's own card adds "My gladiator" and "Schedule" shortcuts.
    - On desktop it sits near `screen`; on touch it opens as a bottom sheet.
  - `ShopPanel` and `InventoryPanel` take `initialMerchant?: 'weaponsmith' | 'armorer'`. `open-merchant` opens Inventory and shops at that merchant for a player; for a visitor it opens My gladiator's sign-in prompt.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/domain/results-panel.test.ts
expect(resultLine(trainingRow)).toEqual({ text: 'Aster finished training', replay: false });
test('pages recent results 50 at a time and marks the viewer's own rows', ...)
// tests/browser/management.spec.ts
test('opens a public profile card from a camp click, the Gladiators list and the standings', ...)
test('shows management shortcuts only on the viewer's own card', ...)
test('opens Inventory and shops at the weapon smith when the merchant is clicked', ...)
test('shows the pending build, then Processing results at the slot end, without changing the displayed money', ...)
// old Task 13 Step 1: live routes, signed in; queue a build ("Pending build" visible), move __cloudiatorShell.clock past the activity end
```

- [ ] **Step 2: Run** the files. Expected: FAIL; `ResultsPanel` and `ProfileCard` are missing.
- [ ] **Step 3: Implement.** Give every world click a keyboard path: rows in Gladiators and Standings open the same card.
- [ ] **Step 4: Run** the named files plus `inventory.spec.ts` and `camp.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add results, profile cards and merchant shortcuts`.

### Task 13.8: Replays and expeditions over the camp

**Files:**
- Create: `src/features/shell/SceneOverlay.tsx`
- Modify:
  - `src/features/shell/CampShell.tsx` (Decision 4);
  - `src/features/character/ExpeditionView.tsx:117-259` (replace `useTimelineReads` and `readDue` polling with re-reads on a `revision` prop and at its reveal marks);
  - `src/game/replay.ts` (battles filtered by display time);
  - `src/features/arena/BattleReplay.tsx`;
  - `src/features/character/RosterPanel.tsx` (away rows link);
  - `src/game/expedition-stage.ts` (named encounter-count constant; safe-point leave keeps the rest pose while fading);
  - `src/app/replay/page.tsx` and `src/app/expedition/page.tsx` (they mount `useGameState` for the clock and revision)
- Test: `tests/domain/replay.test.ts`, `tests/domain/expedition-stage.test.ts`, `tests/browser/scenes.spec.ts` (create), `tests/browser/expedition.spec.ts` (rename the stale test title), `tests/browser/replay.spec.ts`

**Interfaces:**
- Consumes: the bridge events `view-replay`, `view-expedition`, `return-camp`; `loadReplayView`; `ExpeditionView`.
- Produces:
  - `SceneOverlay({ view: { kind: 'replay'; activityId: string; stageId?: string } | { kind: 'expedition'; activityId: string }, gateway, state: GameUiState, onClose })`. It is full-window and labelled, with a "Back to camp" button that emits `return-camp`.
  - `replayBattles(view: ReplayView, nowMs: number)` keeps only battles that ended by `nowMs`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('opens a replay full screen over the camp and returns with Back to camp', ...)   // scenes.spec; camp still ready after
test('closes the scene with the browser Back button', ...)
test('opens an away gladiator's expedition from the Gladiators list', ...)
test('keeps /replay/ and /expedition/ deep links working', ...)
test('shows a visitor's guessed or unrevealed activity as not available yet, without a summary', ...)  // Review Focus 3; live routes, no session
// tests/domain/replay.test.ts
expect(replayBattles(view, endOfFirstBattle - 1).map(b => b.id)).toEqual([]);
// tests/domain/expedition-stage.test.ts
test('keeps the rest pose while leaving from the safe point after a defeat', ...)
```

- [ ] **Step 2: Run** the files. Expected: FAIL; there is no overlay and battles are unfiltered.
- [ ] **Step 3: Implement** the overlay, the history entries, the bridge wiring, the revision-driven expedition reads, the replay filter and the Task 15 Minors.
- [ ] **Step 4: Run** `scenes.spec.ts`, `expedition.spec.ts`, `replay.spec.ts` and the two unit files. Expected: PASS.
- [ ] **Step 5: Commit** `feat: open replays and expeditions over the camp`.

### Task 13.9: Live-ready tournament rings, final gates and handoff

**Files:**
- Create: `supabase/functions/_shared/domain/tournament-slot.ts` (engine-free `isTournamentSlot`)
- Modify:
  - `supabase/functions/_shared/domain/tournament.ts` (re-export it);
  - `src/game/tournament-stage.ts:28`;
  - `src/game/tournament-camp.ts` (schedule from the fight summary);
  - `src/game/arena-layout.ts` (`scheduleArenaRings` independent of arrival order);
  - `src/game/GameViewport.tsx:105,166-216` (`forgetLeft` pruning; logs only for current or upcoming ring windows; uses the shared gateway cache)
- Test: `tests/domain/tournament-camp.test.ts`, `tests/domain/arena-layout.test.ts`, `tests/domain/tournament-slot.test.ts`, `tests/browser/tournament.spec.ts`
- Docs: `docs/implementation/task-13-report.md`, `docs/implementation/HANDOFF.md`, `docs/operations/migrations.md`

**Interfaces:**
- Produces:
  - `isTournamentSlot(slotIndex: number): boolean` from `tournament-slot.ts`. Its import graph contains no combat engine.
  - `tournamentLogsDue` changes to `(view, nowMs, windowMs): string[]` and returns only bouts whose ring window is current or starts within `windowMs`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('assigns the same rings whatever order the logs arrive in', ...)     // 18 round-1 fights; two arrival orders; equal schedules (R4)
test('asks for logs only for current and upcoming ring windows', ...)
test('forgets tournament views whose entrants have left the camp', ...)
test('changes a tournament ring and the panel over at the same moment', ...)   // tournament.spec
test('isTournamentSlot imports no combat engine', ...)                     // static import walk of tournament-slot.ts
test('a viewer joining late loads at most the logs of the current and next ring window', ...)  // record the count in the report
```

- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run the full gate** in the order of `verification-gates.md`: `npm test`, `npm run typecheck`, `npm run test:db` (with a stable Edge start time), `npm run build` and `npm run verify:static`, the development browser suite, then the isolated production gate using the repo's `playwright.config.ts`, then `git diff --check`. Expected: all PASS.
- [ ] **Step 5: Write** `task-13-report.md` (gate registry outcomes, measurements, file-map adjustments), update HANDOFF (19 of 24 tasks, M13, Task 18's Marketplace gate) and `migrations.md`.
- [ ] **Step 6: Commit** `feat: ready the live camp's tournament rings`, then `docs: report Task 13` separately.
