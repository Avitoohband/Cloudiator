import { describe, expect, it } from 'vitest';
import { report, verdict } from '../../scripts/resource-report.mjs';

// Task 23.3 fix round 1 (review Minor 3): scripts/resource-report.mjs must never print "ok" for a measurement it does not
// have. A missing number (a boundary window that never published, a section field that is absent) and a section a failed
// suite never wrote are reported as missing, and the report fails. Pure functions on synthetic sections: no database.

const OPTIONS = { players: 50, viewers: 50, slots: 4 };
const MONTHS = [30, 31];
const database = () => ({ bytesPerSlot: 1_000, steadyStateBytes: 100 * 2 ** 20, atOneYear: { bytes: 150 * 2 ** 20, byClass: {} }, at90Days: { byClass: {} },
  permanentBytesPerMonth: 1, seasonBytesPerMonth: 1, monthsToBudget: 12, budgetBytes: 250 * 2 ** 20 });
const invocations = () => ({ perSlot: 20, months: MONTHS.map(days => ({ days, worker: 10_000, commands: 1_000, total: 11_000, ceiling: 200_000 })),
  budget: 300_000 });
const egressMonths = () => MONTHS.map(days => ({ days, raw: 1e9, gzip: 2e8, brotli: 1.5e8 }));
/** A complete measurement, every budget under 80 %, whose windows published at the given times. */
function sections(published: (number | null)[] = [61_500, 61_600]) {
  const windows = published.map((publishedMs, i) => ({ slot: 300 + i, publishedMs }));
  return {
    worker: { worstCombatMs: 7, batch5Ms: 18, bracket50Ms: 3, tournamentBatch5Ms: 186, expeditionBatch5Ms: 20, cpuMs: 2_000, budgetMs: 1_500, machine: {} },
    capacity: { database: database(), databaseDefault: database(), sensitivity: [], invocations: invocations(), invocationsDefault: invocations(),
      egress: { perRead: {}, inputs: {}, players: { months: egressMonths() }, viewers: { months: egressMonths() }, viewersAlwaysOn: { months: egressMonths() },
        worker: null, alwaysOnViewersWithinBudget: 3, budget: 3e9, combined: { months: egressMonths() }, combinedWithWorker: null },
      measured: { windows, defaultSchedule: { windows } }, budgets: { seasonCloseMs: 43_950, standingsReadMs: 750 } },
    seasonClose: { ms50: { ms: 11 }, ms500: { ms: 26 } },
    standings: { pageMs: 4.5, oneRowMs: 4.5, plans: {} },
  };
}
const line = (result: ReturnType<typeof report>, prefix: string) => result.budgets.filter((b: { name: string }) => b.name.startsWith(prefix));

describe('resource-report.mjs verdicts', () => {
  it('calls only a measured share ok, risk or blocker', () => {
    expect([0, 0.5, 0.8, 0.81, 1, 2].map(verdict)).toEqual(['ok', 'ok', 'ok', 'risk', 'blocker', 'blocker']);
    for (const missing of [NaN, Infinity, null, undefined]) expect(verdict(missing), String(missing)).toBe('missing');
  });

  it('passes a complete measurement under every budget', () => {
    const result = report(OPTIONS, sections(), true);
    expect(result.budgets.map((b: { status: string }) => b.status)).not.toContain('missing');
    expect(line(result, 'boundary publication')).toEqual([expect.objectContaining({ used: 61_600, percent: 51.3, status: 'ok' })]);
    expect(result.ok).toBe(true);
  });

  it('reports a boundary window that never published as missing, never as the other windows\' worst, and fails', () => {
    const result = report(OPTIONS, sections([61_500, null]), true);
    expect(line(result, 'boundary publication')).toEqual([expect.objectContaining({ used: null, percent: null, status: 'missing' })]);
    expect(result.ok).toBe(false);
  });

  it('reports an absent number in a section as missing and fails', () => {
    const input = sections();
    delete (input.worker as Partial<typeof input.worker>).batch5Ms;
    const result = report(OPTIONS, input, true);
    expect(line(result, 'worker batch of 5')).toEqual([expect.objectContaining({ used: null, percent: null, status: 'missing' })]);
    expect(result.ok).toBe(false);
  });

  it('reports every section a failed suite never wrote as missing', () => {
    const result = report(OPTIONS, { worker: sections().worker }, false);
    const missing = result.budgets.filter((b: { status: string }) => b.status === 'missing').map((b: { name: string }) => b.name);
    expect(missing).toEqual(expect.arrayContaining([expect.stringContaining('capacity'), expect.stringContaining('season close'),
      expect.stringContaining('standings')]));
    expect(result.budgets.filter((b: { status: string }) => b.status === 'ok').every((b: { name: string }) => b.name.startsWith('worker'))).toBe(true);
    expect(result.ok).toBe(false);
  });
});
