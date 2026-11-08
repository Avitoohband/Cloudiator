import type { ActivitySummary, PartyBattleLog, PartyRole, RevealedStage, RevealedTimeline } from '@contracts/events';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V2 } from '@domain/rules-v2';
import { replayKept } from '../lib/replay-retention';
import { EXPEDITION_APPROACH_MS, JOURNEY, isFinal, type JourneyPoint, type RouteProgress, type StageWalk } from './expedition-stage';
import { reducePartyReplay } from './party-replay';
import { REPLAY_OUTRO_MS } from './replay';
import { TRIP_PACE, type TripChapter, type TripChapterId, type TripPiece, type TripPlan, type TripPlanOptions } from './trip-replay';

export const DUNGEON_JOURNEY = JOURNEY;
export const DUNGEON_FIGHT_INTERVAL_MS = RULES_V2.dungeon.fightIntervalMs;
const SLOT_MS = RULES_V2.clock.slotMs;
const ORDINALS = [1, 2, 3, 4] as const;
const FIGHT_POINTS = ['start', 'encounter-1', 'encounter-2', 'encounter-3', 'search-4'] as const;
const SEARCH_POINTS = ['search-1', 'search-2', 'search-3'] as const;

type FightRef = NonNullable<RevealedStage['fight']>;
type FightOutcome = 'victory' | 'defeat';
export type DungeonFightOrdinal = FightRef['ordinal'];
export type DungeonVisibleStage = {
  readonly id: string;
  readonly kind: RevealedStage['kind'];
  readonly label: string;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  readonly ordinal: DungeonFightOrdinal | null;
  readonly inProgress: boolean;
  readonly outcome: FightOutcome | null;
  readonly replay: boolean;
  readonly final: boolean;
  readonly fight: FightRef | null;
};

export type DungeonSceneState = {
  readonly activityId: string;
  readonly displayNowMs: number;
  readonly phase: 'depart' | 'exploration' | 'room' | 'major' | 'safe-return' | 'returning' | 'arrived' | 'preparing' | 'settled';
  readonly stages: readonly DungeonVisibleStage[];
  readonly current: DungeonVisibleStage | null;
  readonly progress: { readonly startMs: number; readonly endMs: number; readonly fraction: number; readonly minute: number } | null;
  readonly route: RouteProgress | null;
  readonly fight: { readonly ordinal: DungeonFightOrdinal; readonly log: PartyBattleLog; readonly elapsedMs: number; readonly finished: boolean } | null;
  readonly party: readonly { readonly unitId: string; readonly name: string; readonly role: PartyRole; readonly hp: number; readonly max: number }[];
  readonly summary: ActivitySummary | null;
};

const isFight = (stage: RevealedStage) => stage.kind === 'room' || stage.kind === 'major';
const ordinalOf = (stage: RevealedStage): DungeonFightOrdinal | null =>
  stage.kind === 'major' ? 4 : stage.kind === 'room' ? stage.fight?.ordinal ?? null : null;
const outroEnd = (stage: RevealedStage) => stage.endsAtMs + REPLAY_OUTRO_MS;
const dueStages = (timeline: RevealedTimeline, nowMs: number) =>
  timeline.stages.filter(stage => stage.revealedAtMs <= nowMs && stage.startedAtMs <= nowMs);

function publishedOutcome(stage: RevealedStage, next: RevealedStage | undefined): FightOutcome | null {
  const outcome = /: (victory|defeat)$/.exec(stage.label)?.[1];
  if (outcome === 'victory' || outcome === 'defeat') return outcome;
  if (next?.kind === 'exploration' || next?.kind === 'travel') return 'victory';
  if (next?.kind === 'return' && !isFinal(next)) return 'defeat';
  return null;
}

type Movement = StageWalk & { then: 'search' | 'wait' | 'rest'; untilMs?: number };

/** The view follows the same legs that the whole-trip planner plays at walking speed. */
function movementLegs(stage: RevealedStage, last: RevealedStage | undefined, safe: boolean): Movement[] {
  const previous = last ? ordinalOf(last) ?? 0 : 0;
  const from = FIGHT_POINTS[previous];
  const atMs = last ? outroEnd(last) : stage.startedAtMs;
  if (safe) return [{ from, to: 'safe', atMs, then: 'rest' }];
  if (previous === 4) return [{ from, to: 'end', atMs, then: 'wait' }];
  if (previous === 3) return [{ from, to: 'search-4', atMs, then: 'wait' }];
  const spot = SEARCH_POINTS[previous];
  const approach = Math.max(atMs, stage.endsAtMs - EXPEDITION_APPROACH_MS);
  return [
    { from, to: spot, atMs, then: 'search', untilMs: approach - atMs },
    { from: spot, to: FIGHT_POINTS[previous + 1], atMs: approach, then: 'wait' },
  ];
}

function routeAt(stage: RevealedStage, last: RevealedStage | undefined, safe: boolean, nowMs: number): RouteProgress | null {
  const go = (from: JourneyPoint, to: JourneyPoint, atMs: number, then: RouteProgress['then']): RouteProgress => ({
    segment: from === 'safe' ? 0 : DUNGEON_JOURNEY.indexOf(from), from, to, walkedMs: Math.max(0, nowMs - atMs), then,
  });
  const from = FIGHT_POINTS[last ? ordinalOf(last) ?? 0 : 0];
  if (isFinal(stage)) {
    if (!safe) return go('end', 'end', stage.startedAtMs, 'leave');
    return { ...go('safe', 'safe', stage.startedAtMs, 'leave'), rest: go(from, 'safe', last ? outroEnd(last) : stage.startedAtMs, 'rest') };
  }
  if (last && (nowMs < outroEnd(last) || (last === stage && !safe))) {
    return go(from, from, last.startedAtMs, 'fight');
  }
  const leg = movementLegs(stage, last, safe).filter(walk => walk.atMs <= nowMs).at(-1);
  return leg ? { ...go(leg.from, leg.to, leg.atMs, leg.then), ...(leg.untilMs === undefined ? {} : { untilMs: leg.untilMs }) } : null;
}

/** A frame uses only stages that are due and logs that belong to those stages. */
export function renderDungeonStage(timeline: RevealedTimeline, displayNowMs: number, logs: ReadonlyMap<number, PartyBattleLog>): DungeonSceneState {
  const revealed = dueStages(timeline, displayNowMs);
  const summary = timeline.summary && timeline.summary.settledAtMs <= displayNowMs ? timeline.summary : null;
  const completion = timeline.completion && timeline.completion.settledAtMs <= displayNowMs ? timeline.completion : null;
  const expiry = summary?.replayExpiry ?? completion?.replayExpiry;
  const replayAvailable = !expiry || replayKept(expiry, displayNowMs);
  const party = new Map<string, DungeonSceneState['party'][number]>();
  let fight: DungeonSceneState['fight'] = null;
  let latest: RevealedStage | undefined;
  let safe = false;
  const stages = revealed.map((stage, index): DungeonVisibleStage => {
    const ordinal = ordinalOf(stage);
    const ref = isFight(stage) ? stage.fight ?? null : null;
    const inProgress = isFight(stage) && displayNowMs < stage.endsAtMs;
    const final = isFinal(stage);
    let outcome: FightOutcome | null = null;
    if (isFight(stage)) {
      latest = stage;
      fight = null;
      const candidate = ref ? logs.get(ref.ordinal) : undefined;
      const log = ref && candidate?.battleId === `${ref.runId}:fight:${ref.ordinal}` ? candidate : undefined;
      if (!inProgress) outcome = log ? (log.winnerSide === 0 ? 'victory' : 'defeat') : publishedOutcome(stage, revealed[index + 1]);
      if (log && ordinal !== null) {
        const elapsedMs = displayNowMs - stage.startedAtMs;
        const finished = !inProgress;
        const hp = finished ? log.finalHp : reducePartyReplay(log, elapsedMs).hp;
        fight = { ordinal, log, elapsedMs, finished };
        log.participants.forEach((unit, i) => {
          if (unit.side === 0) party.set(unit.id, { unitId: unit.id, name: unit.name, role: unit.role, hp: hp[i], max: unit.maxHealth });
        });
      }
      if (outcome === 'defeat') safe = true;
    }
    if (stage.kind === 'return' && !final) safe = true;
    return {
      id: stage.id, kind: stage.kind, startedAtMs: stage.startedAtMs, endsAtMs: stage.endsAtMs,
      label: inProgress ? (stage.kind === 'major' ? 'Major' : ordinal === null ? 'Room' : `Room ${ordinal}`) : stage.label,
      ordinal, inProgress, outcome, final, fight: ref, replay: !!ref && !inProgress && replayAvailable,
    };
  });

  const current = stages.at(-1) ?? null;
  const currentStage = revealed.at(-1);
  let phase: DungeonSceneState['phase'] = 'preparing';
  if (summary || completion) phase = 'settled';
  else if (current?.final) phase = 'arrived';
  else if (safe && currentStage) phase = 'safe-return';
  else if (current && displayNowMs < current.endsAtMs) {
    if (current.kind === 'travel') phase = 'returning';
    if (current.kind === 'depart' || current.kind === 'exploration' || current.kind === 'room' || current.kind === 'major') phase = current.kind;
  }

  const departure = revealed.find(stage => stage.kind === 'depart');
  const startMs = departure?.startedAtMs ?? 0;
  const elapsed = Math.min(SLOT_MS, Math.max(0, displayNowMs - startMs));
  return {
    activityId: timeline.activityId, displayNowMs, phase, stages, current,
    progress: departure ? { startMs, endMs: startMs + SLOT_MS, fraction: elapsed / SLOT_MS, minute: elapsed / 60_000 } : null,
    route: currentStage ? routeAt(currentStage, latest, safe, displayNowMs) : null,
    fight, party: [...party.values()], summary,
  };
}

export type DungeonTripOptions = Omit<TripPlanOptions, 'nowMs'> & { nowMs?: number };

/** Plan the four fight slots using only their published stages and Patch A's trip pacing. */
export function planDungeonTrip(timeline: RevealedTimeline, options: DungeonTripOptions): TripPlan | null {
  const nowMs = options.nowMs ?? timeline.visibleThroughMs;
  const stages = dueStages(timeline, nowMs);
  const departure = stages.find(stage => stage.kind === 'depart');
  if (!departure) return null;
  const departureMs = departure.startedAtMs;
  const endMs = departureMs + SLOT_MS;
  const dungeon = Object.values(CATALOG_V1.dungeons).find(entry => departure.label.startsWith(`Enter ${entry.name} with `));
  const walks: StageWalk[] = [];
  const fights = new Map<DungeonFightOrdinal, { stage: RevealedStage; outcome: FightOutcome | null; safe: boolean }>();
  let last: RevealedStage | undefined;
  for (const [index, stage] of stages.entries()) {
    if (isFinal(stage)) continue;
    if (isFight(stage)) {
      last = stage;
      const ordinal = ordinalOf(stage);
      const next = stages[index + 1];
      const outcome = stage.endsAtMs <= nowMs ? publishedOutcome(stage, next) : null;
      const returningSafe = next?.kind === 'return' && !isFinal(next);
      if (ordinal !== null) fights.set(ordinal, { stage, outcome, safe: returningSafe || outcome === 'defeat' });
      if (outcome === 'defeat' && !returningSafe) walks.push(...movementLegs(stage, stage, true));
      continue;
    }
    walks.push(...movementLegs(stage, last, stage.kind === 'return'));
  }

  const pieces: TripPiece[] = [];
  const chapters: TripChapter[] = [];
  let cursor = 0;
  const piece = (fromMs: number, toMs: number, lengthMs: number) => {
    const startMs = cursor;
    cursor += lengthMs;
    pieces.push({ fromMs, toMs, startMs, endMs: cursor, rate: lengthMs > 0 ? (toMs - fromMs) / lengthMs : Infinity });
  };
  const stretch = (fromMs: number, toMs: number) => {
    if (toMs <= fromMs) return;
    const legs = walks.filter(leg => leg.atMs >= fromMs && leg.atMs < toMs);
    const intervals: { from: number; to: number; walking: boolean }[] = [];
    let from = fromMs;
    for (const [index, leg] of legs.entries()) {
      if (leg.atMs > from) intervals.push({ from, to: leg.atMs, walking: false });
      const walkMs = options.walkMs(leg.from, leg.to);
      const next = legs[index + 1]?.atMs ?? toMs;
      const end = Math.min(leg.atMs + (Number.isFinite(walkMs) ? Math.max(0, walkMs) : 0), next);
      if (end > leg.atMs) intervals.push({ from: leg.atMs, to: end, walking: true });
      from = end;
    }
    if (from < toMs) intervals.push({ from, to: toMs, walking: false });
    const walking = intervals.reduce((sum, interval) => sum + (interval.walking ? interval.to - interval.from : 0), 0);
    const waiting = toMs - fromMs - walking;
    const waitingTime = Math.max(0, (toMs - fromMs) / TRIP_PACE.travel - walking / TRIP_PACE.walk);
    for (const interval of intervals) {
      const length = interval.to - interval.from;
      piece(interval.from, interval.to, interval.walking ? length / TRIP_PACE.walk : waitingTime * length / waiting);
    }
  };
  const chapter = (id: TripChapterId, label: string, from: number, to: number, play?: () => void) => {
    const startMs = cursor;
    play?.();
    chapters.push({ id, label, startMs, endMs: cursor, vignette: null, displayFromMs: from, displayToMs: to, revealed: !!play });
  };
  const camp = (id: 'leaving' | 'back' | 'resting', label: string, ms: number, duration: number, revealed = true) => {
    const startMs = cursor;
    if (revealed) cursor += duration;
    chapters.push({ id, label, startMs, endMs: cursor, vignette: id, displayFromMs: ms, displayToMs: ms, revealed });
  };

  const dueAt = (ordinal: number) => departureMs + ordinal * DUNGEON_FIGHT_INTERVAL_MS;
  const startOf = (ordinal: DungeonFightOrdinal) => fights.get(ordinal)?.stage.startedAtMs ?? dueAt(ordinal);
  camp('leaving', 'Leaving camp', departureMs, TRIP_PACE.campMs);
  chapter('trail', dungeon ? `Into ${dungeon.name}` : 'Into the dungeon', departureMs, startOf(1), () => stretch(departureMs, startOf(1)));

  let destination: 'safe' | 'home' | 'unknown' = 'unknown';
  let afterFight = endMs;
  let nextKnown = true;
  for (const ordinal of ORDINALS) {
    const entry = fights.get(ordinal);
    const id = `fight-${ordinal}` as const;
    const label = ordinal === 4 ? dungeon?.major.name ?? 'Major' : `Room ${ordinal}`;
    if (!entry || !nextKnown) {
      chapter(id, label, dueAt(ordinal), dueAt(ordinal));
      nextKnown = false;
      continue;
    }
    const from = entry.stage.startedAtMs;
    const over = Math.min(endMs, outroEnd(entry.stage));
    const to = entry.safe || ordinal === 4 ? over : startOf(ORDINALS[ordinal]);
    chapter(id, label, from, to, () => {
      const fightEnd = Math.min(over, to);
      piece(from, fightEnd, fightEnd - from);
      stretch(fightEnd, to);
    });
    if (entry.safe) {
      destination = 'safe';
      afterFight = over;
      break;
    }
    nextKnown = entry.outcome === 'victory';
    if (ordinal === 4 && nextKnown) {
      destination = 'home';
      afterFight = over;
    }
  }
  if (destination === 'safe') chapter('safe-point', 'Safe point', afterFight, endMs, () => stretch(afterFight, endMs));
  else if (destination === 'home') chapter('heading-home', 'Heading home', afterFight, endMs, () => stretch(afterFight, endMs));
  else chapter('heading-home', 'Heading home', endMs, endMs);

  const arrived = destination !== 'unknown' && stages.some(isFinal);
  camp('back', 'Back in camp', endMs, TRIP_PACE.campMs, arrived);
  if (arrived && options.resting) camp('resting', 'Resting', endMs, TRIP_PACE.restMs);
  return { chapters, totalMs: cursor, departureMs, endMs, pieces };
}
