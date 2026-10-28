import { expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { handleCommand, parseCommand, type CommandDependencies } from '../../supabase/functions/_shared/backend/commands.ts';
import { createDatabase, prepareBuild } from '../../supabase/functions/_shared/backend/database.ts';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import type { Appearance } from '../../supabase/functions/_shared/domain/appearance.ts';
import { ownerFixture } from '../fixtures/domain.ts';

const operationId = '8d2f0216-c41a-4056-89aa-8f0c1da612e0';
const create = { kind: 'create-character', operationId, name: 'Avi Fighter', classId: 'guardian',
  allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } };
const deps: CommandDependencies = { allowedOrigins: ['http://127.0.0.1:3000'], verifyActor: async () => ({ userId: operationId }),
  database: { plan: async () => ({ ok: false, code: 'unavailable' }), inventory: async () => ({ ok: false, code: 'unavailable' }), consumeRateLimit: async () => null, createGladiator: async () => ({ ok: true, receiptId: operationId, value: { gladiatorId: operationId } }),
    market: async () => ({ ok: false, code: 'unavailable' }), setTournamentOptIn: async () => ({ ok: false, code: 'unavailable' }),
    changeAppearance: async () => ({ ok: false, code: 'unavailable' }), readMessage: async () => ({ ok: false, code: 'unavailable' }),
    seeNotifications: async () => ({ ok: false, code: 'unavailable' }) } };
function req(body: unknown, origin = 'http://127.0.0.1:3000') { return new Request('http://local', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }); }

it('rejects missing identity before any command executes', async () => {
  const response = await handleCommand(new Request('http://local', { method: 'POST', body: '{}' }), {
    allowedOrigins: ['http://127.0.0.1:3000'],
    verifyActor: async () => { throw new Error('unauthenticated'); },
    database: { plan: async () => { throw new Error('must not execute'); }, inventory: async () => { throw new Error('must not execute'); }, consumeRateLimit: async () => null, createGladiator: async () => { throw new Error('must not execute'); },
      market: async () => { throw new Error('must not execute'); }, setTournamentOptIn: async () => { throw new Error('must not execute'); },
      changeAppearance: async () => { throw new Error('must not execute'); }, readMessage: async () => { throw new Error('must not execute'); },
      seeNotifications: async () => { throw new Error('must not execute'); } },
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

it('accepts create-character with or without a valid appearance and refuses an invalid one', () => {
  const appearance = { body: 'female', hair: 'ponytail', skin: 3, hairColor: 5, cloth: 11 };
  expect(parseCommand(create)).toEqual(create);
  expect(parseCommand({ ...create, appearance })).toEqual({ ...create, appearance });
  for (const body of ['male', 'female']) for (const hair of ['short', 'long', 'ponytail', 'bald'])
    expect(parseCommand({ ...create, appearance: { body, hair, skin: 0, hairColor: 0, cloth: 0 } })).not.toBeNull();
  expect(parseCommand({ ...create, appearance: { ...appearance, skin: 4, hairColor: 0, cloth: 0 } })).not.toBeNull();
  const { cloth: _cloth, ...missing } = appearance;
  for (const bad of [null, undefined, 'female', 0, [], [appearance], {}, missing, { ...appearance, skin: 5 }, { ...appearance, skin: -1 },
    { ...appearance, cloth: 12 }, { ...appearance, cloth: -1 }, { ...appearance, hairColor: 6 }, { ...appearance, hairColor: 1.5 },
    { ...appearance, skin: '1' }, { ...appearance, hair: 'mohawk' }, { ...appearance, body: 'other' }, { ...appearance, extra: 1 }])
    expect(parseCommand({ ...create, appearance: bad }), JSON.stringify(bad)).toBeNull();
  // The optional key must still be exact: no other extra authority rides along with a valid look.
  expect(parseCommand({ ...create, appearance, ownerId: operationId })).toBeNull();
  // Other commands never accept a look.
  expect(parseCommand({ kind: 'cancel-build', operationId, expectedVersion: 1, appearance })).toBeNull();
});

it('refuses an invalid appearance over HTTP and never reaches creation', async () => {
  let created: unknown = null;
  const spy: CommandDependencies = { ...deps, database: { ...deps.database, createGladiator: async (_actor, command) => { created = command; return { ok: true, receiptId: operationId, value: { gladiatorId: operationId } }; } } };
  const bad = await handleCommand(req({ ...create, appearance: { body: 'female', hair: 'mohawk', skin: 1, hairColor: 1, cloth: 1 } }), spy);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ ok: false, code: 'invalid' });
  expect(created).toBeNull();
  const appearance = { body: 'male', hair: 'bald', skin: 2, hairColor: 4, cloth: 8 };
  const good = await handleCommand(req({ ...create, appearance }), spy);
  expect(good.status).toBe(200);
  expect(created).toEqual({ ...create, appearance });
  created = null;
  expect((await handleCommand(req(create), spy)).status).toBe(200);
  expect(created).toEqual(create);
});

// Change look (2026-10-28): the free, unlimited look change of the player's own gladiator.
const look: Appearance = { body: 'female', hair: 'ponytail', skin: 3, hairColor: 5, cloth: 11 };
const change = { kind: 'change-appearance' as const, operationId, appearance: look };

it('accepts change-appearance only with exactly a valid look and no other key', () => {
  expect(parseCommand(change)).toEqual(change);
  for (const body of ['male', 'female']) for (const hair of ['short', 'long', 'ponytail', 'bald'])
    expect(parseCommand({ ...change, appearance: { body, hair, skin: 0, hairColor: 0, cloth: 0 } })).not.toBeNull();
  expect(parseCommand({ ...change, appearance: { ...look, skin: 4, hairColor: 0, cloth: 0 } })).not.toBeNull();
  const { cloth: _cloth, ...missing } = look;
  // Every refused look of the creation command, plus the ones only a change can send: no look at all.
  for (const bad of [null, undefined, 'female', 0, true, [], [look], {}, missing, { ...look, skin: 5 }, { ...look, skin: -1 },
    { ...look, cloth: 12 }, { ...look, cloth: -1 }, { ...look, hairColor: 6 }, { ...look, hairColor: 1.5 }, { ...look, skin: 1e100 },
    { ...look, skin: '1' }, { ...look, cloth: null }, { ...look, hair: 'mohawk' }, { ...look, body: 'other' }, { ...look, body: 'Male' },
    { ...look, extra: 1 }, { ...look, ownerId: operationId }])
    expect(parseCommand({ ...change, appearance: bad }), JSON.stringify(bad)).toBeNull();
  const { appearance: _appearance, ...withoutLook } = change;
  expect(parseCommand(withoutLook)).toBeNull();
  // The command names no gladiator and carries no other authority: the actor is the verified session's.
  for (const extra of [{ ownerId: operationId }, { gladiatorId: operationId }, { name: 'Avi Fighter' }, { expectedVersion: 1 }, { price: 0 }])
    expect(parseCommand({ ...change, ...extra }), JSON.stringify(extra)).toBeNull();
  expect(parseCommand({ ...change, operationId: 'bad' })).toBeNull();
  expect(parseCommand({ ...change, operationId: undefined })).toBeNull();
  // A look rides only on the commands that own it.
  expect(parseCommand({ kind: 'set-tournament-opt-in', operationId, enabled: true, appearance: look })).toBeNull();
});

it('routes change-appearance to its own transaction with the verified actor and the parsed command only', async () => {
  const calls: unknown[] = [];
  const results = [{ ok: true as const, receiptId: operationId, value: { appearance: look, receivedAtMs: 7 } },
    { ok: false as const, code: 'not-found' as const }, { ok: false as const, code: 'conflict' as const }];
  const never = (what: string) => async () => { throw new Error(`a look change must not reach ${what}`); };
  const routed = { ...deps, database: { ...deps.database, plan: never('planning'), inventory: never('the inventory'), market: never('the market'),
    createGladiator: never('creation'), setTournamentOptIn: never('the opt-in'),
    changeAppearance: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return results.shift()!; } } };
  const saved = await handleCommand(req(change), routed);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ ok: true, receiptId: operationId, value: { appearance: look, receivedAtMs: 7 } });
  // An account with no gladiator has nothing to change; a reused operation id with another look is a conflict.
  const none = await handleCommand(req(change), routed);
  expect(none.status).toBe(404);
  expect(await none.json()).toEqual({ ok: false, code: 'not-found' });
  expect((await handleCommand(req(change), routed)).status).toBe(409);
  expect(calls).toEqual(Array(3).fill({ actor: { userId: operationId }, command: change }));
  // An invalid look (or a command with extra authority) is refused at the boundary and never reaches the transaction.
  for (const bad of [{ ...change, appearance: { ...look, hair: 'mohawk' } }, { ...change, gladiatorId: operationId }, { kind: 'change-appearance', operationId }]) {
    const refused = await handleCommand(req(bad), routed);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ ok: false, code: 'invalid' });
  }
  expect(calls).toHaveLength(3);
});

it('charges the command rate limit for a look change like any command, and answers a limit before any parsing', async () => {
  let reached = false;
  const limited = { ...deps, database: { ...deps.database, consumeRateLimit: async () => 900,
    changeAppearance: async () => { reached = true; return { ok: false as const, code: 'unavailable' as const }; } } };
  const answer = await handleCommand(req(change), limited);
  expect(answer.status).toBe(429);
  expect(await answer.json()).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 900 });
  expect(reached).toBe(false);
});

// Messages (2026-10-28): marking a message read. It writes no receipt (as presence), so its answer carries none.
const readCommand = { kind: 'read-message' as const, operationId, messageId: 1 };

it('accepts read-message only with a positive safe integer message id and no other key', () => {
  expect(parseCommand(readCommand)).toEqual(readCommand);
  expect(parseCommand({ ...readCommand, messageId: 4242 })).not.toBeNull();
  expect(parseCommand({ ...readCommand, messageId: Number.MAX_SAFE_INTEGER })).not.toBeNull();
  for (const messageId of [0, -1, 1.5, 0.5, '1', '', null, undefined, true, [], [1], {}, NaN, Infinity, -Infinity, 2 ** 53, 1e100, 1e21])
    expect(parseCommand({ ...readCommand, messageId }), String(messageId)).toBeNull();
  const { messageId: _id, ...withoutId } = readCommand;
  expect(parseCommand(withoutId)).toBeNull();
  // The command names no account or other authority: the actor is the verified session's, and a read mark is that account's only.
  for (const extra of [{ ownerId: operationId }, { actorId: operationId }, { gladiatorId: operationId }, { userId: operationId }, { expectedVersion: 1 },
    { extra: 1 }, { readAtMs: 1 }, { read: true }]) expect(parseCommand({ ...readCommand, ...extra }), JSON.stringify(extra)).toBeNull();
  expect(parseCommand({ ...readCommand, operationId: 'bad' })).toBeNull();
  expect(parseCommand({ ...readCommand, operationId: undefined })).toBeNull();
  // A message id rides only on the command that owns it.
  expect(parseCommand({ kind: 'cancel-build', operationId, expectedVersion: 1, messageId: 1 })).toBeNull();
  expect(parseCommand({ kind: 'presence', operationId, messageId: 1 })).toBeNull();
});

it('routes read-message to its own database call with the verified actor and the parsed command, and answers without a receipt', async () => {
  const calls: unknown[] = [];
  const results = [{ ok: true as const, value: { messageId: 1 } }, { ok: false as const, code: 'not-found' as const }];
  const never = (what: string) => async () => { throw new Error(`reading a message must not reach ${what}`); };
  const routed = { ...deps, database: { ...deps.database, plan: never('planning'), inventory: never('the inventory'), market: never('the market'),
    createGladiator: never('creation'), setTournamentOptIn: never('the opt-in'), changeAppearance: never('a look change'),
    readMessage: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return results.shift()!; } } };
  const read = await handleCommand(req(readCommand), routed);
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ ok: true, value: { messageId: 1 } });
  const missing = await handleCommand(req(readCommand), routed);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ ok: false, code: 'not-found' });
  expect(calls).toEqual(Array(2).fill({ actor: { userId: operationId }, command: readCommand }));
  // An invalid id (or a command with extra authority) is refused at the boundary and never reaches the database.
  for (const bad of [{ ...readCommand, messageId: 0 }, { ...readCommand, ownerId: operationId }, { kind: 'read-message', operationId }]) {
    const refused = await handleCommand(req(bad), routed);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ ok: false, code: 'invalid' });
  }
  expect(calls).toHaveLength(2);
});

it('charges the command rate limit for a read mark like any command, and answers a limit before any parsing', async () => {
  let reached = false;
  const limited = { ...deps, database: { ...deps.database, consumeRateLimit: async () => 900,
    readMessage: async () => { reached = true; return { ok: false as const, code: 'unavailable' as const }; } } };
  const answer = await handleCommand(req(readCommand), limited);
  expect(answer.status).toBe(429);
  expect(await answer.json()).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 900 });
  expect(reached).toBe(false);
});

// Notifications (2026-10-28): marking the player's own results seen up to a time. Like a read mark it writes no receipt.
const seeCommand = { kind: 'see-notifications' as const, operationId, upToMs: 1_791_590_400_000 };

it('accepts see-notifications only with a non-negative safe integer time and no other key', () => {
  expect(parseCommand(seeCommand)).toEqual(seeCommand);
  for (const upToMs of [0, 1, 4242, Number.MAX_SAFE_INTEGER]) expect(parseCommand({ ...seeCommand, upToMs }), String(upToMs)).not.toBeNull();
  for (const upToMs of [-1, 1.5, 0.5, '1', '', null, undefined, true, [], [1], {}, NaN, Infinity, -Infinity, 2 ** 53, 1e100, 1e21])
    expect(parseCommand({ ...seeCommand, upToMs }), String(upToMs)).toBeNull();
  const { upToMs: _time, ...withoutTime } = seeCommand;
  expect(parseCommand(withoutTime)).toBeNull();
  // The command names no account: the actor is the verified session's, so a mark is always the caller's own.
  for (const extra of [{ ownerId: operationId }, { actorId: operationId }, { gladiatorId: operationId }, { userId: operationId }, { expectedVersion: 1 },
    { extra: 1 }, { seenMs: 1 }, { messageId: 1 }]) expect(parseCommand({ ...seeCommand, ...extra }), JSON.stringify(extra)).toBeNull();
  expect(parseCommand({ ...seeCommand, operationId: 'bad' })).toBeNull();
  expect(parseCommand({ ...seeCommand, operationId: undefined })).toBeNull();
  // A time rides only on the command that owns it.
  expect(parseCommand({ kind: 'read-message', operationId, messageId: 1, upToMs: 1 })).toBeNull();
  expect(parseCommand({ kind: 'presence', operationId, upToMs: 1 })).toBeNull();
});

it('routes see-notifications to its own database call with the verified actor and the parsed command, and answers without a receipt', async () => {
  const calls: unknown[] = [];
  const results = [{ ok: true as const, value: { seenMs: 1_791_590_400_000 } }, { ok: false as const, code: 'unauthenticated' as const }];
  const never = (what: string) => async () => { throw new Error(`seeing notifications must not reach ${what}`); };
  const routed = { ...deps, database: { ...deps.database, plan: never('planning'), inventory: never('the inventory'), market: never('the market'),
    createGladiator: never('creation'), setTournamentOptIn: never('the opt-in'), changeAppearance: never('a look change'), readMessage: never('a message read'),
    seeNotifications: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return results.shift()!; } } };
  const seen = await handleCommand(req(seeCommand), routed);
  expect(seen.status).toBe(200);
  expect(await seen.json()).toEqual({ ok: true, value: { seenMs: 1_791_590_400_000 } });
  const refused = await handleCommand(req(seeCommand), routed);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({ ok: false, code: 'unauthenticated' });
  expect(calls).toEqual(Array(2).fill({ actor: { userId: operationId }, command: seeCommand }));
  // A bad time (or a command with extra authority) is refused at the boundary and never reaches the database.
  for (const bad of [{ ...seeCommand, upToMs: -1 }, { ...seeCommand, ownerId: operationId }, { kind: 'see-notifications', operationId }]) {
    const invalid = await handleCommand(req(bad), routed);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, code: 'invalid' });
  }
  expect(calls).toHaveLength(2);
});

it('charges the command rate limit for seeing notifications like any command, and answers a limit before any parsing', async () => {
  let reached = false;
  const limited = { ...deps, database: { ...deps.database, consumeRateLimit: async () => 900,
    seeNotifications: async () => { reached = true; return { ok: false as const, code: 'unavailable' as const }; } } };
  const answer = await handleCommand(req(seeCommand), limited);
  expect(answer.status).toBe(429);
  expect(await answer.json()).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 900 });
  expect(reached).toBe(false);
});

it('validates every discriminant and rejects invalid counts, prices, booleans and catalog IDs', () => {
  const commands = [
    { kind: 'edit-schedule', expectedVersion: 1, phase: 'morning', choice: { kind: 'expedition', expeditionId: 'woodland' } },
    { kind: 'queue-build', expectedVersion: 1, classId: 'duelist', stance: 'balanced', allocation: create.allocation,
      equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } },
    { kind: 'cancel-build', expectedVersion: 1 }, { kind: 'buy-shop', catalogId: 'sword:1:common', catalogVersion: 'v1', quantity: 1 },
    { kind: 'sell-item', itemId: operationId, quantity: 1 }, { kind: 'discard-item', itemId: operationId, quantity: 1 },
    { kind: 'create-listing', itemId: operationId, price: 2 }, { kind: 'cancel-listing', listingId: operationId },
    { kind: 'buy-listing', listingId: operationId }, { kind: 'set-tournament-opt-in', enabled: false },
    { kind: 'edit-day-schedule', expectedVersion: 1, day: { morning: { kind: 'rest' }, afternoon: { kind: 'training' }, evening: { kind: 'arena' } } },
  ];
  for (const command of commands) {
    expect(parseCommand({ ...command, operationId })).not.toBeNull();
    expect(parseCommand({ ...command, operationId, ownerId: operationId })).toBeNull();
  }
  for (const command of [{ ...commands[0], expectedVersion: -1 }, { ...commands[0], choice: { kind: 'rest', expeditionId: 'woodland' } },
    { ...commands[2], expectedVersion: 1.5 }, { ...commands[3], quantity: 0 }, { ...commands[3], catalogId: 'missing' },
    { ...commands[3], quantity: Infinity }, { ...commands[4], quantity: 1.5 }, { ...commands[6], price: Number.MAX_SAFE_INTEGER + 1 },
    // Launch feedback: the lowest listing price is 2, so a price of 1 (or less) is invalid.
    { ...commands[6], price: 1 }, { ...commands[6], price: 0 },
    { ...commands[9], enabled: 'false' }]) expect(parseCommand({ ...command, operationId })).toBeNull();
});

// Launch feedback (2026-10-25): Arena is scheduled only in the evening, for both schedule kinds; the day command carries all three parts.
const arena = { kind: 'arena' };
const dayOf = (day: Record<string, unknown> = {}): Record<string, unknown> => ({ morning: { kind: 'rest' }, afternoon: { kind: 'training' }, evening: { kind: 'arena' }, ...day });
const editDay = (patch: Record<string, unknown> = {}) => ({ kind: 'edit-day-schedule', operationId, expectedVersion: 3, day: dayOf(), ...patch });
const editPart = (phase: string, choice: unknown) => ({ kind: 'edit-schedule', operationId, expectedVersion: 1, phase, choice });

it('refuses Arena in the morning and the afternoon for edit-schedule, and accepts it in the evening', () => {
  expect(parseCommand(editPart('morning', arena))).toBeNull();
  expect(parseCommand(editPart('afternoon', arena))).toBeNull();
  expect(parseCommand(editPart('evening', arena))).toEqual(editPart('evening', arena));
  // Every other choice stays open in every part.
  for (const phase of ['morning', 'afternoon', 'evening']) {
    for (const choice of [{ kind: 'training' }, { kind: 'rest' }, { kind: 'expedition', expeditionId: 'woodland' }]) {
      expect(parseCommand(editPart(phase, choice)), `${phase} ${choice.kind}`).toEqual(editPart(phase, choice));
    }
  }
});

it('parses edit-day-schedule with exactly the three parts and refuses Arena outside the evening', () => {
  expect(parseCommand(editDay())).toEqual(editDay());
  // A day with Arena only in the evening, and a day with no Arena at all, are both fine.
  expect(parseCommand(editDay({ day: dayOf({ evening: { kind: 'expedition', expeditionId: 'mountain' } }) }))).not.toBeNull();
  expect(parseCommand(editDay({ day: dayOf({ morning: { kind: 'training' }, evening: { kind: 'rest' } }) }))).not.toBeNull();
  // Arena in the morning or the afternoon refuses the whole day.
  expect(parseCommand(editDay({ day: dayOf({ morning: arena }) }))).toBeNull();
  expect(parseCommand(editDay({ day: dayOf({ afternoon: arena }) }))).toBeNull();
  expect(parseCommand(editDay({ day: { morning: arena, afternoon: arena, evening: arena } }))).toBeNull();
});

it('refuses a day missing a part, with an extra key, or with a malformed part', () => {
  expect(parseCommand(editDay())).not.toBeNull(); // the complete day is the control for every refusal below
  for (const part of ['morning', 'afternoon', 'evening']) {
    const { [part]: _omitted, ...without } = dayOf();
    expect(parseCommand(editDay({ day: without })), `missing ${part}`).toBeNull();
    expect(parseCommand(editDay({ day: dayOf({ [part]: undefined }) })), `undefined ${part}`).toBeNull();
  }
  for (const day of [{ ...dayOf(), night: { kind: 'rest' } }, { ...dayOf(), extra: undefined }, {}, null, [], 'rest', 7,
    dayOf({ morning: { kind: 'sleep' } }), dayOf({ afternoon: { kind: 'expedition', expeditionId: 'missing' } }), dayOf({ afternoon: { kind: 'expedition' } }),
    dayOf({ morning: { kind: 'rest', expeditionId: 'woodland' } }), dayOf({ morning: { kind: 'rest', extra: 1 } }), dayOf({ morning: 'rest' }),
    dayOf({ morning: null }), dayOf({ morning: [] })]) expect(parseCommand(editDay({ day })), JSON.stringify(day)).toBeNull();
  // The day itself must be present, and the command carries no other authority.
  const { day: _day, ...withoutDay } = editDay();
  for (const body of [withoutDay, editDay({ ownerId: operationId }), editDay({ phase: 'morning' }), editDay({ choice: { kind: 'rest' } }),
    editDay({ gladiatorId: operationId }), editDay({ operationId: 'bad' }), editDay({ operationId: undefined })]) expect(parseCommand(body)).toBeNull();
});

it('checks the day command expected version like edit-schedule does', () => {
  for (const expectedVersion of [1, 2, Number.MAX_SAFE_INTEGER]) expect(parseCommand(editDay({ expectedVersion }))).not.toBeNull();
  for (const expectedVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', null, undefined]) {
    expect(parseCommand(editDay({ expectedVersion })), String(expectedVersion)).toBeNull();
  }
  const { expectedVersion: _version, ...withoutVersion } = editDay();
  expect(parseCommand(withoutVersion)).toBeNull();
});

it('answers Arena outside the evening as invalid before any transaction, and routes a valid day to the planning transaction', async () => {
  const calls: unknown[] = [];
  const routed = { ...deps, database: { ...deps.database,
    plan: async (actor: unknown, command: unknown) => { calls.push({ actor, command }); return { ok: false as const, code: 'conflict' as const }; } } };
  for (const body of [editPart('morning', arena), editPart('afternoon', arena), editDay({ day: dayOf({ morning: arena }) }), editDay({ day: dayOf({ afternoon: arena }) })]) {
    const refused = await handleCommand(req(body), routed);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ ok: false, code: 'invalid' });
  }
  expect(calls).toEqual([]);
  for (const body of [editPart('evening', arena), editDay()]) {
    const answered = await handleCommand(req(body), routed);
    expect(answered.status).toBe(409);
    expect(await answered.json()).toEqual({ ok: false, code: 'conflict' });
  }
  expect(calls).toEqual([editPart('evening', arena), editDay()].map(command => ({ actor: { userId: operationId }, command })));
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
    setTournamentOptIn: refuse('setTournamentOptIn'), changeAppearance: refuse('changeAppearance'), readMessage: refuse('readMessage'),
    seeNotifications: refuse('seeNotifications') } as unknown as CommandDependencies['database'];
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

// Task 24.1 (plan Decision 9): every preflight is a billed function invocation, so the browser may cache the command
// preflight for two hours (Chrome's maximum). The exact-origin rule is unchanged: another origin gets no CORS grant at all.
it('lets the browser cache the command preflight for 7200 s, for the allowed origin only', async () => {
  const preflight = (origin?: string) => handleCommand(new Request('http://local', { method: 'OPTIONS',
    headers: { ...(origin ? { Origin: origin } : {}), 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, apikey, content-type' } }), deps);
  const allowed = await preflight('http://127.0.0.1:3000');
  expect(allowed.status).toBe(204);
  expect(Object.fromEntries([...allowed.headers].filter(([name]) => name.startsWith('access-control-')))).toEqual({
    'access-control-allow-origin': 'http://127.0.0.1:3000', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS', 'access-control-max-age': '7200' });
  expect(allowed.headers.get('Vary')).toBe('Origin');
  expect(await allowed.text()).toBe('');
  const refused = await preflight('https://evil.example');
  expect(refused.status).toBe(403);
  expect([...refused.headers].filter(([name]) => name.startsWith('access-control-'))).toEqual([]);
  // Without an Origin there is no CORS grant to cache either.
  const bare = await preflight();
  expect(bare.status).toBe(204);
  expect([...bare.headers].filter(([name]) => name.startsWith('access-control-'))).toEqual([]);
  // Only the preflight is cacheable: a command answer carries no Max-Age.
  expect((await handleCommand(req(create), deps)).headers.has('Access-Control-Max-Age')).toBe(false);
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

// Launch feedback (M23): the day command has its own RPC, edit_day_schedule; the other planning kinds keep theirs.
it('routes edit-day-schedule to the edit_day_schedule RPC with the canonical command and no preparation', async () => {
  const sent: Sent[] = [];
  const answer = { ok: true, receiptId: 'r1', value: { version: 4, receivedAtMs: 1, parts: { morning: null, afternoon: null, evening: { effectiveSlotIndex: 2, effectiveAtMs: 9_600_000 } } } };
  const database = createDatabase(backend(() => json(answer), sent));
  const actor = { userId: ACTOR }, canonical = OPERATION.toLowerCase();
  const day = { kind: 'edit-day-schedule' as const, operationId: OPERATION, expectedVersion: 3,
    day: { morning: { kind: 'rest' as const }, afternoon: { kind: 'training' as const }, evening: { kind: 'arena' as const } } };
  expect(await database.plan(actor, day)).toEqual(answer);
  // No owner-state read: a day save needs no backend preparation.
  expect(sent).toEqual([{ method: 'POST', path: '/rest/v1/rpc/edit_day_schedule', search: '',
    body: { actor_id: ACTOR, operation_id: canonical, input: { command: { ...day, operationId: canonical }, prepared: null } } }]);
  sent.length = 0;
  await database.plan(actor, { kind: 'edit-schedule', operationId: OPERATION, expectedVersion: 1, phase: 'evening', choice: { kind: 'arena' } });
  await database.plan(actor, { kind: 'cancel-build', operationId: OPERATION, expectedVersion: 1 });
  expect(sent.map(r => [r.method, r.path])).toEqual([['POST', '/rest/v1/rpc/edit_schedule'], ['POST', '/rest/v1/rpc/cancel_build']]);
});

it('refuses a price below 2 or above 1,000,000,000 before any RPC', async () => {
  const sent: Sent[] = [];
  const database = createDatabase(backend(() => json({ ok: true, receiptId: 'r1', value: { listingId: operationId, expiresAtMs: 1 } }), sent));
  const routed = { ...deps, database: { ...deps.database, market: database.market } };
  // Launch feedback: 1 is refused (the lowest listing price is 2, so the seller always receives something after the fee).
  for (const price of [1_000_000_001, Number.MAX_SAFE_INTEGER, 1, 0, -1, 1.5, '10', null]) {
    const response = await handleCommand(req({ kind: 'create-listing', operationId, itemId: operationId, price }), routed);
    expect(response.status, String(price)).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: 'invalid' });
  }
  expect(sent).toEqual([]);
  for (const price of [2, 1_000_000_000]) {
    const response = await handleCommand(req({ kind: 'create-listing', operationId, itemId: operationId, price }), routed);
    expect(response.status, String(price)).toBe(200);
  }
  expect(sent.map(r => [r.path, (r.body as { input: { command: { price: number } } }).input.command.price]))
    .toEqual([['/rest/v1/rpc/create_listing', 2], ['/rest/v1/rpc/create_listing', 1_000_000_000]]);
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

it('sends a look change to the change_appearance RPC with the actor, the operation id and the command only', async () => {
  const sent: Sent[] = [];
  const stored = { ok: true, receiptId: 'r1', value: { appearance: look, receivedAtMs: 5 } };
  const database = createDatabase(backend(() => json(stored), sent));
  const id = OPERATION.toLowerCase();
  expect(await database.changeAppearance({ userId: ACTOR }, { kind: 'change-appearance', operationId: OPERATION, appearance: look })).toEqual(stored);
  // The operation id is the lower-case identity PostgreSQL stores, in the command as well as the argument (the receipt compares the command).
  expect(sent).toEqual([{ method: 'POST', path: '/rest/v1/rpc/change_appearance', search: '',
    body: { actor_id: ACTOR, operation_id: id, input: { command: { kind: 'change-appearance', operationId: id, appearance: look } } } }]);
  // A database error stays unavailable and never forwards the driver's message.
  const failing = createDatabase(backend(() => json({ code: 'XX000', message: 'secret database detail', details: null, hint: null }, 500), []));
  await expect(failing.changeAppearance({ userId: ACTOR }, change)).rejects.toThrow('appearance-unavailable');
  const response = await handleCommand(req(change), { ...deps, database: { ...deps.database, changeAppearance: failing.changeAppearance } });
  expect([response.status, await response.json()]).toEqual([503, { ok: false, code: 'unavailable' }]);
});

it('sends a read mark to the read_message RPC with the actor and the message id only, and no operation id', async () => {
  const sent: Sent[] = [];
  const stored = { ok: true, value: { messageId: 7 } };
  const database = createDatabase(backend(() => json(stored), sent));
  expect(await database.readMessage({ userId: ACTOR }, { kind: 'read-message', operationId: OPERATION, messageId: 7 })).toEqual(stored);
  // No receipt exists to replay, so nothing but the account and the message goes to the database.
  expect(sent).toEqual([{ method: 'POST', path: '/rest/v1/rpc/read_message', search: '', body: { actor_id: ACTOR, message_id: 7 } }]);
  // A database error stays unavailable and never forwards the driver's message.
  const failing = createDatabase(backend(() => json({ code: 'XX000', message: 'secret database detail', details: null, hint: null }, 500), []));
  const command = { kind: 'read-message' as const, operationId: OPERATION, messageId: 7 };
  await expect(failing.readMessage({ userId: ACTOR }, command)).rejects.toThrow('message-unavailable');
  const response = await handleCommand(req(command), { ...deps, database: { ...deps.database, readMessage: failing.readMessage } });
  expect([response.status, await response.json()]).toEqual([503, { ok: false, code: 'unavailable' }]);
});

it('sends seeing notifications to the see_notifications RPC with the actor and the time only, and no operation id', async () => {
  const sent: Sent[] = [];
  const stored = { ok: true, value: { seenMs: 1_791_590_400_000 } };
  const database = createDatabase(backend(() => json(stored), sent));
  expect(await database.seeNotifications({ userId: ACTOR }, { kind: 'see-notifications', operationId: OPERATION, upToMs: 1_791_590_400_000 })).toEqual(stored);
  // No receipt exists to replay, so nothing but the account and the time goes to the database.
  expect(sent).toEqual([{ method: 'POST', path: '/rest/v1/rpc/see_notifications', search: '', body: { actor_id: ACTOR, up_to_ms: 1_791_590_400_000 } }]);
  // A database error stays unavailable and never forwards the driver's message.
  const failing = createDatabase(backend(() => json({ code: 'XX000', message: 'secret database detail', details: null, hint: null }, 500), []));
  const command = { kind: 'see-notifications' as const, operationId: OPERATION, upToMs: 1_791_590_400_000 };
  await expect(failing.seeNotifications({ userId: ACTOR }, command)).rejects.toThrow('notifications-unavailable');
  const response = await handleCommand(req(command), { ...deps, database: { ...deps.database, seeNotifications: failing.seeNotifications } });
  expect([response.status, await response.json()]).toEqual([503, { ok: false, code: 'unavailable' }]);
});

// Fixed class and points (spec "Added 2026-10-28"): the build preparation refuses a class change or a lower attribute, so SQL
// receives no preparation and answers `invalid`. The floor is the CURRENT build, never a pending one.
const queueBuild = (patch: Record<string, unknown> = {}) => ({ kind: 'queue-build' as const, operationId, expectedVersion: 1, classId: 'guardian' as const, stance: 'balanced' as const,
  allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 }, equipment: { weapon: null, offHand: null, head: null, body: null, feet: null }, ...patch });
const withPoints = (patch: Record<string, number>) => ({ strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2, ...patch });

it('prepares no build for a class change or a lower attribute, and a free one for everything else', () => {
  const earned12: OwnerState = { ...ownerFixture, progression: { ...ownerFixture.progression, earnedAttributePoints: 12 } };
  expect(prepareBuild(queueBuild({ classId: 'duelist' }), earned12)).toBeNull();
  expect(prepareBuild(queueBuild({ classId: 'berserker', allocation: withPoints({ strength: 3 }) }), earned12)).toBeNull();
  for (const key of ['strength', 'agility', 'vitality', 'endurance', 'precision']) {
    expect(prepareBuild(queueBuild({ allocation: withPoints({ [key]: 1 }) }), earned12), `${key} one lower`).toBeNull();
    expect(prepareBuild(queueBuild({ allocation: withPoints({ [key]: 3 }) }), earned12), `${key} one higher`).toMatchObject({ fee: 0 });
  }
  expect(prepareBuild(queueBuild({ stance: 'defensive' }), earned12)).toMatchObject({ fee: 0, snapshot: { classId: 'guardian', stance: 'defensive' } });
  expect(prepareBuild(queueBuild(), earned12)).toMatchObject({ fee: 0 });
});

it('keeps the current build as the floor while a pending build is queued', () => {
  // The pending build is a duelist with strength 5; the current build is still the guardian with 2 in every attribute.
  const pending = { build: { ...ownerFixture.currentBuild, version: 2, classId: 'duelist' as const, allocations: withPoints({ strength: 5 }) },
    effectiveSlotIndex: 373_250, reservedMoney: 0, reservedItemIds: [], operationId };
  const state: OwnerState = { ...ownerFixture, buildVersion: 2, pendingBuild: pending, progression: { ...ownerFixture.progression, earnedAttributePoints: 15 } };
  // Revised down to the current build's class and values (not below): allowed, so the pending build can still be corrected.
  expect(prepareBuild(queueBuild({ expectedVersion: 2 }), state)).toMatchObject({ fee: 0 });
  expect(prepareBuild(queueBuild({ expectedVersion: 2, allocation: withPoints({ strength: 4 }) }), state)).toMatchObject({ fee: 0 });
  // Repeating the pending build's own class is still a class change, and below the current values is still a decrease.
  expect(prepareBuild(queueBuild({ expectedVersion: 2, classId: 'duelist' }), state)).toBeNull();
  expect(prepareBuild(queueBuild({ expectedVersion: 2, allocation: withPoints({ agility: 1 }) }), state)).toBeNull();
});

it('sends no preparation to the build command when the change is locked', async () => {
  const sent: Sent[] = [];
  const database = createDatabase(backend(name => name === 'owner_state' ? json([{ state: ownerFixture }])
    : json({ ok: false, code: 'invalid' }), sent));
  const actor = { userId: ACTOR };
  expect(await database.plan(actor, queueBuild({ classId: 'duelist' }))).toEqual({ ok: false, code: 'invalid' });
  expect(await database.plan(actor, queueBuild({ allocation: withPoints({ strength: 1, agility: 3 }) }))).toEqual({ ok: false, code: 'invalid' });
  const queued = sent.filter(request => request.path === '/rest/v1/rpc/queue_build').map(request => (request.body as { input: { prepared: unknown } }).input.prepared);
  expect(queued).toEqual([null, null]);
});
