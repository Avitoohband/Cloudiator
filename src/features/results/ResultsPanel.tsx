'use client';

// The "Results" menu's list of recent results (spec "Menus": recent results and replays, the same public list for a
// player and a visitor). It reads `recent()` 50 rows at a time, with "More" for the next page, and marks the viewer's
// own rows "You". A row holds only public fields (who, what happened, how it ended, when, whether its replay is kept),
// never a reward or receipt. A kept replay offers "Replay", which calls `onWatch` with the result's kind (the camp opens
// it over itself as that kind's scene, Task 13.8). It reads once each time the menu opens and never sends a command.
// Names render as React text.
//
// Task 22.5: one plain line explains retention, and whether a replay is kept is decided by the shared display clock (the
// server's time): until it has the server's time the rows offer no replay and call none gone (never an endless "Loading"
// when the revision cannot be read), and a row stops offering its replay when the clock passes its expiry.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PublicActivitySummary } from '@contracts/events';
import type { ResultRow } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { RETENTION_TEXT, resultKind, resultLine, resultTime } from './result-text';
import styles from './ResultsPanel.module.css';

const PAGE_ROWS = 50;
/** The rows before the first page has loaded (one array, so the server-time timer is not reset on every render). */
const NO_ROWS: ResultRow[] = [];

export type ResultsReader = Pick<GameGateway, 'recent'>;
export type ResultsList = { rows: ResultRow[]; nextCursor: string | null };
export type ResultsModel = ResultsList & { status: 'loading' | 'ready' | 'failed' };

/**
 * The first page (`loaded` null), or `loaded` with the page after its cursor appended: at most 50 new rows, never a row
 * already listed. A page with nothing new (a reader that ignores the cursor) ends the list.
 */
export async function readResults(reader: ResultsReader, loaded: ResultsList | null): Promise<ResultsList> {
  if (loaded && !loaded.nextCursor) return loaded;
  const page = await reader.recent(loaded?.nextCursor ?? undefined);
  const seen = new Set((loaded?.rows ?? []).map(row => row.summary.activityId));
  const fresh: ResultRow[] = [];
  for (const row of page.rows) {
    if (fresh.length === PAGE_ROWS || seen.has(row.summary.activityId)) continue;
    seen.add(row.summary.activityId);
    fresh.push(row);
  }
  if (loaded && !fresh.length) return { ...loaded, nextCursor: null };
  return { rows: [...(loaded?.rows ?? []), ...fresh], nextCursor: page.nextCursor };
}

/**
 * The shared display clock's time once it has the server's time (or a test holds it), else null: the device's own clock
 * never decides whether a replay is kept. It is read again when the clock is held or let go, when the next listed replay
 * expires (checked at least every minute, as a later revision read can move the clock forward), and every second until
 * the clock has the server's time.
 */
function useServerTime(clock: DisplayClock, rows: readonly ResultRow[]): number | null {
  const sample = useCallback(() => (clock.synced() || clock.frozen() !== null ? clock.now() : null), [clock]);
  const [now, setNow] = useState<number | null>(sample);
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      const t = sample();
      setNow(t);
      if (t === null) { timer = window.setTimeout(update, 1000); return; }
      const next = Math.min(...rows.map(r => r.summary.replayExpiry).flatMap(e => (e.state === 'available' && e.expiresAtMs > t ? [e.expiresAtMs] : [])));
      if (Number.isFinite(next) && clock.frozen() === null) timer = window.setTimeout(update, Math.min(60_000, next - t + 50));
    };
    update();
    const off = clock.subscribe(update);
    return () => { off(); window.clearTimeout(timer); };
  }, [clock, rows, sample]);
  return now;
}

/** Pure view of the loaded results. */
export function ResultsView({ model, viewerId, serverNowMs, onMore, onRetry, onWatch, loadingMore = false, moreFailed = false, timeZone }: {
  model: ResultsModel;
  /** The viewer's own gladiator, whose rows say "You"; null for a visitor. */
  viewerId: string | null;
  /** The server's time (the shared display clock), which decides whether each replay is kept; null until it is known (no replay offered). */
  serverNowMs: number | null;
  onMore(): void;
  onRetry(): void;
  onWatch(activityId: string, kind: PublicActivitySummary['resolvedKind']): void;
  loadingMore?: boolean;
  moreFailed?: boolean;
  /** Tests only: the time zone of the settlement times (the viewer's own otherwise). */
  timeZone?: string;
}) {
  const titleId = useId();
  const { rows, status } = model;
  return (
    <section className={styles.results} aria-labelledby={titleId}>
      <p id={titleId} className="eyebrow">RECENT RESULTS</p>
      <p className="muted">{RETENTION_TEXT}</p>
      {status === 'failed' && rows.length === 0
        ? <div className={styles.failed} role="alert"><p>Recent results could not be loaded right now.</p><button type="button" onClick={onRetry}>Try again</button></div>
        : status === 'loading' && rows.length === 0 ? <p className="muted" role="status">Loading recent results…</p>
          : rows.length === 0 ? <p className="muted" role="status">No results yet.</p>
            : <ul className={styles.list} aria-label="Recent results">{rows.map(row => {
              const line = resultLine(row, serverNowMs);
              return (
                <li key={row.summary.activityId} className={styles.row}>
                  <div className={styles.what}>
                    <p className={styles.line}>{line.text}{row.gladiatorId === viewerId && <span className={styles.you}>You</span>}</p>
                    <p className={styles.when}>{resultKind(row)} · {resultTime(row.summary.settledAtMs, timeZone)}</p>
                  </div>
                  {line.replay && (
                    <button type="button" className={styles.watch} aria-label={`Replay: ${line.text}`} onClick={() => onWatch(row.summary.activityId, row.summary.resolvedKind)}>Replay</button>
                  )}
                </li>
              );
            })}</ul>}
      {model.nextCursor && <button type="button" className={styles.more} onClick={onMore} disabled={loadingMore}>More</button>}
      {moreFailed && <p className={styles.moreFailed} role="alert">More results could not be loaded. Please try again.</p>}
    </section>
  );
}

export function ResultsPanel({ reads, viewerId, clock, onWatch }: {
  reads: ResultsReader;
  viewerId: string | null;
  /** The shared display clock: whether each replay is kept is decided by the server's time. */
  clock: DisplayClock;
  /** Watches a result's kept replay. */
  onWatch(activityId: string, kind: PublicActivitySummary['resolvedKind']): void;
}) {
  const [list, setList] = useState<ResultsList | null>(null);
  const [status, setStatus] = useState<ResultsModel['status']>('loading');
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  /** The current read generation: a page that arrives for an older one (another reader, a retry) is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setStatus('loading');
    setLoadingMore(false);
    readResults(reads, null).then(
      next => { if (mine === generation.current) { setList(next); setStatus('ready'); } },
      () => { if (mine === generation.current) setStatus('failed'); },
    );
    return () => { generation.current += 1; };
  }, [reads, attempt]);

  const more = useCallback(async () => {
    if (!list?.nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const next = await readResults(reads, list);
      if (mine === generation.current) setList(next);
    } catch {
      // The rows already shown stay, and More stays for another try.
      if (mine === generation.current) setMoreFailed(true);
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  }, [list, loadingMore, reads]);

  const rows = list?.rows ?? NO_ROWS;
  const serverNowMs = useServerTime(clock, rows);
  const model: ResultsModel = { rows, nextCursor: list?.nextCursor ?? null, status };
  return <ResultsView model={model} viewerId={viewerId} serverNowMs={serverNowMs} onMore={() => void more()} onRetry={() => setAttempt(n => n + 1)}
    onWatch={onWatch} loadingMore={loadingMore} moreFailed={moreFailed} />;
}
