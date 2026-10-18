'use client';

// League standings: paginated rows (at most 50 per page, a "More" cursor) with rating, human wins and losses and the
// promoted and inactive markers; separately the owner's own rating, renown and current combat strength; and a short
// explanation of the leagues from the spec thresholds. It re-reads the pages it shows when the shared world revision
// changes (Task 13.4: the server credits results with a new revision, and the sync controller polls it), so standings
// change only from results the server has credited; it has no read timer of its own, never adds a rating change itself
// and never computes another player's league index. It only reads and never sends a command. Names render as React text.
//
// Seasons (Task 21.4, plan Decision 8, the approved mockup): a season picker; for the current season a card with its
// countdown (the shared display clock, redrawn twice a minute), its end in the viewer's local time with the UTC time, the
// three prizes and the rule, the owner's season rank and human bouts toward five in "Your standing", and ✓ Eligible marks;
// a finished season shows its frozen archive with medals and a promotion footnote, and no "Your standing". A finished
// season never changes, so a new revision re-reads only an open season's pages.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { GladiatorId, LeagueId } from '@contracts/commands';
import type { OwnerState, SeasonView, StandingRow, StandingsPage } from '@contracts/reads';
import type { DisplayClock } from '../../game/display-clock';
import { RULES_V1 } from '@domain/rules-v1';
import { leagueName, leagueRules } from './arena-text';
import { ELIGIBLE_NOTE, medalOf, placeText, promotionNote, qualifyText, seasonEnds, seasonLabel, seasonName } from '../seasons/season-text';
import styles from './StandingsPanel.module.css';

/**
 * Reads the panel makes. `standings` takes the page cursor and a season id as optional arguments; a reader that ignores the
 * cursor returns the first page again, which the panel detects. `seasons` lists the seasons for the picker, and `standingOf`
 * reads the owner's own row of the current season (both Task 21; without them the picker and the season rank are not shown).
 */
export type StandingsReads = {
  standings(league: LeagueId, cursor?: string, seasonId?: string): Promise<StandingsPage>;
  profile?(id: GladiatorId): Promise<{ combatStrength: number | null; rating: number }>;
  seasons?(): Promise<SeasonView[]>;
  standingOf?(league: LeagueId, gladiatorId: GladiatorId): Promise<StandingRow | null>;
};

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): standings reads so far, for refresh checks. */
export type StandingsTestHook = { reads(): number; league(): LeagueId; rows(): number };
declare global {
  interface Window { __cloudiatorStandings?: StandingsTestHook }
}

const LEAGUES: LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];
const PAGE_ROWS = 50;
/** How often the season countdown is redrawn from the display clock while the tab is visible. */
const TICK_MS = 30_000;
const ORDINALS = ['First', 'Second', 'Third'];
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export type StandingsReader = { standings(league: LeagueId, cursor?: string, seasonId?: string): Promise<StandingsPage> };
export type StandingsPages = { league: LeagueId; rows: StandingRow[]; nextCursor: string | null; seasonId: string; archived: boolean; pages: number };

/**
 * Appends the page after `cursor` to `rows`, without repeats; a reader that ignores the cursor ends the list. When the season
 * closed between two pages (the next page comes from its archive), every loaded page is read again from the archive, whose
 * ranks are the same, so the rows never mix live and frozen flags.
 */
export async function readNextPage(reader: StandingsReader, loaded: StandingsPages): Promise<StandingsPages> {
  if (!loaded.nextCursor) return loaded;
  const next = await reader.standings(loaded.league, loaded.nextCursor);
  if (next.archived && !loaded.archived && next.seasonId === loaded.seasonId) return readStandingsPages(reader, loaded.league, loaded.pages + 1, loaded.seasonId);
  const seen = new Set(loaded.rows.map(r => r.gladiatorId));
  const fresh = next.rows.slice(0, PAGE_ROWS).filter(r => !seen.has(r.gladiatorId));
  if (!fresh.length) return { ...loaded, nextCursor: null };
  return { ...loaded, rows: [...loaded.rows, ...fresh], nextCursor: next.nextCursor, pages: loaded.pages + 1 };
}

/**
 * The first `pages` pages of a league (at least one) of the season `seasonId`, or of the current season when it is
 * undefined, so a refresh keeps every row the viewer loaded with More.
 */
export async function readStandingsPages(reader: StandingsReader, league: LeagueId, pages: number, seasonId?: string): Promise<StandingsPages> {
  const first = await reader.standings(league, undefined, seasonId);
  let loaded: StandingsPages = { league, rows: first.rows.slice(0, PAGE_ROWS), nextCursor: first.nextCursor, seasonId: first.seasonId, archived: first.archived, pages: 1 };
  while (loaded.pages < pages && loaded.nextCursor) {
    const next = await readNextPage(reader, loaded);
    if (next.pages === loaded.pages) return next;
    loaded = next;
  }
  return loaded;
}

/** The owner's own row of the current season: loading, read (null: not ranked yet) or not available. */
export type OwnSeason = { status: 'loading' | 'unavailable' } | { status: 'ready'; row: StandingRow | null };

export type StandingsModel = {
  league: LeagueId;
  rows: StandingRow[];
  nextCursor: string | null;
  /** The shown (or chosen) season, '' for a world with no season yet, null before any read. */
  seasonId: string | null;
  archived: boolean;
  /** `unavailable`: this build has no standings read; `failed`: a read failed and can be tried again. */
  status: 'loading' | 'ready' | 'unavailable' | 'failed';
  ownerId: string | null;
  own: { name: string; league: LeagueId; rating: number; renown: number; combatStrength: number | null; season: OwnSeason } | null;
  /** The seasons for the picker, newest first; empty before they load, when none has started, or when they cannot be read. */
  seasons: readonly SeasonView[];
  /** The shared display clock's time, for the current season's countdown. */
  nowMs: number;
};

/** The current season's card: countdown, end time (local and UTC), prizes and the rule. */
function CurrentSeason({ season, nowMs, timeZone }: { season: SeasonView; nowMs: number; timeZone?: string }) {
  const titleId = useId();
  const name = seasonName(season.seasonId);
  const ends = seasonEnds(season.endsAtMs, nowMs, timeZone);
  const over = nowMs >= season.endsAtMs;
  const { minimumHumanBouts, placements } = RULES_V1.seasons;
  return (
    <section className={styles.season} aria-labelledby={titleId}>
      <h3 id={titleId}>{over ? `${name} is ending` : `${name} ends in ${ends.countdown}`}</h3>
      <p className="muted">{over
        ? `Ended ${ends.local} your time (${ends.utc}). Final standings and rewards appear once the server closes the season.`
        : `${ends.local} your time (${ends.utc}). Ratings then restart at ${RULES_V1.rating.initial}; level, gear, money and renown stay.`}</p>
      <ul className={styles.prizes} aria-label="Season prizes">
        {placements.map((p, i) => (
          <li key={p.badge}>
            <span role="img" aria-label={`${ORDINALS[i]} place`}>{medalOf(p.badge)}</span>
            <span><b>{p.money}</b> money · <b>{p.renown}</b> renown{p.title && <> · <b>{capital(p.title)}</b> title</>} · {p.badge} badge</span>
          </li>
        ))}
      </ul>
      <p className="muted">Top {placements.length} in each league among gladiators with at least {minimumHumanBouts} human bouts. Paid once, in your highest league where you qualify.</p>
    </section>
  );
}

/** A finished season's card: frozen at the close, with its end in local time and UTC. */
function FinalSeason({ season, timeZone }: { season: SeasonView; timeZone?: string }) {
  const titleId = useId();
  const ends = seasonEnds(season.endsAtMs, season.endsAtMs, timeZone);
  return (
    <section className={styles.season} aria-labelledby={titleId}>
      <h3 id={titleId}>{seasonName(season.seasonId)} final standings</h3>
      <p className="muted">Ended {ends.local} your time ({ends.utc}). Frozen at the close; medals show the season rewards.</p>
    </section>
  );
}

/** Pure view of one league's standings of one season and the owner's own figures. */
export function StandingsView({ model, onLeague, onSeason, onMore, onRetry, onProfile, loadingMore = false, timeZone }: {
  model: StandingsModel; onLeague(league: LeagueId): void; onMore(): void; onRetry(): void; loadingMore?: boolean;
  /** Shows another season (a `SeasonView.seasonId` from the picker). */
  onSeason?(seasonId: string): void;
  /** Opens a row's profile card (Task 13.7: the keyboard path of a camp click); without it names are plain text. */
  onProfile?(row: StandingRow): void;
  /** The viewer's time zone for season times; undefined is the runtime's zone. */
  timeZone?: string;
}) {
  const titleId = useId();
  const ownId = useId();
  const tableId = useId();
  const pickerId = useId();
  const { league, rows, own, seasons, archived } = model;
  const failed = model.status === 'failed';
  const season = model.seasonId ? seasons.find(s => s.seasonId === model.seasonId) ?? null : null;
  const minimum = RULES_V1.seasons.minimumHumanBouts;
  const ownRow = own?.season.status === 'ready' ? own.season.row : null;
  const ownBouts = ownRow ? ownRow.humanWins + ownRow.humanLosses : 0;
  const ownValue = (ready: string) => (own?.season.status === 'ready' ? ready : own?.season.status === 'loading' ? 'Loading…' : 'not available');
  return (
    <section className={styles.standings} aria-labelledby={titleId}>
      <div className="section-title">
        <div><p className="eyebrow">LEAGUE STANDINGS</p><h2 id={titleId}>Arena standings</h2></div>
        <span className={archived ? `tag ${styles.archivedTag}` : 'tag'}>{archived ? 'Archived season' : model.seasonId ? 'Current season' : 'Season'}</span>
      </div>

      {seasons.length > 0 && (
        <div className={styles.picker}>
          <label htmlFor={pickerId}>Season</label>
          <select id={pickerId} value={model.seasonId ?? ''} onChange={event => onSeason?.(event.target.value)}>
            {/* A season the list does not hold yet (a boundary opened it after the list was read) still shows by name. */}
            {model.seasonId && !season && <option value={model.seasonId}>{seasonName(model.seasonId)}</option>}
            {seasons.map(s => <option key={s.seasonId} value={s.seasonId}>{seasonLabel(s, timeZone)}</option>)}
          </select>
        </div>
      )}

      {season && (archived ? <FinalSeason season={season} timeZone={timeZone} /> : <CurrentSeason season={season} nowMs={model.nowMs} timeZone={timeZone} />)}

      {own && !archived && (
        <section className={styles.own} aria-labelledby={ownId}>
          <h3 id={ownId}>Your standing</h3>
          <dl>
            <div><dt>League</dt><dd>{leagueName(own.league)}</dd></div>
            <div><dt>Rating</dt><dd>{own.rating}</dd></div>
            <div><dt>Renown</dt><dd>{own.renown}</dd></div>
            <div><dt>Current combat strength</dt><dd>{own.combatStrength ?? 'not available'}</dd></div>
            <div><dt>Season rank</dt><dd>{ownValue(ownRow ? `#${ownRow.rank}` : 'Not ranked yet')}</dd></div>
            <div><dt>Human bouts</dt><dd>{ownValue(`${ownBouts} of ${minimum}`)}</dd></div>
          </dl>
          {own.season.status === 'ready' && <>
            <div className={styles.progress} role="progressbar" aria-label="Human bouts toward season rewards" aria-valuemin={0} aria-valuemax={minimum}
              aria-valuenow={Math.min(ownBouts, minimum)}>
              <span style={{ width: `${(Math.min(ownBouts, minimum) / minimum) * 100}%` }} />
            </div>
            <p className="muted">{qualifyText(ownBouts, own.league)}</p>
          </>}
          <p className="muted">Rating and renown change only when the server credits a result at minute {RULES_V1.clock.slotMs / 60_000}. Current combat strength is your loadout now; your league comes from your progression and never drops when you change gear.</p>
        </section>
      )}

      <div className={styles.leagues} role="group" aria-label="League">
        {LEAGUES.map(id => <button key={id} type="button" aria-pressed={league === id} onClick={() => onLeague(id)}>{leagueName(id)}</button>)}
      </div>

      {model.status === 'unavailable' ? <p className="panel-notice" role="status">Standings are not available in this build yet.</p>
        : failed && rows.length === 0 ? <div className={styles.failed} role="alert"><p>The standings could not be loaded right now.</p><button type="button" onClick={onRetry}>Try again</button></div>
          : model.status === 'loading' && rows.length === 0 ? <p role="status" className="muted">Loading the {leagueName(league)} standings…</p>
            : rows.length === 0 ? <p className="muted" role="status">No standings in the {leagueName(league)} league {archived && model.seasonId ? `in ${seasonName(model.seasonId)}` : 'yet'}.</p>
              : <>
                {failed && <div className={styles.failed} role="alert"><p>The latest standings could not be loaded; these rows may be out of date.</p><button type="button" onClick={onRetry}>Try again</button></div>}
                <div className={styles.tableWrap}>
                  <table className={styles.table} aria-labelledby={tableId}>
                    <caption id={tableId}>{leagueName(league)} league standings</caption>
                    <thead><tr><th scope="col">Rank</th><th scope="col">Gladiator</th><th scope="col">Rating</th><th scope="col">Human <span className={styles.nowrap}>W–L</span></th><th scope="col">Notes</th></tr></thead>
                    <tbody>{rows.map(row => (
                      <tr key={row.gladiatorId} aria-current={row.gladiatorId === model.ownerId ? 'true' : undefined} className={row.gladiatorId === model.ownerId ? styles.mine : undefined}>
                        <td>{row.rank}</td>
                        <th scope="row">{onProfile
                          ? <button type="button" className={styles.name} aria-label={`Profile: ${row.name}`} onClick={() => onProfile(row)}>{row.name}</button>
                          : row.name}</th>
                        <td>{row.rating}</td>
                        <td>{row.humanWins}–{row.humanLosses}</td>
                        <td><span className={styles.notes}>
                          {row.gladiatorId === model.ownerId && <span className={styles.you}>You</span>}
                          {archived && row.awardPlace !== null && <span className={styles.medal}>{placeText(row.awardPlace)}</span>}
                          {row.promoted && <span className={styles.promoted}>Promoted</span>}
                          {row.inactive && <span className={styles.inactive}>Inactive</span>}
                          {!archived && row.rewardEligible && <span className={styles.eligible}>✓ Eligible</span>}
                        </span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <p className={`muted ${styles.footnote}`}>{archived ? promotionNote(rows, league) : ELIGIBLE_NOTE}</p>
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
  /** The shared display clock, as every panel receives it. Standings follow the revision; the clock only moves the season countdown. */
  clock: DisplayClock;
  /** The shared world revision (`GameUiState.revision`); a change re-reads the shown standings. */
  revision: string | null;
  /** Opens a row's profile card. */
  onProfile?(row: StandingRow): void;
  /** The viewer's time zone for season times (tests); undefined is the runtime's zone. */
  timeZone?: string;
};

/** The display clock's time, twice a minute while the tab is visible and whenever the clock is held or moved. */
function useNow(clock: DisplayClock) {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const update = () => setNow(clock.now());
    const off = clock.subscribe(update);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    update();
    return () => { off(); window.clearInterval(timer); };
  }, [clock]);
  return now;
}

/** The shown pages, with the league and chosen season they were read for. */
type ShownPages = StandingsPages & { key: string };
const keyOf = (league: LeagueId, chosen: string | null) => `${league}|${chosen ?? ''}`;

/**
 * Whether the season list may be out of date at a new revision: never read or failed, no season yet, the newest season
 * closed or past its end on the display clock (a boundary opens the next one), or the shown season missing from the list or
 * listed open although its pages are archived. Otherwise it stays as read: seasons change only at a season boundary.
 */
function seasonsStale(list: readonly SeasonView[] | null, shown: ShownPages | null, nowMs: number): boolean {
  if (!list || list.length === 0) return true;
  if (list[0].closedAtMs !== null || nowMs >= list[0].endsAtMs) return true;
  if (!shown || shown.seasonId === '') return false;
  const listed = list.find(s => s.seasonId === shown.seasonId);
  return !listed || (shown.archived && listed.closedAtMs === null);
}

/**
 * Live standings: reads the chosen league and season, pages with "More", and re-reads the loaded pages of an open season
 * when the world revision changes, which is when the server credits results (a finished season's archive never changes).
 * A failed read keeps any rows shown and offers a retry. The season list and the owner's own season row are read at
 * opening; the owner's row again with each revision, the list only when it may be out of date (`seasonsStale`).
 */
export function StandingsPanel({ reads, owner, clock, revision, onProfile, timeZone }: StandingsPanelProps) {
  const [league, setLeague] = useState<LeagueId>(owner?.progression.league ?? 'bronze');
  /** The season the viewer picked; null follows the current (latest) season. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [page, setPage] = useState<ShownPages | null>(null);
  const [status, setStatus] = useState<StandingsModel['status']>(reads ? 'loading' : 'unavailable');
  const [loadingMore, setLoadingMore] = useState(false);
  const [strength, setStrength] = useState<{ id: string; value: number | null } | null>(null);
  /** The season list as last read (kept when a later read fails), or null before the first one succeeds. */
  const [seasons, setSeasons] = useState<SeasonView[] | null>(null);
  const [mine, setMine] = useState<{ id: string; league: LeagueId; season: OwnSeason } | null>(null);
  const now = useNow(clock);
  const request = useRef(0);
  const seasonsRequest = useRef(0);
  /** Whether the last season list read failed, so the next revision or retry reads it again. */
  const seasonsFailed = useRef(false);
  const readCount = useRef(0);
  const rowCount = useRef(0);
  /** The pages shown now, so a refresh reloads as many. */
  const shown = useRef<ShownPages | null>(null);
  const listed = useRef<SeasonView[] | null>(null);
  const ownerId = owner?.gladiatorId ?? null;
  const ownLeague = owner?.progression.league ?? null;

  const counted = useCallback((): StandingsReader | null => reads && {
    standings: (which, cursor, season) => { readCount.current += 1; return reads.standings(which, cursor, season); },
  }, [reads]);

  /** Reads a league's first page of a season (null: the current one), or for a refresh of what is shown as many pages as are shown. */
  const load = useCallback(async (which: LeagueId, season: string | null, refresh: boolean) => {
    const reader = counted();
    if (!reader) { setStatus('unavailable'); return; }
    const mine = ++request.current;
    const key = keyOf(which, season);
    const kept = refresh && shown.current?.key === key ? shown.current : null;
    setStatus('loading');
    try {
      const next: ShownPages = { ...await readStandingsPages(reader, which, kept?.pages ?? 1, season ?? undefined), key };
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

  const loadSeasons = useCallback(async () => {
    if (!reads?.seasons) return;
    const mine = ++seasonsRequest.current;
    try {
      const list = await reads.seasons();
      if (mine !== seasonsRequest.current) return;
      seasonsFailed.current = false;
      listed.current = list;
      setSeasons(list);
    } catch {
      // Keep the list already shown; the next revision or a retry reads it again.
      if (mine === seasonsRequest.current) seasonsFailed.current = true;
    }
  }, [reads]);

  useEffect(() => { void load(league, chosen, false); }, [league, chosen, load]);
  useEffect(() => { void loadSeasons(); }, [loadSeasons]);
  // A new world revision (the sync controller polls it every 30 s, and on focus) re-reads the shown pages of an open season:
  // credited results arrive with one. The first revision after opening is no change.
  const seen = useRef(revision);
  useEffect(() => {
    const previous = seen.current;
    seen.current = revision;
    if (previous === null || revision === null || revision === previous) return;
    const current = shown.current?.key === keyOf(league, chosen) ? shown.current : null;
    if (!current?.archived) void load(league, chosen, true);
    if (seasonsFailed.current || seasonsStale(listed.current, current, clock.now())) void loadSeasons();
  }, [revision, league, chosen, load, loadSeasons, clock]);

  // The owner's current combat strength, from its public profile: again with each new revision (a queued build
  // activates at a slot boundary, which changes the revision).
  useEffect(() => {
    if (!ownerId || !reads?.profile) return;
    let alive = true;
    reads.profile(ownerId).then(p => { if (alive) setStrength({ id: ownerId, value: p.combatStrength ?? null }); }, () => { if (alive) setStrength({ id: ownerId, value: null }); });
    return () => { alive = false; };
  }, [ownerId, reads, revision]);

  // The owner's own row of the current season in its league (season rank and human bouts), also when it is outside the
  // loaded pages: again with each new revision. A failed read keeps nothing stale: it says not available.
  useEffect(() => {
    if (!ownerId || !ownLeague || !reads?.standingOf) return;
    let alive = true;
    reads.standingOf(ownLeague, ownerId).then(row => { if (alive) setMine({ id: ownerId, league: ownLeague, season: { status: 'ready', row } }); },
      () => { if (alive) setMine({ id: ownerId, league: ownLeague, season: { status: 'unavailable' } }); });
    return () => { alive = false; };
  }, [ownerId, ownLeague, reads, revision]);

  const more = async () => {
    const reader = counted();
    if (!reader || !page?.nextCursor) return;
    const mine = request.current;
    setLoadingMore(true);
    try {
      const next: ShownPages = { ...await readNextPage(reader, page), key: page.key };
      if (mine !== request.current) return;
      shown.current = next;
      setPage(next);
    } catch {
      // Keep the rows already shown; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  const list = seasons ?? [];
  const current = page && page.key === keyOf(league, chosen) ? page : null;
  const rows = current ? current.rows : [];
  useEffect(() => { rowCount.current = rows.length; });
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorStandings = { reads: () => readCount.current, league: () => league, rows: () => rowCount.current };
    return () => { delete window.__cloudiatorStandings; };
  }, [league]);

  // The shown season: the chosen one; else the current season as read, or the newest open one listed while it loads.
  const seasonId = chosen ?? current?.seasonId ?? list.find(s => s.closedAtMs === null)?.seasonId ?? list[0]?.seasonId ?? null;
  const listedSeason = seasonId ? list.find(s => s.seasonId === seasonId) : undefined;
  const ownSeason: OwnSeason = !reads?.standingOf ? { status: 'unavailable' }
    : mine && mine.id === ownerId && mine.league === ownLeague ? mine.season : { status: 'loading' };
  const model: StandingsModel = {
    league, rows, nextCursor: current ? current.nextCursor : null,
    seasonId, archived: current ? current.archived : listedSeason ? listedSeason.closedAtMs !== null : false,
    status: page && !current && status !== 'failed' ? 'loading' : status, ownerId,
    own: owner ? { name: owner.name, league: owner.progression.league, rating: owner.progression.rating, renown: owner.wallets.renown,
      combatStrength: strength && strength.id === owner.gladiatorId ? strength.value : null, season: ownSeason } : null,
    seasons: list, nowMs: now,
  };
  // Picking the newest open season follows the current season again; any other pick stays on that season.
  const pick = (id: string) => setChosen(list.find(s => s.closedAtMs === null)?.seasonId === id ? null : id);
  const retry = () => {
    void load(league, chosen, true);
    if (seasonsFailed.current || !seasons) void loadSeasons();
  };
  return <StandingsView model={model} onLeague={setLeague} onSeason={pick} onMore={() => void more()} onRetry={retry} onProfile={onProfile}
    loadingMore={loadingMore} timeZone={timeZone} />;
}
