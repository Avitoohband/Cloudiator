import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicActivitySummary } from '@contracts/events';
import type { ResultRow, ResultsPage } from '@contracts/reads';
import { resultLine } from '@/features/results/result-text';
import { ResultsView, readResults, type ResultsModel } from '@/features/results/ResultsPanel';
import { RESULTS_FIXTURE } from '../fixtures/results';

const ASTER = '0d5f8471-d919-428f-9ab7-058c95821757';
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function row(kind: PublicActivitySummary['resolvedKind'], result: PublicActivitySummary['result'], replay: 'available' | 'expired',
  { name = 'Aster', gladiatorId = ASTER, activityId = `${kind}-${result}-${replay}`, settledAtMs = 1_791_590_400_000 } = {}): ResultRow {
  return { gladiatorId, name, summary: { activityId, resolvedKind: kind, result, success: result !== 'defeat', settledAtMs,
    replayExpiry: replay === 'available' ? { state: 'available', expiresAtMs: settledAtMs + 7 * 86_400_000 } : { state: 'expired' } } };
}

describe('result lines', () => {
  it('says what Training and Rest did, never offers a replay and never says one is no longer kept (Tasks 7, 9)', () => {
    const trainingRow = row('training', 'completed', 'expired');
    expect(resultLine(trainingRow)).toEqual({ text: 'Aster finished training', replay: false });
    expect(resultLine(row('rest', 'completed', 'expired', { name: 'Cassia' }))).toEqual({ text: 'Cassia finished resting', replay: false });
    // Even a Training or Rest summary that claimed a kept replay offers none.
    expect(resultLine(row('training', 'completed', 'available'))).toEqual({ text: 'Aster finished training', replay: false });
  });

  it('offers the replay of a bout, an expedition or a tournament while it is kept, and says so once it is not', () => {
    expect(resultLine(row('arena', 'victory', 'available'))).toEqual({ text: 'Aster won an Arena bout', replay: true });
    expect(resultLine(row('arena', 'defeat', 'expired'))).toEqual({ text: 'Aster lost an Arena bout · replay no longer kept', replay: false });
    expect(resultLine(row('expedition', 'victory', 'available'))).toEqual({ text: 'Aster returned victorious from an expedition', replay: true });
    expect(resultLine(row('expedition', 'defeat', 'available'))).toEqual({ text: 'Aster was defeated on an expedition', replay: true });
    expect(resultLine(row('expedition', 'completed', 'expired'))).toEqual({ text: 'Aster returned from an expedition · replay no longer kept', replay: false });
    expect(resultLine(row('tournament', 'victory', 'available'))).toEqual({ text: 'Aster won a tournament', replay: true });
    expect(resultLine(row('tournament', 'defeat', 'available'))).toEqual({ text: 'Aster was knocked out of a tournament', replay: true });
  });

  it('describes every fixture result from its public fields only', () => {
    for (const fixture of RESULTS_FIXTURE[0].rows) {
      const line = resultLine(fixture);
      expect(line.text.startsWith(fixture.name), fixture.summary.activityId).toBe(true);
      if (fixture.summary.resolvedKind === 'training' || fixture.summary.resolvedKind === 'rest') {
        expect(line.replay).toBe(false);
        expect(line.text).not.toContain('no longer kept');
      } else expect(line.replay).toBe(fixture.summary.replayExpiry.state === 'available');
      expect(line.text).not.toMatch(/\b(renown|money|xp|rating|rewards?)\b/i);
    }
  });
});

describe('Results', () => {
  const MINE = 'mine-0000';
  /** 120 results, a third of them the viewer's, newest first; the cursor is the next row's index. */
  const ROWS: ResultRow[] = Array.from({ length: 120 }, (_, i) => row(i % 4 === 0 ? 'training' : 'arena', 'victory', 'available', {
    name: i % 3 === 0 ? 'Mine' : `Other ${i}`, gladiatorId: i % 3 === 0 ? MINE : `other-${i}`, activityId: `activity-${String(i).padStart(3, '0')}`,
    settledAtMs: 1_791_590_400_000 - i * 60_000,
  }));
  function reader(rows: readonly ResultRow[] = ROWS) {
    const cursors: (string | undefined)[] = [];
    return {
      cursors,
      recent: async (cursor?: string): Promise<ResultsPage> => {
        cursors.push(cursor);
        const at = cursor ? Number(cursor) : 0;
        const page = rows.slice(at, at + 50);
        return { rows: structuredClone(page), nextCursor: page.length === 50 ? String(at + 50) : null };
      },
    };
  }
  const view = (model: ResultsModel, viewerId: string | null = MINE) =>
    renderToStaticMarkup(createElement(ResultsView, { model, viewerId, onMore: noop, onRetry: noop, onWatch: noop, timeZone: 'UTC' }));

  it('pages recent results 50 at a time and marks the viewer’s own rows', async () => {
    const reads = reader();
    let list = await readResults(reads, null);
    expect(list.rows.map(r => r.summary.activityId)).toEqual(ROWS.slice(0, 50).map(r => r.summary.activityId));
    expect(list.nextCursor).toBe('50');
    let html = view({ ...list, status: 'ready' });
    expect(html.match(/<li/g)).toHaveLength(50);
    expect(text(html)).toContain('More');
    // "You" marks exactly the viewer's own rows; a visitor (no viewer) sees none.
    expect(text(html).match(/\bYou\b/g)).toHaveLength(ROWS.slice(0, 50).filter(r => r.gladiatorId === MINE).length);
    expect(text(view({ ...list, status: 'ready' }, null))).not.toMatch(/\bYou\b/);

    list = await readResults(reads, list);
    expect(list.rows).toHaveLength(100);
    list = await readResults(reads, list);
    expect(list.rows).toHaveLength(120);
    expect(list.nextCursor).toBeNull();
    expect(reads.cursors).toEqual([undefined, '50', '100']);
    html = view({ ...list, status: 'ready' });
    expect(html.match(/<li/g)).toHaveLength(120);
    expect(text(html)).not.toContain('More');
    expect(text(html).match(/\bYou\b/g)).toHaveLength(ROWS.filter(r => r.gladiatorId === MINE).length);
  });

  it('keeps at most 50 new rows a page, never repeats one, and ends a list whose reader ignores the cursor', async () => {
    const oversized = { recent: async (): Promise<ResultsPage> => ({ rows: structuredClone(ROWS.slice(0, 60)), nextCursor: 'next' }) };
    const first = await readResults(oversized, null);
    expect(first.rows).toHaveLength(50);
    // The same page again (a reader that ignores the cursor): nothing new, so the list ends.
    const again = await readResults(oversized, first);
    expect(again.rows).toHaveLength(60);
    expect(new Set(again.rows.map(r => r.summary.activityId)).size).toBe(60);
    const ended = await readResults({ recent: async () => ({ rows: structuredClone(ROWS.slice(0, 50)), nextCursor: 'x' }) }, first);
    expect(ended).toEqual({ ...first, nextCursor: null });
    // An exact multiple of 50 ends with an empty page.
    const hundred = reader(ROWS.slice(0, 100));
    let list = await readResults(hundred, null);
    list = await readResults(hundred, list);
    expect(list.nextCursor).toBe('100');
    list = await readResults(hundred, list);
    expect(list).toMatchObject({ nextCursor: null });
    expect(list.rows).toHaveLength(100);
  });

  it('offers a replay button only for a kept replay, and shows each result’s kind and settlement time', () => {
    const rows = [row('arena', 'victory', 'available'), row('training', 'completed', 'expired', { activityId: 'training-1' }),
      row('arena', 'defeat', 'expired', { activityId: 'gone-1' })];
    const html = view({ rows, nextCursor: null, status: 'ready' });
    expect(html.match(/<button[^>]*>Replay<\/button>/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Replay: Aster won an Arena bout"');
    expect(text(html)).toContain('Arena · Sat 10 Oct, 00:00');
    expect(text(html)).toContain('Training ·');
    expect(text(html)).toContain('Aster lost an Arena bout · replay no longer kept');
  });

  it('says when results are loading, empty or failed', () => {
    expect(text(view({ rows: [], nextCursor: null, status: 'loading' }))).toContain('Loading recent results…');
    expect(text(view({ rows: [], nextCursor: null, status: 'ready' }))).toContain('No results yet.');
    const failed = view({ rows: [], nextCursor: null, status: 'failed' });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('Try again');
  });
});
