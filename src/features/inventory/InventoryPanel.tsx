'use client';

// The Inventory and shops menu: the bag (search, sort and the chips over an icon grid, the chosen piece's card, what is worn now) and the
// Shops (`ShopPanel`). Patch 1.9 Task 33 (menus with Back and Next, the approved paged-menus mockup): two named sections, Inventory and
// Shops, under the strip; a merchant's stall and "Open Buy back" open the Shops. The grid shows one page of whole rows (`useGridPage`).
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { EquipmentSlot, GameCommand } from '@contracts/commands';
import type { BuyBackEntry, ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { npcSaleValue, type Merchant } from '@domain/inventory';
import { RULES_V1 } from '@domain/rules-v1';
import type { Rules } from '@domain/types';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { useClockMode } from '../../lib/clock-setting';
import { slotTimeText } from '../schedule/slot-time';
import { useMinuteNow } from '../schedule/use-minute-now';
import { ShopPanel } from '../shops/ShopPanel';
import { afterSaleLine, buyBackSales, plainSaleLine } from '../shops/buy-back';
import { useOutcomeFocus } from '../shell/focus-lost';
import { useSectionChange } from '../shell/section-change';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
import { SectionStrip, type Section } from '../paging/SectionPager';
import { pageOfIndex } from '../paging/paging';
import { usePagedList } from '../paging/usePagedList';
import { gridColumns, rowFill, useGridPage } from './grid-page';
import { usePhoneCard } from './phone-card';
import { ItemIcon, ItemStats } from './ItemPresentation';
import { ItemSearch, MatchCount, NoMatch } from './ItemSearch';
import { groupStacks, isStackable, joinsStack, stackSaleItems, type StackTile } from './stacks';
import { INVENTORY_SORTS, queryItems, type Queryable, type SortKey } from './item-query';
import {
  GEAR_SLOTS, SLOT_LABELS, blockedText, cancelGearCommand, changedSlots, gearRefusal, isWearable, keepsOtherChanges, nextEquipment, pendingNote,
  undoCommand, wearBadge, wearBadgeText, wearCommand, wearState, wornNow, type GearCommand,
} from './gear';
import styles from './InventoryPanel.module.css';

type InventoryCommand = Extract<GameCommand, { kind: 'buy-shop' | 'sell-item' | 'discard-item' | 'buy-back' }>;
type Intent = Omit<Extract<InventoryCommand, { kind: 'buy-shop' }>, 'operationId'> | Omit<Extract<InventoryCommand, { kind: 'sell-item' | 'discard-item' }>, 'operationId'>
  | Omit<Extract<InventoryCommand, { kind: 'buy-back' }>, 'operationId'>;
const filters = ['All', 'Weapons', 'Armor', 'Materials'] as const;
type Filter = typeof filters[number];
const itemName = (item: ItemInstance) => item.catalogId === 'salvage' ? 'Salvage' : CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId;
/** A piece's level and rarity: two pieces of one kind share a name, and this tells them apart. */
const itemDetail = (item: ItemInstance) => `Level ${item.tier} · ${item.rarity}`;
const itemBinding = (item: ItemInstance) => item.binding === 'bound' ? 'Account-bound' : 'Tradable';
/** A material (salvage) is one piece with its own quantity; every other piece is one item. */
const isMaterial = (item: ItemInstance) => item.catalogId === CATALOG_V1.salvage.id || item.quantity > 1;
/** Why a refused sale was refused, as one clause of the partial result ("Sale 2 was refused: <reason>"). */
const saleReason = (code: string) => code === 'invalid' ? 'that piece is reserved' : code === 'conflict' ? 'your inventory changed' : code === 'not-found' ? 'that item is no longer in your inventory'
  : code === 'processing' ? 'the world is processing previous results' : code === 'unavailable' ? 'the request could not be confirmed'
    : code === 'rate-limited' ? 'too many requests, try again shortly' : code === 'sold' ? 'it was sold on the Marketplace'
      : code === 'expired' ? 'its Marketplace listing expired' : `the server answered ${code}`;
/**
 * What a refused buy back says (patch 1.9): a sale the server no longer lists (an earlier game day, outside the last 10, bought back) and a
 * stale preparation both read the list again; gold and the bag in the card's own words. Null: the trade's words.
 */
const buyBackRefusal = (code: string) => code === 'expired' || code === 'not-found' ? 'This sale can no longer be bought back. The list is up to date.'
  : code === 'conflict' ? 'Your items changed. Review the updated list and try again.'
    : code === 'insufficient-funds' ? 'Not enough available gold. Held fees cannot be spent.'
      : code === 'inventory-full' ? 'Your bag is full. Free a slot and try again.' : null;
/** What a refused command says: a gear change in the gear's words (`gearRefusal`), a buy back in its own, a trade in its own. */
const refusalText = (gear: boolean, code: string, kind?: string) => gear ? gearRefusal(code) : (kind === 'buy-back' && buyBackRefusal(code))
  || (code === 'processing' ? 'The world is processing previous results. Retry shortly.'
  : code === 'unavailable' ? 'This request could not be confirmed. Retry the same request.'
    : code === 'inventory-full' ? 'Your inventory is full. Clear enough slots and try again.'
      : code === 'insufficient-funds' ? 'Not enough available currency. Held fees cannot be spent.'
        : code === 'conflict' ? 'Your inventory changed or this cosmetic is already owned. Review the refreshed state.'
          : code === 'sold' ? 'This item was sold on the Marketplace. Review the refreshed inventory.'
            : code === 'expired' ? 'Its Marketplace listing has expired and the item is back. Review the refreshed inventory.'
              : `Request rejected: ${code}.`);
/** What `send` tells a caller that waits for it: whether the server took the command, or why not; null when it was not sent. */
type Sent = { ok: true } | { ok: false; code: string } | null;
const itemLabel = (item: ItemInstance) => `${itemName(item)}, level ${item.tier} ${item.rarity}`;
const isReserved = (owner: OwnerState, item: ItemInstance) => item.reservation !== null || !!owner.pendingBuild?.reservedItemIds.includes(item.id);

/** What search and sort read from a piece in the bag: its name, level, stats and what an NPC pays for it. */
function itemView(item: ItemInstance): Queryable {
  return { name: itemName(item), level: item.tier, damage: item.stats.damage, armor: item.stats.armor, weight: item.stats.weight, sell: npcSaleValue(item, CATALOG_V1) };
}

function matchesFilter(item: ItemInstance, filter: Filter) {
  const slot = CATALOG_V1.items[item.catalogId]?.slot;
  return filter === 'All' || (filter === 'Weapons' && slot === 'weapon')
    || (filter === 'Armor' && slot !== undefined && slot !== 'weapon') || (filter === 'Materials' && item.catalogId === 'salvage');
}

/** Patch 1.9 Task 33: the menu's two named sections (the approved paged-menus mockup). */
export const INVENTORY_SECTIONS: readonly Section[] = [{ id: 'inventory', name: 'Inventory' }, { id: 'shops', name: 'Shops' }];
const SHOPS = 1;
/** An outcome line held in its place while the next command is on its way (Task 33 fix round 1): nothing moves until the new line comes. */
type HeldOutcome = { place: string; message: string; error: string; retry: boolean; sold: boolean };

export function InventoryPanel({ owner, gateway, refresh, clock, preview = false, initialMerchant, merchantRequest = 0, rules = RULES_V1 }: {
  owner: OwnerState; gateway: GameGateway; refresh(): Promise<void>; clock: DisplayClock; preview?: boolean;
  /** The active rules (Patch 1.6): what an NPC merchant pays for salvage (10 gold a unit under v1, 4 under v2); gear values stay. */
  rules?: Rules;
  /** Opens the shops at this merchant's tab (a click on the merchant in the camp). */
  initialMerchant?: Merchant;
  /** Counts merchant clicks: each one opens the shops at `initialMerchant` again, even the same merchant's. */
  merchantRequest?: number;
}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  /** Patch 1.9: the last outcome was a gear sale, so it offers "Open Buy back"; and how many times that was pressed (the Shops open on Buy back). */
  const [sold, setSold] = useState(false), [buyBackRequest, setBuyBackRequest] = useState(0);
  const [confirmation, setConfirmation] = useState<{ itemId: string; quantity: number } | 'stale' | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>('All');
  const [query, setQuery] = useState(''), [sort, setSort] = useState<SortKey>('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  /** A sale of several pieces in progress: one `sell-item` per piece, in a row (`sellTile`). */
  const [selling, setSelling] = useState<{ key: string; name: string; done: number; total: number } | null>(null);
  const [held, setHeld] = useState<HeldOutcome | null>(null);
  /** Where the outcome shows now (`place` below), for the held line. */
  const shownPlace = useRef('trade');
  const sellLock = useRef(false), ownerNow = useRef(owner);
  ownerNow.current = owner;
  /**
   * Where the outcome shows: in the card of the piece a swap was sent from, under the gear row for "Cancel changes", after the
   * items for a trade. The player is looking at the control they used, so a refusal is read where it happened.
   */
  const [where, setWhere] = useState<string>('trade');
  const attempt = useRef<InventoryCommand | GearCommand | null>(null), sending = useRef(false), mounted = useRef(false);
  /** What the command in `attempt` says when it succeeds: kept with it, so a retry says the same. */
  const success = useRef('');
  const dialog = useRef<HTMLDialogElement>(null);
  const staleDiscardNotice = useRef<HTMLParagraphElement>(null);
  const panelId = useId(), gearHeading = `${panelId}-gear`, previewNote = `${panelId}-preview`;
  const detailsId = `${panelId}-details`;
  // Identical pieces share a tile (`groupStacks`); search, the filters and every sort read a tile by its first piece, and "Newest" is the bag's order.
  const tiles = groupStacks(owner.inventory, item => isStackable(owner, item));
  const visibleTiles = queryItems(tiles.filter(tile => matchesFilter(tile.items[0], filter)), tile => itemView(tile.items[0]), query, sort);
  const visibleCount = visibleTiles.reduce((total, tile) => total + tile.items.length, 0);
  // A search with no match under a chip that hides matches All would show says so ("No match for “sword” in Armor").
  const hiddenBy = !visibleTiles.length && query.trim() && filter !== 'All' && queryItems(tiles, tile => itemView(tile.items[0]), query, sort).length ? filter : undefined;
  const selected = visibleTiles.find(tile => tile.items.some(item => item.id === selectedId)) ?? visibleTiles[0];
  // Remember the displayed fallback so a refresh cannot replace a still-visible selection. With nothing shown (a search or a chip
  // with no match) the choice is kept, so clearing the search brings it back, as the Shops do (Task 21).
  if (selected && selectedId !== selected.key) setSelectedId(selected.key);
  // Patch 1.9 Task 33: the menu's sections (Inventory, Shops); a merchant's click opens on Shops, and so does "Open Buy back".
  const [section, setSection] = useState(initialMerchant ? SHOPS : 0);
  const shownMerchant = useRef(merchantRequest);
  if (shownMerchant.current !== merchantRequest) { shownMerchant.current = merchantRequest; if (initialMerchant && section !== SHOPS) setSection(SHOPS); }
  const sectionsRef = useRef<HTMLDivElement>(null);
  useSectionChange(section, sectionsRef, merchantRequest);
  // The grid shows one page of whole rows (24 or 15 tiles, `useGridPage`). Fix round 1 (the coordinator's ruling): the tiles page, and only the
  // last page is padded with free slots to whole rows, so no page holds free slots only (the "N / 60 slots" line says the bag). Search, sort
  // and the chips go back to page 1; the chosen piece stays chosen across pages, and when a change keeps it on another page, that page shows
  // (as the chosen piece was brought into view in the grid before the pages, never moving the focus).
  const panelRef = useRef<HTMLDivElement>(null);
  const gridPage = useGridPage(panelRef);
  const paged = usePagedList(visibleTiles, { size: gridPage, resetKey: `${filter}|${query}|${sort}` });
  // The free slots that finish the page's last row: no more than the bag's free slots in All, as before the pages.
  const fill = rowFill(paged.rows.length, gridColumns(gridPage));
  const freeCells = filter === 'All' && !query.trim() ? Math.min(fill, Math.max(0, owner.inventoryCapacity - visibleCount)) : fill;
  // Fix round 1 (review Important 1): on a phone the chosen item's card opens over the grid (`usePhoneCard`).
  const phoneCard = usePhoneCard(visibleTiles.length > 0);
  const covered = phoneCard.open;
  // Another section hides the card's (it opens again from a tile).
  useEffect(() => { if (section !== 0) phoneCard.close(false); }, [section, phoneCard.close]);
  const latest = useRef(selected?.key), visibleTilesRef = useRef(visibleTiles), gridPageRef = useRef(gridPage);
  latest.current = selected?.key; visibleTilesRef.current = visibleTiles; gridPageRef.current = gridPage;
  const changedView = useRef(false);
  useEffect(() => {
    if (!changedView.current) { changedView.current = true; return; }
    const at = visibleTilesRef.current.findIndex(tile => tile.key === latest.current);
    if (at >= 0 && pageOfIndex(at, gridPageRef.current) > 1) paged.goToIndex(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, query, sort]);
  const discardRequest = confirmation === 'stale' ? null : confirmation;
  const confirmingItem = discardRequest && owner.inventory.find(item => item.id === discardRequest.itemId);
  const canConfirmDiscard = !!(discardRequest && confirmingItem && !isReserved(owner, confirmingItem) && discardRequest.quantity <= confirmingItem.quantity);
  if (discardRequest && !canConfirmDiscard) setConfirmation('stale');
  /** The shared clock's time to the minute: the queued gear's effective time is shown against it, as the build panel does (Task 23.10). */
  const nowMs = useMinuteNow(clock);
  const clockMode = useClockMode();
  // A trade sent by keyboard gives the focus to its outcome when its control leaves (the sold or discarded item); a pointer
  // trade moves nothing (Task 23.5, `useOutcomeFocus`).
  const { outcome, begin, end, target } = useOutcomeFocus(busy || selling !== null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (confirmation === 'stale') {
      // Close and focus in the same commit. The native dialog may have lost its opener on refresh.
      dialog.current?.close();
      staleDiscardNotice.current?.focus();
    } else if (confirmation && !dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, [confirmation]);
  /** `done` is what a gear change says once it is queued or canceled, and `place` where its outcome shows; the trades and the retry say their own. */
  async function send(intent: Intent | InventoryCommand | GearCommand, done?: string, place?: string, quiet = false): Promise<Sent> {
    if (sending.current || (sellLock.current && !quiet)) return null;
    if (preview) { setMessage('Actions are unavailable in this preview.'); return null; }
    if (confirmation === 'stale') setConfirmation(null);
    const comparable = (value: InventoryCommand | GearCommand | Intent) => { const { operationId: _id, ...rest } = value as InventoryCommand; return JSON.stringify(rest); };
    const again = attempt.current !== null && comparable(attempt.current) === comparable(intent);
    const command = again && attempt.current ? attempt.current : { ...intent, operationId: crypto.randomUUID() } as InventoryCommand | GearCommand;
    if (done !== undefined) success.current = done; else if (!again) success.current = '';
    const gear = command.kind === 'queue-build' || command.kind === 'cancel-build';
    if (!quiet) begin();
    // Fix round 1 (review Important 4): the last outcome keeps its room, unseen, until the new one comes, so nothing moves while this is on its way.
    if (!quiet && (message || error || retry)) setHeld({ place: shownPlace.current, message, error, retry, sold });
    attempt.current = command; sending.current = true; setBusy(true); if (!quiet) { setError(''); setMessage(''); setRetry(false); setSold(false); }
    if (place) setWhere(place); else if (!gear) setWhere('trade');
    try {
      const result = await gateway.command(command);
      if (!mounted.current) return null;
      if (result.ok) {
        await refresh();
        if (mounted.current) {
          attempt.current = null;
          // A gear sale (it has its line: salvage says "Sale confirmed.") offers "Open Buy back", also after a Retry.
          if (!quiet && command.kind === 'sell-item' && success.current) setSold(true);
          if (!quiet) setMessage(success.current || (command.kind === 'buy-shop' ? 'Purchase confirmed.' : command.kind === 'sell-item' ? 'Sale confirmed.'
            : command.kind === 'buy-back' ? 'Bought back.' : 'Item discarded. No gold or renown awarded.'));
        }
        return { ok: true };
      } else {
        const transient = ['processing', 'unavailable', 'rate-limited'].includes(result.code);
        if (!quiet) setRetry(transient);
        if (!quiet) setError(refusalText(gear, result.code, command.kind));
        // A gear change the server finds `invalid` no longer fits the build or the bag (`gearRefusal`): reload them.
        const reload = ['conflict', 'not-found', 'inventory-full', 'sold', 'expired'].includes(result.code) || result.code === 'invalid' || (quiet && result.code === 'unavailable');
        if (!transient && (quiet || !reload)) attempt.current = null;
        if (reload) {
          try { await refresh(); } catch (failure) {
            // A sale in a run is reported by the run (`sellTile`), which reads the bag again and calls the result unknown, as before.
            if (quiet) throw failure;
            // Task 21 (the HANDOFF's pre-existing Retry issue): the refusal stands, but the bag it refers to could not be read again.
            // The command is kept, so Retry resends this very operation (the server answers it again) and reads the bag again; once
            // that read works the refusal stays, with nothing more to retry. Before, the command was dropped here and the "could not
            // be confirmed" Retry that followed sent nothing.
            if (mounted.current) { setError(`${refusalText(gear, result.code, command.kind)} Your latest items could not be loaded. Retry sends it again and reloads your items.`); setRetry(true); }
            return { ok: false, code: result.code };
          }
        }
        if (!transient) attempt.current = null;
        return { ok: false, code: result.code };
      }
    } catch {
      if (mounted.current && !quiet) { setError('This request could not be confirmed. Retry the same request.'); setRetry(true); }
      // A sale in a run whose answer was lost may or may not have happened: read the bag again before the run reports.
      if (quiet) try { await refresh(); } catch { /* the report says the result is unknown */ }
      return { ok: false, code: 'unavailable' };
    } finally { sending.current = false; if (!quiet) end(); if (mounted.current) { setBusy(false); if (!quiet) setHeld(null); } }
  }
  // The gear view: what is worn now, what the queued build changes, and the commands that queue, undo and cancel a swap.
  const worn = wornNow(owner), next = nextEquipment(owner), changed = changedSlots(owner);
  const pieceOf = (id: string | null) => owner.inventory.find(item => item.id === id);
  /** The queued build's effective time ('' when it cannot be shown: the words then say "the next slot"). */
  const effective = owner.pendingBuild ? slotTimeText(owner.pendingBuild.effectiveSlotIndex * RULES_V1.clock.slotMs, nowMs, clockMode) : '';
  const wearItem = (item: ItemInstance, left = 0) => {
    const command = wearCommand(owner, item.id), state = wearState(owner, item);
    void send(command, command.kind === 'cancel-build' ? 'Back to your current gear. No gear change is queued.'
      : state === 'leaving' ? `${itemName(item)} stays worn.` : `${itemName(item)} will be worn from the next slot.${left > 0 ? ` ${left} left in the stack.` : ''}`, item.id);
  };
  const undoItem = (item: ItemInstance, slot: EquipmentSlot) => {
    const back = pieceOf(worn[slot]);
    // A piece that goes back to a stack says so (the approved wording); a single piece says what stays worn.
    void send(undoCommand(owner, slot), joinsStack(owner, item) ? `Swap undone. ${itemName(item)} is back in the stack.`
      : `Swap undone. ${back ? `${itemName(back)} stays worn` : `${SLOT_LABELS[slot]} stays empty`}.`, item.id);
  };
  const cancelGear = () => void send(cancelGearCommand(owner), keepsOtherChanges(owner) ? 'Gear changes canceled. Your other queued build changes are kept.' : 'Gear changes canceled.', 'gear');
  // Command buttons stay focusable while sending (aria-disabled, guarded against activation): a keyboard player keeps the
  // place in the list, and the button that becomes "Undo" or "Wear" is the one they pressed. Cancel changes leaves with its
  // section and gives the focus to the outcome (`useOutcomeFocus`), as do the trades.
  const locked = busy || selling !== null;
  const busyProps = locked ? { 'aria-disabled': true as const } : {};
  /** Keep a gear outcome reachable if the item is no longer shown in the detail card. */
  const place = where === 'trade' || where === 'sale' || where === 'buyback' || selected?.items.some(item => item.id === where) ? where : 'gear';
  shownPlace.current = place;
  /** "Open Buy back" after a sale: the Shops section opens on Buy back, with the focus on its chip. */
  const openBuyBack = () => { setSection(SHOPS); setBuyBackRequest(n => n + 1); };
  /** Final fix wave: an owner read without the Buy back list (an older server) offers no buy back, so a sale offers no "Open Buy back". */
  const offersBuyBack = buyBackSales(owner) !== undefined;
  const outcomes = <>
    {message && (sold && offersBuyBack ? <div className={styles.soldNote}>
      <p ref={outcome} role="status" tabIndex={-1} {...target}>{message}</p>
      <button type="button" className={styles.linkButton} onClick={openBuyBack}>Open Buy back</button>
    </div> : <p ref={outcome} role="status" tabIndex={-1} {...target}>{message}</p>)}
    {error && <p ref={outcome} role="alert" tabIndex={-1} {...target}>{error}</p>}
    {retry && <button disabled={busy} onClick={() => { if (attempt.current) void send(attempt.current, undefined, where); }}>Retry request</button>}
  </>;
  /**
   * The held outcome at `at`: the same lines, unseen and out of reach, keeping their room until the new outcome comes. Each copy has its
   * line's own box: `data-role` takes the style a line's role gives it (the Buy back's boxed lines, fix round 2, re-review I4).
   */
  const heldAt = (at: string) => held && held.place === at && <div className={styles.held} aria-hidden="true" inert>
    {held.message && (held.sold && offersBuyBack ? <div className={styles.soldNote}><p data-role="status">{held.message}</p><button type="button" className={styles.linkButton}>Open Buy back</button></div>
      : <p data-role="status">{held.message}</p>)}
    {held.error && <p data-role="alert">{held.error}</p>}
    {held.retry && <button type="button">Retry request</button>}
  </div>;
  /**
   * Buy back (patch 1.9): one `buy-back` for the chosen sale, through `send` (its operation id, busy state, refresh and Retry); its outcome
   * shows above the sale's card ("Bought back. Sword is in your bag again."). The preview takes no command and says so there.
   */
  const buyBack = (entry: BuyBackEntry) => {
    if (sending.current || sellLock.current) return;
    const name = itemName(entry.item);
    if (preview) { setWhere('buyback'); setError(''); setRetry(false); setSold(false); setMessage('Actions are unavailable in this preview.'); return; }
    void send({ kind: 'buy-back', saleId: entry.saleId }, `Bought back. ${name} is in your bag again.`, 'buyback');
  };
  /** Waits for the bag the panel shows to catch up with the sale just settled, so the next piece is checked against it. */
  async function bagUpdated(before: OwnerState) {
    for (let waited = 0; ownerNow.current === before && waited < 50; waited++) await new Promise(resolve => setTimeout(resolve, 10));
  }
  /**
   * Sells `quantity` pieces of a tile: one `sell-item` per piece, one after the other, each through `send` (its own operation id, busy
   * state and refresh). It stops at the first refusal and reports what was sold; a piece that is worn, listed, reserved or queued by
   * then is never sent. One piece is the plain sale, with the plain retry.
   */
  async function sellTile(tile: StackTile, quantity: number) {
    const item = tile.items[0], name = itemName(item), value = npcSaleValue(item, CATALOG_V1, rules) ?? 0, list = stackSaleItems(tile, quantity);
    if (list.length === 0 || sending.current || sellLock.current) return;
    if (preview) { setMessage('Actions are unavailable in this preview.'); return; }
    const reset = () => setQuantities(values => { const { [tile.key]: _gone, ...rest } = values; return rest; });
    // Patch 1.9: the line says where to buy it back (it replaces "Sold Sword for 39 gold."), with "Open Buy back"; a server without Buy back
    // keeps the old line (final fix wave).
    const saleLine = (gold: number, count: number) => (buyBackSales(ownerNow.current) !== undefined ? afterSaleLine(gold, count, name) : plainSaleLine(gold, count, name));
    if (list.length === 1) {
      const result = await send({ kind: 'sell-item', itemId: list[0].id, quantity: 1 }, saleLine(value, 1), 'sale');
      if (result?.ok && mounted.current) reset();
      return;
    }
    sellLock.current = true; begin();
    setSelling({ key: tile.key, name, done: 0, total: list.length }); setMessage(''); setError(''); setRetry(false); setSold(false); setWhere('sale');
    let done = 0, refusal = '', unknown = false;
    try {
      for (const piece of list) {
        const current = ownerNow.current.inventory.find(other => other.id === piece.id);
        if (!current || !isStackable(ownerNow.current, current)) { refusal = saleReason('conflict'); break; }
        const before = ownerNow.current;
        const result = await send({ kind: 'sell-item', itemId: piece.id, quantity: 1 }, undefined, 'sale', true);
        if (!mounted.current) return;
        if (!result || !result.ok) { refusal = saleReason(result ? result.code : 'unavailable'); unknown = !result || result.code === 'unavailable'; break; }
        done++;
        setSelling(progress => progress && { ...progress, done });
        if (done < list.length) { await bagUpdated(before); if (!mounted.current) return; }
      }
      const gold = done * value;
      const soldPart = done ? `Sold ${done} of ${list.length} ${name} for ${gold} gold. ` : '';
      if (unknown) setError(`${soldPart}The result of sale ${done + 1} is unknown; check your gold. Review the updated items and sell the rest again.`);
      else if (refusal) setError(`${soldPart || 'Nothing was sold. '}Sale ${done + 1} was refused: ${refusal}. Review the updated items and sell the rest again.`);
      else { setMessage(saleLine(gold, list.length)); setSold(true); }
      reset();
    } finally { sellLock.current = false; end(); if (mounted.current) setSelling(null); }
  }
  /** The card of a tile: its first piece's details, "N owned", and Wear, Discard and Sell acting on pieces of exactly this tile. */
  function itemCard(tile: StackTile) {
    const item = tile.items[0], count = tile.items.length, material = isMaterial(item), owned = material ? item.quantity : count;
    /** Discard takes the last piece, so the first (which names the tile and its card) stays chosen. */
    const discardable = tile.items[count - 1];
    const reserved = isReserved(owner, discardable);
    const loose = isStackable(owner, item);
    const quantity = material ? (item.quantity > 1 ? quantities[item.id] ?? 1 : 1) : count > 1 && loose ? quantities[tile.key] ?? 1 : 1;
    const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= (material ? item.quantity : count);
    const value = npcSaleValue(item, CATALOG_V1, rules);
    const state = isWearable(item) ? wearState(owner, item) : null, badge = wearBadge(owner, item);
    const blocked = state ? blockedText(state, item) : null, blockedId = `${panelId}-${item.id}-blocked`, listingId = `${blockedId}-listing`;
    const wearName = itemLabel(item), slot = CATALOG_V1.items[item.catalogId]?.slot;
    const here = selling?.key === tile.key ? selling : null;
    /** While a run is going the stack shrinks under the quantity asked for: the run, not the stack, decides then. */
    const askable = valid || here !== null;
    const sellable = !material && loose && value !== null;
    const sellNote = material ? '' : item.reservation?.kind === 'listing' ? 'Listed for sale' : badge === 'wearing' || badge === 'off-at' ? 'Worn: change it first to sell it'
      : !loose ? `Reserved: ${item.reservation && item.reservation.kind !== 'equipment' ? item.reservation.kind : 'pending-build'}`
        : value === null ? 'Account-bound: cannot sell to NPCs' : !askable ? `Enter a quantity from 1 to ${count}` : '';
    /** "Listed for sale" is already said by the availability line (and heard there once): the Sell box repeats it for the eye only. */
    const listedNote = !material && item.reservation?.kind === 'listing';
    const sellLabel = here ? `Selling ${itemName(item)}…` : sellable && askable ? `Sell ${quantity > 1 ? `${quantity} × ` : ''}${itemName(item)} · ${(value ?? 0) * quantity} gold` : `Sell ${itemName(item)}`;
    return <article key={item.id} className={styles.card} data-testid={`item-${item.id}`} data-rarity={item.rarity}>
      <div className={styles.cardHead}>
        <ItemIcon catalogId={item.catalogId} size={48} />
        <div><h3>{itemName(item)}</h3><p>{itemDetail(item)} · {itemBinding(item)}</p></div>
        {badge && <span className="gear-badge" data-badge={badge}>{wearBadgeText(badge, effective)}</span>}
      </div>
      <ItemStats item={item} />
      <p>{owned} owned · {item.reservation?.kind === 'listing' ? <span id={state === 'listed' ? blockedId : listingId}>Listed for sale</span> : reserved ? `Reserved: ${item.reservation?.kind ?? 'pending-build'}` : 'Available'}</p>
      <p>{value === null ? 'Cannot sell to NPCs' : `NPC sell value: ${value} gold each`}</p>
      {material && item.quantity > 1 && <label>Quantity for {itemName(item)}<input type="number" min="1" max={item.quantity} step="1" value={quantity || ''} onChange={event => setQuantities(values => ({ ...values, [item.id]: Number(event.target.value) }))} /></label>}
      {blocked && state !== 'listed' && <p id={blockedId} className="gear-note">{blocked}</p>}
      {count > 1 && <p className={styles.hint}>Wear and Discard use one item at a time.</p>}
      <div className={`item-actions ${styles.actions}`}>
        {state === 'queued' && slot ? <button type="button" className="gear-undo" disabled={preview} {...busyProps} aria-label={`Undo wearing ${wearName}`} aria-describedby={preview ? previewNote : undefined} onClick={() => undoItem(item, slot)}>Undo</button>
          : state === 'wearing' ? <button type="button" disabled aria-label={`Wearing ${wearName}`}>Wearing</button>
            : state ? <button type="button" className="gear-wear" disabled={preview || blocked !== null} {...busyProps} aria-label={`Wear ${wearName}${count > 1 ? ` (one of ${count})` : ''}`}
              aria-describedby={[blocked ? blockedId : '', preview ? previewNote : ''].filter(Boolean).join(' ') || undefined} onClick={() => wearItem(item, count - 1)}>Wear</button> : null}
        {material && <button type="button" disabled={reserved || value === null || !valid} {...busyProps} onClick={() => void send({ kind: 'sell-item', itemId: item.id, quantity })}>Sell</button>}
        <button type="button" disabled={reserved || (material && !valid)} {...busyProps} onClick={() => {
          if (sending.current || sellLock.current) return;
          if (preview) setMessage('Actions are unavailable in this preview.');
          else setConfirmation({ itemId: discardable.id, quantity: material ? quantity : 1 });
        }}>Discard</button>
      </div>
      {!material && <div className={styles.sellBox}>
        <h4>Sell to the NPC</h4>
        {count > 1 && sellable && <div className={styles.qtyRow}>
          <label>Quantity <input type="number" min="1" max={count} step="1" value={quantity || ''} readOnly={locked} aria-label={`Quantity of ${itemName(item)} to sell`}
            onChange={event => setQuantities(values => ({ ...values, [tile.key]: Number(event.target.value) }))} /></label>
          <span className={styles.of}>of {count}</span>
          <button type="button" className={styles.max} {...busyProps} onClick={() => { if (!locked) setQuantities(values => ({ ...values, [tile.key]: count })); }}>Max</button>
        </div>}
        <button type="button" className={styles.sellButton} disabled={!here && (!sellable || !valid)} {...busyProps} aria-describedby={listedNote ? (state === 'listed' ? blockedId : listingId) : undefined} onClick={() => void sellTile(tile, quantity)}>{sellLabel}</button>
        <p className={styles.sellNote} aria-live={listedNote ? undefined : 'polite'} aria-hidden={listedNote ? true : undefined}>{sellNote}</p>
        {here && <div className={styles.progress} role="status">
          <span>Selling {here.name}: {here.done} of {here.total} sold</span>
          <div className={styles.track} role="progressbar" aria-label="Sales completed" aria-valuemin={0} aria-valuemax={here.total} aria-valuenow={here.done}><i style={{ width: `${Math.round(100 * here.done / here.total)}%` }} /></div>
        </div>}
      </div>}
      {place !== 'sale' && tile.items.some(piece => piece.id === place) && outcomes}
      {held && held.place !== 'sale' && tile.items.some(piece => piece.id === held.place) && heldAt(held.place)}
    </article>;
  }
  // The strip sits outside the panel's own box, so the panel's large button style (`.inventory-panel button`) leaves its circles alone.
  return <><SectionStrip sections={INVENTORY_SECTIONS} index={section} onGo={setSection} />
  <div ref={panelRef} className={`inventory-panel ${styles.panel}`}>
    <div ref={sectionsRef} className={styles.sections}>
    <div className={styles.section} data-section="inventory" hidden={section !== 0}>
    {/* The strip names the section; the heading stays for the outline and screen readers. */}
    <div className="section-title"><h2 className={styles.visuallyHidden}>Inventory</h2><span>{owner.inventory.length} / {owner.inventoryCapacity} slots</span></div>
    {/* On a phone the chosen tile's card lies over the grid once a tile is chosen; with no tile to choose, the card's line shows below. */}
    <div ref={phoneCard.hostRef} className={styles.columns} data-card={phoneCard.phone && visibleTiles.length > 0 ? (phoneCard.open ? 'open' : 'closed') : undefined}>
      <div>
        <ItemSearch query={query} setQuery={setQuery} sorts={INVENTORY_SORTS} sort={sort} setSort={setSort} label="Search your items" sortLabel="Sort your items" />
        <div className={styles.filters} role="group" aria-label="Inventory filters">
          {filters.map(option => <button key={option} type="button" aria-pressed={option === filter} onClick={() => setFilter(option)}>{option}</button>)}
        </div>
        <div inert={covered}>
        <div ref={phoneCard.anchorRef} className={`${styles.gridScroll} ${styles.paged}`}>
          {visibleTiles.length === 0 && query.trim() ? <NoMatch query={query} clear={() => setQuery('')} filter={hiddenBy} />
            /* The page's container (`listRef`): a turn gives the focus to its first tile. `data-arrow-keys` (review Minor 7): the grid has no arrow
               keys of its own (it never had), and ← → on a tile must not move the section from under the player either, as in the shop grid. */
            : <div ref={paged.listRef as RefObject<HTMLDivElement | null>} data-page-list=""><div className={`${styles.grid} ${styles.paged}`} data-testid="inventory-grid" role="group" aria-label="Your items" data-arrow-keys="">
            {paged.rows.map(tile => {
              const item = tile.items[0], count = isMaterial(item) ? item.quantity : tile.items.length;
              const badge = wearBadge(owner, item), listed = item.reservation?.kind === 'listing';
              const status = badge ? wearBadgeText(badge, effective) : listed ? 'Listed for sale' : '';
              const word = badge ? (badge === 'wears-from' ? 'Next' : 'Worn') : listed ? 'Listed' : '';
              return <button key={tile.key} type="button" className={styles.tile} data-testid={`tile-${tile.key}`} data-rarity={item.rarity} data-stack={tile.items.length > 1 ? tile.items.length : undefined}
                data-page-row="" tabIndex={0}
                aria-label={[itemLabel(item), itemBinding(item), count > 1 && `${count} owned`, status].filter(Boolean).join(', ')}
                aria-description={`Weight ${item.stats.weight}`} aria-controls={detailsId} aria-pressed={tile.key === selected?.key} onClick={event => { setSelectedId(tile.key); phoneCard.show(event.currentTarget); }}>
                <ItemIcon catalogId={item.catalogId} />
                <span className={styles.level} aria-hidden="true">L{item.tier}</span>
                {word && <span className={styles.mark} data-mark={word.toLowerCase()} aria-hidden="true">{word}</span>}
                {badge && <span className={styles.visuallyHidden} data-gear-badge={badge}>{status}</span>}
                {count > 1 && <span className={styles.count} aria-hidden="true">×{count}</span>}
              </button>;
            })}
            {Array.from({ length: freeCells }, (_, index) => <span key={`free-${index}`} className={styles.emptyCell} aria-hidden="true" />)}
          </div></div>}
        </div>
        <MatchCount count={visibleCount} query={query} filter={hiddenBy} idle={visibleTiles.length > 0 ? `${visibleTiles.length} tile${visibleTiles.length === 1 ? '' : 's'} · ${visibleCount} item${visibleCount === 1 ? '' : 's'} · each item still uses a slot` : ''} />
        </div>
      </div>
      <section ref={phoneCard.sheetRef} id={detailsId} aria-label="Item details" className={styles.details}
        onKeyDown={phoneCard.onKeyDown}>
        {phoneCard.phone && visibleTiles.length > 0 && <button type="button" className={styles.closeCard} aria-label="Close item card" onClick={() => phoneCard.close()}>×</button>}
        {confirmation === 'stale' && <p ref={staleDiscardNotice} role="alert" tabIndex={-1}>Your inventory changed. Review the updated inventory before discarding.</p>}
        {/* A discard's or a material sale's line shows in the card while it lies over the grid (a phone), else at the section's end. */}
        {place === 'trade' && phoneCard.open && outcomes}
        {held?.place === 'trade' && phoneCard.open && heldAt('trade')}
        {place === 'sale' && outcomes}
        {heldAt('sale')}
        {selected ? itemCard(selected) : <p className="muted">{query.trim() ? 'Nothing to show. Clear the search to see every item.' : owner.inventory.length ? `No ${filter.toLowerCase()} in your inventory.` : 'Your inventory is empty.'}</p>}
      </section>
    </div>
    <div inert={covered}>
    <p>Available gold: {owner.wallets.money - owner.reservedFees.money}</p><p>Available renown: {owner.wallets.renown - owner.reservedFees.renown}</p>
    <p className="muted">Equipped and reserved items count toward capacity. Discarding gives no currency and never lowers historical gear strength.</p>
    <section className="gear-now" aria-labelledby={gearHeading}>
      <h3 id={gearHeading}>Wearing now</h3>
      <ul className="gear-slots" role="list">{GEAR_SLOTS.map(slot => {
        const now = pieceOf(worn[slot]), then = pieceOf(next[slot]);
        return <li key={slot} className="gear-slot" data-filled={worn[slot] ? '' : undefined} data-changing={worn[slot] !== next[slot] ? '' : undefined}>
          <span className="gear-slot-label">{SLOT_LABELS[slot]}</span>
          <span className="gear-slot-piece">{now ? itemName(now) : 'Empty'}</span>
          {now && <span className="gear-slot-detail">{itemDetail(now)}</span>}
          {worn[slot] !== next[slot] && <span className="gear-slot-next">Next: {then ? `${itemName(then)}, ${itemDetail(then).toLowerCase()}` : 'Empty'}</span>}
        </li>;
      })}</ul>
      {preview && <p id={previewNote} className="muted">Gear changes are unavailable in this preview.</p>}
      {changed.length > 0 && <div className="gear-pending">
        <p>{pendingNote(effective)}{keepsOtherChanges(owner) && ' Cancel changes puts the gear back; your other queued build changes stay.'}</p>
        <button type="button" disabled={preview} {...busyProps} aria-describedby={preview ? previewNote : undefined} onClick={cancelGear}>Cancel changes</button>
      </div>}
      {place === 'gear' && outcomes}
      {heldAt('gear')}
    </section>
    {place === 'trade' && section !== SHOPS && !phoneCard.open && outcomes}
    {section !== SHOPS && !phoneCard.open && heldAt('trade')}
    </div>
    {section === 0 && !(visibleTiles.length === 0 && query.trim()) && <PanelFooter><Pager list={paged} /></PanelFooter>}
    </div>
    <div className={styles.section} data-section="shops" hidden={section !== SHOPS}>
    {/* A trade's outcome shows where the player is: a purchase's above the shops, as before the sections. */}
    {place === 'trade' && section === SHOPS && outcomes}
    {section === SHOPS && heldAt('trade')}
    <ShopPanel key={merchantRequest} initialMerchant={initialMerchant} owner={owner} busy={busy || selling !== null} preview={preview} buy={(catalogId, quantity) => void send({ kind: 'buy-shop', catalogId, catalogVersion: CATALOG_V1.version, quantity })}
      clock={clock} buyBack={buyBack} buyBackOutcome={place === 'buyback' ? <>{outcomes}{heldAt('buyback')}</> : heldAt('buyback') || null} buyBackRequest={buyBackRequest} gridPage={gridPage} active={section === SHOPS} />
    </div>
    </div>
    <dialog ref={dialog} aria-labelledby="discard-heading" onCancel={() => setConfirmation(null)} onClose={() => {
      if (!dialog.current?.open) setConfirmation(current => current === 'stale' ? current : null);
    }}>
      <h2 id="discard-heading">Confirm discard</h2><p>Discard {discardRequest?.quantity} × {confirmingItem ? itemName(confirmingItem) : ''}? This gives no gold or renown.</p>
      <button autoFocus onClick={() => { dialog.current?.close(); setConfirmation(null); }}>Keep item</button>
      <button {...busyProps} disabled={!canConfirmDiscard} onClick={() => {
        if (sending.current || !discardRequest || !canConfirmDiscard) return;
        dialog.current?.close();
        setConfirmation(null);
        void send({ kind: 'discard-item', itemId: discardRequest.itemId, quantity: discardRequest.quantity });
      }}>Confirm discard</button>
    </dialog>
  </div></>;
}
