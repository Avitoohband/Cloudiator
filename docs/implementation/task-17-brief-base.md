# Task 17 brief base: binding plan and spec text

Copied verbatim from the brief Codex prepared from the approved plan and spec (its Codex-era "Controller preparation context" is omitted; `task-17-claude-dispatch.md` replaces it). This text is binding.

## Task 17: Shared Arena staging, selection, and standings

**Files:** Create `src/features/arena/ArenaPanel.tsx`, `StandingsPanel.tsx`, `tests/browser/arena.spec.ts`; extend camp scene, gateway standings and replay navigation.

**Interfaces:** Consumes `ArenaAssignment` public summaries, revealed logs and `StandingsPage`; produces expanded Arena replay selection and paginated league standings with separate rating/renown/current-strength displays.

- [ ] **Step 1:** Test presentation timing and fallback disclosure.
  ```ts
  await arenaFlow.openAtMinute(page, 59);
  await expect(page.getByText('Warming up')).toBeVisible();
  await arenaFlow.openAtMinute(page, 60);
  await expect(page.getByRole('button', { name: 'Watch replay' })).toBeEnabled();
  await expect(page.getByText('NPC opponent — reduced renown, no rating change')).toBeVisible();
  ```
- [ ] **Step 2:** Run `npm run test:e2e -- tests/browser/arena.spec.ts`; expect missing stage/standings UI.
- [ ] **Step 3:** Add bounded simultaneous sparring/staging positions, selected close-up replay, result summaries, visible opponent/current rating and league explanation. At the boundary, refresh standings from credited results; don't pre-credit simulated wins. NPCs are distinguishable from player characters. Panels work on mobile and through keyboard buttons.
- [ ] **Step 4:** Run staged/preparing/revealed/completed cases, multiple simultaneous fights, NPC and human losses without lasting injury, selected replay after return, and no-result worker delay.
- [ ] **Step 5:** Stage named/modified files; commit `feat: present Arena activity and standings`.


## Global Constraints

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


### Shared types and API decisions

Task 1 defines the public wire types; Task 2 defines domain snapshots. Integers use finite safe integers; IDs are UUID strings; timestamps are UTC epoch milliseconds; currencies and points are nonnegative integers. Types serialize as plain JSON, not Dates, Maps, or class instances.

```ts
type GladiatorId = string;
type ActivityId = string;
type OperationId = string; // client-created UUID, scoped to verified account
type Seed = string;        // private backend input, never a public DTO property
type Phase = 'morning' | 'afternoon' | 'evening';
type ClassId = 'berserker' | 'guardian' | 'duelist';
type Stance = 'offensive' | 'balanced' | 'defensive';
type LeagueId = 'bronze' | 'silver' | 'gold' | 'champion';
type Attributes = { strength: number; agility: number; vitality: number; endurance: number; precision: number };
type ActivityChoice = { kind: 'training' | 'rest' | 'arena' } | { kind: 'expedition'; expeditionId: 'woodland' | 'outpost' | 'mountain' };
type Schedule = Record<Phase, ActivityChoice>;
type ApiErrorCode = 'unauthenticated' | 'invalid' | 'conflict' | 'processing' | 'insufficient-funds' | 'inventory-full' | 'sold' | 'expired' | 'not-found' | 'rate-limited' | 'unavailable';
type CommandResult<T> = { ok: true; receiptId: string; value: T } | { ok: false; code: ApiErrorCode; retryAfterMs?: number };
```

`GameCommand` is a discriminated union of create-character, edit-schedule, queue-build, cancel-build, buy-shop, sell-item, discard-item, create-listing, cancel-listing, buy-listing, and set-tournament-opt-in. Every command carries `operationId`; actor identity comes from the verified session, never from a request owner ID. Creation contains name/class/allocation; builds contain expected version plus class/stance/allocation/equipment; item commands contain instance/catalog IDs and quantity; market commands contain listing ID or item ID/price; schedule commands contain phase/choice and expected version.

`GameGateway` provides `command<T>(input: GameCommand): Promise<CommandResult<T>>`, `owner(): Promise<OwnerState>`, `world(): Promise<WorldSnapshot>`, `revision(): Promise<RevisionState>`, `timeline(id: ActivityId): Promise<RevealedTimeline>`, `profile(id: GladiatorId): Promise<PublicProfile>`, `market(cursor?: string): Promise<MarketPage>`, `standings(league: LeagueId): Promise<StandingsPage>`, `tournament(id: string): Promise<TournamentView>`, and `recent(cursor?: string): Promise<ResultsPage>`. Cursor pages have at most 50 rows.

`OwnerState` contains the owner's current and pending builds, schedule/version, wallets and reserved fees, inventory, progression, stamina, opt-in flag, processed slot, and current activity summary. `PublicActor` contains character ID/name/class, visible equipment silhouettes, current league/level, phase/location, activity ID/status/timestamps, and visible stage; it excludes owner identity, wallet, inventory, future schedule, private snapshots, and seeds. `WorldSnapshot` contains `{ revision: string, serverNowMs: number, slotIndex: number, actors: PublicActor[] }`; `RevisionState` is the first three fields only. `RevealedTimeline` contains `{ activityId, serverNowMs, visibleThroughMs, stages: RevealedStage[], summary?: ActivitySummary }`; stages can include an already revealed `BattleLog`. A summary carries resolved kind, success/result, credited rewards, receipt ID, and replay-expiry state. Competition DTOs expose archived standings and revealed bracket results, with no future opponent snapshot or outcome.

Task 1 declares the complete serializable wire shapes, including the battle-log shape in `contracts/events.ts`, so its typecheck does not depend on later files. Task 2's domain types reuse those primitive/wire types and add private inputs; Task 3 implements the engine without redefining the log. Other task-owned return types are defined beside the named producing function. `ItemInstance` includes ID/owner/catalog version/tier/rarity/immutable stats/origin/binding/reservation; `Rules` and `Catalog` are typed versions of the exact spec tables. `BuildInput` contains class/stance/allocations/item IDs; validation returns either a frozen legal build or a typed reason. Inventory plans distinguish retained items, stacked salvage and overflow-money receipts; job leases include ID/token/expiry/immutable snapshot/seed/rules version. No later task should introduce a competing definition.

Live reads use the protected Supabase Data API tables/views and RLS, avoiding an Edge invocation for every poll. Commands go through `game-command`; worker requests go through `game-worker` with private authentication. `OwnerState` is available after Task 4, before the world projection exists; unimplemented read methods explicitly return unavailable. Public read rows contain only safe DTO columns. Backend projection code writes those rows; frontend `src/lib/api/reads.ts` maps protected read queries to DTOs.

### Common execution and test protocol

- Read the spec and applicable skills before each implementation area. At execution start inspect the local runtime/tool inventory and current official Next/Phaser/Supabase docs/changelog; select compatible stable packages, pin exact versions, and commit lockfiles. No package installs are part of plan writing.
- Use npm scripts established in Task 1: `test` = Vitest domain/backend/assets; `test:db` = Vitest PostgreSQL integration config; `test:e2e` = Playwright; `typecheck` = TypeScript plus Deno checks; `build` = static Next build; `verify:static` = output/secret scanner. Edge modules use explicit relative `.ts` imports; Next/Vitest alias `@domain` and `@contracts` to the canonical `_shared` directories. Pure shared code imports neither Deno APIs nor React/Phaser/database adapters.
- `tests/fixtures/domain.ts` supplies typed minimal snapshots/catalog fixtures; `tests/fixtures/db.ts` supplies independent-account clients and trusted operator SQL access against the local test database, with a reset per suite. Never use production data for destructive tests. Test-only clock controls are local fixtures/operator harness inputs, never authenticated player endpoints.
- Test snippets are assertions inside named tests in the listed owning test file. Fixture variables and convenience helpers such as `db.raceCreate` or `arenaFlow.openAtMinute` are defined in that test file or extended in the named fixture module as part of Step 1; they are test setup, not unspecified production APIs. They must exercise actual SQL/handlers/renderers rather than fabricate a passing result. Name each test after the behavior in its Step 1 and add the extra table cases in Step 4.
- PostgreSQL changes: implement in the named `supabase/sql/NN-*.sql`, iterate locally using SQL queries, run the owning tests and advisors, then generate a deployable migration with the current CLI's documented `db pull <name> --local --yes` and inspect `migration list --local`. Discover flags with `--help`. If a new empty migration is needed, use `migration new <name>`; never invent its timestamp filename. Record the generated path in `docs/operations/migrations.md`, and stage that exact path along with the SQL source. In task commit commands, `Mnn` means that newly generated exact path, resolved before running Git.
- SQL source files support controlled local reapplication with guarded DDL and `CREATE OR REPLACE` where appropriate; generated committed migrations remain immutable. Schema iteration and migration replay are separate checks.
- Each task has a red/green cycle. A missing import, table, route, or assertion is the expected initial failure. Do not count configuration mistakes as a meaningful red result. Run only the owning tests plus affected existing suites; the final release runs the complete suite.
- Commit commands below use PowerShell-compatible Git calls on separate lines. Local commits are reviewable checkpoints; pushes, account creation, and deployment follow the approved execution scope and account availability.
- Every Step 5 means run `git add -- <exact paths in that task's Files list and any explicitly modified earlier files>`, inspect `git diff --cached --check`, then `git commit -m "<the task's quoted message>"`. Resolve generated migration aliases to their actual paths first. Stage no other work or ignored credentials; record actual paths if implementation needs a file-map adjustment.


## 3. Player journey and interface

### 3.1 First visit and character creation

1. Open the public URL and sign in with Google.
2. If no gladiator exists, enter a name, choose a class, and allocate starting points.
3. Preview class bonuses, derived health/stamina, and equipment load before confirming.
4. Create the character and starter items in one server transaction.
5. Enter the shared camp, centered on the character, and configure the repeating schedule.

**Proposed defaults:** names are unique case-insensitively, 3–20 characters, using English letters, digits, spaces, underscores, or hyphens. Start at level 1 with five base points in each attribute, 10 allocatable points, 100 money, zero renown, full stamina, a common sword, and light body armor. The suggested allocation distributes the 10 points equally, but the player can change it during creation. Default schedule is Training / Expedition: Woodland Path / Rest. Tournament auto-registration starts off. Newly created characters start their first full activity at the next shared slot boundary; the remaining partial slot is an orientation period.

Creation is idempotent and the account-to-gladiator relation is unique. Concurrent tabs cannot create a second character or duplicate starter items. Google email addresses and provider identifiers are never part of public character profiles.

### 3.2 Main screen

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

Minimum animation set: idle, directional walking, weight training, weapon practice, sparring, sitting, eating, sleeping, searching, attack, hit reaction, defend, evade, defeat, and victory. Weighted variants and offsets prevent all characters looping in synchrony. Equipment appearances distinguish weapon categories and light/heavy armor. Character colors and nameplates distinguish players; full bespoke visuals for every item are not a first-release requirement.

The generated references are style concepts, not production sprite sheets. Preserve their originals and include reference copies with this spec:

- [Art styles](references/art-style-comparison.png): approved top panel A, Colorful Fantasy.
- [World perspectives](references/world-perspective-comparison.png): approved top panel A, Angled/Isometric.

Production assets must be original or sourced with documented usable licenses. Record provenance alongside the assets. Asset generation and integration begin after the implementation plan is approved.


## 7. Automatic combat and replays

Combat is a deterministic, seed-driven engine independent of Phaser and React. Given participant snapshots, a private server seed, and a rules version, it produces the same event log and outcome. Browser animation consumes the event log without recalculating damage or awarding rewards.

Proposed initial formulas:

- Base player attack damage: `weapon damage + 0.5 × effective Strength`.
- Attack interval: `max(250, weapon interval / ((1 + 0.01 × effective Agility) × efficiency))`, rounded to integer milliseconds.
- Hit probability: `clamp(0.70 + 0.005 × attacker Precision − 0.003 × defender Agility, 0.10, 0.95)`.
- Critical probability: `clamp(0.05 + 0.003 × Precision, 0.05, 0.40)`; critical damage multiplier 1.5.
- Armor reduction: `min(0.70, 0.02 × total armor)`.
- Offensive: outgoing damage ×1.15 and incoming damage ×1.10.
- Balanced: outgoing/incoming multipliers 1.
- Defensive: outgoing damage ×0.90 and incoming damage ×0.85.
- Damage applies efficiency, critical and stance multipliers, then armor reduction; round to an integer with minimum damage 1 on a hit.

First attacks occur after the first attack interval. Equal-time attacks resolve simultaneously, avoiding an ID-based initiative advantage. End a fight on defeat or after 120 simulated seconds. At the time limit, higher remaining-health fraction wins; equal fractions, including simultaneous defeat, use a logged seeded tie-break. All initial fights produce a winner; there are no drawn tournament matches.

Logs identify actions, timestamps, hits/misses, criticals, damage, health changes, and the victory reason. Replays support normal/fast playback, pause, restart, and skip-to-result. Damage labels, effects, and animation reflect the actual log. Completed results show the opponent, stance/build snapshots, rewards, rating delta where applicable, and a readable combat log.

Arena health is fight-local. Every regular arena fight starts at full health. Every tournament bout starts at full health. Arena defeat affects rating/result and spent stamina, with no lasting injury or gear loss.

NPC fallback opponents are generated from the entrant's current combat build strength, using server-controlled templates, not an inflated random opponent. NPC win reward is three renown; loss reward is zero. Human arena wins give 10 renown and losses two. These amounts are proposed balance.

Proposed fallback template: mirror the player's effective attributes, armor, and weapon interval, use Balanced stance, and override maximum health and pre-stance base damage to 85% of the player's values. Retain the player's overload efficiency, applying it once. The NPC has no XP, money, or item rewards. Its snapshot is generated once and retained with the activity.

Proposed regular-Arena presentation: stage and warm up during minutes 0–60; reveal the fight log at minute 60; show the completed bout/replay afterward; grant rewards and rating changes at minute 80. Warm-up animation does not grant training points. The log is a replay of the authoritative bout, and can be watched at any point after its reveal.


## 8. Leagues, matchmaking, tournaments, and seasons

### 8.1 League eligibility and regular matching

League eligibility must include earned progression even when points are unallocated, and preserve equipment-strength history after items are unequipped or sold. This prevents deliberate downgrading through loadout changes, respecs, or banking points.

Proposed progression index: `2 × level + floor(total earned allocatable points / 5) + floor(historical gear strength / 10)`. The starting 10 allocatable points count as earned. Historical gear strength is the highest legal loadout score obtainable from equipment the character owned at any time; it never decreases. Score sums `4 × weapon damage × (1000 / weapon interval) + 2 × total armor`, using immutable item stats; two-handed restrictions still apply. Calculate legal combinations when gear is acquired and retain the maximum, rather than retaining every old inventory. Bound arena gear includes its arena damage bonus in this score.

| Proposed league | Progression index |
| --- | --- |
| Bronze | Below 25 |
| Silver | 25–59 |
| Gold | 60–119 |
| Champion | 120 and above |

Promotion applies at slot boundaries. League placement never decreases through equipment removal or respec. Current combat strength remains visible separately so players understand why a weak current loadout can still belong to a higher league.

Regular Arena pairs entrants within their league. Sort by current combat strength, then rating, then a seeded tie-break. Process the first unpaired entrant, choosing the eligible opponent with nearest strength, then fewest recent pairings in the preceding 18 slots, then nearest rating, then seeded tie-break; remove the pair and continue. Reject pairs where larger estimate exceeds twice the smaller; an unmatched entrant receives an NPC fight. No cross-league regular fights occur at launch.

Proposed strength estimate is `max health × expected outgoing damage per second`, derived from the frozen snapshot. Expected damage per attack uses player base damage, efficiency, stance, hit probability against reference Agility 5, and expected critical multiplier `1 + 0.5 × critical probability`. Divide by the attack interval in seconds. For this reference target, armor is zero and incoming stance multiplier is one. Include arena-specific item modifiers. This estimate orders opponents; the seeded combat engine still determines winners.

Proposed rating is Elo-style, starting at 1,000, with K=24 and expectation `1 / (1 + 10^((opponent rating − own rating) / 400))`. Compute the winner's gain as `round(24 × (1 − expected win probability))`; apply that gain to the winner and its negative to the loser, then clamp each rating at zero. NPC fights never affect rating. Human tournament bouts also affect rating. For a tournament, apply bouts in round order using the ratings updated by earlier rounds; same-round bouts involve distinct players. Maintain ratings per character, league, and season; entering a new league starts that league's rating at 1,000 while retaining the previous league record.

### 8.2 Tournament scheduling and eligibility

**Proposed fixed times:** Wednesday and Saturday, 17:20 UTC, lasting one 80-minute afternoon slot. Display the equivalent local time and a countdown. No local daylight-saving change alters UTC scheduling.

The character must have auto-registration enabled, Arena assigned to that phase, and sufficient stamina at the slot cutoff. Registration does not require an open browser. Toggles made after the cutoff affect future tournaments. Each league runs its own bracket if at least two entrants qualify. Otherwise those entrants run regular Arena, including NPC fallback where needed.

Single-elimination brackets use seeded randomized placement and byes to fill the next power-of-two bracket. Publish entrants and bracket shape at start, with no fabricated NPC entrants. All bout builds use the tournament's initial snapshot. The entire tournament charges stamina once. A defeated entrant remains in that slot until completion and cannot claim an extra activity.

For R rounds, reveal rounds at `80 × round_number / (R + 1)` minutes after start; settle all rewards at minute 80. Private planning jobs compute parent results before child bouts while withholding future winners from public reads. A separate planning job exists for each bout so the bracket can be processed in bounded batches. Results reveal at their scheduled stages; unavailable processing is clearly indicated rather than replaced with invented animation.

Proposed tournament placement bonuses, additional to earned fight renown: winner 100 money / 50 renown; runner-up 60 / 30; semifinal losers 30 / 15; other entrants five renown. A two-player bracket awards only winner and runner-up placements. Byes award no win renown or rating change. Each placement reward has one immutable grant identity.

### 8.3 Seasons

A season lasts exactly 28 real-world days, or 504 activity slots. Its epoch is the first slot boundary chosen when the public launch is activated, persisted once. Assign fights to the season containing their activity start; settle the final slot before closing the season. Recovery processing follows those same historical timestamps.

At season close, freeze league standings, award eligible placements once, archive the summary, and start new ratings at 1,000. Preserve characters, XP, attributes, inventory, money, renown, titles, and cosmetics. Rank by rating, then human wins, then fewer human losses, then stable character identifier.

Proposed reward eligibility: at least five human bouts in that league during the season. A character receives end-of-season progression rewards in their highest league with qualifying participation, preventing duplicate payouts after promotion. Select the top three from that league's eligible-reward subset, not from a list containing characters already assigned to higher-league rewards. Archive full standings in every league and identify promoted/inactive entries. Top rewards are first: 500 money / 100 renown / champion title and gold badge; second: 300 / 60 / silver badge; third: 200 / 40 / bronze badge. Cosmetics persist, with season and league identity. In a league with fewer eligible players, award only existing eligible placements.


## 10. Architecture and module boundaries

### 10.1 Selected deployment model

- **Next.js + TypeScript:** static-exported interface, fixed routes, client-side authenticated data access.
- **Phaser:** browser-only camp, expedition, and combat-replay scenes; sprite animation, depth sorting, camera and pointer handling.
- **Supabase Auth:** Google login and verified user sessions.
- **Supabase PostgreSQL:** durable state, ownership, schedules, jobs, wallets, ratings, listings, and transactions.
- **Supabase Edge Functions:** authenticated commands and deterministic simulation workers.
- **Supabase Cron + pg_net:** scheduled coordination and dispatch of due work.
- **Cloudflare Pages:** static interface, tiles, sprites, fonts, and other public assets.

The static export has no request-time Next.js server actions, server routes, or cookie-dependent server rendering. Use fixed pages and query parameters for profile/replay identifiers; Google callback handling runs in the browser. Client code receives only the Supabase project URL and publishable key. Backend credentials, worker authentication material, seeds, and unrevealed plans remain server-side.

Phaser loads only in a browser client component. A small typed scene/UI bridge communicates selection, view changes, activity updates, and replay requests. It does not grant gameplay permissions. Next.js panels remain independently usable while scenes load, fail, or are disabled.

### 10.2 Responsibilities

| Module | Responsibility | Boundary/dependencies |
| --- | --- | --- |
| Domain rules | Attributes, derived stats, costs, progression, league score, combat, reward calculations | Pure TypeScript; explicit config, snapshots, seeds and timestamps; no React/Phaser/database calls |
| Command API | Creation, schedule/build changes, shop and market operations | Verified user identity, strict schemas, database transactions, idempotency keys |
| Slot coordinator | Historical cutoffs, ordered boundary processing, pairing and job creation | Database state, server clock, durable checkpoint; no frame animation |
| Simulation worker | Expedition encounters, arena bouts, tournament dependency graph | Claimed immutable jobs, domain rules, private plans, guarded completion RPCs |
| Public projection | Minimal camp population, visible activity stages, standings and selected profiles | Safe read models; no wallets, Google data, future plans or private seeds |
| Scene renderer | Camp life, travel, combat log playback, camera and hit testing | Current public/owner data and asset catalog; no progression authority |
| Management UI | Login, forms, comparisons, inventory, schedule, standings and errors | API responses and typed bridge; supports keyboard and touch controls |

Use versioned rule/config snapshots so updates cannot change an in-progress activity. Shared domain code can support previews in the client, but server validation is definitive. Item and enemy definitions are versioned catalog data. Runtime package versions are pinned and lockfiles committed when implementation begins.

### 10.3 Durable model

| Entity family | Important fields/invariants |
| --- | --- |
| Gladiators | Unique account owner and normalized name; class, level, XP, earned/allocated points, stamina, league progression history, processed slot |
| Builds and pending changes | Version, equipment references, stance, allocations, class, effective boundary, fee reservation; one pending draft per character |
| Schedule revisions | Phase choices, expedition IDs, effective timestamps; history sufficient for recovery |
| Wallets and ledger | Non-negative money/renown; unique grant/receipt IDs; transactional balance updates |
| Item instances and catalog | Owner, definition version, immutable tier/rarity/stats, bound flag, equip/listing/reservation state |
| Activity runs | Unique `(gladiator, slot)`; timestamps, snapshot, resolved kind, stamina debit, status, rewards receipt |
| Private simulation jobs | Immutable seed/snapshot, dependency IDs, lease, attempt count, outcome and rules version; future plans kept private |
| Visible events and battle logs | Public reveal timestamp and minimal event payload; bounded replay data linked to its activity |
| Leagues, ratings and seasons | Unique character/league/season rating; counters, season bounds and archived standings |
| Tournaments and bouts | League/slot identity, eligible entries, seeds, byes, parent relationships, reveal times and placement grants |
| Market listings | Unique reserved item, seller, price, expiry, status and terminal purchase receipt |
| World projection and revision | Current safe activity summaries; small revision record; updated transactionally with visible changes |
| Operations receipts | Account-scoped request identity, action/result, reservation/refund history and replay-safe response |

Index due jobs by status/due time, activity uniqueness, item owner/state, open listing filters, character ownership, league/season rating, and event reveal times. Mutating functions enforce ownership and legal state transitions; a client cannot bypass rules through direct table updates.

### 10.4 Authoritative processing and retry handling

Cron coordinates every minute using database time and a single coordinator lease. It creates due work and uses pg_net to dispatch up to five worker invocations when work exists. Worker requests use a server-only credential stored in Vault or backend secrets and checked explicitly; a publishable key alone is not authorization to run workers.

Workers claim tasks with database leases and `SKIP LOCKED`, process bounded batches, and commit with the lease/version they claimed. Proposed batch limits are five combat jobs or 20 simple reward/state jobs per invocation. Time/CPU measurements can reduce these limits without altering game semantics. Expired leases are reclaimable; simulation retries reuse the same seed and snapshot. The job graph separates tournament bouts so no invocation must simulate an entire large bracket.

Planning and settlement are distinct. Outcomes may be computed privately in advance to drive timely stages, but future events and rewards remain hidden. Reveal workers publish only due events; settlement writes the receipt, reward, progression, and terminal activity status atomically. Activity uniqueness plus processed-slot checkpoints protects against replaying old jobs. Commands cannot re-enter completed historical activities.

Normal boundary processing target is completion within two minutes at 50 characters, tested under representative load. A miss produces a visible processing state and recovery alert, not premature success. Three failed attempts retain diagnostic metadata and surface an operator-action state; deterministic errors are fixed before resuming the same snapshot rather than silently deleting an activity.

### 10.5 Reading world state efficiently

Fetch the camp projection on entry. While visible, poll a small revision/server-time record every 30 seconds and fetch changed projection data only when its revision differs. Load character details, inventory, replay logs, and marketplace pages on demand, with pagination. Public stage reveals increment the revision. Pause polling in hidden tabs and refresh on focus. Render movement locally between synchronized timestamps. No per-frame database writes or network broadcasts are needed.

Initial reads are authenticated. Public profiles and current visible events are readable by signed-in players; private management rows are owner-only. An expedition viewer can watch another character's already-revealed travel/encounters through the public projection. Unequipped loot stays private; equipped items and marketplace listings are public. Read authorization enforces `reveal_at <= database time` even if a caller guesses an event ID. The owner cannot read unrevealed plans through an owner-only management query either.

### 10.6 Authentication and database access

Google OAuth requests identity scopes only. Configure authorized origins, Google's Supabase callback, and the app's exact allowed redirect destinations. Keep the Google client secret in backend/provider configuration. Verify sessions server-side for every command and bind the acting character to the verified account; arbitrary client-supplied owner IDs are not authority.

Enable RLS on every exposed table, with owner policies for private reads and explicit authenticated-player policies for safe public projections. Revoke direct mutation privileges for gameplay state. Keep private plans/seeds in an unexposed schema with no client grants. Transactional worker/command RPCs are executable only by the backend role, use security-invoker semantics, and still validate actor ownership and business constraints. Revoke default PUBLIC function execution where appropriate. If views are used, apply security-invoker behavior and verify underlying access; avoid accidental RLS bypass.

Rate-limit creation and command endpoints, validate finite integer inputs and catalog IDs, and escape character names in UI. Account currency and current/future secret state never enter the public world payload. Supabase advisors and negative access tests are release checks.


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
| Duplicate request/job | Return existing receipt/outcome; no repeated grants |
| Backend delayed/unavailable | Show last synchronized state and processing/retry status; recover from durable checkpoints |
| Scene asset/WebGL failure | Keep management panels/results usable; offer reload and a readable activity list |
| Replay expired | Show summarized outcome and rewards; clearly identify that animation is no longer retained |

Persist operational logs for job identity, attempts, duration, CPU measurements where available, and failures, with no tokens or provider secrets. Expose an owner-operated health view/CLI report for overdue jobs, stalled checkpoints, and resource usage; do not add another player-facing admin flow.


