import { expect, it } from 'vitest';
import type { PartyAttack, PartyBattleLog, PartyCombatant } from '@contracts/events';
import { groupPartyReplay, reducePartyReplay } from '@/game/party-replay';

const stats = {
  classId: 'guardian', stance: 'balanced', attributes: { strength: 4, agility: 3, vitality: 5, endurance: 4, precision: 3 },
  armor: 2, weaponDamage: 8, attackIntervalMs: 1_000, efficiencyBasisPoints: 10_000, equipmentSilhouettes: [],
} as const;
const party = [
  { ...stats, id: 'aster', gladiatorId: 'aster', name: 'Aster', side: 0, role: 'gladiator', seat: 0, initialHealth: 13, maxHealth: 40 },
  { ...stats, id: 'grit', gladiatorId: 'grit', name: 'Grit', side: 0, role: 'bot', seat: 1, initialHealth: 31, maxHealth: 45 },
  { ...stats, id: 'hireling:2', gladiatorId: null, name: 'Guard', side: 0, role: 'hireling', seat: 2, initialHealth: 9, maxHealth: 36 },
  { ...stats, id: 'creature:dire-wolf', gladiatorId: null, name: 'Alpha of the Den', side: 1, role: 'major', seat: null, initialHealth: 28, maxHealth: 65 },
] satisfies PartyCombatant[];
const major = 'creature:dire-wolf';

function hit(sequence: number, elapsedMs: number, attackerId: string, defenderId: string,
  damage: number, healthBefore: number, healthAfter: number, sweep = false): PartyAttack {
  return { kind: 'attack', sequence, elapsedMs, attackerId, defenderId, damage, healthBefore, healthAfter, sweep,
    hit: true, critical: false, defend: false, evade: false };
}

const sweepLog: PartyBattleLog = {
  battleId: 'wolf-den:major', rulesVersion: 'v2', participants: party,
  events: [
    hit(0, 1_000, major, 'aster', 24, 13, 0, true),
    hit(1, 1_000, major, 'grit', 24, 31, 7, true),
    hit(2, 1_000, major, 'hireling:2', 24, 9, 0, true),
    hit(3, 1_400, 'grit', major, 30, 28, 0),
    { kind: 'victory', sequence: 4, elapsedMs: 1_400, winnerSide: 0, reason: 'defeat' },
  ],
  durationMs: 1_400, winnerSide: 0, victoryReason: 'defeat', finalHp: [0, 7, 0, 0], tieBreakReason: null,
};

it('takes initial and maximum health from the recorded lineup', () => {
  expect(reducePartyReplay(sweepLog, 0)).toMatchObject({
    throughMs: 0, hp: [13, 31, 9, 28], maxHp: [40, 45, 36, 65], groupIndex: -1, group: null,
    appliedEvents: 0, finished: false, result: null,
  });
});

it('groups all same-time events in log order, including a victory at the final hit', () => {
  const groups = groupPartyReplay(sweepLog);
  expect(groups.map(group => [group.index, group.elapsedMs, group.events.map(event => event.sequence)])).toEqual([
    [0, 1_000, [0, 1, 2]], [1, 1_400, [3, 4]],
  ]);
  expect(groups[0].events).toMatchObject([
    { defenderId: 'aster', sweep: true }, { defenderId: 'grit', sweep: true }, { defenderId: 'hireling:2', sweep: true },
  ]);
});

it('applies the entire sweep at its timestamp and reconstructs the same frame after seeking back', () => {
  expect(reducePartyReplay(sweepLog, 999)).toMatchObject({ hp: [13, 31, 9, 28], appliedEvents: 0 });
  const sweep = reducePartyReplay(sweepLog, 1_000);
  expect(sweep).toMatchObject({
    hp: [0, 7, 0, 28], groupIndex: 0, group: { elapsedMs: 1_000 }, appliedEvents: 3, finished: false, result: null,
  });
  expect(reducePartyReplay(sweepLog, 1_001)).toEqual({ ...sweep, throughMs: 1_001 });
  expect(reducePartyReplay(sweepLog, 1_400).hp).toEqual([0, 7, 0, 0]);
  expect(reducePartyReplay(sweepLog, 1_000)).toEqual(sweep);
});

it('uses recorded healthAfter during play and the recorded final snapshot at victory', () => {
  // Reveal validation retains the authoritative HP fields separately from the displayed damage.
  const log: PartyBattleLog = {
    ...sweepLog, participants: [party[0], party[3]], durationMs: 2_000,
    events: [hit(0, 1_000, major, 'aster', 5, 13, 12),
      { kind: 'victory', sequence: 1, elapsedMs: 2_000, winnerSide: 1, reason: 'health-fraction' }],
    winnerSide: 1, victoryReason: 'health-fraction', finalHp: [10, 28],
  };
  expect(reducePartyReplay(log, 1_000).hp).toEqual([12, 28]);
  expect(reducePartyReplay(log, Infinity)).toMatchObject({
    throughMs: 2_000, hp: [10, 28], maxHp: [40, 65], appliedEvents: 2, finished: true,
    result: { winnerSide: 1, victoryReason: 'health-fraction', tieBreakReason: null },
  });
});

it('retains the logged winner and tie-break reason when both sides finish at zero HP', () => {
  const log: PartyBattleLog = {
    ...sweepLog, participants: [party[0], party[3]], durationMs: 1_000,
    events: [hit(0, 1_000, major, 'aster', 13, 13, 0), hit(1, 1_000, 'aster', major, 28, 28, 0),
      { kind: 'victory', sequence: 2, elapsedMs: 1_000, winnerSide: 0, reason: 'tie-break' }],
    winnerSide: 0, victoryReason: 'tie-break', finalHp: [0, 0], tieBreakReason: 'simultaneous-defeat',
  };
  expect(reducePartyReplay(log, 1_000)).toMatchObject({
    hp: [0, 0], finished: true, result: { winnerSide: 0, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' },
  });
});
