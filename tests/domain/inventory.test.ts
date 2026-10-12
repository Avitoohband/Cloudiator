import { describe, expect, it } from 'vitest';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { applyXp, historicalGearScore, npcSaleValue, planInventoryGrant, shopOffer, shopOffers, type LootGrant } from '@domain/inventory.ts';
import type { ItemInstance } from '@domain/types.ts';
import { itemFixture, ownerFixture } from '../fixtures/domain.ts';

let serial = 0;
/** Unique, sortable UUID-shaped IDs keep stacking order and inventory counts explicit. */
const nextId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
const gear = (catalogId: string, overrides: Partial<ItemInstance> = {}): ItemInstance =>
  ({ ...itemFixture(CATALOG_V1.items[catalogId]), id: nextId(), ...overrides });
const salvage = (quantity: number, id = nextId()): ItemInstance => ({ id, ownerId: ownerFixture.gladiatorId, catalogId: 'salvage', catalogVersion: 'v1',
  tier: 1, rarity: 'common', stats: { damage: 0, armor: 0, weight: 0, intervalMs: 0, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } },
  quantity, origin: 'expedition', binding: 'tradable', reservation: null });
const swords = (count: number) => Array.from({ length: count }, () => gear('sword:1:common'));
const loot = (catalogId: string, quantity = 1, origin: LootGrant['origin'] = 'expedition'): LootGrant => ({ catalogId, catalogVersion: 'v1', quantity, origin });

const fullInventory = swords(60);
const commonSwordLoot = [loot('sword:1:common')];

describe('inventory grants', () => {
  it('sells expedition gear that cannot fit at its NPC value', () => {
    expect(planInventoryGrant(fullInventory, commonSwordLoot, CATALOG_V1).overflowMoney).toBe(10);
    expect(planInventoryGrant(fullInventory, commonSwordLoot, CATALOG_V1)).toMatchObject({ retained: [], rejected: [],
      overflow: [{ catalogId: 'sword:1:common', quantity: 1, unitValue: 10, money: 10 }], slotsUsed: 60 });
  });

  it.each([
    [59, 'expedition', { retained: 1, overflowMoney: 0, rejected: 0, slotsUsed: 60 }],
    [60, 'expedition', { retained: 0, overflowMoney: 10, rejected: 0, slotsUsed: 60 }],
    [61, 'expedition', { retained: 0, overflowMoney: 10, rejected: 0, slotsUsed: 61 }],
    [59, 'shop', { retained: 1, overflowMoney: 0, rejected: 0, slotsUsed: 60 }],
    [60, 'shop', { retained: 0, overflowMoney: 0, rejected: 1, slotsUsed: 60 }],
    [61, 'shop', { retained: 0, overflowMoney: 0, rejected: 1, slotsUsed: 61 }],
  ] as const)('counts every owned item against the 60-slot boundary at %i items (%s)', (count, origin, want) => {
    const plan = planInventoryGrant(swords(count), [loot('sword:1:common', 1, origin)], CATALOG_V1);
    expect({ retained: plan.retained.length, overflowMoney: plan.overflowMoney, rejected: plan.rejected.length, slotsUsed: plan.slotsUsed }).toEqual(want);
  });

  it('counts equipped and listed items as occupied slots', () => {
    const inventory = [...swords(58), gear('light-armor:1:common', { reservation: { kind: 'equipment', referenceId: ownerFixture.gladiatorId } }),
      gear('axe:1:common', { reservation: { kind: 'listing', referenceId: nextId() } })];
    expect(planInventoryGrant(inventory, [loot('sword:1:common', 1, 'shop')], CATALOG_V1).rejected).toHaveLength(1);
  });

  it('never converts renown equipment to money and rejects only the units that do not fit', () => {
    expect(planInventoryGrant(fullInventory, [loot('sword:1:renown', 1, 'renown')], CATALOG_V1)).toMatchObject({
      retained: [], overflow: [], overflowMoney: 0, rejected: [{ catalogId: 'sword:1:renown', quantity: 1, origin: 'renown' }] });
    const partial = planInventoryGrant(swords(58), [loot('iron-helmet:1:renown', 3, 'renown')], CATALOG_V1);
    expect(partial).toMatchObject({ overflowMoney: 0, rejected: [{ catalogId: 'iron-helmet:1:renown', quantity: 1 }], slotsUsed: 60 });
    expect(partial.retained).toHaveLength(2);
  });

  it('copies immutable catalog rolls, origin and binding into each new slot', () => {
    const plan = planInventoryGrant([], [loot('bow:10:rare'), loot('iron-helmet:1:renown', 1, 'renown'), loot('axe:5:common', 2, 'shop')], CATALOG_V1);
    expect(plan.retained).toEqual([
      { catalogId: 'bow:10:rare', catalogVersion: 'v1', tier: 10, rarity: 'rare', quantity: 1, origin: 'expedition', binding: 'tradable',
        stats: { damage: 15.6, armor: 0, weight: 3, intervalMs: 1100, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } } },
      { catalogId: 'iron-helmet:1:renown', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity: 1, origin: 'renown', binding: 'bound',
        stats: { damage: 0, armor: 3, weight: 4, intervalMs: 0, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } } },
      { catalogId: 'axe:5:common', catalogVersion: 'v1', tier: 5, rarity: 'common', quantity: 1, origin: 'shop', binding: 'tradable',
        stats: { damage: 12, armor: 0, weight: 6, intervalMs: 1400, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } } },
      { catalogId: 'axe:5:common', catalogVersion: 'v1', tier: 5, rarity: 'common', quantity: 1, origin: 'shop', binding: 'tradable',
        stats: { damage: 12, armor: 0, weight: 6, intervalMs: 1400, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } } },
    ]);
    plan.retained[2].stats.damage = 999;
    expect(CATALOG_V1.items['axe:5:common'].stats.damage).toBe(12);
    expect(plan.retained[3].stats.damage).toBe(12);
  });

  it('tops up partial salvage stacks in ID order before opening slots, then sells the remainder', () => {
    const full = salvage(999, '00000000-0000-4000-8000-a00000000001');
    const nearlyFull = salvage(998, '00000000-0000-4000-8000-a00000000002');
    const partial = salvage(990, '00000000-0000-4000-8000-a00000000003');
    const inventory = [partial, ...swords(56), full, nearlyFull];
    const plan = planInventoryGrant(inventory, [loot('salvage', 1500)], CATALOG_V1);
    expect(plan.stacked).toEqual([{ itemId: nearlyFull.id, quantity: 1 }, { itemId: partial.id, quantity: 9 }]);
    expect(plan.retained).toEqual([expect.objectContaining({ catalogId: 'salvage', quantity: 999, origin: 'expedition', binding: 'tradable' })]);
    expect(plan.overflow).toEqual([{ catalogId: 'salvage', quantity: 491, unitValue: 10, money: 4910 }]);
    expect(plan).toMatchObject({ overflowMoney: 4910, slotsUsed: 60 });
  });

  it('lets a later salvage grant fill a stack opened earlier in the same plan', () => {
    const plan = planInventoryGrant(swords(58), [loot('salvage', 3), loot('salvage', 4)], CATALOG_V1);
    expect(plan.retained).toEqual([expect.objectContaining({ catalogId: 'salvage', quantity: 7 })]);
    expect(plan).toMatchObject({ stacked: [], overflowMoney: 0, slotsUsed: 59 });
  });

  it('sells overflow at the rarity- and tier-adjusted NPC value', () => {
    // 25% of the Common tier-5 axe price (40 x 3) x 1.15 = 34.5, rounded down.
    expect(planInventoryGrant(fullInventory, [loot('axe:5:uncommon')], CATALOG_V1).overflowMoney).toBe(34);
    expect(planInventoryGrant(fullInventory, [loot('leather-hood:1:rare')], CATALOG_V1).overflowMoney).toBe(6);
  });

  it('rejects malformed grants and unsafe quantity or price totals', () => {
    for (const grant of [loot('sword:1:common', 0), loot('sword:1:common', 1.5), loot('missing'), { ...loot('sword:1:common'), catalogVersion: 'v2' },
      loot('salvage', 1, 'shop'), loot('sword:1:common', 1, 'renown'), loot('sword:1:renown', 1, 'shop'), loot('sword:1:uncommon', 1, 'shop'),
      loot('sword:1:renown', 1, 'expedition'), { ...loot('sword:1:common'), origin: 'starter' as LootGrant['origin'] }]) {
      expect(() => planInventoryGrant([], [grant], CATALOG_V1), JSON.stringify(grant)).toThrow(RangeError);
    }
    expect(() => planInventoryGrant(fullInventory, [loot('salvage', Number.MAX_SAFE_INTEGER)], CATALOG_V1)).toThrow(RangeError);
    expect(() => planInventoryGrant(fullInventory, [loot('salvage', 2 ** 52), loot('salvage', 2 ** 52)], CATALOG_V1)).toThrow(RangeError);
  });
});

describe('experience', () => {
  it('consumes 100 x current level per level-up without granting points or stamina', () => {
    expect(applyXp(1, 0, 100)).toEqual({ level: 2, xp: 0 });
  });

  it.each([
    [1, 0, 99, { level: 1, xp: 99 }],
    [1, 0, 300, { level: 3, xp: 0 }],
    [1, 50, 250, { level: 3, xp: 0 }],
    [2, 150, 49, { level: 2, xp: 199 }],
    [4, 399, 1, { level: 5, xp: 0 }],
    [1, 0, 4_500, { level: 10, xp: 0 }],
    [1, 0, 4_499, { level: 9, xp: 899 }],
    [1_000_000_000, 0, 1_000_000_000_000, { level: 1_000_000_000, xp: 1_000_000_000_000 }],
  ])('advances level %i with %i XP plus %i', (level, xp, award, want) => {
    expect(applyXp(level, xp, award)).toEqual(want);
  });

  it('rejects invalid progression inputs and unsafe XP totals', () => {
    for (const [level, xp, award] of [[0, 0, 1], [1.5, 0, 1], [1, -1, 1], [1, 0, -1], [1, 0, 0.5], [1_000_000_001, 0, 1],
      [1, Number.MAX_SAFE_INTEGER, 1], [1, 0, Number.NaN]]) expect(() => applyXp(level, xp, award)).toThrow(RangeError);
  });
});

describe('historical gear strength', () => {
  it('scores the starter loadout from immutable item stats', () => {
    // 4 x 6 x (1000 / 1000) for the sword plus 2 x 2 armor.
    expect(historicalGearScore([gear('sword:1:common'), gear('light-armor:1:common')], 0)).toBe(28);
    // 4 x 8 x (1000 / 1400) = 22.857..., kept to two decimals without rounding up.
    expect(historicalGearScore([gear('axe:1:common')], 0)).toBe(22.85);
  });

  it('chooses the best legal loadout under the two-handed rule', () => {
    const spear = gear('spear:1:common'), sword = gear('sword:1:common'), shield = gear('round-shield:1:common');
    // A spear (4 x 7 x 1000/1200 = 23.33) cannot be combined with the shield (2 x 3).
    expect(historicalGearScore([spear, shield], 0)).toBe(23.33);
    expect(historicalGearScore([spear, sword, shield], 0)).toBe(30);
    expect(historicalGearScore([gear('spear:10:common'), sword, shield], 0)).toBe(46.66);
    const heavy = [gear('heavy-armor:1:common'), gear('iron-helmet:1:common'), gear('heavy-boots:1:common'), gear('light-boots:1:common')];
    expect(historicalGearScore([...heavy, sword, shield], 0)).toBe(24 + 6 + 2 * (6 + 3 + 2));
  });

  it('counts one item per slot and ignores salvage and unknown entries', () => {
    expect(historicalGearScore([gear('sword:1:common'), gear('sword:1:common')], 0)).toBe(24);
    expect(historicalGearScore([salvage(999), gear('sword:1:common', { catalogId: 'missing' })], 0)).toBe(0);
  });

  it('includes the renown arena bonus for bound arena gear', () => {
    expect(historicalGearScore([gear('sword:1:renown')], 0)).toBe(26.4);
    expect(historicalGearScore([gear('iron-helmet:1:renown')], 0)).toBe(6.6);
  });

  it('never decreases as items are acquired, unequipped, sold or discarded', () => {
    // Axe 22.85; + boots 2; spear 35 replaces it; the shield (2 x 5.18) cannot join the spear; heavy armor adds 2 x 6.
    const acquired = [gear('axe:1:common'), gear('light-boots:1:common'), gear('spear:5:common'), gear('round-shield:5:uncommon'), gear('heavy-armor:1:common')];
    let peak = 0;
    const history: number[] = [];
    for (let i = 1; i <= acquired.length; i++) { peak = historicalGearScore(acquired.slice(0, i), peak); history.push(peak); }
    expect(history).toEqual([22.85, 24.85, 37, 37, 49]);
    // Removing the best items afterwards keeps the retained maximum.
    expect(historicalGearScore([acquired[1]], peak)).toBe(49);
    expect(historicalGearScore([], 50)).toBe(50);
  });

  it('rejects an invalid previous maximum', () => {
    for (const previous of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => historicalGearScore([], previous)).toThrow(RangeError);
  });
});

describe('NPC shops', () => {
  const money = { sword: 40, axe: 40, spear: 40, bow: 40, 'round-shield': 30, 'leather-hood': 20, 'iron-helmet': 40, 'light-armor': 40, 'heavy-armor': 80, 'light-boots': 20, 'heavy-boots': 40 };
  const renown = { sword: 50, axe: 50, spear: 50, bow: 50, 'round-shield': 40, 'leather-hood': 30, 'iron-helmet': 30, 'light-armor': 50, 'heavy-armor': 50, 'light-boots': 30, 'heavy-boots': 30 };
  const weapons = ['sword', 'axe', 'spear', 'bow'];

  it('sells every Common money variant and every renown variant at the versioned price and level', () => {
    for (const [template, base] of Object.entries(money)) {
      for (const [tier, moneyMultiplier, renownMultiplier] of [[1, 1, 1], [5, 3, 2], [10, 6, 3]]) {
        const merchant = weapons.includes(template) ? 'weaponsmith' : 'armorer';
        expect(shopOffer(`${template}:${tier}:common`, CATALOG_V1)).toEqual({ catalogId: `${template}:${tier}:common`, catalogVersion: 'v1',
          currency: 'money', unitPrice: base * moneyMultiplier, requiredLevel: tier, merchant });
        expect(shopOffer(`${template}:${tier}:renown`, CATALOG_V1)).toEqual({ catalogId: `${template}:${tier}:renown`, catalogVersion: 'v1',
          currency: 'renown', unitPrice: renown[template as keyof typeof renown] * renownMultiplier, requiredLevel: tier, merchant });
        expect(shopOffer(`${template}:${tier}:uncommon`, CATALOG_V1)).toBeNull();
        expect(shopOffer(`${template}:${tier}:rare`, CATALOG_V1)).toBeNull();
      }
    }
    expect(shopOffer('salvage', CATALOG_V1)).toBeNull();
    expect(shopOffer('missing', CATALOG_V1)).toBeNull();
    const offers = shopOffers(CATALOG_V1);
    expect(offers).toHaveLength(66);
    expect(offers.filter(offer => offer.merchant === 'weaponsmith')).toHaveLength(24);
  });

  it('values NPC sales from the catalog and refuses bound or renown-origin gear', () => {
    expect(npcSaleValue(gear('sword:1:common'), CATALOG_V1)).toBe(10);
    expect(npcSaleValue(gear('heavy-armor:10:common'), CATALOG_V1)).toBe(120);
    expect(npcSaleValue(gear('axe:5:uncommon', { origin: 'expedition' }), CATALOG_V1)).toBe(34);
    expect(npcSaleValue(gear('light-boots:1:rare', { origin: 'expedition' }), CATALOG_V1)).toBe(6);
    expect(npcSaleValue(salvage(12), CATALOG_V1)).toBe(10);
    expect(npcSaleValue(gear('sword:1:renown'), CATALOG_V1)).toBeNull();
    expect(npcSaleValue(gear('sword:1:common', { binding: 'bound' }), CATALOG_V1)).toBeNull();
    expect(npcSaleValue(gear('sword:1:common', { origin: 'renown' }), CATALOG_V1)).toBeNull();
    expect(npcSaleValue(gear('sword:1:common', { tier: 5 }), CATALOG_V1)).toBeNull();
    expect(npcSaleValue(gear('sword:1:common', { catalogVersion: 'v2' }), CATALOG_V1)).toBeNull();
  });
});
