import { expect, test } from 'vitest';
import { createFixtureGateway, FIXTURE_ARENA } from '../../src/lib/api/fixture-gateway';

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
  // The owner, plus the current slot's Arena entrants (Task 17).
  expect(world.actors).toHaveLength(14);
  const actor = world.actors[0];
  expect(actor.name).toBe('Aster');
  expect(actor.location).toBe('training');
  for (const a of world.actors) {
    for (const field of ['ownerId', 'wallets', 'inventory', 'schedule', 'seed', 'encounterPlan']) expect(a).not.toHaveProperty(field);
    // The camp projection never carries a battle log.
    expect(a.visibleStage?.battleLog).toBeUndefined();
  }
  expect(world.actors.slice(1).every(a => a.location === 'arena' && a.visibleStage?.kind === 'staging')).toBe(true);
  const revision = await gateway.revision();
  expect(revision).toEqual({ revision: world.revision, serverNowMs: world.serverNowMs, slotIndex: world.slotIndex });
});

test('unimplemented fixture reads reject explicitly as unavailable', async () => {
  const gateway = createFixtureGateway();
  await expect(gateway.market()).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.timeline('9fce3cd5-e831-4a66-8ca1-16b4576b1499')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.profile('1f205d8f-cd7b-4631-9b4d-a22ef6614e70')).rejects.toMatchObject({ code: 'unavailable' });
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

test('fixture expedition timelines resolve by activity id, and unknown ids stay unavailable', async () => {
  const { EXPEDITION_FIXTURES, EXPEDITION_FIXTURE_TIMELINES, EXPEDITION_SAMPLES } = await import('../fixtures/expeditions');
  const { FIXTURE_EXPEDITIONS } = await import('../../src/lib/api/fixture-gateway');
  const gateway = createFixtureGateway();
  for (const [key, fixture] of Object.entries(EXPEDITION_FIXTURES)) {
    const timeline = await gateway.timeline(fixture.activityId);
    expect(timeline, key).toEqual(EXPEDITION_FIXTURE_TIMELINES[key as keyof typeof EXPEDITION_FIXTURES]);
    // Callers get their own copy.
    timeline.stages.length = 0;
    expect((await gateway.timeline(fixture.activityId)).stages.length, key).toBeGreaterThan(0);
  }
  expect(FIXTURE_EXPEDITIONS).toEqual(EXPEDITION_SAMPLES);
  expect(FIXTURE_EXPEDITIONS.map(e => e.activityId)).toEqual(Object.values(EXPEDITION_FIXTURES).map(e => e.activityId));
  await expect(gateway.timeline('0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e')).rejects.toMatchObject({ code: 'unavailable' });
  // The replay samples are still served alongside.
  const { REPLAY_FIXTURES } = await import('../fixtures/battles');
  expect((await gateway.timeline(REPLAY_FIXTURES.pvp.activityId)).activityId).toBe(REPLAY_FIXTURES.pvp.activityId);
});

test('fixture expedition timelines hold every stage; the display clock reveals only those due', async () => {
  const { EXPEDITION_FIXTURES } = await import('../fixtures/expeditions');
  const { renderExpeditionStage } = await import('../../src/game/expedition-stage');
  const gateway = createFixtureGateway();
  // The gateway has no clock: the outpost run (server time minute 65) already holds its arrival stage.
  const outpost = await gateway.timeline(EXPEDITION_FIXTURES.outpost.activityId);
  expect(outpost.stages.some(s => s.revealedAtMs > outpost.serverNowMs)).toBe(true);
  for (const fixture of Object.values(EXPEDITION_FIXTURES)) {
    const timeline = await gateway.timeline(fixture.activityId);
    const state = renderExpeditionStage(timeline, timeline.serverNowMs);
    const due = timeline.stages.filter(s => s.revealedAtMs <= timeline.serverNowMs).map(s => s.id);
    expect(state.stages.map(s => s.id), fixture.label).toEqual(due);
    if (!fixture.owner) expect(timeline.summary, fixture.label).toBeUndefined();
  }
  expect(renderExpeditionStage(outpost, outpost.serverNowMs).phase).toBe('safe-return');
});

test('fixture Arena timelines pair both entrants of a bout and keep spectators free of rewards', async () => {
  const { ARENA_TIMELINES, ARENA_WORLD_ACTORS, arenaActivityId, arenaBattleId } = await import('../fixtures/arena');
  const gateway = createFixtureGateway();
  const [bellator, corvina] = ['bellator', 'corvina'].map(name => ARENA_WORLD_ACTORS.find(a => a.name.toLowerCase() === name)!);
  const timelines = await Promise.all([bellator, corvina].map(a => gateway.timeline(a.activityId!)));
  expect(timelines.map(t => t.stages.find(s => s.kind === 'bout')!.battleLog!.battleId)).toEqual([arenaBattleId('campOne'), arenaBattleId('campOne')]);
  expect(timelines.every(t => t.summary === undefined)).toBe(true);
  expect(await gateway.timeline(arenaActivityId('ownerHumanWin'))).toEqual(ARENA_TIMELINES[arenaActivityId('ownerHumanWin')]);
  expect(FIXTURE_ARENA.map(s => s.activityId)).toContain(arenaActivityId('ownerNpcWin'));
  // Callers get copies.
  const first = await gateway.timeline(arenaActivityId('ownerHumanWin'));
  first.summary!.rewards.renown = 999;
  expect((await gateway.timeline(arenaActivityId('ownerHumanWin'))).summary!.rewards.renown).toBe(10);
});

test('fixture standings page each league at most 50 rows, and profiles carry the standings rating', async () => {
  const gateway = createFixtureGateway();
  const first = await gateway.standings('bronze');
  expect(first).toMatchObject({ league: 'bronze', archived: false });
  expect(first.rows).toHaveLength(50);
  const read = gateway.standings as (league: 'bronze', cursor?: string) => ReturnType<typeof gateway.standings>;
  const second = await read('bronze', first.nextCursor!);
  expect(second.rows[0].rank).toBe(51);
  expect(second.nextCursor).toBeNull();
  expect((await gateway.standings('champion')).rows).toEqual([]);
  const aster = await gateway.profile('0d5f8471-d919-428f-9ab7-058c95821757');
  expect(aster).toMatchObject({ actor: { name: 'Aster' }, rating: 1000 });
  expect(first.rows.find(r => r.name === 'Aster')!.rating).toBe(aster.rating);
  first.rows[0].rating = -1;
  expect((await gateway.standings('bronze')).rows[0].rating).not.toBe(-1);
});

test('fixture tournaments serve each sample view by id as a copy; unknown ids stay unavailable', async () => {
  const { TOURNAMENT_SAMPLES, TOURNAMENT_VIEWS, tournamentId } = await import('../fixtures/tournaments');
  const { FIXTURE_TOURNAMENTS } = await import('../../src/lib/api/fixture-gateway');
  const gateway = createFixtureGateway();
  expect(FIXTURE_TOURNAMENTS).toEqual(TOURNAMENT_SAMPLES);
  for (const [key, view] of Object.entries(TOURNAMENT_VIEWS)) {
    const read = await gateway.tournament(tournamentId(key as keyof typeof TOURNAMENT_VIEWS));
    expect(read, key).toEqual(view);
    // Callers get their own copy.
    read.entrants.length = 0;
    read.placements.length = 0;
    expect(await gateway.tournament(view.id), key).toEqual(view);
  }
  await expect(gateway.tournament('tournament:1:bronze')).rejects.toMatchObject({ code: 'unavailable' });
  // The opt-in command is refused like every fixture command, and the owner's flag stays off.
  const result = await gateway.command({ kind: 'set-tournament-opt-in', operationId: '5d1f0b9e-8a43-4b55-9c7e-2f6a1d3c4b5e', enabled: true });
  expect(result).toEqual({ ok: false, code: 'unavailable' });
  expect((await gateway.owner()).tournamentOptIn).toBe(false);
});
