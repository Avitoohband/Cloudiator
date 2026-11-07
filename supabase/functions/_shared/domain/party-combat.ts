import type { PartyAttack, PartyBattleLog, PartyCombatant, PartyRole, PartyVictory } from '../contracts/events.ts';
import { criticalProbability, hitProbability, roundedDamage, validFighter } from './combat.ts';
import { seededRandom } from './random.ts';
import { isRulesV2 } from './rules.ts';
import { freezeDomain, type DeepReadonly, type FighterSnapshot, type Rules, type Seed } from './types.ts';

export type SkirmishUnit = DeepReadonly<{
  id: string; gladiatorId: string | null; name: string; side: 0 | 1; role: PartyRole; seat: number | null;
  snapshot: FighterSnapshot; startingHealth?: number;
}>;
export type SkirmishInput = DeepReadonly<{ battleId: string; rulesVersion: string; rules: Rules; units: SkirmishUnit[] }>;

const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

function validUnit(unit: SkirmishUnit, rules: Rules): boolean {
  if (!unit || typeof unit.id !== 'string' || !unit.id || typeof unit.name !== 'string'
    || (unit.gladiatorId !== null && typeof unit.gladiatorId !== 'string')) return false;
  const { side, role, seat, snapshot, startingHealth } = unit;
  if (side === 0) {
    if (role !== 'gladiator' && role !== 'bot' && role !== 'hireling') return false;
    if (role === 'bot' && (seat === null || unit.gladiatorId !== unit.id)) return false;
    if (seat !== null && (!Number.isSafeInteger(seat) || seat < 0)) return false;
  } else if (side !== 1 || (role !== 'monster' && role !== 'major') || seat !== null) return false;
  return !!snapshot?.attributes && validFighter(snapshot, rules)
    && (startingHealth === undefined || (positiveInteger(startingHealth) && startingHealth <= snapshot.maxHealth));
}

function publicParticipant(unit: SkirmishUnit): PartyCombatant {
  const { id, gladiatorId, name, side, role, seat, snapshot, startingHealth } = unit;
  const { classId, stance, maxHealth, armor, weaponDamage, attackIntervalMs, efficiency, equipmentSilhouettes } = snapshot;
  const { strength, agility, vitality, endurance, precision } = snapshot.attributes;
  // Explicit public whitelist. Never spread the private snapshot or its attributes into the log.
  return { id, gladiatorId, name, classId, stance, attributes: { strength, agility, vitality, endurance, precision },
    maxHealth, initialHealth: startingHealth ?? maxHealth, armor, weaponDamage, attackIntervalMs,
    efficiencyBasisPoints: Math.round(efficiency * 10_000), equipmentSilhouettes: [...equipmentSilhouettes], side, role, seat };
}

/** Simulate a v2 party fight with a separate log and seeded stream. Unit order stays stable within each side. */
export function simulateSkirmish(input: SkirmishInput, seed: Seed): PartyBattleLog {
  if (!input) throw new RangeError('Invalid party combat input');
  const { battleId, rulesVersion, rules } = input;
  if (typeof battleId !== 'string' || !battleId || !rules || !isRulesV2(rules) || rulesVersion !== rules.version
    || !rules.dungeon || !positiveInteger(rules.combat?.minimumIntervalMs) || !positiveInteger(rules.combat?.maximumDurationMs)
    || rules.combat.maximumDurationMs === Number.MAX_SAFE_INTEGER
    || !Array.isArray(input.units) || input.units.length < 2 || input.units.length > 12) {
    throw new RangeError('Invalid party combat input');
  }
  const units: readonly SkirmishUnit[] = input.units;
  const sides: [number[], number[]] = [[], []];
  const ids = new Set<string>();
  for (const [index, unit] of units.entries()) {
    if (!validUnit(unit, rules) || ids.has(unit.id)) throw new RangeError('Invalid private party combat snapshot');
    ids.add(unit.id);
    sides[unit.side].push(index);
  }
  if (sides.some(side => side.length < 1 || side.length > 6)) throw new RangeError('Invalid party combat side size');

  const { targetWeights, sweepEvery, sweepFactor } = rules.dungeon;
  const random = seededRandom(seed);
  const participants = units.map(publicParticipant);
  const hp = participants.map(unit => unit.initialHealth);
  const events: (PartyAttack | PartyVictory)[] = [];
  const next = units.map(unit => unit.snapshot.attackIntervalMs);
  const turns = units.map(() => 0);
  const limit = rules.combat.maximumDurationMs;
  let durationMs = limit;
  while (Math.min(...next) <= limit) {
    const elapsedMs = Math.min(...next);
    const groupHp = hp.slice();
    const party = sides[0].filter(index => groupHp[index] > 0);
    const monsters = sides[1].filter(index => groupHp[index] > 0);
    for (const [standing, enemies] of [[party, monsters], [monsters, party]]) {
      for (const index of standing) {
        if (next[index] !== elapsedMs) continue;
        const unit = units[index];
        const attacker = unit.snapshot;
        const sweep = unit.role === 'major' && ++turns[index] % sweepEvery === 0;
        let targets: readonly number[];
        if (sweep) targets = enemies;
        else if (unit.side === 0) targets = [enemies.reduce((lowest, enemy) => groupHp[enemy] < groupHp[lowest] ? enemy : lowest)];
        else if (enemies.length === 1) targets = enemies;
        else {
          const weights = enemies.map(enemy => targetWeights[units[enemy].snapshot.stance]);
          const draw = random() * weights.reduce((sum, weight) => sum + weight, 0);
          let running = 0;
          targets = [enemies[weights.findIndex(weight => (running += weight) > draw)]];
        }

        // Targets and scheduled attackers use pre-group health. The visible deltas use the actual event order.
        for (const target of targets) {
          const defender = units[target].snapshot;
          const hit = random() < hitProbability(attacker.attributes.precision, defender.attributes.agility, rules);
          const criticalRoll = random();
          const critical = hit && criticalRoll < criticalProbability(attacker.attributes.precision, rules);
          const damage = hit ? roundedDamage(attacker, defender, rules, critical, sweep ? sweepFactor : 1) : 0;
          if (!Number.isSafeInteger(damage) || damage < 0) throw new RangeError('Unsafe combat damage');
          const healthBefore = hp[target];
          const healthAfter = Math.max(0, healthBefore - damage);
          hp[target] = healthAfter;
          events.push({ kind: 'attack', sequence: events.length, elapsedMs, attackerId: unit.id, defenderId: units[target].id,
            hit, critical, defend: hit && defender.stance === 'defensive', evade: !hit, damage, healthBefore, healthAfter, sweep });
        }
        const interval = attacker.attackIntervalMs;
        next[index] = interval > limit - elapsedMs ? limit + 1 : elapsedMs + interval;
      }
    }
    if (sides.some(side => side.every(index => hp[index] === 0))) { durationMs = elapsedMs; break; }
    for (let index = 0; index < units.length; index++) if (hp[index] === 0) next[index] = limit + 1;
  }

  const totals = sides.map(side => side.reduce((sum, index) => ({
    health: sum.health + BigInt(hp[index]), maximum: sum.maximum + BigInt(units[index].snapshot.maxHealth),
  }), { health: 0n, maximum: 0n }));
  const [party, monsters] = totals;
  let winnerSide: 0 | 1;
  let victoryReason: PartyBattleLog['victoryReason'];
  let tieBreakReason: PartyBattleLog['tieBreakReason'] = null;
  if ((party.health === 0n) !== (monsters.health === 0n)) {
    winnerSide = party.health === 0n ? 1 : 0;
    victoryReason = 'defeat';
  } else {
    const left = party.health * monsters.maximum, right = monsters.health * party.maximum;
    if (left === right) {
      winnerSide = random() < 0.5 ? 0 : 1;
      victoryReason = 'tie-break';
      tieBreakReason = party.health === 0n ? 'simultaneous-defeat' : 'equal-health-fraction';
    } else {
      winnerSide = left > right ? 0 : 1;
      victoryReason = 'health-fraction';
    }
  }
  events.push({ kind: 'victory', sequence: events.length, elapsedMs: durationMs, winnerSide, reason: victoryReason });
  return freezeDomain({ battleId, rulesVersion, participants, events, durationMs, winnerSide, victoryReason, finalHp: hp, tieBreakReason });
}
