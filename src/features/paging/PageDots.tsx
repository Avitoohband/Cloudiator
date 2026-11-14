'use client';

// Patch 1.9 Task 30 (Avi, 2026-11-13: "the circles down could be clicked to go to a certain page right away"): one circle per page,
// the current one gold. Hover or keyboard focus (`:focus-visible`, not a click's focus) shows a bubble with the page ("Page 3 of 8")
// or the section's name. Touch: a tap jumps and shows the bubble for 1.2 s; press and hold 0.3 s, then slide: the bubble rides above
// the finger and the page changes as the finger crosses each circle (a mouse can do the same). A press of any length selects the
// circle pressed. With more pages than circles the slide is measured from the pressed circle along the row, which stands for all
// pages (fix round 1, I3), and the row does not re-centre until the finger lifts. Sliding never reads from the server: only the "+"
// circle ("Load more") does, and it is never held. Pointer events with pointer capture, on this row only.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import { MAX_DOTS, dotWindow, slidePage } from './paging';
import styles from './paging.module.css';

/** Hold this long before a slide starts. */
const HOLD_MS = 300;
/** A tapped circle's bubble stays this long. */
const FLASH_MS = 1200;
/** A finger that travels this far before the hold is a swipe, not a hold. */
const SWIPE_PX = 10;
const NARROW_QUERY = '(max-width: 359px)';

const subscribeMedia = (onChange: () => void) => {
  const queries = [COMPACT_QUERY, NARROW_QUERY].map(query => window.matchMedia?.(query));
  queries.forEach(query => query?.addEventListener('change', onChange));
  return () => queries.forEach(query => query?.removeEventListener('change', onChange));
};
const readMax = () => (window.matchMedia?.(NARROW_QUERY).matches ? MAX_DOTS.narrow
  : window.matchMedia?.(COMPACT_QUERY).matches ? MAX_DOTS.phone : MAX_DOTS.desktop);

/** A bubble: where, and why (a tap's flash and a slide outlast the focus and the pointer leaving). */
type Tip = { at: number | 'more'; x?: number; scrub?: boolean; flash?: boolean };
type Press = { pointer: number; x: number; y: number; startX: number; startPage: number; timer: number; scrub: boolean; frozen: readonly (number | 'gap')[] | null; type: string; on: number | 'more' | null };

export function PageDots({ count, current, names, more = false, onGo, onMore }: {
  count: number; current: number;
  /** Sections: each circle's name ("Go to section: Worn equipment"). */
  names?: readonly string[];
  /** The total is unknown: a last "+" circle reads more. */
  more?: boolean;
  onGo(page: number): void; onMore?(): void;
}) {
  const max = useSyncExternalStore(subscribeMedia, readMax, () => MAX_DOTS.desktop);
  const [tip, setTip] = useState<Tip | null>(null);
  const [frozen, setFrozen] = useState<readonly (number | 'gap')[] | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const flash = useRef(0);
  const shown = useRef(current);
  useEffect(() => { shown.current = current; });
  useEffect(() => () => { window.clearTimeout(flash.current); if (press.current) window.clearTimeout(press.current.timer); }, []);

  const dots = frozen ?? dotWindow(current, count, max);
  /** A bubble whose circle has left the row (the row re-centred under a hover) is not shown (fix round 1, M5). */
  const shownTip = tip && (tip.scrub || (tip.at === 'more' ? more && !!onMore : dots.includes(tip.at))) ? tip : null;
  // A bubble that is no longer shown is forgotten, so it does not come back with its circle (fix round 2, R2-7).
  useEffect(() => { if (tip && !shownTip) setTip(null); }, [tip, shownTip]);
  const text = (at: number | 'more') => (at === 'more' ? 'Load more' : names ? names[at - 1] ?? '' : more ? `Page ${at}` : `Page ${at} of ${count}`);
  const label = (at: number) => (names ? `Go to section: ${names[at - 1] ?? at}` : `Go to page ${at}`);

  // A bubble that is not following a finger sits above its circle.
  useLayoutEffect(() => {
    const box = row.current, tipBox = bubble.current;
    if (!shownTip || shownTip.x !== undefined || !box || !tipBox) return;
    const dot = box.querySelector<HTMLElement>(`[data-dot="${shownTip.at}"]`);
    if (dot) tipBox.style.left = `${dot.offsetLeft + dot.offsetWidth / 2}px`;
  });

  const circles = () => [...(row.current?.querySelectorAll<HTMLElement>('[data-dot]:not([data-dot="more"])') ?? [])];
  const scrubAt = (clientX: number, windowed: readonly (number | 'gap')[], held: Press) => {
    const box = row.current;
    const list = circles();
    if (!box || list.length === 0) return;
    let page: number;
    if (windowed.includes('gap')) {
      const left = list[0].getBoundingClientRect().left, right = list[list.length - 1].getBoundingClientRect().right;
      page = slidePage(held.startPage, clientX - held.startX, right - left, count);
    } else {
      let best = Infinity;
      page = shown.current;
      for (const dot of list) {
        const r = dot.getBoundingClientRect(), distance = Math.abs(r.left + r.width / 2 - clientX);
        if (distance < best) { best = distance; page = Number(dot.dataset.dot); }
      }
    }
    setTip({ at: page, x: clientX - box.getBoundingClientRect().left, scrub: true });
    if (page !== shown.current) { shown.current = page; onGo(page); }
  };

  const endPress = (scrubbed: boolean) => {
    const held = press.current;
    if (held) window.clearTimeout(held.timer);
    press.current = null;
    if (scrubbed) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 400);
      setFrozen(null);
      setTip(null);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const target = (event.target as Element).closest<HTMLElement>('[data-dot]');
    const on = target ? (target.dataset.dot === 'more' ? 'more' : Number(target.dataset.dot)) : null;
    const pointer = event.pointerId, box = event.currentTarget;
    const held: Press = { pointer, x: event.clientX, y: event.clientY, startX: event.clientX, startPage: typeof on === 'number' ? on : shown.current,
      scrub: false, frozen: null, type: event.pointerType, on,
      timer: window.setTimeout(() => {
        if (press.current !== held || on === 'more') return;
        held.scrub = true;
        // The slide is measured from where the finger is when the hold fires, so a drift before it moves nothing (fix round 2, R2-5).
        held.startX = held.x;
        held.frozen = dotWindow(shown.current, count, max);
        setFrozen(held.frozen);
        try { box.setPointerCapture(pointer); } catch { /* The pointer is gone already. */ }
        scrubAt(held.x, held.frozen, held);
      }, HOLD_MS) };
    press.current = held;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = press.current;
    if (!held || held.pointer !== event.pointerId) return;
    if (!held.scrub) {
      if (Math.hypot(event.clientX - held.x, event.clientY - held.y) > SWIPE_PX) endPress(false);
      else held.x = event.clientX;
      return;
    }
    held.x = event.clientX;
    scrubAt(event.clientX, held.frozen ?? dots, held);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = press.current;
    if (!held || held.pointer !== event.pointerId) return;
    endPress(held.scrub);
    // A tap (not a mouse click): the bubble of the circle it reached shows for a moment.
    if (!held.scrub && held.type !== 'mouse' && held.on !== null) {
      window.clearTimeout(flash.current);
      setTip({ at: held.on === 'more' ? 'more' : held.on, flash: true });
      flash.current = window.setTimeout(() => setTip(null), FLASH_MS);
    }
  };

  /** Keyboard focus only: a click's or a tap's focus shows no bubble of its own. */
  const keyboardFocus = (element: Element) => { try { return element.matches(':focus-visible'); } catch { return false; } };
  /** Hides the hover or focus bubble of `at` (never a tap's flash or a slide's). */
  const hide = (at: number | 'more') => setTip(t => (t?.at === at && !t.scrub && !t.flash ? null : t));

  const go = (at: number | 'more') => {
    if (suppressClick.current) return;
    if (at === 'more') onMore?.();
    else if (at !== current) onGo(at);
  };

  return (
    <div ref={row} className={styles.dots} data-page-dots="" data-scrubbing={frozen ? '' : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={() => endPress(press.current?.scrub ?? false)} onContextMenu={event => event.preventDefault()}>
      {dots.map((at, i) => at === 'gap' ? <span key={`gap-${i}`} className={styles.gap} aria-hidden="true">…</span> : (
        <button key={at} type="button" className={styles.dot} data-dot={at} aria-label={label(at)} aria-current={at === current ? (names ? 'step' : 'page') : undefined}
          onClick={() => go(at)}
          onPointerEnter={event => { if (event.pointerType === 'mouse' && !press.current?.scrub) setTip({ at }); }}
          onPointerLeave={event => { if (event.pointerType === 'mouse' && !press.current?.scrub) hide(at); }}
          onFocus={event => { if (keyboardFocus(event.currentTarget)) setTip(t => (t?.flash || t?.scrub ? t : { at })); }} onBlur={() => hide(at)}>
          <i aria-hidden="true" />
        </button>
      ))}
      {more && onMore && <button type="button" className={`${styles.dot} ${styles.plus}`} data-dot="more" aria-label="Load more" onClick={() => go('more')}
        onPointerEnter={event => { if (event.pointerType === 'mouse') setTip({ at: 'more' }); }}
        onPointerLeave={() => hide('more')}
        onFocus={event => { if (keyboardFocus(event.currentTarget)) setTip(t => (t?.flash || t?.scrub ? t : { at: 'more' })); }} onBlur={() => hide('more')}>+</button>}
      {shownTip && <span ref={bubble} role="tooltip" className={styles.bubble} data-scrub={shownTip.scrub ? '' : undefined}
        style={shownTip.x !== undefined ? { left: `${shownTip.x}px` } : undefined}>{text(shownTip.at)}</span>}
      {shownTip?.scrub && <span className={styles.finger} style={{ left: `${shownTip.x}px` }} aria-hidden="true" />}
    </div>
  );
}
