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
//
// Task 22.5: replays are kept seven days by the display clock (the server's time). Once cleanup has removed every stage,
// an expedition whose settled summary or public completion says so is "no longer kept": the owner sees its saved outcome
// and credited rewards, a spectator only that its replays are gone, never "not available yet".
//
// Patch A Task 9 (spec "Item 3 + Task 10"): the view has two modes. LIVE follows the server's display clock as before, with a
// "● LIVE · minute 30" badge while the trip runs and named marks under the strip ("Left camp · 12:20 AM", "▶ Fight 1 · won", …).
// The whole-trip replay (`play=trip` in the address, "⏪ Watch from the start", a fight's mark, "▶ Watch the whole trip") plays the
// trip in chapters in about 1¼ minutes (src/game/trip-replay.ts): a replay clock drives the scene and the panels, while the view
// keeps its server display clock for everything else (its reads, its reveal marks and the cap). During a running trip the replay
// never passes now (the cap) and its later chapters are locked; a stage revealed while watching unlocks its chapter and leaves the
// position where it is. The view names and draws the gladiator from the whole timeline as read (the first battle log's
// participant 0), so a replay opened after the trip names it from its first moment (plan Review Focus 1). Whether the next slot was
// a Rest is asked once per activity and gladiator: the owner's own current Rest from the trip's end answers it without a read, and
// any failed read means the replay ends at the gate.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { ActivitySummary, RevealedTimeline } from '@contracts/events';
import type { OwnerState, PublicActor } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import { CATALOG_V1 } from '@domain/catalog-v1';
import {
  EXPEDITION_ENCOUNTERS, EXPEDITION_MS, expeditionRevealMarks, isFinal, renderExpeditionStage, timelineGladiator, type ExpeditionSceneState, type JourneyPoint,
  type VisibleStage,
} from '../../game/expedition-stage';
import { firstLocked, planTrip, tripBoundary, tripFrame, tripPositionOf, type TripChapterId, type TripPlan } from '../../game/trip-replay';
import type { ExpeditionEnvironment, GladiatorLook } from '../../game/expedition-scene';
import { ExpeditionViewport } from '../../game/ExpeditionViewport';
import { createSceneBridge } from '../../game/bridge';
import { lookFor } from '../../game/actors';
import { prefersReducedMotion } from '../../game/webgl';
import { useClockMode, type ClockMode } from '../../lib/clock-setting';
import { slotTimeText } from '../schedule/slot-time';
import { restingGain } from '../schedule/rest-stamina';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import { campBanner, campPhase, tripMarks } from './trip-text';
import { TripBar } from './TripBar';
import { TripMarks } from './TripMarks';
import styles from './ExpeditionView.module.css';

/** The timeline read, and (optionally) whether a trip's next slot was a Rest: without it the replay ends at the gate. */
export type ExpeditionReads = Pick<GameGateway, 'timeline'> & Partial<Pick<GameGateway, 'restAfter'>>;

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read the view and hold its clock. */
export type ExpeditionTestHook = {
  /** What the view shows: at the display clock live, at the replay's display time in the whole-trip replay. */
  state(): {
    activityId: string; phase: ExpeditionSceneState['phase']; displayNowMs: number; minute: number | null; labels: string[]; current: string | null;
    hp: ExpeditionSceneState['hp']; route: ExpeditionSceneState['route']; replays: string[]; complete: boolean;
    outcome: ExpeditionSceneState['outcome']; settled: boolean; owner: boolean; name: string | null; environment: ExpeditionEnvironment | null;
  } | null;
  /** Holds the (server) display clock at a display time (null lets it run on from there). */
  freeze(displayNowMs: number | null): void;
  /** Timeline reads so far, including the first. */
  reads(): number;
  /** Bridge listeners. */
  listeners(): number;
  /** Display clock loops running on this page. */
  loops(): number;
  /**
   * The whole-trip replay (Patch A Task 9), once its plan is known (null before): the mode, whether it is catching up with a
   * running trip, the chapter and position of the replay clock, the cap (the position of now, null for a finished trip) and the
   * chapters that are locked.
   */
  trip(): {
    mode: 'live' | 'trip'; catchUp: boolean; chapter: TripChapterId; index: number; positionMs: number; totalMs: number; capMs: number | null;
    playing: boolean; locked: TripChapterId[];
  } | null;
  /** Moves the replay clock to a position (held to the replay and to the cap), keeping it paused or playing. */
  seek(positionMs: number): void;
};
declare global {
  interface Window { __cloudiatorExpedition?: ExpeditionTestHook }
}

const ENVIRONMENTS: ExpeditionEnvironment[] = ['woodland', 'outpost', 'mountain'];
const TICK_MS = 250;
/** Encounter numbers in words: a health or phase text never repeats a log line's "Encounter N". */
const ORDINALS = ['first', 'second', 'third'];
let activeLoops = 0;

const day = (ms: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(ms);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A stage's start in the activity log, shown as every slot time is (`slotTimeText` against the view's display time; Task
 * 24.0c, after Avi's 2026-10-20 decision for the activity end times): `4:20 AM` or `04:20` as the device's clock setting
 * (`clock`) asks, with the day once the display time is on another local day. A start that cannot be shown (`slotTimeText`
 * gives '') leaves the time out.
 */
export function StageStart({ startedAtMs, nowMs, clock }: { startedAtMs: number; nowMs: number; clock: ClockMode }) {
  const text = slotTimeText(startedAtMs, nowMs, clock);
  return text ? <time dateTime={new Date(startedAtMs).toISOString()}>{text}</time> : null;
}

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
    r.money ? `+${r.money} gold` : null,
    r.xp ? `+${r.xp} XP` : null,
    r.renown ? `+${r.renown} renown` : null,
    r.attributePoints ? `+${r.attributePoints} attribute points` : null,
    ...r.items.map(item => `${itemName(item.catalogId, item.tier, item.rarity)} ×${item.quantity}`),
    r.overflowMoney ? `+${r.overflowMoney} gold for items that did not fit` : null,
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

type WalkMs = (from: JourneyPoint, to: JourneyPoint) => number;

/**
 * How long the gladiator takes to walk each leg of the expedition's map (its path at the actors' walking speed), for the
 * whole-trip plan. The map and the speed come with the art (the scene loads the same module), so `walkMs` is null until they
 * have; `failed` says they never will (the module did not load, or the map has no expedition layout).
 */
function useWalkTimes(environment: ExpeditionEnvironment | null): { walkMs: WalkMs | null; failed: boolean } {
  const [loaded, setLoaded] = useState<{ environment: ExpeditionEnvironment; walkMs: WalkMs | null } | null>(null);
  useEffect(() => {
    if (!environment) return;
    let active = true;
    Promise.all([import('../../game/assets'), import('../../game/expedition-path'), import('../../game/paths')]).then(([assets, path, paths]) => {
      if (!active) return;
      const manifest = assets.loadAssetManifest();
      const map = manifest.maps.find(m => m.id === environment);
      if (!map?.expedition) { setLoaded({ environment, walkMs: null }); return; }
      const journey = path.journeyMap(map);
      const speed = manifest.actors.gladiator.walk.tilesPerSecond;
      setLoaded({ environment, walkMs: (from, to) => { const leg = path.legPath(journey, from, to); return leg ? (paths.pathLength(leg) / speed) * 1000 : 0; } });
    }).catch(() => { if (active) setLoaded({ environment, walkMs: null }); });
    return () => { active = false; };
  }, [environment]);
  const mine = loaded && loaded.environment === environment ? loaded : null;
  return { walkMs: mine?.walkMs ?? null, failed: !!mine && !mine.walkMs };
}

/** The arrival is revealed by `nowMs`: the trip is over. */
const arrived = (timeline: RevealedTimeline, nowMs: number) => timeline.stages.some(stage => stage.revealedAtMs <= nowMs && isFinal(stage));
/** The replay may not pass now in a running trip: the position of the display time now, or null once the trip is over. */
const capOf = (plan: TripPlan, timeline: RevealedTimeline, nowMs: number) => (arrived(timeline, nowMs) ? null : tripPositionOf(plan, nowMs));
const within = (ms: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isFinite(ms) ? ms : low));

const subscribeCompact = (onChange: () => void) => {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const readCompact = () => window.matchMedia?.(COMPACT_QUERY).matches ?? false;

type HeadingLevel = 1 | 2;
const titleTag = (level: HeadingLevel) => (level === 1 ? 'h1' : 'h2');
const sectionTag = (level: HeadingLevel) => (level === 1 ? 'h2' : 'h3');

/**
 * Shown for a missing, malformed or unreadable expedition (nothing is drawn or read further), and for a guessed or
 * unknown one (`not-yet`), which shows no summary at all. A failed read cannot be loaded right now (timelines have had a
 * reader since Task 13.2, so it is no longer "in this build"; final review Minor 6). Over the camp there is no Camp link
 * (the scene has Back to camp) and the title is an h2. `expired` (Task 22.5): cleanup has removed its stages; the owner's
 * settled `summary` still shows its outcome and credited rewards, and a spectator (no summary) is told the result stays in
 * the recent results.
 */
export function ExpeditionUnavailable({ fixture, reason, overCamp = false, summary = null }: {
  fixture: boolean; reason: 'not-found' | 'unavailable' | 'not-yet' | 'expired'; overCamp?: boolean; summary?: ActivitySummary | null;
}) {
  const titleId = useId();
  const Title = titleTag(overCamp ? 2 : 1);
  return <section className={`${styles.card} ${styles.missing}`} aria-labelledby={titleId}>
    <Title id={titleId}>{reason === 'not-yet' ? 'This expedition is not available yet' : reason === 'expired' ? 'This expedition’s replays are no longer kept'
      : 'This expedition is not available'}</Title>
    {reason === 'expired' && summary ? <>
      <strong className={styles.verdict}>{summary.success ? 'Success' : 'Defeated'}</strong>
      {summary.success ? <><p className={styles.note}>Credited rewards</p>
        <ul className={styles.rewards}>{rewardLines(summary).map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}</ul></>
        : <p className={styles.note}>No rewards are credited after a defeat.</p>}
      <p>Detailed replays are kept for seven days; the result and the credited rewards stay in your history for 90 days.</p>
    </> : <p>{reason === 'not-yet' ? 'Nothing has been revealed for it. Only the revealed stages of an expedition are ever shown, as they happen.'
      : reason === 'expired' ? 'Detailed replays are kept for seven days. The result stays in the recent results.'
        : reason === 'not-found' ? 'No expedition matches this link.'
          : 'This expedition cannot be loaded right now. Only revealed stages of an expedition are ever shown.'}</p>}
    {!overCamp && <Link className={styles.camp} href={fixture ? '/game/?mode=fixture' : '/game/'}>Camp</Link>}
  </section>;
}

export function ExpeditionView({ reads, activityId, fixture, startMinute = null, play = null, onPlay, revision, world, worldFailed = false, owner, ownerLoading = false, overCamp }: {
  reads: ExpeditionReads;
  activityId: string;
  /** Fixture preview: links keep mode=fixture. */
  fixture: boolean;
  /** Fixture preview only: open at this minute of the expedition, then run in real time. */
  startMinute?: number | null;
  /**
   * `'trip'`: the address asks for the whole-trip replay (at its first chapter); null: the live view. The view follows a change
   * (the browser's Back and Forward) without remounting, and tells `onPlay` when it changes the mode itself.
   */
  play?: 'trip' | null;
  /** The view switched between live and the whole-trip replay: the address records it (a new history entry). */
  onPlay?(play: 'trip' | null): void;
  /** The shared world revision (`useGameState`): each change re-reads the timeline. */
  revision: string | null;
  /** The shared public world, for names, the look and whose expedition this is; null while it loads. */
  world: { actors: readonly PublicActor[] } | null;
  /** The world could not be read, so no actor is known to be on this activity. */
  worldFailed?: boolean;
  /**
   * The signed-in viewer's own gladiator, or null (a visitor, or an owner still loading). Its stamina and current activity tell the
   * Resting chapter's stamina, the owner's only.
   */
  owner: (Pick<OwnerState, 'gladiatorId' | 'name'> & Partial<Pick<OwnerState, 'appearance' | 'stamina' | 'currentActivity' | 'pendingBuild'>>) | null;
  /** The viewer's own gladiator is still being read: the next-slot Rest is asked only once it is known (its own Rest may answer). */
  ownerLoading?: boolean;
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
  const clockMode = useClockMode();
  const compact = useSyncExternalStore(subscribeCompact, readCompact, () => false);

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

  const state = useMemo(() => (timeline && displayMs !== null ? renderExpeditionStage(timeline, displayMs) : null), [timeline, displayMs]);

  // Identity (plan Review Focus 1): the world's actor on this activity, else the gladiator of the whole timeline as read (on the
  // live server that is known from the first fight's reveal, and the world names the gladiator before it), never the stages the
  // replay clock has revealed. Only the owner's timeline carries a summary; otherwise the owner's id is compared.
  const whole = useMemo(() => (timeline ? timelineGladiator(timeline) : null), [timeline]);
  const byActivity = world?.actors.find(a => a.activityId === activityId) ?? null;
  const gladiatorId = byActivity?.gladiatorId ?? whole?.id ?? null;
  const byId = gladiatorId ? world?.actors.find(a => a.gladiatorId === gladiatorId) ?? null : null;
  const environment = environmentOf(timeline, byActivity);
  const isOwner = !!timeline?.summary || (!!owner && owner.gladiatorId === gladiatorId);
  const name = byActivity?.name ?? byId?.name ?? (isOwner ? owner?.name ?? null : null);
  const silhouettes = (byActivity?.equipmentSilhouettes ?? whole?.equipmentSilhouettes ?? []).join('|');
  // The chosen look, from the same public actor the camp draws (the owner's own read when the world has not named them); a
  // gladiator whose look is not known, or never chosen, is drawn in the legacy look.
  const appearance = byActivity?.appearance ?? byId?.appearance ?? (isOwner ? owner?.appearance : null) ?? null;
  const look = useMemo<GladiatorLook>(() => ({
    key: gladiatorId ?? activityId, name: name ?? 'Gladiator',
    ...lookFor(appearance, gladiatorId ?? activityId, silhouettes ? silhouettes.split('|') : []),
  }), [activityId, appearance, gladiatorId, name, silhouettes]);

  // The next slot: the owner's own current Rest from the trip's end says it was a Rest (and its stamina, the owner's only, while
  // it runs); anyone else's view asks the public results once per activity and gladiator, after the first read of a complete
  // trip. Any failure means no Rest: the replay then ends at the gate, and nothing says an error.
  const departureMs = timeline?.stages.find(stage => stage.kind === 'depart')?.startedAtMs ?? timeline?.stages[0]?.startedAtMs ?? null;
  const tripEndMs = departureMs === null ? null : departureMs + EXPEDITION_MS;
  const ownTrip = !!owner && !!gladiatorId && owner.gladiatorId.toLowerCase() === gladiatorId.toLowerCase();
  const current = owner?.currentActivity ?? null;
  const ownerRest = ownTrip && tripEndMs !== null && current?.kind === 'rest' && current.startsAtMs === tripEndMs ? current : null;
  const restKey = gladiatorId ? `${activityId}|${gladiatorId}` : null;
  const complete = !!state?.complete;
  const [restRead, setRestRead] = useState<{ key: string; resting: boolean } | null>(null);
  const restAsked = useRef<string | null>(null);
  useEffect(() => {
    const ask = reads.restAfter;
    if (!restKey || !gladiatorId || !complete || ownerLoading || ownerRest || tripEndMs === null || !ask || restAsked.current === restKey) return;
    restAsked.current = restKey;
    let answer: Promise<boolean>;
    try { answer = ask(gladiatorId, tripEndMs); } catch { answer = Promise.resolve(false); }
    // A late answer for another activity or gladiator is kept under its own key, so it never decides this one.
    answer.then(resting => setRestRead({ key: restKey, resting: resting === true }), () => setRestRead({ key: restKey, resting: false }));
  }, [complete, gladiatorId, ownerLoading, ownerRest, reads, restKey, tripEndMs]);
  const resting = !!ownerRest || (restRead !== null && restRead.key === restKey && restRead.resting);
  const gain = ownerRest && owner?.stamina ? restingGain({ stamina: owner.stamina, currentActivity: ownerRest, pendingBuild: owner.pendingBuild ?? null }) : null;
  const restEndMs = ownerRest?.endsAtMs ?? (tripEndMs === null ? Number.NaN : tripEndMs + EXPEDITION_MS);

  // The whole-trip plan, rebuilt on each read, when the display clock passes a reveal or a fight's end, and when the Rest is
  // known. It is planned on the timeline cut at that moment (the fixture's reads hold every stage; the planner reads only the
  // revealed ones too), at that moment, so it never says more than the display clock has revealed.
  const { walkMs, failed: walkFailed } = useWalkTimes(environment);
  const boundary = timeline && displayMs !== null ? tripBoundary(timeline, displayMs) : null;
  const plan = useMemo(() => {
    if (!timeline || !walkMs || boundary === null) return null;
    const cut = { ...timeline, stages: timeline.stages.filter(stage => stage.revealedAtMs <= boundary) };
    return planTrip(cut, { walkMs, resting, nowMs: boundary });
  }, [boundary, resting, timeline, walkMs]);
  const planRef = useRef(plan);
  useEffect(() => { planRef.current = plan; }, [plan]);

  // The replay clock: a position (ms into the replay) that runs on in real time while playing. It is read every frame by the
  // scene, and held to the replay and, in a running trip, to now.
  const [mode, setMode] = useState<'live' | 'trip'>(play === 'trip' ? 'trip' : 'live');
  const modeRef = useRef(mode);
  const replay = useRef<{ baseMs: number; at: number; playing: boolean; pending: TripChapterId | null }>(
    { baseMs: 0, at: 0, playing: false, pending: play === 'trip' ? 'leaving' : null });
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const focusNext = useRef<'play' | 'live' | null>(play === 'trip' ? 'play' : null);
  const playRef = useRef<HTMLButtonElement>(null);
  const watchRef = useRef<HTMLButtonElement>(null);
  const onPlayRef = useRef(onPlay);
  useEffect(() => { onPlayRef.current = onPlay; }, [onPlay]);

  /** The furthest the replay may go: now in a running trip, else its end. */
  const limitOf = useCallback((p: TripPlan) => {
    const t = timelineRef.current;
    const cap = t && clock.current ? capOf(p, t, now()) : null;
    return cap ?? p.totalMs;
  }, [now]);
  const position = useCallback(() => {
    const p = planRef.current;
    if (!p) return 0;
    const r = replay.current;
    return within(r.playing ? r.baseMs + (performance.now() - r.at) : r.baseMs, 0, limitOf(p));
  }, [limitOf]);
  /** Holds the replay clock at `ms` (within the replay and the cap), paused unless `keepPlaying` and it was playing. */
  const hold = useCallback((ms: number, keepPlaying = false) => {
    const p = planRef.current;
    const at = p ? within(ms, 0, limitOf(p)) : 0;
    const still = keepPlaying && replay.current.playing;
    replay.current = { ...replay.current, baseMs: at, at: performance.now(), playing: still };
    setPositionMs(at);
    setPlaying(still);
  }, [limitOf]);
  const toLive = useCallback((record: boolean) => {
    replay.current = { ...replay.current, baseMs: position(), playing: false, pending: null };
    setPlaying(false);
    modeRef.current = 'live';
    setMode('live');
    focusNext.current = 'live';
    if (record) onPlayRef.current?.(null);
  }, [position]);
  const toTrip = useCallback((chapter: TripChapterId, record: boolean) => {
    replay.current = { ...replay.current, playing: false, pending: chapter };
    const p = planRef.current;
    if (p) {
      const start = p.chapters.find(c => c.id === chapter)?.startMs ?? 0;
      replay.current = { ...replay.current, pending: null };
      hold(start);
    }
    setPlaying(false);
    modeRef.current = 'trip';
    setMode('trip');
    focusNext.current = 'play';
    if (record) onPlayRef.current?.('trip');
  }, [hold]);

  // The address changed the mode (the browser's Back or Forward): follow it, without recording it again.
  useEffect(() => {
    const wanted = play === 'trip' ? 'trip' : 'live';
    if (wanted === modeRef.current) return;
    if (wanted === 'trip') toTrip('leaving', false); else toLive(false);
  }, [play, toLive, toTrip]);

  // A chapter asked for before the plan was known starts once it is.
  useEffect(() => {
    const pending = replay.current.pending;
    if (!plan || !pending) return;
    replay.current = { ...replay.current, pending: null };
    hold(plan.chapters.find(c => c.id === pending)?.startMs ?? 0);
  }, [hold, plan]);

  // The replay starts paused with ▶ focused, once its bar is there (dropped if the replay turns out not to be possible). Back to
  // live gives the focus to the live view's own button, once the live view is rendered, and only when the switch took it away (it
  // was in the bar, which is gone, so it is on <body>): a focus the player put elsewhere (the log) stays there, and a target that
  // is not rendered is dropped.
  useEffect(() => {
    const want = focusNext.current;
    if (want === 'play') {
      if (tripRuledOut) focusNext.current = null;
      else if (tripMode && playRef.current) { focusNext.current = null; playRef.current.focus({ preventScroll: true }); }
      return;
    }
    if (want !== 'live' || mode !== 'live') return;
    focusNext.current = null;
    const active = document.activeElement;
    if (watchRef.current && (!active || active === document.body)) watchRef.current.focus({ preventScroll: true });
  });

  // A hidden tab pauses the replay.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== 'hidden' || !replay.current.playing) return;
      replay.current = { ...replay.current, baseMs: position(), playing: false };
      setPlaying(false);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [position]);

  // The display clock: React re-renders a few times a second; the scene reads the clock every frame. A
  // hidden tab does nothing; on return the clock shows the current time directly. A replay that plays up to its end stops
  // there; one that plays up to now in a running trip goes back to live.
  useEffect(() => {
    activeLoops += 1;
    const tick = () => {
      if (document.visibilityState !== 'visible' || !timelineRef.current || !clock.current) return;
      const t = now();
      setDisplayMs(t);
      if (passedRevealMark(marks.current, renderExpeditionStage(timelineRef.current, t))) void read();
      const p = planRef.current;
      if (modeRef.current !== 'trip' || !p) return;
      const at = position();
      if (replay.current.playing && at >= limitOf(p)) {
        if (capOf(p, timelineRef.current, t) !== null) { toLive(true); return; }
        replay.current = { ...replay.current, baseMs: at, playing: false };
        setPlaying(false);
      }
      setPositionMs(at);
    };
    const timer = window.setInterval(tick, TICK_MS);
    return () => { window.clearInterval(timer); activeLoops -= 1; };
  }, [limitOf, now, position, read, toLive]);

  // What the scene and the panels show: the display clock live, the replay clock's display time in the whole-trip replay. The
  // whole-trip replay is shown while the trip's replays are kept (an expired one is the live view's "no longer kept") and while it
  // can be planned: without the walking times (their module failed to load) or a departure there is no plan, and the view is live.
  // Until its plan is there (the walking times load with the art), the replay shows the departure, never the trip's end (fix
  // round 1: the result, the later log and the arrival were shown for a moment, a spoiler).
  const plannable = !!environment && !walkFailed && !(walkMs && timeline && boundary !== null && !plan);
  const tripMode = mode === 'trip' && !(state?.replayExpired ?? false) && plannable;
  /** Once the timeline is read, whether this trip can have no replay here (its replays are gone, or it cannot be planned). */
  const tripRuledOut = !!state && (state.replayExpired || !plannable);
  const capMs = plan && timeline && displayMs !== null ? capOf(plan, timeline, displayMs) : null;
  const frame = tripMode && plan ? tripFrame(plan, within(positionMs, 0, capMs ?? plan.totalMs)) : null;
  const shownMs = frame ? frame.displayMs : tripMode ? departureMs : null;
  const shown = useMemo(() => (shownMs !== null && timeline ? renderExpeditionStage(timeline, shownMs) : state), [shownMs, state, timeline]);
  /** The display time the scene draws (and the test hook reports): the replay's, the departure's while it is prepared, or now. */
  const drawn = useRef<{ trip: boolean; departureMs: number | null }>({ trip: false, departureMs: null });
  useEffect(() => { drawn.current = { trip: tripMode, departureMs }; }, [departureMs, tripMode]);
  const drawnMs = useCallback(() => {
    const p = planRef.current, d = drawn.current;
    return d.trip ? (p ? tripFrame(p, position()).displayMs : d.departureMs ?? now()) : now();
  }, [now, position]);
  const sceneState = useCallback(() => {
    const t = timelineRef.current;
    return t && clock.current ? renderExpeditionStage(t, drawnMs()) : null;
  }, [drawnMs]);

  // Moves the replay a chapter on or back (it stops playing): past the last chapter a running trip may show, back to live.
  const step = useCallback((by: -1 | 1) => {
    const p = planRef.current, t = timelineRef.current;
    if (!p || !t) return;
    const index = tripFrame(p, position()).index + by;
    const cap = capOf(p, t, now());
    if (index < 0) return;
    if (index >= firstLocked(p, cap)) { if (cap !== null && by > 0) toLive(true); return; }
    hold(p.chapters[index].startMs);
  }, [hold, now, position, toLive]);
  const choose = useCallback((index: number) => {
    const p = planRef.current, t = timelineRef.current;
    if (!p || !t || index >= firstLocked(p, capOf(p, t, now()))) return;
    hold(p.chapters[index].startMs);
  }, [hold, now]);
  const toggle = useCallback(() => {
    const p = planRef.current, t = timelineRef.current;
    if (!p || !t) return;
    if (replay.current.playing) { hold(position()); return; }
    const at = position();
    if (at >= limitOf(p)) {
      // At now in a running trip, ▶ is live; at the end of a finished one, it plays the trip again.
      if (capOf(p, t, now()) !== null) { toLive(true); return; }
      hold(0);
    }
    replay.current = { ...replay.current, at: performance.now(), playing: true };
    setPlaying(true);
  }, [hold, limitOf, now, position, toLive]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorExpedition = {
      state: () => {
        const t = timelineRef.current;
        if (!t || !clock.current) return null;
        const s = renderExpeditionStage(t, drawnMs());
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
      trip: () => {
        const p = planRef.current, t = timelineRef.current;
        if (!p || !t || !clock.current) return null;
        const cap = capOf(p, t, now());
        const at = position();
        const f = tripFrame(p, at);
        return {
          mode: modeRef.current, catchUp: modeRef.current === 'trip' && cap !== null, chapter: f.chapter.id, index: f.index, positionMs: at,
          totalMs: p.totalMs, capMs: cap, playing: replay.current.playing, locked: p.chapters.slice(firstLocked(p, cap)).map(c => c.id),
        };
      },
      seek: ms => hold(ms, true),
    };
    return () => { delete window.__cloudiatorExpedition; };
  }, [bridge, count, drawnMs, environment, hold, name, now, isOwner, position]);

  if (failure) return <ExpeditionUnavailable fixture={fixture} reason={failure} overCamp={!!overCamp} />;
  if (!timeline || !state || !shown) return <p role="status">Loading the expedition…</p>;
  // Cleanup has removed every stage of an expedition whose replays are no longer kept (Task 22.5): its saved outcome only.
  if (!state.stages.length && state.replayExpired) return <ExpeditionUnavailable fixture={fixture} reason="expired" summary={state.summary} overCamp={!!overCamp} />;
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
  const vignette = frame?.vignette ?? null;
  const ownerMaximum = gain ? gain.maximum : null;
  const text = vignette
    ? campPhase(vignette.kind, expedition, state.outcome, vignette.kind === 'resting' && gain && gain.before < gain.maximum ? gain.maximum - gain.before : null)
    : phaseText(shown, expedition);
  const banner = vignette ? campBanner(vignette.kind, restEndMs, state.displayNowMs, clockMode, vignette.kind === 'resting' ? ownerMaximum : null, compact) : null;
  const health = healthText(shown);
  const progress = state.progress;
  const minute = Math.floor(progress?.minute ?? 0);
  const replayHref = (stage: VisibleStage) => `/replay/?${fixture ? 'mode=fixture&' : ''}activity=${encodeURIComponent(activityId)}&stage=${encodeURIComponent(stage.id)}`;
  const summary = state.summary;
  const encounters = shown.stages.some(s => s.encounter !== null);
  const who = name ?? (isOwner ? 'Your gladiator' : gladiatorId ? "Another gladiator's journey" : null);
  // The whole trip is offered while its replays are kept; a running trip shows LIVE (from its departure until its arrival).
  const offerTrip = !!plan && !state.replayExpired;
  const running = !!progress && !state.complete;
  const allowed = plan ? firstLocked(plan, capMs) : 0;
  // The Result card of the replay shows the result from "Back in camp" on (the settlement comes after it), as the live view has it.
  const backIndex = plan ? plan.chapters.findIndex(c => c.id === 'back') : -1;
  const resultShown = !tripMode || (!!frame && backIndex >= 0 && frame.index >= backIndex);
  return (
    <section className={styles.view} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <p className="eyebrow">{who ? `EXPEDITION · ${who}` : 'EXPEDITION'}</p>
          <Title id={titleId}>{expedition}</Title>
        </div>
        <div className={styles.modes}>
          {tripMode ? <span className={styles.replayBadge} data-testid="replay-badge">{compact ? '▶ REPLAY' : '▶ REPLAY · THE WHOLE TRIP'}</span>
            : running ? <>
              <span className={styles.liveBadge} data-testid="live-badge"><i aria-hidden="true" />{compact ? 'LIVE' : `LIVE · minute ${minute}`}</span>
              {offerTrip && <button ref={watchRef} type="button" className={styles.rewind} aria-label="Watch from the start" title="Watch from the start"
                onClick={() => toTrip('leaving', true)}><span aria-hidden="true">⏪</span>{compact ? null : <span> Watch from the start</span>}</button>}
            </> : offerTrip ? <button ref={watchRef} type="button" className={styles.wholeTrip} onClick={() => toTrip('leaving', true)}>
              <span aria-hidden="true">▶ </span>Watch the whole trip</button> : null}
        </div>
        {!overCamp && <Link className={styles.camp} href={campHref}>Camp</Link>}
      </header>

      {environment ? <ExpeditionViewport environment={environment} state={sceneState} look={look} bridge={bridge} reducedMotion={reduced} banner={banner} wander={!frame}
        label={`Isometric view of the ${expedition}. The gladiator travels automatically; drag or use the arrow keys to look around, plus and minus to zoom, F to follow.`} />
        : <div className={styles.placeholder}>The scene appears once the departure is revealed.</div>}

      <div className={styles.now}>
        <div className={styles.phase} role="status" aria-live="polite" aria-label="Current stage">
          <strong>{text.title}</strong>
          <span>{text.detail}</span>
        </div>
        <div className={styles.health}>
          <span className={styles.label}>{health.label}</span>
          {shown.hp ? <div className={styles.meter} role="meter" aria-label="Gladiator health" aria-valuemin={0} aria-valuemax={shown.hp.max} aria-valuenow={shown.hp.current}
            aria-valuetext={`${shown.hp.current} of ${shown.hp.max} ${health.label.toLowerCase()}`}>
            <span className={styles.fill} style={{ width: `${(100 * shown.hp.current) / shown.hp.max}%` }} />
            <span className={styles.hpText}>{shown.hp.current} / {shown.hp.max}</span>
          </div> : <span className={styles.note}>{encounters ? 'Not kept for this expedition' : 'Full at departure'}</span>}
          {health.recovers && <span className={styles.recovers}>Some health recovers before the next encounter.</span>}
        </div>
      </div>

      {frame && plan ? <TripBar plan={plan} index={frame.index} positionMs={within(positionMs, 0, capMs ?? plan.totalMs)} allowed={allowed} catchUp={capMs !== null}
        playing={playing} playRef={playRef} onToggle={toggle} onPrevious={() => step(-1)} onNext={() => step(1)} onChapter={choose} onLive={() => toLive(true)} />
        : tripMode ? <p className={styles.note} role="status">Preparing the whole trip…</p>
        : <div className={styles.strip}>
          <div className={styles.track} role="meter" aria-label="Expedition progress" aria-valuemin={0} aria-valuemax={EXPEDITION_MS / 60_000} aria-valuenow={minute}
            aria-valuetext={`Minute ${minute} of ${EXPEDITION_MS / 60_000}`}>
            <span className={styles.trackFill} style={{ width: `${100 * (progress?.fraction ?? 0)}%` }} />
            <span className={styles.position} style={{ left: `${100 * (progress?.fraction ?? 0)}%` }} />
          </div>
          {progress && <TripMarks marks={tripMarks(state, progress.startMs, clockMode)} fraction={progress.fraction}
            onFight={fight => (state.replayExpired ? undefined : toTrip(`fight-${fight}`, true))} />}
        </div>}

      <div className={styles.columns}>
        <section className={styles.card} role="region" aria-labelledby={resultId}>
          <Section id={resultId}>Result</Section>
          {!resultShown ? (shown.phase === 'safe-return' ? <p>No rewards: a defeat ends the remaining encounters, and the gladiator keeps all gear.</p>
            : <p className={styles.note}>The result is known when the expedition returns at minute 80.</p>)
            : state.phase === 'safe-return' ? <p>No rewards: a defeat ends the remaining encounters, and the gladiator keeps all gear.</p>
              : !state.complete ? <p className={styles.note}>The result is known when the expedition returns at minute 80.</p>
                : <>
                  <p className={styles.verdict}>{state.outcome === 'failure' ? 'Defeated' : 'Success'}</p>
                  {!isOwner ? <>
                    <p className={styles.note}>Another gladiator&apos;s expedition: only its revealed journey is shown.</p>
                    {state.replayExpired && <p className={styles.note}>Encounter replays are no longer kept; the result stays in the recent results.</p>}
                  </> : summary ? <>
                      {summary.success ? <><p className={styles.note}>Credited rewards</p>
                        <ul className={styles.rewards}>{rewardLines(summary).map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}</ul></>
                        : <p className={styles.note}>No rewards are credited after a defeat.</p>}
                      <p className={styles.note}>{summary.replayExpiry.state === 'available' && !state.replayExpired
                        ? `Encounter replays are kept until ${day(summary.replayExpiry.expiresAtMs)}; the result stays in your history for 90 days.`
                        : 'Encounter replays are no longer kept; the result stays in your history for 90 days.'}</p>
                    </> : state.awaitingSummary ? <p role="status">Processing results…</p> : null}
                </>}
        </section>

        <section className={styles.card} aria-labelledby={logId}>
          <Section id={logId}>Activity log</Section>
          <ol className={styles.log} aria-label="Activity log">
            {shown.stages.map(stage => <li key={stage.id} aria-current={stage.id === shown.current?.id ? 'step' : undefined} className={stage.id === shown.current?.id ? styles.current : undefined}>
              <StageStart startedAtMs={stage.startedAtMs} nowMs={shown.displayNowMs} clock={clockMode} />
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
