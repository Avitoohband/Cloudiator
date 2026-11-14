'use client';

// Patch 1.9 Task 27 (Avi, 2026-11-12: "option to see gladiators arena match history\expedition history and tournaments battles history"; the
// approved mockup `.superpowers/design/2026-11-12-gladiator-history/`): a gladiator's History, in place of its card's sections. ← goes back to
// the card; the chips Arena (won–lost) · 🏆 Tournament fights (n) · Expeditions (n) each show a list of their own, newest first by day, read 20
// at a time and shown six a page (four on the touch layout) with Back and Next (Patch 1.9 Task 32: Next past the loaded rows reads the next 20, and Back from a replay
// reopens the page and row it was opened from); the line under the chips says how long replays are kept. ▶ Watch opens a kept replay in the existing viewer for
// anyone; a row whose replay is gone is dimmed with Result. Tournament fights are gold rows (Avi: "should be fancier, so people can
// distinguish"): a gold double-trimmed frame, a trophy medallion with laurels, the round in gold small caps, the tournament's name, a WON
// or LOST pill. Rewards show only on the viewer's own card (`own`, from its own rewards); the foot says whose rewards show. Every word
// is `history-text`'s, rendered as text.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type Ref, type RefObject } from 'react';
import type { HistoryEntry, HistoryKind } from '@contracts/reads';
import { useClockMode } from '../../lib/clock-setting';
import type { SceneView } from '../shell/scene-url';
import { BotTag } from './BotTag';
import { useHistory, type HistoryStore } from './history-store';
import { clearHistoryRow, landingStep, rememberHistoryRow, takeHistoryRow, type Landing } from './history-return';
import { useCompactLayout } from './useCompactLayout';
import { usePagedList } from '../paging/usePagedList';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
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
  // A row takes the focus after a page turn (Patch 1.9 Task 32); it is not a tab stop.
  if (entry.kind === 'tournament') {
    return <li className={`${styles.trow} ${text.kept ? '' : styles.gone}`} data-history-row="tournament" data-page-row="" data-gone={gone} tabIndex={-1}>
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
  return <li className={`${styles.row} ${text.kept ? '' : styles.gone}`} data-history-row={entry.kind} data-page-row="" data-gone={gone} tabIndex={-1}>
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

export function GladiatorHistory({ store, kind, onKind, name, own, nowMs, onBack, onWatch, backRef, timeZone, gladiatorId, active = true }: {
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
  /** The card's gladiator: with it, Back from a replay opened from a row reopens the page and row it was opened from. */
  gladiatorId?: string;
  /**
   * Shown (the default). My gladiator keeps its History section mounted while another section shows, so the page and the chip are kept;
   * meanwhile its bar, which `PanelFooter` puts at the menu's bottom edge, is not rendered (the 1.9 merge).
   */
  active?: boolean;
  /** Tests only: the time zone of the days and times (the viewer's own otherwise). */
  timeZone?: string;
}) {
  const ids = useId();
  const clock = useClockMode();
  const { list, counts, rewards } = useHistory(store, kind);
  const last = useMemo(() => runLastRows(list.rows), [list.rows]);
  const empty = emptyHistory(kind, name);
  const chipRefs = useRef(new Map<HistoryKind, HTMLButtonElement>());
  // The pager knows only about its own reads. Report a failed replay landing here until it takes over.
  const [landingFailed, setLandingFailed] = useState(false);
  // Six a page (Patch 1.9 Task 32); a chip goes back to page 1. Next past the loaded rows reads the next server page; a failed read
  // rejects, so the pager says so and Next tries again.
  // On the touch layout the sheet holds four of its rows, so a page is four there (the hook's `size`, as a grid passes its layout's): no Show.
  const compact = useCompactLayout();
  const paged = usePagedList(list.rows, {
    list: 'history', resetKey: kind, size: compact ? 4 : undefined,
    more: list.nextCursor ? { hasMore: true, load: async () => {
      setLandingFailed(false);
      const done = await store.more(kind);
      if (!done && store.list(kind).moreFailed) throw new Error('More could not be loaded.');
    } } : undefined,
  });
  // Try again goes away as it reads, so the focus moves to the chip shown first.
  const retry = () => { chipRefs.current.get(kind)?.focus({ preventScroll: true }); store.load(kind); };
  // Back from a replay this card opened: the page and row it was opened from (kept in `history-return`, taken once). Rows not read yet are
  // read first, a page at a time, and a row on the partly read last page waits for the rest of it.
  const landing = useRef<Landing | null>(null);
  /** Names this History as the maker of a marker, so it forgets only its own (a profile card's marker is not its to clear). */
  const token = useRef({});
  // A History that stays mounted under the replay (My gladiator's section) restores itself when the scene closes: the marker is only for one
  // that remounts (the profile card), so it is forgotten as soon as the address is back from the scene (Codex review, finding 7).
  useEffect(() => {
    const back = () => { if (!new URL(window.location.href).searchParams.has('view')) clearHistoryRow(token.current); };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    const found = gladiatorId ? takeHistoryRow(gladiatorId, kind) : null;
    if (found) landing.current = { kind, entryId: found };
  }, [gladiatorId, kind]);
  useEffect(() => {
    const wanted = landing.current;
    if (!wanted || list.status !== 'ready') return;
    const next = landingStep(wanted, { kind, ids: list.rows.map(row => row.entryId), hasMore: list.nextCursor !== null, failed: list.moreFailed, size: paged.size });
    if (next.step === 'jump') { landing.current = null; paged.goToIndex(next.index); }
    else if (next.step === 'read') { if (!list.loadingMore) void store.more(kind); }
    else if (next.step === 'failed') { landing.current = null; setLandingFailed(true); }
    else landing.current = null;
  });
  useEffect(() => { setLandingFailed(false); }, [kind]);
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
      <p className={styles.keep} title={retentionText(kind)}>{retentionText(kind)}</p>
      {list.rows.length === 0
        ? list.status === 'failed'
          ? <div className={styles.failed} role="alert"><p>This history could not be loaded right now.</p>
            <button type="button" className={styles.more} onClick={retry}>Try again</button></div>
          : list.status === 'ready'
            ? <div className={styles.empty} data-history-empty=""><b>{empty.title}</b><p>{empty.line}</p></div>
            : <p className={styles.state} role="status">Loading the history…</p>
        : <>
          <div ref={paged.listRef as RefObject<HTMLDivElement | null>} className={styles.list} data-history-list="" tabIndex={-1}>
            {historyDays(paged.rows, nowMs, timeZone).map((group, n) => (
              <section key={group.label} className={styles.group} aria-labelledby={`${ids}-day-${n}`}>
                <p id={`${ids}-day-${n}`} className={styles.day} data-history-day="">{group.label}</p>
                <ul className={styles.rows}>
                  {group.entries.map(entry => <Row key={entry.entryId} entry={entry} onWatch={() => { if (gladiatorId) rememberHistoryRow(gladiatorId, kind, entry.entryId, token.current); onWatch(historyScene(entry)); }}
                    text={historyRow(entry, { nowMs, clock, timeZone, rewards: own ? rewards.get(entry.activityId) ?? null : null, runLast: last.has(entry.entryId) })} />)}
                </ul>
              </section>
            ))}
          </div>
          {active && <PanelFooter><Pager list={paged} show={!compact} /></PanelFooter>}
          {landingFailed && list.moreFailed && <p className={styles.failed} role="alert" data-landing-failed="">Could not load more. Try Next again.</p>}
          {/* The end of a list that paged is said on its last page. */}
          {!list.nextCursor && list.pages > 1 && paged.page === paged.knownPages ? <p className={styles.everything}>{EVERYTHING}</p> : null}
        </>}
      <p className={styles.footer} data-history-footer="">{footerText(own)}</p>
    </section>
  );
}
