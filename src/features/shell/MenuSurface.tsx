'use client';

// One menu's floating panel (a bottom sheet on touch): a labelled, non-modal dialog that takes the focus when it opens,
// scrolls internally and closes with its × button or, on touch, a swipe down on its handle. It renders outside the camp
// view's element, so the camp's key handlers never see keystrokes typed here.
// Patch 1.9 Task 30: a slot at the panel's own bottom edge, outside the part that scrolls, for a paged list's bar (`PanelFooter`);
// a paged menu (`paged`) opens as a tall sheet on a phone.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanelScopeContext } from '../paging/PanelFooter';
import type { MenuDef } from './menus';
import styles from './shell.module.css';

/** A sheet closes when its top is dragged down at least this far. */
const SWIPE_PX = 50;

export function MenuSurface({ menu, open, covered = false, paged = false, onClose, children }: {
  menu: MenuDef; open: boolean;
  /** A menu of pages (Task 30): the phone sheet opens tall. */
  paged?: boolean;
  /** A profile card replaces the panel while it is open (no room beside it, Task 21): hidden and inert until the card closes. */
  covered?: boolean;
  onClose(): void; children: ReactNode;
}) {
  const surface = useRef<HTMLElement | null>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const holdPanel = useCallback((element: HTMLElement | null) => { surface.current = element; setPanel(element); }, []);
  const scope = useMemo(() => ({ slot, panel }), [slot, panel]);
  const [swipe, setSwipe] = useState<{ pointer: number; y: number } | null>(null);
  useEffect(() => { if (open) surface.current?.focus({ preventScroll: true }); }, [open]);
  return (
    <section ref={holdPanel} id={`menu-${menu.id}`} className={styles.surface} role="dialog" aria-label={menu.label} tabIndex={-1} hidden={!open}
      data-menu-surface={menu.id} data-paged={paged ? '' : undefined} data-covered={covered ? '' : undefined} inert={covered || undefined}>
      <div className={styles.top}
        onPointerDown={event => {
          if (event.pointerType === 'mouse' || (event.target as Element).closest('button')) return;
          setSwipe({ pointer: event.pointerId, y: event.clientY });
        }}
        onPointerUp={event => {
          if (swipe && swipe.pointer === event.pointerId && event.clientY - swipe.y >= SWIPE_PX) onClose();
          setSwipe(null);
        }}
        onPointerCancel={() => setSwipe(null)}>
        <div className={styles.grab} data-testid="sheet-handle" aria-hidden="true"><span /></div>
        <div className={styles.head}>
          <p className={styles.title} data-testid="menu-title"><span aria-hidden="true">{menu.icon}</span>{menu.label}</p>
          <button type="button" className={styles.close} aria-label="Close" data-menu-close="" onClick={onClose}>×</button>
        </div>
      </div>
      <PanelScopeContext.Provider value={scope}>
        <div className={styles.body} data-testid="menu-body">{children}</div>
      </PanelScopeContext.Provider>
      <div ref={setSlot} className={styles.foot} data-panel-footer="" />
    </section>
  );
}
