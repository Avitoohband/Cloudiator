// Stacked duplicates (Patch 1.9, the approved stacks mockup): identical pieces share one tile with a count. Pure, so the Inventory
// and the My gladiator equip picker group the same way.
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { wearBadge } from './gear';

/** One tile: its pieces in the bag's order. `key` is the first piece's id, the id the tile and its card are known by. */
export type StackTile = { key: string; items: ItemInstance[] };

/**
 * Whether a piece may share a tile: not worn now or next, not listed, not reserved by anything (a queued build included), and not a
 * material (salvage is one piece with its own quantity). Each piece that fails keeps its own tile, so the Worn / Next / Listed tag
 * and the card say what is true of exactly that piece.
 */
export function isStackable(owner: OwnerState, item: ItemInstance): boolean {
  return item.catalogId !== CATALOG_V1.salvage.id && item.quantity === 1 && item.reservation === null
    && !owner.pendingBuild?.reservedItemIds.includes(item.id) && wearBadge(owner, item) === null;
}

/**
 * The tiles of `items`: stackable pieces of one kind (the catalog id, which holds the level and the rarity, and the binding) share the
 * tile of the first of them; every other piece is a tile of its own. Tiles keep the order of their first piece.
 */
export function groupStacks(items: readonly ItemInstance[], canStack: (item: ItemInstance) => boolean): StackTile[] {
  const tiles: StackTile[] = [], stacks = new Map<string, StackTile>();
  for (const item of items) {
    if (!canStack(item)) { tiles.push({ key: item.id, items: [item] }); continue; }
    const kind = `${item.catalogId}|${item.tier}|${item.rarity}|${item.binding}`, stack = stacks.get(kind);
    if (stack) stack.items.push(item);
    else { const tile = { key: item.id, items: [item] }; stacks.set(kind, tile); tiles.push(tile); }
  }
  return tiles;
}

/**
 * The pieces a sale of `quantity` takes from a tile, in the order they are sold: from the end of the stack, so its first piece (the
 * one that names the tile and its card) is sold last. Empty when `quantity` is not a whole number from 1 to the tile's size.
 */
export function stackSaleItems(tile: StackTile, quantity: number): ItemInstance[] {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > tile.items.length) return [];
  return tile.items.slice(tile.items.length - quantity).reverse();
}
