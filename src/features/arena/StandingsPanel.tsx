'use client';

// League standings: paginated rows (at most 50 per page, a "More" cursor) with rating, human wins and losses and the
// promoted and inactive markers; separately the owner's own rating, renown and current combat strength; and a short
// explanation of the leagues from the spec thresholds. It re-reads the pages it shows when the shared world revision
// changes (Task 13.4: the server credits results with a new revision, and the sync controller polls it), so standings
// change only from results the server has credited; it has no timer of its own, never adds a rating change itself and
// never computes another player's league index. It only reads and never sends a command. Names render as React text.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GladiatorId, LeagueId } from '@contracts/commands';
import type { OwnerState, StandingRow, StandingsPage } from '@contracts/reads';
import type { DisplayClock } from '../../game/display-clock';
import { RULES_V1 } from '@domain/rules-v1';
import { leagueName, leagueRules } from './arena-text';
import styles from './StandingsPanel.module.css';

/**
 * Reads the panel makes. `standings` takes the page cursor as an optional second argument; the current
 * GameGateway.standings(league) has none (reported for Task 10/16), and a reader that ignores it returns the first
 * page again, which the panel detects. `combatStrength` becomes nullable in Task 10.
 */
export type StandingsReads = {
  standings(league: LeagueId, cursor?: string): Promise<StandingsPage>;
  profile?(id: GladiatorId): Promise<{ combatStrength: number | null; rating: number }>;
};

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): standings reads so far, for refresh checks. */
export type StandingsTestHook = { reads(): number; league(): LeagueId; rows(): number };
declare global {
  interface Window { __cloudiatorStandings?: StandingsTestHook }
}

const LEAGUES: LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];
const PAGE_ROWS = 50;

export type StandingsReader = { standings(league: LeagueId, cursor?: string): Promise<StandingsPage> };
export type StandingsPages = { league: LeagueId; rows: StandingRow[]; nextCursor: string | null; seasonId: string; archived: boolean; pages: number };

/** Appends the page after `cursor` to `rows`, without repeats; a reader that ignores the cursor ends the list. */
export async function readNextPage(reader: StandingsReader, loaded: StandingsPages): Promise<StandingsPages> {
  if (!loaded.nextCursor) return loaded;
  const next = await reader.standings(loaded.league, loaded.nextCursor);
  const seen = new Set(loaded.rows.map(r => r.gladiatorId));
  const fresh = next.rows.slice(0, PAGE_ROWS).filter(r => !seen.has(r.gladiatorId));
  if (!fresh.length) return { ...loaded, nextCursor: null };
  return { ...loaded, rows: [...loaded.rows, ...fresh], nextCursor: next.nextCursor, pages: loaded.pages + 1 };
}

/** The first `pages` pages of a league (at least one), so a refresh keeps every row the viewer loaded with More. */
export async function readStandingsPages(reader: StandingsReader, league: LeagueId, pages: number): Promise<StandingsPages> {
  const first = await reader.standings(league);
  let loaded: StandingsPages = { league, rows: first.rows.slice(0, PAGE_ROWS), nextCursor: first.nextCursor, seasonId: first.seasonId, archived: first.archived, pages: 1 };
  while (loaded.pages < pages && loaded.nextCursor) {
    const next = await readNextPage(reader, loaded);
    if (next.pages === loaded.pages) return next;
    loaded = next;
  }
  return loaded;
}

export type StandingsModel = {
  league: LeagueId;
  rows: StandingRow[];
  nextCursor: string | null;
  seasonId: string | null;
  archived: boolean;
  /** `unavailable`: this build has no standings read; `failed`: a read failed and can be tried again. */
  status: 'loading' | 'ready' | 'unavailable' | 'failed';
  ownerId: string | null;
  own: { name: string; league: LeagueId; rating: number; renown: number; combatStrength: number | null } | null;
};

/** Pure view of one league's standings and the owner's own figures. */
export function StandingsView({ model, onLeague, onMore, onRetry, loadingMore = false }: {
  model: StandingsModel; onLeague(league: LeagueId): void; onMore(): void; onRetry(): void; loadingMore?: boolean;
}) {
  const titleId = useId();
  const ownId = useId();
  const tableId = useId();
  const { league, rows, own } = model;
  const failed = model.status === 'failed';
  return (
    <section className={styles.standings} aria-labelledby={titleId}>
      <div className="section-title">
        <div><p className="eyebrow">LEAGUE STANDINGS</p><h2 id={titleId}>Arena standings</h2></div>
        <span className="tag">{model.archived ? 'Archived season' : model.seasonId ? 'Current season' : 'Season'}</span>
      </div>

      {own && (
        <section className={styles.own} aria-labelledby={ownId}>
          <h3 id={ownId}>Your standing</h3>
          <dl>
            <div><dt>League</dt><dd>{leagueName(own.league)}</dd></div>
            <div><dt>Rating</dt><dd>{own.rating}</dd></div>
            <div><dt>Renown</dt><dd>{own.renown}</dd></div>
            <div><dt>Current combat strength</dt><dd>{own.combatStrength ?? 'not available'}</dd></div>
          </dl>
          <p className="muted">Rating and renown change only when the server credits a result at minute {RULES_V1.clock.slotMs / 60_000}. Current combat strength is your loadout now; your league comes from your progression and never drops when you change gear.</p>
        </section>
      )}

      <div className={styles.leagues} role="group" aria-label="League">
        {LEAGUES.map(id => <button key={id} type="button" aria-pressed={league === id} onClick={() => onLeague(id)}>{leagueName(id)}</button>)}
      </div>

      {model.status === 'unavailable' ? <p className="panel-notice" role="status">Standings are not available in this build yet.</p>
        : failed && rows.length === 0 ? <div className={styles.failed} role="alert"><p>The standings could not be loaded right now.</p><button type="button" onClick={onRetry}>Try again</button></div>
          : model.status === 'loading' && rows.length === 0 ? <p role="status" className="muted">Loading the {leagueName(league)} standings…</p>
            : rows.length === 0 ? <p className="muted" role="status">No standings in the {leagueName(league)} league yet.</p>
              : <>
                {failed && <div className={styles.failed} role="alert"><p>The latest standings could not be loaded; these rows may be out of date.</p><button type="button" onClick={onRetry}>Try again</button></div>}
                <div className={styles.tableWrap}>
                  <table className={styles.table} aria-labelledby={tableId}>
                    <caption id={tableId}>{leagueName(league)} league standings</caption>
                    <thead><tr><th scope="col">Rank</th><th scope="col">Gladiator</th><th scope="col">Rating</th><th scope="col">Human W–L</th><th scope="col">Notes</th></tr></thead>
                    <tbody>{rows.map(row => (
                      <tr key={row.gladiatorId} aria-current={row.gladiatorId === model.ownerId ? 'true' : undefined} className={row.gladiatorId === model.ownerId ? styles.mine : undefined}>
                        <td>{row.rank}</td>
                        <th scope="row">{row.name}</th>
                        <td>{row.rating}</td>
                        <td>{row.humanWins}–{row.humanLosses}</td>
                        <td><span className={styles.notes}>
                          {row.gladiatorId === model.ownerId && <span className={styles.you}>You</span>}
                          {row.promoted && <span className={styles.promoted}>Promoted</span>}
                          {row.inactive && <span className={styles.inactive}>Inactive</span>}
                        </span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </>}
      {model.nextCursor && <button type="button" className={styles.more} onClick={onMore} disabled={loadingMore}>More</button>}

      <section className={styles.explain} aria-label="How leagues work">
        <h3>How leagues work</h3>
        <p>Each league is set by a progression index from your level, every attribute point you have earned and the best gear you have ever owned. It never drops when you unequip gear, sell items or respec, and promotion applies at slot boundaries.</p>
        <ul>{leagueRules().map(r => <li key={r.league}><strong>{leagueName(r.league)}</strong>: index {r.range}</li>)}</ul>
        <p>Regular Arena bouts pair gladiators within a league. Ratings start at {RULES_V1.rating.initial} in each league and season and change by Elo (K = {RULES_V1.rating.k}) after human bouts; NPC fallback bouts never change rating. Standings rank by rating, then human wins, then fewer human losses. A season lasts 28 days; placement rewards need at least {RULES_V1.seasons.minimumHumanBouts} human bouts in the league.</p>
      </section>
    </section>
  );
}

export type StandingsPanelProps = {
  reads: StandingsReads | null;
  /** The signed-in owner ("Your standing"), re-read by the shared game state on each new revision; null for a visitor. */
  owner: OwnerState | null;
  /** The shared display clock, as every panel receives it. Standings follow the revision, never the clock. */
  clock: DisplayClock;
  /** The shared world revision (`GameUiState.revision`); a change re-reads the shown standings. */
  revision: string | null;
};

/**
 * Live standings: reads the chosen league, pages with "More", and re-reads the loaded pages when the world revision
 * changes, which is when the server credits results. A failed read keeps any rows shown and offers a retry.
 */
export function StandingsPanel({ reads, owner, revision }: StandingsPanelProps) {
  const [league, setLeague] = useState<LeagueId>(owner?.progression.league ?? 'bronze');
  const [page, setPage] = useState<StandingsPages | null>(null);
  const [status, setStatus] = useState<StandingsModel['status']>(reads ? 'loading' : 'unavailable');
  const [loadingMore, setLoadingMore] = useState(false);
  const [strength, setStrength] = useState<{ id: string; value: number | null } | null>(null);
  const request = useRef(0);
  const readCount = useRef(0);
  const rowCount = useRef(0);
  /** The pages shown now, so a refresh reloads as many. */
  const shown = useRef<StandingsPages | null>(null);
  const ownerId = owner?.gladiatorId ?? null;

  const counted = useCallback((): StandingsReader | null => reads && {
    standings: (which, cursor) => { readCount.current += 1; return reads.standings(which, cursor); },
  }, [reads]);

  /** Reads a league's first page, or for a refresh of the shown league as many pages as are shown. */
  const load = useCallback(async (which: LeagueId, refresh: boolean) => {
    const reader = counted();
    if (!reader) { setStatus('unavailable'); return; }
    const mine = ++request.current;
    const kept = refresh && shown.current?.league === which ? shown.current : null;
    setStatus('loading');
    try {
      const next = await readStandingsPages(reader, which, kept?.pages ?? 1);
      if (mine !== request.current) return;
      shown.current = next;
      setPage(next);
      setStatus('ready');
    } catch {
      if (mine !== request.current) return;
      // A failed refresh keeps the rows already shown; a failed first read shows only the retry.
      if (!kept) { shown.current = null; setPage(null); }
      setStatus('failed');
    }
  }, [counted]);

  useEffect(() => { void load(league, false); }, [league, load]);
  // A new world revision (the sync controller polls it every 30 s, and on focus) re-reads the shown pages: credited
  // results arrive with one. The first revision after opening is no change.
  const seen = useRef(revision);
  useEffect(() => {
    const previous = seen.current;
    seen.current = revision;
    if (previous !== null && revision !== null && revision !== previous) void load(league, true);
  }, [revision, league, load]);

  // The owner's current combat strength, from its public profile: again with each new revision (a queued build
  // activates at a slot boundary, which changes the revision).
  useEffect(() => {
    if (!ownerId || !reads?.profile) return;
    let alive = true;
    reads.profile(ownerId).then(p => { if (alive) setStrength({ id: ownerId, value: p.combatStrength ?? null }); }, () => { if (alive) setStrength({ id: ownerId, value: null }); });
    return () => { alive = false; };
  }, [ownerId, reads, revision]);

  const more = async () => {
    const reader = counted();
    if (!reader || !page?.nextCursor) return;
    const mine = request.current;
    setLoadingMore(true);
    try {
      const next = await readNextPage(reader, page);
      if (mine !== request.current) return;
      shown.current = next;
      setPage(next);
    } catch {
      // Keep the rows already shown; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  const current = page && page.league === league ? page : null;
  const rows = current ? current.rows : [];
  useEffect(() => { rowCount.current = rows.length; });
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorStandings = { reads: () => readCount.current, league: () => league, rows: () => rowCount.current };
    return () => { delete window.__cloudiatorStandings; };
  }, [league]);

  const model: StandingsModel = {
    league, rows, nextCursor: current ? current.nextCursor : null,
    seasonId: page?.seasonId ?? null, archived: !!page?.archived, status: page && !current && status !== 'failed' ? 'loading' : status, ownerId,
    own: owner ? { name: owner.name, league: owner.progression.league, rating: owner.progression.rating, renown: owner.wallets.renown,
      combatStrength: strength && strength.id === owner.gladiatorId ? strength.value : null } : null,
  };
  return <StandingsView model={model} onLeague={setLeague} onMore={() => void more()} onRetry={() => void load(league, true)} loadingMore={loadingMore} />;
}
