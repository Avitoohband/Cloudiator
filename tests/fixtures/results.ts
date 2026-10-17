// Recent results for the fixture preview: the public completion of every settled activity in the fixture timelines, newest
// first, as the live `recent_results` read serves them (Task 13.2). A completion holds only what a spectator may see (what
// happened, how it ended and when), never the owner's rewards, receipt or rating change. Only the tournament timelines carry
// a `completion`; for the others it is the six public fields of their settled summary. Training and Rest have no replay, so
// the fixtures hold no timeline for them: two plain completions stand in, 3 and 4 slots ago, where Varro and Cassia
// have no other fixture activity (theirs are 1 and 2 slots ago; 13.2 review). Aster's independent sample sets (Arena
// samples, replays, expeditions) still share some slots. Like arena.ts, this imports the engine-generated
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
const ROWS: ResultRow[] = [
  ...(Object.keys(ARENA_ACTIVITIES) as ArenaActivityKey[]).flatMap(key => rowOf(ARENA_GLADIATORS[ARENA_ACTIVITIES[key].gladiator], ARENA_TIMELINES[arenaActivityId(key)])),
  ...Object.values(REPLAY_TIMELINES).flatMap(timeline => rowOf(aster, timeline)),
  ...(Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[]).flatMap(key =>
    rowOf(EXPEDITION_FIXTURES[key].owner ? EXPEDITION_GLADIATORS.aster : EXPEDITION_GLADIATORS.varro, EXPEDITION_FIXTURE_TIMELINES[key])),
  ...Object.values(TOURNAMENT_OWNER_TIMELINES).flatMap(timeline => rowOf(aster, timeline)),
  plainRow(varro, 'training', 3), plainRow(cassia, 'rest', 4),
].sort((a, b) => b.summary.settledAtMs - a.summary.settledAtMs || (a.summary.activityId < b.summary.activityId ? -1 : 1));

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
