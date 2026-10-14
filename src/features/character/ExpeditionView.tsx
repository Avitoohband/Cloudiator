'use client';

// The followable expedition view: the isometric scene, an 80-minute progress strip, the current phase,
// health read from the battle logs, an activity log of revealed stages with replay links, camera
// controls and a Camp button. Everything shown comes from the revealed timeline at the display clock
// (src/game/expedition-stage.ts); results and rewards come only from a settled summary. The view only
// reads (timeline, then world and owner once) and never sends a command. Names and labels render as
// React text. The character's name comes from the public world actor (or the owner's own record),
// never from a battle log, whose gladiator participant Task 9 names "Gladiator".
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { ActivitySummary, RevealedTimeline } from '@contracts/events';
import type { PublicActor } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { EXPEDITION_MS, expeditionRevealMarks, renderExpeditionStage, type ExpeditionSceneState, type VisibleStage } from '../../game/expedition-stage';
import type { ExpeditionEnvironment, GladiatorLook } from '../../game/expedition-scene';
import { ExpeditionViewport } from '../../game/ExpeditionViewport';
import { createSceneBridge } from '../../game/bridge';
import { layersFor, tintFor } from '../../game/actors';
import { prefersReducedMotion } from '../../game/webgl';
import styles from './ExpeditionView.module.css';

export type ExpeditionReads = Pick<GameGateway, 'timeline' | 'world' | 'owner'>;

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read the view and hold its clock. */
export type ExpeditionTestHook = {
  state(): {
    activityId: string; phase: ExpeditionSceneState['phase']; displayNowMs: number; minute: number | null; labels: string[]; current: string | null;
    hp: ExpeditionSceneState['hp']; route: ExpeditionSceneState['route']; replays: string[]; complete: boolean;
    outcome: ExpeditionSceneState['outcome']; settled: boolean; owner: boolean; name: string | null; environment: ExpeditionEnvironment | null;
  } | null;
  /** Holds the display clock at a display time (null lets it run on from there). */
  freeze(displayNowMs: number | null): void;
  /** Timeline reads so far, including the first. */
  reads(): number;
  /** Bridge listeners. */
  listeners(): number;
  /** Display clock loops running on this page. */
  loops(): number;
};
declare global {
  interface Window { __cloudiatorExpedition?: ExpeditionTestHook }
}

const ENVIRONMENTS: ExpeditionEnvironment[] = ['woodland', 'outpost', 'mountain'];
const MARKERS = [0, 20, 40, 60, 80];
const TICK_MS = 250;
/** Spec 10.5's poll interval, used while a due stage or the owner's summary is awaited. */
const POLL_MS = 30_000;
/** Encounter numbers in words: a health or phase text never repeats a log line's "Encounter N". */
const ORDINALS = ['first', 'second', 'third'];
let activeLoops = 0;

const clockTime = (ms: number) => new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(ms);
const day = (ms: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(ms);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The expedition environment: the public location when known, else the published departure label. */
function environmentOf(timeline: RevealedTimeline | null, actor: PublicActor | null): ExpeditionEnvironment | null {
  const located = actor?.location.startsWith('expedition:') ? actor.location.slice('expedition:'.length) : null;
  if (located && (ENVIRONMENTS as string[]).includes(located)) return located as ExpeditionEnvironment;
  const departure = timeline?.stages.find(s => s.kind === 'depart')?.label.toLowerCase() ?? '';
  return ENVIRONMENTS.find(id => departure.includes(CATALOG_V1.expeditions[id].name.toLowerCase())) ?? null;
}

/** 'light-boots:1:uncommon' → 'Light boots (tier 1, uncommon)'; 'salvage' → 'Salvage'. */
function itemName(catalogId: string, tier: number, rarity: string): string {
  const template = catalogId.split(':')[0];
  const base = CATALOG_V1.items[catalogId]?.name ?? capital(template.replace(/-/g, ' '));
  return template === 'salvage' ? base : `${base} (tier ${tier}, ${rarity})`;
}
function rewardLines(summary: ActivitySummary): string[] {
  const r = summary.rewards;
  return [
    r.money ? `+${r.money} money` : null,
    r.xp ? `+${r.xp} XP` : null,
    r.renown ? `+${r.renown} renown` : null,
    r.attributePoints ? `+${r.attributePoints} attribute points` : null,
    ...r.items.map(item => `${itemName(item.catalogId, item.tier, item.rarity)} ×${item.quantity}`),
    r.overflowMoney ? `+${r.overflowMoney} money for items that did not fit` : null,
  ].filter((line): line is string => !!line);
}

/** The current phase in words. Titles never name an encounter number, so a log line stays the only "Encounter N". */
function phaseText(state: ExpeditionSceneState, expedition: string): { title: string; detail: string } {
  const lost = state.stages.find(s => s.outcome === 'defeat')?.encounter;
  switch (state.phase) {
    case 'depart': return { title: 'Setting out', detail: `Travelling the ${expedition} and searching the trail.` };
    case 'exploration': return { title: 'Exploring', detail: 'Searching the trail and waiting for whatever comes next.' };
    case 'encounter': return { title: 'Fighting', detail: 'The revealed battle plays in the scene. Its result shows when it ends.' };
    case 'safe-return': return { title: 'Returning without rewards', detail: `Defeated${lost ? ` in the ${ORDINALS[lost - 1]} encounter` : ''}. Resting at the safe return point until the slot ends, with all gear kept.` };
    case 'returning': return { title: 'Returning to camp', detail: 'All three encounters cleared. Heading back along the trail.' };
    case 'preparing': return state.stages.length
      ? { title: 'Preparing', detail: 'The next stage has not been published yet. It appears here as soon as it is revealed.' }
      : { title: 'Preparing', detail: 'Nothing has been revealed for this expedition yet.' };
    default: return state.outcome === 'failure'
      ? { title: 'Back at camp after a defeat', detail: 'The gladiator returned with all gear.' }
      : { title: 'Back at camp', detail: 'The expedition is complete.' };
  }
}

/** The logged health, named by the encounter it comes from; the server's recovery is never computed here. */
function healthText(state: ExpeditionSceneState): { label: string; recovers: boolean } {
  if (!state.hp) return { label: 'Health', recovers: false };
  const fight = state.stages.find(s => s.encounter === state.hp!.encounter);
  const which = ORDINALS[state.hp.encounter - 1] ?? `number ${state.hp.encounter}`;
  return {
    label: `Health ${fight?.inProgress ? 'during' : 'after'} the ${which} encounter`,
    // After a won non-final encounter the server heals the gladiator before the next one.
    recovers: fight?.outcome === 'victory' && state.hp.encounter < ORDINALS.length,
  };
}

/**
 * Timeline reads. Task 10 replaces this with the shared sync controller: one read on entry, the reads
 * `readDue` asks for while the tab is visible, and one when the tab regains focus. `onRead` hears every
 * read. A failed later read keeps the last revealed timeline.
 */
function useTimelineReads(reads: ExpeditionReads, activityId: string, onFirst: (timeline: RevealedTimeline) => void, onRead: () => void) {
  const [timeline, setTimeline] = useState<RevealedTimeline | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'not-found' | null>(null);
  const count = useRef(0);
  const request = useRef(0);
  const first = useRef(onFirst);
  const heard = useRef(onRead);
  const loaded = useRef(false);
  useEffect(() => { first.current = onFirst; heard.current = onRead; }, [onFirst, onRead]);
  const read = useCallback(async () => {
    const mine = ++request.current;
    count.current += 1;
    heard.current();
    try {
      const next = await reads.timeline(activityId);
      if (mine !== request.current) return;
      if (!loaded.current) { loaded.current = true; first.current(next); }
      setTimeline(next);
    } catch (error) {
      if (mine !== request.current || loaded.current) return;
      setFailure((error as { code?: unknown } | null)?.code === 'not-found' ? 'not-found' : 'unavailable');
    }
  }, [activityId, reads]);
  useEffect(() => {
    void read();
    const onFocus = () => { if (document.visibilityState === 'visible') void read(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      request.current += 1;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [read]);
  return { timeline, failure, read, count };
}

type ReadSchedule = { pending: number[]; done: Set<number>; lastReadMs: number | null };

/**
 * When the display clock (ticking only while the tab is visible) next needs a fresh timeline read; the
 * one swappable piece Task 10's sync controller replaces. True once for each reveal mark passed (the
 * current stage's end and each 20-minute mark), and, while a due stage is unpublished (Preparing) or
 * the owner's summary is awaited (Processing results), whenever POLL_MS have passed since the last read
 * of any kind. Those polls stop as soon as the stage or the summary is there. A spectator never waits
 * for a summary.
 */
function readDue(schedule: ReadSchedule, state: ExpeditionSceneState, owner: boolean): boolean {
  const t = state.displayNowMs;
  const passed = schedule.pending.filter(mark => mark <= t && !schedule.done.has(mark));
  for (const mark of passed) schedule.done.add(mark);
  schedule.pending = expeditionRevealMarks(state);
  // The entry read happened just before the first tick; a held fixture clock may also move back.
  if (schedule.lastReadMs === null || schedule.lastReadMs > t) schedule.lastReadMs = t;
  const waiting = state.phase === 'preparing' || (owner && state.awaitingSummary);
  return passed.length > 0 || (waiting && t - schedule.lastReadMs >= POLL_MS);
}

/** Shown for a missing, malformed or unreadable expedition: nothing is drawn or read further. */
export function ExpeditionUnavailable({ fixture, reason }: { fixture: boolean; reason: 'not-found' | 'unavailable' }) {
  const titleId = useId();
  return <section className={`${styles.card} ${styles.missing}`} aria-labelledby={titleId}>
    <h1 id={titleId}>This expedition is not available</h1>
    <p>{reason === 'not-found'
      ? 'No expedition matches this link.'
      : 'It may not exist, or expedition scenes cannot be loaded in this build yet. Only revealed stages of an expedition are ever shown.'}</p>
    <Link className={styles.camp} href={fixture ? '/game/?mode=fixture' : '/game/'}>Camp</Link>
  </section>;
}

export function ExpeditionView({ reads, activityId, fixture, startMinute = null }: {
  reads: ExpeditionReads;
  activityId: string;
  /** Fixture preview: links keep mode=fixture. */
  fixture: boolean;
  /** Fixture preview only: open at this minute of the expedition, then run in real time. */
  startMinute?: number | null;
}) {
  const [bridge] = useState(createSceneBridge);
  const clock = useRef<{ anchorMs: number; at: number; frozen: number | null } | null>(null);
  const now = useCallback(() => {
    const c = clock.current;
    return c ? c.frozen ?? c.anchorMs + (performance.now() - c.at) : 0;
  }, []);
  // The display clock starts at the server time of the first read (or the fixture minute) and runs in real time.
  const anchor = useCallback((timeline: RevealedTimeline) => {
    const departure = timeline.stages[0]?.startedAtMs;
    const start = startMinute !== null && departure !== undefined ? departure + startMinute * 60_000 : timeline.serverNowMs;
    clock.current = { anchorMs: start, at: performance.now(), frozen: null };
  }, [startMinute]);
  const schedule = useRef<ReadSchedule>({ pending: [], done: new Set(), lastReadMs: null });
  // Every read (entry, schedule or focus) restarts the poll interval at the display time it was made.
  const onRead = useCallback(() => { schedule.current.lastReadMs = clock.current ? now() : null; }, [now]);
  const { timeline, failure, read, count } = useTimelineReads(reads, activityId, anchor, onRead);
  const timelineRef = useRef(timeline);
  const ownerRef = useRef(false);
  const [displayMs, setDisplayMs] = useState<number | null>(null);
  const [world, setWorld] = useState<{ actors: readonly PublicActor[] } | null>(null);
  const [ownerState, setOwnerState] = useState<{ id: string; name: string } | null>(null);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const titleId = useId();
  const resultId = useId();
  const logId = useId();
  const loadedOnce = !!timeline;

  // Public names and look, and whose expedition this is: optional reads, made once the expedition exists.
  useEffect(() => {
    if (!loadedOnce) return;
    let alive = true;
    reads.world().then(next => { if (alive) setWorld({ actors: next.actors }); }).catch(() => {});
    reads.owner().then(owner => { if (alive) setOwnerState({ id: owner.gladiatorId, name: owner.name }); }).catch(() => {});
    return () => { alive = false; };
  }, [loadedOnce, reads]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // A later read never moves the display clock back; a server ahead of it moves it forward (not in a fixture minute).
  useEffect(() => {
    timelineRef.current = timeline;
    const c = clock.current;
    if (!timeline || !c) return;
    if (c.frozen === null && startMinute === null && timeline.serverNowMs > now()) clock.current = { anchorMs: timeline.serverNowMs, at: performance.now(), frozen: null };
    setDisplayMs(now());
  }, [now, startMinute, timeline]);

  // The display clock: React re-renders a few times a second; the scene reads the clock every frame. A
  // hidden tab does nothing; on return the clock shows the current time directly.
  useEffect(() => {
    activeLoops += 1;
    const tick = () => {
      if (document.visibilityState !== 'visible' || !timelineRef.current || !clock.current) return;
      const t = now();
      setDisplayMs(t);
      if (readDue(schedule.current, renderExpeditionStage(timelineRef.current, t), ownerRef.current)) void read();
    };
    const timer = window.setInterval(tick, TICK_MS);
    return () => { window.clearInterval(timer); activeLoops -= 1; };
  }, [now, read]);

  const state = useMemo(() => (timeline && displayMs !== null ? renderExpeditionStage(timeline, displayMs) : null), [timeline, displayMs]);

  const byActivity = world?.actors.find(a => a.activityId === activityId) ?? null;
  const gladiatorId = byActivity?.gladiatorId ?? state?.gladiator?.id ?? null;
  const byId = gladiatorId ? world?.actors.find(a => a.gladiatorId === gladiatorId) ?? null : null;
  const environment = environmentOf(timeline, byActivity);
  // Only the owner's timeline carries a summary (counted once it is due, like every stage); otherwise
  // compare the owner's id with the expedition's. Before either is known, nobody is named.
  const owner = !!state?.summary || (!!ownerState && ownerState.id === gladiatorId);
  useEffect(() => { ownerRef.current = owner; }, [owner]);
  const name = byActivity?.name ?? byId?.name ?? (owner ? ownerState?.name ?? null : null);
  const silhouettes = (byActivity?.equipmentSilhouettes ?? state?.gladiator?.equipmentSilhouettes ?? []).join('|');
  const look = useMemo<GladiatorLook>(() => ({
    key: gladiatorId ?? activityId, name: name ?? 'Gladiator',
    layers: layersFor(silhouettes ? silhouettes.split('|') : []), tint: tintFor(gladiatorId ?? activityId),
  }), [activityId, gladiatorId, name, silhouettes]);
  const sceneState = useCallback(() => (timelineRef.current && clock.current ? renderExpeditionStage(timelineRef.current, now()) : null), [now]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorExpedition = {
      state: () => {
        const t = timelineRef.current;
        if (!t || !clock.current) return null;
        const s = renderExpeditionStage(t, now());
        return {
          activityId: s.activityId, phase: s.phase, displayNowMs: s.displayNowMs, minute: s.progress?.minute ?? null, labels: s.stages.map(x => x.label),
          current: s.current?.label ?? null, hp: s.hp, route: s.route, replays: s.stages.filter(x => x.replay).map(x => x.id), complete: s.complete,
          outcome: s.outcome, settled: !!s.summary, owner, name, environment,
        };
      },
      freeze: ms => {
        const c = clock.current;
        if (!c) return;
        clock.current = ms === null ? { anchorMs: c.frozen ?? now(), at: performance.now(), frozen: null } : { ...c, frozen: ms };
        setDisplayMs(now());
      },
      reads: () => count.current,
      listeners: () => bridge.listenerCount(),
      loops: () => activeLoops,
    };
    return () => { delete window.__cloudiatorExpedition; };
  }, [bridge, count, environment, name, now, owner]);

  if (failure) return <ExpeditionUnavailable fixture={fixture} reason={failure} />;
  if (!timeline || !state) return <p role="status">Loading the expedition…</p>;

  const campHref = fixture ? '/game/?mode=fixture' : '/game/';
  const expedition = environment ? CATALOG_V1.expeditions[environment].name : 'Expedition';
  const text = phaseText(state, expedition);
  const health = healthText(state);
  const progress = state.progress;
  const minute = Math.floor(progress?.minute ?? 0);
  const replayHref = (stage: VisibleStage) => `/replay/?${fixture ? 'mode=fixture&' : ''}activity=${encodeURIComponent(activityId)}&stage=${encodeURIComponent(stage.id)}`;
  const summary = state.summary;
  const encounters = state.stages.some(s => s.encounter !== null);
  const who = name ?? (owner ? 'Your gladiator' : gladiatorId ? "Another gladiator's journey" : null);
  return (
    <section className={styles.view} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <p className="eyebrow">{who ? `EXPEDITION · ${who}` : 'EXPEDITION'}</p>
          <h1 id={titleId}>{expedition}</h1>
        </div>
        <Link className={styles.camp} href={campHref}>Camp</Link>
      </header>

      {environment ? <ExpeditionViewport environment={environment} state={sceneState} look={look} bridge={bridge} reducedMotion={reduced}
        label={`Isometric view of the ${expedition}. The gladiator travels automatically; drag or use the arrow keys to look around, plus and minus to zoom, F to follow.`} />
        : <div className={styles.placeholder}>The scene appears once the departure is revealed.</div>}

      <div className={styles.now}>
        <div className={styles.phase} role="status" aria-live="polite" aria-label="Current stage">
          <strong>{text.title}</strong>
          <span>{text.detail}</span>
        </div>
        <div className={styles.health}>
          <span className={styles.label}>{health.label}</span>
          {state.hp ? <div className={styles.meter} role="meter" aria-label="Gladiator health" aria-valuemin={0} aria-valuemax={state.hp.max} aria-valuenow={state.hp.current}
            aria-valuetext={`${state.hp.current} of ${state.hp.max} ${health.label.toLowerCase()}`}>
            <span className={styles.fill} style={{ width: `${(100 * state.hp.current) / state.hp.max}%` }} />
            <span className={styles.hpText}>{state.hp.current} / {state.hp.max}</span>
          </div> : <span className={styles.note}>{encounters ? 'Not kept for this expedition' : 'Full at departure'}</span>}
          {health.recovers && <span className={styles.recovers}>Some health recovers before the next encounter.</span>}
        </div>
      </div>

      <div className={styles.strip}>
        <div className={styles.track} role="meter" aria-label="Expedition progress" aria-valuemin={0} aria-valuemax={EXPEDITION_MS / 60_000} aria-valuenow={minute}
          aria-valuetext={`Minute ${minute} of ${EXPEDITION_MS / 60_000}`}>
          <span className={styles.trackFill} style={{ width: `${100 * (progress?.fraction ?? 0)}%` }} />
          <span className={styles.position} style={{ left: `${100 * (progress?.fraction ?? 0)}%` }} />
        </div>
        <ol className={styles.markers} aria-label="Minutes">
          {MARKERS.map(m => <li key={m} style={{ left: `${(100 * m) / 80}%` }}>{m === 80 ? '80 min' : m}</li>)}
        </ol>
      </div>

      <div className={styles.columns}>
        <section className={styles.card} role="region" aria-labelledby={resultId}>
          <h2 id={resultId}>Result</h2>
          {state.phase === 'safe-return' ? <p>No rewards: a defeat ends the remaining encounters, and the gladiator keeps all gear.</p>
            : !state.complete ? <p className={styles.note}>The result is known when the expedition returns at minute 80.</p>
              : <>
                <p className={styles.verdict}>{state.outcome === 'failure' ? 'Defeated' : 'Success'}</p>
                {!owner ? <p className={styles.note}>Another gladiator&apos;s expedition: only its revealed journey is shown.</p>
                  : summary ? <>
                    {summary.success ? <><p className={styles.note}>Credited rewards</p>
                      <ul className={styles.rewards}>{rewardLines(summary).map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}</ul></>
                      : <p className={styles.note}>No rewards are credited after a defeat.</p>}
                    <p className={styles.note}>{summary.replayExpiry.state === 'available'
                      ? `Encounter replays are kept until ${day(summary.replayExpiry.expiresAtMs)}; the result stays in your history for 90 days.`
                      : 'Encounter replays are no longer kept; the result stays in your history for 90 days.'}</p>
                  </> : state.awaitingSummary ? <p role="status">Processing results…</p> : null}
              </>}
        </section>

        <section className={styles.card} aria-labelledby={logId}>
          <h2 id={logId}>Activity log</h2>
          <ol className={styles.log} aria-label="Activity log">
            {state.stages.map(stage => <li key={stage.id} aria-current={stage.id === state.current?.id ? 'step' : undefined} className={stage.id === state.current?.id ? styles.current : undefined}>
              <time dateTime={new Date(stage.startedAtMs).toISOString()}>{clockTime(stage.startedAtMs)}</time>
              <span className={styles.logLabel}>{stage.label}</span>
              {stage.inProgress && <span className={styles.badge}>in progress</span>}
              {stage.replay && <Link className={styles.replay} href={replayHref(stage)} aria-label={`Watch the replay of encounter ${stage.encounter}`}>Watch replay</Link>}
            </li>)}
          </ol>
        </section>
      </div>
    </section>
  );
}
