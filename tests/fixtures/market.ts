// Open marketplace offers for the fixture preview (Task 18.2), as the live `market` read serves them from the public
// `market_offers` projection: newest listing first, then by listing id, in pages of at most 50. Each offer carries only the
// sanitized fields (seller, the item's catalog fields, stats and quantity, the price and the times), never an item id, owner,
// origin or reservation. The items are tradable catalog equipment; prices are above each one's NPC sale value. Listing
// times count back from the fixture world's server time, so every offer is open there (seven days from listing).
// No JSON imports, so browser specs can import this module directly.
import type { MarketListing, MarketPage } from '../../supabase/functions/_shared/contracts/reads.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { worldFixture } from './domain.ts';
import { ARENA_GLADIATORS, fixtureUuid, type ArenaGladiatorKey } from './arena-ids.ts';

const MARKET_PAGE = 50;
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** Seven days, `RULES_V1.marketplace.expiryMs`. */
const LISTING_MS = 7 * DAY;
const NOW = worldFixture.serverNowMs;

/** Each offer: who listed which catalog item, at what price, and how long before the fixture time. */
const OFFERS: { key: string; seller: ArenaGladiatorKey; catalogId: string; price: number; listedAgoMs: number }[] = [
  { key: 'varro-spear', seller: 'varro', catalogId: 'spear:10:rare', price: 450, listedAgoMs: 4 * MINUTE },
  // The fixture owner's own listing, shown under "My listings".
  { key: 'aster-helmet', seller: 'aster', catalogId: 'iron-helmet:5:uncommon', price: 95, listedAgoMs: 25 * MINUTE },
  { key: 'cassia-shield', seller: 'cassia', catalogId: 'round-shield:1:common', price: 18, listedAgoMs: 2 * HOUR },
  { key: 'severus-axe', seller: 'severus', catalogId: 'axe:5:common', price: 90, listedAgoMs: 9 * HOUR },
  { key: 'lucilla-boots', seller: 'lucilla', catalogId: 'heavy-boots:10:uncommon', price: 240, listedAgoMs: 2 * DAY },
  { key: 'varro-armor', seller: 'varro', catalogId: 'light-armor:1:rare', price: 35, listedAgoMs: 4 * DAY },
  // Two hours left before it expires.
  { key: 'cassia-bow', seller: 'cassia', catalogId: 'bow:10:common', price: 1_250, listedAgoMs: LISTING_MS - 2 * HOUR },
];

function offerOf({ key, seller, catalogId, price, listedAgoMs }: (typeof OFFERS)[number]): MarketListing {
  const entry = CATALOG_V1.items[catalogId];
  if (!entry || entry.binding !== 'tradable') throw new Error(`Fixture offer ${key} must be tradable catalog equipment`);
  const listedAtMs = NOW - listedAgoMs;
  return { listingId: fixtureUuid(`market-listing-${key}`), seller: { gladiatorId: ARENA_GLADIATORS[seller].id, name: ARENA_GLADIATORS[seller].name },
    item: { catalogId: entry.id, catalogVersion: CATALOG_V1.version, tier: entry.tier, rarity: entry.rarity, stats: structuredClone(entry.stats), quantity: 1 },
    price, listedAtMs, expiresAtMs: listedAtMs + LISTING_MS };
}

/** Newest listing first, then by listing id: the order of the live read. */
const newestFirst = (a: MarketListing, b: MarketListing) => b.listedAtMs - a.listedAtMs || (a.listingId < b.listingId ? -1 : 1);

/** Every fixture offer, in the live read's order. */
export const MARKET_ROWS: readonly MarketListing[] = OFFERS.map(offerOf).sort(newestFirst);

/**
 * Pages of `size` offers with the live read's cursor: a full page names its last row as `listedAtMs:listingId` (a page cannot
 * tell whether another follows, so an exact multiple ends with an empty page).
 */
export function marketPages(rows: readonly MarketListing[], size = MARKET_PAGE): MarketPage[] {
  const pages: MarketPage[] = [];
  for (let at = 0; ; at += size) {
    const page = rows.slice(at, at + size), last = page.at(-1);
    pages.push({ rows: page, nextCursor: last && page.length === size ? `${last.listedAtMs}:${last.listingId}` : null });
    if (page.length < size) return pages;
  }
}

/** The fixture gateway's `market()` pages: one, since the fixtures hold fewer than 50 offers. */
export const FIXTURE_MARKET: MarketPage[] = marketPages(MARKET_ROWS);
