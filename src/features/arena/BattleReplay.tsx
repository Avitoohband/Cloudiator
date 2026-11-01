'use client';

// Battle replay panel: the close-up scene, both fighters' health, the replay bar (Arena replays Task 5: Patch A's bar with a track,
// the time, a remembered speed and ⚑ Result), the result card on the arena at the end, the fighters' revealed snapshots, the result
// and a readable combat log. Everything shown comes from the revealed log; rewards come only from the activity summary. Names render
// as React text. The header says the kind and when the bout was fought, never the server's stage label, which names the outcome
// (plan Review Focus 4): the result shows only at the end, or on ⚑ Result.
import {
  useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type HTMLAttributes, type KeyboardEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { LeagueId } from '@contracts/commands';
import type { ActivitySummary, BattleLog, RevealedCombatant } from '@contracts/events';
import rawManifest from '../../../public/assets/manifest.json';
import {
  REPLAY_SPEEDS, battleEndMs, createReplayController, loadReplayView, nextSpeed, replayBattles, replayLines, type ReplayBattle, type ReplayController,
  type ReplaySpeed, type ReplayView,
} from '../../game/replay';
import { clockText } from '../../game/trip-replay';
import type { DisplayClock } from '../../game/display-clock';
import type { GameGateway } from '../../lib/api/gateway';
import { useClockMode } from '../../lib/clock-setting';
import { replayKept } from '../../lib/replay-retention';
import { readReplaySpeed, saveReplaySpeed } from '../../lib/replay-speed';
import { tournamentRound } from '../../lib/tournament-id';
import { creatureFor, type Creature } from '../../game/battle-stage';
import { createSceneBridge, type SceneBridge } from '../../game/bridge';
import { BattleViewport, BattleViewportWaiting } from '../../game/BattleViewport';
import { loadLooks, lookIdsFor, type LookMap, type LookSource } from '../../game/replay-looks';
import { prefersReducedMotion } from '../../game/webgl';
import { ReplayBar, type BarStep } from '../replay/ReplayBar';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import { RESULT_HINT, againLabel, boutEyebrow, chapterLabel, counterText, nextLabel, rewardChips, upNextText, verdictText } from '../bouts/bout-text';
import { nextQueuePage, nextTarget, previousTarget, queueEntries, type ReplayQueue, type StepTarget } from '../bouts/bout-queue';
import type { BoutList } from '../bouts/bouts-store';
import styles from './BattleReplay.module.css';

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read and drive playback. */
export type ReplayTestHook = {
  state(): {
    battleId: string; positionMs: number; endMs: number; playing: boolean; speed: ReplaySpeed; autoPaused: boolean; reducedMotion: boolean;
    hp: number[]; groupIndex: number; finished: boolean; winnerId: string | null;
    /** The result card shows on the arena (the replay is at its end, after the outro). */
    endCard: boolean;
    /** The shown chapter and how many there are (1 for a single bout). */
    chapter: number; chapters: number;
  };
  /** Bridge plus controller listeners. */
  listeners(): number;
  /** Playback loops running on this page. */
  loops(): number;
  seek(positionMs: number): void;
  pause(): void;
  queue(): { index: number; count: number; more: boolean; next: string | null; previous: string | null } | null;
};
declare global {
  interface Window { __cloudiatorReplay?: ReplayTestHook }
}

/**
 * Where ⏮ and ⏭ (and N, P, the end card's ▶ Next bout) go: a step to the previous chapter or bout (null: ⏮ disabled), the next one
 * with its opponent (null: ⏭ disabled, and the end card shows `back` instead), and a counter ("Bout 1 of 5 in My bouts", Task 6).
 */
export type ReplayNav = {
  previous: (() => void) | null;
  next: { opponent: string | null; upNext: { wide: string; narrow: string } | null; go(): void } | null;
  counter: { wide: string; narrow: string } | null;
  queue?: ReturnType<ReplayTestHook['queue']>;
};
/** An activity's bouts (a tournament run, an expedition's encounters) as chapters on the bar: their names, the shown one, the step. */
export type ReplayChapters = { labels: readonly string[]; current: number; select(index: number): void };
/** The scene's way back, named for where it goes ("My bouts"): the end card offers it at the end of the queue. */
export type ReplayBack = { label: string; go(): void };

const CREATURES = (rawManifest as unknown as { actors: { creatures: Creature[] } }).actors.creatures;
let activeLoops = 0;
/** How far ← and → move the replay. */
const SEEK_STEP_MS = 5000;

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const decimals = (n: number) => `${Math.round(n * 100) / 100}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
/** The viewer's own calendar day, so a date near midnight is never off by one. */
const day = (ms: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(ms);
/** 'sword:1:common' → 'Sword (tier 1, common)'; public layer ids such as 'weapon-sword' → 'Sword'. */
function itemName(id: string): string {
  const [template, tier, kind] = id.split(':');
  const base = capital(template.replace(/^(weapon|offhand|armor|head|feet)-/, '').replace(/-/g, ' '));
  return tier ? `${base} (tier ${tier}${kind ? `, ${kind}` : ''})` : base;
}
function kindOf(p: RevealedCombatant): string {
  if (p.gladiatorId !== null) return p.classId ? capital(p.classId) : 'Gladiator';
  return creatureFor(p, CREATURES) ? 'Creature' : 'NPC opponent';
}

/** Whether the shell's touch layout applies (`COMPACT_QUERY`): the phone's words, the folded details. */
const subscribeCompact = (onChange: () => void) => {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const readCompact = () => window.matchMedia?.(COMPACT_QUERY).matches ?? false;
const useCompact = () => useSyncExternalStore(subscribeCompact, readCompact, () => false);

/** A label that starts with its icon ("↺ Watch again"): the icon is a picture, so the button's name is the words. */
function IconText({ text }: { text: string }) {
  const space = text.indexOf(' ');
  return space < 0 ? <>{text}</> : <><span aria-hidden="true">{text.slice(0, space)}</span>{text.slice(space)}</>;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
/** A heading at `level`; its sections use the next level (at most h6). */
function Heading({ level, ...props }: { level: HeadingLevel } & HTMLAttributes<HTMLHeadingElement>) {
  const Tag = `h${level}` as const;
  return <Tag {...props} />;
}
const below = (level: HeadingLevel) => Math.min(6, level + 1) as HeadingLevel;

/**
 * The display time for a replay view, re-rendered when its next battle ends or its replay expires (and when the clock is
 * held or let go), so a fight in progress is offered once it has ended and the "kept until" note goes at the expiry. Without
 * a clock (a view whose battles are already over) it is 0.
 */
function useReplayTime(clock: DisplayClock | null | undefined, view: ReplayView, list?: BoutList): number {
  const [now, setNow] = useState(() => clock?.now() ?? 0);
  useEffect(() => {
    if (!clock) return;
    let timer: number | undefined;
    const update = () => {
      const t = clock.now();
      setNow(t);
      window.clearTimeout(timer);
      const expiry = view.kind === 'replay' && view.summary?.replayExpiry.state === 'available' ? [view.summary.replayExpiry.expiresAtMs] : [];
      expiry.push(...(list?.rows.flatMap(row => row.replayExpiry.state === 'available' ? [row.replayExpiry.expiresAtMs] : []) ?? []));
      const next = view.kind === 'replay' ? Math.min(...[...view.battles.map(battleEndMs), ...expiry].filter(end => end > t)) : Infinity;
      // A server time moved forward by a later revision read is caught within a minute.
      if (Number.isFinite(next) && clock.frozen() === null) timer = window.setTimeout(update, Math.min(60_000, next - t + 50));
    };
    update();
    const off = clock.subscribe(update);
    return () => { off(); window.clearTimeout(timer); };
  }, [clock, view, list]);
  return now;
}

/**
 * `headingLevel` places the replay's title (default h1, as on the replay page) under an embedding page's headings;
 * its Result, Fighters and Combat log sections take the next level. With the shared display `clock` (the replay page
 * and the scene over the camp, Task 13.8) only the battles that ended by its time are offered, and the summary only once
 * settled (Task 15 review Minor 2): a fight still in progress, a later encounter and its server label stay hidden.
 * `viewerId` is the viewer's own gladiator (null for a visitor): only a fighter in the bout is told its rewards are
 * credited when the activity settles; when it is left out, everyone is (Task 13.8 fix round 1).
 *
 * Arena replays Task 5: `chapters` are the activity's bouts on the bar (the shown one is `current`); `nav` is where ⏮ and ⏭ go
 * (without `nav` and without chapters they are not rendered); `back` is the scene's way back, which the end card offers when there
 * is no next bout; `takeFocus` moves the focus to ⏸ once the replay has loaded, when it is still on the scene's back button or
 * nowhere; `league` is a tournament bracket's (its eyebrow names it, and a bracket's bouts show no rewards).
 */
export function BattleReplay({ view, bridge, headingLevel = 1, clock, viewerId, looks, onRetry, chapters = null, nav = null, back = null, takeFocus = false, league = null, endActions = 'navigation' }: {
  view: ReplayView; bridge?: SceneBridge; headingLevel?: HeadingLevel; clock?: DisplayClock | null; viewerId?: string | null;
  /**
   * Where the fighters' looks come from: the looks the caller already holds (its world actors) and a reader for the rest. The
   * scene waits for them (at most 1.5 s) and draws the legacy look for any it does not get; without a reader that is every
   * fighter the caller does not know. They are settled once per replay, so a look never changes while it plays.
   */
  looks?: LookSource;
  /** Reads the replay again: a replay that could not be loaded offers Try again (Task 23.4). */
  onRetry?: () => void;
  chapters?: ReplayChapters | null;
  nav?: ReplayNav | null;
  back?: ReplayBack | null;
  takeFocus?: boolean;
  league?: LeagueId | null;
  /** Standalone pages keep bar/keyboard chapters, but their end card offers only Again. */
  endActions?: 'again' | 'navigation';
}) {
  const now = useReplayTime(clock, view);
  if (view.kind === 'summary') return <SavedOutcome summary={view.summary} level={headingLevel} />;
  if (view.kind === 'unavailable') return <ReplayUnavailable reason={view.reason} level={headingLevel} onRetry={onRetry} />;
  const battles = clock ? replayBattles(view, now) : view.battles;
  if (!battles.length) return <ReplayUnavailable reason="in-progress" level={headingLevel} />;
  const summary = view.summary && (!clock || view.summary.settledAtMs <= now) ? view.summary : null;
  // A loaded replay keeps playing; only the "kept until" note follows the display time (Task 22.5). Without a clock the view
  // was decided at its read's server time.
  const expiry = summary?.replayExpiry;
  const keptUntil = expiry?.state === 'available' && (!clock || replayKept(expiry, now)) ? expiry.expiresAtMs : null;
  // The chapters' current bout when the caller steps them, else the view's own (a display clock held back by a test can offer
  // fewer battles than were chosen from).
  const selected = Math.max(0, Math.min(chapters ? chapters.current : view.selected, battles.length - 1));
  // The whole view's fighters (every encounter of an expedition), whichever battles are shown yet: read once for the replay.
  return <ReplayBattles battle={battles[selected]} summary={summary} keptUntil={keptUntil} bridge={bridge} level={headingLevel} viewerId={viewerId}
    looks={looks} lookIds={lookIdsFor(...view.battles.map(b => b.log))} chapters={chapters} nav={nav ?? (chapters ? chaptersNav(chapters) : null)}
    back={back} takeFocus={takeFocus} league={league} last={selected === battles.length - 1} endActions={endActions} />;
}

/** A chapters-only nav: ⏮ and ⏭ step through the chapters, and the last one has no next. */
function chaptersNav(chapters: ReplayChapters, opponentOf: (index: number) => string | null = () => null): ReplayNav {
  const { current, labels, select } = chapters;
  return {
    previous: current > 0 ? () => select(current - 1) : null,
    next: current < labels.length - 1 ? { opponent: opponentOf(current + 1), upNext: null, go: () => select(current + 1) } : null,
    counter: null,
  };
}

/** The gladiator who fights every bout of an activity (a run's entrant, the expedition's gladiator), or null. */
function sideOf(battles: readonly ReplayBattle[]): string | null {
  const ids = battles[0]?.log.participants.map(p => p.gladiatorId).filter((id): id is string => id !== null) ?? [];
  return ids.find(id => battles.every(b => b.log.participants.some(p => p.gladiatorId === id))) ?? null;
}
/** The one a bout's own side fights: the other participant (an expedition's creature, a run's opponent). */
const opponentIn = (log: BattleLog, side: string | null) => (log.participants.find(p => p.gladiatorId !== side) ?? log.participants[1]).name;

/**
 * One activity's replay, read once (`loadReplayView`) and shown with `BattleReplay`: the replay page and the replay scene
 * over the camp. It waits for `reads` (a fixture preview's load) and for `clock` (null until the shared clock has a
 * server time, so nothing is filtered by the device's own clock). An activity with several bouts shows them as chapters, and
 * ⏮ ⏭ step through them (Arena replays Task 5); a step never adds a history entry.
 */
export function ActivityReplay({ reads, activityId, stageId = null, clock, headingLevel = 1, viewerId, known, takeFocus = false, back = null, queue = null, onChapter, counterHost = null, endActions = 'navigation' }: {
  /** `looks` (when the gateway has it) reads the fighters' looks the caller does not already hold. */
  reads: (Pick<GameGateway, 'timeline'> & Partial<Pick<GameGateway, 'looks'>>) | null;
  activityId: string;
  stageId?: string | null;
  clock: DisplayClock | null;
  headingLevel?: HeadingLevel;
  /** The viewer's own gladiator, or null for a visitor (`BattleReplay`). */
  viewerId?: string | null;
  /** The looks of the fighters the caller already holds as world actors (`appearancesOf`): they are not read. */
  known?: LookMap | null;
  /** The scene over the camp: ⏸ takes the focus from its back button once the replay has loaded. */
  takeFocus?: boolean;
  /** The scene's way back, which the end card offers at the end (the replay page has none). */
  back?: ReplayBack | null;
  queue?: ReplayQueue | null;
  onChapter?(stageId: string): void;
  /** The compact scene's solid Back row; receives the queue counter as text, with no duplicate state. */
  counterHost?: HTMLElement | null;
  endActions?: 'again' | 'navigation';
}) {
  const [loaded, setLoaded] = useState<{ reads: object; attempt: number; view: ReplayView } | null>(null);
  /** Each Try again reads the replay once more (Task 23.4). */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!reads) return;
    let active = true;
    loadReplayView(reads, activityId).then(view => { if (active) setLoaded({ reads, attempt, view }); });
    return () => { active = false; };
  }, [activityId, reads, attempt]);
  const view = loaded && loaded.reads === reads && loaded.attempt === attempt ? loaded.view : null;
  return view && clock ? <ActivityChapters view={view} headingLevel={headingLevel} clock={clock} viewerId={viewerId} looks={{ known, read: reads?.looks?.bind(reads) ?? null }}
    onRetry={() => setAttempt(n => n + 1)} takeFocus={takeFocus} back={back} queue={queue} activityId={activityId} stageId={stageId} onChapter={onChapter} counterHost={counterHost} endActions={endActions} />
    : <p role="status">Loading the replay…</p>;
}

/** A loaded activity's replay with its bouts as chapters (those ended by the display time), the chosen one shown. */
function ActivityChapters({ view, clock, queue, activityId, stageId, onChapter, counterHost, ...rest }: {
  view: ReplayView; clock: DisplayClock; headingLevel: HeadingLevel; viewerId?: string | null; looks: LookSource; onRetry(): void;
  takeFocus: boolean; back: ReplayBack | null;
  queue: ReplayQueue | null; activityId: string; stageId: string | null; onChapter?: (stageId: string) => void;
  counterHost: HTMLElement | null;
  endActions: 'again' | 'navigation';
}) {
  const now = useReplayTime(clock, view, queue?.list);
  const clockMode = useClockMode();
  const compact = useCompact();
  const battles = replayBattles(view, now);
  // Keep identity while eligibility changes. An explicit local choice overrides the requested stage, even after a clock tick.
  const [chosen, setChosen] = useState<string | null>(null);
  const requested = onChapter ? stageId : chosen ?? stageId;
  const current = Math.max(0, battles.findIndex(b => b.stage.id === requested));
  const mounted = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const latest = useRef({ queue, activityId, current });
  useLayoutEffect(() => { latest.current = { queue, activityId, current }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);
  const select = (index: number) => {
    if (index === current) return;
    generation.current += 1;
    if (onChapter) onChapter(battles[index].stage.id);
    else setChosen(battles[index].stage.id);
  };
  const chapters: ReplayChapters | null = battles.length > 1 ? { labels: battles.map(b => chapterLabel(b.stage)), current, select } : null;
  const side = sideOf(battles);
  // A filter/origin never establishes ownership. Only the owner summary or their current bout does.
  const own = queue !== null && view.kind === 'replay' && (view.summary?.resolvedKind === 'arena' || view.summary?.resolvedKind === 'tournament'
    || activityId === queue.currentActivityId) && battles.some(b => b.stage.kind === 'bout');
  const unsettled = own && view.kind === 'replay' && !view.summary && activityId === queue.currentActivityId;
  const list = queue?.list;
  // Discover a settled bookmark one ordered page at a time. No counter or list targets exist until its real position is known.
  // The store guards each response; every subsequent page also checks the native address before React can commit navigation.
  useEffect(() => {
    if (!own || unsettled || !queue || !list || list.status !== 'ready' || list.loadingMore || list.moreFailed
      || !list.nextCursor || list.rows.some(row => row.activityId === activityId) || queue.isCurrent?.() === false) return;
    void queue.more();
  }, [queue, list, own, unsettled, activityId, stageId]);
  const entries = own ? queueEntries(queue.list, activityId, now, unsettled) : null;
  const next = nextTarget(current, battles.length, entries);
  const previous = previousTarget(current, entries);
  const go = (target: StepTarget) => {
    if (target.kind === 'chapter') { select(target.index); return; }
    if (!queue) return;
    if (target.kind === 'bout') { generation.current += 1; queue.open(target.activityId); return; }
    if (pending.current) return;
    pending.current = true;
    const version = ++generation.current;
    const active = () => mounted.current && generation.current === version && latest.current.queue === queue
      && latest.current.activityId === activityId && latest.current.current === current;
    void nextQueuePage(queue, activityId, () => clock.now(), active).finally(() => { pending.current = false; });
  };
  const nextRow = next?.kind === 'bout' ? entries?.entries.find(row => row.activityId === next.activityId) : null;
  const nextBattle = next?.kind === 'chapter' ? battles[next.index] : null;
  const opponent = nextBattle ? opponentIn(nextBattle.log, side) : nextRow?.opponent?.name ?? null;
  const upcoming = nextBattle ? upNextText({ a: nextBattle.log.participants.find(p => p.gladiatorId === side)?.name ?? nextBattle.log.participants[0].name,
    b: opponent!, chapter: chapterLabel(nextBattle.stage) }, clockMode)
    : nextRow && queue ? upNextText({ a: queue.ownerName, b: opponent, kind: nextRow.kind, foughtAtMs: nextRow.foughtAtMs }, clockMode) : null;
  const nav: ReplayNav | null = entries || chapters ? {
    previous: previous ? () => go(previous) : null,
    next: next ? { opponent, upNext: upcoming, go: () => go(next) } : null,
    counter: entries ? counterText(entries) : null,
    queue: entries ? { index: entries.index, count: entries.entries.length, more: entries.more,
      next: entries.entries[entries.index + 1]?.activityId ?? null, previous: entries.entries[entries.index - 1]?.activityId ?? null } : null,
  } : null;
  return <><BattleReplay view={view} clock={clock} chapters={chapters} nav={nav} {...rest} />
    {compact && counterHost && nav?.counter && createPortal(<span className={styles.counter} data-bout-counter="">{nav.counter.narrow}</span>, counterHost)}</>;
}

function ReplayBattles({ battle, looks, lookIds, ...rest }: {
  battle: ReplayBattle; summary: ActivitySummary | null; keptUntil: number | null; bridge?: SceneBridge; level: HeadingLevel; viewerId?: string | null;
  looks?: LookSource; lookIds: readonly string[]; chapters: ReplayChapters | null; nav: ReplayNav | null; back: ReplayBack | null; takeFocus: boolean;
  league: LeagueId | null; last: boolean; endActions: 'again' | 'navigation';
}) {
  // One look read for the whole replay: choosing another chapter of the same view reuses it and never waits again.
  const settledLooks = useSettledLooks(lookIds, looks);
  return <BattlePlayer key={battle.log.battleId} battle={battle} looks={settledLooks} {...rest} />;
}

/** Re-renders after the controller's discrete changes (group, result, play state, speed, the end). */
function useController(controller: ReplayController) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => controller.subscribe(force), [controller]);
}

/**
 * The fighters' looks for one replay, settled once (`loadLooks`: the caller's known looks plus one batched read for the rest,
 * at most 1.5 s, the legacy look on a failure or a timeout), or null while they are awaited. The scene mounts only when this is
 * a map, so it is built with its final look and never re-skinned mid-play. The ids and the source are the ones the replay first
 * rendered with: a world refresh later never changes a replay already in play. Unmounting drops a late answer.
 */
function useSettledLooks(ids: readonly string[], source: LookSource | undefined): LookMap | null {
  const first = useRef({ ids, source });
  const [looks, setLooks] = useState<LookMap | null>(null);
  useEffect(() => {
    const { ids, source } = first.current;
    const load = loadLooks({ ids, known: source?.known, read: source?.read, onSettled: setLooks });
    return () => load.cancel();
  }, []);
  return looks;
}

/** Whether a key press came from a control that the key operates itself (Space presses a button, a summary toggles). */
const operates = (target: HTMLElement) => target.closest('button, a, summary, input, select, textarea, [contenteditable="true"]') !== null;

function BattlePlayer({ battle, summary, keptUntil, bridge: external, level, viewerId, looks: settledLooks, chapters, nav, back, takeFocus, league, last, endActions }: {
  battle: ReplayBattle; summary: ActivitySummary | null;
  /** When the replay stops being kept, while it still is at the display time (else null: no note). */
  keptUntil: number | null;
  bridge?: SceneBridge; level: HeadingLevel; viewerId?: string | null;
  /** The fighters' looks once settled (`useSettledLooks`); the scene is not mounted before. */
  looks: LookMap | null;
  chapters: ReplayChapters | null; nav: ReplayNav | null; back: ReplayBack | null; takeFocus: boolean; league: LeagueId | null;
  /** The activity's last chapter (a tournament run's rewards show there only). */
  last: boolean;
  endActions: 'again' | 'navigation';
}) {
  const { log, stage } = battle;
  // Rewards to come are promised only to a fighter in the bout (or when the viewer is not known).
  const fighter = viewerId === undefined || (viewerId !== null && log.participants.some(p => p.gladiatorId === viewerId));
  const [bridge] = useState(() => external ?? createSceneBridge());
  // Each replay starts at the speed this device remembers (spec 2).
  const [controller] = useState(() => createReplayController(log, { speed: readReplaySpeed() }));
  useController(controller);
  const compact = useCompact();
  const clockMode = useClockMode();
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [sceneMissing, setSceneMissing] = useState(false);
  const autoPaused = useRef(false);
  const slider = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const logBox = useRef<HTMLOListElement>(null);
  const resultId = useId();
  const tableId = useId();
  const logId = useId();
  const [a, b] = log.participants;
  const { frame, playing, speed, endMs, ended } = controller;
  const lines = replayLines(log).slice(0, frame.appliedEvents);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => bridge.on('scene-unavailable', () => setSceneMissing(true)), [bridge]);

  // The one playback clock: animation frames advance the controller, the track and the time; a hidden tab pauses it.
  useEffect(() => {
    let alive = true;
    let last: number | null = null;
    let request = 0;
    activeLoops += 1;
    const total = clockText(controller.endMs);
    const show = () => {
      const text = `${clockText(controller.positionMs)} / ${total}`;
      if (time.current && time.current.textContent !== text) time.current.textContent = text;
    };
    const step = (now: number) => {
      if (!alive) return;
      // Long gaps (a busy main thread) count as at most a quarter second of viewing.
      if (last !== null) controller.tick(Math.min(250, now - last));
      last = now;
      const input = slider.current;
      if (input && !dragging.current) {
        input.value = String(Math.round(controller.positionMs));
        input.setAttribute('aria-valuetext', `${seconds(Math.min(controller.positionMs, log.durationMs))} of ${seconds(log.durationMs)}`);
      }
      show();
      request = requestAnimationFrame(step);
    };
    show();
    request = requestAnimationFrame(step);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (controller.playing) { autoPaused.current = true; controller.pause(); }
      } else {
        last = null;
        if (autoPaused.current) { autoPaused.current = false; controller.play(); }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    controller.play();
    return () => {
      alive = false;
      cancelAnimationFrame(request);
      activeLoops -= 1;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [controller, log.durationMs]);

  // The scene over the camp: once the replay has loaded, ⏸ takes the focus if it is still on the scene's back button, or nowhere
  // (a chapter's remount drops it), never from a control the viewer has moved to (spec 2, "Opening").
  useEffect(() => {
    if (!takeFocus) return;
    const active = document.activeElement;
    if (active === null || active === document.body || (active instanceof HTMLElement && active.matches('[data-scene-back]'))) {
      playButton.current?.focus({ preventScroll: true });
    }
  }, [takeFocus]);

  // The end card's buttons go with it (↺ Watch again, R, a seek): the focus they held moves to ▶/⏸, never to <body>.
  const wasEnded = useRef(ended);
  useLayoutEffect(() => {
    if (wasEnded.current && !ended && (document.activeElement === null || document.activeElement === document.body)) playButton.current?.focus({ preventScroll: true });
    wasEnded.current = ended;
  }, [ended]);

  const chapterCount = chapters?.labels.length ?? 1;
  const chapterIndex = chapters?.current ?? 0;
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorReplay = {
      state: () => ({
        battleId: log.battleId, positionMs: controller.positionMs, endMs: controller.endMs, playing: controller.playing, speed: controller.speed,
        autoPaused: autoPaused.current, reducedMotion: reduced, hp: [...controller.frame.hp], groupIndex: controller.frame.groupIndex,
        finished: controller.frame.finished, winnerId: controller.frame.result?.winnerId ?? null,
        endCard: controller.ended, chapter: chapterIndex, chapters: chapterCount,
      }),
      listeners: () => bridge.listenerCount() + controller.listenerCount(),
      loops: () => activeLoops,
      seek: ms => controller.seek(ms),
      pause: () => controller.pause(),
      queue: () => nav?.queue ?? null,
    };
    return () => { delete window.__cloudiatorReplay; };
  }, [bridge, controller, log.battleId, reduced, chapterIndex, chapterCount, nav]);

  // Keep the newest log lines in view inside the log box (never scrolls the page).
  useEffect(() => {
    const box = logBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [frame.appliedEvents]);

  const toggle = useCallback(() => { autoPaused.current = false; if (controller.playing) controller.pause(); else controller.play(); }, [controller]);
  // The speed cycles 1× → 2× → 4× and this device remembers it for the next replay (spec 2).
  const cycleSpeed = useCallback(() => { const next = nextSpeed(controller.speed); controller.setSpeed(next); saveReplaySpeed(next); }, [controller]);
  const restart = useCallback(() => { autoPaused.current = false; controller.restart(); }, [controller]);
  const skip = useCallback(() => { autoPaused.current = false; controller.skipToResult(); }, [controller]);
  const seekBy = useCallback((deltaMs: number) => controller.seek(controller.positionMs + deltaMs), [controller]);
  const position = useCallback(() => controller.positionMs, [controller]);
  const previous = nav?.previous ?? null;
  const next = nav?.next ?? null;

  // Keys (spec 2): Space or K play/pause · ← → 5 s · N/P next/previous bout · F speed · R restart · End result. Space acts only when the
  // focus is not on a button, link, summary or form control (there it presses that control); ← and → replace the track's own small
  // steps. A text field is never a shortcut.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const range = target instanceof HTMLInputElement && target.type === 'range';
    if (!range && target.closest('input, select, textarea, [contenteditable="true"]')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === ' ') { if (operates(target)) return; toggle(); }
    else if (key === 'k') toggle();
    else if (key === 'ArrowLeft') seekBy(-SEEK_STEP_MS);
    else if (key === 'ArrowRight') seekBy(SEEK_STEP_MS);
    else if (key === 'f') cycleSpeed();
    else if (key === 'r') restart();
    else if (key === 'End') skip();
    else if (key === 'n' && next) next.go();
    else if (key === 'p' && previous) previous();
    else return;
    event.preventDefault();
  };

  const closeUp = `Close-up of ${a.name} (left) fighting ${b.name} (right). The combat log below describes every action.`;
  const winner = frame.result ? log.participants.find(p => p.id === frame.result!.winnerId) : undefined;
  const loser = frame.result ? log.participants.find(p => p.id === frame.result!.loserId) : undefined;
  const tournament = stage.kind === 'bout' && (tournamentRound(stage.label) !== null || league !== null);
  const npc = stage.kind === 'bout' && log.participants.some(p => p.gladiatorId === null);
  const eyebrow = boutEyebrow(stage, { npc, league, compact }, clockMode);
  // A bracket's bouts show no rewards (spec 2); a run's show on its last chapter.
  const chips = league !== null ? [] : rewardChips(summary, { fighter, npc, kind: stage.kind === 'encounter' ? 'expedition' : tournament ? 'tournament' : 'arena', last });
  const verdict = verdictText(log, compact);
  const step = (name: string, shortcut: string, go: (() => void) | null): BarStep => ({ name, shortcut, disabled: go === null, onClick: () => go?.() });
  const stepping = nav !== null || chapters !== null;

  const fightersBody = <Comparison fighters={log.participants} />;
  const logBody = <>
    {sceneMissing && <p className={styles.note}>The animation is unavailable here; the log follows the fight instead.</p>}
    {lines.length === 0 && <p className={styles.note}>The first blow lands at {seconds(log.events[0]?.elapsedMs ?? 0)}.</p>}
    <ol ref={logBox} className={styles.log} aria-label="Combat log">
      {lines.map(line => <li key={line.sequence} aria-current={line.groupIndex === frame.groupIndex ? 'true' : undefined}
        className={`${styles[line.kind] ?? ''} ${line.groupIndex === frame.groupIndex ? styles.current : ''}`}>{line.text}</li>)}
    </ol>
  </>;
  return (
    <section className={styles.player} aria-labelledby={`${resultId}-title`} onKeyDown={onKeyDown}>
      <header className={styles.header}>
        <p className="eyebrow">{eyebrow}</p>
        <Heading level={level} id={`${resultId}-title`}>{a.name} vs {b.name}</Heading>
        {!compact && nav?.counter && <p className={styles.counter} data-bout-counter="">{nav.counter.wide}</p>}
      </header>
      <div className={styles.arena}>
        {settledLooks
          ? <BattleViewport log={log} looks={settledLooks} position={position} reducedMotion={reduced} bridge={bridge} label={closeUp} />
          : <BattleViewportWaiting label={closeUp} />}
        {/* The result card on the arena: at the end (after the victory poses) or on ⚑ Result; it never moves on by itself (Avi). */}
        {ended && <div className={styles.endCard} data-end-card="">
          {!compact && <p className="eyebrow">RESULT</p>}
          <p className={styles.endVerdict}>{verdict.verdict}</p>
          <p className={styles.endReason}>{verdict.reason}</p>
          {chips.length > 0 && <ul className={styles.chips} aria-label="Rewards">{chips.map(chip => <li key={chip}>{chip}</li>)}</ul>}
          <div className={styles.endActions}>
            <button type="button" onClick={restart}><IconText text={againLabel(compact)} /></button>
            {endActions === 'navigation' && (next ? <button type="button" className={styles.gold} onClick={() => next.go()}><IconText text={nextLabel(next.opponent, compact)} /></button>
              : back ? <button type="button" className={styles.gold} onClick={() => back.go()}><IconText text={`← ${back.label}`} /></button> : null)}
          </div>
        </div>}
      </div>
      <div className={styles.health}>
        {log.participants.map((p, i) => {
          const hp = frame.hp[i];
          return <div key={p.id} className={i === 0 ? styles.left : styles.right}>
            <div className={styles.name}><strong>{p.name}</strong> <span className={styles.kind}>{kindOf(p)}</span></div>
            <div className={styles.meter} role="meter" aria-label={`${p.name} health`} aria-valuemin={0} aria-valuemax={p.maxHealth} aria-valuenow={hp} aria-valuetext={`${hp} of ${p.maxHealth} health`}>
              <span className={styles.fill} style={{ width: `${(100 * hp) / p.maxHealth}%` }} />
              <span className={styles.hpText}>{hp} / {p.maxHealth}</span>
            </div>
          </div>;
        })}
      </div>
      <ReplayBar label="Replay controls"
        play={{ playing, onToggle: toggle, shortcut: 'K Space', buttonRef: playButton }}
        previous={stepping ? step('Previous bout', 'P', previous) : undefined}
        next={stepping ? step('Next bout', 'N', next ? () => next.go() : null) : undefined}
        chapters={chapters ? { items: chapters.labels.map((label, i) => ({ id: `${i}`, label })), current: chapters.current, onSelect: chapters.select } : undefined}
        track={<input ref={slider} className={styles.range} type="range" aria-label="Replay position" min={0} max={endMs} step={100} defaultValue={0}
          onPointerDown={() => { dragging.current = true; }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
          onInput={event => controller.seek(Number(event.currentTarget.value))} />}
        time={<span ref={time} data-replay-time="" />}
        tail={<>
          <button type="button" className={styles.barText} aria-label={`Speed ${REPLAY_SPEEDS[speed]}×`} title="Speed (F)" aria-keyshortcuts="F" onClick={cycleSpeed}>{REPLAY_SPEEDS[speed]}×</button>
          <button type="button" className={styles.barText} aria-label="Skip to the result" title="Skip to the result (End)" aria-keyshortcuts="End" onClick={skip}>
            <span aria-hidden="true">⚑ Result</span>
          </button>
        </>} />

      {next?.upNext && <div className={styles.upNext} data-up-next="">
        <p className="eyebrow">UP NEXT</p>
        <p>{compact ? next.upNext.narrow : next.upNext.wide}</p>
        <button type="button" onClick={() => next.go()}><IconText text="⏭ Next bout" /></button>
      </div>}

      <div className={styles.columns}>
        <section className={styles.card} role="region" aria-labelledby={resultId}>
          <Heading level={below(level)} id={resultId}>Result</Heading>
          {frame.result && winner && loser ? <div aria-live="polite">
            <p className={styles.verdict}>{winner.name} wins</p>
            <p>{frame.result.victoryReason === 'defeat' ? `${loser.name} is defeated.`
              : frame.result.victoryReason === 'health-fraction' ? `Time ran out and ${winner.name} kept the larger share of health.`
                : frame.result.tieBreakReason === 'simultaneous-defeat' ? `Both fighters fell at the same moment, so a seeded tie-break chose ${winner.name}.`
                  : `Time ran out with equal shares of health, so a seeded tie-break chose ${winner.name}.`}</p>
            {league === null && (summary ? <Rewards summary={summary} scope={stage.kind === 'encounter' ? 'Credited for the whole expedition' : 'Credited rewards'} />
              : fighter ? <p className={styles.note}>Rewards are credited when the activity settles.</p> : null)}
          </div> : <p className={styles.note}>{RESULT_HINT}</p>}
          {keptUntil !== null && <p className={styles.note}>This replay is kept until {day(keptUntil)}; the result and rewards stay in your history for 90 days.</p>}
        </section>

        {compact
          // The touch layout folds the details, so who won stays in view without scrolling (spec 2, "Phone layout").
          ? <Fold title="Fighters at the start">{fightersBody}</Fold>
          : <section className={styles.card} aria-labelledby={tableId}>
            <Heading level={below(level)} id={tableId}>Fighters</Heading>
            {fightersBody}
          </section>}

        {compact
          ? <Fold title="Combat log" wide>{logBody}</Fold>
          : <section className={`${styles.card} ${styles.logCard}`} aria-labelledby={logId}>
            <Heading level={below(level)} id={logId}>Combat log</Heading>
            {logBody}
          </section>}
      </div>
    </section>
  );
}

/** A closed section the viewer can open, named by its summary ("▸ Fighters at the start"). */
function Fold({ title, wide = false, children }: { title: string; wide?: boolean; children: ReactNode }) {
  const id = useId();
  return <details className={`${styles.card} ${styles.fold} ${wide ? styles.logCard : ''}`} aria-labelledby={id}>
    <summary id={id}>{title}</summary>
    {children}
  </details>;
}

function Comparison({ fighters }: { fighters: readonly Readonly<RevealedCombatant>[] }) {
  const rows: [string, (p: Readonly<RevealedCombatant>) => string][] = [
    ['Type', kindOf],
    ['Stance', p => capital(p.stance)],
    ['Health at start', p => `${p.initialHealth} / ${p.maxHealth}`],
    ['Weapon damage', p => decimals(p.weaponDamage)],
    ['Armor', p => decimals(p.armor)],
    ['Attack interval', p => seconds(p.attackIntervalMs)],
    ['Efficiency', p => `${p.efficiencyBasisPoints / 100}%`],
    ['Strength', p => decimals(p.attributes.strength)],
    ['Agility', p => decimals(p.attributes.agility)],
    ['Vitality', p => decimals(p.attributes.vitality)],
    ['Endurance', p => decimals(p.attributes.endurance)],
    ['Precision', p => decimals(p.attributes.precision)],
    ['Equipment', p => (p.equipmentSilhouettes.length ? p.equipmentSilhouettes.map(itemName).join(', ') : 'None')],
  ];
  return <table className={styles.table}>
    <caption className={styles.caption}>Fighters at the start of the fight</caption>
    <thead><tr><th scope="col"><span className={styles.hidden}>Detail</span></th>{fighters.map(p => <th key={p.id} scope="col">{p.name}</th>)}</tr></thead>
    <tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th>{fighters.map(p => <td key={p.id}>{value(p)}</td>)}</tr>)}</tbody>
  </table>;
}

function Rewards({ summary, scope }: { summary: ActivitySummary; scope: string }) {
  const r = summary.rewards;
  const parts = [
    r.renown ? `+${r.renown} renown` : null,
    r.money ? `+${r.money} gold` : null,
    r.xp ? `+${r.xp} XP` : null,
    r.attributePoints ? `+${r.attributePoints} attribute points` : null,
    ...r.items.map(item => `${itemName(`${item.catalogId.split(':')[0]}:${item.tier}:${item.rarity}`)} ×${item.quantity}`),
    r.overflowMoney ? `+${r.overflowMoney} gold for items that did not fit` : null,
  ].filter((p): p is string => !!p);
  const rating = summary.ratingDelta === undefined ? null : summary.ratingDelta === 0 ? 'No rating change' : `Rating ${summary.ratingDelta > 0 ? '+' : ''}${summary.ratingDelta}`;
  return <div className={styles.rewards}>
    <p className={styles.note}>{scope}</p>
    <ul>{parts.length ? parts.map((p, i) => <li key={`${i}-${p}`}>{p}</li>) : <li>No rewards</li>}{rating && <li>{rating}</li>}</ul>
  </div>;
}

function SavedOutcome({ summary, level }: { summary: ActivitySummary; level: HeadingLevel }) {
  const id = useId();
  const result = summary.result === 'victory' ? 'Victory' : summary.result === 'defeat' ? 'Defeat' : 'Completed';
  const kind = summary.resolvedKind === 'expedition' ? 'Expedition' : summary.resolvedKind === 'tournament' ? 'Tournament bout' : summary.resolvedKind === 'arena' ? 'Arena bout' : capital(summary.resolvedKind);
  return <section className={`${styles.card} ${styles.saved}`} role="region" aria-labelledby={id}>
    <p className="eyebrow">{kind} · settled {day(summary.settledAtMs)}</p>
    <Heading level={level} id={id}><span className={styles.hidden}>Saved outcome: </span>{result}</Heading>
    <p>The animation for this fight is no longer kept. Detailed replays are kept for seven days; the result and the credited rewards stay in your history for 90 days.</p>
    <Rewards summary={summary} scope="Credited rewards" />
  </section>;
}

/**
 * No replay to play. A guessed, unrevealed or still-running fight is "not available yet", with no summary, never an
 * error (Review Focus 3); an expired one is no longer kept; a missing or malformed link names no fight; a failed read
 * cannot be loaded right now (timelines have had a reader since Task 13.2, so it is no longer "in this build"; final
 * review Minor 6).
 */
function ReplayUnavailable({ reason, level, onRetry }: {
  reason: 'not-revealed' | 'in-progress' | 'not-found' | 'unavailable' | 'expired'; level: HeadingLevel; onRetry?: () => void;
}) {
  const later = reason === 'not-revealed' || reason === 'in-progress';
  return <section className={`${styles.card} ${styles.saved}`}>
    <Heading level={level}>{later ? 'This replay is not available yet' : reason === 'expired' ? 'This replay is no longer kept' : 'This replay is not available'}</Heading>
    <p>{reason === 'not-revealed' ? 'The fight has not been revealed yet. Replays appear once the bout is revealed.'
      : reason === 'in-progress' ? 'The fight is still going on. Its replay appears here as soon as it ends.'
        : reason === 'expired' ? 'Detailed replays are kept for seven days. The result stays in the recent results.'
          : reason === 'not-found' ? 'No fight was found for this link.'
            : 'This replay cannot be loaded right now. Try again shortly.'}</p>
    {reason === 'unavailable' && onRetry && <button type="button" className={styles.retry} onClick={event => { focusStaying(event.currentTarget); onRetry(); }}>Try again</button>}
  </section>;
}

/**
 * Try again replaces itself with "Loading the replay…": first the focus moves to what stays (the scene's Back to camp, or
 * the page's main landmark), so it never falls to <body> (Task 23.5).
 */
function focusStaying(from: HTMLElement) {
  const target = from.closest('dialog')?.querySelector<HTMLElement>('button') ?? from.closest<HTMLElement>('main');
  target?.focus({ preventScroll: true });
}
