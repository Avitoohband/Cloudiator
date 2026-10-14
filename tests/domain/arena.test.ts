import { describe, expect, it } from 'vitest';
import { applyRatingDelta, arenaOutcomes, estimateArenaStrength, leagueFor, makeFallback, matchArena, ratingDelta,
  type ArenaAssignment, type ArenaEntrant, type PairingHistory } from '@domain/arena.ts';
import { buildChangeFee, validateBuild } from '@domain/build.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { criticalProbability, hitProbability, makeFighter, simulateBattle } from '@domain/combat.ts';
import { historicalGearScore } from '@domain/inventory.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import type { LeagueId } from '@contracts/commands.ts';
import type { BattleLog } from '@contracts/events.ts';
import type { Attributes, BattleParticipant, BuildSnapshot, EquipmentSlot, FighterSnapshot, ItemInstance, Rules } from '@domain/types.ts';
import { baseFiveBuild, buildInputFixture, itemFixture } from '../fixtures/domain.ts';

const item = (id: string): ItemInstance => itemFixture(CATALOG_V1.items[id]);
const LEAGUES: LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];
const rank = (league: LeagueId) => LEAGUES.indexOf(league);
function build(classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: Attributes,
  equipment: Partial<Record<EquipmentSlot, ItemInstance>> = {}): BuildSnapshot {
  return { rulesVersion: 'v1', classId, stance, allocations, equipment: { ...baseFiveBuild.equipment, ...equipment } };
}
const arena = (snapshot: BuildSnapshot) => makeFighter(snapshot, 'arena', RULES_V1);
/** Berserker {4, 2, 2, 1, 1} with the starter sword and light armor: a typical new real build. */
const starter = build('berserker', 'balanced', { strength: 4, agility: 2, vitality: 2, endurance: 1, precision: 1 },
  { weapon: item('sword:1:common'), body: item('light-armor:1:common') });
/** A real unarmed v1 fighter (Precision 5: engine hit .71 against Agility 5, critical .065, expected ×1.0325). */
const reference = arena(baseFiveBuild);
/** NPC-style private overrides of the real fighter at a 1 s interval: strength = maxHealth × baseDamage × .733075. */
const tuned = (maxHealth: number, baseDamage: number): FighterSnapshot => ({ ...reference, maxHealth, baseDamage, attackIntervalMs: 1000 });
const sureHits: Rules = { ...RULES_V1, combat: { ...RULES_V1.combat, minimumHit: 1, maximumHit: 1, minimumCritical: 0, maximumCritical: 0 } };
const side = (id: string, snapshot: FighterSnapshot): BattleParticipant => ({ id, gladiatorId: null, name: id, snapshot });
const SLOT = 373_248;
const entrant = (gladiatorId: string, fighter: FighterSnapshot, patch: Partial<ArenaEntrant> = {}): ArenaEntrant => ({
  gladiatorId, activityId: `activity-${gladiatorId}`, seasonId: 'season-1', league: 'bronze', slotIndex: SLOT, rating: 1000, fighter, ...patch });
/** First attack of `attacker` against `defender` under guaranteed, non-critical hits. */
const firstHit = (attacker: BattleParticipant, defender: BattleParticipant) => simulateBattle(
  { battleId: 'probe', rulesVersion: 'v1', rules: sureHits, fighters: [attacker, defender] }, 'probe-seed').events[0];

describe('league placement', () => {
  it('places characters by 2 × level + floor(earned / 5) + floor(historical gear / 10)', () => {
    expect(leagueFor(1, 10, 0)).toBe('bronze');
    expect(leagueFor(5, 25, 100)).toBe('silver');
    // The starter sword and light armor establish history 28: 2 + 2 + 2 = 6.
    expect(leagueFor(1, 10, historicalGearScore([item('sword:1:common'), item('light-armor:1:common')], 0))).toBe('bronze');
  });
  it.each([
    // Each progression input crosses each threshold: index 24/25, 59/60 and 119/120.
    [1, 10, 209.99, 'bronze'], [1, 10, 210, 'silver'], [1, 14, 200, 'bronze'], [1, 15, 200, 'silver'],
    [6, 15, 90, 'bronze'], [7, 15, 70, 'bronze'], [7, 15, 90, 'silver'],
    [20, 10, 179.99, 'silver'], [20, 10, 180, 'gold'], [20, 14, 170, 'silver'], [20, 15, 170, 'gold'],
    [50, 10, 179.99, 'gold'], [50, 10, 180, 'champion'], [50, 14, 170, 'gold'], [50, 15, 170, 'champion'],
    [48, 15, 190, 'gold'], [49, 15, 190, 'champion'], [1_000, 1_000, 10_000, 'champion'],
  ] as const)('places level %s, earned %s, gear history %s in %s', (level, earned, gear, league) => {
    expect(leagueFor(level, earned, gear)).toBe(league);
  });
  it('counts banked earned points exactly like allocated ones, and respecs never lower placement', () => {
    const owned = [item('sword:1:common')];
    const history = historicalGearScore(owned, 0);
    const equipment = { ...buildInputFixture.equipment, weapon: owned[0].id };
    const EARNED = 125;
    const legal = (allocation: Attributes) => {
      const result = validateBuild({ ...buildInputFixture, equipment, allocation }, owned, EARNED, 1);
      if (!result.ok) throw new Error(`illegal fixture allocation: ${result.reason}`);
      return result;
    };
    // Every point the character earned, allocated or banked, recovered from one legal build state.
    const earned = (state: ReturnType<typeof legal>) =>
      Object.values(state.snapshot.allocations).reduce((sum, points) => sum + points, 0) + state.unspentPoints;
    expect(legal(buildInputFixture.allocation)).toMatchObject({ unspentPoints: 115 });
    // 2 + floor(125 / 5) + floor(24 / 10) = 29; counting only the 10 allocated points would give bronze.
    expect(leagueFor(1, EARNED, history)).toBe('silver');
    expect(leagueFor(1, 10, history)).toBe('bronze');
    // Bank 115, spend all 125, respec Strength into Agility, then respec back down to 10 allocated and 115 banked.
    const states = [buildInputFixture.allocation, { strength: 100, agility: 5, vitality: 10, endurance: 2, precision: 8 },
      { strength: 5, agility: 100, vitality: 10, endurance: 2, precision: 8 }, buildInputFixture.allocation];
    const placement = rank(leagueFor(1, earned(legal(states[0])), history));
    expect(placement).toBe(rank('silver'));
    for (let i = 1; i < states.length; i += 1) {
      const fee = buildChangeFee({ ...buildInputFixture, allocation: states[i - 1] }, { ...buildInputFixture, allocation: states[i] });
      // The first step only allocates banked points (free); every later step lowers an attribute and is a paid respec.
      expect(fee).toBe(i === 1 ? 0 : RULES_V1.fees.respec);
      const after = legal(states[i]);
      expect(earned(after)).toBe(EARNED);
      expect(rank(leagueFor(1, earned(after), history))).toBeGreaterThanOrEqual(placement);
    }
  });
  it('keeps a weak current loadout in the league its historical gear earned', () => {
    const everOwned = [item('sword:10:rare'), item('round-shield:10:rare'), item('spear:10:rare'), item('iron-helmet:10:rare'),
      item('heavy-armor:10:rare'), item('heavy-boots:10:rare')];
    // Sword 4 × 15.6 + shield 2 × 7.8 beats the spear's 60.66; helmet 15.6, armor 31.2, boots 10.4: 135.2.
    const history = historicalGearScore(everOwned, 0);
    expect(history).toBe(135.2);
    // Everything sold, unequipped or discarded: the acquisition maximum never decreases.
    const afterSelling = historicalGearScore([], history);
    expect(afterSelling).toBe(history);
    // 40 + 12 + 13 = 65 (gold); using the current empty loadout (0) instead would give 52 (silver).
    expect(leagueFor(20, 60, afterSelling)).toBe('gold');
    expect(leagueFor(20, 60, 0)).toBe('silver');
  });
  it('never decreases as level, earned points or historical gear grow', () => {
    for (const level of [1, 2, 5, 12, 13, 29, 30, 59, 60, 200]) {
      for (const earned of [10, 14, 15, 60, 61, 300, 600]) {
        for (const gear of [0, 9.99, 10, 99.99, 100, 599.99, 600, 1_200]) {
          const here = rank(leagueFor(level, earned, gear));
          expect(rank(leagueFor(level + 1, earned, gear))).toBeGreaterThanOrEqual(here);
          expect(rank(leagueFor(level, earned + 1, gear))).toBeGreaterThanOrEqual(here);
          expect(rank(leagueFor(level, earned, gear + 0.01))).toBeGreaterThanOrEqual(here);
        }
      }
    }
  });
  it('reads thresholds, weights and input limits from the rules it is given, defaulting to v1', () => {
    // 2 × 1 + floor(10 / 5) + floor(0 / 10) = 4.
    const lowSilver: Rules = { ...RULES_V1, leagues: { ...RULES_V1.leagues, silver: 4 } };
    expect(leagueFor(1, 10, 0)).toBe('bronze');
    expect(leagueFor(1, 10, 0, RULES_V1)).toBe('bronze');
    expect(leagueFor(1, 10, 0, lowSilver)).toBe('silver');
    const heavyLevels: Rules = { ...RULES_V1, leagues: { ...RULES_V1.leagues, levelWeight: 12 } };
    expect(leagueFor(2, 10, 0, heavyLevels)).toBe('silver'); // 24 + 2 = 26
    const lowCap: Rules = { ...RULES_V1, attributes: { ...RULES_V1.attributes, maximumLevel: 10 } };
    expect(() => leagueFor(11, 10, 0, lowCap)).toThrow(RangeError);
  });
  it.each([
    [0, 10, 0], [1.5, 10, 0], [Number.NaN, 10, 0], [1_000_000_001, 10, 0],
    [1, 9, 0], [1, 10.5, 0], [1, -1, 0], [1, 1_000_000_001, 0],
    [1, 10, -0.01], [1, 10, Number.NaN], [1, 10, Number.POSITIVE_INFINITY],
  ])('rejects invalid progression input level %s, earned %s, gear %s', (level, earned, gear) => {
    expect(() => leagueFor(level, earned, gear)).toThrow(RangeError);
  });
});

describe('Elo ratings', () => {
  it('splits K = 24 evenly between equal ratings', () => {
    expect(ratingDelta(1000, 1000)).toEqual({ winner: 12, loser: -12 });
  });
  it.each([
    // expected = 1 / (1 + 10^((loser − winner) / 400)); winner gain = round(24 × (1 − expected)).
    [1200, 1000, 6], // expected .7597, 5.77
    [1000, 1200, 18], // expected .2403, 18.23
    [1400, 1000, 2], // expected 10 / 11, 2.18
    [1000, 1400, 22], // expected 1 / 11, 21.82
    [1016, 1000, 11], // expected .5230, 11.45
    [0, 3000, 24],
  ])('gives winner %s against loser %s a gain of %s and the loser its negative', (winner, loser, gain) => {
    expect(ratingDelta(winner, loser)).toEqual({ winner: gain, loser: -gain });
  });
  it('awards no change, as positive zero, when the favourite is overwhelmingly expected to win', () => {
    const delta = ratingDelta(3000, 0);
    expect(delta).toEqual({ winner: 0, loser: 0 });
    expect(Object.is(delta.loser, 0)).toBe(true);
  });
  it('applies the delta and clamps each rating at zero, reporting the change actually applied', () => {
    expect(applyRatingDelta(1000, 1000)).toEqual({ winner: 1012, loser: 988, applied: { winner: 12, loser: -12 } });
    // Winner 0 against loser 5: expected .4928, gain 12; the loser falls only to 0.
    expect(applyRatingDelta(0, 5)).toEqual({ winner: 12, loser: 0, applied: { winner: 12, loser: -5 } });
    const floor = applyRatingDelta(10, 0);
    expect(floor).toEqual({ winner: 22, loser: 0, applied: { winner: 12, loser: 0 } });
    expect(Object.is(floor.applied.loser, 0)).toBe(true);
  });
  it.each([[-1, 1000], [1000, -1], [999.5, 1000], [1000, Number.NaN], [Number.POSITIVE_INFINITY, 1000], [2 ** 53, 1000]])(
    'rejects invalid ratings %s and %s', (winner, loser) => {
      expect(() => ratingDelta(winner, loser)).toThrow(RangeError);
      expect(() => applyRatingDelta(winner, loser)).toThrow(RangeError);
    });
  it('reads K, the expectation scale and the floor from the rules it is given, defaulting to v1', () => {
    const custom: Rules = { ...RULES_V1, rating: { ...RULES_V1.rating, k: 32, minimum: 100 } };
    expect(ratingDelta(1000, 1000, RULES_V1)).toEqual({ winner: 12, loser: -12 });
    expect(ratingDelta(1000, 1000, custom)).toEqual({ winner: 16, loser: -16 });
    const wideScale: Rules = { ...RULES_V1, rating: { ...RULES_V1.rating, expectationScale: 800 } };
    expect(ratingDelta(1400, 1000, wideScale)).toEqual({ winner: 6, loser: -6 }); // expected .7597, 5.77
    // Winner 100 against loser 110: expected .4856, gain round(32 × .5144) = 16; the loser stops at the floor 100.
    expect(applyRatingDelta(100, 110, custom)).toEqual({ winner: 116, loser: 100, applied: { winner: 16, loser: -10 } });
    expect(() => ratingDelta(1000, 99, custom)).toThrow(RangeError);
    expect(() => applyRatingDelta(99, 1000, custom)).toThrow(RangeError);
  });
  it('rejects an applied rating beyond the safe integer range', () => {
    expect(() => applyRatingDelta(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});

describe('arena strength estimate', () => {
  it('multiplies maximum health by expected damage per second against the reference target', () => {
    // Strength 9.9, Agility 7, Vitality 7, Precision 6: HP 120, base damage 6 + 4.95, interval round(1000 / 1.07) = 935,
    // hit .7 + .03 − .015 = .715, critical .068 (×1.034): 120 × 10.95 × .715 × 1.034 / .935 = 1038.9875…
    expect(arena(starter)).toMatchObject({ maxHealth: 120, baseDamage: 10.95, attackIntervalMs: 935, efficiency: 1 });
    expect(estimateArenaStrength(arena(starter))).toBe(1038.99);
  });
  it('applies the outgoing stance multiplier once', () => {
    expect(estimateArenaStrength(arena({ ...starter, stance: 'offensive' }))).toBe(1194.84); // × 1.15 = 1194.8356…
    expect(estimateArenaStrength(arena({ ...starter, stance: 'defensive' }))).toBe(935.09); // × .9 = 935.0887…
  });
  it('applies overload efficiency to damage and, through the frozen interval, to attack rate', () => {
    const overloaded = arena({ ...baseFiveBuild, equipment: { weapon: item('axe:1:common'), offHand: item('round-shield:1:common'),
      head: item('iron-helmet:1:common'), body: item('heavy-armor:1:common'), feet: item('heavy-boots:1:common') } });
    expect(overloaded).toMatchObject({ efficiency: 0.775, baseDamage: 10.75, attackIntervalMs: 1720 });
    // 100 × 10.75 × .775 × .71 × 1.0325 / 1.72 = 355.0832…
    expect(estimateArenaStrength(overloaded)).toBe(355.08);
  });
  it('uses the engine hit and critical clamps', () => {
    const precise = arena(build('berserker', 'balanced', { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 995 }));
    // Precision 1000 saturates hit at .95 and critical at .4 (×1.2): 100 × 2.75 × .95 × 1.2 / .952 = 329.3067…
    expect(estimateArenaStrength(precise)).toBe(329.31);
  });
  it('includes the bound arena weapon modifier with precision preserved until the final rounding', () => {
    const weapon = item('sword:1:renown');
    weapon.stats.damage = 6.65;
    const bound = { ...baseFiveBuild, equipment: { ...baseFiveBuild.equipment, weapon } };
    expect(arena(bound)).toMatchObject({ weaponDamage: 7.315, baseDamage: 10.065 });
    // 100 × 10.065 × .71 × 1.0325 / .952 = 775.0420…; a weapon rounded early to 7.32 would give 775.43.
    expect(estimateArenaStrength(arena(bound))).toBe(775.04);
    // The expedition snapshot carries no arena modifier: 100 × 9.4 × .71 × 1.0325 / .952 = 723.8345…
    expect(estimateArenaStrength(makeFighter(bound, 'expedition', RULES_V1))).toBe(723.83);
  });
  it('normalises the engine hit and critical probabilities to exact decimals before the final rounding', () => {
    // The engine's own Precision 17 hit probability carries floating-point error; the engine itself keeps using it.
    expect(hitProbability(17, RULES_V1.leagues.referenceAgility, RULES_V1)).toBe(0.7699999999999999);
    expect(criticalProbability(17, RULES_V1)).toBe(0.101);
    // Berserker Precision 12 + 5 = 17, Agility 7 (round(1000 / 1.07) = 935), renown sword 6 × 1.1 = 6.6 + 2.75 = 9.35:
    // 100 × 9.35 × .77 × (1 + .5 × .101) / .935 = 808.885 exactly, so 808.89; the raw .7699999999999999 gives 808.88.
    const precise = arena(build('berserker', 'balanced', { strength: 0, agility: 2, vitality: 0, endurance: 0, precision: 12 },
      { weapon: item('sword:1:renown') }));
    expect(precise).toMatchObject({ attributes: { precision: 17 }, maxHealth: 100, baseDamage: 9.35, attackIntervalMs: 935, efficiency: 1 });
    expect(estimateArenaStrength(precise)).toBe(808.89);
    // The same exact half cent at a 1 s interval: 100 × 10 × .77 × 1.0505.
    expect(estimateArenaStrength({ ...tuned(100, 10), attributes: { ...reference.attributes, precision: 17 } })).toBe(808.89);
  });
  it("leaves the estimate unchanged by the fighter's own armor (the reference target's armor is 0)", () => {
    const body = item('heavy-armor:1:renown');
    body.stats.armor = 6.65;
    const allocation = { strength: 3, agility: 2, vitality: 2, endurance: 2, precision: 1 };
    const armored = arena(build('guardian', 'balanced', allocation, { weapon: item('spear:1:common'), body }));
    const unarmored = arena(build('guardian', 'balanced', allocation, { weapon: item('spear:1:common') }));
    expect(armored).toMatchObject({ armor: 7.315, maxHealth: 123, baseDamage: 11, attackIntervalMs: 1121, efficiency: 1 });
    expect(unarmored).toMatchObject({ armor: 0, maxHealth: 123, baseDamage: 11, attackIntervalMs: 1121, efficiency: 1 });
    // 123 × 11 × .715 × 1.034 / 1.121 = 892.3164…, with or without the bound arena armor.
    expect(estimateArenaStrength(armored)).toBe(892.32);
    expect(estimateArenaStrength(unarmored)).toBe(892.32);
    expect(estimateArenaStrength({ ...armored, armor: 60 })).toBe(892.32);
  });
  it.each([[100, 10, 733.08], [100, 18, 1319.54], [100, 22, 1612.77], [100, 20, 1466.15], [200, 20, 2932.3]])(
    'rounds HP %s × base damage %s once, half-up, from exact decimals to %s', (maxHealth, baseDamage, strength) => {
      expect(estimateArenaStrength(tuned(maxHealth, baseDamage))).toBe(strength);
    });
  it.each([
    { rulesVersion: 'v2' }, { maxHealth: Number.NaN }, { maxHealth: 0 }, { baseDamage: Number.POSITIVE_INFINITY },
    { efficiency: 0 }, { attackIntervalMs: 100 }, { stance: 'reckless' }, { attributes: undefined },
  ] as Partial<FighterSnapshot>[])('rejects an unknown-rules or corrupt fighter snapshot %o', patch => {
    expect(() => estimateArenaStrength({ ...reference, ...patch } as FighterSnapshot)).toThrow(RangeError);
  });
});

describe('NPC fallback template', () => {
  const body = item('heavy-armor:1:renown');
  body.stats.armor = 6.65;
  // Guardian Vitality 7.35 (HP 123), Strength 8 (spear 7 + 4 = 11), Agility 7 (round(1200 / 1.07) = 1121), arena armor 7.315.
  const player = arena(build('guardian', 'offensive', { strength: 3, agility: 2, vitality: 2, endurance: 2, precision: 1 },
    { weapon: item('spear:1:common'), body }));
  it('mirrors effective attributes, armor and interval, in Balanced stance at 85% health and base damage', () => {
    expect(player).toMatchObject({ maxHealth: 123, baseDamage: 11, attackIntervalMs: 1121, armor: 7.315, efficiency: 1, stance: 'offensive' });
    expect(makeFallback(player)).toEqual({ rulesVersion: 'v1', classId: null, stance: 'balanced', attributes: player.attributes,
      maxHealth: 104, armor: 7.315, weaponDamage: 7, baseDamage: 9.35, attackIntervalMs: 1121, efficiency: 1,
      equipmentSilhouettes: ['spear:1:common', 'heavy-armor:1:renown'] });
  });
  it('retains overload efficiency once: interval mirrored, base damage still before efficiency', () => {
    const overloaded = arena({ ...baseFiveBuild, equipment: { weapon: item('axe:1:common'), offHand: item('round-shield:1:common'),
      head: item('iron-helmet:1:common'), body: item('heavy-armor:1:common'), feet: item('heavy-boots:1:common') } });
    const npc = makeFallback(overloaded);
    expect(npc).toMatchObject({ efficiency: 0.775, attackIntervalMs: 1720, baseDamage: 9.1375 });
    // 10.75 × .85 × .775 = 7.08 → 7; a second efficiency application would give 5.49 → 5.
    expect(firstHit(side('npc', npc), side('target', { ...reference, attackIntervalMs: 5000 }))).toMatchObject({ attackerId: 'npc', damage: 7 });
  });
  it('keeps fractional bound arena armor exact through final damage rounding', () => {
    // 20.5 × (1 − .02 × 7.315) = 17.50085 → 18; armor rounded to 7.32 would give 17.
    expect(firstHit(side('attacker', tuned(1000, 20.5)), side('npc', makeFallback(player))))
      .toMatchObject({ damage: 18, healthBefore: 104, healthAfter: 86 });
  });
  it('is a valid engine fighter about 0.85² as strong as the player it mirrors', () => {
    const npc = makeFallback(arena(starter));
    expect(npc).toMatchObject({ maxHealth: 102, baseDamage: 9.3075 });
    // 102 × 9.3075 × .715 × 1.034 / .935 = 750.6685…
    expect(estimateArenaStrength(npc)).toBe(750.67);
    const log = simulateBattle({ battleId: 'fallback', rulesVersion: 'v1', rules: RULES_V1,
      fighters: [{ id: 'player', gladiatorId: 'player', name: 'Player', snapshot: arena(starter) }, side('npc:player', npc)] }, 'seed-a');
    expect(log.participants[1]).toMatchObject({ gladiatorId: null, classId: null, maxHealth: 102, stance: 'balanced' });
  });
  it('never produces a template below one health', () => {
    expect(makeFallback(tuned(1, 10)).maxHealth).toBe(1);
  });
  it('returns a frozen copy without freezing or changing the caller snapshot', () => {
    const caller = structuredClone(player) as FighterSnapshot;
    const npc = makeFallback(caller);
    expect(Object.isFrozen(npc) && Object.isFrozen(npc.attributes) && Object.isFrozen(npc.equipmentSilhouettes)).toBe(true);
    expect(Object.isFrozen(caller) || Object.isFrozen(caller.attributes)).toBe(false);
    expect(caller).toEqual(player);
  });
  it.each([{ rulesVersion: 'v2' }, { maxHealth: Number.NaN }, { baseDamage: -1 }, { efficiency: 1.5 }, { attributes: undefined }] as Partial<FighterSnapshot>[])(
    'rejects an unknown-rules or corrupt fighter snapshot %o', patch => {
      expect(() => makeFallback({ ...player, ...patch } as FighterSnapshot)).toThrow(RangeError);
    });
});

describe('regular Arena pairing', () => {
  /** Strengths 1466.15 and round(100 × ratio) × 20 × .733075 (see the tuned estimates above). */
  const twoEntrantsWithStrengthRatio = (ratio: number) => [entrant('weak', tuned(100, 20)), entrant('strong', tuned(Math.round(100 * ratio), 20))];
  const pairs = (assignments: readonly ArenaAssignment[]) => assignments.map(a => a.sides.map(s => s.gladiatorId).join('+'));
  const npcs = (assignments: readonly ArenaAssignment[]) => assignments.filter(a => a.kind === 'npc').map(a => a.sides[0].gladiatorId);
  const seeds = Array.from({ length: 24 }, (_, i) => `seed-${i}`);
  const CLASSES = ['berserker', 'guardian', 'duelist'] as const;
  const WEAPONS = ['sword:1:common', 'axe:1:common', 'spear:1:common', 'bow:1:common'];
  /** Real catalog builds with varied classes, allocations, weapons, armor and ratings. */
  const roster = (count: number) => Array.from({ length: count }, (_, i) => entrant(`g${String(i).padStart(2, '0')}`, arena(build(CLASSES[i % 3], 'balanced',
    { strength: i % 7, agility: (i * 3) % 5, vitality: (i * 2) % 4, endurance: i % 3, precision: (i * 5) % 4 },
    { weapon: item(WEAPONS[i % 4]), body: item(i % 2 ? 'light-armor:1:common' : 'heavy-armor:1:common') })), { rating: 950 + (i * 37) % 120 }));

  it('gives both entrants NPC fallbacks when the stronger estimate exceeds twice the weaker', () => {
    expect(matchArena(twoEntrantsWithStrengthRatio(2.01), [], 's').every(a => a.kind === 'npc')).toBe(true);
  });
  it('allows a pair at exactly twice the weaker estimate and rejects one hundredth above it', () => {
    const exact = [entrant('weak', tuned(100, 20)), entrant('strong', tuned(200, 20))];
    expect(exact.map(e => estimateArenaStrength(e.fighter))).toEqual([1466.15, 2932.3]);
    expect(matchArena(exact, [], 's')).toMatchObject([{ kind: 'human' }]);
    const above = [entrant('weak', tuned(100, 20)), entrant('strong', tuned(200, 20.0001))];
    expect(above.map(e => estimateArenaStrength(e.fighter))).toEqual([1466.15, 2932.31]);
    expect(matchArena(above, [], 's').map(a => a.kind)).toEqual(['npc', 'npc']);
  });
  it('returns no assignments for no entrants', () => {
    expect(matchArena([], [], 's')).toEqual([]);
  });
  it('gives a lone entrant a frozen NPC fallback bout in its season, league and slot', () => {
    const solo = entrant('solo', arena(starter), { league: 'silver', rating: 1040 });
    expect(matchArena([solo], [], 's')).toEqual([{ kind: 'npc', battleId: `arena:${SLOT}:solo:npc`, seasonId: 'season-1', league: 'silver',
      slotIndex: SLOT, sides: [{ gladiatorId: 'solo', activityId: 'activity-solo', rating: 1040, strength: 1038.99, fighter: solo.fighter }],
      opponent: { id: 'npc:solo', snapshot: makeFallback(solo.fighter) } }]);
  });
  it('pairs two entrants into one human bout sharing a battle id, the first processed entrant first', () => {
    const [a, b] = roster(2);
    const [bout] = matchArena([b, a], [], 's');
    const first = estimateArenaStrength(a.fighter) >= estimateArenaStrength(b.fighter) ? a : b;
    const second = first === a ? b : a;
    expect(bout).toEqual({ kind: 'human', battleId: `arena:${SLOT}:${first.gladiatorId}:${second.gladiatorId}`, seasonId: 'season-1',
      league: 'bronze', slotIndex: SLOT, sides: [first, second].map(e => ({ gladiatorId: e.gladiatorId, activityId: e.activityId,
        rating: e.rating, strength: estimateArenaStrength(e.fighter), fighter: e.fighter })) });
  });
  it('processes the strongest unpaired entrant first and gives it the nearest-strength opponent', () => {
    const a = entrant('a', arena(build('berserker', 'balanced', { strength: 10, agility: 0, vitality: 4, endurance: 0, precision: 0 }, { weapon: item('sword:1:common') })));
    const b = entrant('b', arena(build('berserker', 'balanced', { strength: 6, agility: 0, vitality: 2, endurance: 0, precision: 0 }, { weapon: item('sword:1:common') })));
    const c = entrant('c', arena(build('berserker', 'balanced', { strength: 3, agility: 0, vitality: 0, endurance: 0, precision: 0 }, { weapon: item('sword:1:common') })));
    const [sa, sb, sc] = [a, b, c].map(e => estimateArenaStrength(e.fighter));
    expect(sa > sb && sb > sc && sa <= 2 * sc).toBe(true);
    // Weakest-first processing would pair c with b and leave a alone.
    for (const seed of seeds) expect(pairs(matchArena([c, a, b], [], seed))).toEqual(['a+b', 'c']);
  });
  it('orders equal strengths by higher rating before the seeded tie-break', () => {
    const fighter = arena(starter);
    const field = [entrant('x', fighter, { rating: 1200 }), entrant('y', fighter, { rating: 1000 }), entrant('z', fighter, { rating: 1100 })];
    // x is processed first and takes z (nearer rating); y, processed last, gets the fallback for every seed.
    for (const seed of seeds) expect(pairs(matchArena(field, [], seed))).toEqual(['x+z', 'y']);
  });
  it('breaks equal strength gaps by fewest recent pairings, then nearest rating', () => {
    const lead = entrant('a', arena({ ...starter, stance: 'offensive' }));
    const b = entrant('b', arena(starter), { rating: 1100 });
    const c = entrant('c', arena(starter), { rating: 950 });
    const at = (back: number, other: string): PairingHistory => ({ slotIndex: SLOT - back, gladiatorIds: ['a', other] });
    for (const seed of seeds) {
      expect(pairs(matchArena([lead, b, c], [], seed))).toEqual(['a+c', 'b']); // no history: rating gap 50 beats 100
      expect(pairs(matchArena([lead, b, c], [at(18, 'c')], seed))).toEqual(['a+b', 'c']); // slot S − 18 still counts
      expect(pairs(matchArena([lead, b, c], [at(1, 'b'), at(9, 'b'), at(2, 'c')], seed))).toEqual(['a+c', 'b']); // 2 against 1
      expect(pairs(matchArena([lead, b, c], [at(1, 'c'), at(9, 'c'), at(2, 'b')], seed))).toEqual(['a+b', 'c']);
    }
  });
  it('drops pairings older than the preceding 18 slots', () => {
    const lead = entrant('a', arena({ ...starter, stance: 'offensive' }));
    const near = entrant('near', arena(starter), { rating: 1010 });
    const far = entrant('far', arena(starter), { rating: 1300 });
    // Slot S − 19 no longer counts, so `far` has no recent pairing while `near` has one; counting S − 19 would tie
    // them and the nearer rating would choose `near`.
    const history: PairingHistory[] = [{ slotIndex: SLOT - 19, gladiatorIds: ['far', 'a'] }, { slotIndex: SLOT - 1, gladiatorIds: ['near', 'a'] }];
    for (const seed of seeds) expect(pairs(matchArena([lead, near, far], history, seed))).toEqual(['a+far', 'near']);
  });
  it('breaks complete ties with the seed, stably across calls and input orders', () => {
    const fighter = arena(starter);
    const field = ['p', 'q', 'r', 's', 't'].map(id => entrant(id, fighter));
    const outcomes = new Set<string>();
    for (const seed of seeds) {
      const result = matchArena(field, [], seed);
      expect(matchArena(field, [], seed)).toEqual(result);
      expect(matchArena([...field].reverse(), [], seed)).toEqual(result);
      expect(matchArena(structuredClone(field), [], seed)).toEqual(result);
      outcomes.add(pairs(result).join(' '));
    }
    expect(outcomes.size).toBeGreaterThan(1);
    expect(new Set(seeds.map(seed => npcs(matchArena(field, [], seed))[0])).size).toBeGreaterThan(1);
  });
  it.each([3, 5, 7])('assigns every entrant exactly once for %s similar entrants, one by NPC fallback', count => {
    const field = roster(count);
    const result = matchArena(field, [], 'odd');
    expect(result.flatMap(a => a.sides.map(s => s.gladiatorId)).sort()).toEqual(field.map(e => e.gladiatorId).sort());
    expect(result.filter(a => a.kind === 'npc')).toHaveLength(1);
  });
  it('pairs 50 real entrants deterministically within the strength cap', () => {
    const field = roster(50);
    const strengths = field.map(e => estimateArenaStrength(e.fighter));
    expect(Math.max(...strengths) <= 2 * Math.min(...strengths)).toBe(true);
    const result = matchArena(field, [], 'fifty');
    expect(result.filter(a => a.kind === 'human')).toHaveLength(25);
    expect(result.flatMap(a => a.sides.map(s => s.gladiatorId)).sort()).toEqual(field.map(e => e.gladiatorId).sort());
    for (const bout of result) {
      const [x, y] = bout.sides.map(s => s.strength);
      expect(Math.max(x, y) <= 2 * Math.min(x, y)).toBe(true);
      expect(bout).toMatchObject({ seasonId: 'season-1', league: 'bronze', slotIndex: SLOT });
      expect(new Set(bout.sides.map(s => s.gladiatorId)).size).toBe(2);
    }
    expect(matchArena([...field].reverse(), [], 'fifty')).toEqual(result);
  });
  it('never pairs entrants across leagues', () => {
    const fighter = arena(starter);
    expect(matchArena([entrant('b1', fighter), entrant('s1', fighter, { league: 'silver' })], [], 's')).toMatchObject([
      { kind: 'npc', league: 'bronze', sides: [{ gladiatorId: 'b1' }] }, { kind: 'npc', league: 'silver', sides: [{ gladiatorId: 's1' }] }]);
    const mixed = [entrant('g1', fighter, { league: 'gold' }), entrant('b1', fighter), entrant('g2', fighter, { league: 'gold' }), entrant('b2', fighter)];
    for (const seed of seeds) {
      const result = matchArena(mixed, [], seed);
      expect(result.map(a => [a.kind, a.league, a.sides.map(s => s.gladiatorId).sort().join('+')]))
        .toEqual([['human', 'bronze', 'b1+b2'], ['human', 'gold', 'g1+g2']]);
    }
  });
  it('returns frozen assignments without freezing or changing the caller entrants', () => {
    const field = roster(3).map(e => structuredClone(e) as ArenaEntrant);
    const copy = structuredClone(field);
    const result = matchArena(field, [], 's');
    expect(result.every(a => Object.isFrozen(a)) && Object.isFrozen(result[0].sides[0].fighter.attributes)).toBe(true);
    expect(Object.isFrozen(field[0]) || Object.isFrozen(field[0].fighter)).toBe(false);
    expect(field).toEqual(copy);
  });
  it.each([
    ['a duplicate gladiator', (f: ArenaEntrant[]) => [f[0], { ...f[1], gladiatorId: f[0].gladiatorId }]],
    ['a duplicate activity', (f: ArenaEntrant[]) => [f[0], { ...f[1], activityId: f[0].activityId }]],
    ['two slots', (f: ArenaEntrant[]) => [f[0], { ...f[1], slotIndex: SLOT + 1 }]],
    ['two seasons', (f: ArenaEntrant[]) => [f[0], { ...f[1], seasonId: 'season-2' }]],
    ['an unknown league', (f: ArenaEntrant[]) => [{ ...f[0], league: 'diamond' }]],
    ['a fractional rating', (f: ArenaEntrant[]) => [{ ...f[0], rating: 1000.5 }]],
    ['a negative rating', (f: ArenaEntrant[]) => [{ ...f[0], rating: -1 }]],
    ['an empty identity', (f: ArenaEntrant[]) => [{ ...f[0], gladiatorId: '' }]],
    ['a corrupt fighter', (f: ArenaEntrant[]) => [{ ...f[0], fighter: { ...f[0].fighter, maxHealth: 0 } }]],
  ])('rejects %s', (_name, change) => {
    expect(() => matchArena(change(roster(2)) as ArenaEntrant[], [], 's')).toThrow(RangeError);
  });
  it.each([
    ['a self pairing', [{ slotIndex: SLOT - 1, gladiatorIds: ['g00', 'g00'] }]],
    ['a current-slot pairing', [{ slotIndex: SLOT, gladiatorIds: ['g00', 'g01'] }]],
    ['a fractional slot', [{ slotIndex: SLOT - 1.5, gladiatorIds: ['g00', 'g01'] }]],
    ['a missing identity', [{ slotIndex: SLOT - 1, gladiatorIds: ['g00'] }]],
  ])('rejects recent history with %s', (_name, recent) => {
    expect(() => matchArena(roster(2), recent as unknown as PairingHistory[], 's')).toThrow(RangeError);
  });
  it('requires a private seed', () => {
    expect(() => matchArena(roster(2), [], '')).toThrow(RangeError);
  });
  it('derives its rules once from the entrants and rejects mixed rules versions', () => {
    const [a, b, c] = roster(3);
    const other = { ...b, fighter: { ...b.fighter, rulesVersion: 'v2' } };
    expect(() => matchArena([a, other, c], [], 's')).toThrow(/share one rules version/);
    expect(() => matchArena([other, a, c], [], 's')).toThrow(/share one rules version/);
    // A single unknown version still fails closed as an invalid snapshot.
    expect(() => matchArena([other], [], 's')).toThrow(/Invalid arena fighter snapshot/);
  });
});

describe('regular Arena outcomes', () => {
  const noRewards = { money: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 };
  /** The real engine bout for an assignment: human participant ids are gladiator ids; the NPC uses `opponent.id`. */
  const bout = (assignment: ArenaAssignment, seed: string): BattleLog => simulateBattle({ battleId: assignment.battleId, rulesVersion: 'v1',
    rules: RULES_V1, fighters: [
      ...assignment.sides.map(s => ({ id: s.gladiatorId, gladiatorId: s.gladiatorId, name: s.gladiatorId, snapshot: s.fighter })),
      ...(assignment.kind === 'npc' ? [{ id: assignment.opponent.id, gladiatorId: null, name: 'Arena warden', snapshot: assignment.opponent.snapshot }] : []),
    ] as [BattleParticipant, BattleParticipant] }, seed);
  /** First fixed seed `${prefix}-n` whose real bout has the wanted shape. */
  const firstLog = (assignment: ArenaAssignment, prefix: string, wanted: (log: BattleLog) => boolean) => {
    for (let n = 0; n < 2000; n += 1) { const log = bout(assignment, `${prefix}-${n}`); if (wanted(log)) return log; }
    throw new Error(`no ${prefix} seed`);
  };
  // Duelist {2, 2, 0, 3, 3} with a sword: equal intervals make simultaneous lethal attacks possible.
  const mirror = arena(build('duelist', 'balanced', { strength: 2, agility: 2, vitality: 0, endurance: 3, precision: 3 }, { weapon: item('sword:1:common') }));
  const [pair] = matchArena([entrant('a', mirror), entrant('b', mirror)], [], 'pair');
  const [solo] = matchArena([entrant('solo', arena(starter), { rating: 1040 })], [], 'solo');

  it('credits a human win 10 renown and a loss 2, with Elo and no XP or money', () => {
    const log = bout(pair, 'bout-0');
    const winner = log.winnerId, loser = winner === 'a' ? 'b' : 'a';
    const outcomes = arenaOutcomes(pair, log);
    expect(outcomes.map(o => o.gladiatorId)).toEqual(pair.sides.map(s => s.gladiatorId));
    expect(outcomes.find(o => o.gladiatorId === winner)).toEqual({ gladiatorId: winner, activityId: `activity-${winner}`, result: 'victory',
      success: true, rewards: { ...noRewards, renown: 10 }, ratingBefore: 1000, ratingAfter: 1012, ratingDelta: 12 });
    expect(outcomes.find(o => o.gladiatorId === loser)).toEqual({ gladiatorId: loser, activityId: `activity-${loser}`, result: 'defeat',
      success: false, rewards: { ...noRewards, renown: 2 }, ratingBefore: 1000, ratingAfter: 988, ratingDelta: -12 });
  });
  it('credits an NPC win 3 renown and a loss none, never changing rating', () => {
    const won = firstLog(solo, 'npc-win', log => log.winnerId === 'solo');
    const lost = firstLog(solo, 'npc-loss', log => log.winnerId === 'npc:solo');
    const expected = { gladiatorId: 'solo', activityId: 'activity-solo', ratingBefore: 1040, ratingAfter: 1040, ratingDelta: 0 };
    expect(arenaOutcomes(solo, won)).toEqual([{ ...expected, result: 'victory', success: true, rewards: { ...noRewards, renown: 3 } }]);
    expect(arenaOutcomes(solo, lost)).toEqual([{ ...expected, result: 'defeat', success: false, rewards: { ...noRewards, renown: 0 } }]);
    expect(Object.is(arenaOutcomes(solo, won)[0].ratingDelta, 0)).toBe(true);
  });
  it('follows the logged winnerId when both fighters end at zero health', () => {
    const log = firstLog(pair, 'tie', l => l.tieBreakReason === 'simultaneous-defeat');
    expect(log.finalHp).toEqual([0, 0]);
    const winner = arenaOutcomes(pair, log).find(o => o.gladiatorId === log.winnerId);
    expect(winner).toMatchObject({ result: 'victory', success: true, rewards: { renown: 10 }, ratingDelta: 12 });
    const npcTie = firstLog(solo, 'npc-tie', l => l.tieBreakReason === 'simultaneous-defeat' && l.winnerId === 'solo');
    expect(npcTie.finalHp).toEqual([0, 0]);
    expect(arenaOutcomes(solo, npcTie)).toMatchObject([{ result: 'victory', rewards: { renown: 3 }, ratingDelta: 0 }]);
  });
  it('applies Elo from the frozen ratings and clamps the loser at zero', () => {
    const [low] = matchArena([entrant('a', mirror, { rating: 0 }), entrant('b', mirror, { rating: 5 })], [], 'low');
    const log = firstLog(low, 'low', l => l.winnerId === 'a');
    // Winner 0 against loser 5: gain 12; the loser falls only from 5 to 0.
    expect(arenaOutcomes(low, log).map(o => [o.gladiatorId, o.ratingBefore, o.ratingAfter, o.ratingDelta]))
      .toEqual(expect.arrayContaining([['a', 0, 12, 12], ['b', 5, 0, -5]]));
  });
  it('returns frozen outcomes', () => {
    const outcomes = arenaOutcomes(pair, bout(pair, 'bout-0'));
    expect(outcomes.every(o => Object.isFrozen(o) && Object.isFrozen(o.rewards))).toBe(true);
  });
  it('rejects a battle log that does not belong to the assignment', () => {
    const log = bout(pair, 'bout-0');
    expect(() => arenaOutcomes(pair, { ...log, battleId: 'other' })).toThrow(RangeError);
    expect(() => arenaOutcomes(solo, { ...log, battleId: solo.battleId })).toThrow(RangeError);
    expect(() => arenaOutcomes(pair, { ...log, winnerId: 'npc:a' })).toThrow(RangeError);
    expect(() => arenaOutcomes(pair, { ...log, rulesVersion: 'v2' })).toThrow(RangeError);
  });
  it('validates every fighter of the bout and requires one rules version', () => {
    if (pair.kind !== 'human') throw new Error('expected a human assignment');
    const log = bout(pair, 'bout-0');
    const [first, second] = pair.sides;
    const withSecond = (fighter: FighterSnapshot) => ({ ...pair, sides: [first, { ...second, fighter }] }) as ArenaAssignment;
    expect(() => arenaOutcomes(withSecond({ ...second.fighter, maxHealth: 0 }), log)).toThrow(RangeError);
    expect(() => arenaOutcomes(withSecond({ ...second.fighter, rulesVersion: 'v2' }), log)).toThrow(/share one rules version/);
    if (solo.kind !== 'npc') throw new Error('expected an NPC assignment');
    const npcLog = bout(solo, 'npc-0');
    const withOpponent = (snapshot: FighterSnapshot) => ({ ...solo, opponent: { ...solo.opponent, snapshot } }) as ArenaAssignment;
    expect(() => arenaOutcomes(withOpponent({ ...solo.opponent.snapshot, attackIntervalMs: 0 }), npcLog)).toThrow(RangeError);
    expect(() => arenaOutcomes(withOpponent({ ...solo.opponent.snapshot, rulesVersion: 'v2' }), npcLog)).toThrow(/share one rules version/);
    expect(arenaOutcomes(pair, log)).toHaveLength(2);
    expect(arenaOutcomes(solo, npcLog)).toHaveLength(1);
  });
  it('requires each human participant to carry its gladiator id and the NPC participant a null one', () => {
    const relabel = (log: BattleLog, index: 0 | 1, gladiatorId: string | null): BattleLog => {
      const [zero, one] = log.participants;
      return { ...log, participants: index === 0 ? [{ ...zero, gladiatorId }, one] : [zero, { ...one, gladiatorId }] };
    };
    const log = bout(pair, 'bout-0');
    expect(log.participants.map(p => [p.id, p.gladiatorId])).toEqual([['a', 'a'], ['b', 'b']]);
    expect(() => arenaOutcomes(pair, relabel(log, 0, null))).toThrow(RangeError);
    expect(() => arenaOutcomes(pair, relabel(log, 1, 'a'))).toThrow(RangeError);
    if (solo.kind !== 'npc') throw new Error('expected an NPC assignment');
    const npcLog = bout(solo, 'npc-0');
    expect(npcLog.participants.map(p => [p.id, p.gladiatorId])).toEqual([['solo', 'solo'], ['npc:solo', null]]);
    expect(() => arenaOutcomes(solo, relabel(npcLog, 1, 'solo'))).toThrow(RangeError);
    expect(() => arenaOutcomes(solo, relabel(npcLog, 0, null))).toThrow(RangeError);
  });
});
