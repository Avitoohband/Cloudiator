'use client';

// Patch history (Patch A spec, "Patch numbers and the changelog", Client; Avi approved the mockup in chat, 2026-10-29): inside the messages
// panel, opened from the account menu's "Patch history ›" and from a patch note's number. The heading, "You are playing Patch 1.4" (when
// the server has a newer patch, "· Patch 1.5 is out" and Reload), then every patch newest first, each a disclosure button with its number,
// title and date; one is open at a time, at first the newest or the one a note named. An open patch lists its features and, when its note
// is one the panel can show, "Read the patch note ›". Patch 1.9 Task 31: 8 patches a page with Back and Next; Next past the loaded ones reads the next 20
// from the server (its total is unknown until the last page: "Page 2 / more to see"), and a patch a note named opens on the page that holds it. The text is data, shown as plain text.
// The panel's own head holds "‹ Back to messages" and ×. The focus goes to the heading when it opens (the control that opened it is gone).
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { isBehind, playingLine, type PatchEntry } from '../../lib/patch';
import { messageDate } from './messages';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
import { usePagedList } from '../paging/usePagedList';
import { reloadPage } from '../shell/PatchNotice';
import styles from './messages.module.css';

type Pages = { items: PatchEntry[]; more: boolean };
const NO_PATCHES: readonly PatchEntry[] = [];

export function PatchHistory({ load, build, latest, open, notes, onReadNote }: {
  /** One page of 20 patches, older than `beforeSortKey` when given. */
  load(beforeSortKey?: number): Promise<Pages>;
  /** The patch this build is (`PATCH`). */
  build: string;
  /** The server's newest patch, from the latest revision read (null when unknown). */
  latest: string | null;
  /** The patch to open at first; null opens the newest. */
  open: string | null;
  /** The ids of the patch notes the panel can show: a patch links "Read the patch note ›" only to one of them. */
  notes: readonly number[];
  onReadNote(messageId: number): void;
}) {
  const ids = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [pages, setPages] = useState<Pages | null>(null);
  const [failed, setFailed] = useState(false);
  // Which patch is open: `undefined` until the player chooses (then the one named, else the newest), null when they closed it.
  const [chosen, setChosen] = useState<string | null | undefined>(open ?? undefined);
  // Only the latest read lands, and nothing after the view is gone.
  const ticket = useRef(0);
  /** Reads a page; the promise settles once the rows are in (or rejects when the read fails), for the pager's Next. */
  const read = (before?: number) => new Promise<void>((resolve, reject) => {
    const mine = ++ticket.current;
    load(before).then(page => {
      if (mine !== ticket.current) { resolve(); return; }
      setPages(previous => {
        if (before === undefined || previous === null) return { items: page.items, more: page.more };
        const known = new Set(previous.items.map(p => p.number));
        return { items: [...previous.items, ...page.items.filter(p => !known.has(p.number))], more: page.more };
      });
      setFailed(false);
      resolve();
    }, () => {
      if (mine !== ticket.current) { resolve(); return; }
      setFailed(true);
      reject(new Error('patches'));
    });
  });
  useEffect(() => {
    heading.current?.focus();
    read().catch(() => undefined);
    return () => { ticket.current++; };
  }, []);

  const items = pages?.items ?? null;
  const current = chosen === undefined ? (items?.[0]?.number ?? null) : chosen;
  const behind = isBehind(latest, build);
  const lead = `You are playing Patch ${build}`;
  const paged = usePagedList(items ?? NO_PATCHES, { list: 'patches', more: { hasMore: !!pages?.more, load: () => {
    const last = items?.at(-1);
    return last ? read(last.sortKey) : Promise.resolve();
  } } });
  // The patch a note named opens on the page that holds it, once the list is read (once).
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || items === null) return;
    landed.current = true;
    const at = open === null ? -1 : items.findIndex(patch => patch.number === open);
    if (at > 0) paged.goToIndex(at);
  });

  return (
    <div className={styles.history} data-testid="patch-history">
      <h3 ref={heading} className={styles.detailTitle} tabIndex={-1}>Patch history</h3>
      <p className={styles.playing}>
        <span>You are playing <b>Patch {build}</b>{playingLine(build, latest).slice(lead.length)}</span>
        {behind && <button type="button" className={styles.reload} onClick={reloadPage}>Reload</button>}
      </p>
      {items === null ? (failed ? <div className={styles.state}>
        <p role="alert">Patch history could not be loaded.</p>
        <button type="button" className={styles.retry} onClick={() => read()}>Try again</button>
      </div> : <p role="status" className={styles.state}>Loading patches…</p>) : <>
        <ul className={styles.patches} ref={paged.listRef as RefObject<HTMLUListElement | null>}>
          {paged.rows.map(patch => {
            const expanded = patch.number === current;
            const detailId = `${ids}-patch-${patch.number}`;
            const note = patch.messageId !== null && notes.includes(patch.messageId) ? patch.messageId : null;
            return <li key={patch.number} data-page-row="" tabIndex={-1}>
              <button type="button" className={styles.patchButton} data-patch={patch.number} aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}
                onClick={() => setChosen(expanded ? null : patch.number)}>
                <span className={styles.patchPill}>{patch.number}</span>
                <span className={styles.sr}> · </span>
                <span className={styles.patchTitle}>{patch.title}</span>
                <span className={styles.sr}> · </span>
                <span className={styles.date}>{messageDate(patch.releasedAtMs)}</span>
                <span className={styles.chevron} aria-hidden="true" />
              </button>
              {expanded && <div id={detailId} className={styles.patchDetail}>
                <ul className={styles.features}>{patch.features.map((feature, n) => <li key={n}>{feature}</li>)}</ul>
                {note !== null && <button type="button" className={styles.textButton} onClick={() => onReadNote(note)}>
                  Read the patch note<span aria-hidden="true"> ›</span>
                </button>}
              </div>}
            </li>;
          })}
        </ul>
        <PanelFooter><Pager list={paged} /></PanelFooter>
      </>}
    </div>
  );
}
