// The practice dialog's edits and words (Patch 1.9 Task 18; additions spec section 3, the approved mockup's `dialogHTML`). Pure: every edit
// returns a new setup the dialog can always show. Any change but the level makes the dummy Custom; the level re-makes a preset at the new
// level (its points, gear and highest gear level) and keeps Custom's points, so a lower level can leave a Custom dummy with too many points,
// which the dialog says ("24 points too many for level 4") and will not fight (Review Focus 3).
import type { Attributes, Stance } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import {
  DUMMY_PRESETS, PRACTICE_MAX_LEVEL, dummyLoad, dummyPoints, maxGearLevel, pointsLeft, presetSetup, withLevel, type DummyPreset, type DummySetup, type DummySlot,
  type comparisonRows,
} from './practice';

export const PRESET_ORDER: readonly DummyPreset[] = ['balanced', 'tank', 'glass-cannon', 'custom'];
export const presetLabel = (preset: DummyPreset): string => (preset === 'custom' ? 'Custom' : DUMMY_PRESETS[preset].label);
export const ATTRIBUTE_ORDER: readonly (keyof Attributes)[] = ['strength', 'agility', 'vitality', 'endurance', 'precision'];
export const STANCE_ORDER: readonly Stance[] = ['offensive', 'balanced', 'defensive'];
export const DUMMY_SLOTS: readonly DummySlot[] = ['weapon', 'offHand', 'head', 'body', 'feet'];
export const SLOT_NAMES: Record<DummySlot, string> = { weapon: 'Weapon', offHand: 'Off hand', head: 'Head', body: 'Body', feet: 'Feet' };
/** The most points one attribute takes: the top level's whole total (a Custom dummy may go over its own level's, and is told so). */
const MOST_POINTS = dummyPoints(PRACTICE_MAX_LEVEL);

/** The catalog's shop pieces for each slot, in catalog order: "Spear (two hands)" for a weapon that takes both. */
export const GEAR_CHOICES: Record<DummySlot, { id: string; label: string }[]> = (() => {
  const choices: Record<DummySlot, { id: string; label: string }[]> = { weapon: [], offHand: [], head: [], body: [], feet: [] };
  for (const item of Object.values(CATALOG_V1.items)) {
    if (item.tier !== 1 || item.rarity !== 'common' || item.moneyPrice === null) continue;
    choices[item.slot as DummySlot]?.push({ id: item.templateId, label: item.hands === 2 ? `${item.name} (two hands)` : item.name });
  }
  return choices;
})();

/** The gear levels a dummy of this level can wear: 1, then 5 and 10 from those levels. */
export const gearLevels = (level: number): (1 | 5 | 10)[] => ([1, 5, 10] as const).filter(tier => tier <= maxGearLevel(level));

const custom = (setup: DummySetup, change: Partial<DummySetup>): DummySetup => ({ ...setup, ...change, preset: 'custom' });

/** A preset at the setup's level; Custom keeps the setup as it is, named Custom. */
export const withPreset = (setup: DummySetup, preset: DummyPreset): DummySetup =>
  (preset === 'custom' ? custom(setup, {}) : presetSetup(preset, setup.level));
/** The level stepper: a preset is re-made at the new level; Custom keeps its points (`withLevel` drops its gear level to the highest allowed). */
export function changeLevel(setup: DummySetup, level: number): DummySetup {
  if (!Number.isFinite(level)) return setup;
  return setup.preset === 'custom' ? withLevel(setup, level) : presetSetup(setup.preset, level);
}
/** One point more or less: never below 0, never above the top level's total. */
export function withPoint(setup: DummySetup, attribute: keyof Attributes, delta: 1 | -1): DummySetup {
  const value = Math.min(MOST_POINTS, Math.max(0, setup.allocations[attribute] + delta));
  return custom(setup, { allocations: { ...setup.allocations, [attribute]: value } });
}
export const withStance = (setup: DummySetup, stance: Stance): DummySetup => custom(setup, { stance });
export const withGear = (setup: DummySetup, slot: DummySlot, template: string | null): DummySetup =>
  custom(setup, { gear: { ...setup.gear, [slot]: template } });
/** A gear level the dummy's level allows (another is ignored). */
export const withGearLevel = (setup: DummySetup, gearLevel: 1 | 5 | 10): DummySetup =>
  (gearLevels(setup.level).includes(gearLevel) ? custom(setup, { gearLevel }) : setup);

/** Whether the dummy can fight: no more points than its level allows. */
export const fightable = (setup: DummySetup): boolean => pointsLeft(setup) >= 0;

/** "Points left: 0 of 14", or "24 points too many for level 4". */
export function pointsText(setup: DummySetup): { text: string; over: boolean } {
  const left = pointsLeft(setup);
  if (left >= 0) return { text: `Points left: ${left} of ${dummyPoints(setup.level)}`, over: false };
  return { text: `${-left} ${left === -1 ? 'point' : 'points'} too many for level ${setup.level}`, over: true };
}

/** What the level gives, under the Level and Stance. */
export function pointsHelp(level: number): string {
  const { trainingCapBase, trainingCapPerLevel } = RULES_V2.progression;
  return `${dummyPoints(level)} attribute points: the most a level ${level} gladiator can have from Training (${trainingCapBase} + ${trainingCapPerLevel} per level). `
    + 'Levels 5 and 10 open better gear.';
}

/** The preview's line under "Training dummy". */
export const dummySubline = (setup: DummySetup): string => `Level ${setup.level} · no class bonus · ${setup.stance} stance`;

/** The phone preview's numbers, from the comparison's dummy column. */
export function summaryLine(rows: ReturnType<typeof comparisonRows>): string {
  const of = (label: string) => rows.find(row => row[0] === label)?.[2] ?? '';
  return `Health ${of('Health')} · Damage ${of('Damage')} · every ${of('Attack speed')} · blocks ${of('Armor blocks')} · Critical ${of('Critical')}`;
}

/** The mockup's overload line, or null when the dummy carries no more than it can. */
export function overloadText(setup: DummySetup): string | null {
  const { load, capacity, efficiency } = dummyLoad(setup);
  if (load <= capacity) return null;
  const decimals = (value: number) => String(Math.round(value * 100) / 100);
  return `Overloaded: load ${decimals(load)} of ${decimals(capacity)}, fighting at ${Math.round(efficiency * 100)}%.`;
}

const classWord = (classId: string) => classId.charAt(0).toUpperCase() + classId.slice(1);
/** The footer: who fights the dummy and under which rules (a phone's is short). */
export function footerText(owner: Pick<OwnerState, 'currentBuild' | 'progression'>, compact: boolean): string {
  if (compact) return 'Your current build, Arena rules.';
  const more = Math.round((RULES_V1.shops.renownArenaMultiplier - 1) * 100);
  return `You fight with your current build (${classWord(owner.currentBuild.classId)}, level ${owner.progression.level}). Arena rules: renown gear counts ${more}% more.`;
}
