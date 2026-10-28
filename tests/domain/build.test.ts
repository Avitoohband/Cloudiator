import { describe, expect, it } from 'vitest';
import { buildChangeFee, lockedChange } from '@domain/build.ts';
import type { BuildInput } from '@domain/types.ts';
import { buildInputFixture } from '../fixtures/domain.ts';

// Fixed class and points (spec "Added 2026-10-28"): a saved build's class and every added point are permanent. Only the stance,
// the equipment and more points can change, and every such change is free.
const current = buildInputFixture;
const next = (patch: Partial<BuildInput>): BuildInput => ({ ...current, ...patch });
const points = (patch: Partial<BuildInput['allocation']>) => next({ allocation: { ...current.allocation, ...patch } });

describe('lockedChange', () => {
  it('is "class" for another class, whatever else changes', () => {
    expect(lockedChange(current, next({ classId: 'duelist' }))).toBe('class');
    expect(lockedChange(current, { ...points({ strength: 3 }), classId: 'guardian' })).toBe('class');
    // A class change together with a decrease is still reported as the class.
    expect(lockedChange(current, { ...points({ strength: 1, agility: 3 }), classId: 'duelist' })).toBe('class');
  });

  it('is "points" when any one attribute is one lower', () => {
    for (const key of ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const) {
      expect(lockedChange(current, points({ [key]: current.allocation[key] - 1 })), key).toBe('points');
    }
    // Moving a point from one attribute to another is a decrease of the first.
    expect(lockedChange(current, points({ strength: 1, agility: 3 }))).toBe('points');
  });

  it('is null for a stance change, an equipment change, no change and one more point on any attribute', () => {
    expect(lockedChange(current, current)).toBeNull();
    expect(lockedChange(current, next({ stance: 'offensive' }))).toBeNull();
    const weapon = '2d6f1c2e-7d5b-4f4e-9d0b-3f2a8e8f5b11';
    expect(lockedChange(current, next({ equipment: { ...current.equipment, weapon } }))).toBeNull();
    for (const key of ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const) {
      expect(lockedChange(current, points({ [key]: current.allocation[key] + 1 })), key).toBeNull();
    }
    // Everything free to change, changed at once.
    expect(lockedChange(current, { ...points({ endurance: 5, precision: 4 }), stance: 'offensive', equipment: { ...current.equipment, weapon } })).toBeNull();
  });

  it('refuses malformed input as buildChangeFee does', () => {
    expect(() => lockedChange(current, { ...current, classId: 'nobody' as never })).toThrow(RangeError);
    expect(() => lockedChange({ ...current, allocation: { strength: 1 } as never }, current)).toThrow(RangeError);
  });
});

describe('buildChangeFee for every change lockedChange allows', () => {
  it('is 0', () => {
    const weapon = '2d6f1c2e-7d5b-4f4e-9d0b-3f2a8e8f5b11';
    for (const allowed of [current, next({ stance: 'offensive' }), points({ strength: 3 }), points({ vitality: 4, precision: 3 }),
      next({ equipment: { ...current.equipment, weapon } })]) {
      expect(lockedChange(current, allowed)).toBeNull();
      expect(buildChangeFee(current, allowed)).toBe(0);
    }
  });
});
