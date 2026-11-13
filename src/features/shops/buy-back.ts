// Patch 1.9 (Task 23): the pure rules behind Buy back in the Shops (the approved mockup, notes.md "Buy back"). The server lists the gladiator's
// last 10 gear sales of the current game day (`OwnerState.buyBack`, newest first) and is the authority on what can still be bought back; the
// client never removes a sale by its own clock. The price is what the sale paid, so the card shows it as stored.
import type { BuyBackEntry, OwnerState } from '@contracts/reads';
import { BUY_BACK } from '@domain/feedback';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { ClockMode } from '../../lib/clock-setting';
import { waitText } from '../../lib/game-day';
import { timeOfDay } from '../../lib/time-format';
import type { Queryable, SortKey } from '../inventory/item-query';

/**
 * The sales Buy back offers, or undefined when the owner read has no list (final fix wave): an older server, before M34, keeps no sales and
 * refuses `buy-back`, so the Shops show no Buy back chip and a sale no buy-back line. The shared contract types the list as present; this is
 * the client's view of it, the one place the client reads it.
 */
export const buyBackSales = (owner: OwnerView): BuyBackEntry[] | undefined => owner.buyBack;
/** The owner read as the client sees it: `buyBack` may be absent (an older server). Every `OwnerState` is one. */
export type OwnerView = Omit<OwnerState, 'buyBack'> & { buyBack?: BuyBackEntry[] };

/** The sorts of the Buy back view: Newest (the sale time, the server's order) first. */
export const BUY_BACK_SORTS: readonly [SortKey, string][] = [['newest', 'Newest'], ['level', 'Level'], ['price', 'Price'], ['name', 'Name'], ['damage', 'Damage'],
  ['armor', 'Armor'], ['weight', 'Weight']];

export const buyBackName = (entry: BuyBackEntry): string => CATALOG_V1.items[entry.item.catalogId]?.name ?? entry.item.catalogId;

/** What search and sort read from a sale: the item's name, level and stats, and its price. */
export const buyBackView = (entry: BuyBackEntry): Queryable => ({ name: buyBackName(entry), level: entry.item.tier, price: entry.price,
  damage: entry.item.stats.damage, armor: entry.item.stats.armor, weight: entry.item.stats.weight });

/** A cell's name: what it is and what buying it back costs. */
export const buyBackCellLabel = (entry: BuyBackEntry): string =>
  `${buyBackName(entry)}, level ${entry.item.tier}, ${entry.item.rarity}, buy back for ${entry.price} gold`;

const DAY_MS = 86_400_000;
const localDay = (ms: number) => { const date = new Date(ms); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };
/** When it was sold, in the viewer's time zone: "today 15:20", or "yesterday 23:50" (a game day can span midnight). */
export function soldWhen(soldAtMs: number, nowMs: number, clock: ClockMode): string {
  const time = timeOfDay(soldAtMs, clock);
  const days = (localDay(nowMs) - localDay(soldAtMs)) / DAY_MS;
  return `${days === 0 ? 'today' : days === 1 ? 'yesterday' : ''} ${time}`.trim();
}

/** The card's line: until the next game day, with a live countdown; past it, the line alone (the server answers a late Buy back). */
export function availableLine(expiresAtMs: number, nowMs: number): string {
  const left = expiresAtMs - nowMs;
  return left > 0 ? `Available until the next game day (in ${waitText(left)}).` : 'Available until the next game day.';
}

/** Why Buy back is off: the gold the owner can spend (the wallet less held fees) is short, or the bag is full; null when it can go. */
export function buyBackBlock(entry: BuyBackEntry, owner: OwnerState): { kind: 'gold' | 'bag'; text: string } | null {
  const gold = owner.wallets.money - owner.reservedFees.money;
  if (gold < entry.price) return { kind: 'gold', text: `Not enough gold (you have ${gold}).` };
  if (owner.inventory.length >= owner.inventoryCapacity) {
    return { kind: 'bag', text: `Your bag is full (${owner.inventory.length} / ${owner.inventoryCapacity} slots). Free a slot to buy it back.` };
  }
  return null;
}

/** The line under the grid. */
export const buyBackCount = (count: number, used: number, capacity: number): string =>
  `${count} item${count === 1 ? '' : 's'} to buy back · your last ${BUY_BACK.recentSales} sales of this game day. ${used} / ${capacity} bag slots used.`;

export const BUY_BACK_EMPTY = 'Nothing to buy back. Items you sell today can be bought back until the next game day.';
export const BUY_BACK_EMPTY_CARD = 'Sold items show here, newest first, for the rest of the game day.';
export const BUY_BACK_SAME_PRICE = 'Same price you were paid. It comes back with its level, rarity and stats.';

/**
 * What a sale says once it is done (it replaces "Sold Sword for 39 gold."): one piece, or a stack sold as `count` separate sales, of which
 * only the last 10 can be bought back.
 */
export function afterSaleLine(gold: number, count: number, name = ''): string {
  if (count <= 1) return `Sold for ${gold} gold. You can buy it back in Shops until the next game day.`;
  const back = count <= BUY_BACK.recentSales ? 'You can buy them back' : `You can buy back the last ${BUY_BACK.recentSales}`;
  return `Sold ${count} × ${name} for ${gold} gold. ${back} in Shops until the next game day.`;
}

/** What a gear sale says where the server has no Buy back (`buyBackSales` undefined): the line from before 1.9. */
export const plainSaleLine = (gold: number, count: number, name: string): string =>
  (count <= 1 ? `Sold ${name} for ${gold} gold.` : `Sold ${count} × ${name} for ${gold} gold.`);
