import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
// No browser client by default (no backend configured); a test may install one over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('without a configured backend, every live read and command fails explicitly instead of returning fixture authority', async () => {
  const gateway = createLiveGateway();
  const reads = [gateway.world(), gateway.revision(), gateway.timeline('activity'), gateway.profile('gladiator'),
    gateway.market(), gateway.standings('bronze'), gateway.tournament('tournament'), gateway.tournamentLog('tournament:301:bronze:1:0'), gateway.recent()];
  await Promise.all(reads.map(read => expect(read).rejects.toMatchObject({ code: 'unavailable' })));
  await expect(gateway.command({ kind: 'edit-schedule', operationId: 'd43f7844-52e0-4302-b8e4-740035047765',
    expectedVersion: 1, phase: 'morning', choice: { kind: 'arena' } })).resolves.toEqual({ ok: false, code: 'unavailable' });
});

// Task 18.2: the marketplace's live read and commands.
const SELLER = '0d5f8471-d919-428f-9ab7-058c95821757', LISTING = '1f205d8f-cd7b-4631-9b4d-a22ef6614e70';
const offer = { id: LISTING, seller_gladiator_id: SELLER, seller_name: 'Aster', price: 95, listed_at_ms: 1_791_591_300_000, expires_at_ms: 1_792_196_100_000,
  item: { catalogId: 'iron-helmet:5:uncommon', catalogVersion: 'v1', tier: 5, rarity: 'uncommon', quantity: 1,
    stats: { damage: 0, armor: 5.18, weight: 4, intervalMs: 0, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } } } };
/** A browser client over a fake Data API that answers only the public offers; `session` is what getSession reports. */
function api(session: Session | null) {
  const tables: string[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const table = new URL(String(input)).pathname.split('/').at(-1)!;
    tables.push(table);
    return table === 'market_offers' ? new Response(JSON.stringify([offer]), { headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(session ? { data: { session }, error: null } : { data: { session: null }, error: null });
  holder.client = client;
  return tables;
}

test('reads offers without a session', async () => {
  const tables = api(null);
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  const gateway = createLiveGateway();
  const listing = { listingId: LISTING, seller: { gladiatorId: SELLER, name: 'Aster' }, item: offer.item, price: 95, listedAtMs: offer.listed_at_ms, expiresAtMs: offer.expires_at_ms };
  expect(await gateway.market()).toEqual({ rows: [listing], nextCursor: null });
  expect(await gateway.market(undefined, SELLER)).toEqual({ rows: [listing], nextCursor: null });
  // Only the public projection, and no command was sent.
  expect(tables).toEqual(['market_offers', 'market_offers']);
  expect(sent).not.toHaveBeenCalled();
  // A malformed cursor or seller is refused before any request.
  await expect(gateway.market('bad,filter')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.market(undefined, 'not-a-gladiator')).rejects.toMatchObject({ code: 'unavailable' });
  expect(tables).toHaveLength(2);
});

test('sends the listing commands to the authenticated command endpoint and keeps their business codes', async () => {
  api({ user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session);
  const sent: unknown[] = [];
  const answers = [{ status: 200, body: { ok: true, receiptId: 'r1', value: { listingId: LISTING, expiresAtMs: 1 } } },
    { status: 409, body: { ok: false, code: 'expired' } }, { status: 409, body: { ok: false, code: 'sold' } },
    { status: 409, body: { ok: false, code: 'processing', retryAfterMs: 1000 } }];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const { status, body } = answers.shift()!;
    return new Response(JSON.stringify(body), { status });
  });
  const operationId = 'd43f7844-52e0-4302-b8e4-740035047765';
  const commands = [{ kind: 'create-listing' as const, operationId, itemId: LISTING, price: 95 }, { kind: 'cancel-listing' as const, operationId, listingId: LISTING },
    { kind: 'buy-listing' as const, operationId, listingId: LISTING }, { kind: 'buy-listing' as const, operationId, listingId: LISTING }];
  const gateway = createLiveGateway();
  const results = [];
  for (const command of commands) results.push(await gateway.command(command));
  expect(results).toEqual([{ ok: true, receiptId: 'r1', value: { listingId: LISTING, expiresAtMs: 1 } }, { ok: false, code: 'expired' }, { ok: false, code: 'sold' },
    { ok: false, code: 'processing', retryAfterMs: 1000 }]);
  expect(sent).toEqual(commands.map(body => ({ url: expect.stringMatching(/\/functions\/v1\/game-command$/), body })));
});
