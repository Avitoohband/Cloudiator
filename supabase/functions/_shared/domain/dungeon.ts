import type { DungeonId } from '../contracts/commands.ts';
import type { PartyBattleLog, RevealedStage } from '../contracts/events.ts';
import { validateBuild } from './build.ts';
import { CATALOG_V1 } from './catalog-v1.ts';
import { decimal, fractionValue, makeFighter, multiply } from './combat.ts';
import { dungeonReward, type DungeonReward } from './economy.ts';
import type { LootGrant } from './inventory.ts';
import { simulateSkirmish, type SkirmishUnit } from './party-combat.ts';
import { seededRandom } from './random.ts';
import { isRulesV2, requireRetained } from './rules.ts';
import { freezeDomain, type BuildSnapshot, type Catalog, type DeepReadonly, type Dungeon, type DungeonMonster,
  type EquipmentSlot, type FighterSnapshot, type HiredRole, type ItemInstance, type Rules, type Seed, type Stance } from './types.ts';

type Seat = 0 | 1 | 2;
type Ordinal = 1 | 2 | 3 | 4;
export type DungeonBot = Readonly<{ gladiatorId: string; activityId: string; name: string; level: number; role: HiredRole }>;
export type DungeonSeat = DeepReadonly<
  { seat: Seat; kind: 'human'; gladiatorId: string; activityId: string; name: string; level: number; build: BuildSnapshot }
  | (DungeonBot & { seat: Seat; kind: 'bot' })
  | { seat: Seat; kind: 'hireling'; role: HiredRole }
>;
type HumanSeat = Extract<DungeonSeat, { kind: 'human' }>;
export type DungeonRunInput = DeepReadonly<{ kind: 'dungeon'; runId: string; slotIndex: number; rulesVersion: string;
  dungeonId: DungeonId; startsAtMs: number; seats: DungeonSeat[] }>;
export type DungeonFight = DeepReadonly<{ ordinal: Ordinal; kind: 'room' | 'major'; offsetMs: number; log: PartyBattleLog; won: boolean }>;
export type DungeonMemberOutcome = DeepReadonly<{ gladiatorId: string; activityId: string; result: 'victory' | 'defeat';
  success: boolean; entered: number[]; won: number[]; overLevel: boolean; rewards: { xp: number; money: number; loot: LootGrant[] } }>;
export type DungeonRunPlan = DeepReadonly<{ runId: string; rulesVersion: string; catalogVersion: string; dungeonId: DungeonId;
  fights: DungeonFight[]; stages: RevealedStage[]; outcomes: DungeonMemberOutcome[] }>;

const HIRED_ROLES = ['guard', 'striker', 'skirmisher'] as const;
const HIRED_STANCE: Readonly<Record<HiredRole, Stance>> = { guard: 'defensive', striker: 'offensive', skirmisher: 'balanced' };
const HIRED_NAME: Readonly<Record<HiredRole, string>> = { guard: 'Guard', striker: 'Striker', skirmisher: 'Skirmisher' };

function dungeonRules(rules: Rules) {
  const retained = requireRetained(rules);
  if (!isRulesV2(retained)) throw new RangeError('Dungeons require retained v2 rules');
  return retained;
}

function catalogItem(id: string): ItemInstance {
  const item = CATALOG_V1.items[id];
  if (!item) throw new RangeError('Unknown hired fighter equipment');
  return { id, ownerId: 'hireling', catalogId: id, catalogVersion: CATALOG_V1.version, tier: item.tier,
    rarity: item.rarity, stats: item.stats, quantity: 1, origin: 'shop', binding: item.binding, reservation: null };
}

export function hiredFighter(dungeon: Dungeon, role: HiredRole, rules: Rules): FighterSnapshot {
  const retained = dungeonRules(rules);
  if (!Object.hasOwn(dungeon.hired, role)) throw new RangeError('Unknown hired fighter role');
  const { classId, stance, allocations, equipment } = dungeon.hired[role];
  const kit = Object.fromEntries(Object.entries(equipment).map(([slot, id]) => [slot, id === null ? null : catalogItem(id)])) as
    Record<EquipmentSlot, ItemInstance | null>;
  const fighter = makeFighter({ rulesVersion: retained.version, classId, stance, allocations, equipment: kit }, 'expedition', retained);
  const factor = decimal(retained.dungeon.hiredMultiplier);
  const health = multiply(decimal(fighter.maxHealth), factor);
  return freezeDomain({ ...fighter, maxHealth: Math.max(1, Number(health.numerator / health.denominator)),
    baseDamage: fractionValue(multiply(decimal(fighter.baseDamage), factor)) });
}

export function hiredRolesFor(humanStances: readonly Stance[]): HiredRole[] {
  const empty = HIRED_ROLES.length - humanStances.length;
  const available: HiredRole[] = HIRED_ROLES.filter(role => !humanStances.includes(HIRED_STANCE[role]));
  while (available.length < empty) available.push('skirmisher');
  return available.slice(0, Math.max(0, empty));
}

export function monsterFighter(monster: DungeonMonster, rules: Rules): FighterSnapshot {
  return freezeDomain({ rulesVersion: rules.version, classId: null, stance: monster.stance, attributes: { ...monster.attributes },
    maxHealth: monster.maxHp, armor: monster.armor, weaponDamage: monster.damage, baseDamage: monster.damage,
    attackIntervalMs: monster.intervalMs, efficiency: 1, equipmentSilhouettes: [] });
}

export function dungeonChestLoot(reward: DungeonReward, catalog: Catalog, random: () => number, salvageOnly: boolean): LootGrant[] {
  const chest = reward.chest;
  const loot: LootGrant[] = [{ catalogId: catalog.salvage.id, catalogVersion: catalog.version,
    quantity: chest.salvageQuantity, origin: 'expedition' }];
  if (salvageOnly || random() >= chest.gearChance) return loot;
  const roll = random();
  // The rarity distribution is normalized. Subtracting rare keeps the .85 threshold exact for v2.
  const rarity = roll < chest.rarity.common ? 'common' : roll < 1 - chest.rarity.rare ? 'uncommon' : 'rare';
  const candidates = Object.values(catalog.items).filter(item => item.tier === chest.gearTier && item.rarity === rarity && item.renownPrice === null)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const gear = candidates[Math.floor(random() * candidates.length)];
  if (!gear) throw new RangeError('Invalid dungeon loot roll');
  loot.push({ catalogId: gear.id, catalogVersion: catalog.version, quantity: 1, origin: 'expedition' });
  return loot;
}

export function dungeonPartyLabel(dungeon: Dungeon, seats: readonly DungeonSeat[]): string {
  const names = seats.map(seat => seat.kind === 'hireling' ? `a hired ${HIRED_NAME[seat.role]}` : seat.name);
  return `Enter ${dungeon.name} with ${names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`;
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nonnegativeInt = (value: number) => Number.isSafeInteger(value) && value >= 0;
const ITEM_ORIGINS = ['starter', 'shop', 'expedition', 'renown'] as const;

export function validDungeonBot(bot: DungeonBot, requiredLevel: number, maximumLevel: number): boolean {
  return !!bot && typeof bot === 'object' && !Array.isArray(bot)
    && nonempty(bot.gladiatorId) && nonempty(bot.activityId) && nonempty(bot.name)
    && Number.isSafeInteger(bot.level) && bot.level >= requiredLevel && bot.level <= maximumLevel
    && typeof bot.role === 'string' && Object.hasOwn(HIRED_NAME, bot.role);
}

/** Validate frozen equipment and rolls through the normal build validator. Training caps limit new points, not existing builds. */
export function frozenDungeonHumanFighter(build: BuildSnapshot, level: number, rules: Rules): FighterSnapshot {
  if (!build || build.rulesVersion !== rules.version || !build.equipment || typeof build.equipment !== 'object') {
    throw new RangeError('Invalid frozen dungeon build');
  }
  const owned: ItemInstance[] = [];
  const equipment = Object.fromEntries(Object.entries(build.equipment).map(([slot, item]) => {
    if (item === null) return [slot, null];
    if (!item || typeof item !== 'object' || !nonempty(item.id) || !nonempty(item.ownerId) || !ITEM_ORIGINS.includes(item.origin)
      || (item.binding !== 'bound' && item.binding !== 'tradable')
      || (item.reservation !== null && (item.reservation?.kind !== 'equipment' || !nonempty(item.reservation.referenceId)))) {
      throw new RangeError('Invalid frozen dungeon equipment');
    }
    owned.push(item);
    return [slot, item.id];
  })) as Record<EquipmentSlot, string | null>;
  const validated = validateBuild({ classId: build.classId, stance: build.stance, allocation: build.allocations, equipment },
    owned, rules.attributes.maximumPoints, level, rules);
  if (!validated.ok) throw new RangeError('Invalid frozen dungeon build');
  return makeFighter(build, 'expedition', rules);
}

/** Pure private run authority. Only due stages and their whitelisted fight logs can be revealed. */
export function planDungeonRun(input: DungeonRunInput, seed: Seed, rules: Rules): DungeonRunPlan {
  const retained = dungeonRules(rules);
  const { seats, fightIntervalMs, recovery, overLevelFactor } = retained.dungeon;
  const slotMs = retained.clock.slotMs;
  if (!input || input.kind !== 'dungeon' || input.rulesVersion !== retained.version || !nonempty(seed)
    || !nonempty(input.runId) || !nonnegativeInt(input.slotIndex) || !nonnegativeInt(input.startsAtMs)
    || !Number.isSafeInteger(input.startsAtMs + slotMs) || !nonempty(input.dungeonId)
    || !Object.hasOwn(CATALOG_V1.dungeons, input.dungeonId) || !Array.isArray(input.seats) || input.seats.length !== seats) {
    throw new RangeError('Invalid dungeon run input');
  }
  const { runId, dungeonId, startsAtMs } = input;
  const dungeon = CATALOG_V1.dungeons[dungeonId];
  const reward = dungeonReward(retained, dungeonId);
  const humans: HumanSeat[] = [];
  const ids = new Set<string>(), activities = new Set<string>();
  let party: SkirmishUnit[] = [];
  for (const [index, seat] of (input.seats as readonly DungeonSeat[]).entries()) {
    if (!seat || seat.seat !== index) throw new RangeError('Invalid dungeon seat order');
    if (seat.kind === 'human') {
      if (index !== humans.length || !nonempty(seat.gladiatorId) || !nonempty(seat.activityId) || !nonempty(seat.name)
        || ids.has(seat.gladiatorId) || activities.has(seat.activityId) || !Number.isSafeInteger(seat.level)
        || seat.level < dungeon.requiredLevel || seat.level > retained.attributes.maximumLevel) {
        throw new RangeError('Invalid dungeon member');
      }
      humans.push(seat);
      ids.add(seat.gladiatorId);
      activities.add(seat.activityId);
      party.push({ id: seat.gladiatorId, gladiatorId: seat.gladiatorId, name: seat.name, side: 0, role: 'gladiator',
        seat: seat.seat, snapshot: frozenDungeonHumanFighter(seat.build, seat.level, retained) });
    } else if (seat.kind === 'bot') {
      if (humans.length === 0 || party.some(unit => unit.role === 'hireling')
        || !validDungeonBot(seat, dungeon.requiredLevel, retained.attributes.maximumLevel)
        || ids.has(seat.gladiatorId) || activities.has(seat.activityId)) throw new RangeError('Invalid dungeon bot');
      ids.add(seat.gladiatorId);
      activities.add(seat.activityId);
      party.push({ id: seat.gladiatorId, gladiatorId: seat.gladiatorId, name: seat.name, side: 0, role: 'bot',
        seat: seat.seat, snapshot: hiredFighter(dungeon, seat.role, retained) });
    } else if (seat.kind === 'hireling' && typeof seat.role === 'string' && Object.hasOwn(HIRED_NAME, seat.role)) {
      party.push({ id: `hired:${seat.seat}`, gladiatorId: null, name: `Hired ${HIRED_NAME[seat.role]}`, side: 0,
        role: 'hireling', seat: seat.seat, snapshot: hiredFighter(dungeon, seat.role, retained) });
    } else throw new RangeError('Invalid dungeon seat');
  }
  if (humans.length === 0) throw new RangeError('A dungeon party requires a human member');

  const fights: DungeonFight[] = [], stages: RevealedStage[] = [];
  const stage = (kind: RevealedStage['kind'], offset: number, end: number, label: string, ordinal?: Ordinal) => {
    stages.push({ id: `${runId}:${stages.length}`, kind, revealedAtMs: startsAtMs + offset, startedAtMs: startsAtMs + offset,
      endsAtMs: startsAtMs + end, label, ...(ordinal === undefined ? {} : { fight: { runId, ordinal } }) });
  };
  stage('depart', 0, fightIntervalMs, dungeonPartyLabel(dungeon, input.seats));
  for (const ordinal of [1, 2, 3, 4] as const) {
    const kind = ordinal === 4 ? 'major' : 'room';
    const offsetMs = ordinal * fightIntervalMs;
    const monsters = ordinal === 4 ? [dungeon.major] : dungeon.rooms[ordinal - 1];
    const enemies = monsters.map((monster, index): SkirmishUnit => ({ id: `creature:${monster.creature}:${ordinal}:${index + 1}`,
      gladiatorId: null, name: monster.name, side: 1, role: kind === 'major' ? 'major' : 'monster', seat: null,
      snapshot: monsterFighter(monster, retained) }));
    const log = simulateSkirmish({ battleId: `${runId}:fight:${ordinal}`, rulesVersion: retained.version, rules: retained,
      units: [...party, ...enemies] }, `${seed}:fight:${ordinal}`);
    const won = log.winnerSide === 0;
    const end = offsetMs + log.durationMs;
    fights.push({ ordinal, kind, offsetMs, log, won });
    stage(kind, offsetMs, end, `${kind === 'major' ? dungeon.major.name : `Room ${ordinal}`}: ${won ? 'victory' : 'defeat'}`, ordinal);
    if (won && kind === 'major') {
      stage('travel', end, slotMs, 'Return to camp');
      break;
    }
    if (won) party = party.flatMap((unit, index) => {
      const hp = log.finalHp[index];
      const maximum = unit.snapshot.maxHealth;
      return hp === 0 ? [] : [{ ...unit, startingHealth: Math.min(maximum, hp + Math.floor(recovery * maximum)) }];
    });
    if (!won || party.length === 0) {
      stage('return', end, slotMs, 'Rest at the safe return point');
      break;
    }
    stage('exploration', end, offsetMs + fightIntervalMs, 'Recover and go deeper');
  }
  stage('return', slotMs, slotMs, 'Arrive at camp');

  const outcomes = humans.map((member): DungeonMemberOutcome => {
    const entered = fights.filter(fight => fight.log.participants.some(unit => unit.gladiatorId === member.gladiatorId));
    const won = entered.filter(fight => fight.won);
    const success = won.some(fight => fight.ordinal === 4);
    const overLevel = dungeon.fullRewardsMaxLevel !== null && member.level > dungeon.fullRewardsMaxLevel;
    let xp = 0, money = 0;
    for (const fight of won) {
      xp += reward[fight.kind].xp;
      money += reward[fight.kind].money;
    }
    const loot = success ? dungeonChestLoot(reward, CATALOG_V1, seededRandom(`${seed}:loot:${member.gladiatorId}`), overLevel) : [];
    return { gladiatorId: member.gladiatorId, activityId: member.activityId, entered: entered.map(fight => fight.ordinal),
      won: won.map(fight => fight.ordinal), overLevel, result: success ? 'victory' : 'defeat', success,
      rewards: { xp: overLevel ? Math.floor(overLevelFactor * xp) : xp, money: overLevel ? Math.floor(overLevelFactor * money) : money, loot } };
  });
  return freezeDomain({ runId, dungeonId, rulesVersion: retained.version, catalogVersion: CATALOG_V1.version, fights, stages, outcomes });
}
