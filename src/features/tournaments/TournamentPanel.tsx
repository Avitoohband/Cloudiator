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
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GameCommand } from '@contracts/commands';
import type { ActivitySummary, BattleLog } from '@contracts/events';
import type { OwnerState, TournamentView } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import {
  latestTournament, nextTournament, processingRetryDelay, renderTournament, tournamentIdFor, tournamentPreparing, tournamentRevealMarks,
  tournamentWindowAt, withTournamentLogs, type TournamentBoutState, type TournamentStageState,
} from '../../game/tournament-stage';
import { BattleReplay } from '../arena/BattleReplay';
import {
  ENTRY_RULES, ENTRY_STAMINA, afternoonText, countdownText, creditedText, leagueName, ordinal, registrationNote, roleText, roundNote,
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
      <p className="muted">Every Wednesday and Saturday at 17:20 UTC, for one 80-minute afternoon slot. Times show in your time zone; daylight saving never moves the UTC time.</p>
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
  owner: { afternoon: OwnerState['schedule']['afternoon']; stamina: number } | null;
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
          <div><dt>Afternoon schedule</dt><dd>{afternoonText(model.owner.afternoon)}</dd></div>
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

function BoutCard({ bout, onWatch }: { bout: TournamentBoutState; onWatch(boutId: string): void }) {
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
      {/* A completed fought bout can always be watched: its log loads on demand when the polled view has none. */}
      {bout.status === 'decided' && (
        <button type="button" className={styles.watch} aria-label={`Watch replay of ${names.join(' vs ')}`} onClick={() => onWatch(bout.id)}>Watch replay</button>
      )}
    </li>
  );
}

/** Pure view of one tournament at the display time. */
export function TournamentBracketView({ model, onRound, onWatch, onCloseReplay }: {
  model: BracketModel; onRound(round: number): void; onWatch(boutId: string): void; onCloseReplay(): void;
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
            <ul className={styles.bouts}>{round.bouts.map(b => <BoutCard key={b.id} bout={b} onWatch={onWatch} />)}</ul>
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
            {/* Under the card's h4 and this section's h5: the replay title is an h6 (its sections stay at h6). */}
            <BattleReplay key={replay.id} headingLevel={6} view={{ kind: 'replay', selected: 0, summary: null, battles: [{
              log: replay.log,
              stage: { id: replay.id, kind: 'bout', label: `Tournament · ${replayRound.label}`, revealedAtMs: replay.revealAtMs, startedAtMs: replay.revealAtMs, endsAtMs: replay.fightEndsAtMs! },
            }] }} />
          </> : (
            // The log loads on demand (the polled view carries none); the card's own status line stays the only status.
            <p className="muted" aria-live="polite">{model.replayStatus === 'failed' ? 'This replay cannot be loaded right now. Try again shortly.' : 'Loading the replay…'}</p>
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

/** A missing or unreadable tournament, or the running slot's tournament before its publication (2b review M4). */
export function TournamentNotice({ failure, preparing }: { failure: 'unavailable' | 'not-found'; preparing: boolean }) {
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

/**
 * One tournament: read on open, at each reveal mark, on focus, every 30 s while a read failed, and while it is
 * processing after 30 s, 60 s, 120 s, 240 s and then every 5 minutes (back to the normal schedule once its status
 * changes); never from a hidden tab. A bout's battle log loads only when its replay is watched.
 */
function TournamentCard({ id, reads, clock, now, viewerId, processedSlotIndex, refreshOwner, onRead, onLogRead, hook }: {
  id: string; reads: TournamentReads; clock: DisplayClock; now: number; viewerId: string | null;
  /** The viewer's own processed slot (owner state), which tells a slot being prepared from one without this tournament. */
  processedSlotIndex: number | null;
  /** Re-reads the owner, so its processed slot is current while the slot is being prepared. */
  refreshOwner?: () => Promise<void>;
  onRead(): void; onLogRead(): void; hook: { current: TournamentTestHook['state'] | null };
}) {
  const [view, setView] = useState<TournamentView | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'not-found' | null>(null);
  const [round, setRound] = useState<number | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const [credited, setCredited] = useState<{ activityId: string; summary: ActivitySummary } | null>(null);
  /** Logs of watched bouts, loaded on demand (results are immutable; the live gateway also keeps them for the session). */
  const [logs, setLogs] = useState<ReadonlyMap<string, BattleLog>>(() => new Map());
  const [logFailed, setLogFailed] = useState<string | null>(null);
  const request = useRef(0);
  const inFlight = useRef(false);
  const lastRead = useRef(-Infinity);
  /** Processing re-reads in a row since the status last changed: they set the back-off. */
  const retries = useRef(0);

  const read = useCallback(async () => {
    const mine = ++request.current;
    lastRead.current = clock.now();
    inFlight.current = true;
    onRead();
    try {
      const next = await reads.tournament(id);
      if (mine !== request.current) return;
      setView(next);
      setFailure(null);
    } catch (error) {
      if (mine === request.current) setFailure((error as { code?: unknown } | null)?.code === 'not-found' ? 'not-found' : 'unavailable');
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
  const preparing = failure === 'not-found' && !view && tournamentPreparing(id, now, processedSlotIndex);
  const preparingNow = useRef(preparing);
  useEffect(() => { preparingNow.current = preparing; });

  // A failed first read is asked again every 30 s while the tab is visible (as well as on focus); while the slot is being
  // prepared the owner is re-read too, so a published slot without this tournament stops reading as being prepared.
  useEffect(() => {
    if (!failure || view) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void read();
      if (preparingNow.current) refreshOwner?.().catch(() => undefined);
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [failure, view, read, refreshOwner]);

  const merged = useMemo(() => (view ? withTournamentLogs(view, logs) : null), [view, logs]);
  const state = merged ? renderTournament(merged, now, { viewerId }) : null;

  // The watched bout's log, on demand: once per bout (a failure can be retried by watching again).
  const watched = replay && state ? state.rounds.flatMap(r => r.bouts).find(b => b.id === replay && b.status === 'decided') ?? null : null;
  const needsLog = !!watched && !watched.log;
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
  }, [replay, needsLog, logs, reads, onLogRead]);
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

  if (failure && !view) return <TournamentNotice failure={failure} preparing={preparing} />;
  if (!state) return <p role="status" className={styles.detail}>Loading the tournament…</p>;
  return <TournamentBracketView model={{ state, round: shownRound, replayBoutId: replay, replayStatus, viewerId,
    credited: credited && credited.activityId === placed ? credited.summary : null }}
    onRound={setRound} onWatch={setReplay} onCloseReplay={() => setReplay(null)} />;
}

/**
 * The Tournaments tab. In fixture mode it opens sample tournaments; otherwise the owner's league tournament of the
 * running or latest tournament slot (`tournamentIdFor`, Task 19's lookup id `tournament:<slot>:<league>`). Without a
 * reader it says brackets cannot be shown yet.
 */
export function TournamentPanel({ reads, owner, clock, fixture, samples = [], refresh }: {
  reads: TournamentReads | null;
  owner: OwnerState | null;
  clock: DisplayClock;
  fixture: boolean;
  samples?: readonly TournamentSample[];
  /** Re-reads the owner after a confirmed change. */
  refresh?: () => Promise<void>;
}) {
  const [now, setNow] = useState(() => clock.now());
  const [selected, setSelected] = useState<string | null>(null);
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

  useEffect(() => clock.subscribe(() => setNow(clock.now())), [clock]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNow(clock.now()); }, TICK_MS);
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

  // Live mode: the owner's league in the running or latest tournament slot.
  const liveId = !fixture && owner ? tournamentIdFor(latestTournament(now).slotIndex, owner.progression.league) : null;
  const id = selected ?? liveId;
  // A fixture sample is one view projected at one server time (the preview has no server clock), so its bracket is
  // held there, where it shows what its label says; the schedule and registration keep the running clock.
  const sampleTime = fixture && holding ? samples.find(s => s.id === id)?.asOfMs ?? null : null;
  return (
    <section className={styles.tournaments} aria-labelledby={titleId}>
      <div className="section-title">
        <div><p className="eyebrow">TOURNAMENTS</p><h2 id={titleId}>Tournaments</h2></div>
        <span className="tag">Wed &amp; Sat · 17:20 UTC</span>
      </div>
      <TournamentScheduleView now={now} />
      <RegistrationView model={{ optIn: owner ? owner.tournamentOptIn : null, busy, message, displayNowMs: now,
        owner: owner ? { afternoon: owner.schedule.afternoon, stamina: owner.stamina.current } : null }} onToggle={() => void toggle()} />
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
        {!id ? <p className="muted">{fixture ? 'Choose a sample tournament to follow its bracket.' : 'Create a gladiator to follow your league’s tournament.'}</p>
          : !reads ? <p className="panel-notice" role="status">Tournament brackets cannot be shown in this build yet.</p>
            : <TournamentCard key={id} id={id} reads={reads} clock={clock} now={sampleTime ?? now} viewerId={owner?.gladiatorId ?? null}
              processedSlotIndex={owner?.processedSlotIndex ?? null} refreshOwner={refresh} onRead={onRead} onLogRead={onLogRead} hook={cardState} />}
      </section>
    </section>
  );
}
