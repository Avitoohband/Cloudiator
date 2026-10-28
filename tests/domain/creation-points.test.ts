import { describe, expect, it } from 'vitest';
import type { Attributes, ClassId } from '@contracts/commands';
import { validateCreationAllocation } from '@domain/build';
import { RULES_V1 } from '@domain/rules-v1';
import {
  ATTRIBUTE_HINTS, ATTRIBUTE_KEYS, CLASS_SUGGESTIONS, EMPTY_ALLOCATION, cappedNote, pointsLeft, pointsSpent, raisedNote, setPoints,
} from '@/features/character/creation-points';

// Launch feedback (2026-10-25), goal 1: the creation points start at 0, a typed value caps at what is left (Avi: "with 7 left,
// typing 10 sets 7"), and the counter never shows a negative number. The server's rule (exactly 10 whole points) is unchanged.
const TOTAL = RULES_V1.attributes.creationPoints;
const alloc = (values: Partial<Attributes>): Attributes => ({ ...EMPTY_ALLOCATION, ...values });

describe('the starting allocation', () => {
  it('is 0 in every attribute, so all the points are left', () => {
    expect(EMPTY_ALLOCATION).toEqual({ strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 });
    expect(pointsSpent(EMPTY_ALLOCATION)).toBe(0);
    expect(pointsLeft(EMPTY_ALLOCATION, TOTAL)).toBe(TOTAL);
  });

  it('names the five attributes the server knows, once each', () => {
    expect([...ATTRIBUTE_KEYS].sort()).toEqual(Object.keys(EMPTY_ALLOCATION).sort());
  });
});

describe('pointsLeft', () => {
  it('counts down as points are spent, to 0 when all are spent', () => {
    expect(pointsLeft(alloc({ strength: 3 }), TOTAL)).toBe(TOTAL - 3);
    expect(pointsLeft(alloc({ strength: 3, agility: 4 }), TOTAL)).toBe(TOTAL - 7);
    expect(pointsLeft(alloc({ strength: 5, vitality: 5 }), TOTAL)).toBe(0);
  });

  it('is never negative, even for an over-spent allocation (an old saved draft)', () => {
    expect(pointsLeft(alloc({ strength: TOTAL, agility: 3 }), TOTAL)).toBe(0);
    expect(pointsLeft(alloc({ strength: 9, agility: 9, vitality: 9, endurance: 9, precision: 9 }), TOTAL)).toBe(0);
  });
});

describe('setPoints', () => {
  it('sets the wanted points on one attribute and leaves the others and the input untouched', () => {
    const before = alloc({ strength: 2, agility: 1 });
    const result = setPoints(before, 'vitality', 4, TOTAL);
    expect(result.allocation).toEqual(alloc({ strength: 2, agility: 1, vitality: 4 }));
    expect(result.capped).toBe(false);
    expect(before).toEqual(alloc({ strength: 2, agility: 1 }));
    expect(result.allocation).not.toBe(before);
  });

  it('caps typing 10 with 7 left at 7 and says it capped (Avi: with 7 left, typing 10 sets 7)', () => {
    const seven = alloc({ strength: 3 });
    expect(pointsLeft(seven, TOTAL)).toBe(7);
    const result = setPoints(seven, 'agility', 10, TOTAL);
    expect(result.allocation).toEqual(alloc({ strength: 3, agility: 7 }));
    expect(result.capped).toBe(true);
    expect(pointsLeft(result.allocation, TOTAL)).toBe(0);
  });

  it('caps at the field\'s current value plus the points left', () => {
    // Strength 3 and agility 4 leave 3, so strength may grow to 3 + 3.
    const result = setPoints(alloc({ strength: 3, agility: 4 }), 'strength', 10, TOTAL);
    expect(result.allocation.strength).toBe(6);
    expect(result.capped).toBe(true);
    // With nothing left a field stays where it is.
    const full = alloc({ strength: 4, agility: 6 });
    expect(setPoints(full, 'strength', 9, TOTAL)).toEqual({ allocation: full, capped: true, raised: false });
  });

  it('does not report a cap when the wanted value fits exactly, even all of the points on one attribute', () => {
    expect(setPoints(alloc({ strength: 3 }), 'agility', 7, TOTAL)).toEqual({ allocation: alloc({ strength: 3, agility: 7 }), capped: false, raised: false });
    expect(setPoints(EMPTY_ALLOCATION, 'strength', TOTAL, TOTAL)).toEqual({ allocation: alloc({ strength: TOTAL }), capped: false, raised: false });
  });

  it('lowers a value freely and gives its points back', () => {
    const result = setPoints(alloc({ strength: 6, agility: 4 }), 'strength', 1, TOTAL);
    expect(result.allocation).toEqual(alloc({ strength: 1, agility: 4 }));
    expect(result.capped).toBe(false);
    expect(pointsLeft(result.allocation, TOTAL)).toBe(TOTAL - 5);
  });

  it('floors a fraction, which is not a cap', () => {
    expect(setPoints(EMPTY_ALLOCATION, 'strength', 2.5, TOTAL)).toEqual({ allocation: alloc({ strength: 2 }), capped: false, raised: false });
    expect(setPoints(EMPTY_ALLOCATION, 'strength', 2.99, TOTAL).allocation.strength).toBe(2);
    expect(setPoints(EMPTY_ALLOCATION, 'strength', 0.9, TOTAL).allocation.strength).toBe(0);
  });

  it('an empty field counts as 0, never NaN', () => {
    const before = alloc({ strength: 4, agility: 2 });
    for (const wanted of [Number(''), Number('  '), NaN, Number('abc'), Number(undefined)]) {
      const result = setPoints(before, 'strength', wanted, TOTAL);
      expect(result.allocation).toEqual(alloc({ strength: 0, agility: 2 }));
      expect(result.capped).toBe(false);
      expect(Object.values(result.allocation).every(Number.isFinite)).toBe(true);
    }
  });

  it('raises a negative number to 0 and counts a non-finite one as 0', () => {
    expect(setPoints(alloc({ strength: 3 }), 'strength', -2, TOTAL)).toEqual({ allocation: EMPTY_ALLOCATION, capped: false, raised: false });
    expect(setPoints(alloc({ strength: 3 }), 'strength', -Infinity, TOTAL).allocation.strength).toBe(0);
    expect(setPoints(alloc({ strength: 3 }), 'strength', Infinity, TOTAL).allocation.strength).toBe(0);
  });

  it('never produces more than the points there are, however it is typed', () => {
    let current: Attributes = EMPTY_ALLOCATION;
    for (const key of ATTRIBUTE_KEYS) current = setPoints(current, key, 1000, TOTAL).allocation;
    expect(pointsSpent(current)).toBe(TOTAL);
    expect(current.strength).toBe(TOTAL);
    expect(pointsLeft(current, TOTAL)).toBe(0);
  });
});

// Fixed class and points (2026-10-28, same release): the build step counts against the points EARNED (`total`), and a typed
// value never goes below the CURRENT build's value (`floor`), because added points are permanent once a build takes effect.
// Creation is the same call with its own total and a floor of 0.
describe('the total parameter', () => {
  it('counts the points left against the total it is given, not against the creation points', () => {
    expect(pointsLeft(alloc({ strength: 4, agility: 5 }), 12)).toBe(3);
    expect(pointsLeft(alloc({ strength: 4, agility: 5 }), TOTAL)).toBe(1);
    expect(pointsLeft(EMPTY_ALLOCATION, 12)).toBe(12);
    // Never negative, whatever the total.
    expect(pointsLeft(alloc({ strength: 9, agility: 9 }), 12)).toBe(0);
  });

  it('caps a typed value at what the field holds plus what is left of the total (12 earned, 9 spent: typing 99 adds 3)', () => {
    const nine = alloc({ strength: 4, agility: 3, vitality: 2 });
    expect(pointsLeft(nine, 12)).toBe(3);
    const result = setPoints(nine, 'strength', 99, 12);
    expect(result.allocation).toEqual(alloc({ strength: 7, agility: 3, vitality: 2 }));
    expect(result).toMatchObject({ capped: true, raised: false });
    expect(pointsLeft(result.allocation, 12)).toBe(0);
    // The same typed value with the creation total would leave one point only.
    expect(setPoints(nine, 'strength', 99, TOTAL).allocation.strength).toBe(5);
  });

  it('does not report a cap when the wanted value fits the total exactly', () => {
    expect(setPoints(alloc({ strength: 4, agility: 3, vitality: 2 }), 'strength', 7, 12)).toMatchObject({ capped: false, raised: false });
  });
});

describe('the floor parameter', () => {
  const held = alloc({ strength: 4, agility: 3, vitality: 2 });

  it('raises a value typed below the floor to the floor and says it was raised, not capped', () => {
    const result = setPoints(held, 'strength', 0, 12, 4);
    expect(result.allocation).toEqual(held);
    expect(result).toMatchObject({ capped: false, raised: true });
    const three = setPoints(held, 'strength', 3, 12, 4);
    expect(three.allocation.strength).toBe(4);
    expect(three.raised).toBe(true);
    // The input is not changed.
    expect(held).toEqual(alloc({ strength: 4, agility: 3, vitality: 2 }));
  });

  it('takes a negative number, a fraction below the floor, an empty field and NaN as a number below the floor', () => {
    for (const wanted of [-5, -Infinity, 3.9, Number(''), NaN, Infinity]) {
      const result = setPoints(held, 'strength', wanted, 12, 4);
      // Infinity is not a finite number, so it counts as 0 like an empty field: raised to the floor.
      expect(result.allocation.strength, String(wanted)).toBe(4);
      expect(result.raised, String(wanted)).toBe(true);
      expect(result.capped, String(wanted)).toBe(false);
    }
  });

  it('keeps a value at or above the floor as typed, up to the cap, with no raised flag', () => {
    expect(setPoints(held, 'strength', 4, 12, 4)).toEqual({ allocation: held, capped: false, raised: false });
    expect(setPoints(held, 'strength', 6, 12, 4)).toEqual({ allocation: alloc({ strength: 6, agility: 3, vitality: 2 }), capped: false, raised: false });
    expect(setPoints(held, 'strength', 4.9, 12, 4).raised).toBe(false);
    expect(setPoints(held, 'strength', 4.9, 12, 4).allocation.strength).toBe(4);
  });

  it('may lower a value the player added this session, down to the floor and no further', () => {
    // Strength was 4 in the saved build and 7 in the draft: stepping it back to 5 is free, to 2 stops at 4.
    const draft = alloc({ strength: 7, agility: 3, vitality: 2 });
    expect(setPoints(draft, 'strength', 5, 12, 4)).toEqual({ allocation: alloc({ strength: 5, agility: 3, vitality: 2 }), capped: false, raised: false });
    expect(setPoints(draft, 'strength', 2, 12, 4)).toEqual({ allocation: alloc({ strength: 4, agility: 3, vitality: 2 }), capped: false, raised: true });
  });

  it('defaults to a floor of 0, so creation can still lower a value to 0 and never reports a raise', () => {
    expect(setPoints(held, 'strength', 0, 12)).toEqual({ allocation: alloc({ agility: 3, vitality: 2 }), capped: false, raised: false });
    expect(setPoints(held, 'strength', -3, 12).raised).toBe(false);
    expect(setPoints(held, 'strength', NaN, 12).raised).toBe(false);
  });

  it('never lets the floor pass the cap: a value already below its floor (a stale draft) is lifted to the floor', () => {
    const stale = alloc({ strength: 1, agility: 5, vitality: 5 });
    expect(pointsLeft(stale, 12)).toBe(1);
    // Cap = 1 + 1 left = 2, but the floor is 4: the floor wins, and the total may then be passed by the stale draft only.
    const result = setPoints(stale, 'strength', 99, 12, 4);
    expect(result.allocation.strength).toBe(4);
    expect(result.capped).toBe(true);
  });

  it('never spends more than the total across several fields, with a floor on each', () => {
    const floors = alloc({ strength: 4, agility: 3, vitality: 2 });
    let current: Attributes = floors;
    for (const key of ATTRIBUTE_KEYS) current = setPoints(current, key, 1000, 12, floors[key]).allocation;
    expect(pointsSpent(current)).toBe(12);
    expect(current.strength).toBe(7);
    for (const key of ATTRIBUTE_KEYS) expect(current[key]).toBeGreaterThanOrEqual(floors[key]);
  });
});

describe('raisedNote', () => {
  it('says the attribute cannot go below the floor because added points are permanent', () => {
    expect(raisedNote('Strength', 4)).toBe("Strength can't go below 4: added points are permanent.");
    expect(raisedNote('Vitality', 0)).toBe("Vitality can't go below 0: added points are permanent.");
    expect(raisedNote('Agility', 12)).toBe("Agility can't go below 12: added points are permanent.");
  });
});

describe('cappedNote', () => {
  // The line names the most the field can take now, its own points plus the points left, which is also what it was set to.
  // Its wording depends on what the field held when the player started editing it (its value when it took the focus, ruling
  // R10): from 0, the counter showed that many left, so the line says so, as in the approved mockup; with points already in
  // it, fewer were left, so the line names the field's cap.
  it('says how many points were left when the field held none (Avi: with 7 left, typing 10 sets 7)', () => {
    expect(cappedNote('Strength', 7, 7, 0)).toBe('Only 7 points left, so Strength was set to 7.');
    // Typed one key at a time: after "1" the field holds 1 and 6 are left, and "10" still says 7, as with 7 left at the start.
    expect(cappedNote('Agility', 6, 7, 0)).toBe('Only 7 points left, so Agility was set to 7.');
    expect(cappedNote('Vitality', 1, 1, 0)).toBe('Only 1 point left, so Vitality was set to 1.');
  });

  it('names the cap of a field that already held points (2 in Strength, 5 left, typing 9 sets 7)', () => {
    expect(cappedNote('Strength', 5, 7, 2)).toBe('Strength can take at most 7, so it was set to 7.');
    expect(cappedNote('Agility', 4, 7, 3)).toBe('Agility can take at most 7, so it was set to 7.');
    // Typed over a field of 2 one key at a time: after "1" it holds 1 and 5 are left, and "10" still names 6.
    expect(cappedNote('Vitality', 5, 6, 2)).toBe('Vitality can take at most 6, so it was set to 6.');
    for (const note of [cappedNote('Strength', 5, 7, 2), cappedNote('Strength', 1, 3, 2)]) expect(note).not.toMatch(/points? left/);
  });

  it('says plainly that nothing is left to add, and never mentions a negative number', () => {
    expect(cappedNote('Strength', 0, 4, 4)).toBe('No points left to add, so Strength stays at 4.');
    expect(cappedNote('Strength', 0, 4, 0)).toBe('No points left to add, so Strength stays at 4.');
    expect(cappedNote('Strength', 0, 0, 0)).toBe('No points left to add, so Strength stays at 0.');
    for (const note of [cappedNote('Strength', 0, 0, 0), cappedNote('Strength', 3, 5, 0), cappedNote('Strength', 3, 5, 2)]) expect(note).not.toMatch(/-\d/);
  });

  it('agrees with setPoints for every way the cap is reached', () => {
    let allocation: Attributes = alloc({ strength: 3 });
    // One key at a time into a field of 0: "1" (fits), then "10" (capped at 1 + 6 left).
    allocation = setPoints(allocation, 'agility', 1, TOTAL).allocation;
    let left = pointsLeft(allocation, TOTAL);
    let result = setPoints(allocation, 'agility', 10, TOTAL);
    expect(result.capped).toBe(true);
    expect(cappedNote('Agility', left, left + allocation.agility, 0)).toBe(`Only ${result.allocation.agility} points left, so Agility was set to ${result.allocation.agility}.`);
    expect(result.allocation.agility).toBe(7);
    // Over a field that already holds points: 2 in Strength and 5 left, typing 9 sets 2 + 5.
    allocation = alloc({ strength: 2, agility: 3 });
    left = pointsLeft(allocation, TOTAL);
    result = setPoints(allocation, 'strength', 9, TOTAL);
    expect(result).toMatchObject({ capped: true, allocation: { strength: 7 } });
    expect(cappedNote('Strength', left, left + allocation.strength, allocation.strength)).toBe('Strength can take at most 7, so it was set to 7.');
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
      expect(pointsLeft(split, TOTAL), classId).toBe(0);
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
