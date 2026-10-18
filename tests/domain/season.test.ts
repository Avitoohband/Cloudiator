import { describe, expect, it } from 'vitest';
import { seasonAt } from '@domain/season';
import { RULES_V1 } from '@domain/rules-v1';

// Task 21.2 (plan Decision 2): the season window of a slot, counted from the launch epoch slot. Boundary phase 2 writes the
// same bounds into public.seasons (tests/db/seasons.test.ts compares them).
const SLOT = RULES_V1.clock.slotMs;

describe('seasonAt', () => {
  it('splits time into 504-slot seasons from the launch epoch', () => {
    expect(seasonAt(0, 0)).toEqual({ index: 0, firstSlot: 0, endSlot: 504, startsAtMs: 0, endsAtMs: 504 * SLOT });
    expect(seasonAt(503, 0)).toMatchObject({ index: 0, firstSlot: 0, endSlot: 504 });
    expect(seasonAt(504, 0)).toMatchObject({ index: 1, firstSlot: 504, endSlot: 1008, startsAtMs: 504 * 4_800_000 });
    expect(seasonAt(1007, 0)).toMatchObject({ index: 1, firstSlot: 504, endSlot: 1008 });
    expect(seasonAt(1008, 0)).toMatchObject({ index: 2, firstSlot: 1008, endSlot: 1512 });
  });

  it('counts from a nonzero epoch and lasts exactly the rules duration', () => {
    expect(seasonAt(10, 10)).toEqual({ index: 0, firstSlot: 10, endSlot: 514, startsAtMs: 10 * SLOT, endsAtMs: 514 * SLOT });
    expect(seasonAt(513, 10)).toMatchObject({ index: 0, endSlot: 514 });
    expect(seasonAt(700, 10)).toEqual({ index: 1, firstSlot: 514, endSlot: 1018, startsAtMs: 514 * SLOT, endsAtMs: 1018 * SLOT });
    expect(seasonAt(700, 10).endsAtMs - seasonAt(700, 10).startsAtMs).toBe(RULES_V1.seasons.durationMs);
    expect(RULES_V1.seasons.durationSlots * SLOT).toBe(RULES_V1.seasons.durationMs);
  });

  it('rejects a slot before the epoch', () => {
    expect(() => seasonAt(5, 10)).toThrow(RangeError);
    expect(() => seasonAt(9, 10)).toThrow(RangeError);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects the unsafe value %s for either argument', bad => {
    expect(() => seasonAt(bad, 0)).toThrow(RangeError);
    expect(() => seasonAt(1000, bad)).toThrow(RangeError);
  });

  it('rejects a season whose times are not safe integers', () => {
    expect(() => seasonAt(Number.MAX_SAFE_INTEGER, 0)).toThrow(RangeError);
  });
});
