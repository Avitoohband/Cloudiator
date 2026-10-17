// Recent results for the fixture preview: the public completion of every settled activity in the fixture timelines, newest
// first, as the live `recent_results` read serves them (Task 13.2). A completion holds only what a spectator may see (what
// happened, how it ended and when), never the owner's rewards, receipt or rating change. Only the tournament timelines carry
// a `completion`; for the others it is the six public fields of their settled summary. Training and Rest have no replay, so
// the fixtures hold no timeline for them: two plain completions stand in, 3 and 4 slots ago, where Varro and Cassia
// have no other fixture activity (theirs are 1 and 2 slots ago; 13.2 review). Aster's independent sample sets (Arena
// samples, replays, expeditions) share slots, so the feed drops a row that repeats another and moves the rest back to
// one result per gladiator a slot (13.7 review). Like arena.ts, this imports the engine-generated
// JSON through the timeline modules, so Playwright specs (whose loader cannot import JSON) must not import it.
import type { PublicActivitySummary, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import type { ResultRow, ResultsPage } from '../../supabase/functions/_shared/contracts/reads.ts';
import { worldFixture } from './domain.ts';
import { REPLAY_TIMELINES } from './battles.ts';
import { EXPEDITION_FIXTURE_TIMELINES } from './expeditions.ts';
import { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS, type ExpeditionFixtureKey } from './expedition-ids.ts';
import { ARENA_ACTIVITIES, ARENA_GLADIATORS, ARENA_TIMELINES, arenaActivityId, fixtureUuid, type ArenaActivityKey } from './arena.ts';
import { TOURNAMENT_OWNER_TIMELINES } from './tournaments.ts';

const SLOT_MS = 4_800_000;
const RESULTS_PAGE = 50;
/** The fixture world's current slot; its previous slot's activities settled when it began. */
const SLOT_START = worldFixture.serverNowMs - (worldFixture.serverNowMs % SLOT_MS);
const { aster, varro, cassia } = ARENA_GLADIATORS;

/** The public completion of a settled timeline, or null while its result is not credited. */
function completionOf(timeline: RevealedTimeline): PublicActivitySummary | null {
  if (timeline.completion) return structuredClone(timeline.completion);
  const summary = timeline.summary;
  return summary ? { activityId: summary.activityId, resolvedKind: summary.resolvedKind, result: summary.result, success: summary.success,
    settledAtMs: summary.settledAtMs, replayExpiry: structuredClone(summary.replayExpiry) } : null;
}
function rowOf(gladiator: { id: string; name: string }, timeline: RevealedTimeline): ResultRow[] {
  const summary = completionOf(timeline);
  return summary ? [{ gladiatorId: gladiator.id, name: gladiator.name, summary }] : [];
}
/**
 * A Training or Rest completion of the slot `slotsAgo` slots before the current one (as ARENA_ACTIVITIES counts them),
 * settled at that slot's end. It has no replay.
 */
function plainRow(gladiator: { id: string; name: string }, kind: 'training' | 'rest', slotsAgo: number): ResultRow {
  return { gladiatorId: gladiator.id, name: gladiator.name, summary: { activityId: fixtureUuid(`results-${kind}-${gladiator.name}`),
    resolvedKind: kind, result: 'completed', success: true, settledAtMs: SLOT_START - (slotsAgo - 1) * SLOT_MS, replayExpiry: { state: 'expired' } } };
}

/** Newest first, then by activity id: the order of the live read. */
const newestFirst = (a: ResultRow, b: ResultRow) => b.summary.settledAtMs - a.summary.settledAtMs || (a.summary.activityId < b.summary.activityId ? -1 : 1);
/** A result settles at its slot's end or shortly after it (an expedition's return): the latest slot boundary at or before it. */
const slotOf = (settledAtMs: number) => Math.floor(settledAtMs / SLOT_MS);

/**
 * One result per gladiator a slot, as a live feed has (13.7 review): newest first, a row that says what an earlier one
 * says (the same gladiator, kind, result and time) is dropped, and a row whose gladiator already has a result in its slot
 * moves back whole slots to the newest one free, so each gladiator's rows keep their order. Only the feed's times move
 * (with the replay expiry, which keeps its distance); the timelines keep theirs. Deterministic: no clock, no randomness.
 */
function oneResultASlot(rows: readonly ResultRow[]): ResultRow[] {
  const said = new Set<string>();
  const taken = new Map<string, Set<number>>();
  const feed: ResultRow[] = [];
  for (const row of [...rows].sort(newestFirst)) {
    const { summary } = row;
    const says = `${row.gladiatorId}|${summary.resolvedKind}|${summary.result}|${summary.settledAtMs}`;
    if (said.has(says)) continue;
    said.add(says);
    const slots = taken.get(row.gladiatorId) ?? new Set<number>();
    let slot = slotOf(summary.settledAtMs);
    while (slots.has(slot)) slot -= 1;
    taken.set(row.gladiatorId, slots.add(slot));
    const back = (slotOf(summary.settledAtMs) - slot) * SLOT_MS;
    feed.push(back === 0 ? row : { ...row, summary: { ...summary, settledAtMs: summary.settledAtMs - back,
      replayExpiry: summary.replayExpiry.state === 'available' ? { state: 'available', expiresAtMs: summary.replayExpiry.expiresAtMs - back } : summary.replayExpiry } });
  }
  return feed.sort(newestFirst);
}

const ROWS: ResultRow[] = oneResultASlot([
  ...(Object.keys(ARENA_ACTIVITIES) as ArenaActivityKey[]).flatMap(key => rowOf(ARENA_GLADIATORS[ARENA_ACTIVITIES[key].gladiator], ARENA_TIMELINES[arenaActivityId(key)])),
  ...Object.values(REPLAY_TIMELINES).flatMap(timeline => rowOf(aster, timeline)),
  ...(Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[]).flatMap(key =>
    rowOf(EXPEDITION_FIXTURES[key].owner ? EXPEDITION_GLADIATORS.aster : EXPEDITION_GLADIATORS.varro, EXPEDITION_FIXTURE_TIMELINES[key])),
  ...Object.values(TOURNAMENT_OWNER_TIMELINES).flatMap(timeline => rowOf(aster, timeline)),
  plainRow(varro, 'training', 3), plainRow(cassia, 'rest', 4),
]);

/**
 * Pages of `size` rows with the live read's cursor: a full page names its last row as `settledAtMs:activityId` (a page
 * cannot tell whether another follows, so an exact multiple ends with an empty page).
 */
export function resultPages(rows: readonly ResultRow[], size = RESULTS_PAGE): ResultsPage[] {
  const pages: ResultsPage[] = [];
  for (let at = 0; ; at += size) {
    const page = rows.slice(at, at + size), last = page.at(-1);
    pages.push({ rows: page, nextCursor: last && page.length === size ? `${last.summary.settledAtMs}:${last.summary.activityId}` : null });
    if (page.length < size) return pages;
  }
}

/** The fixture gateway's `recent()` pages: one, since the fixtures hold fewer than 50 results. */
export const RESULTS_FIXTURE: ResultsPage[] = resultPages(ROWS);
