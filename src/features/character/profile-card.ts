// The richer profile card's words (Task 11c; Patch A spec, "A richer profile card"; Avi approved the mockup, 2026-10-29). Pure: the
// card's sections lay these out. The stats are computed in the browser from the published build with the shared rules
// (`deriveStats`, `makeFighter` for an expedition, `criticalProbability`), so they are what a fight uses; nothing more is sent.
import type { Attributes, ClassId, EquipmentSlot } from '@contracts/commands';
import type { ItemRarity } from '@contracts/events';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { criticalProbability, makeFighter } from '@domain/combat';
import { RULES_V1 } from '@domain/rules-v1';
import type { BuildSnapshot } from '@domain/types';
import { deriveStats } from '@domain/stats';
import type { ArenaRecord, PublicBuild } from '../../lib/api/reads';
import { calendarDays, dateText } from '../../lib/time-format';
import { GEAR_SLOTS, SLOT_LABELS } from '../inventory/gear';
import { classBonuses } from './class-bonus';
import { ATTRIBUTE_KEYS } from './creation-points';

/**
 * What a fight uses, from the published build: an expedition's (and dungeon's) numbers in `hit`, `armor` and `blocks`, and the Arena's and
 * tournaments' (renown gear counts 10% more) in the `arena…` ones; `criticalDamage` is the factor a critical hit multiplies a hit by.
 */
export type CardStats = { health: number; hit: number; intervalMs: number; armor: number; blocks: number; critical: number;
  efficiency: number; load: number; capacity: number; arenaHit: number; arenaArmor: number; arenaBlocks: number; criticalDamage: number };

/** A published item in the shape the rules read: its published fields, and the rest as the rules need them (origin from its catalog id). */
const itemOf = (slot: EquipmentSlot, gear: PublicBuild['equipment'][EquipmentSlot]): ItemInstance | null => gear && {
  ...gear, id: `card-${slot}`, ownerId: 'card', quantity: 1, origin: gear.catalogId.endsWith(':renown') ? 'renown' : 'shop', binding: 'tradable', reservation: null,
};

/** The published build as the rules read it (the snapshot `cardStats` and the practice fights derive from). */
export function cardSnapshot(classId: ClassId, build: PublicBuild): BuildSnapshot {
  const equipment = Object.fromEntries(GEAR_SLOTS.map(slot => [slot, itemOf(slot, build.equipment[slot])])) as Record<EquipmentSlot, ItemInstance | null>;
  return { rulesVersion: RULES_V1.version, classId, stance: build.stance, allocations: { ...build.allocations }, equipment };
}

/** The build's stats as the card says them; null when the rules refuse the build (an unknown stance or class, a bad point). */
export function cardStats(classId: ClassId, build: PublicBuild): CardStats | null {
  try {
    const snapshot = cardSnapshot(classId, build);
    const derived = deriveStats(snapshot, RULES_V1);
    const fighter = makeFighter(snapshot, 'expedition', RULES_V1);
    const arena = makeFighter(snapshot, 'arena', RULES_V1);
    const combat = RULES_V1.combat;
    const hitOf = (of: typeof fighter) => Math.round(of.baseDamage * of.efficiency * RULES_V1.stances[build.stance].outgoing);
    const blocksOf = (of: typeof fighter) => Math.round(Math.min(combat.maximumArmorReduction, combat.armorReductionPerPoint * of.armor) * 100);
    return {
      health: fighter.maxHealth,
      hit: hitOf(fighter),
      intervalMs: fighter.attackIntervalMs,
      armor: fighter.armor,
      blocks: blocksOf(fighter),
      arenaHit: hitOf(arena),
      arenaArmor: arena.armor,
      arenaBlocks: blocksOf(arena),
      criticalDamage: combat.criticalDamage,
      critical: criticalProbability(fighter.attributes.precision, RULES_V1),
      efficiency: fighter.efficiency,
      load: derived.load,
      capacity: derived.loadCapacity,
    };
  } catch {
    return null;
  }
}

/** The owner's current build in the public shape the card reads (a worn piece is found in the bag; a missing one is an empty slot). */
export function ownBuild(owner: OwnerState): PublicBuild {
  const { stance, allocations, equipment } = owner.currentBuild;
  const gear = (id: string | null) => {
    const item = owner.inventory.find(piece => piece.id === id);
    return item ? { catalogId: item.catalogId, catalogVersion: item.catalogVersion, tier: item.tier, rarity: item.rarity, stats: item.stats } : null;
  };
  return { stance, allocations: { ...allocations }, equipment: Object.fromEntries(GEAR_SLOTS.map(slot => [slot, gear(equipment[slot])])) as PublicBuild['equipment'] };
}

/** A number as the card writes it: at most `places` decimals, trailing zeros dropped (12.30 is "12.3", 20.50 is "20.5"). */
const decimals = (value: number, places: number) => String(Math.round(value * 10 ** places) / 10 ** places);

/** A factor as a percentage more ("1.5" is "50%", "1.1" is "10%"): the Arena's and a critical hit's bonuses are the rules' own. */
const morePercent = (factor: number) => `${Math.round((factor - 1) * 1000) / 10}%`;
const ARENA_MORE = morePercent(RULES_V1.shops.renownArenaMultiplier);

export const statHelp = {
  Health: 'Maximum health in combat. Vitality raises it.',
  Damage: `Damage from a normal hit before the target’s defenses. Weapon damage, Strength, stance, and gear overload affect it. A renown weapon deals ${ARENA_MORE} more in the Arena.`,
  'Attack speed': 'Time between attacks. Your weapon sets the base speed. Agility speeds up attacks, and gear overload slows them.',
  Armor: `Equipped armor reduces the damage you take from landed hits. Renown armor counts ${ARENA_MORE} more in the Arena.`,
  Critical: `Chance for a landed hit to be a critical hit, which deals ${morePercent(RULES_V1.combat.criticalDamage)} more damage. Precision raises it.`,
  'Critical damage': 'How much more a critical hit deals than a normal hit.',
} as const;

export const attributeHelp: Record<keyof Attributes, string> = {
  strength: 'Increases damage per hit.',
  agility: 'Speeds up attacks and makes you harder to hit.',
  vitality: 'Increases maximum health.',
  endurance: 'Increases maximum stamina and how much gear you can wear before becoming overloaded.',
  precision: 'Raises your chances to hit and to land a critical hit.',
};

/** The Armor row's words for one context ("13 · blocks 26%"). */
const armorText = (armor: number, blocks: number) => `${decimals(armor, 1)} · blocks ${blocks}%`;

/**
 * The combat stats in profile order: label and value, and as a third element the Arena's line ("Arena 13.9 · blocks 28%") where it differs
 * from the expedition's figure (Patch 1.9 Task 13: renown gear counts 10% more there). A row that does not differ has two elements.
 */
export function statRows(stats: CardStats): ([label: keyof typeof statHelp, value: string] | [label: keyof typeof statHelp, value: string, arena: string])[] {
  const damageArena = stats.arenaHit !== stats.hit ? [`Arena ${stats.arenaHit}`] as const : [] as const;
  const armorValue = stats.armor > 0 ? armorText(stats.armor, stats.blocks) : 'None';
  const armorArena = stats.armor > 0 && armorText(stats.arenaArmor, stats.arenaBlocks) !== armorValue ? [`Arena ${armorText(stats.arenaArmor, stats.arenaBlocks)}`] as const : [] as const;
  return [
    ['Health', String(stats.health)],
    // Avi, 2026-11-04: just the number, as Health is.
    ['Damage', String(stats.hit), ...damageArena],
    // Half up to hundredths: 1005 ms is 1.01 s (1.005 × 100 in binary is 100.49…, which Math.round would take down).
    ['Attack speed', `every ${String(Math.round(stats.intervalMs / 10) / 100)} s`],
    ['Armor', armorValue, ...armorArena],
    ['Critical', `${Math.round(stats.critical * 100)}% of hits`],
    // Today every gladiator has the rules' factor; 1.10 plans a way to raise it, and this row will then differ.
    ['Critical damage', `+${morePercent(stats.criticalDamage)}`],
  ];
}

/**
 * The tooltip lines that say what each context gives (My gladiator's Damage and Armor), only where the figures differ:
 * "Expeditions and dungeons · 13 armor · blocks 26%" and "Arena and tournaments · 13.9 armor · blocks 28%".
 */
export function contextLines(stats: CardStats): Partial<Record<keyof typeof statHelp, string[]>> {
  const lines: Partial<Record<keyof typeof statHelp, string[]>> = {};
  if (stats.arenaHit !== stats.hit) lines.Damage = [`Expeditions and dungeons · ${stats.hit}`, `Arena and tournaments · ${stats.arenaHit}`];
  const [expedition, arena] = [stats.armor, stats.arenaArmor].map((armor, i) => `${decimals(armor, 1)} armor · blocks ${i ? stats.arenaBlocks : stats.blocks}%`);
  if (stats.armor > 0 && expedition !== arena) lines.Armor = [`Expeditions and dungeons · ${expedition}`, `Arena and tournaments · ${arena}`];
  return lines;
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

// ---- Patch 1.9 Task 23c: Compare stats with mine ----------------------------------------------------------------------------------------
// Both sides go through the same `cardStats` and `statRows` (yours from `ownBuild(owner)`), so every figure is the one each card shows; nothing
// new is read or sent. The marks sit on YOUR cell: the arrow says better or worse, the number is your value minus theirs.

/** One side of a comparison: the gladiator's name and level, and the class and published build the card computes from. */
export type CompareSide = { name: string; level: number; classId: ClassId; build: PublicBuild };
/** A mark on your cell: better or worse for you, `same`, or a neutral difference (Level) that is context, not a better stat. */
export type CompareMark = { tone: 'better' | 'worse' | 'same' | 'neutral'; text: string; label: string | null };
export type CompareRow = { label: string; hint: keyof typeof statHelp | null; you: string; them: string; youArena: string | null; themArena: string | null; mark: CompareMark | null };
export type CompareAttribute = { label: string; attribute: keyof Attributes; you: number; them: number; mark: CompareMark | null };
export type Comparison = { youStance: string; themStance: string; rows: CompareRow[]; attributes: CompareAttribute[]; youPoints: number; themPoints: number; overloads: string[] };

/**
 * The mark for `you` against `them` rounded to `places` decimals: `better` says which direction is better for you (`high`, `low`, or null for
 * a neutral row). Equal values say "same" (nothing on a neutral row). The difference is your value minus theirs, with a real minus sign.
 */
export function compareMark(you: number, them: number, better: 'high' | 'low' | null, places: number, unit: string): CompareMark | null {
  const diff = Math.round((you - them) * 10 ** places) / 10 ** places;
  if (diff === 0) return better ? { tone: 'same', text: 'same', label: 'same' } : null;
  // Seconds keep their hundredths ("0.20 s", as the cells say them); every other figure drops trailing zeros (an Armor difference of 9 is "9").
  const size = unit.trim() === 's' ? Math.abs(diff).toFixed(places) : decimals(Math.abs(diff), places);
  const text = `${diff > 0 ? '+' : '−'}${size}${unit}`;
  if (!better) return { tone: 'neutral', text: `(${text})`, label: null };
  const good = better === 'high' ? diff > 0 : diff < 0;
  return { tone: good ? 'better' : 'worse', text: `${good ? '▲' : '▼'} ${text}`,
    label: `${good ? 'better' : 'worse'} by ${decimals(Math.abs(diff), 2)}${unit.trim() === 's' ? ' seconds' : ''}` };
}

const STAT_MARKS: Record<keyof typeof statHelp, { value(stats: CardStats): number; better: 'high' | 'low'; places: number; unit: string }> = {
  Health: { value: stats => stats.health, better: 'high', places: 0, unit: '' },
  Damage: { value: stats => stats.hit, better: 'high', places: 0, unit: '' },
  // The card's own hundredths of a second, so the difference is of the numbers the two cells show.
  'Attack speed': { value: stats => Math.round(stats.intervalMs / 10) / 100, better: 'low', places: 2, unit: ' s' },
  Armor: { value: stats => stats.armor, better: 'high', places: 1, unit: '' },
  Critical: { value: stats => Math.round(stats.critical * 100), better: 'high', places: 0, unit: '%' },
  'Critical damage': { value: stats => Math.round((stats.criticalDamage - 1) * 1000) / 10, better: 'high', places: 0, unit: '%' },
};

/** "Aster is overloaded: load 9 of 8, fighting at 90%", or null when the side carries within its capacity. */
const overloadOf = (name: string, stats: CardStats): string | null => overloadLine(stats)?.replace(/^Overloaded/, `${name} is overloaded`) ?? null;

/** Your gladiator against another's: the table's rows with your marks, the attribute rows, and an overload sentence per overloaded side; null when the rules refuse either build. */
export function compareStats(you: CompareSide, them: CompareSide): Comparison | null {
  const yours = cardStats(you.classId, you.build), theirs = cardStats(them.classId, them.build);
  if (!yours || !theirs) return null;
  const yourRows = statRows(yours), theirRows = statRows(theirs);
  const rows: CompareRow[] = [{ label: 'Level', hint: null, you: String(you.level), them: String(them.level), youArena: null, themArena: null,
    mark: compareMark(you.level, them.level, null, 0, '') }];
  if (you.build.stance !== them.build.stance) rows.push({ label: 'Stance', hint: null, you: title(you.build.stance), them: title(them.build.stance), youArena: null, themArena: null, mark: null });
  yourRows.forEach(([label, value, arena], index) => {
    const [, other, otherArena] = theirRows[index];
    const { value: figure, better, places, unit } = STAT_MARKS[label];
    rows.push({ label, hint: label, you: value, them: other, youArena: arena ?? null, themArena: otherArena ?? null,
      mark: compareMark(figure(yours), figure(theirs), better, places, unit) });
  });
  const attributes = ATTRIBUTE_KEYS.map(attribute => ({ attribute, label: title(attribute), you: you.build.allocations[attribute], them: them.build.allocations[attribute],
    mark: compareMark(you.build.allocations[attribute], them.build.allocations[attribute], 'high', 0, '') }));
  return { youStance: title(you.build.stance), themStance: title(them.build.stance), rows, attributes,
    youPoints: pointsTotal(you.build.allocations), themPoints: pointsTotal(them.build.allocations),
    overloads: [overloadOf(you.name, yours), overloadOf(them.name, theirs)].filter((line): line is string => line !== null) };
}
