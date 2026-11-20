import { expect, it } from 'vitest';
import type { BuildView } from '@contracts/reads';
import type { BuildInput } from '@domain/types';
import { fixedClassAndPoints, fixedKey, pointsToSpend, refloored } from '../../src/features/build/fixed-build';

// The build form's floor (Avi, 2026-10-28): the class and every attribute are fixed at the CURRENT build's. The current build can move
// under an open form without the build version moving (the boundary applies a pending build), so a draft is raised to the new floor.
const build = (over: Partial<BuildView> = {}): BuildView => ({ version: 1, classId: 'berserker', stance: 'balanced',
  allocations: { strength: 4, agility: 2, vitality: 1, endurance: 1, precision: 1 }, equipment: { weapon: null, offHand: null, head: null, body: null, feet: null }, ...over });
const draft = (over: Partial<BuildInput> = {}): BuildInput => ({ classId: 'berserker', stance: 'balanced',
  allocation: { strength: 4, agility: 2, vitality: 1, endurance: 1, precision: 1 }, equipment: { weapon: null, offHand: null, head: null, body: null, feet: null }, ...over });

it('keys the current build by what fixes a draft, by content and not by object identity', () => {
  // Every owner read brings a new object: the same class and points are the same key, whatever else differs.
  expect(fixedKey(build())).toBe(fixedKey(structuredClone(build())));
  expect(fixedKey(build())).toBe(fixedKey(build({ version: 7, stance: 'offensive', equipment: { weapon: 'w1', offHand: null, head: null, body: null, feet: null } })));
  expect(fixedKey(build())).toBe(fixedKey(build({ allocations: { precision: 1, endurance: 1, vitality: 1, agility: 2, strength: 4 } })));
  // A class or any one attribute that differs is another key.
  expect(fixedKey(build())).not.toBe(fixedKey(build({ classId: 'guardian' })));
  for (const key of ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const) {
    expect(fixedKey(build())).not.toBe(fixedKey(build({ allocations: { ...build().allocations, [key]: build().allocations[key] + 1 } })));
  }
});

it('raises an unsent lower draft to the new floor and takes the new class, keeping the rest of the draft', () => {
  // A pending build raised strength 4 to 6; the draft was typed back to 4 (allowed then); the boundary makes 6 the current.
  const current = build({ version: 2, allocations: { strength: 6, agility: 2, vitality: 1, endurance: 1, precision: 1 } });
  const moved = refloored(draft({ stance: 'defensive', equipment: { weapon: 'w1', offHand: null, head: null, body: null, feet: null } }), current);
  expect(moved).toEqual(draft({ stance: 'defensive', allocation: { strength: 6, agility: 2, vitality: 1, endurance: 1, precision: 1 },
    equipment: { weapon: 'w1', offHand: null, head: null, body: null, feet: null } }));
  // A pending class change from before the release takes effect: the draft's class follows the current one.
  expect(refloored(draft({ classId: 'guardian' }), build({ classId: 'berserker' })).classId).toBe('berserker');
  // Points above the new floor stay; a point below it in any attribute is raised.
  expect(refloored(draft({ allocation: { strength: 9, agility: 0, vitality: 1, endurance: 1, precision: 1 } }), current).allocation)
    .toEqual({ strength: 9, agility: 2, vitality: 1, endurance: 1, precision: 1 });
});

it('leaves a draft that already holds the floor as it was, and does not change the draft it is given', () => {
  const held = draft({ allocation: { strength: 5, agility: 2, vitality: 1, endurance: 1, precision: 1 } });
  const before = structuredClone(held);
  expect(refloored(held, build())).toEqual(held);
  expect(held).toEqual(before);
  // It is the form's own starting rule applied to the draft: the class and points `fixedClassAndPoints` gives the same build.
  const fixed = fixedClassAndPoints(build({ allocations: held.allocation }), build());
  expect(refloored(held, build())).toEqual({ ...held, classId: fixed.classId, allocation: fixed.allocations });
});

// Patch 1.9.2 (Avi, 2026-11-20): My gladiator's Attributes and stats says "N points to spend" with a Spend points button. The number is what
// the build planner opens with as left: the points earned less those its draft holds (the pending build's, else the current build's, at the
// fixed floor), so a pending build that spends them leaves none to spend, though the server's unspent count waits for the boundary.
it('counts the points to spend as the build planner opens with them', () => {
  const owner = (earned: number, pending: BuildView | null = null) => ({ currentBuild: build(), pendingBuild: pending && { build: pending,
    effectiveSlotIndex: 2, reservedMoney: 0, reservedItemIds: [], operationId: 'pending' }, progression: { earnedAttributePoints: earned } });
  // The current build holds 9 points.
  expect(pointsToSpend(owner(58))).toBe(49);
  expect(pointsToSpend(owner(10))).toBe(1);
  expect(pointsToSpend(owner(9))).toBe(0);
  // Never negative: an old build that holds more than is earned has none.
  expect(pointsToSpend(owner(5))).toBe(0);
  // A pending build that spends 7 more leaves 42; one that spends them all leaves none.
  expect(pointsToSpend(owner(58, build({ version: 2, allocations: { strength: 11, agility: 2, vitality: 1, endurance: 1, precision: 1 } })))).toBe(42);
  expect(pointsToSpend(owner(58, build({ version: 2, allocations: { strength: 53, agility: 2, vitality: 1, endurance: 1, precision: 1 } })))).toBe(0);
  // A pending build from before the release below the current floor counts at the floor, as the planner's draft does.
  expect(pointsToSpend(owner(58, build({ version: 2, allocations: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } })))).toBe(49);
});
