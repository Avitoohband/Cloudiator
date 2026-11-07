import type { DungeonId, LeagueId } from '../contracts/commands.ts';
import type { ItemRarity } from '../contracts/events.ts';
import { CATALOG_V1 } from './catalog-v1.ts';
import { RULES_V2 } from './rules-v2.ts';
import { isRulesV2 } from './rules.ts';
import type { Rules } from './types.ts';
import { freezeDomain } from './types.ts';

// Patch 1.6 (spec 2026-10-30-economy-1-6-design.md, "Domain"): the only place that knows how the rules versions' economies
// differ. Every consumer (builds, expeditions, tournaments, inventory, the worker, the client's texts) asks these accessors
// with the rules of its own activity; none reads `expeditionRewards`, the Training cap or a prize table directly. For
// RULES_V1 each answers today's value, unchanged. The catalog stays CATALOG_V1 for both versions.

export type ExpeditionId = 'woodland' | 'outpost' | 'mountain';
export type ExpeditionReward = { xp: number; money: number; salvageQuantity: number; gearChance: number; gearTier: 1 | 5 | 10 };
export type DungeonReward = {
  room: { xp: number; money: number }; major: { xp: number; money: number };
  chest: { salvageQuantity: number; gearChance: number; gearTier: 1 | 5 | 10; rarity: Record<ItemRarity, number> };
};
export type PrizeAmount = { money: number; renown: number };
export type TournamentPrizes = { winner: PrizeAmount; runnerUp: PrizeAmount; semifinal: PrizeAmount; other: PrizeAmount };
export type SeasonPrize = { money: number; renown: number; title: 'champion' | null; badge: 'gold' | 'silver' | 'bronze' };

/** A league of the game: RULES_V2's prize tables have one row per league (pinned equal to arena.ts's LEAGUES by test). */
function checkLeague(league: unknown): asserts league is LeagueId {
  if (typeof league !== 'string' || !Object.hasOwn(RULES_V2.tournament.placementsByLeague, league)) throw new RangeError('Unknown league');
}

function checkCount(value: unknown, minimum: number, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new RangeError(`Invalid ${name}`);
}

/**
 * An expedition's rewards under `rules`. v1: the catalog entry's (`CATALOG_V1.expeditions[id].rewards`). v2: the catalog's
 * salvage quantity and gear tier, with XP, gold and gear chance from `rules.expeditionRewards`. Unknown ids are a RangeError.
 */
export function expeditionReward(rules: Rules, id: ExpeditionId): ExpeditionReward {
  if (typeof id !== 'string' || !Object.hasOwn(CATALOG_V1.expeditions, id)) throw new RangeError('Unknown expedition');
  const base = CATALOG_V1.expeditions[id].rewards;
  if (!isRulesV2(rules)) return base;
  const { xp, money, gearChance } = rules.expeditionRewards[id];
  return freezeDomain({ xp, money, salvageQuantity: base.salvageQuantity, gearChance, gearTier: base.gearTier });
}

/** Per-member v2 payouts for each won fight entered and its major chest. Dungeons never pay under v1. */
export function dungeonReward(rules: Rules, id: DungeonId): DungeonReward {
  if (!isRulesV2(rules) || !rules.dungeon) throw new RangeError('Dungeon rewards require v2');
  if (typeof id !== 'string' || !Object.hasOwn(rules.dungeon.rewardsById, id)) throw new RangeError('Unknown dungeon');
  return rules.dungeon.rewardsById[id];
}

/** Maximum actual Training activities per game day: unlimited in v1 (null), two in v2, independent of the point cap. */
export function trainingDailyLimit(rules: Rules): number | null {
  return isRulesV2(rules) ? rules.progression.maxTrainingActivitiesPerGameDay : null;
}

/** The most earned attribute points Training adds to at `level`: none in v1 (null), `base + perLevel × level` in v2. */
export function trainingCap(rules: Rules, level: number): number | null {
  checkCount(level, 1, 'level');
  if (!isRulesV2(rules)) return null;
  const { trainingCapBase, trainingCapPerLevel } = rules.progression;
  return trainingCapBase + trainingCapPerLevel * level;
}

/**
 * The points one Training credits a gladiator at `level` with `earnedPoints` (every attribute point it has, the 10 from
 * creation included). v1: `progression.trainingPoints` always. v2: the same while earned points are below the cap, else 0.
 * Points above the cap are kept; Training just stops until the level catches up.
 */
export function trainingPoints(rules: Rules, level: number, earnedPoints: number): number {
  checkCount(earnedPoints, 0, 'earned points');
  const cap = trainingCap(rules, level);
  return cap === null || earnedPoints < cap ? rules.progression.trainingPoints : 0;
}

/** A tournament's placement prizes for a bracket of `league`: the same in every league in v1, by league in v2. */
export function tournamentPlacements(rules: Rules, league: LeagueId): TournamentPrizes {
  checkLeague(league);
  return isRulesV2(rules) ? rules.tournament.placementsByLeague[league] : rules.tournament.placements;
}

/** A season's prizes for 1st, 2nd and 3rd in `league`: the same in every league in v1, by league in v2. */
export function seasonPrizes(rules: Rules, league: LeagueId): readonly SeasonPrize[] {
  checkLeague(league);
  // The rules type a title and a badge as text; their values are exactly SeasonPrize's (pinned by test).
  return (isRulesV2(rules) ? rules.seasons.placementsByLeague[league] : rules.seasons.placements) as readonly SeasonPrize[];
}

/** What a merchant pays for one unit of salvage, and what an overflowing unit converts to. */
export function salvageSellValue(rules: Rules): number {
  return rules.inventory.salvageSellValue;
}
