import type { GameGateway } from './gateway';
import { worldFixture } from '../../../tests/fixtures/domain';
import { REPLAY_SAMPLES, REPLAY_TIMELINES } from '../../../tests/fixtures/battles';
import { EXPEDITION_SAMPLES, EXPEDITION_TIMELINES } from '../../../tests/fixtures/expeditions';
import { ARENA_OWNER, ARENA_PROFILES, ARENA_SAMPLES, ARENA_TIMELINES, ARENA_WORLD_ACTORS, arenaStandingsPage } from '../../../tests/fixtures/arena';
import { TOURNAMENT_OWNER_TIMELINES, TOURNAMENT_SAMPLES, TOURNAMENT_VIEWS_BY_ID } from '../../../tests/fixtures/tournaments';
import { RESULTS_FIXTURE } from '../../../tests/fixtures/results';
import { withoutTournamentLogs } from '../../game/tournament-stage';

/** Sample replays the fixture game page links to. */
export const FIXTURE_REPLAYS: readonly { activityId: string; label: string }[] = REPLAY_SAMPLES;
/** Sample expeditions the fixture game page links to. */
export const FIXTURE_EXPEDITIONS: readonly { activityId: string; label: string }[] = EXPEDITION_SAMPLES;
/** Sample Arena activities the fixture game page opens in its Arena card, with each entrant's gladiator. */
export const FIXTURE_ARENA: readonly { activityId: string; label: string; gladiatorId: string }[] = ARENA_SAMPLES;
/**
 * Sample tournaments the fixture game page opens in its Tournaments panel (engine-generated public views), with the
 * server time each was projected at.
 */
export const FIXTURE_TOURNAMENTS: readonly { id: string; label: string; asOfMs: number }[] = TOURNAMENT_SAMPLES;
// The owner's own settled tournament activities carry its credited summary, read by the Tournaments panel (Task 19 2b).
const FIXTURE_TIMELINES = { ...REPLAY_TIMELINES, ...EXPEDITION_TIMELINES, ...ARENA_TIMELINES, ...TOURNAMENT_OWNER_TIMELINES };
/** The owner plus the current slot's Arena entrants, warming up at the fixture time (minute 40). */
const FIXTURE_WORLD = { ...worldFixture, actors: [...worldFixture.actors, ...ARENA_WORLD_ACTORS] };

/** Pure local preview: no transport, auth session, storage, clock, or side effects. */
export function createFixtureGateway(): GameGateway {
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error('This read is unavailable in the fixture preview.'), { code: 'unavailable' as const });
  };
  return {
    command: async () => ({ ok: false, code: 'unavailable' }),
    // The owner fixture with the rating and renown of its credited Arena samples.
    owner: async () => structuredClone(ARENA_OWNER),
    world: async () => structuredClone(FIXTURE_WORLD),
    revision: async () => ({ revision: worldFixture.revision, serverNowMs: worldFixture.serverNowMs, slotIndex: worldFixture.slotIndex }),
    // Sample timelines with engine-generated battle logs; every other activity stays unavailable. Expedition and Arena
    // samples hold every stage of their slot (no clock here): views show only the stages revealed by their display time.
    timeline: async id => (Object.hasOwn(FIXTURE_TIMELINES, id) ? structuredClone(FIXTURE_TIMELINES[id]) : unavailable()),
    profile: async id => (Object.hasOwn(ARENA_PROFILES, id) ? structuredClone(ARENA_PROFILES[id]) : unavailable()),
    // Pages of at most 50 rows; the optional cursor (absent from GameGateway.standings) selects the next page.
    standings: async (league, cursor?: string) => arenaStandingsPage(league, cursor),
    // Public tournament views, each projected at its own server time (no clock here): the panel shows only the results
    // its display time has reached. As the live read, a view carries each fought bout's fight summary and no battle log;
    // the log of a revealed bout loads on demand. Every other tournament id stays unavailable.
    tournament: async id => (Object.hasOwn(TOURNAMENT_VIEWS_BY_ID, id) ? withoutTournamentLogs(structuredClone(TOURNAMENT_VIEWS_BY_ID[id])) : unavailable()),
    tournamentLog: async boutId => {
      const id = typeof boutId === 'string' ? boutId.split(':').slice(0, 3).join(':') : '';
      if (!Object.hasOwn(TOURNAMENT_VIEWS_BY_ID, id)) return unavailable();
      const log = TOURNAMENT_VIEWS_BY_ID[id].bouts.find(b => b.id === boutId)?.revealedResult?.battleLog;
      if (!log) throw Object.assign(new Error('This bout has no revealed log in the fixture preview.'), { code: 'not-found' as const });
      return structuredClone(log);
    },
    // Settled results from the fixture timelines, newest first, paged as the live read is. The cursor is opaque: an unknown one
    // ends the list with an empty page.
    recent: async cursor => {
      const previous = cursor === undefined ? -1 : RESULTS_FIXTURE.findIndex(page => page.nextCursor === cursor);
      if (cursor !== undefined && previous < 0) return { rows: [], nextCursor: null };
      return structuredClone(RESULTS_FIXTURE[previous + 1]);
    },
    market: unavailable,
  };
}
