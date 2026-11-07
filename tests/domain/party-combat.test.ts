import { describe, expect, it } from 'vitest';
import { roundedDamage } from '@domain/combat.ts';
import { simulateSkirmish, type SkirmishInput, type SkirmishUnit } from '@domain/party-combat.ts';
import { seededRandom } from '@domain/random.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import type { FighterSnapshot, Stance } from '@domain/types.ts';

const attrs = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };
function unit(id: string, side: 0 | 1, snapshot: Partial<FighterSnapshot> = {}, extra: Partial<SkirmishUnit> = {}): SkirmishUnit {
  return { id, side, role: side === 0 ? 'gladiator' : 'monster', seat: side === 0 ? 0 : null,
    name: id, gladiatorId: side === 0 ? id : null, snapshot: { rulesVersion: 'v2', classId: null, stance: 'balanced',
      attributes: attrs, maxHealth: 1000, armor: 0, weaponDamage: 10, baseDamage: 10, attackIntervalMs: 1000,
      efficiency: 1, equipmentSilhouettes: [], ...snapshot }, ...extra };
}
const input = (...units: SkirmishUnit[]): SkirmishInput => ({ battleId: 'dungeon:1:wolf-den:1:fight:1', rulesVersion: 'v2', rules: RULES_V2, units });
const attacks = (fight: SkirmishInput, seed = 'party-a') => simulateSkirmish(fight, seed).events.filter(event => event.kind === 'attack');
const delayed = { attackIntervalMs: 120_001 };
const precision = (value: number) => ({ attributes: { ...attrs, precision: value } });
const agility = (value: number) => ({ attributes: { ...attrs, agility: value } });

describe('party combat', () => {
  it('is deterministic per seed', () => {
    const fight = input(unit('g', 0), unit('monster', 1));
    expect(simulateSkirmish(fight, 'party-a')).toEqual(simulateSkirmish(structuredClone(fight), 'party-a'));
    expect(attacks(fight, 'party-a')).not.toEqual(attacks(fight, 'party-b'));
  });

  it('keeps the two-fighter damage exactly and rounds only after applying the sweep factor', () => {
    const random = seededRandom('damage-pairs');
    const stances: readonly Stance[] = ['defensive', 'balanced', 'offensive'];
    const fighter = () => unit('g', 0, { rulesVersion: 'v1', stance: stances[Math.floor(random() * 3)],
      baseDamage: Math.floor(random() * 10_000) / 100, armor: Math.floor(random() * 1000) / 10,
      efficiency: 0.5 + Math.floor(random() * 51) / 100 }).snapshot;
    for (let i = 0; i < 200; i++) {
      const attacker = fighter(), defender = fighter(), critical = random() < 0.5;
      expect(roundedDamage(attacker, defender, RULES_V1, critical, 1)).toBe(roundedDamage(attacker, defender, RULES_V1, critical));
    }
    const base = unit('g', 0, { rulesVersion: 'v1' }).snapshot;
    expect(roundedDamage(base, base, RULES_V1, false, 0.6)).toBe(6);
    expect(roundedDamage(base, base, RULES_V1, true, 0.6)).toBe(9);
    expect(roundedDamage({ ...base, baseDamage: 7.49 }, base, RULES_V1, false, 0.6)).toBe(4);
  });

  it('targets the standing enemy with the lowest health, breaking ties by unit index', () => {
    const log = attacks(input(unit('g', 0), unit('first', 1, delayed, { startingHealth: 50 }),
      unit('second', 1, delayed, { startingHealth: 30 }), unit('third', 1, delayed, { startingHealth: 30 })));
    expect(log[0]).toMatchObject({ attackerId: 'g', defenderId: 'second', elapsedMs: 1000, sweep: false });
  });

  it.each([1, 2])('draws a target only with multiple standing party units (%i targets)', count => {
    const seed = 'draw-order';
    const g = unit('guard', 0, { ...delayed, stance: 'defensive', ...agility(20) });
    const s = unit('striker', 0, { ...delayed, stance: 'offensive', ...agility(0) }, { seat: 1 });
    const monster = unit('monster', 1, precision(50));
    const log = attacks(input(g, ...count === 1 ? [] : [s], monster), seed).slice(0, 4);
    const random = seededRandom(seed);
    const expected = Array.from({ length: 4 }, (_, i) => {
      const target = count === 1 || random() < 0.75 ? 'guard' : 'striker';
      const hit = random() < (target === 'guard' ? 0.89 : 0.95);
      const criticalRoll = random();
      return { defenderId: target, elapsedMs: 1000 * (i + 1), hit, critical: hit && criticalRoll < 0.2 };
    });
    expect(log.map(({ defenderId, elapsedMs, hit, critical }) => ({ defenderId, elapsedMs, hit, critical }))).toEqual(expected);
  });

  it('weights monster targets 3 / 2 / 1 by stance', () => {
    const party = (['defensive', 'balanced', 'offensive'] as const).map((stance, seat) =>
      unit(stance, 0, { ...delayed, stance, maxHealth: 1_000_000 }, { seat }));
    const fight = input(...party, unit('monster', 1, { attackIntervalMs: 6000 }));
    const counts = { defensive: 0, balanced: 0, offensive: 0 };
    for (let seed = 0; seed < 200; seed++) {
      for (const attack of attacks(fight, `weighted:${seed}`)) counts[attack.defenderId as Stance]++;
    }
    for (const [stance, expected] of [['defensive', 1 / 2], ['balanced', 1 / 3], ['offensive', 1 / 6]] as const) {
      expect(Math.abs(counts[stance] / 4000 - expected), stance).toBeLessThanOrEqual(0.02);
    }
  });

  it('sweeps every standing party unit on the fourth and eighth major attacks at 0.6 damage', () => {
    const guard = unit('guard', 0, { ...delayed, stance: 'defensive', armor: 4 });
    const striker = unit('striker', 0, { ...delayed, stance: 'offensive' }, { seat: 1 });
    const major = unit('major', 1, precision(25), { role: 'major' });
    const seed = 'major-sweep';
    const log = attacks(input(guard, major, striker), seed);
    const random = seededRandom(seed);
    let hitCount = 0;
    for (let attack = 1; attack <= 8; attack++) {
      const sweep = attack === 4 || attack === 8;
      const targets = sweep ? [guard, striker] : [random() < 0.75 ? guard : striker];
      const events = log.filter(event => event.elapsedMs === attack * 1000);
      expect(events.map(event => event.defenderId)).toEqual(targets.map(target => target.id));
      targets.forEach((target, index) => {
        const hit = random() < 0.825;
        const criticalRoll = random();
        const critical = hit && criticalRoll < 0.125;
        if (hit && sweep) hitCount++;
        expect(events[index]).toMatchObject({ sweep, hit, critical, damage: hit
          ? roundedDamage(major.snapshot, target.snapshot, RULES_V1, critical, sweep ? 0.6 : 1) : 0 });
      });
    }
    expect(hitCount).toBeGreaterThan(0);
  });

  it('orders simultaneous attacks by side and resolves targets from the pre-group health', () => {
    // Find a draw with all attacks landing; the fourth draw is the monster's two-target selection.
    const seed = Array.from({ length: 100 }, (_, i) => `group:${i}`).find(candidate => {
      const roll = seededRandom(candidate);
      return [roll(), roll(), roll(), roll(), roll(), roll()].every(value => value < 0.7);
    })!;
    const a = unit('a', 0, { ...precision(100), baseDamage: 100 });
    const b = unit('b', 0, precision(100), { seat: 1 });
    const first = unit('first', 1, precision(100), { startingHealth: 5 });
    const second = unit('second', 1, delayed, { startingHealth: 6 });
    const events = attacks(input(first, a, second, b), seed).filter(event => event.elapsedMs === 1000);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ sequence: 0, attackerId: 'a', defenderId: 'first', healthBefore: 5, healthAfter: 0 });
    expect(events[1]).toMatchObject({ sequence: 1, attackerId: 'b', defenderId: 'first', healthBefore: 0, healthAfter: 0 });
    expect(events[2]).toMatchObject({ sequence: 2, attackerId: 'first' });
  });

  it('ends on defeat as soon as one side falls', () => {
    const seed = 'seed-a'; // Its first roll lands.
    const log = simulateSkirmish(input(unit('g', 0), unit('monster', 1, delayed, { startingHealth: 1 })), seed);
    expect(log).toMatchObject({ durationMs: 1000, winnerSide: 0, victoryReason: 'defeat', finalHp: [1000, 0], tieBreakReason: null });
    expect(log.events.at(-1)).toEqual({ kind: 'victory', sequence: 1, elapsedMs: 1000, winnerSide: 0, reason: 'defeat' });
  });

  it('uses the next seeded draw for simultaneous defeat', () => {
    const seed = Array.from({ length: 100 }, (_, i) => `tie:${i}`).find(candidate => {
      const roll = seededRandom(candidate);
      const first = roll(); roll();
      return first < 0.7 && roll() < 0.7;
    })!;
    const random = seededRandom(seed);
    for (let i = 0; i < 4; i++) random();
    expect(simulateSkirmish(input(unit('g', 0, {}, { startingHealth: 1 }), unit('monster', 1, {}, { startingHealth: 1 })), seed))
      .toMatchObject({ durationMs: 1000, winnerSide: random() < 0.5 ? 0 : 1, victoryReason: 'tie-break',
        tieBreakReason: 'simultaneous-defeat', finalHp: [0, 0] });
  });

  it('decides a 120 s fight by total health fraction with exact integer sums', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const giant = { ...delayed, maxHealth: max };
    const fight = input(unit('a', 0, giant), unit('b', 0, giant, { seat: 1, startingHealth: max - 2 }),
      unit('x', 1, giant), unit('y', 1, giant, { startingHealth: max - 1 }));
    const log = simulateSkirmish(fight, 'health-fraction');
    expect(log).toMatchObject({ durationMs: 120_000, winnerSide: 1, victoryReason: 'health-fraction', tieBreakReason: null,
      finalHp: [max, max - 2, max, max - 1] });
    expect(log.events).toHaveLength(1);
  });

  it('uses a seeded tie-break for an exact health-fraction tie at 120 s', () => {
    const seed = 'time-tie';
    const fight = input(unit('g', 0, { ...delayed, maxHealth: 100 }, { startingHealth: 25 }),
      unit('monster', 1, { ...delayed, maxHealth: 200 }, { startingHealth: 50 }));
    expect(simulateSkirmish(fight, seed)).toMatchObject({ durationMs: 120_000, winnerSide: seededRandom(seed)() < 0.5 ? 0 : 1,
      victoryReason: 'tie-break', tieBreakReason: 'equal-health-fraction', finalHp: [25, 50] });
  });

  it('refuses invalid unit counts, duplicate IDs, mixed rules and invalid fighter snapshots', () => {
    const a = unit('a', 0), m = unit('monster', 1);
    const withoutAttributes = { ...m.snapshot, attributes: undefined } as unknown as FighterSnapshot;
    const invalid = [
      input(a, { ...m, id: 'a' }), input(a), input(...Array.from({ length: 7 }, (_, i) => unit(`a${i}`, 0, {}, { seat: i })), m),
      input(a, unit('old', 1, { rulesVersion: 'v1' })), input(a, { ...m, startingHealth: 1001 }),
      input(a, { ...m, snapshot: withoutAttributes }), { ...input(a, m), rulesVersion: 'v1' },
      { ...input(a, m), rulesVersion: 'v1', rules: RULES_V1 },
    ];
    for (const fight of invalid) expect(() => simulateSkirmish(fight, 'party-a')).toThrow(RangeError);
  });

  it('logs only whitelisted participant fields', () => {
    const log = simulateSkirmish(input(unit('a', 0), unit('monster', 1)), 'party-a');
    const keys = ['id', 'gladiatorId', 'name', 'classId', 'stance', 'attributes', 'maxHealth', 'initialHealth', 'armor',
      'weaponDamage', 'attackIntervalMs', 'efficiencyBasisPoints', 'equipmentSilhouettes', 'side', 'role', 'seat'].sort();
    for (const participant of log.participants) expect(Object.keys(participant).sort()).toEqual(keys);
  });
});
