'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { BuyBackEntry, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { Merchant } from '@domain/inventory';
import type { DisplayClock } from '../../game/display-clock';
import { ItemIcon } from '../inventory/ItemPresentation';
import { MatchCount, ItemSearch, NoMatch } from '../inventory/ItemSearch';
import { SHOP_SORTS, queryItems, type SortKey } from '../inventory/item-query';
import { gridColumns, rowFill } from '../inventory/grid-page';
import { usePhoneCard } from '../inventory/phone-card';
import inventory from '../inventory/InventoryPanel.module.css';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
import { GRID_PAGE, pageOfIndex } from '../paging/paging';
import { usePagedList } from '../paging/usePagedList';
import { BuyBackCard } from './BuyBackCard';
import { AtlasIcon, BannerArt, CurrencyIcon } from './ShopArt';
import { BannerCard, OfferCard, spendable } from './ShopCard';
import { BUY_BACK_EMPTY, BUY_BACK_EMPTY_CARD, BUY_BACK_SORTS, buyBackCellLabel, buyBackCount, buyBackSales, buyBackView } from './buy-back';
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
 * brings the shops into view and puts the focus on the chip. `buyBackOutcome` is what the last buy back said (shown above the card). An owner
 * read without the list (an older server, before M34) shows no Buy back chip at all (final fix wave).
 *
 * Patch 1.9 Task 33 (menus with Back and Next): the Shops are the menu's second section. The grid shows one page of whole rows (`gridPage`:
 * 24 tiles, or 15 where it has five columns), and Buy back too (fix round 1, the coordinator's ruling: it is the shop's grid, so no Show
 * choice); the last page is padded with empty cells to whole rows. A filter, the currency, a search or a sort goes back to page 1, and when
 * the chosen cell is kept on another page, that page shows. The chosen cell stays chosen across pages, and the grid's one Tab stop is always
 * on the page shown. The bar is the section's bottom bar while the section shows (`active`). On a phone the chosen cell's card opens over
 * the grid (fix round 1, `usePhoneCard`).
 */
export function ShopPanel({ owner, busy, preview, buy, initialMerchant, clock, buyBack, buyBackOutcome, buyBackRequest = 0, gridPage = GRID_PAGE.desktop, active = true }: {
  owner: OwnerState; busy: boolean; preview: boolean; buy(catalogId: string, quantity: number): void; initialMerchant?: Merchant;
  clock: DisplayClock; buyBack(entry: BuyBackEntry): void; buyBackOutcome?: ReactNode; buyBackRequest?: number;
  /** Tiles a grid page holds (the inventory's `useGridPage`). */
  gridPage?: number;
  /** The Shops section shows: its bar is the menu's bottom bar. */
  active?: boolean;
}) {
  const section = useRef<HTMLElement>(null), grid = useRef<HTMLDivElement>(null);
  const backChip = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<ShopView>(merchantFilter(initialMerchant));
  const [currency, setCurrency] = useState<ShopCurrency>('money');
  const [chosenId, setChosenId] = useState<string | null>(null);
  /** The chosen sale in the Buy back view (its own choice, so the shop's is kept while Buy back is shown). */
  const [saleId, setSaleId] = useState<string | null>(null);
  /** The cell the arrow keys last reached: the grid's one Tab stop while it is shown, else the chosen cell. */
  const [stopId, setStopId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [query, setQuery] = useState(''), [sort, setSort] = useState<SortKey>('level'), [backSort, setBackSort] = useState<SortKey>('newest');
  const offered = buyBackSales(owner);
  // Without the list (an older server) there is no Buy back view: All shows instead.
  const view: ShopView = offered === undefined && filter === 'Buy back' ? 'All' : filter;
  const back = view === 'Buy back';
  const sales = offered ?? [];
  // "Open Buy back": the view, the shops at the top of their menu, and the focus on the chip. Only a request newer than the one present when
  // the shops mounted (fix round 1): a merchant's request remounts them (`key`) at that merchant, and an earlier "Open Buy back" must not
  // take the view and the focus again.
  const handledRequest = useRef(buyBackRequest), offeredRef = useRef(offered !== undefined);
  offeredRef.current = offered !== undefined;
  useEffect(() => {
    if (buyBackRequest === handledRequest.current) return;
    handledRequest.current = buyBackRequest;
    if (!offeredRef.current) return;
    setFilter('Buy back');
    backChip.current?.focus({ preventScroll: true });
  }, [buyBackRequest]);
  const choices = back ? [] : queryItems(shopChoices(view, currency), choiceView, query, sort);
  const backCells = back ? queryItems(sales, buyBackView, query, backSort) : [];
  const cellId = (entry: BuyBackEntry) => `sale-${entry.saleId}`;
  const ids = back ? backCells.map(cellId) : choices.map(choice => choice.id);
  const count = ids.length;
  const phoneCard = usePhoneCard(count > 0);
  // The card closes with the section (it opens again from a cell).
  useEffect(() => { if (!active) phoneCard.close(false); }, [active, phoneCard.close]);
  // A search with no match under a chip that hides matches All would show says so ("No match for “sword” in Armor").
  const hiddenBy = !back && !choices.length && query.trim() && view !== 'All' && queryItems(shopChoices('All', currency), choiceView, query, sort).length ? view : undefined;
  // The first visible cell when nothing visible is chosen; remembered, so Buy never sends an offer the grid hides.
  const picked = back ? saleId : chosenId;
  const chosenKey = ids.find(id => id === picked) ?? ids[0];
  if (chosenKey && picked !== chosenKey) (back ? setSaleId : setChosenId)(chosenKey);
  const chosen: ShopChoice | undefined = back ? undefined : choices.find(choice => choice.id === chosenKey);
  const chosenSale = back ? backCells.find(entry => cellId(entry) === chosenKey) : undefined;
  // The pages: the shop's cells and Buy back's sales, each in whole rows of the grid; the last page is padded with empty cells to whole rows.
  const shopPaged = usePagedList(choices, { size: gridPage, resetKey: `${view}|${currency}|${query}|${sort}` });
  const backPaged = usePagedList(backCells, { size: gridPage, resetKey: `${query}|${backSort}` });
  const paged: { listRef: RefObject<HTMLElement | null>; goToIndex(index: number): void; rows: readonly unknown[] } = back ? backPaged : shopPaged;
  const fill = rowFill(paged.rows.length, gridColumns(gridPage));
  const pageIds = back ? backPaged.rows.map(cellId) : shopPaged.rows.map(choice => choice.id);
  // The grid's one Tab stop is on the page shown: the cell the arrow keys last reached, else the chosen one, else the first.
  const tabStop = pageIds.includes(stopId ?? '') ? stopId : pageIds.includes(chosenKey ?? '') ? chosenKey : pageIds[0];
  // After a filter, currency, search or sort change the chosen cell's page shows (page 1 unless it is kept further on); nothing else moves.
  const latest = useRef({ chosenKey, ids, size: gridPage });
  latest.current = { chosenKey, ids, size: gridPage };
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const changedView = useRef(false);
  useEffect(() => {
    if (!changedView.current) { changedView.current = true; return; }
    const { chosenKey: key, ids: shown, size } = latest.current, at = shown.indexOf(key ?? '');
    if (at >= 0 && pageOfIndex(at, size) > 1) pagedRef.current.goToIndex(at);
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
  /** A cell pressed: chosen, and on a phone its card opens over the grid (the cell takes the focus back when it closes). */
  const choose = (id: string, cell: HTMLElement) => { (back ? setSaleId : setChosenId)(id); phoneCard.show(cell); };
  function cell(choice: ShopChoice) {
    const offer = choice.kind === 'offer' ? choice.offer : null, entry = offer ? CATALOG_V1.items[offer.catalogId] : null;
    const price = offer ? offer.unitPrice : BANNER.renownPrice;
    const owned = !offer && owner.ownedCosmetics.some(item => item.catalogId === BANNER.id);
    const locked = !!offer && owner.progression.level < offer.requiredLevel;
    const poor = !locked && !owned && price > spendable(owner, currency);
    const name = entry ? [`${entry.name}, level ${entry.tier}`, entry.binding === 'bound' && 'account-bound', `${price} ${word}`]
      : [BANNER.name, 'cosmetic', `${price} ${word}`, owned && 'owned'];
    const description = locked && offer ? `Requires level ${offer.requiredLevel}` : poor ? `Not enough available ${word}` : undefined;
    return <button key={choice.id} type="button" className={`${inventory.tile} ${styles.cell}`} data-shop-cell="" data-cell-id={choice.id} data-testid={`offer-${choice.id}`} data-page-row=""
      data-locked={locked ? '' : undefined} data-poor={poor ? '' : undefined}
      aria-label={name.filter(Boolean).join(', ')} aria-description={description} aria-controls={detailsId} aria-pressed={choice.id === chosenKey}
      tabIndex={choice.id === tabStop ? 0 : -1} onFocus={() => setStopId(choice.id)} onClick={event => choose(choice.id, event.currentTarget)}>
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
    return <button key={id} type="button" className={`${inventory.tile} ${styles.cell}`} data-shop-cell="" data-buyback-cell={entry.saleId} data-cell-id={id} data-page-row=""
      data-rarity={entry.item.rarity} data-poor={poor ? '' : undefined} aria-label={buyBackCellLabel(entry)} aria-description={poor ? 'Not enough gold' : undefined}
      aria-controls={detailsId} aria-pressed={id === chosenKey} tabIndex={id === tabStop ? 0 : -1} onFocus={() => setStopId(id)} onClick={event => choose(id, event.currentTarget)}>
      <ItemIcon catalogId={entry.item.catalogId} />
      <span className={styles.level} aria-hidden="true">L{entry.item.tier}</span>
      <span className={styles.price} aria-hidden="true"><CurrencyIcon currency="money" size={10} />{entry.price}</span>
    </button>;
  }
  const purchase = { owner, busy, preview, buy };
  return <section ref={section} aria-labelledby="shops-heading" className={`shops-panel ${styles.panel}`}>
    <div className={styles.top}>
      {/* The section strip names the Shops (Task 33); the heading stays for the outline and screen readers. */}
      <h2 id="shops-heading" className={inventory.visuallyHidden}>Shops</h2>
      <p className={styles.wallet}>
        <span><CurrencyIcon currency="money" size={14} /> Available gold <b>{spendable(owner, 'money')}</b></span>
        <span><CurrencyIcon currency="renown" size={14} /> Available renown <b>{spendable(owner, 'renown')}</b></span>
      </p>
    </div>
    {/* On a phone the chosen cell's card lies over the grid once a cell is chosen; with no cell to choose, the card (empty or no match) shows below. */}
    <div ref={phoneCard.hostRef} className={inventory.columns} data-card={phoneCard.phone && count > 0 ? (phoneCard.open ? 'open' : 'closed') : undefined}>
      <div>
        <ItemSearch query={query} setQuery={setQuery} sorts={back ? BUY_BACK_SORTS : SHOP_SORTS} sort={back ? backSort : sort}
          setSort={back ? setBackSort : setSort} label="Search the shops" sortLabel="Sort the shops" />
        <div className={styles.bar}>
          <div className={inventory.filters} role="group" aria-label="Shop filters">
            {SHOP_FILTERS.map(option => <button key={option} type="button" aria-pressed={option === view} onClick={() => setFilter(option)}>{option}</button>)}
            {offered && <button ref={backChip} type="button" className={styles.bbChip} aria-pressed={back} data-buyback-chip="" onClick={() => setFilter('Buy back')}>
              Buy back{sales.length > 0 && <><span className={styles.chipCount} aria-hidden="true">{sales.length}</span><span className={inventory.visuallyHidden}> ({sales.length})</span></>}
            </button>}
          </div>
          {!back && <div className={inventory.filters} role="group" aria-label="Shop currency">
            {CURRENCIES.map(([value, label]) => <button key={value} type="button" aria-pressed={value === currency} onClick={() => switchCurrency(value)}>{label}</button>)}
          </div>}
        </div>
        <div inert={phoneCard.open}>
        {/* The arrow keys move between the cells and never move the section (`data-arrow-keys`). */}
        <div ref={phoneCard.anchorRef} className={`${inventory.gridScroll} ${inventory.paged} ${styles.scroll}${back ? ` ${styles.backScroll}` : ''}`} role="group"
          aria-label={back ? 'Items to buy back' : 'Shop items'} data-arrow-keys="" onKeyDown={move}>
          {back && sales.length === 0 ? <div className={styles.empty}><span><AtlasIcon frame="inventory" size={40} /></span><p>{BUY_BACK_EMPTY}</p></div>
            : count === 0 ? <NoMatch query={query} clear={() => setQuery('')} filter={hiddenBy} />
              : <div ref={paged.listRef as RefObject<HTMLDivElement | null>} data-page-list=""><div ref={grid} className={`${inventory.grid} ${inventory.paged}`}>
                {back ? backPaged.rows.map(saleCell) : shopPaged.rows.map(cell)}
                {Array.from({ length: fill }, (_, n) => <span key={`empty-${n}`} className={inventory.emptyCell} aria-hidden="true" />)}
              </div></div>}
        </div>
        <MatchCount count={count} query={query} filter={hiddenBy} />
        <p className={`muted ${styles.foot}`}>{back ? buyBackCount(sales.length, owner.inventory.length, owner.inventoryCapacity)
          : `${EXPLAINERS[currency]} L = level needed; pieces with a lock are above your level. ${choices.length} items.`}</p>
        </div>
      </div>
      <section ref={phoneCard.sheetRef} id={detailsId} aria-label="Offer details" className={inventory.details}
        onKeyDown={phoneCard.onKeyDown}>
        {phoneCard.phone && count > 0 && <button type="button" className={inventory.closeCard} aria-label="Close item card" onClick={() => phoneCard.close()}>×</button>}
        {back ? <>
          {buyBackOutcome && <div className={styles.outcome}>{buyBackOutcome}</div>}
          {sales.length === 0 ? <div className={styles.emptyCard}><p>{BUY_BACK_EMPTY_CARD}</p></div>
            : chosenSale ? <BuyBackCard key={chosenSale.saleId} entry={chosenSale} owner={owner} clock={clock} busy={busy} preview={preview} buyBack={buyBack} />
              : <p>Nothing to show. Clear the search to see every item.</p>}
        </> : !chosen ? <p>{query.trim() ? 'Nothing to show. Clear the search to see every item.' : 'Nothing here.'}</p>
          : chosen.kind === 'offer' ? <OfferCard offer={chosen.offer} quantity={quantity} setQuantity={setQuantity} {...purchase} /> : <BannerCard {...purchase} />}
      </section>
    </div>
    {active && count > 0 && <PanelFooter>{back ? <Pager list={backPaged} /> : <Pager list={shopPaged} />}</PanelFooter>}
  </section>;
}
