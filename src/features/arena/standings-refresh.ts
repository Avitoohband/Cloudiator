// When the standings panel reads again after a slot boundary, and how it reloads the pages it has shown. The server
// settles a slot's results shortly after its boundary (cron every minute, about a two-minute target), so one read at
// the boundary is usually too early: the panel reads at the boundary, then every 30 s for five minutes, and stops
// early once the owner's processed slot shows that slot settled. Standings change only from what the server has
// credited; nothing here adds a result. Task 13's shared sync controller replaces standingsRefreshDue.
import type { LeagueId } from '@contracts/commands';
import type { StandingRow, StandingsPage } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';

const SLOT_MS = RULES_V1.clock.slotMs;
/** Re-read this often after a boundary while results may still be settling. */
export const STANDINGS_REFRESH_MS = 30_000;
/** How long after a boundary the panel keeps re-reading. */
export const STANDINGS_SETTLE_WINDOW_MS = 5 * 60_000;
const PAGE_ROWS = 50;

export type StandingsRefresh = {
  /** The display clock now, and when the shown standings were read. */
  nowMs: number;
  lastReadMs: number;
  /** The owner's processed slot now, and when the shown standings were read (null without an owner). */
  processedSlotIndex: number | null;
  readProcessedSlotIndex: number | null;
};

/**
 * Whether the standings should be read again now: once after each slot boundary (or after the clock moved back),
 * then every 30 s during the five minutes after it, unless the shown standings were read after the owner's slot
 * settled; a settlement seen since the last read is read at once. Nothing is due later in the slot.
 */
export function standingsRefreshDue({ nowMs, lastReadMs, processedSlotIndex, readProcessedSlotIndex }: StandingsRefresh): boolean {
  const slot = Math.floor(nowMs / SLOT_MS);
  const boundary = slot * SLOT_MS;
  if (lastReadMs < boundary || lastReadMs > nowMs) return true;
  if (nowMs - boundary >= STANDINGS_SETTLE_WINDOW_MS) return false;
  const ended = slot - 1;
  if (readProcessedSlotIndex !== null && readProcessedSlotIndex >= ended) return false;
  if (processedSlotIndex !== null && processedSlotIndex >= ended) return true;
  return nowMs - lastReadMs >= STANDINGS_REFRESH_MS;
}

export type StandingsReader = { standings(league: LeagueId, cursor?: string): Promise<StandingsPage> };
export type StandingsPages = { league: LeagueId; rows: StandingRow[]; nextCursor: string | null; seasonId: string; archived: boolean; pages: number };

/** Appends the page after `cursor` to `rows`, without repeats; a reader that ignores the cursor ends the list. */
export async function readNextPage(reader: StandingsReader, loaded: StandingsPages): Promise<StandingsPages> {
  if (!loaded.nextCursor) return loaded;
  const next = await reader.standings(loaded.league, loaded.nextCursor);
  const seen = new Set(loaded.rows.map(r => r.gladiatorId));
  const fresh = next.rows.slice(0, PAGE_ROWS).filter(r => !seen.has(r.gladiatorId));
  if (!fresh.length) return { ...loaded, nextCursor: null };
  return { ...loaded, rows: [...loaded.rows, ...fresh], nextCursor: next.nextCursor, pages: loaded.pages + 1 };
}

/** The first `pages` pages of a league (at least one), so a refresh keeps every row the viewer loaded with More. */
export async function readStandingsPages(reader: StandingsReader, league: LeagueId, pages: number): Promise<StandingsPages> {
  const first = await reader.standings(league);
  let loaded: StandingsPages = { league, rows: first.rows.slice(0, PAGE_ROWS), nextCursor: first.nextCursor, seasonId: first.seasonId, archived: first.archived, pages: 1 };
  while (loaded.pages < pages && loaded.nextCursor) {
    const next = await readNextPage(reader, loaded);
    if (next.pages === loaded.pages) return next;
    loaded = next;
  }
  return loaded;
}
