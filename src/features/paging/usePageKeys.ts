'use client';

// Patch 1.9 Task 30: the page keys. PageDown and PageUp turn pages, ← and → move sections, only while the focus is inside the
// panel and not in a text field, a select or a slider (nor in a control that owns its arrows: tabs, a radio group, a list box).
import { useEffect, useRef, type RefObject } from 'react';
import { usePanelScope } from './PanelFooter';

const OWNS_KEYS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="tablist"], [role="radiogroup"], [role="listbox"], [role="menu"], [role="spinbutton"]';

/** Whether a key on `target` belongs to the control itself. */
export const ownsKeys = (target: EventTarget | null) => target instanceof Element && target.closest(OWNS_KEYS) !== null;

export function usePageKeys(anchor: RefObject<HTMLElement | null>, keys: Record<string, () => void>, enabled = true) {
  const scope = usePanelScope();
  const latest = useRef(keys);
  useEffect(() => { latest.current = keys; });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const action = latest.current[event.key];
      if (!action || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || ownsKeys(event.target)) return;
      // The panel: the open menu, else the dialog or section the bar sits in.
      const panel = scope?.panel ?? anchor.current?.closest('[role="dialog"], section') ?? null;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      event.preventDefault();
      action();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anchor, scope, enabled]);
}
