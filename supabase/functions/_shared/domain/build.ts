import type { Attributes, BuildInput, BuildValidation, ItemInstance } from './types.ts';
import { freezeDomain } from './types.ts';
import { RULES_V1 } from './rules-v1.ts';
import { CATALOG_V1 } from './catalog-v1.ts';

const attributes = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;
const slots = ['weapon', 'offHand', 'head', 'body', 'feet'] as const;
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function boundedInteger(value: unknown, maximum: number, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function allocationTotal(value: unknown): number | null {
  if (!exactKeys(value, attributes)) return null;
  const allocation = value as Attributes;
  let total = 0;
  for (const key of attributes) {
    if (!boundedInteger(allocation[key], RULES_V1.attributes.maximumPoints)) return null;
    total += allocation[key];
  }
  return total <= RULES_V1.attributes.maximumPoints ? total : null;
}
function validInput(input: BuildInput): boolean {
  return isRecord(input) && typeof input.classId === 'string' && Object.hasOwn(RULES_V1.classes, input.classId)
    && typeof input.stance === 'string' && Object.hasOwn(RULES_V1.stances, input.stance)
    && allocationTotal(input.allocation) !== null && exactKeys(input.equipment, slots);
}
function validStats(item: ItemInstance): boolean {
  const stats = item.stats;
  if (!isRecord(stats) || !exactKeys(stats.attributes, attributes)) return false;
  const decimal = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    && value <= RULES_V1.attributes.maximumPoints && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
  return [stats.damage, stats.armor, stats.weight, ...attributes.map(key => stats.attributes[key])].every(decimal)
    && boundedInteger(stats.intervalMs, RULES_V1.attributes.maximumPoints);
}

/** `owned` must be loaded server-side for the authenticated actor, never accepted from a client. */
export function validateBuild(input: BuildInput, owned: ItemInstance[], earnedPoints: number, level: number): BuildValidation {
  if (!validInput(input) || !boundedInteger(earnedPoints, RULES_V1.attributes.maximumPoints, RULES_V1.attributes.creationPoints)
    || !boundedInteger(level, RULES_V1.attributes.maximumLevel, 1) || !Array.isArray(owned)) return { ok: false, reason: 'invalid-input' };
  const total = allocationTotal(input.allocation)!;
  if (total > earnedPoints) return { ok: false, reason: 'points' };
  const equipment: Record<typeof slots[number], ItemInstance | null> = { weapon: null, offHand: null, head: null, body: null, feet: null };
  const used = new Set<string>();
  for (const slot of slots) {
    const id = input.equipment[slot];
    if (id === null) continue;
    if (typeof id !== 'string' || !id.length || id.length > 200 || used.has(id)) return { ok: false, reason: 'item' };
    used.add(id);
    const matches = owned.filter(item => item?.id === id);
    if (matches.length !== 1) return { ok: false, reason: 'item' };
    const item = matches[0];
    const entry = CATALOG_V1.items[item.catalogId];
    if (!entry || item.catalogVersion !== CATALOG_V1.version || item.tier !== entry.tier || item.rarity !== entry.rarity
      || item.quantity !== 1 || !validStats(item) || (slot === 'weapon' && item.stats.intervalMs === 0)) return { ok: false, reason: 'item' };
    if (entry.slot !== slot) return { ok: false, reason: 'slot' };
    if (item.tier > level) return { ok: false, reason: 'level' };
    if (item.reservation?.kind === 'listing') return { ok: false, reason: 'reserved' };
    if ((item.origin === 'renown') !== (entry.renownPrice !== null) || (item.origin === 'renown' && item.binding !== 'bound')) return { ok: false, reason: 'item' };
    equipment[slot] = structuredClone(item);
  }
  const weapon = equipment.weapon;
  if (weapon && CATALOG_V1.items[weapon.catalogId].hands === 2 && equipment.offHand) return { ok: false, reason: 'two-handed' };
  return { ok: true, unspentPoints: earnedPoints - total,
    snapshot: freezeDomain({ rulesVersion: RULES_V1.version, classId: input.classId, stance: input.stance,
      allocations: { ...input.allocation }, equipment }) };
}

export function validateCreationAllocation(allocation: Attributes): boolean {
  return allocationTotal(allocation) === RULES_V1.attributes.creationPoints;
}

/**
 * A saved build's class and added points are fixed (Avi, 2026-10-28; respec and class changes come back later as paid options).
 * Compared against the ACTIVE build, never a pending one, so a pending build may be revised down to the active build's values
 * (not below) and still be cancelled. 'class' wins when both changed. Stance, equipment and more points are free to change.
 * `buildChangeFee` is unchanged and returns 0 for every change this allows.
 */
export function lockedChange(current: BuildInput, next: BuildInput): 'class' | 'points' | null {
  if (!validInput(current) || !validInput(next)) throw new RangeError('Invalid build lock input');
  if (current.classId !== next.classId) return 'class';
  return attributes.some(key => next.allocation[key] < current.allocation[key]) ? 'points' : null;
}

/** Compare against the active build, not a previously queued request. Reservation/refund is transactional backend work. */
export function buildChangeFee(current: BuildInput, next: BuildInput): number {
  if (!validInput(current) || !validInput(next)) throw new RangeError('Invalid build fee input');
  const changedClass = current.classId !== next.classId;
  const respec = attributes.some(key => next.allocation[key] < current.allocation[key]);
  return (changedClass ? RULES_V1.fees.classChange : 0) + (respec ? RULES_V1.fees.respec : 0);
}
