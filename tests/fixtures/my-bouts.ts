// The fixture owner Aster's own settled Arena and tournament bouts, newest first: what My bouts lists in the fixture preview
// (`?mode=fixture`, world time Sat 10 Oct 2026 00:40 UTC) and what a live-mode browser spec can serve as `LiveData.bouts`. They are
// timelines the other fixtures already hold, found by activity id: the five credited Arena samples, the older Arena bout whose replay
// is gone, and the two tournament runs of the sample tournaments (Aster out in the first round, and a two-entrant final). Each
// carries the owner's settled summary; the delayed bout (no summary), a spectator's side of a bout and the older replay samples are
// not Aster's bouts. This module imports no JSON, so browser specs can use it: the ids are here, the timelines come from a pool the
// caller builds (the fixture gateway from the committed modules, a spec from the log files it reads, as its other fixtures do).
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import { arenaActivityId } from './arena-ids.ts';
import { REPLAY_FIXTURES } from './replay-ids.ts';
import { tournamentActivityId } from './tournament-ids.ts';

/** The activity ids of the owner's bouts, newest first (by slot): Varro, Cassia, two NPC bouts, Severus's tie-break; the old Arena bout; the two tournaments. */
export const MY_BOUT_IDS: readonly string[] = [
  ...(['ownerHumanWin', 'ownerHumanLoss', 'ownerNpcWin', 'ownerNpcLoss', 'ownerTieBreak'] as const).map(arenaActivityId),
  REPLAY_FIXTURES.expired.activityId,
  tournamentActivityId('completed', 'aster'),
  tournamentActivityId('pair', 'aster'),
];

/** The owner's bouts' timelines, newest first, out of `pool` (timelines by activity id); a bout the pool lacks is an error, never skipped. */
export function myBoutTimelines(pool: Readonly<Record<string, RevealedTimeline>>): RevealedTimeline[] {
  return MY_BOUT_IDS.map(id => {
    const timeline = Object.hasOwn(pool, id) ? pool[id] : undefined;
    if (!timeline?.summary) throw new Error(`The fixture bout ${id} is not in the pool, or has no summary`);
    return timeline;
  });
}
