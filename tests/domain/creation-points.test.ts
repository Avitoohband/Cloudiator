import { describe, expect, it } from 'vitest';
import type { Attributes, ClassId } from '@contracts/commands';
import { validateCreationAllocation } from '@domain/build';
import { RULES_V1 } from '@domain/rules-v1';
import {
  ATTRIBUTE_HINTS, ATTRIBUTE_KEYS, CLASS_SUGGESTIONS, EMPTY_ALLOCATION, cappedNote, pointsLeft, pointsSpent, setPoints,
} from '@/features/character/creation-points';

// Launch feedback (2026-10-25), goal 1: the creation points start at 0, a typed value caps at what is left (Avi: "with 7 left,
// typing 10 sets 7"), and the counter never shows a negative number. The server's rule (exactly 10 whole points) is unchanged.
const TOTAL = RULES_V1.attributes.creationPoints;
const alloc = (values: Partial<Attributes>): Attributes => ({ ...EMPTY_ALLOCATION, ...values });

describe('the starting allocation', () => {
  it('is 0 in every attribute, so all the points are left', () => {
    expect(EMPTY_ALLOCATION).toEqual({ strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 });
    expect(pointsSpent(EMPTY_ALLOCATION)).toBe(0);
    expect(pointsLeft(EMPTY_ALLOCATION)).toBe(TOTAL);
  });

  it('names the five attributes the server knows, once each', () => {
    expect([...ATTRIBUTE_KEYS].sort()).toEqual(Object.keys(EMPTY_ALLOCATION).sort());
  });
});

describe('pointsLeft', () => {
  it('counts down as points are spent, to 0 when all are spent', () => {
    expect(pointsLeft(alloc({ strength: 3 }))).toBe(TOTAL - 3);
    expect(pointsLeft(alloc({ strength: 3, agility: 4 }))).toBe(TOTAL - 7);
    expect(pointsLeft(alloc({ strength: 5, vitality: 5 }))).toBe(0);
  });

  it('is never negative, even for an over-spent allocation (an old saved draft)', () => {
    expect(pointsLeft(alloc({ strength: TOTAL, agility: 3 }))).toBe(0);
    expect(pointsLeft(alloc({ strength: 9, agility: 9, vitality: 9, endurance: 9, precision: 9 }))).toBe(0);
  });
});

describe('setPoints', () => {
  it('sets the wanted points on one attribute and leaves the others and the input untouched', () => {
    const before = alloc({ strength: 2, agility: 1 });
    const result = setPoints(before, 'vitality', 4);
    expect(result.allocation).toEqual(alloc({ strength: 2, agility: 1, vitality: 4 }));
    expect(result.capped).toBe(false);
    expect(before).toEqual(alloc({ strength: 2, agility: 1 }));
    expect(result.allocation).not.toBe(before);
  });

  it('caps typing 10 with 7 left at 7 and says it capped (Avi: with 7 left, typing 10 sets 7)', () => {
    const seven = alloc({ strength: 3 });
    expect(pointsLeft(seven)).toBe(7);
    const result = setPoints(seven, 'agility', 10);
    expect(result.allocation).toEqual(alloc({ strength: 3, agility: 7 }));
    expect(result.capped).toBe(true);
    expect(pointsLeft(result.allocation)).toBe(0);
  });

  it('caps at the field\'s current value plus the points left', () => {
    // Strength 3 and agility 4 leave 3, so strength may grow to 3 + 3.
    const result = setPoints(alloc({ strength: 3, agility: 4 }), 'strength', 10);
    expect(result.allocation.strength).toBe(6);
    expect(result.capped).toBe(true);
    // With nothing left a field stays where it is.
    const full = alloc({ strength: 4, agility: 6 });
    expect(setPoints(full, 'strength', 9)).toEqual({ allocation: full, capped: true });
  });

  it('does not report a cap when the wanted value fits exactly, even all of the points on one attribute', () => {
    expect(setPoints(alloc({ strength: 3 }), 'agility', 7)).toEqual({ allocation: alloc({ strength: 3, agility: 7 }), capped: false });
    expect(setPoints(EMPTY_ALLOCATION, 'strength', TOTAL)).toEqual({ allocation: alloc({ strength: TOTAL }), capped: false });
  });

  it('lowers a value freely and gives its points back', () => {
    const result = setPoints(alloc({ strength: 6, agility: 4 }), 'strength', 1);
    expect(result.allocation).toEqual(alloc({ strength: 1, agility: 4 }));
    expect(result.capped).toBe(false);
    expect(pointsLeft(result.allocation)).toBe(TOTAL - 5);
  });

  it('floors a fraction, which is not a cap', () => {
    expect(setPoints(EMPTY_ALLOCATION, 'strength', 2.5)).toEqual({ allocation: alloc({ strength: 2 }), capped: false });
    expect(setPoints(EMPTY_ALLOCATION, 'strength', 2.99).allocation.strength).toBe(2);
    expect(setPoints(EMPTY_ALLOCATION, 'strength', 0.9).allocation.strength).toBe(0);
  });

  it('an empty field counts as 0, never NaN', () => {
    const before = alloc({ strength: 4, agility: 2 });
    for (const wanted of [Number(''), Number('  '), NaN, Number('abc'), Number(undefined)]) {
      const result = setPoints(before, 'strength', wanted);
      expect(result.allocation).toEqual(alloc({ strength: 0, agility: 2 }));
      expect(result.capped).toBe(false);
      expect(Object.values(result.allocation).every(Number.isFinite)).toBe(true);
    }
  });

  it('raises a negative number to 0 and counts a non-finite one as 0', () => {
    expect(setPoints(alloc({ strength: 3 }), 'strength', -2)).toEqual({ allocation: EMPTY_ALLOCATION, capped: false });
    expect(setPoints(alloc({ strength: 3 }), 'strength', -Infinity).allocation.strength).toBe(0);
    expect(setPoints(alloc({ strength: 3 }), 'strength', Infinity).allocation.strength).toBe(0);
  });

  it('never produces more than the points there are, however it is typed', () => {
    let current: Attributes = EMPTY_ALLOCATION;
    for (const key of ATTRIBUTE_KEYS) current = setPoints(current, key, 1000).allocation;
    expect(pointsSpent(current)).toBe(TOTAL);
    expect(current.strength).toBe(TOTAL);
    expect(pointsLeft(current)).toBe(0);
  });
});

describe('cappedNote', () => {
  it('says how many points were left and what the attribute was set to (Avi: with 7 left, typing 10)', () => {
    expect(cappedNote('Strength', 7, 7)).toBe('Only 7 points left, so Strength was set to 7.');
    // The attribute already held 3 of the 7, so the 4 left take it to 7.
    expect(cappedNote('Agility', 4, 7)).toBe('Only 4 points left, so Agility was set to 7.');
    expect(cappedNote('Vitality', 1, 6)).toBe('Only 1 point left, so Vitality was set to 6.');
  });

  it('says plainly that nothing is left to add, and never mentions a negative number', () => {
    expect(cappedNote('Strength', 0, 4)).toBe('No points left to add, so Strength stays at 4.');
    for (const note of [cappedNote('Strength', 0, 0), cappedNote('Strength', 3, 5)]) expect(note).not.toMatch(/-\d/);
  });
});

describe('CLASS_SUGGESTIONS', () => {
  it('has the agreed split for each class', () => {
    expect(CLASS_SUGGESTIONS.berserker).toEqual({ strength: 5, agility: 1, vitality: 2, endurance: 1, precision: 1 });
    expect(CLASS_SUGGESTIONS.guardian).toEqual({ strength: 2, agility: 0, vitality: 5, endurance: 2, precision: 1 });
    expect(CLASS_SUGGESTIONS.duelist).toEqual({ strength: 2, agility: 4, vitality: 0, endurance: 0, precision: 4 });
  });

  it('covers every class of the rules, and each split is exactly 10 whole points the server accepts', () => {
    expect(Object.keys(CLASS_SUGGESTIONS).sort()).toEqual(Object.keys(RULES_V1.classes).sort());
    for (const classId of Object.keys(CLASS_SUGGESTIONS) as ClassId[]) {
      const split = CLASS_SUGGESTIONS[classId];
      expect(pointsSpent(split), classId).toBe(TOTAL);
      expect(pointsLeft(split), classId).toBe(0);
      expect(validateCreationAllocation(split), classId).toBe(true);
      expect(Object.values(split).every(points => Number.isInteger(points) && points >= 0 && points <= TOTAL), classId).toBe(true);
    }
  });
});

describe('ATTRIBUTE_HINTS', () => {
  it('has the exact one-line effect of each attribute', () => {
    expect(ATTRIBUTE_HINTS).toEqual({
      strength: 'More damage with every hit',
      agility: 'Faster attacks, harder to hit',
      vitality: '+10 health per point',
      endurance: '+2 stamina per point, carries more',
      precision: 'Hits more often, more critical hits',
    });
  });

  it('states the rules the hints quote', () => {
    expect(RULES_V1.resources.healthPerVitality).toBe(10);
    expect(RULES_V1.resources.staminaPerEndurance).toBe(2);
  });
});
