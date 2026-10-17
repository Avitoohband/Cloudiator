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
  await expect(gateway.timeline('9fce3cd5-e831-4a66-8ca1-16b4576b1499')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.profile('1f205d8f-cd7b-4631-9b4d-a22ef6614e70')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.tournament('1f205d8f-cd7b-4631-9b4d-a22ef6614e70')).rejects.toMatchObject({ code: 'unavailable' });
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
  expect(aster).toMatchObject({ actor: { name: 'Aster' }, rating: 1015 });
  expect(first.rows.find(r => r.name === 'Aster')!.rating).toBe(aster.rating);
  // The owner's rating and renown include the credited sample bouts (latest: +13 rating, +10 renown).
  const owner = await gateway.owner();
  expect([owner.progression.rating, owner.wallets.renown]).toEqual([aster.rating, 25]);
  first.rows[0].rating = -1;
  expect((await gateway.standings('bronze')).rows[0].rating).not.toBe(-1);
});

test('fixture tournaments serve each sample view by id as a copy, without logs as the live read does, and each log on demand; unknown ids stay unavailable', async () => {
  const { TOURNAMENT_SAMPLES, TOURNAMENT_VIEWS, tournamentId } = await import('../fixtures/tournaments');
  const { FIXTURE_TOURNAMENTS } = await import('../../src/lib/api/fixture-gateway');
  const { withoutTournamentLogs } = await import('../../src/game/tournament-stage');
  const gateway = createFixtureGateway();
  expect(FIXTURE_TOURNAMENTS).toEqual(TOURNAMENT_SAMPLES);
  for (const [key, view] of Object.entries(TOURNAMENT_VIEWS)) {
    const read = await gateway.tournament(tournamentId(key as keyof typeof TOURNAMENT_VIEWS));
    // The polled view carries each fought bout's fight summary, never its battle log.
    expect(read, key).toEqual(withoutTournamentLogs(view));
    expect(JSON.stringify(read), key).not.toContain('battleLog');
    // Callers get their own copy.
    read.entrants.length = 0;
    read.placements.length = 0;
    expect(await gateway.tournament(view.id), key).toEqual(withoutTournamentLogs(view));
    // Each revealed fought bout's log loads on demand, as a copy; a bye or an unrevealed bout has none.
    for (const bout of view.bouts) {
      const log = bout.revealedResult?.battleLog;
      if (log) {
        const loaded = await gateway.tournamentLog(bout.id);
        expect(loaded, bout.id).toEqual(log);
        expect(loaded).not.toBe(log);
      } else await expect(gateway.tournamentLog(bout.id), bout.id).rejects.toMatchObject({ code: 'not-found' });
    }
  }
  await expect(gateway.tournament('tournament:1:bronze')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.tournamentLog('tournament:1:bronze:1:0')).rejects.toMatchObject({ code: 'unavailable' });
  // The owner's own settled tournament activity: its timeline carries its credited summary, which no public view carries.
  const { TOURNAMENT_OWNER_TIMELINES, tournamentActivityId } = await import('../fixtures/tournaments');
  const own = tournamentActivityId('completed', 'aster');
  expect(await gateway.timeline(own)).toEqual(TOURNAMENT_OWNER_TIMELINES[own]);
  expect((await gateway.timeline(own)).summary).toMatchObject({ resolvedKind: 'tournament', rewards: { money: 0, renown: 7 } });
  expect((await gateway.tournament(tournamentId('completed'))).placements.find(p => p.completion.activityId === own)).toBeTruthy();
  // The opt-in command is refused like every fixture command, and the owner's flag stays off.
  const result = await gateway.command({ kind: 'set-tournament-opt-in', operationId: '5d1f0b9e-8a43-4b55-9c7e-2f6a1d3c4b5e', enabled: true });
  expect(result).toEqual({ ok: false, code: 'unavailable' });
  expect((await gateway.owner()).tournamentOptIn).toBe(false);
});

test('fixture recent results list public completions of every kind, newest first, and no owner reward detail', async () => {
  const { RESULTS_FIXTURE } = await import('../fixtures/results');
  const { ARENA_GLADIATORS, ARENA_TIMELINES, arenaActivityId } = await import('../fixtures/arena');
  const { TOURNAMENT_OWNER_TIMELINES } = await import('../fixtures/tournaments');
  const gateway = createFixtureGateway();
  const page = await gateway.recent();
  expect(page).toEqual(RESULTS_FIXTURE[0]);
  expect(page.nextCursor).toBeNull();
  const kinds = new Set(page.rows.map(row => row.summary.resolvedKind));
  for (const kind of ['arena', 'expedition', 'tournament', 'training', 'rest'] as const) expect(kinds, kind).toContain(kind);
  // Each row names a fixture gladiator, and only the six public completion fields appear.
  const names = new Map(Object.values(ARENA_GLADIATORS).map(g => [g.id, g.name]));
  for (const row of page.rows) {
    expect(row.name, row.summary.activityId).toBe(names.get(row.gladiatorId));
    expect(Object.keys(row.summary).sort()).toEqual(['activityId', 'replayExpiry', 'resolvedKind', 'result', 'settledAtMs', 'success']);
  }
  expect(JSON.stringify(page)).not.toMatch(/rewards|receiptId|ratingDelta|overflow/);
  // The order of the live read: newest result first, then by activity id; every activity once.
  const keys = page.rows.map(row => [row.summary.settledAtMs, row.summary.activityId] as const);
  expect(keys).toEqual([...keys].sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1)));
  expect(new Set(keys.map(k => k[1])).size).toBe(keys.length);
  // A row is the public part of its timeline: a settled Arena bout by its summary, a tournament by its own completion.
  const { REPLAY_FIXTURES, REPLAY_TIMELINES } = await import('../fixtures/battles');
  const bout = page.rows.find(row => row.summary.activityId === REPLAY_FIXTURES.pvp.activityId)!;
  const { activityId, resolvedKind, result, success, settledAtMs, replayExpiry } = REPLAY_TIMELINES[REPLAY_FIXTURES.pvp.activityId].summary!;
  expect(bout).toEqual({ gladiatorId: ARENA_GLADIATORS.aster.id, name: 'Aster', summary: { activityId, resolvedKind, result, success, settledAtMs, replayExpiry } });
  // The Arena sample that says the same at the same time ("Aster won an Arena bout") is listed once (13.7 review).
  expect(ARENA_TIMELINES[arenaActivityId('ownerHumanWin')].summary).toMatchObject({ resolvedKind, result, settledAtMs });
  expect(page.rows.some(row => row.summary.activityId === arenaActivityId('ownerHumanWin'))).toBe(false);
  for (const timeline of Object.values(TOURNAMENT_OWNER_TIMELINES)) {
    expect(page.rows.find(row => row.summary.activityId === timeline.activityId)?.summary).toEqual(timeline.completion);
  }
  // A bout whose rewards are not yet credited has no result yet.
  expect(page.rows.some(row => row.summary.activityId === REPLAY_FIXTURES.tie.activityId)).toBe(false);
});

test('fixture Training and Rest results fall in slots where their gladiators did nothing else (13.2 review)', async () => {
  const { RESULTS_FIXTURE } = await import('../fixtures/results');
  const { worldFixture } = await import('../fixtures/domain');
  const { ARENA_ACTIVITIES, ARENA_GLADIATORS, ARENA_TIMELINES, arenaActivityId } = await import('../fixtures/arena');
  const { REPLAY_TIMELINES } = await import('../fixtures/battles');
  const { EXPEDITION_FIXTURE_TIMELINES } = await import('../fixtures/expeditions');
  const { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS } = await import('../fixtures/expedition-ids');
  const { TOURNAMENT_OWNER_TIMELINES } = await import('../fixtures/tournaments');
  const SLOT_MS = 4_800_000;
  // Every slot each gladiator spends on a fixture activity: its own timelines, and every bout it fights in.
  const busy = new Map<string, Set<number>>();
  const mark = (id: string | null | undefined, slot: number | null) => {
    if (!id || slot === null) return;
    busy.set(id, (busy.get(id) ?? new Set()).add(slot));
  };
  const slotOf = (t: { stages: { startedAtMs: number }[]; summary?: { settledAtMs: number }; completion?: { settledAtMs: number } }) => {
    if (t.stages.length) return Math.floor(t.stages[0].startedAtMs / SLOT_MS);
    const settled = t.summary?.settledAtMs ?? t.completion?.settledAtMs;
    return settled === undefined ? null : Math.floor(settled / SLOT_MS) - 1;
  };
  for (const key of Object.keys(ARENA_ACTIVITIES) as (keyof typeof ARENA_ACTIVITIES)[]) {
    mark(ARENA_GLADIATORS[ARENA_ACTIVITIES[key].gladiator].id, slotOf(ARENA_TIMELINES[arenaActivityId(key)]));
  }
  for (const key of Object.keys(EXPEDITION_FIXTURES) as (keyof typeof EXPEDITION_FIXTURES)[]) {
    mark((EXPEDITION_FIXTURES[key].owner ? EXPEDITION_GLADIATORS.aster : EXPEDITION_GLADIATORS.varro).id, slotOf(EXPEDITION_FIXTURE_TIMELINES[key]));
  }
  const timelines = [...Object.values(ARENA_TIMELINES), ...Object.values(REPLAY_TIMELINES), ...Object.values(EXPEDITION_FIXTURE_TIMELINES), ...Object.values(TOURNAMENT_OWNER_TIMELINES)];
  for (const t of timelines) for (const stage of t.stages) for (const p of stage.battleLog?.participants ?? []) mark(p.gladiatorId, slotOf(t));
  const rows = RESULTS_FIXTURE[0].rows;
  const plain = rows.filter(r => r.summary.resolvedKind === 'training' || r.summary.resolvedKind === 'rest');
  expect(plain.map(r => r.summary.resolvedKind).sort()).toEqual(['rest', 'training']);
  for (const row of plain) {
    const slot = Math.floor(row.summary.settledAtMs / SLOT_MS) - 1;
    const label = `${row.name} ${row.summary.resolvedKind} in slot ${slot - worldFixture.slotIndex}`;
    expect(busy.get(row.gladiatorId)?.has(slot) ?? false, label).toBe(false);
    expect(rows.filter(r => r.gladiatorId === row.gladiatorId && Math.floor(r.summary.settledAtMs / SLOT_MS) - 1 === slot), label).toEqual([row]);
    // A settled slot before the current one, at its end, as the live settlement records it.
    expect(row.summary.settledAtMs % SLOT_MS, label).toBe(0);
    expect(slot, label).toBeLessThan(worldFixture.slotIndex);
  }
});

test('fixture recent results show each gladiator at most once a slot and never the same row twice (13.7 review)', async () => {
  const { RESULTS_FIXTURE } = await import('../fixtures/results');
  const SLOT_MS = 4_800_000;
  const rows = RESULTS_FIXTURE[0].rows;
  // A result settles at its slot's end or shortly after it (an expedition's return), so the latest slot boundary at or
  // before its settlement names its slot.
  const slots = new Map<string, number[]>();
  for (const row of rows) slots.set(row.gladiatorId, [...(slots.get(row.gladiatorId) ?? []), Math.floor(row.summary.settledAtMs / SLOT_MS)]);
  for (const [gladiator, held] of slots) expect(new Set(held).size, `${rows.find(r => r.gladiatorId === gladiator)!.name}: ${held}`).toBe(held.length);
  const shown = rows.map(r => `${r.name} ${r.summary.resolvedKind} ${r.summary.result} at ${r.summary.settledAtMs}`);
  expect(new Set(shown).size, shown.join('\n')).toBe(shown.length);
  // Still one or more of every kind.
  for (const kind of ['arena', 'expedition', 'tournament', 'training', 'rest'] as const) expect(rows.some(r => r.summary.resolvedKind === kind), kind).toBe(true);
});

test('fixture recent results follow the live cursor rules, and callers get copies', async () => {
  const { RESULTS_FIXTURE, resultPages } = await import('../fixtures/results');
  const { GatewayReadError } = await import('../../src/lib/api/gateway');
  const gateway = createFixtureGateway();
  const recent = gateway.recent as (cursor?: string | null) => ReturnType<typeof gateway.recent>;
  // A well-formed cursor that no page issued ends the list with an empty page.
  expect(await gateway.recent('1791592800000:0d5f8471-d919-428f-9ab7-058c95821757')).toEqual({ rows: [], nextCursor: null });
  // A malformed one is refused with the error `readRecent` throws, whatever its type.
  for (const bad of ['not a cursor', 'bad,filter', '1791592800000', '1791592800000:not-a-uuid', '1:0d5f8471-d919-428f-9ab7-058c95821757:2',
    '99999999999999999:0d5f8471-d919-428f-9ab7-058c95821757', '9999999999999999:0d5f8471-d919-428f-9ab7-058c95821757', 42]) {
    const read = recent(bad as string);
    await expect(read, String(bad)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(read, String(bad)).rejects.toBeInstanceOf(GatewayReadError);
  }
  // No cursor, null or an empty one starts the list.
  for (const none of [undefined, null, '']) expect(await recent(none), String(none)).toEqual(RESULTS_FIXTURE[0]);
  const first = await gateway.recent();
  first.rows[0].name = 'Changed';
  first.rows.length = 1;
  expect(await gateway.recent()).toEqual(RESULTS_FIXTURE[0]);
  expect(RESULTS_FIXTURE[0].rows[0].name).not.toBe('Changed');
  // The pager: a full page's cursor is `settledAtMs:activityId` of its last row, and an exact multiple ends with an empty page.
  const rows = RESULTS_FIXTURE[0].rows;
  const pages = resultPages(rows.slice(0, 4), 2);
  const last = (i: number) => `${pages[i].rows.at(-1)!.summary.settledAtMs}:${pages[i].rows.at(-1)!.summary.activityId}`;
  expect(pages.map(p => p.rows.length)).toEqual([2, 2, 0]);
  expect(pages.map(p => p.nextCursor)).toEqual([last(0), last(1), null]);
  expect(resultPages(rows.slice(0, 3), 2).map(p => [p.rows.length, p.nextCursor === null])).toEqual([[2, false], [1, true]]);
  expect(resultPages([], 2)).toEqual([{ rows: [], nextCursor: null }]);
});

// Task 18.2: the fixture marketplace, read as the live `market` read pages it.
test('fixture market pages open offers newest first, 50 at a time, and filters by seller', async () => {
  const { FIXTURE_MARKET, marketPages } = await import('../fixtures/market');
  const { CATALOG_V1 } = await import('../../supabase/functions/_shared/domain/catalog-v1');
  const { worldFixture } = await import('../fixtures/domain');
  const { GatewayReadError } = await import('../../src/lib/api/gateway');
  const gateway = createFixtureGateway();
  const owner = await gateway.owner();
  const page = await gateway.market();
  expect(page).toEqual(FIXTURE_MARKET[0]);
  expect(page.nextCursor).toBeNull();
  const rows = [...page.rows];
  // At least six offers, across tiers, rarities and sellers, one of them the fixture owner's.
  expect(rows.length).toBeGreaterThanOrEqual(6);
  expect(new Set(rows.map(r => r.item.tier))).toEqual(new Set([1, 5, 10]));
  expect(new Set(rows.map(r => r.item.rarity))).toEqual(new Set(['common', 'uncommon', 'rare']));
  expect(new Set(rows.map(r => r.seller.gladiatorId)).size).toBeGreaterThanOrEqual(3);
  expect(rows.filter(r => r.seller.gladiatorId === owner.gladiatorId).map(r => r.seller.name)).toEqual([owner.name]);
  // The live read's order (newest listing first, then by id), one row per listing.
  const keys = rows.map(r => [r.listedAtMs, r.listingId] as const);
  expect(keys).toEqual([...keys].sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1)));
  expect(new Set(keys.map(k => k[1])).size).toBe(rows.length);
  // Each offer is open at the fixture time, lasts seven days, is priced within the market's range, and carries exactly the
  // sanitized projection's fields: its catalog entry's tier, rarity and stats, never an item id, owner, origin or reservation.
  for (const row of rows) {
    expect(row.listedAtMs, row.listingId).toBeLessThanOrEqual(worldFixture.serverNowMs);
    expect(row.expiresAtMs - row.listedAtMs, row.listingId).toBe(604_800_000);
    expect(row.expiresAtMs, row.listingId).toBeGreaterThan(worldFixture.serverNowMs);
    expect(Number.isSafeInteger(row.price) && row.price >= 1 && row.price <= 1_000_000_000, row.listingId).toBe(true);
    const entry = CATALOG_V1.items[row.item.catalogId];
    expect(row.item, row.listingId).toEqual({ catalogId: entry.id, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats, quantity: 1 });
    expect(entry.binding, row.listingId).toBe('tradable');
    expect(row.price, row.listingId).toBeGreaterThan(entry.npcSellValue!);
    expect(Object.keys(row).sort()).toEqual(['expiresAtMs', 'item', 'listedAtMs', 'listingId', 'price', 'seller']);
  }
  // One seller's offers only, as the live read filters them.
  const own = await gateway.market(undefined, owner.gladiatorId);
  expect(own).toEqual({ rows: rows.filter(r => r.seller.gladiatorId === owner.gladiatorId), nextCursor: null });
  expect(await gateway.market(undefined, '1f205d8f-cd7b-4631-9b4d-a22ef6614e70')).toEqual({ rows: [], nextCursor: null });
  // The live cursor rules: a well-formed cursor that no page issued ends the list; a malformed cursor or seller is refused.
  expect(await gateway.market(`${worldFixture.serverNowMs}:${rows[0].listingId}`)).toEqual({ rows: [], nextCursor: null });
  for (const [cursor, seller] of [['bad,filter', undefined], ['1:not-a-uuid', undefined], [undefined, 'g1'], [undefined, '']] as const) {
    const read = gateway.market(cursor, seller);
    await expect(read, `${cursor} ${seller}`).rejects.toBeInstanceOf(GatewayReadError);
    await expect(read, `${cursor} ${seller}`).rejects.toMatchObject({ code: 'unavailable' });
  }
  // Callers get copies.
  page.rows[0].price = -1;
  page.rows.length = 0;
  expect(await gateway.market()).toEqual(FIXTURE_MARKET[0]);
  expect(FIXTURE_MARKET[0].rows[0].price).not.toBe(-1);
  // The pager: a full page names its last row as `listedAtMs:listingId`, and the next page follows it.
  const pages = marketPages(rows.slice(0, 5), 2);
  expect(pages.map(p => p.rows.length)).toEqual([2, 2, 1]);
  expect(pages.map(p => p.nextCursor)).toEqual([`${rows[1].listedAtMs}:${rows[1].listingId}`, `${rows[3].listedAtMs}:${rows[3].listingId}`, null]);
  // Fixture commands still never trade.
  expect(await gateway.command({ kind: 'buy-listing', operationId: 'd43f7844-52e0-4302-b8e4-740035047765', listingId: rows[0].listingId }))
    .toEqual({ ok: false, code: 'unavailable' });
});
