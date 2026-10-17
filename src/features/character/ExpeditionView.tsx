'use client';

// The followable expedition view: the isometric scene, an 80-minute progress strip, the current phase,
// health read from the battle logs, an activity log of revealed stages with replay links, camera
// controls and a Camp button. Everything shown comes from the revealed timeline at the display clock
// (src/game/expedition-stage.ts); results and rewards come only from a settled summary. The view only
// reads its timeline and never sends a command. Names and labels render as React text. The character's
// name comes from the public world actor (or the owner's own record), never from a battle log, whose
// gladiator participant Task 9 names "Gladiator".
//
// Task 13.8: the shared game state (`useGameState`, on the page or in the camp) gives the view its world, its
// owner and the world revision. The timeline is read on entry, once at each reveal mark the display clock
// passes, and again whenever the shared sync controller's revision changes (its 30-second poll, and on focus):
// the view has no timer of its own. Over the camp it is a scene (`overCamp`): its headings start at h2, Watch
// replay opens the replay scene, and Back to camp replaces its Camp link. A guessed or unknown activity, with no
// revealed stage and no world actor on it, is "not available yet": never an endless "Preparing", never an error.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { ActivitySummary, RevealedTimeline } from '@contracts/events';
import type { OwnerState, PublicActor } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import { CATALOG_V1 } from '@domain/catalog-v1';
import {
  EXPEDITION_ENCOUNTERS, EXPEDITION_MS, expeditionRevealMarks, renderExpeditionStage, type ExpeditionSceneState, type VisibleStage,
} from '../../game/expedition-stage';
import type { ExpeditionEnvironment, GladiatorLook } from '../../game/expedition-scene';
import { ExpeditionViewport } from '../../game/ExpeditionViewport';
import { createSceneBridge } from '../../game/bridge';
import { layersFor, tintFor } from '../../game/actors';
import { prefersReducedMotion } from '../../game/webgl';
import styles from './ExpeditionView.module.css';

export type ExpeditionReads = Pick<GameGateway, 'timeline'>;

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
    // After a won encounter that is not the last the server heals the gladiator before the next one.
    recovers: fight?.outcome === 'victory' && state.hp.encounter < EXPEDITION_ENCOUNTERS,
  };
}

/**
 * Timeline reads: one on entry, then whatever `read` is asked for (a reveal mark, a new shared revision). `onFirst`
 * hears the first timeline. A failed later read keeps the last revealed timeline; only the latest read lands.
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
    return () => { request.current += 1; };
  }, [read]);
  return { timeline, failure, read, count };
}

/**
 * Whether the display clock (ticking only while the tab is visible) has passed a reveal mark it had ahead of it at an
 * earlier tick: the current stage's end and each 20-minute mark. Each mark asks for one read; nothing is due once the
 * expedition is complete. Everything else a read could bring arrives with a new shared revision.
 */
function passedRevealMark(schedule: { pending: number[]; done: Set<number> }, state: ExpeditionSceneState): boolean {
  const passed = schedule.pending.filter(mark => mark <= state.displayNowMs && !schedule.done.has(mark));
  for (const mark of passed) schedule.done.add(mark);
  schedule.pending = expeditionRevealMarks(state);
  return passed.length > 0;
}

type HeadingLevel = 1 | 2;
const titleTag = (level: HeadingLevel) => (level === 1 ? 'h1' : 'h2');
const sectionTag = (level: HeadingLevel) => (level === 1 ? 'h2' : 'h3');

/**
 * Shown for a missing, malformed or unreadable expedition (nothing is drawn or read further), and for a guessed or
 * unknown one (`not-yet`), which shows no summary at all. Over the camp there is no Camp link (the scene has Back to
 * camp) and the title is an h2.
 */
export function ExpeditionUnavailable({ fixture, reason, overCamp = false }: { fixture: boolean; reason: 'not-found' | 'unavailable' | 'not-yet'; overCamp?: boolean }) {
  const titleId = useId();
  const Title = titleTag(overCamp ? 2 : 1);
  return <section className={`${styles.card} ${styles.missing}`} aria-labelledby={titleId}>
    <Title id={titleId}>{reason === 'not-yet' ? 'This expedition is not available yet' : 'This expedition is not available'}</Title>
    <p>{reason === 'not-yet' ? 'Nothing has been revealed for it. Only the revealed stages of an expedition are ever shown, as they happen.'
      : reason === 'not-found' ? 'No expedition matches this link.'
        : 'It may not exist, or expedition scenes cannot be loaded in this build yet. Only revealed stages of an expedition are ever shown.'}</p>
    {!overCamp && <Link className={styles.camp} href={fixture ? '/game/?mode=fixture' : '/game/'}>Camp</Link>}
  </section>;
}

export function ExpeditionView({ reads, activityId, fixture, startMinute = null, revision, world, worldFailed = false, owner, overCamp }: {
  reads: ExpeditionReads;
  activityId: string;
  /** Fixture preview: links keep mode=fixture. */
  fixture: boolean;
  /** Fixture preview only: open at this minute of the expedition, then run in real time. */
  startMinute?: number | null;
  /** The shared world revision (`useGameState`): each change re-reads the timeline. */
  revision: string | null;
  /** The shared public world, for names, the look and whose expedition this is; null while it loads. */
  world: { actors: readonly PublicActor[] } | null;
  /** The world could not be read, so no actor is known to be on this activity. */
  worldFailed?: boolean;
  /** The signed-in viewer's own gladiator, or null (a visitor, or an owner still loading). */
  owner: Pick<OwnerState, 'gladiatorId' | 'name'> | null;
  /** Over the camp: Watch replay opens the replay scene (at an encounter's stage), and there is no Camp link. */
  overCamp?: { onWatch(stageId: string): void };
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
  const marks = useRef<{ pending: number[]; done: Set<number> }>({ pending: [], done: new Set() });
  const { timeline, failure, read, count } = useTimelineReads(reads, activityId, anchor);
  const timelineRef = useRef(timeline);
  const [displayMs, setDisplayMs] = useState<number | null>(null);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const titleId = useId();
  const resultId = useId();
  const logId = useId();

  // A new shared revision (never the first one the view sees: the entry read is fresh) may carry a published stage or
  // the owner's settled summary.
  const seenRevision = useRef(revision);
  useEffect(() => {
    const previous = seenRevision.current;
    seenRevision.current = revision;
    if (previous !== null && revision !== null && revision !== previous) void read();
  }, [revision, read]);

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
      if (passedRevealMark(marks.current, renderExpeditionStage(timelineRef.current, t))) void read();
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
  const isOwner = !!state?.summary || (!!owner && owner.gladiatorId === gladiatorId);
  const name = byActivity?.name ?? byId?.name ?? (isOwner ? owner?.name ?? null : null);
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
          outcome: s.outcome, settled: !!s.summary, owner: isOwner, name, environment,
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
  }, [bridge, count, environment, name, now, isOwner]);

  if (failure) return <ExpeditionUnavailable fixture={fixture} reason={failure} overCamp={!!overCamp} />;
  if (!timeline || !state) return <p role="status">Loading the expedition…</p>;
  // A guessed or unknown activity: nothing revealed, and nobody in the world on it (Review Focus 3).
  if (!state.stages.length && !byActivity) {
    return world || worldFailed ? <ExpeditionUnavailable fixture={fixture} reason="not-yet" overCamp={!!overCamp} />
      : <p role="status">Loading the expedition…</p>;
  }

  const level: HeadingLevel = overCamp ? 2 : 1;
  const Title = titleTag(level);
  const Section = sectionTag(level);
  const campHref = fixture ? '/game/?mode=fixture' : '/game/';
  const expedition = environment ? CATALOG_V1.expeditions[environment].name : 'Expedition';
  const text = phaseText(state, expedition);
  const health = healthText(state);
  const progress = state.progress;
  const minute = Math.floor(progress?.minute ?? 0);
  const replayHref = (stage: VisibleStage) => `/replay/?${fixture ? 'mode=fixture&' : ''}activity=${encodeURIComponent(activityId)}&stage=${encodeURIComponent(stage.id)}`;
  const summary = state.summary;
  const encounters = state.stages.some(s => s.encounter !== null);
  const who = name ?? (isOwner ? 'Your gladiator' : gladiatorId ? "Another gladiator's journey" : null);
  return (
    <section className={styles.view} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <p className="eyebrow">{who ? `EXPEDITION · ${who}` : 'EXPEDITION'}</p>
          <Title id={titleId}>{expedition}</Title>
        </div>
        {!overCamp && <Link className={styles.camp} href={campHref}>Camp</Link>}
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
          <Section id={resultId}>Result</Section>
          {state.phase === 'safe-return' ? <p>No rewards: a defeat ends the remaining encounters, and the gladiator keeps all gear.</p>
            : !state.complete ? <p className={styles.note}>The result is known when the expedition returns at minute 80.</p>
              : <>
                <p className={styles.verdict}>{state.outcome === 'failure' ? 'Defeated' : 'Success'}</p>
                {!isOwner ? <p className={styles.note}>Another gladiator&apos;s expedition: only its revealed journey is shown.</p>
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
          <Section id={logId}>Activity log</Section>
          <ol className={styles.log} aria-label="Activity log">
            {state.stages.map(stage => <li key={stage.id} aria-current={stage.id === state.current?.id ? 'step' : undefined} className={stage.id === state.current?.id ? styles.current : undefined}>
              <time dateTime={new Date(stage.startedAtMs).toISOString()}>{clockTime(stage.startedAtMs)}</time>
              <span className={styles.logLabel}>{stage.label}</span>
              {stage.inProgress && <span className={styles.badge}>in progress</span>}
              {stage.replay && (overCamp
                ? <button type="button" className={styles.replay} aria-label={`Watch the replay of encounter ${stage.encounter}`} onClick={() => overCamp.onWatch(stage.id)}>Watch replay</button>
                : <Link className={styles.replay} href={replayHref(stage)} aria-label={`Watch the replay of encounter ${stage.encounter}`}>Watch replay</Link>)}
            </li>)}
          </ol>
        </section>
      </div>
    </section>
  );
}
