'use client';

// Patch 1.9 Task 30: one paged list. It keeps the page (and, for lists, the Show choice saved on this device), cuts the page's rows,
// and after a turn moves the focus to the first row of the new page (`listRef`, the page's container; a row is an element with
// `data-page-row`, else a child of the container). The state lives in `page-controller.ts`; this file adds React and the DOM.
// Closing the menu unmounts the list and so forgets the page.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPageController } from './page-controller';
import { PAGE_SIZES, pageRows, type ListId } from './paging';
import { readPageSize, writePageSize } from './page-size-prefs';

export type PagedList<T> = {
  rows: readonly T[]; page: number; pages: number | null; knownPages: number; size: number; fit: number;
  /** All the rows loaded now (an addition to the Task 30 brief: the bar shows when there are more than `fit`). */
  total: number;
  canBack: boolean; canNext: boolean; busy: boolean; failed: boolean;
  back(): void; next(): void; go(page: number): void; goToIndex(index: number): void; setSize(size: number): void;
  /** The page's container: receives the focus after a turn. */
  listRef: RefObject<HTMLElement | null>;
};

/** The rows of a page's container, in order. */
export function pageRowsOf(box: HTMLElement): HTMLElement[] {
  const marked = [...box.querySelectorAll<HTMLElement>('[data-page-row]')];
  return marked.length > 0 ? marked : [...box.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
}

/** The nearest ancestor that scrolls (the menu's body), or null. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/** Focuses a row without the browser's own jump, then brings it just into view. */
function focusRow(row: HTMLElement) {
  if (!row.hasAttribute('tabindex')) row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'nearest' });
}

export function usePagedList<T>(all: readonly T[], options: {
  list: ListId; size?: number;
  resetKey?: string | number;
  more?: { hasMore: boolean; load(): Promise<unknown> };
}): PagedList<T> {
  const { list, size: fixed, resetKey, more } = options;
  const fit = fixed ?? PAGE_SIZES[list];
  // The first render uses Fit, as the prerendered page does; the Show choice saved on this device applies before the first paint
  // (fix round 1, M2), so a panel mounted from the first render (Arena) hydrates without a mismatch.
  const [chosen, setChosen] = useState(fit);
  useLayoutEffect(() => {
    if (fixed === undefined) setChosen(readPageSize(list, fit));
  }, [list, fit, fixed]);
  const size = fixed ?? chosen;
  const [controller] = useState(createPageController);
  controller.sync({ total: all.length, size, hasMore: !!more?.hasMore, resetKey: resetKey ?? '' }, more ? () => more.load() : null);
  useSyncExternalStore(controller.subscribe, controller.version, controller.version);
  const view = controller.view();
  const listRef = useRef<HTMLElement | null>(null);

  // After a turn: the focus to the first row of the new page, or a jumped-to row into view. A turn that waits for a read is
  // handled once its rows are here.
  const handled = useRef(view.turn);
  const reveal = useRef<number | null>(null);
  useEffect(() => {
    const box = listRef.current;
    if (reveal.current !== null && box) {
      const row = pageRowsOf(box)[reveal.current - (view.page - 1) * size];
      reveal.current = null;
      row?.scrollIntoView?.({ block: 'nearest' });
    }
    if (view.turn === handled.current || !box) return;
    if (view.page !== view.target && more?.hasMore) return;
    handled.current = view.turn;
    const rows = pageRowsOf(box);
    if (view.jump !== null) {
      rows[view.jump - (view.page - 1) * size]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (rows[0]) focusRow(rows[0]);
  });

  const setSize = useCallback((next: number) => {
    if (fixed !== undefined) return;
    // The first row on screen now: the first one whose bottom is below the top of the part that scrolls.
    let first = (controller.view().page - 1) * size;
    const box = listRef.current;
    if (box) {
      const rows = pageRowsOf(box);
      const scroll = scroller(box);
      const top = scroll ? scroll.getBoundingClientRect().top : -Infinity;
      const at = rows.findIndex(row => row.getBoundingClientRect().bottom > top + 2);
      if (at > 0) first += at;
    }
    writePageSize(list, next);
    setChosen(next);
    reveal.current = first;
    controller.resize(next, first);
  }, [controller, fixed, list, size]);

  return {
    rows: pageRows(all, view.page, size), page: view.page, pages: view.pages, knownPages: view.knownPages, size, fit, total: all.length,
    canBack: view.canBack, canNext: view.canNext, busy: view.busy, failed: view.failed,
    back: controller.back, next: controller.next, go: controller.go, goToIndex: controller.goToIndex, setSize, listRef,
  };
}
