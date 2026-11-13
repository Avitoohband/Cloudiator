'use client';

// Patch 1.9 Task 27 (Avi, 2026-11-12: "option to see gladiators arena match history\expedition history and tournaments battles history"; the
// approved mockup `.superpowers/design/2026-11-12-gladiator-history/`): a gladiator's History, in place of its card's sections. ← goes back to
// the card; the chips Arena (won–lost) · 🏆 Tournament fights (n) · Expeditions (n) each show a list of their own, newest first by day, 20 a
// page with Show more; the line under the chips says how long replays are kept. ▶ Watch opens a kept replay in the existing viewer for
// anyone; a row whose replay is gone is dimmed with Result. Tournament fights are gold rows (Avi: "should be fancier, so people can
// distinguish"): a gold double-trimmed frame, a trophy medallion with laurels, the round in gold small caps, the tournament's name, a WON
// or LOST pill. Rewards show only on the viewer's own card (`own`, from its own rewards); the foot says whose rewards show. Every word
// is `history-text`'s, rendered as text.
import { Fragment, useEffect, useId, useMemo, useRef, type Ref } from 'react';
import type { HistoryEntry, HistoryKind } from '@contracts/reads';
import { useClockMode } from '../../lib/clock-setting';
import type { SceneView } from '../shell/scene-url';
import { BotTag } from './BotTag';
import { useHistory, type HistoryStore } from './history-store';
import {
  EVERYTHING, HISTORY_KINDS, HISTORY_SUBTITLE, chipCount, chipText, emptyHistory, footerText, historyDays, historyRow, historyScene, historyTitle, retentionText, runLastRows,
  type HistoryRowText,
} from './history-text';
import styles from './GladiatorHistory.module.css';

const SEP = ' · ';

/**
 * A sub-line with its rating part coloured (up green, down red); the words are the sub-line's. Each part is one unbreakable span that starts
 * with its separator, after a plain space, so a long line wraps before a "·", never after one (as My bouts' rows).
 */
function Sub({ text }: { text: string }) {
  if (!text) return null;
  const tone = (part: string) => (part.startsWith('Rating +') ? styles.up : part.startsWith('Rating −') ? styles.down : null);
  return <>{text.split(SEP).map((part, i) => {
    const lead = i > 0 ? '· ' : '', colour = tone(part);
    return <Fragment key={i}>
      {i > 0 && ' '}
      <span className={styles.part}>{colour ? <>{lead}<span className={colour}>{part}</span></> : `${lead}${part}`}</span>
    </Fragment>;
  })}</>;
}

function Action({ text, onWatch }: { text: HistoryRowText; onWatch(): void }) {
  if (text.action === '▶ Watch') return <button type="button" className={styles.watch} aria-label={text.label} onClick={onWatch}>▶ Watch</button>;
  return text.action ? <span className={styles.result}>Result</span> : null;
}

function Row({ entry, text, onWatch }: { entry: HistoryEntry; text: HistoryRowText; onWatch(): void }) {
  const gone = text.kept ? undefined : '';
  // A row can take the focus from a Show more that goes away (fix round 1); it is not a tab stop.
  if (entry.kind === 'tournament') {
    return <li className={`${styles.trow} ${text.kept ? '' : styles.gone}`} data-history-row="tournament" data-gone={gone} tabIndex={-1}>
      <span className={styles.medal} data-medal="" aria-hidden="true">🏆</span>
      <span className={styles.who}>
        <span className={styles.round} data-round="">{text.round}</span>
        <span className={styles.tname}>{text.name}</span>
        <span className={styles.sub}>
          <span className={`${styles.pill} ${text.badge.won ? styles.won : styles.lost}`} data-pill="">{text.pill}</span>{' '}<Sub text={text.sub} />
        </span>
      </span>
      <Action text={text} onWatch={onWatch} />
    </li>;
  }
  return <li className={`${styles.row} ${text.kept ? '' : styles.gone}`} data-history-row={entry.kind} data-gone={gone} tabIndex={-1}>
    <span className={`${styles.badge} ${text.badge.won ? styles.won : styles.lost}`}>
      <span aria-hidden="true">{text.badge.text}</span><span className={styles.sr}>{text.badge.name}</span>
    </span>
    <span className={styles.who}>
      <span className={styles.name}>{text.name}{text.tag === 'BOT' ? <BotTag /> : text.tag && <span className={styles.tag}>{text.tag}</span>}</span>
      <span className={styles.sub}><Sub text={text.sub} /></span>
    </span>
    <Action text={text} onWatch={onWatch} />
  </li>;
}

export function GladiatorHistory({ store, kind, onKind, name, own, nowMs, onBack, onWatch, backRef, timeZone }: {
  store: HistoryStore;
  kind: HistoryKind;
  onKind(kind: HistoryKind): void;
  /** The gladiator's name (the viewer's own on its own card). */
  name: string;
  /** The viewer's own card: "My history" and its own rewards. */
  own: boolean;
  /** The server's time (the shell's minute clock): whether each replay is kept. */
  nowMs: number | null;
  onBack(): void;
  /** ▶ Watch: the scene to open (`historyScene`). */
  onWatch(view: Exclude<SceneView, { kind: 'bout' }>): void;
  backRef?: Ref<HTMLButtonElement>;
  /** Tests only: the time zone of the days and times (the viewer's own otherwise). */
  timeZone?: string;
}) {
  const ids = useId();
  const clock = useClockMode();
  const { list, counts, rewards } = useHistory(store, kind);
  const last = useMemo(() => runLastRows(list.rows), [list.rows]);
  const empty = emptyHistory(kind, name);
  const chipRefs = useRef(new Map<HistoryKind, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  // Fix round 1: Try again goes away as it reads, so the focus moves to the chip shown first; a Show more that lands the last page goes away
  // too, so the focus moves to the first new row (or the list, when nothing new came).
  const retry = () => { chipRefs.current.get(kind)?.focus({ preventScroll: true }); store.load(kind); };
  const moreFrom = useRef<number | null>(null);
  const showMore = () => {
    if (list.loadingMore) return;
    moreFrom.current = list.rows.length;
    void store.more(kind);
  };
  useEffect(() => {
    const from = moreFrom.current;
    if (from === null || list.loadingMore) return;
    moreFrom.current = null;
    if (list.nextCursor) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-history-row]');
    (rows && rows.length > from ? rows[from] : listRef.current)?.focus({ preventScroll: false });
  }, [list.loadingMore, list.nextCursor, list.rows.length]);
  return (
    <section className={styles.history} aria-labelledby={`${ids}-title`} data-history={kind}>
      <div className={styles.head}>
        <button ref={backRef} type="button" className={styles.back} aria-label="Back to the card" onClick={onBack}><span aria-hidden="true">←</span></button>
        <div className={styles.heading}>
          <h2 id={`${ids}-title`} className={styles.title}>{historyTitle(name, own)}</h2>
          <p className={styles.subtitle}>{HISTORY_SUBTITLE}</p>
        </div>
      </div>
      <div className={styles.chips} role="group" aria-label="Show history">
        {HISTORY_KINDS.map(option => {
          const chip = chipText(option), count = chipCount(option, counts);
          return <button key={option} ref={element => { if (element) chipRefs.current.set(option, element); else chipRefs.current.delete(option); }} type="button"
            className={styles.chip} aria-pressed={option === kind} onClick={() => onKind(option)}>
            {chip.icon && <span aria-hidden="true">{chip.icon} </span>}{chip.label}{count && <> <b>{count}</b></>}
          </button>;
        })}
      </div>
      <p className={styles.keep}>{retentionText(kind)}</p>
      {list.rows.length === 0
        ? list.status === 'failed'
          ? <div className={styles.failed} role="alert"><p>This history could not be loaded right now.</p>
            <button type="button" className={styles.more} onClick={retry}>Try again</button></div>
          : list.status === 'ready'
            ? <div className={styles.empty} data-history-empty=""><b>{empty.title}</b><p>{empty.line}</p></div>
            : <p className={styles.state} role="status">Loading the history…</p>
        : <>
          <div ref={listRef} className={styles.list} data-history-list="" tabIndex={-1}>
            {historyDays(list.rows, nowMs, timeZone).map((group, n) => (
              <section key={group.label} className={styles.group} aria-labelledby={`${ids}-day-${n}`}>
                <p id={`${ids}-day-${n}`} className={styles.day} data-history-day="">{group.label}</p>
                <ul className={styles.rows}>
                  {group.entries.map(entry => <Row key={entry.entryId} entry={entry} onWatch={() => onWatch(historyScene(entry))}
                    text={historyRow(entry, { nowMs, clock, timeZone, rewards: own ? rewards.get(entry.activityId) ?? null : null, runLast: last.has(entry.entryId) })} />)}
                </ul>
              </section>
            ))}
          </div>
          {/* aria-disabled while it reads, so a keyboard press keeps the focus on it (a disabled button would drop it). */}
          {list.nextCursor ? <button type="button" className={styles.more} onClick={showMore} aria-disabled={list.loadingMore || undefined}>Show more</button>
            : list.pages > 1 ? <p className={styles.everything}>{EVERYTHING}</p> : null}
          {list.moreFailed && <p className={styles.moreFailed} role="alert">More could not be loaded. Please try again.</p>}
        </>}
      <p className={styles.footer} data-history-footer="">{footerText(own)}</p>
    </section>
  );
}
