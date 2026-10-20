import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { slotTimeText } from '../../src/features/schedule/slot-time';

// Task 23.10: a slot boundary's time, short, in the viewer's locale and zone. The zone is pinned to New York (the process's
// own, restored afterwards) and the locale to en-US (the formatter is handed it only where the code names none), so no
// assertion depends on the host. July 2026 is far from any daylight-saving change; the change itself is tested below.
const RealFormat = Intl.DateTimeFormat;
const zone = process.env.TZ;
let locales: unknown[] = [];

// Set at once (not in a hook): the times below are built when the file loads.
process.env.TZ = 'America/New_York';
beforeAll(() => {
  // The pinned zone must have taken effect, or every assertion below would be about the host.
  expect(new Date(2026, 6, 14, 4, 20).getTimezoneOffset()).toBe(240);
});
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
beforeEach(() => {
  locales = [];
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (this: unknown, locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
    locales.push(locale);
    return new RealFormat(locale ?? 'en-US', options);
  } as unknown as typeof Intl.DateTimeFormat);
});
afterEach(() => { vi.restoreAllMocks(); });

/** A local time in the pinned zone: July 2026 (Tue 14th) by default, as month index, day, hour, minute, second. */
const at = (day: number, hour: number, minute: number, second = 0, month = 6) => new Date(2026, month, day, hour, minute, second).getTime();
const NOW = at(14, 4, 0);

describe('slotTimeText', () => {
  it('shows only the hour and minute for a time on the same local day', () => {
    expect(slotTimeText(at(14, 4, 20), NOW)).toBe('4:20 AM');
    expect(slotTimeText(at(14, 23, 59), NOW)).toBe('11:59 PM');
    expect(slotTimeText(at(14, 12, 0), NOW)).toBe('12:00 PM');
    // The start of the same day still counts as the same day, though it has passed.
    expect(slotTimeText(at(14, 0, 0), NOW)).toBe('12:00 AM');
  });

  it('says tomorrow for the next local day, across midnight and not by 24-hour differences', () => {
    expect(slotTimeText(at(15, 0, 1), at(14, 23, 59))).toBe('tomorrow 12:01 AM');
    expect(slotTimeText(at(15, 1, 0), at(14, 23, 0))).toBe('tomorrow 1:00 AM');
    expect(slotTimeText(at(15, 4, 20), NOW)).toBe('tomorrow 4:20 AM');
    expect(slotTimeText(at(15, 23, 59), at(14, 0, 0))).toBe('tomorrow 11:59 PM');
    // Almost 24 hours ahead is still today when the local date has not changed.
    expect(slotTimeText(at(14, 23, 30), at(14, 0, 30))).toBe('11:30 PM');
  });

  it('shows the short weekday for the 2nd to the 6th local day ahead', () => {
    expect(slotTimeText(at(16, 4, 20), NOW)).toBe('Thu 4:20 AM');
    expect(slotTimeText(at(20, 4, 20), NOW)).toBe('Mon 4:20 AM');
    // The 6th day ahead, at either end of its day; the same weekday a week on is not shown as a weekday.
    expect(slotTimeText(at(20, 0, 0), at(14, 23, 59))).toBe('Mon 12:00 AM');
    expect(slotTimeText(at(20, 23, 59), at(14, 0, 0))).toBe('Mon 11:59 PM');
  });

  it('shows the short month and day from the 7th local day ahead on', () => {
    expect(slotTimeText(at(21, 4, 20), NOW)).toBe('Jul 21, 4:20 AM');
    expect(slotTimeText(at(21, 0, 0), at(14, 23, 59))).toBe('Jul 21, 12:00 AM');
    expect(slotTimeText(at(14, 4, 20, 0, 9), NOW)).toBe('Oct 14, 4:20 AM');
  });

  it('shows the short month and day for a time on an earlier local day', () => {
    expect(slotTimeText(at(13, 4, 20), NOW)).toBe('Jul 13, 4:20 AM');
    expect(slotTimeText(at(13, 23, 59), at(14, 0, 1))).toBe('Jul 13, 11:59 PM');
    expect(slotTimeText(at(14, 4, 20, 0, 5), NOW)).toBe('Jun 14, 4:20 AM');
  });

  it('never shows seconds', () => {
    for (const [ms, now] of [[at(14, 4, 20, 59), NOW], [at(15, 4, 20, 30), NOW], [at(17, 4, 20, 1), NOW], [at(25, 4, 20, 45), NOW], [at(10, 4, 20, 15), NOW]]) {
      expect(slotTimeText(ms, now)).not.toMatch(/\d:\d\d:\d\d/);
    }
    expect(slotTimeText(at(14, 4, 20, 59), NOW)).toBe('4:20 AM');
    expect(slotTimeText(at(15, 4, 20, 30), NOW)).toBe('tomorrow 4:20 AM');
  });

  it('counts local calendar days through a daylight-saving change', () => {
    // 1 November 2026 is 25 hours long in New York (the clocks go back at 2:00).
    const midnightHalf = at(1, 0, 30, 0, 10);
    expect(slotTimeText(at(1, 23, 30, 0, 10), midnightHalf)).toBe('11:30 PM');
    expect(slotTimeText(at(2, 0, 30, 0, 10), midnightHalf)).toBe('tomorrow 12:30 AM');
    // Seven calendar days on across the spring change (8 March 2026 is 23 hours long) is only 6 days 23 hours later: still the
    // 7th day, and the 6th day is a weekday.
    expect(slotTimeText(at(14, 4, 20, 0, 2), at(7, 4, 20, 0, 2))).toBe('Mar 14, 4:20 AM');
    expect(slotTimeText(at(13, 4, 20, 0, 2), at(7, 4, 20, 0, 2))).toBe('Fri 4:20 AM');
  });

  it('formats in the viewer\'s own locale: the locale is never named', () => {
    slotTimeText(at(14, 4, 20), NOW);
    slotTimeText(at(15, 4, 20), NOW);
    slotTimeText(at(17, 4, 20), NOW);
    slotTimeText(at(25, 4, 20), NOW);
    expect(locales.length).toBeGreaterThanOrEqual(4);
    expect(locales.every(locale => locale === undefined)).toBe(true);
  });
});
