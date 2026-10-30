import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LEAGUES, RETAINED_RULES as ARENA_RETAINED_RULES } from '@domain/arena.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import { isRulesV2, RETAINED_RULES, retainedRules } from '@domain/rules.ts';

// Patch 1.6 (spec 2026-10-30-economy-1-6-design.md, "RULES_V2 (exact)"; plan Task 1). RULES_V2 is a second immutable rules
// version beside RULES_V1: every value the same except the economy keys. RULES_V1 and CATALOG_V1 keep every value (an activity
// frozen under v1 settles under v1), pinned here by hash.
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Computed before any 1.6 change by a throwaway test that printed hash(RULES_V1) and hash(CATALOG_V1) (never committed).
const V1_RULES_HASH = '22d6600e16dcb46ea7ea621eae9284759bfe5eed023fcf99d5a328b7ad93d2c0';
const V1_CATALOG_HASH = 'd82b1dc5163ea83b98fa0e31f0c20f935a43afb01b4787b1d3aca311fdcfd6dc';

/** Every object reachable from `value` is frozen. */
function deepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

describe('RULES_V2', () => {
  it('keeps every v1 rule and catalog value', () => {
    expect(hash(RULES_V1)).toBe(V1_RULES_HASH);
    expect(hash(CATALOG_V1)).toBe(V1_CATALOG_HASH);
  });

  const ECONOMY = ['version', 'progression', 'inventory', 'expeditionRewards', 'tournament', 'seasons'] as const;
  it('differs from v1 only in the economy keys', () => {
    const rest = (rules: object) => Object.fromEntries(Object.entries(rules).filter(([key]) => !ECONOMY.includes(key as never)));
    expect(Object.keys(rest(RULES_V2)).sort()).toEqual(Object.keys(rest(RULES_V1)).sort());
    expect(rest(RULES_V2)).toEqual(rest(RULES_V1));
    expect({ ...RULES_V2.progression, trainingCapBase: undefined, trainingCapPerLevel: undefined })
      .toEqual({ ...RULES_V1.progression, trainingCapBase: undefined, trainingCapPerLevel: undefined });
    expect({ ...RULES_V2.tournament, placementsByLeague: undefined })
      .toEqual({ ...RULES_V1.tournament, placements: undefined, placementsByLeague: undefined });
    expect({ ...RULES_V2.seasons, placementsByLeague: undefined })
      .toEqual({ ...RULES_V1.seasons, placements: undefined, placementsByLeague: undefined });
    expect(Object.keys(RULES_V2.inventory)).toEqual(Object.keys(RULES_V1.inventory));
    expect({ ...RULES_V2.inventory, salvageSellValue: undefined }).toEqual({ ...RULES_V1.inventory, salvageSellValue: undefined });
  });

  it('holds the spec values', () => {
    expect(RULES_V2.version).toBe('v2');
    expect(RULES_V2.expeditionRewards).toEqual({ woodland: { xp: 30, money: 4, gearChance: 0.1 },
      outpost: { xp: 75, money: 10, gearChance: 0.15 }, mountain: { xp: 150, money: 18, gearChance: 0.2 } });
    expect(RULES_V2.inventory).toEqual({ capacity: 60, salvageStack: 999, salvageSellValue: 4 });
    expect(RULES_V2.progression).toEqual({ trainingPoints: 1, xpPerCurrentLevel: 100, levelAttributePoints: 0, levelStaminaRefill: 0,
      trainingCapBase: 10, trainingCapPerLevel: 4 });
    expect([RULES_V2.progression.trainingCapBase, RULES_V2.progression.trainingCapPerLevel]).toEqual([10, 4]);
    expect(Object.keys(RULES_V2.tournament.placementsByLeague)).toEqual(LEAGUES);
    expect(LEAGUES.map(l => Object.keys(RULES_V2.tournament.placementsByLeague[l]))).toEqual(LEAGUES.map(() => ['winner', 'runnerUp', 'semifinal', 'other']));
    expect(LEAGUES.map(l => Object.values(RULES_V2.tournament.placementsByLeague[l]).map(p => p.money)))
      .toEqual([[40, 24, 12, 0], [60, 36, 18, 0], [80, 48, 24, 0], [100, 60, 30, 0]]);
    expect(LEAGUES.map(l => Object.values(RULES_V2.tournament.placementsByLeague[l]).map(p => p.renown)))
      .toEqual(LEAGUES.map(() => [50, 30, 15, 5]));
    expect(Object.keys(RULES_V2.seasons.placementsByLeague)).toEqual(LEAGUES);
    expect(LEAGUES.map(l => RULES_V2.seasons.placementsByLeague[l].map(p => p.money)))
      .toEqual([[200, 120, 80], [300, 180, 120], [400, 240, 160], [500, 300, 200]]);
    for (const league of LEAGUES) {
      expect(RULES_V2.seasons.placementsByLeague[league].map(({ renown, title, badge }) => ({ renown, title, badge })))
        .toEqual([{ renown: 100, title: 'champion', badge: 'gold' }, { renown: 60, title: null, badge: 'silver' }, { renown: 40, title: null, badge: 'bronze' }]);
    }
    expect(Object.isFrozen(RULES_V2.seasons.placementsByLeague.gold[0])).toBe(true);
    expect(deepFrozen(RULES_V2)).toBe(true);
  });

  it('never pays more gold or renown than v1 in any league', () => {
    for (const league of LEAGUES) {
      const v2 = RULES_V2.tournament.placementsByLeague[league];
      for (const place of ['winner', 'runnerUp', 'semifinal', 'other'] as const) {
        expect(v2[place].money, `${league} ${place} gold`).toBeLessThanOrEqual(RULES_V1.tournament.placements[place].money);
        expect(v2[place].renown, `${league} ${place} renown`).toBeLessThanOrEqual(RULES_V1.tournament.placements[place].renown);
      }
      const seasons = RULES_V2.seasons.placementsByLeague[league];
      expect(seasons).toHaveLength(RULES_V1.seasons.placements.length);
      seasons.forEach((prize, i) => {
        expect(prize.money, `${league} season ${i + 1} gold`).toBeLessThanOrEqual(RULES_V1.seasons.placements[i].money);
        expect(prize.renown, `${league} season ${i + 1} renown`).toBeLessThanOrEqual(RULES_V1.seasons.placements[i].renown);
      });
    }
    // The Champion league pays exactly today's prizes (factor 1.0).
    expect(RULES_V2.tournament.placementsByLeague.champion).toEqual(RULES_V1.tournament.placements);
    expect(RULES_V2.seasons.placementsByLeague.champion).toEqual(RULES_V1.seasons.placements);
  });
});

describe('retained rules', () => {
  it('retains v1 and v2, frozen, and Arena re-exports the same registry', () => {
    expect(Object.keys(RETAINED_RULES)).toEqual(['v1', 'v2']);
    expect(RETAINED_RULES.v1).toBe(RULES_V1);
    expect(RETAINED_RULES.v2).toBe(RULES_V2);
    expect(Object.isFrozen(RETAINED_RULES)).toBe(true);
    expect(ARENA_RETAINED_RULES).toBe(RETAINED_RULES);
  });

  it('answers a retained version and refuses any other', () => {
    expect(retainedRules('v1')).toBe(RULES_V1);
    expect(retainedRules('v2')).toBe(RULES_V2);
    for (const version of ['v3', 'V2', '', 'toString', '__proto__', 'constructor', 2, null, undefined, {}]) {
      expect(() => retainedRules(version), String(version)).toThrow(new RangeError('Unsupported rules version'));
    }
  });

  it('tells v2 from v1', () => {
    expect(isRulesV2(RULES_V2)).toBe(true);
    expect(isRulesV2(RULES_V1)).toBe(false);
  });
});
