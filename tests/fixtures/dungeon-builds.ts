import type { ClassId, DungeonId, Stance } from '@contracts/commands.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { hiredRolesFor, type DungeonRunInput, type DungeonSeat } from '@domain/dungeon.ts';
import { trainingCap } from '@domain/economy.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import type { Attributes, BuildSnapshot, EquipmentSlot, ItemInstance } from '@domain/types.ts';

// Preserve prototype key order: equal allocation weights receive leftovers in that order.
const SPLIT: Record<ClassId, Attributes> = {
  berserker: { strength: .5, vitality: .25, precision: .15, agility: .1, endurance: 0 },
  guardian: { vitality: .45, strength: .25, endurance: .2, precision: .1, agility: 0 },
  duelist: { agility: .35, precision: .35, strength: .2, vitality: .1, endurance: 0 },
};
const STANCE: Record<ClassId, Stance> = { berserker: 'offensive', guardian: 'defensive', duelist: 'balanced' };
const LEVELS = {
  1: { points: 10, tier: 1, full: false },
  3: { points: 14, tier: 1, full: true },
  5: { points: 20, tier: 5, full: false },
  7: { points: 25, tier: 5, full: true },
  10: { points: 33, tier: 10, full: false },
  12: { points: 38, tier: 10, full: true },
  15: { points: 45, tier: 10, full: true },
} as const;
export type RepresentativeLevel = keyof typeof LEVELS;

function allocation(classId: ClassId, points: number): Attributes {
  const split = SPLIT[classId];
  const keys = Object.keys(split) as (keyof Attributes)[];
  const result: Attributes = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };
  let used = 0;
  for (const key of keys) {
    result[key] = Math.floor(points * split[key]);
    used += result[key];
  }
  const priority = keys.sort((a, b) => split[b] - split[a]);
  for (let i = 0; used < points; i++, used++) result[priority[i % priority.length]]++;
  return result;
}

function item(id: string): ItemInstance {
  const entry = CATALOG_V1.items[id];
  if (!entry) throw new RangeError(`Unknown dungeon fixture item: ${id}`);
  return { id, ownerId: 'g', catalogId: id, catalogVersion: CATALOG_V1.version, tier: entry.tier,
    rarity: entry.rarity, stats: entry.stats, quantity: 1, origin: 'shop', binding: 'tradable', reservation: null };
}

function gear(classId: ClassId, tier: 1 | 5 | 10, full: boolean): Record<EquipmentSlot, ItemInstance | null> {
  // At 1/5/10 the prototype equips only sword and light armor, even for a Berserker.
  const weapon = classId === 'berserker' && full ? 'axe' : 'sword';
  const head = classId === 'guardian' ? 'iron-helmet' : 'leather-hood';
  return {
    weapon: item(`${weapon}:${tier}:common`),
    offHand: full && classId === 'guardian' ? item(`round-shield:${tier}:common`) : null,
    head: full ? item(`${head}:${tier}:common`) : null,
    body: item(`light-armor:${tier}:common`),
    feet: full ? item(`light-boots:${tier}:common`) : null,
  };
}

export function representativeBuild(classId: ClassId, level: RepresentativeLevel): BuildSnapshot {
  const { points, tier, full } = LEVELS[level];
  return { rulesVersion: RULES_V2.version, classId, stance: STANCE[classId],
    allocations: allocation(classId, points), equipment: gear(classId, tier, full) };
}

export function cappedDungeonBuild(classId: ClassId, level: RepresentativeLevel): BuildSnapshot {
  const build = representativeBuild(classId, level);
  return { ...build, allocations: allocation(classId, trainingCap(RULES_V2, level)!) };
}

const SEATS = [0, 1, 2] as const;
const NAMES = ['Ari', 'Bo', 'Cy'] as const;

export function partyInput(dungeonId: DungeonId, humans: { classId: ClassId; level: number }[], runId: string): DungeonRunInput {
  if (humans.length < 1 || humans.length > SEATS.length) throw new RangeError('Expected one to three fixture humans');
  const builds = humans.map(({ classId, level }) => {
    if (!Object.hasOwn(LEVELS, level)) throw new RangeError(`Unknown dungeon fixture level: ${level}`);
    return representativeBuild(classId, level as RepresentativeLevel);
  });
  const hired = hiredRolesFor(builds.map(build => build.stance));
  const seats = SEATS.map((seat): DungeonSeat => {
    const human = humans[seat];
    if (!human) return { seat, kind: 'hireling', role: hired[seat - humans.length] };
    return { seat, kind: 'human', gladiatorId: `10000000-0000-4000-8000-00000000000${seat + 1}`,
      activityId: `20000000-0000-4000-8000-00000000000${seat + 1}`,
      name: NAMES[seat], level: human.level, build: builds[seat] };
  });
  const slotIndex = 1; // Afternoon; startsAtMs is a real slot boundary.
  return { kind: 'dungeon', runId, slotIndex, rulesVersion: RULES_V2.version,
    dungeonId, startsAtMs: slotIndex * RULES_V2.clock.slotMs, seats };
}
