import { describe, expect, it } from 'vitest';
import type { EquipmentSlot } from '@contracts/commands';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { CLOTH_COLOURS, SKIN_TONES, validAppearance } from '@domain/appearance';
import { validFighter } from '@domain/combat';
import { RULES_V1 } from '@domain/rules-v1';
import { deriveStats } from '@domain/stats';
import type { PublicBuild, PublicGear } from '@/lib/api/reads';
import { cardSnapshot } from '@/features/character/profile-card';
import {
  DUMMY_LOOK, DUMMY_NAME, DUMMY_PRESETS, cardFighter, comparisonRows, dummyFighter, dummyPoints, levelRange, maxGearLevel,
  pointsLeft, practiceSeed, presetSetup, runPractice, withLevel, type DummySetup, type PracticeSide,
} from '@/features/practice/practice';

const gear = (id: string): PublicGear => {
  const item = CATALOG_V1.items[id];
  return { catalogId: id, catalogVersion: 'v1', tier: item.tier, rarity: item.rarity, stats: structuredClone(item.stats) as PublicGear['stats'] };
};
const NONE: Record<EquipmentSlot, PublicGear | null> = { weapon: null, offHand: null, head: null, body: null, feet: null };
const ASTER: PublicBuild = { stance: 'balanced', allocations: { strength: 5, agility: 3, vitality: 4, endurance: 3, precision: 3 },
  equipment: { ...NONE, weapon: gear('sword:1:common'), body: gear('heavy-armor:1:renown') } };

describe('dummy points and gear level', () => {
  it('is 10 + 4 per level', () => {
    expect([1, 5, 10].map(dummyPoints)).toEqual([14, 30, 50]);
  });
  it('opens better gear at levels 5 and 10', () => {
    expect([1, 4, 5, 9, 10, 20].map(maxGearLevel)).toEqual([1, 1, 5, 5, 10, 10]);
  });
  it('has the rules maximum level', () => {
    expect(levelRange()).toEqual({ min: 1, max: RULES_V1.attributes.maximumLevel });
  });
});

describe('presets', () => {
  it('splits level 1 points, floor then one each to the largest shares', () => {
    expect(presetSetup('balanced', 1).allocations).toEqual({ strength: 3, agility: 3, vitality: 3, endurance: 3, precision: 2 });
    expect(presetSetup('tank', 1).allocations).toEqual({ strength: 2, agility: 0, vitality: 6, endurance: 5, precision: 1 });
    expect(presetSetup('glass-cannon', 1).allocations).toEqual({ strength: 7, agility: 3, vitality: 0, endurance: 0, precision: 4 });
  });
  it('spends every point at every level', () => {
    for (const preset of ['balanced', 'tank', 'glass-cannon'] as const) for (const level of [1, 2, 3, 5, 7, 10, 20]) {
      expect(pointsLeft(presetSetup(preset, level))).toBe(0);
    }
  });
  it('carries the mockup labels, gear and stances', () => {
    expect([DUMMY_PRESETS.balanced.label, DUMMY_PRESETS.tank.label, DUMMY_PRESETS['glass-cannon'].label]).toEqual(['Balanced', 'Tank', 'Glass cannon']);
    expect(presetSetup('balanced', 1)).toMatchObject({ stance: 'balanced', gear: { weapon: 'sword', offHand: 'round-shield', head: 'leather-hood', body: 'light-armor', feet: 'light-boots' } });
    expect(presetSetup('tank', 1)).toMatchObject({ stance: 'defensive', gear: { weapon: 'sword', offHand: 'round-shield', head: 'iron-helmet', body: 'heavy-armor', feet: 'heavy-boots' } });
    expect(presetSetup('glass-cannon', 1)).toMatchObject({ stance: 'offensive', gear: { weapon: 'spear', offHand: null, head: 'leather-hood', body: null, feet: 'light-boots' } });
  });
  it('uses the highest gear level allowed', () => {
    expect(presetSetup('tank', 10).gearLevel).toBe(10);
    expect(presetSetup('tank', 6).gearLevel).toBe(5);
  });
  it('clamps the gear level when the level drops and re-applies a preset split', () => {
    expect(withLevel(presetSetup('tank', 10), 4).gearLevel).toBe(1);
    expect(withLevel(presetSetup('tank', 1), 5).allocations).toEqual(presetSetup('tank', 5).allocations);
  });
  it('keeps a Custom setup points when the level drops', () => {
    const custom: DummySetup = { ...presetSetup('tank', 10), preset: 'custom' };
    const lower = withLevel(custom, 1);
    expect(lower.allocations).toEqual(custom.allocations);
    expect(pointsLeft(lower)).toBe(14 - 50);
  });
});

describe('dummyFighter', () => {
  it('has no class and exactly base 5 + allocation, and is valid', () => {
    const setup = presetSetup('tank', 5);
    const fighter = dummyFighter(setup);
    expect(fighter.classId).toBeNull();
    for (const key of Object.keys(setup.allocations) as (keyof typeof setup.allocations)[]) expect(fighter.attributes[key]).toBe(5 + setup.allocations[key]);
    expect(validFighter(fighter, RULES_V1)).toBe(true);
    expect(fighter.stance).toBe('defensive');
  });
  it('empties the off hand under a two-handed weapon', () => {
    const base = presetSetup('balanced', 1);
    const fighter = dummyFighter({ ...base, gear: { ...base.gear, weapon: 'spear' } });
    expect(fighter.equipmentSilhouettes.some(id => id.startsWith('round-shield'))).toBe(false);
    expect(fighter.equipmentSilhouettes).toContain('spear:1:common');
  });
  it('wears the gear at the chosen level', () => {
    expect(dummyFighter(presetSetup('balanced', 5)).equipmentSilhouettes).toContain('sword:5:common');
  });
});

describe('cardFighter', () => {
  it('matches the derived Arena armor of a renown piece', () => {
    const fighter = cardFighter('duelist', ASTER);
    expect(fighter.armor).toBe(deriveStats(cardSnapshot('duelist', ASTER), RULES_V1).arenaArmor);
    expect(fighter.armor).toBeCloseTo(6.6, 5);
    expect(fighter.classId).toBe('duelist');
  });
});

describe('runPractice', () => {
  const you: PracticeSide = { gladiatorId: 'g-1', name: 'Aster', look: null, snapshot: cardFighter('duelist', ASTER) };
  const dummy: PracticeSide = { gladiatorId: null, name: DUMMY_NAME, look: DUMMY_LOOK, snapshot: dummyFighter(presetSetup('balanced', 4)) };
  it('is deterministic per seed and ends in a victory', () => {
    const a = runPractice(you, dummy, 'abc'), b = runPractice(you, dummy, 'abc');
    expect(a).toEqual(b);
    expect(a.participants.map(p => p.id)).toEqual(['practice-you', 'practice-opponent']);
    expect(a.events[a.events.length - 1].kind).toBe('victory');
    expect(['practice-you', 'practice-opponent']).toContain(a.winnerId);
  });
  it('works for a mirror', () => {
    const log = runPractice(you, { ...you }, 'mirror');
    expect(log.events[log.events.length - 1].kind).toBe('victory');
    expect(log.participants.map(p => p.gladiatorId)).toEqual(['g-1', 'g-1']);
  });
  it('draws a fresh 16 hex seed', () => {
    const [a, b] = [practiceSeed(), practiceSeed()];
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe('dummy look', () => {
  it('is a valid palette-only look: bald male in Cream, skin nearest straw', () => {
    expect(validAppearance(DUMMY_LOOK)).toBe(true);
    expect(DUMMY_LOOK).toMatchObject({ body: 'male', hair: 'bald' });
    expect(CLOTH_COLOURS[DUMMY_LOOK.cloth]).toMatchObject({ name: 'Cream', tint: 0xf4e8cb });
    // Nearest of the five tones to 0xd9b26f (217, 178, 111) by RGB distance: computed here.
    const near = (tint: number) => [16, 8, 0].reduce((sum, shift) => sum + (((tint >> shift) & 255) - ((0xd9b26f >> shift) & 255)) ** 2, 0);
    const best = SKIN_TONES.reduce((a, b, i) => (near(b.tint) < near(SKIN_TONES[a].tint) ? i : a), 0);
    expect(DUMMY_LOOK.skin).toBe(best);
    expect(SKIN_TONES[best].name).toBe('Olive');
  });
});

describe('comparisonRows', () => {
  it('lists the six rows in order, formatted as the mockup', () => {
    const dummy = dummyFighter(presetSetup('balanced', 1));
    const rows = comparisonRows(cardFighter('duelist', ASTER), dummy);
    expect(rows.map(row => row[0])).toEqual(['Health', 'Damage', 'Attack speed', 'Armor blocks', 'Critical', 'Chance to hit']);
    expect(rows[2][1]).toMatch(/^\d+(\.\d+)? s$/);
    for (const row of rows.slice(3)) expect(row[1]).toMatch(/%$/);
    expect(rows[0][2]).toBe(String(dummy.maxHealth));
  });
});
