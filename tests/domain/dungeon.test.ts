import { afterEach, expect, it, vi } from 'vitest';
import type { PartyBattleLog } from '@contracts/events.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { makeFighter } from '@domain/combat.ts';
import { dungeonChestLoot, dungeonPartyLabel, hiredFighter, hiredRolesFor, monsterFighter,
  planDungeonRun, type DungeonRunInput } from '@domain/dungeon.ts';
import { dungeonReward } from '@domain/economy.ts';
import { simulateSkirmish, type SkirmishInput } from '@domain/party-combat.ts';
import { seededRandom } from '@domain/random.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { cappedDungeonBuild, partyInput } from '../fixtures/dungeon-builds.ts';

vi.mock('@domain/party-combat.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@domain/party-combat.ts')>();
  return { ...actual, simulateSkirmish: vi.fn(actual.simulateSkirmish) };
});
const simulate = vi.mocked(simulateSkirmish);
const realSkirmish = simulate.getMockImplementation()!;
afterEach(() => { simulate.mockReset(); simulate.mockImplementation(realSkirmish); });

/** Script only the engine/planner boundary. Task 1's tests own the combat events leading to each result. */
function scriptedFight(input: SkirmishInput, winnerSide: 0 | 1, allFallen = false): PartyBattleLog {
  const participants = input.units.map(unit => ({
    id: unit.id, gladiatorId: unit.gladiatorId, name: unit.name, role: unit.role, side: unit.side, seat: unit.seat,
    classId: unit.snapshot.classId, stance: unit.snapshot.stance, attributes: unit.snapshot.attributes,
    maxHealth: unit.snapshot.maxHealth, initialHealth: unit.startingHealth ?? unit.snapshot.maxHealth,
    armor: unit.snapshot.armor, weaponDamage: unit.snapshot.weaponDamage, attackIntervalMs: unit.snapshot.attackIntervalMs,
    efficiencyBasisPoints: Math.round(unit.snapshot.efficiency * 10_000),
    equipmentSilhouettes: unit.snapshot.equipmentSilhouettes,
  }));
  const durationMs = 10_000;
  const victoryReason = allFallen ? 'tie-break' : 'defeat';
  return { battleId: input.battleId, rulesVersion: input.rulesVersion, participants,
    events: [{ kind: 'victory', sequence: 0, elapsedMs: durationMs, winnerSide, reason: victoryReason }],
    durationMs, winnerSide, victoryReason, tieBreakReason: allFallen ? 'simultaneous-defeat' : null,
    finalHp: participants.map(participant => !allFallen && participant.side === winnerSide ? participant.initialHealth : 0) };
}

function forceFights(winners: readonly (0 | 1)[]) {
  for (const winner of winners) simulate.mockImplementationOnce(input => scriptedFight(input, winner));
}

const WOLF = 'wolf-den';
const SLOT_MS = 4_800_000;
const interval = 960_000;
const solo = () => partyInput(WOLF, [{ classId: 'duelist', level: 3 }], 'dungeon:1:wolf-den:1');
const trio = () => partyInput(WOLF, [
  { classId: 'berserker', level: 3 }, { classId: 'guardian', level: 3 }, { classId: 'duelist', level: 3 },
], 'dungeon:1:wolf-den:1');

function withFrozenLevels(input: DungeonRunInput, levels: readonly number[]): DungeonRunInput {
  return { ...input, seats: input.seats.map(seat => seat.kind === 'human' ? { ...seat, level: levels[seat.seat] } : seat) };
}

it('pays an all-fallen room win and stops at the safe point', () => {
  const input = solo();
  simulate.mockImplementationOnce(fight => scriptedFight(fight, 0, true));
  const plan = planDungeonRun(input, 'all-fallen', RULES_V2);
  expect(simulate).toHaveBeenCalledTimes(1);
  expect(plan.fights.map(({ ordinal, won }) => [ordinal, won])).toEqual([[1, true]]);
  expect(plan.outcomes).toHaveLength(1);
  expect(plan.outcomes[0]).toMatchObject({ entered: [1], won: [1], result: 'defeat', success: false,
    rewards: { xp: 6, money: 1, loot: [] } });
  expect(plan.stages.map(({ kind }) => kind)).toEqual(['depart', 'room', 'return', 'return']);
  expect(plan.stages[2]).toMatchObject({ label: 'Rest at the safe return point',
    startedAtMs: input.startsAtMs + interval + 10_000, endsAtMs: input.startsAtMs + SLOT_MS });
});

it('uses the frozen band and floors the combined won-room payout once', () => {
  const input = withFrozenLevels(trio(), [8, 9, 8]);
  forceFights([0, 0, 0, 1]);
  const { outcomes } = planDungeonRun(input, 'floor-after-summing', RULES_V2);
  expect(outcomes).toHaveLength(3);
  expect(outcomes[0]).toMatchObject({ entered: [1, 2, 3, 4], won: [1, 2, 3], overLevel: false,
    success: false, rewards: { xp: 18, money: 3, loot: [] } });
  expect(outcomes[1]).toMatchObject({ entered: [1, 2, 3, 4], won: [1, 2, 3], overLevel: true,
    success: false, rewards: { xp: 9, money: 1, loot: [] } });
});

it('uses an independent seeded chest for each member and no gear draws over the band', () => {
  const input = withFrozenLevels(trio(), [8, 8, 9]);
  const reward = dungeonReward(RULES_V2, WOLF);
  const salvage = [{ catalogId: 'salvage', catalogVersion: CATALOG_V1.version, quantity: 1, origin: 'expedition' }];
  const expectedLoot = (seed: string) => input.seats.slice(0, 2).map(seat => {
    if (seat.kind !== 'human') throw new Error('Expected the fixture to have three humans');
    return dungeonChestLoot(reward, CATALOG_V1, seededRandom(`${seed}:loot:${seat.gladiatorId}`), false);
  });
  // Choose a discriminating seed: one eligible member gets gear and the other does not.
  const seed = Array.from({ length: 200 }, (_, i) => `chests:${i}`).find(value => {
    const [first, second] = expectedLoot(value);
    return first.length !== second.length;
  });
  if (!seed) throw new Error('No discriminating per-member loot seed in the fixture range');

  forceFights([0, 0, 0, 0]);
  const { outcomes } = planDungeonRun(input, seed, RULES_V2);
  expect(outcomes.slice(0, 2).map(outcome => outcome.rewards.loot)).toEqual(expectedLoot(seed));
  expect(outcomes[2]).toMatchObject({ overLevel: true, result: 'victory', success: true,
    rewards: { xp: 24, money: 4, loot: salvage } });
  const random = vi.fn(() => 0); // This would otherwise guarantee gear.
  expect(dungeonChestLoot(reward, CATALOG_V1, random, true)).toEqual(salvage);
  expect(random).not.toHaveBeenCalled();
});

it('uses stable fight seeds, ids and stage offsets on repeated runs', () => {
  const input = solo();
  const seed = 'fixed-run';
  forceFights([0, 0, 0, 0]);
  const plan = planDungeonRun(input, seed, RULES_V2);
  expect(simulate.mock.calls.map(([fight, fightSeed]) => [fight.battleId, fightSeed])).toEqual(
    [1, 2, 3, 4].map(n => [`${input.runId}:fight:${n}`, `${seed}:fight:${n}`]));
  expect(plan.fights.map(fight => fight.offsetMs)).toEqual([interval, 2 * interval, 3 * interval, 4 * interval]);
  const stageOffsets = [0, interval, interval + 10_000, 2 * interval, 2 * interval + 10_000,
    3 * interval, 3 * interval + 10_000, 4 * interval, 4 * interval + 10_000, SLOT_MS];
  expect(plan.stages.map(stage => stage.startedAtMs - input.startsAtMs)).toEqual(stageOffsets);
  expect(plan.stages.map(stage => stage.revealedAtMs)).toEqual(plan.stages.map(stage => stage.startedAtMs));
  expect(plan.stages.map(stage => stage.id)).toEqual(stageOffsets.map((_, ordinal) => `${input.runId}:${ordinal}`));
  expect(plan.stages.flatMap(stage => stage.fight ? [stage.fight] : [])).toEqual(
    [1, 2, 3, 4].map(ordinal => ({ runId: input.runId, ordinal })));
  expect(plan.stages.every(stage => !Object.hasOwn(stage, 'battleLog'))).toBe(true);
  forceFights([0, 0, 0, 0]);
  expect(planDungeonRun(input, seed, RULES_V2)).toEqual(plan);
});

it('derives the hired kits and discounts only maximum health and base damage', () => {
  const roles = ['guard', 'striker', 'skirmisher'] as const;
  const dungeons = ['wolf-den', 'raider-stronghold', 'troll-hall'] as const;
  const stats = dungeons.map(id => roles.map(role => {
    const f = hiredFighter(CATALOG_V1.dungeons[id], role, RULES_V2);
    return [f.maxHealth, f.baseDamage, f.attackIntervalMs, f.armor, f.stance];
  }));
  expect(stats).toEqual([
    [[158, 9.45, 952, 9, 'defensive'], [117, 13.635, 1321, 4, 'offensive'], [99, 9, 905, 4, 'balanced']],
    [[205, 13.05, 952, 13.5, 'defensive'], [153, 19.71, 1308, 6, 'offensive'], [108, 12.6, 872, 6, 'balanced']],
    [[261, 17.55, 952, 18, 'defensive'], [180, 26.775, 1296, 8, 'offensive'], [117, 16.2, 834, 8, 'balanced']],
  ]);
  expect(hiredRolesFor(['balanced'])).toEqual(['guard', 'striker']);
  expect(hiredRolesFor(['defensive'])).toEqual(['striker', 'skirmisher']);
  expect(hiredRolesFor(['offensive', 'defensive'])).toEqual(['skirmisher']);
  expect(hiredRolesFor(['balanced', 'balanced'])).toEqual(['guard']);
});

it('rolls exact gear thresholds, skips renown and orders candidates by id', () => {
  const reward = dungeonReward(RULES_V2, WOLF);
  const chest = (...rolls: number[]) => dungeonChestLoot(reward, CATALOG_V1, () => {
    const roll = rolls.shift();
    if (roll === undefined) throw new Error('Unexpected additional loot draw');
    return roll;
  }, false);
  expect(chest(.3).map(item => item.catalogId)).toEqual(['salvage']);
  expect(chest(.29999, .39999, 0).map(item => item.catalogId)).toEqual(['salvage', 'axe:1:common']);
  expect(chest(0, .4, .99999).map(item => item.catalogId)).toEqual(['salvage', 'sword:1:uncommon']);
  expect(chest(0, .84999, 0).map(item => item.catalogId)).toEqual(['salvage', 'axe:1:uncommon']);
  expect(chest(0, .85, 0).map(item => item.catalogId)).toEqual(['salvage', 'axe:1:rare']);
});

it('hands the real engine the frozen humans and the room in stable order', () => {
  const original = trio();
  const input: DungeonRunInput = { ...original, seats: original.seats.map(seat => {
    if (seat.kind !== 'human') throw new Error('Expected a human');
    const { body, feet, head, weapon, offHand } = seat.build.equipment;
    // Frozen JSON objects can arrive in a different order from the build validator's fixed slot list.
    return { ...seat, build: { ...seat.build, equipment: { body, feet, head, weapon, offHand } } };
  }) };
  const dungeon = CATALOG_V1.dungeons[WOLF];
  const seed = 'room-one-engine';
  const units: SkirmishInput['units'] = [
    ...input.seats.map(seat => {
      if (seat.kind !== 'human') throw new Error('Expected humans');
      return { id: seat.gladiatorId, gladiatorId: seat.gladiatorId, name: seat.name, side: 0 as const,
        role: 'gladiator' as const, seat: seat.seat, snapshot: makeFighter(seat.build, 'expedition', RULES_V2) };
    }),
    ...dungeon.rooms[0].map((monster, index) => ({ id: `creature:timber-wolf:1:${index + 1}`, gladiatorId: null,
      name: monster.name, side: 1 as const, role: 'monster' as const, seat: null, snapshot: monsterFighter(monster, RULES_V2) })),
  ];
  const plan = planDungeonRun(input, seed, RULES_V2);
  expect(plan.fights[0].log).toEqual(realSkirmish({ battleId: `${input.runId}:fight:1`, rulesVersion: 'v2',
    rules: RULES_V2, units }, `${seed}:fight:1`));
  expect(planDungeonRun(input, seed, RULES_V2)).toEqual(plan);
  expect(plan.fights[0].log.participants[0]).not.toHaveProperty('snapshot');
  expect(Object.isFrozen(plan.fights[0].log.participants[0])).toBe(true);
  expect(Object.isFrozen(input.seats[0])).toBe(false);
});

it('recovers standing fighters between rooms and never pays an absent member', () => {
  const input = partyInput('troll-hall', [
    { classId: 'guardian', level: 12 }, { classId: 'berserker', level: 15 }, { classId: 'duelist', level: 15 },
  ], 'dungeon:1:troll-hall:1');
  const first = input.seats[0];
  if (first.kind !== 'human') throw new Error('Expected a human');
  const weak: DungeonRunInput = { ...input, seats: [{ ...first, build: { ...first.build,
    allocations: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 },
    equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } } }, ...input.seats.slice(1).map(seat => {
    if (seat.kind !== 'human') throw new Error('Expected a human');
    return { ...seat, build: cappedDungeonBuild(seat.build.classId, 15) };
  })] };
  const plan = Array.from({ length: 200 }, (_, i) => `fall:${i}`).map(seed => planDungeonRun(weak, seed, RULES_V2))
    .find(result => result.fights.at(-1)?.ordinal === 4 && result.fights.at(-1)?.won && !result.outcomes[0].success);
  if (!plan) throw new Error('Expected a real fight seed where the weak member falls and the party continues');
  const member = plan.outcomes[0];
  expect(member.entered).toEqual([1, 2, 3, 4].slice(0, member.entered.length));
  expect(member.entered.length).toBeLessThan(4);
  expect(member.won).toEqual(member.entered);
  expect(member.rewards).toEqual({ xp: member.entered.length * 30, money: member.entered.length * 4, loot: [] });
  for (let i = 1; i < plan.fights.length; i++) {
    const previous = plan.fights[i - 1].log;
    const next = plan.fights[i].log;
    expect(next.participants.filter(p => p.side === 0).map(p => [p.id, p.initialHealth])).toEqual(
      previous.participants.flatMap((p, index) => p.side === 0 && previous.finalHp[index] > 0
        ? [[p.id, Math.min(p.maxHealth, previous.finalHp[index] + Math.floor(p.maxHealth * .2))]] : []));
  }
});

it('labels the party and a lost major, while paying three actual room wins', () => {
  const input = partyInput(WOLF, [{ classId: 'duelist', level: 3 }, { classId: 'berserker', level: 3 }], 'dungeon:1:wolf-den:1');
  expect(dungeonPartyLabel(CATALOG_V1.dungeons[WOLF], input.seats)).toBe('Enter Wolf Den with Ari, Bo and a hired Guard');
  expect(dungeonPartyLabel(CATALOG_V1.dungeons[WOLF], solo().seats)).toBe('Enter Wolf Den with Ari, a hired Guard and a hired Striker');
  const plan = Array.from({ length: 100 }, (_, i) => `major-loss:${i}`).map(seed => planDungeonRun(input, seed, RULES_V2))
    .find(result => result.fights.at(-1)?.ordinal === 4 && result.fights.at(-1)?.won === false && result.outcomes.every(o => o.entered.length === 4));
  if (!plan) throw new Error('Expected a real fight seed with three rooms won and the major lost');
  expect(plan.outcomes).toHaveLength(2);
  for (const outcome of plan.outcomes) expect(outcome).toMatchObject({ result: 'defeat', success: false, rewards: { xp: 18, money: 3, loot: [] } });
  expect(plan.stages.map(stage => stage.label)).toEqual(['Enter Wolf Den with Ari, Bo and a hired Guard', 'Room 1: victory',
    'Recover and go deeper', 'Room 2: victory', 'Recover and go deeper', 'Room 3: victory', 'Recover and go deeper',
    'Alpha of the Den: defeat', 'Rest at the safe return point', 'Arrive at camp']);
});

it('keeps Troll Hall rewards in full at high levels', () => {
  const input = withFrozenLevels(partyInput('troll-hall', [{ classId: 'guardian', level: 12 }], 'dungeon:1:troll-hall:1'), [30]);
  forceFights([0, 0, 0, 0]);
  expect(planDungeonRun(input, 'troll-high-level', RULES_V2).outcomes[0]).toMatchObject({
    overLevel: false, success: true, rewards: { xp: 240, money: 30 },
  });
});

it('rejects mixed versions, malformed seats and invalid frozen builds before fighting', () => {
  const input = solo();
  const [first, second, third] = input.seats;
  if (first.kind !== 'human') throw new Error('Expected a human');
  const { weapon } = first.build.equipment;
  if (!weapon) throw new Error('Expected a weapon');
  const malformed: DungeonRunInput[] = [
    { ...input, dungeonId: 'toString' as DungeonRunInput['dungeonId'] }, { ...input, rulesVersion: 'v1' },
    { ...input, seats: [first, second] }, { ...input, seats: [first, third, second] },
    { ...input, seats: [{ seat: 0, kind: 'hireling', role: 'guard' }, second, third] },
    { ...input, seats: [first, { ...first, seat: 1 }, third] },
    { ...input, seats: [{ ...first, level: 2 }, second, third] },
    { ...input, seats: [{ ...first, build: { ...first.build, rulesVersion: 'v1' } }, second, third] },
    { ...input, seats: [{ ...first, build: { ...first.build, equipment: {} as typeof first.build.equipment } }, second, third] },
    { ...input, seats: [{ ...first, build: { ...first.build, equipment: { ...first.build.equipment,
      weapon: { ...weapon, origin: 'invalid' as typeof weapon.origin } } } }, second, third] },
    { ...input, seats: [{ ...first, build: { ...first.build,
      allocations: { ...first.build.allocations, vitality: -1 } } }, second, third] },
  ];
  for (const bad of malformed) expect(() => planDungeonRun(bad, 'reject', RULES_V2)).toThrow(RangeError);
  expect(() => planDungeonRun(input, 'reject', RULES_V1)).toThrow(RangeError);
  expect(() => planDungeonRun(input, 'reject', { ...RULES_V2 })).toThrow(RangeError);
  expect(simulate).not.toHaveBeenCalled();
});
