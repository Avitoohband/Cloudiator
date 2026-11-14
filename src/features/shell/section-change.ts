'use client';

// Patch 1.9 Task 33: My gladiator and Inventory and shops show one named section at a time (the approved paged-menus mockup). Every
// section stays mounted (hidden while another shows), so a draft build, a shop's filter or an open choice is kept while the player looks
// at another section. When the section changes, the menu's body goes back to its top (a new section starts at its top), and the focus,
// if it was left in the section now hidden or lost with a bar that went away, goes to the menu panel itself (as the shell's focus rescue
// does), while the strip's status says the section.
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { scroller } from '../paging/scroller';

/** `holder` holds the sections, each an element with `data-section` (the shown one without `hidden`). */
export function useSectionChange(index: number, holder: RefObject<HTMLElement | null>, request: unknown = null) {
  const last = useRef({ index, request });
  useLayoutEffect(() => {
    if (last.current.index === index && last.current.request === request) return;
    last.current = { index, request };
    const shown = holder.current?.querySelector<HTMLElement>(':scope > [data-section]:not([hidden])');
    if (!shown) return;
    const body = scroller(shown);
    if (body) body.scrollTop = 0;
    const active = document.activeElement;
    const panel = shown.closest<HTMLElement>('[data-menu-surface]');
    if (panel && (!active || active === document.body || active.closest('[hidden]'))) panel.focus({ preventScroll: true });
  }, [index, request, holder]);
}
