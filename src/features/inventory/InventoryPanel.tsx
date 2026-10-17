'use client';

import { useEffect, useRef, useState } from 'react';
import type { GameCommand } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { npcSaleValue, type Merchant } from '@domain/inventory';
import type { GameGateway } from '../../lib/api/gateway';
import { ShopPanel } from '../shops/ShopPanel';

type InventoryCommand = Extract<GameCommand, { kind: 'buy-shop' | 'sell-item' | 'discard-item' }>;
type Intent = Omit<Extract<InventoryCommand, { kind: 'buy-shop' }>, 'operationId'> | Omit<Extract<InventoryCommand, { kind: 'sell-item' | 'discard-item' }>, 'operationId'>;
const itemName = (item: ItemInstance) => item.catalogId === 'salvage' ? 'Salvage' : CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId;

export function InventoryPanel({ owner, gateway, refresh, preview = false, initialMerchant, merchantRequest = 0 }: {
  owner: OwnerState; gateway: GameGateway; refresh(): Promise<void>; preview?: boolean;
  /** Opens the shops at this merchant's tab (a click on the merchant in the camp). */
  initialMerchant?: Merchant;
  /** Counts merchant clicks: each one opens the shops at `initialMerchant` again, even the same merchant's. */
  merchantRequest?: number;
}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ item: ItemInstance; quantity: number } | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [retry, setRetry] = useState(false);
  const attempt = useRef<InventoryCommand | null>(null), sending = useRef(false), mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (confirmation) dialog.current?.showModal(); }, [confirmation]);
  async function send(intent: Intent | InventoryCommand) {
    if (sending.current) return;
    if (preview) { setMessage('Actions are unavailable in this preview.'); return; }
    const comparable = (value: InventoryCommand | Intent) => { const { operationId: _id, ...rest } = value as InventoryCommand; return JSON.stringify(rest); };
    const command = attempt.current && comparable(attempt.current) === comparable(intent) ? attempt.current
      : { ...intent, operationId: crypto.randomUUID() } as InventoryCommand;
    attempt.current = command; sending.current = true; setBusy(true); setError(''); setMessage(''); setRetry(false);
    try {
      const result = await gateway.command(command);
      if (!mounted.current) return;
      if (result.ok) {
        await refresh();
        if (mounted.current) { attempt.current = null; setMessage(command.kind === 'buy-shop' ? 'Purchase confirmed.' : command.kind === 'sell-item' ? 'Sale confirmed.' : 'Item discarded. No money or renown awarded.'); }
      } else {
        const transient = ['processing', 'unavailable', 'rate-limited'].includes(result.code);
        setRetry(transient);
        setError(result.code === 'processing' ? 'The world is processing previous results. Retry shortly.'
          : result.code === 'unavailable' ? 'This request could not be confirmed. Retry the same request.'
            : result.code === 'inventory-full' ? 'Your inventory is full. Clear enough slots and try again.'
              : result.code === 'insufficient-funds' ? 'Not enough available currency. Held fees cannot be spent.'
                : result.code === 'conflict' ? 'Your inventory changed or this cosmetic is already owned. Review the refreshed state.'
                  : `Request rejected: ${result.code}.`);
        if (!transient) attempt.current = null;
        if (['conflict', 'not-found', 'inventory-full'].includes(result.code)) await refresh();
      }
    } catch {
      if (mounted.current) { setError('This request could not be confirmed. Retry the same request.'); setRetry(true); }
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="inventory-panel">
    <div className="section-title"><h2>Inventory</h2><span>{owner.inventory.length} / {owner.inventoryCapacity} slots</span></div>
    <p>Available money: {owner.wallets.money - owner.reservedFees.money}</p><p>Available renown: {owner.wallets.renown - owner.reservedFees.renown}</p>
    <p className="muted">Equipped and reserved items count toward capacity. Discarding gives no currency and never lowers historical gear strength.</p>
    {owner.inventory.length === 0 && <p>Your inventory is empty.</p>}
    <div className="inventory-grid">{owner.inventory.map(item => {
      const reserved = item.reservation !== null || owner.pendingBuild?.reservedItemIds.includes(item.id);
      const quantity = quantities[item.id] ?? 1, valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= item.quantity;
      const value = npcSaleValue(item, CATALOG_V1);
      return <article className="inventory-item" key={item.id} data-testid={`item-${item.id}`}>
        <h3>{itemName(item)}</h3><p>Level {item.tier} · {item.rarity} · {item.binding === 'bound' ? 'Account-bound' : 'Tradable'}</p>
        <p>Damage {item.stats.damage} · Armor {item.stats.armor} · Weight {item.stats.weight}</p>
        <p>{item.quantity} owned · {reserved ? `Reserved: ${item.reservation?.kind ?? 'pending-build'}` : 'Available'}</p>
        <p>{value === null ? 'Cannot sell to NPCs' : `NPC sell value: ${value} money each`}</p>
        {item.quantity > 1 && <label>Quantity for {itemName(item)}<input type="number" min="1" max={item.quantity} step="1" value={quantity || ''} onChange={e => setQuantities(values => ({ ...values, [item.id]: Number(e.target.value) }))} /></label>}
        <div className="item-actions"><button disabled={busy || reserved || value === null || !valid} onClick={() => void send({ kind: 'sell-item', itemId: item.id, quantity })}>Sell</button>
          <button disabled={busy || reserved || !valid} onClick={() => preview ? setMessage('Actions are unavailable in this preview.') : setConfirmation({ item, quantity })}>Discard</button></div>
      </article>;
    })}</div>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {retry && <button disabled={busy} onClick={() => { if (attempt.current) void send(attempt.current); }}>Retry request</button>}
    <ShopPanel key={merchantRequest} initialMerchant={initialMerchant} owner={owner} busy={busy} preview={preview} buy={(catalogId, quantity) => void send({ kind: 'buy-shop', catalogId, catalogVersion: CATALOG_V1.version, quantity })} />
    <dialog ref={dialog} aria-labelledby="discard-heading" onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)}>
      <h2 id="discard-heading">Confirm discard</h2><p>Discard {confirmation?.quantity} × {confirmation ? itemName(confirmation.item) : ''}? This gives no money or renown.</p>
      <button autoFocus onClick={() => { dialog.current?.close(); setConfirmation(null); }}>Keep item</button>
      <button disabled={busy} onClick={() => { if (confirmation) void send({ kind: 'discard-item', itemId: confirmation.item.id, quantity: confirmation.quantity }); dialog.current?.close(); setConfirmation(null); }}>Confirm discard</button>
    </dialog>
  </div>;
}
