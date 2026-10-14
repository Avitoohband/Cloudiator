# Task 19 brief base: binding plan and spec text, plus reviewed producer notes

Copied verbatim from the brief Codex prepared (2026-10-14). The plan and spec text is binding. The "Controller preparation context" and the "not dispatch" note are Codex-era context: `task-19-claude-dispatch.md` replaces them where they differ (Avi moved Task 19 to Claude on 2026-10-14), but their reviewed producer facts remain authoritative.

## Task 19: Tournament eligibility, bounded bout graph, and rewards

**Files:** Create `supabase/functions/_shared/domain/tournament.ts`, `supabase/sql/09-tournaments-seasons.sql` (tournament portion), `tests/domain/tournament.test.ts`, `tests/db/tournaments.test.ts`; extend boundary/jobs/commands/projections; generate `M09a`.

**Interfaces:** Consumes frozen league entrants, regular matcher, combat and rating. Produces `isTournamentSlot(slot: SlotWindow): boolean`, `buildBracket(entries: ArenaEntrant[], seed: Seed): TournamentGraph`, `readyBouts(graph: TournamentGraph): BoutJob[]`, `placementGrants(graph: TournamentGraph): RewardGrant[]`. Graph stores stable bout/parent IDs, byes, frozen entry snapshots, reveal times and private results. SQL `set_tournament_opt_in(actor_id, operation_id, input jsonb)` returns receipt; graph completion is fenced through job RPCs.

- [ ] **Step 1:** Test the approved participant counts and debit invariants.
  ```ts
  for (const n of [0,1,2,3,5,50]) {
    const run = await tournamentHarness.run(n);
    expect(run.chargesPerParticipant).toEqual(Array(n).fill(1));
    expect(run.bracketWinners).toBe(n >= 2 ? 1 : 0);
    expect(run.ratedBouts).toBe(n >= 2 ? n - 1 : 0);
    expect(run.byeRenown).toBe(0);
  }
  ```
- [ ] **Step 2:** Run tournament unit/DB suites; expect absent eligibility/bracket processing.
- [ ] **Step 3:** Partition cutoff-eligible opted-in Arena entrants with sufficient stamina per league. At Wed/Sat17:20UTC create seeded single-elimination power-of-two brackets with byes only when≥2; otherwise put those entrants into regular Arena exactly once. One stamina debit for the slot; frozen builds and fullHP each bout; separate parent-dependent job per bout and round-ordered rating updates. Reveal round `r` at80×r/(R+1)minutes; minute80 settles bout renown plus exact placement money/renown once. Byes do not grant wins. Elimination never opens another activity in the same slot.
- [ ] **Step 4:** Run eligibility cutoff±1ms, opt-out/insufficientstamina, 0/1/2/3/5/50 entrants in each league, bye paths, stalled child job, lease retry, fullHP per bout, placement counts/amounts and frozen-build tests. A two-person run has one bout and only winner/runner-up placement awards.
- [ ] **Step 5:** Stage named files plus `M09a`; commit `feat: run automatic league tournaments`.


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


## 4. Time, schedules, and activity lifecycle

### 4.1 Authoritative clock

Use server UTC timestamps. The world day starts at UTC hours 00:00, 04:00, 08:00, 12:00, 16:00, and 20:00. Each game's morning lasts 80 minutes, followed by 80-minute afternoon and evening slots. This UTC alignment is a proposed default; local timezone display does not change world timing.

Define `slot_index = floor(UTC epoch milliseconds / 4,800,000)` and `phase = slot_index mod 3`. Persist timestamps and slot identifiers; a device clock cannot determine eligibility or completion. The client estimates the server time offset for smooth countdowns and corrects it after synchronization.

At every boundary, in order:

1. Finish and settle the previous slot, including its rating changes and rewards.
2. Close an ending season after all of its final-slot results have settled.
3. Apply pending build changes and schedule edits eligible for the new boundary.
4. Recompute derived stats and league eligibility.
5. Snapshot the new slot's schedule, character builds, participation flags, and starting resources.
6. Check stamina, replacing unaffordable activities with Rest.
7. Pair regular Arena entrants or create the scheduled tournament bracket.
8. Deduct activity stamina once, prepare simulation jobs, and publish the new current-activity state.

All participants for a slot use a common cutoff. A worker delay does not allow a late edit into a slot that has already started. New characters created after that cutoff participate next slot.

### 4.2 Editing and pending builds

The schedule has one entry for each named phase and repeats every game day. Expedition entries include the chosen unlocked expedition. Editing a phase affects its next occurrence whose start is still in the future. If morning has started, changing morning affects the next game's morning; changing an unstarted afternoon affects today's afternoon and future afternoons.

Equipment, attribute allocation, stance, class, and respec changes made during an activity are queued as a pending build for the next slot boundary. The current build snapshot and activity continue. The UI shows Current and Pending values with an effective time. Players can revise or cancel a pending build.

**Proposed fees:** class change costs 100 money; respec costs 100 money; combining them costs 200. Allocating previously unspent points is free. A respec fee is required when any already-allocated attribute decreases. Fees are reserved transactionally when queued, applied once when the change takes effect, and refunded if canceled. Pending equipment is reserved against sale/listing. Newly earned training points remain unspent unless explicitly allocated; replacing a pending request cannot duplicate points, fees, or refunds.

Changing Endurance preserves absolute current stamina, clamping it to a reduced maximum if needed. Raising capacity does not refill stamina. Class or gear changes do not create activity rewards or restore expedition health.

### 4.3 Offline behavior and processing delays

The repeating schedule continues while the player is offline, until changed. There is no login-based earnings cap in this proposed release. The server normally advances slots continuously; returning players receive summaries of completed activities.

If processing is delayed or temporarily unavailable, jobs catch up in chronological slot order from saved state, preserving historical schedule revisions, item ownership changes, and season assignment. Catch-up is bounded per worker invocation and continues across invocations. It never applies a new edit retroactively or awards the same slot twice. Until catch-up reaches the current boundary, dependent mutation requests return a processing/retry state, preventing purchases or build edits against stale balances.

Show Scheduled / Preparing / In progress / Processing results / Completed states with clear timestamps. Result publication may lag the nominal boundary; the progress bar alone never proves a reward has been credited. A persistent checkpoint supports recovery after a hosting pause or outage. Replay retention may expire older animations, but progression and summarized outcomes remain correct.


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


## Controller preparation context
Not dispatched. Before dispatch reconcile actual reviewed prerequisite reports/interfaces, fixed BASE, dependency/ownership readiness and exact account availability. Current root branch codex/gladiator-arena; user selected current folder. Avi authorized detailed commits/pushes of every completed task; controller owns fresh review, HANDOFF.md and reviewed checkpoint push. Write full report both ignored scratch task-19-report.md and tracked docs/implementation/task-19-report.md. No helper/reviewer subagents, no direct push, no unrelated staging. Follow TDD/verification and all applicable skills. Never fabricate hosted/physical-device evidence from fixtures.
Claude owns Tasks11/12/14/15 in separate registered worktree/branch, reserved assets/source/** public/assets/** tests/assets/** src/game/** BattleReplay.tsx ExpeditionView.tsx and exact scene/replay browser/domain tests. Shared config/routes/gateway/fixture changes require owning-agent exact REQUEST. Any src/game/** modification in a later task needs explicit coordinated ownership before dispatch. UI13/17/20 and release23/24 are not yet assigned between Codex/Claude.
Canonical DTO/domain interfaces come from clean preceding tasks. Player allocation/count/currency inputs finite safe integers; item roll/effective attribute values allow hundredths; arena armor and damage modifier intermediates preserve further precision until the prescribed final damage rounding. No duplicate formulas/private future information in public/read models.
Cloudiator hosted project/Cloudflare/OAuth currently unprovisioned. Never change unrelated inactive Supabase projects; local DB tests must guard local-only resets. CLI discovery/current official docs before Supabase operations, generated timestamp migrations only by documentedCLI. Backend-only RPC security-invoker explicit grants and owner-read RLS are binding. No secrets in output/commits. Preserve preview session50338 port3000.

## Producer reconciliation — prepared 2026-10-14, not dispatch
Task9 reviewedpublished62f24cc, immutableM06newgraphprimitives: private.job_dependencies enforce prerequisites in claim_jobs/dispatch; chainedreveals/settlement dependencyfencing, immutableprivateplans and explicitdue publicactivity_stages. Reuse actualjob runner/retainedrules executors/bounded5simulation20simple/maxCPU2s, noentiretournament onejob. complete_job/renew_job now lockfirst sampleplanning_now_ms(clock_timestamp helper), verifycurrenttoken/status/expiry; authoritativerenewedexpiresAt consumedworker. Never resurrectstale/stolen/exhaustedjobs, existingcompletedtoken receipt replay separatefromnewwrite. Preservecommonlocks/exhaustedsweepexception and M06safe_settlement nestedfinitewhitelist/rollback. Everybout currenttoken checked underlock before publishingprivate result/revealedlog.
Canonical winnerId includesseededsimultaneouszeroHPwinner; fullhealth resets eachtournamentbout, no extra HP>0 victory condition. Task16 regularArena pairing/league/rating implementation and Task10safeprojections stillrequiredreviewed dependencies; reportactualhookinterfaces beforedispatch. Public tournamententrants/bracketshape atstart approved, futureopponent snapshots/results cannotleak. OwnerActivitySummary rewards/receipt/overflow private; Task10PublicActivitySummary completion safe sixfields, publicResultRow narrowed. TournamentView.placements summary currentlyfullowner type: reconcile role-safe DTO whenimplementationready, explicitprivacy projection not spread.
AviauthorizedfixedWednesdaySaturday17:20UTC (UTC slot math80min; DSTonlydisplay); no fabricatedNPC entrants/byerating. 0/1 fallback regularArena sameactivity/staminacharge; dependency graph stable acrossretries androundratingserialization. No second grantguardparallel withM06. ActualM09a aliasobsoleteaftertask10/16/18 migrations; CLIgeneratenewimmutableversion. Codexowns19;Claude20 UI awaitsreviewed19wire, sendminimalexactcontractnotifications beforeedits.
