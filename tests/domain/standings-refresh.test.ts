import { describe, expect, it } from 'vitest';
import type { LeagueId } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';
import { STANDINGS_REFRESH_MS, STANDINGS_SETTLE_WINDOW_MS, readStandingsPages, standingsRefreshDue } from '@/features/arena/standings-refresh';
import { ARENA_STANDINGS, arenaStandingsPage } from '../fixtures/arena';

const SLOT = RULES_V1.clock.slotMs;
const SLOT_INDEX = 373_249;
/** A slot boundary: slot SLOT_INDEX - 1 has just ended. */
const B = SLOT_INDEX * SLOT;
const ENDED = SLOT_INDEX - 1;

/** Steps the display clock second by second and records when a standings read is due (each read happens at once). */
function readsBetween(from: number, to: number, processedAt: (t: number) => number | null, firstReadMs = B - 20 * 60_000) {
  let last = firstReadMs;
  let readProcessed = processedAt(firstReadMs);
  const reads: number[] = [];
  for (let t = from; t <= to; t += 1000) {
    if (standingsRefreshDue({ nowMs: t, lastReadMs: last, processedSlotIndex: processedAt(t), readProcessedSlotIndex: readProcessed })) {
      reads.push(t - B);
      last = t;
      readProcessed = processedAt(t);
    }
  }
  return reads;
}

describe('standings refresh after a slot boundary', () => {
  it('reads when the display clock crosses the boundary, then every 30 s for five minutes, then stops', () => {
    expect(STANDINGS_REFRESH_MS).toBe(30_000);
    expect(STANDINGS_SETTLE_WINDOW_MS).toBe(5 * 60_000);
    const unsettled = () => ENDED - 1;
    expect(readsBetween(B - 10 * 60_000, B + 20 * 60_000, unsettled)).toEqual(Array.from({ length: 10 }, (_, i) => i * 30_000));
    // Without an owner the window is the same.
    expect(readsBetween(B - 10 * 60_000, B + 20 * 60_000, () => null)).toEqual(Array.from({ length: 10 }, (_, i) => i * 30_000));
  });

  it('stops once the owner’s processed slot reaches the slot that ended, after one read that follows it', () => {
    // Settled before the boundary read: that read is the last.
    expect(readsBetween(B - 60_000, B + 20 * 60_000, t => (t >= B ? ENDED : ENDED - 1))).toEqual([0]);
    // Settled 45 s after the boundary: one read at once, then none.
    expect(readsBetween(B - 60_000, B + 20 * 60_000, t => (t >= B + 45_000 ? ENDED : ENDED - 1))).toEqual([0, 30_000, 45_000]);
  });

  it('reads nothing during the rest of the slot, and again when the clock is moved back', () => {
    const unsettled = () => ENDED - 1;
    expect(readsBetween(B + 6 * 60_000, B + 70 * 60_000, unsettled, B + 6 * 60_000)).toEqual([]);
    expect(standingsRefreshDue({ nowMs: B + 60_000, lastReadMs: B + 90_000, processedSlotIndex: null, readProcessedSlotIndex: null })).toBe(true);
    // A first read after a long hidden tab still happens once, even after the window.
    expect(standingsRefreshDue({ nowMs: B + 30 * 60_000, lastReadMs: B - 1000, processedSlotIndex: null, readProcessedSlotIndex: null })).toBe(true);
  });
});

describe('standings pages', () => {
  const reader = { standings: async (league: LeagueId, cursor?: string) => arenaStandingsPage(league, cursor) };

  it('reads as many pages as were loaded, so a refresh keeps the rows loaded with More', async () => {
    const one = await readStandingsPages(reader, 'bronze', 1);
    expect(one).toMatchObject({ league: 'bronze', pages: 1, seasonId: 'fixture-season-1', archived: false });
    expect(one.rows).toEqual(ARENA_STANDINGS.bronze.slice(0, 50));
    expect(one.nextCursor).not.toBeNull();
    const two = await readStandingsPages(reader, 'bronze', 2);
    expect(two).toMatchObject({ pages: 2, nextCursor: null });
    expect(two.rows).toEqual(ARENA_STANDINGS.bronze);
    // Asking for more pages than exist stops at the last one.
    expect(await readStandingsPages(reader, 'bronze', 5)).toEqual(two);
    expect((await readStandingsPages(reader, 'silver', 3)).rows).toEqual(ARENA_STANDINGS.silver);
  });

  it('stops when a reader ignores the cursor, without repeating rows', async () => {
    const ignoring = { standings: async (league: LeagueId) => arenaStandingsPage(league) };
    const read = await readStandingsPages(ignoring, 'bronze', 3);
    expect(read).toMatchObject({ pages: 1, nextCursor: null });
    expect(read.rows).toEqual(ARENA_STANDINGS.bronze.slice(0, 50));
  });
});
