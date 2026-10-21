import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StageStart } from '@/features/character/ExpeditionView';
import { slotTimeText } from '@/features/schedule/slot-time';

// Task 24.0c (consistent with Avi's 2026-10-20 decision, plan question 14): each stage's start in the expedition's activity log
// is shown as every slot time is (`slotTimeText` against the view's own display time, Task 23.10), never in the fixed 'en'
// two-digit form (`04:20 AM`). A start that cannot be shown leaves the time out, never an empty or made-up one.

/** A local wall-clock time (the viewer's time zone, as the view shows it). */
const local = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).getTime();
const render = (startedAtMs: number, nowMs: number) => renderToStaticMarkup(createElement(StageStart, { startedAtMs, nowMs }));

describe('a stage start in the expedition activity log', () => {
  it('is the short slot time against the display time, with its exact instant as the machine-readable time', () => {
    const start = local(20, 4, 20), now = local(20, 4, 47);
    expect(render(start, now)).toBe(`<time dateTime="${new Date(start).toISOString()}">${slotTimeText(start, now)}</time>`);
    expect(slotTimeText(start, now)).toMatch(/^4:20\sAM$/);
    expect(render(start, now)).not.toContain('04:20');
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
