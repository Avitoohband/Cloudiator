// Pure battle-log replay core. Everything here is derived from the revealed, authoritative
// BattleLog: health comes from the logged healthAfter values and the result from the logged
// victory. Nothing is simulated, recalculated or rewarded, and no Phaser, React or combat engine
// is imported. Playback is a position in log milliseconds, so it is independent of frame rate.
import type { ActivitySummary, BattleAction, BattleLog, BattleVictory, RevealedStage, RevealedTimeline } from '@contracts/events';
import type { GameGateway } from '../lib/api/gateway';
import { replayKept } from '../lib/replay-retention';

export const REPLAY_SPEEDS = { normal: 1, fast: 4 } as const;
export type ReplaySpeed = keyof typeof REPLAY_SPEEDS;
/** Log time played after the victory so the defeat and victory poses can finish. */
export const REPLAY_OUTRO_MS = 2000;

export type ReplayEvent = Readonly<BattleAction> | Readonly<BattleVictory>;
export type ReplayGroup = { readonly index: number; readonly elapsedMs: number; readonly events: readonly ReplayEvent[] };
export type ReplayResult = {
  readonly winnerId: string;
  readonly loserId: string;
  readonly victoryReason: BattleLog['victoryReason'];
  readonly tieBreakReason: BattleLog['tieBreakReason'];
};
/** Replay state at a log time. It holds no rewards: those exist only in the activity summary. */
export type ReplayFrame = {
  /** The log time reduced through, clamped to [0, durationMs]. */
  readonly throughMs: number;
  /** In participant order, taken from the logged health values. */
  readonly hp: readonly [number, number];
  readonly maxHp: readonly [number, number];
  /** Index of the latest applied group, or -1 before the first one. */
  readonly groupIndex: number;
  readonly group: ReplayGroup | null;
  /** How many log events (a prefix of log.events) are applied. */
  readonly appliedEvents: number;
  readonly finished: boolean;
  readonly result: ReplayResult | null;
};

const groupsCache = new WeakMap<BattleLog, readonly ReplayGroup[]>();

/** Events with the same elapsedMs form one group and apply together, in log order. */
export function groupReplay(log: BattleLog): readonly ReplayGroup[] {
  const cached = groupsCache.get(log);
  if (cached) return cached;
  const groups: ReplayGroup[] = [];
  let current: ReplayEvent[] | null = null;
  for (const event of log.events) {
    if (!current || groups[groups.length - 1].elapsedMs !== event.elapsedMs) {
      current = [];
      groups.push({ index: groups.length, elapsedMs: event.elapsedMs, events: current });
    }
    current.push(event);
  }
  for (const g of groups) { Object.freeze(g.events); Object.freeze(g); }
  Object.freeze(groups);
  groupsCache.set(log, groups);
  return groups;
}

/** Index of the last group at or before `ms`, or -1. */
function groupAt(groups: readonly ReplayGroup[], ms: number): number {
  let lo = 0;
  let hi = groups.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].elapsedMs <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function reduceReplay(log: BattleLog, throughMs: number): ReplayFrame {
  const through = Math.min(log.durationMs, Math.max(0, Number.isFinite(throughMs) ? throughMs : throughMs > 0 ? log.durationMs : 0));
  const groups = groupReplay(log);
  const groupIndex = groupAt(groups, through);
  const [first, second] = log.participants;
  const hp: [number, number] = [first.initialHealth, second.initialHealth];
  let appliedEvents = 0;
  let victory: Readonly<BattleVictory> | null = null;
  for (let g = 0; g <= groupIndex; g += 1) {
    for (const event of groups[g].events) {
      appliedEvents += 1;
      if (event.kind === 'victory') { victory = event; continue; }
      hp[event.defenderId === first.id ? 0 : 1] = event.healthAfter;
    }
  }
  const result: ReplayResult | null = victory
    ? Object.freeze({ winnerId: victory.winnerId, loserId: victory.loserId, victoryReason: victory.reason, tieBreakReason: log.tieBreakReason })
    : null;
  return Object.freeze({
    throughMs: through,
    hp: Object.freeze(hp),
    maxHp: Object.freeze([first.maxHealth, second.maxHealth] as [number, number]),
    groupIndex,
    group: groupIndex >= 0 ? groups[groupIndex] : null,
    appliedEvents,
    finished: !!victory,
    result,
  });
}

export type ReplayController = {
  readonly log: BattleLog;
  /** Last playable position: the log duration plus the outro. */
  readonly endMs: number;
  readonly positionMs: number;
  readonly playing: boolean;
  readonly speed: ReplaySpeed;
  readonly frame: ReplayFrame;
  /** Plays from the current position, or from the start when the replay has ended. */
  play(): void;
  pause(): void;
  /** Back to the start, playing. */
  restart(): void;
  seek(positionMs: number): void;
  setSpeed(speed: ReplaySpeed): void;
  /** Jumps to the final state and stops. */
  skipToResult(): void;
  /** The only clock input: real milliseconds since the previous tick, scaled by the speed. */
  tick(realMs: number): void;
  /** Called after discrete changes (group, result, play state, speed), not every tick. */
  subscribe(listener: () => void): () => void;
  listenerCount(): number;
};

export function createReplayController(log: BattleLog, options: { speed?: ReplaySpeed } = {}): ReplayController {
  const endMs = log.durationMs + REPLAY_OUTRO_MS;
  const listeners = new Set<() => void>();
  let positionMs = 0;
  let playing = false;
  let speed: ReplaySpeed = options.speed ?? 'normal';
  let frame = reduceReplay(log, 0);
  let signature = '';
  const sign = () => `${playing}|${speed}|${frame.groupIndex}|${frame.finished}`;
  signature = sign();

  function moveTo(ms: number) {
    positionMs = Math.min(endMs, Math.max(0, Number.isFinite(ms) ? ms : ms > 0 ? endMs : 0));
    if (positionMs >= endMs) playing = false;
    const next = reduceReplay(log, positionMs);
    if (next.groupIndex !== frame.groupIndex || next.finished !== frame.finished || next.throughMs !== frame.throughMs) frame = next;
    notify();
  }
  function notify() {
    const now = sign();
    if (now === signature) return;
    signature = now;
    for (const listener of [...listeners]) listener();
  }

  const controller: ReplayController = Object.freeze({
    log,
    endMs,
    get positionMs() { return positionMs; },
    get playing() { return playing; },
    get speed() { return speed; },
    get frame() { return frame; },
    play() {
      if (positionMs >= endMs) positionMs = 0;
      playing = true;
      moveTo(positionMs);
    },
    pause() { playing = false; notify(); },
    restart() { playing = true; moveTo(0); },
    seek(ms: number) { moveTo(ms); },
    setSpeed(next: ReplaySpeed) { if (Object.hasOwn(REPLAY_SPEEDS, next)) { speed = next; notify(); } },
    skipToResult() { playing = false; moveTo(endMs); },
    tick(realMs: number) {
      if (!playing || !(realMs > 0)) return;
      moveTo(positionMs + realMs * REPLAY_SPEEDS[speed]);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    listenerCount: () => listeners.size,
  });
  return controller;
}

// ------------------------------------------------------------------ readable log

export type ReplayLine = {
  sequence: number;
  groupIndex: number;
  elapsedMs: number;
  kind: 'hit' | 'critical' | 'defend' | 'evade' | 'victory';
  text: string;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** One plain-text line per log event, with the logged names and numbers. */
export function replayLines(log: BattleLog): ReplayLine[] {
  const name = (id: string) => log.participants.find(p => p.id === id)?.name ?? id;
  return groupReplay(log).flatMap(group => group.events.map(event => {
    const at = `${seconds(event.elapsedMs)} · `;
    if (event.kind === 'victory') {
      const winner = name(event.winnerId);
      const text = event.reason === 'defeat' ? `${name(event.loserId)} is defeated. ${winner} wins.`
        : event.reason === 'health-fraction' ? `Time is up. ${winner} wins with the larger share of health left.`
          : log.tieBreakReason === 'simultaneous-defeat' ? `Both fighters fall at the same moment. A seeded tie-break names ${winner} the winner.`
            : `Time is up with equal shares of health. A seeded tie-break names ${winner} the winner.`;
      return { sequence: event.sequence, groupIndex: group.index, elapsedMs: event.elapsedMs, kind: 'victory' as const, text: at + text };
    }
    const attacker = name(event.attackerId);
    const defender = name(event.defenderId);
    const health = ` ${defender} ${event.healthBefore} → ${event.healthAfter} HP.`;
    const [kind, text] = !event.hit ? ['evade', `${attacker} attacks ${defender} and misses: ${defender} evades.`] as const
      : event.critical ? ['critical', `${attacker} lands a critical hit on ${defender} for ${event.damage} damage.${health}`] as const
        : event.defend ? ['defend', `${attacker} hits ${defender} for ${event.damage} damage; ${defender}’s defensive stance softens the blow.${health}`] as const
          : ['hit', `${attacker} hits ${defender} for ${event.damage} damage.${health}`] as const;
    return { sequence: event.sequence, groupIndex: group.index, elapsedMs: event.elapsedMs, kind, text: at + text };
  }));
}

// ------------------------------------------------------------------ timeline views

export type ReplayBattle = { stage: RevealedStage; log: BattleLog };
export type ReplayView =
  | { kind: 'replay'; battles: ReplayBattle[]; selected: number; summary: ActivitySummary | null }
  /** No animation is kept: show the saved outcome and credited rewards only. */
  | { kind: 'summary'; reason: 'expired' | 'missing'; summary: ActivitySummary }
  /** `expired`: a spectator's replay that is no longer kept (only the public completion says so; it holds no rewards). */
  | { kind: 'unavailable'; reason: 'not-revealed' | 'not-found' | 'unavailable' | 'expired' };

/**
 * What a replay page can show for a revealed timeline. An expired replay always shows its owner's summary; a spectator,
 * who has only the public completion, is told it is no longer kept (Task 13.8 fix round 1). Expiry is decided at the
 * read's server time (Task 22.5): a summary that still says `available` past its expiry (cleanup has not flipped it yet,
 * or has already pruned the log) is expired too, never `missing` or "not available yet".
 */
export function replayViewOf(timeline: RevealedTimeline, stageId?: string | null): ReplayView {
  const summary = timeline.summary ?? null;
  if (summary && !replayKept(summary.replayExpiry, timeline.serverNowMs)) return { kind: 'summary', reason: 'expired', summary };
  if (!summary && timeline.completion && !replayKept(timeline.completion.replayExpiry, timeline.serverNowMs)) return { kind: 'unavailable', reason: 'expired' };
  const battles = timeline.stages.filter((s): s is RevealedStage & { battleLog: BattleLog } => !!s.battleLog).map(stage => ({ stage, log: stage.battleLog }));
  if (battles.length) return { kind: 'replay', battles, selected: Math.max(0, battles.findIndex(b => b.stage.id === stageId)), summary };
  if (summary) return { kind: 'summary', reason: 'missing', summary };
  return { kind: 'unavailable', reason: 'not-revealed' };
}

/** When a battle's fight ends: its start plus the logged duration (the server publishes this as a bout's end). */
export const battleEndMs = (battle: ReplayBattle) => battle.stage.startedAtMs + battle.log.durationMs;

/**
 * The battles of a replay view that ended by the display time `nowMs` (Task 15 review Minor 2). A battle's log is
 * revealed when the fight starts, so one still in progress (and a fixture's later one) is never offered, nor its
 * server label, which names the outcome. A saved outcome or an unavailable view has none.
 */
export function replayBattles(view: ReplayView, nowMs: number): ReplayBattle[] {
  return view.kind === 'replay' ? view.battles.filter(battle => battleEndMs(battle) <= nowMs) : [];
}

/** One timeline read and nothing else: replays never send commands. */
export async function loadReplayView(gateway: Pick<GameGateway, 'timeline'>, activityId: string, stageId?: string | null): Promise<ReplayView> {
  try {
    return replayViewOf(await gateway.timeline(activityId), stageId);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { kind: 'unavailable', reason: code === 'not-found' ? 'not-found' : 'unavailable' };
  }
}
