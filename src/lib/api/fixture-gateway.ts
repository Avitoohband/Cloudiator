import type { GameGateway } from './gateway';
import { ownerFixture, worldFixture } from '../../../tests/fixtures/domain';
import { REPLAY_SAMPLES, REPLAY_TIMELINES } from '../../../tests/fixtures/battles';

/** Sample replays the fixture game page links to. */
export const FIXTURE_REPLAYS: readonly { activityId: string; label: string }[] = REPLAY_SAMPLES;

/** Pure local preview: no transport, auth session, storage, clock, or side effects. */
export function createFixtureGateway(): GameGateway {
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error('This read is unavailable in the fixture preview.'), { code: 'unavailable' as const });
  };
  return {
    command: async () => ({ ok: false, code: 'unavailable' }),
    owner: async () => structuredClone(ownerFixture),
    world: async () => structuredClone(worldFixture),
    revision: async () => ({ revision: worldFixture.revision, serverNowMs: worldFixture.serverNowMs, slotIndex: worldFixture.slotIndex }),
    // Revealed sample timelines with engine-generated battle logs; every other activity stays unavailable.
    timeline: async id => (Object.hasOwn(REPLAY_TIMELINES, id) ? structuredClone(REPLAY_TIMELINES[id]) : unavailable()),
    profile: unavailable, market: unavailable,
    standings: unavailable, tournament: unavailable, recent: unavailable,
  };
}
