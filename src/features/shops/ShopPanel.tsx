'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { Merchant } from '@domain/inventory';
import { ItemIcon } from '../inventory/ItemPresentation';
import inventory from '../inventory/InventoryPanel.module.css';
import { BannerArt, CurrencyIcon } from './ShopArt';
import { BannerCard, OfferCard, spendable } from './ShopCard';
import {
  BANNER, SHOP_FILTERS, counterpartId, currencyWord, merchantFilter, shopChoices, type ShopChoice, type ShopCurrency, type ShopFilter,
} from './shop-offers';
import styles from './ShopPanel.module.css';

const CURRENCIES = [['money', 'Gold'], ['renown', 'Renown']] as const;
const EXPLAINERS: Record<ShopCurrency, string> = {
  money: 'Common equipment. NPC sell value is shown for comparison.',
  renown: 'Account-bound gear. +10% weapon damage or armor in Arena and tournaments; no expedition bonus.',
};

/**
 * The weapon smith's and the armorer's shops as one icon grid (Patch 1.9, the approved shop-grid mockup): every level in
 * one grid by required level, filtered to All, Weapons or Armor, in gold or renown, and the chosen cell's card beside it
 * (below it on a phone). `initialMerchant` opens that merchant's filter and brings the shops into view in their scrolling
 * menu (a click on the merchant in the camp, Task 13.7). Cells are chosen by a click, a tap, or Enter or Space after the
 * arrow keys; a pointer passing over a cell changes nothing, so Buy always sends the card's offer.
 */
export function ShopPanel({ owner, busy, preview, buy, initialMerchant }: {
  owner: OwnerState; busy: boolean; preview: boolean; buy(catalogId: string, quantity: number): void; initialMerchant?: Merchant;
}) {
  const section = useRef<HTMLElement>(null), grid = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (initialMerchant) scrollToTop(section.current); }, [initialMerchant]);
  const [filter, setFilter] = useState<ShopFilter>(merchantFilter(initialMerchant));
  const [currency, setCurrency] = useState<ShopCurrency>('money');
  const [chosenId, setChosenId] = useState<string | null>(null);
  /** The cell the arrow keys last reached: the grid's one Tab stop while it is shown, else the chosen cell. */
  const [stopId, setStopId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const choices = shopChoices(filter, currency);
  // The first visible cell when nothing visible is chosen; remembered, so Buy never sends an offer the grid hides.
  const chosen: ShopChoice | undefined = choices.find(choice => choice.id === chosenId) ?? choices[0];
  if (chosen && chosenId !== chosen.id) setChosenId(chosen.id);
  const tabStop = choices.some(choice => choice.id === stopId) ? stopId : chosen?.id;
  // After a filter or currency change the chosen cell is brought into view inside the grid only (never the page or the menu).
  const latest = useRef(chosen?.id);
  latest.current = chosen?.id;
  useEffect(() => {
    const box = scroller.current, cell = box?.querySelector<HTMLElement>(`[data-testid="offer-${latest.current}"]`);
    if (!box || !cell) return;
    const top = cell.getBoundingClientRect().top - box.getBoundingClientRect().top, bottom = top + cell.offsetHeight - box.clientHeight;
    if (top < 0) box.scrollTop += top;
    else if (bottom > 0) box.scrollTop += bottom;
  }, [filter, currency]);
  const ids = useId(), detailsId = `${ids}-details`;
  const word = currencyWord(currency);

  /** A currency switch keeps the chosen piece when the other currency sells it (the same kind and level). */
  function switchCurrency(next: ShopCurrency) {
    if (next === currency) return;
    const counterpart = chosen ? counterpartId(chosen.id, next) : null;
    setCurrency(next);
    if (counterpart) setChosenId(counterpart);
  }
  /** The arrow keys move the focus a cell (left, right) or a row (up, down) at a time; Home and End go to the ends. */
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const cells = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>('[data-shop-cell]') ?? []);
    const index = cells.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const columns = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length : 1;
    const steps: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: cells.length - 1 };
    const next = steps[event.key];
    if (next === undefined) return;
    event.preventDefault();
    cells[next]?.focus();
  }
  function cell(choice: ShopChoice) {
    const offer = choice.kind === 'offer' ? choice.offer : null, entry = offer ? CATALOG_V1.items[offer.catalogId] : null;
    const price = offer ? offer.unitPrice : BANNER.renownPrice;
    const owned = !offer && owner.ownedCosmetics.some(item => item.catalogId === BANNER.id);
    const locked = !!offer && owner.progression.level < offer.requiredLevel;
    const poor = !locked && !owned && price > spendable(owner, currency);
    const name = entry ? [`${entry.name}, level ${entry.tier}`, entry.binding === 'bound' && 'account-bound', `${price} ${word}`]
      : [BANNER.name, 'cosmetic', `${price} ${word}`, owned && 'owned'];
    const description = locked && offer ? `Requires level ${offer.requiredLevel}` : poor ? `Not enough available ${word}` : undefined;
    return <button key={choice.id} type="button" className={`${inventory.tile} ${styles.cell}`} data-shop-cell="" data-testid={`offer-${choice.id}`}
      data-locked={locked ? '' : undefined} data-poor={poor ? '' : undefined}
      aria-label={name.filter(Boolean).join(', ')} aria-description={description} aria-controls={detailsId} aria-pressed={choice.id === chosen?.id}
      tabIndex={choice.id === tabStop ? 0 : -1} onFocus={() => setStopId(choice.id)} onClick={() => setChosenId(choice.id)}>
      {offer ? <ItemIcon catalogId={offer.catalogId} /> : <BannerArt />}
      {offer ? <span className={styles.level} data-shop-level="" aria-hidden="true">L{offer.requiredLevel}</span>
        : owned && <span className={styles.owned} aria-hidden="true">✓</span>}
      {locked && <span className={styles.lock} data-shop-lock="" aria-hidden="true">
        <svg width="10" height="11" viewBox="0 0 10 11"><rect x=".5" y="4.5" width="9" height="6" rx="1" fill="currentColor" /><path d="M2.5 4.5V3a2.5 2.5 0 0 1 5 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </span>}
      <span className={styles.price} data-shop-price="" aria-hidden="true"><CurrencyIcon currency={currency} size={10} />{price}</span>
    </button>;
  }
  const purchase = { owner, busy, preview, buy };
  return <section ref={section} aria-labelledby="shops-heading" className={`shops-panel ${styles.panel}`}>
    <div className={styles.top}>
      <h2 id="shops-heading">Shops</h2>
      <p className={styles.wallet}>
        <span><CurrencyIcon currency="money" size={14} /> Gold <b>{spendable(owner, 'money')}</b></span>
        <span><CurrencyIcon currency="renown" size={14} /> Renown <b>{spendable(owner, 'renown')}</b></span>
      </p>
    </div>
    <div className={inventory.columns}>
      <div>
        <div className={styles.bar}>
          <div className={inventory.filters} role="group" aria-label="Shop filters">
            {SHOP_FILTERS.map(option => <button key={option} type="button" aria-pressed={option === filter} onClick={() => setFilter(option)}>{option}</button>)}
          </div>
          <div className={inventory.filters} role="group" aria-label="Shop currency">
            {CURRENCIES.map(([value, label]) => <button key={value} type="button" aria-pressed={value === currency} onClick={() => switchCurrency(value)}>{label}</button>)}
          </div>
        </div>
        <div ref={scroller} className={`${inventory.gridScroll} ${styles.scroll}`} role="group" aria-label="Shop items" onKeyDown={move}>
          <div ref={grid} className={inventory.grid}>
            {choices.map(cell)}
            {Array.from({ length: Math.max(0, (filter === 'All' ? 30 : 6) - choices.length) }, (_, index) => <span key={index} className={inventory.emptyCell} aria-hidden="true" />)}
          </div>
        </div>
        <p className={`muted ${styles.foot}`}>{EXPLAINERS[currency]} L = level needed; pieces with a lock are above your level. {choices.length} items.</p>
      </div>
      <section id={detailsId} aria-label="Offer details" className={inventory.details}>
        {!chosen ? <p>Nothing here.</p> : chosen.kind === 'offer' ? <OfferCard offer={chosen.offer} quantity={quantity} setQuantity={setQuantity} {...purchase} /> : <BannerCard {...purchase} />}
      </section>
    </div>
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
