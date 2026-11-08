import type { DungeonId } from '../contracts/commands.ts';
import { leagueFor } from './arena.ts';
import { validateBuild } from './build.ts';
import { CATALOG_V1 } from './catalog-v1.ts';
import { historicalGearScore } from './inventory.ts';
import { RULES_V2 } from './rules-v2.ts';
import { deriveStats } from './stats.ts';
import { freezeDomain, type BuildInput, type EquipmentSlot, type HiredBuild, type HiredRole, type ItemInstance } from './types.ts';

export const BOT_TEAM = 'ludus-nimbus';
export type BotDirective = 'off-duty' | 'rest' | 'on-call' | 'arena' | 'training';

function resolveKit(kit: HiredBuild) {
  const inventory: ItemInstance[] = [];
  const equipment = {} as BuildInput['equipment'];
  for (const slot of Object.keys(kit.equipment) as EquipmentSlot[]) {
    const id = kit.equipment[slot];
    equipment[slot] = id;
    if (id === null) continue;
    const { tier, rarity, stats } = CATALOG_V1.items[id];
    inventory.push({ id, ownerId: BOT_TEAM, catalogId: id, catalogVersion: CATALOG_V1.version, tier, rarity, stats,
      quantity: 1, origin: 'starter', binding: 'bound', reservation: null });
  }
  const draft: BuildInput = { classId: kit.classId, stance: kit.stance, allocation: { ...kit.allocations }, equipment };
  return { draft, inventory };
}

function member<Key extends string>(key: Key, name: string, level: number, dungeon: DungeonId, role: HiredRole) {
  // Camp and Arena use the role kit of the hardest dungeon this member can enter.
  const kit = CATALOG_V1.dungeons[dungeon].hired[role];
  const { draft, inventory } = resolveKit(kit);
  const earnedPoints = Object.values(draft.allocation).reduce((total, points) => total + points, 0);
  const build = validateBuild(draft, inventory, earnedPoints, level, RULES_V2);
  if (!build.ok) throw new Error('Invalid fixed bot kit');
  const peakStrength = historicalGearScore(inventory, 0);
  const { levelWeight, earnedPointsDivisor, historicalGearDivisor } = RULES_V2.leagues;
  const leagueIndex = levelWeight * level + Math.floor(earnedPoints / earnedPointsDivisor) + Math.floor(peakStrength / historicalGearDivisor);
  return { key, name, level, classId: kit.classId, stance: kit.stance, role, allocation: kit.allocations, equipment: kit.equipment,
    earnedPoints, peakStrength, leagueIndex, staminaMaximum: deriveStats(build.snapshot, RULES_V2).maxStamina,
    league: leagueFor(level, earnedPoints, peakStrength, RULES_V2) };
}

/** Fixed catalog for Patch 1.8 (§15). SQL 24 stores the same builds and the routine's 630 private cells. */
export const BOT_CATALOG = freezeDomain({
  tullia: member('tullia', 'Tullia', 12, 'troll-hall', 'guard'),
  grit: member('grit', 'Grit', 7, 'raider-stronghold', 'striker'),
  ash: member('ash', 'Cinder', 7, 'raider-stronghold', 'skirmisher'),
  rufus: member('rufus', 'Rufus', 4, 'wolf-den', 'guard'),
  pip: member('pip', 'Pip', 3, 'wolf-den', 'skirmisher'),
});

export type BotKey = keyof typeof BOT_CATALOG;

/** Resolve the fixed catalog items without any account, wallet or persisted instance IDs. */
export function botBuild(key: BotKey) {
  const { classId, stance, allocation: allocations, equipment } = BOT_CATALOG[key];
  return resolveKit({ classId, stance, allocations, equipment });
}

const SLOTS_PER_DAY = 18;
const SLOTS_PER_WEEK = 126;
const MONDAY_OFFSET = 72; // The Unix epoch begins on Thursday UTC.
const OFF_DUTY_SLOTS = 6; // 00:00 inclusive through 08:00 exclusive.
const BRONZE_ROTATION = ['grit', 'rufus', 'ash', 'pip'] as const;

/** A canonical absolute slot maps to a Monday-based UTC routine index. */
export function botRoutineIndex(slotIndex: number): number {
  const maximum = Math.floor(Number.MAX_SAFE_INTEGER / RULES_V2.clock.slotMs) - 1;
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex > maximum) throw new RangeError('Invalid absolute slot');
  return ((slotIndex - MONDAY_OFFSET) % SLOTS_PER_WEEK + SLOTS_PER_WEEK) % SLOTS_PER_WEEK;
}

/** The private base directive before applying duty, stamina or placement. */
export function botRoutine(key: BotKey, slotIndex: number): BotDirective {
  const weekIndex = botRoutineIndex(slotIndex);
  const dailySlot = weekIndex % SLOTS_PER_DAY;
  if (dailySlot < OFF_DUTY_SLOTS) return 'off-duty';
  const phase = dailySlot % 3;
  if (phase === 0) return 'rest';
  if (phase === 1) return 'on-call';
  if (key === 'tullia') return 'arena';
  const weekday = Math.floor(weekIndex / SLOTS_PER_DAY);
  const evening = (dailySlot - 8) / 3;
  const first = (weekday + evening) % BRONZE_ROTATION.length;
  const second = (first + 1) % BRONZE_ROTATION.length;
  return BRONZE_ROTATION[first] === key || BRONZE_ROTATION[second] === key ? 'arena' : 'training';
}
