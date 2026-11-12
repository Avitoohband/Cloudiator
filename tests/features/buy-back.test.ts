import { expect, test } from 'vitest';
import type { BuyBackEntry, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { itemFixture, ownerFixture } from '../fixtures/domain';
import {
  BUY_BACK_SORTS, afterSaleLine, availableLine, buyBackBlock, buyBackCellLabel, buyBackCount, buyBackView, soldWhen,
} from '../../src/features/shops/buy-back';
import { queryItems } from '../../src/features/inventory/item-query';

// Patch 1.9 (Task 23): Buy back in the Shops (the approved mockup, notes.md "Buy back"). The server lists the last 10 gear sales of the
// current game day, newest first; the price is what the sale paid; the next game day starts every 14,400,000 ms.
const DAY = 14_400_000;
const entry = (saleId: number, catalogId: string, price: number, soldAtMs: number): BuyBackEntry =>
  ({ saleId, item: { ...itemFixture(CATALOG_V1.items[catalogId]), id: `item-${saleId}` }, price, soldAtMs, expiresAtMs: (Math.floor(soldAtMs / DAY) + 1) * DAY });
const plain = (text: string) => text.replace(/ /g, ' ');

test('the card says when it was sold and how long it can be bought back', () => {
  const now = new Date(2026, 10, 12, 15, 40).getTime();
  expect(soldWhen(new Date(2026, 10, 12, 15, 20).getTime(), now, '24')).toBe('today 15:20');
  expect(soldWhen(new Date(2026, 10, 11, 23, 50).getTime(), now, '24')).toBe('yesterday 23:50');
  expect(plain(availableLine(now + 2 * 3_600_000 + 20 * 60_000, now))).toBe('Available until the next game day (in 2 h 20 min).');
  expect(plain(availableLine(now + 59_000, now))).toBe('Available until the next game day (in under a minute).');
  // The client clock never removes a sale: past the boundary it only stops counting (the server answers `expired`).
  expect(availableLine(now - 1, now)).toBe('Available until the next game day.');
});

test('Buy back is refused for gold the owner cannot spend, and for a full bag', () => {
  const sword = entry(1, 'sword:5:rare', 39, 0);
  const owner = (money: number, held = 0, bag = 19): OwnerState => ({ ...structuredClone(ownerFixture), wallets: { money, renown: 0 }, reservedFees: { money: held, renown: 0 },
    inventory: Array.from({ length: bag }, (_, n) => ({ ...itemFixture(CATALOG_V1.items['axe:1:common']), id: `bag-${n}` })) });
  expect(buyBackBlock(sword, owner(100))).toBeNull();
  expect(buyBackBlock(sword, owner(39))).toBeNull();
  expect(buyBackBlock(sword, owner(30))).toEqual({ kind: 'gold', text: 'Not enough gold (you have 30).' });
  expect(buyBackBlock(sword, owner(50, 20))).toEqual({ kind: 'gold', text: 'Not enough gold (you have 30).' });
  expect(buyBackBlock(sword, owner(100, 0, 60))).toEqual({ kind: 'bag', text: 'Your bag is full (60 / 60 slots). Free a slot to buy it back.' });
});

test('the cells, the count line and the after-sale line read as the mockup', () => {
  const sword = entry(1, 'sword:5:rare', 39, 0);
  expect(buyBackCellLabel(sword)).toBe('Sword, level 5, rare, buy back for 39 gold');
  expect(buyBackCount(5, 19, 60)).toBe('5 items to buy back · your last 10 sales of this game day. 19 / 60 bag slots used.');
  expect(buyBackCount(1, 60, 60)).toBe('1 item to buy back · your last 10 sales of this game day. 60 / 60 bag slots used.');
  expect(afterSaleLine(39, 1)).toBe('Sold for 39 gold. You can buy it back in Shops until the next game day.');
  expect(afterSaleLine(30, 3, 'Light boots')).toBe('Sold 3 × Light boots for 30 gold. You can buy them back in Shops until the next game day.');
  expect(afterSaleLine(120, 12, 'Light boots')).toBe('Sold 12 × Light boots for 120 gold. You can buy back the last 10 in Shops until the next game day.');
});

test('search and sort read a sale by its item and price; Newest keeps the server order', () => {
  const list = [entry(5, 'sword:5:rare', 39, 50), entry(4, 'iron-helmet:5:uncommon', 34, 40), entry(3, 'heavy-boots:1:common', 10, 30)];
  expect(BUY_BACK_SORTS[0]).toEqual(['newest', 'Newest']);
  expect(queryItems(list, buyBackView, '', 'newest').map(e => e.saleId)).toEqual([5, 4, 3]);
  expect(queryItems(list, buyBackView, '', 'price').map(e => e.saleId)).toEqual([3, 4, 5]);
  expect(queryItems(list, buyBackView, 'helm', 'newest').map(e => e.saleId)).toEqual([4]);
});
