import type { Page } from '@playwright/test';

/**
 * The text a slot time shows (Task 23.10), worked out in the page, in its own locale and time zone, apart from the code under
 * test: the time alone on the same local day as `nowMs`, `tomorrow …` on the next, the short weekday for the 2nd to the 6th
 * day ahead, and otherwise the short month and day; never seconds.
 */
export function slotTime(page: Page, ms: number, nowMs: number): Promise<string> {
  return page.evaluate(([time, now]) => {
    const midnight = (t: number) => { const date = new Date(t); date.setHours(0, 0, 0, 0); return date.getTime(); };
    const ahead = Math.round((midnight(time) - midnight(now)) / 86_400_000);
    const show = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', ...options }).format(time);
    if (ahead === 0) return show({});
    if (ahead === 1) return `tomorrow ${show({})}`;
    if (ahead >= 2 && ahead <= 6) return show({ weekday: 'short' });
    return show({ month: 'short', day: 'numeric' });
  }, [ms, nowMs]);
}
