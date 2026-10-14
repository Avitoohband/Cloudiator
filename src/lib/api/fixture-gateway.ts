import type { GameGateway } from './gateway';
import { ownerFixture, worldFixture } from '../../../tests/fixtures/domain';
import { REPLAY_SAMPLES, REPLAY_TIMELINES } from '../../../tests/fixtures/battles';
import { EXPEDITION_SAMPLES, EXPEDITION_TIMELINES } from '../../../tests/fixtures/expeditions';
import { ARENA_PROFILES, ARENA_SAMPLES, ARENA_TIMELINES, ARENA_WORLD_ACTORS, arenaStandingsPage } from '../../../tests/fixtures/arena';

/** Sample replays the fixture game page links to. */
export const FIXTURE_REPLAYS: readonly { activityId: string; label: string }[] = REPLAY_SAMPLES;
/** Sample expeditions the fixture game page links to. */
export const FIXTURE_EXPEDITIONS: readonly { activityId: string; label: string }[] = EXPEDITION_SAMPLES;
/** Sample Arena activities the fixture game page opens in its Arena card, with each entrant's gladiator. */
export const FIXTURE_ARENA: readonly { activityId: string; label: string; gladiatorId: string }[] = ARENA_SAMPLES;
const FIXTURE_TIMELINES = { ...REPLAY_TIMELINES, ...EXPEDITION_TIMELINES, ...ARENA_TIMELINES };
/** The owner plus the current slot's Arena entrants, warming up at the fixture time (minute 40). */
const FIXTURE_WORLD = { ...worldFixture, actors: [...worldFixture.actors, ...ARENA_WORLD_ACTORS] };

/** Pure local preview: no transport, auth session, storage, clock, or side effects. */
export function createFixtureGateway(): GameGateway {
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error('This read is unavailable in the fixture preview.'), { code: 'unavailable' as const });
  };
  return {
    command: async () => ({ ok: false, code: 'unavailable' }),
    owner: async () => structuredClone(ownerFixture),
    world: async () => structuredClone(FIXTURE_WORLD),
    revision: async () => ({ revision: worldFixture.revision, serverNowMs: worldFixture.serverNowMs, slotIndex: worldFixture.slotIndex }),
    // Sample timelines with engine-generated battle logs; every other activity stays unavailable. Expedition and Arena
    // samples hold every stage of their slot (no clock here): views show only the stages revealed by their display time.
    timeline: async id => (Object.hasOwn(FIXTURE_TIMELINES, id) ? structuredClone(FIXTURE_TIMELINES[id]) : unavailable()),
    profile: async id => (Object.hasOwn(ARENA_PROFILES, id) ? structuredClone(ARENA_PROFILES[id]) : unavailable()),
    // Pages of at most 50 rows; the optional cursor (absent from GameGateway.standings) selects the next page.
    standings: async (league, cursor?: string) => arenaStandingsPage(league, cursor),
    market: unavailable, tournament: unavailable, recent: unavailable,
  };
}
