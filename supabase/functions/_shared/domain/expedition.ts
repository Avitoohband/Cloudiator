import type { BattleLog, RevealedStage } from '../contracts/events.ts';
import type { ActivitySnapshot, Catalog, DeepReadonly, Expedition, FighterSnapshot, Rules, Seed } from './types.ts';
import type { LootGrant } from './inventory.ts';
import { CATALOG_V1 } from './catalog-v1.ts';
import { makeFighter, simulateBattle } from './combat.ts';
import { seededRandom } from './random.ts';
import { freezeDomain } from './types.ts';

export type ExpeditionEncounter = { index: number; dependsOn: number | null; revealOffsetMs: number;
  playerStartingHp: number; battleLog: BattleLog; success: boolean };
export type ExpeditionRewards = { xp: number; money: number; loot: LootGrant[] };
/** Private immutable authority. Only individual due stages may enter a public read model. */
export type ExpeditionPlan = DeepReadonly<{ activityId: string; rulesVersion: string; catalogVersion: string;
  expeditionId: string; success: boolean; encounters: ExpeditionEncounter[]; stages: RevealedStage[]; rewards: ExpeditionRewards }>;

const CREATURES = { woodland: ['dire-wolf', 'timber-wolf', 'dire-wolf'], outpost: ['raider', 'raider-archer', 'raider'],
  mountain: ['rock-troll', 'frost-troll', 'rock-troll'] } as const;

/** Stable catalog ordering and distinct loot stream: battle draw counts never shift loot probabilities. */
export function expeditionLoot(entry: Expedition, catalog: Catalog, rules: Rules, random: () => number): LootGrant[] {
  const loot: LootGrant[] = [{ catalogId: catalog.salvage.id, catalogVersion: catalog.version,
    quantity: entry.rewards.salvageQuantity, origin: 'expedition' }];
  if (random() >= entry.rewards.gearChance) return loot;
  const rarityRoll = random();
  const rarity = rarityRoll < rules.rarities.common.lootChance ? 'common'
    : rarityRoll < rules.rarities.common.lootChance + rules.rarities.uncommon.lootChance ? 'uncommon' : 'rare';
  const candidates = Object.values(catalog.items).filter(item => item.tier === entry.rewards.gearTier && item.rarity === rarity && item.renownPrice === null)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const gear = candidates[Math.floor(random() * candidates.length)];
  if (!gear) throw new RangeError('Invalid expedition loot roll');
  loot.push({ catalogId: gear.id, catalogVersion: catalog.version, quantity: 1, origin: 'expedition' });
  return loot;
}

/** Pure retained-v1 planner; future rules/catalog versions require explicit retained implementations. */
export function planExpedition(snapshot: ActivitySnapshot, seed: Seed, rules: Rules): ExpeditionPlan {
  if (rules.version !== 'v1' || snapshot.rulesVersion !== rules.version || snapshot.build.rulesVersion !== rules.version
    || snapshot.choice.kind !== 'expedition' || !Object.hasOwn(CATALOG_V1.expeditions, snapshot.choice.expeditionId)) throw new RangeError('Unsupported expedition snapshot');
  const id = snapshot.choice.expeditionId, catalog = CATALOG_V1, entry = catalog.expeditions[id];
  if (snapshot.starting.level < entry.requiredLevel) throw new RangeError('Locked expedition');
  const player = makeFighter(snapshot.build, 'expedition', rules), enemy = entry.enemy;
  const template: FighterSnapshot = { rulesVersion: rules.version, classId: null, stance: enemy.stance, attributes: enemy.attributes,
    maxHealth: enemy.maxHp, armor: enemy.armor, weaponDamage: enemy.damage, baseDamage: enemy.damage,
    attackIntervalMs: enemy.intervalMs, efficiency: 1, equipmentSilhouettes: [] };
  const encounters: ExpeditionEncounter[] = [], stages: RevealedStage[] = [];
  const stage = (kind: RevealedStage['kind'], offset: number, end: number, label: string, battleLog?: BattleLog) => {
    stages.push({ id: `${snapshot.activityId}:${stages.length}`, kind, revealedAtMs: snapshot.cutoffMs + offset,
      startedAtMs: snapshot.cutoffMs + offset, endsAtMs: snapshot.cutoffMs + end, label, ...(battleLog ? { battleLog } : {}) });
  };
  stage('depart', 0, 1_200_000, `Depart for ${entry.name}`);
  let hp = player.maxHealth, success = true;
  for (let i = 0; i < 3; i++) {
    const offset = (i + 1) * 1_200_000;
    const battleLog = simulateBattle({ battleId: `${snapshot.activityId}:encounter:${i + 1}`, rulesVersion: rules.version, rules,
      fighters: [{ id: snapshot.gladiatorId, gladiatorId: snapshot.gladiatorId, name: 'Gladiator', snapshot: player, startingHealth: hp },
        { id: `creature:${CREATURES[id][i]}:${i + 1}`, gladiatorId: null, name: enemy.name, snapshot: template }] }, `${seed}:encounter:${i + 1}`);
    // A simultaneous-defeat tie-break victory still has zero HP: defeat ends the expedition.
    success = battleLog.winnerId === snapshot.gladiatorId && battleLog.finalHp[0] > 0;
    encounters.push({ index: i + 1, dependsOn: i === 0 ? null : i, revealOffsetMs: offset, playerStartingHp: hp, battleLog, success });
    stage('encounter', offset, offset + battleLog.durationMs, `Encounter ${i + 1}: ${success ? 'victory' : 'defeat'}`, battleLog);
    if (!success) { stage('return', offset + battleLog.durationMs, rules.clock.slotMs, 'Rest at the safe return point'); break; }
    hp = battleLog.finalHp[0];
    if (i < 2) { hp = Math.min(player.maxHealth, hp + Math.floor(player.maxHealth * .2));
      stage('exploration', offset + battleLog.durationMs, offset + 1_200_000, 'Recover and continue exploring'); }
    else stage('travel', offset + battleLog.durationMs, rules.clock.slotMs, 'Return to camp');
  }
  stage('return', rules.clock.slotMs, rules.clock.slotMs, 'Arrive at camp');
  const rewards = success ? { xp: entry.rewards.xp, money: entry.rewards.money, loot: expeditionLoot(entry, catalog, rules, seededRandom(`${seed}:loot`)) }
    : { xp: 0, money: 0, loot: [] };
  return freezeDomain({ activityId: snapshot.activityId, rulesVersion: rules.version, catalogVersion: catalog.version,
    expeditionId: id, success, encounters, stages, rewards });
}
