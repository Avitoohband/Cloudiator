import type { ActivityId, Attributes, ClassId, GladiatorId, Stance } from './commands.ts';

export type ItemRarity = 'common' | 'uncommon' | 'rare';
export type ItemStats = { damage: number; armor: number; weight: number; intervalMs: number; attributes: Attributes };
export type ItemReward = { catalogId: string; catalogVersion: string; tier: 1 | 5 | 10; rarity: ItemRarity; quantity: number };
export type CreditedRewards = { money: number; renown: number; xp: number; attributePoints: number; items: ItemReward[]; overflowMoney: number };
export type ActivitySummary = {
  activityId: ActivityId;
  resolvedKind: 'training' | 'rest' | 'expedition' | 'arena' | 'tournament';
  result: 'completed' | 'victory' | 'defeat';
  success: boolean;
  rewards: CreditedRewards;
  receiptId: string;
  settledAtMs: number;
  replayExpiry: { state: 'available'; expiresAtMs: number } | { state: 'expired' };
  ratingDelta?: number;
};

/** These snapshots appear only inside an already-revealed battle log. */
export type RevealedCombatant = {
  id: string;
  gladiatorId: GladiatorId | null;
  name: string;
  classId: ClassId | null;
  stance: Stance;
  attributes: Readonly<Attributes>;
  maxHealth: number;
  initialHealth: number;
  armor: number;
  weaponDamage: number;
  attackIntervalMs: number;
  efficiencyBasisPoints: number;
  equipmentSilhouettes: readonly string[];
};
export type BattleAction = {
  kind: 'attack'; sequence: number; elapsedMs: number; attackerId: string; defenderId: string;
  /** defend means a landed attack received Defensive stance mitigation; evade means a miss. */
  hit: boolean; critical: boolean; defend: boolean; evade: boolean;
  damage: number; healthBefore: number; healthAfter: number;
};
export type BattleVictory = {
  kind: 'victory'; sequence: number; elapsedMs: number; winnerId: string; loserId: string;
  reason: 'defeat' | 'health-fraction' | 'tie-break';
};
export type BattleLog = {
  battleId: string; rulesVersion: string;
  participants: readonly [Readonly<RevealedCombatant>, Readonly<RevealedCombatant>];
  events: readonly (Readonly<BattleAction> | Readonly<BattleVictory>)[];
  durationMs: number; winnerId: string;
  victoryReason: BattleVictory['reason'];
  /** Health values use the same order as participants. */
  finalHp: readonly [number, number];
  tieBreakReason: 'simultaneous-defeat' | 'equal-health-fraction' | null;
};
export type RevealedStage = {
  id: string; kind: 'depart' | 'travel' | 'exploration' | 'encounter' | 'return' | 'settlement' | 'staging' | 'bout';
  revealedAtMs: number; startedAtMs: number; endsAtMs: number; label: string;
  battleLog?: BattleLog;
};
export type RevealedTimeline = {
  activityId: ActivityId; serverNowMs: number; visibleThroughMs: number;
  stages: RevealedStage[]; summary?: ActivitySummary;
};
