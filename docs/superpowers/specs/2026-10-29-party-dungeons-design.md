# Patch 1.8 (Patch B): party dungeons (MVP) — design

Date: 2026-10-29. Author: Claude. Status: **approved for implementation**. Avi approved the proposal on 2026-10-29,
with decisions (4)–(8) in [the next-patch ideas](2026-10-29-next-patch-ideas.md), and approved the desktop and phone
mockup on 2026-11-07 (see §9). Release approval is separate.

Sources: the approved [proposal](../../../.superpowers/design/2026-10-29-party-dungeons/design-proposal.md) and its balance
prototype (`prototype/`, re-run on 2026-10-29 at this branch's head: Wolf Den 90 / 74 / 45 %, Raider Stronghold 88 / 80 /
56 %, Troll Hall 87 / 68 / 51 % for full party / duo + 1 hired / solo + 2 hired); the game as built
([HANDOFF](../../implementation/HANDOFF.md), the [first-release design](2026-10-11-gladiator-arena-design.md), M01–M29).
Plan: [2026-10-29-party-dungeons.md](../plans/2026-10-29-party-dungeons.md).

**2026-11-07 takeover baseline.** Patch A's whole-trip replay, the v2 economy, wearable titles and hand-given awards
are live. Start from the pushed 1.7.1 line at `5d12d50`. The dungeon view reuses the current replay, LIVE marks and Watch
button (§9). M30 adds dungeons and the separately designed named bot team. On 2026-11-07 Avi chose labeled bots in
camp, dungeon seats after humans and unranked Arena. The recovered approved Ludus Nimbus rules are in §15.
Avi also approved the v2 reward table in §3.1. Hired fighters fill the seats left after humans and eligible bots.

Decisions Claude made inside Avi's go are marked **(Claude)**; the reasons are in §13.

---

## 1. Scope

**In the MVP (M30):** a Dungeon choice in the afternoon part of the schedule; three dungeons (Wolf Den, level 3; Raider
Stronghold, level 7; Troll Hall, level 12) built from the six existing creatures; automatic grouping at the boundary into
parties of up to 3, with eligible bots after human players and hired fighters in the remaining seats; a run of 3 rooms then the major (the boss) inside the one
80-minute afternoon slot; personal rewards where every won fight a member entered pays (a lost major still pays the rooms);
timed reveals, a run view, a party close-up replay, results, notifications and the camp location; a patch note.

Friend parties and invites, and seeing a friend's planned dungeon, follow in phase 2 (M32; Avi's decisions 5 and 8).
Run records and first-clear trophies follow in phase 3. The [title design](2026-10-30-titles-1-7-design.md) separately
assigns four playable dungeon titles to 1.8. The named bot team is part of the 1.8 release per the later handoff, with
its own play rules and approval. Preserve existing expedition, Arena, tournament, season, market and replay behavior
outside that approved bot design. Summoners remain a future class.

**Extension points kept open (not built):**
- *Friend parties (M32):* grouping places pre-formed friend parties first; nothing in the run, rewards or reveals assumes
  strangers. The frozen assignment already records each seat's kind.
- *Summoners:* the party engine fights *units*, not one unit per member. A spirit is a later unit on the party side with an
  owning seat and no rewards; nothing in the engine, targeting, logs or reveals may assume one unit per seat.

## 2. What a player sees

1. **Schedule.** The afternoon select lists the dungeons after the expeditions: "Dungeon: Wolf Den · Level 3". Locked ones
   are listed disabled, as locked expeditions are. The morning and evening selects do not offer them and say "Dungeons run in
   the afternoon only." The description line: "3 rooms, then the boss. Players group first. Eligible bots and hired
   fighters fill open seats. Costs 40 base stamina." The choice repeats every game day until changed, like any other.
2. **The boundary.** At the afternoon cutoff, eligible players who can afford their calculated stamina cost group first
   into parties of up to 3. Eligible bots and then hired fighters fill the open seats. A solo entrant gets two teammates
   even if no bot qualifies.
3. **The run.** The party leaves camp together through the expedition gate, fights Room 1 at minute 16, Room 2 at 32,
   Room 3 at 48 and the major at 64, and comes home at minute 80. Health carries between fights; after a won room every
   standing member recovers 20 % of its maximum. A member knocked out sits out the rest of the run. The first lost fight ends
   the run: the party rests at the safe point until minute 80.
4. **Watching.** The run view (`/dungeon/?activity=<id>`) shows the party walking on the dungeon's map, each fight at its
   time, and a close-up replay of any revealed fight. Stages are public on time, like an expedition's; rewards are
   owner-only.
5. **Rewards.** Each member gets the dungeon's full reward for every fight it entered that its party won: each room pays a
   little, the major pays more and opens a chest (rolled from the member's own seed). Hired fighters earn nothing, and their
   share is not handed to the humans. Overflowing chest items sell to the NPCs at their value, as for an expedition.
6. **Camp.** While away, the roster says "In Wolf Den"; the actor is away like an expedition actor.

## 3. Rules and catalog (v2 dungeon capability)

Following the 1.6 design, dungeon capability belongs to `RULES_V2`. Retain `RULES_V1` unchanged. The catalog stays
`CATALOG_V1` with the new dungeon entries. No existing snapshot can contain a dungeon choice and M30 and the new command
parser enable it only on active v2. Verify frozen v2 for the dungeon worker and payout. Guard full v1 and all pre-existing
v2 and catalog values with the baseline hashes.

```
RULES_V2.schedule.dungeonPhases = ['afternoon']
RULES_V2.activityStamina.dungeon = 40
RULES_V2.dungeon = { seats: 3, fightIntervalMs: 960_000, recovery: 0.2, hiredMultiplier: 0.9,
  targetWeights: { defensive: 3, balanced: 2, offensive: 1 }, sweepEvery: 4, sweepFactor: 0.6, overLevelFactor: 0.5,
  rewardsById }
```

`fightIntervalMs` is 80 min / 5: fights at 16, 32, 48 and 64 minutes. Stamina overload applies as for every activity
(`activityCost`). Unlocks: the member's level at the command (SQL) and in the frozen snapshot (the grouper and planner fail
closed below it).

### 3.1 Dungeons (`CATALOG_V1.dungeons`)

Ids **(Claude)**: `wolf-den`, `raider-stronghold`, `troll-hall`. Monster stat lines: health / damage / interval ms / armor /
attributes (Strength, Agility, Vitality, Endurance, Precision); Balanced stance, no class, no equipment, as the expedition
enemy templates. `creature` is the existing manifest creature drawn for it **(Claude)**.

| Dungeon | Level | Full rewards | Map | Room 1 | Room 2 | Room 3 | Major |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wolf Den | 3 | 3–8 | woodland | 3× Timber wolf 46/7/1000/0/(5,6,4,5,5) `timber-wolf` | 3× Dire wolf 69/9/1200/2/(6,4,6,6,6) `dire-wolf` | 2× Dire wolf + Stalker 52/12/1100/0/(6,8,4,6,10) `timber-wolf` | Alpha of the Den 754/16/1300/4/(12,6,10,10,10) `dire-wolf` |
| Raider Stronghold | 7 | 7–12 | outpost | 3× Raider 80/12/1100/2/(12,10,8,10,10) `raider` | Raider + Raider brute 130/15/1400/4/(14,6,12,10,10) `raider` + Raider archer 70/13/1100/0/(10,12,6,10,14) `raider-archer` | 2× Raider brute + Raider archer | Raider Warlord 880/20/1300/6/(20,10,16,14,16) `raider` |
| Troll Hall | 12 | 12 and above | mountain | 3× Rock troll 129/17/1100/3/(20,14,14,16,16) `rock-troll` | Rock troll + 2× Frost troll 147/18/1300/5/(22,12,16,16,16) `frost-troll` | 2× Frost troll + Troll shaman 101/20/1200/2/(18,16,12,16,20) `frost-troll` | Troll King 1230/19/1300/8/(28,14,22,20,22) `rock-troll` |

V2 rewards approved by Avi on 2026-11-07, per member and per won fight entered. Scaling the prototype XP preserves its
relationship to live v2 expeditions. Gold follows each comparison expedition's new rate, rounded to whole gold, and gear
chance halves alongside expedition gear chance. Store these in `RULES_V2.dungeon.rewardsById` and read them by retained
version through `dungeonReward`.

| Dungeon | Each room | Major | Major chest |
| --- | --- | --- | --- |
| Wolf Den | 6 XP, 1 gold | 30 XP, 5 gold | 1 salvage; 30 % one tier-1 item (Common 40 / Uncommon 45 / Rare 15 %) |
| Raider Stronghold | 15 XP, 2 gold | 75 XP, 10 gold | 2 salvage; 30 % one tier-5 item (40 / 45 / 15) |
| Troll Hall | 30 XP, 4 gold | 150 XP, 18 gold | 3 salvage; 30 % one tier-10 item (40 / 45 / 15) |

Chest items: the tier's non-renown variants of the drawn rarity, sorted by id, picked with the member's loot stream (the
`expeditionLoot` pattern with the chest's own rarity odds). Loot grants use origin `'expedition'` **(Claude)**, so the
inventory planner, `apply_inventory_plan` and the overflow sale need no change.

**Over-level band:** a member whose frozen level is above the dungeon's full-reward band (Wolf Den 8, Stronghold 12; Troll
Hall has none) gets `floor(0.5 × XP)` and `floor(0.5 × gold)` of its total and a salvage-only chest (no gear draw).

### 3.2 Hired fighters

Three roles per dungeon, each the prototype's representative build at the dungeon's required level, frozen in the catalog
as a build (class, stance, allocations, catalog equipment) and turned into a fighter with the real `makeFighter(build,
'expedition')`, then maximum health `max(1, floor(0.9 × health))` and base damage `0.9 × base damage` in exact fractions
(the `makeFallback` arithmetic) **(Claude: a build, not hand-typed stat lines, so the real derivation stays the source)**.

| Role (stance, class) | Wolf Den: allocations S/A/V/E/P · gear tier 1 | Raider Stronghold: · tier 5 | Troll Hall: · tier 10 |
| --- | --- | --- | --- |
| Guard (Defensive, Guardian): sword, round shield, iron helmet, light armor, light boots | 4/0/7/2/1 → 158 HP, 9.45 dmg, 952 ms, armor 9 | 6/0/12/5/2 → 205, 13.05, 952, 13.5 | 10/0/18/7/3 → 261, 17.55, 952, 18 |
| Striker (Offensive, Berserker): axe, leather hood, light armor, light boots | 8/1/3/0/2 → 117, 13.635, 1321, 4 | 13/2/7/0/3 → 153, 19.71, 1308, 6 | 20/3/10/0/5 → 180, 26.775, 1296, 8 |
| Skirmisher (Balanced, Duelist): sword, leather hood, light armor, light boots | 3/5/1/0/5 → 99, 9, 905, 4 | 5/9/2/0/9 → 108, 12.6, 872, 6 | 7/14/3/0/14 → 117, 16.2, 834, 8 |

Gear is the `:<tier>:common` variant of each template. Roles fill the empty seats in this order: the roles whose stance no
human in the party has, Guard, then Striker, then Skirmisher; any further seat is a Skirmisher. Hired fighters get no
rewards, rating, records, results, world actor or notification; logs show them as "Hired Guard" (etc.) with a null
`gladiatorId`, drawn in the NPC steel grey with a "Hired" tag.

## 4. Party combat (deterministic)

New pure module `domain/party-combat.ts`, `simulateSkirmish(input, seed)`, beside the unchanged two-fighter
`simulateBattle`. It reuses the v1 hit, critical, stance, armor and rounding rules: `combat.ts` exports `roundedDamage`
with an optional factor (folded into the exact product only when it is not 1, so every existing log is byte-identical).

- **Units:** 1–6 per side, ids unique, one shared retained rules version. Side 0 is the party (gladiators and hired
  fighters), side 1 the monsters. A unit's first attack is at its interval; the next at `elapsed + interval`.
- **Groups:** the units standing before a millisecond that attack at it resolve together against the health before the
  group (the existing simultaneous rule, generalised to N timers). Order inside a group: side 0 in unit order, then side 1
  in unit order. Damage applies event by event in that order; `healthBefore` / `healthAfter` are logged per event.
- **Party targets:** the standing enemy with the lowest health before the group; ties to the lower unit index. No draw.
- **Monster targets:** with one standing party unit, that unit and no draw; with two or more, a seeded weighted draw over
  the standing party units in unit order with weights Defensive 3, Balanced 2, Offensive 1: `r = random() × total`, the
  first unit whose running weight exceeds `r` **(Claude: no draw with a single target, as the proposal's text says; the
  prototype drew anyway, which changes the stream only)**.
- **The major's sweep:** every 4th attack of a `major` unit hits every standing party unit, in unit order, at 0.6× damage,
  with its own hit and critical draw per target. No target draw for a sweep.
- **Draw order per scheduled attack:** target (a monster with two or more targets, not a sweep), then for each target hit
  then critical (both drawn even on a miss), exactly as `simulateBattle` draws.
- **End:** after a group in which a side has no standing unit; or at 120 s (`combat.maximumDurationMs`). One side standing:
  it wins (`defeat`). Otherwise the higher total remaining-health fraction (sum of health / sum of snapshot maximum health,
  compared in exact integers) wins (`health-fraction`); an exact tie is a seeded draw, side 0 on `random() < 0.5`
  (`tie-break`, `simultaneous-defeat` when both sides fell together, else `equal-health-fraction`).
- **Log (`PartyBattleLog`, contracts/events.ts):** `battleId`, `rulesVersion`, `participants` (the `RevealedCombatant`
  whitelist plus `side`, `role: 'gladiator' | 'hireling' | 'monster' | 'major'` and `seat`, the party seat or null),
  `events` (the `attack` event plus `sweep: boolean`; a `victory` event with `winnerSide` and `reason`), `durationMs`,
  `winnerSide`, `victoryReason`, `finalHp` (one per participant, in participant order) and `tieBreakReason`. `BattleLog`
  is untouched, so `private.safe_battle_log` (exactly two participants) and every existing replay are untouched.

## 5. The run

`domain/dungeon.ts`, `planDungeonRun(input, seed, rules)`, the counterpart of `planExpedition`.

- **Input** (frozen by grouping, §6): run id, slot, dungeon, start time and 3 seats in order — a human seat carries its
  gladiator id, activity id, name, frozen level and frozen build; a hired seat its role.
- **Units:** a human is `makeFighter(build, 'expedition')` with id = its gladiator id; a hired fighter has id
  `hired:<seat>`, name "Hired Guard" / "Hired Striker" / "Hired Skirmisher"; monsters have ids
  `creature:<creature>:<fight>:<k>` (k from 1 in room order) and the major `creature:<creature>:4:1` with role `major`.
- **Fights:** fight n (1–4) at `n × 16 min`, battle id `<runId>:fight:<n>`, seed `<seed>:fight:<n>`. Party health carries;
  after a won fight 1–3 each standing unit recovers `floor(0.2 × maximum)` (capped at its maximum); a unit at 0 is left
  out of later fights. The run continues while any party unit stands (hired fighters may finish a run whose humans fell) and
  ends at the first lost fight. If a simultaneous defeat awards the party a room win with nobody standing, pay that
  room and wait at the safe point. No unit can enter the next fight.
- **Stages** (shared by every member; a member's stage id is `<activityId>:<ordinal>`):
  0 `depart` [0, 16 min) "Enter Wolf Den with Ari, Bo and a hired Guard" (every seat in seat order);
  fight n: `room` (n ≤ 3) or `major` (n = 4) [start, start + duration], "Room n: victory | defeat" or
  "Alpha of the Den: victory | defeat", with `fight: { runId, ordinal: n }`;
  after a won room: `exploration` until the next fight, "Recover and go deeper";
  after the won major: `travel` until minute 80, "Return to camp";
  after a lost fight: `return` until minute 80, "Rest at the safe return point";
  last: `return` [80 min, 80 min] "Arrive at camp". So 4 to 10 stages, revealed in order.
- **Outcome per human** (`DungeonMemberOutcome`): the fights it entered (a prefix of 1–4), the ones of those its party
  won, `overLevel`, and rewards `{ xp, money, loot }` = the sum of the won entered fights' rewards (§3.1), the chest only
  for a won entered major, loot from `<seed>:loot:<gladiatorId>` (a stream of its own, so fight draws never shift loot),
  halved and salvage-only above the band. `result: 'victory'` and `success: true` only when it entered the major and its
  party won it; otherwise `'defeat'` / `false` with whatever the won rooms paid (Avi's decision 7).

## 6. Grouping at the boundary

`domain/dungeon-grouping.ts`, `groupDungeon(input, seed)`; one fenced job per slot and dungeon at phase 7.

1. Each entrant's strength is `estimateArenaStrength(makeFighter(build, 'expedition'))`, compared in cents.
2. Sort: strength descending, then the seeded key `seededRandom('<seed>:dungeon:<gladiatorId>')()` ascending, then
   gladiator id. The result is independent of input order.
3. **Bands (Claude):** walk the sorted list; a band grows while its strongest is at most 2× (`matchmaking.
   maximumStrengthRatio`, exactly 2× allowed) the next entrant; otherwise a new band starts. So no group mixes strengths
   more than 2×, and an entrant who fits nowhere runs alone with two hired fighters.
4. Each band of m splits into `ceil(m / 3)` consecutive groups whose sizes differ by at most one, larger groups first
   (4 → 2+2, 5 → 3+2, 7 → 3+2+2): nearest strengths together.
5. Run k (from 1, in group order) gets id `dungeon:<slot>:<dungeonId>:<k>`; humans take seats 0.. in sorted order; hired
   roles fill the rest (§3.2).
6. Each run's seed is `encode(digest(<grouping job seed> || ':' || runId, 'sha256'), 'hex')`, written by acceptance (the
   Arena battle-seed exception).

## 7. Server integration (M30 from `supabase/sql/24-dungeons.sql`)

**No new job kind.** Grouping is a `pair` job with input `kind: 'dungeon-grouping'`; a run is one `simulation` job with
input `kind: 'dungeon'`; reveals are `reveal` jobs with input `kind: 'dungeon-reveal'`; members settle through their own
`settlement` jobs.

| Boundary phase | Dungeon addition |
| --- | --- |
| 4 Recompute | The prepare result's `costs` gain `dungeon`. `private.valid_preparation` accepts the old 5 keys or 6 with `dungeon` (deploy window) |
| 5 Snapshot | Unchanged: the choice is frozen with the build and level |
| 6 Stamina | `private.boundary_check_stamina`: a missing cost (an old preparation) now means Rest, not a null debit |
| 7 Pair | `private.boundary_pair` keeps Arena unchanged and adds one job `party:<slot>:<dungeonId>` per dungeon with resolved entrants; it waits with `'pairing'` (`'operator'` after three failures) and raises `ungrouped dungeon entrant` if one is left without a run |
| 8 Start | `private.prepare_activity_jobs` (dungeon branch): one simulation job `dungeon:<runId>` anchored to seat 0's activity and gladiator, carrying the run seed, due at the slot start; each member's settlement depends on it. `private.boundary_start` already takes every member's account lock in gladiator order before any job insert (the 40P01 fix), unchanged |
| Run accepted | `private.accept_dungeon_result` stores the plan in `private.dungeon_results` and creates **one shared reveal chain per run (Claude)**: a reveal job per stage ordinal, anchored to seat 0, due at the stage's time, each after the previous; every member's settlement depends on the last |
| Reveal | Writes every member's stage row (`public.activity_stages`, existing reveal RLS) and, for a fight stage, the run's one `public.dungeon_fights` row (the whitelisted log) |
| Minute 80 | Each member settles alone under its own locks with a worker-prepared grant: `public.expedition_settlement_input` and `public.settle_expedition` serve dungeon members too **(Claude: the worker's settlement path is already kind-agnostic, so it needs no change and the RPC names stay stable across the deploy)**; ledger reason `'dungeon'` |

**New tables.** `private.dungeon_runs` (run id, grouping job, slot, dungeon, seed, frozen assignment);
`private.dungeon_run_members` (activity id primary key, run, seat; unique run + seat); `private.dungeon_results` (run,
simulation job, plan, outcomes); `public.dungeon_fights` (run id, ordinal 1–4, reveal time, log; primary key run + ordinal).
Private tables: RLS on, `service_role` only, frozen by `private.guard_frozen`. `dungeon_fights`: SELECT for `anon` and
`authenticated` through a `due_read` policy on database time (as `activity_stages`), writes for `service_role` only.

**Changed SQL (restated from its latest source).** `activities.resolved_kind` check gains `dungeon`;
`private.planning_command` (18) accepts `{ kind: 'dungeon', dungeonId }` in the afternoon only, for a known id at the
member's level (3 / 7 / 12) and active v2, in `edit-schedule` and `edit-day-schedule`. `private.valid_preparation`,
`private.boundary_check_stamina` and `private.boundary_pair` all start from (21), keeping v2 Training and free tournament
behavior. `public.complete_job` (07) dispatches dungeon grouping
to `private.accept_grouping` and dungeon simulations and reveals to `private.accept_dungeon_result`;
`private.activity_executor_ready` (09) and `private.prepare_activity_jobs` (10) add `dungeon`;
`public.expedition_settlement_input` (05), `private.settle_activity_core` (10) and the new `private.dungeon_rewards`;
`private.project_character` and `public.owner_state` (22) add the `dungeon:<id>` location, activity label and dungeon
notifications while preserving full profiles, worn titles, owner progress and title notices. `private.cleanup_history`
(15) prunes dungeon fights, results, members and runs
in its 7-day pass (summaries keep 90 days). New: `private.grouping_input`, `private.accept_grouping`,
`private.safe_party_log`, `private.accept_dungeon_result`, `private.dungeon_rewards`. Callable helpers use `security
invoker`, `search_path=''` and API EXECUTE for `service_role` only. Trigger functions and cleanup remain inaccessible to
API callers. Read active rules with `private.active_rules_version()`. `private.economy_switches` stays owner-only.

Persist `dungeon: { id, terminalFight, partyWon }` on both settled summary reads so the approved result copy survives
replay expiry. `terminalFight` is 1–4 and `partyWon` is the result of that fight. A terminal room won with nobody left
standing is a safe return. The existing member result stays separate, including when the party clears after that member
falls. The public projection exposes these three fields and keeps reward amounts and receipts on the owner path.

**Dungeon titles.** The 1.7 design already assigns Den Breaker (Wolf Den clear), Warlord's End (Stronghold clear),
Kingslayer (Troll Hall clear) and Dungeoneer (25 clears) to 1.8. Start `private.title_rules()` from `23-awards.sql`,
retaining Game Master and High Ground. Increment the member's own clear count exactly once, on an entered and won major,
before awarding. Count positive dungeon gold in gold earned from play and use the existing ownership trigger for gear.
Preserve existing expedition win counts and the exclusion of named bots from Founder.

**Acceptance trusts canonical TypeScript amounts** (as preparation, pairing and Arena acceptance do) and checks shape and
identity: grouping — exact keys, run ids numbered `1..R` in order, exactly 3 seats numbered 0–2, humans first, at least one
human, each human seat equal to its frozen activity, build, level and name, every entrant exactly once; run plan — run id,
rules and catalog version, dungeon, 1–4 fights and 4–10 stages in time order inside the slot, each log through
`safe_party_log`, one outcome per human seat with its identity, safe integer rewards, well-formed loot, `success` true
exactly when `result` is `'victory'`.

**Accepted exceptions** (recorded in the source header, as 07–10 do):
1. Run seeds are derived from the grouping job's seed (Arena exception 2); the run's simulation job carries the run seed
   and is anchored to seat 0's activity (Arena exception 1).
2. Grouping acceptance inserts member rows whose foreign keys take KEY SHARE locks on the entrants' preparing activities
   (job before activity, as Arena exception 3; nothing else locks those rows while phase 7 waits).
3. One shared reveal per stage writes every member's stage (tournament exception 4): KEY SHARE locks on the members'
   activity rows after the reveal job row; a member's settlement waits on it through dependencies and locks no other
   member's rows.
4. Settlement lock order per member: account, character, wallet, sorted items, activity, job; time sampled after the locks
   (unchanged `settle_activity_core`). Members settle independently.
5. Restated constants: 960000 (`dungeon.fightIntervalMs`), 604800000 (`retention.replayMs`), the unlock levels 3 / 7 / 12
   and the afternoon (`schedule.dungeonPhases`). A rules version that changes them needs a new source.

All time-limited mutations go through the existing fenced paths. `complete_job` locks its job first. Settlement locks
account, character, wallet, items, activity and job in the existing order. Both sample `clock_timestamp()` after acquiring
the required locks and revalidate token, status and expiry. The reveal regression holds the lock until after expiry.

**Deploy window.** M30 first: with the previous worker, preparations keep 5 cost keys (accepted), no dungeon choice can be
saved (the previous Edge parser refuses it), and every existing path behaves as before. Deploy and verify `game-worker`
before deploying `game-command`, which first permits clients to save dungeon choices. Then release the client, post the
patch note and link it to the patch record. Each production write requires Avi's explicit go.

## 8. Contracts

- `commands.ts`: `DungeonId = 'wolf-den' | 'raider-stronghold' | 'troll-hall'`; `ActivityChoice` adds
  `{ kind: 'dungeon'; dungeonId: DungeonId }`.
- `events.ts`: `ActivitySummary.resolvedKind` adds `'dungeon'`; `RevealedStage.kind` adds `'room' | 'major'` and an
  optional `fight?: { runId: string; ordinal: 1 | 2 | 3 | 4 }`; `PartyRole`, `PartyCombatant`, `PartyAttack`,
  `PartyVictory`, `PartyBattleLog` (§4).
- `reads.ts`: `CurrentActivity.kind` and `GameNotification.kind` add `'dungeon'` (a dungeon notification's `destination` is
  the dungeon's name); `CampLocation` adds `dungeon:wolf-den | dungeon:raider-stronghold | dungeon:troll-hall`.
- `domain/types.ts`: `ActivityKind` adds `'dungeon'`; `Dungeon`, `DungeonMonster`, `HiredRole`.
- `GameGateway.dungeonFight(runId, ordinal): Promise<PartyBattleLog>`: one revealed fight's log from `dungeon_fights`,
  loaded on demand and cached like `tournamentLog`.

## 9. Client

**Mockup approval, 2026-11-07.** Avi answered “Approve the mockup (Recommended)” to `call_5cb7b19d35da43dcb461ee2230b7598a`.
The approved `mockups.html` is in the parent `logs/p18-mockup-20261107/` folder at SHA-256
`2f789653c8b9a3d633cd3c14861279dd6dcae25d1812ca729597af0a8a182576`. The final installed Chrome check covered 14 views
and 216 assertions each at 1440 × 900 and 360 × 740. It uses synthetic data, 24 real 1.7.1 screenshots and map layers from
the current assets. The visible reward amounts follow §3.1. The approval includes the bot tag and unranked Arena card,
four dungeon titles, separate room loss, boss loss and knocked-out member states, and the short mobile Watch control.
The prototype's fictional data, fight timing and sample playback are review aids. Product behavior follows §§4–8.

Screens:

1. **Schedule** (§2, item 1): dungeon options in the afternoon select, the afternoon-only note elsewhere, the description
   line.
2. **Run view** `/dungeon/?activity=<id>`: the expedition scene's map for the dungeon (Wolf Den woodland, Stronghold
   outpost, Troll Hall mountain), the party walking in formation (seat 0 leading), waiting monster groups at each fight
   spot (the waiting-monster rules extended to groups and the major), a five-segment strip (depart, three rooms, the
   major), the party's health bars from the logs, labels hidden while a fight is still being fought. The rooms are fought
   at the map's `encounter-1..3` points and the major at its `search-4` point, so no map changes **(Claude)**. A pure core
   `src/game/dungeon-stage.ts` derives everything from the revealed timeline, the fight logs and the display clock, as
   `expedition-stage.ts` does. **Reuse of Patch A** (its plan, `../plans/2026-10-29-patch-a.md`): live mode shows the
   same "● LIVE" badge and named marks (`TripBar`, `TripMarks`); the whole-trip replay is a Patch A `TripPlan` built by
   `planDungeonTrip` with four fight chapters (Patch A's `TripChapterId` gains `fight-4`) and played by its `tripFrame` /
   `tripPositionOf` at `TRIP_PACE` (walking sped up, fights at real speed); Patch A's away button (`awayState`) is also
   running for a dungeon (next fight at 16, 32, 48 or 64) and opens this view; times use its `timeOfDay` and clock
   setting.
3. **Party close-up replay:** up to 3 against up to 3 at integer scale, the major one integer scale larger with a tint,
   a sweep effect, normal/fast, pause, restart, skip, health bars from the log. Its own reducer
   (`src/game/party-replay.ts`) and stage planner (`src/game/party-stage.ts`); the Arena `replay.ts` /
   `battle-stage.ts` stay two-fighter. Route `/replay/?run=<runId>&fight=<n>`.
4. **Results and notifications:** a victory reads "Wolf Den cleared: the Alpha of the Den fell". Use the known terminal
   outcome for a boss defeat, room defeat or member knocked out before a party clear. A member defeat alone must never
   imply the whole party lost. The owner sees their XP, gold and items including room pay on a defeat. Visitors see
   the public outcome only. The run view has the fight details.
5. **Camp:** "In Wolf Den" on the roster; the actor leaves and returns through the expedition gate (`dungeon:` locations
   are away, like `expedition:`).

## 10. Balance targets (pinned by tests)

Measured by the product engine with the prototype's representative builds (points 14 / 25 / 38 at levels 3 / 7 / 12, the
class splits and common gear of `prototype/builds.ts`), 300 seeds per shape, fixed seeds (so the test is deterministic):

| Measure | Target (prototype) | Test band |
| --- | --- | --- |
| Full party (Berserker + Guardian + Duelist) at the required level beats the major | Wolf Den 90 %, Stronghold 88 %, Troll Hall 87 % | each within ±8 points of its target |
| Solo + 2 hired (mean of the three classes) | 45 %, 56 %, 51 % | each within ±8 points; no class below 35 % |
| Rooms 1–3 cleared by every reference shape | 100 % | ≥ 97 % |
| Full party at L5 / L10 / L15 | 100 / 100 / 99 % | ≥ 95 % |
| Solo run's expected XP ÷ the v2 comparison expedition's (Woodland 30, Outpost 75, Mountain 150) | Re-measure for v2 | 1.00–1.25 |
| Full party's expected XP ÷ the same | Re-measure for v2 | 1.35–1.65 |

If a band fails, tune in this order and re-measure: the major's health, then its damage, then `hiredMultiplier`; record
the final numbers here. A run plans in well under the worker's 2,000 ms invocation budget (measured, recorded).

## 11. Release

The gate of record (`node scripts/verify.mjs --config node_modules/.cache/pw-design-tcp.config.mjs --browser-shards 32 --results <fresh-dir> --json <file>`, 12/12, DB-test rule), a
fresh whole-branch review, then hosted read-only pre-checks. **Production needs Avi's go in chat** (with the patch note's
text) for each write, outside Wednesday and Saturday 17:20–20:00 UTC and with no open boundary. Follow the M28/M29
migration process and `--skip-vault` for dry-run and push. Confirm metadata with aggregate reads. Deploy and verify
`game-worker` before `game-command`, fast-forward `release` on Avi's go, verify live Pages, then post the approved note
and record on their own go. Finish the grandiose trailer using the playable test build before shipping.

## 12. Patch note (draft, posted with `private.post_message('patch-notes', …)` after the client is live)

- **Title:** Dungeons: team up in the afternoon
- **Preview:** Choose a dungeon for your afternoon. Players group first, then eligible bots and hired fighters fill open seats.
- **Body:**
  - p: "Dungeons are here. In your schedule, choose one for the afternoon (dungeons run in the afternoon only)."
  - li: "Wolf Den opens at level 3, Raider Stronghold at level 7 and Troll Hall at level 12."
  - li: "When the afternoon starts, players who chose the same dungeon form parties of up to three. Eligible bots and hired
    fighters fill open seats, so you can go even if no other player joins."
  - li: "A run is 3 rooms, then the boss, all in one afternoon. Health carries from fight to fight."
  - li: "Every fight you enter and your party wins pays you. The boss pays the most and opens a chest. Lose to the boss
    and you still keep what the rooms paid."
  - li: "Rewards are personal. Bots and hired fighters take no share."
  - li: "A dungeon costs 40 base stamina."
  - li: "Meet Ludus Nimbus, five named gladiators marked BOT. They can fill dungeon seats and fight in unranked Arena."
  - p: "Watch your run like an expedition and replay every fight. Inviting friends to your party comes in a later patch."

## 13. Decisions Claude made (inside Avi's go)

1. Dungeon ids and the creature drawn for each monster and major (§3.1).
2. Hired fighters stored as builds and derived with the real `makeFighter` (§3.2).
3. No target draw for a monster with a single target (§4).
4. Grouping by strength bands, then even splits inside a band (§6).
5. One shared reveal chain per run; the depart stage is revealed by that chain at minute 0 (not written at phase 8), as an
   expedition's is (§7).
6. Dungeon members settle through the existing `expedition_settlement_input` / `settle_expedition` RPCs; chest loot uses
   origin `'expedition'`; the ledger reason is `'dungeon'` (§7, §3.1).
7. A member's `victory` means it entered the won major; the run continues while any party unit stands (§5).
8. Shared stages for every member; the depart label names the whole party; a new route `/dungeon/`; the major fought at
   the expedition map's `search-4` point; result lines without per-room counts (§5, §9).
9. Stage kinds `room` and `major` with a fight reference; logs stored once per run in `public.dungeon_fights` (§7, §8).

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Multi-member runs across the boundary, job and settlement machinery (lock order, fencing, exactly-once) | Follow the Arena and tournament precedents exception by exception; the 40P01 and concurrent-settlement regressions; the full DB suite |
| Boundary time: afternoons gain a phase-7 wait (the publication measured 61.6 s at 50 characters with zero headroom) | One grouping job per dungeon, claimed in the worker's pairing loop; capacity test at 50 characters with half in dungeons before release |
| Cliff-shaped outcomes: a small stat change swings a run | Partial rewards; the seeded band test; tuning knobs in the catalog |
| Few players, so human parties are rare at first | Hired fighters make every run playable; afternoon only |
| Storage of party logs | Stored once per run, loaded on demand, pruned after 7 days; measured in the capacity task |
| Patch A's replay names differ from this spec's wording | The run-view task binds to Patch A's merged exports first and records them |

## 15. Ludus Nimbus bot team

The archived 2026-10-29 bot-team proposal records Avi's approval of the name, five members, fixed builds, off-duty
hours, crowd cutoff, tournament exclusion and 20% unranked Arena reward. Avi reaffirmed dungeons and unranked Arena on
2026-11-07. The production baseline is v2 and the bot schema shipped in M30. On 2026-11-08, Avi chose Cinder for the
level 7 skirmisher after the registration preflight found the original label Ash occupied. M31 changes the catalog
label before registration. The member key is still `ash`.

| Gladiator | Class and stance | Dungeon role | Fixed level |
| --- | --- | --- | --- |
| Tullia | Guardian, Defensive | Guard | 12 |
| Grit | Berserker, Offensive | Striker | 7 |
| Cinder | Duelist, Balanced | Skirmisher | 7 |
| Rufus | Guardian, Defensive | Guard | 4 |
| Pip | Duelist, Balanced | Skirmisher | 3 |

Camp and Arena loadouts reuse each role's hired build from the highest dungeon that bot can enter. This keeps the
existing gear silhouettes and legal v2 point budgets. Allocations are listed in Strength, Agility, Vitality, Endurance,
Precision order. Earned points equal the allocation total. Equipped items use the listed common catalog variants.

| Gladiator | Allocations | Weapon | Off-hand | Head | Body | Feet |
| --- | --- | --- | --- | --- | --- | --- |
| Tullia | 10 / 0 / 18 / 7 / 3 | `sword:10:common` | `round-shield:10:common` | `iron-helmet:10:common` | `light-armor:10:common` | `light-boots:10:common` |
| Grit | 13 / 2 / 7 / 0 / 3 | `axe:5:common` | — | `leather-hood:5:common` | `light-armor:5:common` | `light-boots:5:common` |
| Cinder | 5 / 9 / 2 / 0 / 9 | `sword:5:common` | — | `leather-hood:5:common` | `light-armor:5:common` | `light-boots:5:common` |
| Rufus | 4 / 0 / 7 / 2 / 1 | `sword:1:common` | `round-shield:1:common` | `iron-helmet:1:common` | `light-armor:1:common` | `light-boots:1:common` |
| Pip | 3 / 5 / 1 / 0 / 5 | `sword:1:common` | — | `leather-hood:1:common` | `light-armor:1:common` | `light-boots:1:common` |

- **Camp and schedule.** Each bot uses a deterministic weekly routine (126 slots), with ordinary choices, off duty and
  on-call afternoons. Off duty 00:00–08:00 UTC and when the boundary has at least 45 active human gladiators. Off duty
  actors stay in camp without a scheduled activity. Show the scheduled return in the viewer's clock when applicable.
  Active bots are exempt from the idle presence rule. The weekly patterns must fit stamina and obey current v2 rules.
- **Evening rotation.** Avi chose three Arena candidates and two Training bots each on-duty evening on 2026-11-07.
  Tullia is always a candidate. Rotate the adjacent pair in the circular order Grit, Rufus, Cinder, Pip, starting at
  `(UTC weekday from Monday + on-duty game day from 08:00) % 4`. The remaining two train. This keeps two Bronze
  options at different levels alongside Tullia. All five use Rest in the on-duty mornings and are on call in the
  afternoons, subject to ordinary eligibility. For absolute slot `s`, the UTC routine index is
  `((s - 72) % 126 + 126) % 126`. In each 18-slot UTC day the first six slots are off duty, then four Rest/on-call/evening
  triples follow. The exact five kits and all 630 routine cells are checked against SQL.
- **Dungeons.** Group eligible humans first using the regular strength bands. Add eligible on-call bots after humans
  and before hired fighters, within the original cap of `3 * ceil(humans / 3) - humans` bots per dungeon, with a bot in
  at most one run. Avi chose Troll Hall, Raider Stronghold, then Wolf Den on 2026-11-07. That reserves Tullia, the only
  level-12 bot, for an eligible Troll Hall cohort. Bots must meet
  the unlock level and never start a bot-only run. Unassigned bots train where their
  routine and v2 limit allow. A bot uses its role's hired build at that dungeon's level for combat. Its actual name,
  actor and BOT tag appear in the run and log. It earns no dungeon payout and the humans' per-member payouts stay fixed.
- **Arena.** Preserve real-player pairing first. A same-league bot within 25% of a player's frozen strength can replace
  only that player's NPC fallback. Prefer the bot met least recently. No bot occupies a tournament seat. A human's bot
  bout pays `floor(0.2 * amount)` for each normal player-bout currency under the retained rules. No rating, standings or
  season qualification change for either side. Avi chose private Arena practice for a scheduled bot with no player
  match on 2026-11-07. Practice keeps the bot at the Arena and creates no public bout or reward. Existing human/NPC
  paths stay intact.
- **Identity and safety.** Bot identities are registered by an operator behind owner-only create/bench operations, with
  system Auth accounts that have no sign-in method and are banned. An active bot cannot submit player commands. It has
  a fixed level and build, no market/shop actions or economic grants. Preserve exactly-once internal processing. Bots
  never qualify for Founder. Other title measures use the same applicable activity rules without inventing rewards.
- **Disclosure.** The sky-blue BOT tag accompanies the name in camp, roster, profile, Arena, dungeon and replays.
  Group bots under Ludus Nimbus in the roster. Show their separate count, team, off-duty state and unranked status.
  No NEW tag or arrival announcement. No bot-only result, reward notice or standing appears as a human entry.
- **Rollout.** M30 installs the schema and routines with no active bot identities. Create and activate bots only after
  the worker, command and client understand the tag and the unranked routes, on separate explicit production approval.
  Keep operator actions and aggregates auditable. Test the 44-human plus five-bot case and the 45-human cutoff.
