import { describe, expect, it } from 'vitest';
import type { EarnedTitle, GameNotification } from '@contracts/reads';
import {
  HISTORY_INTRO, historyChips, notificationEntries, notificationsSummary, resultTitleRows, titleNotices, type NotificationEntry, type TitleNotice,
} from '@/features/titles/title-notices';

// Patch 1.7 Task 11 (spec "Earning, wearing and notices" and "Notices (Notifications tab)"; the approved mockup, section 5): the titles the
// owner read carries, as the Notifications tab shows them. A title earned by a result joins that result's card; the others are grouped by
// source and time into notices of their own ("Titles from your history" for the release back-fill), Founder at creation has none. The
// list merges the notices with the results by time, and its summary line counts both.
const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b';
const title = (id: string, earnedAtMs: number, source: EarnedTitle['source'], activityId: string | null = null,
  detail: EarnedTitle['detail'] = null): EarnedTitle => ({ id, earnedAtMs, activityId, source, detail });
const silverFirst = { seasonIndex: 0, league: 'silver' as const, place: 1 as const };

describe('titleNotices', () => {
  it('groups the titles without an activity by source and time, newest first', () => {
    const titles = [
      title('tiro', 1_000, 'history'), title('founder', 1_000, 'history'),
      title('champion', 2_000, 'season', null, silverFirst), title('medalist', 2_000, 'season', null, silverFirst),
      title('moneyed', 3_000, 'sale'),
    ];
    expect(titleNotices(titles)).toEqual<TitleNotice[]>([
      { key: 'sale:3000', kind: 'earned', atMs: 3_000, heading: 'New title: Moneyed', rows: [{ id: 'moneyed', name: 'Moneyed', detail: '1,000 gold earned' }] },
      { key: 'season:2000', kind: 'earned', atMs: 2_000, heading: 'New titles', rows: [
        { id: 'medalist', name: 'Medalist', detail: '1st in Season 1 · Silver' },
        { id: 'champion', name: 'Champion', detail: '1st in Season 1 · Silver' },
      ] },
      { key: 'history:1000', kind: 'history', atMs: 1_000, heading: 'Titles from your history', rows: [
        { id: 'founder', name: 'Founder', detail: 'Made in Season 1' },
        { id: 'tiro', name: 'Tiro', detail: '10 Trainings' },
      ] },
    ]);
  });

  it('gives Founder at creation no notice, and leaves the titles earned by a result to that result', () => {
    expect(titleNotices([title('founder', 1_000, 'joined')])).toEqual([]);
    expect(titleNotices([title('wanderer', 1_000, 'result', A), title('rare-find', 1_000, 'result', A)])).toEqual([]);
  });

  it('keeps one notice per source at one time, and the rule as the line of a title that is not a season place', () => {
    const notices = titleNotices([title('bannerman', 5_000, 'shop'), title('rare-find', 5_000, 'market'), title('old-guard', 4_000, 'history')]);
    expect(notices.map(n => [n.key, n.heading, n.rows.map(r => r.detail)])).toEqual([
      ['market:5000', 'New title: Rare Find', ['A first Rare item']],
      ['shop:5000', 'New title: Bannerman', ['Own the Arena banner']],
      ['history:4000', 'Titles from your history', ['100 days in camp']],
    ]);
    // A season title without its place says its rule.
    expect(titleNotices([title('medalist', 1, 'season')])[0].rows[0].detail).toBe('A season top-three place');
  });

  // Patch 1.7.1: a title the Game Master gave (source `award`) is an own-title notice: "New title: {name}", then its rule line.
  it('words a given title as an own-title notice with its rule', () => {
    expect(titleNotices([title('game-master', 7_000, 'award'), title('high-ground', 8_000, 'award')])).toEqual<TitleNotice[]>([
      { key: 'award:8000', kind: 'earned', atMs: 8_000, heading: 'New title: High Ground', rows: [{ id: 'high-ground', name: 'High Ground', detail: 'Given by the Game Master' }] },
      { key: 'award:7000', kind: 'earned', atMs: 7_000, heading: 'New title: Game Master', rows: [{ id: 'game-master', name: 'Game Master', detail: "The game's Game Master" }] },
    ]);
  });

  it('shows no title this client does not know, and never throws (Review Focus 1)', () => {
    const unknown = [title('legend-bearer', 1_000, 'history'), title('', 2_000, 'sale'), { ...title('tiro', 3_000, 'history'), id: 42 as unknown as string }];
    expect(() => titleNotices(unknown)).not.toThrow();
    expect(titleNotices(unknown)).toEqual([]);
    expect(titleNotices([title('legend-bearer', 1_000, 'history'), title('tiro', 1_000, 'history')])[0].rows.map(r => r.id)).toEqual(['tiro']);
    expect(titleNotices([])).toEqual([]);
  });
});

describe('resultTitleRows', () => {
  it('lists the titles a result earned, in catalog order, with their rules', () => {
    const titles = [title('rare-find', 1_000, 'result', A), title('tiro', 1_000, 'result', B), title('wanderer', 1_000, 'result', A), title('founder', 1_000, 'history')];
    expect(resultTitleRows(titles, A)).toEqual([
      { id: 'wanderer', name: 'Wanderer', detail: '10 expeditions won' },
      { id: 'rare-find', name: 'Rare Find', detail: 'A first Rare item' },
    ]);
    expect(resultTitleRows(titles, B)).toEqual([{ id: 'tiro', name: 'Tiro', detail: '10 Trainings' }]);
    expect(resultTitleRows(titles, '00000000-0000-4000-8000-00000000000c')).toEqual([]);
  });

  it('shows no title this client does not know (Review Focus 1)', () => {
    expect(resultTitleRows([title('outfitter', 1_000, 'result', A)], A)).toEqual([]);
  });
});

describe('the history notice', () => {
  it('says what the release did, word for word', () => {
    expect(HISTORY_INTRO).toBe('Patch 1.7 counted everything you have done since you joined.');
  });

  it('puts the worn title first among the chips and marks it, the rest in their order', () => {
    const rows = titleNotices([title('founder', 1, 'history'), title('wanderer', 1, 'history'), title('tiro', 1, 'history')])[0].rows;
    expect(historyChips(rows, 'tiro')).toEqual([{ name: 'Tiro', worn: true }, { name: 'Founder', worn: false }, { name: 'Wanderer', worn: false }]);
    expect(historyChips(rows, 'founder').map(c => c.name)).toEqual(['Founder', 'Wanderer', 'Tiro']);
    // None worn, or a title worn that history did not earn: no chip is marked.
    expect(historyChips(rows, null).some(c => c.worn)).toBe(false);
    expect(historyChips(rows, 'moneyed').map(c => c.name)).toEqual(['Founder', 'Wanderer', 'Tiro']);
  });
});

describe('the Notifications list', () => {
  const result = (n: number, settledAtMs: number) => ({ activityId: `r${n}`, settledAtMs }) as unknown as GameNotification;
  const notice = (atMs: number): TitleNotice => ({ key: `sale:${atMs}`, kind: 'earned', atMs, heading: 'New title: Moneyed', rows: [] });
  const shape = (entries: NotificationEntry<GameNotification>[]) => entries.map(e => (e.kind === 'result' ? e.result.activityId : `n${e.notice.atMs}`));

  it('merges the notices with the results by time, a notice at a result\'s time first', () => {
    const results = [result(3, 300), result(2, 200), result(1, 100)];
    expect(shape(notificationEntries(results, [notice(400), notice(200), notice(50)], 20))).toEqual(['n400', 'r3', 'n200', 'r2', 'r1', 'n50']);
    expect(shape(notificationEntries([], [notice(400), notice(200)], 20))).toEqual(['n400', 'n200']);
    expect(shape(notificationEntries(results, [], 20))).toEqual(['r3', 'r2', 'r1']);
  });

  it('leaves out a notice older than the oldest listed result while the page of results is full', () => {
    const results = [result(3, 300), result(2, 200), result(1, 100)];
    expect(shape(notificationEntries(results, [notice(400), notice(100), notice(50)], 3))).toEqual(['n400', 'r3', 'r2', 'n100', 'r1']);
    expect(shape(notificationEntries(results, [notice(50)], 4))).toEqual(['r3', 'r2', 'r1', 'n50']);
  });

  it('says how many results and title notices it lists and how many are new', () => {
    expect(notificationsSummary(4, 1, 3)).toBe('Latest 4 results and 1 title notice · 3 new');
    expect(notificationsSummary(4, 0, 0)).toBe('Latest 4 results · nothing new');
    expect(notificationsSummary(1, 2, 0)).toBe('Latest 1 result and 2 title notices · nothing new');
    expect(notificationsSummary(1, 0, 1)).toBe('Latest 1 result · 1 new');
  });
});
