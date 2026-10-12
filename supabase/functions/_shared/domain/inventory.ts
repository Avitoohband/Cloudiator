import type { ItemInstance } from '../contracts/reads.ts';
import type { ItemStats } from '../contracts/events.ts';
import type { Catalog, CatalogItem } from './types.ts';
import { RULES_V1 } from './rules-v1.ts';
import { CATALOG_V1 } from './catalog-v1.ts';

/** Where a granted item comes from. Starter items are created only by character creation. */
export type GrantOrigin = 'shop' | 'expedition' | 'renown';
/** One reward or purchase to place in an inventory: an equipment variant (one slot per unit) or salvage units. */
export type LootGrant = { catalogId: string; catalogVersion: string; quantity: number; origin: GrantOrigin };
/** A new inventory slot. The database assigns its ID and owner; stats are copied immutable catalog rolls. */
export type PlannedItem = Omit<ItemInstance, 'id' | 'ownerId' | 'reservation'>;
/** Units added to an existing, owned salvage stack. */
export type SalvageStackAddition = { itemId: string; quantity: number };
/** Expedition units that did not fit, converted at NPC sell value and reported. */
export type OverflowConversion = { catalogId: string; quantity: number; unitValue: number; money: number };
/**
 * Retained slots, stacked salvage and overflow money are distinct. `rejected` holds shop and renown units that do not fit:
 * they never convert to money, so a purchase with any rejected unit must be refused as a whole.
 */
export type InventoryGrantPlan = {
  retained: PlannedItem[]; stacked: SalvageStackAddition[]; overflow: OverflowConversion[];
  overflowMoney: number; rejected: LootGrant[]; slotsUsed: number;
};
export type Progression = { level: number; xp: number };
export type Merchant = 'weaponsmith' | 'armorer';
export type ShopOffer = { catalogId: string; catalogVersion: string; currency: 'money' | 'renown'; unitPrice: number; requiredLevel: 1 | 5 | 10; merchant: Merchant };
/** The immutable fields the historical score reads; any ItemInstance satisfies it. */
export type ScoredItem = Pick<ItemInstance, 'catalogId' | 'catalogVersion' | 'stats' | 'origin'>;

const ORIGINS: readonly GrantOrigin[] = ['shop', 'expedition', 'renown'];
const safeProduct = (a: number, b: number) => {
  const value = a * b;
  if (!Number.isSafeInteger(value)) throw new RangeError('Inventory value exceeds the safe integer range');
  return value;
};
const entryFor = (catalog: Catalog, catalogId: string): CatalogItem | null =>
  typeof catalogId === 'string' && Object.hasOwn(catalog.items, catalogId) ? catalog.items[catalogId] : null;

function validGrant(grant: LootGrant, catalog: Catalog): CatalogItem | 'salvage' {
  if (!grant || typeof grant !== 'object' || grant.catalogVersion !== catalog.version || !ORIGINS.includes(grant.origin)
    || !Number.isSafeInteger(grant.quantity) || grant.quantity < 1) throw new RangeError('Invalid inventory grant');
  if (grant.catalogId === catalog.salvage.id) {
    if (grant.origin !== 'expedition') throw new RangeError('Salvage comes only from expeditions');
    return 'salvage';
  }
  const entry = entryFor(catalog, grant.catalogId);
  if (!entry) throw new RangeError('Unknown catalog item');
  const consistent = grant.origin === 'renown' ? entry.renownPrice !== null
    : grant.origin === 'shop' ? entry.moneyPrice !== null : entry.renownPrice === null;
  if (!consistent) throw new RangeError('Grant origin does not match the catalog variant');
  return entry;
}

/**
 * Plans placing rewards or purchases into an inventory of `capacity` slots, every owned item (equipped, reserved, listed,
 * salvage stack) occupying one. Salvage first tops up partial stacks in item-ID order, then opens slots of at most the
 * stack limit. Expedition units that do not fit convert to money at NPC sell value; shop and renown units are rejected.
 */
export function planInventoryGrant(inventory: readonly ItemInstance[], rewards: readonly LootGrant[], catalog: Catalog): InventoryGrantPlan {
  if (!Array.isArray(inventory) || !Array.isArray(rewards)) throw new RangeError('Invalid inventory grant input');
  const stackLimit = catalog.salvage.stackLimit;
  let free = Math.max(0, RULES_V1.inventory.capacity - inventory.length);
  const partial = inventory.filter(item => item.catalogId === catalog.salvage.id && item.catalogVersion === catalog.version && item.quantity < stackLimit)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(item => ({ itemId: item.id, room: stackLimit - item.quantity }));
  const added = new Map<string, number>();
  const plan: InventoryGrantPlan = { retained: [], stacked: [], overflow: [], overflowMoney: 0, rejected: [], slotsUsed: 0 };
  const convert = (catalogId: string, quantity: number, unitValue: number) => {
    const money = safeProduct(quantity, unitValue);
    plan.overflow.push({ catalogId, quantity, unitValue, money });
    plan.overflowMoney += money;
    if (!Number.isSafeInteger(plan.overflowMoney)) throw new RangeError('Overflow money exceeds the safe integer range');
  };
  for (const grant of rewards) {
    const entry = validGrant(grant, catalog);
    if (entry === 'salvage') {
      let remaining = grant.quantity;
      for (const stack of partial) {
        const take = Math.min(stack.room, remaining);
        if (take === 0) continue;
        stack.room -= take; remaining -= take;
        added.set(stack.itemId, (added.get(stack.itemId) ?? 0) + take);
      }
      for (const stack of plan.retained) {
        if (stack.catalogId !== catalog.salvage.id || remaining === 0) continue;
        const take = Math.min(stackLimit - stack.quantity, remaining);
        stack.quantity += take; remaining -= take;
      }
      while (remaining > 0 && free > 0) {
        const quantity = Math.min(stackLimit, remaining), material = catalog.salvage;
        plan.retained.push({ catalogId: material.id, catalogVersion: catalog.version, tier: material.tier, rarity: material.rarity,
          stats: structuredClone(material.stats) as ItemStats, quantity, origin: 'expedition', binding: material.binding });
        free -= 1; remaining -= quantity;
      }
      if (remaining > 0) convert(catalog.salvage.id, remaining, catalog.salvage.npcSellValue);
      continue;
    }
    const fit = Math.min(free, grant.quantity);
    for (let i = 0; i < fit; i++) {
      plan.retained.push({ catalogId: entry.id, catalogVersion: catalog.version, tier: entry.tier, rarity: entry.rarity,
        stats: structuredClone(entry.stats) as ItemStats, quantity: 1, origin: grant.origin, binding: entry.binding });
    }
    free -= fit;
    const rest = grant.quantity - fit;
    if (rest === 0) continue;
    if (grant.origin === 'expedition') convert(entry.id, rest, entry.npcSellValue!);
    else plan.rejected.push({ ...grant, quantity: rest });
  }
  plan.stacked = [...added].map(([itemId, quantity]) => ({ itemId, quantity }));
  plan.slotsUsed = inventory.length + plan.retained.length;
  return plan;
}

/** Spends `100 × current level` XP per level-up, repeatedly. Levels grant no attribute points and no stamina. */
export function applyXp(level: number, xp: number, award: number): Progression {
  const maximum = RULES_V1.attributes.maximumLevel;
  if (!Number.isSafeInteger(level) || level < 1 || level > maximum || !Number.isSafeInteger(xp) || xp < 0
    || !Number.isSafeInteger(award) || award < 0) throw new RangeError('Invalid progression input');
  let remaining = xp + award;
  if (!Number.isSafeInteger(remaining)) throw new RangeError('XP exceeds the safe integer range');
  let next = level;
  while (next < maximum) {
    const cost = RULES_V1.progression.xpPerCurrentLevel * next;
    if (remaining < cost) break;
    remaining -= cost; next += 1;
  }
  return { level: next, xp: remaining };
}

/**
 * Highest legal-loadout score of `items`, retained against `previousMax` so it never decreases. The spec's score is
 * `4 × weapon damage × (1000 / interval) + 2 × total armor` from immutable item stats, one item per slot, with a
 * two-handed weapon excluding the off-hand. Renown gear counts its arena modifier (weapon damage and armor × 1.1).
 * Salvage and unknown entries do not score. The result is kept to two decimals, rounded down.
 */
export function historicalGearScore(items: readonly ScoredItem[], previousMax: number): number {
  if (!Array.isArray(items) || !Number.isFinite(previousMax) || previousMax < 0) throw new RangeError('Invalid historical gear input');
  const best = { oneHand: 0, twoHand: 0, offHand: 0, head: 0, body: 0, feet: 0 };
  const { gearDamageWeight, gearArmorWeight } = RULES_V1.leagues;
  for (const item of items) {
    if (item.catalogVersion !== CATALOG_V1.version) continue;
    const entry = entryFor(CATALOG_V1, item.catalogId);
    if (!entry) continue;
    const { damage, armor, intervalMs } = item.stats;
    if (![damage, armor, intervalMs].every(value => Number.isFinite(value) && value >= 0)) throw new RangeError('Invalid item stats');
    const arena = item.origin === 'renown' ? RULES_V1.shops.renownArenaMultiplier : 1;
    if (entry.slot === 'weapon') {
      if (intervalMs <= 0) continue;
      const term = gearDamageWeight * damage * arena * 1000 / intervalMs;
      const hand = entry.hands === 2 ? 'twoHand' : 'oneHand';
      best[hand] = Math.max(best[hand], term);
    } else {
      best[entry.slot] = Math.max(best[entry.slot], gearArmorWeight * armor * arena);
    }
  }
  const score = Math.max(best.oneHand + best.offHand, best.twoHand) + best.head + best.body + best.feet;
  // The epsilon absorbs binary representation error (24.000000000000004) without turning 22.857 into 22.86.
  return Math.max(previousMax, Math.floor(score * 100 + 1e-7) / 100);
}

/** The NPC merchant offer for a catalog variant: Common variants for money, renown variants for renown, else none. */
export function shopOffer(catalogId: string, catalog: Catalog): ShopOffer | null {
  const entry = entryFor(catalog, catalogId);
  if (!entry) return null;
  const merchant: Merchant = entry.slot === 'weapon' ? 'weaponsmith' : 'armorer';
  const base = { catalogId: entry.id, catalogVersion: catalog.version, requiredLevel: entry.tier, merchant };
  if (entry.moneyPrice !== null) return { ...base, currency: 'money', unitPrice: entry.moneyPrice };
  if (entry.renownPrice !== null) return { ...base, currency: 'renown', unitPrice: entry.renownPrice };
  return null;
}

/** Every merchant offer in catalog order. */
export function shopOffers(catalog: Catalog): ShopOffer[] {
  return Object.keys(catalog.items).map(id => shopOffer(id, catalog)).filter((offer): offer is ShopOffer => offer !== null);
}

/** Money an NPC pays per unit, or null: NPCs never buy bound or renown-origin gear, or anything outside this catalog. */
export function npcSaleValue(item: Pick<ItemInstance, 'catalogId' | 'catalogVersion' | 'tier' | 'rarity' | 'origin' | 'binding'>, catalog: Catalog): number | null {
  if (item.catalogVersion !== catalog.version || item.binding !== 'tradable' || item.origin === 'renown') return null;
  if (item.catalogId === catalog.salvage.id) return catalog.salvage.npcSellValue;
  const entry = entryFor(catalog, item.catalogId);
  if (!entry || entry.tier !== item.tier || entry.rarity !== item.rarity) return null;
  return entry.npcSellValue;
}
