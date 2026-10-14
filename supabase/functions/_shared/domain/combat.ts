import type { BattleAction, BattleLog, BattleVictory, RevealedCombatant } from '../contracts/events.ts';
import type { Attributes, BattleInput, BattleParticipant, BuildSnapshot, FighterSnapshot, Rules, Seed } from './types.ts';
import { freezeDomain } from './types.ts';
import { deriveStats } from './stats.ts';
import { seededRandom } from './random.ts';

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const numeric = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
function copyAttributes(a: Readonly<Attributes>): Attributes {
  return { strength: a.strength, agility: a.agility, vitality: a.vitality, endurance: a.endurance, precision: a.precision };
}
/** Exact rational arithmetic for decimal factors; shared with Arena estimates and NPC templates (Task 16). */
export type Fraction = { numerator: bigint; denominator: bigint };
/** Exact decimal factors prevent e.g. 50 × 1.15 rounding 57.499999… down. */
export function decimal(value: number): Fraction {
  if (!numeric(value)) throw new RangeError('Invalid combat coefficient');
  const [significand, exponent = '0'] = value.toString().split('e');
  const decimalPlaces = significand.split('.')[1]?.length ?? 0;
  const scale = decimalPlaces - Number(exponent);
  const numerator = BigInt(significand.replace('.', ''));
  return scale >= 0 ? { numerator, denominator: 10n ** BigInt(scale) }
    : { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n };
}
export function multiply(a: Fraction, b: Fraction): Fraction {
  return { numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator };
}
export const fractionValue = (fraction: Fraction) => Number(fraction.numerator) / Number(fraction.denominator);
function baseDamage(weapon: number, strength: number, coefficient: number): number {
  const a = decimal(weapon), b = multiply(decimal(strength), decimal(coefficient));
  return Number(a.numerator * b.denominator + b.numerator * a.denominator) / Number(a.denominator * b.denominator);
}
function roundedDamage(attacker: FighterSnapshot, defender: FighterSnapshot, rules: Rules, critical: boolean): number {
  const armor = multiply(decimal(rules.combat.armorReductionPerPoint), decimal(defender.armor));
  const cap = decimal(rules.combat.maximumArmorReduction);
  const reduction = armor.numerator * cap.denominator < cap.numerator * armor.denominator ? armor : cap;
  const remaining = { numerator: reduction.denominator - reduction.numerator, denominator: reduction.denominator };
  const total = [attacker.baseDamage, attacker.efficiency, critical ? rules.combat.criticalDamage : 1,
    rules.stances[attacker.stance].outgoing, rules.stances[defender.stance].incoming]
    .map(decimal).reduce(multiply, remaining);
  // One final nonnegative integer half-up rounding, after all modifiers.
  return Math.max(rules.combat.minimumDamage,
    Number((2n * total.numerator + total.denominator) / (2n * total.denominator)));
}

/** Freeze effective combat stats, not owned items. Identity belongs to the battle participant. */
export function makeFighter(build: BuildSnapshot, context: 'arena' | 'expedition', rules: Rules): FighterSnapshot {
  if (context !== 'arena' && context !== 'expedition') throw new RangeError('Unknown combat context');
  if (!Object.hasOwn(rules.stances, build.stance)) throw new RangeError('Unknown combat stance');
  const stats = deriveStats(build, rules);
  // Only the weapon component gets the bound arena bonus; Strength does not.
  const weaponDamage = context === 'arena'
    ? fractionValue(multiply(decimal(stats.weaponDamage), decimal(stats.arenaWeaponMultiplier)))
    : stats.weaponDamage;
  return freezeDomain({ rulesVersion: rules.version, classId: build.classId, stance: build.stance,
    attributes: copyAttributes(stats.attributes), maxHealth: stats.maxHp,
    armor: context === 'arena' ? stats.arenaArmor : stats.armor, weaponDamage,
    baseDamage: baseDamage(weaponDamage, stats.attributes.strength, rules.combat.strengthDamage),
    attackIntervalMs: Math.round(Math.max(rules.combat.minimumIntervalMs,
      stats.weaponIntervalMs / ((1 + rules.combat.agilityRate * stats.attributes.agility) * stats.efficiency))),
    efficiency: stats.efficiency,
    equipmentSilhouettes: Object.values(build.equipment).filter(item => item !== null).map(item => item.catalogId),
  });
}

/** The engine's private snapshot checks for these retained rules. A snapshot without attributes throws a TypeError. */
export function validFighter(s: FighterSnapshot, rules: Rules): boolean {
  return s.rulesVersion === rules.version && Object.hasOwn(rules.stances, s.stance)
    && (s.classId === null || Object.hasOwn(rules.classes, s.classId))
    && positiveInteger(s.maxHealth) && positiveInteger(s.attackIntervalMs)
    && s.attackIntervalMs >= rules.combat.minimumIntervalMs
    && [s.armor, s.weaponDamage, s.baseDamage, ...Object.values(copyAttributes(s.attributes))].every(numeric)
    && Number.isFinite(s.efficiency) && s.efficiency > 0 && s.efficiency <= 1
    && Array.isArray(s.equipmentSilhouettes) && s.equipmentSilhouettes.every(value => typeof value === 'string');
}

function validateParticipant(p: BattleParticipant, rules: Rules): void {
  const s = p.snapshot;
  if (!p.id || typeof p.id !== 'string' || typeof p.name !== 'string'
    || (p.gladiatorId !== null && typeof p.gladiatorId !== 'string')
    || !validFighter(s, rules)
    || (p.startingHealth !== undefined && (!positiveInteger(p.startingHealth) || p.startingHealth > s.maxHealth))) {
    throw new RangeError('Invalid private combat snapshot');
  }
}

function publicParticipant(p: BattleParticipant): RevealedCombatant {
  const s = p.snapshot;
  // Explicit whitelist: never spread an authoritative input into a public replay DTO.
  return { id: p.id, gladiatorId: p.gladiatorId, name: p.name, classId: s.classId, stance: s.stance,
    attributes: copyAttributes(s.attributes), maxHealth: s.maxHealth, initialHealth: p.startingHealth ?? s.maxHealth,
    armor: s.armor, weaponDamage: s.weaponDamage, attackIntervalMs: s.attackIntervalMs,
    efficiencyBasisPoints: Math.round(s.efficiency * 10_000), equipmentSilhouettes: [...s.equipmentSilhouettes] };
}

/** Spec §7 hit probability of an attacker's effective Precision against a defender's effective Agility. */
export function hitProbability(precision: number, defenderAgility: number, rules: Rules): number {
  const r = rules.combat;
  return clamp(r.hitBase + r.hitPrecision * precision - r.hitDefenderAgility * defenderAgility, r.minimumHit, r.maximumHit);
}

/** Spec §7 critical probability of an attacker's effective Precision. */
export function criticalProbability(precision: number, rules: Rules): number {
  const r = rules.combat;
  return clamp(r.criticalBase + r.criticalPrecision * precision, r.minimumCritical, r.maximumCritical);
}

/** Both random draws occur for every scheduled attack, even a miss. No block/evade extra rolls. */
function attack(attacker: FighterSnapshot, defender: FighterSnapshot, rules: Rules, random: () => number) {
  const hit = random() < hitProbability(attacker.attributes.precision, defender.attributes.agility, rules);
  const criticalRoll = random();
  const critical = hit && criticalRoll < criticalProbability(attacker.attributes.precision, rules);
  const damage = hit ? roundedDamage(attacker, defender, rules, critical) : 0;
  if (!Number.isSafeInteger(damage) || damage < 0) throw new RangeError('Unsafe combat damage');
  return { hit, critical, damage, defend: hit && defender.stance === 'defensive', evade: !hit };
}

/** Pure v1 simulation: consume retained rules, never a mutable current-rules/catalog singleton. */
export function simulateBattle(input: BattleInput, seed: Seed): BattleLog {
  const { rules, fighters } = input;
  if (input.rulesVersion !== rules.version || typeof input.battleId !== 'string' || !input.battleId
    || fighters.length !== 2 || fighters[0].id === fighters[1].id
    || !positiveInteger(rules.combat.minimumIntervalMs) || !positiveInteger(rules.combat.maximumDurationMs)
    || rules.combat.maximumDurationMs === Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid battle input');
  fighters.forEach(p => validateParticipant(p, rules));
  const random = seededRandom(seed);
  const participants: [RevealedCombatant, RevealedCombatant] = [publicParticipant(fighters[0]), publicParticipant(fighters[1])];
  const hp: [number, number] = [participants[0].initialHealth, participants[1].initialHealth];
  const events: (BattleAction | BattleVictory)[] = [];
  // Two-entry timestamp priority queue. First attacks occur after their full intervals.
  const next = fighters.map(p => p.snapshot.attackIntervalMs);
  const limit = rules.combat.maximumDurationMs;
  let durationMs = limit;
  while (Math.min(...next) <= limit) {
    const elapsedMs = Math.min(...next);
    const group = [0, 1].filter(i => next[i] === elapsedMs);
    // Calculate the entire group against the pre-group live fighters, before applying HP changes.
    const resolved = group.map(i => ({ i, result: attack(fighters[i].snapshot, fighters[1 - i].snapshot, rules, random) }));
    for (const { i, result } of resolved) {
      const target = 1 - i;
      const healthBefore = hp[target];
      hp[target] = Math.max(0, healthBefore - result.damage);
      events.push({ kind: 'attack', sequence: events.length, elapsedMs,
        attackerId: fighters[i].id, defenderId: fighters[target].id, ...result, healthBefore, healthAfter: hp[target] });
      const interval = fighters[i].snapshot.attackIntervalMs;
      next[i] = interval > limit - elapsedMs ? limit + 1 : elapsedMs + interval;
    }
    if (hp[0] === 0 || hp[1] === 0) { durationMs = elapsedMs; break; }
  }
  let winner: number;
  let victoryReason: BattleVictory['reason'];
  let tieBreakReason: BattleLog['tieBreakReason'] = null;
  if ((hp[0] === 0) !== (hp[1] === 0)) {
    winner = hp[0] === 0 ? 1 : 0;
    victoryReason = 'defeat';
  } else {
    // Exact fractions without cross-product overflow or floating near-equality errors.
    const left = BigInt(hp[0]) * BigInt(fighters[1].snapshot.maxHealth);
    const right = BigInt(hp[1]) * BigInt(fighters[0].snapshot.maxHealth);
    if (left === right) {
      winner = random() < 0.5 ? 0 : 1;
      victoryReason = 'tie-break';
      tieBreakReason = hp[0] === 0 ? 'simultaneous-defeat' : 'equal-health-fraction';
    } else { winner = left > right ? 0 : 1; victoryReason = 'health-fraction'; }
  }
  const winnerId = fighters[winner].id;
  events.push({ kind: 'victory', sequence: events.length, elapsedMs: durationMs,
    winnerId, loserId: fighters[1 - winner].id, reason: victoryReason });
  return freezeDomain({ battleId: input.battleId, rulesVersion: input.rulesVersion,
    participants, events, durationMs, winnerId, victoryReason, finalHp: hp, tieBreakReason });
}
