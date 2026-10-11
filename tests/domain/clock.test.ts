import { describe, expect, it } from 'vitest';
import { nextPhaseStart, slotAt } from '@domain/clock.ts';

describe('UTC epoch clock', () => {
  it.each([
    [0, 0, 'morning', 0, 4_800_000],
    [4_799_999, 0, 'morning', 0, 4_800_000],
    [4_800_000, 1, 'afternoon', 4_800_000, 9_600_000],
    [4_800_001, 1, 'afternoon', 4_800_000, 9_600_000],
    [9_599_999, 1, 'afternoon', 4_800_000, 9_600_000],
    [9_600_000, 2, 'evening', 9_600_000, 14_400_000],
    [9_600_001, 2, 'evening', 9_600_000, 14_400_000],
    [14_399_999, 2, 'evening', 9_600_000, 14_400_000],
    [14_400_000, 3, 'morning', 14_400_000, 19_200_000],
    [14_400_001, 3, 'morning', 14_400_000, 19_200_000],
  ])('uses a common cutoff at %i ms', (now, index, phase, startMs, endMs) => {
    expect(slotAt(now)).toEqual({ index, phase, startMs, endMs });
  });
  it('aligns scheduled tournament UTC times with afternoon', () => {
    for (const day of [14, 17]) expect(slotAt(Date.UTC(2026, 9, day, 17, 20)).phase).toBe('afternoon');
  });
  it('selects only future occurrences, even exactly at a boundary', () => {
    expect(nextPhaseStart('morning', 0)).toBe(14_400_000);
    expect(nextPhaseStart('afternoon', 0)).toBe(4_800_000);
    expect(nextPhaseStart('evening', 4_800_000)).toBe(9_600_000);
    expect(nextPhaseStart('afternoon', 4_800_000)).toBe(19_200_000);
    expect(nextPhaseStart('morning', 14_399_999)).toBe(14_400_000);
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])('rejects unusable timestamp %s', (now) => {
    expect(() => slotAt(now)).toThrow(RangeError);
    expect(() => nextPhaseStart('morning', now)).toThrow(RangeError);
  });
  it('rejects unknown phase values at runtime', () => {
    expect(() => nextPhaseStart('night' as never, 0)).toThrow(RangeError);
  });
});
