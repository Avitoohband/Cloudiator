# Gladiator Arena — first-release design

Date: 2026-10-11, Asia/Jerusalem

Project directory: `Cloudiator`

Status: Approved by Avi on 2026-10-11, including the explicitly proposed launch defaults. Implementation-plan writing is authorized; implementation follows plan review and execution-method selection.

Review route: section 2 summarizes confirmed decisions; section 3 describes the visible game; sections 5–9 contain proposed gameplay defaults; sections 10–13 cover implementation boundaries and acceptance. The checklist at the end identifies the defaults needing particular attention.

## 1. Intent and decision status

Build a public pixel-art browser game in which players manage one gladiator, arrange a repeating daily schedule, watch a living shared camp, follow expeditions, and compete in automatic arena battles. The intended experience combines idle progression with the pleasure of watching a character live in the world. Returning to the game should reveal understandable progress and offer useful build, schedule, equipment, and market decisions.

Avi wants a long-term public game, an initially simple implementation, a shareable link with Google sign-in and character creation, desktop and mobile browser support, and no recurring infrastructure cost at launch. The first-month planning target is up to 50 active players.

**Confirmed decisions** are recorded in section 2 and in the corresponding behavioral sections. **Proposed defaults** are concrete additions needed to make the game implementable: numbers, initial content, precise timestamps, and operational rules. They are explicitly identified throughout. Approval of the written spec accepts these defaults; they are not presented as earlier user decisions or as playtested balance.

The working document label is Gladiator Arena. A permanent product name is not required for the first implementation. Development should deliver playable increments of this design; marketplace, tournaments, the living camp, and expedition scenes remain part of the intended first public release.

## 2. Confirmed first-release scope

| Area | Agreed behavior |
| --- | --- |
| Access | Public game, English interface, responsive desktop/mobile browsers, Google sign-in only |
| Character | One gladiator per account; initial class selection; class changes and attribute respecs cost game money with no additional cooldown |
| Setting | Colorful fantasy pixel art, weapon-based fighters and fantasy creatures, no spellcasting classes |
| Classes | Berserker, Guardian, Duelist; percentage attribute bonuses; every class can use any weapon |
| Attributes | Strength, Agility, Vitality, Endurance, Precision; Endurance affects stamina capacity and equipment load |
| Clock | Shared four-hour game day; three 80-minute slots: morning, afternoon, evening |
| Schedule | Training, Expedition, Arena, Rest; repeats until changed; upcoming slots editable; current activity finishes as planned |
| Stamina | Activities spend stamina; Rest restores it; insufficient stamina automatically converts the slot to Rest |
| Training | Grants allocatable attribute points |
| Expeditions | Grant XP/levels and loot; levels unlock harder expeditions and better equipment; failure gives no XP or loot, with gear and attributes preserved |
| Arena | Automatic PvP and NPC fights; Offensive, Balanced, Defensive stances; animated replays and combat logs |
| Arena losses | No permanent damage or equipment/attribute loss; spent stamina remains spent |
| Matchmaking | Strength leagues and opponent-adjusted win/loss rating; NPC fallback gives reduced renown and no rating change |
| Tournaments | Opt-in automatic registration; twice per real-world week; single elimination; replace regular Arena in a scheduled Arena slot |
| Tournament edges | At least two eligible entrants; otherwise regular Arena; byes; one stamina charge per slot; full health at each bout |
| Seasons | Four real-world weeks; ratings reset; character progression and currencies remain; top finishers receive progression and prestige rewards |
| Economy | Money buys standard gear and marketplace items; renown buys arena gear/prestige; renown gear is untradable |
| Trading | NPC shops and fixed-price player listings at first release |
| Equipment | Weapon, off-hand, head, body, feet; soft load limit with efficiency and stamina penalties |
| World | Shared movable-camera isometric camp; varied routines, wandering NPCs, ambient interactions, and visible activity changes |
| Expeditions visually | Dedicated isometric scene with automatic travel, exploration, encounters, and follow/free camera |
| Architecture | Next.js + TypeScript static frontend on Cloudflare Pages; Supabase database/Auth/backend; Phaser for animated scenes |
| Integrity | Server-controlled results; atomic purchases; reward retry protection; build changes during activities apply at the next boundary; removing gear cannot move a fighter into weaker leagues |

The character screen is a management layer over the animated world. Watching is optional: the same progression occurs while the browser is closed.

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

## 9. Economy, NPC shops, and marketplace

Money and renown are separate non-negative server-controlled balances. Spending renown does not reduce rating or earned titles. Every credit/debit has a ledger reason and operation identity. Prices use whole positive units; transactions validate balances, item eligibility, ownership, and capacity.

Proposed NPC buy prices: all weapons 40, shield 30, leather hood 20, iron helmet 40, light armor 40, heavy armor 80, light boots 20, and heavy boots 40 money at tier 1. Tier multipliers are 1 / 3 / 6 for level 1 / 5 / 10. The NPC shop sells Common variants. Sell value is 25% of the corresponding Common shop price, further multiplied by rarity, rounded down with a minimum of one. Salvage sells for 10 per unit. NPCs never buy renown-origin gear.

Proposed renown shop: weapon 50, shield 40, head 30, body 50, feet 30 at tier 1; tier multipliers 1 / 2 / 3. Renown gear uses Common tier stats with +10% outgoing arena damage for its weapon, or +10% arena armor for armor/off-hand pieces. The modifier applies in PvP, NPC Arena, and tournaments, not expeditions. A cosmetic banner costs 50 renown. Purchased renown equipment and prestige items are account-bound; class/respec changes do not unbind them.

Fixed-price listings have one seller, item, price, and expiry. Proposed limits: five active listings per account; seven-day expiry; 5% sale fee rounded down. No listing fee; NPC-sale value is shown for comparison. Listings reserve the item, making it unavailable for equipping, NPC sale, or another listing. Equipped or pending-build-reserved items cannot be listed. Owner cancellation or expiry returns the same item. Players cannot purchase their own listing.

Purchase transaction locks the listing, buyer/seller state, and item; verifies open status, money, capacity, and tradability; transfers ownership; debits buyer; credits seller minus fee; writes ledger entries and marks sold. Two buyers cannot both succeed. Retrying a successful purchase returns the original receipt. Listing cancellation and purchase races have exactly one terminal result. Prices and balances are bounded within JavaScript-safe integer values and checked in the database.

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

Public projections are readable by anyone, including visitors who have not signed in. Private reads and all commands require Google sign-in, and the acting character is bound to the verified account. (Amended 2026-10-16 by the [full-screen camp spec](2026-10-14-full-screen-camp-design.md#visitor-access-backend).) Public profiles and current visible events are readable by visitors and signed-in players; private management rows are owner-only. An expedition viewer can watch another character's already-revealed travel/encounters through the public projection. Unequipped loot stays private; equipped items and marketplace listings are public. Read authorization enforces `reveal_at <= database time` even if a caller guesses an event ID. The owner cannot read unrevealed plans through an owner-only management query either.

### 10.6 Authentication and database access

Google OAuth requests identity scopes only. Configure authorized origins, Google's Supabase callback, and the app's exact allowed redirect destinations. Keep the Google client secret in backend/provider configuration. Verify sessions server-side for every command and bind the acting character to the verified account; arbitrary client-supplied owner IDs are not authority.

Enable RLS on every exposed table, with owner policies for private reads and explicit read-only policies for visitors and signed-in players on safe public projections. Revoke direct mutation privileges for gameplay state. Keep private plans/seeds in an unexposed schema with no client grants. Transactional worker/command RPCs are executable only by the backend role, use security-invoker semantics, and still validate actor ownership and business constraints. Revoke default PUBLIC function execution where appropriate. If views are used, apply security-invoker behavior and verify underlying access; avoid accidental RLS bypass.

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

## 12. Hosting, resource budget, and deployment

Current free-plan references, checked 2026-10-11: Supabase includes a 500 MB database, 5 GB egress, and 500,000 monthly Edge Function invocations. Its free tier has no automatic database backups and can pause after inactivity. [Supabase pricing](https://supabase.com/pricing). Hosted Edge Functions have a two-second CPU limit per request, so simulation batching must be measured. [Function limits](https://supabase.com/docs/guides/functions/limits).

Cloudflare documents static Next.js deployment on Pages. [Deployment guide](https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/). Static exports exclude runtime server features. [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports).

Proposed internal budgets: below 250 MB database usage, below 3 GB monthly Supabase egress, and below 300,000 monthly function invocations at the initial expected usage. Measure 50 active players with a representative 30-minute visible session per player/day, and separately test 50 concurrent scene viewers. These budgets are engineering targets, not a guarantee that arbitrary usage fits free plans. Host static art on Pages, load selected scenes lazily, and keep revision reads small.

Retain detailed battle/expedition replay events seven days. Retain activity and financial summaries 90 days, with checkpointed balances and progression. Preserve account state, item ownership, season archives, prestige, and unique settled-slot checkpoints indefinitely. Pruning cannot delete unprocessed jobs, active reservations, or the information required to prevent duplicate grants. Explain retention in the recent-results interface.

Daily cleanup expires listings and prunes safe historical data. Monitor budgets and overdue work; approaching a limit prompts optimization or a decision by Avi rather than an automatic paid upgrade. Weekly operator exports provide a recoverable database copy outside the free service, with a restoration check before launch. Do not treat cron traffic as a guarantee against platform pausing.

Use the free Pages subdomain initially. Production setup requires an available Supabase free project, Cloudflare account/project, source repository, and Google OAuth client configured for the final origins. Create/connect these only in the approved implementation/deployment stage. Local development uses a local database when available and a deterministic fixture mode for the scene/UI; fixture mode must not masquerade as authenticated public persistence.

Deployment must run type checks, meaningful tests, and a static build, then verify real Google login, a persisted character, scheduled processing, and a real transactional trade on the deployed origin. Client build inspection must show no secret credentials. Pin dependencies and record environment variable responsibilities. Keep migrations, rule versions, and static builds compatible with in-progress snapshots during releases.

Before implementation, recheck current Supabase changelog and relevant docs. The markdown changelog could not be fetched by the research browser due to its content-type restriction; use an alternate fetch method or the official HTML changelog then. This is a documentation-access limitation, not evidence that there are no breaking changes.

## 13. Verification and acceptance

The public release is complete when these flows work against the deployed backend and responsive interface:

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
11. Owner/public/other-account/unauthenticated access tests prove that wallet writes, private builds, future plans, seeds and provider data cannot be read or mutated through client APIs. The unauthenticated access tests also prove that public projections are readable and read-only.
12. Desktop and mobile flows support readable controls, touch interaction, keyboard-accessible management, reduced motion, scene load failure, and the defined frame-rate targets.
13. Worst-case simulation batches respect hosted CPU limits; projected database, egress and function usage fit the internal free-plan budgets. Public deployment validates OAuth redirects and real scheduled jobs.

Use a testable injected clock and deterministic seeds for domain/time tests, database integration tests for transactions/RLS, and browser tests for the critical user journey and scene/UI bridge. Do not wait 80 real minutes for every automated test; exercise accelerated test clocks plus one real deployed boundary check. Art and animation need visual inspection in addition to code tests. Record actual results during implementation; this spec does not claim those tests have run.

## 14. Delivery boundaries

Implement in vertical increments: identity/character/schedule persistence; authoritative activities and inventory; visible living camp and expedition stages; arena/rating/replays; shops/marketplace; tournaments/seasons; release verification. The written implementation plan will turn these into executable tasks with checks and dependencies.

All agreed systems remain in the intended public release. Real-time manual combat, spellcasting classes, auctions, signature class abilities, and dual wielding are outside this initial design. Adding them requires a subsequent design change. Balancing can change configuration values after simulation/playtests, while changes to rewards or rules retain activity-version integrity.

### Proposed defaults to review closely

- UTC phase alignment and Wednesday/Saturday 17:20 UTC tournaments.
- Initial attribute budget, starter equipment, money, default schedule, and fees.
- Class percentages, stamina/load formulas, combat formulas, and reward amounts.
- Three expedition environments and their timed encounter presentation.
- Initial item templates, tiers, rarity, inventory capacity, market fee and listing limits.
- League thresholds, rating formula, seasonal qualification and reward amounts.
- Public character/expedition visibility and private inventory/wallet boundaries.
- Camera controls, ambient NPC budget, performance targets, and replay retention.

These are reviewable recommendations, not silently assumed user preferences. After written-spec approval, the next artifact is the implementation plan; product code, dependency installation, external project creation, and production asset work follow only after that plan is reviewed and its execution method selected.

## 15. Primary technical references

- [Phaser Next.js integration template](https://github.com/phaserjs/template-nextjs)
- [Phaser camera concepts](https://docs.phaser.io/phaser/concepts/cameras)
- [Phaser isometric tilemap support](https://docs.phaser.io/api-documentation/function/tilemaps)
- [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase Google authentication](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase function limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase pricing](https://supabase.com/pricing)
- [Cloudflare static Next.js deployment](https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports)
