import type { ActivityChoice, Attributes, ClassId, EquipmentSlot, GameCommand, LeagueId, Phase, Stance } from '../contracts/commands.ts';
import type { BuildView, ItemInstance } from '../contracts/reads.ts';
import type { ItemRarity, ItemStats } from '../contracts/events.ts';
import type { RULES_V1 } from './rules-v1.ts';

export type { Attributes, ClassId, EquipmentSlot, Phase, Stance, ItemInstance };
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Rules = typeof RULES_V1;
/** Private domain inputs reuse the canonical queue command's fields. */
export type BuildInput = Pick<Extract<GameCommand, { kind: 'queue-build' }>, 'classId' | 'stance' | 'allocation' | 'equipment'>;
export type BuildSnapshot = DeepReadonly<{
  rulesVersion: string; classId: ClassId; stance: Stance; allocations: Attributes;
  equipment: Record<EquipmentSlot, ItemInstance | null>;
}>;
export type BuildValidation = { ok: true; snapshot: BuildSnapshot; unspentPoints: number } | {
  ok: false; reason: 'invalid-input' | 'points' | 'item' | 'level' | 'slot' | 'reserved' | 'two-handed';
};
export type SlotWindow = { index: number; phase: Phase; startMs: number; endMs: number };
export type DerivedStats = {
  attributes: Attributes; maxHp: number; maxStamina: number; loadCapacity: number; load: number;
  overload: number; efficiency: number; armor: number; weaponDamage: number; weaponIntervalMs: number;
  arenaWeaponMultiplier: number; arenaArmor: number;
};
/** Private backend inputs. Neither seeds nor these authoritative snapshots are read DTOs. */
export type Seed = string;
/** Resolved activity kinds; tournament is assigned by the Task 19 pairing hook, never requested directly. */
export type ActivityKind = 'training' | 'rest' | 'expedition' | 'arena' | 'tournament';
export type ActivityCosts = Record<ActivityKind, number>;
/** Durable job categories: boundary preparation, private simulation, timed reveal and terminal settlement. */
export type JobKind = 'prepare' | 'simulation' | 'reveal' | 'settlement';
/** Frozen cutoff inputs for the boundary recompute phase; written by SQL, read only by a trusted worker. */
export type PreparationInput = DeepReadonly<{
  gladiatorId: string; slotIndex: number; rulesVersion: string;
  build: BuildView; items: ItemInstance[]; level: number; earnedPoints: number;
}>;
/** Canonical TypeScript derivation stored by `complete_job`; SQL never re-implements the stats engine. */
export type PreparationResult = {
  rulesVersion: string; snapshot: BuildSnapshot; derived: DerivedStats;
  staminaMaximum: number; costs: ActivityCosts; trainingPoints: number;
};
/** Private, frozen at one historical boundary; never an owner/public read DTO. Executors (Tasks 9/16/19) consume it. */
export type ActivitySnapshot = DeepReadonly<{
  activityId: string; gladiatorId: string; slotIndex: number; rulesVersion: string; cutoffMs: number;
  choice: ActivityChoice; scheduleVersion: number;
  build: BuildSnapshot; derived: DerivedStats; costs: ActivityCosts; trainingPoints: number;
  starting: {
    stamina: { current: number; maximum: number }; level: number; xp: number; earnedPoints: number; unspentPoints: number;
    league: LeagueId; rating: number; peakStrength: number; tournamentOptIn: boolean;
  };
}>;
export type SettlementInput = DeepReadonly<{ activityId: string; gladiatorId: string; slotIndex: number; resolvedKind: ActivityKind; endsAtMs: number }>;
export type JobInput = PreparationInput | SettlementInput | ActivitySnapshot | DeepReadonly<Record<string, unknown>>;
/** A claimed fenced lease. `snapshot` is the job's immutable input; seed and rules version never change across retries. */
export type JobLease<Input = JobInput> = DeepReadonly<{
  id: string; token: string; expiresAtMs: number; kind: JobKind;
  activityId: string | null; gladiatorId: string; slotIndex: number;
  snapshot: Input; seed: Seed; rulesVersion: string; attempt: number;
}>;
/** Coordinator results returned by `advance_boundary`/`coordinate_work`; no seeds, snapshots or tokens. */
export type BoundaryReport = {
  ok: boolean; code?: string; slotIndex?: number; phase?: number;
  status?: 'complete' | 'waiting'; wait?: 'settlement' | 'extension' | 'preparation' | 'integration' | 'operator' | 'straggler'; replayed?: boolean;
};
export type CoordinatorReport = { ok: boolean; busy?: boolean; publishedSlot: number | null; currentSlot?: number; boundaries?: BoundaryReport[] };
export type WorkerReport = {
  claimed: number; completed: number; replayed: number; failed: number; conflicts: number;
  byKind: Record<JobKind, number>; coordination: CoordinatorReport | null;
};
export type FighterSnapshot = DeepReadonly<{
  rulesVersion: string; classId: ClassId | null; stance: Stance; attributes: Attributes;
  maxHealth: number; armor: number; weaponDamage: number;
  /** Arena-adjusted item damage plus Strength, before efficiency/critical/stances/armor.
   * NPC templates may override baseDamage/maxHealth without re-applying efficiency. */
  baseDamage: number;
  attackIntervalMs: number; efficiency: number; equipmentSilhouettes: string[];
}>;
export type BattleParticipant = DeepReadonly<{
  id: string; gladiatorId: string | null; name: string; snapshot: FighterSnapshot;
  /** Omit for full-health arena/tournament bouts; expeditions carry encounter health. */
  startingHealth?: number;
}>;
export type BattleInput = DeepReadonly<{
  battleId: string; rulesVersion: string; rules: Rules;
  fighters: [BattleParticipant, BattleParticipant];
}>;
export type CatalogItem = DeepReadonly<{
  id: string; templateId: string; name: string; slot: EquipmentSlot; hands: 0 | 1 | 2;
  tier: 1 | 5 | 10; rarity: ItemRarity; stats: ItemStats; binding: ItemInstance['binding'];
  moneyPrice: number | null; renownPrice: number | null; npcSellValue: number | null;
}>;
export type Expedition = DeepReadonly<{
  id: string; name: string; requiredLevel: 1 | 5 | 10; encounters: number;
  rewards: { xp: number; money: number; salvageQuantity: number; gearChance: number; gearTier: 1 | 5 | 10 };
  enemy: { name: string; maxHp: number; damage: number; intervalMs: number; attributes: Attributes; stance: Stance; armor: number };
}>;

/** Freeze owned versioned data/snapshots, never the caller's live DTO. */
export function freezeDomain<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDomain(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
