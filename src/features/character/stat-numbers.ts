// The numbers under each help sentence on My gladiator (Patch 1.9 Task 10; the approved xp-help mockup). The sentences themselves are the profile
// card's (`statHelp`, `attributeHelp`); each tooltip adds a second line with the rule's real numbers, read from the rules the card's stats use
// (`RULES_V1`: combat and resources are the same in every version), so a change to the rules changes the words. Pure.
import type { Attributes } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';
import type { statHelp } from './profile-card';

/** A number as written: at most three decimals, none trailing ("0.5", "10", "0.3"). */
const n = (value: number) => String(Math.round(value * 1000) / 1000);
/** A fraction as a percentage ("0.005" is "0.5%"). */
const pct = (fraction: number) => `${n(fraction * 100)}%`;

const { resources: r, combat: c } = RULES_V1;

/** Sentences for the two bars that are not on the profile card: what stamina is for, and what the load is. */
export const staminaHelp = 'What your activities spend; resting gives it back. Endurance raises it.';
export const loadHelp = `How much your worn gear weighs against what you can carry. Over the limit you fight at lower efficiency (down to ${pct(r.minimumEfficiency)}).`;

export const statNumbers: Record<keyof typeof statHelp | 'Stamina' | 'Load', string> = {
  Health: `Base ${n(r.healthBase)}, plus ${n(r.healthPerVitality)} for each Vitality.`,
  Damage: `Each Strength adds ${n(c.strengthDamage)} damage.`,
  'Attack speed': `Each Agility speeds attacks by ${pct(c.agilityRate)}; never faster than every ${n(c.minimumIntervalMs / 1000)} s.`,
  Armor: `Each armor point blocks ${pct(c.armorReductionPerPoint)} of a hit, up to ${pct(c.maximumArmorReduction)}.`,
  Critical: `Base ${pct(c.criticalBase)}, plus ${pct(c.criticalPrecision)} for each Precision, up to ${pct(c.maximumCritical)}. A critical hits for ${n(c.criticalDamage)} times the damage.`,
  Stamina: `Base ${n(r.staminaBase)}, plus ${n(r.staminaPerEndurance)} for each Endurance.`,
  Load: `Capacity is ${n(r.capacityBase)}, plus ${n(r.capacityPerEndurance)} for each Endurance.`,
};

export const attributeNumbers: Record<keyof Attributes, string> = {
  strength: `Each point adds ${n(c.strengthDamage)} damage.`,
  agility: `Each point speeds attacks by ${pct(c.agilityRate)} and lowers enemies’ chance to hit you by ${pct(c.hitDefenderAgility)}.`,
  vitality: `Each point adds ${n(r.healthPerVitality)} health.`,
  endurance: `Each point adds ${n(r.staminaPerEndurance)} stamina and ${n(r.capacityPerEndurance)} load capacity.`,
  precision: `Each point adds ${pct(c.hitPrecision)} to hit and ${pct(c.criticalPrecision)} to critical chance.`,
};
