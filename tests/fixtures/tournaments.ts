// Tournament fixtures for the local preview: the public views committed by tests/domain/tournament-fixtures.test.ts,
// which builds each bracket with the real Task 19 domain and projects it at the server time named in
// tests/fixtures/tournament-ids.ts. The browser never runs the engine: it only reads these views. Browser specs read
// the JSON files with fs, since their loader cannot import JSON modules.
import type { TournamentView } from '../../supabase/functions/_shared/contracts/reads.ts';
import upcoming from './tournaments/upcoming.json';
import opening from './tournaments/opening.json';
import midway from './tournaments/midway.json';
import late from './tournaments/late.json';
import completed from './tournaments/completed.json';
import pair from './tournaments/pair.json';
import insufficient from './tournaments/insufficient.json';
import { TOURNAMENT_SAMPLE_KEYS, TOURNAMENTS, tournamentId, type TournamentKey } from './tournament-ids.ts';

export * from './tournament-ids.ts';

const view = (json: unknown) => json as TournamentView;
export const TOURNAMENT_VIEWS: Record<TournamentKey, TournamentView> = {
  upcoming: view(upcoming), opening: view(opening), midway: view(midway), late: view(late),
  completed: view(completed), pair: view(pair), insufficient: view(insufficient),
};
/** Views by tournament id, as gateway.tournament(id) returns them. */
export const TOURNAMENT_VIEWS_BY_ID: Record<string, TournamentView> = Object.fromEntries(Object.values(TOURNAMENT_VIEWS).map(v => [v.id, v]));
/** Tournament samples listed on the fixture game page. */
export const TOURNAMENT_SAMPLES: { id: string; label: string }[] = TOURNAMENT_SAMPLE_KEYS.map(key => ({ id: tournamentId(key), label: TOURNAMENTS[key].label }));
