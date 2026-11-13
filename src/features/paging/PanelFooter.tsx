'use client';

// Patch 1.9 Task 30: the bar's place. An open menu (`MenuSurface`) offers a slot at its own bottom edge, outside the part that
// scrolls; `PanelFooter` moves its children there, so the bar moves with a menu pinned left, right or bottom and never scrolls
// away. In a popover or a card with no slot it renders in place. The same context names the panel, the scope of the page keys.
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type PanelScope = { slot: HTMLElement | null; panel: HTMLElement | null };
export const PanelScopeContext = createContext<PanelScope | null>(null);

/** The open panel around this component (null outside a menu). */
export const usePanelScope = () => useContext(PanelScopeContext);

export function PanelFooter({ children }: { children: ReactNode }) {
  const slot = usePanelScope()?.slot ?? null;
  return slot ? createPortal(children, slot) : <>{children}</>;
}
