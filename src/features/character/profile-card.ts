// The richer profile card's words (Task 11c; Patch A spec, "A richer profile card"; Avi approved the mockup, 2026-10-29). Pure: the
// card's sections lay these out. The stats are computed in the browser from the published build with the shared rules
// (`deriveStats`, `makeFighter` for an expedition, `criticalProbability`), so they are what a fight uses; nothing more is sent.
import type { Attributes, ClassId, EquipmentSlot } from '@contracts/commands';
import type { ItemRarity } from '@contracts/events';
import type { ItemInstance } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { criticalProbability, makeFighter } from '@domain/combat';
import { RULES_V1 } from '@domain/rules-v1';
import { deriveStats } from '@domain/stats';
import type { ArenaRecord, PublicBuild } from '../../lib/api/reads';
import { calendarDays, dateText } from '../../lib/time-format';
import { GEAR_SLOTS, SLOT_LABELS } from '../inventory/gear';
import { classBonuses } from './class-bonus';
import { ATTRIBUTE_KEYS } from './creation-points';

/** What a fight uses, from the published build: an expedition's numbers (the Arena's +10% on renown gear is not added). */
export type CardStats = { health: number; hit: number; intervalMs: number; armor: number; blocks: number; critical: number;
  efficiency: number; load: number; capacity: number };

/** A published item in the shape the rules read: its published fields, and the rest as the rules need them (origin from its catalog id). */
const itemOf = (slot: EquipmentSlot, gear: PublicBuild['equipment'][EquipmentSlot]): ItemInstance | null => gear && {
  ...gear, id: `card-${slot}`, ownerId: 'card', quantity: 1, origin: gear.catalogId.endsWith(':renown') ? 'renown' : 'shop', binding: 'tradable', reservation: null,
};

/** The build's stats as the card says them; null when the rules refuse the build (an unknown stance or class, a bad point). */
export function cardStats(classId: ClassId, build: PublicBuild): CardStats | null {
  try {
    const equipment = Object.fromEntries(GEAR_SLOTS.map(slot => [slot, itemOf(slot, build.equipment[slot])])) as Record<EquipmentSlot, ItemInstance | null>;
    const snapshot = { rulesVersion: RULES_V1.version, classId, stance: build.stance, allocations: { ...build.allocations }, equipment };
    const derived = deriveStats(snapshot, RULES_V1);
    const fighter = makeFighter(snapshot, 'expedition', RULES_V1);
    const combat = RULES_V1.combat;
    return {
      health: fighter.maxHealth,
      hit: Math.round(fighter.baseDamage * fighter.efficiency * RULES_V1.stances[build.stance].outgoing),
      intervalMs: fighter.attackIntervalMs,
      armor: fighter.armor,
      blocks: Math.round(Math.min(combat.maximumArmorReduction, combat.armorReductionPerPoint * fighter.armor) * 100),
      critical: criticalProbability(fighter.attributes.precision, RULES_V1),
      efficiency: fighter.efficiency,
      load: derived.load,
      capacity: derived.loadCapacity,
    };
  } catch {
    return null;
  }
}

/** A number as the card writes it: at most `places` decimals, trailing zeros dropped (12.30 is "12.3", 20.50 is "20.5"). */
const decimals = (value: number, places: number) => String(Math.round(value * 10 ** places) / 10 ** places);

/** The five stats rows: Health, Damage, Speed, Armor and Critical. */
export function statRows(stats: CardStats): [label: string, value: string][] {
  return [
    ['Health', String(stats.health)],
    // Avi, 2026-11-04: just the number, as Health is.
    ['Damage', String(stats.hit)],
    // Half up to hundredths: 1005 ms is 1.01 s (1.005 × 100 in binary is 100.49…, which Math.round would take down).
    ['Speed', `every ${String(Math.round(stats.intervalMs / 10) / 100)} s`],
    ['Armor', stats.armor > 0 ? `${decimals(stats.armor, 1)} · blocks ${stats.blocks}%` : 'None'],
    ['Critical', `${Math.round(stats.critical * 100)}% of hits`],
  ];
}

/** The line under the stats when the gear outweighs the load capacity, or null. */
export function overloadLine(stats: CardStats): string | null {
  if (stats.load <= stats.capacity) return null;
  return `Overloaded: load ${decimals(stats.load, 2)} of ${decimals(stats.capacity, 2)}, fighting at ${Math.round(stats.efficiency * 100)}%`;
}

const title = (value: string) => value[0].toUpperCase() + value.slice(1);

/** The five attributes in order: the build's points, the class's bonus ("+5%") and the bar's width (points over the largest, at least 1). */
export function attributeRows(classId: ClassId, allocations: Attributes): { attribute: keyof Attributes; label: string; points: number; bonus: string | null; width: number }[] {
  const bonuses = new Map(classBonuses(classId).map(bonus => [bonus.attribute, `+${bonus.percent}%`]));
  const largest = Math.max(1, ...ATTRIBUTE_KEYS.map(key => allocations[key]));
  return ATTRIBUTE_KEYS.map(attribute => ({ attribute, label: title(attribute), points: allocations[attribute], bonus: bonuses.get(attribute) ?? null,
    width: allocations[attribute] / largest }));
}

/** The build's points in all (the eyebrow's "{n} POINTS"). */
export const pointsTotal = (allocations: Attributes): number => ATTRIBUTE_KEYS.reduce((sum, key) => sum + allocations[key], 0);

/** One slot of the Gear section: a worn item's name and " · Level 5 · uncommon", or the note of an empty slot. */
export type GearRow = { slot: EquipmentSlot; label: string; name: string | null; detail: string | null; rarity: ItemRarity | null;
  note: 'Empty' | 'Two-handed weapon' | null };

/** The five slots in the Inventory's words; null when nothing is worn ("Nothing worn yet."). */
export function gearRows(build: PublicBuild): GearRow[] | null {
  if (GEAR_SLOTS.every(slot => build.equipment[slot] === null)) return null;
  const weapon = build.equipment.weapon;
  const twoHanded = weapon !== null && CATALOG_V1.items[weapon.catalogId]?.hands === 2;
  return GEAR_SLOTS.map(slot => {
    const item = build.equipment[slot];
    if (!item) return { slot, label: SLOT_LABELS[slot], name: null, detail: null, rarity: null, note: slot === 'offHand' && twoHanded ? 'Two-handed weapon' : 'Empty' };
    return { slot, label: SLOT_LABELS[slot], name: CATALOG_V1.items[item.catalogId]?.name ?? 'Unknown item', detail: ` · Level ${item.tier} · ${item.rarity}`,
      rarity: item.rarity, note: null };
  });
}

/** A record of bouts: "9–5", or "No bouts yet". */
export const recordText = (record: ArenaRecord): string => (record.wins + record.losses === 0 ? 'No bouts yet' : `${record.wins}–${record.losses}`);

/** "In camp since": the day the gladiator was made and the whole days since, in the viewer's zone ("2 Oct · 8 days", "today", "1 day"). */
export function sinceText(joinedAtMs: number, nowMs: number, timeZone?: string): string {
  const date = dateText(joinedAtMs, nowMs, timeZone), days = calendarDays(joinedAtMs, nowMs, timeZone);
  if (!date || days === null) return '';
  return `${date} · ${days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`}`;
}
