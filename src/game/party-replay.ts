import type { PartyAttack, PartyBattleLog, PartyVictory } from '@contracts/events';

export type PartyReplayEvent = Readonly<PartyAttack> | Readonly<PartyVictory>;
export type PartyReplayGroup = {
  readonly index: number;
  readonly elapsedMs: number;
  readonly events: readonly PartyReplayEvent[];
};
export type PartyReplayResult = {
  readonly winnerSide: PartyBattleLog['winnerSide'];
  readonly victoryReason: PartyBattleLog['victoryReason'];
  readonly tieBreakReason: PartyBattleLog['tieBreakReason'];
};
export type PartyReplayFrame = {
  /** Log time clamped to the recorded duration. */
  readonly throughMs: number;
  /** Health values are in the original participant order. */
  readonly hp: readonly number[];
  readonly maxHp: readonly number[];
  readonly groupIndex: number;
  readonly group: PartyReplayGroup | null;
  readonly appliedEvents: number;
  readonly finished: boolean;
  readonly result: PartyReplayResult | null;
};

const groupsByLog = new WeakMap<PartyBattleLog, readonly PartyReplayGroup[]>();

/** The revealed event sequence is chronological. Every event at a timestamp advances as one group. */
export function groupPartyReplay(log: PartyBattleLog): readonly PartyReplayGroup[] {
  const cached = groupsByLog.get(log);
  if (cached) return cached;

  const groups: { index: number; elapsedMs: number; events: PartyReplayEvent[] }[] = [];
  for (const event of log.events) {
    let group = groups.at(-1);
    if (group?.elapsedMs !== event.elapsedMs) {
      group = { index: groups.length, elapsedMs: event.elapsedMs, events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  for (const group of groups) {
    Object.freeze(group.events);
    Object.freeze(group);
  }
  Object.freeze(groups);
  groupsByLog.set(log, groups);
  return groups;
}

/** Reconstruct the frame from the log at any position, including after seeking backwards. */
export function reducePartyReplay(log: PartyBattleLog, throughMs: number): PartyReplayFrame {
  const through = Math.min(log.durationMs, Math.max(0, Number.isNaN(throughMs) ? 0 : throughMs));
  const hp = log.participants.map(participant => participant.initialHealth);
  const indices = new Map(log.participants.map((participant, index) => [participant.id, index]));
  let group: PartyReplayGroup | null = null;
  let appliedEvents = 0;
  let result: PartyReplayResult | null = null;

  for (const next of groupPartyReplay(log)) {
    if (next.elapsedMs > through) break;
    group = next;
    appliedEvents += next.events.length;
    for (const event of next.events) {
      if (event.kind === 'victory') {
        result = { winnerSide: event.winnerSide, victoryReason: event.reason, tieBreakReason: log.tieBreakReason };
      } else {
        const defender = indices.get(event.defenderId);
        if (defender !== undefined) hp[defender] = event.healthAfter;
      }
    }
  }

  return {
    throughMs: through,
    hp: result ? [...log.finalHp] : hp,
    maxHp: log.participants.map(participant => participant.maxHealth),
    groupIndex: group?.index ?? -1,
    group,
    appliedEvents,
    finished: result !== null,
    result,
  };
}
