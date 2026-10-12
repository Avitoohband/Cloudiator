import { expect, test } from 'vitest';
import { createLiveGateway } from '../../src/lib/api/gateway';

test('unimplemented live reads fail explicitly instead of returning fixture authority', async () => {
  const gateway = createLiveGateway();
  const reads = [gateway.world(), gateway.revision(), gateway.timeline('activity'), gateway.profile('gladiator'),
    gateway.market(), gateway.standings('bronze'), gateway.tournament('tournament'), gateway.recent()];
  await Promise.all(reads.map(read => expect(read).rejects.toMatchObject({ code: 'unavailable' })));
  await expect(gateway.command({ kind: 'edit-schedule', operationId: 'd43f7844-52e0-4302-b8e4-740035047765',
    expectedVersion: 1, phase: 'morning', choice: { kind: 'arena' } })).resolves.toEqual({ ok: false, code: 'unavailable' });
});
