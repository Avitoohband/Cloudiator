// Offline balance simulations for 2.0 (Task 20). Pure scenario functions on the shared combat domain; no number is changed.
// Relative `.ts` imports only, so `node scripts/balance/run-sims.ts` runs under Node type stripping.
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { criticalProbability, makeFighter, simulateBattle } from '../../supabase/functions/_shared/domain/combat.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import type { BuildSnapshot, FighterSnapshot, Rules } from '../../supabase/functions/_shared/domain/types.ts';

export type ScenarioId = 'critical' | 'two-handed' | 'renown';
export type Attrs = { strength: number; agility: number; vitality: number; endurance: number; precision: number };
export type Matchup = {
  id: string; label: string; level: number; context: 'arena' | 'expedition';
  wins: number; fights: number; winRate: number; low95: number; high95: number;
  meanDurationMs: number;
  /** The subject's landed share of its attacks. */
  meanHit: number;
  /** The subject's critical chance from its Precision. */
  criticalChance: number;
  /** The subject's critical hits per landed hit. */
  criticalRate: number;
  /** Share of the subject's damage dealt by critical hits. */
  criticalDamageShare: number;
  /** Fights in which the subject was the first listed side. */
  subjectFirst: number;
  seeds: string[];
};
export type ScenarioResult = { scenario: ScenarioId; fightsPerMatchup: number; matchups: Matchup[] };

const KEYS = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;
const NEUTRAL = 'neutral';
const RULES = { ...RULES_V1, classes: { ...RULES_V1.classes, [NEUTRAL]: { strength: 1, agility: 1, vitality: 1, endurance: 1, precision: 1 } } } as unknown as Rules;

/** The most points Training allows at a level (rules v2: 10 + 4 per level). */
export const pointsAt = (level: number): number => 10 + 4 * level;
const gearLevelAt = (level: number): 1 | 5 | 10 => (level >= 10 ? 10 : level >= 5 ? 5 : 1);

/** An even split, the leftover points going to the first keys in order. */
function evenSplit(total: number, keys: readonly (keyof Attrs)[]): Partial<Attrs> {
  const out: Partial<Attrs> = {};
  keys.forEach((key, i) => { out[key] = Math.floor(total / keys.length) + (i < total % keys.length ? 1 : 0); });
  return out;
}
export const balancedPoints = (level: number): Attrs => evenSplit(pointsAt(level), KEYS) as Attrs;
export function precisionPoints(total: number, precision: number): Attrs {
  const rest = evenSplit(total - precision, KEYS.filter(k => k !== 'precision'));
  return { strength: 0, agility: 0, vitality: 0, endurance: 0, ...rest, precision } as Attrs;
}

type Gear = { weapon: string; offHand: string | null; head: string; body: string; feet: string };
/** The Balanced preset's kit at a gear level, the weapon being a full catalog id. */
const kit = (weapon: string, tier: 1 | 5 | 10): Gear => ({ weapon, offHand: `round-shield:${tier}:common`, head: `leather-hood:${tier}:common`,
  body: `light-armor:${tier}:common`, feet: `light-boots:${tier}:common` });

/** A classless fighter: base 5 plus its points, catalog gear (an id is `template:tier:kind`), balanced stance. */
function fighter(allocations: Attrs, gear: Gear, context: 'arena' | 'expedition'): FighterSnapshot {
  const piece = (slot: string, id: string | null) => {
    if (id === null) return null;
    const item = CATALOG_V1.items[id];
    if (!item || item.slot !== slot) throw new RangeError(`${id} is not a ${slot} item`);
    return { id: `sim-${slot}`, ownerId: 'sim', catalogId: item.id, catalogVersion: CATALOG_V1.version, tier: item.tier, rarity: item.rarity,
      stats: structuredClone(item.stats), quantity: 1, origin: item.id.endsWith(':renown') ? 'renown' : 'shop', binding: 'tradable', reservation: null };
  };
  const twoHanded = CATALOG_V1.items[gear.weapon]?.hands === 2;
  const equipment = { weapon: piece('weapon', gear.weapon), offHand: twoHanded ? null : piece('offHand', gear.offHand),
    head: piece('head', gear.head), body: piece('body', gear.body), feet: piece('feet', gear.feet) };
  const build = { rulesVersion: RULES.version, classId: NEUTRAL, stance: 'balanced', allocations: { ...allocations }, equipment } as unknown as BuildSnapshot;
  return { ...makeFighter(build, context, RULES), classId: null } as FighterSnapshot;
}

/** The Wilson 95% interval of `wins` in `n`. */
export function wilson(wins: number, n: number): [low: number, high: number] {
  if (n === 0) return [0, 1];
  const z = 1.959964, p = wins / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

type Spec = { id: string; label: string; level: number; context: 'arena' | 'expedition'; subject: FighterSnapshot; opponent: FighterSnapshot; criticalChance: number };

function fight(spec: Spec, scenario: ScenarioId, fights: number): Matchup {
  let wins = 0, duration = 0, attacks = 0, hits = 0, crits = 0, damage = 0, critDamage = 0, subjectFirst = 0;
  const seeds: string[] = [];
  for (let n = 0; n < fights; n++) {
    const seed = `sim-${scenario}-${spec.id}-${n}`;
    seeds.push(seed);
    const swap = n % 2 === 1; // odd fights list the subject second: the first-attacker bias cancels
    if (!swap) subjectFirst++;
    const subject = { id: 'subject', gladiatorId: null, name: 'Subject', snapshot: spec.subject };
    const opponent = { id: 'opponent', gladiatorId: null, name: 'Opponent', snapshot: spec.opponent };
    const log = simulateBattle({ battleId: 'sim', rulesVersion: RULES.version, rules: RULES, fighters: swap ? [opponent, subject] : [subject, opponent] } as never, seed);
    if (log.winnerId === 'subject') wins++;
    duration += log.durationMs;
    for (const event of log.events) {
      if (event.kind !== 'attack' || event.attackerId !== 'subject') continue;
      attacks++;
      if (event.hit) { hits++; damage += event.damage; if (event.critical) { crits++; critDamage += event.damage; } }
    }
  }
  const [low95, high95] = wilson(wins, fights);
  const winRate = wins / fights;
  return { id: spec.id, label: spec.label, level: spec.level, context: spec.context, wins, fights, winRate,
    low95: Math.min(low95, winRate), high95: Math.max(high95, winRate), meanDurationMs: duration / fights,
    meanHit: attacks ? hits / attacks : 0, criticalChance: spec.criticalChance,
    criticalRate: hits ? crits / hits : 0, criticalDamageShare: damage ? critDamage / damage : 0, subjectFirst, seeds };
}

function specs(id: ScenarioId): Spec[] {
  const out: Spec[] = [];
  if (id === 'critical') {
    const level = 10, total = pointsAt(level), opponent = fighter(balancedPoints(level), kit('sword:10:common', 10), 'arena');
    for (const precision of [0, 10, 20, 30, 40, 50]) {
      const subject = fighter(precisionPoints(total, precision), kit('sword:10:common', 10), 'arena');
      out.push({ id: `precision-${precision}`, label: `Precision ${precision} vs Balanced`, level, context: 'arena', subject, opponent,
        criticalChance: criticalProbability(subject.attributes.precision, RULES) });
    }
  } else if (id === 'two-handed') {
    const name = (weapon: string) => weapon[0].toUpperCase() + weapon.slice(1);
    for (const level of [1, 5, 10]) {
      const tier = gearLevelAt(level), points = balancedPoints(level);
      for (const two of ['spear', 'bow']) for (const one of ['sword', 'axe']) {
        out.push({ id: `${two}-vs-${one}-L${level}`, label: `${name(two)} vs ${name(one)} + Round shield`, level, context: 'arena',
          subject: fighter(points, kit(`${two}:${tier}:common`, tier), 'arena'), opponent: fighter(points, kit(`${one}:${tier}:common`, tier), 'arena'), criticalChance: 0 });
      }
    }
  } else {
    for (const context of ['arena', 'expedition'] as const) for (const level of [1, 5, 10]) {
      const tier = gearLevelAt(level), points = balancedPoints(level);
      out.push({ id: `renown-vs-common-${context}-L${level}`, label: `sword:${tier}:renown vs sword:${tier}:common`, level, context,
        subject: fighter(points, kit(`sword:${tier}:renown`, tier), context), opponent: fighter(points, kit(`sword:${tier}:common`, tier), context), criticalChance: 0 });
    }
    const points = balancedPoints(10);
    out.push({ id: 'renown5-vs-common10-arena-L10', label: 'sword:5:renown vs sword:10:common', level: 10, context: 'arena',
      subject: fighter(points, kit('sword:5:renown', 10), 'arena'), opponent: fighter(points, kit('sword:10:common', 10), 'arena'), criticalChance: 0 });
  }
  return out;
}

export function runScenario(id: ScenarioId, fights: number): ScenarioResult {
  return { scenario: id, fightsPerMatchup: fights, matchups: specs(id).map(spec => fight(spec, id, fights)) };
}
