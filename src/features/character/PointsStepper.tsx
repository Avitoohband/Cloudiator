'use client';

// One attribute's points, in the creation dialog and the build step alike (points hotfix, Avi, 2026-10-29): "People can't add
// points. When they write any number, it automatically reset to max. They should have like +1 or +5 point they can add."
// The row is the attribute's name (and a hint), then − | the number | +1 | +5; the build step leaves out − (`minus={false}`): points
// can't be taken back there, and respec comes later as a paid option (Avi, change round 1). The control only reports the number
// wanted; the panel's own `changePoints` clamps it and says why (`setPoints`, `cappedNote`, `raisedNote`).
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { committedPoints, typedPoints } from './points-field';
import styles from './PointsStepper.module.css';

/** Where a wanted number came from: the field (typed, or stepped with the arrow keys) or one of the −, +1 and +5 buttons. */
export type PointsSource = 'field' | 'button';

/**
 * Holds back the one press that took the focus from a points field whose waiting number was then changed (capped, raised or floored)
 * on blur. One tap would otherwise both correct the number and act (queue the build, create, add a point), and the player would
 * never read the corrected number and its line (review, fix round 2). A panel makes one, passes it to each PointsStepper and checks
 * it in its submit; the stepper's buttons check it too. It lets go by itself: after the click that ends that press (a task later, so
 * the submit that click causes still sees it), or at the next press or key.
 */
export type PressHold = { hold(): void; take(): boolean };
export function usePressHold(): PressHold {
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);
  return useMemo(() => ({
    hold() {
      release.current?.();
      let timer: number | undefined;
      const later = () => { timer = window.setTimeout(done, 0); };
      const done = () => {
        window.clearTimeout(timer);
        window.removeEventListener('pointerdown', done, true);
        window.removeEventListener('keydown', done, true);
        window.removeEventListener('click', later, true);
        if (release.current === done) release.current = null;
      };
      // Added during the blur, so the press under way (its pointerdown came first) is not one of these.
      window.addEventListener('pointerdown', done, true);
      window.addEventListener('keydown', done, true);
      window.addEventListener('click', later, true);
      release.current = done;
    },
    take() {
      if (!release.current) return false;
      release.current();
      return true;
    },
  }), []);
}

export function PointsStepper({ id, label, hint, name, value, floor, cap, minus = true, hold, onChange, onFocus, before, after, className, fieldProps }: {
  /** The number field's id (its label points at it); a generated one when left out. */
  id?: string;
  /** The label's content, which names the number field. */
  label: ReactNode;
  /** A line under the label, such as the creation dialog's effect of a point. */
  hint?: ReactNode;
  /** The attribute's name as the buttons say it: "Add a point to Strength". */
  name: string;
  value: number;
  /** The fewest points the attribute can hold (0 when creating, the current build's value in the build step). */
  floor: number;
  /** The most it can take now: its own points plus the points left. */
  cap: number;
  /** Whether the row has a − button (the creation dialog); the build step has none. Typing still goes down to `floor`. */
  minus?: boolean;
  /** The panel's `usePressHold`: a blur that corrects a waiting number holds back the press that caused it. */
  hold?: PressHold;
  /** A wanted number: the panel clamps it (a button stops at its limit, but +5 may ask past the cap). */
  onChange(wanted: number, source: PointsSource): void;
  /** The field took the focus (the panels keep what it held then for the capped line). */
  onFocus?(): void;
  /** Shown before the − and after the +5 (the creation dialog's "5 +" and "= total"). */
  before?: ReactNode;
  after?: ReactNode;
  className?: string;
  fieldProps?: { 'aria-invalid'?: boolean; 'aria-describedby'?: string };
}) {
  const generated = useId(), fieldId = id ?? generated;
  /**
   * The field's own text while it waits for Enter or blur: empty, out of range, or not a whole number. Null while the field shows
   * `value`, so a value changed from outside (a reload, a new floor) is shown at once and no stale text survives a blur.
   */
  const [waiting, setWaiting] = useState<string | null>(null);
  /**
   * The focus came with a press: its release must not drop the whole-value selection the focus made (a tap or a click). Chrome
   * keeps it anyway; this is the usual guard for WebKit, where the mouseup after the focus collapses the selection (untested here).
   * A press released outside the field clears it on the window's mouseup (fix round 2), so it never reaches a later release.
   */
  const pressed = useRef(false);
  const atFloor = value <= floor, atCap = value >= cap;
  /**
   * Enter or blur: a waiting number goes to the panel, which clamps it with its line; an empty field just shows its value again. On
   * blur, a number the panel will change holds back the press that took the focus away (`usePressHold`).
   */
  function commit(blurred: boolean) {
    if (waiting === null) return;
    setWaiting(null);
    const wanted = committedPoints(waiting);
    if (wanted === null) return;
    if (blurred && !(Number.isInteger(wanted) && wanted >= floor && wanted <= cap)) hold?.hold();
    onChange(wanted, 'field');
  }
  // The buttons stay in the tab order at their limit (aria-disabled, not disabled), so a keyboard user who spends the last point
  // keeps the focus instead of losing it to <body>.
  const step = (by: number, off: boolean) => () => { if (off || hold?.take()) return; setWaiting(null); onChange(value + by, 'button'); };
  return <div className={className ? `${styles.row} ${className}` : styles.row}>
    <div className={styles.name}><label htmlFor={fieldId} className={styles.label}>{label}</label>{hint}</div>
    <div className={styles.controls}>
      {before}
      {minus && <button type="button" className={styles.step} aria-label={`Remove a point from ${name}`} aria-disabled={atFloor || undefined} onClick={step(-1, atFloor)}>−</button>}
      <input id={fieldId} className={styles.value} type="number" inputMode="numeric" min={floor} max={cap} step="1" value={waiting ?? value} {...fieldProps}
        // The focus selects the whole value, so the first digit typed replaces it (a phone types after the digits already there).
        onMouseDown={event => {
          pressed.current = document.activeElement !== event.currentTarget;
          if (pressed.current) window.addEventListener('mouseup', () => { pressed.current = false; }, { once: true });
        }}
        onFocus={event => { event.currentTarget.select(); onFocus?.(); }}
        onMouseUp={event => { if (!pressed.current) return; pressed.current = false; event.preventDefault(); event.currentTarget.select(); }}
        onChange={event => {
          const text = event.target.value, wanted = typedPoints(text, floor, cap);
          setWaiting(wanted === null ? text : null);
          if (wanted !== null) onChange(wanted, 'field');
        }}
        onKeyDown={event => { if (event.key === 'Enter' && waiting !== null) { event.preventDefault(); commit(false); } }}
        onBlur={() => { pressed.current = false; commit(true); }} />
      <button type="button" className={styles.step} aria-label={`Add a point to ${name}`} aria-disabled={atCap || undefined} onClick={step(1, atCap)}>+1</button>
      <button type="button" className={styles.step} aria-label={`Add 5 points to ${name}`} aria-disabled={atCap || undefined} onClick={step(5, atCap)}>+5</button>
      {after}
    </div>
  </div>;
}
