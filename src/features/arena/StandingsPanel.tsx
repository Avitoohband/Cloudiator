'use client';

// League standings: paginated rows (at most 50 per page, a "More" cursor) with rating, human wins and losses and the
// promoted and inactive markers; separately the owner's own rating, renown and current combat strength; and a short
// explanation of the leagues from the spec thresholds. It re-reads after each slot boundary, so standings change
// only from results the server has credited; it never adds a rating change itself and never computes another
// player's league index. It only reads and never sends a command. Names render as React text.
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
const SLOT_MS = RULES_V1.clock.slotMs;
const TICK_MS = 1000;

export type StandingsModel = {
  league: LeagueId;
  rows: StandingRow[];
  nextCursor: string | null;
  seasonId: string | null;
  archived: boolean;
  status: 'loading' | 'ready' | 'unavailable';
  ownerId: string | null;
  own: { name: string; league: LeagueId; rating: number; renown: number; combatStrength: number | null } | null;
};

/** Pure view of one league's standings and the owner's own figures. */
export function StandingsView({ model, onLeague, onMore, loadingMore = false }: { model: StandingsModel; onLeague(league: LeagueId): void; onMore(): void; loadingMore?: boolean }) {
  const titleId = useId();
  const ownId = useId();
  const tableId = useId();
  const { league, rows, own } = model;
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
          <p className="muted">Rating and renown change only when the server credits a result at minute 80. Current combat strength is your loadout now; your league comes from your progression and never drops when you change gear.</p>
        </section>
      )}

      <div className={styles.leagues} role="group" aria-label="League">
        {LEAGUES.map(id => <button key={id} type="button" aria-pressed={league === id} onClick={() => onLeague(id)}>{leagueName(id)}</button>)}
      </div>

      {model.status === 'unavailable' ? <p className="panel-notice" role="status">Standings are not available in this build yet.</p>
        : model.status === 'loading' && rows.length === 0 ? <p role="status" className="muted">Loading the {leagueName(league)} standings…</p>
          : rows.length === 0 ? <p className="muted" role="status">No standings in the {leagueName(league)} league yet.</p>
            : <div className={styles.tableWrap}>
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
            </div>}
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

/** Live standings: reads the chosen league, pages with "More", and re-reads after each slot boundary and on focus. */
export function StandingsPanel({ reads, owner, clock }: { reads: StandingsReads | null; owner: OwnerState | null; clock: DisplayClock }) {
  const [league, setLeague] = useState<LeagueId>(owner?.progression.league ?? 'bronze');
  const [page, setPage] = useState<{ league: LeagueId; rows: StandingRow[]; nextCursor: string | null; seasonId: string; archived: boolean } | null>(null);
  const [status, setStatus] = useState<StandingsModel['status']>(reads ? 'loading' : 'unavailable');
  const [loadingMore, setLoadingMore] = useState(false);
  const [strength, setStrength] = useState<{ id: string; value: number | null } | null>(null);
  const [slot, setSlot] = useState(() => Math.floor(clock.now() / SLOT_MS));
  const request = useRef(0);
  const readCount = useRef(0);
  const rowCount = useRef(0);
  const ownerId = owner?.gladiatorId ?? null;

  const load = useCallback(async (which: LeagueId) => {
    if (!reads) { setStatus('unavailable'); return; }
    const mine = ++request.current;
    readCount.current += 1;
    setStatus('loading');
    try {
      const next = await reads.standings(which);
      if (mine !== request.current) return;
      setPage({ league: which, rows: next.rows.slice(0, 50), nextCursor: next.nextCursor, seasonId: next.seasonId, archived: next.archived });
      setStatus('ready');
    } catch {
      if (mine === request.current) { setPage(null); setStatus('unavailable'); }
    }
  }, [reads]);

  // The chosen league, and again after every slot boundary (credited results only) or when the tab returns.
  useEffect(() => { void load(league); }, [league, load, slot]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') setSlot(Math.floor(clock.now() / SLOT_MS)); };
    const timer = window.setInterval(tick, TICK_MS);
    const off = clock.subscribe(tick);
    const onFocus = () => { if (document.visibilityState === 'visible') void load(league); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); off(); window.removeEventListener('focus', onFocus); };
  }, [clock, league, load]);

  useEffect(() => {
    if (!ownerId || !reads?.profile) return;
    let alive = true;
    reads.profile(ownerId).then(p => { if (alive) setStrength({ id: ownerId, value: p.combatStrength ?? null }); }, () => { if (alive) setStrength({ id: ownerId, value: null }); });
    return () => { alive = false; };
  }, [ownerId, reads, slot]);

  const more = async () => {
    if (!reads || !page?.nextCursor) return;
    const mine = request.current;
    setLoadingMore(true);
    readCount.current += 1;
    try {
      const next = await reads.standings(page.league, page.nextCursor);
      if (mine !== request.current) return;
      const seen = new Set(page.rows.map(r => r.gladiatorId));
      const fresh = next.rows.slice(0, 50).filter(r => !seen.has(r.gladiatorId));
      // A reader that ignores the cursor returns the same page: stop instead of repeating rows.
      setPage({ ...page, rows: [...page.rows, ...fresh], nextCursor: fresh.length ? next.nextCursor : null });
    } catch {
      // Keep the rows already shown; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  const rows = page && page.league === league ? page.rows : [];
  useEffect(() => { rowCount.current = rows.length; });
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorStandings = { reads: () => readCount.current, league: () => league, rows: () => rowCount.current };
    return () => { delete window.__cloudiatorStandings; };
  }, [league]);

  const model: StandingsModel = {
    league, rows, nextCursor: page && page.league === league ? page.nextCursor : null,
    seasonId: page?.seasonId ?? null, archived: !!page?.archived, status: page && page.league !== league ? 'loading' : status, ownerId,
    own: owner ? { name: owner.name, league: owner.progression.league, rating: owner.progression.rating, renown: owner.wallets.renown,
      combatStrength: strength && strength.id === owner.gladiatorId ? strength.value : null } : null,
  };
  return <StandingsView model={model} onLeague={setLeague} onMore={() => void more()} loadingMore={loadingMore} />;
}
