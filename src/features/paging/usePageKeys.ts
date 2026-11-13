'use client';

// Patch 1.9 Task 30: the page keys. PageDown and PageUp turn pages, ← and → move sections, only while the focus is inside the
// panel (the menu or the `PagingScope` around the bar) and not in a control that keeps the key (`ownsKeys`).
import { useEffect, useRef, type RefObject } from 'react';
import { usePanelScope } from './PanelFooter';

/** Controls that keep PageDown and PageUp: text fields, selects, sliders and spin buttons. */
const OWNS_PAGE_KEYS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="spinbutton"]';
/**
 * Controls that keep ← and → (fix round 1, I5): the page-key owners, and anything that moves with the arrows itself (a grid, a list
 * box, tabs, a radio group, a menu, a toolbar, or an element marked `data-arrow-keys`). Never left to `defaultPrevented` alone: a grid
 * at its edge does not prevent the default.
 */
const OWNS_ARROWS = `${OWNS_PAGE_KEYS}, [role="grid"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="menu"], [role="toolbar"], [data-arrow-keys]`;

/** Whether `key` on `target` belongs to the control itself, not to the pages. */
export const ownsKeys = (target: EventTarget | null, key: string): boolean => {
  const element = target as Element | null;
  if (!element || typeof element.closest !== 'function') return false;
  return element.closest(key.startsWith('Arrow') ? OWNS_ARROWS : OWNS_PAGE_KEYS) !== null;
};

export function usePageKeys(anchor: RefObject<HTMLElement | null>, keys: Record<string, () => void>, enabled = true) {
  const scope = usePanelScope();
  const latest = useRef(keys);
  useEffect(() => { latest.current = keys; });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const action = latest.current[event.key];
      if (!action || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || ownsKeys(event.target, event.key)) return;
      // The panel: the open menu or the PagingScope, else the dialog or section the bar sits in.
      const panel = scope?.panel ?? anchor.current?.closest('[data-paging-scope], [role="dialog"], section') ?? null;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      event.preventDefault();
      action();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anchor, scope, enabled]);
}
