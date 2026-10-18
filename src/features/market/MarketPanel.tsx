'use client';

// The 💰 Marketplace menu (Task 18 plan Decision 11; full-screen camp spec "Menus": a player buys, sells, lists and cancels;
// a visitor browses listings only). Three tabs for a player:
// - Browse: the open offers, newest first, 50 at a time with "More". Each shows the item, its tier, rarity and stats, the
//   seller, the price, the NPC sale value for comparison and the time left. Buy asks for confirmation first.
// - My listings: the player's own open offers (the seller-filtered read), each with Cancel.
// - Sell: the items that can be listed (equipment only: tradable, not renown, bound, equipped, held by a pending build or
//   reserved), a whole price, and the 5% fee and the NPC sale value shown before listing.
// A visitor sees Browse only, with "Sign in with Google to trade"; a signed-in account without a gladiator sees Browse only,
// with "Create your gladiator to trade". Neither ever sees a wallet or a trading control, and neither can send a command:
// the shell gives this panel the command gateway for a player only.
//
// Commands follow InventoryPanel's retry rules: an identical retry keeps its operation id after `processing`,
// `unavailable` or `rate-limited` (or a lost response), so a retry after a rolled-back deadlock replays the same operation
// (Ruling 3); any other answer ends that operation. A purchase on a stale page (`sold`, `expired`, `not-found`) is
// explained and the page and the owner are refreshed (Review Focus 4). Offers load on demand: each time the menu opens, a
// tab is shown, a command settles or Refresh is pressed. Names render as React text.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { GameCommand } from '@contracts/commands';
import type { ItemInstance, MarketListing, OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import type { Viewer } from '../character/useGameState';
import { GoogleMark, SIGN_IN_NOT_STARTED, useGoogleSignIn } from '../auth/SignIn';
import {
  MARKET_FEE_PERCENT, MAXIMUM_LISTINGS, MAXIMUM_PRICE, RETRY_CODES, activeListings, amount, itemGrade, itemIcon, itemName, itemStats,
  listableItems, marketErrorText, marketFee, money, npcValueText, sellerReceives, timeLeft, validPrice, type MarketKind,
} from './market-text';
import styles from './MarketPanel.module.css';

const PAGE_ROWS = 50;
/** The time left is shown in whole minutes: redraw twice a minute while the tab is visible. */
const TICK_MS = 30_000;
const LISTING_DAYS = RULES_V1.marketplace.expiryMs / 86_400_000;
const PREVIEW = 'Actions are unavailable in this preview.';

export type MarketReader = Pick<GameGateway, 'market'>;
export type OffersList = { rows: MarketListing[]; nextCursor: string | null };
export type OffersModel = OffersList & { status: 'loading' | 'ready' | 'failed' };

type MarketCommand = Extract<GameCommand, { kind: MarketKind }>;
type Intent = { kind: 'create-listing'; itemId: string; price: number } | { kind: 'cancel-listing'; listingId: string } | { kind: 'buy-listing'; listingId: string };
/** The command being sent or kept for a retry, with the words its outcome is told in. */
type Attempt = { command: MarketCommand; name: string; price: number };
type Tab = 'browse' | 'mine' | 'sell';
const TABS: readonly { id: Tab; label: string }[] = [{ id: 'browse', label: 'Browse' }, { id: 'mine', label: 'My listings' }, { id: 'sell', label: 'Sell' }];

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

/** Pure view of a list of offers: Browse's (`action` buy, or null for a viewer who cannot trade) or My listings' (cancel). */
export function MarketOffers({ model, action, ownerId, now, busy, onAction, onMore, onRetry, loadingMore = false, moreFailed = false,
  label = 'Open listings', empty = 'No open listings right now.', available = null, full = false }: {
  model: OffersModel;
  action: 'buy' | 'cancel' | null;
  /** The viewer's gladiator, whose own offers say "Your listing" and offer no Buy; null for a visitor. */
  ownerId: string | null;
  /** The display time, for each offer's time left. */
  now: number;
  busy: boolean;
  onAction(listing: MarketListing): void;
  onMore(): void;
  onRetry(): void;
  loadingMore?: boolean;
  moreFailed?: boolean;
  label?: string;
  empty?: string;
  /** A buyer's available money: a dearer offer cannot be bought. */
  available?: number | null;
  /** A buyer's inventory has no free slot. */
  full?: boolean;
}) {
  const { rows, status } = model;
  return <div className={styles.offers}>
    {status === 'failed' && rows.length === 0
      ? <div className={styles.failed} role="alert"><p>Listings could not be loaded right now.</p><button type="button" onClick={onRetry}>Try again</button></div>
      : status === 'loading' && rows.length === 0 ? <p className="muted" role="status">Loading listings…</p>
        : rows.length === 0 ? <p className="muted" role="status">{empty}</p>
          : <ul className={styles.list} aria-label={label}>{rows.map(row => {
            const name = itemName(row.item), own = row.seller.gladiatorId === ownerId, expired = row.expiresAtMs <= now;
            const poor = available !== null && row.price > available;
            const blocked = action === 'buy' && !own && !expired ? (poor ? 'Not enough available money' : full ? 'Your inventory is full' : null) : null;
            return <li key={row.listingId} className={styles.offer} data-testid={`listing-${row.listingId}`}>
              <div className={styles.what}>
                <p className={styles.name}><span className={styles.icon} aria-hidden="true">{itemIcon(row.item)}</span>{name}
                  {own && action === 'buy' && <span className={styles.yours}>Your listing</span>}</p>
                <p className={styles.detail}>{`${row.seller.name} · ${timeLeft(row.expiresAtMs, now)}`}</p>
                <p className={styles.detail}>{`${itemGrade(row.item)} · ${itemStats(row.item)}`}</p>
                <p className={styles.detail}>{npcValueText(row.item)}</p>
                {action === 'cancel' && <p className={styles.detail}>{`You receive ${money(sellerReceives(row.price))} after the ${MARKET_FEE_PERCENT}% fee`}</p>}
                {blocked && <p className={styles.blocked}>{blocked}</p>}
              </div>
              <div className={styles.deal}>
                <p className={styles.price}><span aria-hidden="true">💰 </span>{amount(row.price)}<span className={styles.sr}> money</span></p>
                {action === 'buy' && !own && <button type="button" className={styles.act} disabled={busy || expired || blocked !== null}
                  aria-label={`Buy ${name} for ${money(row.price)}`} onClick={() => onAction(row)}>Buy</button>}
                {action === 'cancel' && <button type="button" className={styles.act} disabled={busy}
                  aria-label={`Cancel listing: ${name} for ${money(row.price)}`} onClick={() => onAction(row)}>Cancel</button>}
              </div>
            </li>;
          })}</ul>}
    {status === 'failed' && rows.length > 0 && <p className={styles.failedNote} role="alert">The listings could not be refreshed. Showing the last ones read.</p>}
    {model.nextCursor && <button type="button" className={styles.more} onClick={onMore} disabled={loadingMore}>More</button>}
    {moreFailed && <p className={styles.failedNote} role="alert">More listings could not be loaded. Please try again.</p>}
  </div>;
}

/** One list of offers, read on demand: anyone's (`seller` null) or one seller's. `version` changes re-read it. */
function OfferList({ reads, seller, version, ...view }: {
  reads: MarketReader; seller: string | null; version: number;
} & Omit<Parameters<typeof MarketOffers>[0], 'model' | 'onMore' | 'onRetry' | 'loadingMore' | 'moreFailed'>) {
  const [list, setList] = useState<OffersList | null>(null);
  const [status, setStatus] = useState<OffersModel['status']>('loading');
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  /** The current read generation: a page that arrives for an older one (a refresh, another seller) is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setStatus('loading');
    setLoadingMore(false);
    setMoreFailed(false);
    readOffers(reads, seller, null).then(
      next => { if (mine === generation.current) { setList(next); setStatus('ready'); } },
      () => { if (mine === generation.current) setStatus('failed'); },
    );
    return () => { generation.current += 1; };
  }, [reads, seller, version, attempt]);

  const more = useCallback(async () => {
    if (!list?.nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const next = await readOffers(reads, seller, list);
      if (mine === generation.current) setList(next);
    } catch {
      // The offers already shown stay, and More stays for another try.
      if (mine === generation.current) setMoreFailed(true);
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  }, [list, loadingMore, reads, seller]);

  return <>
    <div className={styles.listHead}>
      <p className="eyebrow">{seller ? 'YOUR OPEN LISTINGS' : 'OPEN LISTINGS · NEWEST FIRST'}</p>
      <button type="button" className={styles.refresh} onClick={() => setAttempt(n => n + 1)} disabled={status === 'loading'}>Refresh</button>
    </div>
    <MarketOffers {...view} model={{ rows: list?.rows ?? [], nextCursor: list?.nextCursor ?? null, status }} onMore={() => void more()}
      onRetry={() => setAttempt(n => n + 1)} loadingMore={loadingMore} moreFailed={moreFailed} />
  </>;
}

/** The Sell tab: choose an item that can be listed, set a whole price, and see the fee, the credit and the NPC value. */
function SellForm({ owner, busy, onList }: { owner: OwnerState; busy: boolean; onList(item: ItemInstance, price: number): void }) {
  const items = listableItems(owner);
  const [chosen, setChosen] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const group = useId(), priceId = useId(), hintId = useId();
  const item = items.find(i => i.id === chosen) ?? null;
  const value = Number(price), valid = price.trim() !== '' && validPrice(value);
  const count = activeListings(owner), atLimit = count >= MAXIMUM_LISTINGS;
  return <div className={styles.sell}>
    <p className={styles.count}>{`Active listings: ${count} of ${MAXIMUM_LISTINGS}`}</p>
    <p className="muted">{`No listing fee. When an item sells, a ${MARKET_FEE_PERCENT}% sale fee (rounded down) is kept from the price. A listing lasts ${LISTING_DAYS} days; cancel it any time to take the item back.`}</p>
    {items.length === 0
      ? <p className={styles.nothing}>Nothing to list right now. Only free, tradable equipment can be listed: not equipped or reserved items, account-bound or renown gear, or salvage.</p>
      : <>
        <fieldset className={styles.items}>
          <legend>Item to list</legend>
          {items.map(i => <label key={i.id} className={styles.choice}>
            <input type="radio" name={group} value={i.id} checked={chosen === i.id} onChange={() => setChosen(i.id)} />
            <span className={styles.choiceText}><span className={styles.name}><span className={styles.icon} aria-hidden="true">{itemIcon(i)}</span>{itemName(i)}</span>{' '}
              <span className={styles.detail}>{`${itemGrade(i)} · ${itemStats(i)}`}</span></span>
          </label>)}
        </fieldset>
        <label className={styles.priceLabel} htmlFor={priceId}>Price in money</label>
        <input id={priceId} className={styles.priceInput} type="number" inputMode="numeric" min={1} max={MAXIMUM_PRICE} step={1} value={price}
          aria-describedby={hintId} onChange={event => setPrice(event.target.value)} />
        <p id={hintId} className="muted">{`A whole price from 1 to ${amount(MAXIMUM_PRICE)}.`}</p>
        {price.trim() !== '' && !valid && <p className={styles.blocked} role="status">{`Enter a whole price from 1 to ${amount(MAXIMUM_PRICE)}.`}</p>}
        {item && <div className={styles.terms} aria-live="polite">
          <p>{npcValueText(item)}</p>
          {valid && <>
            <p>{`Sale fee (${MARKET_FEE_PERCENT}%): ${money(marketFee(value))}`}</p>
            <p className={styles.receive}>{`You receive: ${money(sellerReceives(value))}`}</p>
          </>}
        </div>}
        {atLimit && <p className={styles.blocked} role="status">{`You have ${MAXIMUM_LISTINGS} active listings, the most allowed. Cancel one to list another.`}</p>}
        <button type="button" className={styles.primary} disabled={busy || !item || !valid || atLimit} onClick={() => { if (item && valid) onList(item, value); }}>List for sale</button>
      </>}
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

export function MarketPanel({ reads, gateway, owner, viewer, clock, refreshOwner, fixture }: {
  reads: MarketReader;
  /** The command gateway: a player's only (null otherwise), so no other viewer can send a command. */
  gateway: GameGateway | null;
  owner: OwnerState | null;
  viewer: Viewer;
  clock: DisplayClock;
  refreshOwner(): Promise<void>;
  /** The fixture preview: browsing works, actions say they are unavailable. */
  fixture: boolean;
}) {
  const trader = viewer === 'player' && owner !== null;
  const [tab, setTab] = useState<Tab>('browse');
  const shown: Tab = trader ? tab : 'browse';
  const now = useNow(clock);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(false);
  const [confirming, setConfirming] = useState<MarketListing | null>(null);
  const attempt = useRef<Attempt | null>(null), sending = useRef(false), mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const tabsId = useId(), confirmId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (confirming && !dialog.current?.open) dialog.current?.showModal(); }, [confirming]);

  const available = owner ? owner.wallets.money - owner.reservedFees.money : 0;
  const full = owner ? owner.inventory.length >= owner.inventoryCapacity : false;

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
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
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

  const buy = (listing: MarketListing) => { if (fixture) setMessage(PREVIEW); else setConfirming(listing); };
  const confirmed = () => {
    const listing = confirming;
    dialog.current?.close();
    setConfirming(null);
    if (listing) void send({ kind: 'buy-listing', listingId: listing.listingId }, itemName(listing.item), listing.price);
  };

  return <div className={styles.market}>
    {viewer === 'visitor' && <p className={`muted ${styles.browsing}`}>Browsing only. Sign in to buy or sell.</p>}
    {viewer === 'no-gladiator' && <p className={styles.create}>Create your gladiator to trade.</p>}
    {trader && <div className={styles.wallet}>
      <p>{`Available money: ${amount(available)}`}</p>
      <p className="muted">{`Inventory ${owner.inventory.length} / ${owner.inventoryCapacity} slots`}</p>
    </div>}
    {trader && <div role="tablist" aria-label="Marketplace sections" className={styles.tabs} onKeyDown={onTabKey}>
      {TABS.map(t => <button key={t.id} type="button" role="tab" id={`${tabsId}-${t.id}`} data-tab={t.id} aria-selected={t.id === shown}
        aria-controls={`${tabsId}-panel`} tabIndex={t.id === shown ? 0 : -1} onClick={() => setTab(t.id)}>{t.label}</button>)}
    </div>}
    <div className={styles.panel} id={`${tabsId}-panel`} role={trader ? 'tabpanel' : undefined} aria-labelledby={trader ? `${tabsId}-${shown}` : undefined}>
      {shown === 'browse' && <OfferList reads={reads} seller={null} version={version} action={trader ? 'buy' : null} ownerId={owner?.gladiatorId ?? null}
        now={now} busy={busy} onAction={buy} available={trader ? available : null} full={trader && full} />}
      {shown === 'mine' && owner && <>
        <p className="muted">{`A listing lasts ${LISTING_DAYS} days. Cancel it, or let it expire, to return the item to your inventory.`}</p>
        <OfferList reads={reads} seller={owner.gladiatorId} version={version} action="cancel" ownerId={owner.gladiatorId} now={now} busy={busy}
          label="Your open listings" empty="You have no open listings."
          onAction={listing => void send({ kind: 'cancel-listing', listingId: listing.listingId }, itemName(listing.item), listing.price)} />
      </>}
      {shown === 'sell' && owner && <SellForm owner={owner} busy={busy} onList={(item, price) => void send({ kind: 'create-listing', itemId: item.id, price }, itemName(item), price)} />}
    </div>
    {message && <p className={styles.message} role="status">{message}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {retry && <button type="button" className={styles.retry} disabled={busy}
      onClick={() => { const kept = attempt.current; if (kept) void send(kept.command, kept.name, kept.price); }}>Retry request</button>}
    {viewer === 'visitor' && <TradeSignIn fixture={fixture} />}
    {trader && <dialog ref={dialog} className={styles.confirm} aria-labelledby={confirmId} onClose={() => setConfirming(null)}>
      <h2 id={confirmId}>Confirm purchase</h2>
      {confirming && <>
        <p>{`Buy ${itemName(confirming.item)} (${itemGrade(confirming.item)}) from ${confirming.seller.name} for ${money(confirming.price)}?`}</p>
        <p className="muted">{`Available money after the purchase: ${money(Math.max(0, available - confirming.price))}.`}</p>
      </>}
      <div className={styles.actions}>
        <button type="button" autoFocus onClick={() => { dialog.current?.close(); setConfirming(null); }}>Keep browsing</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={confirmed}>Confirm purchase</button>
      </div>
    </dialog>}
  </div>;
}
