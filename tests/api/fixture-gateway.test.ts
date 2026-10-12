import { expect, test } from 'vitest';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';

test('fixture commands cannot mutate even the local owner preview', async () => {
  const gateway = createFixtureGateway();
  const before = await gateway.owner();
  const result = await gateway.command({
    kind: 'edit-schedule', operationId: 'd43f7844-52e0-4302-b8e4-740035047765',
    expectedVersion: 1, phase: 'morning', choice: { kind: 'arena' },
  });
  expect(result).toEqual({ ok: false, code: 'unavailable' });
  expect((await gateway.owner()).schedule).toEqual(before.schedule);
});

test('fixture owner reads cannot share mutable state with callers', async () => {
  const gateway = createFixtureGateway();
  const owner = await gateway.owner();
  owner.wallets.money = 99999;
  owner.currentBuild.allocations.strength = 99999;
  expect((await gateway.owner()).wallets.money).toBe(100);
  expect((await gateway.owner()).currentBuild.allocations.strength).toBe(2);
});

test('fixture public actors omit private owner management state', async () => {
  const gateway = createFixtureGateway();
  const world = await gateway.world();
  expect(world.actors).toHaveLength(1);
  const actor = world.actors[0];
  expect(actor.name).toBe('Aster');
  expect(actor.location).toBe('training');
  for (const field of ['ownerId', 'wallets', 'inventory', 'schedule', 'seed', 'encounterPlan']) {
    expect(actor).not.toHaveProperty(field);
  }
  const revision = await gateway.revision();
  expect(revision).toEqual({ revision: world.revision, serverNowMs: world.serverNowMs, slotIndex: world.slotIndex });
});

test('unimplemented fixture reads reject explicitly as unavailable', async () => {
  const gateway = createFixtureGateway();
  await expect(gateway.market()).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.timeline('9fce3cd5-e831-4a66-8ca1-16b4576b1499')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.profile('0d5f8471-d919-428f-9ab7-058c95821757')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.standings('bronze')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.tournament('1f205d8f-cd7b-4631-9b4d-a22ef6614e70')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.recent()).rejects.toMatchObject({ code: 'unavailable' });
});

test('fixture timelines reveal the sample battle logs and their saved summaries', async () => {
  const { REPLAY_FIXTURES, FIXTURE_BATTLE_LOGS } = await import('../fixtures/battles');
  const gateway = createFixtureGateway();
  const battles = async (id: string) => (await gateway.timeline(id)).stages.filter(s => s.battleLog).map(s => s.battleLog!.battleId);
  expect(await battles(REPLAY_FIXTURES.pvp.activityId)).toEqual(['fixture-bout-pvp']);
  expect(await battles(REPLAY_FIXTURES.npc.activityId)).toEqual(['fixture-bout-npc']);
  expect(await battles(REPLAY_FIXTURES.tie.activityId)).toEqual(['fixture-bout-tie']);
  expect(await battles(REPLAY_FIXTURES.expedition.activityId)).toEqual([...REPLAY_FIXTURES.expedition.battleIds]);
  const pvp = await gateway.timeline(REPLAY_FIXTURES.pvp.activityId);
  expect(pvp.activityId).toBe(REPLAY_FIXTURES.pvp.activityId);
  expect(pvp.stages.find(s => s.battleLog)!.battleLog).toEqual(FIXTURE_BATTLE_LOGS.pvp);
  expect(pvp.summary).toMatchObject({ resolvedKind: 'arena', result: 'victory', rewards: { renown: 10 }, replayExpiry: { state: 'available' } });
  // A revealed bout whose rewards are not yet credited carries no summary.
  expect((await gateway.timeline(REPLAY_FIXTURES.tie.activityId)).summary).toBeUndefined();
  const expired = await gateway.timeline(REPLAY_FIXTURES.expired.activityId);
  expect(expired.stages.some(s => s.battleLog)).toBe(false);
  expect(expired.summary).toMatchObject({ result: 'defeat', replayExpiry: { state: 'expired' }, rewards: { renown: 2 } });
});

test('fixture summaries agree with the logged winners', async () => {
  const { REPLAY_FIXTURES } = await import('../fixtures/battles');
  const gateway = createFixtureGateway();
  for (const key of ['pvp', 'npc', 'expedition'] as const) {
    const timeline = await gateway.timeline(REPLAY_FIXTURES[key].activityId);
    const won = timeline.stages.filter(s => s.battleLog).every(s => s.battleLog!.winnerId === s.battleLog!.participants[0].id);
    expect(timeline.summary!.success, key).toBe(won);
  }
});

test('fixture timelines cannot share mutable state with callers', async () => {
  const { REPLAY_FIXTURES } = await import('../fixtures/battles');
  const gateway = createFixtureGateway();
  const first = await gateway.timeline(REPLAY_FIXTURES.pvp.activityId);
  (first.stages[1].battleLog!.finalHp as unknown as number[])[0] = 999;
  first.summary!.rewards.renown = 999;
  const again = await gateway.timeline(REPLAY_FIXTURES.pvp.activityId);
  expect(again.stages[1].battleLog!.finalHp[0]).not.toBe(999);
  expect(again.summary!.rewards.renown).toBe(10);
});
