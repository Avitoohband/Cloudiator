'use client';

// The Tournaments panel: the next tournament and its countdown in the viewer's time zone (with UTC beside it), the
// owner's automatic-entry registration with the entry rules, and a league bracket as the stage core shows it at the
// display clock: entrants and the bracket shape from the start, round-by-round results only as revealed, each
// entrant's role, placements after settlement and, for completed bouts, an inline close-up replay of the revealed log
// (tournament bouts have no activity id in the public view, so no /replay/ link). The only command it sends is
// `set-tournament-opt-in`, when the owner toggles the box; the box always shows the owner's saved setting. Names render
// as React text. The public view carries nobody's rewards: once settled, the viewer's own credited rewards are read from
// its own activity timeline (owner-only under RLS), never from the bracket.
//
// Task 19 phase 2b review fixes: the polled view carries no battle logs, so a bout's log loads on demand when its replay
// is watched (I1); while a tournament is processing its re-reads back off from 30 s to 5 minutes and pause in hidden tabs
// (I1); and a missing view of the running slot before its publication reads "Tournament being prepared" (M4).
//
// Task 13.4: the panel runs on the shared display clock. "Being prepared" holds for every viewer during the five minutes
// after a cutoff, and for a player while its processed slot still lags (Task 19 R3); a card keeps the owner refresh in a
// ref, so a new function from its parent never restarts its retry timer, and while its slot is being prepared it awaits
// the owner refresh before it reads the tournament again (R2). A visitor, with no league of its own, picks one (Bronze
// first). The panel names a slot's tournament only once the shared clock has the server's time; while the sync cannot
// read the revision it says brackets cannot be loaded (review M1).
//
// Task 23.4 (C5): with the revision's published slot (Task 23.2) a missing view of the running slot is "being prepared"
// exactly until that slot is published, with no five-minute bound; a card's re-reads meanwhile no longer refresh the owner
// first (the publication is the revision's, not the owner's processed slot), and a card read before the publication reads
// again as soon as the sync sees it. Without a published slot (before the first coordination) the Task 19 rules stand.
// Task 23.4 (C11): those re-reads back off from three minutes after the cutoff.
//
// Task 22.5: bout replays are kept seven days after the tournament ends (`tournamentReplayKept`, by the display clock), when
// the server compacts each log to its fight summary. From then on a decided bout says "Replay no longer kept" (its result
// and fight summary stay), a watched replay whose log is not loaded says so instead of "cannot be loaded", no log is read,
// and an old tournament link whose view is gone (its id carries its slot) is "no longer kept" instead of missing.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GameCommand, LeagueId } from '@contracts/commands';
import type { ActivitySummary, BattleLog } from '@contracts/events';
import type { OwnerState, TournamentView } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import type { Viewer } from '../character/useGameState';
import { RULES_V1 } from '@domain/rules-v1';
import {
  TOURNAMENT_PREPARE_FAST_MS, latestTournament, nextTournament, preparingRetryDelay, processingRetryDelay, renderTournament, tournamentPreparing,
  tournamentRevealMarks, tournamentWindowAt, withTournamentLogs, type TournamentBoutState, type TournamentStageState,
} from '../../game/tournament-stage';
import { tournamentLookupIdOrNull, tournamentSlotOf } from '../../lib/tournament-id';
import { tournamentEndsAtMs, tournamentReplayKept } from '../../lib/replay-retention';
import { BattleReplay } from '../arena/BattleReplay';
import {
  ENTRY_RULES, ENTRY_STAMINA, countdownText, creditedText, eveningText, leagueName, ordinal, registrationNote, roleText, roundNote,
  roundStatus, shapeText, statusDetail, statusText, timeWithUtc, victoryText, viewerText,
} from './tournament-text';
import styles from './TournamentPanel.module.css';

/**
 * Reads and the one command the panel uses; `timeline` reads the viewer's own credited summary once it has a place, and
 * `tournamentLog` loads a bout's log when its replay is watched.
 */
export type TournamentReads = Pick<GameGateway, 'tournament'> & Partial<Pick<GameGateway, 'command' | 'timeline' | 'tournamentLog'>>;
/** A fixture sample: its view was projected at the server time `asOfMs`, where the preview holds its bracket. */
export type TournamentSample = { id: string; label: string; asOfMs?: number };
type OptIn = Extract<GameCommand, { kind: 'set-tournament-opt-in' }>;

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read the open bracket and hold the clock. */
export type TournamentTestHook = {
  state(): { id: string; now: number; status: string; round: number | null; replay: string | null; roles: Record<string, string | null>; champion: string | null; placements: number } | null;
  /** Holds the shared display clock (null runs on from there); the open sample then follows it instead of its own time. */
  freeze(displayNowMs: number | null): void;
  /** Tournament view reads so far. */
  reads(): number;
  /** Battle logs asked for on demand so far (one per watched bout). */
  logReads(): number;
  /** Kinds of every command this panel has sent. */
  commands(): string[];
  /** Opens a tournament as the sample buttons do (a sample is held at its projection time). */
  open(id: string): void;
};
declare global {
  interface Window { __cloudiatorTournaments?: TournamentTestHook }
}

const TICK_MS = 1000;
/** A failed read is asked again this often while the tab is visible (processing re-reads back off instead). */
const RETRY_MS = 30_000;

/** The next tournament and its countdown, or the one running now and then the next. */
export function TournamentScheduleView({ now, timeZone }: { now: number; timeZone?: string }) {
  const running = tournamentWindowAt(now);
  const next = nextTournament(now);
  return (
    <section className={styles.schedule} aria-label="Tournament schedule">
      {running && <p className={styles.running}>A tournament is running now: it started {timeWithUtc(running.startsAtMs, timeZone)} and settles at minute 80.</p>}
      <dl>
        <div><dt>Next tournament</dt><dd>{timeWithUtc(next.startsAtMs, timeZone)}</dd></div>
        <div><dt>Starts in</dt><dd className={styles.countdown}>{countdownText(next.countdownMs)}</dd></div>
      </dl>
      <p className="muted">Every Wednesday and Saturday at 18:40 UTC, for one 80-minute evening slot. Times show in your time zone; daylight saving never moves the UTC time.</p>
    </section>
  );
}

export type RegistrationModel = {
  /** The owner's saved setting; null without a gladiator. */
  optIn: boolean | null;
  busy: boolean;
  message: { kind: 'status' | 'alert'; text: string } | null;
  displayNowMs: number;
  timeZone?: string;
  owner: { evening: OwnerState['schedule']['evening']; stamina: number } | null;
};

/** The automatic-entry checkbox, the rules and the owner's own checklist. The box always shows the saved setting. */
export function RegistrationView({ model, onToggle }: { model: RegistrationModel; onToggle(): void }) {
  const titleId = useId();
  const note = registrationNote(model.displayNowMs, model.timeZone);
  return (
    <section className={styles.registration} aria-labelledby={titleId}>
      <h3 id={titleId}>Registration</h3>
      <label className={styles.optIn}>
        <input type="checkbox" checked={model.optIn === true} disabled={model.optIn === null || model.busy} onChange={onToggle} />
        <span>Automatically enter tournaments</span>
      </label>
      {model.optIn === null && <p className="muted">Create a gladiator to register for tournaments.</p>}
      {note.fixed && <p className={styles.late}>{note.fixed}</p>}
      <p className="muted">{note.applies}</p>
      {model.message && <p role={model.message.kind} className={model.message.kind === 'alert' ? styles.alert : styles.message}>{model.message.text}</p>}
      {model.owner && model.optIn !== null && (
        <dl className={styles.checklist} aria-label="Your entry checklist">
          <div><dt>Automatic entry</dt><dd>{model.optIn ? 'On' : 'Off'}</dd></div>
          <div><dt>Evening schedule</dt><dd>{eveningText(model.owner.evening)}</dd></div>
          <div><dt>Stamina now</dt><dd>{model.owner.stamina} ({ENTRY_STAMINA} needed at the cutoff)</dd></div>
        </dl>
      )}
      <ul className={styles.rules}>{ENTRY_RULES.map(rule => <li key={rule}>{rule}</li>)}</ul>
    </section>
  );
}

export type BracketModel = {
  state: TournamentStageState;
  /** The round tab shown. */
  round: number | null;
  /** The completed bout replayed inline. */
  replayBoutId: string | null;
  /** While that bout's log is not merged in yet: loading on demand, or it could not be loaded. */
  replayStatus?: 'loading' | 'failed' | null;
  /** The signed-in owner's gladiator, if any. */
  viewerId?: string | null;
  /** The viewer's own credited summary for its placement, from its own timeline (null until read). */
  credited?: ActivitySummary | null;
  timeZone?: string;
};

/** Seven days after a tournament ends its bout replays are no longer kept; its results stay (Task 22.5). */
const REPLAYS_GONE = 'These bout replays are no longer kept. Detailed replays are kept for seven days; the results stay.';
const REPLAY_GONE = 'This replay is no longer kept. Detailed replays are kept for seven days. The result stays in the recent results.';

function BoutCard({ bout, kept, onWatch }: { bout: TournamentBoutState; kept: boolean; onWatch(boutId: string): void }) {
  const names = bout.sides.map(s => s?.name ?? 'To be decided');
  const winner = bout.sides.find(s => s?.gladiatorId === bout.winnerId) ?? null;
  const how = victoryText(bout);
  return (
    <li className={styles.bout} data-status={bout.status}>
      <p className={styles.boutTitle}>Bout {bout.position + 1}</p>
      <p className={styles.sides}>{bout.sides.length === 0 ? 'To be revealed' : bout.status === 'bye' ? names[0] : names.join(' vs ')}</p>
      {bout.status === 'fighting' && <p className={styles.live}>Bout in progress</p>}
      {bout.status === 'delayed' && <p className="muted">Not published yet</p>}
      {bout.status === 'bye' && winner && <p className={styles.winner} data-winner-id={winner.gladiatorId}>{winner.name} advances on a bye</p>}
      {bout.status === 'decided' && winner && <p className={styles.winner} data-winner-id={winner.gladiatorId}>Winner: {winner.name}</p>}
      {how && <p className="muted">{how}</p>}
      {/* A completed fought bout can be watched while its replay is kept: its log loads on demand when the polled view has none. */}
      {bout.status === 'decided' && (kept
        ? <button type="button" className={styles.watch} aria-label={`Watch replay of ${names.join(' vs ')}`} onClick={() => onWatch(bout.id)}>Watch replay</button>
        : <p className="muted">Replay no longer kept</p>)}
    </li>
  );
}

/** Pure view of one tournament at the display time. */
export function TournamentBracketView({ model, onRound, onWatch, onCloseReplay, onRetryReplay }: {
  model: BracketModel; onRound(round: number): void; onWatch(boutId: string): void; onCloseReplay(): void;
  /** Asks for the watched bout's log again after its load failed (Task 23.4); without it no Try again is offered. */
  onRetryReplay?: () => void;
}) {
  const { state, timeZone } = model;
  const titleId = useId();
  const tabsId = useId();
  const replayId = useId();
  const round = state.rounds.find(r => r.round === model.round) ?? state.rounds[0] ?? null;
  const champion = state.entrants.find(e => e.gladiatorId === state.championId) ?? null;
  const own = viewerText(state, !!model.viewerId, timeZone);
  const replay = model.replayBoutId ? state.rounds.flatMap(r => r.bouts).find(b => b.id === model.replayBoutId && b.status === 'decided') ?? null : null;
  const replayRound = replay ? state.rounds.find(r => r.round === replay.round)! : null;
  const kept = tournamentReplayKept(state.endsAtMs, state.displayNowMs);

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!round) return;
    const last = state.rounds.length;
    const target = event.key === 'ArrowRight' ? Math.min(last, round.round + 1) : event.key === 'ArrowLeft' ? Math.max(1, round.round - 1)
      : event.key === 'Home' ? 1 : event.key === 'End' ? last : null;
    if (target === null) return;
    event.preventDefault();
    onRound(target);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-round="${target}"]`)?.focus();
  };

  return (
    <article className={styles.card} aria-labelledby={titleId} data-status={state.status}>
      <header className={styles.header}>
        <p className="eyebrow">{leagueName(state.league)} league · {timeWithUtc(state.startsAtMs, timeZone)}</p>
        <h4 id={titleId}>{leagueName(state.league)} tournament</h4>
      </header>
      <p className={styles.status} role="status">{statusText(state.status)}</p>
      <p className={styles.detail}>{statusDetail(state, timeZone)}</p>
      {own && <p className={styles.own}>{own}</p>}
      {state.viewer.placement && (
        <p className={styles.own}>Your placement: {ordinal(state.viewer.placement.place)}.{model.credited ? ` Credited: ${creditedText(model.credited)}.` : ''}</p>
      )}
      {champion && <p className={styles.champion} data-champion-id={champion.gladiatorId}>Champion: {champion.name}</p>}
      {state.shape && <p className={styles.shape}>{shapeText(state.shape)}</p>}

      {state.entrants.length > 0 && (
        <section aria-label="Entrants" className={styles.entrants}>
          <h5>Entrants ({state.entrants.length})</h5>
          <ul>{state.entrants.map(e => (
            <li key={e.gladiatorId} data-role={e.role ?? 'none'} aria-current={e.gladiatorId === model.viewerId ? 'true' : undefined}>
              <span className={styles.name}>{e.name}</span>{e.gladiatorId === model.viewerId && <span className={styles.you}>You</span>}
              <span className={styles.role}>{roleText(e, state)}</span>
            </li>
          ))}</ul>
        </section>
      )}

      {round && (
        <section aria-label="Bracket" className={styles.bracket}>
          <div role="tablist" aria-label="Rounds" className={styles.tabs} onKeyDown={onTabKey}>
            {state.rounds.map(r => (
              <button key={r.round} type="button" role="tab" id={`${tabsId}-tab-${r.round}`} data-round={r.round} aria-selected={r.round === round.round}
                aria-controls={`${tabsId}-panel`} tabIndex={r.round === round.round ? 0 : -1} onClick={() => onRound(r.round)}>{r.label}</button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${round.round}`} className={styles.panel}>
            <p className={styles.roundStatus}>{roundStatus(round)}</p>
            {roundNote(round, timeZone) && <p className="muted">{roundNote(round, timeZone)}</p>}
            {!kept && <p className="muted">{REPLAYS_GONE}</p>}
            <ul className={styles.bouts}>{round.bouts.map(b => <BoutCard key={b.id} bout={b} kept={kept} onWatch={onWatch} />)}</ul>
          </div>
        </section>
      )}

      {replay && replayRound && (
        <section className={styles.replay} aria-labelledby={replayId}>
          <div className={styles.replayHeader}>
            <h5 id={replayId}>Replay · {replayRound.label}, bout {replay.position + 1}</h5>
            <button type="button" onClick={onCloseReplay}>Close replay</button>
          </div>
          {replay.log ? <>
            <p className="muted">The replay is the recorded bout. Watching it never changes the result.</p>
            {/* Under the card's h4 and this section's h5: the replay title is an h6 (its sections stay at h6). Only a fighter
                in the bout is told its rewards are credited when the activity settles (13.8 review). */}
            <BattleReplay key={replay.id} headingLevel={6} viewerId={model.viewerId ?? null} view={{ kind: 'replay', selected: 0, summary: null, battles: [{
              log: replay.log,
              stage: { id: replay.id, kind: 'bout', label: `Tournament · ${replayRound.label}`, revealedAtMs: replay.revealAtMs, startedAtMs: replay.revealAtMs, endsAtMs: replay.fightEndsAtMs! },
            }] }} />
          </> : (
            // The log loads on demand (the polled view carries none) while the replay is kept; the card's own status line
            // stays the only status. Once it is not kept the log cannot be read any more (Task 22.5).
            <>
              <p className="muted" aria-live="polite">{!kept ? REPLAY_GONE
                : model.replayStatus === 'failed' ? 'This replay cannot be loaded right now. Try again shortly.' : 'Loading the replay…'}</p>
              {/* Try again replaces itself: the focus moves to Close replay first, never to <body>. */}
              {kept && model.replayStatus === 'failed' && onRetryReplay && <button type="button" className={styles.retry}
                onClick={event => { event.currentTarget.closest('section')?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }); onRetryReplay(); }}>Try again</button>}
            </>
          )}
        </section>
      )}

      {state.placements.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Placements</caption>
            <thead><tr><th scope="col">Place</th><th scope="col">Gladiator</th></tr></thead>
            <tbody>{state.placements.map(p => (
              <tr key={p.gladiatorId} aria-current={p.gladiatorId === model.viewerId ? 'true' : undefined}><td>{p.place}</td><th scope="row">{p.name}</th></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

/**
 * A missing or unreadable tournament, or the running slot's tournament before its publication (2b review M4). `expired`
 * (Task 22.5): a missing tournament whose replays would no longer be kept anyway, as an old link's slot tells.
 */
export function TournamentNotice({ failure, preparing, expired = false }: { failure: 'unavailable' | 'not-found'; preparing: boolean; expired?: boolean }) {
  if (failure === 'not-found' && expired) {
    return (
      <div className={styles.detail} role="status">
        <p><strong>This tournament is no longer kept</strong></p>
        <p className="muted">Detailed replays are kept for seven days, and results stay in the recent results for 90 days.</p>
      </div>
    );
  }
  if (failure === 'not-found' && preparing) {
    return (
      <div className={styles.detail} role="status">
        <p><strong>Tournament being prepared</strong></p>
        <p className="muted">Entrants and the bracket appear here once this slot’s entries are processed, usually within about two minutes of the start.</p>
      </div>
    );
  }
  return <p className={styles.detail} role="status">{failure === 'not-found' ? 'No tournament matches this selection.' : 'Tournament brackets cannot be loaded right now. Only revealed results are ever shown.'}</p>;
}

/** What one read of a card's tournament found: its view, or why there is none. */
export type TournamentCardRead = { view: TournamentView; failure: null } | { view: null; failure: 'unavailable' | 'not-found' };

/** Reads one tournament for its card: a missing view is `not-found`, any other failure `unavailable`. Never throws. */
export async function readTournamentCard(reads: Pick<TournamentReads, 'tournament'>, id: string): Promise<TournamentCardRead> {
  try {
    return { view: await reads.tournament(id), failure: null };
  } catch (error) {
    return { view: null, failure: (error as { code?: unknown } | null)?.code === 'not-found' ? 'not-found' : 'unavailable' };
  }
}

const cardPreparing = (id: string, failure: 'unavailable' | 'not-found', now: number, processedSlotIndex: number | null, publishedSlotIndex: number | null) =>
  failure === 'not-found' && tournamentPreparing(id, now, processedSlotIndex, publishedSlotIndex);

/**
 * A card without a view (Task 19 R5): its tournament is being prepared while its slot is unpublished by the revision's
 * published slot as of the read (C5), or without one during the five minutes after its cutoff or while the owner's
 * processed slot (null without an owner) is still behind it (`tournamentPreparing`); a missing one whose slot ended seven
 * days or more before the display time is no longer kept (Task 22.5); otherwise it is missing or cannot be read now.
 */
export function TournamentCardNotice({ id, failure, now, processedSlotIndex, publishedSlotIndex = null }: {
  id: string; failure: 'unavailable' | 'not-found'; now: number; processedSlotIndex: number | null; publishedSlotIndex?: number | null;
}) {
  const endsAtMs = tournamentEndsAtMs(id);
  return <TournamentNotice failure={failure} preparing={cardPreparing(id, failure, now, processedSlotIndex, publishedSlotIndex)}
    expired={endsAtMs !== null && !tournamentReplayKept(endsAtMs, now)} />;
}

/**
 * One tournament: read on open, at each reveal mark, on focus, every 30 s while a read failed, and while it is
 * processing after 30 s, 60 s, 120 s, 240 s and then every 5 minutes (back to the normal schedule once its status
 * changes); never from a hidden tab. A bout's battle log loads only when its replay is watched. While its slot is being
 * prepared without a published slot on the revision, a re-read first awaits the owner refresh (R2); with one, a card read
 * before the publication reads again once the revision shows it (C5).
 */
function TournamentCard({ id, reads, clock, now, viewerId, processedSlotIndex, publishedSlotIndex, refreshOwner, onRead, onLogRead, hook }: {
  id: string; reads: TournamentReads; clock: DisplayClock; now: number; viewerId: string | null;
  /** The viewer's own processed slot (owner state; null without an owner), published with the slot's tournaments. */
  processedSlotIndex: number | null;
  /** The revision's published slot (Task 23.2; null before the first coordination), from the shared sync. */
  publishedSlotIndex: number | null;
  /** Re-reads the owner, so its processed slot is current while the slot is being prepared. */
  refreshOwner?: () => Promise<void>;
  onRead(): void; onLogRead(): void; hook: { current: TournamentTestHook['state'] | null };
}) {
  const [view, setView] = useState<TournamentView | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'not-found' | null>(null);
  /** The published slot as it was when the failed read started: a missing view read before the publication is no answer. */
  const [failedPublished, setFailedPublished] = useState<number | null>(null);
  /** Failed reads so far, so a read that lands just after the publication was seen is followed by one more. */
  const [failedReads, setFailedReads] = useState(0);
  const publishedNow = useRef(publishedSlotIndex);
  useEffect(() => { publishedNow.current = publishedSlotIndex; });
  const [round, setRound] = useState<number | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const [credited, setCredited] = useState<{ activityId: string; summary: ActivitySummary } | null>(null);
  /** Logs of watched bouts, loaded on demand (results are immutable; the live gateway also keeps them for the session). */
  const [logs, setLogs] = useState<ReadonlyMap<string, BattleLog>>(() => new Map());
  const [logFailed, setLogFailed] = useState<string | null>(null);
  /** Each Try again on a failed log asks for it once more (Task 23.4). */
  const [logAttempt, setLogAttempt] = useState(0);
  const request = useRef(0);
  const inFlight = useRef(false);
  const lastRead = useRef(-Infinity);
  /** Processing re-reads in a row since the status last changed: they set the back-off. */
  const retries = useRef(0);
  // R2: the latest owner refresh and "being prepared", kept in refs so a new function or value never restarts a timer.
  const refreshOwnerNow = useRef(refreshOwner);
  const preparingNow = useRef(false);
  useEffect(() => { refreshOwnerNow.current = refreshOwner; });

  const read = useCallback(async () => {
    const mine = ++request.current;
    inFlight.current = true;
    try {
      // While the slot is being prepared without a published slot on the revision, the owner is read first: a
      // publication its processed slot shows is then already visible to the tournament read, so the two never disagree on
      // the publication tick (R2). With one (C5) the revision tells the publication, so the owner is not read for it.
      const refresh = preparingNow.current && publishedNow.current === null ? refreshOwnerNow.current : undefined;
      if (refresh) {
        await refresh().catch(() => undefined);
        if (mine !== request.current) return;
      }
      const published = publishedNow.current;
      lastRead.current = clock.now();
      onRead();
      const next = await readTournamentCard(reads, id);
      if (mine !== request.current) return;
      if (next.view) { setView(next.view); setFailure(null); } else { setFailure(next.failure); setFailedPublished(published); setFailedReads(n => n + 1); }
    } finally {
      if (mine === request.current) inFlight.current = false;
    }
  }, [clock, id, onRead, reads]);

  useEffect(() => {
    void read();
    // Focus and visibility usually fire together: one re-read on coming back.
    const onFocus = () => { if (document.visibilityState === 'visible' && !inFlight.current) void read(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { request.current += 1; window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [read]);

  // Between the cutoff and the slot's publication the live read answers not-found: the tournament is being prepared.
  const preparing = !!failure && !view && cardPreparing(id, failure, now, processedSlotIndex, failedPublished);
  useEffect(() => { preparingNow.current = preparing; });
  // A view found missing before its slot was published is read again as soon as the revision shows the publication (C5):
  // that read's answer is final, without waiting for the next (backed-off) retry.
  const slotOfCard = tournamentSlotOf(id);
  const publishedSince = failure === 'not-found' && !view && slotOfCard !== null && failedPublished !== null && failedPublished < slotOfCard
    && publishedSlotIndex !== null && publishedSlotIndex >= slotOfCard;
  useEffect(() => {
    if (publishedSince && document.visibilityState === 'visible' && !inFlight.current) void read();
  }, [publishedSince, failedReads, read]);

  // A failed first read is asked again every 30 s while the tab is visible (as well as on focus); while the slot is being
  // prepared without a published slot on the revision, each re-read first refreshes the owner, so a published slot
  // without this tournament stops reading as being prepared (with one, the revision tells it: C5). One timer per failure: a new owner refresh function from the parent does not restart it (R2). From three
  // minutes after the cutoff a slot still being prepared is re-read, with its owner, after 60 s, 120 s, 240 s and then
  // every 5 minutes (Task 23.4, C11): each visible 30 s tick counts toward the wait.
  useEffect(() => {
    if (!failure || view) return;
    const slot = tournamentSlotOf(id);
    let ticks = 0, late = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      ticks += 1;
      const since = slot === null ? Number.NaN : clock.now() - slot * RULES_V1.clock.slotMs;
      const preparingLate = preparingNow.current && since >= TOURNAMENT_PREPARE_FAST_MS;
      if (ticks * RETRY_MS < (preparingNow.current ? preparingRetryDelay(since, late) : RETRY_MS)) return;
      ticks = 0;
      if (preparingLate) late += 1;
      void read();
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [failure, view, read, clock, id]);

  const merged = useMemo(() => (view ? withTournamentLogs(view, logs) : null), [view, logs]);
  const state = merged ? renderTournament(merged, now, { viewerId }) : null;

  // The watched bout's log, on demand while its replay is kept: once per bout (a failure can be retried by watching again).
  const watched = replay && state ? state.rounds.flatMap(r => r.bouts).find(b => b.id === replay && b.status === 'decided') ?? null : null;
  const needsLog = !!watched && !watched.log && tournamentReplayKept(state!.endsAtMs, state!.displayNowMs);
  useEffect(() => {
    if (!replay || !needsLog || logs.has(replay)) return;
    let current = true;
    if (!reads.tournamentLog) { setLogFailed(replay); return; }
    setLogFailed(null);
    onLogRead();
    reads.tournamentLog(replay).then(log => {
      if (current) setLogs(prev => new Map(prev).set(replay, log));
    }, () => { if (current) setLogFailed(replay); });
    return () => { current = false; };
  }, [replay, needsLog, logs, reads, onLogRead, logAttempt]);
  // A loaded log that does not agree with the published result is never shown.
  const replayStatus = !needsLog ? null : logFailed === replay || (replay !== null && logs.has(replay)) ? 'failed' as const : 'loading' as const;

  // Once the viewer has a place, its own credited rewards come from its own activity timeline (owner-only under RLS).
  const placed = state?.viewer.placement?.activityId ?? null;
  useEffect(() => {
    if (!placed || !reads.timeline || credited?.activityId === placed) return;
    let current = true;
    reads.timeline(placed).then(timeline => {
      if (current && timeline.summary?.activityId === placed) setCredited({ activityId: placed, summary: timeline.summary });
    }, () => undefined);
    return () => { current = false; };
  }, [placed, reads, credited]);

  // A fresh read once the clock passes the start, a round's reveal or the settlement, and while results are due but
  // missing (processing) after a back-off of 30 s, 60 s, 120 s, 240 s, then every 5 minutes, reset when the status
  // changes. Marks are recomputed after every render, so a clock moved back and forward reads again. A hidden tab
  // never reads (the focus listener re-reads once on coming back).
  const pending = useRef<number[]>([]);
  useEffect(() => {
    if (!state) return;
    const t = state.displayNowMs;
    if (t < lastRead.current) lastRead.current = t;
    if (state.status !== 'processing') retries.current = 0;
    const passedMark = pending.current.some(mark => mark <= t);
    const retry = state.status === 'processing' && t - lastRead.current >= processingRetryDelay(retries.current);
    pending.current = tournamentRevealMarks(state);
    if (document.visibilityState !== 'visible' || !(passedMark || retry)) return;
    if (!passedMark) retries.current += 1;
    void read();
  });

  const shownRound = state?.rounds.some(r => r.round === round) ? round : state?.currentRound ?? null;
  useEffect(() => {
    hook.current = () => state && {
      id: state.id, now: state.displayNowMs, status: state.status, round: shownRound, replay,
      roles: Object.fromEntries(state.entrants.map(e => [e.name, e.role])),
      champion: state.entrants.find(e => e.gladiatorId === state.championId)?.name ?? null, placements: state.placements.length,
    };
  });

  if (failure && !view) return <TournamentCardNotice id={id} failure={failure} now={now} processedSlotIndex={processedSlotIndex} publishedSlotIndex={failedPublished} />;
  if (!state) return <p role="status" className={styles.detail}>Loading the tournament…</p>;
  return <TournamentBracketView model={{ state, round: shownRound, replayBoutId: replay, replayStatus, viewerId,
    credited: credited && credited.activityId === placed ? credited.summary : null }}
    onRound={setRound} onWatch={setReplay} onCloseReplay={() => setReplay(null)}
    onRetryReplay={replayStatus === 'failed' && logFailed === replay ? () => { setLogFailed(null); setLogAttempt(n => n + 1); } : undefined} />;
}

const LEAGUES: readonly LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];
/** The display time, and whether it is the server's (synced from a revision read, or held by a test or capture). */
const readClock = (clock: DisplayClock) => ({ now: clock.now(), ready: clock.synced() || clock.frozen() !== null });

/**
 * The Tournaments tab. In fixture mode it opens sample tournaments; otherwise the tournament of the running or latest
 * tournament slot (Task 19's lookup id `tournament:<slot>:<league>`, `tournamentLookupIdOrNull`) in the owner's league,
 * or, for a visitor or a viewer without a gladiator, in the league the viewer picks (Bronze first). A signed-in player
 * whose owner is still loading gets no picker and reads nothing until its league is known. Without a reader it says
 * brackets cannot be shown yet. Every time is the shared display clock's; until it has the server's time the panel waits,
 * or says brackets cannot be loaded while the sync fails to read the revision. Registration is a player's only: everyone
 * else sees the countdown and the brackets (spec "Menus", the Visitor column).
 */
export function TournamentPanel({ reads, owner, clock, fixture, samples = [], refresh, syncError, viewer, publishedSlotIndex = null }: {
  reads: TournamentReads | null;
  owner: OwnerState | null;
  clock: DisplayClock;
  fixture: boolean;
  samples?: readonly TournamentSample[];
  /** Re-reads the owner: after a confirmed change, and before a re-read while the slot is being prepared. */
  refresh?: () => Promise<void>;
  /** The shared sync's error (`GameUiState.syncError`): while the clock has no server time, a failed revision read. */
  syncError: 'unavailable' | 'unauthenticated' | null;
  /** The game state's viewer kind: only a visitor or a viewer without a gladiator picks a league, only a player registers. */
  viewer: Viewer;
  /** The revision's published slot (`GameUiState.publishedSlotIndex`, Task 23.2; null before the first coordination). */
  publishedSlotIndex?: number | null;
}) {
  /** The shared clock's time, and whether it has the server's time yet (or is held), read together at each tick. */
  const [time, setTime] = useState(() => readClock(clock));
  const now = time.now;
  const [selected, setSelected] = useState<string | null>(null);
  /** The league a viewer without a gladiator follows. */
  const [league, setLeague] = useState<LeagueId>('bronze');
  /** Fixture only: the opened sample's bracket is held at its projection time until the test hook sets the clock. */
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<RegistrationModel['message']>(null);
  const attempt = useRef<OptIn | null>(null);
  const sending = useRef(false);
  const mounted = useRef(false);
  const commandLog = useRef<string[]>([]);
  const readCount = useRef(0);
  const logReadCount = useRef(0);
  const cardState = useRef<TournamentTestHook['state'] | null>(null);
  const titleId = useId();
  const bracketsId = useId();
  const samplesId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => clock.subscribe(() => setTime(readClock(clock))), [clock]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setTime(readClock(clock)); }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [clock]);
  const onRead = useCallback(() => { readCount.current += 1; }, []);
  const onLogRead = useCallback(() => { logReadCount.current += 1; }, []);
  const pick = useCallback((next: string) => { cardState.current = null; setSelected(next); setHolding(true); }, []);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorTournaments = {
      state: () => cardState.current?.() ?? null,
      freeze: ms => { setHolding(false); clock.freeze(ms); },
      reads: () => readCount.current,
      logReads: () => logReadCount.current,
      commands: () => [...commandLog.current],
      open: pick,
    };
    return () => { delete window.__cloudiatorTournaments; };
  }, [clock, pick]);

  async function toggle() {
    if (!owner || sending.current) return;
    const enabled = !owner.tournamentOptIn;
    const command: OptIn = attempt.current?.enabled === enabled ? attempt.current : { kind: 'set-tournament-opt-in', operationId: crypto.randomUUID(), enabled };
    attempt.current = command;
    sending.current = true; setBusy(true); setMessage(null);
    commandLog.current.push(command.kind);
    try {
      const result = reads?.command ? await reads.command<unknown>(command) : { ok: false as const, code: 'unavailable' as const };
      if (!mounted.current) return;
      if (result.ok) {
        attempt.current = null;
        await refresh?.();
        if (mounted.current) setMessage({ kind: 'status', text: `Saved. ${registrationNote(clock.now()).applies}` });
        return;
      }
      if (!['processing', 'unavailable', 'rate-limited'].includes(result.code)) attempt.current = null;
      setMessage({ kind: fixture ? 'status' : 'alert', text: fixture && result.code === 'unavailable' ? 'Registration changes are unavailable in this preview. Your setting is unchanged.'
        : result.code === 'processing' ? 'The world is processing the latest results. Your setting is unchanged; retry shortly.'
          : result.code === 'unauthenticated' ? 'Sign in again to change your registration. Your setting is unchanged.'
            : result.code === 'unavailable' || result.code === 'rate-limited' ? 'This change could not be confirmed. Your setting is unchanged; retry to confirm the same request.'
              : `Registration change rejected: ${result.code}. Your setting is unchanged.` });
    } catch {
      if (mounted.current) setMessage({ kind: 'alert', text: 'This change could not be confirmed. Your setting is unchanged; retry to confirm the same request.' });
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // Live mode: the owner's league, or the picked one, in the running or latest tournament slot (never an invalid id).
  // Only once the shared clock has the server's time (or is held): the browser's own clock could name another slot.
  // Only a visitor or a viewer without a gladiator picks; a signed-in player whose owner is loading waits for its league.
  const picker = !fixture && !owner && (viewer === 'visitor' || viewer === 'no-gladiator');
  const liveLeague = owner ? owner.progression.league : picker ? league : null;
  const liveId = fixture || !time.ready || !liveLeague ? null : tournamentLookupIdOrNull(latestTournament(now).slotIndex, liveLeague);
  const id = selected ?? liveId;
  // A fixture sample is one view projected at one server time (the preview has no server clock), so its bracket is
  // held there, where it shows what its label says; the schedule and registration keep the running clock.
  const sampleTime = fixture && holding ? samples.find(s => s.id === id)?.asOfMs ?? null : null;
  return (
    <section className={styles.tournaments} aria-labelledby={titleId}>
      <div className="section-title">
        <div><p className="eyebrow">TOURNAMENTS</p><h2 id={titleId}>Tournaments</h2></div>
        <span className="tag">Wed &amp; Sat · 18:40 UTC</span>
      </div>
      <TournamentScheduleView now={now} />
      {viewer === 'player' && <RegistrationView model={{ optIn: owner ? owner.tournamentOptIn : null, busy, message, displayNowMs: now,
        owner: owner ? { evening: owner.schedule.evening, stamina: owner.stamina.current } : null }} onToggle={() => void toggle()} />}
      <section className={styles.brackets} aria-labelledby={bracketsId}>
        <h3 id={bracketsId}>Brackets</h3>
        {fixture && samples.length > 0 && (
          <nav aria-labelledby={samplesId} className={styles.samples}>
            <p id={samplesId} className="eyebrow">SAMPLE TOURNAMENTS</p>
            <ul>{samples.map(s => (
              <li key={s.id}><button type="button" aria-pressed={id === s.id} onClick={() => pick(s.id)}>{s.label}</button></li>
            ))}</ul>
          </nav>
        )}
        {picker && (
          <div className={styles.leagues} role="group" aria-label="League">
            {LEAGUES.map(option => <button key={option} type="button" aria-pressed={league === option} onClick={() => setLeague(option)}>{leagueName(option)}</button>)}
          </div>
        )}
        {fixture && !id ? <p className="muted">Choose a sample tournament to follow its bracket.</p>
          : !reads ? <p className="panel-notice" role="status">Tournament brackets cannot be shown in this build yet.</p>
            : !fixture && !liveLeague && !selected ? (viewer === 'unavailable' ? <TournamentNotice failure="unavailable" preparing={false} />
              : <p role="status" className={styles.detail}>Loading your gladiator’s tournament…</p>)
            : !id ? (time.ready ? <TournamentNotice failure="not-found" preparing={false} />
              // No server time yet: a failed revision read is said at once, never an endless "Loading" (review M1).
              : syncError ? <TournamentNotice failure="unavailable" preparing={false} />
                : <p role="status" className={styles.detail}>Loading the tournament…</p>)
              : <TournamentCard key={id} id={id} reads={reads} clock={clock} now={sampleTime ?? now} viewerId={owner?.gladiatorId ?? null}
                processedSlotIndex={owner?.processedSlotIndex ?? null} publishedSlotIndex={fixture ? null : publishedSlotIndex}
                refreshOwner={refresh} onRead={onRead} onLogRead={onLogRead} hook={cardState} />}
      </section>
    </section>
  );
}
