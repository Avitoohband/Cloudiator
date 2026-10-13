// Pure expedition stage core. Given a revealed timeline and the display clock (estimated server time),
// it returns everything the expedition view and scene show: the stages revealed by that time, the
// phase, the progress along the 80-minute slot, where the gladiator is on its journey, the revealed
// battle to play, health read from the battle logs, replay availability and the settled summary.
// It never computes an outcome, health or reward: those come from the published stages, logs and
// summary. Only stages whose revealedAtMs <= displayNowMs exist here, even when the timeline holds
// later ones, and the summary appears only once its settlement time has passed. No Phaser, React,
// clock or randomness is used, so the same inputs always give the same state.
import type { ActivitySummary, BattleLog, RevealedStage, RevealedTimeline } from '@contracts/events';
import { RULES_V1 } from '@domain/rules-v1';
import { REPLAY_OUTRO_MS, reduceReplay } from './replay';

/** One expedition fills one shared slot: depart at minute 0, encounters at 20, 40 and 60, arrival at 80. */
export const EXPEDITION_MS = RULES_V1.clock.slotMs;
export const ENCOUNTER_INTERVAL_MS = EXPEDITION_MS / 4;
/** The gladiator leaves its search spot this long before the next encounter is due, to wait at the spot. */
export const EXPEDITION_APPROACH_MS = 45_000;

/** Named points of the journey, in route order; the scene resolves them on the expedition map. */
export const JOURNEY = ['start', 'search-1', 'encounter-1', 'search-2', 'encounter-2', 'search-3', 'encounter-3', 'search-4', 'end'] as const;
export type JourneyPoint = (typeof JOURNEY)[number] | 'safe';

export type ExpeditionPhase = 'depart' | 'exploration' | 'encounter' | 'safe-return' | 'returning' | 'arrived' | 'preparing' | 'settled';

/**
 * Where the gladiator is: it left `from` `walkedMs` ago (display time) for `to`, and does `then` once it
 * arrives. The scene walks the map path between the two points at the actors' walking speed and holds
 * at `to`. `segment` is the index of `from` in JOURNEY (the route segment being walked).
 */
export type RouteProgress = {
  readonly segment: number;
  readonly from: JourneyPoint;
  readonly to: JourneyPoint;
  readonly walkedMs: number;
  readonly then: 'search' | 'wait' | 'fight' | 'rest';
};

export type VisibleStage = {
  readonly id: string;
  readonly kind: RevealedStage['kind'];
  /** The published label, except `Encounter N` while that battle is still being fought. */
  readonly label: string;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  /** 1-based encounter number for encounter stages. */
  readonly encounter: number | null;
  /** An encounter whose battle has not ended by the display time. */
  readonly inProgress: boolean;
  /** Only once the battle has ended. */
  readonly outcome: 'victory' | 'defeat' | null;
  /** A completed encounter whose battle log is kept (not pruned, not expired). */
  readonly replay: boolean;
  /** The zero-length arrival that completes the expedition. */
  readonly final: boolean;
};

export type ExpeditionBattle = {
  readonly stageId: string;
  readonly encounter: number;
  readonly log: BattleLog;
  /** Display time since the battle started; the replay controller is seeked to it. */
  readonly elapsedMs: number;
  readonly finished: boolean;
};

export type ExpeditionSceneState = {
  readonly activityId: string;
  readonly displayNowMs: number;
  readonly phase: ExpeditionPhase;
  /** Revealed stages in order, for the activity log. */
  readonly stages: readonly VisibleStage[];
  readonly current: VisibleStage | null;
  /** Position on the 80-minute strip; null until the departure is revealed. */
  readonly progress: { readonly startMs: number; readonly endMs: number; readonly fraction: number; readonly minute: number } | null;
  readonly route: RouteProgress | null;
  /** The search spot (1 to 4) the gladiator is heading to or searching at. */
  readonly searchSpot: 1 | 2 | 3 | 4 | null;
  /** The latest revealed encounter that has a battle log, for playback in the scene. */
  readonly battle: ExpeditionBattle | null;
  /** The gladiator's health, read from the latest battle log (running health during a fight). */
  readonly hp: { readonly current: number; readonly max: number; readonly encounter: number } | null;
  /** The gladiator as the first revealed battle log shows it (participant 0). */
  readonly gladiator: { readonly id: string; readonly name: string; readonly equipmentSilhouettes: readonly string[] } | null;
  /** The arrival stage is revealed. */
  readonly complete: boolean;
  /** Once complete: from the summary when settled, otherwise from the revealed encounters. */
  readonly outcome: 'success' | 'failure' | null;
  /** The settled summary (owner timelines only), once its settlement time has passed. */
  readonly summary: ActivitySummary | null;
  /** Minute 80 has passed and no summary is visible: an owner sees "Processing results". */
  readonly awaitingSummary: boolean;
};

type Battled = RevealedStage & { battleLog: BattleLog };

/** Deep-freezes the state it built; the caller's battle logs are shared by reference and left untouched. */
function freeze<V>(value: V, shared: ReadonlySet<object>): V {
  if (value && typeof value === 'object' && !shared.has(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child, shared);
  }
  return value;
}

/** A tie-break victory with 0 HP counts as a defeat, as in settlement. */
function logOutcome(log: BattleLog): 'victory' | 'defeat' {
  return log.winnerId === log.participants[0].id && log.finalHp[0] > 0 ? 'victory' : 'defeat';
}

/** The outcome of an ended encounter: its log, else the stage that follows it, else its published label. */
function encounterOutcome(stage: RevealedStage, next: RevealedStage | undefined): 'victory' | 'defeat' | null {
  if (stage.battleLog) return logOutcome(stage.battleLog);
  if (next?.kind === 'exploration' || next?.kind === 'travel') return 'victory';
  if (next?.kind === 'return' && next.endsAtMs > next.startedAtMs) return 'defeat';
  const word = /:\s*(victory|defeat)\s*$/i.exec(stage.label)?.[1]?.toLowerCase();
  return word === 'victory' || word === 'defeat' ? word : null;
}

const isFinal = (stage: RevealedStage) => stage.kind === 'settlement' || (stage.kind === 'return' && stage.endsAtMs <= stage.startedAtMs);
const point = (name: string) => name as JourneyPoint;
const segmentOf = (from: JourneyPoint) => Math.max(0, JOURNEY.indexOf(from as (typeof JOURNEY)[number]));

/**
 * The gladiator's movement during the current stage. Departing, exploring after a won encounter and
 * travelling home after the last one all follow one pattern: finish the result poses at the encounter,
 * walk to the next search spot and search there, then walk on and wait at the next encounter spot (or
 * the route's end) shortly before it is due. A fight happens at its encounter spot; after a defeat the
 * gladiator walks back to the safe point and rests there.
 */
function journeyAt(t: number, stage: RevealedStage, current: VisibleStage, upToCurrent: RevealedStage[], encounterOf: Map<RevealedStage, number>, failed: boolean): RouteProgress {
  const go = (from: JourneyPoint, to: JourneyPoint, since: number, then: RouteProgress['then']): RouteProgress =>
    ({ segment: segmentOf(from), from, to, walkedMs: Math.max(0, t - since), then });
  if (current.final) return failed ? go('safe', 'safe', stage.startedAtMs, 'rest') : go('end', 'end', stage.startedAtMs, 'wait');
  const last = [...upToCurrent].reverse().find(s => s.kind === 'encounter');
  const n = last ? encounterOf.get(last)! : 0;
  const here: JourneyPoint = n ? point(`encounter-${n}`) : 'start';
  if (stage === last) return go(here, here, stage.startedAtMs, 'fight');
  // The fighters finish their result poses before the gladiator moves on.
  const leave = last ? last.endsAtMs + REPLAY_OUTRO_MS : stage.startedAtMs;
  if (last && t < leave) return go(here, here, last.startedAtMs, 'fight');
  if (stage.kind === 'return') return go(here, 'safe', leave, 'rest');
  const spot = point(`search-${n + 1}`);
  const next = point(n >= 3 ? 'end' : `encounter-${n + 1}`);
  const approach = Math.max(leave, stage.endsAtMs - EXPEDITION_APPROACH_MS);
  return t < approach ? go(here, spot, leave, 'search') : go(spot, next, approach, 'wait');
}

export function renderExpeditionStage(timeline: RevealedTimeline, displayNowMs: number): ExpeditionSceneState {
  const t = displayNowMs;
  const revealed = timeline.stages.filter(stage => stage.revealedAtMs <= t);
  const kept = timeline.summary?.replayExpiry.state !== 'expired';
  const summary = timeline.summary && timeline.summary.settledAtMs <= t ? structuredClone(timeline.summary) : null;

  let encounters = 0;
  const encounterOf = new Map<RevealedStage, number>();
  const stages: VisibleStage[] = revealed.map((stage, i) => {
    const encounter = stage.kind === 'encounter' ? (encounters += 1) : null;
    if (encounter !== null) encounterOf.set(stage, encounter);
    const inProgress = encounter !== null && t < stage.endsAtMs;
    const outcome = encounter !== null && !inProgress ? encounterOutcome(stage, revealed[i + 1]) : null;
    return {
      id: stage.id, kind: stage.kind,
      label: inProgress ? `Encounter ${encounter}` : stage.label,
      startedAtMs: stage.startedAtMs, endsAtMs: stage.endsAtMs,
      encounter, inProgress, outcome,
      replay: encounter !== null && !inProgress && !!stage.battleLog && kept,
      final: isFinal(stage),
    };
  });

  let index = -1;
  for (let i = 0; i < revealed.length; i += 1) if (revealed[i].startedAtMs <= t) index = i;
  const currentStage = index >= 0 ? revealed[index] : undefined;
  const current = index >= 0 ? stages[index] : null;
  const departure = revealed[0];
  const startMs = departure?.startedAtMs ?? null;

  // Phase.
  const complete = stages.some(s => s.final);
  let phase: ExpeditionPhase;
  if (!currentStage || !current) phase = 'preparing';
  else if (current.final) phase = summary ? 'settled' : 'arrived';
  else if (t >= currentStage.endsAtMs) phase = 'preparing';
  else if (currentStage.kind === 'depart') phase = 'depart';
  else if (currentStage.kind === 'encounter') phase = 'encounter';
  else if (currentStage.kind === 'travel') phase = encounters > 0 ? 'returning' : 'depart';
  else if (currentStage.kind === 'return') phase = 'safe-return';
  else phase = 'exploration';

  // The latest revealed encounter with a log: played in the scene and the source of health.
  let battle: ExpeditionBattle | null = null;
  for (const stage of revealed) {
    if (stage.kind !== 'encounter' || !stage.battleLog) continue;
    battle = { stageId: stage.id, encounter: encounterOf.get(stage)!, log: stage.battleLog, elapsedMs: t - stage.startedAtMs, finished: t >= stage.endsAtMs };
  }
  const latestEncounter = [...revealed].reverse().find(stage => stage.kind === 'encounter');
  let hp: ExpeditionSceneState['hp'] = null;
  if (battle && latestEncounter?.id === battle.stageId) {
    const me = battle.log.participants[0];
    hp = { current: battle.finished ? battle.log.finalHp[0] : reduceReplay(battle.log, battle.elapsedMs).hp[0], max: me.maxHealth, encounter: battle.encounter };
  }
  const firstLog = revealed.find((stage): stage is Battled => !!stage.battleLog)?.battleLog;
  const gladiator = firstLog
    ? { id: firstLog.participants[0].id, name: firstLog.participants[0].name, equipmentSilhouettes: [...firstLog.participants[0].equipmentSilhouettes] }
    : null;

  // Journey.
  const outcomes = stages.filter(s => s.encounter !== null && s.outcome !== null);
  const failed = outcomes.some(s => s.outcome === 'defeat') || revealed.some(s => s.kind === 'return' && !isFinal(s));
  const route = currentStage && current ? journeyAt(t, currentStage, current, revealed.slice(0, index + 1), encounterOf, failed) : null;
  const searchSpot = route && route.to.startsWith('search-') ? (Number(route.to.slice('search-'.length)) as 1 | 2 | 3 | 4) : null;

  const outcome: ExpeditionSceneState['outcome'] = !complete ? null : summary ? (summary.success ? 'success' : 'failure') : failed ? 'failure' : 'success';
  const progress = startMs === null ? null : (() => {
    const elapsed = Math.min(EXPEDITION_MS, Math.max(0, t - startMs));
    return { startMs, endMs: startMs + EXPEDITION_MS, fraction: elapsed / EXPEDITION_MS, minute: elapsed / 60_000 };
  })();

  return freeze({
    activityId: timeline.activityId,
    displayNowMs: t,
    phase,
    stages,
    current,
    progress,
    route,
    searchSpot,
    battle,
    hp,
    gladiator,
    complete,
    outcome,
    summary,
    awaitingSummary: !summary && startMs !== null && t >= startMs + EXPEDITION_MS,
  }, new Set(revealed.flatMap(stage => (stage.battleLog ? [stage.battleLog] : []))));
}

/**
 * Display times when a fresh timeline read may reveal more: the end of the current stage and each
 * 20-minute mark still ahead. Nothing is due once the expedition is complete.
 */
export function expeditionRevealMarks(state: ExpeditionSceneState): number[] {
  if (state.complete || !state.progress) return [];
  const marks = [1, 2, 3, 4].map(k => state.progress!.startMs + k * ENCOUNTER_INTERVAL_MS);
  if (state.current) marks.push(state.current.endsAtMs);
  return [...new Set(marks)].filter(mark => mark > state.displayNowMs).sort((a, b) => a - b);
}
