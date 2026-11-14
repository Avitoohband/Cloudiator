'use client';

// The 💰 Marketplace menu (Task 18 plan Decision 11; full-screen camp spec "Menus": a player buys, sells, lists and cancels;
// a visitor browses listings only). Patch 1.9, Task 26 (Avi approved the revised mockup on 2026-11-13: "big icon like the other tabs,
// but the seller should have more emphasis; still a list with all the details"): two tabs for a player.
// - Browse: the open offers, newest first, read 50 at a time and shown three cards a page with Back and Next (Patch 1.9 Task 32: Next past the
//   loaded offers reads the next 50), as a list. Each row has a big icon tile in the Inventory's style
//   (its level, rarity, "Yours" or "Expired"), the name, the level line, the stat chips, when it was listed, the time left and the NPC
//   sale value, the price with Buy (others' offers, after a confirmation) or Cancel listing (the player's own), and under them a seller
//   band: an initial, "Sold by", the name, the class, league and level when the listing carries them (optional until the read selects
//   them), and View profile. Chips All, Weapons, Armor and My listings (n), a search by name and Sort (Newest, Price low-high, Price
//   high-low, Level) work on the listings loaded so far. My listings is the seller-filtered read.
// - Sell: the items that can be listed (equipment only: tradable, not renown, bound, equipped, held by a pending build or reserved) as
//   the Inventory's tile grid (identical pieces stacked), with search, Sort and chips; the chosen tile's card holds a whole price from
//   2, and what the buyer pays, the market fee (5%, at least 1), what the seller receives and the NPC sale value shown before listing.
// A visitor sees Browse only, with "Sign in with Google to trade"; a signed-in account without a gladiator sees Browse only,
// with "Create your gladiator to trade". Neither ever sees a wallet or a trading control, and neither can send a command:
// the shell gives this panel the command gateway for a player only.
//
// Commands follow InventoryPanel's retry rules: an identical retry keeps its operation id after `processing`,
// `unavailable` or `rate-limited` (or a lost response), so a retry after a rolled-back deadlock replays the same operation
// (the Task 18.2 review's item carried to 18.3: keep the same operationId on `processing`); any other answer ends that
// operation. A purchase on a stale page (`sold`, `expired`, `not-found`) is explained and the page and the owner are
// refreshed (Review Focus 4). Offers load on demand: each time the menu opens, a tab or My listings is shown, a command settles
// or Refresh is pressed. A trader's owner is read when the menu opens and on each Refresh too, because a sale or an expiry changes
// the seller's wallet and inventory without a new world revision (final review I1). Names render as React text.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { GameCommand } from '@contracts/commands';
import type { ItemInstance, MarketListing, OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import type { Rules } from '@domain/types';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import type { Viewer } from '../character/useGameState';
import { GoogleMark, SIGN_IN_NOT_STARTED, useGoogleSignIn } from '../auth/SignIn';
import { ItemIcon, ItemStats } from '../inventory/ItemPresentation';
import { itemStatLines } from '../inventory/item-presentation';
import { ItemSearch, MatchCount, NoMatch } from '../inventory/ItemSearch';
import { queryItems, type SortKey } from '../inventory/item-query';
import { revealCard } from '../inventory/reveal-card';
import { groupStacks, isStackable, type StackTile } from '../inventory/stacks';
import inventory from '../inventory/InventoryPanel.module.css';
import { useOutcomeFocus } from '../shell/focus-lost';
import { usePagedList } from '../paging/usePagedList';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
import { CurrencyIcon } from '../shops/ShopArt';
import {
  ITEM_FILTERS, LOWEST_PRICE_TEXT, MARKET_FEE_PERCENT, MARKET_FEE_TERMS, MARKET_MINIMUM_FEE, MARKET_SORTS, MAXIMUM_LISTINGS, MAXIMUM_PRICE, MINIMUM_PRICE,
  NOT_OFFERED_TEXT, PRICE_HINT, RETRY_CODES, SELL_SORTS, WHOLE_PRICE_TEXT, activeListings, amount, capital, itemGrade, itemName, listableItems, listedAgo,
  marketCountLine, marketErrorText, marketFee, matchesItemFilter, money, npcValueText, offerName, offerView, priceProblem, sellerInitial, sellerLine,
  sellerReceives, sellView, timeLeft, validPrice, type ItemFilter, type MarketKind,
} from './market-text';
import styles from './MarketPanel.module.css';

const PAGE_ROWS = 50;
/** The time left is shown in whole minutes: redraw twice a minute while the tab is visible. */
const TICK_MS = 30_000;
const LISTING_DAYS = RULES_V1.marketplace.expiryMs / 86_400_000;
const PREVIEW = 'Actions are unavailable in this preview.';
/** Empty cells after the Sell tab's tiles, so its grid keeps two rows on a desktop (the Shops' shape). */
const SELL_CELLS = 12;

export type MarketReader = Pick<GameGateway, 'market'>;
export type OffersList = { rows: MarketListing[]; nextCursor: string | null };
export type OffersModel = OffersList & { status: 'loading' | 'ready' | 'failed' };
/** Who looks at the offers: a trader buys and cancels, a visitor is asked to sign in to buy, anyone else browses. */
export type MarketAccess = 'trade' | 'sign-in' | 'browse';

type MarketCommand = Extract<GameCommand, { kind: MarketKind }>;
type Intent = { kind: 'create-listing'; itemId: string; price: number } | { kind: 'cancel-listing'; listingId: string } | { kind: 'buy-listing'; listingId: string };
/** The command being sent or kept for a retry, with the words its outcome is told in. */
type Attempt = { command: MarketCommand; name: string; price: number };
type Tab = 'browse' | 'sell';
const TABS: readonly { id: Tab; label: string }[] = [{ id: 'browse', label: 'Browse' }, { id: 'sell', label: 'Sell' }];
/** Browse's chips: the item filters, and the trader's own listings. */
type Chip = ItemFilter | 'Mine';

/**
 * The first page (`loaded` null), or `loaded` with the page after its cursor appended: at most 50 new rows, never a listing
 * already shown. A page with nothing new (a reader that ignores the cursor) ends the list.
 */
export async function readOffers(reader: MarketReader, seller: string | null, loaded: OffersList | null): Promise<OffersList> {
  if (loaded && !loaded.nextCursor) return loaded;
  const page = await reader.market(loaded?.nextCursor ?? undefined, seller ?? undefined);
  const seen = new Set((loaded?.rows ?? []).map(row => row.listingId));
  const fresh: MarketListing[] = [];
  for (const row of page.rows) {
    if (fresh.length === PAGE_ROWS || seen.has(row.listingId)) continue;
    seen.add(row.listingId);
    fresh.push(row);
  }
  if (loaded && !fresh.length) return { ...loaded, nextCursor: null };
  return { rows: [...(loaded?.rows ?? []), ...fresh], nextCursor: page.nextCursor };
}

/**
 * A trader's on-demand owner reads (final review I1). A sale or an expiry changes the seller's wallet and inventory without
 * bumping the world revision (Ruling 2), so nothing else reads the owner again. The panel reads it once when it opens and
 * again on each Refresh, so the listing count, the available gold and the free slots match the server. `open` reads at
 * most once, however often it runs (a development remount runs effects twice); a failed read keeps the owner last shown.
 */
export function ownerReads(read: () => Promise<void>): { open(): Promise<void>; refresh(): Promise<void> } {
  let opened = false;
  const refresh = () => read().catch(() => undefined);
  return {
    open: () => {
      if (opened) return Promise.resolve();
      opened = true;
      return refresh();
    },
    refresh,
  };
}

/** The display clock's time, twice a minute while the tab is visible and whenever the clock is held or moved. */
function useNow(clock: DisplayClock) {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const update = () => setNow(clock.now());
    const off = clock.subscribe(update);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    update();
    return () => { off(); window.clearInterval(timer); };
  }, [clock]);
  return now;
}

/** The seller band (Task 26): the seller in front, with their class, league and level only when the listing carries them. */
function SellerBand({ listing, own, onProfile }: { listing: MarketListing; own: boolean; onProfile?(listing: MarketListing): void }) {
  const { name } = listing.seller, line = sellerLine(listing);
  return <div className={styles.seller} data-part="seller">
    <span className={styles.avatar} data-class={listing.sellerClassId ?? undefined} aria-hidden="true">{sellerInitial(name)}
      {listing.sellerLeague && <span className={styles.league} data-league={listing.sellerLeague}>{capital(listing.sellerLeague).charAt(0)}</span>}</span>
    <div className={styles.sellerText}>
      <p className={styles.soldBy}>{own ? 'Your listing, sold by' : 'Sold by'}</p>
      <p className={styles.sellerName}>{own ? `${name} (you)` : name}</p>
      {line && <p className={styles.sellerLine}>{line}</p>}
    </div>
    {onProfile && <button type="button" className={styles.profile} aria-label={`View profile of ${name}`} onClick={() => onProfile(listing)}>View profile</button>}
  </div>;
}

/**
 * Pure view of a list of offers (Task 26): the rows a chip, a search and a sort leave, the count under them with Refresh, the pager, and the
 * foot. `access` decides each row's action: a trader's Buy (others' offers) or Cancel listing (their own), a visitor's "Sign in to buy.",
 * or none. `mine` is My listings (the seller's own read).
 */
export function MarketOffers({ model, access, ownerId, now, busy, onBuy, onCancel, onProfile, onMore, onRetry, onRefresh, onSell, onClearQuery,
  query = '', sort = 'newest', filter = 'All', mine = false, available = null, full = false, rules = RULES_V1 }: {
  model: OffersModel;
  access: MarketAccess;
  /** The viewer's gladiator, whose own offers say "Your listing" and offer Cancel listing, never Buy; null for a visitor. */
  ownerId: string | null;
  /** The display time, for each offer's time left and how long ago it was listed. */
  now: number;
  busy: boolean;
  onBuy(listing: MarketListing): void;
  onCancel(listing: MarketListing): void;
  /** Opens the seller's profile card; without it the band has no View profile. */
  onProfile?(listing: MarketListing): void;
  /** Reads the next page of offers: resolves once the rows have grown, rejects when the read fails (Next past the loaded offers). */
  onMore(): Promise<unknown> | void;
  onRetry(): void;
  onRefresh(): void;
  /** My listings with nothing listed offers "List an item" (the Sell tab). */
  onSell?(): void;
  onClearQuery?(): void;
  query?: string;
  sort?: SortKey;
  filter?: ItemFilter;
  mine?: boolean;
  /** A buyer's available gold: a dearer offer cannot be bought. */
  available?: number | null;
  /** A buyer's inventory has no free slot. */
  full?: boolean;
  /** The active rules (Patch 1.6): a salvage offer's NPC value is theirs. */
  rules?: Rules;
}) {
  const { rows, status } = model;
  const ids = useId();
  const searched = query.trim();
  const shown = queryItems(rows.filter(row => matchesItemFilter(row.item.catalogId, filter)), offerView, query, sort);
  // A search with no match under a chip that hides matches All would show says so ("No match for “bow” in Armor").
  const hiddenBy = !shown.length && searched && filter !== 'All' && queryItems(rows, offerView, query, sort).length ? filter : undefined;
  const count = searched ? `${shown.length} listing${shown.length === 1 ? '' : 's'} match “${searched}”`
    : mine ? `${shown.length} of your ${MAXIMUM_LISTINGS} listings` : marketCountLine(shown.length, sort);
  // Three cards a page (Patch 1.9 Task 32): a chip, a search, a sort or My listings goes back to page 1; a refresh keeps the page.
  const paged = usePagedList(shown, {
    // Under a sort that re-orders the loaded offers, a read starts again at page 1 of the new order (Task 32 fix round 1, I4): the loaded count joins
    // the key, or the page asked for would skip and repeat offers. Newest keeps the load order, so it pages on.
    list: 'market', resetKey: `${filter}|${query}|${sort}|${mine}|${model.nextCursor !== null && sort !== 'newest' ? rows.length : ''}`,
    more: model.nextCursor ? { hasMore: true, load: async () => { await onMore(); } } : undefined,
  });
  const partial = model.nextCursor !== null && (sort !== 'newest' || searched !== '');
  const foot = mine ? `A listing lasts ${LISTING_DAYS} days. Cancel it, or let it expire, to return the item to your inventory.`
    : access === 'trade' ? "Red price: not enough available gold. L = the item's level." : "L = the item's level.";
  return <div className={styles.offers}>
    {status === 'failed' && rows.length === 0
      ? <div className={styles.failed} role="alert"><p>Listings could not be loaded right now.</p><button type="button" onClick={onRetry}>Try again</button></div>
      : status === 'loading' && rows.length === 0 ? <p className="muted" role="status">Loading listings…</p>
        : rows.length === 0 || (!shown.length && !searched) ? <div className={styles.empty}>
          <p className="muted" role="status">{mine ? 'You have no open listings.'
            // Final review (fix round 1): under an empty Weapons or Armor chip, while the market has listings, say what is missing.
            : rows.length > 0 && filter === 'Weapons' ? 'No weapons listed right now.' : rows.length > 0 && filter === 'Armor' ? 'No armor listed right now.'
              : 'No open listings right now.'}</p>
          {mine && onSell && <button type="button" className={styles.ghost} onClick={onSell}>List an item</button>}
        </div>
          : !shown.length ? <NoMatch query={query} clear={() => onClearQuery?.()} filter={hiddenBy} />
            : <ul ref={paged.listRef as RefObject<HTMLUListElement | null>} className={styles.list} aria-label={mine ? 'Your open listings' : 'Open listings'}>{paged.rows.map(row => {
              const name = offerName(row.item), { tier, rarity, quantity } = row.item;
              const own = ownerId !== null && row.seller.gladiatorId === ownerId, expired = row.expiresAtMs <= now, trade = access === 'trade';
              const poor = trade && !own && !expired && available !== null && row.price > available;
              const blocked = trade && !own && !expired ? (poor ? 'Not enough available gold' : full ? 'Your inventory is full' : null) : null;
              // A disabled Buy says why: the reason describes it (Task 23.5, C18).
              const blockedId = `${ids}-${row.listingId}`;
              const label = [name, `level ${tier}`, rarity, `sold by ${row.seller.name}`, money(row.price), own && 'your listing', expired && 'expired'].filter(Boolean).join(', ');
              return <li key={row.listingId} className={styles.row} data-page-row="" tabIndex={-1} data-testid={`listing-${row.listingId}`} data-rarity={rarity} data-mine={own ? '' : undefined}
                data-poor={poor ? '' : undefined} data-expired={expired ? '' : undefined} aria-label={label}>
                <div className={styles.tile} data-part="icon" aria-hidden="true">
                  <ItemIcon catalogId={row.item.catalogId} size={64} />
                  <span className={styles.level}>L{tier}</span>
                  {quantity > 1 && <span className={styles.count}>×{amount(quantity)}</span>}
                  {own ? <span className={styles.mark}>Yours</span> : expired ? <span className={styles.mark} data-mark="expired">Expired</span> : null}
                </div>
                <div className={styles.details} data-part="details">
                  <h3 className={styles.name}>{name}<span className={styles.rarity}>{capital(rarity)}</span>{own && <span className={styles.yours}>Your listing</span>}</h3>
                  <p className={styles.grade}>{`Level ${tier} · ${rarity} · Tradable`}</p>
                  {/* The stat chips are the Inventory card's lines, as terms and values (not list items, so a row's items are only the rows). */}
                  <dl className={styles.stats}>{itemStatLines(row.item).filter(([label, value]) => label !== 'Attribute bonuses' || value !== 'None')
                    .map(([label, value]) => <div key={label} className={label === 'Weight' ? styles.weight : undefined}><dt>{label}</dt> <dd>{value}</dd></div>)}</dl>
                  <p className={styles.time}>{`Listed ${listedAgo(row.listedAtMs, now)} · `}<span className={expired ? styles.expiredText : undefined}>{timeLeft(row.expiresAtMs, now)}</span>
                    {` · ${npcValueText(row.item, rules)}`}</p>
                </div>
                <div className={styles.deal} data-part="deal">
                  <p className={styles.price}><CurrencyIcon currency="money" size={18} />{amount(row.price)}<span className={styles.sr}> gold</span></p>
                  {trade && own ? <>
                    <button type="button" className={styles.cancel} aria-disabled={busy || undefined} aria-label={`Cancel listing: ${name} for ${money(row.price)}`}
                      onClick={() => { if (!busy) onCancel(row); }}>Cancel listing</button>
                    <p className={styles.soft}>{`You receive ${money(sellerReceives(row.price))} after the market fee (${MARKET_FEE_TERMS})`}</p>
                  </> : trade ? <>
                    <button type="button" className={styles.buy} disabled={expired || blocked !== null} aria-disabled={busy || undefined}
                      aria-label={`Buy ${name} for ${money(row.price)}`} aria-describedby={blocked ? blockedId : undefined} onClick={() => { if (!busy) onBuy(row); }}>
                      {expired ? 'Buy' : <>Buy for <CurrencyIcon currency="money" size={14} /> {amount(row.price)} gold</>}</button>
                    {blocked && <p id={blockedId} className={styles.blocked}>{blocked}</p>}
                  </> : access === 'sign-in' ? <p className={styles.soft}>Sign in to buy.</p> : null}
                </div>
                <SellerBand listing={row} own={own} onProfile={onProfile} />
              </li>;
            })}</ul>}
    {status === 'failed' && rows.length > 0 && <p className={styles.failedNote} role="alert">The listings could not be refreshed. Showing the last ones read.</p>}
    <div className={styles.countLine}>
      <p role="status">{rows.length > 0 ? count : ''}</p>
      <button type="button" className={styles.refresh} onClick={onRefresh} disabled={status === 'loading'}>Refresh</button>
    </div>
    <PanelFooter><Pager list={paged} show /></PanelFooter>
    <p className={styles.foot}>{foot}{partial && ' Sort and search apply to the listings loaded so far.'}</p>
  </div>;
}

/**
 * One list of offers, read on demand: anyone's (`seller` null) or one seller's. `version` changes re-read it; Refresh re-reads
 * it and calls `onRefresh` (a trader's owner read).
 */
function OfferList({ reads, seller, version, onRefresh, ...view }: {
  reads: MarketReader; seller: string | null; version: number; onRefresh?(): void;
} & Omit<Parameters<typeof MarketOffers>[0], 'model' | 'onMore' | 'onRetry' | 'onRefresh'>) {
  const [list, setList] = useState<OffersList | null>(null);
  const [status, setStatus] = useState<OffersModel['status']>('loading');
  const [attempt, setAttempt] = useState(0);
  /** The next page being read (a second Next while it reads does nothing). */
  const loadingMore = useRef(false);
  /** The current read generation: a page that arrives for an older one (a refresh, another seller) is dropped. */
  const generation = useRef(0);
  /** The list as last set, and the first-page read in flight: a Next waits for the read and extends the list it leaves (Codex review, finding 2). */
  const latest = useRef<OffersList | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const mine = ++generation.current;
    setStatus('loading');
    loadingMore.current = false;
    const run = readOffers(reads, seller, null).then(
      next => { if (mine === generation.current) { latest.current = next; setList(next); setStatus('ready'); } },
      () => { if (mine === generation.current) setStatus('failed'); },
    );
    refreshing.current = run;
    void run.then(() => { if (refreshing.current === run) refreshing.current = null; });
    return () => { generation.current += 1; };
  }, [reads, seller, version, attempt]);

  const more = useCallback(async () => {
    if (loadingMore.current) return;
    loadingMore.current = true;
    try {
      while (refreshing.current) await refreshing.current;
      const base = latest.current;
      if (!base?.nextCursor) return;
      const mine = generation.current;
      const next = await readOffers(reads, seller, base);
      // A page whose base list is no longer the shown one (a refresh landed meanwhile) is dropped: older offers never replace a refreshed list.
      if (mine === generation.current && latest.current === base) { latest.current = next; setList(next); }
    } finally {
      loadingMore.current = false;
    }
  }, [reads, seller]);

  return <MarketOffers {...view} model={{ rows: list?.rows ?? [], nextCursor: list?.nextCursor ?? null, status }} onMore={more}
    onRetry={() => setAttempt(n => n + 1)} onRefresh={() => { setAttempt(n => n + 1); onRefresh?.(); }} />;
}

/**
 * The Sell tab (Task 26, the approved mockup): the pieces that can be listed as the Inventory's tile grid, stacked as there, with search,
 * Sort and the item chips; the chosen tile's card shows the piece and holds the price, its fee lines and List for sale. The tiles are
 * radio buttons: one Tab stop, and the arrow keys choose the next piece. A stack lists its first piece.
 */
function SellForm({ owner, busy, onList, rules }: { owner: OwnerState; busy: boolean; onList(item: ItemInstance, price: number): void; rules: Rules }) {
  const items = listableItems(owner);
  const tiles = groupStacks(items, item => isStackable(owner, item));
  const [chosen, setChosen] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [filter, setFilter] = useState<ItemFilter>('All');
  const [query, setQuery] = useState(''), [sort, setSort] = useState<SortKey>('newest');
  const [stopId, setStopId] = useState<string | null>(null);
  /** Counts tile taps: each one brings the card into view on a phone (`revealCard`). */
  const [reveal, setReveal] = useState(0);
  const grid = useRef<HTMLDivElement>(null), cardBox = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (reveal) revealCard(cardBox.current); }, [reveal]);
  const priceId = useId(), hintId = useId(), errorId = useId(), limitId = useId(), detailsId = useId();
  const shown = queryItems(tiles.filter(tile => matchesItemFilter(tile.items[0].catalogId, filter)), tile => sellView(tile.items[0]), query, sort);
  const hiddenBy = !shown.length && query.trim() && filter !== 'All' && queryItems(tiles, tile => sellView(tile.items[0]), query, sort).length ? filter : undefined;
  const tile = shown.find(t => t.key === chosen) ?? null;
  const item = tile?.items[0] ?? null;
  const tabStop = shown.some(t => t.key === chosen) ? chosen : shown.some(t => t.key === stopId) ? stopId : shown[0]?.key ?? null;
  const value = Number(price), valid = price.trim() !== '' && validPrice(value);
  const count = activeListings(owner), atLimit = count >= MAXIMUM_LISTINGS;
  // The price's message marks the field invalid and describes it, beside its hint; List for sale is described by what
  // keeps it disabled (Task 23.5, C18). A whole price under the lowest one is told why the lowest is 2.
  const problem = priceProblem(price), wrong = problem !== null;
  const listReasons = [wrong && errorId, atLimit && limitId].filter(Boolean).join(' ');
  const choose = (key: string) => { setChosen(key); setStopId(key); };
  /** The arrow keys move a tile (left, right) or a row (up, down) and choose it, as radio buttons do; Home and End go to the ends. */
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const cells = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
    const index = cells.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const columns = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length : 1;
    const steps: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: cells.length - 1 };
    const next = steps[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = cells[Math.max(0, Math.min(cells.length - 1, next))];
    const key = target?.dataset.tileKey;
    if (!target || !key) return;
    choose(key);
    target.focus();
  }
  const tileLabel = (t: StackTile) => {
    const first = t.items[0];
    return [`${itemName(first)}, level ${first.tier}, ${first.rarity}`, t.items.length > 1 && `${t.items.length} owned`].filter(Boolean).join(', ');
  };
  const fees = <>
    <p className={styles.foot}><b className={styles.active}>{`Active listings: ${count} of ${MAXIMUM_LISTINGS}`}</b><br />
      {`No listing fee. When an item sells, a ${MARKET_FEE_PERCENT}% market fee (rounded down, at least ${money(MARKET_MINIMUM_FEE)}) is kept from the price. A listing lasts ${LISTING_DAYS} days; cancel it any time to take the item back.`}</p>
    <p className={styles.foot}>{NOT_OFFERED_TEXT}</p>
  </>;
  if (items.length === 0) return <div className={styles.sell}>
    <p className={styles.nothing}>Nothing to list right now. Only free, tradable equipment can be listed: not equipped or reserved items, account-bound or renown gear, or salvage.</p>
    {fees}
  </div>;
  return <div className={`${styles.sell} ${inventory.columns}`}>
    <div>
      <ItemSearch query={query} setQuery={setQuery} sorts={SELL_SORTS} sort={sort} setSort={setSort} label="Search your items" sortLabel="Sort your items" />
      <div className={styles.chips} role="group" aria-label="Item filters">
        {ITEM_FILTERS.map(option => <button key={option} type="button" aria-pressed={option === filter} onClick={() => setFilter(option)}>{option}</button>)}
      </div>
      <div className={inventory.gridScroll}>
        {shown.length === 0 ? query.trim() ? <NoMatch query={query} clear={() => setQuery('')} filter={hiddenBy} />
          : <div className={inventory.noMatch}><span>{`No ${filter.toLowerCase()} to list.`}</span></div>
          : <div ref={grid} className={inventory.grid} role="radiogroup" aria-label="Item to list" onKeyDown={move}>
            {shown.map(t => {
              const first = t.items[0], checked = t.key === tile?.key;
              return <button key={t.key} type="button" role="radio" aria-checked={checked} className={inventory.tile} data-tile-key={t.key} data-rarity={first.rarity}
                data-stack={t.items.length > 1 ? t.items.length : undefined} aria-label={tileLabel(t)} aria-controls={detailsId} tabIndex={t.key === tabStop ? 0 : -1}
                onFocus={() => setStopId(t.key)} onClick={() => { choose(t.key); setReveal(n => n + 1); }}>
                <ItemIcon catalogId={first.catalogId} />
                <span className={inventory.level} aria-hidden="true">L{first.tier}</span>
                {t.items.length > 1 && <span className={inventory.count} aria-hidden="true">×{t.items.length}</span>}
              </button>;
            })}
            {Array.from({ length: Math.max(0, SELL_CELLS - shown.length) }, (_, index) => <span key={index} className={inventory.emptyCell} aria-hidden="true" />)}
          </div>}
      </div>
      {query.trim() ? <MatchCount count={shown.reduce((total, t) => total + t.items.length, 0)} query={query} filter={hiddenBy} />
        : <p className={styles.tilesLine}>{`${shown.length} tile${shown.length === 1 ? '' : 's'} · free, tradable equipment only`}</p>}
      {fees}
    </div>
    <section ref={cardBox} id={detailsId} aria-label="Listing details" className={inventory.details}>
      {item ? <article className={inventory.card} data-rarity={item.rarity}>
        <div className={inventory.cardHead}>
          <ItemIcon catalogId={item.catalogId} size={48} />
          <div><h3>{itemName(item)}</h3><p>{`Level ${item.tier} · ${item.rarity} · Tradable`}</p></div>
        </div>
        <ItemStats item={item} />
        <div className={styles.listBox}>
          <h4>List on the Marketplace</h4>
          <label className={styles.priceLabel} htmlFor={priceId}>Price in gold</label>
          <input id={priceId} className={styles.priceInput} type="number" inputMode="numeric" min={MINIMUM_PRICE} max={MAXIMUM_PRICE} step={1} value={price}
            aria-invalid={wrong ? true : undefined} aria-describedby={wrong ? `${hintId} ${errorId}` : hintId} onChange={event => setPrice(event.target.value)} />
          <p id={hintId} className={styles.hint}>{PRICE_HINT}</p>
          {problem && <p id={errorId} className={styles.problem} role="status">{problem === 'low' ? LOWEST_PRICE_TEXT : WHOLE_PRICE_TEXT}</p>}
          <div className={styles.terms} aria-live="polite">
            <p>{npcValueText(item, rules)}</p>
            {valid && <>
              <p>{`Buyer pays: ${money(value)}`}</p>
              <p>{`Market fee (${MARKET_FEE_TERMS}): ${money(marketFee(value))}`}</p>
              <p className={styles.receive}>{`You receive: ${money(sellerReceives(value))}`}</p>
            </>}
          </div>
          {atLimit && <p id={limitId} className={styles.problem} role="status">{`You have ${MAXIMUM_LISTINGS} active listings, the most allowed. Cancel one to list another.`}</p>}
          <button type="button" className={styles.listButton} disabled={!valid || atLimit} aria-disabled={busy || undefined} aria-describedby={listReasons || undefined}
            onClick={() => { if (!busy && valid && !atLimit) onList(item, value); }}>List for sale</button>
        </div>
      </article> : <div className={styles.emptyCard}><p>Choose an item from the grid to list it.</p></div>}
    </section>
  </div>;
}

/** A visitor's way in: browsing needs no account, trading needs Google sign-in (the mockup's "Sign in to trade"). */
function TradeSignIn({ fixture }: { fixture: boolean }) {
  const { busy, failed, begin } = useGoogleSignIn();
  return <div className={styles.signIn}>
    <button type="button" className={styles.google} disabled={fixture || busy} onClick={() => void begin()}>
      <GoogleMark /><span>{busy ? 'Opening Google…' : 'Sign in with Google to trade'}</span>
    </button>
    {fixture && <p className="muted">This preview cannot sign in.</p>}
    {failed && <p role="alert">{SIGN_IN_NOT_STARTED}</p>}
  </div>;
}

export function MarketPanel({ reads, gateway, owner, viewer, clock, refreshOwner, fixture, onProfile, rules = RULES_V1 }: {
  reads: MarketReader;
  /** The command gateway: a player's only (null otherwise), so no other viewer can send a command. */
  gateway: GameGateway | null;
  owner: OwnerState | null;
  viewer: Viewer;
  clock: DisplayClock;
  refreshOwner(): Promise<void>;
  /** The fixture preview: browsing works, actions say they are unavailable. */
  fixture: boolean;
  /** Opens a seller's profile card by their gladiator id (Task 26's View profile; the shell's `openRow`). */
  onProfile?(gladiatorId: string, name: string): void;
  /** The active rules (Patch 1.6): the NPC values the offers and the Sell form compare against. */
  rules?: Rules;
}) {
  const trader = viewer === 'player' && owner !== null;
  const [tab, setTab] = useState<Tab>('browse');
  const shown: Tab = trader ? tab : 'browse';
  const [chip, setChip] = useState<Chip>('All');
  const mine = trader && chip === 'Mine';
  const [query, setQuery] = useState(''), [sort, setSort] = useState<SortKey>('newest');
  const now = useNow(clock);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(false);
  const [confirming, setConfirming] = useState<MarketListing | null>(null);
  const attempt = useRef<Attempt | null>(null), sending = useRef(false), mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const tabsId = useId(), confirmId = useId();
  // A trade sent by keyboard gives the focus to its receipt or its reason when its control leaves (Task 23.5, C18): a bought
  // or cancelled listing's row, with its button, leaves the refreshed page. A pointer trade moves nothing (`useOutcomeFocus`).
  const { outcome, begin, end, target } = useOutcomeFocus(busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (confirming && !dialog.current?.open) dialog.current?.showModal(); }, [confirming]);
  // The owner is read through the latest `refreshOwner`, whose identity may change, without reading again for that.
  const latestRefresh = useRef(refreshOwner);
  useEffect(() => { latestRefresh.current = refreshOwner; });
  const [owners] = useState(() => ownerReads(() => latestRefresh.current()));
  useEffect(() => { if (trader) void owners.open(); }, [owners, trader]);
  const refreshTrader = trader ? () => void owners.refresh() : undefined;

  const available = owner ? owner.wallets.money - owner.reservedFees.money : 0;
  const full = owner ? owner.inventory.length >= owner.inventoryCapacity : false;
  const listings = owner ? activeListings(owner) : 0;

  /** After a settled command: the page and the owner are read again (a failed owner read keeps the last one shown). */
  const settle = useCallback(async () => {
    setVersion(v => v + 1);
    await refreshOwner().catch(() => undefined);
  }, [refreshOwner]);

  async function send(intent: Intent, name: string, price: number) {
    if (sending.current) return;
    if (fixture || !gateway || !trader) { setMessage(PREVIEW); return; }
    const comparable = (value: Intent | MarketCommand) => { const { operationId: _id, ...rest } = value as MarketCommand; return JSON.stringify(rest); };
    const previous = attempt.current;
    const command = previous && comparable(previous.command) === comparable(intent) ? previous.command
      : { ...intent, operationId: crypto.randomUUID() } as MarketCommand;
    attempt.current = { command, name, price };
    begin();
    sending.current = true; setBusy(true); setError(''); setMessage(''); setRetry(false);
    try {
      const result = await gateway.command<{ price?: number }>(command);
      if (!mounted.current) return;
      if (result.ok) {
        attempt.current = null;
        setMessage(command.kind === 'buy-listing'
          ? `Purchase confirmed: ${name} for ${money(typeof result.value?.price === 'number' ? result.value.price : price)}, now in your inventory. Receipt ${result.receiptId.slice(0, 8)}.`
          : command.kind === 'create-listing' ? `Listed for sale: ${name} at ${money(price)}. It stays listed for ${LISTING_DAYS} days unless it sells or you cancel it.`
            : `Listing cancelled. ${name} is back in your inventory.`);
        await settle();
      } else {
        const transient = RETRY_CODES.includes(result.code);
        setRetry(transient);
        setError(marketErrorText(result.code, command.kind));
        if (!transient) {
          // A final answer: this operation is over. A stale page (sold, expired, not-found) and every other refusal re-read
          // the listings and the owner, so the panel shows what the server holds now.
          attempt.current = null;
          await settle();
        }
      }
    } catch {
      if (mounted.current) { setError(marketErrorText('unavailable', command.kind)); setRetry(true); }
    } finally { sending.current = false; end(); if (mounted.current) setBusy(false); }
  }

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(t => t.id === shown), last = TABS.length - 1;
    const target = event.key === 'ArrowRight' ? Math.min(last, at + 1) : event.key === 'ArrowLeft' ? Math.max(0, at - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (target === null) return;
    event.preventDefault();
    setTab(TABS[target].id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${TABS[target].id}"]`)?.focus();
  };

  const buy = (listing: MarketListing) => { if (sending.current) return; if (fixture) setMessage(PREVIEW); else setConfirming(listing); };
  const cancel = (listing: MarketListing) => void send({ kind: 'cancel-listing', listingId: listing.listingId }, offerName(listing.item), listing.price);
  const confirmed = () => {
    if (sending.current) return;
    const listing = confirming;
    dialog.current?.close();
    setConfirming(null);
    if (listing) void send({ kind: 'buy-listing', listingId: listing.listingId }, offerName(listing.item), listing.price);
  };
  const access: MarketAccess = trader ? 'trade' : viewer === 'visitor' ? 'sign-in' : 'browse';

  return <div className={styles.market}>
    {viewer === 'visitor' && <p className={`muted ${styles.browsing}`}>Browsing only. Sign in to buy or sell.</p>}
    {viewer === 'no-gladiator' && <p className={styles.create}>Create your gladiator to trade.</p>}
    {trader && <div className={styles.top}>
      <div role="tablist" aria-label="Marketplace sections" className={styles.tabs} onKeyDown={onTabKey}>
        {TABS.map(t => <button key={t.id} type="button" role="tab" id={`${tabsId}-${t.id}`} data-tab={t.id} aria-selected={t.id === shown}
          aria-controls={`${tabsId}-panel`} tabIndex={t.id === shown ? 0 : -1} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <div className={styles.wallet}>
        <p><CurrencyIcon currency="money" size={14} />{`Available gold: ${amount(available)}`}</p>
        <p className="muted">{`Inventory ${owner.inventory.length} / ${owner.inventoryCapacity} slots`}</p>
      </div>
    </div>}
    {message && <p ref={outcome} className={styles.message} role="status" tabIndex={-1} {...target}>{message}</p>}
    {error && <p ref={outcome} className={styles.error} role="alert" tabIndex={-1} {...target}>{error}</p>}
    {retry && <button type="button" className={styles.retry} disabled={busy}
      onClick={() => { const kept = attempt.current; if (kept) void send(kept.command, kept.name, kept.price); }}>Retry request</button>}
    <div className={styles.panel} id={`${tabsId}-panel`} role={trader ? 'tabpanel' : undefined} aria-labelledby={trader ? `${tabsId}-${shown}` : undefined}>
      {shown === 'browse' && <>
        <ItemSearch query={query} setQuery={setQuery} sorts={MARKET_SORTS} sort={sort} setSort={setSort} label="Search the Marketplace" sortLabel="Sort the Marketplace" />
        <div className={styles.chips} role="group" aria-label="Marketplace filters">
          {ITEM_FILTERS.map(option => <button key={option} type="button" aria-pressed={chip === option} onClick={() => setChip(option)}>{option}</button>)}
          {trader && <button type="button" aria-pressed={mine} onClick={() => setChip('Mine')}>My listings
            <span className={styles.chipCount} aria-hidden="true">{listings}</span><span className={styles.sr}>{` (${listings})`}</span></button>}
        </div>
        {/* Keyed by whose listings it reads, so My listings starts empty ("Loading listings…") instead of showing the last list. */}
        <OfferList key={mine ? 'mine' : 'all'} reads={reads} seller={mine && owner ? owner.gladiatorId : null} version={version} access={access} ownerId={owner?.gladiatorId ?? null}
          now={now} busy={busy} onBuy={buy} onCancel={cancel} onProfile={onProfile ? listing => onProfile(listing.seller.gladiatorId, listing.seller.name) : undefined}
          onSell={() => setTab('sell')} onClearQuery={() => setQuery('')} query={query} sort={sort} filter={chip === 'Mine' ? 'All' : chip} mine={mine}
          available={trader ? available : null} full={trader && full} onRefresh={refreshTrader} rules={rules} />
      </>}
      {shown === 'sell' && owner && <SellForm owner={owner} busy={busy} rules={rules} onList={(item, price) => void send({ kind: 'create-listing', itemId: item.id, price }, itemName(item), price)} />}
    </div>
    {viewer === 'visitor' && <TradeSignIn fixture={fixture} />}
    {trader && <dialog ref={dialog} className={styles.confirm} aria-labelledby={confirmId} onClose={() => setConfirming(null)}>
      <h2 id={confirmId}>Confirm purchase</h2>
      {confirming && <>
        <p>{`Buy ${offerName(confirming.item)} (${itemGrade(confirming.item)}) from ${confirming.seller.name} for ${money(confirming.price)}?`}</p>
        <p className="muted">{`Available gold after the purchase: ${money(Math.max(0, available - confirming.price))}.`}</p>
      </>}
      <div className={styles.actions}>
        <button type="button" autoFocus onClick={() => { dialog.current?.close(); setConfirming(null); }}>Keep browsing</button>
        <button type="button" className={styles.primary} aria-disabled={busy || undefined} onClick={confirmed}>Confirm purchase</button>
      </div>
    </dialog>}
  </div>;
}
