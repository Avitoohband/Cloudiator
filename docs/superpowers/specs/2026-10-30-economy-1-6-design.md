# Patch 1.6: the economy rebalance (design)

Date: 2026-10-30. Author: Claude. Status: **decided by Avi through question forms** (2026-10-29/30) on the
[economy proposal](../../../.superpowers/design/2026-10-29-economy/proposal.md) (local, ignored by git; this spec carries
everything an implementer needs). Plan: [2026-10-30-economy-1-6.md](../plans/2026-10-30-economy-1-6.md).

Decisions are marked **Avi** (his answers in the question forms) or **Claude's call** (made while writing this spec; Avi can
overrule any of them). Numbers come from a scratch slot model (18 slots a day, 100 stamina, every expedition won at the
best safe stage: Woodland at levels 1–4, Outpost at 5–11, Mountain from 12), the proposal's model re-run on 2026-10-30 for
Avi's harsher option. It reproduces the proposal's v1 table exactly. No production data was read.

## Intent

Gold and levels come about four times too easily for the prizes: a typical player earns about 320 gold a day, so a
tournament win (100) is worth a third of a day, and points run away from levels (a week of Training at level 1 gives 94
points). Patch 1.6 makes progress harsher and prizes meaningful, and nothing else. It is the first change of rules
version: `v2` starts at one operator switch, and everything frozen before it settles on `v1`.

## Goals

1. **Harsher progression (Avi).** Level 10 in about 20 days on a Training / Expedition / Arena day: expedition XP is 0.3×
   today's, and expedition gold is cut to less than a quarter.
2. **Prizes by league (Avi).** A tournament win pays 40 / 60 / 80 / 100 gold in Bronze / Silver / Gold / Champion, and the
   other places scale the same way. Season gold prizes scale by league too and never exceed today's.
3. **A Training cap (Avi).** Training gives a point only while the gladiator has fewer than 10 + 4 × level points. At the
   cap it gives nothing, and the Schedule says so.
4. **Salvage sells for 4 gold, not 10 (Avi),** after a day's warning in a game message posted before the release.
5. **Live players (Avi):** everyone's gold is cut to a quarter when 1.6 ships; levels, items and renown stay; season 1 pays
   its promised prizes.
6. **The Arena banner is shown** (Claude's call, see "The Arena banner").
7. Old activities are never paid on new rules: whatever was frozen under `v1` settles under `v1`.

## Non-goals

- **Later patches only, not in 1.6:** party dungeons and the bot team (patch **1.8**, on v2 rewards from the start); the
  renown skins shop with dyes for clothes and weapons (**1.7 or 1.8**); new gear and attribute requirements (**a later
  patch**); the Deep, the weekly solo delve (**after the dungeons**).
- Item prices, NPC gear sale values, market fees, Arena renown, the XP curve (100 × level a level), stamina, leagues and the
  catalog do not change. Gold a player keeps buys exactly what it bought before (apart from the quarter cut).
- No respec or class change (still locked), no new currency, no change to open market listings or their prices.
- No conversion of points above the cap: they are kept (only new Training stops).
- The Schedule's expedition lines keep their wording (they name no amounts today).

## Avi's decisions and Claude's calls

| Decision | Who |
| --- | --- |
| Harsher: XP × 0.3, level 10 in about 20 days; expedition gold cut to less than a quarter | Avi |
| Tournament gold 40 / 60 / 80 / 100 for a win by league, other places scaled the same way | Avi |
| Season gold prizes by league, never above today's | Avi |
| Everyone's gold cut to a quarter at 1.6; levels, items, renown stay; season 1 pays its promised prizes | Avi |
| Training cap 10 + 4 × level; at the cap Training gives nothing and the Schedule says so | Avi |
| Salvage 10 → 4 gold, with a game message a day before | Avi |
| 1.6 is the economy alone; dungeons and the bot team move to 1.7, then 1.8 when titles took 1.7 (Avi, 2026-10-30) | Avi |
| Item prices stay | Avi |
| Expedition gold **4 / 10 / 18** (Woodland / Outpost / Mountain) | Claude's call (within Avi's "less than a quarter") |
| "Scaled the same way" read literally: factors 0.4 / 0.6 / 0.8 / 1.0 on today's gold, for tournaments and seasons alike | Claude's call |
| Renown prizes unchanged in every league (renown has nothing new to buy until the skins shop) | Claude's call |
| Gear drop chance halved to 10 / 15 / 20 %, as the proposal's v2 table had it (Avi's answers left that row as proposed) | Claude's call, **Avi to confirm** |
| `RULES_V2`, keyed by the boundary that froze each activity; an operator switch with Avi's go starts it | Claude's call |
| The cut is part of that one owner-only switch function, idempotent and audited, not a migration data step | Claude's call |
| The cut rounds up (a quarter of 3 gold is 1) and never touches gold held for a queued fee | Claude's call |
| A season pays the prizes of the rules version that opened it (season 1: today's) | Claude's call |
| The Arena banner is shown on the profile card, not removed with a refund | Claude's call (recommended) |
| The day-ahead message tells players about the gold cut as well as salvage | Claude's call, **Avi to confirm** |

## The numbers

### What changes (`RULES_V1` → `RULES_V2`)

| Rule | Today (v1) | 1.6 (v2) |
| --- | --- | --- |
| Expedition XP (Woodland Path / Ruined Outpost / Mountain Pass) | 100 / 250 / 500 | **30 / 75 / 150** (× 0.3) |
| Expedition gold | 20 / 60 / 120 | **4 / 10 / 18** (20 %, 17 %, 15 %) |
| Salvage a run | 1 / 2 / 3 | unchanged |
| Salvage sold to an NPC (and an overflowing unit's value) | 10 gold | **4 gold** |
| Gear drop chance | 20 / 30 / 40 % | **10 / 15 / 20 %** (Avi to confirm) |
| Training | 1 point, no limit | 1 point while earned points < **10 + 4 × level**, else 0 |
| Tournament and season gold | the same in every league | **by league** (tables below) |
| Tournament and season renown | 50 / 30 / 15 / 5 and 100 / 60 / 40 | unchanged |
| Prices, NPC gear values, fees, Arena renown, XP curve, stamina, leagues, catalog | | unchanged |

"Earned points" are every attribute point the gladiator has, the 10 from creation included (`earnedAttributePoints`).

| Level | 1 | 2 | 5 | 10 | 12 | 15 | 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Training cap (10 + 4 × level) | 14 | 18 | 30 | 50 | 58 | 70 | 90 |

### A day's expedition income (Training / Expedition / Arena: 4 expeditions a day)

| Stage | XP today → 1.6 | Gold (cash + salvage) today → 1.6 | Gear drops sold, expected |
| --- | --- | --- | --- |
| Woodland Path (levels 1–4) | 400 → **120** | 120 → **32** (16 + 16) | 8 → 4 |
| Ruined Outpost (5–11) | 1,000 → **300** | 320 → **72** (40 + 32) | 37 → 18 |
| Mountain Pass (12+) | 2,000 → **600** | 600 → **120** (72 + 48) | 99 → 49 |

A focused Training / Expedition / Expedition day (8 expeditions) earns twice the XP and gold.

### Milestones (days from creation; no gear drops, no market; 100 starting gold)

| Milestone | Today T/E/A | **1.6 T/E/A** | Today T/E/E | 1.6 T/E/E |
| --- | --- | --- | --- | --- |
| Level 5 (Outpost, tier 5) | 2.4 | **8.4** | 1.2 | 4.2 |
| **Level 10** (tier 10) | 5.9 | **20.1** | 2.9 | **10.1** |
| Level 12 | 8.1 | 27.1 | 4.1 | 13.6 |
| Level 15 | 10.1 | 33.6 | 5.1 | 16.8 |
| Standard tier-5 kit (510 gold) | 2.9 | 10.4 | 1.4 | 5.2 |
| Standard tier-10 kit (1,020 more) | 6.1 | 24.6 | 3.1 | 12.3 |
| Points at level 10 | 35 | 46 (cap 50) | 28 | 46 (cap 50) |

The first item of a tier is still bought on the day its level arrives; a full tier-10 kit follows about 4½ days later.
With the cap, about 6 in 10 trainings of a T/E/A day give nothing from level 3 on: the Schedule's line tells the player,
who can plan an expedition instead.

### Tournament placements (gold / renown)

| Place | Bronze | Silver | Gold | Champion | Today (every league) |
| --- | --- | --- | --- | --- | --- |
| Winner | **40** / 50 | **60** / 50 | **80** / 50 | 100 / 50 | 100 / 50 |
| Runner-up | **24** / 30 | **36** / 30 | **48** / 30 | 60 / 30 | 60 / 30 |
| Semifinal | **12** / 15 | **18** / 15 | **24** / 15 | 30 / 15 | 30 / 15 |
| Others | 0 / 5 | 0 / 5 | 0 / 5 | 0 / 5 | 0 / 5 |

Fight renown (10 a won bout, 2 a lost one) is unchanged. The league is the bracket's.

### Season prizes (gold / renown; titles and badges unchanged)

| Place | Bronze | Silver | Gold | Champion | Today (every league) |
| --- | --- | --- | --- | --- | --- |
| 1st (Champion title, gold badge) | **200** / 100 | **300** / 100 | **400** / 100 | 500 / 100 | 500 / 100 |
| 2nd (silver badge) | **120** / 60 | **180** / 60 | **240** / 60 | 300 / 60 | 300 / 60 |
| 3rd (bronze badge) | **80** / 40 | **120** / 40 | **160** / 40 | 200 / 40 | 200 / 40 |

### What a prize is worth (days of that stage's expedition gold, T/E/A)

| League (usual stage) | Tournament win today → 1.6 | Season title today → 1.6 |
| --- | --- | --- |
| Bronze (Woodland, 32 a day) | 0.83 → **1.25** | 4.2 → **6.3** |
| Silver (Outpost, 72) | 0.31 → **0.83** | 1.6 → **4.2** |
| Gold (Mountain, 120) | 0.17 → **0.67** | 0.83 → **3.3** |
| Champion (Mountain, 120) | 0.17 → **0.83** | 0.83 → **4.2** |

### Live players

- **Gold:** every wallet keeps a quarter, rounded up, of the gold it can spend: `new = held + ceil((money − held) / 4)`,
  where `held` is gold held for a queued build fee (0 today: respec and class change are locked). 0 → 0, 1 → 1, 3 → 1,
  4 → 1, 5 → 2, 100 → 25, 5,601 → 1,401.
- **Points above the cap** are kept; Training gives nothing until the level catches up (a level-1 gladiator with 94 points
  trains again at level 22).
- **Levels, XP, items, renown, ratings, leagues** stay.
- **Season 1** (2026-10-25 09:20 to 2026-11-22 09:20 UTC) pays 500 / 300 / 200 gold in every league, as promised. If 1.6
  ships after season 2 has begun, season 2 pays today's prizes too: a season pays the version that opened it.
- **Salvage** sells for 10 until the switch and for 4 after it.

## Rules versioning (Claude's call)

The game already versions its rules: `private.rules_versions` has one active row; `private.advance_boundary` writes the
active version into each new boundary, and every snapshot, job and tournament graph made at that boundary carries it; the
worker runs a job with the executors of its own version (`DEFAULT_EXECUTORS[job.rulesVersion]`). 1.6 uses that machinery
as built (runbook, "Retained-rule deployments"):

- **`RULES_V2`** is a new immutable module. **An activity is paid by the version of the boundary that froze it**, i.e. of
  its start. The first boundary opened after the operator's switch is `v2`; everything frozen before it settles under `v1`
  with the retained `v1` executors: the slot running at the switch, a tournament in progress, every pending settlement and
  reveal. Settled history keeps its version.
- **The switch is one owner-only statement** (`private.switch_to_economy_v2()`, below), run with Avi's go between
  boundaries. Deploying M27 and the functions changes nothing: `v2` is inactive until the switch.
- **What reads the active version, and only these:** a new boundary (SQL, as today); an NPC sale of salvage (Edge, at
  command time); the client's texts (from the public revision read).
- **A season pays the version that opened it.** Boundary phase 2 stores its boundary's version on the new season row;
  season 1's row is `v1`.
- **The catalog stays `CATALOG_V1`** for both versions: SQL accepts only catalog `v1` items and plans, and no item changes.
  Everything that differs between the versions is in the rules: expedition XP, gold and gear chance
  (`expeditionRewards`), the salvage value (`inventory.salvageSellValue`), the cap (`progression.trainingCapBase`,
  `trainingCapPerLevel`), and the prize tables (`tournament.placementsByLeague`, `seasons.placementsByLeague`).
- `RULES_V1` and `CATALOG_V1` keep every value; a test pins them. Both versions stay registered in the worker until a later
  patch proves no `v1` job is left (runbook query).

### `RULES_V2` (exact)

`RULES_V2` has every key of `RULES_V1` with the same value, except:

```ts
version: 'v2',
progression: { trainingPoints: 1, xpPerCurrentLevel: 100, levelAttributePoints: 0, levelStaminaRefill: 0,
  trainingCapBase: 10, trainingCapPerLevel: 4 },
inventory: { capacity: 60, salvageStack: 999, salvageSellValue: 4 },
expeditionRewards: { woodland: { xp: 30, money: 4, gearChance: 0.1 }, outpost: { xp: 75, money: 10, gearChance: 0.15 },
  mountain: { xp: 150, money: 18, gearChance: 0.2 } },
tournament: { utcWeekdays: [3, 6], hourUtc: 18, minuteUtc: 40, minimumEntrants: 2, durationMs: 4_800_000,
  placementsByLeague: {   // replaces `placements`
    bronze:   { winner: { money: 40, renown: 50 },  runnerUp: { money: 24, renown: 30 }, semifinal: { money: 12, renown: 15 }, other: { money: 0, renown: 5 } },
    silver:   { winner: { money: 60, renown: 50 },  runnerUp: { money: 36, renown: 30 }, semifinal: { money: 18, renown: 15 }, other: { money: 0, renown: 5 } },
    gold:     { winner: { money: 80, renown: 50 },  runnerUp: { money: 48, renown: 30 }, semifinal: { money: 24, renown: 15 }, other: { money: 0, renown: 5 } },
    champion: { winner: { money: 100, renown: 50 }, runnerUp: { money: 60, renown: 30 }, semifinal: { money: 30, renown: 15 }, other: { money: 0, renown: 5 } } } },
seasons: { durationSlots: 504, durationMs: 2_419_200_000, minimumHumanBouts: 5,
  placementsByLeague: {   // replaces `placements`; 1st, 2nd, 3rd
    bronze:   [{ money: 200, renown: 100, title: 'champion', badge: 'gold' }, { money: 120, renown: 60, title: null, badge: 'silver' }, { money: 80, renown: 40, title: null, badge: 'bronze' }],
    silver:   [{ money: 300, renown: 100, title: 'champion', badge: 'gold' }, { money: 180, renown: 60, title: null, badge: 'silver' }, { money: 120, renown: 40, title: null, badge: 'bronze' }],
    gold:     [{ money: 400, renown: 100, title: 'champion', badge: 'gold' }, { money: 240, renown: 60, title: null, badge: 'silver' }, { money: 160, renown: 40, title: null, badge: 'bronze' }],
    champion: [{ money: 500, renown: 100, title: 'champion', badge: 'gold' }, { money: 300, renown: 60, title: null, badge: 'silver' }, { money: 200, renown: 40, title: null, badge: 'bronze' }] } },
```

`Rules` becomes `typeof RULES_V1 | typeof RULES_V2`, so any code that still reads `tournament.placements` or
`seasons.placements` through `Rules` stops compiling and must use the accessors (plan Task 1).

## Server pieces

### Domain (shared by Edge and worker)

- `domain/rules-v2.ts` (above); `domain/rules.ts`: `RETAINED_RULES` (`v1`, `v2`; `arena.ts` re-exports it),
  `retainedRules(version)`, `isRulesV2(rules)`.
- `domain/economy.ts`, the only place that knows how the versions differ: `expeditionReward(rules, id)`,
  `trainingCap(rules, level)` (`null` in v1), `trainingPoints(rules, level, earnedPoints)` (v1: 1; v2: 1 below the cap,
  else 0), `tournamentPlacements(rules, league)`, `seasonPrizes(rules, league)`, `salvageSellValue(rules)`.
- The consumers take the rules instead of reading `RULES_V1`: `validateBuild` (stamps `rules.version`), `planExpedition`
  (any retained version equal to its snapshot's; rewards and gear chance from `expeditionReward`), `placementGrants` (the
  graph's version and league), `planInventoryGrant` and `npcSaleValue` (the salvage value and capacity from the rules).
  Each defaults to `RULES_V1`, so a caller that passes nothing behaves as today.

### Worker (`game-worker`)

- Every executor is written once over `rules` (`prepareActivity`, `pairArena`, `simulateArena`, `simulateTournamentBout`,
  the simulation dispatch); `DEFAULT_EXECUTORS` is `{ v1: executorsFor(RULES_V1), v2: executorsFor(RULES_V2) }`. The `…V1`
  names stay as wrappers.
- **The cap is applied at preparation.** The prepare result's `trainingPoints` is `trainingPoints(rules, level,
  earnedPoints)` from the frozen prepare input (taken after boundary phase 1 proved the previous slot settled). SQL already
  freezes it into the snapshot and credits it at settlement (`least(trainingPoints, 1e9 − earned)`): no SQL change.
- **Expedition settlement** (`createWorkerDatabase().settle`) plans the inventory grant with the plan's own version
  (`retainedRules(input.rulesVersion)`, which throws `unsupported-rules` for an unknown one), so a v1 trip's overflowing
  salvage converts at 10 and a v2 trip's at 4.

### Edge (`game-command`)

- **Selling salvage** reads the active version (`world_revision.rules_version`, a public column, read beside the owner
  state) and prepares the unit value with it: 4 under v2. SQL keeps trusting the Edge's unit value, as today (it checks
  only its range). A sale prepared a moment before the switch and applied a moment after is paid 10: accepted.
- Creation, builds, shops and the market keep `RULES_V1` / `CATALOG_V1`: their rules are equal in both versions.

### M27 (from `supabase/sql/21-economy.sql`; Patch 1.4's M26 is the patch list and profile card, Patch 1.5 has none)

1. **The v2 row:** `insert into private.rules_versions(version, active) values ('v2', false) on conflict do nothing`.
2. **The public copy of the active version:** `public.world_revision_state.rules_version text not null default 'v1'`
   (check `^v[0-9]+$`), written by a deferred constraint trigger on `private.rules_versions` when a row becomes active
   (`private.mirror_rules_version()`, the `mirror_published_slot` pattern of `15-release.sql`); `public.world_revision`
   restated (M26's view) with `rules_version` appended; backfill to the active version.
3. **Seasons by version:** `public.seasons.rules_version text not null default 'v1'` (check `^v[0-9]+$`; existing rows
   are `v1`); `private.guard_season()` restated so it is immutable; boundary phase 2 (`private.boundary_close_season`,
   14-operations.sql's body) inserts the new season with its boundary's `rules_version`; `private.season_prizes(version
   text, league text) returns jsonb` (immutable SQL: the three placements of the tables above, `null` for an unknown
   version, restated constants pinned by a database test against `RULES_V1` and `RULES_V2`); `private.close_season`
   (13-seasons.sql's body) pays `private.season_prizes(s.rules_version, award.league)->(place − 1)` and raises
   `unknown season prizes` when that is null. `private.season_rules()` stays for the qualification minimum.
4. **The Arena banner:** `public.public_profiles.banner boolean not null default false`; `private.publish_banner()`, an
   AFTER INSERT trigger on `public.owned_cosmetics` for `catalog_id = 'banner'` that sets it (the profile's existing
   `projection_changed` trigger raises the world revision); `public.public_profile_reads` restated (M26's view) with
   `'banner', p.banner` in the profile; backfill from `owned_cosmetics`. `private.project_character` is not restated: its
   upsert never writes `banner`.
5. **The switch:** `private.economy_switches` (audit, owner only) and `private.switch_to_economy_v2()` (below).
6. ACLs (trigger functions: no EXECUTE for anyone; `season_prizes`: service_role; the switch: owner only), `notify
   pgrst, 'reload schema'`.

M27 changes no executor input: a v1 job frozen before it runs unchanged.

### `private.switch_to_economy_v2() returns jsonb` (owner only; with Avi's go)

One transaction, in this lock order (the established one: coordinator row, account advisory lock, gladiator row, wallet):

1. `select … from private.coordinator where singleton for update` (a coordination meanwhile answers `busy`).
2. **Replay:** if `private.economy_switches` has the `v2` row, return its `result` with `"replayed": true` and change
   nothing.
3. **Refuse** with SQLSTATE 55000 and no change: any `private.boundaries` row not `complete` (`open boundary`); the active
   version is not `v1` (`unexpected rules version`); no `v2` row (`missing v2`).
4. **The cut:** for every wallet, in `gladiator_id` order: the owner's advisory lock, the gladiator row and the wallet
   `for update`, `held` = its held reservations' money; when `cut = (money − held) − ceil((money − held) / 4)` is above 0:
   one `public.operation_receipts` row (request `{"kind":"economy-cut","version":"v2"}`, digest
   `sha256('economy-cut:v2:' || gladiator_id)`, result `{moneyBefore, moneyAfter, cut}`), the wallet debited, and one
   `public.wallet_ledger` row (`money_delta = −cut`, `renown_delta = 0`, reason `economy-cut`).
5. **The switch:** `v1` inactive, then `v2` active (the mirror trigger sets the public copy at commit); the world revision
   raised once.
6. **The audit row:** `private.economy_switches(version 'v2', switched_at_ms` (database time, `clock_timestamp()`),
   `wallets_cut, money_before, money_after, result)`; return
   `{"ok":true,"version":"v2","switchedAtMs":…,"walletsCut":…,"moneyBefore":…,"moneyAfter":…,"replayed":false}`.

A deadlock with a concurrent command rolls the whole call back; running it again is safe. There is no undo function: the
receipts and ledger hold every wallet's before and after, so a correction is an owner statement after Avi's go.
`scripts/economy-switch-check.sql` is the read-only pre-check (one row, aggregates only): `open_boundary`,
`active_version`, `v2_row`, `switched`, `wallets`, `money_now`, `money_after_cut`, `held`, `copy_matches`.

## Client

- **The active version:** the revision read (every client, visitors too, every 30 s) asks for `rules_version` beside
  Patch 1.4's `latest_patch`; `displayRules(version)` is `RULES_V2` for `'v2'` and `RULES_V1` for anything else (missing,
  malformed, an unknown `'v3'`), never throwing. The fixture world answers `'v2'`.
- **Schedule:** the Training line (copy below) from the owner's level and earned points under the active rules.
- **Notifications:** a Training that earned no point says so (copy below) instead of "No rewards".
- **Inventory and market:** salvage's NPC value from the active rules (4 under v2); gear values unchanged.
- **Tournaments:** one more rule in the entry rules list: the prizes by league (copy below).
- **Season card:** a season whose `rulesVersion` is `v2` shows a table of every league's gold prizes, the owner's league
  marked; a `v1` season (season 1) keeps today's list. `SeasonView` gains `rulesVersion` (absent → `v1`).
- **The Arena banner** on the profile card and in the shop (copy below).
- `PATCH = '1.6'` and the CHANGELOG 1.6 section from the patch's first commit (Patch 1.4's rule).

UI copy and placement are Claude's call. By Avi's rule, a clickable mockup over real screenshots of these surfaces is shown
to him before the client tasks land; the server tasks do not wait for it.

## The Arena banner (Claude's call)

The banner (50 renown) can be bought but is shown nowhere. **Recommended and chosen: show it** on the gladiator's profile
card (public, so every viewer sees the same card, as Avi asked for 1.4), and say so in the shop. Removing it from sale with
a refund would take away something players chose, and the skins shop (1.7 or 1.8) plans to draw it in Arena bouts; this
fix is the first half of that. Drawing it in the camp or in replays is not in 1.6.

## Player-facing copy (word for word)

Braces are values filled in by code or, for the messages, at posting time. "·" is U+00B7, "×" U+00D7, "→" U+2192.

### The Training line (Schedule, under a Training choice)

- v2, below the cap: `Practice yard: +1 attribute point, up to {cap} at level {level} (you have {earned}). Costs {cost} stamina.`
- v2, at or above the cap: `Training is full: {earned} points, and level {level} allows {cap}. It gives nothing until level {next}. Costs {cost} stamina.`
- v1 (before the switch): unchanged, `Practice yard: builds experience. Costs {cost} stamina.`

`cap` = 10 + 4 × level; `next` = ⌊(earned − 10) / 4⌋ + 1, the first level whose cap is above `earned`; `cost` is Training's
stamina (20). Examples: level 1 with 10 points: "Practice yard: +1 attribute point, up to 14 at level 1 (you have 10).
Costs 20 stamina." Level 1 with 94 points: "Training is full: 94 points, and level 1 allows 14. It gives nothing until
level 22. Costs 20 stamina."

### Notification of a Training at the cap

Title "Training finished" (unchanged); the one line `No point: Training was full for your level`.

### Tournament prizes (Tournaments, the last entry rule)

- v2: `Gold prizes by league, for 1st · 2nd · semifinal: Bronze 40 · 24 · 12, Silver 60 · 36 · 18, Gold 80 · 48 · 24, Champion 100 · 60 · 30. Renown in every league: 50, 30, 15, and 5 for the others, plus 10 a won bout and 2 a lost one.`
- v1: `Gold prizes for 1st · 2nd · semifinal: 100 · 60 · 30 in every league. Renown: 50, 30, 15, and 5 for the others, plus 10 a won bout and 2 a lost one.`

### Season card (a v2 season)

A table labelled "Season prizes in gold" with the header cells `League`, `1st`, `2nd`, `3rd` and four rows `Bronze`,
`Silver`, `Gold`, `Champion` (numbers from the season prize table). The owner's league reads `{League} · yours` and its row
is highlighted; a visitor sees no mark. Under it: `Gold for each place. Every league also pays 100, 60 and 40 renown, the
Champion title for 1st, and gold, silver and bronze badges.` The existing rule line follows unchanged.

### The Arena banner

- Profile card, after the name line: a pill `🚩 Arena banner` (the flag is decorative, hidden from screen readers).
- Shop card: `Cosmetic · Account-bound · Shown on your profile card · No inventory slot or combat bonus`; when owned:
  `Arena banner · Owned · Shown on your profile card`.

### The warning message (posted a day before the switch, kind `admin`, no action)

- Title: `Patch 1.6 on {Weekday} {D Mon}: a new economy`
- Preview: `On {Weekday} at about {HH:MM} UTC, gold, XP and prizes change, and everyone's gold is cut to a quarter.`
- Body:
  - p: `Patch 1.6 changes the game's economy on {Weekday} {D Mon} at about {HH:MM} UTC. This note comes a day early so that nothing is a surprise.`
  - li: `Everyone's gold is cut to a quarter at that moment. Levels, XP, attribute points, items and renown stay as they are, and shop prices do not change.`
  - li: `Salvage sells to merchants for 10 gold until then, and for 4 gold after.`
  - li: `Expeditions will give less XP and gold, so levels come more slowly.`
  - li: `Tournament and season gold prizes will depend on the league. A tournament win will pay 40 gold in Bronze, 60 in Silver, 80 in Gold and 100 in Champion.`
  - li: `Training will give points up to a limit that grows with your level. Points you already have stay.`
  - li (only while season 1 runs): `Season 1 ends on 22 Nov with the prizes it promised.`
  - p: `The patch note will explain everything once the patch is live.`

(43-character title for "Thursday 12 Nov", about 100-character preview, 8 blocks, about 790 characters.) **Avi to confirm the
first bullet** (question 1 below). Without it, the salvage line alone invites selling at 10 just before a cut that makes
those 10 gold worth 2½, against 4 after the patch.

### Patch note draft (posted after the switch, kind `patch-notes`, no action)

- Title: `A new economy: slower levels and prizes by league`
- Preview: `Levels and gold come more slowly, prizes depend on your league, and Training has a limit. Everyone's gold was cut to a quarter.`
- Body:
  - p: `What changed:`
  - li: `Expeditions give less. The Woodland Path pays 30 XP and 4 gold, the Ruined Outpost 75 XP and 10 gold, and the Mountain Pass 150 XP and 18 gold. Level 10 now takes about three weeks of Training, Expedition and Arena days.`
  - li: `Gear is found half as often on expeditions, and salvage sells to merchants for 4 gold.`
  - li: `Tournament gold depends on your league: a win pays 40 gold in Bronze, 60 in Silver, 80 in Gold and 100 in Champion, and second place and the semifinals are scaled the same way. Renown prizes are unchanged.`
  - li: `Season gold prizes depend on the league too, from the first season that starts after this patch: first place pays 200 gold in Bronze, 300 in Silver, 400 in Gold and 500 in Champion. Season 1 pays the prizes it promised.`
  - li: `Training gives a point until your gladiator has 10 + 4 × its level in points. At that limit Training gives nothing until the next level, and the Schedule says so. Points you already have stay.`
  - li: `Everyone's gold was cut to a quarter when the patch went live. Levels, items, points and renown stay, and shop prices are unchanged.`
  - li: `The Tournaments rules list the prizes by league, and the season card shows each league's prizes.`
  - li: `The Arena banner now shows on your profile card.`

(49-character title, 127-character preview, 9 blocks, about 1,210 characters.) If Avi keeps today's gear drop chance, the
second bullet is `Salvage sells to merchants for 4 gold.` Credits nobody: these were Avi's own decisions.

### CHANGELOG.md bullets (the server's patch rows; plain text, one line each)

1. `Expeditions give less XP and gold: 30 XP and 4 gold on the Woodland Path, 75 and 10 on the Ruined Outpost, 150 and 18 on the Mountain Pass. Level 10 takes about three weeks.`
2. `Gear is found half as often on expeditions, and salvage sells to merchants for 4 gold.`
3. `Tournament gold depends on the league: a win pays 40 in Bronze, 60 in Silver, 80 in Gold and 100 in Champion, the other places scaled the same way. The Tournaments rules list them.`
4. `Season gold prizes depend on the league from the next season, up to today's: 200, 300, 400 or 500 gold for first place. The season card shows every league's prizes. Season 1 pays what it promised.`
5. `Training gives a point until your gladiator has 10 + 4 × its level in points. At that limit it gives nothing until the next level, and the Schedule says so. Points you have stay.`
6. `A Training that gave no point says so in Notifications.`
7. `Everyone's gold was cut to a quarter when 1.6 went live. Levels, items, points and renown stayed, and shop prices did not change.`
8. `The Arena banner shows on your profile card.`

Patch title (the 1.6 row and CHANGELOG heading): `A new economy: slower levels and prizes by league`.

## Release (needs Avi's go for every production write)

Outside Wednesday and Saturday 17:20–20:00 UTC, after 1.5 is recorded (`private.record_patch` refuses a number not above
every recorded one).

1. **A day before:** the gate of record and a whole-branch review have passed and the release commit is chosen. With Avi's
   go on the filled-in text, post the warning (`private.post_message('admin', …)`, runbook "Posting a game message") naming
   the switch's day and a time 20–60 minutes after a slot cutoff (cutoffs fall every 80 minutes: …, 09:20, 10:40, 12:00 …
   UTC). Read back the visible messages.
2. **The release day,** in this order, each after Avi's go:
   1. The hosted checks (read-only, `scripts/hosted-checks.sql`): no open boundary.
   2. **M27:** `db push --dry-run` lists exactly the `_patch_1_6.sql` migration; `db push`; read back
      `select version, active from private.rules_versions order by version` (v1 true, v2 false), `select rules_version
      from public.world_revision` (v1) and `scripts/economy-switch-check.sql` (`active_version` v1, `v2_row` true,
      `switched` false, `copy_matches` true); the access audit and the schema fingerprint against the local M01–M27
      replay.
   3. **Functions:** `functions deploy game-worker` and `game-command` (both carry the v2 executors and the salvage rule);
      the probes; the health check after the next boundary (no `unsupported-rules`).
   4. **Client:** the `release` fast-forward; the deployed checks. The client shows v1 numbers until the switch.
   5. **The switch,** between boundaries at the announced time: the check again (`open_boundary` 0), then
      `select private.switch_to_economy_v2();`. Read back: `private.economy_switches` (one row), the ledger's `economy-cut`
      sum equal to its `money_before − money_after`, `public.world_revision.rules_version` = v2, and after the next
      boundary, its `rules_version` v2 and its jobs completing (health).
   6. **The patch note**, then the patch row (`node scripts/patch-statement.mjs 1.6 --message <id>`); read back
      `latest_patch` = 1.6.
3. **Rollback:** before the switch, nothing has changed for players; the client can roll back (the old client reads no new
   column). After it, there is no automatic undo (see the switch); the emergency brake is pausing the scheduler.

**Players' clip, after the release:** a short clip of the new economy from the real game (HyperFrames), narrated in the
concept film's voice (local Kokoro `bm_george`), music about 0.1 under the narration and never normalised up, closing on
the game and the update with no URL and no "Coming soon"; 16:9 for Indigo Labs and 9:16 for Instagram and WhatsApp
stories; uploads and posts only on Avi's go. The release report reminds Avi of it (his patch-clip rule).

## Later patches (noted only)

- **1.8: party dungeons and the bot team** (1.7 is wearable titles, M28) (spec `2026-10-29-party-dungeons-design.md`, now M29 from
  `22-dungeons.sql`; friend parties M29). Its §3 adds keys to `RULES_V1` and pays v1-sized rewards; once 1.6 has made `v2`
  active, those keys and the proposal's v2 dungeon amounts belong in `RULES_V2`, and its monster numbers must be measured
  again against capped builds (up to 50 points at level 10). Revise its §3 and §8 before building it.
- **1.7 or 1.8: the renown skins shop** with dyes for clothes and weapons (Avi, 2026-10-29); it can raise renown prizes by
  league then.
- **A later patch: gear** (new items, attribute requirements set against the cap, one free respec message).
- **After the dungeons: the Deep**, the weekly solo delve from level 15.

## Risks

| Risk | Answer |
| --- | --- |
| A worker without v2 executors meets a v2 job | Functions deploy before the switch; the rule-retention test fails while a seeded version has no executors |
| The switch while a boundary is open or twice | It refuses an open boundary and replays its audit row; it holds the coordinator lock |
| Players feel robbed by the cut | The day-ahead message, the patch note, and levels, items and renown kept (Avi's decision) |
| Training at the cap feels broken | The Schedule line and the notification say why, and until which level |
| Old clients show old numbers after the switch | The patch row makes every 1.4+ tab show the reload notice within one poll |

## Avi's answers to the open questions (2026-10-30, question form) — binding, they override any text above

1. The day-before warning message **says plainly that everyone's gold will be cut to a quarter** (with the new salvage value), so nobody sells at 10 just before the cut.
2. **Gear drops are halved** on expeditions: 10 / 15 / 20 % (Woodland / Outpost / Mountain).

## Avi's added decision (2026-10-31, question form) — binding

3. **At most 2 Training slots per game day** (a game day = the morning, afternoon and evening slots), on top of the Training cap (10 + 4 × level). A third Training in the same game day gives nothing; the Schedule refuses or warns before saving (exact copy and where the check lives — client schedule validation and the server's preparation — to be settled in the spec/plan update before Task 4). Avi: today a player can train about 12 times a real day, "it is OP".
