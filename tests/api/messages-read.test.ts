import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { GameMessage } from '@contracts/reads';
// No browser client by default (no backend configured); a test may install one over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
import { readMessages } from '../../src/lib/api/reads';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Game messages (2026-10-28): the public message list, readable by visitors and players alike.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const SESSION = { user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session;
/** A browser client over a fake Data API; `answer` gets each request's table and query. `session` is what getSession reports. */
function api(answer: (table: string, query: URLSearchParams) => Response, session: Session | null = null) {
  const requests: { table: string; query: URLSearchParams; auth: string | null }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push({ table, query: url.searchParams, auth: new Headers(init?.headers).get('Authorization') });
    return answer(table, url.searchParams);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(session ? { data: { session }, error: null } : { data: { session: null }, error: null });
  holder.client = client;
  return { client, requests };
}
const row = (id: number, over: Record<string, unknown> = {}) => ({ id, kind: 'patch-notes', title: `Note ${id}`, preview: `Preview ${id}`,
  body: [{ p: 'What changed:' }, { li: 'One.' }], action: null, published_at_ms: 1_791_591_300_000 + id, ...over });
const message = (id: number, over: Partial<GameMessage> = {}): GameMessage => ({ id, kind: 'patch-notes', title: `Note ${id}`, preview: `Preview ${id}`,
  body: [{ p: 'What changed:' }, { li: 'One.' }], action: null, publishedAtMs: 1_791_591_300_000 + id, ...over });

test('reads the newest 50 messages from the public table, newest first by posting time and then id, as camel-case messages', async () => {
  const { client, requests } = api(() => json([row(3, { action: 'change-look', kind: 'admin' }), row(2), row(1)]));
  expect(await readMessages(client)).toEqual([message(3, { action: 'change-look', kind: 'admin' }), message(2), message(1)]);
  expect(requests).toHaveLength(1);
  expect(requests[0].table).toBe('game_messages');
  expect(requests[0].query.get('select')).toBe('id,kind,title,preview,body,action,published_at_ms');
  expect(requests[0].query.get('order')).toBe('published_at_ms.desc,id.desc');
  expect(requests[0].query.get('limit')).toBe('50');
  // Never the hidden flag, and no filter of the client's own: the table's row security hides what is hidden.
  expect(requests[0].query.get('select')).not.toContain('hidden');
  // An empty list is an empty list (no message has been posted yet).
  expect(await readMessages(api(() => json([])).client)).toEqual([]);
});

test('turns numbers from the database into numbers and caps the list at 50 even if the server sent more', async () => {
  const many = Array.from({ length: 60 }, (_, i) => row(60 - i));
  const { client } = api(() => json(many));
  const list = await readMessages(client);
  expect(list).toHaveLength(50);
  expect(list[0].id).toBe(60);
  expect(list.every(m => typeof m.id === 'number' && typeof m.publishedAtMs === 'number')).toBe(true);
  // A bigint sent as text (a driver option) still reads as a number.
  expect((await readMessages(api(() => json([row(7, { id: '7', published_at_ms: '1791591300007' })])).client))[0]).toMatchObject({ id: 7, publishedAtMs: 1_791_591_300_007 });
});

test('shows only what it understands: a row of an unknown kind, action or block shape is left out, never rendered or failed on', async () => {
  const { client } = api(() => json([
    row(9), row(8, { kind: 'game' }), row(7, { action: 'delete-everything' }), row(6, { body: [{ p: 'ok' }, { html: '<b>x</b>' }] }),
    row(5, { body: [{ p: 'ok', li: 'both' }] }), row(4, { body: [] }), row(3, { body: 'text' }), row(2, { body: [{ p: 5 }] }), row(1, { title: 5 }),
    row(0, { preview: null }),
  ]));
  expect((await readMessages(client)).map(m => m.id)).toEqual([9]);
});

test('keeps message text exactly as stored: markup stays characters, never a tag', async () => {
  const text = '<b>x</b> <script>alert(1)</script> & "q"';
  const { client } = api(() => json([row(1, { title: text, preview: text, body: [{ p: text }, { li: text }] })]));
  const [read] = await readMessages(client);
  expect(read).toMatchObject({ title: text, preview: text, body: [{ p: text }, { li: text }] });
});

test('a failed read is unavailable (the server error is not forwarded) and a refused one is unauthenticated', async () => {
  await expect(readMessages(api(() => json({ code: 'XX000', message: 'secret database detail' }, 500)).client)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readMessages(api(() => json({ code: '42501', message: 'permission denied' }, 401)).client)).rejects.toMatchObject({ code: 'unauthenticated' });
});

test.each([['a visitor', null], ['a signed-in reader', SESSION]])('the live gateway reads the messages for %s with no command and no private table', async (_who, session) => {
  const { requests } = api(() => json([row(2), row(1)]), session);
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  const gateway = createLiveGateway();
  expect(await gateway.messages()).toEqual([message(2), message(1)]);
  expect(requests.map(r => r.table)).toEqual(['game_messages']);
  expect(sent).not.toHaveBeenCalled();
});

test('without a configured backend the live gateway fails a message read explicitly', async () => {
  await expect(createLiveGateway().messages()).rejects.toMatchObject({ code: 'unavailable' });
});

test('sends a read mark to the authenticated command endpoint and takes an answer with no receipt, keeping the business codes', async () => {
  api(() => json([]), SESSION);
  const sent: { url: string; body: unknown; auth: string | null }[] = [];
  const answers = [{ status: 200, body: { ok: true, value: { messageId: 4 } } }, { status: 404, body: { ok: false, code: 'not-found' } },
    { status: 400, body: { ok: false, code: 'invalid' } }, { status: 429, body: { ok: false, code: 'rate-limited', retryAfterMs: 900 } },
    // Never taken as a read mark: a success with no value, a 5xx with a success body and a garbled answer.
    { status: 200, body: { ok: true } }, { status: 500, body: { ok: true, value: { messageId: 4 } } }, { status: 200, body: 'not an object' }];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('Authorization') });
    const { status, body } = answers.shift()!;
    return new Response(JSON.stringify(body), { status });
  });
  const command = { kind: 'read-message' as const, operationId: 'd43f7844-52e0-4302-b8e4-740035047765', messageId: 4 };
  const gateway = createLiveGateway();
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await gateway.command(command));
  expect(results).toEqual([{ ok: true, receiptId: '', value: { messageId: 4 } }, { ok: false, code: 'not-found' }, { ok: false, code: 'invalid' },
    { ok: false, code: 'rate-limited', retryAfterMs: 900 }, { ok: false, code: 'unavailable' }, { ok: false, code: 'unavailable' }, { ok: false, code: 'unavailable' }]);
  expect(sent).toEqual(Array(7).fill({ url: expect.stringMatching(/\/functions\/v1\/game-command$/), body: command, auth: 'Bearer first' }));
});

test('a visitor\'s read mark is refused locally and sends nothing', async () => {
  api(() => json([]), null);
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  expect(await createLiveGateway().command({ kind: 'read-message', operationId: 'd43f7844-52e0-4302-b8e4-740035047765', messageId: 4 }))
    .toEqual({ ok: false, code: 'unauthenticated' });
  expect(sent).not.toHaveBeenCalled();
});

test('the fixture preview lists sample messages, newest first, and agrees with the owner\'s inbox', async () => {
  const gateway = createFixtureGateway();
  const list = await gateway.messages();
  expect(list.length).toBeGreaterThan(1);
  expect(list.map(m => m.id)).toEqual([...list].sort((a, b) => b.publishedAtMs - a.publishedAtMs || b.id - a.id).map(m => m.id));
  expect(new Set(list.map(m => m.id)).size).toBe(list.length);
  for (const m of list) {
    expect(['patch-notes', 'admin']).toContain(m.kind);
    expect([null, 'change-look']).toContain(m.action);
    expect(m.title.length).toBeLessThanOrEqual(80);
    expect(m.preview.length).toBeLessThanOrEqual(140);
    expect(m.body.length).toBeGreaterThan(0);
  }
  // The owner's inbox is what these messages make of it: unread = published after sinceMs and not read.
  const { inbox } = await gateway.owner();
  expect(inbox.unread).toBe(list.filter(m => m.publishedAtMs > inbox.sinceMs && !inbox.readIds.includes(m.id)).length);
  expect(inbox.readIds.every(id => list.some(m => m.id === id))).toBe(true);
  // A copy each time: a caller that edits it changes nothing for the next.
  list[0].title = 'Edited';
  expect((await gateway.messages())[0].title).not.toBe('Edited');
  // The preview takes no commands: a read mark is refused like every command there.
  expect(await gateway.command({ kind: 'read-message', operationId: 'd43f7844-52e0-4302-b8e4-740035047765', messageId: list[0].id })).toEqual({ ok: false, code: 'unavailable' });
});
