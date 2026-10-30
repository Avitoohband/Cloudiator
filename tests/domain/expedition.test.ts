import { describe, expect, it } from 'vitest';
import { planExpedition, expeditionLoot } from '../../supabase/functions/_shared/domain/expedition.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { RULES_V2 } from '../../supabase/functions/_shared/domain/rules-v2.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { deriveStats } from '../../supabase/functions/_shared/domain/stats.ts';
import type { ActivitySnapshot, BuildSnapshot } from '../../supabase/functions/_shared/domain/types.ts';
import { baseFiveBuild, itemFixture } from '../fixtures/domain.ts';

export function expeditionSnapshot(strength = 150, vitality = 30, expeditionId: 'woodland' | 'outpost' | 'mountain' = 'woodland', level = 10): ActivitySnapshot {
  const build: BuildSnapshot = { ...baseFiveBuild, allocations: { strength, agility: 5, vitality, endurance: 5, precision: 5 } };
  return { activityId: 'ae449160-81a3-4057-a05f-ce6ba3a43e23', gladiatorId: '0d5f8471-d919-428f-9ab7-058c95821757',
    slotIndex: 300, rulesVersion: 'v1', cutoffMs: 300 * 4_800_000, choice: { kind: 'expedition', expeditionId }, scheduleVersion: 1,
    build, derived: deriveStats(build, RULES_V1), costs: RULES_V1.activityStamina, trainingPoints: 1,
    starting: { stamina: { current: 100, maximum: 100 }, level, xp: 0, earnedPoints: 200, unspentPoints: 0,
      league: 'bronze', rating: 1000, peakStrength: 0, tournamentOptIn: false } };
}
describe('private deterministic expedition planning', () => {
  // Canonical tier-1 spear, 20 effective Agility: 1200 / 1.2 = 1000ms,
  // matching the Mountain enemy's interval. These fixed seeds produce real
  // simultaneous lethal attacks in the unchanged combat engine, without mocks.
  function simultaneousSnapshot(strength: number): ActivitySnapshot {
    const snapshot = expeditionSnapshot(strength, 0, 'mountain');
    const build: BuildSnapshot = { ...snapshot.build,
      allocations: { ...snapshot.build.allocations, agility: 15 },
      equipment: { ...snapshot.build.equipment, weapon: itemFixture(CATALOG_V1.items['spear:1:common']) } };
    return { ...snapshot, build, derived: deriveStats(build, RULES_V1) };
  }
  it('heals a canonical zero-HP winner after a non-final encounter and continues the trip', () => {
    const snapshot = simultaneousSnapshot(5), plan = planExpedition(snapshot, 'tie-21', RULES_V1);
    const first = plan.encounters[0];
    expect(first.battleLog).toMatchObject({ finalHp: [0, 0], winnerId: snapshot.gladiatorId,
      victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' });
    expect(first.battleLog.events.at(-1)).toMatchObject({ kind: 'victory', winnerId: snapshot.gladiatorId });
    expect(first.success).toBe(true);
    expect(plan.encounters[1].playerStartingHp).toBe(20); // 20% of canonical 100 max HP.
    expect(plan.stages.find(s => s.kind === 'encounter')?.label).toBe('Encounter 1: victory');
    expect(plan.stages.some(s => s.kind === 'exploration')).toBe(true);
  });
  it('awards full success rewards when the canonical third-encounter winner has zero HP', () => {
    const snapshot = simultaneousSnapshot(30), plan = planExpedition(snapshot, 'tie-252', RULES_V1);
    expect(plan.encounters).toHaveLength(3);
    expect(plan.encounters.map(e => e.playerStartingHp)).toEqual([100, 66, 23]);
    expect(plan.encounters[2].battleLog).toMatchObject({ finalHp: [0, 0], winnerId: snapshot.gladiatorId,
      victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' });
    expect(plan.encounters.every(e => e.success)).toBe(true);
    expect(plan.success).toBe(true);
    expect(plan.rewards).toEqual({ xp: 500, money: 120,
      loot: [{ catalogId: 'salvage', catalogVersion: 'v1', quantity: 3, origin: 'expedition' }] });
    expect(plan.stages.some(s => s.kind === 'travel')).toBe(true);
    expect(plan.stages.some(s => s.label === 'Rest at the safe return point')).toBe(false);
  });
  it('still stops and withholds all rewards when the canonical simultaneous-defeat winner is the enemy', () => {
    const snapshot = simultaneousSnapshot(5), plan = planExpedition(snapshot, 'tie-0', RULES_V1);
    expect(plan.encounters).toHaveLength(1);
    expect(plan.encounters[0].battleLog).toMatchObject({ finalHp: [0, 0], winnerId: 'creature:rock-troll:1',
      victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' });
    expect(plan.encounters[0].success).toBe(false);
    expect(plan.success).toBe(false);
    expect(plan.rewards).toEqual({ xp: 0, money: 0, loot: [] });
    expect(plan.stages.some(s => s.kind === 'exploration' || s.kind === 'travel')).toBe(false);
    expect(plan.stages.some(s => s.label === 'Rest at the safe return point')).toBe(true);
  });
  it('plans complete immutable encounters at 20/40/60 with full initial HP and capped floored recovery', () => {
    const snapshot = expeditionSnapshot(), before = JSON.stringify(snapshot);
    const plan = planExpedition(snapshot, 'success', RULES_V1);
    expect(plan).toEqual(planExpedition(snapshot, 'success', RULES_V1));
    expect(plan.success).toBe(true);
    expect(plan.encounters.map(e => e.revealOffsetMs)).toEqual([1_200_000, 2_400_000, 3_600_000]);
    expect(plan.encounters[0].playerStartingHp).toBe(snapshot.derived.maxHp);
    for (let i = 1; i < 3; i++) expect(plan.encounters[i].playerStartingHp).toBe(Math.min(snapshot.derived.maxHp,
      plan.encounters[i - 1].battleLog.finalHp[0] + Math.floor(snapshot.derived.maxHp * .2)));
    expect(plan.rewards).toMatchObject({ xp: 100, money: 20, loot: [{ catalogId: 'salvage', quantity: 1 }] });
    expect(Object.isFrozen(plan.encounters[0].battleLog)).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it.each(['woodland', 'outpost', 'mountain'] as const)('uses canonical %s templates and exact manifest identities', id => {
    const plan = planExpedition(expeditionSnapshot(300, 100, id), 'templates', RULES_V1);
    const entry = CATALOG_V1.expeditions[id];
    const names = { woodland: ['dire-wolf','timber-wolf','dire-wolf'], outpost: ['raider','raider-archer','raider'], mountain: ['rock-troll','frost-troll','rock-troll'] };
    plan.encounters.forEach((e, i) => {
      expect(e.battleLog.participants[1]).toMatchObject({ id: `creature:${names[id][i]}:${i + 1}`, maxHealth: entry.enemy.maxHp, armor: 0, stance: 'balanced', attackIntervalMs: entry.enemy.intervalMs, attributes: entry.enemy.attributes });
    });
    expect(plan.rewards).toMatchObject({ xp: entry.rewards.xp, money: entry.rewards.money });
  });
  it('rejects locked tiers and unknown retained rules', () => {
    for (const [id, level] of [['outpost',4],['mountain',9]] as const) expect(() => planExpedition(expeditionSnapshot(150,30,id,level), 'x', RULES_V1)).toThrow();
    expect(() => planExpedition({ ...expeditionSnapshot(), rulesVersion: 'v9' }, 'x', RULES_V1)).toThrow();
  });
  it('stops on defeat at each encounter and gives no XP, money or loot; a new trip begins at full HP', () => {
    const found = new Map<number, ReturnType<typeof planExpedition>>();
    const first = planExpedition(expeditionSnapshot(0, 0, 'outpost'), 'defeat', RULES_V1);
    found.set(first.encounters.length, first);
    for (let strength = 0; strength <= 12 && found.size < 3; strength += 2) {
      for (let seed = 0; seed < 100 && found.size < 3; seed++) {
        const snapshot = expeditionSnapshot(strength, 0);
        const plan = planExpedition(snapshot, `failure-${seed}`, RULES_V1);
        if (!plan.success) found.set(plan.encounters.length, plan);
      }
    }
    expect([...found.keys()].sort()).toEqual([1, 2, 3]);
    for (const plan of found.values()) {
      expect(plan.rewards).toEqual({ xp: 0, money: 0, loot: [] });
      expect(plan.encounters.at(-1)?.success).toBe(false);
      expect(plan.stages.filter(s => s.kind === 'encounter')).toHaveLength(plan.encounters.length);
      expect(plan.stages.some(s => s.label === 'Rest at the safe return point')).toBe(true);
      expect(plan.encounters[0].playerStartingHp).toBe(plan.encounters[0].battleLog.participants[0].maxHealth);
    }
  });
  it.each(['woodland', 'outpost', 'mountain'] as const)('uses strict gear probability and 70/25/5 rarity boundaries for %s', id => {
    const entry = CATALOG_V1.expeditions[id];
    const roll = (values: number[]) => expeditionLoot(entry, CATALOG_V1, RULES_V1, () => values.shift()!);
    expect(roll([entry.rewards.gearChance])).toHaveLength(1);
    for (const [value, rarity] of [[0,'common'],[.699999,'common'],[.7,'uncommon'],[.949999,'uncommon'],[.95,'rare']] as const) {
      const loot = roll([entry.rewards.gearChance - .000001, value, 0]);
      expect(CATALOG_V1.items[loot[1].catalogId]).toMatchObject({ tier: entry.rewards.gearTier, rarity, renownPrice: null });
    }
  });
});

// Patch 1.6: a trip is planned under the rules of the snapshot that froze it (spec "Domain"): any retained version, the same
// fights, the version's own rewards. A snapshot "prepared under" v2 has its build stamped v2 and its stats derived under v2.
function v2Snapshot(snapshot: ActivitySnapshot): ActivitySnapshot {
  const build: BuildSnapshot = { ...snapshot.build, rulesVersion: 'v2' };
  return { ...snapshot, rulesVersion: 'v2', build, derived: deriveStats(build, RULES_V2), costs: RULES_V2.activityStamina };
}
describe('expeditions under the activity\'s rules version (patch 1.6)', () => {
  const outpost = () => expeditionSnapshot(150, 30, 'outpost', 10);
  it('plans a v2 trip with v2 rewards and the same fights', () => {
    const v1Snapshot = outpost(), v2 = planExpedition(v2Snapshot(v1Snapshot), 'success', RULES_V2), v1 = planExpedition(v1Snapshot, 'success', RULES_V1);
    expect(v1.success).toBe(true);
    expect(v2).toMatchObject({ success: true, rulesVersion: 'v2', catalogVersion: 'v1', expeditionId: 'outpost' });
    expect(v2.rewards).toMatchObject({ xp: 75, money: 10 });
    expect(v2.rewards.loot[0]).toEqual({ catalogId: 'salvage', catalogVersion: 'v1', quantity: 2, origin: 'expedition' });
    expect(v1).toMatchObject({ rulesVersion: 'v1', catalogVersion: 'v1' });
    expect(v1.rewards).toMatchObject({ xp: 250, money: 60 });
    expect(v2.encounters).toHaveLength(3);
    expect(v2.encounters.map(e => e.battleLog.winnerId)).toEqual(v1.encounters.map(e => e.battleLog.winnerId));
    expect(v2.encounters.map(e => e.battleLog.durationMs)).toEqual(v1.encounters.map(e => e.battleLog.durationMs));
    expect(v2.stages.map(stage => stage.label)).toEqual(v1.stages.map(stage => stage.label));
  });
  it.each([['woodland', 30, 4, 1], ['outpost', 75, 10, 2], ['mountain', 150, 18, 3]] as const)(
    'pays %s %i XP, %i gold and %i salvage under v2', (id, xp, money, salvage) => {
      const plan = planExpedition(v2Snapshot(expeditionSnapshot(300, 100, id, 10)), 'rewards', RULES_V2);
      expect(plan.success).toBe(true);
      expect(plan.rewards).toMatchObject({ xp, money });
      expect(plan.rewards.loot[0]).toMatchObject({ catalogId: 'salvage', quantity: salvage });
    });
  it('finds gear half as often', () => {
    const v1Snapshot = outpost(), v2Prepared = v2Snapshot(v1Snapshot);
    let v1Wins = 0, v1Gear = 0, v2Wins = 0, v2Gear = 0;
    for (let i = 0; i < 2000; i++) {
      const v1 = planExpedition(v1Snapshot, `seed-${i}`, RULES_V1), v2 = planExpedition(v2Prepared, `seed-${i}`, RULES_V2);
      if (v1.success) { v1Wins += 1; if (v1.rewards.loot.length > 1) v1Gear += 1; }
      if (v2.success) { v2Wins += 1; if (v2.rewards.loot.length > 1) v2Gear += 1; }
    }
    expect(v1Wins).toBeGreaterThan(1900);
    expect(v2Wins).toBe(v1Wins);
    expect(v1Gear / v1Wins).toBeGreaterThan(0.27);
    expect(v1Gear / v1Wins).toBeLessThan(0.33);
    expect(v2Gear / v2Wins).toBeGreaterThan(0.12);
    expect(v2Gear / v2Wins).toBeLessThan(0.18);
  });
  it('refuses mixed versions', () => {
    const v1Snapshot = outpost(), prepared = v2Snapshot(v1Snapshot);
    // Each snapshot is fine under its own rules; only the pairing is refused.
    expect(() => planExpedition(v1Snapshot, 'x', RULES_V1)).not.toThrow();
    expect(() => planExpedition(prepared, 'x', RULES_V2)).not.toThrow();
    expect(() => planExpedition(v1Snapshot, 'x', RULES_V2)).toThrow(RangeError);
    expect(() => planExpedition(prepared, 'x', RULES_V1)).toThrow(RangeError);
    // A v2 trip whose build was stamped v1 (or the reverse) is as mixed as a wrong rules argument.
    expect(() => planExpedition({ ...prepared, build: { ...prepared.build, rulesVersion: 'v1' } }, 'x', RULES_V2)).toThrow(RangeError);
    expect(() => planExpedition({ ...v1Snapshot, build: { ...v1Snapshot.build, rulesVersion: 'v2' } }, 'x', RULES_V1)).toThrow(RangeError);
    expect(() => planExpedition({ ...prepared, rulesVersion: 'v9', build: { ...prepared.build, rulesVersion: 'v9' } }, 'x', RULES_V2)).toThrow(RangeError);
  });
  it('keeps the loot stream of a seed: v2 loot is v1 loot whenever v1 found gear that v2 also found', () => {
    const v1Snapshot = outpost(), prepared = v2Snapshot(v1Snapshot);
    let shared = 0;
    for (let i = 0; i < 300; i++) {
      const v1 = planExpedition(v1Snapshot, `loot-${i}`, RULES_V1), v2 = planExpedition(prepared, `loot-${i}`, RULES_V2);
      if (v2.rewards.loot.length > 1) { expect(v1.rewards.loot).toEqual(v2.rewards.loot); shared += 1; }
    }
    expect(shared).toBeGreaterThan(10);
  });
});
