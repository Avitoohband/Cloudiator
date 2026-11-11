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
const itemLabel = (item: ItemInstance) => `${itemName(item)}, level ${item.tier} ${item.rarity}`;
const isReserved = (owner: OwnerState, item: ItemInstance) => item.reservation !== null || !!owner.pendingBuild?.reservedItemIds.includes(item.id);

function itemNumber(inventory: readonly ItemInstance[], item: ItemInstance) {
  const name = itemName(item);
  const copies = inventory.filter(other => itemName(other) === name);
  return copies.length > 1 ? copies.indexOf(item) + 1 : null;
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
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
  const visibleItems = owner.inventory.filter(item => matchesFilter(item, filter));
  const selected = visibleItems.find(item => item.id === selectedId) ?? visibleItems[0];
  // Remember the displayed fallback so a refresh cannot replace a still-visible selection.
  if (selectedId !== (selected?.id ?? null)) setSelectedId(selected?.id ?? null);
  const discardRequest = confirmation === 'stale' ? null : confirmation;
  const confirmingItem = discardRequest && owner.inventory.find(item => item.id === discardRequest.itemId);
  const canConfirmDiscard = !!(discardRequest && confirmingItem && !isReserved(owner, confirmingItem) && discardRequest.quantity <= confirmingItem.quantity);
  if (discardRequest && !canConfirmDiscard) setConfirmation('stale');
  /** The shared clock's time to the minute: the queued gear's effective time is shown against it, as the build panel does (Task 23.10). */
  const nowMs = useMinuteNow(clock);
  const clockMode = useClockMode();
  // A trade sent by keyboard gives the focus to its outcome when its control leaves (the sold or discarded item); a pointer
  // trade moves nothing (Task 23.5, `useOutcomeFocus`).
  const { outcome, begin, end, target } = useOutcomeFocus(busy);
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
  async function send(intent: Intent | InventoryCommand | GearCommand, done?: string, place?: string) {
    if (sending.current) return;
    if (preview) { setMessage('Actions are unavailable in this preview.'); return; }
    if (confirmation === 'stale') setConfirmation(null);
    const comparable = (value: InventoryCommand | GearCommand | Intent) => { const { operationId: _id, ...rest } = value as InventoryCommand; return JSON.stringify(rest); };
    const command = attempt.current && comparable(attempt.current) === comparable(intent) ? attempt.current
      : { ...intent, operationId: crypto.randomUUID() } as InventoryCommand | GearCommand;
    if (done !== undefined) success.current = done;
    const gear = command.kind === 'queue-build' || command.kind === 'cancel-build';
    begin();
    attempt.current = command; sending.current = true; setBusy(true); setError(''); setMessage(''); setRetry(false);
    if (place) setWhere(place); else if (!gear) setWhere('trade');
    try {
      const result = await gateway.command(command);
      if (!mounted.current) return;
      if (result.ok) {
        await refresh();
        if (mounted.current) {
          attempt.current = null;
          setMessage(gear ? success.current : command.kind === 'buy-shop' ? 'Purchase confirmed.' : command.kind === 'sell-item' ? 'Sale confirmed.' : 'Item discarded. No gold or renown awarded.');
        }
      } else {
        const transient = ['processing', 'unavailable', 'rate-limited'].includes(result.code);
        setRetry(transient);
        setError(gear ? gearRefusal(result.code) : result.code === 'processing' ? 'The world is processing previous results. Retry shortly.'
          : result.code === 'unavailable' ? 'This request could not be confirmed. Retry the same request.'
            : result.code === 'inventory-full' ? 'Your inventory is full. Clear enough slots and try again.'
              : result.code === 'insufficient-funds' ? 'Not enough available currency. Held fees cannot be spent.'
                : result.code === 'conflict' ? 'Your inventory changed or this cosmetic is already owned. Review the refreshed state.'
                  : result.code === 'sold' ? 'This item was sold on the Marketplace. Review the refreshed inventory.'
                    : result.code === 'expired' ? 'Its Marketplace listing has expired and the item is back. Review the refreshed inventory.'
                      : `Request rejected: ${result.code}.`);
        if (!transient) attempt.current = null;
        // A gear change the server finds `invalid` no longer fits the build or the bag (`gearRefusal`): reload them.
        if (['conflict', 'not-found', 'inventory-full', 'sold', 'expired'].includes(result.code) || (gear && result.code === 'invalid')) await refresh();
      }
    } catch {
      if (mounted.current) { setError('This request could not be confirmed. Retry the same request.'); setRetry(true); }
    } finally { sending.current = false; end(); if (mounted.current) setBusy(false); }
  }
  // The gear view: what is worn now, what the queued build changes, and the commands that queue, undo and cancel a swap.
  const worn = wornNow(owner), next = nextEquipment(owner), changed = changedSlots(owner);
  const pieceOf = (id: string | null) => owner.inventory.find(item => item.id === id);
  /** The queued build's effective time ('' when it cannot be shown: the words then say "the next slot"). */
  const effective = owner.pendingBuild ? slotTimeText(owner.pendingBuild.effectiveSlotIndex * RULES_V1.clock.slotMs, nowMs, clockMode) : '';
  const wearItem = (item: ItemInstance) => {
    const command = wearCommand(owner, item.id), state = wearState(owner, item);
    void send(command, command.kind === 'cancel-build' ? 'Back to your current gear. No gear change is queued.'
      : state === 'leaving' ? `${itemName(item)} stays worn.` : `${itemName(item)} will be worn from the next slot.`, item.id);
  };
  const undoItem = (item: ItemInstance, slot: EquipmentSlot) => {
    const back = pieceOf(worn[slot]);
    void send(undoCommand(owner, slot), `Swap undone. ${back ? `${itemName(back)} stays worn` : `${SLOT_LABELS[slot]} stays empty`}.`, item.id);
  };
  const cancelGear = () => void send(cancelGearCommand(owner), keepsOtherChanges(owner) ? 'Gear changes canceled. Your other queued build changes are kept.' : 'Gear changes canceled.', 'gear');
  // Command buttons stay focusable while sending (aria-disabled, guarded against activation): a keyboard player keeps the
  // place in the list, and the button that becomes "Undo" or "Wear" is the one they pressed. Cancel changes leaves with its
  // section and gives the focus to the outcome (`useOutcomeFocus`), as do the trades.
  const busyProps = busy ? { 'aria-disabled': true as const } : {};
  /** Keep a gear outcome reachable if the item is no longer shown in the detail card. */
  const place = where === 'trade' || where === selected?.id ? where : 'gear';
  const outcomes = <>
    {message && <p ref={outcome} role="status" tabIndex={-1} {...target}>{message}</p>}{error && <p ref={outcome} role="alert" tabIndex={-1} {...target}>{error}</p>}
    {retry && <button disabled={busy} onClick={() => { if (attempt.current) void send(attempt.current); }}>Retry request</button>}
  </>;
  function itemCard(item: ItemInstance) {
    const reserved = isReserved(owner, item);
    const quantity = item.quantity > 1 ? quantities[item.id] ?? 1 : 1;
    const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= item.quantity;
    const value = npcSaleValue(item, CATALOG_V1, rules);
    const state = isWearable(item) ? wearState(owner, item) : null, badge = wearBadge(owner, item);
    const blocked = state ? blockedText(state, item) : null, blockedId = `${panelId}-${item.id}-blocked`;
    const wearName = itemLabel(item), slot = CATALOG_V1.items[item.catalogId]?.slot;
    const copy = itemNumber(owner.inventory, item);
    return <article key={item.id} className={styles.card} data-testid={`item-${item.id}`} data-rarity={item.rarity}>
      <div className={styles.cardHead}>
        <ItemIcon catalogId={item.catalogId} size={48} />
        <div><h3>{itemName(item)}</h3><p>{itemDetail(item)} · {itemBinding(item)}{copy && ` · Item ${copy}`}</p></div>
        {badge && <span className="gear-badge" data-badge={badge}>{wearBadgeText(badge, effective)}</span>}
      </div>
      <ItemStats item={item} />
      <p>{item.quantity} owned · {item.reservation?.kind === 'listing' ? <span id={state === 'listed' ? blockedId : undefined}>Listed for sale</span> : reserved ? `Reserved: ${item.reservation?.kind ?? 'pending-build'}` : 'Available'}</p>
      <p>{value === null ? 'Cannot sell to NPCs' : `NPC sell value: ${value} gold each`}</p>
      {item.quantity > 1 && <label>Quantity for {itemName(item)}<input type="number" min="1" max={item.quantity} step="1" value={quantity || ''} onChange={event => setQuantities(values => ({ ...values, [item.id]: Number(event.target.value) }))} /></label>}
      {blocked && state !== 'listed' && <p id={blockedId} className="gear-note">{blocked}</p>}
      <div className={`item-actions ${styles.actions}`}>
        {state === 'queued' && slot ? <button type="button" className="gear-undo" disabled={preview} {...busyProps} aria-label={`Undo wearing ${wearName}`} aria-describedby={preview ? previewNote : undefined} onClick={() => undoItem(item, slot)}>Undo</button>
          : state === 'wearing' ? <button type="button" disabled aria-label={`Wearing ${wearName}`}>Wearing</button>
            : state ? <button type="button" className="gear-wear" disabled={preview || blocked !== null} {...busyProps} aria-label={`Wear ${wearName}`}
              aria-describedby={[blocked ? blockedId : '', preview ? previewNote : ''].filter(Boolean).join(' ') || undefined} onClick={() => wearItem(item)}>Wear</button> : null}
        <button type="button" disabled={reserved || value === null || !valid} {...busyProps} onClick={() => void send({ kind: 'sell-item', itemId: item.id, quantity })}>Sell</button>
        <button type="button" disabled={reserved || !valid} {...busyProps} onClick={() => {
          if (sending.current) return;
          if (preview) setMessage('Actions are unavailable in this preview.');
          else setConfirmation({ itemId: item.id, quantity });
        }}>Discard</button>
      </div>
      {place === item.id && outcomes}
    </article>;
  }
  const emptyCells = filter === 'All' ? owner.inventoryCapacity - visibleItems.length : 6 - visibleItems.length;
  return <div className={`inventory-panel ${styles.panel}`}>
    <div className="section-title"><h2>Inventory</h2><span>{owner.inventory.length} / {owner.inventoryCapacity} slots</span></div>
    <div className={styles.columns}>
      <div>
        <div className={styles.filters} role="group" aria-label="Inventory filters">
          {filters.map(option => <button key={option} type="button" aria-pressed={option === filter} onClick={() => setFilter(option)}>{option}</button>)}
        </div>
        <div className={styles.gridScroll}>
          <div className={styles.grid} data-testid="inventory-grid">
            {visibleItems.map(item => {
              const badge = wearBadge(owner, item);
              const status = badge ? wearBadgeText(badge, effective) : item.reservation?.kind === 'listing' ? 'Listed for sale' : '';
              const label = itemLabel(item);
              const binding = itemBinding(item);
              const copy = itemNumber(owner.inventory, item);
              return <button key={item.id} type="button" className={styles.tile} data-testid={`tile-${item.id}`} data-rarity={item.rarity}
                aria-label={[label, binding, copy && `item ${copy}`, item.quantity > 1 && `${item.quantity} owned`, status].filter(Boolean).join(', ')}
                aria-description={`Weight ${item.stats.weight}`} aria-controls={detailsId} aria-pressed={item.id === selected?.id} onClick={() => setSelectedId(item.id)}>
                <ItemIcon catalogId={item.catalogId} />
                {badge && <span className={styles.mark} data-gear-badge={badge} aria-hidden="true"><span className={styles.visuallyHidden}>{status}</span></span>}
                {copy && <span className={styles.copy} aria-hidden="true">#{copy}</span>}
                {item.quantity > 1 && <span className={styles.count} aria-hidden="true">×{item.quantity}</span>}
              </button>;
            })}
            {Array.from({ length: Math.max(0, emptyCells) }, (_, index) => <span key={index} className={styles.emptyCell} aria-hidden="true" />)}
          </div>
        </div>
      </div>
      <section id={detailsId} aria-label="Item details" className={styles.details}>
        {confirmation === 'stale' && <p ref={staleDiscardNotice} role="alert" tabIndex={-1}>Your inventory changed. Review the updated inventory before discarding.</p>}
        {selected ? itemCard(selected) : <p className="muted">{owner.inventory.length ? `No ${filter.toLowerCase()} in your inventory.` : 'Your inventory is empty.'}</p>}
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
    <ShopPanel key={merchantRequest} initialMerchant={initialMerchant} owner={owner} busy={busy} preview={preview} buy={(catalogId, quantity) => void send({ kind: 'buy-shop', catalogId, catalogVersion: CATALOG_V1.version, quantity })} />
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
