import { describe, expect, it } from 'vitest';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { activityCost, deriveStats, preserveStamina } from '@domain/stats.ts';
import { buildChangeFee, validateBuild, validateCreationAllocation } from '@domain/build.ts';
import type { BuildInput } from '@domain/types.ts';
import { baseFiveBuild, buildInputFixture, itemFixture as itemFromCatalog } from '../fixtures/domain.ts';

const itemFixture = (id: string) => itemFromCatalog(CATALOG_V1.items[id]);

const rows = [
  ['sword', 'weapon', 1, 6, 0, 4, 1000, 40, 50],
  ['axe', 'weapon', 1, 8, 0, 6, 1400, 40, 50],
  ['spear', 'weapon', 2, 7, 0, 6, 1200, 40, 50],
  ['bow', 'weapon', 2, 6, 0, 3, 1100, 40, 50],
  ['round-shield', 'offHand', 0, 0, 3, 5, 0, 30, 40],
  ['leather-hood', 'head', 0, 0, 1, 1, 0, 20, 30],
  ['iron-helmet', 'head', 0, 0, 3, 4, 0, 40, 30],
  ['light-armor', 'body', 0, 0, 2, 3, 0, 40, 50],
  ['heavy-armor', 'body', 0, 0, 6, 10, 0, 80, 50],
  ['light-boots', 'feet', 0, 0, 1, 1, 0, 20, 30],
  ['heavy-boots', 'feet', 0, 0, 2, 4, 0, 40, 30],
] as const;

describe('catalog consumers', () => {
  it.each(rows)('derives and prices every %s row across tiers/rarities', (id, slot, hands, damage, armor, weight, interval, money, renown) => {
    for (const [tier, stat, price, renownPrice] of [[1, 1, 1, 1], [5, 1.5, 3, 2], [10, 2, 6, 3]] as const) {
      for (const [rarity, multiplier] of [['common', 1], ['uncommon', 1.15], ['rare', 1.3]] as const) {
        const entry = CATALOG_V1.items[`${id}:${tier}:${rarity}`];
        expect(entry).toMatchObject({ slot, hands, tier, rarity, moneyPrice: rarity === 'common' ? money * price : null,
          npcSellValue: Math.max(1, Math.floor(money * price * 0.25 * multiplier)),
          stats: { damage: Math.round(damage * stat * multiplier * 100) / 100,
            armor: Math.round(armor * stat * multiplier * 100) / 100, weight, intervalMs: interval } });
        const item = itemFixture(entry.id);
        const build = { ...baseFiveBuild, equipment: { ...baseFiveBuild.equipment, [slot]: item } };
        expect(deriveStats(build, RULES_V1)).toMatchObject({ load: weight, armor: entry.stats.armor, weaponDamage: entry.stats.damage });
      }
      const bound = CATALOG_V1.items[`${id}:${tier}:renown`];
      expect(bound).toMatchObject({ renownPrice: renown * renownPrice, moneyPrice: null, npcSellValue: null, binding: 'bound', rarity: 'common',
        stats: { damage: damage * stat, armor: armor * stat, weight, intervalMs: interval } });
      expect(deriveStats({ ...baseFiveBuild, equipment: { ...baseFiveBuild.equipment, [slot]: itemFixture(bound.id) } }, RULES_V1))
        .toMatchObject({ load: weight, armor: armor * stat, weaponDamage: damage * stat,
          arenaArmor: Math.round(armor * stat * 1.1 * 100) / 100, arenaWeaponMultiplier: slot === 'weapon' ? 1.1 : 1 });
    }
  });
  it('keeps immutable catalog data and rolled snapshot stats independent of later inventory mutation', () => {
    expect(Object.isFrozen(CATALOG_V1.items['sword:1:common'].stats.attributes)).toBe(true);
    expect(Object.isFrozen(RULES_V1.classes.guardian)).toBe(true);
    const item = itemFixture('sword:1:common');
    const valid = validateBuild({ ...buildInputFixture, equipment: { ...buildInputFixture.equipment, weapon: item.id } }, [item], 10, 1);
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error('expected valid build');
    item.stats.damage = 999;
    expect(deriveStats(valid.snapshot, RULES_V1).weaponDamage).toBe(6);
    expect(Object.isFrozen(valid.snapshot.equipment.weapon?.stats)).toBe(true);
  });
  it('encodes enemy baselines and expedition rewards without player health derivation', () => {
    const expected = [
      ['woodland', 1, 100, 20, 1, 0.2, 35, 6, 1100, [4, 4, 3, 4, 4]],
      ['outpost', 5, 250, 60, 2, 0.3, 80, 12, 1100, [12, 10, 8, 10, 10]],
      ['mountain', 10, 500, 120, 3, 0.4, 140, 18, 1000, [20, 16, 14, 16, 16]],
    ] as const;
    for (const [id, level, xp, money, salvage, chance, hp, damage, interval, attributes] of expected) {
      expect(CATALOG_V1.expeditions[id]).toMatchObject({ requiredLevel: level, encounters: 3,
        rewards: { xp, money, salvageQuantity: salvage, gearChance: chance, gearTier: level },
        enemy: { maxHp: hp, damage, intervalMs: interval, stance: 'balanced', armor: 0,
          attributes: { strength: attributes[0], agility: attributes[1], vitality: attributes[2], endurance: attributes[3], precision: attributes[4] } } });
    }
  });
});

describe('derived resources', () => {
  it.each([
    ['berserker', [5.5, 5, 5, 5, 5], 100, 100, 20],
    ['guardian', [5, 5, 5.25, 5.25, 5], 102, 100, 20.5],
    ['duelist', [5, 5.25, 5, 5, 5.25], 100, 100, 20],
  ] as const)('applies %s bonuses before flooring resources', (classId, a, maxHp, maxStamina, loadCapacity) => {
    expect(deriveStats({ ...baseFiveBuild, classId }, RULES_V1)).toMatchObject({
      attributes: { strength: a[0], agility: a[1], vitality: a[2], endurance: a[3], precision: a[4] },
      maxHp, maxStamina, loadCapacity, load: 0, overload: 0, efficiency: 1,
    });
  });
  it('combines immutable item attribute bonuses then rounds effective attributes to two decimals', () => {
    const sword = itemFixture('sword:1:common');
    sword.stats.attributes.strength = 0.05;
    expect(deriveStats({ ...baseFiveBuild, equipment: { ...baseFiveBuild.equipment, weapon: sword } }, RULES_V1).attributes.strength).toBe(5.56);
  });
  it('rounds percentage half-cent ties with fixed point arithmetic', () => {
    const sword = itemFixture('sword:1:common');
    sword.stats.attributes.strength = 0.15;
    const build = { ...baseFiveBuild, allocations: { ...baseFiveBuild.allocations, strength: 12 },
      equipment: { ...baseFiveBuild.equipment, weapon: sword } };
    // (5 + 12 + 0.15) × 1.10 = 18.865, rounded half-up to 18.87.
    expect(deriveStats(build, RULES_V1).attributes.strength).toBe(18.87);
  });
  it('permits heavy equipment while preserving armor and reducing efficiency to a floor of 0.5', () => {
    const equipment = { weapon: itemFixture('axe:1:common'), offHand: itemFixture('round-shield:1:common'),
      head: itemFixture('iron-helmet:1:common'), body: itemFixture('heavy-armor:1:common'), feet: itemFixture('heavy-boots:1:common') };
    expect(deriveStats({ ...baseFiveBuild, equipment }, RULES_V1)).toMatchObject({ load: 29, overload: 0.45, efficiency: 0.775, armor: 14 });
    equipment.body.stats.weight = 100;
    expect(deriveStats({ ...baseFiveBuild, equipment }, RULES_V1).efficiency).toBe(0.5);
  });
  it('exposes arena item modifiers separately so downstream combat applies them once', () => {
    const equipment = { ...baseFiveBuild.equipment, weapon: itemFixture('sword:1:renown'), body: itemFixture('heavy-armor:1:renown') };
    expect(deriveStats({ ...baseFiveBuild, equipment }, RULES_V1)).toMatchObject({ weaponDamage: 6, armor: 6, arenaWeaponMultiplier: 1.1, arenaArmor: 6.6 });
  });
  it('supports an empty weapon slot with zero item damage and a 1000 ms base interval', () => {
    expect(deriveStats(baseFiveBuild, RULES_V1)).toMatchObject({ weaponDamage: 0, weaponIntervalMs: 1000 });
  });
  it('never refills stamina on an Endurance change', () => {
    expect(preserveStamina(80, 120)).toBe(80);
    expect(preserveStamina(110, 100)).toBe(100);
    expect(preserveStamina(0, 120)).toBe(0);
  });
  it.each([[20, 0, 20], [30, 0.5, 45], [25, 0.45, 37], [0, 5, 0]])('charges ceiling of base %i with overload %s', (base, overload, expected) => {
    expect(activityCost(base, overload)).toBe(expected);
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer resource input %s', (value) => {
    expect(() => preserveStamina(value, 100)).toThrow(RangeError);
    expect(() => activityCost(value, 0)).toThrow(RangeError);
  });
  it('rejects unknown rules versions rather than silently applying current rules', () => {
    expect(() => deriveStats({ ...baseFiveBuild, rulesVersion: 'unknown' }, RULES_V1)).toThrow(RangeError);
  });
  it('rejects nonfinite overload and activity costs outside the safe integer range', () => {
    for (const overload of [NaN, Infinity, -0.01]) expect(() => activityCost(30, overload)).toThrow(RangeError);
    expect(() => activityCost(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(() => preserveStamina(10, 1.5)).toThrow(RangeError);
  });
});

describe('build validation', () => {
  it('requires ten creation points and allows unspent earned points on later builds', () => {
    expect(validateCreationAllocation(buildInputFixture.allocation)).toBe(true);
    expect(validateCreationAllocation({ ...buildInputFixture.allocation, strength: 1 })).toBe(false);
    expect(validateBuild({ ...buildInputFixture, allocation: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } }, [], 10, 100).ok).toBe(true);
    expect(validateBuild(buildInputFixture, [], 9, 1).ok).toBe(false);
  });
  it.each(['offensive', 'balanced', 'defensive'] as const)('accepts stance %s', (stance) => {
    expect(validateBuild({ ...buildInputFixture, stance }, [], 10, 1).ok).toBe(true);
  });
  it.each(rows)('accepts %s only in its legal slot', (id, slot) => {
    const item = itemFixture(`${id}:1:common`);
    const equipment = { ...buildInputFixture.equipment, [slot]: item.id };
    for (const classId of ['berserker', 'guardian', 'duelist'] as const) {
      expect(validateBuild({ ...buildInputFixture, equipment, classId }, [item], 10, 1).ok).toBe(true);
    }
    const wrongSlot = slot === 'head' ? 'feet' : 'head';
    expect(validateBuild({ ...buildInputFixture, equipment: { ...buildInputFixture.equipment, [wrongSlot]: item.id } }, [item], 10, 1).ok).toBe(false);
  });
  it.each([1, 5, 10] as const)('enforces tier %i level lock', (tier) => {
    const item = itemFixture(`sword:${tier}:common`);
    const input = { ...buildInputFixture, equipment: { ...buildInputFixture.equipment, weapon: item.id } };
    expect(validateBuild(input, [item], 10, tier).ok).toBe(true);
    if (tier > 1) expect(validateBuild(input, [item], 10, tier - 1).ok).toBe(false);
  });
  it('rejects two hands plus shield, missing ownership, repeated items and listing reservation', () => {
    const spear = itemFixture('spear:1:common');
    const shield = itemFixture('round-shield:1:common');
    const input = { ...buildInputFixture, equipment: { ...buildInputFixture.equipment, weapon: spear.id, offHand: shield.id } };
    expect(validateBuild(input, [spear, shield], 10, 1).ok).toBe(false);
    expect(validateBuild(input, [], 10, 1).ok).toBe(false);
    expect(validateBuild({ ...input, equipment: { ...input.equipment, offHand: spear.id } }, [spear], 10, 1).ok).toBe(false);
    spear.reservation = { kind: 'listing', referenceId: 'listing' };
    expect(validateBuild({ ...input, equipment: { ...input.equipment, offHand: null } }, [spear], 10, 1).ok).toBe(false);
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe allocation %s', (strength) => {
    const input = { ...buildInputFixture, allocation: { ...buildInputFixture.allocation, strength } };
    expect(validateBuild(input, [], 10, 1).ok).toBe(false);
    expect(validateCreationAllocation(input.allocation)).toBe(false);
  });
  it('rejects malformed runtime input without throwing or accepting extra allocation/equipment keys', () => {
    for (const input of [null, {}, { ...buildInputFixture, stance: 'magic' }, { ...buildInputFixture, classId: 'mage' },
      { ...buildInputFixture, allocation: { ...buildInputFixture.allocation, luck: 0 } },
      { ...buildInputFixture, equipment: { ...buildInputFixture.equipment, ring: null } }]) {
      expect(validateBuild(input as BuildInput, [], 10, 1).ok).toBe(false);
    }
    for (const [earned, level] of [[Infinity, 1], [10, 0], [10, 1.5], [-1, 1], [Number.MAX_SAFE_INTEGER, 1]]) {
      expect(validateBuild(buildInputFixture, [], earned, level).ok).toBe(false);
    }
  });
  it('accepts the named administrative bound exactly and rejects excess total/earned points or levels', () => {
    const allocation = { strength: 1_000_000_000, agility: 0, vitality: 0, endurance: 0, precision: 0 };
    const input = { ...buildInputFixture, allocation };
    const result = validateBuild(input, [], 1_000_000_000, 1_000_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected bound build');
    expect(result.unspentPoints).toBe(0);
    expect(deriveStats(result.snapshot, RULES_V1).attributes.strength).toBe(1_100_000_005.5);
    expect(validateBuild({ ...input, allocation: { ...allocation, agility: 1 } }, [], 1_000_000_000, 1).ok).toBe(false);
    expect(validateBuild({ ...input, allocation: { ...allocation, strength: 1_000_000_001 } }, [], 1_000_000_000, 1).ok).toBe(false);
    expect(validateBuild(buildInputFixture, [], 1_000_000_001, 1).ok).toBe(false);
    expect(validateBuild(buildInputFixture, [], 10, 1_000_000_001).ok).toBe(false);
  });
  it('rejects unknown catalog versions and malformed immutable rolls, while allowing two-decimal rolls', () => {
    const item = itemFixture('sword:1:common');
    const input = { ...buildInputFixture, equipment: { ...buildInputFixture.equipment, weapon: item.id } };
    item.stats.damage = 6.25;
    const result = validateBuild(input, [item], 10, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected rolled build');
    expect(deriveStats(result.snapshot, RULES_V1).weaponDamage).toBe(6.25);
    for (const damage of [NaN, Infinity, -1, 1.234, 1_000_000_001]) {
      item.stats.damage = damage;
      expect(validateBuild(input, [item], 10, 1).ok).toBe(false);
    }
    item.stats.damage = 6;
    item.catalogVersion = 'v2';
    expect(validateBuild(input, [item], 10, 1).ok).toBe(false);
  });
  it('allows revisions using equipment/pending reservations and rejects duplicate inventory IDs', () => {
    const item = itemFixture('sword:1:common');
    const input = { ...buildInputFixture, equipment: { ...buildInputFixture.equipment, weapon: item.id } };
    for (const kind of ['equipment', 'pending-build'] as const) {
      item.reservation = { kind, referenceId: 'current-or-pending' };
      expect(validateBuild(input, [item], 10, 1).ok).toBe(true);
    }
    expect(validateBuild(input, [item, structuredClone(item)], 10, 1).ok).toBe(false);
    expect(validateBuild({ ...input, equipment: { ...input.equipment, weapon: undefined as never } }, [item], 10, 1).ok).toBe(false);
  });
  it('charges only class changes and decreases of previously allocated points', () => {
    expect(buildChangeFee(buildInputFixture, { ...buildInputFixture, allocation: { ...buildInputFixture.allocation, strength: 3 } })).toBe(0);
    expect(buildChangeFee(buildInputFixture, { ...buildInputFixture, classId: 'duelist' })).toBe(100);
    const respec = { ...buildInputFixture, allocation: { ...buildInputFixture.allocation, strength: 1, agility: 3 } };
    expect(buildChangeFee(buildInputFixture, respec)).toBe(100);
    expect(buildChangeFee(buildInputFixture, { ...respec, classId: 'duelist' })).toBe(200);
  });
});
