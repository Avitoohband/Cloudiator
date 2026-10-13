import { describe, expect, it } from 'vitest';
import { planExpedition, expeditionLoot } from '../../supabase/functions/_shared/domain/expedition.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { deriveStats } from '../../supabase/functions/_shared/domain/stats.ts';
import type { ActivitySnapshot, BuildSnapshot } from '../../supabase/functions/_shared/domain/types.ts';
import { baseFiveBuild } from '../fixtures/domain.ts';

export function expeditionSnapshot(strength = 150, vitality = 30, expeditionId: 'woodland' | 'outpost' | 'mountain' = 'woodland', level = 10): ActivitySnapshot {
  const build: BuildSnapshot = { ...baseFiveBuild, allocations: { strength, agility: 5, vitality, endurance: 5, precision: 5 } };
  return { activityId: 'ae449160-81a3-4057-a05f-ce6ba3a43e23', gladiatorId: '0d5f8471-d919-428f-9ab7-058c95821757',
    slotIndex: 300, rulesVersion: 'v1', cutoffMs: 300 * 4_800_000, choice: { kind: 'expedition', expeditionId }, scheduleVersion: 1,
    build, derived: deriveStats(build, RULES_V1), costs: RULES_V1.activityStamina, trainingPoints: 1,
    starting: { stamina: { current: 100, maximum: 100 }, level, xp: 0, earnedPoints: 200, unspentPoints: 0,
      league: 'bronze', rating: 1000, peakStrength: 0, tournamentOptIn: false } };
}
describe('private deterministic expedition planning', () => {
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
