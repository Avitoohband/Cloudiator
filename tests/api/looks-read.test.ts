import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Appearance } from '@domain/appearance';
// No browser client by default (no backend configured); a test may install one over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
import { GatewayReadError, readLooks } from '../../src/lib/api/reads';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ASTER = '0d5f8471-d919-428f-9ab7-058c95821757', VARRO = '5b0c3f8e-2d4a-4e61-9a7b-6c5d4e3f2a10', CASSIA = '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const FEMALE: Appearance = { body: 'female', hair: 'ponytail', skin: 1, hairColor: 2, cloth: 4 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A browser client over a fake Data API for a visitor (no session); `answer` gets each request's table and query. */
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

test('reads the looks of several gladiators in one public read of the actor projection', async () => {
  const { client, requests } = api(() => json([
    { gladiator_id: ASTER, appearance: FEMALE },
    // A gladiator from before the look was chosen: the projection has no appearance key (the read answers null).
    { gladiator_id: VARRO, appearance: null },
  ]));
  const looks = await readLooks(client, [ASTER, VARRO, CASSIA]);
  expect(requests).toHaveLength(1);
  expect(requests[0].table).toBe('world_actor_reads');
  // Only the id and the look cross, never the whole actor.
  expect(requests[0].query.get('select')).toBe('gladiator_id,appearance:actor->appearance');
  expect(requests[0].query.get('gladiator_id')).toBe(`in.(${ASTER},${VARRO},${CASSIA})`);
  expect(looks).toBeInstanceOf(Map);
  expect(looks.get(ASTER)).toEqual(FEMALE);
  expect(looks.get(VARRO)).toBeNull();
  // A gladiator the projection does not know is absent, so the replay draws it as legacy.
  expect(looks.has(CASSIA)).toBe(false);
});

test('bounds, dedupes and checks the ids before any query is built', async () => {
  const { client, requests } = api(() => json([]));
  expect((await readLooks(client, [])).size).toBe(0);
  // Not a gladiator id: nothing to ask for (a text value would fail the whole read against the uuid column).
  expect((await readLooks(client, ['npc:fallback:b2e1d3f5', 'not-a-uuid', '', 'a,b)'])).size).toBe(0);
  expect(requests).toHaveLength(0);

  await readLooks(client, [ASTER, ASTER.toUpperCase(), VARRO, ASTER, 'junk']);
  expect(requests).toHaveLength(1);
  expect(requests[0].query.get('gladiator_id')).toBe(`in.(${ASTER},${VARRO})`);

  const many = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  await readLooks(client, many);
  expect(requests).toHaveLength(2);
  const asked = requests[1].query.get('gladiator_id')!.slice('in.('.length, -1).split(',');
  expect(asked).toEqual(many.slice(0, 16));
});

test('an invalid stored look reads as the legacy look, and a failed read is unavailable', async () => {
  const { client } = api(() => json([
    { gladiator_id: ASTER, appearance: { body: 'female', hair: 'mohawk', skin: 1, hairColor: 2, cloth: 4 } },
    { gladiator_id: VARRO, appearance: { ...FEMALE, extra: 1 } },
    { gladiator_id: CASSIA, appearance: 'female' },
  ]));
  const looks = await readLooks(client, [ASTER, VARRO, CASSIA]);
  expect([...looks.values()]).toEqual([null, null, null]);

  const failing = api(() => json({ code: 'XX000', message: 'boom' }, 500));
  await expect(readLooks(failing.client, [ASTER])).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readLooks(failing.client, [ASTER])).rejects.toBeInstanceOf(GatewayReadError);
});

test('the live gateway reads looks as a visitor without a session, and fails explicitly without a backend', async () => {
  await expect(createLiveGateway().looks([ASTER])).rejects.toMatchObject({ code: 'unavailable' });
  const { requests } = api(() => json([{ gladiator_id: ASTER, appearance: FEMALE }]));
  const looks = await createLiveGateway().looks([ASTER]);
  expect(looks.get(ASTER)).toEqual(FEMALE);
  expect(requests.map(r => r.table)).toEqual(['world_actor_reads']);
});

test('the fixture gateway answers looks from its own world, with no network', async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const gateway = createFixtureGateway();
  const world = await gateway.world();
  const aster = world.actors.find(a => a.gladiatorId === ASTER)!;
  const looks = await gateway.looks([ASTER, 'someone-unknown']);
  // Aster is in the fixture world with the look the world holds (the legacy look), and an unknown id is absent.
  expect(looks.get(ASTER)).toEqual(aster.appearance ?? null);
  expect(looks.has('someone-unknown')).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});
