import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The text a slot time shows (Task 23.10), worked out in the page, in its own locale and time zone, apart from the code under
 * test: the time alone on the same local day as `nowMs`, `tomorrow …` on the next, the short weekday for the 2nd to the 6th
 * day ahead, and otherwise the short month and day; never seconds. The page joins the pieces of the time with no-break
 * spaces (the follow-up below); `toHaveText` reads them as ordinary ones, so this writes them as ordinary ones.
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

/**
 * The first time in `locator`'s text (`4:20 AM`) must stay on one line in a 360 px viewport (Task 23.10 follow-up): the client
 * rects of a range over it all start at one height, whether or not the words before it wrap. The viewport is put back.
 */
export async function expectTimeOnOneLine(page: Page, locator: Locator, what: string) {
  const size = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(500);
  await locator.scrollIntoViewIfNeeded();
  const { time, lines } = await locator.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      const found = /\d{1,2}:\d\d\s[AP]M/.exec(text);
      if (!found) continue;
      const range = document.createRange();
      range.setStart(node, found.index);
      range.setEnd(node, found.index + found[0].length);
      return { time: found[0], lines: new Set(Array.from(range.getClientRects()).map(rect => Math.round(rect.top))).size };
    }
    return { time: '', lines: 0 };
  });
  if (size) await page.setViewportSize(size);
  expect(time, `${what}: its text holds a time`).not.toBe('');
  expect(lines, `${what}: ${time} is on one line at 360 px`).toBe(1);
}
