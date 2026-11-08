# Patch 1.8 (Patch B): Party Dungeons (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players pick a dungeon for the afternoon; at the boundary the server groups everyone who chose it into parties
of up to 3 (hired fighters fill empty seats), runs 3 rooms then the major inside the slot, reveals it on time and pays
each member personally for every won fight it entered.

**Architecture:** Pure, seeded TypeScript decides everything (an N-versus-M party engine beside the untouched two-fighter
engine, a run planner, a grouper), run by the existing worker through the existing job kinds with input discriminators.
One migration (M30, from `supabase/sql/24-dungeons.sql`) adds the dungeon choice, phase-7 grouping, one simulation and one
shared reveal chain per run, a public `dungeon_fights` log table and per-member settlement through the expedition
settlement path. The client adds dungeon choices to the schedule, a run view built on Patch A's whole-trip replay, a party
close-up replay, and dungeon results, notifications and camp locations.

**Tech Stack:** Next.js 16.4.3 static client, Deno Edge functions `game-command` and `game-worker` (shared
`supabase/functions/_shared`), Supabase Postgres 17 (CLI 2.120.0), Phaser 4, Vitest, Playwright (`channel: 'chrome'`).

**Spec:** `docs/superpowers/specs/2026-10-29-party-dungeons-design.md` (sections cited as §n). Read `AGENTS.md`,
`docs/operations/migrations.md`, `docs/operations/verification-gates.md` and `docs/operations/job-leases.md` before Tasks
4–6.

**2026-11-07 takeover.** `codex/p18-dungeons` starts in `design` at `5d12d50`, the pushed Patch 1.7.1 line. The live
client is `8828d0a`, the database is M01–M29 with v2 active, `game-command` is from 1.7.1 and `game-worker` is from 1.6.
The dungeon MVP, exact v2 reward table and Ludus Nimbus play rules are recorded in the spec. Schedule, Results,
Notifications, camp, dungeon and party replay UI need the clickable approval in
Task 7 before implementation. The named bot team is also in 1.8 per the 1.6 and 1.7 decisions. It needs its own approved
design and tasks before the single M30 is sealed. Avi chose labeled named bots for dungeons after humans and unranked
Arena on 2026-11-07. Temporary hired fighters remain the fallback after the named bots.

## Global Constraints

- **Current release line.** Patch A's whole-trip replay and the later Arena replay, v2 economy and wearable titles are
  already present. Reuse the current modules and preserve their public behavior and retained reads.
- **Rules.** Keep `RULES_V1` byte-stable. The approved 1.6 carry puts new dungeon capability in `RULES_V2` only:
  `schedule.dungeonPhases = ['afternoon']`, `activityStamina.dungeon = 40` and `dungeon = { seats: 3,
  fightIntervalMs: 960_000, recovery: 0.2, hiredMultiplier: 0.9, targetWeights: { defensive: 3, balanced: 2, offensive: 1 },
  sweepEvery: 4, sweepFactor: 0.6, overLevelFactor: 0.5, rewardsById }`. Store the approved v2 payout table in
  `rewardsById`. `CATALOG_V1.dungeons` adds maps, monsters and hired builds with existing values intact.
  Keep the retained rules dispatcher and v1 settlement replay. Gate dungeon choice by active v2 when saving and by
  frozen v2 when preparing, grouping, simulating and paying. Use `private.active_rules_version()` for the active value.
  `private.economy_switches` is owner-only audit storage and stays inaccessible to command and settlement roles.
- **Dungeons** exactly as spec §3.1–3.2: `wolf-den` (level 3, full rewards 3–8, woodland), `raider-stronghold` (7, 7–12,
  outpost), `troll-hall` (12, no upper band, mountain). Treat the original stat lines and hired builds as balance inputs.
  Pin the approved v2 figures in §3.1. Measure against the live expedition accessor (30 / 75 / 150 XP) and v2 Training
  limits before accepting product balance.
- **Identifiers:** fights at 16, 32, 48, 64 minutes; fight seed `<seed>:fight:<n>`, battle id `<runId>:fight:<n>`, loot
  stream `<seed>:loot:<gladiatorId>`; run id `dungeon:<slot>:<dungeonId>:<k>`; grouping job `party:<slot>:<dungeonId>`;
  run job `dungeon:<runId>`; reveal job `dungeon-reveal:<runId>:<ordinal>`; run seed
  `encode(digest(<grouping job seed>||':'||runId,'sha256'),'hex')`; unit ids: gladiator id, `hired:<seat>`,
  `creature:<creature>:<fight>:<k>`, the major `creature:<creature>:4:1`.
- **No new job kind:** `pair` (input `kind: 'dungeon-grouping'`), `simulation` (`kind: 'dungeon'`), `reveal`
  (`kind: 'dungeon-reveal'`), `settlement`. `simulateBattle`, `BattleLog`, `private.safe_battle_log`, `src/game/replay.ts`
  and `src/game/battle-stage.ts` are unchanged and every existing log stays byte-identical.
- **Hired fighters** earn nothing and never become a gladiator row, world actor, result, standing or notification; their
  share is never handed to the humans.
- **Words:** every player word says gold; plain text only; times use Patch A's 12/24-hour setting.
- **Database:** committed migrations are never edited. Generate M30 with bundled `pg-delta` from the reapplicable `24-dungeons.sql`,
  completed and replayed per `AGENTS.md` (ACLs, RLS and policies, the invoker view, every CHECK and trigger after the
  functions it calls, data and initialisation statements), the replayed fingerprint byte-equal to the source-applied one,
  the access audit after the migration; multi-statement source through the psql fallback after the container label check;
  `--agent no` on any parsed `db query --output-format json`; never print keys or connection strings.
- **Process:** TDD; the DB-test rule (`npm run test:db` only while nothing else builds, browses or edits this worktree,
  Edge start time compared before and after, access times refreshed); no build while a browser run is active; the Postgres
  concurrency override (lock first, then sample `clock_timestamp()`, revalidate token, status and expiry, with its
  regression); the React effects override (reload flags scoped to the record version that set them); no package
  downloads (`npx --offline --no-install`); no hosted Supabase command before Task 9's checks. Run only approved release
  commands in the linked `claude` worktree and never modify `codex`. Never read `supabase/.temp` except `*-version` files.
  Never print secrets or change Windows or Defender settings.
- **UI:** a clickable mockup over real screenshots, desktop and 360 px, approved by Avi in chat before any UI code.
- **Gate of record:** `node scripts/verify.mjs --config node_modules/.cache/pw-design-tcp.config.mjs --browser-shards 32 --results <fresh-dir> --json <file>` 12/12 with the local
  Edge serve running.
- **Release:** aggregate production reads only. Each production write needs its own explicit Avi go in chat. Release
  outside Wednesday and Saturday 17:20–20:00 UTC with no open boundary. Order M30 → verified `game-worker` → `game-command`
  → client → patch note → patch record. The grandiose 1.8 trailer is a pre-release deliverable in Task 9.

## Review Focus

1. A member whose frozen level is above the band is paid half with a salvage-only chest, even if it saved the choice while
   inside the band (level 8 at the command, 9 at the snapshot); one inside the band at the snapshot is paid in full (Task 2
   unit, Task 6 DB test).
2. An entrant whose afternoon dungeon became Rest (stamina 39, or an old 5-key preparation) is in no party, and the other
   entrants still run (Task 4 DB test).
3. Two members of one party settle at the same moment: each gets exactly one receipt and neither deadlocks (Task 6 DB
   test).
4. After a run, hired fighters appear nowhere a player does: no world actor, recent result, standing, notification,
   receipt or ledger row (Task 6 DB test).
5. The longest fight of the balance sample (six units, about 70 s) passes `private.safe_party_log` under 100 KB, and its
   close-up fits a 360 × 740 phone with no sideways scroll (Task 5 DB test, Task 8 browser test).

---

### Before Task 1: player review and patch identity

- [x] Prepare Task 7 Steps 1–3 on the exact 1.7.1 test build. Record Avi's approval and any changes before starting
  player-facing implementation. Show the v2 reward choice, the named bot behavior and tag, and the four existing dungeon
  title designs in that review. Use real test-app captures and show the room-loss and member-knockout cases separately.
- [x] Finish the named bot team's spec and ordered tasks after Avi's decisions. Keep the entire 1.8 database change in M30.
- [x] Add the 1.8 in-progress section in `docs/CHANGELOG.md`, run `npx --offline --no-install vitest run tests/domain/patch.test.ts`
  and observe the mismatched patch failure. Set `PATCH='1.8'` in `src/lib/patch.ts`, rerun, review and commit the identity.

### Task 1: Rules, catalog, contracts and the party combat engine

**Files:**
- Modify: `supabase/functions/_shared/domain/rules-v2.ts`, `domain/economy.ts`, `catalog-v1.ts` (`dungeons`), `types.ts` (`ActivityKind` adds
  `'dungeon'`; `Dungeon`, `DungeonMonster`, `HiredRole`, `HiredBuild`), `schedule-choice.ts`, `combat.ts` (export
  `roundedDamage`), `contracts/commands.ts`, `contracts/events.ts`, `contracts/reads.ts`; any client `Record` or `switch`
  that `npm run typecheck` flags gets a plain "Dungeon" entry only (the real screens are Tasks 7–8)
- Narrow the existing five cost keys in `backend/jobs.ts` and `src/features/schedule/rest-stamina.ts` for type compatibility.
  Keep preparation payloads at five keys in this task and return no dungeon stamina estimate until a cost is available.
- Create: `supabase/functions/_shared/domain/party-combat.ts`
- Test: `tests/domain/dungeon-catalog.test.ts` (new), `tests/domain/party-combat.test.ts` (new),
  `tests/domain/schedule-choice.test.ts`, `tests/domain/rules-v2.test.ts` (preserve the existing hashes and compare the old
  contract after omitting only the named dungeon additions)

**Interfaces:**
- Produces (contracts): `DungeonId = 'wolf-den' | 'raider-stronghold' | 'troll-hall'`; `ActivityChoice` adds
  `{ kind: 'dungeon'; dungeonId: DungeonId }`; `ActivitySummary.resolvedKind`, `CurrentActivity.kind`,
  `GameNotification.kind` add `'dungeon'`; `CampLocation` adds `` `dungeon:${DungeonId}` ``; `RevealedStage.kind` adds
  `'room' | 'major'` and `fight?: { runId: string; ordinal: 1 | 2 | 3 | 4 }`; `PartyRole = 'gladiator' | 'hireling' |
  'monster' | 'major'`; `PartyCombatant = RevealedCombatant & { side: 0 | 1; role: PartyRole; seat: number | null }`;
  `PartyAttack = BattleAction & { sweep: boolean }`; `PartyVictory = { kind: 'victory'; sequence: number; elapsedMs:
  number; winnerSide: 0 | 1; reason: BattleVictory['reason'] }`; `PartyBattleLog = { battleId: string; rulesVersion:
  string; participants: readonly PartyCombatant[]; events: readonly (PartyAttack | PartyVictory)[]; durationMs: number;
  winnerSide: 0 | 1; victoryReason: BattleVictory['reason']; finalHp: readonly number[]; tieBreakReason:
  BattleLog['tieBreakReason'] }`.
- Produces (domain): `HiredRole = 'guard' | 'striker' | 'skirmisher'`; `DungeonMonster = { name; creature: 'dire-wolf' |
  'timber-wolf' | 'raider' | 'raider-archer' | 'rock-troll' | 'frost-troll'; maxHp; damage; intervalMs; armor; stance:
  'balanced'; attributes: Attributes }`; `HiredBuild = { classId; stance; allocations: Attributes; equipment:
  Record<EquipmentSlot, string | null> }` (catalog ids); `Dungeon = { id; name; requiredLevel: 3 | 7 | 12;
  fullRewardsMaxLevel: 8 | 12 | null; map: 'woodland' | 'outpost' | 'mountain'; rooms: [DungeonMonster[],
  DungeonMonster[], DungeonMonster[]]; major: DungeonMonster; hired: Record<HiredRole, HiredBuild> }` (all `DeepReadonly`).
  Add `DungeonReward = { room: { xp: number; money: number }; major: { xp: number; money: number }; chest: {
  salvageQuantity: number; gearChance: number; gearTier: 1 | 5 | 10; rarity: Record<ItemRarity, number> } }` and the
  accessor `dungeonReward(rules: Rules, id: DungeonId): DungeonReward` in `domain/economy.ts`, failing closed without v2.
- Produces: `choiceAllowedInPhase(phase, choice, rules = RULES_V1)`: Arena only in `arenaPhases`, a dungeon only in
  `dungeonPhases`, everything else everywhere. `roundedDamage(attacker: FighterSnapshot, defender: FighterSnapshot, rules:
  Rules, critical: boolean, factor = 1): number` (the factor joins the exact product only when it is not 1).
  `simulateSkirmish(input: SkirmishInput, seed: Seed): PartyBattleLog` with `SkirmishUnit = DeepReadonly<{ id: string;
  gladiatorId: string | null; name: string; side: 0 | 1; role: PartyRole; seat: number | null; snapshot: FighterSnapshot;
  startingHealth?: number }>` and `SkirmishInput = DeepReadonly<{ battleId: string; rulesVersion: string; rules: Rules;
  units: SkirmishUnit[] }>`; weights and the sweep come from `rules.dungeon`, a `major` unit sweeps.

- [x] **Step 1: Record the guard hashes on the unmodified tree:** hash `RULES_V1`, `RULES_V2` and `CATALOG_V1` via
  `node --experimental-strip-types --no-warnings` or the existing retention-test helper. Pin the baseline before edits.
- [x] **Step 2: Write `tests/domain/dungeon-catalog.test.ts`:**
  - `keeps every pre-existing rule and catalog value`: compare full `RULES_V1`, `RULES_V2` without its three new dungeon
    keys and `CATALOG_V1` without `dungeons` with the Step 1 hashes. Keep the v1 catalog/hash guard in its existing owner.
  - `adds the three dungeons with the spec's numbers`: `CATALOG_V1.dungeons['wolf-den']` `toEqual` the full §3.1 content
    (rooms, major, hired builds); for the other two, `requiredLevel`, `fullRewardsMaxLevel`, `map` and the major's stat line.
    Pin each approved table row through `dungeonReward(RULES_V2, id)` and reject v1.
  - `draws every monster with a manifest creature`: each `creature` is a creature id in `public/assets/manifest.json`.
  - In `schedule-choice.test.ts`: `opens dungeons in the v2 afternoon only` (v2 afternoon true, v1 all false, morning and
    evening false in both; Arena unchanged).
- [x] **Step 3: Write `tests/domain/party-combat.test.ts`** (fighters from `makeFighter` or literal snapshots; expected
  draws replayed from `seededRandom(seed)` in the documented order):
  - `is deterministic per seed`: equal logs for one seed, different events for another.
  - `keeps the two-fighter damage exactly`: `roundedDamage(a, d, RULES_V1, c)` equals the 5-argument call with factor 1
    for 200 random pairs; base damage 10, efficiency 1, Balanced both, armor 0: factor 0.6 gives 6, critical gives 9.
  - `party units hit the standing enemy with the lowest health, ties to the lower index`: against monsters at 50, 30, 30
    the first party attack targets the second monster.
  - `draws hit and critical only for a single target, and the target first for two or more`: a 1-v-1 monster's `hit` and
    `critical` flags, and a 2-v-1 monster's `defenderId`, `hit` and `critical`, equal the replayed draws for the first 4
    groups.
  - `weights monster targets 3 / 2 / 1 by stance`: Defensive, Balanced and Offensive party units with 1,000,000 health
    against one monster, 200 seeds: target shares within ±0.02 of 0.5, 0.333, 0.167.
  - `sweeps every standing party unit on every 4th major attack at 0.6 damage`: attacks 4 and 8 of a `major` log
    `sweep: true`, one event per standing party unit in unit order, each landed hit's damage equal to
    `roundedDamage(major, target, RULES_V1, critical, 0.6)`; other attacks hit one target with `sweep: false`.
  - `resolves a group against the health before it`: two units attacking at the same millisecond both log their attack
    though the first would fell the second; the second's target was chosen on pre-group health.
  - `ends on a defeat, and both sides falling together is a seeded tie-break`: one side standing → its `winnerSide`,
    reason `defeat`; a found seed where both fall in one group → reason `tie-break`, `tieBreakReason`
    `simultaneous-defeat`.
  - `decides a 120 s fight by total health fraction, an exact tie by the seed`: `durationMs` 120000 with reason
    `health-fraction`; an engineered exact tie gives `tie-break` / `equal-health-fraction`.
  - `refuses a bad input`: a duplicate id, an empty side, 7 units on a side, two rules versions, `startingHealth` above
    maximum → `RangeError`.
  - `logs only whitelisted participant fields`: each participant's keys are exactly `RevealedCombatant`'s plus `side`,
    `role`, `seat`.
- [x] **Step 4: Run** `npx --offline --no-install vitest run tests/domain/dungeon-catalog.test.ts tests/domain/party-combat.test.ts tests/domain/schedule-choice.test.ts`;
  expect FAIL (missing exports).
- [x] **Step 5: Implement** the rules, catalog and contracts; then the engine exactly as spec §4 (units 1–6 per side,
  group order side 0 then side 1 in unit order, damage applied event by event, `healthBefore` / `healthAfter` per event,
  first attacks at the interval, `next = elapsed + interval` or past the limit). Model dungeon cost as optional on older
  frozen snapshots. Do not require a retroactive sixth key or change legacy serialized payloads.
- [x] **Step 6: Run** step 4's command, `npx --offline --no-install vitest run tests/domain/combat.test.ts tests/domain/replay-fixtures.test.ts`
  and `npm run typecheck`; expect PASS (the existing fixtures unchanged).
- [x] **Step 7: Commit** `feat: dungeon rules, catalog, contracts and the party combat engine`.

### Task 2: The run planner and balance pinned to the prototype

**Files:**
- Create: `supabase/functions/_shared/domain/dungeon.ts`, `tests/domain/dungeon.test.ts`, `tests/fixtures/dungeon-builds.ts`,
  `tests/domain/dungeon-balance.test.ts`. Port the archived prototype build fixtures without their absolute imports.
  Points are 10 / 14 / 20 / 25 / 33 / 38 / 45 at levels 1 / 3 / 5 / 7 / 10 / 12 / 15, all within `10 + 4 × level`.
  Use the original class splits and common gear for the baseline and include v2 capped-build sensitivity runs.
- Modify only if a band fails: `catalog-v1.ts` (monster numbers), `rules-v2.ts` (`dungeon.hiredMultiplier`), spec §3.1 and
  §10 tables

**Interfaces:**
- Consumes: Task 1's catalog, `simulateSkirmish`, `makeFighter`, `seededRandom`, `LootGrant`.
- Produces:
  - `DungeonSeat = DeepReadonly<{ seat: 0 | 1 | 2; kind: 'human'; gladiatorId: string; activityId: string; name: string;
    level: number; build: BuildSnapshot } | { seat: 0 | 1 | 2; kind: 'hireling'; role: HiredRole }>`
  - `DungeonRunInput = DeepReadonly<{ kind: 'dungeon'; runId: string; slotIndex: number; rulesVersion: string; dungeonId:
    DungeonId; startsAtMs: number; seats: DungeonSeat[] }>`
  - `DungeonFight = DeepReadonly<{ ordinal: 1 | 2 | 3 | 4; kind: 'room' | 'major'; offsetMs: number; log: PartyBattleLog;
    won: boolean }>`
  - `DungeonMemberOutcome = DeepReadonly<{ gladiatorId: string; activityId: string; result: 'victory' | 'defeat'; success:
    boolean; entered: number[]; won: number[]; overLevel: boolean; rewards: { xp: number; money: number; loot: LootGrant[]
    } }>`
  - `DungeonRunPlan = DeepReadonly<{ runId: string; rulesVersion: string; catalogVersion: string; dungeonId: DungeonId;
    fights: DungeonFight[]; stages: RevealedStage[]; outcomes: DungeonMemberOutcome[] }>` (plan stage ids are
    `<runId>:<ordinal>`; Task 5 rewrites them per member)
  - `hiredFighter(dungeon: Dungeon, role: HiredRole, rules: Rules): FighterSnapshot`; `hiredRolesFor(humanStances:
    readonly Stance[]): HiredRole[]` (length `3 − humans`); `monsterFighter(monster: DungeonMonster, rules: Rules):
    FighterSnapshot`; `dungeonChestLoot(reward: DungeonReward, catalog: Catalog, random: () => number, salvageOnly: boolean):
    LootGrant[]`; `dungeonPartyLabel(dungeon: Dungeon, seats: readonly DungeonSeat[]): string`;
    `planDungeonRun(input: DungeonRunInput, seed: Seed, rules: Rules): DungeonRunPlan`
  - Fixture: `representativeBuild(classId: ClassId, level: 1 | 3 | 5 | 7 | 10 | 12 | 15): BuildSnapshot`,
    `partyInput(dungeonId: DungeonId, humans: { classId: ClassId; level: number }[], runId: string): DungeonRunInput`
    (hired roles from `hiredRolesFor`).

- [x] **Step 1: Write `tests/domain/dungeon.test.ts`:**
  - `builds hired fighters from the catalog at 0.9 health and base damage`: `[maxHealth, baseDamage, attackIntervalMs,
    armor, stance]` for Wolf Den guard / striker / skirmisher `[158, 9.45, 952, 9, 'defensive']`, `[117, 13.635, 1321, 4,
    'offensive']`, `[99, 9, 905, 4, 'balanced']`; Raider Stronghold `[205, 13.05, 952, 13.5]`, `[153, 19.71, 1308, 6]`,
    `[108, 12.6, 872, 6]`; Troll Hall `[261, 17.55, 952, 18]`, `[180, 26.775, 1296, 8]`, `[117, 16.2, 834, 8]`.
  - `fills missing roles Guard, Striker, Skirmisher, then Skirmisher`: `['balanced']` → `['guard', 'striker']`;
    `['defensive']` → `['striker', 'skirmisher']`; `['offensive', 'defensive']` → `['skirmisher']`; `['balanced',
    'balanced']` → `['guard']`.
  - `plans the same run for the same input and seed`.
  - `fights at minutes 16, 32, 48 and 64 under seeds <seed>:fight:<n>`: fight n's `offsetMs` is `n × 960000`, its log's
    `battleId` is `<runId>:fight:<n>`, and fight 1's log equals `simulateSkirmish` of the same units under
    `<seed>:fight:1`.
  - `carries health, recovers 20 % after a won room and leaves fallen units out`: every party participant of fight n > 1
    has `initialHealth = min(max, finalHp of fight n−1 + floor(0.2 × max))`; a unit at 0 is absent.
  - `labels the stages and keeps them in the slot`: seats Ari, Bo, guard → depart "Enter Wolf Den with Ari, Bo and a hired
    Guard"; solo Ari → "Enter Wolf Den with Ari, a hired Guard and a hired Striker"; fights "Room n: victory" /
    "Alpha of the Den: defeat"; 4–10 stages, kinds and times as spec §5, the last `return` at 4800000.
  - `pays the won fights each member entered; a lost major still pays the rooms`: a found seed where Wolf Den rooms 1–3
  are won and the major lost → every outcome is 18 XP, 3 gold and no loot, `result: 'defeat'`,
  `success: false`. Add an all-fallen simultaneous room win that pays that room and creates no next fight.
  - `pays a fallen member only up to its last fight` (seeds `fall:0`…`fall:199`, one weak human): `entered` is `[1..m]`,
    `won ⊆ entered`, rewards equal the sum of its won fights.
  - `rolls each member's chest from <seed>:loot:<gladiatorId>`: a won major's loot equals `dungeonChestLoot(…,
    seededRandom('<seed>:loot:<id>'), false)` with the retained v2 reward, origin `'expedition'`; one outcome per human and none for a
    hired seat.
  - `halves XP and gold above the band with a salvage-only chest`: Wolf Den at level 9 → `floor(0.5 × total)` and loot of
    salvage only, `overLevel: true`; level 8 → full; Troll Hall at level 30 → full (Review Focus 1).
  - `refuses a bad run`: a level below the dungeon's, seats other than exactly 0–2, no human, a repeated gladiator, an
    unknown dungeon, another rules version → `RangeError`.
- [x] **Step 2: Run** `npx --offline --no-install vitest run tests/domain/dungeon.test.ts`; expect FAIL.
- [x] **Step 3: Implement** `dungeon.ts` as spec §5 (hired fighter: `makeFighter` of the catalog build with item
  instances from `CATALOG_V1.items`, then `fallbackOf`'s exact arithmetic with `hiredMultiplier` and the role's stance;
  chest draws in `expeditionLoot`'s order with the chest's rarity odds; result `victory` only for an entered, won major).
- [x] **Step 4: Run** step 2's command; expect PASS.
- [x] **Step 5: Write `tests/domain/dungeon-balance.test.ts`** (`{ timeout: 180_000 }`, 300 seeds per shape named
  `balance:<dungeon>:<shape>:<i>`):
  - `matches the prototype's builds and the catalog's hired builds`: `representativeBuild` allocations and gear at 3 / 7 /
    12 equal the catalog's hired builds of the same class.
  - `a full party beats the major within 8 points of 90 / 88 / 87 %`.
  - `solo with two hired fighters beats the major within 8 points of 45 / 56 / 51 %, no class below 35 %`.
  - `every reference shape clears rooms 1–3 at least 97 % of the time; a party 3–5 levels over wins at least 95 %`
    (levels 5, 10, 15).
  - Re-measure solo and full party expected XP against `expeditionReward` under `RULES_V2` (30 / 75 / 150 XP) with the
    approved reward table. The relative bands preserve 1.00–1.25× solo and 1.35–1.65× full party.
  - `plans a run in under 100 ms on average`: 50 Troll Hall full-party runs; print fight p50 / p95 / max ms and the p95 JSON
    size of a run for the report.
- [x] **Step 6: Run** `npx --offline --no-install vitest run tests/domain/dungeon-balance.test.ts`. If a band fails, tune in the spec's order (the
  major's health, then its damage, then `hiredMultiplier`), rerun, and write the final numbers into spec §3.1 and §10;
  never widen a band. Expect PASS.
- [x] **Step 7: Commit** `feat: plan dungeon runs, balanced to the prototype`.

### Task 3: The grouper and the worker executors

**Files:**
- Create: `supabase/functions/_shared/domain/dungeon-grouping.ts`, `tests/domain/dungeon-grouping.test.ts`
- Modify: `supabase/functions/_shared/backend/jobs.ts` (the retained `executorsFor(rules)` pair and simulation dispatch),
  `tests/backend/worker.test.ts`, `domain/arena.ts` (shared exact strength cents and no change to legacy pairing),
  and `domain/dungeon.ts` (reuse the planner's frozen human build validation in grouping).

**Interfaces:**
- Consumes: Task 2's `DungeonSeat`, `DungeonRunInput`, `DungeonRunPlan`, `planDungeonRun`, `hiredRolesFor`;
  the frozen human fighter validator, and an exact cents accessor alongside `estimateArenaStrength`.
- Produces: `DungeonEntrant = DeepReadonly<{ gladiatorId: string; activityId: string; name: string; level: number; build:
  BuildSnapshot }>`; `DungeonGroupingInput = DeepReadonly<{ kind: 'dungeon-grouping'; slotIndex: number; dungeonId:
  DungeonId; rulesVersion: string; entrants: DungeonEntrant[] }>`; `DungeonRunAssignment = DeepReadonly<{ runId: string;
  seats: DungeonSeat[] }>`; `DungeonGroupingResult = { runs: DungeonRunAssignment[] }`;
  `partitionByStrength(cents: readonly number[], ratio: number): number[][]` (index groups of an already sorted list);
  `groupDungeon(input: DungeonGroupingInput, seed: Seed, rules: Rules): DungeonGroupingResult`. In `jobs.ts` use
  `groupDungeonV2` and `simulateDungeonV2` only from the retained v2 dispatcher. Both reject malformed inputs and frozen
  versions that do not match the executor. A human seat copies its entrant's fields exactly for SQL validation.

- [x] **Step 1: Write the tests:**
  - `partitions strengths in bands of at most 2×, then evenly`: cents `[100, 40, 35]` → `[[0], [1, 2]]`; `[100, 50]` →
    `[[0, 1]]` (exactly 2×); seven equal → `[[0,1,2],[3,4],[5,6]]`; 1–6 equal → sizes 1, 2, 3, 2+2, 3+2, 3+3.
  - `groups by strength, strongest first, independent of input order`: shuffled entrants give the same runs; equal
    strengths order by `seededRandom('<seed>:dungeon:<id>')()` then gladiator id. Reuse the exact integer cents computed
    in `domain/arena.ts` for banding so round-tripping through display strength cannot change a boundary.
  - `numbers runs and seats`: ids `dungeon:<slot>:<dungeonId>:1..R` in group order; humans in seats 0.., then the
    `hiredRolesFor` roles.
  - `refuses a bad grouping input`: an entrant below the level, a repeated gladiator or activity, a wrong `kind` or rules
    version → `RangeError`.
  - `worker.test.ts`: `routes dungeon grouping and simulation through the retained v2 executor`, rejects dungeon inputs
    at v1 and mismatched frozen versions, keeps both existing Arena routes, rejects malformed snapshots, and refuses a
    run whose `startsAtMs` is not `slotIndex * rules.clock.slotMs`.
- [x] **Step 2: Run** `npx --offline --no-install vitest run tests/domain/dungeon-grouping.test.ts tests/backend/worker.test.ts`; expect FAIL.
- [x] **Step 3: Implement** as spec §6 in `executorsFor(rules)`. Check the discriminator and the retained version before
  using dungeon capabilities. Preserve `simulateV1` and the existing two-fighter route.
- [x] **Step 4: Run** step 2's command and `npm run typecheck`; expect PASS.
- [x] **Step 5: Commit** `feat: group dungeon entrants and run dungeon jobs in the worker`.

### Task 4: Planning, preparation and phase-7 grouping (Edge, SQL sections 1–2)

**Files:**
- Modify: `supabase/functions/_shared/backend/commands.ts` (`choiceShape` accepts `{ kind: 'dungeon', dungeonId }` with a
  catalog id and validates known v2 afternoon syntax in both schedule paths), `backend/jobs.ts` (v2 preparations carry
  6 costs, retained v1 still carries 5). Verify that the existing `tests/fixtures/db.ts` character truncate cascades
  through activities/jobs to both new tables. Keep M29 RED independent of the absent tables.
- Create: `supabase/sql/24-dungeons.sql` with a header (purpose, lock order, the accepted exceptions of spec §7) and:
  - **Section 1:** `activities_resolved_kind_check` re-added with `'dungeon'`; `private.planning_command` restated from
    `18-messages.sql` with, in both `edit-schedule` and `edit-day-schedule`, a dungeon outside the afternoon `invalid` and
    `{ kind, dungeonId }` (exactly 2 keys) checked by `case dungeonId when 'wolf-den' then 3 when 'raider-stronghold' then 7
    when 'troll-hall' then 12 end` against `g.level` and active `v2` via `private.active_rules_version()`; restate
    `private.valid_preparation` and `private.boundary_check_stamina` from `21-economy.sql`. Preserve slot-specific v2
    `trainingAllowed` validation and the two-Training fallback. Accept legacy five-key v1/v2 preparations and the six-key
    v2 preparation with safe integer `dungeon`. A frozen dungeon with a missing cost or insufficient stamina becomes Rest.
  - **Section 2:** `private.dungeon_runs` (`run_id text primary key` with a format check, `grouping_job_id uuid not null
    references private.jobs(id)`, `slot_index`, `dungeon_id` checked, `seed`, `assignment jsonb` object, `created_at_ms`)
    and `private.dungeon_run_members` (`activity_id uuid primary key references public.activities(id)`, `run_id references
    private.dungeon_runs`, `seat smallint` 0–2, `unique (run_id, seat)`): RLS on, `backend_only` policy, revoke all,
    `select, insert, delete` for `service_role`, `guard_frozen`; `private.grouping_input(target bigint, dungeon text, rules
    text) returns jsonb`; `private.boundary_pair` restated from `21-economy.sql` (preserve all Arena routing, including the
    v2 cohort whose requested Arena resolved to Rest and can enter a free tournament; then the v2 dungeon jobs, the
    existing `pairing` / `operator` waits and `raise exception
    'ungrouped dungeon entrant'`); `private.accept_grouping(job uuid, result jsonb) returns boolean`; `public.complete_job`
    restated from `07-arena.sql` sending `pair` jobs with `input->>'kind' = 'dungeon-grouping'` to `accept_grouping`; the
    revoke and grant lists; `notify pgrst, 'reload schema'`.
- Test: `tests/backend/commands.test.ts`, `tests/backend/worker.test.ts`, `tests/db/dungeons.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's `DungeonGroupingInput` (written by `grouping_input`: entrants ordered by gladiator id, `name` from
  `public.gladiators`, `level` from the snapshot's `starting.level`, `build` from the snapshot) and
  `DungeonGroupingResult`.
- Produces: rows `private.dungeon_runs` / `private.dungeon_run_members` for Task 5; `grouping_input` and
  `accept_grouping` with the acceptance checks of spec §7.

- [x] **Step 1: Failing tests (units):** `parseCommand` accepts an afternoon Wolf Den in `edit-schedule` and
  `edit-day-schedule`, refuses it in the morning and the evening, refuses `dragon-lair` and an extra key. Generic
  `prepareActivity(input, RULES_V2)` costs are `{ training: 20, expedition: 30, arena: 25, tournament: 0, rest: 0,
  dungeon: 40 }` for an unloaded build, with `ceil(40 × (1 + overload))` for an overloaded one. Pin the old v1 cost shape.
- [x] **Step 2: Failing tests (`describe('dungeon planning')`):** `accepts Wolf Den in the afternoon at level 3 and
  refuses it at level 2, in the morning and in the evening`; `refuses an unknown dungeon or an extra key in edit-schedule
  and edit-day-schedule`; `validates preparations with the old 5 cost keys and with 6 including dungeon, and refuses 7 keys
  or 6 without dungeon`; `turns a dungeon into Rest at stamina 39 and when the frozen costs lack the dungeon key`.
- [x] **Step 3: Failing tests (`describe('dungeon grouping')`):** `writes one grouping job per dungeon with entrants and
  waits with pairing until it completes` (3 Wolf Den and 1 Troll Hall entrants: jobs `party:<S>:wolf-den` and
  `party:<S>:troll-hall` with a null gladiator, wait `pairing`, phase 7 passes once the worker completes them); `stores
  frozen runs, members and run seeds` (seed equals the digest rule; an update raises); `refuses a grouping that drops,
  repeats or alters an entrant, changes a build, level or name, misnumbers runs or seats, seats a hireling before a human
  or has no human` (each mutation → `complete_job` code `invalid`, no row written); `leaves an entrant that fell back to
  Rest out of every party` (Review Focus 2: stamina 39 → 2 entrants, 1 run of 2 humans); `stops the boundary with ungrouped
  dungeon entrant` (a dungeon activity inserted after its grouping job completed); `denies clients the runs, members, seeds
  and grouping jobs`.
- [x] **Step 4: Run** `npx --offline --no-install vitest run tests/backend` and `npm run test:db -- tests/db/dungeons.test.ts`; expect FAIL.
- [x] **Step 5: Implement** the Edge and worker changes and sections 1–2; apply `24-dungeons.sql` locally with the psql
  fallback (container label check first).
- [x] **Step 6: Run** step 4's commands plus `npm run test:db -- tests/db/build-schedule.test.ts tests/db/launch-feedback-backfill.test.ts tests/db/arena.test.ts tests/db/tournaments.test.ts tests/db/economy.test.ts`;
  expect PASS (Arena and tournaments unchanged).
- [x] **Step 7: Commit** `feat: schedule dungeons in the afternoon and group their entrants at the boundary`.

### Task 5: Run jobs and shared reveals (SQL section 3)

**Files:**
- Modify: `supabase/sql/24-dungeons.sql` section 3:
  - `private.dungeon_results` (`run_id text primary key references private.dungeon_runs`, `simulation_job_id uuid
    references private.jobs(id)`, `plan jsonb` object, `created_at_ms`), backend only and frozen;
    `public.dungeon_fights` (`run_id text references private.dungeon_runs`, `ordinal smallint` 1–4, `reveal_at_ms bigint`,
    `log jsonb` object, `primary key (run_id, ordinal)`, index on `reveal_at_ms`): RLS on, revoke all, `select` for
    `anon, authenticated`, `select, insert, delete` for `service_role`, policy `due_read` for `anon, authenticated` using
    `reveal_at_ms <= floor(extract(epoch from clock_timestamp())*1000)::bigint`
  - `private.activity_executor_ready` restated from `09-tournaments.sql` adding `'dungeon'`;
    `private.prepare_activity_jobs` restated from `10-tournament-results.sql` with a dungeon branch: the member row and
    its run, the run job `dungeon:<runId>` (anchored to seat 0's activity and gladiator, input `{ kind: 'dungeon', runId,
    slotIndex, rulesVersion, dungeonId, startsAtMs, seats }` from the stored assignment, the run seed, due at the slot
    start, `on conflict do nothing`), the member's settlement depending on it
  - `private.safe_party_log(value jsonb) returns jsonb` (2–12 participants with the whitelist plus `side` 0 | 1, `role`
    and `seat` null or 0–2; `attack` events with `sweep` boolean; `victory` with `winnerSide` and `reason`; `finalHp` one
    safe integer per participant; unknown keys dropped)
  - `private.accept_dungeon_result(job uuid, result jsonb) returns boolean`: the simulation branch (spec §7's plan checks,
    then `dungeon_results` and the reveal chain `dungeon-reveal:<runId>:<ordinal>` anchored to seat 0 with seat 0's
    activity seed, input `{ kind: 'dungeon-reveal', runId, ordinal }`, due at each stage's `revealedAtMs`, each after the
    previous and the first after the run job, every member's settlement after the last); the reveal branch (due and ready,
    then each member's `activity_stages` row with id `<activityId>:<ordinal>` and, for a fight stage, the
    `dungeon_fights` row through `safe_party_log`, `on conflict do nothing`)
  - `public.complete_job` (section 2's) sends `simulation` and `reveal` jobs with `input->>'kind'` `dungeon` or
    `dungeon-reveal` to `accept_dungeon_result`
- Test: `tests/db/dungeons.test.ts` (`describe('dungeon runs')`)

**Interfaces:**
- Consumes: Task 4's runs and members; Task 3's `simulateDungeonV2` (run by the real worker in the end-to-end test) and
  Task 2's `planDungeonRun` (tests plan with the job's seed, as `tests/db/expeditions.test.ts` does).
- Produces: `public.dungeon_fights` rows (Task 7 reads them); member stage rows with `fight` references; settlement jobs
  gated on the last reveal (Task 6).

- [x] **Step 1: Failing tests:** `creates one run job per run, anchored to seat 0 with the run seed, and gates every
  member's settlement on it`; `stores an accepted plan privately and chains one reveal per stage, the last gating every
  settlement`; `writes each member's stage under its own id and one whitelisted dungeon_fights row per fight` (an extra key
  in a participant and an event is absent after); `refuses a plan for another run, a missing, extra or hired outcome, an
  unsafe reward, a stage outside the slot or out of order, or victory without success` (each → `invalid`, nothing
  written); `shows a dungeon fight to visitors and players only from its reveal time and hides plans, runs and seeds`;
  `passes the longest balance-sample fight through safe_party_log under 100 KB` (Review Focus 5: the longest of 300 Troll
  Hall full-party plans); prove a separate validator ceiling admits the worst legal released 3v3 or major log under the
  120 s cap, 250 ms minimum interval and sweep multiplicity, measured as serialized PostgreSQL bytes, and rejects
  out-of-bound payloads. `takes every member's account lock before anchoring the run job to seat 0, so a member's command
  holding its lock cannot deadlock phase 8` (the pattern of `tests/db/arena.test.ts` "takes every member's account lock
  before phase 8 anchors a battle job to side 0"); `refuses a dungeon reveal whose lease expired while it waited on the job
  row lock` (the concurrency override's regression, as `docs/operations/job-leases.md` describes).
- [x] **Step 2: Run** `npm run test:db -- tests/db/dungeons.test.ts`; expect FAIL.
- [x] **Step 3: Implement** section 3; reapply the source.
- [x] **Step 4: Run** step 2's command plus `npm run test:db -- tests/db/expeditions.test.ts tests/db/arena.test.ts tests/db/tournaments.test.ts`;
  expect PASS.
- [x] **Step 5: Commit** `feat: run dungeon parties and reveal their fights on time`.

### Task 6A: Member settlement, projections, retention and access (SQL section 4)

**Files:**
- Modify: `supabase/sql/24-dungeons.sql` section 4: `public.expedition_settlement_input` restated from `05-expeditions.sql`
  (a dungeon member's `rewards` are its outcome's from `dungeon_results.plan->'outcomes'`, `rulesVersion` the plan's, the
  same lease fence); new `private.dungeon_rewards(activity uuid, prepared jsonb) returns jsonb` (`expedition_rewards`'
  body over the member's outcome, `result` and `success` from it, the 7-day `replayExpiry`); `private.settle_activity_core`
  restated from `10-tournament-results.sql` (dungeon → `dungeon_rewards`, a stale preparation `P0002`; receipt and ledger
  for `'dungeon'`, reason `'dungeon'`); `private.project_character` and `public.owner_state` restated from `22-titles.sql`.
  Restate `private.safe_settlement` from `05-expeditions.sql`. Explicitly whitelist `dungeon: { id, terminalFight, partyWon }`
  in the owner summary and the public projector. The existing member result and success stay separate from the party's
  terminal outcome. Keep the three public fields after detailed replays expire, and keep receipts and payouts owner-only.
  Restate the M20 `public.claim_jobs` with complete, bounded, reveal-first dungeon settlement bundles so siblings fit
  together in one worker. Retain the existing worker caps, legacy claims, due-order priority and separate member settlement.
  Add location `'dungeon:'||(a.requested->>'dungeonId')`, label "Dungeon" and dungeon result notices. Preserve the full
  public profile, worn title, counts, owner title progress/notices, idle Rest, ACLs and the invoker view.
  `private.cleanup_history` restated from `15-release.sql` (in the
  7-day pass, before step 12, delete the `dungeon_fights`, `dungeon_results`, `dungeon_run_members` and `dungeon_runs` of
  runs in slots `lo..hi`, reported as `dungeonFights`, `dungeonResults`, `dungeonRunMembers`, `dungeonRuns`); the revoke
  and grant lists. Preserve all unfinished-work and checkpoint fences and owner-only cleanup. Delete dependent dungeon
  rows before jobs, permit owner cleanup of frozen rows and retain title history after dungeon details expire.
- Add the four titles from the 1.7 spec to the shared catalog and `private.title_rules()` using `23-awards.sql` as the
  baseline (both `award` rows retained). Count member dungeon clears before awarding, and count positive `dungeon` ledger
  entries toward earned gold. Trigger functions stay non-executable by API roles. Keep expedition-win titles specific.
- Modify: `contracts/events.ts` (`ActivitySummary` and `PublicActivitySummary` add the optional dungeon summary),
  `tests/db/access-matrix.test.ts` (only this task's privilege lines, preserving Task 5's `dungeon_fights` fixture),
  `tests/rule-retention.test.ts` (table list), `tests/performance/capacity-model.ts` (retention classes and per-run bytes
  from Task 2), `tests/browser/live-routes.ts` (`dungeon_fights` in `tables()`) and `tests/db/capacity.test.ts`.
  Keep migration inventory pins and the migration record for Task 6E, when the M30 file exists.
- Test: `tests/db/dungeons.test.ts` (`describe('dungeon settlement')`), `tests/db/retention.test.ts`, the access matrix,
  `tests/db/capacity.test.ts`

**Interfaces:**
- Consumes: Task 5's plans and gated settlement jobs. Reuse `expedition_settlement_input`, `prepareGrant`, `applyXp` and
  `settle_expedition` with the plan's retained `rulesVersion`. Inventory overflow uses v2 NPC values and keeps the old
  v1 value in historical expedition settlement. No runtime role reads `private.economy_switches`.
- Produces: settled dungeon summaries (`resolvedKind: 'dungeon'`) and `dungeon:<id>` world locations.

- [x] **Step 1: Failing tests:** `settles each member once at minute 80 from its own outcome; a retry replays the
  receipt`; `pays the won rooms when the major is lost` (Avi's decision 7: Wolf Den → `result: 'defeat'`, `success: false`,
  18 XP and 3 gold, no items, wallet +3); `pays an over-level member from its frozen level` (Review Focus 1: level 8 when
  saved, 9 at the snapshot → XP and gold halved, salvage only); `sells chest overflow at NPC value when the inventory is
  full`; `settles two members of one party at the same moment with one receipt each and no deadlock` (Review Focus 3:
  `Promise.all` of two `createWorkerDatabase(admin).settle` calls); `shows hired fighters nowhere a player appears` (Review
  Focus 4: `world_actors`, `recent_results`, standings, notifications, receipts and ledger hold the humans only); `places a
  member at dungeon:<id> while away, labels its activity Dungeon and counts its result as a notification`; `prunes dungeon
  fights, results, members and runs after 7 days and keeps the summaries 90`; the access matrix lines for
  `public.dungeon_fights` (SELECT for `anon` and `authenticated` under `due_read`) and every new private table and
  function (`service_role` only); `runs a Wolf Den afternoon with four entrants end to end through the real worker HTTP
  endpoint` (as "runs planning, reveals and exactly-once rewards through the real private Edge worker HTTP endpoint").
  Pin immediate first-clear and 25th-clear awards from member success, no clear from a fallen member in a winning party,
  no double count on retry, dungeon gold and loot ownership counts, unchanged M29 award rows/ACLs and bot Founder exclusion.
  Verify the same whitelisted terminal outcome after replay expiry and reprojection, with rewards on the owner path only.
- [x] **Step 2: Run** `npm run test:db -- tests/db/dungeons.test.ts tests/db/retention.test.ts tests/db/access-matrix.test.ts`; expect FAIL.
- [x] **Step 3: Implement** section 4; reapply the source; update the fixtures, lists and pins above.
- [x] **Step 4: Run** step 2's command and `npx --offline --no-install vitest run tests/rule-retention.test.ts tests/performance`; expect PASS.
- [x] **Step 5: Review and commit** `feat: settle dungeon members and count dungeon titles`.

### Task 6B: Register Ludus Nimbus and protect bot identities

**Files:** `domain/bots.ts` under the shared functions, `24-dungeons.sql` bot registry and routine section,
`scripts/create-bots.mjs`, `tests/domain/bots.test.ts`, `tests/db/bots.test.ts` and existing title and access tests.

**Interfaces:** Freeze the five catalog entries and their 126-slot UTC routines from spec §15, with a catalog-to-SQL
parity test. Pin every listed kit, allocation and stance, and all 630 routine cells before RED.
`private.bots` stores team, gladiator, role and active status. `private.bot_routines` stores the fixed routine choices.
`private.create_bot` and the bench operation are owner-only. The local/prod operator script makes banned, non-sign-in
system Auth identities and registers them idempotently. Record only safe status/counts. No bot identities are seeded
by M30. The public projection exposes only a whitelisted bot team identifier, never Auth or schedule details.

- [x] Write and run RED: catalog/member parity, fixed cap/kit, exact slots and off-duty window, concurrent/repeated
  create, refusal of bot sign-in/player commands and any public operator access, no economic grant or Founder, and
  no lost 1.7.1 title/profile fields. Include wrong identity and stale retry.
- [x] Implement on current SQL21 creation and SQL22 title/projection foundations. Preserve account/advisory lock order.
  Register the trusted bot identity before any automatic title eligibility check. Test both non-bot and bot paths.
- [x] Run owning unit/DB/auth/ACL tests and offline typecheck. Independent review, commit and update handoff.

### Task 6C: Schedule bots and fill dungeon seats after humans

**Files:** `24-dungeons.sql` scheduling/grouping/settlement sections, `domain/bots.ts`, `domain/dungeon-grouping.ts`,
`domain/dungeon.ts`, worker contracts, `tests/domain/dungeon-grouping.test.ts` and `tests/db/bots.test.ts`.

**Interfaces:** Start `boundary_apply_changes` from SQL15's latest idle-aware version. Freeze bot eligibility after
the cutoff without changing any human schedule. The human groups and seat order are canonical. In phase 7 use the
affordable frozen human cohort, the approved global per-dungeon seat cap, each bot's eligibility and at most one run
per bot. Derive disjoint per-dungeon bot pools once under the boundary coordinator before dispatching any grouping job.
Use Avi's approved hardest-first priority and stable eligible bot IDs. Acceptance only uses that frozen pool so parallel or
retried grouping jobs cannot reuse a bot. Expose derived duty status and scheduled return time with the public team
identifier. Keep the full routines private. An unplaced bot follows the approved Training fallback with ordinary v2 checks. Preserve the ungrouped
human guard and do not manufacture a bot-only run. Keep member settlement and shared reveals fenced.

- [x] Write and run RED: off-duty at 00:00/08:00 UTC, 44 humans can see bots and 45 benches them, no bot idle suppression
  while active, current v2 Training limit, no bot-only runs, no duplicate bot across two dungeons, insufficient-stamina
  human excluded, valid bot retained ahead of a hire, role combat matches its hire equivalent and no economic grant.
- [x] Implement the minimal SQL/worker extensions. Preserve real-human grouping, fallback, dependency and lease behavior.
- [x] Run owning unit and DB tests plus capacity fixtures, then independent review, commit and update handoff.

### Task 6D: Unranked Arena bot bouts

**Files:** `domain/arena.ts`, shared Arena worker types/executors, `24-dungeons.sql` pairing/job/reward sections,
`tests/domain/arena.test.ts`, `tests/backend/worker.test.ts`, `tests/db/arena.test.ts`, `tests/db/bots.test.ts`.

**Interfaces:** Preserve `pairArena`'s retained player pairing. Add a distinct bot route only for an NPC fallback. The
latest SQL21 pairing acceptance preserves free v2 tournaments and validates the frozen same-league and 25% eligibility.
Use the existing Arena simulation/reveal lanes with unranked result metadata. Settle only the human's approved 20%
floor of normal player-bout currencies. Do not update either rating, standings or qualification, or create a bot
reward receipt in the public history. When a scheduled bot has no player match, keep it at the Arena for private practice
with no public bout or reward. Preserve internal idempotency and opponent identity for replay.

- [x] Write and run RED: human pairs and tournaments unchanged, bots never enter a tournament, only eligible NPC
  replacements, least-recent eligible bot first, no double-assignment, 20% floor and no rank/qualification changes,
  bot spar with zero grants, release-window old worker unchanged while bots are inactive, fenced reveal and settlement.
- [x] Implement from the latest SQL21 pairing and SQL10 settlement bodies with the dungeon changes included. Keep
  existing two-fighter human and NPC logs byte-stable. Verify replay only discloses the whitelisted bot identity/tag.
- [x] Run owning unit, worker, Arena/tournament/economy/title DB and offline typecheck. Independent review, commit and
  update handoff.

### Task 6E: Seal M30 and prove capacity

**Files:** Create `supabase/migrations/<generated>_patch_1_8.sql`. Update the migration count pins, access and retention
coverage, capacity model, `docs/operations/migrations.md` and handoff. Consume all Task 4–6D source changes.

- [x] **Step 1: Write the M30 test** in `tests/db/dungeons.test.ts`: `ships M30 completed from 24-dungeons.sql: functions
  before the CHECKs and triggers that call them, revokes before grants, the source bodies, ACLs, RLS and policies, the
  invoker view and the reload last` (the shape of `tests/db/messages.test.ts`'s M25 test). Run it; expect FAIL (no file).
- [x] **Step 2: Generate and complete M30** as in the M28/M29 records: clean M01–M29, apply the final LF source once and
  capture fingerprint and audit. For future generations, lint the source-applied schema before the pull as recorded in the
  [migration guide](../../operations/migrations.md#sql-source-iteration-and-deployment-artifact). Generate with
  `npx --offline --no-install supabase db pull patch_1_8 --local --schema public,private --diff-engine pg-delta --yes`.
  Record the generator's image/cache evidence and compare the draft with the source
  for grants and revokes, RLS and policies, the invoker view, function / trigger / CHECK order, initialisation statements,
  and re-emitted unchanged functions byte-equal to their previous migration; complete every omission (a privilege-only
  omission through `supabase migration new`, the Task 23.1 rule).
- [x] **Step 3: Replay:** `npx --offline --no-install supabase db reset --local --no-seed --yes`; inspect the replayed function bodies and
  `search_path`, role ACLs, policies, triggers and the invoker view; the `scripts/schema-fingerprint.sql` output equals the
  source-applied one byte for byte, and again after a second reset; record the line count.
- [x] **Step 4: Run** the access audit (`scripts/access-audit.sql`, `tests/db/access-matrix.test.ts`), the full
  `npm run test:db` under the DB-test rule, `npx --offline --no-install supabase db lint --local` and the advisors `--local`.
  All 633 tests passed. Avi accepted six new unused-index INFO notices on the empty replay. The M30 record lists each notice.
- [x] **Step 5: Capacity:** rerun the existing 25-of-50 dungeon fixture on the clean M30 replay, with both publications
  within 120 s by the tick after cutoff and all following settlements accounted for. Combine its physical relation sizes
  with the retained 90-day model, including heap, indexes and TOAST. Model one afternoon per three slots, parties of up
  to three, both temporary plan copies, shared logs and jobs, member stages and summaries, permanent receipts, title
  counts and the approved bot population. Use the measured plan p95 sensitivity and compare the integrated total with
  524,288,000 bytes. Keep all four legacy capacity checks. Run with `CAPACITY_GATE=1`;
  expect PASS. If either fails, stop and report the numbers to the controller (no scope change).
- [x] **Step 6: Review and commit** `feat: seal party dungeons and Ludus Nimbus in M30`, with the M30 migration record.
  Independent spec and code review approved `e22dcb0`.

### Task 7: Client: mockups for Avi, then reads, schedule, results, notifications and camp

**Files:**
- Review evidence (parent workspace): `logs/p18-mockup-20261107/mockups.html`, `shots/`, `art/` and `mockup-verification.json`
- Modify: `src/lib/api/reads.ts` (`readDungeonFight`; timeline stages keep `fight` for `room` / `major`;
  `NOTIFICATION_KINDS` adds `'dungeon'`, a dungeon's `destination` is its name), `src/lib/api/gateway.ts` (`dungeonFight`,
  cached like `tournamentLog`), `src/lib/api/fixture-gateway.ts`, `src/features/schedule/schedule-text.ts`,
  `src/features/schedule/SchedulePanel.tsx` (`choiceKey` / `choiceOf` for `dungeon:<id>`),
  `src/features/schedule/rest-stamina.ts` (dungeon cost and v2 projection), `src/features/titles/title-picker.ts`
  (remove the four shipped titles from the later-titles line),
  `src/features/results/result-text.ts`, `src/features/results/ResultsPanel.tsx` (a dungeon row's Replay opens
  `/dungeon/?activity=`), `src/features/messages/notifications.ts`, `src/features/character/actor-text.ts`,
  `src/features/character/activity-status.ts`, `src/game/actors.ts` (`locationKind`: `dungeon` → `'away'`)
- Create: `tests/fixtures/dungeons.ts`, `tests/fixtures/dungeons/*.json`, `tests/domain/dungeon-fixtures.test.ts`
  (regenerated with `UPDATE_DUNGEON_FIXTURES=1`, as `expedition-fixtures.test.ts`), `tests/api/dungeon-read.test.ts`
- Test: those, `tests/domain/schedule-text.test.ts`, `tests/domain/results-panel.test.ts`,
  `tests/features/notifications.test.ts`, `tests/domain/roster-panel.test.ts`, `tests/browser/planning.spec.ts`,
  `tests/browser/full-screen.spec.ts`

**Interfaces:**
- Consumes: Task 1's contracts; Task 2's `planDungeonRun` (fixtures only); Task 5's `dungeon_fights`.
- Produces: `GameGateway.dungeonFight(runId: string, ordinal: 1 | 2 | 3 | 4): Promise<PartyBattleLog>`;
  `readDungeonFight(client: SupabaseClient, runId: string, ordinal: number): Promise<PartyBattleLog>`; fixtures
  `DUNGEON_FIXTURES` keyed `full-victory` (Wolf Den, three humans), `solo-major-lost` (Raider Stronghold, one human and two
  hired), `room-lost` (Troll Hall, a member fallen in room 2, the run lost in room 3), each a timeline plus its fight logs;
  `schedule-text`: `choicesFor(phase, level, rules)` lists unlocked dungeons in the v2 afternoon only. Pass phase and
  active rules to `lockedChoices` and `dungeonNote` too, and keep Training cap/warning and v2 Rest projection.
  `choiceLabel` "Dungeon: Wolf Den", `optionLabel`
  "Dungeon: Wolf Den · Level 3", and `choiceHint`'s dungeon case "3 rooms, then the boss. Players group first. Eligible bots
  and hired fighters fill open seats. Costs 40 base stamina." (the cost from `rules.activityStamina.dungeon`).

- [x] **Step 1: Capture real screens** at 1440 × 900 and 360 × 740. Use the routed owner in `tests/browser/live-routes.ts`
  and `planning.spec.ts` for the editable Schedule and `away-button.spec.ts` for Watch live. The fixture Schedule is
  read-only. Use fixture preview for the existing run, replay, Results, Notifications and roster. Use test data only.
- [x] **Step 2: Build the clickable mockup** over them: dungeon options and the afternoon-only note; the run view (party of
  three in formation, a room fight, the major one scale larger and tinted, the five-segment strip, LIVE and the whole-trip
  replay controls from Patch A); the 3-v-3 close-up with a sweep; the result card and notification lines (spec §9); the
  roster's "In Wolf Den"; the watch button for a dungeon. Add the four dungeon titles and Ludus Nimbus disclosure in
  camp, roster, profile, unranked Arena and replay, at both sizes.
- [x] **Step 3: Show Avi and wait for his approval in chat.** Record his answer and any change in spec §9 (dated) and
  commit `docs: Avi's dungeon mockup decisions`. No step below and no Task 8 step starts before this approval.
- [ ] **Step 4: Failing tests:** `dungeon-fixtures.test.ts` `regenerates the dungeon fixtures from planDungeonRun byte
  for byte`; `dungeon-read.test.ts` `reads a revealed fight once and serves it from the cache`, `refuses a malformed log
  row as unavailable`, `keeps the fight reference of room and major stages`, `lists a settled dungeon as a notification
  with its dungeon's name`; `schedule-text.test.ts` `offers Wolf Den and Raider Stronghold in the afternoon at level 7 and
  lists Troll Hall locked`, `offers no dungeon in the morning or evening and says "Dungeons run in the afternoon only."`,
  `describes a dungeon with its 40 stamina` (`choiceHint` equals the line above);
  `results-panel` / `notifications` verifies the approved victory and defeat text, including a member knocked out while
  the party cleared. Room pay remains visible to that member. `roster-panel` `says "In Wolf Den" while away`; `locationKind` of
  `dungeon:wolf-den` is `'away'`.
- [ ] **Step 5: Run** `npx --offline --no-install vitest run tests/domain tests/api tests/features`; expect FAIL.
- [ ] **Step 6: Implement** the reads, gateway, fixtures, schedule words and result, notification and camp lines. Allowlist
  a dungeon identifier in the public result, keep owner reward amounts private and preserve the combined look/title read.
- [ ] **Step 7: Browser tests:** in `planning.spec.ts`, a level-3 player saves a day with Wolf Den in the afternoon and the
  command carries `{ kind: 'dungeon', dungeonId: 'wolf-den' }`, the morning select offers no dungeon and shows the note,
  and the panel fits 360 × 740; in `full-screen.spec.ts`, a dungeon member walks out through the gate and the roster line
  reads "In Wolf Den". Cover the BOT tag in every approved surface, including a bot in a mixed dungeon party and in an
  unranked Arena replay. Run with the private Playwright config; expect PASS.
- [ ] **Step 8: Commit** `feat: dungeon choices, results, notifications and camp lines`.

### Task 8: Run view and party close-up replay (reusing Patch A)

**Files:**
- Create: `src/game/dungeon-stage.ts`, `src/game/dungeon-scene.ts`, `src/features/dungeon/DungeonView.tsx` and
  `DungeonView.module.css`, `src/app/dungeon/page.tsx`, `src/game/party-replay.ts`, `src/game/party-stage.ts`,
  `src/features/dungeon/PartyReplay.tsx` and `PartyReplay.module.css`
- Modify: `src/game/expedition-creatures.ts` (waiting groups and the major), `src/app/replay/page.tsx`
  (`?run=<runId>&fight=<n>`), `src/features/shell/scene-url.ts`, `CampShell.tsx`, `SceneOverlay.tsx`, `useAwayTrip.ts`
  and `AwayButton.tsx` (dungeon Watch, close and focus return), Patch A's
  `src/game/trip-replay.ts` (`TripChapterId` adds `'fight-4'`), `src/features/character/trip-text.ts` (`TripMark.fight`
  adds 4) and `src/features/shell/away-trip.ts` (`awayState` is running for a dungeon too, `nextFight` adds 16 | 32 | 48 |
  64, and its button opens `/dungeon/?activity=`), `scripts/release-scan.mjs` (`FIXED_ROUTES` adds `dungeon/index.html`),
  `scripts/verify-static.mjs` ("6 fixed routes")
- Test: `tests/domain/dungeon-stage.test.ts`, `tests/domain/party-replay.test.ts`, `tests/domain/party-stage.test.ts`,
  `tests/domain/away-trip.test.ts`, `tests/browser/dungeon.spec.ts` (new), `tests/browser/replay.spec.ts`,
  `tests/static.test.ts` and `tests/deployed.test.ts` (the six fixed routes; the scanner refuses an export without
  `dungeon/index.html`)

**Interfaces:**
- Consumes from Patch A (names from its plan, `docs/superpowers/plans/2026-10-29-patch-a.md` Tasks 2, 7, 9 and 11; step 1
  checks them against the merged code): `TRIP_PACE`, `TripPlan`, `TripChapter`, `tripFrame(plan, positionMs)`,
  `tripPositionOf(plan, displayMs)`, `firstLocked(plan, capMs)` and `clockText(ms)` from `src/game/trip-replay.ts`;
  `TripBar` and `TripMarks` (`src/features/character/`); `awayState` / `awayText` (`src/features/shell/away-trip.ts`);
  `timeOfDay(ms, clock)` (`src/lib/time-format.ts`) and `useClockMode` / `ClockMode`. Consumes Task 7's `dungeonFight`
  and `DUNGEON_FIXTURES`.
- Produces: `planDungeonTrip(timeline: RevealedTimeline, options: { walkMs(from: JourneyPoint, to: JourneyPoint): number;
  resting: boolean }): TripPlan | null` (Patch A's chapter rules with four fights at `n × 16 min`: Leaving camp · Into
  {dungeon} · Room 1 · Room 2 · Room 3 · {major name} (`fight-4`) · Heading home or Safe point · Back in camp · Resting),
  played by Patch A's `tripFrame` / `tripPositionOf` at `TRIP_PACE`; `renderDungeonStage(timeline: RevealedTimeline,
  displayNowMs: number, logs: ReadonlyMap<number, PartyBattleLog>): DungeonSceneState` with `{ activityId; displayNowMs; phase: 'depart' | 'exploration' | 'room' |
  'major' | 'safe-return' | 'returning' | 'arrived' | 'preparing' | 'settled'; stages; current; progress; route; fight: {
  ordinal; log; elapsedMs; finished } | null; party: { unitId; name; role; hp; max }[]; summary }` and
  `DUNGEON_JOURNEY = ['start', 'search-1', 'encounter-1', 'search-2', 'encounter-2', 'search-3', 'encounter-3',
  'search-4', 'end']` (the major at `search-4`); `groupPartyReplay(log: PartyBattleLog)`, `reducePartyReplay(log:
  PartyBattleLog, throughMs: number): PartyReplayFrame` (`{ throughMs; hp: number[]; maxHp: number[]; groupIndex; group;
  appliedEvents; finished; result: { winnerSide; victoryReason; tieBreakReason } | null }`); `planPartyStage(log:
  PartyBattleLog, viewport: { width: number; height: number }): PartyStageLayout` (`{ scale: number; units: { id; x; y;
  scale; facing: 'left' | 'right'; hired: boolean }[] }`).

- [ ] **Step 1: Bind Patch A:** check every name in Consumes against Patch A's merged code and record any rename in the
  task report (use the merged name). If Patch A is not merged, stop and tell the controller.
- [ ] **Step 2: Failing pure tests:** `dungeon-stage`: `walks the party out at minute 0 and fights at 16, 32, 48 and
  64`, `hides a fight's label while it is fought`, `reads party health from the logs, a fallen member at 0`, `turns to the
  safe point after a lost room`, `never shows a stage after the display time`, `shows the summary only after settlement`;
  `planDungeonTrip`: `plans the nine chapters with the four fights at real speed and walking at TRIP_PACE`, `ends a lost
  room with Safe point`, `locks the chapters after the cap while the run is live`; `away-trip`: `is running for a dungeon
  with its next fight at 16, 32, 48 or 64` and `names the dungeon`; `party-replay`: `takes health only from the
  logged healthAfter`, `applies a sweep group at once`, `ends with the logged winner side`; `party-stage`: `fits three
  against three on 360 × 740 at an integer scale of at least 2 with no overlap`, `draws the major one integer scale larger
  than the monsters`; `static.test.ts`: `scanner refuses an export without the fixed dungeon page`.
- [ ] **Step 3: Run** `npx --offline --no-install vitest run tests/domain/dungeon-stage.test.ts tests/domain/party-replay.test.ts tests/domain/party-stage.test.ts tests/domain/away-trip.test.ts tests/static.test.ts tests/deployed.test.ts`; expect FAIL.
- [ ] **Step 4: Implement** the pure cores, then the scene, view, route and replay as approved in Task 7 step 3.
- [ ] **Step 5: Browser tests** (`dungeon.spec.ts`, `replay.spec.ts`, fixtures): the watch button opens a running run;
  the party walks and fights at the fixture times; the whole-trip replay plays and its chapters work; a fight opens the
  close-up, which plays, pauses, goes fast, restarts and skips; the `room-lost` run shows the safe point; desktop and
  360 × 740 with no sideways scroll, the longest-fight close-up included (Review Focus 5); reduced motion shows stills;
  Back and Escape return focus; the a11y helpers find no name or contrast issue. Run with the private Playwright config;
  expect PASS.
- [ ] **Step 6: Commit** `feat: watch dungeon runs and replay party fights`.

### Task 9: Trailer, gate, review and release

- [ ] **Step 1: Deployed probes:** add to `tests/browser/deployed-checks.ts` the anonymous M30 probes (`dungeon_fights`
  returns only revealed rows; the new private tables and functions are refused).
- [ ] **Step 2: Trailer:** when the test build is playable, read
  `C:/Users/Avi_OP_PC/Documents/Youtube Channel Videos/.agents/skills/cloudiator-patch-video/SKILL.md` and use
  its grandiose trailer workflow with HyperFrames. Capture real test gameplay, with playable party combat, hires, the
  boss and approved bot presentation. Show Avi the preview and use his approval for rendering. Finish the film,
  thumbnail, story and feature-post kit before shipping. Ask separately before any upload or post.
- [ ] **Step 3: Gate:** after any reboot start Docker Desktop, then serve Edge from Design with
  `npx --offline --no-install supabase functions serve --env-file .env.edge.local`. Check both private browser-config
  modes and helpers. Run the native32 gate of record on the exact candidate and retain complete reports for all 12 stages.
- [ ] **Step 4: Review:** a fresh reviewer checks the whole branch against the spec; fix what it finds; rerun the affected
  tests and the gate.
- [ ] **Step 5: Hosted pre-checks (aggregate reads only):** confirm 1.7.1 on `release`, M01–M29 and active v2, no open
  boundary, zero recent failed jobs, and a quiet window outside Wednesday and Saturday 17:20–20:00 UTC.
- [ ] **Step 6: Release with separate explicit Avi go for each write.** Show the actual patch note and candidate proof.
  Check `npx --offline --no-install supabase db push --dry-run --skip-vault` lists only M30, then on migration go use
  `db push --skip-vault --yes`. Compare fingerprint and audit to the local replay via aggregate checks. On individual
  go, deploy and verify `game-worker` first, then `game-command`. On client go, fast-forward `release` and verify the
  exact Pages deployment and live probes. Each production command runs only in the approved linked release worktree.
- [ ] **Step 7: Register bots, note and record.** After the client is verified, use the local-proven bot operator script
  to create and activate the five identities only on Avi's exact go. Verify counts, labels and inactive competitors using
  aggregate checks. Post the approved §12 note on its own go. On the next
  explicit go run the linked patch record generated by `node scripts/patch-statement.mjs 1.8`. Verify visibility,
  `latest_patch` and feature count through aggregate reads.
- [ ] **Step 8: Watch the first afternoon and next boundary** with aggregate publication, grouping, settlement and job
  health checks. Confirm no failed or operator jobs or duplicate grants and record actual settlement timing.
- [ ] **Step 9: Record** the evidence in `docs/operations/release-evidence.md` and `deployment.md`, update
  `docs/implementation/HANDOFF.md`; commit `deploy: ship party dungeons (M30)`.
