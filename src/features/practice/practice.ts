// The practice engine (Patch 1.9, Task 17; additions spec section 3). Pure and local: a practice fight runs in the browser with the shared
// combat domain under the Arena's rules, against a training dummy or a copy of another gladiator's published build. Nothing is sent,
// stored or counted (no rating, record, renown or XP).
import type { Attributes, ClassId, EquipmentSlot, Stance } from '@contracts/commands';
import type { BattleLog } from '@contracts/events';
import type { Appearance } from '@domain/appearance';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { criticalProbability, hitProbability, makeFighter, simulateBattle } from '@domain/combat';
import { trainingCap } from '@domain/economy';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import type { FighterSnapshot, Rules } from '@domain/types';
import type { PublicBuild, PublicGear } from '../../lib/api/reads';
import { cardSnapshot } from '../character/profile-card';
import { GEAR_SLOTS } from '../inventory/gear';

export type DummyPreset = 'balanced' | 'tank' | 'glass-cannon' | 'custom';
export type DummySlot = 'weapon' | 'offHand' | 'head' | 'body' | 'feet';
export type DummySetup = {
  preset: DummyPreset; level: number; stance: Stance; allocations: Attributes;
  /** Catalog template ids ("sword"); the gear level is `gearLevel`. */
  gear: Record<DummySlot, string | null>; gearLevel: 1 | 5 | 10;
};

/** The fights' rules: what the profile card's fighters use (v2 combat is v1's). */
const RULES: Rules = RULES_V1;
/** The attribute shares in the order that ties break (the listed order is also the order the leftover points go in). */
const SHARES = {
  balanced: [['strength', 20], ['agility', 20], ['vitality', 20], ['endurance', 20], ['precision', 20]],
  tank: [['vitality', 40], ['endurance', 30], ['strength', 20], ['precision', 10], ['agility', 0]],
  'glass-cannon': [['strength', 45], ['precision', 30], ['agility', 25], ['vitality', 0], ['endurance', 0]],
} as const satisfies Record<string, readonly (readonly [keyof Attributes, number])[]>;

export const DUMMY_PRESETS = {
  balanced: { label: 'Balanced', stance: 'balanced', split: SHARES.balanced,
    gear: { weapon: 'sword', offHand: 'round-shield', head: 'leather-hood', body: 'light-armor', feet: 'light-boots' } },
  tank: { label: 'Tank', stance: 'defensive', split: SHARES.tank,
    gear: { weapon: 'sword', offHand: 'round-shield', head: 'iron-helmet', body: 'heavy-armor', feet: 'heavy-boots' } },
  'glass-cannon': { label: 'Glass cannon', stance: 'offensive', split: SHARES['glass-cannon'],
    gear: { weapon: 'spear', offHand: null, head: 'leather-hood', body: null, feet: 'light-boots' } },
} as const satisfies Record<Exclude<DummyPreset, 'custom'>, { label: string; stance: Stance; split: readonly (readonly [keyof Attributes, number])[]; gear: Record<DummySlot, string | null> }>;

/** The most attribute points a gladiator of this level can have from Training: 10 + 4 per level (rules v2's cap). */
export function dummyPoints(level: number): number {
  const cap = trainingCap(RULES_V2, level);
  if (cap === null) throw new RangeError('Rules without a training cap');
  return cap;
}

/** Levels 5 and 10 open the better gear tiers. */
export const maxGearLevel = (level: number): 1 | 5 | 10 => (level >= 10 ? 10 : level >= 5 ? 5 : 1);

export const levelRange = (): { min: 1; max: number } => ({ min: 1, max: RULES.attributes.maximumLevel });

/** A preset's points at a level: each share's floor, then one more to each of the largest shares in turn (the listed order breaks ties). */
function splitPoints(preset: Exclude<DummyPreset, 'custom'>, level: number): Attributes {
  const total = dummyPoints(level), split = DUMMY_PRESETS[preset].split;
  const out: Attributes = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };
  let used = 0;
  for (const [key, percent] of split) { out[key] = Math.floor(total * percent / 100); used += out[key]; }
  const order = [...split].filter(([, percent]) => percent > 0).sort((a, b) => b[1] - a[1]).map(([key]) => key);
  for (let i = 0; used < total; i++, used++) out[order[i % order.length]]++;
  return out;
}

export function presetSetup(preset: DummyPreset, level: number): DummySetup {
  const gearLevel = maxGearLevel(level);
  if (preset === 'custom') {
    return { preset, level, stance: 'balanced', allocations: splitPoints('balanced', level), gear: { ...DUMMY_PRESETS.balanced.gear }, gearLevel };
  }
  const data = DUMMY_PRESETS[preset];
  return { preset, level, stance: data.stance, allocations: splitPoints(preset, level), gear: { ...data.gear }, gearLevel };
}

/** A new level: the gear level is clamped; a preset re-applies its split at the new total, Custom keeps its points. */
export function withLevel(setup: DummySetup, level: number): DummySetup {
  const gearLevel = Math.min(setup.gearLevel, maxGearLevel(level)) as 1 | 5 | 10;
  return { ...setup, level, gearLevel, allocations: setup.preset === 'custom' ? { ...setup.allocations } : splitPoints(setup.preset, level) };
}

/** Points the level allows minus the points spent; negative when a Custom setup has too many. */
export const pointsLeft = (setup: DummySetup): number =>
  dummyPoints(setup.level) - (setup.allocations.strength + setup.allocations.agility + setup.allocations.vitality + setup.allocations.endurance + setup.allocations.precision);

/** A neutral class: no multiplier on any attribute, so the dummy's attributes are exactly base 5 plus its points. */
const NEUTRAL = 'neutral' as ClassId;
const NEUTRAL_RULES: Rules = { ...RULES, classes: { ...RULES.classes, [NEUTRAL]: { strength: 1, agility: 1, vitality: 1, endurance: 1, precision: 1 } } };

/** The fighter of a catalog-common build with no class; Arena context. */
export function dummyFighter(setup: DummySetup): FighterSnapshot {
  const twoHanded = setup.gear.weapon !== null && CATALOG_V1.items[`${setup.gear.weapon}:${setup.gearLevel}:common`]?.hands === 2;
  const piece = (slot: DummySlot): PublicGear | null => {
    const template = slot === 'offHand' && twoHanded ? null : setup.gear[slot];
    const item = template === null ? undefined : CATALOG_V1.items[`${template}:${setup.gearLevel}:common`];
    return item ? { catalogId: item.id, catalogVersion: CATALOG_V1.version, tier: item.tier, rarity: item.rarity, stats: structuredClone(item.stats) } : null;
  };
  const equipment = Object.fromEntries(GEAR_SLOTS.map(slot => [slot, piece(slot as DummySlot & EquipmentSlot)])) as PublicBuild['equipment'];
  const snapshot = cardSnapshot(NEUTRAL, { stance: setup.stance, allocations: { ...setup.allocations }, equipment });
  const fighter = makeFighter(snapshot, 'arena', NEUTRAL_RULES);
  return { ...fighter, classId: null, attributes: { ...fighter.attributes }, equipmentSilhouettes: [...fighter.equipmentSilhouettes] };
}

/** A published build as the Arena fights it. */
export const cardFighter = (classId: ClassId, build: PublicBuild): FighterSnapshot => makeFighter(cardSnapshot(classId, build), 'arena', RULES);

export type PracticeSide = { gladiatorId: string | null; name: string; look: Appearance | null; snapshot: FighterSnapshot };

/** One practice fight; the sides are told apart by their participant ids, so a mirror (one gladiator twice) works. */
export function runPractice(you: PracticeSide, opponent: PracticeSide, seed: string): BattleLog {
  const side = (id: string, of: PracticeSide) => ({ id, gladiatorId: of.gladiatorId, name: of.name, snapshot: of.snapshot });
  return simulateBattle({ battleId: 'practice', rulesVersion: RULES.version, rules: RULES,
    fighters: [side('practice-you', you), side('practice-opponent', opponent)] }, seed);
}

/** A fresh seed of 16 hex characters. */
export function practiceSeed(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const DUMMY_NAME = 'Training dummy';
/** A bald, cream-clothed man in the straw-coloured palette tone (palette indices only: Cream in `CLOTH_COLOURS`, Olive in `SKIN_TONES`). */
export const DUMMY_LOOK: Appearance = { body: 'male', hair: 'bald', skin: 2, hairColor: 0, cloth: 7 };

const secondsText = (ms: number) => `${Math.round(ms / 10) / 100} s`;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const blocksOf = (fighter: FighterSnapshot) =>
  percent(Math.min(RULES.combat.maximumArmorReduction, RULES.combat.armorReductionPerPoint * fighter.armor));
const damageOf = (fighter: FighterSnapshot) => Math.round(fighter.baseDamage * fighter.efficiency * RULES.stances[fighter.stance].outgoing);

/** The dialog's table: the two fighters side by side under the Arena's rules. */
export function comparisonRows(you: FighterSnapshot, dummy: FighterSnapshot): [label: string, you: string, dummy: string][] {
  const chance = (attacker: FighterSnapshot, defender: FighterSnapshot) =>
    percent(hitProbability(attacker.attributes.precision, defender.attributes.agility, RULES));
  return [
    ['Health', String(you.maxHealth), String(dummy.maxHealth)],
    ['Damage', String(damageOf(you)), String(damageOf(dummy))],
    ['Attack speed', secondsText(you.attackIntervalMs), secondsText(dummy.attackIntervalMs)],
    ['Armor blocks', blocksOf(you), blocksOf(dummy)],
    ['Critical', percent(criticalProbability(you.attributes.precision, RULES)), percent(criticalProbability(dummy.attributes.precision, RULES))],
    ['Chance to hit', chance(you, dummy), chance(dummy, you)],
  ];
}
