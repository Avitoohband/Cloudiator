import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StageStart } from '@/features/character/ExpeditionView';
import { slotTimeText } from '@/features/schedule/slot-time';

// Task 24.0c (consistent with Avi's 2026-10-20 decision, plan question 14): each stage's start in the expedition's activity log
// is shown as every slot time is (`slotTimeText` against the view's own display time, Task 23.10), never in the fixed 'en'
// two-digit form (`04:20 AM`). A start that cannot be shown leaves the time out, never an empty or made-up one.

// The zone is pinned (Task 24.0d), as tests/domain/slot-time.test.ts pins its own and restores the process's afterwards, so no
// assertion depends on the host: the first CI run's UTC runner failed this file's `not.toContain('04:20')`, which read the
// machine-readable instant (`2026-10-20T04:20:00.000Z`) as well as the shown time. Jerusalem is the zone the game's fixtures and
// Avi's decisions use; 19 and 20 October 2026 are clear of any daylight-saving change there and everywhere else.
const zone = process.env.TZ;
// Set at once (not in a hook): the times below are built when the file loads.
process.env.TZ = 'Asia/Jerusalem';
beforeAll(() => {
  // The pinned zone must have taken effect, or every assertion below would be about the host.
  expect(new Date(2026, 9, 20, 4, 20).getTimezoneOffset()).toBe(-180);
});
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

/** A local wall-clock time (the viewer's time zone, as the view shows it). */
const local = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).getTime();
const render = (startedAtMs: number, nowMs: number) => renderToStaticMarkup(createElement(StageStart, { startedAtMs, nowMs }));

describe('a stage start in the expedition activity log', () => {
  it('is the short slot time against the display time, with its exact instant as the machine-readable time', () => {
    const start = local(20, 4, 20), now = local(20, 4, 47);
    expect(render(start, now)).toBe(`<time dateTime="${new Date(start).toISOString()}">${slotTimeText(start, now)}</time>`);
    expect(slotTimeText(start, now)).toMatch(/^4:20\sAM$/);
    // The shown text only (the markup's `dateTime` is the instant in UTC, which holds the digits in some zones): not `04:20 AM`.
    const shown = render(start, now).replace(/<[^>]*>/g, '');
    expect(shown).toBe(slotTimeText(start, now));
    expect(shown).not.toContain('04:20');
    // An expedition that set out before local midnight names that day once the display time is past it.
    const evening = local(19, 23, 50), afterMidnight = local(20, 0, 30);
    expect(render(evening, afterMidnight)).toContain(`>${slotTimeText(evening, afterMidnight)}<`);
    expect(slotTimeText(evening, afterMidnight)).toMatch(/^\p{L}+ 19, 11:50\sPM$/u);
  });

  it('leaves the time out when the start or the display time is not a finite number', () => {
    const now = local(20, 4, 47);
    for (const [start, at] of [[Number.NaN, now], [Number.POSITIVE_INFINITY, now], [local(20, 4, 20), Number.NaN]]) {
      expect(render(start, at), `${start} at ${at}`).toBe('');
    }
  });
});
