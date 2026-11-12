import { expect, it } from 'vitest';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { groupStacks, isStackable, joinsStack, stackSaleItems } from '../../src/features/inventory/stacks';
import { itemFixture, ownerFixture } from '../fixtures/domain';

// Identical pieces share one tile (Patch 1.9, the approved stacks mockup). Worn, listed, reserved and queued pieces keep their own
// tile; pieces of another level, rarity or binding never join a stack.
let counter = 0;
const piece = (catalogId: string, over: Partial<ItemInstance> = {}): ItemInstance =>
  ({ ...itemFixture(CATALOG_V1.items[catalogId]), id: `p${++counter}`, ...over });
const owner = (inventory: ItemInstance[], over: Partial<OwnerState> = {}): OwnerState => ({ ...structuredClone(ownerFixture), inventory, ...over });
const shape = (state: OwnerState) => groupStacks(state.inventory, item => isStackable(state, item)).map(tile => tile.items.map(item => item.id).join('+'));

it('puts identical free pieces in one tile at the place of the first, keyed by its id', () => {
  const [a, b, c, d] = [piece('light-boots:1:common'), piece('sword:1:common'), piece('light-boots:1:common'), piece('light-boots:1:common')];
  const state = owner([a, b, c, d]);
  const tiles = groupStacks(state.inventory, item => isStackable(state, item));
  expect(tiles.map(tile => tile.key)).toEqual([a.id, b.id]);
  expect(tiles[0].items).toEqual([a, c, d]);
  expect(tiles[1].items).toEqual([b]);
});

it('never joins another level, another rarity or another binding', () => {
  const state = owner([piece('sword:1:common'), piece('sword:5:common'), piece('sword:1:uncommon'), piece('sword:1:common', { binding: 'bound' }), piece('sword:1:common')]);
  expect(shape(state)).toEqual(['p' + (counter - 4) + '+p' + counter, 'p' + (counter - 3), 'p' + (counter - 2), 'p' + (counter - 1)]);
});

it('never joins pieces of another catalog version, nor counts one as its stack (final review Minor 8)', () => {
  const [v1a, v2, v1b] = [piece('sword:1:common'), piece('sword:1:common', { catalogVersion: 'v2' }), piece('sword:1:common')];
  const state = owner([v1a, v2, v1b]);
  expect(shape(state)).toEqual([`${v1a.id}+${v1b.id}`, v2.id]);
  expect(joinsStack(owner([v2, v1a]), v2)).toBe(false);
});

it('keeps a worn, a queued, a listed and a reserved piece on its own tile', () => {
  const [worn, queued, listed, reserved, free1, free2] = ['light-boots:1:common', 'light-boots:1:common', 'light-boots:1:common', 'light-boots:1:common', 'light-boots:1:common', 'light-boots:1:common'].map(id => piece(id));
  listed.reservation = { kind: 'listing', referenceId: 'l' };
  reserved.reservation = { kind: 'pending-build', referenceId: 'r' };
  const state = owner([worn, queued, listed, reserved, free1, free2]);
  state.currentBuild.equipment = { ...state.currentBuild.equipment, feet: worn.id };
  state.pendingBuild = { build: { ...state.currentBuild, version: 2, equipment: { ...state.currentBuild.equipment, feet: queued.id } }, effectiveSlotIndex: 1, reservedMoney: 0, reservedItemIds: [queued.id], operationId: 'o' };
  expect(shape(state)).toEqual([worn.id, queued.id, listed.id, reserved.id, `${free1.id}+${free2.id}`]);
  expect([worn, queued, listed, reserved, free1].map(item => isStackable(state, item))).toEqual([false, false, false, false, true]);
});

it('does not stack a piece the queued build reserves even when its own reservation is unset', () => {
  const [a, b] = [piece('axe:1:common'), piece('axe:1:common')];
  const state = owner([a, b]);
  state.pendingBuild = { build: { ...state.currentBuild, version: 2 }, effectiveSlotIndex: 1, reservedMoney: 0, reservedItemIds: [b.id], operationId: 'o' };
  expect(shape(state)).toEqual([a.id, b.id]);
});

it('leaves materials alone: salvage keeps its own quantity on its own tile', () => {
  const salvage = (id: string, quantity: number): ItemInstance => ({ ...piece('light-boots:1:common'), id, catalogId: CATALOG_V1.salvage.id, quantity });
  const state = owner([salvage('s1', 4), salvage('s2', 1)]);
  expect(shape(state)).toEqual(['s1', 's2']);
});

it('sells from the end of the stack, so its first piece stays and the card keeps its place', () => {
  const items = [piece('light-boots:1:common'), piece('light-boots:1:common'), piece('light-boots:1:common')];
  const [tile] = groupStacks(items, () => true);
  expect(stackSaleItems(tile, 2).map(item => item.id)).toEqual([items[2].id, items[1].id]);
  expect(stackSaleItems(tile, 3).map(item => item.id)).toEqual([items[2].id, items[1].id, items[0].id]);
  expect(stackSaleItems(tile, 1).map(item => item.id)).toEqual([items[2].id]);
  expect(stackSaleItems(tile, 0)).toEqual([]);
  expect(stackSaleItems(tile, 4)).toEqual([]);
  expect(stackSaleItems(tile, 1.5)).toEqual([]);
});

it('says an undone piece goes back into a stack only when another free piece of its kind is in the bag', () => {
  const [queued, free, other, bound] = [piece('sword:1:common'), piece('sword:1:common'), piece('sword:1:uncommon'), piece('sword:1:common', { binding: 'bound' })];
  const state = owner([queued, free, other, bound]);
  state.pendingBuild = { build: { ...state.currentBuild, version: 2, equipment: { ...state.currentBuild.equipment, weapon: queued.id } }, effectiveSlotIndex: 1,
    reservedMoney: 0, reservedItemIds: [queued.id], operationId: 'op' };
  expect(joinsStack(state, queued)).toBe(true);
  expect(joinsStack(owner([queued, other, bound]), queued)).toBe(false);
  const reserved = owner([queued, { ...free, reservation: { kind: 'listing', referenceId: 'l' } }]);
  expect(joinsStack(reserved, queued)).toBe(false);
});
