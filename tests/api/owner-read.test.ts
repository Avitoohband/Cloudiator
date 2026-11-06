import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { readLooks, readOwner, readWorld } from '../../src/lib/api/reads';
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
afterEach(() => { holder.client = null; vi.restoreAllMocks(); });

// Patch 1.7 (spec "Client"; Review Focus 1): the three owner keys and a world actor's worn title read defensively. A missing key (an older
// server), junk, or an id this client does not know shows no title and never throws.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function api(answer: (table: string, query: URLSearchParams) => Response) {
  const requests: { table: string; query: URLSearchParams }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push({ table, query: url.searchParams });
    return answer(table, url.searchParams);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: null }, error: null });
  holder.client = client;
  return { client, requests };
}
const ownerRow = (over: Record<string, unknown> = {}) => json({ state: { ...ownerFixture, ...over } });
const { wornTitle: _w, titles: _t, titleProgress: _p, ...OLDER } = ownerFixture;
const TIRO = { id: 'tiro', earnedAtMs: 5, activityId: null, source: 'history', detail: null };

test('reads an owner state without the three title keys (an older server) as no titles, no worn title and no progress', async () => {
  const { client } = api(() => json({ state: OLDER }));
  const owner = await readOwner(client);
  expect([owner.titles, owner.wornTitle, owner.titleProgress]).toEqual([[], null, {}]);
  expect(owner.name).toBe(ownerFixture.name);
});

test('keeps the well-formed titles and drops a malformed row or an id this client does not know', async () => {
  const season = { id: 'champion', earnedAtMs: 9, activityId: null, source: 'season', detail: { seasonIndex: 0, league: 'silver', place: 1 } };
  const { client } = api(() => ownerRow({ titles: [TIRO, { id: 7 }, 'tiro', null, { ...TIRO, id: 'den-breaker' }, { ...TIRO, source: 'gift' }, { ...TIRO, earnedAtMs: -1 }, season,
    { ...TIRO, id: 'lion', detail: { seasonIndex: 'x' } }], wornTitle: 'tiro' }));
  const owner = await readOwner(client);
  expect(owner.titles.map(t => t.id)).toEqual(['tiro', 'champion', 'lion']);
  expect(owner.titles[1].detail).toEqual({ seasonIndex: 0, league: 'silver', place: 1 });
  // A malformed detail reads as none; the row itself is kept.
  expect(owner.titles[2].detail).toBeNull();
  expect(owner.wornTitle).toBe('tiro');
  // Not an array: none.
  expect((await readOwner(api(() => ownerRow({ titles: 'tiro' })).client)).titles).toEqual([]);
});

test('reads a worn title that is not a held 1.7 id as null', async () => {
  for (const [wornTitle, titles] of [['den-breaker', [TIRO]], [42, [TIRO]], ['lion', [TIRO]], ['tiro', []], [undefined, [TIRO]]] as const) {
    expect((await readOwner(api(() => ownerRow({ wornTitle, titles })).client)).wornTitle, String(wornTitle)).toBeNull();
  }
});

test('keeps only the whole-number progress from 0', async () => {
  const { client } = api(() => ownerRow({ titleProgress: { 'arena-wins': 18, trainings: 46.5, 'gold-earned': -1, 'days-in-camp': '21', 'items-owned': 0, x: null } }));
  expect((await readOwner(client)).titleProgress).toEqual({ 'arena-wins': 18, 'items-owned': 0 });
  expect((await readOwner(api(() => ownerRow({ titleProgress: [1, 2] })).client)).titleProgress).toEqual({});
});

test('a world actor keeps a title this client knows, and reads an unknown, junk or missing one as null', async () => {
  const actor = (id: string, extra: Record<string, unknown>) => ({ gladiator_id: id, actor: { ...worldFixture.actors[0], gladiatorId: id, ...extra } });
  const rows = [actor('a1', { title: 'lion' }), actor('a2', { title: 'den-breaker' }), actor('a3', { title: 42 }), actor('a4', {}), actor('a5', { title: null })];
  const { client } = api(table => (table === 'world_revision'
    ? json({ revision: 'r1', server_now_ms: 1, slot_index: 0, published_slot_index: null, latest_patch: null })
    : json(rows)));
  const world = await readWorld(client);
  expect(world.actors.map(a => a.title)).toEqual(['lion', null, null, null, null]);
});

test('the looks read carries the worn titles in the same single request', async () => {
  const A = '0d5f8471-d919-428f-9ab7-058c95821757', B = '5b0c3f8e-2d4a-4e61-9a7b-6c5d4e3f2a10', C = '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b', D = '1a2b3c4d-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
  const { client, requests } = api(() => json([{ gladiator_id: A, appearance: null, title: 'lion' }, { gladiator_id: B, appearance: null, title: null },
    { gladiator_id: D, appearance: null, title: 'den-breaker' }]));
  let titles: Record<string, string | null> = {};
  const looks = await readLooks(client, [A.toUpperCase(), B, C, D, 'junk'], t => { titles = t; });
  expect(requests).toHaveLength(1);
  expect(requests[0].table).toBe('world_actor_reads');
  expect(requests[0].query.get('select')).toBe('gladiator_id,appearance:actor->appearance,title:actor->>title');
  expect(requests[0].query.get('gladiator_id')).toBe(`in.(${A},${B},${C},${D})`);
  expect([...looks.keys()]).toEqual([A, B, D]);
  // An unknown id reads as no title; a gladiator the projection does not know is absent.
  expect(titles).toEqual({ [A]: 'lion', [B]: null, [D]: null });
  // A consumer that throws never fails the looks.
  expect((await readLooks(client, [A], () => { throw new Error('x'); })).size).toBe(3);
});

test('a failed looks read gives no titles and never throws, on the live and the fixture gateway', async () => {
  const { client } = api(() => json({ message: 'down' }, 500));
  const given: unknown[] = [];
  await expect(readLooks(client, ['0d5f8471-d919-428f-9ab7-058c95821757'], t => given.push(t))).rejects.toBeTruthy();
  expect(given).toEqual([]);
  // The fixture preview answers from its own world: the owner (Aster) wears Founder.
  let titles: unknown = null;
  await createFixtureGateway().looks([ownerFixture.gladiatorId], t => { titles = t; });
  expect(titles).toEqual({ [ownerFixture.gladiatorId]: 'founder' });
});

test('the fixture owner holds Aster’s 8 history titles and the mockup’s progress', async () => {
  const owner = await createFixtureGateway().owner();
  expect(owner.wornTitle).toBe('founder');
  expect(owner.titles.map(t => t.id)).toEqual(['founder', 'wanderer', 'tiro', 'bloodied', 'finalist', 'collector', 'rare-find', 'moneyed']);
  expect(new Set(owner.titles.map(t => t.source))).toEqual(new Set(['history']));
  expect(new Set(owner.titles.map(t => t.earnedAtMs)).size).toBe(1);
  expect(owner.titleProgress).toMatchObject({ 'expeditions-won': 34, 'outpost-won': 13, 'woodland-won': 21, trainings: 46, 'arena-wins': 18, 'arena-best-streak': 3,
    'tournament-finals': 1, 'items-owned': 14, 'tiers-of-one': 2, 'rarities-of-one': 2, 'gold-earned': 1240, 'days-in-camp': 21 });
});
