'use client';

// The followable expedition view: the isometric scene, an 80-minute progress strip, the current phase,
// health read from the battle logs, an activity log of revealed stages with replay links, camera
// controls and a Camp button. Everything shown comes from the revealed timeline at the display clock
// (src/game/expedition-stage.ts); results and rewards come only from a settled summary. The view only
// reads (timeline, world, owner) and never sends a command. Names and labels render as React text.
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
    phase: ExpeditionSceneState['phase']; displayNowMs: number; minute: number | null; labels: string[]; current: string | null;
    hp: ExpeditionSceneState['hp']; route: ExpeditionSceneState['route']; replays: string[]; complete: boolean;
    outcome: ExpeditionSceneState['outcome']; settled: boolean; owner: boolean; environment: ExpeditionEnvironment | null;
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

function phaseText(state: ExpeditionSceneState, expedition: string): { title: string; detail: string } {
  switch (state.phase) {
    case 'depart': return { title: 'Setting out', detail: `Travelling the ${expedition} and searching the trail.` };
    case 'exploration': return { title: 'Exploring', detail: 'Recovering and searching for the next encounter.' };
    case 'encounter': return { title: 'Fighting a revealed encounter', detail: 'The battle plays in the scene. Its result appears when it ends.' };
    case 'safe-return': return { title: 'Returning without rewards', detail: 'Defeated. The gladiator rests at the safe return point until the slot ends and keeps all gear.' };
    case 'returning': return { title: 'Returning to camp', detail: 'All three encounters cleared. Heading back along the trail.' };
    case 'preparing': return state.stages.length
      ? { title: 'Preparing', detail: 'The next stage has not been published yet. It appears here as soon as it is revealed.' }
      : { title: 'Preparing', detail: 'Nothing has been revealed for this expedition yet.' };
    default: return state.outcome === 'failure'
      ? { title: 'Expedition failed', detail: 'The gladiator is back at camp with all gear.' }
      : { title: 'Expedition complete', detail: 'The gladiator is back at camp.' };
  }
}

/**
 * Timeline reads. Task 10 replaces this with the shared sync controller: one read on entry, one each time
 * the display clock passes a reveal mark (the current stage's end and each 20-minute mark, at most once
 * per mark), and one when the tab regains focus. A failed later read keeps the last revealed timeline.
 */
function useTimelineReads(reads: ExpeditionReads, activityId: string, onFirst: (timeline: RevealedTimeline) => void) {
  const [timeline, setTimeline] = useState<RevealedTimeline | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'not-found' | null>(null);
  const count = useRef(0);
  const request = useRef(0);
  const first = useRef(onFirst);
  const loaded = useRef(false);
  useEffect(() => { first.current = onFirst; }, [onFirst]);
  const read = useCallback(async () => {
    const mine = ++request.current;
    count.current += 1;
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
  const anchor = useCallback((timeline: RevealedTimeline) => {
    const departure = timeline.stages[0]?.startedAtMs;
    const start = startMinute !== null && departure !== undefined ? departure + startMinute * 60_000 : timeline.serverNowMs;
    clock.current = { anchorMs: start, at: performance.now(), frozen: null };
  }, [startMinute]);
  const { timeline, failure, read, count } = useTimelineReads(reads, activityId, anchor);
  const timelineRef = useRef(timeline);
  const [displayMs, setDisplayMs] = useState<number | null>(null);
  const [actor, setActor] = useState<PublicActor | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const marks = useRef<{ pending: number[]; done: Set<number> }>({ pending: [], done: new Set() });
  const titleId = useId();
  const resultId = useId();
  const logId = useId();

  // Public look and ownership: optional reads, never required to follow the expedition.
  useEffect(() => {
    let alive = true;
    reads.world().then(world => { if (alive) setActor(world.actors.find(a => a.activityId === activityId) ?? null); }).catch(() => {});
    reads.owner().then(owner => { if (alive) setOwnerId(owner.gladiatorId); }).catch(() => {});
    return () => { alive = false; };
  }, [activityId, reads]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // A later read never moves the display clock back; a server ahead of it moves it forward.
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
      const m = marks.current;
      const passed = m.pending.filter(mark => mark <= t && !m.done.has(mark));
      for (const mark of passed) m.done.add(mark);
      m.pending = expeditionRevealMarks(renderExpeditionStage(timelineRef.current, t));
      if (passed.length) void read();
    };
    const timer = window.setInterval(tick, TICK_MS);
    return () => { window.clearInterval(timer); activeLoops -= 1; };
  }, [now, read]);

  const state = useMemo(() => (timeline && displayMs !== null ? renderExpeditionStage(timeline, displayMs) : null), [timeline, displayMs]);

  const environment = environmentOf(timeline, actor);
  const gladiatorId = actor?.gladiatorId ?? state?.gladiator?.id ?? null;
  const name = actor?.name ?? state?.gladiator?.name ?? null;
  const silhouettes = (actor?.equipmentSilhouettes ?? state?.gladiator?.equipmentSilhouettes ?? []).join('|');
  const look = useMemo<GladiatorLook>(() => ({
    key: gladiatorId ?? activityId, name: name ?? 'Gladiator',
    layers: layersFor(silhouettes ? silhouettes.split('|') : []), tint: tintFor(gladiatorId ?? activityId),
  }), [activityId, gladiatorId, name, silhouettes]);
  const owner = !!ownerId && ownerId === gladiatorId;
  const sceneState = useCallback(() => (timelineRef.current && clock.current ? renderExpeditionStage(timelineRef.current, now()) : null), [now]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorExpedition = {
      state: () => {
        const t = timelineRef.current;
        if (!t || !clock.current) return null;
        const s = renderExpeditionStage(t, now());
        return {
          phase: s.phase, displayNowMs: s.displayNowMs, minute: s.progress?.minute ?? null, labels: s.stages.map(x => x.label), current: s.current?.label ?? null,
          hp: s.hp, route: s.route, replays: s.stages.filter(x => x.replay).map(x => x.id), complete: s.complete, outcome: s.outcome,
          settled: !!s.summary, owner, environment,
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
  }, [bridge, count, environment, now, owner]);

  const campHref = fixture ? '/game/?mode=fixture' : '/game/';
  const camp = <Link className={styles.camp} href={campHref}>Camp</Link>;
  if (failure) {
    return <section className={`${styles.card} ${styles.missing}`} aria-labelledby={titleId}>
      <h1 id={titleId}>This expedition is not available</h1>
      <p>{failure === 'not-found' ? 'No expedition was found for this link.' : 'Expedition scenes cannot be loaded in this build yet.'}</p>
      {camp}
    </section>;
  }
  if (!timeline || !state) return <p role="status">Loading the expedition…</p>;

  const expedition = environment ? CATALOG_V1.expeditions[environment].name : 'Expedition';
  const text = phaseText(state, expedition);
  const progress = state.progress;
  const minute = Math.floor(progress?.minute ?? 0);
  const replayHref = (stage: VisibleStage) => `/replay/?${fixture ? 'mode=fixture&' : ''}activity=${encodeURIComponent(activityId)}&stage=${encodeURIComponent(stage.id)}`;
  const summary = state.summary;
  return (
    <section className={styles.view} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div>
          <p className="eyebrow">EXPEDITION{name ? <> · <span>{name}</span></> : null}</p>
          <h1 id={titleId}>{expedition}</h1>
        </div>
        {camp}
      </header>

      {environment ? <ExpeditionViewport environment={environment} state={sceneState} look={look} bridge={bridge} reducedMotion={reduced}
        label={`Isometric view of the ${expedition}. The gladiator travels automatically; drag or use the arrow keys to look around, plus and minus to zoom, F to follow.`} />
        : <div className={styles.placeholder}>The scene appears once the departure is revealed.</div>}

      <div className={styles.now}>
        <div className={styles.phase} role="status" aria-live="polite">
          <strong>{text.title}</strong>
          <span>{text.detail}</span>
        </div>
        <div className={styles.health}>
          <span className={styles.label}>Health</span>
          {state.hp ? <div className={styles.meter} role="meter" aria-label="Gladiator health" aria-valuemin={0} aria-valuemax={state.hp.max} aria-valuenow={state.hp.current}
            aria-valuetext={`${state.hp.current} of ${state.hp.max} health`}>
            <span className={styles.fill} style={{ width: `${(100 * state.hp.current) / state.hp.max}%` }} />
            <span className={styles.hpText}>{state.hp.current} / {state.hp.max}</span>
          </div> : <span className={styles.note}>{state.stages.some(s => s.encounter !== null) ? 'Not kept for this expedition' : 'Full at departure'}</span>}
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
          {state.phase === 'safe-return' ? <p>Returning without rewards. A defeat ends the remaining encounters.</p>
            : !state.complete ? <p className={styles.note}>The result is known when the expedition returns at minute 80.</p>
              : <>
                <p className={styles.verdict}>{state.outcome === 'failure' ? 'Defeated: no rewards' : 'Success'}</p>
                {summary ? <>
                  {summary.success && <><p className={styles.note}>Credited rewards</p><ul className={styles.rewards}>{rewardLines(summary).map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}</ul></>}
                  <p className={styles.note}>{summary.replayExpiry.state === 'available'
                    ? `Encounter replays are kept until ${day(summary.replayExpiry.expiresAtMs)}; the result stays in your history for 90 days.`
                    : 'Encounter replays are no longer kept; the result stays in your history for 90 days.'}</p>
                </> : owner && state.awaitingSummary ? <p role="status">Processing results…</p>
                  : !owner ? <p className={styles.note}>Another gladiator&apos;s expedition: only its revealed journey is shown.</p> : null}
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
