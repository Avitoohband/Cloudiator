'use client';

// The help tooltips on a stat or attribute label (Task 11c's profile card; Patch 1.9 Task 10 shares them with My gladiator). A dotted label is a
// button: hovering its row (mouse), focusing it by keyboard or pressing it (touch) opens a tooltip with the sentence (and, when given, a second line
// of numbers); Escape or a press elsewhere closes it. The button is described by its tooltip (`aria-describedby`) while it is open. The tooltip sits
// below its row, or above when the scrollport has no room below it. One tooltip is open at a time.
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

type Hint = { label: string; source: 'hover' | 'focus' | 'press' };

export type StatHintOptions = {
  /** The button's, the tooltip's and the flipped tooltip's classes (the caller's stylesheet). */
  buttonClass: string;
  tipClass: string;
  aboveClass: string;
  /** The box the tooltip must stay inside, for a row; the nearest scrolling ancestor by default. */
  scrollport?(row: Element): HTMLElement | null;
  /** A class for the second line of numbers. */
  numbersClass?: string;
};

function scrollingAncestor(row: Element): HTMLElement | null {
  for (let node = row.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

export function useStatHints({ buttonClass, tipClass, aboveClass, scrollport = scrollingAncestor, numbersClass }: StatHintOptions) {
  const hintId = useId();
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const hintOpen = hint !== null;
  const openLabel = hint?.label;
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const row = tooltip?.closest('[data-profile-stat-help]');
    if (!tooltip || !row) return;

    const update = () => {
      const port = scrollport(row);
      const top = port ? port.getBoundingClientRect().top + port.clientTop : 0;
      const bottom = port ? top + port.clientHeight : window.innerHeight;
      const bounds = row.getBoundingClientRect();
      const below = Math.min(window.innerHeight, bottom) - bounds.bottom;
      const above = bounds.top - Math.max(0, top);
      tooltip.classList.toggle(aboveClass, below < tooltip.offsetHeight && above > below);
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
    // `scrollport` and the class are the caller's constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLabel]);
  useEffect(() => {
    if (!hintOpen) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof Element && event.target.closest('dialog[open]'))) return;
      event.preventDefault();
      setHint(null);
    };
    const dismissOutside = (event: globalThis.PointerEvent) => {
      // Only a press inside one of this hook's own rows keeps its tooltip: another hook's row (the panel's, the card's) closes it.
      if (event.target instanceof Element && event.target.closest('[data-profile-stat-help]')?.getAttribute('data-profile-stat-help') !== hintId) setHint(null);
    };
    document.addEventListener('keydown', dismissOnEscape, true);
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => {
      document.removeEventListener('keydown', dismissOnEscape, true);
      document.removeEventListener('pointerdown', dismissOutside, true);
    };
  }, [hintOpen]);

  /** The props of the (positioned) row that holds a label's button and tooltip: hovering it opens the hint. */
  const hintRow = (label: string) => ({
    'data-profile-stat-help': hintId,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse' && window.matchMedia('(any-hover: hover)').matches) {
        setHint(current => current && (current.label === label || current.source !== 'hover') ? current : { label, source: 'hover' });
      }
    },
    onPointerLeave: () => setHint(current => current?.label === label && current.source === 'hover' ? null : current),
  });
  /** The label's button, and its tooltip while open: the sentence, then `numbers` as a second line when given. */
  const hintLabel = (label: string, description: string, numbers?: string): ReactNode => {
    const open = hint?.label === label;
    const id = `${hintId}-${label.toLowerCase().replaceAll(' ', '-')}`;
    return <>
      <button type="button" className={buttonClass} aria-expanded={open} aria-describedby={open ? id : undefined}
        onFocus={event => {
          if (event.currentTarget.matches(':focus-visible')) setHint({ label, source: 'focus' });
        }}
        onBlur={() => setHint(current => current?.label === label ? null : current)}
        onClick={() => setHint(current => current?.label === label && current.source === 'press' ? null : { label, source: 'press' })}
      >{label}</button>
      {open && <span ref={tooltipRef} id={id} role="tooltip" className={tipClass}>{description}{numbers && <span className={numbersClass} data-hint-numbers="">{numbers}</span>}</span>}
    </>;
  };
  return { hintRow, hintLabel };
}

/** The props `hintRow` gives a row. */
export type HintRowProps = ReturnType<ReturnType<typeof useStatHints>['hintRow']>;
