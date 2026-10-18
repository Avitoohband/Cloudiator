import { describe, expect, it } from 'vitest';
import type { PrestigeAward } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import { badgeText, placeText, qualifyText, seasonEnds, seasonLabel, seasonName, titleText } from '@/features/seasons/season-text';

// Task 21.4: the words of the seasons UI (Arena standings and profile cards), from the reads only.
const HOUR = 3_600_000, DAY = 24 * HOUR, MIN = 60_000;
const award = (overrides: Partial<PrestigeAward> = {}): PrestigeAward => ({ seasonId: '0', league: 'silver', place: 1, badge: 'gold', title: 'champion', ...overrides });

describe('season text', () => {
  it('names a season by its index plus one', () => {
    expect(seasonName('0')).toBe('Season 1');
    expect(seasonName('1')).toBe('Season 2');
    expect(seasonName('41')).toBe('Season 42');
    // No season yet (a world before its first season): no number is invented.
    expect(seasonName('')).toBe('Season');
  });

  it('gives the season end as a countdown, the viewer’s local time and the UTC time', () => {
    // The plan's example: 15 Nov 2026 is a Sunday (the brief's "Sat" was the mockup's sample weekday).
    expect(seasonEnds(Date.UTC(2026, 10, 15, 17), Date.UTC(2026, 9, 18, 19), 'Asia/Jerusalem')).toEqual({ countdown: '27 days 22 h', local: 'Sun 15 Nov, 19:00', utc: '17:00 UTC' });
    // Summer time in Jerusalem (UTC+3) before 25 Oct 2026.
    expect(seasonEnds(Date.UTC(2026, 9, 18, 17), Date.UTC(2026, 9, 1), 'Asia/Jerusalem')).toMatchObject({ local: 'Sun 18 Oct, 20:00', utc: '17:00 UTC' });
    expect(seasonEnds(Date.UTC(2026, 10, 15, 17), Date.UTC(2026, 9, 18, 19), 'UTC')).toMatchObject({ local: 'Sun 15 Nov, 17:00', utc: '17:00 UTC' });
    // When the local date is not the UTC date, the UTC time names its own day.
    expect(seasonEnds(Date.UTC(2026, 9, 24, 0), 0, 'America/New_York')).toMatchObject({ local: 'Fri 23 Oct, 20:00', utc: 'Sat 24 Oct, 00:00 UTC' });
    expect(seasonEnds(Date.UTC(2026, 9, 24, 0), 0, 'Asia/Jerusalem')).toMatchObject({ local: 'Sat 24 Oct, 03:00', utc: '00:00 UTC' });
  });

  it('counts down in days and hours, then hours and minutes, then minutes, and never below zero', () => {
    const end = Date.UTC(2026, 10, 15, 17);
    const left = (ms: number) => seasonEnds(end, end - ms, 'UTC').countdown;
    expect(left(28 * DAY)).toBe('28 days 0 h');
    expect(left(DAY + 3 * HOUR + 59 * MIN)).toBe('1 day 3 h');
    expect(left(DAY)).toBe('1 day 0 h');
    expect(left(DAY - 1)).toBe('23 h 59 min');
    expect(left(HOUR)).toBe('1 h 0 min');
    expect(left(HOUR - 1)).toBe('59 min');
    expect(left(90_000)).toBe('1 min');
    // Under a minute it still says a minute is left; at or after the end, nothing is left.
    expect(left(1)).toBe('1 min');
    expect(left(0)).toBe('0 min');
    expect(left(-5 * MIN)).toBe('0 min');
  });

  it('labels the picker’s seasons: the current one, and each finished one by its local end date', () => {
    const current = { seasonId: '1', startsAtMs: Date.UTC(2026, 9, 18, 17), endsAtMs: Date.UTC(2026, 10, 15, 17), closedAtMs: null };
    const ended = { seasonId: '0', startsAtMs: Date.UTC(2026, 8, 20, 17), endsAtMs: Date.UTC(2026, 9, 18, 17), closedAtMs: Date.UTC(2026, 9, 18, 17) + 3_000 };
    expect(seasonLabel(current, 'Asia/Jerusalem')).toBe('Season 2 · current');
    expect(seasonLabel(ended, 'Asia/Jerusalem')).toBe('Season 1 · ended Sun 18 Oct');
    expect(seasonLabel({ ...ended, endsAtMs: Date.UTC(2026, 9, 18, 2) }, 'America/Los_Angeles')).toBe('Season 1 · ended Sat 17 Oct');
  });

  it('writes a badge chip and the champion title of a season award', () => {
    expect(badgeText({ seasonId: '0', league: 'silver', place: 1, badge: 'gold', title: 'champion' })).toBe('🥇 Season 1 · Silver');
    expect(badgeText(award({ seasonId: '3', league: 'bronze', place: 2, badge: 'silver', title: null }))).toBe('🥈 Season 4 · Bronze');
    expect(badgeText(award({ league: 'champion', place: 3, badge: 'bronze', title: null }))).toBe('🥉 Season 1 · Champion');
    expect(titleText(award())).toBe('Champion · Season 1 Silver');
    expect(titleText(award({ seasonId: '9', league: 'gold' }))).toBe('Champion · Season 10 Gold');
    expect(titleText(award({ place: 2, badge: 'silver', title: null }))).toBeNull();
  });

  it('marks an archived place with its medal, and the champion title on first place', () => {
    expect(placeText(1)).toBe('🥇 1st · Champion');
    expect(placeText(2)).toBe('🥈 2nd');
    expect(placeText(3)).toBe('🥉 3rd');
    // The medals and the title are RULES_V1's placements.
    expect(RULES_V1.seasons.placements.map(p => [p.badge, p.title])).toEqual([['gold', 'champion'], ['silver', null], ['bronze', null]]);
  });

  it('says how many more human bouts qualify for season rewards, and when the owner qualifies', () => {
    expect(qualifyText(0, 'bronze')).toBe('5 more human bouts to qualify for season rewards. NPC bouts do not count.');
    expect(qualifyText(3, 'bronze')).toBe('2 more human bouts to qualify for season rewards. NPC bouts do not count.');
    expect(qualifyText(4, 'bronze')).toBe('1 more human bout to qualify for season rewards. NPC bouts do not count.');
    expect(qualifyText(5, 'silver')).toBe('Qualified: at least 5 human bouts in the Silver league, so a top-three place among its eligible gladiators wins a season reward.');
    expect(qualifyText(9, 'gold')).toBe(qualifyText(5, 'gold'));
  });
});
