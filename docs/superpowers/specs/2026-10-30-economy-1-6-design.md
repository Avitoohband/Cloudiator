# Patch 1.6: the economy rebalance (design)

**Adopted amendment, 2026-11-02.** Root self-reviewed the reconciled V5 amendments on completed integration `67fd7c310fd487a9d2f53091b1f4e471a28665fc`, preserving economy `5919fa1` and released/post-doc `09a5bde`. The incoming October 31 notes are superseded by Avi's binding actual-Training/ordinary-Rest decision below; free formed v2 brackets remain. Original V5, exact source captures, reconciliation diffs/checks and independent review are retained in parent `logs/p16-merged-plan-candidate-20261102-7b3cd891/`. Actual adoption identity is recorded in parent `logs/p16-plan-adoption-20261102-67fd7c3/` and this document's Git history. Tasks 1–3 history is preserved. Tasks 4–10, daily-limit/SQL runtime proof, the economy gate, notice approval and irreversible activation remain pending. Avi's separate scoped layout/source-reference approval is recorded below; no production authority is inferred.

Date: 2026-10-30. Author: Claude. Status: **decided by Avi through question forms** (2026-10-29/30) on the
[economy proposal](../../../.superpowers/design/2026-10-29-economy/proposal.md) (local, ignored by git; this spec carries
everything an implementer needs). Plan: [2026-10-30-economy-1-6.md](../plans/2026-10-30-economy-1-6.md).

Decisions are marked **Avi** (his answers in the question forms) or **Claude's call** (made while writing this spec; Avi can
overrule any of them). Numbers come from a scratch slot model (18 slots a day, 100 stamina, every expedition won at the
best safe stage: Woodland at levels 1–4, Outpost at 5–11, Mountain from 12), the proposal's model re-run on 2026-10-30 for
Avi's harsher option. It reproduces the proposal's v1 table exactly. No production data was read.

## Reconciliation checkpoint — 2026-11-02

The incoming release record, [current 1.5.1 checkpoint](../../implementation/PATCH-1.5.1-VERIFICATION-HOLD-2026-11-02.md), supersedes v5's old pending-NPC snapshot: exact client candidate `9e41caebdafe4c37978b07df663d25227d80c9b4` passed the accepted native32 12-stage gate, was deployed to fresh Pages UUID `43258204-1a66-41b6-b7b5-0519c6cb9c51`, and completed the distinct deployed checks, existing note/record readback and next-completed-boundary/hosted-health proof for slot 373677. Post-release documentation is `09a5bde5245a65991f54b84afaa7b98ff97556f6`. This is retained NPC evidence, not an economy gate; preserve failed Linux/native attempts and their limits as history. Never republish note 7 or record 1.5.1. Human Google sign-in and physical-phone attestation remain unclaimed.

Design integration `67fd7c310fd487a9d2f53091b1f4e471a28665fc` is committed and pushed, preserving both parent histories. The Task 1 carry is complete: `PATCH='1.6'`, CHANGELOG order 1.6 > 1.5.1 > 1.5 > 1.4 and “New since then” includes the shipped patches. Root's actual existing RED was `tests/domain/patch.test.ts:45` (2,241/2,242 passed; top section 1.6 versus PATCH 1.5.1). After the correction, all 2,242 tests in 126 files and complete validated offline `npm run typecheck` passed, with index/source stable during the final run and independent integration review clear. Evidence: parent `logs/p16-integration-20261102-09a5bde/{ROOT-ACCEPTANCE.json,safe-summary.json,REVIEW.md}`. These retained integration results are not new daily-limit/free-entry proof, DB tests or a 1.6 release gate. This candidate runs no product tests.

The V5 mockup has actual offline QA across 20/20 views (552 assertions, 89/89 protected inputs, zero failures). Avi explicitly answered “Approve layouts (Recommended)” on 2026-11-02 for Schedule, registration, season prizes and Arena banner/shop layouts, accepting sample characters/old fixture dates, hypothetical banner ownership and adapted capture backgrounds/crops as preview references. The UI/source-gap approval gate before client Tasks 8–9 is satisfied; implementation uses live components and live game data, never prototype screenshots as screen assets. Durable authority: parent `logs/p16-ui-approval-20261102.json`, selected candidate3 prototype SHA256 `e4822b1630e5657a3a34fbd95d2a661ee5bf534cbfe65de450cedcabdd51dc17`. Historical mockup-preparation instructions/captions below remain history and do not reopen this scoped approval. It authorizes no economy notice, activation, production write or test/gate waiver. Preserve the merged AGENTS offline/no-download path, native gate/audit-reader guidance and separate local-stack ownership transfer. Future level-20/base-100 cap ideas are outside 1.6; its point cap remains `10 + 4 × level`.

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
3. **Two actual Training activities per game day (Avi).** Excess v2 requests become ordinary Rest with zero Training debit and normal recovery; warn before saving and accept the plan. This limit is separate from the point cap.
4. **A Training cap (Avi).** Training gives a point only while the gladiator has fewer than 10 + 4 × level points. At the
   cap it gives nothing, and the Schedule says so.
5. **Salvage sells for 4 gold, not 10 (Avi),** after a day's warning in a game message posted before the release.
6. **Live players (Avi):** everyone's gold is cut to a quarter when 1.6 ships; levels, items and renown stay; season 1 pays
   its promised prizes.
7. **The Arena banner is shown** (Claude's call, see "The Arena banner").
8. Old activities are never paid on new rules: whatever was frozen under `v1` settles under `v1`.

## Non-goals

- **Later patches only, not in 1.6:** party dungeons and the bot team (patch **1.8**, on v2 rewards from the start); the
  renown skins shop with dyes for clothes and weapons (**1.7 or 1.8**); new gear and attribute requirements (**a later
  patch**); the Deep, the weekly solo delve (**after the dungeons**).
- Item prices, NPC gear sale values, market fees, Arena renown, the XP curve (100 × level a level), leagues and the
catalog do not change. Regular Arena remains 25 base stamina; the one stamina change is free v2 tournament entry. Gold a player keeps buys exactly what it bought before (apart from the quarter cut).
- Friends feature 46 (standalone, after 1.6) and per-device Audio feature 47 remain future work; neither belongs to the economy. Future level-20/base-100 cap ideas are also outside 1.6; retain `10 + 4 × level` here.
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
| Max 2 actual Training/game day; excess ordinary Rest, warn before save and accept plan | Avi, 2026-11-01 resolution |
| V2 tournament bracket entry 0 stamina; ordinary Arena stays 25 base | Avi, 2026-10-31 |
| 1.6 is the economy alone; dungeons and the bot team move to 1.7, then 1.8 when titles took 1.7 (Avi, 2026-10-30) | Avi |
| Item prices stay | Avi |
| Expedition gold **4 / 10 / 18** (Woodland / Outpost / Mountain) | Claude's call (within Avi's "less than a quarter") |
| "Scaled the same way" read literally: factors 0.4 / 0.6 / 0.8 / 1.0 on today's gold, for tournaments and seasons alike | Claude's call |
| Renown prizes unchanged in every league (renown has nothing new to buy until the skins shop) | Claude's call |
| Gear drop chance halved to 10 / 15 / 20 %, as the proposal's v2 table had it (Avi's answers left that row as proposed) | Avi confirmed 2026-10-30 |
| `RULES_V2`, keyed by the boundary that froze each activity; an operator switch with Avi's go starts it | Claude's call |
| The cut is part of that one owner-only switch function, idempotent and audited, not a migration data step | Claude's call |
| The cut rounds up (a quarter of 3 gold is 1) and never touches gold held for a queued fee | Claude's call |
| A season pays the prizes of the rules version that opened it (season 1: today's) | Claude's call |
| The Arena banner is shown on the profile card, not removed with a refund | Claude's call (recommended) |
| The day-ahead message tells players about the gold cut as well as salvage | Avi confirmed 2026-10-30 |

## The numbers

### What changes (`RULES_V1` → `RULES_V2`)

| Rule | Today (v1) | 1.6 (v2) |
| --- | --- | --- |
| Expedition XP (Woodland Path / Ruined Outpost / Mountain Pass) | 100 / 250 / 500 | **30 / 75 / 150** (× 0.3) |
| Expedition gold | 20 / 60 / 120 | **4 / 10 / 18** (20 %, 17 %, 15 %) |
| Salvage a run | 1 / 2 / 3 | unchanged |
| Salvage sold to an NPC (and an overflowing unit's value) | 10 gold | **4 gold** |
| Gear drop chance | 20 / 30 / 40 % | **10 / 15 / 20 %** (Avi confirmed 2026-10-30) |
| Training points | 1 point, no limit | 1 point while earned points < **10 + 4 × level**, else 0 |
| Actual Training activities per game day | unlimited | **2**; excess requested Training becomes ordinary Rest |
| Tournament entry stamina | 25 base | **0**, including overload; ordinary Arena stays 25 base |
| Tournament and season gold | the same in every league | **by league** (tables below) |
| Tournament and season renown | 50 / 30 / 15 / 5 and 100 / 60 / 40 | unchanged |
| Prices, NPC gear values, fees, Arena renown, XP curve, leagues, catalog | | unchanged |

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
  boundaries. Deploying M27 and the functions does not activate the v2 economy or quarter wallets: v2 is inactive until the switch. The separately deployed new client may already show its banner and non-economy copy; economy values remain v1 until activation.
- **What reads the active version, and only these:** a new boundary (SQL, as today); an NPC sale of salvage (Edge, at
  command time, and SQL's salvage price fence when the sale is applied: the salvage race addendum below); the client's
  texts (from the public revision read).
- **A season pays the version that opened it.** Boundary phase 2 stores its boundary's version on the new season row;
  season 1's row is `v1`.
- **The catalog stays `CATALOG_V1`** for both versions: SQL accepts only catalog `v1` items and plans, and no item changes.
  Everything that differs between the versions is in the rules: expedition XP, gold and gear chance
  (`expeditionRewards`), the salvage value (`inventory.salvageSellValue`), the cap (`progression.trainingCapBase`,
  `trainingCapPerLevel`, `maxTrainingActivitiesPerGameDay`), tournament entry (`activityStamina.tournament`), and the prize tables (`tournament.placementsByLeague`, `seasons.placementsByLeague`).
- `RULES_V1` and `CATALOG_V1` keep every value; a test pins them. Both versions stay registered in the worker until a later
  patch proves no `v1` job is left (runbook query).

### `RULES_V2` (exact)

`RULES_V2` has every key of `RULES_V1` with the same value, except:

```ts
version: 'v2',
progression: { trainingPoints: 1, xpPerCurrentLevel: 100, levelAttributePoints: 0, levelStaminaRefill: 0,
  trainingCapBase: 10, trainingCapPerLevel: 4, maxTrainingActivitiesPerGameDay: 2 },
activityStamina: { training: 20, rest: 0, expedition: 30, arena: 25, tournament: 0 },
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
  else 0), `trainingDailyLimit(rules)` (`null` for v1, `2` for v2), `tournamentPlacements(rules, league)`, `seasonPrizes(rules, league)`, `salvageSellValue(rules)`.
- The consumers take the rules instead of reading `RULES_V1`: `validateBuild` (stamps `rules.version`), `planExpedition`
  (any retained version equal to its snapshot's; rewards and gear chance from `expeditionReward`), `placementGrants` (the
  graph's version and league), `planInventoryGrant` and `npcSaleValue` (the salvage value and capacity from the rules).
  Each defaults to `RULES_V1`, so a caller that passes nothing behaves as today.

### Worker (`game-worker`) and trusted daily Training history

Every executor is written once over its retained rules object; `DEFAULT_EXECUTORS` retains both versions and the `…V1` wrappers. A job's frozen version chooses its rules. Keep the existing v1 build stamps in backend/database.ts and the existing prepare restamp; stored builds and `deriveStats(..., RULES_V1)` are intentionally paired. Preserve v1/catalog hash pins and copied-rules identity rejection.

The point cap and daily activity allowance are independent. `trainingPoints(rules, level, earnedPoints)` still returns 0 at `10 + 4 × level`; an actual zero-point Training still costs normal stamina and consumes one of the two activities. An insufficient-stamina request resolved as Rest consumes none. The daily excess route is ordinary Rest, with zero Training debit and full normal recovery when Rest settles; it is not zero-point Training. Existing repeating three-Training schedules and old-client saves remain accepted.

Builder-chosen wire additions in `domain/types.ts`:

```ts
// PreparationInput: optional for historical v1 only; required for v2.
trainingActivitiesEarlierInDay?: number;
// PreparationResult and ActivitySnapshot: required boolean for v2; v1 omission accepted/ignored.
trainingAllowed?: boolean;
```

For target slot `t`, SQL freezes the count from permanent `private.settled_slots` for this gladiator, `resolved_kind='training'` and `t - (t % 3) <= slot_index < t`. Count actual Training across all retained versions, including v1 earlier in the activation game day. Do not count requested kinds, schedules, attribute-point changes, notifications or real-calendar days. Phase 1 settles the preceding slot before preparation; the count is immutable job input under the existing dedupe key. Retry/replay uses the same frozen input. Catch-up uses target arithmetic; morning starts an empty interval; idle/orientation slots contribute none. Permanent checkpoints survive activity pruning.

`prepareActivity(input, rules)` fails with `WorkerFailure('invalid-input')` for a v2 count that is absent, not a safe integer, negative or greater than `slotIndex % 3`; also validate the slot as a nonnegative safe integer. It emits `trainingAllowed = count < trainingDailyLimit(rules)` for v2. It keeps point calculation independent. V1 inputs without the new field and already-frozen v1 resolutions/rewards retain their existing behavior, including a third Training.

SQL's latest `valid_preparation` validates the v2 input count and requires a boolean equal to that frozen comparison; a forged boolean or malformed input fails closed. `boundary_snapshot` validates the accepted v2 preparation before copying `trainingAllowed`; `boundary_check_stamina` rejects a missing/malformed v2 snapshot boolean rather than treating it as true/zero. For v2 Training and `trainingAllowed=false`, resolve ordinary Rest before affordability: `resolved_kind='rest'`, `fallback=false`, `stamina_debit=0`. Otherwise retain normal affordability/fallback logic. Preserve immutable snapshot/input guards, once-only debit, checkpoint/grant replay and normal Rest settlement. Use SQL15's latest idle-aware `boundary_start`; do not regress it to SQL03.

Expedition settlement plans inventory grants with its frozen version through required `prepareGrant(..., rules)`: overflowing salvage remains 10 under v1 and 4 under v2. Unknown/mixed versions retain `unsupported-rules` failures.

### Free v2 tournament routing

`partitionTournament(slot, candidates)` retains its signature and shared retained-version validation. For v2, qualification is Arena requested, opted in before cutoff, tournament slot and league minimum; stamina does not disqualify a valid bracket entrant. Form each league's bracket before ordinary-Arena affordability fallback. V2 entrants in a formed bracket route to tournament with debit 0; otherwise ordinary Arena costs its frozen Arena price (25 before overload), or becomes insufficient-stamina Rest. V1 routing, including its old affordability checks, is retained.

Builder-chosen narrow SQL guard: `private.economy_tournament_slot(target bigint) returns boolean`, SQL immutable/invoker/search_path empty, is true for nonnegative target with `target % 126 in (50,122)` (Unix-epoch slots: Saturday/Wednesday 18:40 UTC). This is an explicitly documented restatement of the retained tournament calendar for v2 promotion only, pinned across a whole week and later weeks against `isTournamentSlot(slotAt(target * RULES_V2.clock.slotMs), RULES_V2)`. Keep EXECUTE owner/service_role only. Other v1 partition behavior remains trusted as before. The v2 promotion guard additionally checks requested Arena, frozen opt-in true, frozen v2 version/league/cost0 and a complete league bracket of at least two such candidates. A result cannot promote an ineligible preliminary Rest on an arbitrary slot.

SQL09's latest pairing functions need restatement in SQL21. Keep phase 6's preliminary affordability result, but discover v2 requested-Arena candidates even when every candidate is preliminary Rest. `pairing_input` retains both affordable and rested candidates. `boundary_pair` must enqueue the league even when no resolved Arena exists. `accept_pairing` uses frozen version/cutoff/choice/opt-in/league/minimum/costs and complete candidate coverage to permit preliminary Rest to tournament only for a valid v2 bracket at zero debit; it must reject Rest to ordinary Arena, forged promotions, wrong/duplicate/missing entrants and wrong costs. Retain `valid_bracket` and exact regular-Arena assignment coverage. After acceptance, `boundary_pair` adopts both prior Arena and valid prior Rest entrants to `tournament`, debit 0 and `fallback=false` before start. Their settlement is tournament, so no accidental Rest refill. A v1 or non-bracket Rest remains Rest.

### Edge (`game-command`)

- **Selling salvage** reads the active version (`world_revision.rules_version`, a public column, read beside the owner
  state) and prepares the unit value with it: 4 under v2, stamping the preparation privately with that version.
  **Salvage race addendum (Task 6):** SQL no longer trusts the Edge's unit value for salvage. After the account guard
  and the receipt replay, `private.inventory_command` (`supabase/sql/21-economy.sql`) reads the active version afresh;
  a preparation stamped with another version (or unstamped, which means v1) returns the transient `unavailable` before
  any write, so the same operation can be retried, and a price other than that version's (10 under v1, 4 under v2) is
  `invalid`. A sale prepared a moment before the switch and applied a moment after is therefore **not** paid 10: it
  returns `unavailable`, and its retry is paid 4. A sale that holds the account guard before the switch reaches it is
  paid 10 at v1, and the switch, waiting for that guard, then cuts the credited wallet. A committed receipt still
  replays unchanged across the switch.
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
6. **Daily Training and free tournaments:** restate the latest prepare/snapshot/validation/stamina/pairing bodies in SQL21 with the contracts above. No new public history read is needed for the selected generic warning.
7. ACLs (trigger functions: no EXECUTE for anyone; `season_prizes`: service_role; the switch: owner only), `notify
   pgrst, 'reload schema'`.

The M27 seal compares the exact source CHECK text for the two added `rules_version` columns: `public.world_revision_state.rules_version` and `public.seasons.rules_version`. Existing public tournament projection, column whitelist, private-column denials and read contract stay unchanged.

The Tournaments Registration section describes active/future entry and league-prize rules using active display rules. An old tournament's actual owner credit remains the existing `creditedText(summary)` result from its settled summary; never recalculate those credited amounts from today's rules. There is no new per-bracket prize/rules panel or historical public metadata requirement.

M27 adds version-gated v2 preparation input/result/snapshot fields. A historical v1 job remains valid and unchanged. All SQL and read/ACL changes are complete before Task 7 seals M27; Tasks 8–9 contain no new SQL. Never silently edit a committed migration.

### `private.switch_to_economy_v2() returns jsonb` (owner only; separate activation go)

One atomic transaction, owner only. Builder choice: reserve two-int advisory key `(1600001, 1)` for the wallet population guard, separate from the existing bigint account keys. Restate the latest `public.create_gladiator(actor_id uuid, operation_id uuid, input jsonb)` from SQL17 in SQL21 and take `pg_advisory_xact_lock_shared(1600001, 1)` before its account advisory lock, on all valid creation/replay paths. Preserve all appearance, receipt, starter-item and ACL behavior. The switch takes the exclusive counterpart after coordinator/replay/refusal checks and before any account lock. A creator that obtains its shared guard first commits/rolls back before switch enumeration; a later creator waits until switch commit and then receives normal unchanged starting gold. Review every wallet insertion path after merging the released line; all real creation paths must obey this fence.

Switch order: coordinator row → population guard → account locks in ascending gladiator-ID order → each gladiator row → wallet row; projection/revision writes are the tail. Creation takes population → account → its rows and keeps deferred projection publication last. No projection flush/revision update occurs inside the wallet loop. Guarded enumeration follows the exclusive wait, under READ COMMITTED with a fresh query snapshot. Builder choice: reject non-READ-COMMITTED operator transactions with SQLSTATE 55000 `unsupported transaction isolation` so an old transaction snapshot cannot omit a creator that just committed.

1. Lock `private.coordinator`; a concurrent coordination answers busy. Replay a committed v2 audit result with `replayed:true`, changing nothing. A replay is immutable receipt replay, not authorization of another cut.
2. Before writes, refuse SQLSTATE 55000 for an open boundary (`open boundary`), active version other than v1 (`unexpected rules version`), missing v2 (`missing v2`), or the isolation guard above. Take the exclusive population fence, draining earlier creators before enumerating.
3. Enumerate wallet IDs/owners only, sorted by gladiator ID. For each, acquire the account/gladiator/wallet guards; **then reread** current wallet money and sum of `status='held'` fee reservations. Never use pre-wait cursor balances/held sums. Let spendable=`greatest(money-held,0)`; cut=`spendable - ceil(spendable/4)`. Money never falls below held gold. Include every scanned wallet, even cut=0, in totals and `walletsScanned`.
4. For cut>0 only, write one operation receipt with request `{"kind":"economy-cut","version":"v2"}`, digest `sha256('economy-cut:v2:' || gladiator_id)`, result `{moneyBefore,moneyAfter,cut}`, the debit, and one linked ledger row (`money_delta=-cut`, `renown_delta=0`, reason `economy-cut`). Retain all acquired account locks until transaction end.
5. At the tail set v1 inactive, v2 active, publish the revision through the deferred mirror/projection mechanism and insert the owner-only audit. Record `switched_at_ms` from database `clock_timestamp()`, `wallets_scanned`, `wallets_cut`, `money_before`, `money_after`, `result`. Return `{ok:true,version:'v2',switchedAtMs,walletsScanned,walletsCut,moneyBefore,moneyAfter,replayed:false}`. Exactly one immutable v2 audit exists after success.

All writes, active rules, audit, receipts, ledger and revision roll back together on a late exception/deadlock. The operator stops on a refusal/failure and reports it; there is no retry loop and no undo function. A deliberate later operator call after diagnosis can succeed once; committed replay does not cut new/post-switch wallets.

`scripts/economy-switch-check.sql` is one read-only, aggregate-only precheck with `checked_at_ms`, `open_boundary`, `active_version`, `v2_row`, `switched`, `wallets`, `money_now`, `money_after_cut`, `held`, `copy_matches`. It is advisory at its own timestamp. Do not require its money totals to equal a later cut: live commands may legitimately mutate balances between statements.

Committed reconciliation is authoritative: returned result equals persisted audit result; cut receipt count and uniquely linked `economy-cut` ledger count equal `wallets_cut`; all receipt before/after/cut fields agree with each linked debit; ledger delta sum equals `money_after-money_before`; zero-cut wallets are included in audited totals/scanned count but have no cut receipt/ledger. Verify active rules/public mirror v2 immediately, then promptly publish the truthful note/record as below; separately verify the next completed boundary/jobs v2 and health after publication. Do not compare immutable historical money-after to a live wallet sum after commands resume, and do not link ledger rows by timestamp range.

## Client

- **The active version:** the revision read (every client, visitors too; visible tabs refresh 30 s after the previous refresh settles and on focus/return/start) asks for `rules_version` beside
  Patch 1.4's `latest_patch`; `displayRules(version)` is `RULES_V2` for `'v2'` and `RULES_V1` for anything else (missing,
  malformed, an unknown `'v3'`), never throwing. The fixture world answers `'v2'`.
- **Schedule:** the point-cap line from owner progression plus a visible, accessible generic daily-limit warning whenever the v2 draft contains any Training. Show it before Save, keep Save enabled and accept single-phase/whole-day/legacy plans. No new owner-history read, exact daily-count claim or schedule-derived historical count is introduced. Preserve expected-version conflict handling and same-operation retry.
- **Rest projections:** thread retained rules into `activityCosts`/`projectRest`. Current frozen activity/stamina is authoritative; never replay its debit. A future walk affected by v2 Training with unknown actual daily history returns `null` (generic `restHint(null)`); do not infer history from the edited draft. A future opted-in Arena tournament slot may become a zero-cost bracket, paid Arena or insufficient-stamina Rest: if these routes can change the downstream refill and the bracket is not frozen, suppress its exact number. Preserve pending-build, idle-rest and unprocessed-boundary guards; a clock behind `processedSlotIndex` must not replay processed activities. Historical v1 paths retain their old behavior.
- **Notifications:** a Training that earned no point says so (copy below) instead of "No rewards".
- **Inventory and market:** salvage's NPC value from the active rules (4 under v2); gear values unchanged.
- **Tournaments:** entry requirements and all stamina/threshold copy distinguish zero-cost v2 bracket entry from paid regular Arena; one extra Registration rule lists future league prizes using active display rules. An existing BracketView continues showing actual credited summary amounts, including v1 rewards after v2 activation.
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

- v2, below the cap: `Practice yard: +1 attribute point, up to {cap} at level {level} (you have {earned}). When Training runs, it costs {cost} stamina.`
- v2, at or above the cap: `Training is full: {earned} points, and level {level} allows {cap}. It gives nothing until level {next}. When Training runs, it costs {cost} stamina.`
- v1 (before the switch): unchanged, `Practice yard: builds experience. Costs {cost} stamina.`

`cap` = 10 + 4 × level; `next` = ⌊(earned − 10) / 4⌋ + 1, the first level whose cap is above `earned`; `cost` is Training's
stamina (20). Examples: level 1 with 10 points: "Practice yard: +1 attribute point, up to 14 at level 1 (you have 10).
When Training runs, it costs 20 stamina." Level 1 with 94 points: "Training is full: 94 points, and level 1 allows 14. It gives nothing until
level 22. When Training runs, it costs 20 stamina."

### Generic daily-limit warning (Schedule, linked to Save)

Builder-chosen copy: `Only two Training activities can run per game day (morning, afternoon and evening). After two, another Training request becomes Rest, costs no Training stamina and refills stamina when it ends. Training at the point cap still uses one of the two activities.`

V2 shows it for any draft containing Training, including a one-Training mid-day replan; no confirmation dialog or rejection is required. An excess request resolves as ordinary Rest and does not produce a Training-finished/no-point notification or the false “not enough stamina” explanation.

### Tournament entry stamina (Schedule and Tournaments)

Builder-chosen v2 copy: `Tournament entry costs 0 stamina. Choose Arena and opt in before the cutoff; a bracket needs at least two entrants in your league. If no bracket forms, regular Arena still costs {arenaCost} stamina and needs enough stamina.` Values come from retained rules. V1 entry text remains unchanged. Registration and the future Schedule use active display rules. Existing historical credited rewards come from their actual settled summaries.

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
  - li: `Training will give points up to a limit that grows with your level. Only two Training activities can run per game day; another request becomes Rest. Points you already have stay.`
  - li: `Tournament entry will cost no stamina. Regular Arena will still cost stamina.`
  - li (only while season 1 runs): `Season 1 ends on 22 Nov with the prizes it promised.`
  - p: `The patch note will explain everything once the patch is live.`

The warning explicitly names the quarter-gold cut (Avi confirmed 2026-10-30). Obtain his go on the final filled-in wording and announced time; recompute actual block/length limits from the final payload before posting.

### Patch note draft (posted after the switch, kind `patch-notes`, no action)

- Title: `A new economy: slower levels and prizes by league`
- Preview: `Levels and gold come more slowly, prizes depend on your league, and Training has a limit. Everyone's gold was cut to a quarter.`
- Body:
  - p: `What changed:`
  - li: `Expeditions give less. The Woodland Path pays 30 XP and 4 gold, the Ruined Outpost 75 XP and 10 gold, and the Mountain Pass 150 XP and 18 gold. Level 10 now takes about three weeks of Training, Expedition and Arena days.`
  - li: `Gear is found half as often on expeditions, and salvage sells to merchants for 4 gold.`
  - li: `Tournament gold depends on your league: a win pays 40 gold in Bronze, 60 in Silver, 80 in Gold and 100 in Champion, and second place and the semifinals are scaled the same way. Renown prizes are unchanged.`
  - li: `Season gold prizes depend on the league too, from the first season that starts after this patch: first place pays 200 gold in Bronze, 300 in Silver, 400 in Gold and 500 in Champion. Season 1 pays the prizes it promised.`
  - li: `Training gives a point until your gladiator has 10 + 4 × its level in points. At that limit Training gives nothing until the level allows more. Only two Training activities can run per game day; another request becomes Rest, costs no Training stamina and refills stamina when it ends. The Schedule warns before saving. Points you already have stay.`
  - li: `Tournament entry costs no stamina. If no bracket forms, regular Arena still needs its normal stamina.`
  - li: `Everyone's gold was cut to a quarter when the patch went live. Levels, items, points and renown stay, and shop prices are unchanged.`
  - li: `The Tournaments rules list the prizes by league, and the season card shows each league's prizes.`
  - li: `The Arena banner now shows on your profile card.`

This remains a draft for release wording review. Gear halving is already confirmed; do not offer the superseded unchanged-gear alternative. Validate the actual message limits after the added daily-limit and tournament lines.

### CHANGELOG.md bullets (the server's patch rows; plain text, one line each)

1. `Expeditions give less XP and gold: 30 XP and 4 gold on the Woodland Path, 75 and 10 on the Ruined Outpost, 150 and 18 on the Mountain Pass. Level 10 takes about three weeks.`
2. `Gear is found half as often on expeditions, and salvage sells to merchants for 4 gold.`
3. `Tournament gold depends on the league: a win pays 40 in Bronze, 60 in Silver, 80 in Gold and 100 in Champion, the other places scaled the same way. The Tournaments rules list them.`
4. `Season gold prizes depend on the league from the next season, up to today's: 200, 300, 400 or 500 gold for first place. The season card shows every league's prizes. Season 1 pays what it promised.`
5. `Training gives a point below 10 + 4 × its level in points, and at most two Training activities run per game day. Another request becomes ordinary Rest at no Training cost; the Schedule warns before saving. Points you have stay.`
6. `A Training that gave no point says so in Notifications.`
7. `Everyone's gold was cut to a quarter when 1.6 went live. Levels, items, points and renown stayed, and shop prices did not change.`
8. `The Arena banner shows on your profile card.`

9. `Tournament entry costs no stamina. Regular Arena still costs its normal stamina when no bracket forms.`
10. `The profile card's Damage row shows just the number, as Health does.` The Damage row reads "Damage 14", no longer "14 a hit"
    (Avi, 2026-11-04).

**Release copy review for Avi** (builder copy and late additions, for Avi to confirm with the patch note wording at release):
- bullet 10 above (Avi asked for the change; the bullet's words are the builder's);
- `src/features/schedule/schedule-text.ts:97`: the Arena line's order under v2: the bout, the cost, then the tournament and
  its free entry;
- `src/features/tournaments/tournament-text.ts:98`: v2 Registration rule 6, "Tournament entry costs 0 stamina.";
- `src/features/tournaments/TournamentPanel.tsx:122`: the checklist's stamina line under v2,
  "<stamina> · 0 stamina for tournament entry".

Patch title (the 1.6 row and CHANGELOG heading): `A new economy: slower levels and prizes by league`.

## Release (routine writes authorized; warning and activation retain separate gates)

Avi's current broad go covers routine planned release writes. It does not replace the filled D-1 warning/text/time go, at least 24 hours of notice, or a separate explicit go for irreversible quarter-gold activation. Local command resolution uses installed or already-cached tools only, with no package-install/download fallback; a missing binary/cache stops for separately approved local preparation. Bare `supabase` examples mean the verified installed CLI; check its installed version and command help before execution. Where active steps show npx, use `npx --offline --no-install` or the equivalent verified installed executable. Keep the merged project's validated offline typecheck/verification path; a frozen lock alone is not an offline guarantee. Normal remote pinned GitHub/Cloudflare dependency installs and CI container pulls for the planned release are already authorized; this does not authorize new local package downloads.

Outside Wednesday and Saturday 17:20–20:00 UTC, after 1.5.1 is recorded (`private.record_patch` refuses a number not above
every recorded one).

1. **A day before:** the gate of record and a whole-branch review have passed and the release commit is chosen. With Avi's
   go on the filled-in text, post the warning (`private.post_message('admin', …)`, runbook "Posting a game message") naming
   the switch's day and a time 20–60 minutes after a slot cutoff (cutoffs fall every 80 minutes: …, 09:20, 10:40, 12:00 …
   UTC). Read back the visible messages.
2. **The release day,** at least 24 hours after the approved warning, in this order under routine release authorization:
   1. The hosted checks (read-only, `scripts/hosted-checks.sql`): no open boundary. Vault updates remain separately authorized; these migration-only commands do not authorize them.
   2. **M27, migrations only:** after checking the installed CLI version/help, `supabase db push --dry-run --skip-vault` lists exactly the `_patch_1_6.sql` migration; `supabase db push --skip-vault`; read back
      `select version, active from private.rules_versions order by version` (v1 true, v2 false), `select rules_version
      from public.world_revision` (v1) and `scripts/economy-switch-check.sql` (`active_version` v1, `v2_row` true,
      `switched` false, `copy_matches` true); the access audit and the schema fingerprint against the local M01–M27
      replay.
   3. **Functions:** `functions deploy game-worker` and `game-command` (both carry the v2 executors and the salvage rule);
      the probes; the health check after the next boundary (no `unsupported-rules`).
   4. **Client:** the `release` fast-forward; verify the exact new client live and run deployed checks before activation. Economy values/wallets remain v1 until the switch, while the banner or non-economy copy can already appear.
   5. **The switch:** only after a separate explicit Avi go naming the irreversible quarter-gold activation, >=24 hours after the approved filled warning, between boundaries at the announced time. Run the advisory precheck again (`open_boundary` 0), then `select private.switch_to_economy_v2();`. Wait for atomic commit and immediately reconcile the returned/persisted audit, identity-linked receipts/ledger, scanned/positive-cut counts and signed delta sum, and active rules/public mirror v2. A refusal, call failure or failed authoritative readback stops further changes; report the actual state and do not announce an unsupported successful cut. No automatic retry loop.
   6. **Prompt truthful publication after the committed activation and immediate authoritative readbacks:** the approved patch note first, then the linked 1.6 patch record (`node scripts/patch-statement.mjs 1.6 --message <id>`), under routine release authorization with the new client already verified live. Read back the visible note/inbox, `latest_patch=1.6` and feature lines. Do not wait for the next boundary before this publication, and never announce the cut before commit/readback success. The record supplies a Reload offer on the next successful visible-tab revision refresh; it does not force a reload or promise delivery within 30 seconds. Hidden tabs pause polling; focus/return refreshes. Scenes/dialogs can postpone the notice; Later suppresses that patch for the tab's life, while the account menu still offers Reload when behind. Old compiled clients can keep v1 copy until the player actually reloads.
   7. **Mandatory next-completed-boundary follow-up after publication:** read the new completed boundary's `rules_version=v2`, verify its jobs completed with no `unsupported-rules`, and run remote health. This remains required and separate from the earlier post-functions boundary health check in step2.3, which is retained. Do not claim full operational verification until this follow-up passes. Actual health alerts/CLI failures stop further changes and require reporting/diagnosis; publication does not waive health.
3. **Rollback:** before activation, the economy/wallet values remain v1 and no quarter-cut has occurred, although the new client may already show banner/copy changes. The client can roll back (the old client reads no new column). After activation there is no automatic wallet undo; the emergency brake is pausing the scheduler. Retain frozen-v1 executors and truthful evidence of any partial operational follow-up.

**Media authorization:** one combined 1.4 + 1.5 clip is already authorized during 1.6's notice period. That authorization does not include a 1.6 film. Social posting/upload requires Avi's explicit go.

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
| Old clients show old numbers after the switch | Prompt post-commit/readback note+record offers Reload on the next successful visible refresh; hidden/Later/scene limits mean old copy can persist until actual reload. Required next-boundary health follows publication. |

## Avi's answers to the open questions (2026-10-30, question form) — binding, they override any text above

1. The day-before warning message **says plainly that everyone's gold will be cut to a quarter** (with the new salvage value), so nobody sells at 10 just before the cut.
2. **Gear drops are halved** on expeditions: 10 / 15 / 20 % (Woodland / Outpost / Mountain).

## Binding decision consolidation — 2026-11-01

The October 31 max-two note is resolved by Avi's November 1 answer “Automatically Rest; warn before saving.” The daily count is actual Training, cap-zero counts, insufficient-stamina Rest does not, legacy plans are accepted, and excess v2 Training is ordinary Rest with normal recovery. Prior v1 actual Training in the same target game day counts when preparing v2; already-frozen v1 activities remain unchanged. October 31 free v2 tournaments are retained. These amendments describe implementation constraints; all new names and copy above remain builder choices for review.
