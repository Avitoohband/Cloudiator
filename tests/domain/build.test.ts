import { describe, expect, it } from 'vitest';
import { buildChangeFee, lockedChange, validateBuild } from '@domain/build.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import type { BuildInput } from '@domain/types.ts';
import { buildInputFixture, itemFixture } from '../fixtures/domain.ts';

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

describe('validateBuild under a rules version (patch 1.6)', () => {
  const sword = itemFixture(CATALOG_V1.items['sword:1:common']);
  const input: BuildInput = { ...buildInputFixture, equipment: { ...buildInputFixture.equipment, weapon: sword.id } };
  it('stamps the rules version it validated under and changes nothing else', () => {
    const v1 = validateBuild(input, [sword], 10, 1), v1Explicit = validateBuild(input, [sword], 10, 1, RULES_V1);
    const v2 = validateBuild(input, [sword], 10, 1, RULES_V2);
    if (!v1.ok || !v1Explicit.ok || !v2.ok) throw new Error('every build above is legal');
    expect(v1.snapshot.rulesVersion).toBe('v1');
    expect(v1Explicit).toEqual(v1);
    expect(v2.snapshot.rulesVersion).toBe('v2');
    expect(v2.unspentPoints).toBe(v1.unspentPoints);
    expect({ ...v2.snapshot, rulesVersion: 'v1' }).toEqual(v1.snapshot);
    expect(v2.snapshot.allocations).toEqual(v1.snapshot.allocations);
    expect(v2.snapshot.equipment).toEqual(v1.snapshot.equipment);
    expect(v2.snapshot.equipment.weapon?.id).toBe(sword.id);
  });
  it('keeps refusing what both versions refuse', () => {
    expect(validateBuild({ ...input, classId: 'nobody' as never }, [sword], 10, 1, RULES_V2)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validateBuild({ ...input, stance: 'nobody' as never }, [sword], 10, 1, RULES_V2)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(validateBuild(input, [sword], 10, 1, RULES_V2)).toMatchObject({ ok: true });
    expect(validateBuild({ ...input, allocation: { ...input.allocation, strength: 5 } }, [sword], 10, 1, RULES_V2)).toEqual({ ok: false, reason: 'points' });
    expect(validateBuild(input, [], 10, 1, RULES_V2)).toEqual({ ok: false, reason: 'item' });
  });
});
