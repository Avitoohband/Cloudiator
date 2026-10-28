import type { OwnerState, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads.ts';
import type { ItemInstance } from '../../supabase/functions/_shared/contracts/reads.ts';
import type { BuildInput, BuildSnapshot, CatalogItem } from '../../supabase/functions/_shared/domain/types.ts';

/** Minimal serializable wire fixtures, supplemented by private domain fixtures below. */
export const ownerFixture: OwnerState = {
  gladiatorId: '0d5f8471-d919-428f-9ab7-058c95821757', name: 'Aster', appearance: null,
  currentBuild: { version: 1, classId: 'guardian', stance: 'balanced',
    allocations: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 },
    equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } },
  pendingBuild: null, buildVersion: 1,
  schedule: { morning: { kind: 'training' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' }, evening: { kind: 'rest' } },
  scheduleVersion: 1, wallets: { money: 100, renown: 0 }, reservedFees: { money: 0, renown: 0 },
  inventory: [], inventoryCapacity: 60, ownedCosmetics: [],
  progression: { level: 1, xp: 0, earnedAttributePoints: 10, unspentAttributePoints: 0, league: 'bronze', peakStrength: 0, rating: 1000 },
  stamina: { current: 104, maximum: 104 }, tournamentOptIn: false,
  processedSlotIndex: 373247,
  currentActivity: { id: '9fce3cd5-e831-4a66-8ca1-16b4576b1499', kind: 'training', status: 'active',
    startsAtMs: 1791590400000, endsAtMs: 1791595200000, label: 'Training at the practice yard' },
  restingUntilSlot: null,
  // No messages in the shared fixture world: no badge. The fixture preview's own inbox is tests/fixtures/messages.ts.
  inbox: { unread: 0, readIds: [], sinceMs: 0 },
};

export const worldFixture: WorldSnapshot = {
  revision: 'fixture-1', serverNowMs: 1791592800000, slotIndex: 373248,
  actors: [{ gladiatorId: ownerFixture.gladiatorId, name: 'Aster', classId: 'guardian',
    equipmentSilhouettes: [], appearance: null, league: 'bronze', level: 1, phase: 'morning', location: 'training',
    activityId: ownerFixture.currentActivity!.id, activityStatus: 'active',
    startsAtMs: 1791590400000, endsAtMs: 1791595200000, visibleStage: null, resting: false }],
};

export const buildInputFixture: BuildInput = {
  classId: 'berserker', stance: 'balanced',
  allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 },
  equipment: { weapon: null, offHand: null, head: null, body: null, feet: null },
};

export const baseFiveBuild: BuildSnapshot = {
  rulesVersion: 'v1', classId: 'berserker', stance: 'balanced',
  allocations: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 },
  equipment: { weapon: null, offHand: null, head: null, body: null, feet: null },
};

/** A fresh canonical item DTO, with catalog stats copied as immutable rolls. */
export function itemFixture(entry: CatalogItem): ItemInstance {
  return { id: `item-${entry.id}`, ownerId: ownerFixture.gladiatorId, catalogId: entry.id, catalogVersion: 'v1',
    tier: entry.tier, rarity: entry.rarity, stats: structuredClone(entry.stats), quantity: 1,
    origin: entry.renownPrice === null ? 'shop' : 'renown', binding: entry.binding, reservation: null };
}
