import { expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { handleCommand, parseCommand, type CommandDependencies } from '../../supabase/functions/_shared/backend/commands.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { ownerFixture } from '../fixtures/domain.ts';

const operationId = '8d2f0216-c41a-4056-89aa-8f0c1da612e0';
const create = { kind: 'create-character', operationId, name: 'Avi Fighter', classId: 'guardian',
  allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } };
const deps: CommandDependencies = { allowedOrigins: ['http://127.0.0.1:3000'], verifyActor: async () => ({ userId: operationId }),
  database: { plan: async () => ({ ok: false, code: 'unavailable' }), inventory: async () => ({ ok: false, code: 'unavailable' }), consumeRateLimit: async () => null, createGladiator: async () => ({ ok: true, receiptId: operationId, value: { gladiatorId: operationId } }),
    market: async () => ({ ok: false, code: 'unavailable' }), setTournamentOptIn: async () => ({ ok: false, code: 'unavailable' }) } };
function req(body: unknown, origin = 'http://127.0.0.1:3000') { return new Request('http://local', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }); }

it('rejects missing identity before any command executes', async () => {
  const response = await handleCommand(new Request('http://local', { method: 'POST', body: '{}' }), {
    allowedOrigins: ['http://127.0.0.1:3000'],
    verifyActor: async () => { throw new Error('unauthenticated'); },
    database: { plan: async () => { throw new Error('must not execute'); }, inventory: async () => { throw new Error('must not execute'); }, consumeRateLimit: async () => null, createGladiator: async () => { throw new Error('must not execute'); },
      market: async () => { throw new Error('must not execute'); }, setTournamentOptIn: async () => { throw new Error('must not execute'); } },
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, code: 'unauthenticated' });
});

it('strictly rejects extra authority, malformed discriminants, UUIDs and fractional allocations', () => {
  for (const body of [null, [], {}, { ...create, ownerId: operationId }, { ...create, owned: [] }, { ...create, kind: 'constructor' },
    { ...create, operationId: 'bad' }, { ...create, name: '  Avi  ' }, { ...create, name: '<script>' },
    { ...create, allocation: { ...create.allocation, strength: 1.5 } }, { ...create, allocation: { ...create.allocation, strength: 1e100 } },
    { ...create, allocation: { ...create.allocation, extra: 0 } }]) expect(parseCommand(body)).toBeNull();
  expect(parseCommand(create)).toEqual(create);
  expect(parseCommand({ ...create, name: '_Avi-' })).not.toBeNull();
});

it('validates every discriminant and rejects invalid counts, prices, booleans and catalog IDs', () => {
  const commands = [
    { kind: 'edit-schedule', expectedVersion: 1, phase: 'morning', choice: { kind: 'expedition', expeditionId: 'woodland' } },
    { kind: 'queue-build', expectedVersion: 1, classId: 'duelist', stance: 'balanced', allocation: create.allocation,
      equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } },
    { kind: 'cancel-build', expectedVersion: 1 }, { kind: 'buy-shop', catalogId: 'sword:1:common', catalogVersion: 'v1', quantity: 1 },
    { kind: 'sell-item', itemId: operationId, quantity: 1 }, { kind: 'discard-item', itemId: operationId, quantity: 1 },
    { kind: 'create-listing', itemId: operationId, price: 1 }, { kind: 'cancel-listing', listingId: operationId },
    { kind: 'buy-listing', listingId: operationId }, { kind: 'set-tournament-opt-in', enabled: false },
  ];
  for (const command of commands) {
    expect(parseCommand({ ...command, operationId })).not.toBeNull();
    expect(parseCommand({ ...command, operationId, ownerId: operationId })).toBeNull();
  }
  for (const command of [{ ...commands[0], expectedVersion: -1 }, { ...commands[0], choice: { kind: 'rest', expeditionId: 'woodland' } },
    { ...commands[2], expectedVersion: 1.5 }, { ...commands[3], quantity: 0 }, { ...commands[3], catalogId: 'missing' },
    { ...commands[3], quantity: Infinity }, { ...commands[4], quantity: 1.5 }, { ...commands[6], price: Number.MAX_SAFE_INTEGER + 1 },
    { ...commands[9], enabled: 'false' }]) expect(parseCommand({ ...command, operationId })).toBeNull();
});

it('parses presence with its operation id and nothing else (Task 23.8)', () => {
  expect(parseCommand({ kind: 'presence', operationId })).toEqual({ kind: 'presence', operationId });
  for (const body of [{ kind: 'presence' }, { kind: 'presence', operationId: 'bad' }, { kind: 'presence', operationId, payload: 1 },
    { kind: 'presence', operationId, ownerId: operationId }]) expect(parseCommand(body)).toBeNull();
});

it('answers presence with ok after the rate check, writing nothing else (Task 23.8)', async () => {
  const calls: string[] = [];
  const refuse = (name: string) => async () => { calls.push(name); throw new Error('must not execute'); };
  const database = { consumeRateLimit: async (_: unknown, creation: boolean) => { calls.push(`rate:${creation}`); return null; },
    plan: refuse('plan'), inventory: refuse('inventory'), createGladiator: refuse('createGladiator'), market: refuse('market'),
    setTournamentOptIn: refuse('setTournamentOptIn') } as unknown as CommandDependencies['database'];
  const answer = await handleCommand(req({ kind: 'presence', operationId }), { ...deps, database });
  expect(answer.status).toBe(200);
  expect(answer.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:3000');
  expect(await answer.json()).toEqual({ ok: true });
  expect(calls).toEqual(['rate:false']);
  const limited = await handleCommand(req({ kind: 'presence', operationId }), { ...deps, database: { ...database, consumeRateLimit: async () => 900 } });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 900 });
});

it('uses exact origin CORS and bounded streamed bodies', async () => {
  const good = await handleCommand(req(create), deps);
  expect(good.status).toBe(200);
  expect(good.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:3000');
  const bad = await handleCommand(req(create, 'https://evil.example'), deps);
  expect(bad.status).toBe(403);
  expect(bad.headers.has('Access-Control-Allow-Origin')).toBe(false);
  expect((await handleCommand(req({ padding: 'x'.repeat(20_000) }), deps)).status).toBe(413);
  expect((await handleCommand(new Request('http://local', { method: 'GET' }), deps)).status).toBe(405);
  const preflight = await handleCommand(new Request('http://local', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:3000' } }), deps);
  expect(preflight.status).toBe(204);
});

it('returns durable rate-limit retry hints and does not expose unexpected backend errors', async () => {
  const limited = await handleCommand(req(create), { ...deps, database: { ...deps.database, consumeRateLimit: async () => 1200 } });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 1200 });
  const broken = await handleCommand(req(create), { ...deps, database: { ...deps.database, createGladiator: async () => { throw new Error('secret database detail'); } } });
  expect(await broken.json()).toEqual({ ok: false, code: 'unavailable' });
  expect(await (await handleCommand(req({ kind: 'cancel-build', expectedVersion: 1, operationId }), deps)).json()).toEqual({ ok: false, code: 'unavailable' });
});

it('routes item commands to the inventory transaction with the verified actor and parsed command only', async () => {
  const calls: unknown[] = [];
  const routed = { ...deps, database: { ...deps.database,
    plan: async () => { throw new Error('item commands must not reach planning'); },
    market: async () => { throw new Error('item commands must not reach the marketplace'); },
    inventory: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return { ok: false as const, code: 'inventory-full' as const }; } } };
  const commands = [{ kind: 'buy-shop', operationId, catalogId: 'sword:1:renown', catalogVersion: 'v1', quantity: 1 },
    { kind: 'sell-item', operationId, itemId: operationId, quantity: 2 }, { kind: 'discard-item', operationId, itemId: operationId, quantity: 1 }];
  for (const command of commands) {
    const response = await handleCommand(req(command), routed);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: 'inventory-full' });
  }
  expect(calls).toEqual(commands.map(command => ({ actor: { userId: operationId }, command })));
});

it('routes the tournament opt-in to its own transaction with the verified actor and the parsed command only', async () => {
  const calls: unknown[] = [];
  const results = [{ ok: true as const, receiptId: operationId, value: { enabled: true, receivedAtMs: 7 } },
    { ok: false as const, code: 'processing' as const, retryAfterMs: 1000 }];
  const routed = { ...deps, database: { ...deps.database,
    plan: async () => { throw new Error('the opt-in must not reach planning'); },
    inventory: async () => { throw new Error('the opt-in must not reach the inventory'); },
    setTournamentOptIn: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return results.shift()!; } } };
  const command = { kind: 'set-tournament-opt-in', operationId, enabled: true };
  const saved = await handleCommand(req(command), routed);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ ok: true, receiptId: operationId, value: { enabled: true, receivedAtMs: 7 } });
  // Behind the world clock the transaction answers processing, a retryable conflict.
  const behind = await handleCommand(req(command), routed);
  expect(behind.status).toBe(409);
  expect(await behind.json()).toEqual({ ok: false, code: 'processing', retryAfterMs: 1000 });
  expect(calls).toEqual([{ actor: { userId: operationId }, command }, { actor: { userId: operationId }, command }]);
  // Extra authority never reaches the transaction.
  expect((await handleCommand(req({ ...command, gladiatorId: operationId }), routed)).status).toBe(400);
  expect(calls).toHaveLength(2);
});

// Task 18.2: the marketplace commands. The adapter is driven over a fake Data API, as the service-role client sends it.
type Sent = { method: string; path: string; search: string; body: unknown };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** A service-role client whose every request is recorded and answered by `answer(table or rpc name, url)`. */
function backend(answer: (name: string, url: URL) => Response, sent: Sent[]) {
  return createClient('http://127.0.0.1:54321', 'service-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    sent.push({ method: init?.method ?? 'GET', path: url.pathname, search: decodeURIComponent(url.search), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer(url.pathname.split('/').at(-1)!, url);
  } } });
}
const ACTOR = 'b8a0c7d4-1f2e-4a3b-9c8d-7e6f5a4b3c2d';
const LISTING = 'C3D4E5F6-A7B8-4C9D-8E0F-1A2B3C4D5E6F', ITEM = 'F1E2D3C4-B5A6-4978-8695-A4B3C2D1E0F9', OPERATION = 'D43F7844-52E0-4302-B8E4-740035047765';
const itemOf = (catalogId: string, id: string): ItemInstance => {
  const entry = CATALOG_V1.items[catalogId];
  return { id, ownerId: ownerFixture.gladiatorId, catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: structuredClone(entry.stats),
    quantity: 1, origin: 'starter', binding: entry.binding, reservation: null };
};
/** The starter loadout: sword 4 x 6 x 1000/1000 = 24 and light armor 2 x 2 = 4, a historical strength of 28. */
const buyerState: OwnerState = { ...ownerFixture, inventory: [itemOf('sword:1:common', 'starter-sword'), itemOf('light-armor:1:common', 'starter-armor')],
  progression: { ...ownerFixture.progression, peakStrength: 28 } };
/** The public offer's item: the listed item's catalog fields and stats, never its id, owner, origin or reservation. */
const heavyArmor = CATALOG_V1.items['heavy-armor:10:rare'];
const offeredItem = { catalogId: heavyArmor.id, catalogVersion: 'v1', tier: 10, rarity: 'rare', stats: structuredClone(heavyArmor.stats), quantity: 1 };

it('routes create, cancel and buy listing commands to their RPCs with the buyer preparation', async () => {
  // The handler sends the three listing kinds to the market transaction, with the verified actor and the parsed command only.
  const calls: unknown[] = [];
  const routed = { ...deps, database: { ...deps.database,
    plan: async () => { throw new Error('listing commands must not reach planning'); },
    inventory: async () => { throw new Error('listing commands must not reach the inventory'); },
    market: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return { ok: false as const, code: 'sold' as const }; } } };
  const listing = [{ kind: 'create-listing', operationId, itemId: operationId, price: 1_000_000_000 }, { kind: 'cancel-listing', operationId, listingId: operationId },
    { kind: 'buy-listing', operationId, listingId: operationId }];
  for (const command of listing) {
    const response = await handleCommand(req(command), routed);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: 'sold' });
  }
  expect(calls).toEqual(listing.map(command => ({ actor: { userId: operationId }, command })));
  expect((await handleCommand(req({ ...listing[2], gladiatorId: operationId }), routed)).status).toBe(400);
  expect(calls).toHaveLength(3);

  // The adapter: canonical lowercase ids, one RPC per kind, and a buyer preparation for purchases only.
  let offer: unknown[] = [{ item: offeredItem }], owner: unknown[] = [{ state: buyerState }];
  const sent: Sent[] = [];
  const database = createDatabase(backend(name => name === 'owner_state' ? json(owner) : name === 'market_offers' ? json(offer)
    : json({ ok: true, receiptId: 'r1', value: { listingId: LISTING.toLowerCase() } }), sent));
  const actor = { userId: ACTOR };
  const rpc = (name: string, command: Record<string, unknown>, prepared: unknown) => ({ method: 'POST', path: `/rest/v1/rpc/${name}`, search: '',
    body: { actor_id: ACTOR, operation_id: OPERATION.toLowerCase(), input: { command, prepared } } });
  const canonical = { operationId: OPERATION.toLowerCase() };

  expect(await database.market(actor, { kind: 'create-listing', operationId: OPERATION, itemId: ITEM, price: 250 })).toMatchObject({ ok: true });
  expect(await database.market(actor, { kind: 'cancel-listing', operationId: OPERATION, listingId: LISTING })).toMatchObject({ ok: true });
  expect(sent).toEqual([
    rpc('create_listing', { kind: 'create-listing', ...canonical, itemId: ITEM.toLowerCase(), price: 250 }, null),
    rpc('cancel_listing', { kind: 'cancel-listing', ...canonical, listingId: LISTING.toLowerCase() }, null),
  ]);

  // A purchase reads the buyer's owner state and the public offer, then prepares the buyer's new historical strength:
  // tier 10 rare heavy armor, 2 x 15.6 = 31.2, replaces light armor's 4 beside the sword's 24.
  sent.length = 0;
  const buy = { kind: 'buy-listing' as const, operationId: OPERATION, listingId: LISTING };
  const purchase = { kind: 'buy-listing', ...canonical, listingId: LISTING.toLowerCase() };
  expect(await database.market(actor, buy)).toMatchObject({ ok: true });
  expect(sent.slice(0, 2).map(r => [r.method, r.path, r.search]).sort()).toEqual([
    ['GET', '/rest/v1/market_offers', `?select=item&id=eq.${LISTING.toLowerCase()}`],
    ['GET', '/rest/v1/owner_state', `?select=state&owner_id=eq.${ACTOR}`],
  ]);
  expect(sent[2]).toEqual(rpc('buy_listing', purchase, { baselinePeakStrength: 28, nextPeakStrength: 55.2 }));
  // No open offer (sold, cancelled, expired or unknown): nothing is acquired, so the baseline stands and SQL answers from the listing.
  sent.length = 0; offer = [];
  await database.market(actor, buy);
  expect(sent[2]).toEqual(rpc('buy_listing', purchase, { baselinePeakStrength: 28, nextPeakStrength: 28 }));
  // Without a character there is nothing to prepare; the call still reaches SQL, which replays a committed receipt first.
  sent.length = 0; offer = [{ item: offeredItem }]; owner = [];
  await database.market(actor, buy);
  expect(sent[2]).toEqual(rpc('buy_listing', purchase, null));
  // Malformed stored stats cannot be scored: no preparation, and the call still reaches SQL.
  sent.length = 0; owner = [{ state: buyerState }]; offer = [{ item: { ...offeredItem, stats: { ...offeredItem.stats, armor: -1 } } }];
  await database.market(actor, buy);
  expect(sent[2]).toEqual(rpc('buy_listing', purchase, null));
});

it('refuses a price above 1,000,000,000 before any RPC', async () => {
  const sent: Sent[] = [];
  const database = createDatabase(backend(() => json({ ok: true, receiptId: 'r1', value: { listingId: operationId, expiresAtMs: 1 } }), sent));
  const routed = { ...deps, database: { ...deps.database, market: database.market } };
  for (const price of [1_000_000_001, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, '10', null]) {
    const response = await handleCommand(req({ kind: 'create-listing', operationId, itemId: operationId, price }), routed);
    expect(response.status, String(price)).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: 'invalid' });
  }
  expect(sent).toEqual([]);
  for (const price of [1, 1_000_000_000]) {
    const response = await handleCommand(req({ kind: 'create-listing', operationId, itemId: operationId, price }), routed);
    expect(response.status, String(price)).toBe(200);
  }
  expect(sent.map(r => [r.path, (r.body as { input: { command: { price: number } } }).input.command.price]))
    .toEqual([['/rest/v1/rpc/create_listing', 1], ['/rest/v1/rpc/create_listing', 1_000_000_000]]);
});

it('answers a deadlocked or serialization-failed market transaction as retryable processing', async () => {
  // PostgreSQL rolls the aborted transaction back whole (no receipt, money or item moved), so the same operation may be sent again.
  for (const code of ['40P01', '40001']) {
    const sent: Sent[] = [];
    const database = createDatabase(backend(name => name === 'owner_state' ? json([{ state: buyerState }]) : name === 'market_offers' ? json([{ item: offeredItem }])
      : json({ code, message: 'deadlock detected', details: 'Process 1 waits for ExclusiveLock on advisory lock', hint: null }, 500), sent));
    for (const command of [{ kind: 'create-listing' as const, operationId, itemId: operationId, price: 5 }, { kind: 'cancel-listing' as const, operationId, listingId: operationId },
      { kind: 'buy-listing' as const, operationId, listingId: operationId }]) {
      expect(await database.market({ userId: ACTOR }, command), `${code} ${command.kind}`).toEqual({ ok: false, code: 'processing', retryAfterMs: 1000 });
    }
    const response = await handleCommand(req({ kind: 'buy-listing', operationId, listingId: operationId }), { ...deps, database: { ...deps.database, market: database.market } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: 'processing', retryAfterMs: 1000 });
  }
  // Any other database error stays unavailable and never forwards the driver's message.
  const database = createDatabase(backend(() => json({ code: 'XX000', message: 'secret database detail', details: null, hint: null }, 500), []));
  await expect(database.market({ userId: ACTOR }, { kind: 'cancel-listing', operationId, listingId: operationId })).rejects.toThrow('market-unavailable');
  const response = await handleCommand(req({ kind: 'cancel-listing', operationId, listingId: operationId }), { ...deps, database: { ...deps.database, market: database.market } });
  expect([response.status, await response.json()]).toEqual([503, { ok: false, code: 'unavailable' }]);
});
