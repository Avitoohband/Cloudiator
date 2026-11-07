import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { dungeonReward } from '@domain/economy.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import type { DungeonId } from '@contracts/commands';
import manifest from '../../public/assets/manifest.json';

// SHA-256 of JSON.stringify on the unmodified 1.8 base 6a3036b.
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const V1_RULES = '22d6600e16dcb46ea7ea621eae9284759bfe5eed023fcf99d5a328b7ad93d2c0';
const V2_RULES = 'a754c6abadb1bf069b95e8db95b1847467c339f3dfbafa1e8383ac1c9d9b6712';
const V1_CATALOG = 'd82b1dc5163ea83b98fa0e31f0c20f935a43afb01b4787b1d3aca311fdcfd6dc';

const attributes = (strength: number, agility: number, vitality: number, endurance: number, precision: number) =>
  ({ strength, agility, vitality, endurance, precision });
const timberWolf = { name: 'Timber wolf', creature: 'timber-wolf', maxHp: 46, damage: 7, intervalMs: 1000,
  armor: 0, stance: 'balanced', attributes: attributes(5, 6, 4, 5, 5) };
const direWolf = { name: 'Dire wolf', creature: 'dire-wolf', maxHp: 69, damage: 9, intervalMs: 1200,
  armor: 2, stance: 'balanced', attributes: attributes(6, 4, 6, 6, 6) };

describe('the dungeon capability', () => {
  it('keeps every pre-existing rule and catalog value', () => {
    const { dungeon: _dungeon, ...v2 } = RULES_V2;
    const { dungeonPhases: _phases, ...schedule } = RULES_V2.schedule;
    const { dungeon: _cost, ...activityStamina } = RULES_V2.activityStamina;
    const { dungeons: _dungeons, ...catalog } = CATALOG_V1;
    expect(hash(RULES_V1)).toBe(V1_RULES);
    expect(hash({ ...v2, schedule, activityStamina })).toBe(V2_RULES);
    expect(hash(catalog)).toBe(V1_CATALOG);
  });

  it('sets the v2 phase, stamina cost, timing, recovery and combat coefficients', () => {
    expect(RULES_V2.schedule.dungeonPhases).toEqual(['afternoon']);
    expect(RULES_V2.activityStamina.dungeon).toBe(40);
    expect(RULES_V2.dungeon).toMatchObject({ seats: 3, fightIntervalMs: 960_000, recovery: 0.2, hiredMultiplier: 0.9,
      targetWeights: { defensive: 3, balanced: 2, offensive: 1 }, sweepEvery: 4, sweepFactor: 0.6, overLevelFactor: 0.5 });
  });

  it('adds the three dungeons with the spec’s numbers', () => {
    const { dungeons } = CATALOG_V1;
    expect(Object.keys(dungeons)).toEqual(['wolf-den', 'raider-stronghold', 'troll-hall']);
    expect(dungeons['wolf-den']).toEqual({
      id: 'wolf-den', name: 'Wolf Den', requiredLevel: 3, fullRewardsMaxLevel: 8, map: 'woodland',
      rooms: [
        [timberWolf, timberWolf, timberWolf],
        [direWolf, direWolf, direWolf],
        [direWolf, direWolf, { name: 'Stalker', creature: 'timber-wolf', maxHp: 52, damage: 12, intervalMs: 1100,
          armor: 0, stance: 'balanced', attributes: attributes(6, 8, 4, 6, 10) }],
      ],
      major: { name: 'Alpha of the Den', creature: 'dire-wolf', maxHp: 754, damage: 16, intervalMs: 1300,
        armor: 4, stance: 'balanced', attributes: attributes(12, 6, 10, 10, 10) },
      hired: {
        guard: { classId: 'guardian', stance: 'defensive', allocations: attributes(4, 0, 7, 2, 1),
          equipment: { weapon: 'sword:1:common', offHand: 'round-shield:1:common', head: 'iron-helmet:1:common',
            body: 'light-armor:1:common', feet: 'light-boots:1:common' } },
        striker: { classId: 'berserker', stance: 'offensive', allocations: attributes(8, 1, 3, 0, 2),
          equipment: { weapon: 'axe:1:common', offHand: null, head: 'leather-hood:1:common',
            body: 'light-armor:1:common', feet: 'light-boots:1:common' } },
        skirmisher: { classId: 'duelist', stance: 'balanced', allocations: attributes(3, 5, 1, 0, 5),
          equipment: { weapon: 'sword:1:common', offHand: null, head: 'leather-hood:1:common',
            body: 'light-armor:1:common', feet: 'light-boots:1:common' } },
      },
    });
    expect(dungeons['raider-stronghold']).toMatchObject({ requiredLevel: 7, fullRewardsMaxLevel: 12, map: 'outpost' });
    expect(dungeons['raider-stronghold'].major).toEqual({ name: 'Raider Warlord', creature: 'raider',
      maxHp: 880, damage: 20, intervalMs: 1300, armor: 6, stance: 'balanced', attributes: attributes(20, 10, 16, 14, 16) });
    expect(dungeons['troll-hall']).toMatchObject({ requiredLevel: 12, fullRewardsMaxLevel: null, map: 'mountain' });
    expect(dungeons['troll-hall'].major).toEqual({ name: 'Troll King', creature: 'rock-troll',
      maxHp: 1230, damage: 19, intervalMs: 1300, armor: 8, stance: 'balanced', attributes: attributes(28, 14, 22, 20, 22) });
  });

  it('draws every monster with a manifest creature', () => {
    const ids = new Set(manifest.actors.creatures.map(({ id }) => id));
    for (const dungeon of Object.values(CATALOG_V1.dungeons)) {
      expect(dungeon.rooms.map(room => room.length)).toEqual([3, 3, 3]);
      for (const monster of [...dungeon.rooms.flat(), dungeon.major]) expect(ids.has(monster.creature), monster.name).toBe(true);
    }
  });

  const payouts = [
    { id: 'wolf-den', room: { xp: 6, money: 1 }, major: { xp: 30, money: 5 }, salvageQuantity: 1, gearTier: 1 },
    { id: 'raider-stronghold', room: { xp: 15, money: 2 }, major: { xp: 75, money: 10 }, salvageQuantity: 2, gearTier: 5 },
    { id: 'troll-hall', room: { xp: 30, money: 4 }, major: { xp: 150, money: 18 }, salvageQuantity: 3, gearTier: 10 },
  ] as const;
  it.each(payouts)('uses the approved v2 payout for $id', ({ id, room, major, salvageQuantity, gearTier }) => {
    expect(dungeonReward(RULES_V2, id)).toEqual({ room, major, chest: { salvageQuantity, gearTier, gearChance: 0.3,
      rarity: { common: 0.4, uncommon: 0.45, rare: 0.15 } } });
    expect(() => dungeonReward(RULES_V1, id)).toThrow(RangeError);
  });

  it('refuses unknown dungeon rewards', () => {
    for (const id of ['dragon-lair', '__proto__', 'constructor']) {
      expect(() => dungeonReward(RULES_V2, id as DungeonId)).toThrow(RangeError);
    }
  });
});
