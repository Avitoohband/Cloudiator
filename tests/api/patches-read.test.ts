import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
// No browser client by default (no backend configured); a test may install one over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
import { readPatchNumbers, readPatches, readRevision } from '../../src/lib/api/reads';
import { PATCH } from '../../src/lib/patch';
import { PATCH_1_4, SEED_PATCHES } from '../fixtures/patches';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Patch numbers (Patch A spec, "Patch numbers and the changelog", Client): the newest patch rides the revision read, the history reads
// 20 patches at a time with their features, and one small read after the messages read finds the numbers of the notes it holds.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const SESSION = { user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session;
/** A browser client over a fake Data API; `answer` gets each request's table and query. `session` is what getSession reports. */
function api(answer: (table: string, query: URLSearchParams) => Response, session: Session | null = null) {
  const requests: { table: string; query: URLSearchParams }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push({ table, query: url.searchParams });
    return answer(table, url.searchParams);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(session ? { data: { session }, error: null } : { data: { session: null }, error: null });
  holder.client = client;
  return { client, requests };
}
const NOW = 1_793_300_000_000;
const revisionRow = (latest: unknown) => ({ revision: '1', server_now_ms: NOW, slot_index: 373_604, published_slot_index: 373_604, latest_patch: latest });
/** A patch row as PostgREST answers the history's select, its features in the order given. */
const patchRow = (n: number, over: Record<string, unknown> = {}) => {
  const number = `1.${n}`;
  return { number, sort_key: 1_000_000 + n * 1_000, title: `Patch ${number}`, released_at_ms: 1_792_920_000_000 + n, message_id: null,
    patch_features: [{ position: 2, text: `Second of ${number}.` }, { position: 1, text: `First of ${number}.` }], ...over };
};
const message = (id: number, kind: 'patch-notes' | 'admin' = 'patch-notes') => ({ id, kind, title: `Note ${id}`, preview: `Preview ${id}`,
  body: [{ p: 'What changed:' }], action: null, published_at_ms: 1_793_000_000_000 + id });

test('reads the newest patch with the revision, and only a well-formed number', async () => {
  let latest: unknown = '1.4';
  const { client, requests } = api(() => json(revisionRow(latest)));
  expect(await readRevision(client)).toEqual({ revision: '1', serverNowMs: NOW, slotIndex: 373_604, publishedSlotIndex: 373_604, latestPatch: '1.4' });
  expect(requests[0].table).toBe('world_revision');
  expect(requests[0].query.get('select')).toBe('revision,server_now_ms,slot_index,published_slot_index,latest_patch,rules_version');
  for (const value of [null, 'junk', '1.3.0', 5, undefined]) {
    latest = value;
    expect((await readRevision(client)).latestPatch, String(value)).toBeNull();
  }
  // The live gateway's revision is the same read, for a visitor too.
  latest = '1.5';
  expect((await createLiveGateway().revision()).latestPatch).toBe('1.5');
});

// Patch 1.6 (spec "Client", "The active version"): the revision read also names the active rules version (M27's public
// `rules_version`), as its text; a read without a text version (an older server, a malformed row) has no `rulesVersion` at all.
test('preserves revision version text and omits the property when the read names no version', async () => {
  const row = revisionRow('1.4');
  const expected = { revision: '1', serverNowMs: NOW, slotIndex: 373_604, publishedSlotIndex: 373_604, latestPatch: '1.4' };
  let response: typeof row & { rules_version?: unknown } = row;
  const { client, requests } = api(() => json(response));

  for (const version of ['v1', 'v2', 'v3']) {
    response = { ...row, rules_version: version };
    expect(await readRevision(client)).toStrictEqual({ ...expected, rulesVersion: version });
  }

  response = row;
  expect(await readRevision(client)).toStrictEqual(expected);
  for (const version of [null, 2]) {
    response = { ...row, rules_version: version };
    expect(await readRevision(client)).toStrictEqual(expected);
  }
  expect(requests.map(request => request.table)).toEqual(Array(6).fill('world_revision'));
});

test('keeps the world snapshot to its existing projection when the revision includes patch and rules', async () => {
  const { requests } = api(table => table === 'world_revision' ? json({ ...revisionRow('1.4'), rules_version: 'v2' }) : json([]));
  expect(await createLiveGateway().world()).toStrictEqual({
    revision: '1', serverNowMs: NOW, slotIndex: 373_604, publishedSlotIndex: 373_604, actors: [],
  });
  expect(requests.map(request => request.table)).toEqual(['world_revision', 'world_actor_reads', 'world_revision']);
});

test('reads 20 patches at a time, newest first, with their features in position order', async () => {
  const rows = Array.from({ length: 21 }, (_, i) => patchRow(30 - i));
  const { client, requests } = api(() => json(rows));
  const page = await readPatches(client);
  expect(requests).toHaveLength(1);
  expect(requests[0].table).toBe('patches');
  expect(requests[0].query.get('select')).toBe('number,sort_key,title,released_at_ms,message_id,patch_features(position,text)');
  expect(requests[0].query.get('order')).toBe('sort_key.desc');
  expect(requests[0].query.get('limit')).toBe('21');
  expect(requests[0].query.get('sort_key')).toBeNull();
  expect(page.more).toBe(true);
  expect(page.items).toHaveLength(20);
  expect(page.items[0]).toEqual({ number: '1.30', sortKey: 1_030_000, title: 'Patch 1.30', releasedAtMs: 1_792_920_000_030, messageId: null,
    features: ['First of 1.30.', 'Second of 1.30.'] });
  expect(page.items.at(-1)!.number).toBe('1.11');
  // The next page: older than the given key.
  const older = api(() => json(rows.slice(0, 3)));
  const next = await readPatches(older.client, 1_003_001);
  expect(older.requests[0].query.get('sort_key')).toBe('lt.1003001');
  expect(next).toMatchObject({ more: false });
  expect(next.items).toHaveLength(3);
});

test('skips a malformed patch row and keeps the rest', async () => {
  const rows = [patchRow(9), patchRow(8, { number: '1.08' }), patchRow(7, { sort_key: 5 }), patchRow(6, { title: 7 }), patchRow(5, { released_at_ms: 'soon' }),
    patchRow(4, { message_id: 'x' }), patchRow(3, { patch_features: null }), patchRow(2, { patch_features: [{ position: 1, text: 5 }] }),
    patchRow(1, { message_id: '3', released_at_ms: '1792920000001', sort_key: '1001000' })];
  const { client } = api(() => json(rows));
  const { items, more } = await readPatches(client);
  expect(items.map(p => p.number)).toEqual(['1.9', '1.1']);
  // Bigints sent as text (a driver option) still read as numbers.
  expect(items[1]).toMatchObject({ sortKey: 1_001_000, releasedAtMs: 1_792_920_000_001, messageId: 3 });
  expect(more).toBe(false);
});

test('a failed patch read is unavailable and a refused one unauthenticated', async () => {
  await expect(readPatches(api(() => json({ code: 'XX000', message: 'secret database detail' }, 500)).client)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readPatches(api(() => json({ code: '42501', message: 'permission denied' }, 401)).client)).rejects.toMatchObject({ code: 'unauthenticated' });
});

test('finds the patch numbers of the notes in one small read, and sends none for no notes', async () => {
  const { client, requests } = api(() => json([{ number: '1.3', message_id: 3 }, { number: 'junk', message_id: 2 }]));
  expect(await readPatchNumbers(client, [3, 2])).toEqual(new Map([[3, '1.3']]));
  expect(requests).toHaveLength(1);
  expect(requests[0].table).toBe('patches');
  expect(requests[0].query.get('select')).toBe('number,message_id');
  expect(requests[0].query.get('message_id')).toBe('in.(3,2)');
  const none = api(() => json([]));
  expect(await readPatchNumbers(none.client, [])).toEqual(new Map());
  expect(none.requests).toHaveLength(0);
});

test('the live gateway numbers the patch notes after the messages read, never an admin note, and shows them without numbers when that read fails', async () => {
  let failing = false;
  const { requests } = api((table, query) => {
    if (table === 'game_messages') return json([message(3), message(2, 'admin'), message(1)]);
    if (failing) return json({ code: 'XX000', message: 'down' }, 500);
    expect(query.get('message_id')).toBe('in.(3,1)');
    return json([{ number: '1.3', message_id: 3 }, { number: '1.1', message_id: 1 }]);
  }, SESSION);
  const gateway = createLiveGateway();
  expect((await gateway.messages()).map(m => [m.id, m.patch])).toEqual([[3, '1.3'], [2, null], [1, '1.1']]);
  expect(requests.map(r => r.table)).toEqual(['game_messages', 'patches']);
  failing = true;
  expect((await gateway.messages()).map(m => [m.id, m.patch])).toEqual([[3, null], [2, null], [1, null]]);
});

test('the live gateway reads the history pages', async () => {
  const { requests } = api(() => json([patchRow(4), patchRow(3)]));
  expect((await createLiveGateway().patches(1_005_000)).items.map(p => p.number)).toEqual(['1.4', '1.3']);
  expect(requests[0].query.get('sort_key')).toBe('lt.1005000');
});

test('the fixture preview is up to date with this build, its history is the seed plus 1.4, and its notes carry their numbers', async () => {
  const gateway = createFixtureGateway();
  expect((await gateway.revision()).latestPatch).toBe(PATCH);
  const page = await gateway.patches();
  expect(page.more).toBe(false);
  expect(page.items.map(p => p.number)).toEqual(['1.4', ...SEED_PATCHES.map(p => p.number)]);
  expect(page.items[0].title).toBe(PATCH_1_4.title);
  expect(page.items.slice(1).map(p => ({ ...p, messageId: null }))).toEqual(SEED_PATCHES);
  expect((await gateway.patches(page.items.at(-1)!.sortKey)).items).toEqual([]);
  // Each sample patch note names the patch that links it; the admin note has none.
  const messages = await gateway.messages();
  for (const m of messages) {
    const linked = page.items.find(p => p.messageId === m.id)?.number ?? null;
    expect(m.patch, `message ${m.id}`).toBe(m.kind === 'patch-notes' ? linked : null);
  }
  expect(messages.some(m => m.patch !== null)).toBe(true);
  // A copy each time.
  page.items[0].features.push('Edited');
  expect((await gateway.patches()).items[0].features).not.toContain('Edited');
});
