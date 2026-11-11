import type { ItemInstance } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import atlas from '../../../public/assets/ui/icons.json';

const itemFrames: Readonly<Record<string, keyof typeof atlas.frames>> = {
  sword: 'sword',
  axe: 'axe',
  spear: 'spear',
  bow: 'bow',
  'round-shield': 'shield',
  'leather-hood': 'hood',
  'iron-helmet': 'helmet',
  'light-armor': 'armor-light',
  'heavy-armor': 'armor-heavy',
  'light-boots': 'boots-light',
  'heavy-boots': 'boots-heavy',
};

export const itemAtlas = {
  url: `/assets/ui/${atlas.meta.image}`,
  width: atlas.meta.size.w,
  height: atlas.meta.size.h,
};

export function itemIconFrame(catalogId: string) {
  const template = CATALOG_V1.items[catalogId]?.templateId;
  const name = catalogId === 'salvage' ? 'salvage' : template ? itemFrames[template] : undefined;
  return name ? { name, ...atlas.frames[name].frame } : null;
}

const attributeNames = {
  strength: 'Strength', agility: 'Agility', vitality: 'Vitality', endurance: 'Endurance', precision: 'Precision',
} as const;
const attributes = Object.keys(attributeNames) as (keyof typeof attributeNames)[];

export function itemStatLines({ catalogId, stats }: Pick<ItemInstance, 'catalogId' | 'stats'>): [string, string][] {
  const entry = CATALOG_V1.items[catalogId];
  const lines: [string, string][] = [];
  if (entry?.slot === 'weapon' || stats.damage !== 0) lines.push(['Damage', String(stats.damage)]);
  if ((entry && entry.slot !== 'weapon') || stats.armor !== 0) lines.push(['Armor', String(stats.armor)]);
  if (stats.intervalMs > 0) lines.push(['Attack interval', `${(stats.intervalMs / 1000).toFixed(3).replace(/0$/, '')} s`]);
  if (entry?.hands) lines.push(['Hands', String(entry.hands)]);
  const bonuses = attributes.filter(key => stats.attributes[key] !== 0).map(key => {
    const value = stats.attributes[key];
    return `${value > 0 ? '+' : ''}${value} ${attributeNames[key]}`;
  });
  lines.push(['Weight', String(stats.weight)], ['Attribute bonuses', bonuses.join(' · ') || 'None']);
  return lines;
}
