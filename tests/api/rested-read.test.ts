import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readRested } from '../../src/lib/api/reads';
afterEach(() => { vi.restoreAllMocks(); });

// Patch 1.9 Task 29: the owner's own rests that replaced a planned activity, from the owner-only `activities` rows (`requested`, `fallback`).
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const SERVER_NOW = 1_791_600_000_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function api(rows: unknown[]): { client: SupabaseClient; requests: { table: string; query: URLSearchParams }[] } {
  const requests: { table: string; query: URLSearchParams }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push({ table, query: url.searchParams });
    return table === 'world_revision' ? json({ revision: '7', server_now_ms: SERVER_NOW, slot_index: 372, published_slot_index: 372 }) : json(rows);
  } } });
  return { client, requests };
}
const row = (n: number, planned: string, fallback: boolean, over: Record<string, unknown> = {}) => ({ id: uuid(n), settled_at_ms: SERVER_NOW - n * 1000, fallback, planned,
  expedition: planned === 'expedition' ? 'outpost' : null, dungeon: planned === 'dungeon' ? 'wolf-den' : null, gladiators: { name: 'Aster' }, ...over });

test('reads the settled rests that replaced a planned activity, with what was planned and why', async () => {
  const { client, requests } = api([row(1, 'expedition', true), row(2, 'training', false), row(3, 'arena', true), row(4, 'dungeon', true),
    // An ordinary Rest, an unknown kind and a non-Training without a fallback are left out.
    row(5, 'rest', false), row(6, 'joust', true), row(7, 'arena', false)]);
  const rests = await readRested(client);
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'activities']);
  const query = requests[1].query;
  expect(query.get('select')).toBe('id,settled_at_ms,fallback,planned:requested->>kind,expedition:requested->>expeditionId,dungeon:requested->>dungeonId,gladiators(name)');
  expect(query.get('status')).toBe('eq.completed');
  expect(query.get('resolved_kind')).toBe('eq.rest');
  expect(query.get('requested->>kind')).toBe('neq.rest');
  expect(query.get('settled_at_ms')).toBe(`lte.${SERVER_NOW}`);
  expect(rests).toEqual([
    { activityId: uuid(1), settledAtMs: SERVER_NOW - 1000, planned: 'expedition', destination: 'Ruined Outpost', reason: 'stamina', name: 'Aster' },
    { activityId: uuid(2), settledAtMs: SERVER_NOW - 2000, planned: 'training', destination: null, reason: 'limit', name: 'Aster' },
    { activityId: uuid(3), settledAtMs: SERVER_NOW - 3000, planned: 'arena', destination: null, reason: 'stamina', name: 'Aster' },
    { activityId: uuid(4), settledAtMs: SERVER_NOW - 4000, planned: 'dungeon', destination: 'Wolf Den', reason: 'stamina', name: 'Aster' },
  ]);
});

test('reads some activities by id, running or settled, and refuses a malformed id without a request', async () => {
  const { client, requests } = api([row(1, 'expedition', true, { settled_at_ms: null })]);
  expect(await readRested(client, [uuid(1)])).toEqual([{ activityId: uuid(1), settledAtMs: null, planned: 'expedition', destination: 'Ruined Outpost', reason: 'stamina', name: 'Aster' }]);
  expect(requests.map(r => r.table)).toEqual(['activities']);
  expect(requests[0].query.get('id')).toBe(`in.(${uuid(1)})`);
  expect(requests[0].query.get('status')).toBeNull();
  await expect(readRested(client, ['not-an-id'])).rejects.toMatchObject({ code: 'unavailable' });
  expect(await readRested(client, [])).toEqual([]);
  expect(requests).toHaveLength(1);
});
