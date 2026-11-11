import { CATALOG_V1 } from '@domain/catalog-v1';
import { shopOffers, type Merchant, type ShopOffer } from '@domain/inventory';

/** The shop's filters (Patch 1.9): every piece, or one merchant's. */
export const SHOP_FILTERS = ['All', 'Weapons', 'Armor'] as const;
export type ShopFilter = typeof SHOP_FILTERS[number];
export type ShopCurrency = ShopOffer['currency'];

/** One cell of the shop: a catalog offer, or the Arena banner (a cosmetic the Armorer sells for renown). */
export type ShopChoice = { kind: 'offer'; id: string; offer: ShopOffer } | { kind: 'banner'; id: string };

export const BANNER = CATALOG_V1.cosmetics.banner;
export const MERCHANT_NAMES: Record<Merchant, string> = { weaponsmith: 'Weaponsmith', armorer: 'Armorer' };

/** The currency as a player reads it: the data keeps `money`, the word is gold (Task 7b). */
export const currencyWord = (currency: ShopCurrency) => currency === 'money' ? 'gold' : 'renown';

/** The filter a merchant's click opens: the Weaponsmith's weapons, the Armorer's armor; without a merchant, everything. */
export const merchantFilter = (merchant?: Merchant): ShopFilter => merchant === 'weaponsmith' ? 'Weapons' : merchant === 'armorer' ? 'Armor' : 'All';

/** Every offer by required level, the Weaponsmith's before the Armorer's within a level, catalog order within a merchant. */
const SORTED: readonly ShopOffer[] = shopOffers(CATALOG_V1)
  .sort((a, b) => a.requiredLevel - b.requiredLevel || Number(a.merchant === 'armorer') - Number(b.merchant === 'armorer'));

/** The cells a filter and a currency show, in grid order; the banner ends the Renown list wherever the Armorer's pieces show. */
export function shopChoices(filter: ShopFilter, currency: ShopCurrency): ShopChoice[] {
  const offers: ShopChoice[] = SORTED
    .filter(offer => offer.currency === currency && (filter === 'All' || (filter === 'Weapons') === (offer.merchant === 'weaponsmith')))
    .map(offer => ({ kind: 'offer', id: offer.catalogId, offer }));
  return currency === 'renown' && filter !== 'Weapons' ? [...offers, { kind: 'banner', id: BANNER.id }] : offers;
}

/** The same piece (its kind and level) sold for `currency`, or null: the banner has no gold counterpart. */
export function counterpartId(catalogId: string, currency: ShopCurrency): string | null {
  const entry = CATALOG_V1.items[catalogId];
  if (!entry) return null;
  return SORTED.find(offer => offer.currency === currency && offer.requiredLevel === entry.tier
    && CATALOG_V1.items[offer.catalogId]?.templateId === entry.templateId)?.catalogId ?? null;
}
