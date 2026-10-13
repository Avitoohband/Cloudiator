import { freezeDomain, type CatalogItem, type Expedition, type EquipmentSlot, type SalvageEntry } from './types.ts';
import { RULES_V1 } from './rules-v1.ts';

const templates: { id: string; name: string; slot: EquipmentSlot; hands: 0 | 1 | 2;
  damage: number; armor: number; weight: number; intervalMs: number; money: number; renown: number }[] = [
  { id: 'sword', name: 'Sword', slot: 'weapon', hands: 1, damage: 6, armor: 0, weight: 4, intervalMs: 1000, money: 40, renown: 50 },
  { id: 'axe', name: 'Axe', slot: 'weapon', hands: 1, damage: 8, armor: 0, weight: 6, intervalMs: 1400, money: 40, renown: 50 },
  { id: 'spear', name: 'Spear', slot: 'weapon', hands: 2, damage: 7, armor: 0, weight: 6, intervalMs: 1200, money: 40, renown: 50 },
  { id: 'bow', name: 'Bow', slot: 'weapon', hands: 2, damage: 6, armor: 0, weight: 3, intervalMs: 1100, money: 40, renown: 50 },
  { id: 'round-shield', name: 'Round shield', slot: 'offHand', hands: 0, damage: 0, armor: 3, weight: 5, intervalMs: 0, money: 30, renown: 40 },
  { id: 'leather-hood', name: 'Leather hood', slot: 'head', hands: 0, damage: 0, armor: 1, weight: 1, intervalMs: 0, money: 20, renown: 30 },
  { id: 'iron-helmet', name: 'Iron helmet', slot: 'head', hands: 0, damage: 0, armor: 3, weight: 4, intervalMs: 0, money: 40, renown: 30 },
  { id: 'light-armor', name: 'Light armor', slot: 'body', hands: 0, damage: 0, armor: 2, weight: 3, intervalMs: 0, money: 40, renown: 50 },
  { id: 'heavy-armor', name: 'Heavy armor', slot: 'body', hands: 0, damage: 0, armor: 6, weight: 10, intervalMs: 0, money: 80, renown: 50 },
  { id: 'light-boots', name: 'Light boots', slot: 'feet', hands: 0, damage: 0, armor: 1, weight: 1, intervalMs: 0, money: 20, renown: 30 },
  { id: 'heavy-boots', name: 'Heavy boots', slot: 'feet', hands: 0, damage: 0, armor: 2, weight: 4, intervalMs: 0, money: 40, renown: 30 },
];
const items: Record<string, CatalogItem> = Object.create(null);
for (const template of templates) {
  for (const tier of [1, 5, 10] as const) {
    for (const kind of ['common', 'uncommon', 'rare', 'renown'] as const) {
      const renown = kind === 'renown';
      const rarity = renown ? 'common' : kind;
      const multiplier = RULES_V1.tiers[tier].stats * RULES_V1.rarities[rarity].stats;
      const commonPrice = template.money * RULES_V1.tiers[tier].moneyPrice;
      const id = `${template.id}:${tier}:${kind}`;
      items[id] = { id, templateId: template.id, name: template.name, slot: template.slot, hands: template.hands, tier, rarity,
        stats: { damage: Math.round(template.damage * multiplier * 100) / 100, armor: Math.round(template.armor * multiplier * 100) / 100,
          weight: template.weight, intervalMs: template.intervalMs, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } },
        binding: renown ? 'bound' : 'tradable',
        moneyPrice: !renown && rarity === 'common' ? commonPrice : null,
        renownPrice: renown ? template.renown * RULES_V1.tiers[tier].renownPrice : null,
        npcSellValue: renown ? null : Math.max(RULES_V1.shops.minimumSellValue, Math.floor(commonPrice * RULES_V1.shops.npcSellRate * RULES_V1.rarities[rarity].stats)),
      };
    }
  }
}
const expeditions: Record<'woodland' | 'outpost' | 'mountain', Expedition> = {
  woodland: { id: 'woodland', name: 'Woodland Path', requiredLevel: 1, encounters: 3,
    rewards: { xp: 100, money: 20, salvageQuantity: 1, gearChance: 0.2, gearTier: 1 },
    enemy: { name: 'Wild beast', maxHp: 35, damage: 6, intervalMs: 1100, armor: 0, stance: 'balanced',
      attributes: { strength: 4, agility: 4, vitality: 3, endurance: 4, precision: 4 } } },
  outpost: { id: 'outpost', name: 'Ruined Outpost', requiredLevel: 5, encounters: 3,
    rewards: { xp: 250, money: 60, salvageQuantity: 2, gearChance: 0.3, gearTier: 5 },
    enemy: { name: 'Armed raider', maxHp: 80, damage: 12, intervalMs: 1100, armor: 0, stance: 'balanced',
      attributes: { strength: 12, agility: 10, vitality: 8, endurance: 10, precision: 10 } } },
  mountain: { id: 'mountain', name: 'Mountain Pass', requiredLevel: 10, encounters: 3,
    rewards: { xp: 500, money: 120, salvageQuantity: 3, gearChance: 0.4, gearTier: 10 },
    enemy: { name: 'Dangerous creature', maxHp: 140, damage: 18, intervalMs: 1000, armor: 0, stance: 'balanced',
      attributes: { strength: 20, agility: 16, vitality: 14, endurance: 16, precision: 16 } } },
};
/** The single stackable expedition material: no equipment slot, sold to NPCs per unit, stacked up to the rules limit. */
const salvage: SalvageEntry = { id: 'salvage', name: 'Salvage', tier: 1, rarity: 'common', binding: 'tradable',
  stats: { damage: 0, armor: 0, weight: 0, intervalMs: 0, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } },
  stackLimit: RULES_V1.inventory.salvageStack, npcSellValue: RULES_V1.inventory.salvageSellValue };
/** Variant IDs: template:tier:rarity, or template:tier:renown. Salvage is separate from equipment items. */
export const CATALOG_V1 = freezeDomain({ version: 'v1', items, expeditions, salvage,
  cosmetics: { banner: { id: 'banner', name: 'Arena banner', binding: 'bound' as const, renownPrice: RULES_V1.shops.bannerRenownPrice } } });
