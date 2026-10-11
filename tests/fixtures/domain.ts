import type { OwnerState, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads.ts';

/** Minimal serializable wire fixtures; private engine snapshots/catalogs arrive in Task 2. */
export const ownerFixture: OwnerState = {
  gladiatorId: '0d5f8471-d919-428f-9ab7-058c95821757', name: 'Aster',
  currentBuild: { version: 1, classId: 'guardian', stance: 'balanced',
    allocations: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 },
    equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } },
  pendingBuild: null,
  schedule: { morning: { kind: 'training' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' }, evening: { kind: 'rest' } },
  scheduleVersion: 1, wallets: { money: 100, renown: 0 }, reservedFees: { money: 0, renown: 0 },
  inventory: [], inventoryCapacity: 60,
  progression: { level: 1, xp: 0, earnedAttributePoints: 10, unspentAttributePoints: 0, league: 'bronze', peakStrength: 0, rating: 1000 },
  stamina: { current: 104, maximum: 104 }, tournamentOptIn: false,
  processedSlotIndex: 373247,
  currentActivity: { id: '9fce3cd5-e831-4a66-8ca1-16b4576b1499', kind: 'training', status: 'active',
    startsAtMs: 1791590400000, endsAtMs: 1791595200000, label: 'Training at the practice yard' },
};

export const worldFixture: WorldSnapshot = {
  revision: 'fixture-1', serverNowMs: 1791592800000, slotIndex: 373248,
  actors: [{ gladiatorId: ownerFixture.gladiatorId, name: 'Aster', classId: 'guardian',
    equipmentSilhouettes: [], league: 'bronze', level: 1, phase: 'morning', location: 'Practice yard',
    activityId: ownerFixture.currentActivity!.id, activityStatus: 'active',
    startsAtMs: 1791590400000, endsAtMs: 1791595200000, visibleStage: null }],
};
