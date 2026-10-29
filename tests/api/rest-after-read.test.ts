import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// Patch A Task 8: was the next slot after a trip really a Rest? The whole-trip replay ends with "Resting" only then. The read is of
// the public `recent_results` projection, which visitors read as `anon`; no backend is configured by default, and a test may
// install a client over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { GatewayReadError, readRestAfter } from '../../src/lib/api/reads';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ASTER = '0d5f8471-d919-428f-9ab7-058c95821757';
/** The slot is 80 minutes (RULES_V1.clock.slotMs); the literal pins it, so a change of the slot has to change this read on purpose. */
const SLOT_MS = 4_800_000;
const TRIP_END = 1_791_585_600_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const row = (resolvedKind: string) => ({ summary: { activityId: 'c1f0a2b4-3d5e-4f60-8a7b-9c0d1e2f3a4b', resolvedKind, result: 'victory', success: true, settledAtMs: TRIP_END + SLOT_MS } });

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

test('asks the public results for this gladiator in the next slot, and nothing else', async () => {
  const { client, requests } = api(() => json([row('rest')]));
  expect(await readRestAfter(client, ASTER, TRIP_END)).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0].table).toBe('recent_results');
  // Only the summary crosses; the filters are exactly the gladiator and the next slot's reveal window, at most four rows.
  expect(requests[0].query.get('select')).toBe('summary');
  expect(requests[0].query.get('gladiator_id')).toBe(`eq.${ASTER}`);
  expect(requests[0].query.getAll('reveal_at_ms')).toEqual([`gte.${TRIP_END + SLOT_MS}`, `lt.${TRIP_END + 2 * SLOT_MS}`]);
  expect(requests[0].query.get('limit')).toBe('4');
  expect([...new Set(requests[0].query.keys())].sort()).toEqual(['gladiator_id', 'limit', 'reveal_at_ms', 'select']);
});

test('is true only when a row of the next slot is a Rest', async () => {
  expect(await readRestAfter(api(() => json([row('rest')])).client, ASTER, TRIP_END)).toBe(true);
  // A training, an Arena or another expedition result, or no result at all, is not a Rest.
  for (const kind of ['training', 'arena', 'tournament', 'expedition']) {
    expect(await readRestAfter(api(() => json([row(kind)])).client, ASTER, TRIP_END), kind).toBe(false);
  }
  expect(await readRestAfter(api(() => json([])).client, ASTER, TRIP_END)).toBe(false);
  // Any row of the window may be the Rest.
  expect(await readRestAfter(api(() => json([row('training'), row('rest')])).client, ASTER, TRIP_END)).toBe(true);
  // A row this client cannot read is not a Rest, and does not fail the read.
  expect(await readRestAfter(api(() => json([{ summary: null }, { summary: 'rest' }, {}, row('training')])).client, ASTER, TRIP_END)).toBe(false);
});

test('lowercases the gladiator id, and checks both arguments before any request', async () => {
  const { client, requests } = api(() => json([]));
  await readRestAfter(client, ASTER.toUpperCase(), TRIP_END);
  expect(requests).toHaveLength(1);
  expect(requests[0].query.get('gladiator_id')).toBe(`eq.${ASTER}`);

  for (const bad of ['not-an-id', '', `${ASTER}x`, `x${ASTER}`, 'a,b)', "1' or '1'='1"]) {
    await expect(readRestAfter(client, bad, TRIP_END), bad).rejects.toMatchObject({ code: 'unavailable' });
    await expect(readRestAfter(client, bad, TRIP_END), bad).rejects.toBeInstanceOf(GatewayReadError);
  }
  // A time that is not a whole, non-negative number of milliseconds is no time to ask about.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 60]) {
    await expect(readRestAfter(client, ASTER, bad), String(bad)).rejects.toMatchObject({ code: 'unavailable' });
  }
  expect(requests).toHaveLength(1);
});

test('a failed read is unavailable', async () => {
  const failing = api(() => json({ code: 'XX000', message: 'boom' }, 500));
  await expect(readRestAfter(failing.client, ASTER, TRIP_END)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readRestAfter(failing.client, ASTER, TRIP_END)).rejects.toBeInstanceOf(GatewayReadError);
});

test('the live gateway asks as a visitor without a session, and fails explicitly without a backend', async () => {
  await expect(createLiveGateway().restAfter(ASTER, TRIP_END)).rejects.toMatchObject({ code: 'unavailable' });
  const { requests } = api(() => json([row('rest')]));
  expect(await createLiveGateway().restAfter(ASTER, TRIP_END)).toBe(true);
  expect(requests.map(r => r.table)).toEqual(['recent_results']);
  await expect(createLiveGateway().restAfter('not-an-id', TRIP_END)).rejects.toMatchObject({ code: 'unavailable' });
  expect(requests).toHaveLength(1);
});
