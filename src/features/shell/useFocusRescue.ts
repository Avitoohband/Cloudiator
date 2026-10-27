'use client';

// Task 23.5 (C19): recover focus left on <body> by a DOM change. When the focused control leaves the page (a bought listing's row, a
// dismissed notice, a menu the viewer lost after a sign-out, an account menu replaced by the sign-in button) or becomes
// unusable (disabled or hidden), this observer can put focus left on <body> back near where it was. Chrome may blur a
// natively disabled button at a later frame, after this observer has run; that blur produces no mutation to observe.
// Busy command buttons must remain focusable with aria-disabled and guard activation in their handlers.
// When the observer finds lost focus, it uses:
// 0. the outcome of a command the player sent by keyboard from that control (`useOutcomeFocus` marks it), else
// 1. the nearest container around it that takes the focus (a menu panel, a profile card), else
// 2. the first control of the nearest part of the page that still has one (the corner chip's sign-in button), else
// 3. the open modal dialog's first focusable element, or the camp view (`fallback`).
// A press on the page itself moves the focus to <body> on purpose, so it is left alone; so is a focus that leaves the
// page for the browser (its control is still there), and one inside a dialog that has closed (the dialog gives it back).
// Components that know a better place (a trade's outcome, a closed menu's icon) still move the focus themselves: they
// run first, or after this and replace it.
import { useEffect, type RefObject } from 'react';

const CONTROLS = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';
const rendered = (el: Element) => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0);
/** Connected, shown, not disabled and not inert: an element the focus can be put on. */
const usable = (el: Element): el is HTMLElement => el instanceof HTMLElement && el.isConnected && !el.matches(':disabled') && !el.closest('[inert]') && rendered(el);
/** A control a Tab can reach. */
const tabbable = (el: Element): el is HTMLElement => usable(el) && el.matches(CONTROLS) && el.tabIndex >= 0;
/** A container that takes the focus itself (tabIndex -1 on a panel, a card or a heading). */
const container = (el: Element): el is HTMLElement => usable(el) && el.hasAttribute('tabindex') && !el.matches('main');

export function useFocusRescue(root: RefObject<HTMLElement | null>, fallback: () => void) {
  useEffect(() => {
    /** The element that had the focus, with its ancestors as they were (they may leave the page with it). */
    let lost: { element: Element; ancestors: Element[] } | null = null;
    const onFocusIn = (event: FocusEvent) => {
      const element = event.target;
      if (!(element instanceof Element) || element === document.body) return;
      const ancestors: Element[] = [];
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) ancestors.push(node);
      lost = { element, ancestors };
    };
    const onPress = () => { lost = null; };
    const rescue = () => {
      const active = document.activeElement;
      if ((active && active !== document.body) || !lost) return;
      // The control is still there and usable: the focus left it on purpose (a press elsewhere, the window).
      if (usable(lost.element)) return;
      const { ancestors } = lost;
      lost = null;
      // A dialog that has closed gives the focus back itself (natively, or its owner on unmount): leave it to it.
      const dialog = ancestors.find(el => el instanceof HTMLDialogElement);
      if (dialog instanceof HTMLDialogElement && !(dialog.isConnected && dialog.open)) return;
      const shell = root.current;
      const modal = document.querySelector('dialog:modal');
      // Inside an open modal dialog the page behind is inert: stay inside it.
      const scope = modal ?? shell ?? document.body;
      const near = ancestors.filter(el => el.isConnected && scope.contains(el) && el !== scope && rendered(el));
      // A command the player sent by keyboard marks its outcome as the place to go (`useOutcomeFocus`); it scrolls into view.
      const outcome = near.map(el => el.querySelector('[data-focus-target]')).find((el): el is HTMLElement => !!el && usable(el));
      if (outcome) { outcome.focus(); return; }
      const target = near.find(container)
        ?? near.map(el => [...el.querySelectorAll(CONTROLS)].find(tabbable)).find((el): el is HTMLElement => !!el)
        ?? (modal ? [...modal.querySelectorAll(CONTROLS)].find(el => usable(el)) as HTMLElement | undefined : undefined);
      if (target) target.focus({ preventScroll: true });
      else fallback();
    };
    // Check body mutations; a later native blur alone cannot trigger another check.
    const observer = new MutationObserver(rescue);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert', 'open'] });
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [root, fallback]);
}
