// Words and sums for the 💰 Marketplace menu (Task 18 plan Decisions 2, 9 and 11): the sale fee and what a seller receives,
// how long a listing has left, an offer's item in words, which items a seller can list, and what each refusal means. The
// database decides every trade; these only explain it. Names render as React text where they are used.
import type { ApiErrorCode, GameCommand } from '@contracts/commands';
import type { ItemInstance, MarketListing, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';

/**
 * The sale fee, a whole percent of the price kept from the seller's credit (spec §9: 5%, rounded down), from the rules'
 * `fees.marketRate` (0.05). As a whole percent, the fee is exact integer math, as the database's bigint `price*5/100` is.
 */
export const MARKET_FEE_PERCENT = Math.round(RULES_V1.fees.marketRate * 100);
/** The least a sale pays, from the rules' `fees.marketMinimum` (launch feedback: 1; a sale at 11 paid no fee, 5% floored to 0). */
export const MARKET_MINIMUM_FEE = RULES_V1.fees.marketMinimum;
/** The fee's rule in the words of its label: "5%, at least 1". */
export const MARKET_FEE_TERMS = `${MARKET_FEE_PERCENT}%, at least ${MARKET_MINIMUM_FEE}`;
/** Whole prices from 2 (launch feedback: the seller always receives something after the fee) to 1,000,000,000 (plan Decision 2). */
export const MINIMUM_PRICE = RULES_V1.marketplace.minimumPrice;
export const MAXIMUM_PRICE = RULES_V1.marketplace.maximumPrice;
/** Active listings per seller (spec §9). */
export const MAXIMUM_LISTINGS = RULES_V1.marketplace.maximumListings;

export type MarketKind = Extract<GameCommand['kind'], 'create-listing' | 'cancel-listing' | 'buy-listing'>;

/**
 * The fee kept from a sale at `price`: 5% rounded down but at least the minimum fee, as the database computes it
 * (`greatest(1, price * 5 / 100)` in bigint).
 */
export const marketFee = (price: number): number => Math.max(MARKET_MINIMUM_FEE, Math.floor((price * MARKET_FEE_PERCENT) / 100));
/** What the seller is credited when a listing at `price` sells. */
export const sellerReceives = (price: number): number => price - marketFee(price);
/** Whether `price` is a whole price the market accepts. */
export const validPrice = (price: number): boolean => Number.isSafeInteger(price) && price >= MINIMUM_PRICE && price <= MAXIMUM_PRICE;

/** An amount with thousands separators: "1,250". */
export const amount = (value: number): string => value.toLocaleString('en-US');
/** A money amount in words: "1,250 money". */
export const money = (value: number): string => `${amount(value)} money`;

/** The Sell form's hint under the price field: "A whole price from 2 to 1,000,000,000." */
export const PRICE_HINT = `A whole price from ${amount(MINIMUM_PRICE)} to ${amount(MAXIMUM_PRICE)}.`;
/** What the Sell form asks for when a typed price is fractional, too large or not a number. */
export const WHOLE_PRICE_TEXT = `Enter a whole price from ${amount(MINIMUM_PRICE)} to ${amount(MAXIMUM_PRICE)}.`;
/** What the Sell form says to a whole price under the lowest one (launch feedback). */
export const LOWEST_PRICE_TEXT = `The lowest price is ${money(MINIMUM_PRICE)}, so you always receive something after the fee.`;
/**
 * What is wrong with the price typed into the Sell form, or null while it is empty or valid: `low` for a whole price under
 * the lowest one (it says why), `whole` for anything else the market refuses (fractional, too large).
 */
export function priceProblem(typed: string): 'low' | 'whole' | null {
  if (typed.trim() === '') return null;
  const value = Number(typed);
  if (validPrice(value)) return null;
  return Number.isSafeInteger(value) && value < MINIMUM_PRICE ? 'low' : 'whole';
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/**
 * How long a listing has left, in its two largest whole units and never rounded up: "6 d 22 h left", "2 h 30 min left",
 * "45 min left", "Under a minute left", or "Expired" from its expiry time on.
 */
export function timeLeft(expiresAtMs: number, nowMs: number): string {
  const left = expiresAtMs - nowMs;
  if (!(left > 0)) return 'Expired';
  if (left < MINUTE) return 'Under a minute left';
  const days = Math.floor(left / DAY), hours = Math.floor((left % DAY) / HOUR), minutes = Math.floor((left % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${days} d ${hours} h left` : `${days} d left`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min left` : `${hours} h left`;
  return `${minutes} min left`;
}

type OfferItem = MarketListing['item'];
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The item's catalog name ("Iron helmet"), or its id for an entry this build does not know. */
export const itemName = (item: Pick<OfferItem, 'catalogId'>): string =>
  item.catalogId === CATALOG_V1.salvage.id ? CATALOG_V1.salvage.name : CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId;
/** Tier and rarity: "Level 5 · Uncommon". */
export const itemGrade = (item: Pick<OfferItem, 'tier' | 'rarity'>): string => `Level ${item.tier} · ${capital(item.rarity)}`;
/** The item's combat stats that it has, and its weight: "Damage 18.2 · Weight 6", "Armor 5.18 · Weight 4". */
export function itemStats(item: Pick<OfferItem, 'stats'>): string {
  const { damage, armor, weight } = item.stats;
  return [damage > 0 ? `Damage ${damage}` : null, armor > 0 ? `Armor ${armor}` : null, `Weight ${weight}`].filter(Boolean).join(' · ');
}
/**
 * An offer's item with its quantity when it is a stack ("12 × Salvage", as Inventory counts one), or its name alone. The
 * database accepts a salvage stack, though the Sell tab offers equipment only, so Browse can show one.
 */
export const offerName = (item: Pick<OfferItem, 'catalogId' | 'quantity'>): string =>
  item.quantity > 1 ? `${amount(item.quantity)} × ${itemName(item)}` : itemName(item);
/** The item's slot icon (decorative), or a neutral one for anything that is not equipment (salvage). */
export function itemIcon(item: Pick<OfferItem, 'catalogId'>): string {
  const slot = CATALOG_V1.items[item.catalogId]?.slot;
  return slot === 'offHand' ? '🛡' : slot === 'head' ? '⛑' : slot === 'body' ? '🥋' : slot === 'feet' ? '🥾' : slot === 'weapon' ? '🗡' : '📦';
}
/** What an NPC merchant pays for one unit of this catalog variant (salvage too), or null when NPCs do not buy it. */
function npcUnitValue(item: Pick<OfferItem, 'catalogId' | 'catalogVersion' | 'tier' | 'rarity'>): number | null {
  if (item.catalogVersion !== CATALOG_V1.version) return null;
  if (item.catalogId === CATALOG_V1.salvage.id) return CATALOG_V1.salvage.npcSellValue;
  const entry = CATALOG_V1.items[item.catalogId];
  return entry && entry.tier === item.tier && entry.rarity === item.rarity ? entry.npcSellValue : null;
}
/** What an NPC merchant pays for the whole offer (per unit times quantity), for comparison (spec §9), or null when NPCs do not buy it. */
export function npcValue(item: Pick<OfferItem, 'catalogId' | 'catalogVersion' | 'tier' | 'rarity' | 'quantity'>): number | null {
  const unit = npcUnitValue(item);
  return unit === null ? null : unit * item.quantity;
}
export const npcValueText = (item: Parameters<typeof npcValue>[0]): string => {
  const value = npcValue(item);
  return value === null ? 'NPC merchants do not buy this item'
    : `NPC sale value: ${money(value)}${item.quantity > 1 ? ` (${amount(value / item.quantity)} each)` : ''}`;
};

/**
 * The items `owner` can list (controller ruling: equipment only, never salvage): tradable catalog equipment of this catalog
 * version that is not renown gear, account-bound, equipped, held by the pending build, or reserved (by equipment, a pending
 * build or another listing). The database checks the same again; this only decides what the Sell tab offers.
 */
export function listableItems(owner: OwnerState): ItemInstance[] {
  const held = new Set<string>(Object.values(owner.currentBuild.equipment).filter((id): id is string => id !== null));
  if (owner.pendingBuild) {
    for (const id of Object.values(owner.pendingBuild.build.equipment)) if (id !== null) held.add(id);
    for (const id of owner.pendingBuild.reservedItemIds) held.add(id);
  }
  return owner.inventory.filter(item => item.catalogId !== CATALOG_V1.salvage.id && CATALOG_V1.items[item.catalogId] !== undefined
    && item.catalogVersion === CATALOG_V1.version && item.binding === 'tradable' && item.origin !== 'renown' && item.quantity === 1
    && item.reservation === null && !held.has(item.id));
}

/** The seller's active listings, as their inventory holds them: items reserved by a listing. */
export const activeListings = (owner: OwnerState): number => owner.inventory.filter(item => item.reservation?.kind === 'listing').length;

/** Refusals that mean the page was stale: the listing is closed, so the panel refreshes it (Review Focus 4). */
export const STALE_CODES: readonly ApiErrorCode[] = ['sold', 'expired', 'not-found'];
/**
 * Refusals that leave the same request worth sending again, with the same operation id (the Task 18.2 review's item
 * carried to 18.3: keep the same operationId on `processing`).
 */
export const RETRY_CODES: readonly ApiErrorCode[] = ['processing', 'unavailable', 'rate-limited'];

/** What a refused market command means, in a sentence or two (plan Decision 9). */
export function marketErrorText(code: ApiErrorCode, kind: MarketKind): string {
  switch (code) {
    case 'processing': return 'The world is processing previous results. Retry shortly.';
    case 'unavailable': return 'This request could not be confirmed. Retry the same request.';
    case 'rate-limited': return 'Too many requests right now. Wait a moment, then retry the same request.';
    case 'unauthenticated': return 'Your session has ended. Sign in again to trade.';
    case 'insufficient-funds': return 'Not enough available money for this purchase. Held fees cannot be spent.';
    case 'inventory-full': return 'Your inventory is full. Clear a slot, then try again.';
    case 'sold': return 'This listing was already sold. The listings have been refreshed.';
    case 'expired': return 'This listing has expired. The listings have been refreshed.';
    // A create's `not-found` is its item, gone from the seller's inventory; a cancel's or a buy's is the listing.
    case 'not-found': return kind === 'create-listing'
      ? 'That item is no longer in your inventory. Your inventory has been refreshed.'
      : 'This listing is no longer open. The listings have been refreshed.';
    case 'conflict': return 'Your inventory changed while this was sent. Review the refreshed state, then try again.';
    case 'invalid': return kind === 'create-listing'
      ? `This item cannot be listed at that price. Only free, tradable equipment can be listed, at a whole price of at least ${money(MINIMUM_PRICE)}, with at most ${MAXIMUM_LISTINGS} active listings.`
      : kind === 'buy-listing' ? 'You cannot buy this listing.' : 'This listing cannot be cancelled.';
  }
}
