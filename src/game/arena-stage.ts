// Pure Arena stage core. Given a revealed Arena timeline and the display clock (estimated server time), it returns
// what the camp, the Arena card and the replay link show: the phase, the opponent once the bout is revealed, whether
// that opponent is an NPC fallback, the bout to play, the replay link, the result once the bout has ended and, for
// the owner only, the credited summary once settled.
//
// The public stage sequence (proposed to Codex for Task 16) for a slot starting at S:
//   0 `staging` S..S+60 min "Warming up"; 1 `bout` from S+60 min for the logged duration; 2 `return` at S+80 min.
// Only stages whose revealedAtMs <= displayNowMs exist here, even when the timeline already holds later ones, and
// the summary appears only once its settlement time has passed. A bout's outcome is never shown before the bout's
// endsAtMs, although its published label names it. The winner is always the logged winnerId (a seeded tie-break at
// 0 HP included); health and labels never decide it, so a bout without its log has no result here. Nothing here
// computes a result, rating or reward, and no Phaser, React, clock or randomness is used, so the same inputs always
// give the same state.
import type { ActivitySummary, BattleLog, RevealedCombatant, RevealedStage, RevealedTimeline } from '@contracts/events';
import type { ClassId } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';
import { replayKept } from '../lib/replay-retention';

export const ARENA_SLOT_MS = RULES_V1.clock.slotMs;
/** The bout log is revealed at minute 60 of the slot. */
export const ARENA_REVEAL_MS = RULES_V1.arena.revealAfterMs;

export type ArenaPhase = 'warming-up' | 'preparing' | 'bout' | 'completed' | 'credited';

export type ArenaFighter = {
  readonly id: string;
  readonly gladiatorId: string | null;
  /** The logged name; views prefer the public name of a gladiator when they know it. */
  readonly name: string;
  readonly classId: ClassId | null;
  /** An NPC fallback opponent: no gladiator behind it. */
  readonly npc: boolean;
};

export type ArenaVisibleStage = {
  readonly id: string;
  readonly kind: RevealedStage['kind'];
  /** The published label, except "Bout in progress" while the bout has not ended. */
  readonly label: string;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  readonly inProgress: boolean;
};

export type ArenaBout = {
  readonly stageId: string;
  /** Null when only a public visible stage (no log) is known. */
  readonly battleId: string | null;
  readonly log: BattleLog | null;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  /** Display time since the bout started; a scene seeks its playback to it. */
  readonly elapsedMs: number;
  readonly finished: boolean;
};

export type ArenaResult = {
  /** For the entrant whose activity this is. */
  readonly outcome: 'victory' | 'defeat';
  readonly winnerId: string | null;
  readonly reason: BattleLog['victoryReason'] | null;
  readonly tieBreakReason: BattleLog['tieBreakReason'];
  /** Entrant first, then opponent; null without a log. */
  readonly finalHp: readonly [number, number] | null;
};

export type ArenaStageState = {
  readonly activityId: string | null;
  readonly displayNowMs: number;
  readonly phase: ArenaPhase;
  /** Slot start, from the warm-up stage; null when unknown. */
  readonly startMs: number | null;
  /** Minutes since the slot started, or null. */
  readonly minute: number | null;
  readonly stages: readonly ArenaVisibleStage[];
  /** Only once the bout is revealed (and its log known). */
  readonly entrant: ArenaFighter | null;
  readonly opponent: ArenaFighter | null;
  readonly npcOpponent: boolean;
  readonly bout: ArenaBout | null;
  /** The expanded replay of the revealed bout, unless its log is known to have expired. */
  readonly replay: { readonly activityId: string; readonly stageId: string } | null;
  /** Only once the bout has ended. */
  readonly result: ArenaResult | null;
  /** The owner's credited summary, once its settlement time has passed. */
  readonly summary: ActivitySummary | null;
  /** The owner's minute 80 has passed and no summary is visible: "Processing results". */
  readonly awaitingSummary: boolean;
  /**
   * At the display time the detailed log is no longer kept: the owner's summary says so, or, for anyone, the settled public
   * completion does (Task 22.5: decided by time, so a summary still saying available past its expiry counts).
   */
  readonly replayExpired: boolean;
};

export type ArenaStageOptions = {
  /** The entrant's gladiator id; otherwise participant 0 is the entrant. */
  entrantId?: string | null;
  /** The viewer owns this activity. Only then is a summary shown (the backend sends it to owners only, too). */
  owner?: boolean;
};

/** Deep-freezes the state it built; the caller's battle logs are shared by reference and left untouched. */
function freeze<V>(value: V, shared: ReadonlySet<object>): V {
  if (value && typeof value === 'object' && !shared.has(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child, shared);
  }
  return value;
}

const fighterOf = (p: Readonly<RevealedCombatant>): ArenaFighter =>
  ({ id: p.id, gladiatorId: p.gladiatorId, name: p.name, classId: p.classId, npc: p.gladiatorId === null });

/** The Arena state of one revealed timeline at the display time. */
export function renderArenaStage(timeline: RevealedTimeline, displayNowMs: number, options: ArenaStageOptions = {}): ArenaStageState {
  const { activityId } = timeline;
  const summarySource = timeline.summary ?? null;
  const t = displayNowMs;
  const revealed: RevealedStage[] = timeline.stages.filter(stage => stage.revealedAtMs <= t);
  const staging = revealed.find(stage => stage.kind === 'staging');
  const startMs = staging?.startedAtMs ?? null;
  const owner = !!options.owner;
  const boutStage = [...revealed].reverse().find(stage => stage.kind === 'bout');
  const log = boutStage?.battleLog ?? null;
  const finished = !!boutStage && t >= boutStage.endsAtMs;

  const stages: ArenaVisibleStage[] = revealed.map(stage => {
    const inProgress = stage.kind === 'bout' && t < stage.endsAtMs;
    return { id: stage.id, kind: stage.kind, label: inProgress ? 'Bout in progress' : stage.label, startedAtMs: stage.startedAtMs, endsAtMs: stage.endsAtMs, inProgress };
  });

  let entrant: ArenaFighter | null = null;
  let opponent: ArenaFighter | null = null;
  if (log) {
    const mine = log.participants.findIndex(p => options.entrantId != null && p.gladiatorId === options.entrantId);
    const me = mine >= 0 ? mine : 0;
    entrant = fighterOf(log.participants[me]);
    opponent = fighterOf(log.participants[1 - me]);
  }

  let result: ArenaResult | null = null;
  if (finished && log && entrant) {
    const me = log.participants[0].id === entrant.id ? 0 : 1;
    result = {
      outcome: log.winnerId === entrant.id ? 'victory' : 'defeat', winnerId: log.winnerId, reason: log.victoryReason,
      tieBreakReason: log.tieBreakReason, finalHp: [log.finalHp[me], log.finalHp[1 - me]],
    };
  }

  const summary = owner && summarySource && summarySource.settledAtMs <= t ? structuredClone(summarySource) : null;
  // By the display time (Task 22.5): the owner's summary, else the public completion once settled, may say the replay is
  // no longer kept, even while its summary still says available.
  const completion = timeline.completion && timeline.completion.settledAtMs <= t ? timeline.completion : null;
  const expiry = (owner ? summarySource?.replayExpiry : undefined) ?? completion?.replayExpiry;
  const replayExpired = !!expiry && !replayKept(expiry, t);
  const phase: ArenaPhase = summary ? 'credited'
    : boutStage ? (finished ? 'completed' : 'bout')
      : startMs !== null && t >= startMs + ARENA_REVEAL_MS ? 'preparing'
        : staging ? 'warming-up' : 'preparing';

  return freeze({
    activityId,
    displayNowMs: t,
    phase,
    startMs,
    minute: startMs === null ? null : (t - startMs) / 60_000,
    stages,
    entrant,
    opponent,
    npcOpponent: !!opponent?.npc,
    bout: boutStage ? {
      stageId: boutStage.id, battleId: log?.battleId ?? null, log, startedAtMs: boutStage.startedAtMs, endsAtMs: boutStage.endsAtMs,
      elapsedMs: t - boutStage.startedAtMs, finished,
    } : null,
    replay: boutStage && activityId && !replayExpired ? { activityId, stageId: boutStage.id } : null,
    result,
    summary,
    awaitingSummary: owner && !summary && startMs !== null && t >= startMs + ARENA_SLOT_MS,
    replayExpired,
  }, new Set(log ? [log] : []));
}

/**
 * Display times when a fresh timeline read may reveal more: minute 60 (the bout) while it is not yet visible, and
 * minute 80 (the results) while they are not. Nothing is due once the results are visible.
 */
export function arenaRevealMarks(state: ArenaStageState): number[] {
  if (state.startMs === null) return [];
  const marks: number[] = [];
  if (!state.bout) marks.push(state.startMs + ARENA_REVEAL_MS);
  if (!state.summary && !state.stages.some(s => s.kind === 'return' || s.kind === 'settlement')) marks.push(state.startMs + ARENA_SLOT_MS);
  return marks.filter(mark => mark > state.displayNowMs);
}
