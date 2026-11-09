import { describe, expect, it } from 'vitest';
import type { EquipmentSlot, Stance } from '@contracts/commands';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { PublicBuild, PublicGear } from '../../src/lib/api/reads';
import { attributeRows, cardStats, gearRows, overloadLine, pointsTotal, recordText, sinceText, statRows } from '../../src/features/character/profile-card';

// Task 11c (Patch A spec, "A richer profile card"; Avi approved the mockup, 2026-10-29): the card's words from the public build, computed
// with the shared rules (deriveStats, makeFighter, criticalProbability), so they are what a fight uses.
const gear = (id: string): PublicGear => {
  const item = CATALOG_V1.items[id];
  return { catalogId: id, catalogVersion: 'v1', tier: item.tier, rarity: item.rarity, stats: structuredClone(item.stats) as PublicGear['stats'] };
};
const NONE: Record<EquipmentSlot, PublicGear | null> = { weapon: null, offHand: null, head: null, body: null, feet: null };
const ZERO = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };
const LUCILLA: PublicBuild = { stance: 'defensive', allocations: { strength: 5, agility: 1, vitality: 9, endurance: 4, precision: 3 },
  equipment: { ...NONE, weapon: gear('spear:5:uncommon'), head: gear('iron-helmet:5:common'), body: gear('heavy-armor:1:rare') } };
const XANTHE: PublicBuild = { stance: 'balanced', allocations: { strength: 6, agility: 3, vitality: 10, endurance: 6, precision: 3 },
  equipment: { ...NONE, weapon: gear('axe:5:rare'), offHand: gear('round-shield:5:uncommon'), body: gear('light-armor:5:common') } };
const ASTER: PublicBuild = { stance: 'balanced', allocations: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 }, equipment: NONE };

describe('profile card data', () => {
  it('computes the stats a fight uses, in the card\'s words', () => {
    expect(statRows(cardStats('guardian', LUCILLA)!)).toEqual([['Health', '197'], ['Damage', '15'], ['Attack speed', 'every 1.13 s'],
      ['Armor', '12.3 · blocks 25%'], ['Critical', '7% of hits']]);
    expect(statRows(cardStats('guardian', XANTHE)!)).toEqual([['Health', '207'], ['Damage', '21'], ['Attack speed', 'every 1.3 s'],
      ['Armor', '8.2 · blocks 16%'], ['Critical', '7% of hits']]);
    expect(statRows(cardStats('guardian', ASTER)!)).toEqual([['Health', '123'], ['Damage', '4'], ['Attack speed', 'every 0.94 s'],
      ['Armor', 'None'], ['Critical', '7% of hits']]);
    expect(overloadLine(cardStats('guardian', LUCILLA)!)).toBeNull();
    const heavy: PublicBuild = { stance: 'balanced', allocations: ZERO, equipment: { weapon: gear('axe:1:common'),
      offHand: gear('round-shield:1:common'), head: gear('iron-helmet:1:common'), body: gear('heavy-armor:1:common'), feet: gear('heavy-boots:1:common') } };
    expect(overloadLine(cardStats('guardian', heavy)!)).toBe('Overloaded: load 29 of 20.5, fighting at 79%');
    expect(cardStats('guardian', { ...LUCILLA, stance: 'reckless' as Stance })).toBeNull();
    // Speed rounds half up to hundredths (fix round: 1005 ms is 1.01 s, where 1.005 × 100 in binary would round down).
    const base = { health: 100, hit: 5, armor: 0, blocks: 0, critical: 0.07, efficiency: 1, load: 0, capacity: 10 };
    expect(statRows({ ...base, intervalMs: 1005 })[2]).toEqual(['Attack speed', 'every 1.01 s']);
    expect(statRows({ ...base, intervalMs: 1296 })[2]).toEqual(['Attack speed', 'every 1.3 s']);
    expect(statRows({ ...base, intervalMs: 935 })[2]).toEqual(['Attack speed', 'every 0.94 s']);
  });

  it('lists the build\'s points with the class bonus', () => {
    expect(attributeRows('guardian', LUCILLA.allocations).map(r => [r.label, r.points, r.bonus])).toEqual([['Strength', 5, null],
      ['Agility', 1, null], ['Vitality', 9, '+5%'], ['Endurance', 4, '+5%'], ['Precision', 3, null]]);
    expect(attributeRows('guardian', LUCILLA.allocations).map(r => r.width)).toEqual([5 / 9, 1 / 9, 1, 4 / 9, 3 / 9]);
    expect(attributeRows('berserker', ZERO).map(r => [r.bonus, r.width])[0]).toEqual(['+10%', 0]);
    expect(pointsTotal(LUCILLA.allocations)).toBe(22);
  });

  it('names the gear as the Inventory does', () => {
    expect(gearRows(LUCILLA)).toEqual([
      { slot: 'weapon', label: 'Weapon', name: 'Spear', detail: ' · Level 5 · uncommon', rarity: 'uncommon', note: null },
      { slot: 'offHand', label: 'Off-hand', name: null, detail: null, rarity: null, note: 'Two-handed weapon' },
      { slot: 'head', label: 'Head', name: 'Iron helmet', detail: ' · Level 5 · common', rarity: 'common', note: null },
      { slot: 'body', label: 'Body', name: 'Heavy armor', detail: ' · Level 1 · rare', rarity: 'rare', note: null },
      { slot: 'feet', label: 'Feet', name: null, detail: null, rarity: null, note: 'Empty' }]);
    expect(gearRows(ASTER)).toBeNull();
    expect(gearRows({ ...XANTHE, equipment: { ...XANTHE.equipment, head: { ...gear('iron-helmet:1:common'), catalogId: 'crown:1:common' } } })![2].name)
      .toBe('Unknown item');
  });

  it('says the record and the days in camp', () => {
    expect(recordText({ wins: 9, losses: 5 })).toBe('9–5');
    expect(recordText({ wins: 0, losses: 0 })).toBe('No bouts yet');
    const now = Date.UTC(2026, 9, 10, 0, 40);
    expect(sinceText(Date.UTC(2026, 9, 2, 9), now, 'UTC')).toBe('2 Oct · 8 days');
    expect(sinceText(Date.UTC(2026, 9, 9, 20), now, 'UTC')).toBe('9 Oct · 1 day');
    expect(sinceText(Date.UTC(2026, 9, 9, 20), now, 'Asia/Tokyo')).toBe('10 Oct · today');
    expect(sinceText(Date.UTC(2025, 9, 2, 12), Date.UTC(2026, 9, 29, 12), 'UTC')).toBe('2 Oct 2025 · 392 days');
  });
});
