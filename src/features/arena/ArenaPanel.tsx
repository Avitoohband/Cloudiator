'use client';

// The Arena card: one entrant's regular Arena activity as the stage core shows it at the display clock. It opens
// from the camp (a click on an Arena entrant or a fight button, which also scrolls it into view and focuses it),
// for the owner's own Arena activity, or from the fixture samples. Before minute 60 it shows only the warm-up; from
// the reveal, the opponent (an NPC fallback is disclosed as such), the bout in progress and the replay link; after
// the bout, the logged result; and for the owner only, the renown and rating change once the server has credited
// them. It only reads (the timeline, then the opponent's public profile) and never sends a command. Names render as
// React text.
//
// Spectators (Task 13.4): without an owner (a visitor, or a player without a gladiator) the section still opens cards
// from the camp, with no "Your arena bout" button; a card it does not own shows the public stages and result only, and
// never an owner summary, even one a reader returned.
//
// Task 13.8: Watch replay opens the bout's replay as a scene over the camp (the bridge's `view-replay`).
import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react';
import type { RevealedTimeline } from '@contracts/events';
import type { OwnerState, PublicProfile, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { SceneBridge } from '../../game/bridge';
import type { DisplayClock } from '../../game/display-clock';
import { ARENA_RETRY_MS } from '../../game/arena-layout';
import { ARENA_REVEAL_MS, arenaRevealMarks, renderArenaStage, type ArenaStageState } from '../../game/arena-stage';
import { NO_INJURY, NPC_DISCLOSURE, REVEAL_MINUTE, SLOT_MINUTES, arenaUnavailableText, className, creditedLines, phaseDetail, phaseTitle, replayHref, resultText } from './arena-text';
import styles from './ArenaPanel.module.css';

/** Reads the card makes: the activity's timeline and, once revealed, the opponent's public profile. */
export type ArenaReads = Pick<GameGateway, 'timeline'> & Partial<Pick<GameGateway, 'profile'>>;
export type ArenaSelection = { activityId: string; gladiatorId: string | null };
/** `focus` counts camp openings (0: opened from the panel itself), so each one brings the card into view. */
type OpenSelection = ArenaSelection & { focus: number };
export type ArenaSample = { activityId: string; label: string; gladiatorId: string };

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read the open card and hold the clock. */
export type ArenaTestHook = {
  state(): (Pick<ArenaStageState, 'activityId' | 'phase' | 'minute' | 'npcOpponent' | 'awaitingSummary'> & {
    owner: boolean; opponent: string | null; replay: string | null; result: string | null; credited: string[] | null;
  }) | null;
  /** Holds the shared display clock (null runs on from there). */
  freeze(displayNowMs: number | null): void;
  /** Timeline reads so far. */
  reads(): number;
  open(selection: ArenaSelection): void;
};
declare global {
  interface Window { __cloudiatorArena?: ArenaTestHook }
}

const TICK_MS = 1000;
const time = (ms: number) => new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(ms);

export type ArenaCardModel = {
  state: ArenaStageState;
  owner: boolean;
  entrantName: string;
  opponent: { name: string; className: string; rating: number | null } | null;
  fixture: boolean;
};

/** Pure view of one Arena activity. `onWatch` opens the expanded replay (`href` is its /replay/ deep link). */
export function ArenaCardView({ model, onWatch, onClose, headingRef }: { model: ArenaCardModel; onWatch(href: string): void; onClose?: () => void; headingRef?: Ref<HTMLHeadingElement> }) {
  const { state, owner, entrantName, opponent } = model;
  const titleId = useId();
  const reveal = state.startMs === null ? null : time(state.startMs + ARENA_REVEAL_MS);
  const result = state.result && opponent ? resultText(state.result, { entrant: entrantName, opponent: opponent.name }) : null;
  // The replay opens once the bout has ended (Task 13.8 fix round 1): mid-bout the replay scene, which offers only ended
  // fights, would say "not available yet". The bout plays live in the camp's ring meanwhile.
  const href = state.replay && state.bout?.finished ? replayHref(state.replay, model.fixture) : null;
  const minute = state.minute === null ? null : Math.max(0, Math.min(SLOT_MINUTES, Math.floor(state.minute)));
  return (
    <article className={styles.card} aria-labelledby={titleId} data-phase={state.phase}>
      <header className={styles.header}>
        <div>
          <p className="eyebrow">{owner ? 'YOUR ARENA BOUT' : 'ARENA BOUT'}{minute !== null ? ` · MINUTE ${minute} OF ${SLOT_MINUTES}` : ''}</p>
          <h3 id={titleId} ref={headingRef} tabIndex={-1}>{entrantName}</h3>
        </div>
        {onClose && <button type="button" className={styles.close} onClick={onClose} aria-label="Close the Arena card">Close</button>}
      </header>
      <p className={styles.phase} role="status">{phaseTitle(state)}</p>
      <p className={styles.detail}>{phaseDetail(state, owner, reveal)}</p>

      {opponent && (
        <dl className={styles.opponent} aria-label="Opponent">
          <div><dt>Opponent</dt><dd>{opponent.name}</dd></div>
          <div><dt>Class</dt><dd>{opponent.className}</dd></div>
          {!state.npcOpponent && <div><dt>Current rating</dt><dd>{opponent.rating ?? 'not available'}</dd></div>}
        </dl>
      )}
      {state.npcOpponent && <p className={styles.npc}>{NPC_DISCLOSURE}</p>}

      {result && (
        <section className={styles.result} aria-label="Result">
          <p className={result.title === 'Victory' ? styles.victory : styles.defeat}>{result.title}</p>
          <p>{result.detail}</p>
          {state.result!.outcome === 'defeat' && <p className="muted">{NO_INJURY}</p>}
        </section>
      )}

      {state.summary && (
        <section className={styles.credited} aria-label="Credited">
          <p className="eyebrow">CREDITED AT MINUTE {SLOT_MINUTES}</p>
          <ul>{creditedLines(state.summary).map(line => <li key={line}>{line}</li>)}</ul>
        </section>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.watch} disabled={!href} onClick={() => href && onWatch(href)}>Watch replay</button>
        <p className="muted">{state.replayExpired ? 'The detailed replay is no longer kept; the saved result remains.'
          : href ? 'The replay is the recorded bout. Watching it never changes the result.'
            : state.replay ? 'The replay becomes available when the bout ends.'
            : state.phase === 'preparing' && state.minute !== null && state.minute >= REVEAL_MINUTE ? 'The replay becomes available once the bout is published.'
              : `The replay becomes available when the bout is revealed at minute ${REVEAL_MINUTE}.`}</p>
      </div>
    </article>
  );
}

/** Live card: reads the timeline on open, again at the reveal marks, every 30 s while results are missing and on focus. */
function ArenaCard({ selection, focusRequest, bridge, reads, owner, world, clock, fixture, onClose, onRead, hook }: {
  selection: ArenaSelection; focusRequest: number; bridge: SceneBridge; reads: ArenaReads; owner: OwnerState | null; world: WorldSnapshot | null; clock: DisplayClock;
  fixture: boolean; onClose(): void; onRead(): void; hook: { current: ArenaTestHook['state'] | null };
}) {
  const [timeline, setTimeline] = useState<RevealedTimeline | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'not-found' | null>(null);
  const [now, setNow] = useState(() => clock.now());
  const [profile, setProfile] = useState<{ id: string; value: PublicProfile } | null>(null);
  const request = useRef(0);
  const lastRead = useRef(-Infinity);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef(0);
  const viewerId = owner?.gladiatorId ?? null;
  const isOwner = viewerId !== null && selection.gladiatorId === viewerId;
  const { activityId } = selection;

  const read = useCallback(async () => {
    const mine = ++request.current;
    lastRead.current = clock.now();
    onRead();
    try {
      const next = await reads.timeline(activityId);
      if (mine !== request.current) return;
      clock.sync(next.serverNowMs);
      setTimeline(next);
      setFailure(null);
    } catch (error) {
      if (mine === request.current) setFailure(prev => prev ?? ((error as { code?: unknown } | null)?.code === 'not-found' ? 'not-found' : 'unavailable'));
    }
  }, [activityId, clock, onRead, reads]);

  useEffect(() => {
    void read();
    const onFocus = () => { if (document.visibilityState === 'visible') void read(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { request.current += 1; window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [read]);

  useEffect(() => clock.subscribe(() => setNow(clock.now())), [clock]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setNow(clock.now()); }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [clock]);

  // A card the viewer does not own is drawn from the public timeline only: its stages and public completion.
  const visible = timeline && !isOwner && timeline.summary ? { ...timeline, summary: undefined } : timeline;
  const state = visible ? renderArenaStage(visible, now, { entrantId: selection.gladiatorId, owner: isOwner }) : null;

  // A fresh read once the clock passes minute 60 or 80 (the reveal marks), and every 30 s while the bout or the
  // results are missing. Marks are recomputed after every render, so a clock moved back and forward reads again.
  const pending = useRef<number[]>([]);
  useEffect(() => {
    if (!state) return;
    const t = state.displayNowMs;
    // A clock moved back (fixture captures) restarts the retry pacing from the new display time.
    if (t < lastRead.current) lastRead.current = t;
    const passedMark = pending.current.some(mark => mark <= t);
    const retry = (state.phase === 'preparing' || state.awaitingSummary) && t - lastRead.current >= ARENA_RETRY_MS;
    pending.current = arenaRevealMarks(state);
    if (passedMark || retry) void read();
  });

  const opponentId = state?.opponent && !state.opponent.npc ? state.opponent.gladiatorId : null;
  useEffect(() => {
    if (!opponentId || !reads.profile || profile?.id === opponentId) return;
    let alive = true;
    reads.profile(opponentId).then(value => { if (alive) setProfile({ id: opponentId, value }); }, () => {});
    return () => { alive = false; };
  }, [opponentId, profile?.id, reads]);

  const actorName = (id: string | null) => (id ? world?.actors.find(a => a.gladiatorId === id)?.name ?? null : null);
  const entrantName = actorName(selection.gladiatorId) ?? (isOwner ? owner!.name : null) ?? state?.entrant?.name ?? 'Gladiator';
  const known = profile && profile.id === opponentId ? profile.value : null;
  const opponent = state?.opponent ? {
    name: state.opponent.npc ? state.opponent.name : actorName(state.opponent.gladiatorId) ?? known?.actor.name ?? state.opponent.name,
    className: state.opponent.npc ? 'NPC fallback' : className(state.opponent.classId ?? known?.actor.classId ?? null),
    rating: state.opponent.npc ? null : known?.rating ?? null,
  } : null;

  // Opened from the camp (a fighter or a bout button), the card may sit far below the view: once its heading has
  // rendered, scroll the card into view by the shortest way (a card already in view stays put, and so does the camp)
  // and move the focus to the heading. Reduced motion jumps instead of scrolling smoothly.
  useEffect(() => {
    if (!focusRequest || focused.current === focusRequest || !heading.current) return;
    focused.current = focusRequest;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    (heading.current.closest('article') ?? heading.current).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    heading.current.focus({ preventScroll: true });
  });

  useEffect(() => {
    hook.current = () => state && {
      activityId: state.activityId, phase: state.phase, minute: state.minute, npcOpponent: state.npcOpponent, awaitingSummary: state.awaitingSummary,
      owner: isOwner, opponent: opponent?.name ?? null, replay: state.replay ? replayHref(state.replay, fixture) : null,
      result: state.result?.outcome ?? null, credited: state.summary ? creditedLines(state.summary) : null,
    };
  });

  if (failure && !timeline) {
    return <article className={styles.card}>
      <header className={styles.header}><h3 ref={heading} tabIndex={-1}>This Arena bout is not available</h3><button type="button" className={styles.close} onClick={onClose}>Close</button></header>
      <p className={styles.detail}>{arenaUnavailableText(failure)}</p>
    </article>;
  }
  if (!state) return <p role="status" className={styles.detail}>Loading the Arena bout…</p>;
  return <ArenaCardView model={{ state, owner: isOwner, entrantName, opponent, fixture }} onWatch={() => { if (state.replay) bridge.emit('view-replay', { activityId: state.replay.activityId, stageId: state.replay.stageId }); }}
    onClose={onClose} headingRef={heading} />;
}

/**
 * The page's Arena section: opens the card from camp selections (bridge `open-arena`), for the owner's own Arena
 * activity (only with an owner), and from the fixture samples. `owner` is null for a spectator. Without a reader it
 * says that the card is not available in this build yet; a real read failure keeps the temporary "right now" message.
 */
export function ArenaPanel({ bridge, reads, owner, world, clock, fixture, samples = [] }: {
  bridge: SceneBridge;
  reads: ArenaReads | null;
  owner: OwnerState | null;
  world: WorldSnapshot | null;
  clock: DisplayClock;
  fixture: boolean;
  samples?: readonly ArenaSample[];
}) {
  const [selection, setSelection] = useState<OpenSelection | null>(null);
  const focusRequests = useRef(0);
  const readCount = useRef(0);
  const cardState = useRef<ArenaTestHook['state'] | null>(null);
  const titleId = useId();
  const listId = useId();
  useEffect(() => bridge.on('open-arena', next => setSelection({ ...next, focus: ++focusRequests.current })), [bridge]);
  const onRead = useCallback(() => { readCount.current += 1; }, []);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorArena = {
      state: () => cardState.current?.() ?? null,
      freeze: ms => clock.freeze(ms),
      reads: () => readCount.current,
      open: next => setSelection({ ...next, focus: 0 }),
    };
    return () => { delete window.__cloudiatorArena; };
  }, [clock]);

  const own = owner?.currentActivity?.kind === 'arena' ? owner.currentActivity : null;
  const pick = (next: ArenaSelection) => { cardState.current = null; setSelection({ ...next, focus: 0 }); };
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <p className="eyebrow">THE ARENA</p>
      <h2 id={titleId} className={styles.title}>Arena bouts</h2>
      {own && owner && <button type="button" className={styles.pick} aria-pressed={selection?.activityId === own.id} onClick={() => pick({ activityId: own.id, gladiatorId: owner.gladiatorId })}>Your arena bout</button>}
      {fixture && samples.length > 0 && (
        <nav aria-labelledby={listId} className={styles.samples}>
          <p id={listId} className="eyebrow">SAMPLE ARENA BOUTS</p>
          <ul>{samples.map(s => (
            <li key={s.activityId}><button type="button" className={styles.pick} aria-pressed={selection?.activityId === s.activityId} onClick={() => pick({ activityId: s.activityId, gladiatorId: s.gladiatorId })}>{s.label}</button></li>
          ))}</ul>
        </nav>
      )}
      {!selection ? <p className="muted">Select a gladiator in the arena, or one of its bout buttons, to follow that bout here.</p>
        : !reads ? <p className={styles.detail} role="status">{arenaUnavailableText('build')}</p>
          : <ArenaCard key={selection.activityId} selection={selection} focusRequest={selection.focus} bridge={bridge} reads={reads} owner={owner} world={world} clock={clock} fixture={fixture}
            onClose={() => setSelection(null)} onRead={onRead} hook={cardState} />}
    </section>
  );
}
