import { describe, expect, it } from 'vitest';
import { LEAGUES } from '@domain/arena.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { expeditionReward, salvageSellValue, seasonPrizes, tournamentPlacements, trainingCap, trainingDailyLimit, trainingPoints, type ExpeditionId } from '@domain/economy.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import { RETAINED_RULES, requireRetained, retainedRules } from '@domain/rules.ts';
import type { Rules } from '@domain/types.ts';
import type { LeagueId } from '@contracts/commands.ts';

// Patch 1.6 (spec "Domain"; plan Task 1): economy.ts is the only place that knows how the rules versions differ. Each accessor
// answers v1's value for RULES_V1 (today's game, unchanged) and the spec's v2 value for RULES_V2.
const EXPEDITIONS: readonly ExpeditionId[] = ['woodland', 'outpost', 'mountain'];
const BAD_COUNTS = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined];

describe('economy accessors', () => {
  it('limits actual Training activities per game day in v2 alone', () => {
    expect(trainingDailyLimit(RULES_V1)).toBeNull();
    expect(trainingDailyLimit(RULES_V2)).toBe(2);
  });
  it('answers each expedition reward by version', () => {
    expect(expeditionReward(RULES_V1, 'outpost')).toEqual({ xp: 250, money: 60, salvageQuantity: 2, gearChance: 0.3, gearTier: 5 });
    expect(expeditionReward(RULES_V2, 'outpost')).toEqual({ xp: 75, money: 10, salvageQuantity: 2, gearChance: 0.15, gearTier: 5 });
    expect(expeditionReward(RULES_V2, 'woodland')).toEqual({ xp: 30, money: 4, salvageQuantity: 1, gearChance: 0.1, gearTier: 1 });
    expect(expeditionReward(RULES_V2, 'mountain')).toEqual({ xp: 150, money: 18, salvageQuantity: 3, gearChance: 0.2, gearTier: 10 });
    for (const id of EXPEDITIONS) expect(expeditionReward(RULES_V1, id)).toEqual(CATALOG_V1.expeditions[id].rewards);
    for (const id of ['cave', 'toString', '__proto__', ''] as unknown as ExpeditionId[]) {
      expect(() => expeditionReward(RULES_V1, id), String(id)).toThrow(RangeError);
      expect(() => expeditionReward(RULES_V2, id), String(id)).toThrow(RangeError);
    }
  });

  it('caps Training at 10 + 4 × level in v2 alone', () => {
    expect(trainingCap(RULES_V1, 10)).toBeNull();
    expect([1, 2, 5, 10, 12, 15, 20].map(level => trainingCap(RULES_V2, level))).toEqual([14, 18, 30, 50, 58, 70, 90]);
    expect([trainingPoints(RULES_V1, 1, 94), trainingPoints(RULES_V2, 1, 13), trainingPoints(RULES_V2, 1, 14), trainingPoints(RULES_V2, 1, 94)])
      .toEqual([1, 1, 0, 0]);
    expect([trainingPoints(RULES_V2, 10, 49), trainingPoints(RULES_V2, 10, 50), trainingPoints(RULES_V2, 22, 94), trainingPoints(RULES_V2, 21, 94)])
      .toEqual([1, 0, 1, 0]);
    expect(trainingPoints(RULES_V1, 1, 0)).toBe(RULES_V1.progression.trainingPoints);
  });

  it('refuses a level below 1 or negative earned points, in either version', () => {
    expect(() => trainingPoints(RULES_V2, 0, 10)).toThrow(RangeError);
    for (const rules of [RULES_V1, RULES_V2]) {
      for (const level of [0, ...BAD_COUNTS]) {
        expect(() => trainingCap(rules, level as number), `${rules.version} cap level ${String(level)}`).toThrow(RangeError);
        expect(() => trainingPoints(rules, level as number, 10), `${rules.version} level ${String(level)}`).toThrow(RangeError);
      }
      for (const earned of BAD_COUNTS) {
        expect(() => trainingPoints(rules, 1, earned as number), `${rules.version} earned ${String(earned)}`).toThrow(RangeError);
      }
    }
  });

  it('answers tournament prizes by the bracket league in v2, the same in every league in v1', () => {
    expect(tournamentPlacements(RULES_V1, 'bronze').winner).toEqual({ money: 100, renown: 50 });
    for (const league of LEAGUES) expect(tournamentPlacements(RULES_V1, league)).toEqual(RULES_V1.tournament.placements);
    expect(LEAGUES.map(l => tournamentPlacements(RULES_V2, l).runnerUp.money)).toEqual([24, 36, 48, 60]);
    expect(tournamentPlacements(RULES_V2, 'silver')).toEqual({ winner: { money: 60, renown: 50 }, runnerUp: { money: 36, renown: 30 },
      semifinal: { money: 18, renown: 15 }, other: { money: 0, renown: 5 } });
    for (const league of ['diamond', 'toString', ''] as unknown as LeagueId[]) {
      expect(() => tournamentPlacements(RULES_V1, league), String(league)).toThrow(RangeError);
      expect(() => tournamentPlacements(RULES_V2, league), String(league)).toThrow(RangeError);
    }
  });

  it('answers season prizes by the league in v2, the same in every league in v1', () => {
    expect(seasonPrizes(RULES_V1, 'bronze').map(p => p.money)).toEqual([500, 300, 200]);
    for (const league of LEAGUES) expect(seasonPrizes(RULES_V1, league)).toEqual(RULES_V1.seasons.placements);
    expect(seasonPrizes(RULES_V2, 'silver').map(p => [p.money, p.renown, p.title, p.badge]))
      .toEqual([[300, 100, 'champion', 'gold'], [180, 60, null, 'silver'], [120, 40, null, 'bronze']]);
    expect(LEAGUES.map(l => seasonPrizes(RULES_V2, l)[0].money)).toEqual([200, 300, 400, 500]);
    expect(Object.isFrozen(seasonPrizes(RULES_V2, 'gold'))).toBe(true);
    for (const league of ['diamond', 'toString', ''] as unknown as LeagueId[]) {
      expect(() => seasonPrizes(RULES_V1, league), String(league)).toThrow(RangeError);
      expect(() => seasonPrizes(RULES_V2, league), String(league)).toThrow(RangeError);
    }
  });

  it('answers the salvage value by version', () => {
    expect([salvageSellValue(RULES_V1), salvageSellValue(RULES_V2)]).toEqual([10, 4]);
  });

  it('retains v1 and v2', () => {
    expect(retainedRules('v2')).toBe(RULES_V2);
    expect(() => retainedRules('v3')).toThrow(RangeError);
    expect(Object.keys(RETAINED_RULES)).toEqual(['v1', 'v2']);
  });

  it('accepts only the retained constants themselves, never a copy', () => {
    expect([requireRetained(RULES_V1), requireRetained(RULES_V2)]).toEqual([RULES_V1, RULES_V2]);
    expect(requireRetained(RULES_V2)).toBe(RULES_V2);
    for (const copy of [{ ...RULES_V1 }, structuredClone(RULES_V2), Object.freeze({ ...RULES_V2 })] as Rules[]) {
      expect(() => requireRetained(copy)).toThrow(RangeError);
      expect(() => requireRetained(copy)).toThrow('Rules must be the retained constants, never a copy');
    }
    expect(() => requireRetained({ ...RULES_V2, version: 'v9' } as unknown as Rules)).toThrow('Unsupported rules version');
  });
});
