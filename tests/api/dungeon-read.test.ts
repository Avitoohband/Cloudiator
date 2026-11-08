import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { ActivitySummary, PartyBattleLog, PublicActivitySummary, RevealedStage, RevealedTimeline } from '@contracts/events';
import { planDungeonRun } from '@domain/dungeon';
import { RULES_V2 } from '@domain/rules-v2';
import * as routed from '../browser/live-routes';
import { emptyWorld, liveRows, type LiveData } from '../browser/live-routes';
import { ARENA_OWNER } from '../fixtures/arena';
import { partyInput } from '../fixtures/dungeon-builds';

const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
import * as reads from '../../src/lib/api/reads';
afterEach(() => { holder.client = null; vi.restoreAllMocks(); });

const run = 'dungeon:301:wolf-den:1', otherRun = 'dungeon:301:wolf-den:2';
const id = 'd0700000-0000-4000-8000-000000000011';
const now = 1_449_600_000;
const party = partyInput('wolf-den', [{ classId: 'duelist', level: 3 }, { classId: 'guardian', level: 7 }], run);
const plan = planDungeonRun({ ...party, slotIndex: 301, startsAtMs: 301 * RULES_V2.clock.slotMs,
  seats: [party.seats[0], party.seats[1], { kind: 'bot', seat: 2, name: 'Milo', role: 'striker', level: 3,
    gladiatorId: '10000000-0000-4000-8000-000000000003', activityId: '20000000-0000-4000-8000-000000000003' }] }, 'gateway', RULES_V2);
const first = plan.fights[0].log;
const second = { ...first, battleId: `${run}:fight:2` };
const other = { ...first, battleId: `${otherRun}:fight:1` };
const wire = (run_id: string, ordinal: 1 | 2 | 3 | 4, log: PartyBattleLog, reveal_at_ms = now) => ({ run_id, ordinal, reveal_at_ms, log });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Use the same filtered Data API as the browser specs, with an optional gate on a fight response. */
function api(data: Partial<LiveData> = {}, account: string | null = null, at = () => now,
  beforeFight?: () => Promise<Response | undefined>) {
  const world = data.world ?? emptyWorld(now), full: LiveData = { ...data, world };
  const requests: { table: string; query: URLSearchParams; account: string | null }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push({ table, query: url.searchParams, account });
    if (table === 'dungeon_fights') {
      const intercepted = await beforeFight?.();
      if (intercepted) return intercepted;
    }
    const answer = liveRows(table, url.searchParams, { world, owner: data.owner ?? null, now: at(), data: full, reader: account });
    if (answer === 'refused') return json({ code: '42501', message: 'permission denied' }, 401);
    return json(table === 'world_revision' ? answer[0] : answer);
  } } });
  const session = account ? { user: { id: account }, access_token: account, expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session : null;
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(session ? { data: { session }, error: null } : { data: { session: null }, error: null });
  holder.client = client;
  return { client, gateway: createLiveGateway(), requests };
}

test('rejects malformed dungeon run keys and ordinals before reaching the transport', async () => {
  const { gateway, requests, client } = api();
  expect(typeof gateway.dungeonFight).toBe('function');
  expect(typeof reads.readDungeonFight).toBe('function');
  const invalid = [[id, 1], ['dungeon:301:elsewhere:1', 1], [`${run}:more`, 1], ['dungeon:0301:wolf-den:1', 1],
    ['dungeon:301:wolf-den:0', 1], [run, 0], [run, 5], [run, 1.5], [run, '1'], [`${run}\n`, 1]] as const;
  for (const [runId, ordinal] of invalid) {
    await expect(gateway.dungeonFight(runId, ordinal as 1)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(createFixtureGateway().dungeonFight(runId, ordinal as 1)).rejects.toMatchObject({ code: 'unavailable' });
  }
  await expect(reads.readDungeonFight(client, id, 1)).rejects.toMatchObject({ code: 'unavailable' });
  expect(requests).toEqual([]);
});

test.each([null, 'spectator'])('reads a public fight only from its exact run and ordinal once the server reveals it (%s)', async account => {
  let at = now - 1;
  const { gateway, requests } = api({ dungeonFights: [wire(run, 1, first), wire(run, 2, second, at), wire(otherRun, 1, other, at)] }, account, () => at);
  expect(typeof gateway.dungeonFight).toBe('function');
  await expect(gateway.dungeonFight(run, 1)).rejects.toMatchObject({ code: 'not-found' });
  at++;
  await expect(gateway.dungeonFight(run, 1)).resolves.toEqual(first);
  await expect(gateway.dungeonFight(run, 1)).resolves.toEqual(first);
  expect(first.participants.find(p => p.role === 'bot')).toMatchObject({ name: 'Milo', role: 'bot' });
  await expect(gateway.dungeonFight(run, 2)).resolves.toEqual(second);
  await expect(gateway.dungeonFight(otherRun, 1)).resolves.toEqual(other);
  expect(requests.map(({ table, query }) => [table, query.get('select'), query.get('run_id'), query.get('ordinal')])).toEqual([
    ['dungeon_fights', 'log', `eq.${run}`, 'eq.1'], ['dungeon_fights', 'log', `eq.${run}`, 'eq.1'],
    ['dungeon_fights', 'log', `eq.${run}`, 'eq.2'], ['dungeon_fights', 'log', `eq.${otherRun}`, 'eq.1'],
  ]);
});

test('rejects an incomplete fight log, a foreign battle ID and an event with an unknown participant', async () => {
  expect(typeof reads.readDungeonFight).toBe('function');
  for (const log of [{ ...first, finalHp: first.finalHp.slice(1) }, { ...first, battleId: other.battleId },
    { ...first, events: [{ ...first.events[0], defenderId: 'foreign' }, ...first.events.slice(1)] }]) {
    const { client } = api({ dungeonFights: [wire(run, 1, log as PartyBattleLog), wire(run, 2, second)] });
    await expect(reads.readDungeonFight(client, run, 1)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(reads.readDungeonFight(client, run, 2)).resolves.toEqual(second);
  }
});

test('coalesces a pending fight lookup and retries once the shared lookup failed', async () => {
  let parked!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { parked = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  let failure = true;
  const { gateway, requests } = api({ dungeonFights: [wire(run, 1, first)] }, null, undefined, async () => {
    if (!failure) return undefined;
    parked(); await wait;
    return json({ code: '22023', message: 'invalid stored log' }, 400);
  });
  expect(typeof gateway.dungeonFight).toBe('function');
  const one = gateway.dungeonFight(run, 1);
  await arrived;
  const both = Promise.allSettled([one, gateway.dungeonFight(run, 1)]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const whilePending = requests.length;
  release();
  expect((await both).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(whilePending).toBe(1);
  expect(requests).toHaveLength(1);
  failure = false;
  await expect(gateway.dungeonFight(run, 1)).resolves.toEqual(first);
  await expect(gateway.dungeonFight(run, 1)).resolves.toEqual(first);
  expect(requests).toHaveLength(2);
});

test('bounds the dungeon log cache and keeps a recently used fight when an older one is evicted', async () => {
  const keys = Array.from({ length: 50 }, (_, i) => `dungeon:301:wolf-den:${i + 1}`);
  const { gateway, requests } = api({ dungeonFights: keys.map(key => wire(key, 1, { ...first, battleId: `${key}:fight:1` })) });
  expect(typeof gateway.dungeonFight).toBe('function');
  for (const key of keys.slice(0, -1)) await gateway.dungeonFight(key, 1);
  await gateway.dungeonFight(keys[0], 1);
  await gateway.dungeonFight(keys[49], 1);
  const beforeRecent = requests.length;
  await gateway.dungeonFight(keys[0], 1);
  expect(requests).toHaveLength(beforeRecent);
  await gateway.dungeonFight(keys[1], 1);
  expect(requests.filter(r => r.query.get('run_id') === `eq.${keys[1]}`)).toHaveLength(2);
});

test('keeps the exact room and major pointers while loading no logs during a timeline read', async () => {
  const room: RevealedStage = { id: `${id}:1`, kind: 'room', label: 'Room 1: victory', startedAtMs: now - 1000,
    endsAtMs: now, revealedAtMs: now - 1000, fight: { runId: run, ordinal: 1 } };
  const major: RevealedStage = { ...room, id: `${id}:7`, kind: 'major', label: 'The Alpha of the Den: victory', fight: { runId: run, ordinal: 4 } };
  const withExtra = { ...room, seed: 'private', fight: { ...room.fight!, reward: 1000 } };
  const badPointer = { ...major, id: `${id}:8`, fight: { runId: id, ordinal: 4 } } as RevealedStage;
  const { gateway, requests } = api({ timelines: { [id]: { activityId: id, serverNowMs: now, visibleThroughMs: now, stages: [withExtra, major, badPointer] } } });
  const { fight: _invalid, ...majorWithoutPointer } = badPointer;
  expect((await gateway.timeline(id)).stages).toEqual([room, major, majorWithoutPointer]);
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'visible_events', 'recent_results']);
});

const completion = (dungeon: NonNullable<PublicActivitySummary['dungeon']>, success = false): PublicActivitySummary => ({
  activityId: id, resolvedKind: 'dungeon', result: success ? 'victory' : 'defeat', success, settledAtMs: now - 1,
  replayExpiry: { state: 'expired' }, dungeon,
});
const ownerSummary = (value: PublicActivitySummary): ActivitySummary => ({ ...value, receiptId: 'private-receipt',
  rewards: { xp: 6, money: 1, renown: 0, attributePoints: 0, overflowMoney: 0, items: [] } });
const timeline = (value: PublicActivitySummary): RevealedTimeline => ({ activityId: id, serverNowMs: now,
  visibleThroughMs: now, stages: [], completion: value, summary: ownerSummary(value) });

test.each([[3, false, false], [4, false, false], [1, true, false], [4, true, false], [4, true, true]] as const)(
  'retains the exact public terminal tuple after pruning (fight %i, party won %s, member success %s)', async (terminalFight, partyWon, success) => {
    const value = completion({ id: 'wolf-den', terminalFight, partyWon }, success);
    // A response with extra keys must not move a private value into the public completion, even when read by the owner.
    const wireValue = { ...ownerSummary(value), dungeon: { ...value.dungeon!, privateOutcome: 'hidden' },
      replayExpiry: { state: 'expired', privateDetail: 'hidden' } } as ActivitySummary;
    const { gateway, requests } = api({ timelines: { [id]: timeline(wireValue) } });
    expect((await gateway.recent()).rows[0].summary).toEqual(value);
    expect(await gateway.timeline(id)).toEqual({ activityId: id, serverNowMs: now, visibleThroughMs: now, stages: [], completion: value });
    expect(requests.map(r => r.table)).toEqual(['recent_results', 'world_revision', 'visible_events', 'recent_results']);
  });

test('drops an unrecognized public dungeon identifier without discarding the rest of the completion', async () => {
  const value = completion({ id: 'wolf-den', terminalFight: 4, partyWon: true });
  const { dungeon: _invalid, ...withoutDungeon } = value;
  const invalid = { ...value, dungeon: { ...value.dungeon!, id: 'constructor' } } as unknown as PublicActivitySummary;
  const { gateway } = api({ timelines: { [id]: timeline(invalid) } });
  expect((await gateway.recent()).rows[0].summary).toEqual(withoutDungeon);
  expect((await gateway.timeline(id)).completion).toEqual(withoutDungeon);
});

test('serves an owner the member’s credited dungeon rewards and keeps them from both kinds of spectator', async () => {
  const value = completion({ id: 'wolf-den', terminalFight: 4, partyWon: true }), privateSummary = ownerSummary(value);
  const data = { owner: ARENA_OWNER, ownerAccountId: 'owner', timelines: { [id]: timeline(value) }, notifications: [{ summary: privateSummary }] };
  const visitor = api(data);
  expect((await visitor.gateway.timeline(id)).summary).toBeUndefined();
  await expect(visitor.gateway.notifications()).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(visitor.requests.some(r => r.table === 'activities')).toBe(false);
  const spectator = api(data, 'spectator');
  expect((await spectator.gateway.timeline(id)).summary).toBeUndefined();
  expect((await spectator.gateway.notifications()).items).toEqual([]);
  const owner = api(data, 'owner');
  expect(await owner.gateway.timeline(id)).toMatchObject({ summary: privateSummary, completion: value });
  expect((await owner.gateway.recent()).rows[0].summary).toEqual(value);
  expect(await owner.gateway.notifications()).toEqual({ newestSettledMs: now - 1, items: [
    { activityId: id, kind: 'dungeon', settledAtMs: now - 1, summary: privateSummary, destination: 'Wolf Den', levelAfter: null },
  ] });
});

test('gives fixture preview and routed readers the same revealed fight and exact pointers', async () => {
  expect(typeof routed.dungeonLiveData).toBe('function');
  const data = routed.dungeonLiveData('member-fell-party-cleared');
  const { gateway } = api(data, null, data.serverNowMs);
  const preview = createFixtureGateway();
  const activityId = 'd0700000-0000-4000-8000-000000000004', runId = 'dungeon:373246:wolf-den:1';
  const watched = await gateway.timeline(activityId), example = await preview.timeline(activityId);
  expect(watched.stages).toEqual(example.stages);
  expect(watched.completion).toEqual(example.completion);
  expect(watched.summary).toBeUndefined();
  expect(example.summary?.rewards).toMatchObject({ xp: 12, money: 2, items: [] });
  const sample = await preview.dungeonFight(runId, 4);
  expect(sample.participants.filter(p => p.side === 0).map(p => p.role)).toEqual(['gladiator', 'bot']);
  expect(await gateway.dungeonFight(runId, 4)).toEqual(sample);
  sample.participants[0].name = 'Changed';
  expect((await preview.dungeonFight(runId, 4)).participants[0].name).not.toBe('Changed');
  await expect(preview.dungeonFight('dungeon:373243:troll-hall:1', 4)).rejects.toMatchObject({ code: 'not-found' });
});

test('the routed dungeon fixture with expired detail still exposes its public result, and its rewards to its owner', async () => {
  expect(typeof routed.dungeonLiveData).toBe('function');
  const data = routed.dungeonLiveData('member-fell-party-cleared', { expired: true, owner: ARENA_OWNER, ownerAccountId: 'owner' });
  const { gateway } = api(data, 'owner', data.serverNowMs);
  const activityId = 'd0700000-0000-4000-8000-000000000004', runId = 'dungeon:373246:wolf-den:1';
  expect(await gateway.timeline(activityId)).toMatchObject({ stages: [], completion: { result: 'defeat', dungeon: { id: 'wolf-den', terminalFight: 4, partyWon: true },
    replayExpiry: { state: 'expired' } }, summary: { rewards: { xp: 12, money: 2, items: [] } } });
  await expect(gateway.dungeonFight(runId, 4)).rejects.toMatchObject({ code: 'not-found' });
  expect((await gateway.notifications()).items[0]).toMatchObject({ destination: 'Wolf Den', summary: { rewards: { xp: 12, money: 2, items: [] } } });
});
