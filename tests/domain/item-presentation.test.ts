import { describe, expect, test } from 'vitest';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { itemIconFrame, itemStatLines } from '../../src/features/inventory/item-presentation';

describe('inventory item presentation', () => {
  test('finds shipped art for every catalog item, including tier and renown variants', () => {
    expect(Object.keys(CATALOG_V1.items).every(id => itemIconFrame(id) !== null)).toBe(true);
    expect(itemIconFrame('spear:5:uncommon')).toMatchObject({ name: 'spear', x: 144, y: 16, w: 16, h: 16 });
    expect(itemIconFrame('round-shield:1:renown')).toMatchObject({ name: 'shield' });
    expect(itemIconFrame('salvage')).toMatchObject({ name: 'salvage' });
    expect(itemIconFrame('unknown-legacy-item')).toBeNull();
  });

  test('shows actual instance stats and bonuses instead of reading the template values', () => {
    const item = CATALOG_V1.items['spear:5:uncommon'];
    const stats = { ...item.stats, damage: 17, weight: 8, intervalMs: 1201, attributes: { ...item.stats.attributes, strength: 3, agility: -1 } };
    expect(Object.fromEntries(itemStatLines({ catalogId: item.id, stats }))).toEqual({
      Damage: '17', 'Attack interval': '1.201 s', Hands: '2', Weight: '8', 'Attribute bonuses': '+3 Strength · -1 Agility',
    });
  });

  test('shows armor and weight for armor and keeps unknown item stats available', () => {
    const armor = CATALOG_V1.items['heavy-armor:5:common'];
    expect(Object.fromEntries(itemStatLines({ catalogId: armor.id, stats: armor.stats }))).toEqual({
      Armor: '9', Weight: '10', 'Attribute bonuses': 'None',
    });
    expect(itemStatLines({ catalogId: 'unknown-legacy-item', stats: armor.stats })).toContainEqual(['Weight', '10']);
  });
});
