import { expect, it } from 'vitest';
import type { PartyAttack, PartyBattleLog, PartyCombatant } from '@contracts/events';
import { reducePartyReplay } from '@/game/party-replay';
import { planPartyStage } from '@/game/party-stage';

const stats = {
  classId: 'guardian', stance: 'balanced', attributes: { strength: 4, agility: 3, vitality: 5, endurance: 4, precision: 3 },
  maxHealth: 40, initialHealth: 40, armor: 2, weaponDamage: 8, attackIntervalMs: 1_000, efficiencyBasisPoints: 10_000,
  equipmentSilhouettes: [],
} as const;
const participants = [
  { ...stats, id: 'aster', gladiatorId: 'aster', name: 'Aster', side: 0, role: 'gladiator', seat: 0 },
  { ...stats, id: 'grit', gladiatorId: 'grit', name: 'Grit', side: 0, role: 'bot', seat: 1, botTeam: 'ludus-nimbus' },
  { ...stats, id: 'hireling:2', gladiatorId: null, name: 'Guard', side: 0, role: 'hireling', seat: 2 },
  { ...stats, id: 'creature:rock-troll:0', gladiatorId: null, name: 'Rock troll', side: 1, role: 'monster', seat: null, initialHealth: 25 },
  { ...stats, id: 'creature:rock-troll:1', gladiatorId: null, name: 'Rock troll', side: 1, role: 'monster', seat: null, initialHealth: 20 },
  { ...stats, id: 'creature:frost-troll:2', gladiatorId: null, name: 'Frost troll', side: 1, role: 'monster', seat: null, initialHealth: 20 },
] satisfies PartyCombatant[];
const knockout: PartyAttack = {
  kind: 'attack', sequence: 0, elapsedMs: 1_000, attackerId: 'creature:rock-troll:0', defenderId: 'aster',
  hit: true, critical: true, defend: false, evade: false, damage: 41, healthBefore: 40, healthAfter: 0, sweep: false,
};
const room: PartyBattleLog = {
  battleId: 'troll-hall:room-2', rulesVersion: 'v2', participants, durationMs: 2_000,
  events: [
    knockout,
    { kind: 'victory', sequence: 1, elapsedMs: 2_000, winnerSide: 0, reason: 'health-fraction' },
  ],
  winnerSide: 0, victoryReason: 'health-fraction', finalHp: [0, 40, 40, 25, 20, 20], tieBreakReason: null,
};
const phone = { width: 360, height: 740 };
const closeup = { width: 332, height: 296 };

// These are full 64 px atlas frames, with feet at (32, 58) before scaling.
function bounds(unit: ReturnType<typeof planPartyStage>['units'][number]) {
  return { left: unit.x - 32 * unit.scale, top: unit.y - 58 * unit.scale,
    right: unit.x + 32 * unit.scale, bottom: unit.y + 6 * unit.scale };
}

it('fits three against three at an integer scale of at least 2 without overlap on a 360 × 740 phone', () => {
  const { scale, units } = planPartyStage(room, phone);
  expect(scale).toBeGreaterThanOrEqual(2);
  expect(Number.isInteger(scale)).toBe(true);
  expect(units).toHaveLength(6);
  const boxes = units.map(unit => {
    expect([unit.x, unit.y, unit.scale].every(Number.isInteger)).toBe(true);
    const box = bounds(unit);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(phone.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(phone.height);
    return box;
  });
  for (const [index, a] of boxes.entries()) {
    for (const b of boxes.slice(index + 1)) {
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
  }
});

it('keeps all frames inside the approved phone battlefield at 2× or larger', () => {
  const { scale, units } = planPartyStage(room, closeup);
  expect(scale).toBeGreaterThanOrEqual(2);
  for (const unit of units) {
    const box = bounds(unit);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(closeup.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(closeup.height);
  }
});

it('draws the major one integer scale larger than a monster', () => {
  const major: PartyCombatant = { ...participants[5], id: 'creature:frost-troll:major', name: 'Troll king', role: 'major' };
  const roomLayout = planPartyStage(room, closeup);
  const majorLog: PartyBattleLog = {
    ...room, battleId: 'troll-hall:major', participants: [...participants.slice(0, 3), major],
    events: [{ ...knockout, attackerId: major.id }, room.events[1]],
    finalHp: [0, 40, 40, 20],
  };
  const majorLayout = planPartyStage(majorLog, closeup);
  expect(roomLayout.units).toHaveLength(6);
  expect(majorLayout.units).toHaveLength(4);
  const boss = majorLayout.units[3];
  expect(boss).toMatchObject({ id: major.id, scale: roomLayout.units[5].scale + 1, facing: 'left', hired: false });
  expect(bounds(boss).right).toBeLessThanOrEqual(closeup.width);
  expect(bounds(boss).top).toBeGreaterThanOrEqual(0);
});

it('keeps sides facing inward and identifies hirelings without mislabeling a bot', () => {
  const { units } = planPartyStage(room, phone);
  expect(units.map(({ id, facing, hired }) => [id, facing, hired])).toEqual([
    ['aster', 'right', false], ['grit', 'right', false], ['hireling:2', 'right', true],
    ['creature:rock-troll:0', 'left', false], ['creature:rock-troll:1', 'left', false], ['creature:frost-troll:2', 'left', false],
  ]);
  expect(units.slice(0, 3).every(unit => unit.x < phone.width / 2)).toBe(true);
  expect(units.slice(3).every(unit => unit.x > phone.width / 2)).toBe(true);
});

it('keeps a fallen fighter in their own fight and uses the next log’s seats and starting health', () => {
  const earlier = planPartyStage(room, phone);
  expect(earlier.units[0]?.id).toBe('aster');
  expect(reducePartyReplay(room, 2_000)).toMatchObject({ hp: [0, 40, 40, 25, 20, 20], result: { winnerSide: 0 } });
  const next: PartyBattleLog = { ...room, battleId: 'troll-hall:room-3',
    participants: [{ ...participants[1], initialHealth: 12 }, { ...participants[2], initialHealth: 21 },
      { ...participants[3], initialHealth: 10 }],
    events: [{ kind: 'victory', sequence: 0, elapsedMs: 2_000, winnerSide: 0, reason: 'health-fraction' }],
    finalHp: [12, 21, 10],
  };
  const later = planPartyStage(next, phone);
  expect(later.units.map(unit => unit.id)).toEqual(['grit', 'hireling:2', 'creature:rock-troll:0']);
  expect(later.units.slice(0, 2)).toEqual(earlier.units.slice(1, 3));
  expect(reducePartyReplay(next, 0).hp).toEqual([12, 21, 10]);
});
