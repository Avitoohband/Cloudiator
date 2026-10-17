'use client';

// The left-edge rail: a 12 px reveal zone and a 5 px grip at rest; the pointer near the edge, over the grip or the
// rail (or keyboard focus) slides in the menu icons with the zoom buttons at the bottom; it slides away 300 ms after
// the pointer leaves unless a panel is open. Hovering or focusing an icon names it. On touch (no hover) a ☰ button
// shows the same buttons as a row. The state lives in `railReducer`; this component turns pointer, focus and timer
// signals into its events.
import { useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent } from 'react';
import type { MenuDef, MenuId } from './menus';
import { COMPACT_QUERY, RAIL_HIDE_MS, type RailEvent, type RailState } from './rail-reveal';
import styles from './shell.module.css';

export function MenuRail({ menus, state, send, onToggle, zoom }: {
  menus: readonly MenuDef[];
  state: RailState;
  send(event: RailEvent): void;
  onToggle(id: MenuId): void;
  /** The camera buttons, while the camp view is not unavailable. */
  zoom: ((direction: 'in' | 'out' | 'reset') => void) | null;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const railId = useId();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Touch pointers have no hover, and in the touch layout the ☰ button decides.
  const hoverless = (event?: PointerEvent) => event?.pointerType === 'touch' || window.matchMedia(COMPACT_QUERY).matches;
  const enter = (event: PointerEvent) => {
    if (hoverless(event)) return;
    hovering.current = true;
    window.clearTimeout(timer.current);
    send('edge-enter');
  };
  const leave = (event: PointerEvent) => {
    if (hoverless(event)) return;
    hovering.current = false;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (hovering.current || rail.current?.contains(document.activeElement)) return;
      send('leave-timeout');
    }, RAIL_HIDE_MS);
  };
  const focusOut = (event: FocusEvent) => {
    setTip(null);
    if (!rail.current?.contains(event.relatedTarget as Node | null) && !hovering.current && !hoverless()) send('focus-out');
  };
  const name = (label: string) => (event: { currentTarget: HTMLElement }) => {
    const button = event.currentTarget;
    setTip({ label, top: button.offsetTop + button.offsetHeight / 2 });
  };

  return <>
    <div className={styles.edge} onPointerEnter={enter} onPointerLeave={leave} aria-hidden="true" />
    <div className={styles.grip} onPointerEnter={enter} onPointerLeave={leave} data-testid="menu-grip" aria-hidden="true" />
    <button type="button" className={styles.burger} aria-label="Menus" aria-expanded={state.revealed} aria-controls={railId} data-menu-burger=""
      onClick={() => send(state.revealed ? 'leave-timeout' : 'edge-enter')}><span aria-hidden="true">☰</span></button>
    <div ref={rail} id={railId} className={styles.rail} data-revealed={state.revealed} data-testid="menu-rail"
      onPointerEnter={enter} onPointerLeave={event => { setTip(null); leave(event); }} onFocus={() => send('focus-in')} onBlur={focusOut}>
      <nav className={styles.menus} aria-label="Game menus">
        {menus.map(menu => (
          <button key={menu.id} type="button" className={styles.railButton} aria-label={menu.label} aria-expanded={state.open === menu.id}
            aria-controls={`menu-${menu.id}`} data-menu-icon={menu.id} onClick={() => onToggle(menu.id)}
            onPointerEnter={name(menu.label)} onFocus={name(menu.label)} onPointerLeave={() => setTip(null)}>
            <span aria-hidden="true">{menu.icon}</span>
          </button>
        ))}
      </nav>
      {zoom && <>
        <div className={styles.sep} aria-hidden="true" />
        <div className={styles.camera} role="group" aria-label="Camera controls">
          <button type="button" className={`${styles.railButton} ${styles.zoom}`} aria-label="Zoom in" onClick={() => zoom('in')}>+</button>
          <button type="button" className={`${styles.railButton} ${styles.zoom}`} aria-label="Zoom out" onClick={() => zoom('out')}>−</button>
          <button type="button" className={`${styles.railButton} ${styles.zoom} ${styles.zoomReset}`} aria-label="Reset zoom" onClick={() => zoom('reset')}>1:1</button>
        </div>
      </>}
      {tip && state.open === null && <span className={styles.tip} role="tooltip" style={{ top: tip.top }}>{tip.label}</span>}
    </div>
  </>;
}
