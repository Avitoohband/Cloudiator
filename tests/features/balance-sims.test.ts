import { describe, expect, it } from 'vitest';
import { runScenario, wilson } from '../../scripts/balance/sims.ts';

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
  it('uses the specified seeds and swaps sides for half the fights', () => {
    const result = runScenario('renown', 20);
    const first = result.matchups[0];
    expect(first.seeds[0]).toBe(`sim-renown-${first.id}-0`);
    expect(first.seeds[19]).toBe(`sim-renown-${first.id}-19`);
    expect(first.subjectFirst).toBe(10);
  });
  it('has the specified matchups', () => {
    expect(runScenario('critical', 2).matchups).toHaveLength(6);
    expect(runScenario('two-handed', 2).matchups).toHaveLength(12);
    expect(runScenario('renown', 2).matchups).toHaveLength(7);
  });
});
