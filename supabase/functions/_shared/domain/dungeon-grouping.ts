import type { DungeonId } from '../contracts/commands.ts';
import { estimateArenaStrengthCents, nonEmpty } from './arena.ts';
import { CATALOG_V1 } from './catalog-v1.ts';
import { frozenDungeonHumanFighter, hiredRolesFor, type DungeonSeat } from './dungeon.ts';
import { seededRandom } from './random.ts';
import { isRulesV2, requireRetained } from './rules.ts';
import { freezeDomain, type BuildSnapshot, type DeepReadonly, type Rules, type Seed } from './types.ts';

export type DungeonEntrant = DeepReadonly<{
  gladiatorId: string; activityId: string; name: string; level: number; build: BuildSnapshot;
}>;
export type DungeonGroupingInput = DeepReadonly<{
  kind: 'dungeon-grouping'; slotIndex: number; dungeonId: DungeonId; rulesVersion: string; entrants: DungeonEntrant[];
}>;
export type DungeonRunAssignment = DeepReadonly<{ runId: string; seats: DungeonSeat[] }>;
export type DungeonGroupingResult = { runs: DungeonRunAssignment[] };

const SEATS = [0, 1, 2] as const;
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Split consecutive strength bands into balanced parties without moving anyone across a band boundary. */
export function partitionByStrength(cents: readonly number[], ratio: number): number[][] {
  if (!Number.isFinite(ratio) || ratio < 1) throw new RangeError('Invalid dungeon strength ratio');
  const groups: number[][] = [];
  for (let start = 0; start < cents.length;) {
    let end = start + 1;
    while (end < cents.length && cents[start] <= ratio * cents[end]) end++;
    const size = end - start;
    const count = Math.ceil(size / SEATS.length);
    const base = Math.floor(size / count);
    const extra = size % count;
    for (let i = 0; i < count; i++) {
      const length = base + (i < extra ? 1 : 0);
      groups.push(Array.from({ length }, (_, offset) => start + offset));
      start += length;
    }
  }
  return groups;
}

/** Group one frozen slot and dungeon. SQL derives each run's seed when accepting its assignment. */
export function groupDungeon(input: DungeonGroupingInput, seed: Seed, rules: Rules): DungeonGroupingResult {
  const retained = requireRetained(rules);
  if (!isRulesV2(retained)) throw new RangeError('Dungeons require retained v2 rules');
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.kind !== 'dungeon-grouping'
    || input.rulesVersion !== retained.version || !nonEmpty(seed)
    || !Number.isSafeInteger(input.slotIndex) || input.slotIndex < 0
    || !Number.isSafeInteger((input.slotIndex + 1) * retained.clock.slotMs)
    || !nonEmpty(input.dungeonId) || !Object.hasOwn(CATALOG_V1.dungeons, input.dungeonId) || !Array.isArray(input.entrants)) {
    throw new RangeError('Invalid dungeon grouping input');
  }
  const { slotIndex, dungeonId } = input;
  const { requiredLevel } = CATALOG_V1.dungeons[dungeonId];
  const ids = new Set<string>(), activities = new Set<string>();
  const ranked = Array.from(input.entrants, entrant => {
    if (!entrant || typeof entrant !== 'object' || Array.isArray(entrant)
      || !nonEmpty(entrant.gladiatorId) || !nonEmpty(entrant.activityId) || !nonEmpty(entrant.name)
      || !Number.isSafeInteger(entrant.level) || entrant.level < requiredLevel
      || ids.has(entrant.gladiatorId) || activities.has(entrant.activityId)) {
      throw new RangeError('Invalid dungeon entrant');
    }
    ids.add(entrant.gladiatorId);
    activities.add(entrant.activityId);
    const fighter = frozenDungeonHumanFighter(entrant.build, entrant.level, retained);
    return { entrant, cents: estimateArenaStrengthCents(fighter), tie: seededRandom(`${seed}:dungeon:${entrant.gladiatorId}`)() };
  }).sort((a, b) => b.cents - a.cents || a.tie - b.tie || compareIds(a.entrant.gladiatorId, b.entrant.gladiatorId));

  const groups = partitionByStrength(ranked.map(candidate => candidate.cents), retained.matchmaking.maximumStrengthRatio);
  return { runs: groups.map((group, index) => {
    const humans = group.map(position => ranked[position].entrant);
    const seats: DungeonSeat[] = humans.map(({ gladiatorId, activityId, name, level, build }, seat) => ({
      seat: SEATS[seat], kind: 'human', gladiatorId, activityId, name, level, build: structuredClone(build),
    }));
    for (const role of hiredRolesFor(humans.map(human => human.build.stance))) {
      seats.push({ seat: SEATS[seats.length], kind: 'hireling', role });
    }
    return freezeDomain({ runId: `dungeon:${slotIndex}:${dungeonId}:${index + 1}`, seats });
  }) };
}
