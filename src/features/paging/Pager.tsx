'use client';

// Patch 1.9 Task 30: the bar under a paged list: "‹ Back · Page 2 of 5 · Next ›" with the circles (Next in gold, the usual move).
// The ends stay in place with `aria-disabled`, so the focus is never lost and Next never jumps around. With `show` (lists, not
// grids) a Show choice: "Fit (7)", 10, 25, 50. Nothing when the list has at most `fit` rows and nothing more to read; otherwise it
// stays, even when the Show choice makes one page. A polite status says the page after a turn. Put it in a `PanelFooter`.
import { useEffect, useRef, useState } from 'react';
import { pagerLabel, showChoices } from './paging';
import { PageDots } from './PageDots';
import { usePageKeys } from './usePageKeys';
import type { PagedList } from './usePagedList';
import styles from './paging.module.css';

export function Pager<T>({ list, show = false }: { list: PagedList<T>; show?: boolean }) {
  const nav = useRef<HTMLElement>(null);
  const visible = list.total > list.fit || list.pages === null;
  const [status, setStatus] = useState('');
  const last = useRef(list.page);
  useEffect(() => {
    if (list.page === last.current) return;
    last.current = list.page;
    setStatus(pagerLabel(list.page, list.pages).main);
  }, [list.page, list.pages]);
  const back = () => { if (list.canBack) list.back(); };
  const next = () => { if (list.canNext) list.next(); };
  usePageKeys(nav, { PageDown: next, PageUp: back }, visible);
  if (!visible) return null;
  const { main, sub } = pagerLabel(list.page, list.pages);
  return (
    <nav ref={nav} className={styles.pager} aria-label="Pages" data-pager="">
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
        {(list.failed || list.busy || sub) && <span className={styles.sub}>{list.failed ? 'Could not load more. Try Next again.' : list.busy ? 'Loading…' : sub}</span>}
      </div>
      <PageDots count={list.knownPages} current={list.page} more={list.pages === null} onGo={list.go} onMore={() => list.go(list.knownPages + 1)} />
      <button type="button" className={styles.next} aria-label="Next page" aria-disabled={!list.canNext} aria-busy={list.busy || undefined} onClick={next}>Next ›</button>
      <p className={styles.sr} role="status">{status}</p>
    </nav>
  );
}
