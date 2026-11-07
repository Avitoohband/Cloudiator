import { describe, expect, it } from 'vitest';
import { titleById } from '@domain/titles';
import type { PrestigeAward } from '@contracts/reads';
import { NO_TITLE, placeInSeasonText, progressShare, progressText, titleName, wornTitleText } from '../../src/features/titles/title-text';

const p = { 'expeditions-won': 34, 'arena-best-streak': 3, 'tiers-of-one': 2, 'rarities-of-one': 2, 'gold-earned': 1240, 'days-in-camp': 21, 'outpost-won': 0 };

describe('title words', () => {
  it("words a locked title's progress", () => {
    expect(progressText(titleById('pathfinder')!, p, 6)).toBe('34 of 50');
    expect(progressText(titleById('patrician')!, p, 6)).toBe('1,240 of 4,000');
    expect(progressText(titleById('invictus')!, p, 6)).toBe('Best run 3 of 5');
    expect(progressText(titleById('tempered')!, p, 6)).toBe('Best item: 2 of 3 tiers');
    expect(progressText(titleById('connoisseur')!, p, 6)).toBe('Best item: 2 of 3 rarities');
    expect(progressText(titleById('old-guard')!, p, 6)).toBe('21 of 100 days');
    expect(progressText(titleById('raiders-bane')!, p, 4)).toBe('Opens at level 5');
    expect(progressText(titleById('raiders-bane')!, p, 5)).toBe('0 of 25');
    expect(progressText(titleById('troll-slayer')!, {}, 9)).toBe('Opens at level 10');
    expect(progressText(titleById('bannerman')!, {}, 1)).toBe('Renown shop · 50 renown');
    expect(progressText(titleById('founder')!, {}, 1)).toBe('Only gladiators made in Season 1');
    expect(progressText(titleById('victor')!, {}, 1)).toBe('0 of 1');
  });
  it('fills the bar up to full', () => {
    expect(progressShare(titleById('pathfinder')!, { 'expeditions-won': 80 })).toBe(1);
    expect(progressShare(titleById('pathfinder')!, { 'expeditions-won': 25 })).toBe(0.5);
    expect(progressShare(titleById('pathfinder')!, {})).toBe(0);
  });
  it('words a season place and a title name', () => {
    expect(placeInSeasonText({ seasonIndex: 0, league: 'bronze', place: 3 })).toBe('3rd in Season 1 · Bronze');
    expect(placeInSeasonText({ seasonIndex: 1, league: 'champion', place: 1 })).toBe('1st in Season 2 · Champion');
    expect([titleName('lion'), titleName('den-breaker'), titleName('outfitter'), titleName(undefined)]).toEqual(['Lion of the Arena', 'Den Breaker', null, null]);
    expect(NO_TITLE).toBe('No title');
  });
  it('words the worn title: Champion names its latest first place, anything unknown is null', () => {
    const award = (seasonId: string, league: PrestigeAward['league'], badge: PrestigeAward['badge']): PrestigeAward => ({ seasonId, league, place: 1, badge, title: 'champion' });
    const second: PrestigeAward = { seasonId: '2', league: 'gold', place: 2, badge: 'silver', title: null };
    expect(wornTitleText('champion', [award('0', 'silver', 'gold'), award('1', 'gold', 'gold')])).toBe('Champion · Season 2 Gold');
    // Newest first whatever the order given, and a second place does not count.
    expect(wornTitleText('champion', [award('1', 'gold', 'gold'), award('0', 'silver', 'gold'), second])).toBe('Champion · Season 2 Gold');
    expect(wornTitleText('champion', [])).toBe('Champion');
    expect(wornTitleText('pathfinder', [])).toBe('Pathfinder');
    // Another title never takes the prestige's words.
    expect(wornTitleText('pathfinder', [award('0', 'silver', 'gold')])).toBe('Pathfinder');
    expect([wornTitleText('x', []), wornTitleText('outfitter', []), wornTitleText(42, []), wornTitleText(null, []), wornTitleText(undefined, [])]).toEqual([null, null, null, null, null]);
  });
});
