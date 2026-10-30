import type { EquipmentSlot } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { OwnerState, PublicProfile, StandingRow } from '../../supabase/functions/_shared/contracts/reads.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import type { ArenaRecord, ProfileRead, PublicBuild, PublicGear } from '../../src/lib/api/reads.ts';
import { suggestedSplit } from '../../src/features/character/class-bonus.ts';

/**
 * The richer profile card's data for the fixture preview (Task 11c): sample builds, creation times and Arena records for the fixture's
 * public profiles, as M26's profile read carries them. Sample data, not any player's:
 * - an Arena gladiator's build is its class's suggested split of `10 + 2 × (level − 1)` points, stance balanced, wearing its silhouettes
 *   as level-1 common items; its record is its current-season standings row's; it was made `level` days before the fixture's clock;
 * - the owner's build is its own current build (its worn items from its inventory), its record its standings row's.
 */
const SLOT_OF: Record<string, [EquipmentSlot, string]> = {
  'weapon-sword': ['weapon', 'sword'], 'weapon-axe': ['weapon', 'axe'], 'weapon-spear': ['weapon', 'spear'], 'weapon-bow': ['weapon', 'bow'],
  'offhand-shield': ['offHand', 'round-shield'], 'head-hood': ['head', 'leather-hood'], 'head-helmet': ['head', 'iron-helmet'],
  'armor-light': ['body', 'light-armor'], 'armor-heavy': ['body', 'heavy-armor'], 'feet-light': ['feet', 'light-boots'], 'feet-heavy': ['feet', 'heavy-boots'],
};
const DAY_MS = 86_400_000;
const NONE = (): Record<EquipmentSlot, PublicGear | null> => ({ weapon: null, offHand: null, head: null, body: null, feet: null });
const gearOf = (catalogId: string): PublicGear => {
  const item = CATALOG_V1.items[catalogId];
  return { catalogId, catalogVersion: CATALOG_V1.version, tier: item.tier, rarity: item.rarity, stats: structuredClone(item.stats) as PublicGear['stats'] };
};

/** A gladiator's silhouettes as level-1 common items, slot by slot. */
export function silhouetteGear(silhouettes: readonly string[]): Record<EquipmentSlot, PublicGear | null> {
  const equipment = NONE();
  for (const silhouette of silhouettes) {
    const entry = SLOT_OF[silhouette];
    if (entry) equipment[entry[0]] = gearOf(`${entry[1]}:1:common`);
  }
  return equipment;
}

/** The owner's current build as the profile read publishes it: its stance, its points and its worn items' public fields. */
export function ownerBuild(owner: OwnerState): PublicBuild {
  const equipment = NONE();
  for (const slot of Object.keys(equipment) as EquipmentSlot[]) {
    const id = owner.currentBuild.equipment[slot];
    const item = id === null ? undefined : owner.inventory.find(candidate => candidate.id === id);
    equipment[slot] = item ? { catalogId: item.catalogId, catalogVersion: item.catalogVersion, tier: item.tier, rarity: item.rarity, stats: structuredClone(item.stats) } : null;
  }
  return { stance: owner.currentBuild.stance, allocations: { ...owner.currentBuild.allocations }, equipment };
}

/**
 * Each profile with its card data. `standings` gives each gladiator's record (its row in any league; none is 0–0); `owner` is the
 * preview's own gladiator, whose build is its current one.
 */
export function profileCards(profiles: Readonly<Record<string, PublicProfile>>, standings: readonly StandingRow[], owner: OwnerState, nowMs: number): Record<string, ProfileRead> {
  const records = new Map<string, ArenaRecord>(standings.map(row => [row.gladiatorId, { wins: row.humanWins, losses: row.humanLosses }]));
  return Object.fromEntries(Object.entries(profiles).map(([id, profile]) => {
    const { actor } = profile;
    const points = 10 + 2 * (actor.level - 1);
    const build: PublicBuild = id === owner.gladiatorId ? ownerBuild(owner) : {
      stance: 'balanced', allocations: suggestedSplit({ strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 }, points, actor.classId),
      equipment: silhouetteGear(actor.equipmentSilhouettes),
    };
    return [id, { ...profile, build, joinedAtMs: nowMs - actor.level * DAY_MS, arenaRecord: records.get(id) ?? { wins: 0, losses: 0 } }];
  }));
}
