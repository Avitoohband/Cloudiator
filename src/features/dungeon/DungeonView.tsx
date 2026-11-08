'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ActivitySummary, PartyBattleLog, RevealedStage, RevealedTimeline } from '@contracts/events';
import type { OwnerState, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import { useClockMode } from '../../lib/clock-setting';
import { replayKept } from '../../lib/replay-retention';
import { DUNGEON_FIGHT_INTERVAL_MS, planDungeonTrip, renderDungeonStage, type DungeonFightOrdinal, type DungeonSceneState } from '../../game/dungeon-stage';
import { firstLocked, tripFrame, tripPositionOf, type TripPlan } from '../../game/trip-replay';
import { loadAssetManifest } from '../../game/assets';
import { journeyMap, legPath } from '../../game/expedition-path';
import { pathLength } from '../../game/paths';
import { BotTag } from '../character/BotTag';
import { TripBar } from '../character/TripBar';
import { TripMarks } from '../character/TripMarks';
import { notificationLines } from '../messages/notifications';
import { useLoaded } from '../messages/useLoadedList';
import { dungeonFrom, dungeonOutcome, dungeonTripMarks } from './dungeon-text';
import { PartyFightReplay } from './PartyReplay';
import { partyReplayHref } from './replay-query';
import { DungeonViewport } from './DungeonViewport';
import styles from './DungeonView.module.css';

export type DungeonReads = Pick<GameGateway, 'timeline' | 'dungeonFight'> & Partial<Pick<GameGateway, 'restAfter'>>;
type FightRef = NonNullable<RevealedStage['fight']>;
type Playback = { chapterId: string; offsetMs: number; startedAt: number | null };
const FIRST_CHAPTER: Playback = { chapterId: 'leaving', offsetMs: 0, startedAt: null };
const NO_LOGS: ReadonlyMap<number, PartyBattleLog> = new Map();
const MINUTE = 60_000;

function atPosition(plan: TripPlan, position: number, playing: boolean): Playback {
  const { chapter } = tripFrame(plan, position);
  return { chapterId: chapter.id, offsetMs: position - chapter.startMs, startedAt: playing ? performance.now() : null };
}

function positionOf(plan: TripPlan, playback: Playback, localMs: number) {
  const chapter = plan.chapters.find(item => item.id === playback.chapterId);
  if (!chapter) return 0;
  return chapter.startMs + playback.offsetMs + (playback.startedAt === null ? 0 : Math.max(0, localMs - playback.startedAt));
}

/** Keep a due playback anchor in local monotonic time while the shared revision re-reads the timeline. */
function useDungeonTimeline(reads: DungeonReads, activityId: string, revision: string | null) {
  const loaded = useLoaded(async () => ({ timeline: await reads.timeline(activityId), at: performance.now() }), true);
  const seen = useRef(revision);
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    loaded.reload();
  }, [revision, loaded.reload]);
  return loaded;
}

function useFightLogs(reads: DungeonReads, timeline: RevealedTimeline | null, nowMs: number) {
  const [logs, setLogs] = useState<ReadonlyMap<number, PartyBattleLog>>(NO_LOGS);
  const wanted = timeline?.stages.filter(stage => stage.fight && stage.revealedAtMs <= nowMs && stage.startedAtMs <= nowMs)
    .map(stage => stage.fight!) ?? [];
  const key = wanted.map(fight => `${fight.runId}|${fight.ordinal}`).join(';');
  const request = useRef(wanted);
  useLayoutEffect(() => { request.current = wanted; });
  useEffect(() => {
    let active = true;
    for (const fight of request.current) {
      if (logs.get(fight.ordinal)?.battleId === `${fight.runId}:fight:${fight.ordinal}`) continue;
      reads.dungeonFight(fight.runId, fight.ordinal).then(log => {
        if (active) setLogs(current => new Map(current).set(fight.ordinal, log));
      }, () => {});
    }
    return () => { active = false; };
    // The key changes only when a new due fight is known. A later timeline refresh also retries a transient failure.
  }, [reads, timeline, key]);
  return logs;
}

function Rewards({ summary, name }: { summary: ActivitySummary; name: string }) {
  const { lines } = notificationLines({
    activityId: summary.activityId, kind: 'dungeon', summary, settledAtMs: summary.settledAtMs, destination: null, levelAfter: null,
  });
  return <section className={styles.result} aria-label="Your rewards">
    <h3>{dungeonOutcome(summary, name) ?? 'Dungeon result'}</h3>
    <p className="eyebrow">YOUR REWARDS</p>
    <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
  </section>;
}

export function DungeonUnavailable({ overCamp = false }: { overCamp?: boolean }) {
  const Heading = overCamp ? 'h2' : 'h1';
  return <section className={styles.view}><Heading>Dungeon not available</Heading><p>No revealed dungeon run matches this link.</p></section>;
}

function FightDialog({ fight, reads, title, appearances, onClose }: {
  fight: FightRef; reads: DungeonReads; title: string; appearances: Parameters<typeof PartyFightReplay>[0]['appearances']; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className={styles.closeUp} aria-label="Dungeon fight replay"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <PartyFightReplay gateway={reads} fight={fight} title={title} headingLevel={2} onBack={onClose} backLabel="Back to run" appearances={appearances} />
  </dialog>;
}

function phaseText(state: DungeonSceneState) {
  switch (state.phase) {
    case 'depart': return 'Leaving camp';
    case 'room': return `Fighting in Room ${state.current?.ordinal ?? ''}`.trim();
    case 'major': return 'Fighting the boss';
    case 'safe-return': return 'Safe point · Back at minute 80';
    case 'returning': return 'Heading home';
    case 'arrived': case 'settled': return 'Back in camp';
    case 'exploration': return 'Exploring the dungeon';
    default: return 'Preparing the dungeon';
  }
}

export function DungeonView({ reads, activityId, fixture, startMinute = null, play, onPlay, revision, world, owner, overCamp = false }: {
  reads: DungeonReads; activityId: string; fixture: boolean; startMinute?: number | null;
  play: 'trip' | null; onPlay(play: 'trip' | null): void;
  revision: string | null; world: WorldSnapshot | null; owner: OwnerState | null; overCamp?: boolean;
}) {
  const clock = useClockMode();
  const { value, failed, reload } = useDungeonTimeline(reads, activityId, revision);
  const timeline = useMemo<RevealedTimeline | null>(() => {
    if (!value) return null;
    if (owner || !value.timeline.summary) return value.timeline;
    const { summary: _owner, ...publicTimeline } = value.timeline;
    return publicTimeline;
  }, [value, owner]);
  const [localMs, setLocalMs] = useState(0);
  const [playback, setPlayback] = useState<Playback>(FIRST_CHAPTER);
  const [detail, setDetail] = useState<{ fight: FightRef; title: string } | null>(null);
  const opener = useRef<HTMLAnchorElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const liveButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    const tick = () => setLocalMs(performance.now());
    tick();
    const timer = window.setInterval(tick, play && playback.startedAt !== null ? 40 : 125);
    return () => window.clearInterval(timer);
  }, [play, playback.startedAt]);
  useLayoutEffect(() => {
    if (!detail && restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus({ preventScroll: true });
    }
  }, [detail]);

  const dungeon = timeline ? dungeonFrom(timeline) : null;
  const departure = timeline?.stages.find(stage => stage.kind === 'depart');
  const sampleMs = timeline?.serverNowMs ?? 0;
  const liveMs = fixture && startMinute !== null && departure ? Math.min(sampleMs, departure.startedAtMs + startMinute * MINUTE)
    : fixture ? sampleMs : sampleMs + Math.max(0, localMs - (value?.at ?? localMs));
  const logs = useFightLogs(reads, timeline, liveMs);
  const live = timeline ? renderDungeonStage(timeline, liveMs, logs) : null;
  const completion = timeline?.completion;
  const expiry = timeline?.summary?.replayExpiry ?? completion?.replayExpiry;
  const expired = !!expiry && !replayKept(expiry, liveMs);
  const actor = world?.actors.find(item => item.activityId === activityId);
  const memberId = timeline?.summary && owner ? owner.gladiatorId : actor?.gladiatorId;
  const tripEnd = departure ? departure.startedAtMs + 5 * DUNGEON_FIGHT_INTERVAL_MS : null;
  const current = owner?.currentActivity;
  const knownRest = memberId && owner?.gladiatorId === memberId && current?.kind === 'rest' && current.startsAtMs === tripEnd;
  const [resting, setResting] = useState(false);
  const canReadRest = !!memberId && tripEnd !== null && liveMs >= tripEnd && !knownRest;
  useEffect(() => {
    if (!canReadRest || !memberId || tripEnd === null || !reads.restAfter) return;
    let active = true;
    reads.restAfter(memberId, tripEnd).then(result => { if (active) setResting(result); }, () => {});
    return () => { active = false; };
  }, [canReadRest, memberId, tripEnd, reads]);
  const walkMs = useMemo(() => {
    if (!dungeon) return null;
    const manifest = loadAssetManifest();
    const map = manifest.maps.find(item => item.id === dungeon.map);
    if (!map) return null;
    const journey = journeyMap(map);
    return (from: Parameters<typeof legPath>[1], to: Parameters<typeof legPath>[2]) => {
      const path = legPath(journey, from, to);
      return path ? 1_000 * pathLength(path) / manifest.actors.gladiator.walk.tilesPerSecond : 0;
    };
  }, [dungeon]);
  const plan = timeline && walkMs && !expired ? planDungeonTrip(timeline, { walkMs, resting: !!knownRest || resting, nowMs: liveMs }) : null;
  const running = live?.progress ? liveMs < live.progress.endMs : false;
  const cap = plan ? running ? tripPositionOf(plan, liveMs) : plan.totalMs : 0;
  const position = plan ? Math.min(cap, Math.max(0, positionOf(plan, playback, localMs))) : 0;
  const frame = play && plan ? tripFrame(plan, position) : null;
  const state = timeline && frame ? renderDungeonStage(timeline, frame.displayMs, logs) : live;
  const isPlaying = playback.startedAt !== null && position < cap;
  const allowed = plan ? firstLocked(plan, running ? cap : null) : 0;
  const appearances = useMemo(() => new Map(world?.actors.map(item => [item.gladiatorId, item.appearance])), [world]);

  const setMode = (mode: 'trip' | null) => {
    onPlay(mode);
    requestAnimationFrame(() => (mode ? playButton : liveButton).current?.focus({ preventScroll: true }));
  };
  const chapter = (index: number) => {
    if (!plan || index < 0 || index >= allowed) return;
    const target = plan.chapters[index];
    setPlayback({ chapterId: target.id, offsetMs: 0, startedAt: null });
  };
  const showFight = (event: MouseEvent<HTMLAnchorElement>, fight: FightRef, title: string) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    opener.current = event.currentTarget;
    if (plan) setPlayback(atPosition(plan, position, false));
    setDetail({ fight, title });
  };
  const closeFight = () => { restoreFocus.current = true; setDetail(null); };

  if (!value) return failed ? <section className={styles.view}><p role="alert">Could not load the dungeon.</p><button type="button" onClick={reload}>Try again</button></section>
    : <p role="status">Loading the dungeon…</p>;
  if (!dungeon || !state || !live) return <DungeonUnavailable overCamp={overCamp} />;
  const Heading = overCamp ? 'h2' : 'h1';
  const publicOutcome = completion && completion.settledAtMs <= liveMs ? dungeonOutcome(completion, actor?.name ?? 'A party member') : null;
  const name = owner?.name ?? actor?.name ?? 'A party member';
  const watchTrip = (ordinal?: DungeonFightOrdinal) => {
    const index = ordinal ? plan?.chapters.findIndex(item => item.id === `fight-${ordinal}`) ?? -1 : 0;
    chapter(index);
    setMode('trip');
  };
  const fightRows = state.stages.filter(stage => stage.kind === 'room' || stage.kind === 'major');
  return <section className={styles.view} aria-label={`${dungeon.name} run`}>
    <header className={styles.header}>
      <div><p className="eyebrow">PARTY DUNGEON</p><Heading>{dungeon.name}</Heading></div>
      {running && !play && <span className={styles.live}>● LIVE</span>}
      {play && <span className={styles.live}>TRIP REPLAY</span>}
    </header>
    {expired ? <p className="muted">Detailed replay no longer kept.</p> : <>
      <DungeonViewport dungeon={dungeon} state={state} departure={departure?.label ?? null} world={world}
        vignette={frame?.vignette ?? null} replay={!!play} paused={detail !== null} />
      <p className={styles.phase} data-testid="dungeon-phase">{frame?.chapter.vignette ? frame.chapter.label : phaseText(state)}</p>
      {state.party.length > 0 && <ul className={styles.party} aria-label="Party health">{state.party.map(unit => <li key={unit.unitId}>
        <strong>{unit.name}{unit.role === 'bot' && <BotTag />}{unit.role === 'hireling' && <span className={styles.hired}>Hired</span>}</strong>
        <meter min={0} max={unit.max} value={unit.hp} aria-label={`${unit.name} health`}>{unit.hp} of {unit.max}</meter>
        <span>{unit.hp} / {unit.max}</span>
      </li>)}</ul>}
      {play && plan && frame
        ? <TripBar plan={plan} index={frame.index} positionMs={position} allowed={allowed} catchUp={running} playing={isPlaying} playRef={playButton}
            onToggle={() => setPlayback(atPosition(plan, position >= cap && !running ? 0 : position, !isPlaying))}
            onPrevious={() => chapter(frame.index - 1)} onNext={() => frame.index + 1 < allowed ? chapter(frame.index + 1) : setMode(null)}
            onChapter={chapter} onLive={() => setMode(null)} />
        : live.progress && <div className={styles.progress}>
          <p>Minute {Math.floor(live.progress.minute)} of 80</p>
          <progress max={1} value={live.progress.fraction} aria-label="Dungeon progress" />
          <TripMarks marks={dungeonTripMarks(live, dungeon.major.name, clock)} fraction={live.progress.fraction} onFight={plan ? watchTrip : undefined} dungeon />
          {plan && <button ref={liveButton} type="button" onClick={() => watchTrip()}>Watch the whole trip</button>}
        </div>}
      {fightRows.length > 0 && <ol className={styles.fights} aria-label="Dungeon fights">{fightRows.map(stage => <li key={stage.id}>
        <span>{stage.label}</span>
        {stage.replay && stage.fight && <a href={partyReplayHref(stage.fight, fixture)}
          onClick={event => showFight(event, stage.fight!, stage.ordinal === 4 ? dungeon.major.name : `Room ${stage.ordinal}`)}>
          Watch {stage.ordinal === 4 ? dungeon.major.name : `Room ${stage.ordinal}`}
        </a>}
      </li>)}</ol>}
    </>}
    {state.summary ? <Rewards summary={state.summary} name={name} />
      : publicOutcome && (!frame || frame.displayMs >= (completion?.settledAtMs ?? Infinity)) && <p className={styles.result}>{publicOutcome}</p>}
    {detail && <FightDialog key={`${detail.fight.runId}|${detail.fight.ordinal}`} reads={reads} fight={detail.fight}
      title={detail.title} appearances={appearances} onClose={closeFight} />}
  </section>;
}
