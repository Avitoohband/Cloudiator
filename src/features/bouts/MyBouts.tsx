'use client';

// My bouts, the player's tab of 📜 Results (Arena replays spec 1, the approved mockup): the owner's own Arena and tournament bouts,
// newest first, by day, each with its result, opponent, renown and rating change, a dot until watched on this device and ▶ Watch (or
// Result once the replay is gone). The chips All · Won · Lost each show a list of their own; 20 a page, then More. The list is read
// again each time it is shown (Results reads once each time it opens), keeping the rows on screen until the new page lands.
import { useEffect, useId } from 'react';
import type { BoutFilter, MyBout } from '../../lib/api/reads';
import { useClockMode } from '../../lib/clock-setting';
import { boutRow, dayGroups, emptyText } from './bout-text';
import { BoutRow } from './BoutRow';
import { useBoutList, type BoutsStore } from './bouts-store';
import { useWatched } from './watched';
import styles from './bouts.module.css';

const CHIPS: readonly { filter: BoutFilter; label: string }[] = [{ filter: 'all', label: 'All' }, { filter: 'won', label: 'Won' }, { filter: 'lost', label: 'Lost' }];

export function MyBouts({ store, filter, onFilter, nowMs, onOpen, timeZone }: {
  store: BoutsStore;
  filter: BoutFilter;
  onFilter(filter: BoutFilter): void;
  /** The server's time (the shared display clock): whether each replay is kept; null until known (no buttons, no "today"). */
  nowMs: number | null;
  onOpen(bout: MyBout): void;
  /** Tests only: the time zone of the days and times (the viewer's own otherwise). */
  timeZone?: string;
}) {
  const ids = useId();
  // Before the list's own first use (an effect declared earlier runs first): every list read before is read again, once per opening.
  useEffect(() => { store.reload(); }, [store]);
  const list = useBoutList(store, filter);
  const watched = useWatched();
  const clock = useClockMode();
  const { rows, status } = list;

  return (
    <div className={styles.bouts}>
      <div className={styles.chips} role="group" aria-label="Show bouts">
        {CHIPS.map(chip => <button key={chip.filter} type="button" className={styles.chip} aria-pressed={chip.filter === filter}
          onClick={() => onFilter(chip.filter)}>{chip.label}</button>)}
      </div>
      <p className={styles.keep}>Replays are kept 7 days · <span className={styles.legend} aria-hidden="true">●</span> not watched yet</p>
      {rows.length === 0
        ? status === 'failed'
          ? <div className={styles.failed} role="alert"><p>Your bouts could not be loaded right now.</p>
            <button type="button" className={styles.more} onClick={() => store.load(filter)}>Try again</button></div>
          : status === 'ready' ? <p className={styles.state} role="status">{emptyText(filter)}</p>
            : <p className={styles.state} role="status">Loading your bouts…</p>
        : dayGroups(rows, nowMs ?? Number.NaN, timeZone).map((group, n) => (
          <section key={group.label} className={styles.group} aria-labelledby={`${ids}-day-${n}`}>
            <p id={`${ids}-day-${n}`} className={`eyebrow ${styles.day}`}>{group.label}</p>
            <ul className={styles.list}>
              {group.bouts.map(bout => <BoutRow key={bout.activityId} text={boutRow(bout, nowMs, clock, timeZone)} watched={watched.has(bout.activityId)}
                onOpen={() => onOpen(bout)} />)}
            </ul>
          </section>
        ))}
      {rows.length > 0 && list.nextCursor && <button type="button" className={styles.more} onClick={() => void store.more(filter)}
        disabled={list.loadingMore || status !== 'ready'}>More</button>}
      {list.moreFailed && <p className={styles.moreFailed} role="alert">More bouts could not be loaded. Please try again.</p>}
    </div>
  );
}
