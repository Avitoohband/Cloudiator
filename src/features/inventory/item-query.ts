/**
 * Search and sort for the Inventory and the Shops (Patch 1.9, the approved search mockup): one pure helper both panels use.
 * A query is a case-insensitive part of the name (trimmed; empty matches everything). A sort is stable, so ties keep the
 * panel's default order. Level, Price and Name ascend; Damage, Armor, Weight and Sell value descend.
 */
export type SortKey = 'newest' | 'level' | 'price' | 'name' | 'damage' | 'armor' | 'weight' | 'sell';

/** What a cell offers the query: its name and the numbers a sort reads (null where a cell has none, as the Arena banner has no stats). */
export type Queryable = {
  name: string; level?: number | null; price?: number | null; damage?: number | null; armor?: number | null; weight?: number | null; sell?: number | null;
};

export const SHOP_SORTS: readonly [SortKey, string][] = [['level', 'Level'], ['price', 'Price'], ['name', 'Name'], ['damage', 'Damage'], ['armor', 'Armor'], ['weight', 'Weight']];
export const INVENTORY_SORTS: readonly [SortKey, string][] = [['newest', 'Newest'], ['level', 'Level'], ['name', 'Name'], ['damage', 'Damage'], ['armor', 'Armor'], ['weight', 'Weight'], ['sell', 'Sell value']];

/** The key a sort reads and its direction: 1 ascends, -1 descends. */
const SORTS: Record<Exclude<SortKey, 'newest'>, { field: keyof Queryable; direction: 1 | -1 }> = {
  level: { field: 'level', direction: 1 }, price: { field: 'price', direction: 1 }, name: { field: 'name', direction: 1 },
  damage: { field: 'damage', direction: -1 }, armor: { field: 'armor', direction: -1 }, weight: { field: 'weight', direction: -1 }, sell: { field: 'sell', direction: -1 },
};

export const matchesQuery = (name: string, query: string) => {
  const needle = query.trim().toLowerCase();
  return needle === '' || name.toLowerCase().includes(needle);
};

/** The cells whose name matches, in the sort's order. A cell with no value for the sorted field goes after every cell that has one. */
export function queryItems<T>(list: readonly T[], view: (cell: T) => Queryable, query: string, sort: SortKey): T[] {
  const matches = list.filter(cell => matchesQuery(view(cell).name, query));
  if (sort === 'newest') return matches;
  const { field, direction } = SORTS[sort];
  const value = (cell: T) => view(cell)[field] ?? null;
  return matches.map((cell, index) => ({ cell, index, key: value(cell) })).sort((a, b) => {
    if (a.key === null || b.key === null) return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
    const order = typeof a.key === 'string' || typeof b.key === 'string' ? String(a.key).localeCompare(String(b.key), 'en') : a.key - b.key;
    return order * direction || a.index - b.index;
  }).map(entry => entry.cell);
}
