import { expect, it } from 'vitest';
import { handleCommand, parseCommand, type CommandDependencies } from '../../supabase/functions/_shared/backend/commands.ts';

const operationId = '8d2f0216-c41a-4056-89aa-8f0c1da612e0';
const create = { kind: 'create-character', operationId, name: 'Avi Fighter', classId: 'guardian',
  allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } };
const deps: CommandDependencies = { allowedOrigins: ['http://127.0.0.1:3000'], verifyActor: async () => ({ userId: operationId }),
  database: { plan: async () => ({ ok: false, code: 'unavailable' }), inventory: async () => ({ ok: false, code: 'unavailable' }), consumeRateLimit: async () => null, createGladiator: async () => ({ ok: true, receiptId: operationId, value: { gladiatorId: operationId } }) } };
function req(body: unknown, origin = 'http://127.0.0.1:3000') { return new Request('http://local', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }); }

it('rejects missing identity before any command executes', async () => {
  const response = await handleCommand(new Request('http://local', { method: 'POST', body: '{}' }), {
    allowedOrigins: ['http://127.0.0.1:3000'],
    verifyActor: async () => { throw new Error('unauthenticated'); },
    database: { plan: async () => { throw new Error('must not execute'); }, inventory: async () => { throw new Error('must not execute'); }, consumeRateLimit: async () => null, createGladiator: async () => { throw new Error('must not execute'); } },
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
    inventory: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return { ok: false as const, code: 'inventory-full' as const }; } } };
  const commands = [{ kind: 'buy-shop', operationId, catalogId: 'sword:1:renown', catalogVersion: 'v1', quantity: 1 },
    { kind: 'sell-item', operationId, itemId: operationId, quantity: 2 }, { kind: 'discard-item', operationId, itemId: operationId, quantity: 1 }];
  for (const command of commands) {
    const response = await handleCommand(req(command), routed);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: 'inventory-full' });
  }
  expect(calls).toEqual(commands.map(command => ({ actor: { userId: operationId }, command })));
  const marketplace = await handleCommand(req({ kind: 'cancel-listing', operationId, listingId: operationId }), routed);
  expect(await marketplace.json()).toEqual({ ok: false, code: 'unavailable' });
});
