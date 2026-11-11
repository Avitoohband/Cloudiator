'use client';

import { useId } from 'react';
import type { OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { ShopOffer } from '@domain/inventory';
import { SLOT_LABELS } from '../inventory/gear';
import { ItemIcon, ItemStats } from '../inventory/ItemPresentation';
import inventory from '../inventory/InventoryPanel.module.css';
import { BannerArt, CurrencyIcon } from './ShopArt';
import { BANNER, MERCHANT_NAMES, currencyWord, type ShopCurrency } from './shop-offers';
import styles from './ShopPanel.module.css';

/** What a shop card needs to sell: the owner's wallet and bag, and the panel's command state. */
export type ShopPurchase = { owner: OwnerState; busy: boolean; preview: boolean; buy(catalogId: string, quantity: number): void };

/** What the owner can spend: the wallet minus the fees held for queued commands. */
export const spendable = (owner: OwnerState, currency: ShopCurrency) => owner.wallets[currency] - owner.reservedFees[currency];

/**
 * The chosen offer in the inventory's detail card: its stats, merchant, price, NPC value, the quantity and Buy. Buy follows
 * today's rules: a whole quantity from 1 to 60, room in the inventory, the level and the spendable currency (a preview
 * enables it and says so when pressed); while a command is sent it stays focusable, aria-disabled.
 */
export function OfferCard({ offer, quantity, setQuantity, owner, busy, preview, buy }: ShopPurchase & {
  offer: ShopOffer; quantity: number; setQuantity(value: number): void;
}) {
  const entry = CATALOG_V1.items[offer.catalogId], word = currencyWord(offer.currency);
  const validQuantity = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 60;
  const full = owner.inventory.length + quantity > owner.inventoryCapacity;
  const total = offer.unitPrice * quantity;
  const levelLocked = owner.progression.level < offer.requiredLevel;
  const poor = total > spendable(owner, offer.currency);
  // Each message names what it explains (Task 23.5): the quantity field and Buy are described by it.
  const ids = useId();
  const quantityId = `${ids}-quantity`, fullId = `${ids}-full`, levelId = `${ids}-level`, moneyId = `${ids}-money`;
  const shared = [!validQuantity && quantityId, full && fullId].filter(Boolean).join(' ');
  const described = [shared, levelLocked && levelId, poor && moneyId].filter(Boolean).join(' ');
  return <article className={inventory.card} data-rarity={entry.rarity}>
    <div className={inventory.cardHead}>
      <ItemIcon catalogId={offer.catalogId} size={48} />
      <div><h3>{entry.name}</h3><p>Level {entry.tier} · {entry.rarity} · {entry.binding === 'bound' ? 'Account-bound' : 'Tradable'}</p></div>
    </div>
    <ItemStats item={{ catalogId: offer.catalogId, stats: entry.stats }} />
    <p>{SLOT_LABELS[entry.slot]} · sold by the {MERCHANT_NAMES[offer.merchant]}</p>
    <p className={styles.priceLine}><CurrencyIcon currency={offer.currency} size={16} />{offer.unitPrice} {word} each{quantity > 1 && ` · ${total} total`}</p>
    <p>{entry.npcSellValue === null ? 'Account-bound · Cannot sell' : `NPC sell value: ${entry.npcSellValue} gold each`}</p>
    {levelLocked && <p id={levelId} className={styles.warn}>Requires level {entry.tier}</p>}
    {poor && <p id={moneyId} className={styles.warn}>Not enough available {word}</p>}
    <label>Purchase quantity<input type="number" min="1" max="60" step="1" value={quantity || ''} onChange={event => setQuantity(Number(event.target.value))}
      aria-invalid={!validQuantity || full ? true : undefined} aria-describedby={shared || undefined} /></label>
    {!validQuantity && <p id={quantityId} role="status">Choose a whole quantity from 1 to 60.</p>}
    {full && <p id={fullId} role="status">Inventory full for this purchase. Clear enough slots first.</p>}
    <div className={`item-actions ${inventory.actions}`}>
      <button type="button" className={styles.buy} disabled={!validQuantity || (!preview && (levelLocked || full || poor))} aria-disabled={busy || undefined}
        aria-describedby={described || undefined} onClick={() => { if (!busy) buy(offer.catalogId, quantity); }}>Buy {entry.name}</button>
    </div>
  </article>;
}

/** The Arena banner's card (Patch 1.6, spec "The Arena banner"): it shows on the owner's profile card, and the shop says so. */
export function BannerCard({ owner, busy, preview, buy }: ShopPurchase) {
  const owned = owner.ownedCosmetics.some(item => item.catalogId === BANNER.id);
  const poor = spendable(owner, 'renown') < BANNER.renownPrice;
  const moneyId = `${useId()}-money`;
  return <article className={inventory.card}>
    <div className={inventory.cardHead}>
      <BannerArt size={48} />
      <div><h3>{BANNER.name}</h3><p>Sold by the {MERCHANT_NAMES.armorer}</p></div>
    </div>
    <p>Cosmetic · Account-bound · Shown on your profile card · No inventory slot or combat bonus</p>
    <p className={styles.priceLine}><CurrencyIcon currency="renown" size={16} />{BANNER.renownPrice} renown</p>
    {owned ? <p>{BANNER.name} · Owned · Shown on your profile card</p> : <>
      {poor && <p id={moneyId} className={styles.warn}>Not enough available renown</p>}
      <div className={`item-actions ${inventory.actions}`}>
        <button type="button" className={styles.buy} disabled={!preview && poor} aria-disabled={busy || undefined} aria-describedby={poor ? moneyId : undefined}
          onClick={() => { if (!busy) buy(BANNER.id, 1); }}>Buy Arena banner</button>
      </div>
    </>}
  </article>;
}
