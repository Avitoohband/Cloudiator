import { describe, expect, it } from 'vitest';
import { STORED_COUNTERS, TITLES_V1, TITLE_FAMILIES, titleById } from '@domain/titles';

// The spec's table "The titles", including Patch 1.8's four dungeon titles and patch 1.7.1's two hand-given titles (plan
// docs/superpowers/plans/2026-11-06-hand-given-titles-1-7-1.md, "Global constraints"): [id, name, family id, rule, measure, threshold,
// tier]. The measure `award` is produced by no counter, trigger or back-fill: only the owner's private.give_title grants them.
const SPEC_ROWS = [
  ['founder', 'Founder', 'special', 'Made in Season 1', 'founder', 1, null],
  ['old-guard', 'Old Guard', 'special', '100 days in camp', 'days-in-camp', 100, null],
  ['bannerman', 'Bannerman', 'special', 'Own the Arena banner', 'banner', 1, null],
  ['game-master', 'Game Master', 'special', "The game's Game Master", 'award', 1, null],
  ['high-ground', 'High Ground', 'special', 'Given by the Game Master', 'award', 1, null],
  ['wanderer', 'Wanderer', 'expeditions', '10 expeditions won', 'expeditions-won', 10, 1],
  ['pathfinder', 'Pathfinder', 'expeditions', '50 expeditions won', 'expeditions-won', 50, 2],
  ['trailblazer', 'Trailblazer', 'expeditions', '200 expeditions won', 'expeditions-won', 200, 3],
  ['wolfbane', 'Wolfbane', 'expeditions', '25 wins on Woodland Path', 'woodland-won', 25, null],
  ['raiders-bane', "Raider's Bane", 'expeditions', '25 wins on Ruined Outpost', 'outpost-won', 25, null],
  ['troll-slayer', 'Troll-Slayer', 'expeditions', '25 wins on Mountain Pass', 'mountain-won', 25, null],
  ['den-breaker', 'Den Breaker', 'dungeons', 'Beat Alpha of the Den (Wolf Den)', 'wolf-den-clears', 1, null],
  ['warlords-end', "Warlord's End", 'dungeons', 'Beat the Raider Warlord (Raider Stronghold)', 'raider-stronghold-clears', 1, null],
  ['kingslayer', 'Kingslayer', 'dungeons', 'Beat the Troll King (Troll Hall)', 'troll-hall-clears', 1, null],
  ['dungeoneer', 'Dungeoneer', 'dungeons', '25 dungeon clears', 'dungeon-clears', 25, null],
  ['tiro', 'Tiro', 'training', '10 Trainings', 'trainings', 10, 1],
  ['disciplined', 'Disciplined', 'training', '100 Trainings', 'trainings', 100, 2],
  ['doctore', 'Doctore', 'training', '400 Trainings', 'trainings', 400, 3],
  ['bloodied', 'Bloodied', 'arena', 'A first Arena win', 'arena-wins', 1, 1],
  ['crowd-pleaser', 'Crowd-Pleaser', 'arena', '25 Arena wins', 'arena-wins', 25, 2],
  ['lion', 'Lion of the Arena', 'arena', '100 Arena wins', 'arena-wins', 100, 3],
  ['invictus', 'Invictus', 'arena', '5 Arena wins in a row', 'arena-best-streak', 5, null],
  ['finalist', 'Finalist', 'tournaments', 'Reach a tournament final', 'tournament-finals', 1, null],
  ['victor', 'Victor', 'tournaments', 'Win a tournament', 'tournament-wins', 1, null],
  ['triumphator', 'Triumphator', 'tournaments', 'Win 5 tournaments', 'tournament-wins', 5, null],
  ['medalist', 'Medalist', 'seasons', 'A season top-three place', 'season-top-three', 1, null],
  ['champion', 'Champion', 'seasons', 'A season first place', 'season-firsts', 1, null],
  ['thrice-crowned', 'Thrice-Crowned', 'seasons', '3 season first places', 'season-firsts', 3, null],
  ['collector', 'Collector', 'gear', '10 distinct items ever owned', 'items-owned', 10, 1],
  ['curator', 'Curator', 'gear', '40 distinct items ever owned', 'items-owned', 40, 2],
  ['antiquarian', 'Antiquarian', 'gear', '100 distinct items ever owned', 'items-owned', 100, 3],
  ['tempered', 'Tempered', 'gear', 'Every tier (1, 5, 10) of one item', 'tiers-of-one', 3, null],
  ['connoisseur', 'Connoisseur', 'gear', 'Common, Uncommon and Rare of one item at one tier', 'rarities-of-one', 3, null],
  ['rare-find', 'Rare Find', 'gear', 'A first Rare item', 'rare-items', 1, null],
  ['moneyed', 'Moneyed', 'wealth', '1,000 gold earned', 'gold-earned', 1000, 1],
  ['patrician', 'Patrician', 'wealth', '4,000 gold earned', 'gold-earned', 4000, 2],
  ['croesus', 'Croesus', 'wealth', '12,000 gold earned', 'gold-earned', 12000, 3],
];

describe('the titles catalog', () => {
  it('lists the 37 titles in the picker order', () => {
    expect(TITLES_V1.map(t => t.id)).toEqual(['founder', 'old-guard', 'bannerman', 'game-master', 'high-ground', 'wanderer', 'pathfinder', 'trailblazer',
      'wolfbane', 'raiders-bane', 'troll-slayer', 'den-breaker', 'warlords-end', 'kingslayer', 'dungeoneer',
      'tiro', 'disciplined', 'doctore', 'bloodied', 'crowd-pleaser', 'lion',
      'invictus', 'finalist', 'victor', 'triumphator', 'medalist', 'champion', 'thrice-crowned', 'collector', 'curator',
      'antiquarian', 'tempered', 'connoisseur', 'rare-find', 'moneyed', 'patrician', 'croesus']);
    expect(TITLES_V1.every(t => /^[a-z][a-z-]{1,30}$/.test(t.id) && t.name.length <= 18)).toBe(true);
    expect(Math.max(...TITLES_V1.map(t => t.name.length))).toBe(17);
    expect(TITLE_FAMILIES.map(f => f.name)).toEqual(['Special', 'Expeditions', 'Dungeons', 'Training', 'Arena', 'Tournaments', 'Seasons', 'Gear collection', 'Wealth']);
    expect(Object.isFrozen(TITLES_V1[0])).toBe(true);
  });
  it('holds the spec rules, thresholds and tiers', () => {
    const row = (id: string) => { const t = titleById(id)!; return [t.name, t.rule, t.measure, t.threshold, t.tier]; };
    expect(row('raiders-bane')).toEqual(["Raider's Bane", '25 wins on Ruined Outpost', 'outpost-won', 25, null]);
    expect(row('lion')).toEqual(['Lion of the Arena', '100 Arena wins', 'arena-wins', 100, 3]);
    expect(row('connoisseur')).toEqual(['Connoisseur', 'Common, Uncommon and Rare of one item at one tier', 'rarities-of-one', 3, null]);
    expect(row('croesus')).toEqual(['Croesus', '12,000 gold earned', 'gold-earned', 12000, 3]);
    expect(row('founder')).toEqual(['Founder', 'Made in Season 1', 'founder', 1, null]);
    expect(TITLES_V1.map(t => [t.id, t.name, t.family, t.rule, t.measure, t.threshold, t.tier])).toEqual(SPEC_ROWS);
  });
  it('earns 35 by play and gives two by hand', () => {
    expect(TITLES_V1.filter(t => t.measure === 'award').map(t => [t.id, t.name, t.rule])).toEqual([
      ['game-master', 'Game Master', "The game's Game Master"], ['high-ground', 'High Ground', 'Given by the Game Master']]);
    expect(TITLES_V1.filter(t => t.measure !== 'award')).toHaveLength(35);
    // No stored counter is named after the hand-given measure, so private.title_measures never yields it.
    expect(STORED_COUNTERS).not.toContain('award');
  });
  it('names unknown ids as nothing', () => { for (const id of ['', 'outfitter', 'Founder', null, 7]) expect(titleById(id)).toBeNull(); });
  it('stores exactly the spec counters', () => expect([...STORED_COUNTERS].sort()).toEqual(['arena-best-streak', 'arena-streak',
    'arena-wins', 'dungeon-clears', 'expeditions-won', 'gold-v1', 'gold-v2', 'items-owned', 'mountain-won', 'outpost-won', 'raider-stronghold-clears', 'rare-items',
    'rarities-of-one', 'season-firsts', 'season-top-three', 'tiers-of-one', 'tournament-finals', 'tournament-wins', 'trainings',
    'troll-hall-clears', 'wolf-den-clears', 'woodland-won']));
});
