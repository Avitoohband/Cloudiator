import { describe, expect, it } from 'vitest';
import type { Schedule } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import { trainingHint, trainingLimitWarning, trainingRoom } from '../../src/features/schedule/training-cap';

// Patch 1.6 (spec "The Training line" and "Generic daily-limit warning"; plan Task 8). The Schedule's line under a Training choice
// says how far the point cap (10 + 4 × level) lets Training go, and a v2 draft holding any Training warns that only two Training
// activities run per game day. Written apart from the code: the cap is 10 + 4 × level, and the next level is the first whose cap
// is above the points held.
const room = (level: number, earned: number) => trainingRoom({ level, earnedAttributePoints: earned }, RULES_V2);

describe('the Training cap line', () => {
  it('has no cap in v1, and a room under v2', () => {
    expect(trainingRoom({ level: 1, earnedAttributePoints: 10 }, RULES_V1)).toBeNull();
    expect(room(1, 10)).toEqual({ earned: 10, cap: 14, level: 1, full: false, nextLevel: 2 });
    expect(room(1, 13)).toEqual({ earned: 13, cap: 14, level: 1, full: false, nextLevel: 2 });
    expect(room(1, 14)).toEqual({ earned: 14, cap: 14, level: 1, full: true, nextLevel: 2 });
    expect(room(10, 50)).toEqual({ earned: 50, cap: 50, level: 10, full: true, nextLevel: 11 });
    expect(room(1, 94)).toEqual({ earned: 94, cap: 14, level: 1, full: true, nextLevel: 22 });
  });

  it('says the spec\'s three lines, word for word', () => {
    expect(trainingHint(room(1, 10), 20)).toBe('Practice yard: +1 attribute point, up to 14 at level 1 (you have 10). When Training runs, it costs 20 stamina.');
    expect(trainingHint(room(10, 50), 20)).toBe('Training is full: 50 points, and level 10 allows 50. It gives nothing until level 11. When Training runs, it costs 20 stamina.');
    expect(trainingHint(room(1, 94), 20)).toBe('Training is full: 94 points, and level 1 allows 14. It gives nothing until level 22. When Training runs, it costs 20 stamina.');
    expect(trainingHint(room(1, 15), 20)).toContain('until level 2.');
    expect(trainingHint(null, 20)).toBe('Practice yard: builds experience. Costs 20 stamina.');
  });

  it('is the first level whose cap is above the points held', () => {
    for (const [level, earned] of [[1, 14], [1, 17], [1, 18], [3, 22], [3, 40], [12, 58], [20, 91]] as const) {
      const next = room(level, earned)!.nextLevel;
      expect(10 + 4 * next, `${level}/${earned}`).toBeGreaterThan(earned);
      expect(10 + 4 * (next - 1) <= earned || next === level + 1, `${level}/${earned}`).toBe(true);
    }
  });

  it('gives no room for numbers that are not safe integers, and never throws', () => {
    expect([room(0, 10), room(1, Number.NaN), room(1, -1)]).toEqual([null, null, null]);
    expect([room(1.5, 10), room(1, 10.5), room(Number.POSITIVE_INFINITY, 10), room(1, Number.MAX_SAFE_INTEGER + 2)]).toEqual([null, null, null, null]);
    expect(trainingRoom({ level: '1', earnedAttributePoints: 10 } as never, RULES_V2)).toBeNull();
    expect(trainingRoom(undefined as never, RULES_V2)).toBeNull();
  });
});

describe('the daily Training limit warning', () => {
  const WARNING = 'Only two Training activities can run per game day (morning, afternoon and evening). After two, another Training request becomes Rest, costs no Training stamina and refills stamina when it ends. Training at the point cap still uses one of the two activities.';
  const day = (morning: Schedule['morning'], afternoon: Schedule['afternoon'], evening: Schedule['evening']): Schedule => ({ morning, afternoon, evening });
  const T = { kind: 'training' } as const, R = { kind: 'rest' } as const, A = { kind: 'arena' } as const, W = { kind: 'expedition', expeditionId: 'woodland' } as const;

  it('warns before Save for a v2 draft with three Training requests', () => {
    expect(trainingLimitWarning(day(T, T, T), RULES_V2)).toBe(WARNING);
  });

  it('warns for a v2 draft with a single Training too (a mid-day replan cannot know the day\'s earlier Training)', () => {
    expect(trainingLimitWarning(day(R, W, T), RULES_V2)).toBe(WARNING);
    expect(trainingLimitWarning(day(T, W, R), RULES_V2)).toBe(WARNING);
  });

  it('says nothing under v1, or for a draft without Training', () => {
    expect(trainingLimitWarning(day(T, T, T), RULES_V1)).toBeNull();
    expect(trainingLimitWarning(day(R, W, A), RULES_V2)).toBeNull();
  });
});
