import { RULES_V1 } from './rules-v1.ts';
import { freezeDomain } from './types.ts';

/**
 * Patch 1.6's economy (spec 2026-10-30-economy-1-6-design.md, "RULES_V2 (exact)"): every key of RULES_V1 with the same value,
 * except expedition XP, gold and gear chance (`expeditionRewards`, which overrides the catalog's), the salvage value, the
 * Training cap (10 + 4 × level) and tournament and season prizes by league (`placementsByLeague`, which replaces
 * `placements`). It is a separate immutable version: an activity is paid by the version of the boundary that froze it, so
 * RULES_V1 stays unchanged and retained. Read the differences through economy.ts, never here directly.
 */
export const RULES_V2 = freezeDomain({
  ...RULES_V1,
  version: 'v2',
  progression: { trainingPoints: 1, xpPerCurrentLevel: 100, levelAttributePoints: 0, levelStaminaRefill: 0,
    trainingCapBase: 10, trainingCapPerLevel: 4 },
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
});
