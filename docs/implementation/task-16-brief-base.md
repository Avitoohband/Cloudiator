# Task 16 brief base: binding plan and spec text, plus reviewed producer notes

Copied verbatim from the brief Codex prepared (2026-10-14). The plan and spec text is binding. The "Controller preparation context" and "not dispatch-ready" notes at the end are Codex-era context: `task-16-claude-dispatch.md` replaces them where they differ, but their reviewed producer facts (Tasks 7-10) remain authoritative.

## Task 16: League placement, regular Arena pairing, and rating settlement

**Files:** Create `supabase/functions/_shared/domain/arena.ts`, `supabase/sql/07-arena.sql`, `tests/domain/arena.test.ts`, `tests/db/arena.test.ts`; extend jobs, projections and catalog registry; generate `M07`.

**Interfaces:** Consumes frozen fighters, historical gear strength and earned points. Produces `leagueFor(level: number, earnedPoints: number, gearHistory: number): LeagueId`, `estimateArenaStrength(fighter: FighterSnapshot): number`, `matchArena(entrants: ArenaEntrant[], recent: PairingHistory[], seed: Seed): ArenaAssignment[]`, `makeFallback(fighter: FighterSnapshot): FighterSnapshot`, `ratingDelta(winnerRating: number, loserRating: number): RatingDelta`. `LeagueId` is bronze/silver/gold/champion; assignments reference frozen builds and one season/league/slot.

- [ ] **Step 1:** Test pairing and monotonic placement.
  ```ts
  expect(leagueFor(1, 10, 0)).toBe('bronze');
  expect(leagueFor(5, 25, 100)).toBe('silver');
  expect(matchArena(twoEntrantsWithStrengthRatio(2.01), [], 's').every(a => a.kind === 'npc')).toBe(true);
  expect(ratingDelta(1000, 1000)).toEqual({ winner: 12, loser: -12 });
  expect(await db.settleNpcWin()).toMatchObject({ renown: 3, ratingDelta: 0 });
  ```
- [ ] **Step 2:** Run Arena unit and DB suites; expect missing matchmaking/rating lifecycle.
- [ ] **Step 3:** Implement exact progression thresholds, banked-point inclusion, acquisition-based legal-loadout history and promotion at boundaries. Pair within league by spec sort/ties, preceding 18-slot pairing counts, and max2× strength. Prepare one frozen regular bout; reveal minute60 and settle minute80 with human win/loss renown10/2, NPC3/0, no XP/money. Fallback mirrors effective stats/armor/interval, Balanced stance, 85% maxHP/pre-stance damage, overload once. Apply Elo K24 with floor0 and distinct league/season records starting1000. Expose warm-up without training reward.
- [ ] **Step 4:** Run suites for no entrants/one/odd count/50, exact2× boundary, repeat pairing ties, sold/unequipped/renown gear, respec/banked points, bound modifiers, simultaneous settlement retry, and no cross-league match. Verify a weak current loadout stays in its historical league.
- [ ] **Step 5:** Stage named files plus `M07`; commit `feat: add league-aware Arena battles and ratings`.


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


## 5. Attributes, classes, and equipment

All numeric rules in this section are **proposed launch balance**, held in versioned configuration and tested before public release.

| Attribute | Primary effect |
| --- | --- |
| Strength | Damage with every weapon |
| Agility | Attack timing and opponent hit probability |
| Vitality | Maximum combat health |
| Endurance | Maximum stamina and effective equipment load capacity |
| Precision | Hit probability and critical-hit probability |

Base attributes are five plus allocated training points. Effective attributes include class and equipped item bonuses. Keep two-decimal fixed-point values so small percentage bonuses remain meaningful; round final health, stamina, and damage at their defined application point.

| Class | Proposed bonus |
| --- | --- |
| Berserker | +10% Strength |
| Guardian | +5% Vitality and +5% Endurance |
| Duelist | +5% Agility and +5% Precision |

There are no signature class abilities at launch. Bonuses follow the current class. Class changes preserve level, earned points, gear, currencies, and rating.

### 5.1 Derived resources and load

- Maximum health: `floor(50 + 10 × effective Vitality)`.
- Maximum stamina: `floor(90 + 2 × effective Endurance)`.
- Equipment load capacity: `10 + 2 × effective Endurance` weight units.
- Only equipped weapon, off-hand, head, body, and feet contribute to combat load. Inventory is limited by slots, not an additional carrying-weight simulation.
- Overload ratio: `max(0, (equipped weight − capacity) / capacity)`.
- Combat efficiency: `max(0.5, 1 − 0.5 × overload ratio)`; apply to outgoing damage and attack rate.
- Activity stamina cost: `ceil(base cost × (1 + overload ratio))` for Training, Expedition, and Arena.

Heavy equipment can always be equipped if owned and level-eligible; the preview explains overload penalties. Heavy armor retains its armor benefit, making the tradeoff observable. Rest has no stamina cost and restores stamina to the current maximum at slot completion.

### 5.2 Initial item content

Proposed base catalog:

| Template | Slot | Damage / armor | Weight | Base attack interval |
| --- | --- | --- | --- | --- |
| Sword | Weapon, one hand | 6 damage | 4 | 1,000 ms |
| Axe | Weapon, one hand | 8 damage | 6 | 1,400 ms |
| Spear | Weapon, two hands | 7 damage | 6 | 1,200 ms |
| Bow | Weapon, two hands | 6 damage | 3 | 1,100 ms |
| Round shield | Off-hand | 3 armor | 5 | — |
| Leather hood | Head | 1 armor | 1 | — |
| Iron helmet | Head | 3 armor | 4 | — |
| Light armor | Body | 2 armor | 3 | — |
| Heavy armor | Body | 6 armor | 10 | — |
| Light boots | Feet | 1 armor | 1 | — |
| Heavy boots | Feet | 2 armor | 4 | — |

Two-handed weapons occupy weapon and off-hand capacity; equipping one queues removal of the shield. Dual wielding is outside the initial catalog. Every class can equip all listed categories.

Create level-1, level-5, and level-10 tiers, multiplying base damage/armor by 1, 1.5, and 2 respectively. Common, Uncommon, and Rare variants further multiply damage/armor by 1, 1.15, and 1.3. Weight remains attached to the template. Items have a level requirement, immutable rolled stats, origin, owner, and tradability flag. No durability loss or random affixes at launch.

Proposed inventory capacity is 60 slots, including equipped and marketplace-reserved items. Salvage stacks to 999 units per slot. Overflow expedition rewards are automatically sold at NPC sell value, with the conversion reported. Purchases are rejected if capacity is insufficient. Renown purchases cannot be silently converted to money.

Owners can discard unequipped, unreserved items after confirmation, including bound gear, receiving no money or renown. Discarding never reduces historical league strength. This provides a way to clear bound items from a full inventory.


## 6. Activities and progression

| Activity | Proposed base stamina | Completion result |
| --- | --- | --- |
| Training | 20 | One allocatable attribute point |
| Expedition | 30 | Success rewards from its table; failure gives no XP, money, or loot |
| Regular Arena | 25 | One fight, its renown result, and rating change for human opponents |
| Tournament Arena | 25 | Whole bracket participation; one cost, irrespective of number of bouts |
| Rest | 0 | Restore stamina to maximum |

Training variants are visual choices, not different attribute-point yields. XP comes from successful expeditions. The next level costs `100 × current level` XP; consume that XP and advance repeatedly if a reward crosses multiple levels. Level-ups unlock content and do not grant attribute points or free stamina.

Proposed expedition catalog:

| Expedition | Required level | Encounters | Success XP | Money | Loot |
| --- | --- | --- | --- | --- | --- |
| Woodland Path | 1 | Three wild beasts | 100 | 20 | One salvage stack; 20% gear chance, tier 1 |
| Ruined Outpost | 5 | Three armed raiders | 250 | 60 | One salvage stack; 30% gear chance, tier 5 |
| Mountain Pass | 10 | Three dangerous creatures | 500 | 120 | One salvage stack; 40% gear chance, tier 10 |

Salvage quantities are 1, 2, and 3 respectively, with an NPC sell value of 10 each. Gear rolls use 70% Common, 25% Uncommon, and 5% Rare. Enemy baseline health/damage/intervals are 35/6/1,100 ms, 80/12/1,100 ms, and 140/18/1,000 ms; effective enemy attribute vectors are `(4,4,3,4,4)`, `(12,10,8,10,10)`, and `(20,16,14,16,16)` in Strength/Agility/Vitality/Endurance/Precision order. Enemies use Balanced stance and no equipment armor. Enemy health and damage use these explicit encounter-template baselines instead of player derivation rules. Difficulty and rewards are starting proposals, not asserted to be balanced.

The activity snapshot locks equipment, attributes, stance, enemy templates, seed, and rules version. Gear purchased or points earned during an activity do not alter that expedition's existing plan.


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
Not dispatched. Before dispatch reconcile actual reviewed prerequisite reports/interfaces, fixed BASE, dependency/ownership readiness and exact account availability. Current root branch codex/gladiator-arena; user selected current folder. Avi authorized detailed commits/pushes of every completed task; controller owns fresh review, HANDOFF.md and reviewed checkpoint push. Write full report both ignored scratch task-16-report.md and tracked docs/implementation/task-16-report.md. No helper/reviewer subagents, no direct push, no unrelated staging. Follow TDD/verification and all applicable skills. Never fabricate hosted/physical-device evidence from fixtures.
Claude owns Tasks11/12/14/15 in separate registered worktree/branch, reserved assets/source/** public/assets/** tests/assets/** src/game/** BattleReplay.tsx ExpeditionView.tsx and exact scene/replay browser/domain tests. Shared config/routes/gateway/fixture changes require owning-agent exact REQUEST. Any src/game/** modification in a later task needs explicit coordinated ownership before dispatch. UI13/17/20 and release23/24 are not yet assigned between Codex/Claude.
Canonical DTO/domain interfaces come from clean preceding tasks. Player allocation/count/currency inputs finite safe integers; item roll/effective attribute values allow hundredths; arena armor and damage modifier intermediates preserve further precision until the prescribed final damage rounding. No duplicate formulas/private future information in public/read models.
Cloudiator hosted project/Cloudflare/OAuth currently unprovisioned. Never change unrelated inactive Supabase projects; local DB tests must guard local-only resets. CLI discovery/current official docs before Supabase operations, generated timestamp migrations only by documentedCLI. Backend-only RPC security-invoker explicit grants and owner-read RLS are binding. No secrets in output/commits. Preserve preview session50338 port3000.

## Boundary integration prerequisite note (not dispatch-ready)

Task7 owns the ordered coordinator and private fenced preparation phase. Its current task deliberately derives canonical stats without inventing a league formula; it retains existing league/history and freezes level/earned-points/gear-history inputs. This Task16 owns leagueFor and promotion, so integrate the actual reviewed phase4 league recompute hook before snapshot/pairing. Obtain its exact interface from task-07-report.md after that review gate; do not assume it yet. Task8 supplies acquisition-based historicalGearScore. Preserve the global cohort cutoff and historical snapshots when promoting; weak current equipment cannot lower historical placement.

Task6 producer is reviewed at ec6939386e7fd0e2f997d0389238bce4d068cc64. M01/M02 are immutable. Pending activation uses private.apply_pending_build after prior settlement and season closing, before stat/league recomputation; monotonic OwnerState.buildVersion is distinct from currentBuild.version. Common actor mutations use account advisory lock then character and sorted dependent rows. Preserve this order in future Arena settlement operations and worker fencing.

## Reviewed Task7 concrete hook interfaces

Published a04484cb774db5d4ae26029949de4e760029f881 contains reviewed Task7 including its Important exhausted-lease fix and immutable M04. Read task-07-report.md and task-07-review.md; do not reimplement its coordinator. Exact phase4 hook: private.boundary_recompute_leagues(bigint) returns text or null after preparation; private.boundary_pair(bigint) runs after affordability and before debit/publish. Job extension hooks are private.activity_executor_ready(text), private.prepare_activity_jobs(uuid), private.accept_job_result(uuid,jsonb), private.settle_rewards(uuid). Existing settlement outcome shape is {rewards, result, success, replayExpiry, ratingDelta?}; Task9 must first integrate its explicit whitelist/nested validation gate. Preserve that reviewed integration when extending Arena outcomes. The snapshot seed is copied onto jobs; current unexpired token is mandatory; completion is terminal. Unknown rules versions fail closed and older registry executors remain available.

Task8/9/10 are currently Claude-owned and their actual reports/interfaces are not yet available. This brief is still NOT dispatch-ready: record their reviewed checkpoints, ownership ACK and actual BASE before implementation. Root must not start a duplicate backend executor while Claude owns those dependencies.

## Reconciled reviewed producer notes — prepared 2026-10-14, still NOT dispatch

Supersedes stale Claude backend ownership above: Codex owns16/18/19/21/22/23/24 and integration; Claude owns13/15/17/20 and Task14 Minors, separate checkout. Tasks1–9/11/12/14 complete. Task10 ACTIVE, actual checkpoint/API before16 dispatch required. Immutable M01–M06 at reviewedpublished62f24cc; Task10 will generateM07, so16's originalM07 alias is obsolete: use new CLI-generated migration after10, never edit committedones. Task7 boundary hooks stillactual; read9report for extensions/canonicalsettlement.

Task8 historicalGearScore is highest legal equipment-only loadout from all owned acquisitions; legacy peakStrength is that gear score only, not full league index. Includes boundrenowngear, excludes cosmetics/salvage, respects twohand/shield exclusion. Startergear history28. Purchases/expedition grants updatehistory withoutmutating active frozen snapshots; selling/discard/unequipping cannot reducehistory. Task16 owns exact league thresholdformula and boundary promotion after priorsettlement/buildactivation/preparation. Include banked earnedpoints, do not use allocatedsum or currentgear weakness for placement.

Task9 private job_dependencies already handles chainedsimulation/reveal/settlement claims/dispatch; reuse boundedgraph, notsecond parallelrunner. Postlockclock/time/token/status fencing in complete_job/renew_job and settle_activity_core, preserved commonaccount/char/wallet/sorteditems/activity/job order; old exhaustedsweep exception explicitsourceheader. current authoritative renewalexpiresAt consumedworker. Immutable public.activity_stages onlydue sanitizedlogs; privateplan/results remain inaccessible evenowner. Backend summary whitelist includesnestedfinite rewards/rating/expiry/owneroverflow and malformedhook rollback; preservewhenArena hooksadded. Matching completedtoken receiptsreplay no grants despiteexpiry, new writes requirevalid currentlease.

Canonical winnerId decides wins including simultaneous0HP; Task9 fixed use of HP>0 and actualseedregressions. Arena no lastinginjury/newHPthresholdrules. NPCfallback baseline must avoid doubleclass/damage/overload modifiers. Boundarena equipmentmodifier intermediates preserveprecision until finaldamagerounding (armor6.65×1.1=7.315 regression). Do not reimplementcombat/formulas.

Task10 approvedcontractreconciliation: additive PublicActivitySummary six safe fields activityId/resolvedKind/result/success/settledAtMs/replayExpiry, timeline.completion publicsafe; existingtimeline.summary owner-onlyrewards/receipt/ratingDelta. ResultsPage summarysafepublic. Before16 dispatch reconcile actual10 projector/revisionhooks and publicresultauthorizations fromreviewedreport. ratingsstandings public but privatewallet/loot not. Claude15/newfixedexpeditionroute/scanner5throute integration pending; don'teditreservedscene/UI/sharedfiles. No physical/hostedproof inferredfromlocals.
