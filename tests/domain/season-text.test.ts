import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrestigeAward, SeasonView } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import { StandingsView, type StandingsModel } from '@/features/arena/StandingsPanel';
import {
  badgeText, placeText, qualifyText, seasonEnds, seasonLabel, seasonName, seasonPrizeNote, seasonPrizeTable, titleText,
} from '@/features/seasons/season-text';
import { pinDeviceClock } from '../fixtures/clock';

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
    expect(seasonEnds(Date.UTC(2026, 10, 15, 17), Date.UTC(2026, 9, 18, 19), '24', 'Asia/Jerusalem')).toEqual({ countdown: '27 days 22 h', local: 'Sun 15 Nov, 19:00', utc: '17:00 UTC' });
    // Summer time in Jerusalem (UTC+3) before 25 Oct 2026.
    expect(seasonEnds(Date.UTC(2026, 9, 18, 17), Date.UTC(2026, 9, 1), '24', 'Asia/Jerusalem')).toMatchObject({ local: 'Sun 18 Oct, 20:00', utc: '17:00 UTC' });
    expect(seasonEnds(Date.UTC(2026, 10, 15, 17), Date.UTC(2026, 9, 18, 19), '24', 'UTC')).toMatchObject({ local: 'Sun 15 Nov, 17:00', utc: '17:00 UTC' });
    // When the local date is not the UTC date, the UTC time names its own day.
    expect(seasonEnds(Date.UTC(2026, 9, 24, 0), 0, '24', 'America/New_York')).toMatchObject({ local: 'Fri 23 Oct, 20:00', utc: 'Sat 24 Oct, 00:00 UTC' });
    expect(seasonEnds(Date.UTC(2026, 9, 24, 0), 0, '24', 'Asia/Jerusalem')).toMatchObject({ local: 'Sat 24 Oct, 03:00', utc: '00:00 UTC' });
  });

  // Patch A, item 7: only the time parts follow the clock setting; the days, the zone and the UTC wording are today's.
  it('writes the end time in 12-hour form when the clock setting asks for it', () => {
    const end = Date.UTC(2026, 10, 15, 17);
    expect(seasonEnds(end, Date.UTC(2026, 9, 18, 19), '12', 'Asia/Jerusalem')).toEqual({ countdown: '27 days 22 h', local: 'Sun 15 Nov, 7:00\xA0PM', utc: '5:00\xA0PM UTC' });
    expect(seasonEnds(end, 0, '12', 'UTC').utc).toBe('5:00\xA0PM UTC');
    expect(seasonEnds(end, 0, '12', 'UTC').local).toBe('Sun 15 Nov, 5:00\xA0PM');
    // The UTC time still names its own day when it differs from the local one.
    expect(seasonEnds(Date.UTC(2026, 9, 24, 0), 0, '12', 'America/New_York')).toMatchObject({ local: 'Fri 23 Oct, 8:00\xA0PM', utc: 'Sat 24 Oct, 12:00\xA0AM UTC' });
    expect(seasonEnds(Date.UTC(2026, 9, 24, 0), 0, '12', 'Asia/Jerusalem')).toMatchObject({ local: 'Sat 24 Oct, 3:00\xA0AM', utc: '12:00\xA0AM UTC' });
    // The countdown is a duration: the same in either mode.
    expect(seasonEnds(end, end - 28 * DAY, '12', 'UTC').countdown).toBe(seasonEnds(end, end - 28 * DAY, '24', 'UTC').countdown);
  });

  it('counts down in days and hours, then hours and minutes, then minutes, and never below zero', () => {
    const end = Date.UTC(2026, 10, 15, 17);
    const left = (ms: number) => seasonEnds(end, end - ms, '24', 'UTC').countdown;
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
    expect(qualifyText(0, 'bronze')).toBe('5 more human bouts in the Bronze league to qualify there. NPC bouts do not count.');
    expect(qualifyText(3, 'bronze')).toBe('2 more human bouts in the Bronze league to qualify there. NPC bouts do not count.');
    expect(qualifyText(4, 'bronze')).toBe('1 more human bout in the Bronze league to qualify there. NPC bouts do not count.');
    expect(qualifyText(5, 'silver')).toBe('Qualified: at least 5 human bouts in the Silver league, so a top-three place among its eligible gladiators wins a season reward.');
    expect(qualifyText(9, 'gold')).toBe(qualifyText(5, 'gold'));
  });
});

// Patch 1.6 (spec "Season card (a v2 season)"): a season opened under v2 pays its gold by league, and its card shows every league's prizes in a
// table; a v1 season (season 1) keeps today's list. The numbers come from the season's own rules version, never from the active one.
describe('season prizes by league (Patch 1.6)', () => {
  const NOTE = 'Gold for each place. Every league also pays 100, 60 and 40 renown, the Champion title for 1st, and gold, silver and bronze badges.';
  const RULE = 'Top 3 in each league among gladiators with at least 5 human bouts. Paid once, in your highest league where you qualify.';

  it('lists every league’s gold for 1st, 2nd and 3rd for a v2 season, and nothing by league otherwise', () => {
    expect(seasonPrizeTable('v2')).toEqual({ byLeague: true, rows: [
      { league: 'bronze', gold: [200, 120, 80] }, { league: 'silver', gold: [300, 180, 120] },
      { league: 'gold', gold: [400, 240, 160] }, { league: 'champion', gold: [500, 300, 200] }] });
    for (const version of ['v1', undefined, 'v3', '', 'V2']) expect(seasonPrizeTable(version), String(version)).toEqual({ byLeague: false });
    expect(seasonPrizeNote('v2')).toBe(NOTE);
    expect(seasonPrizeNote('v1')).toBeNull();
    expect(seasonPrizeNote(undefined)).toBeNull();
  });

  const NOW = Date.UTC(2026, 9, 10, 12);
  const season = (rulesVersion?: string): SeasonView => ({ seasonId: '1', startsAtMs: NOW - 14 * DAY, endsAtMs: NOW + 14 * DAY, closedAtMs: null,
    ...(rulesVersion === undefined ? {} : { rulesVersion }) });
  const model = (s: SeasonView, own: StandingsModel['own']): StandingsModel => ({ league: 'bronze', rows: [], nextCursor: null, seasonId: s.seasonId,
    archived: false, status: 'ready', ownerId: own ? 'owner' : null, own, seasons: [s], nowMs: NOW });
  const OWN: StandingsModel['own'] = { name: 'Lucilla', league: 'silver', rating: 1040, renown: 30, combatStrength: null, season: { status: 'ready', row: null } };
  const card = (s: SeasonView, own: StandingsModel['own']) => {
    pinDeviceClock('24');
    const html = renderToStaticMarkup(createElement(StandingsView, { model: model(s, own), onLeague: () => {}, onMore: () => {}, onRetry: () => {}, timeZone: 'UTC' }));
    // The current season's card: the section around its heading.
    const heading = html.indexOf('Season 2 ends in');
    return html.slice(html.lastIndexOf('<section', heading), html.indexOf('</section>', heading) + '</section>'.length);
  };
  const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  it('shows a v2 season’s table, the owner’s league marked and highlighted, then the renown line and the rule', () => {
    const html = card(season('v2'), OWN);
    expect(html).toMatch(/<table[^>]*>\s*<caption[^>]*>Season prizes in gold<\/caption>/);
    expect([...html.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map(m => m[1])).toEqual(['League', '1st', '2nd', '3rd']);
    const rows = [...html.matchAll(/<tr([^>]*)><th scope="row"[^>]*>([^<]*)<\/th><td[^>]*>(\d+)<\/td><td[^>]*>(\d+)<\/td><td[^>]*>(\d+)<\/td><\/tr>/g)]
      .map(m => [m[2], m[3], m[4], m[5], /class="[^"]+"/.test(m[1])]);
    expect(rows).toEqual([['Bronze', '200', '120', '80', false], ['Silver · yours', '300', '180', '120', true], ['Gold', '400', '240', '160', false],
      ['Champion', '500', '300', '200', false]]);
    expect(html).toMatch(/<tr[^>]*aria-current="true"[^>]*><th scope="row"[^>]*>Silver · yours<\/th>/);
    const text = words(html);
    expect(text).toContain(`${NOTE} ${RULE}`);
    // The table replaces the v1 list: no list of three prizes.
    expect(html).not.toContain('aria-label="Season prizes"');
    expect(text).not.toContain('500 gold · 100 renown');
  });

  it('marks no league for a visitor', () => {
    const html = card(season('v2'), null);
    expect(html).toContain('Season prizes in gold');
    expect(html).not.toContain('yours');
    expect(html).not.toContain('aria-current');
  });

  it('keeps today’s list and no table for a v1 season, or one whose version is not known', () => {
    for (const version of ['v1', undefined, 'v3']) {
      const html = card(season(version), OWN);
      expect(html, String(version)).not.toContain('<table');
      expect(html).not.toContain('Season prizes in gold');
      expect(words(html)).toContain('500 gold · 100 renown · Champion title · gold badge');
      expect(words(html)).toContain('300 gold · 60 renown · silver badge');
      expect(words(html)).toContain('200 gold · 40 renown · bronze badge');
      expect(words(html)).not.toContain(NOTE);
      expect(words(html)).toContain(RULE);
    }
  });
});
