import { freezeDomain } from './types.ts';

// The wearable titles (spec docs/superpowers/specs/2026-10-30-titles-1-7-design.md, "The titles" and "What each
// measure counts"). The SQL (22-titles.sql, 23-awards.sql and 24-dungeons.sql) restates these
// rules and counts; this is the shared name, rule and order every client and Edge command binds to. A title is earned when its measure
// reaches its threshold; a hand-given one (measure `award`) never is.

export type TitleFamily = 'special' | 'expeditions' | 'dungeons' | 'training' | 'arena' | 'tournaments' | 'seasons' | 'gear' | 'wealth';
export type TitleMeasure = 'founder' | 'days-in-camp' | 'banner' | 'expeditions-won' | 'woodland-won' | 'outpost-won'
  | 'mountain-won' | 'wolf-den-clears' | 'raider-stronghold-clears' | 'troll-hall-clears' | 'dungeon-clears'
  | 'trainings' | 'arena-wins' | 'arena-best-streak' | 'tournament-finals' | 'tournament-wins'
  | 'season-top-three' | 'season-firsts' | 'items-owned' | 'tiers-of-one' | 'rarities-of-one' | 'rare-items' | 'gold-earned'
  // Patch 1.7.1: a hand-given title. No counter, trigger or back-fill produces it; only the owner's private.give_title grants one.
  | 'award';
export type TitleDefinition = { id: string; name: string; family: TitleFamily; rule: string; measure: TitleMeasure;
  threshold: number; tier: 1 | 2 | 3 | null };

const row = (id: string, name: string, family: TitleFamily, rule: string, measure: TitleMeasure, threshold: number,
  tier: 1 | 2 | 3 | null = null): TitleDefinition => ({ id, name, family, rule, measure, threshold, tier });

/**
 * The spec's released titles in picker order, including the two hand-given titles after Bannerman and four dungeon titles.
 * The awarding logic uses the same order.
 */
export const TITLES_V1: readonly TitleDefinition[] = freezeDomain([
  row('founder', 'Founder', 'special', 'Made in Season 1', 'founder', 1),
  row('old-guard', 'Old Guard', 'special', '100 days in camp', 'days-in-camp', 100),
  row('bannerman', 'Bannerman', 'special', 'Own the Arena banner', 'banner', 1),
  row('game-master', 'Game Master', 'special', "The game's Game Master", 'award', 1),
  row('high-ground', 'High Ground', 'special', 'Given by the Game Master', 'award', 1),
  row('wanderer', 'Wanderer', 'expeditions', '10 expeditions won', 'expeditions-won', 10, 1),
  row('pathfinder', 'Pathfinder', 'expeditions', '50 expeditions won', 'expeditions-won', 50, 2),
  row('trailblazer', 'Trailblazer', 'expeditions', '200 expeditions won', 'expeditions-won', 200, 3),
  row('wolfbane', 'Wolfbane', 'expeditions', '25 wins on Woodland Path', 'woodland-won', 25),
  row('raiders-bane', "Raider's Bane", 'expeditions', '25 wins on Ruined Outpost', 'outpost-won', 25),
  row('troll-slayer', 'Troll-Slayer', 'expeditions', '25 wins on Mountain Pass', 'mountain-won', 25),
  row('den-breaker', 'Den Breaker', 'dungeons', 'Beat Alpha of the Den (Wolf Den)', 'wolf-den-clears', 1),
  row('warlords-end', "Warlord's End", 'dungeons', 'Beat the Raider Warlord (Raider Stronghold)', 'raider-stronghold-clears', 1),
  row('kingslayer', 'Kingslayer', 'dungeons', 'Beat the Troll King (Troll Hall)', 'troll-hall-clears', 1),
  row('dungeoneer', 'Dungeoneer', 'dungeons', '25 dungeon clears', 'dungeon-clears', 25),
  row('tiro', 'Tiro', 'training', '10 Trainings', 'trainings', 10, 1),
  row('disciplined', 'Disciplined', 'training', '100 Trainings', 'trainings', 100, 2),
  row('doctore', 'Doctore', 'training', '400 Trainings', 'trainings', 400, 3),
  row('bloodied', 'Bloodied', 'arena', 'A first Arena win', 'arena-wins', 1, 1),
  row('crowd-pleaser', 'Crowd-Pleaser', 'arena', '25 Arena wins', 'arena-wins', 25, 2),
  row('lion', 'Lion of the Arena', 'arena', '100 Arena wins', 'arena-wins', 100, 3),
  row('invictus', 'Invictus', 'arena', '5 Arena wins in a row', 'arena-best-streak', 5),
  row('finalist', 'Finalist', 'tournaments', 'Reach a tournament final', 'tournament-finals', 1),
  row('victor', 'Victor', 'tournaments', 'Win a tournament', 'tournament-wins', 1),
  row('triumphator', 'Triumphator', 'tournaments', 'Win 5 tournaments', 'tournament-wins', 5),
  row('medalist', 'Medalist', 'seasons', 'A season top-three place', 'season-top-three', 1),
  row('champion', 'Champion', 'seasons', 'A season first place', 'season-firsts', 1),
  row('thrice-crowned', 'Thrice-Crowned', 'seasons', '3 season first places', 'season-firsts', 3),
  row('collector', 'Collector', 'gear', '10 distinct items ever owned', 'items-owned', 10, 1),
  row('curator', 'Curator', 'gear', '40 distinct items ever owned', 'items-owned', 40, 2),
  row('antiquarian', 'Antiquarian', 'gear', '100 distinct items ever owned', 'items-owned', 100, 3),
  row('tempered', 'Tempered', 'gear', 'Every tier (1, 5, 10) of one item', 'tiers-of-one', 3),
  row('connoisseur', 'Connoisseur', 'gear', 'Common, Uncommon and Rare of one item at one tier', 'rarities-of-one', 3),
  row('rare-find', 'Rare Find', 'gear', 'A first Rare item', 'rare-items', 1),
  row('moneyed', 'Moneyed', 'wealth', '1,000 gold earned', 'gold-earned', 1000, 1),
  row('patrician', 'Patrician', 'wealth', '4,000 gold earned', 'gold-earned', 4000, 2),
  row('croesus', 'Croesus', 'wealth', '12,000 gold earned', 'gold-earned', 12000, 3),
]) as readonly TitleDefinition[];

/** The family headings, in the picker's order. */
export const TITLE_FAMILIES: readonly { id: TitleFamily; name: string }[] = freezeDomain([
  { id: 'special', name: 'Special' }, { id: 'expeditions', name: 'Expeditions' }, { id: 'dungeons', name: 'Dungeons' }, { id: 'training', name: 'Training' },
  { id: 'arena', name: 'Arena' }, { id: 'tournaments', name: 'Tournaments' }, { id: 'seasons', name: 'Seasons' },
  { id: 'gear', name: 'Gear collection' }, { id: 'wealth', name: 'Wealth' },
]) as readonly { id: TitleFamily; name: string }[];

/** The stored counters of "What each measure counts". The other measures are derived. */
export const STORED_COUNTERS: readonly string[] = Object.freeze([
  'expeditions-won', 'woodland-won', 'outpost-won', 'mountain-won', 'trainings', 'arena-wins', 'arena-streak',
  'arena-best-streak', 'tournament-finals', 'tournament-wins', 'season-top-three', 'season-firsts', 'gold-v1', 'gold-v2',
  'items-owned', 'rare-items', 'tiers-of-one', 'rarities-of-one', 'dungeon-clears',
  'wolf-den-clears', 'raider-stronghold-clears', 'troll-hall-clears',
]);

const BY_ID: ReadonlyMap<string, TitleDefinition> = new Map(TITLES_V1.map(t => [t.id, t]));

/** The title with this id, or null for an unknown, mistyped or later-patch id. */
export function titleById(id: unknown): TitleDefinition | null {
  return typeof id === 'string' ? BY_ID.get(id) ?? null : null;
}
