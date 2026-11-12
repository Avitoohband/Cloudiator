'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { BuyBackEntry, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { Merchant } from '@domain/inventory';
import type { DisplayClock } from '../../game/display-clock';
import { ItemIcon } from '../inventory/ItemPresentation';
import { MatchCount, ItemSearch, NoMatch } from '../inventory/ItemSearch';
import { SHOP_SORTS, queryItems, type SortKey } from '../inventory/item-query';
import { revealCard } from '../inventory/reveal-card';
import inventory from '../inventory/InventoryPanel.module.css';
import { BuyBackCard } from './BuyBackCard';
import { AtlasIcon, BannerArt, CurrencyIcon } from './ShopArt';
import { BannerCard, OfferCard, spendable } from './ShopCard';
import { BUY_BACK_EMPTY, BUY_BACK_EMPTY_CARD, BUY_BACK_SORTS, buyBackCellLabel, buyBackCount, buyBackView } from './buy-back';
import {
  BANNER, SHOP_FILTERS, choiceView, counterpartId, currencyWord, merchantFilter, shopChoices, type ShopChoice, type ShopCurrency, type ShopFilter,
} from './shop-offers';
import styles from './ShopPanel.module.css';

const CURRENCIES = [['money', 'Gold'], ['renown', 'Renown']] as const;
const EXPLAINERS: Record<ShopCurrency, string> = {
  money: 'Common equipment. NPC sell value is shown for comparison.',
  renown: 'Account-bound gear. +10% weapon damage or armor in Arena and tournaments; no expedition bonus.',
};
/** The shops' views: a merchant filter, or Buy back (patch 1.9: the owner's own recent sales). */
type ShopView = ShopFilter | 'Buy back';
/** Empty cells drawn after the sales, so the Buy back grid keeps the shop's shape (two rows on a desktop). */
const BUY_BACK_CELLS = 12;

/**
 * The weapon smith's and the armorer's shops as one icon grid (Patch 1.9, the approved shop-grid mockup): every level in
 * one grid by required level, filtered to All, Weapons or Armor, in gold or renown, and the chosen cell's card beside it
 * (below it on a phone). `initialMerchant` opens that merchant's filter and brings the shops into view in their scrolling
 * menu (a click on the merchant in the camp, Task 13.7). Cells are chosen by a click, a tap, or Enter or Space after the
 * arrow keys; a pointer passing over a cell changes nothing, so Buy always sends the card's offer.
 *
 * Buy back (patch 1.9, the approved feedback-buyback mockup): a fourth chip, "Buy back" with a red count, shows the owner's last 10 gear
 * sales of this game day (`owner.buyBack`, newest first) in the same grid and card, each at the price it was sold for. In that view the
 * Gold/Renown group is hidden and the sort starts at Newest. `buyBackRequest` (the inventory's "Open Buy back" after a sale) opens it,
 * brings the shops into view and puts the focus on the chip. `buyBackOutcome` is what the last buy back said (shown above the card).
 */
export function ShopPanel({ owner, busy, preview, buy, initialMerchant, clock, buyBack, buyBackOutcome, buyBackRequest = 0 }: {
  owner: OwnerState; busy: boolean; preview: boolean; buy(catalogId: string, quantity: number): void; initialMerchant?: Merchant;
  clock: DisplayClock; buyBack(entry: BuyBackEntry): void; buyBackOutcome?: ReactNode; buyBackRequest?: number;
}) {
  const section = useRef<HTMLElement>(null), grid = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null), detailsBox = useRef<HTMLElement>(null);
  const backChip = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (initialMerchant) scrollToTop(section.current); }, [initialMerchant]);
  const [filter, setFilter] = useState<ShopView>(merchantFilter(initialMerchant));
  const [currency, setCurrency] = useState<ShopCurrency>('money');
  const [chosenId, setChosenId] = useState<string | null>(null);
  /** The chosen sale in the Buy back view (its own choice, so the shop's is kept while Buy back is shown). */
  const [saleId, setSaleId] = useState<string | null>(null);
  /** Counts cell taps: each one brings the chosen offer's card into view on a phone (`revealCard`, Task 21). */
  const [reveal, setReveal] = useState(0);
  useLayoutEffect(() => { if (reveal) revealCard(detailsBox.current); }, [reveal]);
  /** The cell the arrow keys last reached: the grid's one Tab stop while it is shown, else the chosen cell. */
  const [stopId, setStopId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [query, setQuery] = useState(''), [sort, setSort] = useState<SortKey>('level'), [backSort, setBackSort] = useState<SortKey>('newest');
  const back = filter === 'Buy back';
  const sales = owner.buyBack ?? [];
  // "Open Buy back": the view, the shops at the top of their menu, and the focus on the chip. Only a request newer than the one present when
  // the shops mounted (fix round 1): a merchant's request remounts them (`key`) at that merchant, and an earlier "Open Buy back" must not
  // take the view and the focus again.
  const handledRequest = useRef(buyBackRequest);
  useEffect(() => {
    if (buyBackRequest === handledRequest.current) return;
    handledRequest.current = buyBackRequest;
    setFilter('Buy back');
    scrollToTop(section.current);
    backChip.current?.focus({ preventScroll: true });
  }, [buyBackRequest]);
  const choices = back ? [] : queryItems(shopChoices(filter, currency), choiceView, query, sort);
  const backCells = back ? queryItems(sales, buyBackView, query, backSort) : [];
  const cellId = (entry: BuyBackEntry) => `sale-${entry.saleId}`;
  const ids = back ? backCells.map(cellId) : choices.map(choice => choice.id);
  // A search with no match under a chip that hides matches All would show says so ("No match for “sword” in Armor").
  const hiddenBy = !back && !choices.length && query.trim() && filter !== 'All' && queryItems(shopChoices('All', currency), choiceView, query, sort).length ? filter : undefined;
  // The first visible cell when nothing visible is chosen; remembered, so Buy never sends an offer the grid hides.
  const picked = back ? saleId : chosenId;
  const chosenKey = ids.find(id => id === picked) ?? ids[0];
  if (chosenKey && picked !== chosenKey) (back ? setSaleId : setChosenId)(chosenKey);
  const chosen: ShopChoice | undefined = back ? undefined : choices.find(choice => choice.id === chosenKey);
  const chosenSale = back ? backCells.find(entry => cellId(entry) === chosenKey) : undefined;
  const tabStop = ids.includes(stopId ?? '') ? stopId : chosenKey;
  // After a filter, currency, search or sort change the chosen cell is brought into view inside the grid only (never the page or the menu).
  const latest = useRef(chosenKey);
  latest.current = chosenKey;
  useEffect(() => {
    const box = scroller.current, cell = box?.querySelector<HTMLElement>(`[data-cell-id="${latest.current}"]`);
    if (!box || !cell) return;
    const top = cell.getBoundingClientRect().top - box.getBoundingClientRect().top, bottom = top + cell.offsetHeight - box.clientHeight;
    if (top < 0) box.scrollTop += top;
    else if (bottom > 0) box.scrollTop += bottom;
  }, [filter, currency, query, sort, backSort]);
  const panelIds = useId(), detailsId = `${panelIds}-details`;
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
  const choose = (id: string) => { (back ? setSaleId : setChosenId)(id); setReveal(n => n + 1); };
  function cell(choice: ShopChoice) {
    const offer = choice.kind === 'offer' ? choice.offer : null, entry = offer ? CATALOG_V1.items[offer.catalogId] : null;
    const price = offer ? offer.unitPrice : BANNER.renownPrice;
    const owned = !offer && owner.ownedCosmetics.some(item => item.catalogId === BANNER.id);
    const locked = !!offer && owner.progression.level < offer.requiredLevel;
    const poor = !locked && !owned && price > spendable(owner, currency);
    const name = entry ? [`${entry.name}, level ${entry.tier}`, entry.binding === 'bound' && 'account-bound', `${price} ${word}`]
      : [BANNER.name, 'cosmetic', `${price} ${word}`, owned && 'owned'];
    const description = locked && offer ? `Requires level ${offer.requiredLevel}` : poor ? `Not enough available ${word}` : undefined;
    return <button key={choice.id} type="button" className={`${inventory.tile} ${styles.cell}`} data-shop-cell="" data-cell-id={choice.id} data-testid={`offer-${choice.id}`}
      data-locked={locked ? '' : undefined} data-poor={poor ? '' : undefined}
      aria-label={name.filter(Boolean).join(', ')} aria-description={description} aria-controls={detailsId} aria-pressed={choice.id === chosenKey}
      tabIndex={choice.id === tabStop ? 0 : -1} onFocus={() => setStopId(choice.id)} onClick={() => choose(choice.id)}>
      {offer ? <ItemIcon catalogId={offer.catalogId} /> : <BannerArt />}
      {offer ? <span className={styles.level} data-shop-level="" aria-hidden="true">L{offer.requiredLevel}</span>
        : owned && <span className={styles.owned} aria-hidden="true">✓</span>}
      {locked && <span className={styles.lock} data-shop-lock="" aria-hidden="true">
        <svg width="10" height="11" viewBox="0 0 10 11"><rect x=".5" y="4.5" width="9" height="6" rx="1" fill="currentColor" /><path d="M2.5 4.5V3a2.5 2.5 0 0 1 5 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </span>}
      <span className={styles.price} data-shop-price="" aria-hidden="true"><CurrencyIcon currency={currency} size={10} />{price}</span>
    </button>;
  }
  /** A sale in the Buy back grid: its icon, level, rarity border and the price it was sold for (red when the gold to spend is short). */
  function saleCell(entry: BuyBackEntry) {
    const id = cellId(entry), poor = entry.price > spendable(owner, 'money');
    return <button key={id} type="button" className={`${inventory.tile} ${styles.cell}`} data-shop-cell="" data-buyback-cell={entry.saleId} data-cell-id={id}
      data-rarity={entry.item.rarity} data-poor={poor ? '' : undefined} aria-label={buyBackCellLabel(entry)} aria-description={poor ? 'Not enough gold' : undefined}
      aria-controls={detailsId} aria-pressed={id === chosenKey} tabIndex={id === tabStop ? 0 : -1} onFocus={() => setStopId(id)} onClick={() => choose(id)}>
      <ItemIcon catalogId={entry.item.catalogId} />
      <span className={styles.level} aria-hidden="true">L{entry.item.tier}</span>
      <span className={styles.price} aria-hidden="true"><CurrencyIcon currency="money" size={10} />{entry.price}</span>
    </button>;
  }
  const purchase = { owner, busy, preview, buy };
  const count = back ? backCells.length : choices.length;
  return <section ref={section} aria-labelledby="shops-heading" className={`shops-panel ${styles.panel}`}>
    <div className={styles.top}>
      <h2 id="shops-heading">Shops</h2>
      <p className={styles.wallet}>
        <span><CurrencyIcon currency="money" size={14} /> Available gold <b>{spendable(owner, 'money')}</b></span>
        <span><CurrencyIcon currency="renown" size={14} /> Available renown <b>{spendable(owner, 'renown')}</b></span>
      </p>
    </div>
    <div className={inventory.columns}>
      <div>
        <ItemSearch query={query} setQuery={setQuery} sorts={back ? BUY_BACK_SORTS : SHOP_SORTS} sort={back ? backSort : sort}
          setSort={back ? setBackSort : setSort} label="Search the shops" sortLabel="Sort the shops" />
        <div className={styles.bar}>
          <div className={inventory.filters} role="group" aria-label="Shop filters">
            {SHOP_FILTERS.map(option => <button key={option} type="button" aria-pressed={option === filter} onClick={() => setFilter(option)}>{option}</button>)}
            <button ref={backChip} type="button" className={styles.bbChip} aria-pressed={back} data-buyback-chip="" onClick={() => setFilter('Buy back')}>
              Buy back{sales.length > 0 && <><span className={styles.chipCount} aria-hidden="true">{sales.length}</span><span className={inventory.visuallyHidden}> ({sales.length})</span></>}
            </button>
          </div>
          {!back && <div className={inventory.filters} role="group" aria-label="Shop currency">
            {CURRENCIES.map(([value, label]) => <button key={value} type="button" aria-pressed={value === currency} onClick={() => switchCurrency(value)}>{label}</button>)}
          </div>}
        </div>
        <div ref={scroller} className={`${inventory.gridScroll} ${styles.scroll}${back ? ` ${styles.backScroll}` : ''}`} role="group" aria-label={back ? 'Items to buy back' : 'Shop items'} onKeyDown={move}>
          {back && sales.length === 0 ? <div className={styles.empty}><span><AtlasIcon frame="inventory" size={40} /></span><p>{BUY_BACK_EMPTY}</p></div>
            : count === 0 ? <NoMatch query={query} clear={() => setQuery('')} filter={hiddenBy} /> : <div ref={grid} className={inventory.grid}>
              {back ? backCells.map(saleCell) : choices.map(cell)}
              {Array.from({ length: Math.max(0, (back ? BUY_BACK_CELLS : filter === 'All' && !query.trim() ? 30 : 6) - count) }, (_, index) => <span key={index} className={inventory.emptyCell} aria-hidden="true" />)}
            </div>}
        </div>
        <MatchCount count={count} query={query} filter={hiddenBy} />
        <p className={`muted ${styles.foot}`}>{back ? buyBackCount(sales.length, owner.inventory.length, owner.inventoryCapacity)
          : `${EXPLAINERS[currency]} L = level needed; pieces with a lock are above your level. ${choices.length} items.`}</p>
      </div>
      <section ref={detailsBox} id={detailsId} aria-label="Offer details" className={inventory.details}>
        {back ? <>
          {buyBackOutcome && <div className={styles.outcome}>{buyBackOutcome}</div>}
          {sales.length === 0 ? <div className={styles.emptyCard}><p>{BUY_BACK_EMPTY_CARD}</p></div>
            : chosenSale ? <BuyBackCard key={chosenSale.saleId} entry={chosenSale} owner={owner} clock={clock} busy={busy} preview={preview} buyBack={buyBack} />
              : <p>Nothing to show. Clear the search to see every item.</p>}
        </> : !chosen ? <p>{query.trim() ? 'Nothing to show. Clear the search to see every item.' : 'Nothing here.'}</p>
          : chosen.kind === 'offer' ? <OfferCard offer={chosen.offer} quantity={quantity} setQuantity={setQuantity} {...purchase} /> : <BannerCard {...purchase} />}
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
