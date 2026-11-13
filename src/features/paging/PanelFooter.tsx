'use client';

// Patch 1.9 Task 30: the bar's place. An open menu (`MenuSurface`) offers a slot at its own bottom edge, outside the part that
// scrolls; `PanelFooter` moves its children there, so the bar moves with a menu pinned left, right or bottom and never scrolls
// away. The same context names the panel, the scope of the page keys. Fix round 1 (I4): a popover, a card or a dialog wraps its
// paged content in `PagingScope`, which gives it its own bottom slot and key scope (never the menu's around it). With no scope at
// all, the bar renders in place.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './paging.module.css';

export type PanelScope = { slot: HTMLElement | null; panel: HTMLElement | null };
export const PanelScopeContext = createContext<PanelScope | null>(null);

/** The open panel or `PagingScope` around this component (null outside both). */
export const usePanelScope = () => useContext(PanelScopeContext);

export function PanelFooter({ children }: { children: ReactNode }) {
  const slot = usePanelScope()?.slot ?? null;
  return slot ? createPortal(children, slot) : <>{children}</>;
}

/**
 * A paging surface inside a popover, a card or a dialog: a column whose body (`children`) scrolls and whose bottom slot holds the
 * `PanelFooter` of anything inside it. Give it the height to fill (`className`, e.g. the popover's own `max-height` and `display:
 * flex`); PageDown and PageUp work while the focus is inside it.
 */
export function PagingScope({ children, className, bodyClassName }: { children: ReactNode; className?: string; bodyClassName?: string }) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const scope = useMemo(() => ({ slot, panel }), [slot, panel]);
  return (
    <div ref={setPanel} className={`${styles.scope}${className ? ` ${className}` : ''}`} data-paging-scope="">
      <PanelScopeContext.Provider value={scope}>
        <div className={`${styles.scopeBody}${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
      </PanelScopeContext.Provider>
      <div ref={setSlot} className={styles.scopeFoot} data-panel-footer="" />
    </div>
  );
}
