'use client';

// My gladiator's Worn equipment (Patch 1.9 Task 6, the approved equip-from-gladiator and stacks mockups). The five slots show what is
// worn (hover or focus shows a slot's stats, as before), and each opens a picker of the pieces that fit it: one tile per stack of identical
// pieces (`slotTiles`), a tile of its own for a worn (✓), queued (→), listed or locked piece, and Remove when the slot is filled. Choosing a
// tile compares it with what is worn next in that slot (`compareChoice`); Wear, Undo and Remove send the Inventory's own gear commands
// (`wearCommand`, `undoCommand`, `removeCommand`, `cancelGearCommand`), close the picker and give the focus back to the slot. A queued
// change shows a NEXT tag on its slot and a row in "At the next slot", with Undo and Cancel changes. The card and its Wear always follow
// the CHOSEN tile (the AGENTS.md detail-card rule): hover and keyboard focus move nothing but the focus ring.
// Desktop: a popover laid over the panel under the slot row (nothing below it moves), with a caret at the slot, the grid on the left and
// the card with Wear on the right (two columns from 560 px); what follows it ("At the next slot", the outcome, Retry and the panel's build
// planner) is inert while it is open, so Tab from Wear never lands under it. Touch (the shell's compact query): a sheet over the panel body
// with Back and a Wear bar at its foot; what it covers is hidden. A keyboard command whose control leaves (Retry, Cancel changes) gives the focus to its
// outcome line (`useOutcomeFocus`, as the Inventory does); Wear, Undo and Remove give it back to the slot.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { EquipmentSlot } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { useClockMode } from '../../lib/clock-setting';
import { EquipmentDetails, equipmentSlots } from '../build/EquipmentInspection';
import inspection from '../build/EquipmentInspection.module.css';
import {
  cancelGearCommand, changedSlots, gearRefusal, keepsOtherChanges, nextEquipment, pendingNote, removeCommand, undoCommand, wearCommand, wearState,
  wornNow, type GearCommand,
} from '../inventory/gear';
import { ItemIcon } from '../inventory/ItemPresentation';
import { joinsStack, type StackTile } from '../inventory/stacks';
import { slotTimeText } from '../schedule/slot-time';
import { useMinuteNow } from '../schedule/use-minute-now';
import { useOutcomeFocus } from '../shell/focus-lost';
import {
  SLOT_NAMES, compareChoice, equipmentLoad, isTwoHanded, itemLabel, itemName, lockText, nextBuildDiffers, nextLabel, slotTiles, statText, tileMark,
} from './equip-picker';
import type { HintRowProps } from './stat-hints';
import styles from './WornEquipment.module.css';

/** The Remove tile's key (a tile's key is otherwise its first piece's id). */
const REMOVE = 'remove';
const TRANSIENT = ['processing', 'unavailable', 'rate-limited'];
const LEGEND = 'L = level needed · ×N = how many you own (stacked) · ✓ worn · → next · dimmed pieces cannot be worn yet.';
const binding = (item: ItemInstance) => (item.binding === 'bound' ? 'Account-bound' : 'Tradable');

function Lock() {
  return <svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true"><rect x="0.5" y="4.5" width="9" height="6" rx="1" fill="#f0b8b0" />
    <path d="M2.5 4.5V3a2.5 2.5 0 015 0v1.5" fill="none" stroke="#f0b8b0" strokeWidth="1.4" /></svg>;
}

/** The nearest scrolling ancestor of `element` (the menu's body). */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  return null;
}

type Outcome = { role: 'status' | 'alert'; text: string };

export function WornEquipment({ owner, gateway, refresh, clock, preview = false, onPicking, loadHelp }: {
  owner: OwnerState;
  /** The live gateway: gear commands always go online. */
  gateway: GameGateway;
  refresh(): Promise<void>;
  clock: DisplayClock;
  /** The fixture preview: the picker opens to compare, and its commands are unavailable. */
  preview?: boolean;
  /** Whether a picker is open, for the panel to make inert what the picker covers (and hide what a phone's sheet covers). */
  onPicking?(open: boolean): void;
  /** The panel's help on the Load heading (Patch 1.9 Task 10): the row's props, the label (a button with its tooltip) and a class for the row. */
  loadHelp?: { row: HintRowProps; label: ReactNode; className: string };
}) {
  const { inventory } = owner;
  const worn = wornNow(owner), next = nextEquipment(owner), changed = changedSlots(owner);
  const pieceOf = (id: string | null) => (id === null ? undefined : inventory.find(item => item.id === id));
  const headingId = useId(), pendingId = useId(), pickerId = useId(), blockedId = useId(), previewId = useId();
  const detail = useRef<HTMLDivElement>(null), picker = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<EquipmentSlot, HTMLButtonElement | null>>>({});
  const [inspected, setInspected] = useState<EquipmentSlot>();
  const [open, setOpen] = useState<EquipmentSlot | null>(null);
  /** The chosen tile: a piece's id (any piece of its tile) or `REMOVE`. The card and its button always follow it. */
  const [chosen, setChosen] = useState<string | null>(null);
  /** The tile that holds the grid's one tab stop: the last one focused, else the chosen one, else the first. */
  const [stop, setStop] = useState<string | null>(null);
  /** A slot to give the focus to once the page shows it (after the picker, or the phone's sheet over it, has closed). */
  const [focusTo, setFocusTo] = useState<EquipmentSlot | null>(null);
  const [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<Outcome | null>(null), [retry, setRetry] = useState(false);
  const attempt = useRef<GearCommand | null>(null), success = useRef(''), sending = useRef(false), mounted = useRef(false);
  const nowMs = useMinuteNow(clock), clockMode = useClockMode();
  const effective = owner.pendingBuild ? slotTimeText(owner.pendingBuild.effectiveSlotIndex * RULES_V1.clock.slotMs, nowMs, clockMode) : '';
  const load = equipmentLoad(owner, next), loadIsNext = nextBuildDiffers(owner);
  // A command sent by keyboard whose control leaves (Retry, Cancel changes) gives the focus to its outcome, never to <body>.
  const { outcome: outcomeRef, begin, end, target } = useOutcomeFocus(busy);
  const wearing = equipmentSlots.some(slot => worn[slot] !== null);
  const inspectedItem = inspected && pieceOf(worn[inspected]);
  /** An open picker lies over what follows the slot row (a phone's sheet also hides it): inert meanwhile. */
  const covered = open !== null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onPicking?.(open !== null); }, [open, onPicking]);
  useEffect(() => () => onPicking?.(false), [onPicking]);
  useLayoutEffect(() => {
    if (!focusTo || open) return;
    triggers.current[focusTo]?.focus();
    setFocusTo(null);
  }, [focusTo, open]);
  // On opening, the focus goes to the grid's tab stop (the first tile) without scrolling the panel. A slot with nothing to offer gives it to
  // Back on a phone (the sheet hides the slot) and to the picker itself on the desktop.
  useEffect(() => {
    const element = picker.current;
    if (!open || !element) return;
    const back = element.querySelector<HTMLElement>('[data-back]');
    const first = element.querySelector<HTMLElement>('[data-tile][tabindex="0"]') ?? (back && getComputedStyle(back).display !== 'none' ? back : element);
    first.focus({ preventScroll: true });
  }, [open]);
  // Where the picker sits: on desktop its caret points at the slot; on a phone the sheet starts where the panel's body does.
  useLayoutEffect(() => {
    const element = picker.current;
    if (!open || !element) return;
    const place = () => {
      const host = element.offsetParent;
      if (getComputedStyle(element).position === 'absolute') {
        const scroller = scrollParent(element);
        if (host instanceof HTMLElement && scroller && host.contains(scroller)) {
          element.style.setProperty('--sheet-top', `${scroller.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientTop}px`);
        }
      } else {
        const slot = triggers.current[open]?.getBoundingClientRect(), box = element.getBoundingClientRect();
        if (slot) element.style.setProperty('--caret', `${slot.left + slot.width / 2 - box.left}px`);
      }
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  // A desktop popover is scrolled into the panel's view (its top first) when it opens and when a choice grows its card.
  useLayoutEffect(() => {
    const element = picker.current;
    if (!open || !element || getComputedStyle(element).position === 'absolute') return;
    const scroller = scrollParent(element);
    if (!scroller) return;
    const box = element.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    const below = box.bottom - view.bottom + 8, room = box.top - view.top - 8;
    if (below > 0 && room > 0) scroller.scrollTop += Math.min(below, room);
  }, [open, chosen]);

  /** Sends a gear command as the Inventory does: an identical retry keeps its operation id; a refusal reloads what it must. */
  async function send(intent: GearCommand, done: string) {
    if (sending.current) return;
    if (preview) { setOutcome({ role: 'status', text: 'Gear changes are unavailable in this preview.' }); return; }
    const comparable = ({ operationId: _id, ...rest }: GearCommand) => JSON.stringify(rest);
    const command = attempt.current && comparable(attempt.current) === comparable(intent) ? attempt.current : intent;
    begin();
    success.current = done; attempt.current = command; sending.current = true;
    setBusy(true); setOutcome(null); setRetry(false);
    try {
      const result = await gateway.command(command);
      if (!mounted.current) return;
      if (result.ok) {
        await refresh();
        if (mounted.current) { attempt.current = null; setOutcome({ role: 'status', text: success.current }); }
      } else {
        const transient = TRANSIENT.includes(result.code);
        setRetry(transient); setOutcome({ role: 'alert', text: gearRefusal(result.code) });
        if (!transient) attempt.current = null;
        if (['conflict', 'invalid', 'not-found'].includes(result.code)) await refresh();
      }
    } catch {
      if (mounted.current) { setOutcome({ role: 'alert', text: 'This request could not be confirmed. Retry the same request.' }); setRetry(true); }
    } finally { sending.current = false; end(); if (mounted.current) setBusy(false); }
  }

  /** Opens the picker over the panel. The last outcome (and its Retry) stays until the next command, so nothing below the slots moves; it is inert under the picker. */
  function openPicker(slot: EquipmentSlot) {
    setOpen(slot); setChosen(null); setStop(null);
  }
  function closePicker(slot: EquipmentSlot) {
    setOpen(null); setChosen(null); setStop(null); setFocusTo(slot);
  }
  function wear(tile: StackTile) {
    if (sending.current || !open) return;
    const item = tile.items[0], command = wearCommand(owner, item.id), left = tile.items.length - 1;
    const done = command.kind === 'cancel-build' ? 'Back to your current gear. No gear change is queued.'
      : wearState(owner, item) === 'leaving' ? `${itemName(item)} stays worn.` : `${itemName(item)} will be worn from the next slot.${left > 0 ? ` ${left} left in the stack.` : ''}`;
    closePicker(open);
    void send(command, done);
  }
  function remove(slot: EquipmentSlot) {
    if (sending.current) return;
    const command = removeCommand(owner, slot);
    closePicker(slot);
    void send(command, command.kind === 'cancel-build' ? 'Back to your current gear. No gear change is queued.' : `${SLOT_NAMES[slot]} will be emptied from the next slot.`);
  }
  function undo(slot: EquipmentSlot) {
    if (sending.current) return;
    const item = pieceOf(next[slot]), back = pieceOf(worn[slot]);
    // A piece that goes back to a stack says so (the Inventory's words); otherwise what stays worn, or that the slot stays empty.
    const stacked = !!item && joinsStack(owner, item);
    if (open) closePicker(slot); else setFocusTo(slot);
    void send(undoCommand(owner, slot), stacked ? `Swap undone. ${itemName(item)} is back in the stack.`
      : `Swap undone. ${back ? `${itemName(back)} stays worn` : `${SLOT_NAMES[slot]} stays empty`}.`);
  }
  function cancel() {
    if (sending.current) return;
    // The box leaves with the queue: by keyboard, the outcome takes the focus (`useOutcomeFocus`). An open picker closes so it is seen.
    if (open) { setOpen(null); setChosen(null); setStop(null); }
    void send(cancelGearCommand(owner), keepsOtherChanges(owner) ? 'Gear changes canceled. Your other queued build changes are kept.' : 'Gear changes canceled.');
  }
  /** Arrow keys move the focus over the grid (rows by the tiles' positions); Home and End go to its ends. Enter or Space chooses. */
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
    const tiles = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[data-tile]') ?? []);
    const index = tiles.indexOf(event.currentTarget), columns = tiles.filter(tile => tile.offsetTop === tiles[0].offsetTop).length || 1;
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: tiles.length - 1 };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    tiles[Math.max(0, Math.min(tiles.length - 1, target))]?.focus();
  }
  // Command buttons stay focusable while a command is sent (aria-disabled, guarded in their handlers), as in the Inventory.
  const busyProps = busy ? { 'aria-disabled': true as const } : {};

  function renderPicker(slot: EquipmentSlot) {
    const tiles = slotTiles(owner, slot), now = pieceOf(next[slot]), name = SLOT_NAMES[slot];
    const blockedHands = slot === 'offHand' && isTwoHanded(pieceOf(next.weapon));
    const removable = next[slot] !== null;
    const keys = [...tiles.map(tile => tile.key), ...(removable ? [REMOVE] : [])];
    const tile = chosen === null ? null : tiles.find(entry => entry.items.some(item => item.id === chosen)) ?? null;
    const removing = chosen === REMOVE && removable;
    const tabStop = stop !== null && keys.includes(stop) ? stop : tile?.key ?? (removing ? REMOVE : keys[0]);
    const item = tile?.items[0], count = tile?.items.length ?? 0, state = item ? wearState(owner, item) : null;
    const comparison = item || removing ? compareChoice(owner, slot, item ?? null) : null;
    const blocked = item ? lockText(owner, item) : null;
    const describedBy = [blocked ? blockedId : '', preview ? previewId : ''].filter(Boolean).join(' ') || undefined;
    const nowName = now ? itemName(now) : next[slot] ? 'Unavailable' : 'empty';
    const queuedHere = changed.includes(slot);
    const placeholder = blockedHands ? 'The next weapon is two-handed: it uses both hands, so nothing can go in the off hand. Undo the weapon to free it.'
      : tiles.length ? 'Choose a piece to compare it with what you wear.' : 'You have nothing for this slot.';
    let action = null;
    if (removing) {
      action = <button type="button" className={styles.wear} disabled={preview} {...busyProps} aria-describedby={preview ? previewId : undefined} onClick={() => remove(slot)}>Remove {now ? itemName(now) : 'the piece'}</button>;
    } else if (item && tile && state === 'queued') {
      action = <button type="button" className={`${styles.wear} ${styles.undo}`} disabled={preview} {...busyProps} aria-label={`Undo wearing ${itemLabel(item)}`}
        aria-describedby={preview ? previewId : undefined} onClick={() => undo(slot)}>Undo</button>;
    } else if (item && state === 'wearing') {
      action = <button type="button" className={styles.wear} disabled aria-label={`Wearing ${itemLabel(item)}`}>Wearing</button>;
    } else if (item && tile) {
      action = <button type="button" className={styles.wear} disabled={preview || blocked !== null} {...busyProps} aria-describedby={describedBy}
        aria-label={`Wear ${itemLabel(item)}${count > 1 ? ` (one of ${count})` : ''}`} onClick={() => wear(tile)}>Wear {itemName(item)}</button>;
    }
    return <div className={styles.frame}>
      <div ref={picker} id={pickerId} className={styles.picker} role="dialog" aria-label={`Change ${name}`} tabIndex={-1}>
        <div className={styles.head}>
          <button type="button" className={styles.back} data-back="" onClick={() => closePicker(slot)}><span className={styles.backMark} aria-hidden="true">‹</span>Back</button>
          <h4>{name}</h4>
          <small>Now: {nowName}</small>
          <button type="button" className={styles.close} aria-label={`Close ${name} choices`} onClick={() => closePicker(slot)}>✕</button>
        </div>
        <div className={styles.body} data-picker-body="">
          <div className={styles.gridArea}>
            {keys.length > 0 && <div className={styles.grid} role="group" aria-label={`${name} pieces`}>
              {tiles.map(entry => {
                const piece = entry.items[0], many = entry.items.length, pieceState = wearState(owner, piece), mark = tileMark(pieceState);
                const lock = lockText(owner, piece);
                const words = [itemLabel(piece), many > 1 && `${many} owned`, pieceState === 'wearing' ? 'wearing' : pieceState === 'leaving' ? 'worn now, off at the next slot'
                  : pieceState === 'queued' ? 'next' : '', lock].filter(Boolean).join(', ');
                return <button key={entry.key} type="button" className={styles.pick} data-testid={`pick-${entry.key}`} data-tile={entry.key} data-rarity={piece.rarity}
                  data-stack={many > 1 ? many : undefined} data-locked={mark === 'lock' ? '' : undefined} aria-pressed={tile?.key === entry.key} aria-label={words}
                  tabIndex={entry.key === tabStop ? 0 : -1} onFocus={() => setStop(entry.key)} onKeyDown={moveFocus} onClick={() => setChosen(entry.key)}>
                  <ItemIcon catalogId={piece.catalogId} />
                  <span className={styles.level} aria-hidden="true">L{piece.tier}</span>
                  {mark && <span className={styles.mark} data-mark={mark} aria-hidden="true">{mark === 'lock' ? <Lock /> : mark === 'worn' ? '✓' : '→'}</span>}
                  {many > 1 && <span className={styles.count} aria-hidden="true">×{many}</span>}
                </button>;
              })}
              {removable && <button type="button" className={`${styles.pick} ${styles.remove}`} data-tile={REMOVE} aria-pressed={removing}
                aria-label={`Remove ${now ? itemName(now) : 'the piece'} and leave ${name} empty`} tabIndex={tabStop === REMOVE ? 0 : -1}
                onFocus={() => setStop(REMOVE)} onKeyDown={moveFocus} onClick={() => setChosen(REMOVE)}>
                <span className={styles.removeMark} aria-hidden="true">✕</span>Remove
              </button>}
            </div>}
            {tiles.length > 0 && <p className={styles.legend}>{LEGEND}</p>}
          </div>
          <div className={styles.card} aria-live="polite">
            {comparison ? <>
              <div className={styles.cardHead}>
                {item ? <ItemIcon catalogId={item.catalogId} size={40} /> : <span className={styles.removeIcon} aria-hidden="true">✕</span>}
                <div>
                  <h5>{item ? itemName(item) : `Remove ${now ? itemName(now) : 'the piece'}`}</h5>
                  <p>{item ? `Level ${item.tier} · ${item.rarity} · ${binding(item)}${count > 1 ? ` · ${count} owned` : ''}` : `${name} left empty`}</p>
                </div>
              </div>
              <table className={styles.compare}>
                <thead><tr><th scope="col"><span className={styles.hidden}>Stat</span></th><th scope="col">{queuedHere ? 'Next' : 'Worn'}</th><th scope="col">New</th>
                  <th scope="col"><span className={styles.hidden}>Difference</span></th></tr></thead>
                <tbody>
                  {[...comparison.rows, ...(comparison.load ? [comparison.load] : [])].map(entry => <tr key={entry.label} data-row={entry.label}
                    data-over={entry.label === 'Load' && comparison.load?.over ? '' : undefined}>
                    <th scope="row">{entry.label}</th><td>{entry.before}</td><td>{entry.after}</td><td data-tone={entry.tone}>{entry.change}</td>
                  </tr>)}
                </tbody>
              </table>
              {count > 1 && <p className={styles.info}>You own {count}. Wear takes one.</p>}
              {comparison.offHandOff ? <p className={styles.note}>Two-handed: the off hand goes empty, {itemName(comparison.offHandOff)} comes off.</p>
                : comparison.twoHanded ? <p className={styles.info}>Two-handed: it uses both hands; the off hand is already empty.</p> : null}
              {comparison.offHandBack && <p className={styles.note}>{itemName(comparison.offHandBack)} goes back on.</p>}
              {comparison.load?.over && <p className={styles.bad}>This would overload your gladiator (load {statText(comparison.load.value)} of {statText(comparison.load.capacity)}).</p>}
              {blocked && <p id={blockedId} className={styles.bad}>{blocked}</p>}
              {preview && <p id={previewId} className={styles.info}>Gear changes are unavailable in this preview.</p>}
            </> : <p className={styles.placeholder}>{placeholder}</p>}
          </div>
        </div>
        {action && <div className={styles.act}>{action}</div>}
      </div>
    </div>;
  }

  return <section className={`${inspection.worn} ${styles.worn}`} aria-labelledby={headingId} data-wearing={wearing || undefined} data-picking={open ? '' : undefined}
    onKeyDown={event => {
      // An Escape already handled (the Load tooltip closing) is not the picker's.
      if (event.key !== 'Escape' || !open || event.isDefaultPrevented()) return;
      // Escape closes the picker, not the menu: the shell leaves a handled Escape alone.
      event.preventDefault();
      closePicker(open);
    }}>
    <div className={inspection.heading}>
      <h3 id={headingId}>Worn equipment</h3>
      {load && <p className={[load.load > load.capacity ? styles.over : '', loadHelp?.className ?? ''].join(' ').trim() || undefined} {...loadHelp?.row}>{loadHelp?.label ?? 'Load'} <strong>{statText(load.load)} / {statText(load.capacity)}</strong>{loadIsNext ? ' (next slot)' : ''}</p>}
    </div>
    <div className={inspection.slots} data-slot-row="">
      {equipmentSlots.map(slot => {
        const item = pieceOf(worn[slot]), then = pieceOf(next[slot]), changing = worn[slot] !== next[slot];
        const name = item ? itemName(item) : worn[slot] ? 'Unavailable' : 'Empty';
        const shown = changing && then ? then : item;
        return <button key={slot} ref={element => { triggers.current[slot] = element; }} type="button" className={`${inspection.tile} ${styles.slot}`}
          data-next={changing ? '' : undefined} aria-haspopup="dialog" aria-expanded={open === slot} aria-controls={open === slot ? pickerId : undefined}
          aria-label={`${SLOT_NAMES[slot]}: ${name}${changing ? `, next: ${then ? itemLabel(then) : 'empty'}` : ''}`}
          onPointerEnter={event => { if (event.pointerType !== 'touch') setInspected(slot); }} onFocus={() => setInspected(slot)}
          onClick={() => (open === slot ? closePicker(slot) : openPicker(slot))}>
          <span className={`${inspection.icon} ${styles.slotIcon}`} data-rarity={shown?.rarity}>
            {shown || worn[slot] ? <ItemIcon catalogId={shown?.catalogId ?? ''} /> : <span aria-hidden="true">—</span>}
            {changing && <span className={styles.nextTag} data-next-tag="" aria-hidden="true">NEXT</span>}
            <span className={styles.chevron} data-chevron="" aria-hidden="true">▾</span>
          </span>
          <span className={inspection.tileName}>{SLOT_NAMES[slot]}</span>
          <span className={inspection.tileMeta}>{name}</span>
        </button>;
      })}
    </div>
    {/* The picker is laid over what follows (its place in the order keeps Tab from the slot row into it); the details stay in place under it,
        and what follows is inert meanwhile, so neither Tab nor a click reaches a control under it. */}
    {open && renderPicker(open)}
    <div className={styles.details} data-covered={open ? '' : undefined}>
      <EquipmentDetails label="Worn equipment details" item={inspectedItem} detailsRef={detail}
        empty={inspected ? (worn[inspected] ? 'This equipment is unavailable.' : 'No equipment worn in this slot.')
          : wearing ? 'Choose a slot to see its stats and weight, or to change it.' : 'No equipment worn. Choose a slot to wear something from your inventory.'} />
    </div>
    {changed.length > 0 && <section className={styles.pending} aria-labelledby={pendingId} inert={covered}>
      <h4 id={pendingId}>At the next slot</h4>
      {changed.map(slot => {
        const then = pieceOf(next[slot]), pushed = slot === 'offHand' && isTwoHanded(pieceOf(next.weapon));
        return <div key={slot} className={styles.row}>
          <span className={styles.rowSlot}>{SLOT_NAMES[slot]}</span>
          <span className={styles.rowText}>Next: {then ? nextLabel(then) : 'Empty'}{pushed && <span className={styles.muted}> (two-handed weapon)</span>}</span>
          {!pushed && <button type="button" className={styles.small} disabled={preview} {...busyProps} aria-label={`Undo ${SLOT_NAMES[slot]} change`} onClick={() => undo(slot)}>Undo</button>}
        </div>;
      })}
      <p>{pendingNote(effective)}{keepsOtherChanges(owner) && ' Cancel changes puts the gear back; your other queued build changes stay.'}</p>
      <button type="button" className={`${styles.small} ${styles.cancel}`} disabled={preview} {...busyProps} onClick={cancel}>Cancel changes</button>
    </section>}
    {outcome && <p ref={outcomeRef} className={outcome.role === 'alert' ? styles.alert : styles.message} role={outcome.role} tabIndex={-1} inert={covered} {...target}>{outcome.text}</p>}
    {retry && <button type="button" className={styles.small} inert={covered} {...busyProps} onClick={() => { if (attempt.current && !sending.current) void send(attempt.current, success.current); }}>Retry request</button>}
  </section>;
}
