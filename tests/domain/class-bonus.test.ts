import { describe, expect, it } from 'vitest';
import type { Attributes } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';
import { CLASS_MEANING, bonusText, classBonuses, splitNote, suggestedShares, suggestedSplit } from '@/features/character/class-bonus';
import { ATTRIBUTE_KEYS, CLASS_SUGGESTIONS, EMPTY_ALLOCATION, pointsSpent } from '@/features/character/creation-points';

const CLASSES = ['berserker', 'guardian', 'duelist'] as const;

// Patch A item 4: the class bonuses and the suggested split, read from the rules and the creation dialog's own split.
describe('class bonuses', () => {
  it('reads each class bonus from the rules', () => {
    expect(classBonuses('berserker').map(bonusText)).toEqual(['Strength +10%']);
    expect(classBonuses('guardian').map(bonusText)).toEqual(['Vitality +5%', 'Endurance +5%']);
    expect(classBonuses('duelist').map(bonusText)).toEqual(['Agility +5%', 'Precision +5%']);
    expect(CLASS_MEANING).toEqual({ berserker: 'From points and gear alike: every hit lands harder.',
      guardian: 'From points and gear alike: more health and more stamina.', duelist: 'From points and gear alike: faster, and hits more often.' });
  });

  it('lists a bonus for every multiplier above 1 and no other, in attribute order, as the percent above 1', () => {
    for (const classId of CLASSES) {
      const multipliers = RULES_V1.classes[classId];
      const expected = ATTRIBUTE_KEYS.filter(key => multipliers[key] > 1).map(attribute => ({ attribute, percent: Math.round((multipliers[attribute] - 1) * 100) }));
      expect(classBonuses(classId), classId).toEqual(expected);
      expect(expected.length, classId).toBeGreaterThan(0);
    }
  });
});

describe('the suggested split', () => {
  it('lists the suggested split largest first', () => {
    expect(suggestedShares('guardian')).toEqual([{ attribute: 'vitality', points: 5 }, { attribute: 'strength', points: 2 },
      { attribute: 'endurance', points: 2 }, { attribute: 'precision', points: 1 }, { attribute: 'agility', points: 0 }]);
    // Zeros are kept, ties keep the attribute order, and the shares are the creation dialog's.
    for (const classId of CLASSES) {
      const shares = suggestedShares(classId);
      expect(shares, classId).toHaveLength(ATTRIBUTE_KEYS.length);
      expect(shares.map(share => share.points), classId).toEqual([...shares.map(share => share.points)].sort((a, b) => b - a));
      for (const { attribute, points } of shares) expect(points, `${classId} ${attribute}`).toBe(CLASS_SUGGESTIONS[classId][attribute]);
    }
    expect(suggestedShares('duelist').map(share => share.attribute)).toEqual(['agility', 'precision', 'strength', 'vitality', 'endurance']);
  });

  it('spends exactly the points left the class way, never lowering one', () => {
    const before = { strength: 2, agility: 0, vitality: 5, endurance: 2, precision: 1 };
    const after = suggestedSplit(before, 3, 'guardian');
    expect(after).toEqual({ strength: 3, agility: 0, vitality: 6, endurance: 3, precision: 1 });
    expect(splitNote(before, after, 'guardian')).toBe('+1 Strength, +1 Vitality, +1 Endurance: the Guardian split.');
    for (const classId of CLASSES) for (let left = 0; left <= 25; left += 1) {
      const next = suggestedSplit(EMPTY_ALLOCATION, left, classId);
      expect(pointsSpent(next)).toBe(left);
      if (left === 10) expect(next).toEqual(CLASS_SUGGESTIONS[classId]);
    }
  });

  it('adds to what is there, never lowers a field, and leaves the allocation it was given alone', () => {
    const before: Attributes = { strength: 4, agility: 2, vitality: 1, endurance: 1, precision: 1 };
    const copy = { ...before };
    for (const classId of CLASSES) for (let left = 0; left <= 25; left += 1) {
      const next = suggestedSplit(before, left, classId);
      expect(pointsSpent(next) - pointsSpent(before), `${classId} ${left}`).toBe(left);
      for (const key of ATTRIBUTE_KEYS) expect(next[key], `${classId} ${left} ${key}`).toBeGreaterThanOrEqual(before[key]);
    }
    expect(before).toEqual(copy);
    expect(suggestedSplit(before, 0, 'duelist')).toEqual(before);
  });

  it('gives the leftover points by the largest remainder, ties by the larger share, then attribute order', () => {
    // Berserker 5/1/2/1/1 with 3 left: floors 1/0/0/0/0, remainders 5/3/6/3/3, so the 2 left over go to Vitality (6) then Strength (5).
    expect(suggestedSplit(EMPTY_ALLOCATION, 3, 'berserker')).toEqual({ strength: 2, agility: 0, vitality: 1, endurance: 0, precision: 0 });
    // Duelist 2/4/0/0/4 with 1 left: remainders 2/4/0/0/4 tie between Agility and Precision on remainder and share: attribute order, Agility.
    expect(suggestedSplit(EMPTY_ALLOCATION, 1, 'duelist')).toEqual({ strength: 0, agility: 1, vitality: 0, endurance: 0, precision: 0 });
    // A zero share never receives a point, whatever is left.
    for (let left = 1; left <= 25; left += 1) {
      expect(suggestedSplit(EMPTY_ALLOCATION, left, 'guardian').agility, `guardian ${left}`).toBe(0);
      expect(suggestedSplit(EMPTY_ALLOCATION, left, 'duelist').vitality, `duelist ${left}`).toBe(0);
      expect(suggestedSplit(EMPTY_ALLOCATION, left, 'duelist').endurance, `duelist ${left}`).toBe(0);
    }
  });

  it('spends nothing for a count that is not a whole number above zero', () => {
    for (const left of [-3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(suggestedSplit(EMPTY_ALLOCATION, left, 'guardian')).toEqual(EMPTY_ALLOCATION);
  });

  it('says what was added, in attribute order, named after the class', () => {
    const before = { ...EMPTY_ALLOCATION };
    expect(splitNote(before, suggestedSplit(before, 10, 'berserker'), 'berserker')).toBe('+5 Strength, +1 Agility, +2 Vitality, +1 Endurance, +1 Precision: the Berserker split.');
    expect(splitNote(before, suggestedSplit(before, 1, 'duelist'), 'duelist')).toBe('+1 Agility: the Duelist split.');
  });
});
