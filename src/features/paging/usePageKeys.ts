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

/**
 * Whether a key on `target` belongs to `panel`: the nearest menu or `PagingScope` around the target is that panel (or there is none).
 * A `PagingScope` inside a menu keeps its keys from the menu's own bar (fix round 2, R2-6).
 */
export const keyInPanel = (target: Element, panel: Element): boolean => {
  const owner = target.closest('[data-paging-scope], [data-menu-surface]');
  return owner === null || owner === panel;
};

/**
 * Whether a key on `target` is inside an open `<dialog>` that sits in `panel` (a modal confirmation in the menu, such as the discard one):
 * the dialog's own keys, never the panel's pages or sections. A dialog that holds the panel (a `PagingScope` in a dialog) is the panel's
 * (Task 33 fix round 1, review Minor 8; add-only).
 */
export const inOtherModal = (target: Element, panel: Element): boolean => {
  const dialog = target.closest('dialog[open]');
  return dialog !== null && dialog !== panel && !dialog.contains(panel);
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
      if (!panel || !(event.target instanceof Element) || !panel.contains(event.target) || !keyInPanel(event.target, panel)
        || inOtherModal(event.target, panel)) return;
      event.preventDefault();
      action();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anchor, scope, enabled]);
}
