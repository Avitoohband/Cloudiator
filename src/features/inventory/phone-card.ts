'use client';

// Patch 1.9 Task 33 fix round 1 (Avi's approved paged-menus notes: the chosen item's card "stays beside the grid (desktop) or opens over it
// (phone)"). In the touch layout the Inventory's and the Shops' card is a sheet over the grid: choosing a tile opens it, from the grid's top
// to the menu's visible bottom (it scrolls inside itself), so the strip, the search, the chips and the page bar stay where they are and the
// menu does not scroll. The focus goes into the card and back to the tile when it closes (×, Escape); a press outside closes it too and
// leaves the focus where that press puts it. What lies under it is inert meanwhile (the panel's `covered`). A pointer window keeps the card
// beside the grid, always shown.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { COMPACT_QUERY } from '../shell/rail-reveal';

const subscribe = (change: () => void) => {
  const media = window.matchMedia?.(COMPACT_QUERY);
  media?.addEventListener?.('change', change);
  return () => media?.removeEventListener?.('change', change);
};
const compact = () => !!window.matchMedia?.(COMPACT_QUERY).matches;

/** The nearest ancestor of `element` that scrolls (the menu's body). */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  return null;
}

/**
 * `available`: the grid has a tile to choose. With none (a search or a filter that matches nothing), the card closes and shows below the
 * grid as before, so the grid's "Clear search" is in reach.
 */
export function usePhoneCard(available = true) {
  const phone = useSyncExternalStore(subscribe, compact, () => false);
  const [shown, setShown] = useState(false);
  /** The positioned box that holds the grid and the card, the grid's box the card lies over, and the card. */
  const hostRef = useRef<HTMLDivElement>(null), anchorRef = useRef<HTMLDivElement>(null), sheetRef = useRef<HTMLElement>(null);
  /**
   * The tile the card opened from, which takes the focus back when the card closes. It is the tile pressed (fix round 2, re-review M-3), not
   * the focus at that moment: iOS Safari does not focus a tapped button.
   */
  const opener = useRef<HTMLElement | null>(null);
  const open = phone && shown && available;
  useEffect(() => { if (!available) { setShown(false); opener.current = null; } }, [available]);

  const show = useCallback((tile: HTMLElement) => {
    if (!compact()) return;
    opener.current = tile;
    setShown(true);
  }, []);
  const close = useCallback((giveBack = true) => {
    setShown(false);
    const tile = opener.current;
    opener.current = null;
    if (giveBack && tile?.isConnected) requestAnimationFrame(() => tile.focus({ preventScroll: true }));
  }, []);

  // Over the grid: from its top (or the menu's visible top) to the menu's visible bottom; the focus into the card.
  useLayoutEffect(() => {
    const host = hostRef.current, anchor = anchorRef.current, sheet = sheetRef.current;
    if (!open || !host || !anchor || !sheet) return;
    const place = () => {
      const body = scroller(host);
      const view = body ? body.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const top = Math.max(anchor.getBoundingClientRect().top, view.top);
      sheet.style.setProperty('--card-top', `${top - host.getBoundingClientRect().top}px`);
      sheet.style.setProperty('--card-height', `${Math.max(120, Math.min(view.bottom, window.innerHeight) - top)}px`);
    };
    place();
    // A line that comes or goes above the grid (a purchase's, fix round 2, re-review M-1) moves the grid: the card follows it and stays
    // wholly inside the menu. Every box from the card's host up to the menu's body grows or shrinks with such a line.
    const body = scroller(host);
    const boxes: Element[] = [];
    for (let node: HTMLElement | null = host; node && node !== body; node = node.parentElement) boxes.push(node);
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    for (const box of boxes) resized?.observe(box);
    // The card takes the focus only as it opens: a card that kept a tabindex would catch the focus a control in it leaves (a discarded
    // piece's Discard; `useFocusRescue`) before that command's outcome could take it (`useOutcomeFocus`).
    sheet.tabIndex = -1;
    sheet.focus({ preventScroll: true });
    const drop = () => sheet.removeAttribute('tabindex');
    sheet.addEventListener('blur', drop, { once: true });
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('resize', place); resized?.disconnect(); sheet.removeEventListener('blur', drop); drop(); };
  }, [open]);

  // A press outside the card closes it (the press goes on to what it pressed).
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      // A modal confirmation the card opened (Discard) is the card's own.
      if (event.target instanceof Element && (sheetRef.current?.contains(event.target) || event.target.closest('dialog[open]'))) return;
      close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, close]);

  // Escape with the focus elsewhere in the menu (on the menu itself, where the focus goes when a control in the card leaves, or on a chip):
  // the card closes first, not the menu. A field keeps its Escape as before Task 33 (3ed69c0; fix round 2, the coordinator's ruling on
  // re-review M-2): a typed search clears itself, and an empty search or the Sort select leave it to the shell, which closes the menu.
  // The card's own keys are the card's.
  useEffect(() => {
    const menu = hostRef.current?.closest<HTMLElement>('[data-menu-surface]');
    if (!open || !menu) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (event.key !== 'Escape' || event.defaultPrevented || !(target instanceof Element)) return;
      if (sheetRef.current?.contains(target) || target.closest('dialog, input, textarea, select')) return;
      event.preventDefault();
      close();
    };
    menu.addEventListener('keydown', onKey);
    return () => menu.removeEventListener('keydown', onKey);
  }, [open, close]);

  /** Escape closes the card, not the menu. */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };
  return { phone, open, show, close, hostRef, anchorRef, sheetRef, onKeyDown };
}
