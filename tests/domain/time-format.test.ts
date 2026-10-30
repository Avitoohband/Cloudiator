import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { calendarDays, dateText, dayText, timeOfDay, utcClockText } from '../../src/lib/time-format';

// Patch A, item 7: every time of day is written by one formatter, in the shape the device's clock setting asks for. Zones are
// named in each call, so no assertion depends on the host's own.
const RealFormat = Intl.DateTimeFormat;
const PROTOTYPE = Intl.DateTimeFormat.prototype;
const NBSP = '\xA0';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('dateText and calendarDays (Task 11c: the profile card, "In camp since")', () => {
  it('writes a date with the fixed month names, adding the year only when it is not the current one', () => {
    expect(dateText(Date.UTC(2026, 8, 30, 12), Date.UTC(2026, 9, 1), 'UTC')).toBe('30 Sep');
    expect(dateText(Date.UTC(2025, 9, 2, 12), Date.UTC(2026, 9, 1), 'UTC')).toBe('2 Oct 2025');
    expect(dateText(Date.UTC(2026, 9, 9, 20), Date.UTC(2026, 9, 9, 21), 'Asia/Tokyo')).toBe('10 Oct');
    expect(dateText(NaN, 0)).toBe('');
    expect(dateText(0, NaN)).toBe('');
  });

  it('counts whole calendar days between two dates in a zone', () => {
    expect(calendarDays(Date.UTC(2026, 9, 9, 23), Date.UTC(2026, 9, 10, 1), 'UTC')).toBe(1);
    expect(calendarDays(Date.UTC(2026, 9, 9, 23), Date.UTC(2026, 9, 10, 1), 'Asia/Tokyo')).toBe(0);
    expect(calendarDays(Date.UTC(2025, 9, 2, 12), Date.UTC(2026, 9, 29, 12), 'UTC')).toBe(392);
    expect(calendarDays(NaN, 0)).toBeNull();
  });
});

describe('timeOfDay', () => {
  it('writes a time of day in 12-hour and 24-hour form', () => {
    const three = Date.UTC(2026, 9, 10, 3, 0), noonish = Date.UTC(2026, 9, 10, 12, 5), midnight = Date.UTC(2026, 9, 10, 0, 5);
    expect(timeOfDay(three, '12', 'UTC')).toBe('3:00\xA0AM');
    expect(timeOfDay(three, '24', 'UTC')).toBe('03:00');
    expect(timeOfDay(noonish, '12', 'UTC')).toBe('12:05\xA0PM');
    expect(timeOfDay(midnight, '12', 'UTC')).toBe('12:05\xA0AM');
    expect(timeOfDay(NaN, '24')).toBe('');
  });

  it('writes the hours around noon and midnight both ways', () => {
    const hours = [[0, '12:00\xA0AM', '00:00'], [1, '1:00\xA0AM', '01:00'], [11, '11:00\xA0AM', '11:00'], [12, '12:00\xA0PM', '12:00'],
      [13, '1:00\xA0PM', '13:00'], [23, '11:00\xA0PM', '23:00']] as const;
    for (const [hour, twelve, twentyFour] of hours) {
      expect(timeOfDay(Date.UTC(2026, 9, 10, hour, 0), '12', 'UTC'), `${hour} in 12-hour`).toBe(twelve);
      expect(timeOfDay(Date.UTC(2026, 9, 10, hour, 0), '24', 'UTC'), `${hour} in 24-hour`).toBe(twentyFour);
    }
    expect(timeOfDay(Date.UTC(2026, 9, 10, 23, 59), '24', 'UTC')).toBe('23:59');
    expect(timeOfDay(Date.UTC(2026, 9, 10, 9, 7, 59), '12', 'UTC')).toBe('9:07\xA0AM');
  });

  it('keeps the time together: the one space in 12-hour form never breaks, and 24-hour form has none', () => {
    expect(timeOfDay(Date.UTC(2026, 9, 10, 15, 0), '12', 'UTC')).not.toMatch(/[^\S\xA0]/);
    expect(timeOfDay(Date.UTC(2026, 9, 10, 15, 0), '24', 'UTC')).not.toMatch(/\s/);
  });

  it('reads the hour in the zone it is given, and in the runtime zone when it is given none', () => {
    const at = Date.UTC(2026, 9, 10, 13, 40);
    expect(timeOfDay(at, '12', 'Europe/London')).toBe('2:40\xA0PM');
    expect(timeOfDay(at, '24', 'Europe/London')).toBe('14:40');
    expect(timeOfDay(at, '24', 'Asia/Jerusalem')).toBe('16:40');
    expect(timeOfDay(at, '24', 'America/New_York')).toBe('09:40');
    expect(timeOfDay(at, '24')).toBe(timeOfDay(at, '24', new RealFormat().resolvedOptions().timeZone));
  });

  it('writes upper-case AM and PM whatever the locale', () => {
    // The runtime's own locale is en-GB here, which writes "pm" in lower case; Korean puts its day period first.
    for (const locale of ['en-GB', 'ko-KR', 'ar-EG', 'de-DE']) {
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (this: unknown, requested?: string | string[], options?: Intl.DateTimeFormatOptions) {
        return new RealFormat(requested ?? locale, options);
      } as unknown as typeof Intl.DateTimeFormat);
      expect(timeOfDay(Date.UTC(2026, 9, 10, 15, 0), '12', 'UTC'), locale).toBe('3:00\xA0PM');
      expect(timeOfDay(Date.UTC(2026, 9, 10, 15, 5), '24', 'UTC'), locale).toBe('15:05');
      vi.restoreAllMocks();
    }
  });

  it('writes no time for a value that is not a finite number', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined as unknown as number, null as unknown as number]) {
      expect(timeOfDay(bad, '12', 'UTC'), String(bad)).toBe('');
      expect(timeOfDay(bad, '24', 'UTC'), String(bad)).toBe('');
    }
  });
});

describe('dayText', () => {
  it('names the day in fixed English', () => {
    expect(dayText(Date.UTC(2026, 8, 15, 12), 'UTC')).toBe('Tue 15 Sep');
    expect(dayText(Date.UTC(2026, 9, 10, 12), 'UTC')).toBe('Sat 10 Oct');
    expect(dayText(Date.UTC(2026, 9, 28, 12), 'UTC')).toBe('Wed 28 Oct');
  });

  it('abbreviates every month and weekday the same way in every engine', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let month = 0; month < 12; month += 1) expect(dayText(Date.UTC(2026, month, 5, 12), 'UTC').split(' ')[2], `month ${month}`).toBe(months[month]);
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let day = 0; day < 7; day += 1) expect(dayText(Date.UTC(2026, 9, 11 + day, 12), 'UTC').split(' ')[0], `day ${day}`).toBe(weekdays[day]);
  });

  it('names the day of the zone, not of UTC', () => {
    const lateEvening = Date.UTC(2026, 9, 10, 23, 30);
    expect(dayText(lateEvening, 'UTC')).toBe('Sat 10 Oct');
    expect(dayText(lateEvening, 'Asia/Jerusalem')).toBe('Sun 11 Oct');
    expect(dayText(lateEvening, 'America/New_York')).toBe('Sat 10 Oct');
    expect(dayText(Date.UTC(2026, 9, 11, 2, 0), 'America/New_York')).toBe('Sat 10 Oct');
  });

  it('writes a single-digit day without a leading zero, and no day for a value that is not a finite number', () => {
    expect(dayText(Date.UTC(2026, 9, 7, 12), 'UTC')).toBe('Wed 7 Oct');
    expect(dayText(NaN, 'UTC')).toBe('');
    expect(dayText(undefined as unknown as number)).toBe('');
  });
});

describe('utcClockText', () => {
  it('writes the tournament hour in UTC', () => {
    expect(utcClockText(18, 40, '12')).toBe('6:40\xA0PM UTC');
    expect(utcClockText(18, 40, '24')).toBe('18:40 UTC');
  });

  it('writes midnight, noon and a short minute', () => {
    expect(utcClockText(0, 5, '12')).toBe('12:05\xA0AM UTC');
    expect(utcClockText(0, 5, '24')).toBe('00:05 UTC');
    expect(utcClockText(12, 0, '12')).toBe('12:00\xA0PM UTC');
    expect(utcClockText(12, 0, '24')).toBe('12:00 UTC');
  });
});

describe('the clock setting', () => {
  // Each test imports a fresh module after vi.resetModules(); `hourCycle` stubs what the runtime reports.
  const store = new Map<string, string>();
  const hourCycle = (value: string | undefined, hour12?: boolean) => vi.spyOn(PROTOTYPE, 'resolvedOptions').mockReturnValue(
    { hourCycle: value, hour12 } as unknown as Intl.ResolvedDateTimeFormatOptions);
  const fresh = async () => { vi.resetModules(); return import('../../src/lib/clock-setting'); };
  const throwingStorage = () => vi.stubGlobal('localStorage', {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); },
  });
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } });
  });

  it('starts on the device hour cycle and remembers a choice on this device', async () => {
    hourCycle('h23'); const s = await fresh(); expect(s.readClockMode()).toBe('24');
    const heard = vi.fn(); s.subscribeClockMode(heard); s.saveClockMode('12');
    expect(store.get('cloudiator.clock.v1')).toBe('12'); expect(s.readClockMode()).toBe('12'); expect(heard).toHaveBeenCalledTimes(1);
  });

  it('names its key', async () => { expect((await fresh()).CLOCK_KEY).toBe('cloudiator.clock.v1'); });

  it('reads the device choice from the hour cycle: h11 and h12 are 12-hour, h23 and h24 are 24-hour', async () => {
    for (const [cycle, mode] of [['h11', '12'], ['h12', '12'], ['h23', '24'], ['h24', '24']] as const) {
      hourCycle(cycle); expect((await fresh()).deviceClockMode(), cycle).toBe(mode);
    }
  });

  it('reads hour12 when the runtime names no hour cycle', async () => {
    hourCycle(undefined, true); expect((await fresh()).deviceClockMode()).toBe('12');
    hourCycle(undefined, false); expect((await fresh()).deviceClockMode()).toBe('24');
  });

  it('ignores a stored value it does not know', async () => { store.set('cloudiator.clock.v1', 'x'); hourCycle('h12'); expect((await fresh()).readClockMode()).toBe('12'); });

  it('uses a stored value over the device choice', async () => {
    store.set('cloudiator.clock.v1', '24'); hourCycle('h12'); expect((await fresh()).readClockMode()).toBe('24');
    store.set('cloudiator.clock.v1', '12'); hourCycle('h23'); expect((await fresh()).readClockMode()).toBe('12');
  });

  it('keeps working when storage throws', async () => {
    throwingStorage(); hourCycle('h12'); const s = await fresh();
    expect(s.readClockMode()).toBe('12'); expect(() => s.saveClockMode('24')).not.toThrow(); expect(s.readClockMode()).toBe('24');
  });

  it('tells its listeners of a change even when storage throws', async () => {
    throwingStorage(); hourCycle('h12'); const s = await fresh();
    const heard = vi.fn(); s.subscribeClockMode(heard); s.saveClockMode('24');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('shows the choice just made when its write fails but an older value is still readable', async () => {
    // A full or read-only store still answers a read with what it held before; the choice must not snap back to that.
    store.set('cloudiator.clock.v1', '24'); hourCycle('h23');
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem() { throw new Error('quota'); } });
    const s = await fresh(); expect(s.readClockMode()).toBe('24');
    s.saveClockMode('12'); expect(s.readClockMode()).toBe('12');
  });

  it('stops telling a listener that has unsubscribed', async () => {
    hourCycle('h12'); const s = await fresh();
    const heard = vi.fn(); const off = s.subscribeClockMode(heard); off(); s.saveClockMode('24');
    expect(heard).not.toHaveBeenCalled();
  });

  it('hears another tab change the key, and nothing else', async () => {
    const page = new EventTarget(); vi.stubGlobal('window', page);
    hourCycle('h12'); const s = await fresh();
    const heard = vi.fn(); const off = s.subscribeClockMode(heard);
    const storage = (key: string | null) => page.dispatchEvent(Object.assign(new Event('storage'), { key }));
    store.set('cloudiator.clock.v1', '24'); storage('cloudiator.clock.v1');
    expect(heard).toHaveBeenCalledTimes(1); expect(s.readClockMode()).toBe('24');
    storage('something.else'); expect(heard).toHaveBeenCalledTimes(1);
    off(); storage('cloudiator.clock.v1'); expect(heard).toHaveBeenCalledTimes(1);
  });

  it('renders on the server with the device choice', async () => {
    hourCycle('h23'); const s = await fresh();
    store.set('cloudiator.clock.v1', '12');
    const Probe = () => createElement('span', null, s.useClockMode());
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>24</span>');
  });
});
