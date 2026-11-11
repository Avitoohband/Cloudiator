import { describe, expect, it, vi } from 'vitest';
import type { Equipment } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { compareChoice, equipmentLoad, nextBuildDiffers, slotTiles, tileMark } from '../../src/features/character/equip-picker';
import { wearState } from '../../src/features/inventory/gear';
import { itemFixture, ownerFixture } from '../fixtures/domain';

// My gladiator's equip picker (Patch 1.9). The expected rows are written out from the catalog's stats, never derived by the helpers.
let counter = 0;
const piece = (catalogId: string, over: Partial<ItemInstance> = {}): ItemInstance => ({ ...itemFixture(CATALOG_V1.items[catalogId]), id: `q${++counter}`, ...over });
const gear = (slots: Partial<Equipment>): Equipment => ({ weapon: null, offHand: null, head: null, body: null, feet: null, ...slots });
function owner(inventory: ItemInstance[], worn: Partial<Equipment>, level = 1, pending?: Partial<Equipment>): OwnerState {
  const state = structuredClone(ownerFixture);
  state.inventory = inventory.map(item => (Object.values(worn).includes(item.id) ? { ...item, reservation: { kind: 'equipment' as const, referenceId: state.gladiatorId } } : item));
  state.currentBuild = { ...state.currentBuild, equipment: gear(worn) };
  state.progression = { ...state.progression, level };
  if (pending) {
    const equipment = gear({ ...worn, ...pending });
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, equipment }, effectiveSlotIndex: 1, reservedMoney: 0,
      reservedItemIds: Object.values(equipment).filter((id): id is string => id !== null), operationId: 'op' };
  }
  return state;
}

const sword = piece('sword:1:common'), spare1 = piece('sword:1:common'), spare2 = piece('sword:1:common'), high = piece('sword:5:common');
const spear = piece('spear:1:common'), shield = piece('round-shield:1:common'), armor = piece('light-armor:1:common'), hood = piece('leather-hood:1:common');
const heavy = piece('heavy-armor:5:common'), listedBow = piece('bow:1:common', { reservation: { kind: 'listing', referenceId: 'l1' } });

describe('slotTiles and tileMark', () => {
  it('offers only the pieces of the slot, one tile per stack of free identical pieces, worn and queued pieces on their own', () => {
    const state = owner([sword, spare1, hood, high, spare2, spear, listedBow], { weapon: sword.id });
    expect(slotTiles(state, 'weapon').map(tile => tile.items.map(item => item.id))).toEqual([[sword.id], [spare1.id, spare2.id], [high.id], [spear.id], [listedBow.id]]);
    const queued = owner([sword, spare1, spare2], { weapon: sword.id }, 1, { weapon: spare2.id });
    expect(slotTiles(queued, 'weapon').map(tile => tile.items.map(item => item.id))).toEqual([[sword.id], [spare1.id], [spare2.id]]);
  });

  it('marks worn pieces ✓, the next slot\'s →, and locks a piece above the level, listed, or an off-hand piece while a two-handed weapon is next', () => {
    const state = owner([sword, spare1, high, listedBow, spear, shield], { weapon: sword.id, offHand: shield.id }, 1, { weapon: spear.id, offHand: null });
    const mark = (item: ItemInstance) => tileMark(wearState(state, item));
    expect([sword, spare1, high, listedBow, spear, shield].map(mark)).toEqual(['worn', null, 'lock', 'lock', 'next', 'lock']);
  });
});

describe('compareChoice', () => {
  it('compares a weapon with the one worn next: damage, interval, weight and load against capacity', () => {
    const uncommon = piece('sword:1:uncommon');
    const state = owner([sword, spare1, uncommon, shield, armor], { weapon: sword.id, offHand: shield.id, body: armor.id });
    const { rows, load, offHandOff, twoHanded } = compareChoice(state, 'weapon', uncommon);
    expect(rows).toEqual([
      { label: 'Damage', before: '6', after: '6.9', change: '+0.9', tone: 'good' },
      { label: 'Attack interval', before: '1.00 s', after: '1.00 s', change: '=', tone: 'same' },
      { label: 'Weight', before: '4', after: '4', change: '=', tone: 'same' },
    ]);
    expect(load).toMatchObject({ label: 'Load', before: '12', after: '12 / 24.7', change: '=', over: false });
    expect(offHandOff).toBeNull();
    expect(twoHanded).toBe(false);
  });

  it('names the shield a two-handed weapon pushes off, shows Hands, and works the load out without the shield', () => {
    const state = owner([sword, spear, shield, armor], { weapon: sword.id, offHand: shield.id, body: armor.id });
    const result = compareChoice(state, 'weapon', spear);
    expect(result.rows).toEqual([
      { label: 'Damage', before: '6', after: '7', change: '+1', tone: 'good' },
      { label: 'Attack interval', before: '1.00 s', after: '1.20 s', change: '+0.20 s', tone: 'bad' },
      { label: 'Hands', before: '1', after: '2', change: '', tone: 'same' },
      { label: 'Weight', before: '4', after: '6', change: '+2', tone: 'bad' },
    ]);
    expect(result.load).toMatchObject({ before: '12', after: '9 / 24.7', change: '−3', tone: 'good', over: false });
    expect(result.offHandOff?.id).toBe(shield.id);
    expect(result.twoHanded).toBe(true);
  });

  it('compares Remove as an empty slot, and leaves the interval difference out when either side has none', () => {
    const state = owner([sword, armor], { weapon: sword.id, body: armor.id });
    const result = compareChoice(state, 'weapon', null);
    expect(result.rows).toEqual([
      { label: 'Damage', before: '6', after: '–', change: '−6', tone: 'bad' },
      { label: 'Attack interval', before: '1.00 s', after: '–', change: '', tone: 'same' },
      { label: 'Weight', before: '4', after: '–', change: '−4', tone: 'good' },
    ]);
    expect(result.load).toMatchObject({ before: '7', after: '3 / 24.7', change: '−4' });
  });

  it('marks a load over capacity, for armor shows Armor, and reads a locked piece too', () => {
    const axe = piece('axe:1:common'), helmet = piece('iron-helmet:1:common'), boots = piece('heavy-boots:1:common');
    const state = owner([axe, shield, helmet, armor, boots, heavy], { weapon: axe.id, offHand: shield.id, head: helmet.id, body: armor.id, feet: boots.id }, 5);
    const result = compareChoice(state, 'body', heavy);
    expect(result.rows).toEqual([
      { label: 'Armor', before: '2', after: '9', change: '+7', tone: 'good' },
      { label: 'Weight', before: '3', after: '10', change: '+7', tone: 'bad' },
    ]);
    expect(result.load).toMatchObject({ before: '22', after: '29 / 24.7', change: '+7', tone: 'bad', over: true, value: 29, capacity: 24.7 });
    const low = owner([armor, heavy], { body: armor.id }, 1);
    expect(compareChoice(low, 'body', heavy).load).toMatchObject({ after: '10 / 24.7' });
  });

  it('adds the attribute bonuses when either piece has any', () => {
    const charm = piece('leather-hood:1:common', { stats: { ...hood.stats, attributes: { ...hood.stats.attributes, endurance: 1 } } });
    const state = owner([hood, charm], { head: hood.id });
    const result = compareChoice(state, 'head', charm);
    expect(result.rows.at(-1)).toEqual({ label: 'Attribute bonuses', before: 'None', after: '+1 Endurance', change: '', tone: 'same' });
    // Endurance raises the capacity: 10 + 2 × (7 + 1) × 1.05.
    expect(result.load?.after).toBe('1 / 26.8');
    expect(result.load?.capacity).toBeCloseTo(26.8, 9);
  });
});

describe('compareChoice: the off hand that goes back on, and no fresh ids', () => {
  it('names the worn shield that goes back on when a queued two-handed weapon is removed or replaced by a one-handed one', () => {
    const state = owner([sword, spear, shield, armor], { weapon: sword.id, offHand: shield.id, body: armor.id }, 1, { weapon: spear.id, offHand: null });
    const removed = compareChoice(state, 'weapon', null);
    expect(removed.offHandBack?.id).toBe(shield.id);
    expect(removed.offHandOff).toBeNull();
    // Spear 6 + armor 3 now; with the spear removed, shield 5 + armor 3.
    expect(removed.load).toMatchObject({ before: '9', after: '8 / 24.7', change: '−1' });
    expect(compareChoice(state, 'weapon', sword).offHandBack?.id).toBe(shield.id);
    expect(compareChoice(owner([sword, spare1, shield], { weapon: sword.id, offHand: shield.id }), 'weapon', spare1).offHandBack).toBeNull();
  });

  it('never asks for a fresh operation id: the commands it reads are never sent', () => {
    const fresh = vi.spyOn(crypto, 'randomUUID');
    try {
      const state = owner([sword, spare1, spear, shield], { weapon: sword.id, offHand: shield.id });
      compareChoice(state, 'weapon', spear); compareChoice(state, 'weapon', null); compareChoice(state, 'offHand', shield);
      expect(fresh).not.toHaveBeenCalled();
    } finally { fresh.mockRestore(); }
  });
});

describe('nextBuildDiffers', () => {
  it('is true for queued gear or added points, and false for nothing queued or a stance change alone', () => {
    expect(nextBuildDiffers(owner([sword], { weapon: sword.id }))).toBe(false);
    expect(nextBuildDiffers(owner([sword, spare1], { weapon: sword.id }, 1, { weapon: spare1.id }))).toBe(true);
    const points = owner([sword], { weapon: sword.id }, 1, {});
    expect(nextBuildDiffers(points)).toBe(false);
    points.pendingBuild!.build.stance = 'offensive';
    expect(nextBuildDiffers(points)).toBe(false);
    points.pendingBuild!.build.allocations = { ...points.currentBuild.allocations, endurance: points.currentBuild.allocations.endurance + 1 };
    expect(nextBuildDiffers(points)).toBe(true);
  });
});

describe('equipmentLoad', () => {
  it('follows the next build\'s points and is null for a build that cannot be derived', () => {
    const state = owner([sword], { weapon: sword.id });
    expect(equipmentLoad(state, gear({ weapon: sword.id }))).toEqual({ load: 4, capacity: 24.7 });
    state.currentBuild.allocations.endurance = -1;
    expect(equipmentLoad(state, gear({}))).toBeNull();
  });
});
