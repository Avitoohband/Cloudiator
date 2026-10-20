import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { slotTimeText } from '../../src/features/schedule/slot-time';
import { BuildPanel } from '../../src/features/build/BuildPanel';
import { createDisplayClock } from '../../src/game/display-clock';
import type { GameGateway } from '../../src/lib/api/gateway';
import { ownerFixture } from '../fixtures/domain';

// Task 23.10: a slot boundary's time, short, in the viewer's locale and zone. The zone is pinned to New York (the process's
// own, restored afterwards) and the locale to en-US (the formatter is handed it only where the code names none), so no
// assertion depends on the host. July 2026 is far from any daylight-saving change; the change itself is tested below.
const RealFormat = Intl.DateTimeFormat;
const zone = process.env.TZ;
const NBSP = '\xA0';
/** Whitespace a line may break at: all of it but the no-break space. */
const BREAKABLE = /[^\S\xA0]/;
let locales: unknown[] = [];
/** The locale handed to the formatter where the code names none. */
let pinned = 'en-US';

// Set at once (not in a hook): the times below are built when the file loads.
process.env.TZ = 'America/New_York';
beforeAll(() => {
  // The pinned zone must have taken effect, or every assertion below would be about the host.
  expect(new Date(2026, 6, 14, 4, 20).getTimezoneOffset()).toBe(240);
});
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
beforeEach(() => {
  locales = [];
  pinned = 'en-US';
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (this: unknown, locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
    locales.push(locale);
    return new RealFormat(locale ?? pinned, options);
  } as unknown as typeof Intl.DateTimeFormat);
});
afterEach(() => { vi.restoreAllMocks(); });

/** A local time in the pinned zone: July 2026 (Tue 14th) by default, as month index, day, hour, minute, second. */
const at = (day: number, hour: number, minute: number, second = 0, month = 6) => new Date(2026, month, day, hour, minute, second).getTime();
const NOW = at(14, 4, 0);
/** The text with its no-break spaces read as ordinary ones, for the cases about the wording (the cases about those spaces follow). */
const plain = (ms: number, now: number) => slotTimeText(ms, now).replaceAll(NBSP, ' ');

describe('slotTimeText', () => {
  it('shows only the hour and minute for a time on the same local day', () => {
    expect(plain(at(14, 4, 20), NOW)).toBe('4:20 AM');
    expect(plain(at(14, 23, 59), NOW)).toBe('11:59 PM');
    expect(plain(at(14, 12, 0), NOW)).toBe('12:00 PM');
    // The start of the same day still counts as the same day, though it has passed.
    expect(plain(at(14, 0, 0), NOW)).toBe('12:00 AM');
  });

  it('says tomorrow for the next local day, across midnight and not by 24-hour differences', () => {
    expect(plain(at(15, 0, 1), at(14, 23, 59))).toBe('tomorrow 12:01 AM');
    expect(plain(at(15, 1, 0), at(14, 23, 0))).toBe('tomorrow 1:00 AM');
    expect(plain(at(15, 4, 20), NOW)).toBe('tomorrow 4:20 AM');
    expect(plain(at(15, 23, 59), at(14, 0, 0))).toBe('tomorrow 11:59 PM');
    // Almost 24 hours ahead is still today when the local date has not changed.
    expect(plain(at(14, 23, 30), at(14, 0, 30))).toBe('11:30 PM');
  });

  it('shows the short weekday for the 2nd to the 6th local day ahead', () => {
    expect(plain(at(16, 4, 20), NOW)).toBe('Thu 4:20 AM');
    expect(plain(at(20, 4, 20), NOW)).toBe('Mon 4:20 AM');
    // The 6th day ahead, at either end of its day; the same weekday a week on is not shown as a weekday.
    expect(plain(at(20, 0, 0), at(14, 23, 59))).toBe('Mon 12:00 AM');
    expect(plain(at(20, 23, 59), at(14, 0, 0))).toBe('Mon 11:59 PM');
  });

  it('shows the short month and day from the 7th local day ahead on', () => {
    expect(plain(at(21, 4, 20), NOW)).toBe('Jul 21, 4:20 AM');
    expect(plain(at(21, 0, 0), at(14, 23, 59))).toBe('Jul 21, 12:00 AM');
    expect(plain(at(14, 4, 20, 0, 9), NOW)).toBe('Oct 14, 4:20 AM');
  });

  it('shows the short month and day for a time on an earlier local day', () => {
    expect(plain(at(13, 4, 20), NOW)).toBe('Jul 13, 4:20 AM');
    expect(plain(at(13, 23, 59), at(14, 0, 1))).toBe('Jul 13, 11:59 PM');
    expect(plain(at(14, 4, 20, 0, 5), NOW)).toBe('Jun 14, 4:20 AM');
  });

  it('never shows seconds', () => {
    for (const [ms, now] of [[at(14, 4, 20, 59), NOW], [at(15, 4, 20, 30), NOW], [at(17, 4, 20, 1), NOW], [at(25, 4, 20, 45), NOW], [at(10, 4, 20, 15), NOW]]) {
      expect(plain(ms, now)).not.toMatch(/\d:\d\d:\d\d/);
    }
    expect(plain(at(14, 4, 20, 59), NOW)).toBe('4:20 AM');
    expect(plain(at(15, 4, 20, 30), NOW)).toBe('tomorrow 4:20 AM');
  });

  it('counts local calendar days through a daylight-saving change', () => {
    // 1 November 2026 is 25 hours long in New York (the clocks go back at 2:00).
    const midnightHalf = at(1, 0, 30, 0, 10);
    expect(plain(at(1, 23, 30, 0, 10), midnightHalf)).toBe('11:30 PM');
    expect(plain(at(2, 0, 30, 0, 10), midnightHalf)).toBe('tomorrow 12:30 AM');
    // Seven calendar days on across the spring change (8 March 2026 is 23 hours long) is only 6 days 23 hours later: still the
    // 7th day, and the 6th day is a weekday.
    expect(plain(at(14, 4, 20, 0, 2), at(7, 4, 20, 0, 2))).toBe('Mar 14, 4:20 AM');
    expect(plain(at(13, 4, 20, 0, 2), at(7, 4, 20, 0, 2))).toBe('Fri 4:20 AM');
  });

  // Controller follow-up: "4:20" and "AM" must never part at a line end (the owner's line wrapped them at 360 px).
  it('joins the pieces of the time with a no-break space, and leaves a space to break at before it', () => {
    const forms: [string, number, string][] = [
      ['the time alone', at(14, 4, 20), ''],
      ['tomorrow', at(15, 4, 20), 'tomorrow '],
      ['a weekday', at(17, 4, 20), 'Fri '],
      ['a month and day', at(25, 4, 20), 'Jul 25, '],
    ];
    for (const [form, ms, before] of forms) {
      const text = slotTimeText(ms, NOW);
      expect(text, form).toBe(`${before}4:20${NBSP}AM`);
      // The time part holds no ordinary space or other breakable whitespace; what comes before it ends in an ordinary space.
      expect(text.slice(before.length), form).not.toMatch(BREAKABLE);
      if (before) expect(before.at(-1), form).toBe(' ');
    }
    // The same through the afternoon and the end of the day, and at noon and midnight.
    for (const [hour, minute, time] of [[12, 0, '12:00'], [16, 5, '4:05'], [23, 59, '11:59'], [0, 0, '12:00']] as const) {
      expect(slotTimeText(at(14, hour, minute), NOW)).toMatch(new RegExp(`^${time}${NBSP}[AP]M$`));
    }
  });

  it('keeps the time together in a locale that puts its day period first', () => {
    pinned = 'ko-KR';
    const text = slotTimeText(at(14, 16, 20), NOW);
    expect(text).toBe(`오후${NBSP}4:20`);
    expect(text).not.toMatch(BREAKABLE);
  });

  it('formats in the viewer\'s own locale: the locale is never named', () => {
    slotTimeText(at(14, 4, 20), NOW);
    slotTimeText(at(15, 4, 20), NOW);
    slotTimeText(at(17, 4, 20), NOW);
    slotTimeText(at(25, 4, 20), NOW);
    expect(locales.length).toBeGreaterThanOrEqual(4);
    expect(locales.every(locale => locale === undefined)).toBe(true);
  });

  // Final review Minor 4: a time that is not a finite number (a value missing from a read, a broken display clock) shows
  // nothing. Unguarded, formatToParts throws a RangeError for NaN or Infinity during render, and a missing or null value
  // reads as the current moment or 1970. The callers leave their time out (activity-status.test.ts; the Build panel below).
  it('shows nothing for a time or a display time that is not a finite number', () => {
    const missing = undefined as unknown as number, nothing = null as unknown as number;
    for (const bad of [NaN, Infinity, -Infinity, missing, nothing, missing * 4_800_000, Number(missing)]) {
      expect(slotTimeText(bad, NOW), `time ${bad}`).toBe('');
      expect(slotTimeText(at(14, 4, 20), bad), `display time ${bad}`).toBe('');
    }
  });
});

describe('slot time callers', () => {
  // The Build panel's pending build says "Effective {time}"; with a time that cannot be shown it leaves that line out rather
  // than ending on "Effective" alone.
  it("leaves the Build panel's effective line out when its time cannot be shown", () => {
    const clock = createDisplayClock();
    clock.freeze(NOW);
    // (React's static markup separates adjacent text with `<!-- -->`; it is read as nothing.)
    const render = (effectiveSlotIndex: number) => renderToStaticMarkup(createElement(BuildPanel, {
      owner: { ...structuredClone(ownerFixture), pendingBuild: { build: structuredClone(ownerFixture.currentBuild), effectiveSlotIndex,
        reservedMoney: 0, reservedItemIds: [], operationId: '5d0f6a52-8f3e-4a51-9a39-3c1f4e0f9d21' } },
      gateway: {} as GameGateway, refresh: async () => {}, clock,
    })).replaceAll('<!-- -->', '');
    const next = Math.floor(NOW / 4_800_000) + 1;
    expect(render(next)).toContain(`<p>Effective ${slotTimeText(next * 4_800_000, NOW)}</p>`);
    for (const bad of [NaN, undefined as unknown as number]) {
      const html = render(bad);
      expect(html, String(bad)).toContain('Pending build');
      expect(html, String(bad)).not.toContain('Effective');
    }
  });
});
