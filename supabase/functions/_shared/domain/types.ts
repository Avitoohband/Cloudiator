import type { Attributes, ClassId, EquipmentSlot, GameCommand, Phase, Stance } from '../contracts/commands.ts';
import type { ItemInstance } from '../contracts/reads.ts';
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
