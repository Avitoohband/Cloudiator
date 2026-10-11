import type { GameGateway } from './gateway';
import { ownerFixture, worldFixture } from '../../../tests/fixtures/domain';

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
    timeline: unavailable, profile: unavailable, market: unavailable,
    standings: unavailable, tournament: unavailable, recent: unavailable,
  };
}
