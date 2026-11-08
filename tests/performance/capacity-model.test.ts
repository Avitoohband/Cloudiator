import { describe, expect, it } from 'vitest';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { WORKER_LIMITS } from '../../supabase/functions/_shared/backend/jobs.ts';
import { BUDGETS, JOB_PAYLOAD_SLOTS, MONTHS, RETENTION, TABLE_CLASSES, physicalAfternoonSlope, projectDatabase, projectDungeonDatabase, projectDungeonPayload, projectEgress, projectInvocations, share,
  tournamentsIn } from './capacity-model.ts';

// Task 23.3: the arithmetic that turns the measured run into monthly figures, pinned on small synthetic inputs.

describe('Task 23.3: capacity projections', () => {
  it('takes its windows, months and ceilings from the rules', () => {
    expect(RETENTION).toEqual({ detailSlots: 126, summarySlots: 1_620, dispatchLogSlots: 36, operationsEventSlots: 540, slotsPerDay: 18 });
    expect(RETENTION.detailSlots).toBe(RULES_V1.retention.replayMs / RULES_V1.clock.slotMs);
    expect(RETENTION.summarySlots).toBe(RULES_V1.retention.summaryMs / RULES_V1.clock.slotMs);
    expect(MONTHS.map(m => [m.days, m.slots, m.dispatchCeiling, m.tournaments])).toEqual([[30, 540, 216_000, 9], [31, 558, 223_200, 9]]);
    // At most one extra Wednesday or Saturday beyond four whole weeks: they are three days apart.
    expect([28, 29, 30, 31].map(days => tournamentsIn(days))).toEqual([8, 9, 9, 9]);
    expect(BUDGETS).toMatchObject({ databaseBytes: 524_288_000, egressBytes: 3_000_000_000, invocations: 300_000, workerMs: WORKER_LIMITS.cpuMs * 0.75 });
    expect(share(80, 100)).toBe(0.8);
  });

  it('models compacted job rows and the 500 MB budget', () => {
    // Task 23.7 (Avi's decision, 2026-10-19): 500 MB of 2^20 bytes, its 400 MB warning the health report's 80 %.
    expect(BUDGETS.databaseBytes).toBe(500 * 2 ** 20);
    expect(BUDGETS.databaseBytes * 0.8).toBe(419_430_400);
    // A job keeps its payloads until cleanup's trim reaches its slot: 19 slots behind the checkpoint, plus the hourly tick's
    // lag (under one 80-minute slot). Then it is a compacted row until the seven-day pass deletes it.
    expect(JOB_PAYLOAD_SLOTS).toBe(20);
    expect(TABLE_CLASSES['private.jobs']).toEqual({ retention: 'detail', compactAfterSlots: JOB_PAYLOAD_SLOTS });
    const projected = projectDatabase({
      players: 0, baselineBytes: 0, slotsPerSeason: 504,
      tables: { 'private.jobs': { regularRows: 10, tournamentRows: 10, bytesPerRow: 2_000, compactedBytesPerRow: 500, rows: 0, totalBytes: 0 } },
      system: { cronBytesPerRow: 0, netBytes: 0, authBytesPerPlayer: 0 },
      commandReceipts: { perPlayerPerDay: 0, bytesPerRow: 0 },
    });
    // 20 slots at full size, then 106 compacted, within the 126-slot detail window; before 20 slots every row is full.
    expect(projected.at90Days.byTable['private.jobs']).toBe(10 * (20 * 2_000 + 106 * 500));
    expect(projected.atOneYear.byTable['private.jobs']).toBe(10 * (20 * 2_000 + 106 * 500));
    expect(projected.atDays(1).byTable['private.jobs']).toBe(10 * 18 * 2_000);
    expect(projected.budgetBytes).toBe(524_288_000);
  });

  it('classifies every retention class it projects', () => {
    const classes = new Set(Object.values(TABLE_CLASSES).map(c => c.retention));
    expect([...classes].sort()).toEqual(['detail', 'operational', 'permanent', 'player', 'season', 'singleton', 'summary']);
  });

  it('accounts for the bounded bot roster and routines and prunable duty history', () => {
    expect(TABLE_CLASSES['private.bots']).toEqual({ retention: 'singleton' });
    expect(TABLE_CLASSES['private.bot_routines']).toEqual({ retention: 'singleton' });
    expect(TABLE_CLASSES['private.bot_slot_duty']).toEqual({ retention: 'detail' });
    expect(TABLE_CLASSES['private.bot_arena_history']).toEqual({ retention: 'player' });
  });

  it('separates shared dungeon detail, the second simulation copy and per-member summaries', () => {
    for (const name of ['private.dungeon_runs', 'private.dungeon_run_members', 'private.dungeon_results', 'public.dungeon_fights']) {
      expect(TABLE_CLASSES[name]).toEqual({ retention: 'detail' });
    }
    const bytes = { frozenRun: 5, frozenPlan: 100, fightLogs: 90, memberSeat: 7, simulationResult: 100,
      ownerSummary: 13, publicSummary: 11, receiptSummary: 13 };
    const detailPerAfternoon = 2 * (5 + 100 + 90) + 5 * 7;
    const summaryPerAfternoon = 5 * (13 + 11 + 13);
    expect(projectDungeonPayload(bytes, 2, 5, 3)).toEqual({
      detail: detailPerAfternoon, simulationJobs: 200, summaries: summaryPerAfternoon, total: detailPerAfternoon + 200 + summaryPerAfternoon,
    });
    expect(projectDungeonPayload(bytes, 2, 5, 2_000)).toEqual({
      detail: 42 * detailPerAfternoon, simulationJobs: 7 * 200, summaries: 540 * summaryPerAfternoon,
      total: 42 * detailPerAfternoon + 7 * 200 + 540 * summaryPerAfternoon,
    });
  });

  it('replaces legacy afternoon rows and retains the two physical plan copies for different windows', () => {
    const part = (heap: number, indexes = 0, toast = 0) => ({ heap, indexes, toast });
    const projected = projectDungeonDatabase({ players: 0, baselineBytes: 0, slotsPerSeason: 504,
      tables: {
        'public.activities': { regularRows: 50, tournamentRows: 50, bytesPerRow: 10, rows: 0, totalBytes: 0 },
        'private.jobs': { regularRows: 1, tournamentRows: 1, bytesPerRow: 100, compactedBytesPerRow: 10, rows: 0, totalBytes: 0 },
        'private.bot_routines': { regularRows: 0, tournamentRows: 0, bytesPerRow: 0, rows: 630, totalBytes: 8192 },
      }, system: { cronBytesPerRow: 0, netBytes: 0, authBytesPerPlayer: 0 }, commandReceipts: { perPlayerPerDay: 0, bytesPerRow: 0 },
    }, { runs: 2, frozenPlanRawBytes: 80, simulationPlanRawBytes: 60,
      afternoon: { 'public.activities': { full: part(500, 100, 100) }, 'private.jobs': { full: part(200, 25, 25), compacted: part(50) },
        'private.dungeon_results': { full: part(100, 10, 90) } },
      bots: { population: 5, routineCells: 630, roster: part(100), duty: part(200), arenaHistory: part(300) },
    }, 100);
    expect(projected.afternoonDeltaByTable).toEqual({ 'public.activities': 183_600, 'private.jobs': 3150, 'private.dungeon_results': 10_080 });
    // Packed samples carry the measured payloads. The p95 extra covers two copies (42 and 7 afternoons), plus TOAST overhead.
    expect(projected.p95ExtraBytes).toBeCloseTo(2956.8);
    expect(projected.botBytes).toBe(720);
    expect(projected.benchmarkBytes).toBeCloseTo(projected.legacyBytes + 183_600 + 3150 + 10_080 + 720 + 2956.8);
  });

  it('excludes fixed page allocation from repeated growth and keeps the larger late slope for each storage part', () => {
    // The fixed 8 KiB page in each storage part must never become a recurring per-afternoon cost. The late samples
    // have different index growth rates, so using the final slope alone would undercount that measured component.
    const points = [
      { afternoons: 8, bytes: { heap: 8352, indexes: 8272, toast: 8672 } },
      { afternoons: 32, bytes: { heap: 8832, indexes: 8512, toast: 10112 } },
      { afternoons: 64, bytes: { heap: 9472, indexes: 8896, toast: 12032 } },
      { afternoons: 128, bytes: { heap: 10752, indexes: 9536, toast: 15872 } },
    ];
    expect(physicalAfternoonSlope(points)).toEqual({
      intervals: [{ heap: 20, indexes: 10, toast: 60 }, { heap: 20, indexes: 12, toast: 60 }, { heap: 20, indexes: 10, toast: 60 }],
      perAfternoon: { heap: 20, indexes: 12, toast: 60 },
    });
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
