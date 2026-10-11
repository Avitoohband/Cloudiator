import { describe, expect, it } from 'vitest';
import { makeFighter, simulateBattle } from '@domain/combat.ts';
import { seededRandom } from '@domain/random.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import type { BattleInput, BattleParticipant, FighterSnapshot, Rules } from '@domain/types.ts';
import { baseFiveBuild, itemFixture } from '../fixtures/domain.ts';

const sureHits: Rules = { ...RULES_V1, combat: { ...RULES_V1.combat,
  minimumHit: 1, maximumHit: 1, minimumCritical: 0, maximumCritical: 0 } };
const sureCrits: Rules = { ...sureHits, combat: { ...sureHits.combat, minimumCritical: 1, maximumCritical: 1 } };
function participant(id: string, patch: Partial<FighterSnapshot> = {}): BattleParticipant {
  return { id, gladiatorId: null, name: id, snapshot: {
    rulesVersion: 'v1', classId: null, stance: 'balanced',
    attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 },
    maxHealth: 100, armor: 0, weaponDamage: 10, baseDamage: 10,
    attackIntervalMs: 1000, efficiency: 1, equipmentSilhouettes: [], ...patch,
  } };
}
function battle(a = participant('a'), b = participant('b'), rules = sureHits): BattleInput {
  return { battleId: 'battle-1', rulesVersion: rules.version, rules, fighters: [a, b] };
}
const attacks = (input: BattleInput, seed = 'seed-a') => simulateBattle(input, seed).events.filter(e => e.kind === 'attack');

describe('seeded randomness and retry determinism', () => {
  it('replays the same seed stream while different seeds change the stream', () => {
    const stream = (seed: string) => { const random = seededRandom(seed); return Array.from({ length: 16 }, () => random()); };
    expect(stream('seed-a')).toEqual(stream('seed-a'));
    expect(stream('seed-a')).not.toEqual(stream('seed-b'));
    expect(stream('seed-a').every(value => value >= 0 && value < 1)).toBe(true);
    // Frozen v1 vector, calculated independently from the documented 32-bit algorithm.
    expect(stream('seed-a').slice(0, 4)).toEqual([0.3855641798581928, 0.6668949092272669,
      0.06058924295939505, 0.5732229524292052]);
  });
  it('produces the same complete JSON battle after retries', () => {
    const input = battle(participant('a'), participant('b'), RULES_V1);
    expect(simulateBattle(input, 'seed-a')).toEqual(simulateBattle(structuredClone(input), 'seed-a'));
  });
  it('allows seeded winner variation without relying on participant ID order', () => {
    const input = battle(participant('z', { maxHealth: 1 }), participant('a', { maxHealth: 1 }));
    const winners = new Set(Array.from({ length: 64 }, (_, i) => simulateBattle(input, `seed-${i}`).winnerId));
    expect(winners).toEqual(new Set(['z', 'a']));
    const renamed = battle(participant('a', { maxHealth: 1 }), participant('z', { maxHealth: 1 }));
    expect(simulateBattle(input, 'seed-a').winnerId === 'z').toBe(simulateBattle(renamed, 'seed-a').winnerId === 'a');
  });
});

describe('fighter derivation', () => {
  it('adds effective Strength to zero unarmed item damage and delays the first attack', () => {
    const fighter = makeFighter(baseFiveBuild, 'arena', RULES_V1);
    expect(fighter).toMatchObject({ weaponDamage: 0, baseDamage: 2.75, attackIntervalMs: 952, maxHealth: 100 });
    const input = battle({ ...participant('a'), snapshot: fighter }, participant('b', { attackIntervalMs: 2000 }));
    expect(attacks(input)[0].elapsedMs).toBe(952);
  });
  it('applies overload once to damage and interval, after adding Strength', () => {
    const equipment = { weapon: itemFixture(CATALOG_V1.items['axe:1:common']), offHand: itemFixture(CATALOG_V1.items['round-shield:1:common']),
      head: itemFixture(CATALOG_V1.items['iron-helmet:1:common']), body: itemFixture(CATALOG_V1.items['heavy-armor:1:common']),
      feet: itemFixture(CATALOG_V1.items['heavy-boots:1:common']) };
    const snapshot = makeFighter({ ...baseFiveBuild, equipment }, 'arena', RULES_V1);
    expect(snapshot).toMatchObject({ efficiency: 0.775, baseDamage: 10.75, attackIntervalMs: 1720, armor: 14 });
    expect(attacks(battle({ ...participant('a'), snapshot }, participant('b', { attackIntervalMs: 3000 })))[0].damage).toBe(8);
  });
  it('applies renown weapon and armor bonuses exactly once in arena and never on expedition', () => {
    const equipment = { ...baseFiveBuild.equipment, weapon: itemFixture(CATALOG_V1.items['sword:1:renown']),
      body: itemFixture(CATALOG_V1.items['heavy-armor:1:renown']) };
    const build = { ...baseFiveBuild, equipment };
    expect(makeFighter(build, 'arena', RULES_V1)).toMatchObject({ weaponDamage: 6.6, baseDamage: 9.35, armor: 6.6 });
    expect(makeFighter(build, 'expedition', RULES_V1)).toMatchObject({ weaponDamage: 6, baseDamage: 8.75, armor: 6 });
    const arena = makeFighter(build, 'arena', RULES_V1);
    expect(attacks(battle({ ...participant('a'), snapshot: arena }, participant('b', { attackIntervalMs: 2000 })))[0].damage).toBe(9);
  });
  it('preserves fractional bound weapon damage until the final damage rounding', () => {
    const weapon = itemFixture(CATALOG_V1.items['sword:1:renown']);
    weapon.stats.damage = 6.65;
    const snapshot = makeFighter({ ...baseFiveBuild, equipment: { ...baseFiveBuild.equipment, weapon } }, 'arena', RULES_V1);
    expect(snapshot.weaponDamage).toBe(7.315);
    expect(snapshot.baseDamage).toBe(10.065);
  });
  it('preserves fractional bound arena armor through final attack damage rounding', () => {
    const body = itemFixture(CATALOG_V1.items['heavy-armor:1:renown']);
    body.stats.armor = 6.65;
    const build = { ...baseFiveBuild, equipment: { ...baseFiveBuild.equipment, body } };
    const defender = { ...participant('b'), snapshot: makeFighter(build, 'arena', RULES_V1) };
    // 20.5 × (1 − .02 × (6.65 × 1.1)) = 17.50085, rounds to 18.
    const log = simulateBattle(battle(participant('a', { baseDamage: 20.5, attackIntervalMs: 250 }), defender), 'seed-a');
    expect(log.events[0]).toMatchObject({ kind: 'attack', damage: 18, healthBefore: 100, healthAfter: 82 });
    expect(log.participants[1].armor).toBe(7.315);
    expect(makeFighter(build, 'expedition', RULES_V1).armor).toBe(6.65);
  });
  it('clamps very fast attacks to 250ms and freezes copied combat display data', () => {
    const sword = itemFixture(CATALOG_V1.items['sword:1:common']);
    const build = { ...baseFiveBuild, allocations: { ...baseFiveBuild.allocations, agility: 1000 },
      equipment: { ...baseFiveBuild.equipment, weapon: sword } };
    const snapshot = makeFighter(build, 'arena', RULES_V1);
    sword.stats.damage = 999;
    expect(snapshot.attackIntervalMs).toBe(250);
    expect(snapshot.weaponDamage).toBe(6);
    expect(snapshot.equipmentSilhouettes).toEqual(['sword:1:common']);
    expect(Object.isFrozen(snapshot.attributes)).toBe(true);
    expect(Object.isFrozen(snapshot.equipmentSilhouettes)).toBe(true);
    expect(Object.isFrozen(sword.stats)).toBe(false);
  });
  it('rejects a mismatched rules version', () => {
    expect(() => makeFighter({ ...baseFiveBuild, rulesVersion: 'missing' }, 'arena', RULES_V1)).toThrow(RangeError);
  });
});

describe('ordered simultaneous combat', () => {
  it('resolves mutual lethal damage at the same timestamp and always names a seeded winner', () => {
    const log = simulateBattle(battle(participant('a', { maxHealth: 5 }), participant('b', { maxHealth: 5 })), 'seed-a');
    expect(log.finalHp).toEqual([0, 0]);
    expect(log.durationMs).toBe(1000);
    expect(log.tieBreakReason).toBe('simultaneous-defeat');
    expect(log.victoryReason).toBe('tie-break');
    expect(log.events.slice(0, 2)).toMatchObject([
      { kind: 'attack', sequence: 0, elapsedMs: 1000, attackerId: 'a', healthBefore: 5, healthAfter: 0 },
      { kind: 'attack', sequence: 1, elapsedMs: 1000, attackerId: 'b', healthBefore: 5, healthAfter: 0 },
    ]);
    expect(log.events[2]).toMatchObject({ kind: 'victory', sequence: 2, elapsedMs: 1000 });
    expect(['a', 'b']).toContain(log.winnerId);
  });
  it('stops after an earlier lethal attack without allowing a defeated later attack', () => {
    const log = simulateBattle(battle(participant('a', { attackIntervalMs: 750 }), participant('b', { maxHealth: 5 })), 'seed-a');
    expect(log.finalHp).toEqual([100, 0]);
    expect(log.durationMs).toBe(750);
    expect(log.winnerId).toBe('a');
    expect(log.victoryReason).toBe('defeat');
    expect(log.tieBreakReason).toBeNull();
    expect(log.events).toHaveLength(2);
  });
  it('schedules timestamp priority including later equal-time attacks', () => {
    const events = attacks(battle(participant('a', { attackIntervalMs: 600 }), participant('b', { attackIntervalMs: 900 })));
    expect(events.slice(0, 5).map(e => [e.elapsedMs, e.attackerId])).toEqual([[600, 'a'], [900, 'b'], [1200, 'a'], [1800, 'a'], [1800, 'b']]);
  });
  it('reproduces final health by reducing its ordered health events', () => {
    const input = battle(participant('a', { attackIntervalMs: 600 }), participant('b', { attackIntervalMs: 900 }), RULES_V1);
    const log = simulateBattle(input, 'seed-a');
    const hp: Record<string, number> = { a: 100, b: 100 };
    log.events.forEach((event, sequence) => {
      expect(event.sequence).toBe(sequence);
      if (event.kind === 'attack') {
        expect(event.healthBefore).toBe(hp[event.defenderId]);
        hp[event.defenderId] = event.healthAfter;
      }
    });
    expect(log.finalHp).toEqual([hp.a, hp.b]);
  });
});

describe('damage and probability rules', () => {
  it.each([
    [50, 1, 0, sureHits, 58],
    [60, 1, 0, sureCrits, 104],
    [62.5, 1, 2, sureCrits, 104],
    [100, 0.5, 0, sureHits, 58],
  ] as const)('rounds exact decimal half damage upward for base %s', (baseDamage, efficiency, armor, rules, damage) => {
    const event = attacks(battle(participant('a', { baseDamage, efficiency, stance: 'offensive' }),
      participant('b', { armor, maxHealth: 1000 }), rules))[0];
    expect(event.damage).toBe(damage);
  });
  it.each([
    ['balanced', 'balanced', 1, 0, sureHits, 10],
    ['offensive', 'offensive', 1, 0, sureHits, 13],
    ['defensive', 'defensive', 1, 0, sureHits, 8],
    ['offensive', 'defensive', 0.5, 10, sureCrits, 6],
    ['balanced', 'balanced', 1, 1000, sureHits, 3],
    ['balanced', 'balanced', 0.5, 1000, sureHits, 2],
  ] as const)('rounds %s against %s once after efficiency/crit/stance/armor', (outgoing, incoming, efficiency, armor, rules, damage) => {
    const event = attacks(battle(participant('a', { stance: outgoing, efficiency }), participant('b', { stance: incoming, armor }), rules))[0];
    expect(event).toMatchObject({ hit: true, critical: rules === sureCrits, damage, defend: incoming === 'defensive', evade: false });
  });
  it('retains minimum one damage on a hit and zero damage/critical on a miss', () => {
    expect(attacks(battle(participant('a', { baseDamage: 0 }), participant('b')))[0].damage).toBe(1);
    const misses: Rules = { ...sureCrits, combat: { ...sureCrits.combat, minimumHit: 0, maximumHit: 0 } };
    expect(attacks(battle(participant('a'), participant('b'), misses))[0]).toMatchObject({ hit: false, critical: false,
      damage: 0, evade: true, defend: false, healthBefore: 100, healthAfter: 100 });
  });
  it('saturates hit and critical upper clamps rather than guaranteeing success', () => {
    const input = (precision: number) => battle(participant('a', { maxHealth: 1_000_000,
      attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision } }), participant('b', { maxHealth: 1_000_000 }), RULES_V1);
    const rolls = (value: number) => attacks(input(value)).filter(e => e.attackerId === 'a').map(e => [e.hit, e.critical]);
    expect(rolls(1000)).toEqual(rolls(1_000_000_000));
    expect(rolls(1000)).toContainEqual([false, false]);
    expect(rolls(1000)).toContainEqual([true, false]);
    expect(rolls(1000)).toContainEqual([true, true]);
  });
  it('saturates the hit lower clamp rather than eliminating all hits', () => {
    const input = (agility: number) => battle(participant('a', { maxHealth: 1_000_000 }), participant('b', { maxHealth: 1_000_000,
      attributes: { strength: 0, agility, vitality: 0, endurance: 0, precision: 0 } }), RULES_V1);
    const rolls = (value: number) => attacks(input(value)).filter(e => e.attackerId === 'a').map(e => e.hit);
    expect(rolls(1000)).toEqual(rolls(1_000_000_000));
    expect(rolls(1000)).toContain(true);
    expect(rolls(1000)).toContain(false);
  });
  it('uses exact non-clamped hit Precision and defender Agility coefficients', () => {
    const input = (agility: number) => battle(participant('a', {
      attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 10 } }), participant('b', {
      attributes: { strength: 0, agility, vitality: 0, endurance: 0, precision: 0 } }), RULES_V1);
    // First v1 roll is 0.385564...; probabilities are .387 and .384.
    expect(attacks(input(121))[0].hit).toBe(true);
    expect(attacks(input(122))[0].hit).toBe(false);
  });
  it('uses exact non-clamped critical Precision probability', () => {
    const input = (precision: number) => battle(participant('a', { maxHealth: 1000,
      attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision } }), participant('b', { maxHealth: 1000 }), RULES_V1);
    // Third scheduled attack's critical roll is .252765...; probabilities .251/.254.
    expect(attacks(input(67))[2].critical).toBe(false);
    expect(attacks(input(68))[2].critical).toBe(true);
  });
  it('uses retained supplied rules instead of a runtime current-rules singleton', () => {
    const retained: Rules = { ...sureHits, version: 'retained', stances: { ...sureHits.stances,
      offensive: { outgoing: 2, incoming: 1.1 } } };
    const a = participant('a', { rulesVersion: 'retained', stance: 'offensive' });
    const b = participant('b', { rulesVersion: 'retained' });
    expect(attacks(battle(a, b, retained))[0].damage).toBe(20);
  });
});

describe('timeouts and public output isolation', () => {
  it('resolves at 120 seconds by health fraction, rather than absolute health', () => {
    const log = simulateBattle(battle(participant('a', { maxHealth: 1000, baseDamage: 1 }),
      participant('b', { maxHealth: 2000, baseDamage: 1 })), 'seed-a');
    expect(log.durationMs).toBe(120_000);
    expect(log.finalHp).toEqual([880, 1880]);
    expect(log.winnerId).toBe('b');
    expect(log.victoryReason).toBe('health-fraction');
    expect(log.events.at(-1)).toMatchObject({ elapsedMs: 120_000, winnerId: 'b' });
    expect(log.tieBreakReason).toBeNull();
  });
  it('uses a seeded tie at equal remaining fractions with no attacks beyond the limit', () => {
    const log = simulateBattle(battle(participant('a', { attackIntervalMs: 120001 }),
      participant('b', { attackIntervalMs: 120001 })), 'seed-a');
    expect(log.finalHp).toEqual([100, 100]);
    expect(log.events).toHaveLength(1);
    expect(log.durationMs).toBe(120_000);
    expect(log.tieBreakReason).toBe('equal-health-fraction');
    expect(log.victoryReason).toBe('tie-break');
  });
  it('copies only safe fields into deeply immutable plain JSON logs without freezing callers', () => {
    const attributes = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0, providerIdentity: 'attribute-secret' };
    const a = { ...participant('a', { attributes }), ownerId: 'provider-secret', wallet: 999, pendingBuild: { seed: 'hidden' } };
    const input = battle(a, participant('b'));
    const log = simulateBattle(input, 'private-seed');
    expect(Object.keys(log.participants[0]).sort()).toEqual(['armor', 'attackIntervalMs', 'attributes', 'classId',
      'efficiencyBasisPoints', 'equipmentSilhouettes', 'gladiatorId', 'id', 'initialHealth', 'maxHealth', 'name', 'stance', 'weaponDamage'].sort());
    expect(JSON.stringify(log)).not.toMatch(/private-seed|provider-secret|attribute-secret|wallet|pendingBuild|"seed"|baseDamage/);
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log.events[0])).toBe(true);
    expect(Object.isFrozen(log.participants[0].attributes)).toBe(true);
    expect(Object.isFrozen(input.fighters[0].snapshot.attributes)).toBe(false);
    attributes.strength = 999;
    expect(log.participants[0].attributes.strength).toBe(0);
    // @ts-expect-error Public replay health/attribute snapshots are immutable.
    expect(() => { log.participants[0].attributes.strength = 999; }).toThrow(TypeError);
  });
  it('starts at carried expedition health and records it for replay reduction', () => {
    const a = { ...participant('a'), startingHealth: 35 };
    const log = simulateBattle(battle(a, participant('b', { maxHealth: 5 })), 'seed-a');
    expect(log.participants.map(p => p.initialHealth)).toEqual([35, 5]);
    expect(log.events[1]).toMatchObject({ healthBefore: 35, healthAfter: 25 });
    expect(log.finalHp).toEqual([25, 0]);
  });
  it.each([0, -1, 101, 0.5, NaN, Infinity])('rejects invalid carried health %s', startingHealth => {
    expect(() => simulateBattle(battle({ ...participant('a'), startingHealth }), 'seed-a')).toThrow(RangeError);
  });
  it.each([
    (input: BattleInput) => ({ ...input, rulesVersion: 'wrong' }),
    (input: BattleInput) => ({ ...input, fighters: [input.fighters[0], input.fighters[0]] }),
    (input: BattleInput) => battle(participant('a', { attackIntervalMs: 0 })),
    (input: BattleInput) => battle(participant('a', { maxHealth: NaN })),
    (input: BattleInput) => battle(participant('a', { baseDamage: Infinity })),
    (input: BattleInput) => battle(participant('a', { efficiency: 0 })),
  ])('rejects corrupt private snapshots without returning a misleading outcome', change => {
    expect(() => simulateBattle(change(battle()) as BattleInput, 'seed-a')).toThrow(RangeError);
  });
});
