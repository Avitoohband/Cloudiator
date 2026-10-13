'use client';

import { useState } from 'react';
import type { OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { shopOffers, type Merchant } from '@domain/inventory';

export function ShopPanel({ owner, busy, preview, buy }: {
  owner: OwnerState; busy: boolean; preview: boolean; buy(catalogId: string, quantity: number): void;
}) {
  const [merchant, setMerchant] = useState<Merchant>('weaponsmith');
  const [currency, setCurrency] = useState<'money' | 'renown'>('money');
  const [tier, setTier] = useState(1), [quantity, setQuantity] = useState(1);
  const validQuantity = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 60;
  const available = owner.wallets[currency] - owner.reservedFees[currency];
  const full = owner.inventory.length + quantity > owner.inventoryCapacity;
  const banner = CATALOG_V1.cosmetics.banner;
  const ownsBanner = owner.ownedCosmetics.some(item => item.catalogId === banner.id);
  return <section aria-labelledby="shops-heading" className="shops-panel">
    <h2 id="shops-heading">Shops</h2>
    <div className="shop-merchants" aria-label="Merchants">
      <button aria-pressed={merchant === 'weaponsmith'} onClick={() => setMerchant('weaponsmith')}>Weaponsmith</button>
      <button aria-pressed={merchant === 'armorer'} onClick={() => setMerchant('armorer')}>Armorer</button>
    </div>
    <div className="shop-filters">
      <label>Shop currency<select value={currency} onChange={e => setCurrency(e.target.value as typeof currency)}><option value="money">Money</option><option value="renown">Renown</option></select></label>
      <label>Shop tier<select value={tier} onChange={e => setTier(Number(e.target.value))}>{[1, 5, 10].map(level => <option key={level} value={level}>Level {level}</option>)}</select></label>
      <label>Purchase quantity<input type="number" min="1" max="60" step="1" value={quantity || ''} onChange={e => setQuantity(Number(e.target.value))} /></label>
    </div>
    <p>{currency === 'renown' ? 'Account-bound gear. +10% weapon damage or armor in Arena and tournaments; no expedition bonus.' : 'Common equipment. NPC sell value is shown for comparison.'}</p>
    {!validQuantity && <p role="status">Choose a whole quantity from 1 to 60.</p>}
    {full && <p role="status">Inventory full for this purchase. Clear enough slots first.</p>}
    <div className="inventory-grid">{shopOffers(CATALOG_V1).filter(offer => offer.merchant === merchant && offer.currency === currency && offer.requiredLevel === tier).map(offer => {
      const entry = CATALOG_V1.items[offer.catalogId], total = offer.unitPrice * quantity;
      const levelLocked = owner.progression.level < offer.requiredLevel;
      const poor = total > available;
      return <article className="inventory-item" key={offer.catalogId} data-testid={`offer-${offer.catalogId}`}>
        <h3>{entry.name}</h3><p>Level {entry.tier} · {entry.hands === 2 ? 'Two hands' : entry.slot}</p>
        <p>Damage {entry.stats.damage} · Armor {entry.stats.armor} · Weight {entry.stats.weight}</p>
        <p>{offer.unitPrice} {currency} each{quantity > 1 && ` · ${total} total`}</p>
        <p>{entry.npcSellValue === null ? 'Account-bound · Cannot sell' : `NPC sell value: ${entry.npcSellValue} money`}</p>
        {levelLocked && <p>Requires level {entry.tier}</p>}{poor && <p>Not enough available {currency}</p>}
        <button disabled={busy || !validQuantity || (!preview && (levelLocked || full || poor))} onClick={() => buy(offer.catalogId, quantity)}>Buy {entry.name}</button>
      </article>;
    })}</div>
    {merchant === 'armorer' && <article className="inventory-item cosmetic-offer">
      <h3>{banner.name}</h3><p>Cosmetic · Account-bound · No inventory slot or combat bonus</p><p>{banner.renownPrice} renown</p>
      {ownsBanner ? <p>Arena banner · Owned · Account-bound</p> : <button disabled={busy || (!preview && owner.wallets.renown - owner.reservedFees.renown < banner.renownPrice)} onClick={() => buy(banner.id, 1)}>Buy Arena banner</button>}
    </article>}
  </section>;
}
