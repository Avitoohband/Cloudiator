import { expect, test } from 'vitest';
import { INVENTORY_SORTS, SHOP_SORTS, matchesQuery, queryItems, type Queryable, type SortKey } from '../../src/features/inventory/item-query';

type Cell = Queryable & { id: string };
const cell = (id: string, name: string, rest: Partial<Queryable> = {}): Cell => ({ id, name, ...rest });
const cells: Cell[] = [
  cell('a', 'Sword', { level: 5, price: 120, damage: 9, armor: 0, weight: 4, sell: 30 }),
  cell('b', 'Axe', { level: 1, price: 40, damage: 8, armor: 0, weight: 6, sell: 10 }),
  cell('c', 'Heavy armor', { level: 1, price: 80, damage: 0, armor: 6, weight: 10, sell: 20 }),
  cell('d', 'Bow', { level: 5, price: 120, damage: 9, armor: 0, weight: 3, sell: null }),
  cell('e', 'Arena banner', { price: 50 }),
];
const ids = (list: Cell[]) => list.map(c => c.id).join('');
const sorted = (sort: SortKey, query = '') => ids(queryItems(cells, c => c, query, sort));

test('matching is a case-insensitive part of the name; the query is trimmed and empty matches all', () => {
  expect(matchesQuery('Heavy armor', 'ARM')).toBe(true);
  expect(matchesQuery('Heavy armor', '  vy a ')).toBe(true);
  expect(matchesQuery('Heavy armor', 'sword')).toBe(false);
  expect(matchesQuery('Sword', '')).toBe(true);
  expect(matchesQuery('Sword', '   ')).toBe(true);
  expect(ids(queryItems(cells, c => c, 'AR', 'newest'))).toBe('ce');
  expect(queryItems(cells, c => c, 'zzz', 'newest')).toEqual([]);
});

test('the default order keeps the list as it came', () => {
  expect(sorted('newest')).toBe('abcde');
});

test('Level, Price and Name ascend; ties keep the default order; a cell without the value goes last', () => {
  expect(sorted('level')).toBe('bcade'); // 1, 1, 5, 5, then the banner (no level)
  expect(sorted('price')).toBe('becad'); // 40, 50, 80, 120, 120 (a before d)
  expect(sorted('name')).toBe('ebdca'); // Arena banner, Axe, Bow, Heavy armor, Sword
});

test('Damage, Armor, Weight and Sell value descend; ties keep the default order; a cell without the value goes last', () => {
  expect(sorted('damage')).toBe('adbce'); // 9,9,8,0 then banner
  expect(sorted('armor')).toBe('cabde'); // 6 then three 0s in order, banner last
  expect(sorted('weight')).toBe('cbade'); // 10, 6, 4, 3, banner
  expect(sorted('sell')).toBe('acbde'); // 30,20,10, then null d and banner in order
});

test('search and sort work together', () => {
  expect(sorted('price', 'r')).toBe('eca'); // Arena banner 50, Heavy armor 80, Sword 120
});

test('the sort lists: the shop defaults to Level and the inventory to Newest', () => {
  expect(SHOP_SORTS.map(([, label]) => label)).toEqual(['Level', 'Price', 'Name', 'Damage', 'Armor', 'Weight']);
  expect(INVENTORY_SORTS.map(([, label]) => label)).toEqual(['Newest', 'Level', 'Name', 'Damage', 'Armor', 'Weight', 'Sell value']);
});
