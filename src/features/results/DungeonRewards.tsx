'use client';

import type { GameNotification } from '@contracts/reads';
import { useClockMode } from '../../lib/clock-setting';
import { replayKept } from '../../lib/replay-retention';
import { usePagedList } from '../paging/usePagedList';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
import type { RefObject } from 'react';
import { notificationLines } from '../messages/notifications';
import { resultTime } from './result-text';
import styles from './ResultsPanel.module.css';

export function DungeonRewardsView({ notes, serverNowMs, onWatch }: {
  notes: readonly GameNotification[]; serverNowMs: number | null; onWatch(activityId: string): void;
}) {
  const clock = useClockMode();
  // Patch 1.9 Task 32: the notifications' dungeon rewards (all loaded) eight a page.
  const paged = usePagedList(notes, { list: 'results' });
  return <section className={styles.results} aria-label="Recent dungeon rewards">
    <p className="eyebrow">RECENT DUNGEON REWARDS</p>
    <p className="muted">Dungeon rewards from your 20 most recent activity notifications.</p>
    {notes.length === 0 ? <p className="muted" role="status">No recent dungeon rewards.</p>
      : <ul ref={paged.listRef as RefObject<HTMLUListElement | null>} className={styles.list} aria-label="Dungeon rewards">{paged.rows.map(note => {
        const { title, lines } = notificationLines(note);
        const kept = serverNowMs !== null && replayKept(note.summary.replayExpiry, serverNowMs);
        return <li key={note.activityId} className={styles.row} data-page-row="" tabIndex={-1}>
          <div className={styles.what}>
            <p className={styles.line}>{title}</p>
            <p className={styles.when}>{resultTime(note.settledAtMs, clock)}</p>
            <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
          </div>
          {kept && <button type="button" className={styles.watch} aria-label={`Replay: ${title}`} onClick={() => onWatch(note.activityId)}>Replay</button>}
        </li>;
      })}</ul>}
    <PanelFooter><Pager list={paged} show /></PanelFooter>
  </section>;
}
