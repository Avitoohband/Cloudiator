'use client';

// One menu's floating panel (a bottom sheet on touch): a labelled, non-modal dialog that takes the focus when it opens,
// scrolls internally and closes with its × button or, on touch, a swipe down on its handle. It renders outside the camp
// view's element, so the camp's key handlers never see keystrokes typed here.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MenuDef } from './menus';
import styles from './shell.module.css';

/** A sheet closes when its top is dragged down at least this far. */
const SWIPE_PX = 50;

export function MenuSurface({ menu, open, onClose, children }: { menu: MenuDef; open: boolean; onClose(): void; children: ReactNode }) {
  const surface = useRef<HTMLElement>(null);
  const [swipe, setSwipe] = useState<{ pointer: number; y: number } | null>(null);
  useEffect(() => { if (open) surface.current?.focus({ preventScroll: true }); }, [open]);
  return (
    <section ref={surface} id={`menu-${menu.id}`} className={styles.surface} role="dialog" aria-label={menu.label} tabIndex={-1} hidden={!open}
      data-menu-surface={menu.id}>
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
      <div className={styles.body} data-testid="menu-body">{children}</div>
    </section>
  );
}
