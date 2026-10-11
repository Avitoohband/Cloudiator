import type { BuildSnapshot, DerivedStats, Rules } from './types.ts';

function safeResource(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Resource must be a nonnegative safe integer');
}
const cents = (value: number) => Math.round(value * 100);

/** Input is an authoritative validated snapshot; retain rolled stats, not current catalog stats. */
export function deriveStats(build: BuildSnapshot, rules: Rules): DerivedStats {
  if (build.rulesVersion !== rules.version || !Object.hasOwn(rules.classes, build.classId)) throw new RangeError('Unknown build rules or class');
  const items = Object.values(build.equipment).filter(item => item !== null);
  const attributes = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };
  for (const key of Object.keys(attributes) as (keyof typeof attributes)[]) {
    const allocation = build.allocations[key];
    if (!Number.isSafeInteger(allocation) || allocation < 0 || allocation > rules.attributes.maximumPoints) throw new RangeError('Invalid allocation');
    const bonuses = items.reduce((sum, item) => sum + cents(item.stats.attributes[key]), 0);
    const baseCents = (rules.attributes.base + allocation) * 100 + bonuses;
    // Integer hundredths and percentage points avoid binary half-cent rounding drift.
    attributes[key] = Math.round(baseCents * Math.round(rules.classes[build.classId][key] * 100) / 100) / 100;
    if (!Number.isFinite(attributes[key]) || attributes[key] < 0) throw new RangeError('Invalid rolled attribute stats');
  }
  const r = rules.resources;
  const maxHp = Math.floor(r.healthBase + r.healthPerVitality * attributes.vitality);
  const maxStamina = Math.floor(r.staminaBase + r.staminaPerEndurance * attributes.endurance);
  const loadCapacity = r.capacityBase + r.capacityPerEndurance * attributes.endurance;
  const load = items.reduce((sum, item) => sum + cents(item.stats.weight), 0) / 100;
  const overload = Math.max(0, (load - loadCapacity) / loadCapacity);
  const efficiency = Math.max(r.minimumEfficiency, 1 - r.overloadPenalty * overload);
  const armor = items.reduce((sum, item) => sum + cents(item.stats.armor), 0) / 100;
  const arenaArmor = Math.round(items.reduce((sum, item) => sum + cents(item.stats.armor)
    * (item.origin === 'renown' ? Math.round(rules.shops.renownArenaMultiplier * 100) : 100), 0) / 100) / 100;
  const weapon = build.equipment.weapon;
  return { attributes, maxHp, maxStamina, loadCapacity, load, overload, efficiency, armor,
    weaponDamage: weapon?.stats.damage ?? rules.combat.unarmedDamage,
    weaponIntervalMs: weapon?.stats.intervalMs ?? rules.combat.unarmedIntervalMs,
    arenaWeaponMultiplier: weapon?.origin === 'renown' ? rules.shops.renownArenaMultiplier : 1, arenaArmor };
}

export function activityCost(base: number, overload: number): number {
  safeResource(base);
  if (!Number.isFinite(overload) || overload < 0) throw new RangeError('Invalid overload ratio');
  const cost = Math.ceil(base * (1 + overload));
  safeResource(cost);
  return cost;
}

/** Preview/apply a build change without manufacturing stamina. */
export function preserveStamina(current: number, maximum: number): number {
  safeResource(current);
  safeResource(maximum);
  return Math.min(current, maximum);
}
