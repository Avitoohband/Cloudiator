'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { shopOffers, type Merchant } from '@domain/inventory';

/**
 * The weapon smith's and the armorer's shops. `initialMerchant` opens that merchant's tab and brings the shops into view in
 * their scrolling menu (a click on the merchant in the camp, Task 13.7); without it the weapon smith's tab shows.
 */
export function ShopPanel({ owner, busy, preview, buy, initialMerchant }: {
  owner: OwnerState; busy: boolean; preview: boolean; buy(catalogId: string, quantity: number): void; initialMerchant?: Merchant;
}) {
  const [merchant, setMerchant] = useState<Merchant>(initialMerchant ?? 'weaponsmith');
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (initialMerchant) scrollToTop(section.current); }, [initialMerchant]);
  const [currency, setCurrency] = useState<'money' | 'renown'>('money');
  const [tier, setTier] = useState(1), [quantity, setQuantity] = useState(1);
  const validQuantity = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 60;
  const available = owner.wallets[currency] - owner.reservedFees[currency];
  const full = owner.inventory.length + quantity > owner.inventoryCapacity;
  const banner = CATALOG_V1.cosmetics.banner;
  const ownsBanner = owner.ownedCosmetics.some(item => item.catalogId === banner.id);
  // Each message names what it explains (Task 23.5): the quantity field and the Buy buttons are described by it.
  const ids = useId();
  const quantityId = `${ids}-quantity`, fullId = `${ids}-full`;
  const shared = [!validQuantity && quantityId, full && fullId].filter(Boolean).join(' ');
  return <section ref={section} aria-labelledby="shops-heading" className="shops-panel">
    <h2 id="shops-heading">Shops</h2>
    <div className="shop-merchants" aria-label="Merchants">
      <button aria-pressed={merchant === 'weaponsmith'} onClick={() => setMerchant('weaponsmith')}>Weaponsmith</button>
      <button aria-pressed={merchant === 'armorer'} onClick={() => setMerchant('armorer')}>Armorer</button>
    </div>
    <div className="shop-filters">
      <label>Shop currency<select value={currency} onChange={e => setCurrency(e.target.value as typeof currency)}><option value="money">Money</option><option value="renown">Renown</option></select></label>
      <label>Shop tier<select value={tier} onChange={e => setTier(Number(e.target.value))}>{[1, 5, 10].map(level => <option key={level} value={level}>Level {level}</option>)}</select></label>
      <label>Purchase quantity<input type="number" min="1" max="60" step="1" value={quantity || ''} onChange={e => setQuantity(Number(e.target.value))}
        aria-invalid={!validQuantity || full ? true : undefined} aria-describedby={shared || undefined} /></label>
    </div>
    <p>{currency === 'renown' ? 'Account-bound gear. +10% weapon damage or armor in Arena and tournaments; no expedition bonus.' : 'Common equipment. NPC sell value is shown for comparison.'}</p>
    {!validQuantity && <p id={quantityId} role="status">Choose a whole quantity from 1 to 60.</p>}
    {full && <p id={fullId} role="status">Inventory full for this purchase. Clear enough slots first.</p>}
    <div className="inventory-grid">{shopOffers(CATALOG_V1).filter(offer => offer.merchant === merchant && offer.currency === currency && offer.requiredLevel === tier).map(offer => {
      const entry = CATALOG_V1.items[offer.catalogId], total = offer.unitPrice * quantity;
      const levelLocked = owner.progression.level < offer.requiredLevel;
      const poor = total > available;
      const levelId = `${ids}-${offer.catalogId}-level`, moneyId = `${ids}-${offer.catalogId}-money`;
      const described = [shared, levelLocked && levelId, poor && moneyId].filter(Boolean).join(' ');
      return <article className="inventory-item" key={offer.catalogId} data-testid={`offer-${offer.catalogId}`}>
        <h3>{entry.name}</h3><p>Level {entry.tier} · {entry.hands === 2 ? 'Two hands' : entry.slot}</p>
        <p>Damage {entry.stats.damage} · Armor {entry.stats.armor} · Weight {entry.stats.weight}</p>
        <p>{offer.unitPrice} {currency} each{quantity > 1 && ` · ${total} total`}</p>
        <p>{entry.npcSellValue === null ? 'Account-bound · Cannot sell' : `NPC sell value: ${entry.npcSellValue} money`}</p>
        {levelLocked && <p id={levelId}>Requires level {entry.tier}</p>}{poor && <p id={moneyId}>Not enough available {currency}</p>}
        <button disabled={busy || !validQuantity || (!preview && (levelLocked || full || poor))} aria-describedby={described || undefined} onClick={() => buy(offer.catalogId, quantity)}>Buy {entry.name}</button>
      </article>;
    })}</div>
    {merchant === 'armorer' && <article className="inventory-item cosmetic-offer">
      <h3>{banner.name}</h3><p>Cosmetic · Account-bound · No inventory slot or combat bonus</p><p>{banner.renownPrice} renown</p>
      {ownsBanner ? <p>Arena banner · Owned · Account-bound</p> : <button disabled={busy || (!preview && owner.wallets.renown - owner.reservedFees.renown < banner.renownPrice)} onClick={() => buy(banner.id, 1)}>Buy Arena banner</button>}
    </article>}
  </section>;
}

/** Scrolls the nearest scrolling ancestor (the menu's body) so `element` starts at its top; the page itself never moves. */
function scrollToTop(element: HTMLElement | null) {
  for (let parent = element?.parentElement; element && parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      parent.scrollTop += element.getBoundingClientRect().top - parent.getBoundingClientRect().top;
      return;
    }
  }
}
