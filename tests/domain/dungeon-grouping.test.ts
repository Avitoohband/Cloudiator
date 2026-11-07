import { describe, expect, it } from 'vitest';
import { groupDungeon, partitionByStrength, type DungeonEntrant, type DungeonGroupingInput } from '@domain/dungeon-grouping.ts';
import { estimateArenaStrengthCents } from '@domain/arena.ts';
import type { FighterSnapshot } from '@domain/types.ts';
import { seededRandom } from '@domain/random.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import { representativeBuild } from '../fixtures/dungeon-builds.ts';

function entrant(id: string, addedVitality = 0): DungeonEntrant {
  const build = representativeBuild('guardian', 3);
  return {
    gladiatorId: id, activityId: `activity-${id}`, name: `Fighter ${id}`, level: 3,
    build: { ...build, allocations: { ...build.allocations, vitality: build.allocations.vitality + addedVitality } },
  };
}

const input = (entrants: readonly DungeonEntrant[]): DungeonGroupingInput =>
  ({ kind: 'dungeon-grouping', slotIndex: 1, dungeonId: 'wolf-den', rulesVersion: 'v2', entrants });

describe('dungeon strength bands', () => {
  it('returns the original strength cents before converting to display precision', () => {
    const fighter: FighterSnapshot = {
      rulesVersion: 'v2', classId: null, stance: 'balanced',
      attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 },
      maxHealth: 127_000_000_000_002, armor: 0, weaponDamage: 1, baseDamage: 1,
      attackIntervalMs: 1000, efficiency: 1, equipmentSilhouettes: [],
    };
    expect(estimateArenaStrengthCents(fighter)).toBe(8_916_987_500_000_140);
  });

  it.each([
    { cents: [100, 40, 35], expected: [[0], [1, 2]] },
    { cents: [100, 50], expected: [[0, 1]] },
    { cents: [101, 50], expected: [[0], [1]] },
    { cents: [100, 51, 49], expected: [[0, 1], [2]] },
    { cents: [100, 100, 100, 100, 100, 100, 100], expected: [[0, 1, 2], [3, 4], [5, 6]] },
  ])('partitions $cents against the strongest in each band', ({ cents, expected }) => {
    expect(partitionByStrength(cents, 2)).toEqual(expected);
  });

  it.each([
    { count: 1, expected: [1] }, { count: 2, expected: [2] }, { count: 3, expected: [3] },
    { count: 4, expected: [2, 2] }, { count: 5, expected: [3, 2] }, { count: 6, expected: [3, 3] },
  ])('balances $count equal entrants with larger groups first', ({ count, expected }) => {
    expect(partitionByStrength(Array<number>(count).fill(100), 2).map(group => group.length)).toEqual(expected);
  });
});

describe('dungeon grouping', () => {
  it('puts the stronger frozen builds first regardless of input order', () => {
    // Same class, gear, stance and attack stats. More vitality means more HP and a greater strength estimate.
    const weak = entrant('a');
    const middle = entrant('b', 2);
    const strong = entrant('c', 4);
    for (const entrants of [[weak, strong, middle], [middle, weak, strong]]) {
      const { runs } = groupDungeon(input(entrants), 'strength-order', RULES_V2);
      expect(runs.map(run => run.seats.map(seat => seat.kind === 'human' ? seat.gladiatorId : seat.kind)))
        .toEqual([['c', 'b', 'a']]);
    }
  });

  it('uses the private per-gladiator draw to break strength ties', () => {
    const entrants = ['a', 'b', 'c', 'd'].map(id => entrant(id));
    const seed = 'equal-strength';
    const draw = (id: string) => seededRandom(`${seed}:dungeon:${id}`)();
    const drawn = [...entrants].sort((a, b) => {
      const left = a.gladiatorId, right = b.gladiatorId;
      return draw(left) - draw(right) || (left < right ? -1 : left > right ? 1 : 0);
    });
    const shuffled = [entrants[2], entrants[0], entrants[3], entrants[1]];
    const result = groupDungeon(input(shuffled), seed, RULES_V2);
    expect(result).toEqual(groupDungeon(input([...shuffled].reverse()), seed, RULES_V2));
    expect(result.runs.map(({ seats }) => seats.flatMap(seat => seat.kind === 'human' ? [seat.gladiatorId] : [])))
      .toEqual([[drawn[0].gladiatorId, drawn[1].gladiatorId], [drawn[2].gladiatorId, drawn[3].gladiatorId]]);
  });

  it('numbers balanced runs and seats and copies the frozen humans exactly', () => {
    const strongest = entrant('d', 6), next = entrant('c', 4), third = entrant('b', 2), last = entrant('a');
    expect(groupDungeon(input([last, strongest, third, next]), 'numbered-runs', RULES_V2)).toEqual({
      runs: [
        { runId: 'dungeon:1:wolf-den:1', seats: [
          { ...strongest, kind: 'human', seat: 0 },
          { ...next, kind: 'human', seat: 1 },
          { kind: 'hireling', seat: 2, role: 'striker' },
        ] },
        { runId: 'dungeon:1:wolf-den:2', seats: [
          { ...third, kind: 'human', seat: 0 },
          { ...last, kind: 'human', seat: 1 },
          { kind: 'hireling', seat: 2, role: 'striker' },
        ] },
      ],
    });
  });

  it('keeps the rolled build values without freezing the input build', () => {
    const entrantBefore = entrant('rolled');
    const weapon = entrantBefore.build.equipment.weapon!;
    const build = { ...entrantBefore.build, equipment: { ...entrantBefore.build.equipment,
      weapon: { ...weapon, stats: { ...weapon.stats, damage: weapon.stats.damage + 0.01 } } } };
    const { runs } = groupDungeon(input([{ ...entrantBefore, build }]), 'rolled', RULES_V2);
    expect(runs[0].seats[0]).toEqual({ ...entrantBefore, build, kind: 'human', seat: 0 });
    expect(Object.isFrozen(build.equipment.weapon.stats)).toBe(false);
  });

  const first = entrant('a');
  const second = entrant('b');
  const valid = input([first, second]);

  it.each([
    { reason: 'a locked dungeon for the entrant level', snapshot: input([{ ...first, level: 2 }]) },
    { reason: 'a repeated gladiator', snapshot: input([first, { ...second, gladiatorId: first.gladiatorId }]) },
    { reason: 'a repeated activity', snapshot: input([first, { ...second, activityId: first.activityId }]) },
    { reason: 'the wrong discriminator', snapshot: { ...valid, kind: 'dungeon' } },
    { reason: 'the wrong frozen rules version', snapshot: { ...valid, rulesVersion: 'v1' } },
    { reason: 'the wrong frozen build version', snapshot: input([{ ...first, build: { ...first.build, rulesVersion: 'v1' } }]) },
    { reason: 'an unknown dungeon id', snapshot: { ...valid, dungeonId: 'dragon-lair' } },
    { reason: 'a malformed entrant list', snapshot: { ...valid, entrants: [null] } },
    { reason: 'an incomplete equipment record', snapshot: { ...valid, entrants: [{ ...first, build: { ...first.build, equipment: {} } }] } },
  ])('rejects $reason', ({ snapshot }) => {
    expect(() => groupDungeon(snapshot as unknown as DungeonGroupingInput, 'malformed', RULES_V2)).toThrow(RangeError);
  });

  it('rejects a dungeon grouping under the retained v1 rules', () => {
    expect(() => groupDungeon({ ...valid, rulesVersion: 'v1' }, 'retained-v1', RULES_V1)).toThrow(RangeError);
  });
});
