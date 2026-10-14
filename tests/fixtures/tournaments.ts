// Tournament fixtures for the local preview: the public views committed by tests/domain/tournament-fixtures.test.ts,
// which builds each bracket with the real Task 19 domain and projects it at the server time named in
// tests/fixtures/tournament-ids.ts. The browser never runs the engine: it only reads these views. Browser specs read
// the JSON files with fs, since their loader cannot import JSON modules.
import type { TournamentView } from '../../supabase/functions/_shared/contracts/reads.ts';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import upcoming from './tournaments/upcoming.json';
import opening from './tournaments/opening.json';
import midway from './tournaments/midway.json';
import late from './tournaments/late.json';
import completed from './tournaments/completed.json';
import pair from './tournaments/pair.json';
import insufficient from './tournaments/insufficient.json';
import ownerTimelines from './tournaments/owner-timelines.json';
import { TOURNAMENT_SAMPLE_KEYS, TOURNAMENTS, tournamentAsOf, tournamentId, type TournamentKey } from './tournament-ids.ts';

export * from './tournament-ids.ts';

const view = (json: unknown) => json as TournamentView;
export const TOURNAMENT_VIEWS: Record<TournamentKey, TournamentView> = {
  upcoming: view(upcoming), opening: view(opening), midway: view(midway), late: view(late),
  completed: view(completed), pair: view(pair), insufficient: view(insufficient),
};
/** Views by tournament id, as gateway.tournament(id) returns them. */
export const TOURNAMENT_VIEWS_BY_ID: Record<string, TournamentView> = Object.fromEntries(Object.values(TOURNAMENT_VIEWS).map(v => [v.id, v]));
/**
 * Tournament samples listed on the fixture game page, with the server time each view was projected at: the preview
 * holds a sample's bracket there, so it shows what its label says.
 */
export const TOURNAMENT_SAMPLES: { id: string; label: string; asOfMs: number }[] = TOURNAMENT_SAMPLE_KEYS.map(key => ({
  id: tournamentId(key), label: TOURNAMENTS[key].label, asOfMs: tournamentAsOf(key),
}));
/**
 * The fixture owner's own settled tournament timelines (Aster in `completed` and `pair`), by activity id: its stages and
 * its credited summary, which the gateway's timeline read returns to the owner. No public view carries these rewards.
 */
export const TOURNAMENT_OWNER_TIMELINES: Record<string, RevealedTimeline> = ownerTimelines as unknown as Record<string, RevealedTimeline>;
