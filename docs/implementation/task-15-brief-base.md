# Task 15 brief base: binding plan and spec text

Copied verbatim from the approved plan and spec at `05b1ea0`. This text is binding.

## Plan: Task 15

## Task 15: Followable expedition scenes using only revealed stages

**Files:** Create `src/game/expedition-scene.ts`, `src/features/character/ExpeditionView.tsx`, `tests/browser/expedition.spec.ts`; extend bridge and fixture gateway timelines.

**Interfaces:** Consumes `RevealedTimeline`, replay controller, camera/paths and expedition manifests. Produces `renderExpeditionStage(timeline: RevealedTimeline, displayNowMs: number): ExpeditionSceneState`; no private plan input. State has visible travel/search/encounter/safe-return phase and replay availability.

- [ ] **Step 1:** Test mid-slot entry and failure presentation.
  ```ts
  await expeditionFlow.openAtMinute(page, 39);
  await expect(page.getByText('Encounter 1')).toBeVisible();
  await expect(page.getByText('Encounter 2')).toHaveCount(0);
  await expeditionFlow.openFailedAtMinute(page, 65);
  await expect(page.getByText('Returning without rewards')).toBeVisible();
  ```
- [ ] **Step 2:** Run `npm run test:e2e -- tests/browser/expedition.spec.ts`; expect no journey scene/current-stage rendering.
- [ ] **Step 3:** Implement three environments with automatic path travel, exploration/search pauses, revealed encounter playback, progress strip/log, safe-point rest after failure, follow/free camera and Camp button. A delayed reveal displays Preparing, never a fabricated encounter. Owner and spectators see only gateway-published stages; new navigation/reload jumps to current visible progress. Scene clocks cannot reveal missing stages, advance jobs, or settle rewards.
- [ ] **Step 4:** Run minute19/20/39/40/59/60/79/80 table cases, reload/replay/leave/return and other-character viewing; inspect network payloads for future enemy/loot/outcome leakage and assert no mutation call from replay or camera controls.
- [ ] **Step 5:** Stage named files; commit `feat: follow automatic isometric expeditions`.


## Plan: global contracts (excerpt)

`GameGateway` provides `command<T>(input: GameCommand): Promise<CommandResult<T>>`, `owner(): Promise<OwnerState>`, `world(): Promise<WorldSnapshot>`, `revision(): Promise<RevisionState>`, `timeline(id: ActivityId): Promise<RevealedTimeline>`, `profile(id: GladiatorId): Promise<PublicProfile>`, `market(cursor?: string): Promise<MarketPage>`, `standings(league: LeagueId): Promise<StandingsPage>`, `tournament(id: string): Promise<TournamentView>`, and `recent(cursor?: string): Promise<ResultsPage>`. Cursor pages have at most 50 rows.

`OwnerState` contains the owner's current and pending builds, schedule/version, wallets and reserved fees, inventory, progression, stamina, opt-in flag, processed slot, and current activity summary. `PublicActor` contains character ID/name/class, visible equipment silhouettes, current league/level, phase/location, activity ID/status/timestamps, and visible stage; it excludes owner identity, wallet, inventory, future schedule, private snapshots, and seeds. `WorldSnapshot` contains `{ revision: string, serverNowMs: number, slotIndex: number, actors: PublicActor[] }`; `RevisionState` is the first three fields only. `RevealedTimeline` contains `{ activityId, serverNowMs, visibleThroughMs, stages: RevealedStage[], summary?: ActivitySummary }`; stages can include an already revealed `BattleLog`. A summary carries resolved kind, success/result, credited rewards, receipt ID, and replay-expiry state. Competition DTOs expose archived standings and revealed bracket results, with no future opponent snapshot or outcome.

## Global constraints

- Public game, English interface, responsive desktop/mobile browsers, Google sign-in only.
- One gladiator per account; initial class selection; class changes and attribute respecs cost game money with no additional cooldown.
- Colorful fantasy pixel art, weapon-based fighters and fantasy creatures, no spellcasting classes.
- Shared four-hour game day; three 80-minute slots: morning, afternoon, evening.
- Define `slot_index = floor(UTC epoch milliseconds / 4,800,000)` and `phase = slot_index mod 3`.
- Wednesday and Saturday, 17:20 UTC, lasting one 80-minute afternoon slot.
- Allocating previously unspent points is free. A respec fee is required when any already-allocated attribute decreases.
- Changing Endurance preserves absolute current stamina, clamping it to a reduced maximum if needed. Raising capacity does not refill stamina.
- Initial reads are authenticated.
- Backend credentials, worker authentication material, seeds, and unrevealed plans remain server-side.
- Runtime package versions are pinned and lockfiles committed when implementation begins.
- Target 60 fps desktop and at least 30 fps on the mobile test device, verified before release rather than assumed.
- Below 250 MB database usage, below 3 GB monthly Supabase egress, and below 300,000 monthly function invocations at the initial expected usage.
- Retain detailed battle/expedition replay events seven days. Retain activity and financial summaries 90 days, with checkpointed balances and progression.
- Preserve account state, item ownership, season archives, prestige, and unique settled-slot checkpoints indefinitely.

## Spec excerpts

The isometric camp occupies the main viewport. The visible controls show the character's name, current activity, slot countdown, stamina, level, money, renown, and a compact repeating schedule. Management panels expose attributes, equipment/inventory, shops/marketplace, arena standings, tournament registration/brackets, and recent results.

On desktop, panels sit beside or over the scene. On mobile, they use tabs and a dismissible sheet so the world remains usable. Primary actions remain available through buttons as well as clickable world locations. A gladiator list lets players find characters hidden by scenery or away on expeditions.

Proposed camera controls: mouse drag to pan, wheel to zoom, touch drag/pinch on mobile, visible zoom buttons, and Find my gladiator / Follow toggles. Camera bounds keep the user inside the scene. Selecting a character opens a public profile/current-activity card; selecting the owner's character adds management controls. Selecting an expedition activity opens its currently visible scene. Other characters' wallets, inventory contents, future schedule, and unrevealed encounter outcomes remain private.

### 3.3 Shared camp and ambient life

The camp contains training grounds, resting quarters, merchant stalls, expedition gates, and an arena complex. Training has weight-lifting, dummy practice, and sparring visual routines; all grant the same training reward. Rest has sitting, eating, and sleeping routines. Characters walk along defined paths between activity zones. NPCs wander, tend stalls, and stop for ambient conversations. Clicking merchants opens the actual shop interface.

Player activity locations derive from authoritative activity records. Browsers animate movement and ambient routines locally, using stable character/slot identifiers and time offsets. The database does not track every step. Ambient conversations and NPC movement do not alter progression. Path choices avoid buildings; sprite depth ordering prevents characters drawing over walls incorrectly.

The camp remains lively when the viewer is idle. Morning, afternoon, and evening change lighting, sky tint, and torch intensity without hiding readable characters or controls. Characters remain represented when their owners are offline. Characters on expeditions are away from the camp, with an away indicator in the roster. Arrival/departure transitions are visible when viewing a boundary; returning later shows the current location directly.

The arena complex includes staging space and multiple sparring positions so simultaneous regular fights have room. Selecting a fight opens its expanded replay. Tournament participants visibly wait, fight, or spectate according to the tournament timeline. Decorative spectators use bounded populations.

**Proposed visual budget:** one modular camp map, three expedition environments, six ambient NPCs, and up to 50 player actors in the camp dataset. Render only visible actors and pause rendering in hidden tabs. Target 60 fps desktop and at least 30 fps on the mobile test device, verified before release rather than assumed. A reduced-motion option retains activity labels and progression while reducing ambient movement and camera effects.

### 3.4 Expedition scenes

Each expedition is an individual automatic journey in a dedicated isometric environment. It uses timed travel/exploration segments and encounter stages, with a progress strip and activity log. The camera can follow the gladiator or freely pan, and a Camp button returns to the shared world.

The backend prepares an immutable encounter plan and publishes events only when their scheduled reveal time arrives. Loading a scene midway jumps to the current stage and lets the viewer replay completed encounters. Future opponents, outcomes, and loot are not exposed before their reveal time. Watching, leaving the scene, refreshing, or replaying never changes rewards or speeds up the activity.

**Proposed timeline:** depart at minute 0; encounters begin at minutes 20, 40, and 60; return and settle rewards at minute 80. Travel, searching, and short pauses fill the intervals. Once an encounter is revealed, its combat log can animate as a short replay. HP carries between expedition encounters, with recovery of 20% maximum HP after each won non-final encounter. A defeat ends further encounters; the character rests at a safe return point until the slot ends and receives no expedition rewards. Each new expedition begins at full health.

### 3.5 Art and animation assets

Use colorful fantasy pixel art and an angled/isometric camp and expedition view. The approved battle concept governs the close-up fight style. Maps, sprites, equipment silhouettes, effects, and UI icons must form a consistent palette and pixel scale. Production maps use tiles and separate sprites, supporting animated paths, click targets, and depth sorting.

Normal boundary processing target is completion within two minutes at 50 characters, tested under representative load. A miss produces a visible processing state and recovery alert, not premature success. Three failed attempts retain diagnostic metadata and surface an operator-action state; deterministic errors are fixed before resuming the same snapshot rather than silently deleting an activity.

### 10.5 Reading world state efficiently

Fetch the camp projection on entry. While visible, poll a small revision/server-time record every 30 seconds and fetch changed projection data only when its revision differs. Load character details, inventory, replay logs, and marketplace pages on demand, with pagination. Public stage reveals increment the revision. Pause polling in hidden tabs and refresh on focus. Render movement locally between synchronized timestamps. No per-frame database writes or network broadcasts are needed.

Initial reads are authenticated. Public profiles and current visible events are readable by signed-in players; private management rows are owner-only. An expedition viewer can watch another character's already-revealed travel/encounters through the public projection. Unequipped loot stays private; equipped items and marketplace listings are public. Read authorization enforces `reveal_at <= database time` even if a caller guesses an event ID. The owner cannot read unrevealed plans through an owner-only management query either.

### 10.6 Authentication and database access

Google OAuth requests identity scopes only. Configure authorized origins, Google's Supabase callback, and the app's exact allowed redirect destinations. Keep the Google client secret in backend/provider configuration. Verify sessions server-side for every command and bind the acting character to the verified account; arbitrary client-supplied owner IDs are not authority.

## 11. Failure states and recovery

| Failure | Required behavior |
| --- | --- |
| OAuth canceled/expired | Explain sign-in state; retry safely; preserve a valid character-creation draft without creating a duplicate |
| Insufficient stamina | Resolve the slot as Rest and report the fallback |
| Expedition defeat | End remaining encounters; no XP/money/loot; return at slot end with character and gear intact |
| No eligible PvP opponent | NPC fallback, reduced renown, no rating delta |
| Too few tournament entrants | Regular Arena in the same slot |
| Purchase races or expired listing | One winner; losing requests get a sold/expired response and no debit |
| Invalid/changed pending build | Reject before queueing or preserve current build; never charge a second fee or lose reserved money |

Proposed internal budgets: below 250 MB database usage, below 3 GB monthly Supabase egress, and below 300,000 monthly function invocations at the initial expected usage. Measure 50 active players with a representative 30-minute visible session per player/day, and separately test 50 concurrent scene viewers. These budgets are engineering targets, not a guarantee that arbitrary usage fits free plans. Host static art on Pages, load selected scenes lazily, and keep revision reads small.

Retain detailed battle/expedition replay events seven days. Retain activity and financial summaries 90 days, with checkpointed balances and progression. Preserve account state, item ownership, season archives, prestige, and unique settled-slot checkpoints indefinitely. Pruning cannot delete unprocessed jobs, active reservations, or the information required to prevent duplicate grants. Explain retention in the recent-results interface.

Daily cleanup expires listings and prunes safe historical data. Monitor budgets and overdue work; approaching a limit prompts optimization or a decision by Avi rather than an automatic paid upgrade. Weekly operator exports provide a recoverable database copy outside the free service, with a restoration check before launch. Do not treat cron traffic as a guarantee against platform pausing.


1. A new user opens the link, uses Google sign-in, creates exactly one persistent gladiator, and configures a schedule.
2. Time-boundary tests confirm shared phases, repeat behavior, late-edit exclusion, next-boundary builds, fee refunds, and conservation of earned attribute points.
3. Closing the browser for at least three game days still yields the exact scheduled progression on return; outage/catch-up tests preserve revisions and award each activity once.
4. Stamina fallback, Endurance capacity changes, and overweight equipment behave exactly as previewed, without free refill exploits.
5. The camp displays a representative 50-character population in correct zones, with varied animations, NPC routines, depth sorting, selectable characters, camera pan/zoom, and changing lighting.
6. An expedition shows only revealed stages, maintains health correctly, returns success/failure results at its end, and keeps the same result after reload or replay.
7. Combat simulations are deterministic across retries; replay events reproduce final HP, winner and rewards. Multiple simultaneous bouts and NPC fallback work.
8. Tournament tests cover 0, 1, 2, 3, 5, and 50 entrants, byes, eligibility cutoffs, parent/child jobs, fresh bout health, one stamina debit, and exactly-once placements.
9. League and season tests cover banked points, gear removal/sale, respec, promotion, final-slot ordering, qualification, rating updates and no duplicate seasonal rewards.
10. Concurrent purchase/cancel/NPC-sale/build-reservation tests conserve balances and produce one item owner; bound gear cannot enter the marketplace.
11. Owner/public/other-account/unauthenticated access tests prove that wallet writes, private builds, future plans, seeds and provider data cannot be read or mutated through client APIs.
