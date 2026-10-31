# Patch 1.7: wearable titles (design)

Date: 2026-10-30. Author: Claude. Status: **decided by Avi through question forms** (2026-10-30) on the
[titles proposal](../../../.superpowers/design/2026-10-30-titles/proposal.md) and its clickable mockup `mockups.html` (local,
ignored by git; Avi saw the mockup and approved the direction). This spec carries everything an implementer needs. Plan:
[2026-10-30-titles-1-7.md](../plans/2026-10-30-titles-1-7.md).

Decisions are marked **Avi** (his answers in the question forms) or **Claude's call** (made while writing this spec; Avi can
overrule any of them). No production data was read.

## Intent

Players already do the same things every day: expeditions, Training, the Arena, tournaments, shopping and selling. Nothing
shows what a gladiator has done over time. Patch 1.7 gives every gladiator titles for what it has done, lets the player
wear one beside its name, and marks the players of Season 1 as Founders. It comes right after 1.6 made progress slower, so
long goals land when players need them.

## Goals

1. **31 titles** in 8 families that need nothing new to earn (Avi). Each title has one rule and one threshold.
2. **History counts (Avi).** At the release a back-fill counts everything the database still proves, so nobody starts from
   zero. Counting then continues live, inside the database, in the writer's own transaction.
3. **Founder (Avi):** every gladiator made in Season 1, before Season 1 ends on 22 Nov 2026 (the server's season row),
   gets it. It is never earned again.
4. **Lifetime counting (Avi).** Wealth counts gold earned from play, with gold credited before 1.6's switch counted at a
   quarter. Gear collection counts every item ever owned, in a small ownership-history table.
5. **Wearing (Avi):** one title or none, chosen in My gladiator, shown with the name in the camp label, the Gladiators list,
   the profile card, the Arena and replay headers and the tournament brackets.
6. **Notices** in Notifications, as the proposal and the mockup show them (Avi).

## Non-goals

- **Later patches:** the 4 dungeon titles ship with party dungeons (**1.8**, Avi); the 2 Deep titles with the Deep (later,
  Avi); Outfitter with the new gear; Legend-Bearer only if a Legendary rarity is ever added.
- No title gives a bonus, costs gold or renown, or can be traded. A title, once earned, is never taken back.
- No change to settlement, combat, rewards, the economy or any executor: counting is in database triggers (Avi), so no
  settlement function is restated and the worker is not deployed.
- The Gladiators filter still matches names only; the Arena standings rows show names only (mockup).
- No title in the creation dialog, the market or the season standings archive.

## Avi's decisions and Claude's calls

| Decision | Who |
| --- | --- |
| The proposal's 39 titles in their families; the 31 that need no dungeon ship in 1.7; dungeon titles in 1.8; the Deep later | Avi |
| Today's season champion title becomes the title Champion | Avi |
| The founders' title is "Founder": every gladiator made in Season 1 (before it ends on 22 Nov 2026), from the server's season data; never earned again | Avi |
| Lifetime counting: gold earned from play (results and NPC sales of found items, not market sales), v1 gold at a quarter; items ever owned, in an ownership-history table | Avi |
| Back-fill from history at the release; history is kept 90 days, so it runs before about 23 Jan 2027 | Avi |
| One title or none, chosen in My gladiator; shown in the camp label, the Gladiators list, the profile card, the Arena and replay headers and the brackets | Avi |
| Titles are their own patch 1.7, after 1.6; party dungeons and the bot team move to 1.8 | Avi |
| M28 from a new SQL source; a `wear-title` Edge command; counting in database triggers; a public read of worn titles; the access matrix and anonymous probes | Avi |
| The source is `supabase/sql/22-titles.sql`; the dungeons' source moves from `22-dungeons.sql` to `23-dungeons.sql` | Claude's call |
| "Before Season 1 ends" is `created_at_ms < ends_at_ms` of `public.seasons` row `season_index = 0` (1,795,339,200,000 = 2026-11-22 09:20 UTC) | Claude's call |
| "Gold credited before the switch counts at a quarter" is decided by credit time against `private.economy_switches` (1.6), not by rules version: season 1's prizes, paid after the switch and never cut, count in full | Claude's call |
| An NPC sale counts unless the gladiator bought that item in a shop itself (its id is in one of its own shop receipts) | Claude's call |
| Starter items sold to merchants count as found (history cannot tell them apart; at most 20 gold, 5 after the quarter) | Claude's call |
| The three title tables are in `public` with owner-only reads (the proposal said service_role only): the owner read is an invoker view the owner reads itself | Claude's call |
| A title earned during a settlement belongs to that result's notification, Old Guard included (it comes with the first result after day 100) | Claude's call |
| The first title ever earned is worn at once; when several arrive together: Founder, else the highest tier, else the catalog order | Claude's call |
| Champion is one title; menus name the latest first place ("Champion · Season 1 Silver"); repeat firsts count toward Thrice-Crowned | Claude's call, **question for Avi** |
| Arena titles count the evening Arena's bouts only; tournament bouts count for the tournament titles | Claude's call |
| Brackets show the title on a second line under the name, cut with "…" when the cell is narrow; a mockup of that cell goes to Avi first (the approved mockup showed names only there) | Claude's call |
| The picker's family order and copy are the mockup's; the Founder rule line changes from "Made before Patch 1.4" to Season 1 | Claude's call (from the mockup) |
| A Founder granted at creation is worn at once but gets no notice (the player sees it over its name) | Claude's call |

## The titles

`Measure` is what the rule compares (next section). A title is earned when its measure reaches its threshold. "Ships in" is
the patch that adds it to the catalog; only 1.7's 31 rows are in `TITLES_V1`. The order of the 31 is the picker's order
(the mockup's), and the catalog order the code uses.

| # | Id | Name | Family | Rule (players see it) | Measure | Threshold | Tier | Ships in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `founder` | Founder | Special | Made in Season 1 | `founder` | 1 | – | 1.7 |
| 2 | `old-guard` | Old Guard | Special | 100 days in camp | `days-in-camp` | 100 | – | 1.7 |
| 3 | `bannerman` | Bannerman | Special | Own the Arena banner | `banner` | 1 | – | 1.7 |
| 4 | `wanderer` | Wanderer | Expeditions | 10 expeditions won | `expeditions-won` | 10 | I | 1.7 |
| 5 | `pathfinder` | Pathfinder | Expeditions | 50 expeditions won | `expeditions-won` | 50 | II | 1.7 |
| 6 | `trailblazer` | Trailblazer | Expeditions | 200 expeditions won | `expeditions-won` | 200 | III | 1.7 |
| 7 | `wolfbane` | Wolfbane | Expeditions | 25 wins on Woodland Path | `woodland-won` | 25 | – | 1.7 |
| 8 | `raiders-bane` | Raider's Bane | Expeditions | 25 wins on Ruined Outpost | `outpost-won` | 25 | – | 1.7 |
| 9 | `troll-slayer` | Troll-Slayer | Expeditions | 25 wins on Mountain Pass | `mountain-won` | 25 | – | 1.7 |
| 10 | `tiro` | Tiro | Training | 10 Trainings | `trainings` | 10 | I | 1.7 |
| 11 | `disciplined` | Disciplined | Training | 100 Trainings | `trainings` | 100 | II | 1.7 |
| 12 | `doctore` | Doctore | Training | 400 Trainings | `trainings` | 400 | III | 1.7 |
| 13 | `bloodied` | Bloodied | Arena | A first Arena win | `arena-wins` | 1 | I | 1.7 |
| 14 | `crowd-pleaser` | Crowd-Pleaser | Arena | 25 Arena wins | `arena-wins` | 25 | II | 1.7 |
| 15 | `lion` | Lion of the Arena | Arena | 100 Arena wins | `arena-wins` | 100 | III | 1.7 |
| 16 | `invictus` | Invictus | Arena | 5 Arena wins in a row | `arena-best-streak` | 5 | – | 1.7 |
| 17 | `finalist` | Finalist | Tournaments | Reach a tournament final | `tournament-finals` | 1 | – | 1.7 |
| 18 | `victor` | Victor | Tournaments | Win a tournament | `tournament-wins` | 1 | – | 1.7 |
| 19 | `triumphator` | Triumphator | Tournaments | Win 5 tournaments | `tournament-wins` | 5 | – | 1.7 |
| 20 | `medalist` | Medalist | Seasons | A season top-three place | `season-top-three` | 1 | – | 1.7 |
| 21 | `champion` | Champion | Seasons | A season first place | `season-firsts` | 1 | – | 1.7 |
| 22 | `thrice-crowned` | Thrice-Crowned | Seasons | 3 season first places | `season-firsts` | 3 | – | 1.7 |
| 23 | `collector` | Collector | Gear collection | 10 distinct items ever owned | `items-owned` | 10 | I | 1.7 |
| 24 | `curator` | Curator | Gear collection | 40 distinct items ever owned | `items-owned` | 40 | II | 1.7 |
| 25 | `antiquarian` | Antiquarian | Gear collection | 100 distinct items ever owned | `items-owned` | 100 | III | 1.7 |
| 26 | `tempered` | Tempered | Gear collection | Every tier (1, 5, 10) of one item | `tiers-of-one` | 3 | – | 1.7 |
| 27 | `connoisseur` | Connoisseur | Gear collection | Common, Uncommon and Rare of one item at one tier | `rarities-of-one` | 3 | – | 1.7 |
| 28 | `rare-find` | Rare Find | Gear collection | A first Rare item | `rare-items` | 1 | – | 1.7 |
| 29 | `moneyed` | Moneyed | Wealth | 1,000 gold earned | `gold-earned` | 1,000 | I | 1.7 |
| 30 | `patrician` | Patrician | Wealth | 4,000 gold earned | `gold-earned` | 4,000 | II | 1.7 |
| 31 | `croesus` | Croesus | Wealth | 12,000 gold earned | `gold-earned` | 12,000 | III | 1.7 |
| 32 | `outfitter` | Outfitter | Gear collection | All 20 items of the new gear wave, any tier or rarity | (gear patch) | 20 | – | the gear patch |
| 33 | `legend-bearer` | Legend-Bearer | Gear collection | A first Legendary item | (if added) | 1 | – | if a Legendary rarity is added |
| 34 | `den-breaker` | Den Breaker | Dungeons | Beat Alpha of the Den (Wolf Den) | (1.8) | 1 | – | 1.8 |
| 35 | `warlords-end` | Warlord's End | Dungeons | Beat the Raider Warlord (Raider Stronghold) | (1.8) | 1 | – | 1.8 |
| 36 | `kingslayer` | Kingslayer | Dungeons | Beat the Troll King (Troll Hall) | (1.8) | 1 | – | 1.8 |
| 37 | `dungeoneer` | Dungeoneer | Dungeons | 25 dungeon clears | (1.8) | 25 | – | 1.8 |
| 38 | `delver` | Delver | The Deep | A first full clear | (the Deep) | 1 | – | with the Deep |
| 39 | `deepwalker` | Deepwalker | The Deep | 5 full clears | (the Deep) | 5 | – | with the Deep |

Every name has at most 18 characters (the longest is "Lion of the Arena", 17). Ids match `^[a-z][a-z-]{1,30}$`.
"Raider's Bane" and "Warlord's End" use the ASCII apostrophe. Pace on a 1.6 Training / Expedition / Arena day (4
Trainings, 4 expeditions, 6 bouts): Wanderer and Tiro in about 3 days, Pathfinder in 2 weeks, Trailblazer and Doctore in 2
to 3 months; the wealth tiers in about 2 weeks, 7 weeks and 5 months at about 80 gold a day.

## What each measure counts

| Measure | Stored as | Live: what adds to it | Back-fill: where history proves it |
| --- | --- | --- | --- |
| `expeditions-won` | counter | an expedition activity completes with `summary.success` true (all three fights won) | completed expeditions with success (activities, 90 days) |
| `woodland-won`, `outpost-won`, `mountain-won` | counters | the same, by `requested.expeditionId` (`woodland`, `outpost`, `mountain`) | the same |
| `trainings` | counter | a Training completes, with or without a point (1.6's cap) | the greater of completed Trainings and `earned_points − 10` (every point came from Training) |
| `arena-wins` | counter | an `arena` activity completes with success (a player or an NPC beaten) | completed Arena activities with success |
| `arena-streak`, `arena-best-streak` | counters | a win adds 1 to the streak and raises the best to it; a loss sets the streak to 0 | the run of wins since the last loss, and the longest run, in slot order |
| `tournament-finals` | counter | a tournament activity completes with its placement 1 or 2 | `tournament_placements` (90 days) |
| `tournament-wins` | counter | the same, placement 1 | the same |
| `season-top-three` | counter | a season award is inserted (places 1–3) | `private.season_awards` (forever) |
| `season-firsts` | counter | the same, place 1 | the same |
| `gold-v1`, `gold-v2` | counters | a `wallet_ledger` credit above 0 with reason `expedition`, `arena`, `tournament`, `season` or `npc-sale`, into `gold-v1` before 1.6's switch time (or while no switch is recorded) and `gold-v2` from it; an `npc-sale` of an item the gladiator bought in a shop itself does not count | the same rule over `wallet_ledger` (90 days) |
| `gold-earned` | derived | `gold-v2 + ⌊gold-v1 / 4⌋` (one floor of the whole sum, never per credit) | |
| `items-owned` | counter | a new row in the ownership history (`public.item_firsts`): count of its rows | |
| `rare-items` | counter | the same: rows whose catalog id ends `:rare` | |
| `tiers-of-one` | counter | the same: the most distinct tiers (1, 5, 10) held by one item template | |
| `rarities-of-one` | counter | the same: the most distinct of `common`, `uncommon`, `rare` held by one template at one tier | |
| `days-in-camp` | derived | ⌊(the award time − `created_at_ms`) / 86,400,000⌋ | |
| `founder` | derived | 1 when `created_at_ms` < Season 1's `ends_at_ms`, else 0 | |
| `banner` | derived | 1 when `public.owned_cosmetics` holds `banner` | |

**The ownership history** (`public.item_firsts`): one row per gladiator and catalog id ever owned, the first time it was
seen. A catalog id is item, tier and kind (`sword:5:rare`; a renown variant is its own, `sword:5:renown`); 132 exist today.
Salvage and cosmetics never count. Live, a row is added when an item is inserted for the gladiator (a find, a shop
purchase, a starter item) and when a market purchase moves an item to it. Back-fill sources: the two starter items every
gladiator was given (`sword:1:common`, `light-armor:1:common`); the items held now; the items in completed activities'
`summary.rewards.items` (90 days); the catalog ids of its own successful `buy-shop` receipts (forever); and its market
purchases (sold listings with it as buyer, 90 days past their expiry), identified by the item if it still exists or by the
shop receipt that created it. A market-bought find that has since been sold to a merchant or discarded cannot be
identified: the back-fill misses it (Claude's call).

**Gold:** "earned from play" is results (expeditions, the Arena, tournaments, seasons; later dungeons and the Deep) and NPC
sales. Market sales, refunds, the 1.6 cut, the starting 100 and every debit never count, so trading between accounts can
never buy a title. Nothing ever lowers the count. 1.6's quarter cut does not touch it; gold credited before the switch
counts at a quarter because v1 gold came about four times faster (3,000 v1 gold counts 750).

## Earning, wearing and notices

- **Awarding** is one function, `private.award_titles`, called at the end of the write that earned something. It compares
  every 1.7 rule with the gladiator's measures at that moment and grants each title met and not yet held, in catalog order,
  with one time, one source and, for a result, the activity:
  - a settlement: when its activity becomes `completed` (Training, expedition, Arena, tournament), with that activity, at
    its `settled_at_ms`. Loot found and gold credited in that settlement are already counted, so their titles join the
    result's notification. A Rest awards nothing.
  - a season award (source `season`, with `{seasonIndex, league, place}`); the Arena banner bought (`shop`); an item bought
    in a shop (`shop`) or on the market (`market`); an NPC sale (`sale`); a new gladiator (`joined`: Founder).
  - the release back-fill (`history`).
- **The first title worn at once.** When a gladiator that held no title gets one or more, it wears one: Founder if among
  them, else the highest tier (III before II before I, then untiered), else the first in catalog order. Earning a title
  never changes what a gladiator that already held one wears, so a player who chose "No title" keeps none.
- **Wearing** is free, any time, any earned title or none, with `wear-title`. An unearned or unknown title is refused.
- **Never taken back:** title rows can be neither changed nor deleted; the counters only grow (except the Arena streak).
- **Notices** (Notifications tab; they count on the Messages badge; nothing pops up over a fight or a dialog):
  - A title with an activity: a gold line inside that result's notification, with **Wear**.
  - Titles without an activity, grouped by source and time: one notice each group. Source `history` is the release notice
    "Titles from your history". Source `joined` (Founder at creation) has no notice.
  - A notice is new when its time is after the account's "seen up to" mark (the same rule as results: `earned_at_ms >
    greatest(mark, created_at_ms)`), and the server's `newNotifications` counts it.

## Where a title shows

- **Camp:** a gold line just above the name, in the nameplate's monospace lettering one size smaller (9 px, italic,
  `#f2c66b`, the name's stroke). The name stays where it is. Everyone's title shows when the camera zoom is 2 or more; the
  selected or followed gladiator's shows whenever its name does; between zoom 1.4 and 2 a crowd shows names only. A
  gladiator with no title shows its name only. Arena fighters in the camp ring follow the same rule. Damage labels keep
  their gap over the title as over the name.
- **Gladiators list:** after the name (and NEW or "(you)"), in gold italic; a long one wraps under the name.
- **Profile card (1.4's richer card):** the worn title under the name, replacing 1.4's "latest champion title" line;
  Champion reads "Champion · Season 1 Silver" from the latest first place in the profile's prestige. The badges stay.
  RECORD gains "Titles" "{n} earned" ("None yet" at 0).
- **Arena bouts and replays** (in the camp and on `/replay/`): under each fighter's name in the header, gold italic; an NPC
  or creature has none.
- **Tournament brackets:** each entrant cell shows the title on a second line under the name, gold italic 11 px, cut with
  "…" to the cell's width; the cell's accessible text is "{name}, {title}".
- **Menus everywhere show the title the gladiator wears now** (the public world actor), not the title it wore when a bout
  was fought.
- **Phone** (`@media (hover: none), (max-width: 480px)`): the same places; list rows wrap; the picker fills the screen
  less a 10–14 px margin, its preview stays at the top while the titles scroll, and Wear title and Cancel stay pinned at
  its foot (44 px). Nothing scrolls sideways at 360 × 740.

## Server: M28 from `supabase/sql/22-titles.sql`

One migration, **M28**, generated from the new reapplicable source `supabase/sql/22-titles.sql` (1.6's M27 is
`21-economy.sql`; 1.4's M26 is `19-patches.sql` and `20-profile-card.sql`). The party dungeons' source becomes
`23-dungeons.sql` (M29). The worker is unchanged; the release deploys `game-command` only.

### Tables (owner-only reads, kept forever)

```sql
public.gladiator_titles (gladiator_id uuid references public.gladiators(id), title_id text check (~ '^[a-z][a-z-]{1,30}$'),
  earned_at_ms bigint >= 0, activity_id uuid null (no foreign key: activities go after 90 days, the title stays),
  source text in ('history','result','season','shop','market','sale','joined'),
  detail jsonb null or an object, primary key (gladiator_id, title_id))
  -- guard_frozen before update or delete
public.title_counters (gladiator_id uuid references public.gladiators(id), counter text check (~ '^[a-z][a-z0-9-]{1,40}$'),
  value bigint 0..9007199254740991, primary key (gladiator_id, counter))
public.item_firsts (gladiator_id uuid references public.gladiators(id),
  catalog_id text check (~ '^[a-z][a-z-]*:(1|5|10):(common|uncommon|rare|renown)$'), first_at_ms bigint >= 0,
  primary key (gladiator_id, catalog_id))
  -- guard_frozen before update or delete
public.gladiators.worn_title text null, foreign key (id, worn_title) references public.gladiator_titles(gladiator_id,
  title_id) deferrable initially deferred (only an earned title can be worn)
public.public_profiles.titles_earned integer not null default 0
private.title_backfills (singleton boolean primary key, ran_at_ms bigint, result jsonb)   -- owner only
```

RLS on the three public tables; SELECT for `authenticated` through the `owner_read` policy of `01-identity.sql`'s recipe
(`gladiator_id in (select id from public.gladiators where owner_id = (select auth.uid()))`); `service_role` SELECT and
INSERT (and UPDATE on `title_counters`); no DELETE for anyone; nothing for `anon`. They are not in the access matrix's
`OPEN` list. A deferred `project_changed_character` constraint trigger on `public.gladiator_titles` republishes the
gladiator (its `titles_earned`). Retention: all are kept forever with the player (`player` class).

### Functions

- `private.title_rules() returns jsonb` (immutable SQL): the 31 rules in catalog order, `[{"id","measure","threshold",
  "tier"}]`, restated constants pinned by a database test against `TITLES_V1` (as `season_rules()`).
- `private.founder_cutoff_ms() returns bigint` (stable SQL): `ends_at_ms` of `public.seasons` where `season_index = 0`;
  null without that row (nobody is a founder then).
- `private.title_measures(gid uuid, at_ms bigint) returns jsonb` (stable): every stored counter (0 when absent), plus
  `gold-earned`, `days-in-camp` (at `at_ms`), `founder` and `banner`.
- `private.add_title_count(gid uuid, counter text, delta bigint) returns bigint` and `private.set_title_count(gid uuid,
  counter text, value bigint) returns bigint`: one upsert each, returning the new value.
- `private.refresh_item_counters(gid uuid) returns void`: sets `items-owned`, `rare-items`, `tiers-of-one` and
  `rarities-of-one` from `item_firsts`.
- `private.award_titles(gid uuid, at_ms bigint, activity uuid, source text, detail jsonb) returns integer`: the awarding
  rule above; the auto-wear updates `gladiators.worn_title` only when the gladiator held no title before the call.
- `public.wear_title(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`: the command (below).
- `private.backfill_titles() returns jsonb` (owner only): the back-fill (below).
- `private.project_character(uuid)`: the latest source's projector (1.4's `20-profile-card.sql`), unchanged except the
  actor's `title` (`g.worn_title`) and the profile upsert's `titles_earned` (count of the gladiator's title rows), in its
  insert, update and is-distinct check.
- `public.public_profile_reads`: the latest source's view (1.6's `21-economy.sql`) with `'titlesEarned', p.titles_earned`
  added to the profile.
- `public.owner_state`: the latest source's view (`18-messages.sql` section 4) with `wornTitle`, `titles`, `titleProgress`
  and the title notices in `inbox.newNotifications` (below).

### Triggers (counting; one per writer, each in the writer's transaction)

| Trigger | On | Does |
| --- | --- | --- |
| `titles_on_activity` | AFTER UPDATE OF status ON `public.activities` WHEN old not `completed` and new `completed` | the activity's counters by kind; then `award_titles(gladiator, settled_at_ms, id, 'result', null)` unless a Rest |
| `titles_on_ledger` | AFTER INSERT ON `public.wallet_ledger` WHEN `money_delta > 0` and a counted reason | `gold-v1` or `gold-v2`; for `npc-sale` only, `award_titles(…, 'sale')` (a settlement's gold is awarded with its result) |
| `titles_on_item` | AFTER INSERT ON `public.item_instances` WHEN not salvage | the `item_firsts` row (`on conflict do nothing`); when new, `refresh_item_counters`; then `award_titles(…, 'shop')` unless the item's origin is `expedition` (a find is awarded with its result) |
| `titles_on_item_move` | AFTER UPDATE OF gladiator_id ON `public.item_instances` WHEN the owner changed and not salvage | the same for the new owner, `award_titles(…, 'market')` |
| `titles_on_season_award` | AFTER INSERT ON `private.season_awards` | `season-top-three` + 1, `season-firsts` + 1 at place 1; `award_titles(…, awarded_at_ms, null, 'season', {seasonIndex, league, place})` |
| `titles_on_banner` | AFTER INSERT ON `public.owned_cosmetics` WHEN `catalog_id = 'banner'` | `award_titles(…, 'shop')` |
| `titles_on_gladiator` | AFTER INSERT ON `public.gladiators` | `award_titles(id, created_at_ms, null, 'joined', null)` (Founder before the cutoff) |

**Lock order.** Every trigger touches only its own gladiator's rows, and every writer that fires one already holds that
gladiator's account advisory lock (`hashtextextended(owner_id::text, 0)`): commands, settlements and the season close all
take it first. So the counters, title rows and the `worn_title` update follow the shared order (coordinator, account lock,
gladiator row, wallet, items) without a new wait. The season close locks the account and the wallet but not the gladiator
row; an auto-wear there takes the gladiator row last, which no other holder of that account lock can be waiting on. The
triggers read only data the writer has already validated; an expedition whose `expeditionId` is not one of the three counts
toward `expeditions-won` only. A failing trigger rolls its whole write back, as any settlement failure does.

**Time.** A title's `earned_at_ms` is the result's `settled_at_ms`, the season award's `awarded_at_ms`, the gladiator's
`created_at_ms`, or the database time (`floor(extract(epoch from clock_timestamp()) * 1000)`) sampled once per trigger
call for a purchase or a sale, and once for the whole back-fill. Results settle after their slot ends, so a title never
shows a result before it is revealed.

### The command `wear-title`

- Edge (`game-command`): `{ kind: 'wear-title', operationId, titleId: string | null }`, exactly these keys; `titleId` is
  null or an id of `TITLES_V1`; routed to `wear_title`. This is the release's Edge deploy.
- SQL `public.wear_title`, shaped like `public.change_appearance` (`18-messages.sql`): the account lock; the receipt replay
  (a replay returns the stored result, another body under the same operation is `conflict`); the exact keys
  (`kind`, `operationId`, `titleId`); `titleId` null or a string matching the id pattern, else `invalid`; the caller's own
  gladiator `for update` (`not-found` without one); a title the gladiator does not hold is `invalid`; the update only when
  it differs; the receipt. No receipt for a refusal. Result: `{ok: true, receiptId, value: {titleId, receivedAtMs}}`.
  Backend only (EXECUTE for `service_role`).

### Public and owner reads

- **World actor** (every client, every 30 s): `title`, the worn id or null (about 20 bytes). An older client ignores it.
- **Public profile:** `titlesEarned`, a count.
- **Owner read** (`owner_state`):
  - `wornTitle`: the id or null;
  - `titles`: `[{id, earnedAtMs, activityId, source, detail}]`, by `earnedAtMs` then id;
  - `titleProgress`: every stored counter of the gladiator (absent = 0) plus `gold-earned` and `days-in-camp` (now);
  - `inbox.newNotifications`: the results counted today plus the title notices (distinct `source, earned_at_ms` among its
    rows with no activity and a source other than `joined`) after `greatest(mark, created_at_ms)`.
- Nothing else is public: not the counters, the history of items, the sources or the times.

### Access matrix and probes

- Access audit lines for the three tables (`authenticated` SELECT through `auth.uid()` policies; `service_role` as above)
  and every new function (`award_titles`, `add_title_count`, `set_title_count`, `refresh_item_counters`, `title_measures`,
  `title_rules`, `founder_cutoff_ms` and `wear_title`: EXECUTE for `service_role` only; the seven trigger functions: no
  EXECUTE for anyone; `backfill_titles` and `private.title_backfills`: the owner only).
- Probes (DB and anonymous deployed checks): anon cannot read the three tables or call `wear_title`; a player reads only its
  own rows; a player cannot call `wear_title` or `award_titles` through the Data API; `wear-title` cannot wear an unearned
  title or touch another gladiator; a replay returns its receipt; title and history rows refuse update and delete; the
  public reads carry only the worn id and a count.

### The back-fill (inside M28, at the release, before 23 Jan 2027)

`private.backfill_titles()` runs once (its `private.title_backfills` row replays the result) inside M28's transaction,
after every trigger is created, so writers wait on the trigger tables' locks until the commit and nothing is counted twice.
At one database time `T`, for each gladiator in id order: the counters from history (the table above); the ownership
history from its five sources (`first_at_ms = T`) and `refresh_item_counters`; then `award_titles(gid, T, null,
'history', null)`. It returns `{ok, ranAtMs, gladiators, titles, founders, worn, replayed}`.

**Deadline.** History is kept 90 days; the launch week's history leaves the window from **23 Jan 2027 09:20 UTC** (launch
2026-10-25 09:20 + 90 days). M28 must reach production before then, or the back-fill misses that week. The release steps
say so.

## Client

- `TITLES_V1` and `titleById` in the shared domain (`supabase/functions/_shared/domain/titles.ts`); the copy helpers in
  `src/features/titles/`.
- Reads: `OwnerState` gains `wornTitle`, `titles`, `titleProgress`; `PublicActor` gains `title?`; `PublicProfile` gains
  `titlesEarned?`; a small `readWornTitles(ids)` for the `/replay/` page (`world_actor_reads`, anon allowed). Missing or
  malformed values read as no title, no titles, empty progress and 0; an id this client does not know shows nothing.
- My gladiator: the Title button and the "Choose your title" picker. Wear answers update the button at once; an owner read
  that began before the answer never puts the old title back (AGENTS.md async-state rule).
- Notifications: the gold lines with Wear, the own notices, the history notice, the summary line and the badge.
- The camp label, the Gladiators list, the profile card, the Arena and replay headers and the brackets.
- `PATCH = '1.7'` and CHANGELOG.md's 1.7 section from the patch's first commit (Patch 1.4's rule).
- The fixture world wears the mockup's titles: Aster Founder (the owner, 8 earned), Atticus Pathfinder, Brennus Tiro, Eira
  Invictus, Jovan Crowd-Pleaser, Lucilla Champion, Mira Collector, Pax Bloodied, Quintus Trailblazer, Severus Moneyed, Wren
  Rare Find, Xanthe Victor; Ilaria none.

## Player-facing copy (word for word)

Braces are values filled in by code. "·" is U+00B7, "…" U+2026, "✓" U+2713, "🔒" U+1F512, "›" U+203A, "×" U+00D7. Numbers in
copy come from the catalog or the reads, with thousands separators ("1,240").

### Names and rules

The table "The titles" above is the copy: each title's name and its rule line, word for word. Family headings, in order:
`Special`, `Expeditions`, `Training`, `Arena`, `Tournaments`, `Seasons`, `Gear collection`, `Wealth`.

### Progress (a locked title in the picker)

- Default: `{value} of {threshold}` ("34 of 50", "1,240 of 4,000"), with a bar filled `value ÷ threshold` (at most full).
- `invictus`: `Best run {value} of 5`.
- `tempered`: `Best item: {value} of 3 tiers`. `connoisseur`: `Best item: {value} of 3 rarities`.
- `old-guard`: `{value} of 100 days`.
- `raiders-bane` and `troll-slayer` while the count is 0 and the level is below the trip's level: `Opens at level 5`,
  `Opens at level 10` (the catalog's required levels).
- `bannerman`: `Renown shop · {price} renown` (the banner's renown price, 50).
- `founder` not held: `Only gladiators made in Season 1`.

### My gladiator: the Title button

Beside the name: an eyebrow `TITLE`, the worn title's name (or `No title`) and `›`. Accessible name: `Title: {name}. Choose
your title` (`Title: No title. Choose your title`). Visitors and the fixture visitor have no button. After a wear: the
status line `You now wear {name}.` or `You now wear no title.` (polite live region).

### The picker (a modal dialog)

- Heading `Choose your title`; a close button `×` named `Close`.
- Preview: `IN THE CAMP` with the title over the name, and `IN MENUS` with the name and the title under it (`No title` when
  none).
- A two-button group named `Which titles`: `Earned · {n}` and `All · {n}` (31 in All).
- First group `Wear nothing`: the choice `No title`, its line `Show your name only.`
- Then each family heading with its titles: an earned one is a radio choice with its name, `✓ Earned` and its rule; in All,
  a locked one shows `🔒` (hidden from screen readers), its name, its rule and its progress, and cannot be chosen.
- In All, after the families: `8 more arrive later: 4 with party dungeons, 2 in the Deep, Outfitter with the new gear, and
  Legend-Bearer if a Legendary rarity ever comes.`
- Footer: `Wear title` (gold; disabled while the choice is the worn one) and `Cancel`; while the choice is the worn one,
  `You wear this now`.
- A refused wear: `That title could not be worn. Try again.` (the dialog stays open).

### The Gladiators list, the card, the headers, the brackets

- List: `{name}` then ` (you)` or the `NEW` pill as today, then the title in gold italic.
- Card: the title line under the name (`Champion · Season {n} {League}` for Champion); RECORD `Titles` `{n} earned`, or
  `None yet`.
- Headers: the title under each fighter's name.
- Brackets: `{name}` then the title on its own line; accessible text `{name}, {title}`.

### Notices (Notifications tab)

- **In a result's notification,** one row per title, after the result's lines: `New title: {name}` (the name in italics),
  then the rule in small type, and a button `Wear` (named `Wear {name}`, `aria-pressed` false). When that title is the one
  worn now the button reads `Worn ✓` (`aria-pressed` true). Pressing Wear sends `wear-title`.
- **Its own notice:** card title `New title: {name}` for one title, `New titles` for several, then the same rows. The small
  line is the rule, except a season title: `{1st|2nd|3rd} in Season {n} · {League}` ("3rd in Season 1 · Bronze").
- **At the release:** card title `Titles from your history`; the line `Patch 1.7 counted everything you have done since you
  joined.`; the earned titles' names as chips (the worn one first and marked); a button `Choose a title` (opens the picker
  on My gladiator); `You now wear {name}.` (the title worn now), or nothing when none is worn.
- Summary line: `Latest {n} result{s} and {m} title notice{s} · {k} new` (`· nothing new` at 0); with no notice, today's
  `Latest {n} result{s} · …`. A title notice older than the oldest listed result is not listed (unless the list holds fewer
  than a page of results).

### Patch note draft (posted after the release, kind `patch-notes`, no action)

- Title: `Wearable titles: show what your gladiator has done`
- Preview: `Earn 31 titles for expeditions, Training, the Arena, tournaments, seasons, gear and gold, and wear one with your name.`
- Body:
  - p: `Your gladiator can now earn titles and wear one beside its name.`
  - li: `31 titles to earn: for expeditions won, Trainings, Arena wins, tournaments, season places, gear you have owned, gold you have earned, and a few special ones.`
  - li: `Everything you did before this patch counts. A notice in Notifications lists the titles your history earned.`
  - li (released before 22 Nov 09:20 UTC): `Every gladiator made in Season 1 is a Founder, until the season ends on 22 Nov. After that, nobody gets it again.`
  - li (released after): `Every gladiator made in Season 1 is a Founder. Nobody gets it again.`
  - li: `Choose your title, or no title, on My gladiator. It is free, and you can change it any time.`
  - li: `Your title shows with your name in the camp, the Gladiators list, the profile card, Arena bouts and replays, and the tournament brackets.`
  - li: `New titles arrive in Notifications. A title earned by a result shows in that result, with Wear.`
  - li: `The profile card says how many titles a gladiator has earned.`

(50-character title, 118-character preview, 8 blocks, about 830 characters.) Credits nobody.

### CHANGELOG.md bullets (the server's patch rows; plain text, one line each)

1. `Titles: your gladiator earns titles for expeditions, Training, the Arena, tournaments, seasons, gear owned and gold earned, and wears one beside its name.`
2. `Everything you did before 1.7 counts: a notice in Notifications lists the titles your history earned.`
3. `Founder: every gladiator made in Season 1 has it, and it is never given again.`
4. `Choose your title, or none, on My gladiator: free, any time. Locked titles show how close you are.`
5. `Your title shows with your name in the camp, the Gladiators list, the profile card, Arena bouts, replays and tournament brackets.`
6. `New titles arrive in Notifications; one earned by a result shows in that result, with Wear.`
7. `The profile card counts the titles a gladiator has earned.`

Patch title (the 1.7 row and CHANGELOG heading): `Wearable titles: show what your gladiator has done`.

## Release (needs Avi's go for every production write)

Outside Wednesday and Saturday 17:20–20:00 UTC, with no open boundary, after 1.6 is recorded, and **before 23 Jan 2027**
(the back-fill deadline above).

1. The gate of record and a whole-branch review have passed; the release commit is chosen; Avi's go on the patch note and
   the patch row (`node scripts/patch-statement.mjs 1.7`).
2. The hosted checks (read-only): no open boundary; `select ends_at_ms from public.seasons where season_index = 0` is
   1795339200000.
3. **M28:** `db push --dry-run` lists exactly the `_patch_1_7.sql` migration; `db push`; read back
   `select result from private.title_backfills` (gladiators equal to the gladiator count, `founders` equal to `select
   count(*) from public.gladiators where created_at_ms < 1795339200000`, `worn` equal to the gladiators with a title),
   aggregates only; the access audit and the schema fingerprint against the local M01–M28 replay.
4. **Edge:** `functions deploy game-command`; the probes.
5. **Client:** the `release` fast-forward; the deployed checks.
6. **The patch note, then the patch row** (`node scripts/patch-statement.mjs 1.7 --message <id>`); read back `latest_patch`
   = 1.7.

Rollback: before the client, nothing shows; the old client ignores the new keys. Title rows are permanent; a wrong grant
is corrected by an owner statement after Avi's go (the guard is dropped and restored inside that one transaction).

**Players' clip, after the release:** a short clip of titles from the real game (HyperFrames): the history notice, the
picker, a title over a name in the camp, a result's gold line with Wear, the card's count. Narrated in local Kokoro
`bm_george`, music about 0.1 under the narration and never normalised up, closing on the game and the update with no URL
and no "Coming soon"; 16:9 for Indigo Labs and 9:16 for Instagram and WhatsApp stories; with the feature posts for the
WhatsApp game group and a YouTube post; uploads and posts only on Avi's go.

## Later patches (noted only)

- **1.8, party dungeons and the bot team** (`2026-10-29-party-dungeons-design.md`, now M29 from `23-dungeons.sql`):
  appends the 4 dungeon titles to the catalog and to `private.title_rules()`, with their counters counted by its own
  trigger on a dungeon result; adds its ledger reason to the counted gold reasons; **bots never get Founder** (the
  `titles_on_gladiator` trigger, or the bot row's insert, must skip bot rows; bots earn every other title by the same
  rules and keep their BOT tag beside the name).
- **The gear patch:** Outfitter. **A Legendary rarity, if ever added:** Legend-Bearer (the `item_firsts` check gains the
  rarity). **The Deep:** Delver and Deepwalker.

## Risks

| Risk | Answer |
| --- | --- |
| The back-fill runs after history is pruned | The deadline is in the release steps and the plan header; the Training count falls back to earned points |
| A counted write is counted twice (a retry, a replayed settlement, the back-fill beside a live write) | Settlement replays never re-run the activity update; triggers exist before the back-fill reads; the back-fill runs once |
| A trigger error blocks a settlement | Each trigger is small and tested on every path; an error rolls the settlement back and the job retries, as any settlement failure |
| A restated function differs from its source (the M24/M25 lessons) | The fingerprint must be byte-equal; the M28 file test pins `project_character`, the views and the trigger order |
| Older clients | They read named columns or ignore extra JSON keys; the patch row's reload notice reaches every 1.4+ tab |

## Question for Avi

**Champion: one title, or one per season first place?** *Recommended: one title.* It shows the latest first place in
menus ("Champion · Season 2 Gold"), and repeat firsts count toward Thrice-Crowned. The other way, each first place is its
own choice in the picker ("Champion · Season 1 Silver", "Champion · Season 2 Gold"). Nobody can have two first places before
Season 2 ends, so either answer can wait until then.
