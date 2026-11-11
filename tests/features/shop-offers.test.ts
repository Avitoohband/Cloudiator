import { expect, test } from 'vitest';
import { counterpartId, SHOP_FILTERS, shopChoices, type ShopCurrency } from '../../src/features/shops/shop-offers';

const CURRENCIES: ShopCurrency[] = ['money', 'renown'];

test('every filter and currency pair lists something', () => {
  for (const filter of SHOP_FILTERS) for (const currency of CURRENCIES) expect(shopChoices(filter, currency).length, `${filter} ${currency}`).toBeGreaterThan(0);
});

test('gold offers: 33 in All, 12 weapons and 21 armor; renown has the same offers plus the Arena banner', () => {
  expect(shopChoices('All', 'money')).toHaveLength(33);
  expect(shopChoices('Weapons', 'money')).toHaveLength(12);
  expect(shopChoices('Armor', 'money')).toHaveLength(21);
  expect(shopChoices('All', 'renown')).toHaveLength(34);
  expect(shopChoices('Weapons', 'renown')).toHaveLength(12);
  expect(shopChoices('Armor', 'renown')).toHaveLength(22);
});

test('every offer has a counterpart in the other currency', () => {
  for (const currency of CURRENCIES) {
    const other: ShopCurrency = currency === 'money' ? 'renown' : 'money';
    for (const choice of shopChoices('All', currency)) if (choice.kind === 'offer') expect(counterpartId(choice.id, other), choice.id).not.toBeNull();
  }
});

test('the Arena banner shows only in Renown, under All or Armor', () => {
  const hasBanner = (filter: typeof SHOP_FILTERS[number], currency: ShopCurrency) => shopChoices(filter, currency).some(choice => choice.kind === 'banner');
  expect(hasBanner('All', 'renown')).toBe(true);
  expect(hasBanner('Armor', 'renown')).toBe(true);
  expect(hasBanner('Weapons', 'renown')).toBe(false);
  for (const filter of SHOP_FILTERS) expect(hasBanner(filter, 'money'), `${filter} gold`).toBe(false);
});
