'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { EquipmentSlot, GameCommand } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { npcSaleValue, type Merchant } from '@domain/inventory';
import { RULES_V1 } from '@domain/rules-v1';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { slotTimeText } from '../schedule/slot-time';
import { useMinuteNow } from '../schedule/use-minute-now';
import { ShopPanel } from '../shops/ShopPanel';
import { useOutcomeFocus } from '../shell/focus-lost';
import {
  GEAR_SLOTS, SLOT_LABELS, blockedText, cancelGearCommand, changedSlots, gearRefusal, isWearable, keepsOtherChanges, nextEquipment, pendingNote,
  undoCommand, wearBadge, wearBadgeText, wearCommand, wearState, wornNow, type GearCommand,
} from './gear';

type InventoryCommand = Extract<GameCommand, { kind: 'buy-shop' | 'sell-item' | 'discard-item' }>;
type Intent = Omit<Extract<InventoryCommand, { kind: 'buy-shop' }>, 'operationId'> | Omit<Extract<InventoryCommand, { kind: 'sell-item' | 'discard-item' }>, 'operationId'>;
const itemName = (item: ItemInstance) => item.catalogId === 'salvage' ? 'Salvage' : CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId;
/** A piece's level and rarity: two pieces of one kind share a name, and this tells them apart. */
const itemDetail = (item: ItemInstance) => `Level ${item.tier} · ${item.rarity}`;

export function InventoryPanel({ owner, gateway, refresh, clock, preview = false, initialMerchant, merchantRequest = 0 }: {
  owner: OwnerState; gateway: GameGateway; refresh(): Promise<void>; clock: DisplayClock; preview?: boolean;
  /** Opens the shops at this merchant's tab (a click on the merchant in the camp). */
  initialMerchant?: Merchant;
  /** Counts merchant clicks: each one opens the shops at `initialMerchant` again, even the same merchant's. */
  merchantRequest?: number;
}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ item: ItemInstance; quantity: number } | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
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
  const panelId = useId(), gearHeading = `${panelId}-gear`, previewNote = `${panelId}-preview`;
  /** The shared clock's time to the minute: the queued gear's effective time is shown against it, as the build panel does (Task 23.10). */
  const nowMs = useMinuteNow(clock);
  // A trade sent by keyboard gives the focus to its outcome when its control leaves (the sold or discarded item); a pointer
  // trade moves nothing (Task 23.5, `useOutcomeFocus`).
  const { outcome, begin, end, target } = useOutcomeFocus(busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (confirmation) dialog.current?.showModal(); }, [confirmation]);
  /** `done` is what a gear change says once it is queued or canceled, and `place` where its outcome shows; the trades and the retry say their own. */
  async function send(intent: Intent | InventoryCommand | GearCommand, done?: string, place?: string) {
    if (sending.current) return;
    if (preview) { setMessage('Actions are unavailable in this preview.'); return; }
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
          setMessage(gear ? success.current : command.kind === 'buy-shop' ? 'Purchase confirmed.' : command.kind === 'sell-item' ? 'Sale confirmed.' : 'Item discarded. No money or renown awarded.');
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
  const effective = owner.pendingBuild ? slotTimeText(owner.pendingBuild.effectiveSlotIndex * RULES_V1.clock.slotMs, nowMs) : '';
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
  // The gear buttons stay focusable while a command is sent (aria-disabled, ignored when pressed): a keyboard player keeps the
  // place in the list, and the button that becomes "Undo" or "Wear" is the one they pressed. Cancel changes leaves with its
  // section and gives the focus to the outcome (`useOutcomeFocus`), as do the trades.
  const busyProps = busy ? { 'aria-disabled': true as const } : {};
  /** The outcome shows in the piece's card while the piece is in the bag, else under the gear row. */
  const place = where === 'trade' || where === 'gear' || owner.inventory.some(item => item.id === where) ? where : 'gear';
  const outcomes = <>
    {message && <p ref={outcome} role="status" tabIndex={-1} {...target}>{message}</p>}{error && <p ref={outcome} role="alert" tabIndex={-1} {...target}>{error}</p>}
    {retry && <button disabled={busy} onClick={() => { if (attempt.current) void send(attempt.current); }}>Retry request</button>}
  </>;
  return <div className="inventory-panel">
    <div className="section-title"><h2>Inventory</h2><span>{owner.inventory.length} / {owner.inventoryCapacity} slots</span></div>
    <p>Available money: {owner.wallets.money - owner.reservedFees.money}</p><p>Available renown: {owner.wallets.renown - owner.reservedFees.renown}</p>
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
    {owner.inventory.length === 0 && <p>Your inventory is empty.</p>}
    <div className="inventory-grid">{owner.inventory.map(item => {
      const reserved = item.reservation !== null || owner.pendingBuild?.reservedItemIds.includes(item.id);
      const quantity = quantities[item.id] ?? 1, valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= item.quantity;
      const value = npcSaleValue(item, CATALOG_V1);
      const wearable = isWearable(item), state = wearable ? wearState(owner, item) : null, badge = wearable ? wearBadge(owner, item) : null;
      const blocked = state ? blockedText(state, item) : null, blockedId = `${panelId}-${item.id}-blocked`;
      const wearName = `${itemName(item)}, level ${item.tier} ${item.rarity}`;
      const slot = CATALOG_V1.items[item.catalogId]?.slot;
      return <article className="inventory-item" key={item.id} data-testid={`item-${item.id}`} data-wear={state === 'wearing' || state === 'queued' ? state : undefined}>
        <div className="item-head"><h3>{itemName(item)}</h3>{badge && <span className="gear-badge" data-badge={badge}>{wearBadgeText(badge, effective)}</span>}</div>
        <p>Level {item.tier} · {item.rarity} · {item.binding === 'bound' ? 'Account-bound' : 'Tradable'}</p>
        <p>Damage {item.stats.damage} · Armor {item.stats.armor} · Weight {item.stats.weight}</p>
        {/* A listed piece says so once, here: its Wear button is described by this line's words, not by a second note. */}
        <p>{item.quantity} owned · {item.reservation?.kind === 'listing' ? <span id={state === 'listed' ? blockedId : undefined}>Listed for sale</span> : reserved ? `Reserved: ${item.reservation?.kind ?? 'pending-build'}` : 'Available'}</p>
        <p>{value === null ? 'Cannot sell to NPCs' : `NPC sell value: ${value} money each`}</p>
        {item.quantity > 1 && <label>Quantity for {itemName(item)}<input type="number" min="1" max={item.quantity} step="1" value={quantity || ''} onChange={e => setQuantities(values => ({ ...values, [item.id]: Number(e.target.value) }))} /></label>}
        {blocked && state !== 'listed' && <p id={blockedId} className="gear-note">{blocked}</p>}
        <div className="item-actions">
          {state === 'queued' && slot ? <button type="button" className="gear-undo" disabled={preview} {...busyProps} aria-label={`Undo wearing ${wearName}`} aria-describedby={preview ? previewNote : undefined} onClick={() => undoItem(item, slot)}>Undo</button>
            : state === 'wearing' ? <button type="button" disabled aria-label={`Wearing ${wearName}`}>Wearing</button>
              : state ? <button type="button" className="gear-wear" disabled={preview || blocked !== null} {...busyProps} aria-label={`Wear ${wearName}`}
                aria-describedby={[blocked ? blockedId : '', preview ? previewNote : ''].filter(Boolean).join(' ') || undefined} onClick={() => wearItem(item)}>Wear</button> : null}
          <button disabled={busy || reserved || value === null || !valid} onClick={() => void send({ kind: 'sell-item', itemId: item.id, quantity })}>Sell</button>
          <button disabled={busy || reserved || !valid} onClick={() => preview ? setMessage('Actions are unavailable in this preview.') : setConfirmation({ item, quantity })}>Discard</button></div>
        {place === item.id && outcomes}
      </article>;
    })}</div>
    {place === 'trade' && outcomes}
    <ShopPanel key={merchantRequest} initialMerchant={initialMerchant} owner={owner} busy={busy} preview={preview} buy={(catalogId, quantity) => void send({ kind: 'buy-shop', catalogId, catalogVersion: CATALOG_V1.version, quantity })} />
    <dialog ref={dialog} aria-labelledby="discard-heading" onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)}>
      <h2 id="discard-heading">Confirm discard</h2><p>Discard {confirmation?.quantity} × {confirmation ? itemName(confirmation.item) : ''}? This gives no money or renown.</p>
      <button autoFocus onClick={() => { dialog.current?.close(); setConfirmation(null); }}>Keep item</button>
      <button disabled={busy} onClick={() => { dialog.current?.close(); setConfirmation(null); if (confirmation) void send({ kind: 'discard-item', itemId: confirmation.item.id, quantity: confirmation.quantity }); }}>Confirm discard</button>
    </dialog>
  </div>;
}
