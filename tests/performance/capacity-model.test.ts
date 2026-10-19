import { describe, expect, it } from 'vitest';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { WORKER_LIMITS } from '../../supabase/functions/_shared/backend/jobs.ts';
import { BUDGETS, MONTHS, RETENTION, TABLE_CLASSES, projectDatabase, projectEgress, projectInvocations, share, tournamentsIn } from './capacity-model.ts';

// Task 23.3: the arithmetic that turns the measured run into monthly figures, pinned on small synthetic inputs.

describe('Task 23.3: capacity projections', () => {
  it('takes its windows, months and ceilings from the rules', () => {
    expect(RETENTION).toEqual({ detailSlots: 126, summarySlots: 1_620, dispatchLogSlots: 36, operationsEventSlots: 540, slotsPerDay: 18 });
    expect(RETENTION.detailSlots).toBe(RULES_V1.retention.replayMs / RULES_V1.clock.slotMs);
    expect(RETENTION.summarySlots).toBe(RULES_V1.retention.summaryMs / RULES_V1.clock.slotMs);
    expect(MONTHS.map(m => [m.days, m.slots, m.dispatchCeiling, m.tournaments])).toEqual([[30, 540, 216_000, 9], [31, 558, 223_200, 9]]);
    // At most one extra Wednesday or Saturday beyond four whole weeks: they are three days apart.
    expect([28, 29, 30, 31].map(days => tournamentsIn(days))).toEqual([8, 9, 9, 9]);
    expect(BUDGETS).toMatchObject({ databaseBytes: 262_144_000, egressBytes: 3_000_000_000, invocations: 300_000, workerMs: WORKER_LIMITS.cpuMs * 0.75 });
    expect(share(80, 100)).toBe(0.8);
  });

  it('classifies every retention class it projects', () => {
    const classes = new Set(Object.values(TABLE_CLASSES).map(c => c.retention));
    expect([...classes].sort()).toEqual(['detail', 'operational', 'permanent', 'player', 'season', 'singleton', 'summary']);
  });

  it('projects detail, summary and permanent growth with compaction, a base and the operational windows', () => {
    const projected = projectDatabase({
      players: 10, baselineBytes: 1_000, slotsPerSeason: 504,
      tables: {
        'private.activity_snapshots': { regularRows: 10, tournamentRows: 10, bytesPerRow: 100, rows: 0, totalBytes: 0 },
        'public.activities': { regularRows: 10, tournamentRows: 10, bytesPerRow: 10, rows: 0, totalBytes: 0 },
        'public.operation_receipts': { regularRows: 10, tournamentRows: 10, bytesPerRow: 50, compactedBytesPerRow: 20, rows: 0, totalBytes: 0 },
        'private.dispatch_log': { regularRows: 2, tournamentRows: 2, bytesPerRow: 1, rows: 0, totalBytes: 0 },
        'public.gladiators': { regularRows: 0, tournamentRows: 0, bytesPerRow: 0, rows: 10, totalBytes: 5_000 },
      },
      system: { cronBytesPerRow: 1, netBytes: 0, authBytesPerPlayer: 10 },
      commandReceipts: { perPlayerPerDay: 0, bytesPerRow: 0 },
    });
    // Detail: 126 slots of 1,000 B. Summary: 1,620 slots of 100 B. Receipts: 500 B a slot for 1,620 slots, then 200 B.
    const slots = (days: number) => days * 18;
    expect(projected.windowsFull).toBe(1_620);
    // An average slot writes 1,000 B of detail, 100 B of summaries, 500 B of receipts and 2 B of dispatch log.
    expect(projected.bytesPerSlot).toBe(1_602);
    const at = (days: number) => projected.atDays(days);
    const receipts = (s: number) => Math.min(s, 1_620) * 500 + Math.max(0, s - 1_620) * 200;
    const operational = 36 * 2 + 7 * (1_440 + 24) * 1;
    const fixed = 1_000 + 5_000 + 10 * 10;
    expect(at(90).bytes).toBe(fixed + 126 * 1_000 + 1_620 * 100 + receipts(slots(90)) + operational);
    expect(at(365).bytes).toBe(fixed + 126 * 1_000 + 1_620 * 100 + receipts(slots(365)) + operational);
    expect(projected.permanentBytesPerMonth).toBe(200 * 18 * 30);
  });

  it('projects invocations from dispatches per slot, tournaments and commands with their preflights', () => {
    const projected = projectInvocations({ regularPerSlot: 4, tournamentPerSlot: 20 }, { players: 10, commandsPerPlayerPerDay: 5, preflightPerCommand: 1 });
    expect(projected.months.map(m => m.total)).toEqual([
      (540 - 9) * 4 + 9 * 20 + 10 * 5 * 2 * 30,
      (558 - 9) * 4 + 9 * 20 + 10 * 5 * 2 * 31]);
    expect(projected.months.map(m => m.ceiling)).toEqual([216_000 + 10 * 5 * 2 * 30, 223_200 + 10 * 5 * 2 * 31]);
  });

  it('projects egress per visible minute from the read sizes and revision changes', () => {
    const read = (bytes: number) => ({ raw: bytes, gzip: bytes / 2, brotli: bytes / 4, requests: 1, headerBytes: 0 });
    const reads = Object.fromEntries(['revision', 'world', 'owner', 'standings', 'standingOf', 'timelineArena', 'timelineOwn', 'profile',
      'recent', 'market', 'seasons', 'tournament', 'tournamentLogs', 'command', 'authRefresh']
      .map(kind => [kind, { visitor: read(kind === 'revision' ? 100 : 0), player: read(kind === 'revision' ? 100 : kind === 'world' ? 1_000 : 0) }]));
    const projected = projectEgress({ reads, regular: { changedMinutes: 8, arenaEntrants: 0, splitFactor: 1 }, tournament: { changedMinutes: 8,
      viewReads: 0, logBytes: { raw: 0, gzip: 0, brotli: 0 } } },
      { players: 1, viewers: 0, visibleMinutesPerDay: 30, commandsPerPlayerPerDay: 0, standingsOpenShare: 0 });
    // Two polls a minute; 8 changes in an 80-minute slot (+1 for the slot index) is 9/80 world re-reads a minute (a world read
    // includes its own two revision checks); one entry load (a revision, then the world).
    const perDay = 30 * 2 * 100 + 30 * (9 / 80) * 1_000 + (100 + 1_000);
    expect(projected.players.months[1].raw).toBeCloseTo(perDay * 31, 3);
  });
});
