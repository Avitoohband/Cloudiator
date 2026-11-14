'use client';

// Patch 1.9 Task 30: the bar under a paged list: "‹ Back · Page 2 of 5 · Next ›" with the circles (Next in gold, the usual move).
// The ends stay in place with `aria-disabled`, so the focus is never lost and Next never jumps around. With `show` (lists, not
// grids) a Show choice: "Fit (7)", 10, 25, 50. Nothing when the list has at most `fit` rows and nothing more to read; otherwise it
// stays, even when the Show choice makes one page. A polite status says the page after a turn. Put it in a `PanelFooter`.
import { useEffect, useRef, useState } from 'react';
import { MAX_DOTS, pagerLabel, showChoices } from './paging';
import { PageDots } from './PageDots';
import { usePageKeys } from './usePageKeys';
import type { PagedList } from './usePagedList';
import styles from './paging.module.css';

const FAILED = 'Could not load more. Try Next again.';

/**
 * `label` names the bar's navigation landmark (final review M5): "Pages" by default; a panel with several bars names each for its list (Tournaments:
 * "Entrant pages", "Bout pages", "Placement pages").
 */
export function Pager<T>({ list, show = false, label = 'Pages' }: { list: PagedList<T>; show?: boolean; label?: string }) {
  const nav = useRef<HTMLElement>(null);
  const visible = list.total > list.fit || list.pages === null;
  const [status, setStatus] = useState('');
  const last = useRef(list.page);
  useEffect(() => {
    if (list.page === last.current) return;
    last.current = list.page;
    setStatus(pagerLabel(list.page, list.pages).main);
  }, [list.page, list.pages]);
  // A failed read is said too (fix round 1, Task 31): the bar's own polite status carries it, since the line under the label is not a live region.
  useEffect(() => { if (list.failed) setStatus(previous => (previous === FAILED ? `${FAILED} ` : FAILED)); }, [list.failed]);
  const back = () => { if (list.canBack) list.back(); };
  const next = () => { if (list.canNext) list.next(); };
  usePageKeys(nav, { PageDown: next, PageUp: back }, visible);
  if (!visible) return null;
  const { main, sub } = pagerLabel(list.page, list.pages);
  // More than 8 circles (24 px each) do not fit between the buttons on a desktop panel: they take their own row.
  const wideDots = Math.min(list.knownPages, MAX_DOTS.desktop) + (list.pages === null ? 1 : 0) > 8;
  return (
    <nav ref={nav} className={styles.pager} aria-label={label} data-pager="" data-dots={wideDots ? 'wide' : undefined}>
      <button type="button" className={styles.back} aria-label="Previous page" aria-disabled={!list.canBack} onClick={back}>‹ Back</button>
      <div className={styles.where}>
        <span className={styles.label}>
          <b>{main}</b>
          {show && <label className={styles.show}>Show:{' '}
            <select aria-label="Rows per page" value={list.size} onChange={event => list.setSize(Number(event.target.value))}>
              {showChoices(list.fit).map(choice => <option key={choice} value={choice}>{choice === list.fit ? `Fit (${choice})` : choice}</option>)}
            </select>
          </label>}
        </span>
        {(list.failed || list.busy || sub) && <span className={styles.sub}>{list.failed ? FAILED : list.busy ? 'Loading…' : sub}</span>}
      </div>
      <PageDots count={list.knownPages} current={list.page} more={list.pages === null} onGo={list.go} onMore={() => list.go(list.knownPages + 1)} />
      <button type="button" className={styles.next} aria-label="Next page" aria-disabled={!list.canNext} aria-busy={list.busy || undefined} onClick={next}>Next ›</button>
      <p className={styles.sr} role="status">{status}</p>
    </nav>
  );
}
