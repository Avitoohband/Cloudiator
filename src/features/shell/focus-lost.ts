'use client';

// Task 23.5: where the focus goes when a panel's command (a trade, a build or a schedule save) settles.
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Whether the focus has lost its place: on <body> (its control left the page), on a disabled control (a button disabled
 * while its command was sent), or on the menu panel itself (where `useFocusRescue` put it when its control left).
 */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.matches(':disabled, [data-menu-surface]');
}

/**
 * The outcome of a command a player sent by keyboard takes the focus when the focus would otherwise be lost (Task 23.5
 * fix round 1, the controller's ruling on review Minor 1):
 * - sent by keyboard (the sending control showed its keyboard focus ring), and the focus is lost when the command settles
 *   (the control left or is disabled): the outcome takes it, and a screen reader reads the receipt or the reason there;
 * - sent by keyboard, and the focus is still on the sending control: the outcome is marked (`data-focus-target`) as the
 *   place `useFocusRescue` gives the focus to if that control leaves later (a bought listing's row leaves when the list is
 *   read again);
 * - sent with a pointer: nothing moves, so the menu keeps its scroll position (a control that leaves gives the focus to
 *   the panel, without scrolling);
 * - a focus the player moved elsewhere while the command was pending is never taken.
 *
 * `begin()` is called as the command is sent, after any confirmation dialog has closed (so the focus is back on the
 * control that opened it), and `end()` once it has settled, before `busy` turns false.
 */
export function useOutcomeFocus(busy: boolean) {
  const outcome = useRef<HTMLParagraphElement>(null);
  const sent = useRef<{ trigger: Element | null; keyboard: boolean } | null>(null);
  const settled = useRef(false);
  const [marked, setMarked] = useState<Element | null>(null);

  const begin = useCallback(() => {
    const active = document.activeElement;
    sent.current = { trigger: active, keyboard: !!active && active !== document.body && active.matches(':focus-visible') };
    settled.current = false;
    setMarked(null);
  }, []);
  const end = useCallback(() => { settled.current = true; }, []);

  useEffect(() => {
    if (busy || !settled.current) return;
    settled.current = false;
    const command = sent.current;
    sent.current = null;
    if (!command?.keyboard) return;
    if (focusLost()) outcome.current?.focus();
    else if (document.activeElement === command.trigger) setMarked(command.trigger);
  });

  // The mark lasts while the focus stays on the sending control: once the player moves on, a later loss is not this command's.
  useEffect(() => {
    if (!marked) return;
    const moved = (event: FocusEvent) => { if (event.target !== marked && event.target !== outcome.current) setMarked(null); };
    document.addEventListener('focusin', moved, true);
    return () => document.removeEventListener('focusin', moved, true);
  }, [marked]);

  return { outcome, begin, end, target: marked ? { 'data-focus-target': '' } : {} };
}
