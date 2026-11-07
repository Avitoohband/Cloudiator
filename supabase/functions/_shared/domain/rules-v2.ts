import type { DungeonId } from '../contracts/commands.ts';
import type { DungeonReward } from './economy.ts';
import { RULES_V1 } from './rules-v1.ts';
import { freezeDomain } from './types.ts';

const chestRarity = { common: 0.4, uncommon: 0.45, rare: 0.15 };
const rewardsById = {
  'wolf-den': { room: { xp: 6, money: 1 }, major: { xp: 30, money: 5 },
    chest: { salvageQuantity: 1, gearChance: 0.3, gearTier: 1, rarity: chestRarity } },
  'raider-stronghold': { room: { xp: 15, money: 2 }, major: { xp: 75, money: 10 },
    chest: { salvageQuantity: 2, gearChance: 0.3, gearTier: 5, rarity: chestRarity } },
  'troll-hall': { room: { xp: 30, money: 4 }, major: { xp: 150, money: 18 },
    chest: { salvageQuantity: 3, gearChance: 0.3, gearTier: 10, rarity: chestRarity } },
} satisfies Record<DungeonId, DungeonReward>;

/**
 * Patch 1.6's economy (spec 2026-10-30-economy-1-6-design.md, "RULES_V2 (exact)"): every key of RULES_V1 with the same value,
 * except expedition XP, gold and gear chance (`expeditionRewards`, which overrides the catalog's), the salvage value, the
 * Training cap (10 + 4 × level), two actual Trainings per game day, free tournament stamina and tournament and season prizes by league (`placementsByLeague`, which replaces
 * `placements`). It is a separate immutable version: an activity is paid by the version of the boundary that froze it, so
 * RULES_V1 stays unchanged and retained. Read economy differences through economy.ts. Patch 1.8 adds dungeon
 * capability to v2; the existing rules and payouts keep their values.
 */
export const RULES_V2 = freezeDomain({
  ...RULES_V1,
  version: 'v2',
  schedule: { ...RULES_V1.schedule, dungeonPhases: ['afternoon'] as const },
  progression: { trainingPoints: 1, xpPerCurrentLevel: 100, levelAttributePoints: 0, levelStaminaRefill: 0,
    trainingCapBase: 10, trainingCapPerLevel: 4, maxTrainingActivitiesPerGameDay: 2 },
  activityStamina: { ...RULES_V1.activityStamina, tournament: 0, dungeon: 40 },
  inventory: { capacity: 60, salvageStack: 999, salvageSellValue: 4 },
  // Gear drops halved (Avi's answer, 2026-10-30): 10 / 15 / 20 %. Salvage a run and the gear tier stay the catalog's.
  expeditionRewards: { woodland: { xp: 30, money: 4, gearChance: 0.1 }, outpost: { xp: 75, money: 10, gearChance: 0.15 },
    mountain: { xp: 150, money: 18, gearChance: 0.2 } },
  // The league is the bracket's. Gold scales 0.4 / 0.6 / 0.8 / 1.0 on v1's; renown is v1's in every league.
  tournament: { utcWeekdays: [3, 6], hourUtc: 18, minuteUtc: 40, minimumEntrants: 2, durationMs: 4_800_000,
    placementsByLeague: {
      bronze: { winner: { money: 40, renown: 50 }, runnerUp: { money: 24, renown: 30 }, semifinal: { money: 12, renown: 15 }, other: { money: 0, renown: 5 } },
      silver: { winner: { money: 60, renown: 50 }, runnerUp: { money: 36, renown: 30 }, semifinal: { money: 18, renown: 15 }, other: { money: 0, renown: 5 } },
      gold: { winner: { money: 80, renown: 50 }, runnerUp: { money: 48, renown: 30 }, semifinal: { money: 24, renown: 15 }, other: { money: 0, renown: 5 } },
      champion: { winner: { money: 100, renown: 50 }, runnerUp: { money: 60, renown: 30 }, semifinal: { money: 30, renown: 15 }, other: { money: 0, renown: 5 } },
    } },
  // 1st, 2nd, 3rd of each league; a season pays the version that opened it (M27's private.season_prizes restates them).
  seasons: { durationSlots: 504, durationMs: 2_419_200_000, minimumHumanBouts: 5,
    placementsByLeague: {
      bronze: [{ money: 200, renown: 100, title: 'champion', badge: 'gold' }, { money: 120, renown: 60, title: null, badge: 'silver' }, { money: 80, renown: 40, title: null, badge: 'bronze' }],
      silver: [{ money: 300, renown: 100, title: 'champion', badge: 'gold' }, { money: 180, renown: 60, title: null, badge: 'silver' }, { money: 120, renown: 40, title: null, badge: 'bronze' }],
      gold: [{ money: 400, renown: 100, title: 'champion', badge: 'gold' }, { money: 240, renown: 60, title: null, badge: 'silver' }, { money: 160, renown: 40, title: null, badge: 'bronze' }],
      champion: [{ money: 500, renown: 100, title: 'champion', badge: 'gold' }, { money: 300, renown: 60, title: null, badge: 'silver' }, { money: 200, renown: 40, title: null, badge: 'bronze' }],
    } },
  dungeon: { seats: 3, fightIntervalMs: 960_000, recovery: 0.2, hiredMultiplier: 0.9,
    targetWeights: { defensive: 3, balanced: 2, offensive: 1 }, sweepEvery: 4, sweepFactor: 0.6, overLevelFactor: 0.5, rewardsById },
});
