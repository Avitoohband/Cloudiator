'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { EquipmentSlot, GameCommand } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
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
import { useOutcomeFocus } from '../shell/focus-lost';
import { ItemIcon, ItemStats } from './ItemPresentation';
import { ItemSearch, MatchCount, NoMatch } from './ItemSearch';
import { groupStacks, isStackable, joinsStack, stackSaleItems, type StackTile } from './stacks';
import { INVENTORY_SORTS, queryItems, type Queryable, type SortKey } from './item-query';
import {
  GEAR_SLOTS, SLOT_LABELS, blockedText, cancelGearCommand, changedSlots, gearRefusal, isWearable, keepsOtherChanges, nextEquipment, pendingNote,
  undoCommand, wearBadge, wearBadgeText, wearCommand, wearState, wornNow, type GearCommand,
} from './gear';
import styles from './InventoryPanel.module.css';

type InventoryCommand = Extract<GameCommand, { kind: 'buy-shop' | 'sell-item' | 'discard-item' }>;
type Intent = Omit<Extract<InventoryCommand, { kind: 'buy-shop' }>, 'operationId'> | Omit<Extract<InventoryCommand, { kind: 'sell-item' | 'discard-item' }>, 'operationId'>;
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
  const [confirmation, setConfirmation] = useState<{ itemId: string; quantity: number } | 'stale' | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>('All');
  const [query, setQuery] = useState(''), [sort, setSort] = useState<SortKey>('newest');
  const scroller = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  /** A sale of several pieces in progress: one `sell-item` per piece, in a row (`sellTile`). */
  const [selling, setSelling] = useState<{ key: string; name: string; done: number; total: number } | null>(null);
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
  // Remember the displayed fallback so a refresh cannot replace a still-visible selection.
  if (selectedId !== (selected?.key ?? null)) setSelectedId(selected?.key ?? null);
  // After a filter, search or sort change the chosen piece is brought into view inside the grid only (never the page or the menu).
  const latest = useRef(selected?.key);
  latest.current = selected?.key;
  useEffect(() => {
    const box = scroller.current, tile = box?.querySelector<HTMLElement>(`[data-testid="tile-${latest.current}"]`);
    if (!box || !tile) return;
    const top = tile.getBoundingClientRect().top - box.getBoundingClientRect().top, bottom = top + tile.offsetHeight - box.clientHeight;
    if (top < 0) box.scrollTop += top;
    else if (bottom > 0) box.scrollTop += bottom;
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
    attempt.current = command; sending.current = true; setBusy(true); if (!quiet) { setError(''); setMessage(''); setRetry(false); }
    if (place) setWhere(place); else if (!gear) setWhere('trade');
    try {
      const result = await gateway.command(command);
      if (!mounted.current) return null;
      if (result.ok) {
        await refresh();
        if (mounted.current) {
          attempt.current = null;
          if (!quiet) setMessage(success.current || (command.kind === 'buy-shop' ? 'Purchase confirmed.' : command.kind === 'sell-item' ? 'Sale confirmed.' : 'Item discarded. No gold or renown awarded.'));
        }
        return { ok: true };
      } else {
        const transient = ['processing', 'unavailable', 'rate-limited'].includes(result.code);
        if (!quiet) setRetry(transient);
        if (!quiet) setError(gear ? gearRefusal(result.code) : result.code === 'processing' ? 'The world is processing previous results. Retry shortly.'
          : result.code === 'unavailable' ? 'This request could not be confirmed. Retry the same request.'
            : result.code === 'inventory-full' ? 'Your inventory is full. Clear enough slots and try again.'
              : result.code === 'insufficient-funds' ? 'Not enough available currency. Held fees cannot be spent.'
                : result.code === 'conflict' ? 'Your inventory changed or this cosmetic is already owned. Review the refreshed state.'
                  : result.code === 'sold' ? 'This item was sold on the Marketplace. Review the refreshed inventory.'
                    : result.code === 'expired' ? 'Its Marketplace listing has expired and the item is back. Review the refreshed inventory.'
                      : `Request rejected: ${result.code}.`);
        if (!transient) attempt.current = null;
        // A gear change the server finds `invalid` no longer fits the build or the bag (`gearRefusal`): reload them.
        if (['conflict', 'not-found', 'inventory-full', 'sold', 'expired'].includes(result.code) || result.code === 'invalid' || (quiet && result.code === 'unavailable')) await refresh();
        return { ok: false, code: result.code };
      }
    } catch {
      if (mounted.current && !quiet) { setError('This request could not be confirmed. Retry the same request.'); setRetry(true); }
      // A sale in a run whose answer was lost may or may not have happened: read the bag again before the run reports.
      if (quiet) try { await refresh(); } catch { /* the report says the result is unknown */ }
      return { ok: false, code: 'unavailable' };
    } finally { sending.current = false; if (!quiet) end(); if (mounted.current) setBusy(false); }
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
  const place = where === 'trade' || where === 'sale' || selected?.items.some(item => item.id === where) ? where : 'gear';
  const outcomes = <>
    {message && <p ref={outcome} role="status" tabIndex={-1} {...target}>{message}</p>}{error && <p ref={outcome} role="alert" tabIndex={-1} {...target}>{error}</p>}
    {retry && <button disabled={busy} onClick={() => { if (attempt.current) void send(attempt.current, undefined, where); }}>Retry request</button>}
  </>;
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
    if (list.length === 1) {
      const result = await send({ kind: 'sell-item', itemId: list[0].id, quantity: 1 }, `Sold ${name} for ${value} gold.`, 'sale');
      if (result?.ok && mounted.current) reset();
      return;
    }
    sellLock.current = true; begin();
    setSelling({ key: tile.key, name, done: 0, total: list.length }); setMessage(''); setError(''); setRetry(false); setWhere('sale');
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
      const sold = done ? `Sold ${done} of ${list.length} ${name} for ${gold} gold. ` : '';
      if (unknown) setError(`${sold}The result of sale ${done + 1} is unknown; check your gold. Review the updated items and sell the rest again.`);
      else if (refusal) setError(`${sold || 'Nothing was sold. '}Sale ${done + 1} was refused: ${refusal}. Review the updated items and sell the rest again.`);
      else setMessage(`Sold ${list.length} × ${name} for ${gold} gold.`);
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
    </article>;
  }
  const emptyCells = filter === 'All' && !query.trim() ? owner.inventoryCapacity - visibleCount : 6 - visibleTiles.length;
  return <div className={`inventory-panel ${styles.panel}`}>
    <div className="section-title"><h2>Inventory</h2><span>{owner.inventory.length} / {owner.inventoryCapacity} slots</span></div>
    <div className={styles.columns}>
      <div>
        <ItemSearch query={query} setQuery={setQuery} sorts={INVENTORY_SORTS} sort={sort} setSort={setSort} label="Search your items" sortLabel="Sort your items" />
        <div className={styles.filters} role="group" aria-label="Inventory filters">
          {filters.map(option => <button key={option} type="button" aria-pressed={option === filter} onClick={() => setFilter(option)}>{option}</button>)}
        </div>
        <div ref={scroller} className={styles.gridScroll}>
          {visibleTiles.length === 0 && query.trim() ? <NoMatch query={query} clear={() => setQuery('')} filter={hiddenBy} /> : <div className={styles.grid} data-testid="inventory-grid">
            {visibleTiles.map(tile => {
              const item = tile.items[0], count = isMaterial(item) ? item.quantity : tile.items.length;
              const badge = wearBadge(owner, item), listed = item.reservation?.kind === 'listing';
              const status = badge ? wearBadgeText(badge, effective) : listed ? 'Listed for sale' : '';
              const word = badge ? (badge === 'wears-from' ? 'Next' : 'Worn') : listed ? 'Listed' : '';
              return <button key={tile.key} type="button" className={styles.tile} data-testid={`tile-${tile.key}`} data-rarity={item.rarity} data-stack={tile.items.length > 1 ? tile.items.length : undefined}
                aria-label={[itemLabel(item), itemBinding(item), count > 1 && `${count} owned`, status].filter(Boolean).join(', ')}
                aria-description={`Weight ${item.stats.weight}`} aria-controls={detailsId} aria-pressed={tile.key === selected?.key} onClick={() => setSelectedId(tile.key)}>
                <ItemIcon catalogId={item.catalogId} />
                <span className={styles.level} aria-hidden="true">L{item.tier}</span>
                {word && <span className={styles.mark} data-mark={word.toLowerCase()} aria-hidden="true">{word}</span>}
                {badge && <span className={styles.visuallyHidden} data-gear-badge={badge}>{status}</span>}
                {count > 1 && <span className={styles.count} aria-hidden="true">×{count}</span>}
              </button>;
            })}
            {Array.from({ length: Math.max(0, emptyCells) }, (_, index) => <span key={index} className={styles.emptyCell} aria-hidden="true" />)}
          </div>}
        </div>
        <MatchCount count={visibleCount} query={query} filter={hiddenBy} idle={visibleTiles.length > 0 ? `${visibleTiles.length} tile${visibleTiles.length === 1 ? '' : 's'} · ${visibleCount} item${visibleCount === 1 ? '' : 's'} · each item still uses a slot` : ''} />
      </div>
      <section id={detailsId} aria-label="Item details" className={styles.details}>
        {confirmation === 'stale' && <p ref={staleDiscardNotice} role="alert" tabIndex={-1}>Your inventory changed. Review the updated inventory before discarding.</p>}
        {place === 'sale' && outcomes}
        {selected ? itemCard(selected) : <p className="muted">{query.trim() ? 'Nothing to show. Clear the search to see every item.' : owner.inventory.length ? `No ${filter.toLowerCase()} in your inventory.` : 'Your inventory is empty.'}</p>}
      </section>
    </div>
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
    </section>
    {place === 'trade' && outcomes}
    <ShopPanel key={merchantRequest} initialMerchant={initialMerchant} owner={owner} busy={busy || selling !== null} preview={preview} buy={(catalogId, quantity) => void send({ kind: 'buy-shop', catalogId, catalogVersion: CATALOG_V1.version, quantity })} />
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
  </div>;
}
