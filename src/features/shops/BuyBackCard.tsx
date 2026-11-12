'use client';

// The card of a sale in the Buy back view (patch 1.9, the approved mockup and notes.md "Buy back"): the item exactly as it was sold (its
// name, level, rarity and stats), "Sold for 39 gold · today 15:20", "Available until the next game day (in 2 h 20 min)." counting down by
// the minute, and "Buy back for 39 gold" (the gold fill of Buy). Off when the gold the owner can spend is short or the bag is full, with the
// reason under it; in the preview it stays on and the panel says that actions are unavailable. While a command is out it stays focusable,
// aria-disabled.
import { useId } from 'react';
import type { BuyBackEntry, OwnerState } from '@contracts/reads';
import type { DisplayClock } from '../../game/display-clock';
import { useClockMode } from '../../lib/clock-setting';
import { ItemIcon, ItemStats } from '../inventory/ItemPresentation';
import inventory from '../inventory/InventoryPanel.module.css';
import { useMinuteNow } from '../schedule/use-minute-now';
import { CurrencyIcon } from './ShopArt';
import { BUY_BACK_SAME_PRICE, availableLine, buyBackBlock, buyBackName, soldWhen } from './buy-back';
import styles from './ShopPanel.module.css';

export function BuyBackCard({ entry, owner, clock, busy, preview, buyBack }: {
  entry: BuyBackEntry; owner: OwnerState; clock: DisplayClock; busy: boolean; preview: boolean; buyBack(entry: BuyBackEntry): void;
}) {
  const ids = useId();
  const nowMs = useMinuteNow(clock);
  const mode = useClockMode();
  const { item, price } = entry;
  const block = preview ? null : buyBackBlock(entry, owner);
  const factsId = `${ids}-facts`, soldId = `${ids}-sold`, noteId = `${ids}-note`;
  return <article className={inventory.card} data-rarity={item.rarity} data-buyback-card={entry.saleId}>
    <div className={inventory.cardHead}>
      <ItemIcon catalogId={item.catalogId} size={48} />
      <div><h3>{buyBackName(entry)}</h3><p id={factsId}>Level {item.tier} · {item.rarity} · {item.binding === 'bound' ? 'Account-bound' : 'Tradable'}</p></div>
    </div>
    <ItemStats item={item} />
    <p id={soldId} className={styles.soldLine}>Sold for <b>{price} gold</b> · {soldWhen(entry.soldAtMs, nowMs, mode)}</p>
    <p className={styles.soft}>{availableLine(entry.expiresAtMs, nowMs)}</p>
    <div className={`item-actions ${inventory.actions}`}>
      <button type="button" className={`${styles.buy} ${styles.buyBack}`} disabled={block !== null} aria-disabled={busy || undefined} aria-describedby={[factsId, soldId, block ? noteId : ''].filter(Boolean).join(' ')}
        onClick={() => { if (!busy) buyBack(entry); }}>
        {block ? <>Buy back <CurrencyIcon currency="money" size={14} /> {price}</> : <>Buy back for <CurrencyIcon currency="money" size={14} /> {price} gold</>}
      </button>
    </div>
    <p id={noteId} className={styles.buyBackNote} aria-live="polite">{block?.text ?? ''}</p>
    <p className={`${styles.soft} ${styles.small}`}>{BUY_BACK_SAME_PRICE}</p>
  </article>;
}
