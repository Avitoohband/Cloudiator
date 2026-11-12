import { describe, expect, it } from 'vitest';
import { balancedPoints, fighter, gearLevelAt, kit, pointsAt, runScenario, wilson, type Observer } from '../../scripts/balance/sims.ts';
import { dummyFighter, dummyPoints, maxGearLevel, presetSetup } from '../../src/features/practice/practice';

describe('offline balance simulations (Task 20)', () => {
  it('is deterministic', () => {
    for (const id of ['critical', 'two-handed', 'renown'] as const) {
      expect(JSON.stringify(runScenario(id, 20))).toBe(JSON.stringify(runScenario(id, 20)));
    }
  });
  it('keeps every win rate inside its Wilson interval', () => {
    for (const id of ['critical', 'two-handed', 'renown'] as const) {
      const result = runScenario(id, 20);
      expect(result.matchups.length).toBeGreaterThan(0);
      for (const m of result.matchups) {
        expect(m.fights).toBe(20);
        expect(m.winRate).toBeGreaterThanOrEqual(m.low95);
        expect(m.winRate).toBeLessThanOrEqual(m.high95);
        expect(m.low95).toBeGreaterThanOrEqual(0);
        expect(m.high95).toBeLessThanOrEqual(1);
      }
    }
  });
  it('wilson interval matches a known value', () => {
    const [low, high] = wilson(50, 100);
    expect(low).toBeCloseTo(0.4038, 3);
    expect(high).toBeCloseTo(0.5962, 3);
  });
  it('passes the seeds and flips the side order for every matchup', () => {
    for (const id of ['critical', 'two-handed', 'renown'] as const) {
      const seen: Parameters<Observer>[0][] = [];
      const result = runScenario(id, 6, info => seen.push(info));
      expect(seen).toHaveLength(result.matchups.length * 6);
      for (const m of result.matchups) {
        const own = seen.filter(info => info.matchup === m.id);
        expect(own.map(info => info.seed)).toEqual([0, 1, 2, 3, 4, 5].map(n => `sim-${id}-${m.id}-${n}`));
        expect(m.seeds).toEqual(own.map(info => info.seed));
        // The subject is listed first in even fights and second in odd ones, as simulateBattle received them.
        own.forEach(info => expect(info.participants).toEqual(info.n % 2 === 0 ? ['subject', 'opponent'] : ['opponent', 'subject']));
        expect(m.subjectFirst).toBe(3);
      }
    }
  });
  it('builds the same fighter as the practice dummy (Balanced, levels 1, 5, 10)', () => {
    for (const level of [1, 5, 10]) {
      expect(pointsAt(level)).toBe(dummyPoints(level));
      expect(gearLevelAt(level)).toBe(maxGearLevel(level));
      const setup = presetSetup('balanced', level);
      expect(balancedPoints(level)).toEqual(setup.allocations);
      const tier = gearLevelAt(level);
      expect(fighter(balancedPoints(level), kit(`sword:${tier}:common`, tier), 'arena')).toEqual(dummyFighter(setup));
    }
  });
  it('builds the same two-handed fighter as the practice dummy, with no off-hand', () => {
    for (const level of [1, 5, 10]) {
      const setup = { ...presetSetup('balanced', level), gear: { ...presetSetup('balanced', level).gear, weapon: 'spear' } };
      const tier = gearLevelAt(level);
      const mine = fighter(balancedPoints(level), kit(`spear:${tier}:common`, tier), 'arena');
      expect(mine).toEqual(dummyFighter(setup));
      const oneHanded = fighter(balancedPoints(level), kit(`sword:${tier}:common`, tier), 'arena');
      expect(mine.equipmentSilhouettes.length).toBe(oneHanded.equipmentSilhouettes.length - 1);
      expect(mine.equipmentSilhouettes.some(name => /shield/i.test(name))).toBe(false);
    }
  });
  it('reports a critical chance from Precision on every row', () => {
    for (const id of ['two-handed', 'renown'] as const) {
      for (const m of runScenario(id, 2).matchups) expect(m.criticalChance).toBeGreaterThan(0);
    }
  });
  it('has the specified matchups', () => {
    expect(runScenario('critical', 2).matchups).toHaveLength(6);
    expect(runScenario('two-handed', 2).matchups).toHaveLength(12);
    expect(runScenario('renown', 2).matchups).toHaveLength(7);
  });
});
