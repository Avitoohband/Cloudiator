import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation, request, directEdge } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { Appearance } from '../../supabase/functions/_shared/domain/appearance.ts';
import { readOwner, readProfile, readWorld } from '../../src/lib/api/reads.ts';

// Change look (2026-10-28, M25; spec Goal 4 and "Change look command"): `change-appearance` lets a player replace the look of
// their own gladiator, free and without a limit. public.change_appearance is shaped like public.set_tournament_opt_in (account
// lock, receipt replay and conflict, exact keys, private.valid_appearance, the caller's own gladiator `for update`, a receipt). A
// legacy gladiator (appearance null) is not special: it changes to a chosen look like any other. Updating the column re-projects
// the actor and raises the world revision (M24's project_changed_character trigger), so other players see it on their next read.
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: unknown) => (await handleCommand(request(token, body), deps)).json();
const LOOK: Appearance = { body: 'female', hair: 'ponytail', skin: 3, hairColor: 5, cloth: 11 };
const OTHER_LOOK: Appearance = { body: 'male', hair: 'bald', skin: 4, hairColor: 0, cloth: 7 };
const THIRD_LOOK: Appearance = { body: 'female', hair: 'long', skin: 0, hairColor: 3, cloth: 2 };
const { cloth: _cloth, ...missing } = LOOK;
const { hairColor: _hairColor, ...withoutHairColor } = LOOK;
/** The refused looks of the creation command (tests/db/appearance.test.ts), every one JSON can carry. */
const INVALID: unknown[] = [null, 'female', 0, true, [], [LOOK], {}, missing, { ...withoutHairColor, haircolor: 0 },
  { ...LOOK, skin: 5 }, { ...LOOK, skin: -1 }, { ...LOOK, cloth: 12 }, { ...LOOK, cloth: -1 }, { ...LOOK, hairColor: 6 },
  { ...LOOK, hairColor: 1.5 }, { ...LOOK, skin: 1e100 }, { ...LOOK, skin: '1' }, { ...LOOK, hairColor: '0' }, { ...LOOK, cloth: null },
  { ...LOOK, skin: true }, { ...LOOK, hair: 'mohawk' }, { ...LOOK, body: 'other' }, { ...LOOK, body: 'Male' }, { ...LOOK, hair: 7 },
  { ...LOOK, extra: 1 }, { ...LOOK, ownerId: 'x' }];
const change = <T>(appearance: T, operationId: string = randomUUID()) => ({ kind: 'change-appearance' as const, operationId, appearance });
const rpc = async (actor: string | null, operationId: string | null, command: unknown) => {
  const { data, error } = await admin.rpc('change_appearance', { actor_id: actor, operation_id: operationId, input: { command } });
  expect(error).toBeNull();
  return data;
};
const stored = async (gid: string) => (await sql`select appearance from public.gladiators where id=${gid}`)[0].appearance as Appearance | null;
const projected = async (gid: string) => (await sql`select actor->'appearance' as appearance from public.world_actors where gladiator_id=${gid}`)[0].appearance as Appearance | null;
/** The database's own clock, which `receivedAtMs` is read from (the container's clock may differ from this host's). */
const dbNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
const revision = async () => (await sql`select revision::int as revision from public.world_revision_state where singleton`)[0].revision as number;
const receipts = async (ownerId: string) => (await sql`select count(*)::int as n from public.operation_receipts
  where owner_id=${ownerId} and request->>'kind'='change-appearance'`)[0].n as number;
/** The row's transaction id: any UPDATE of it, even one that changes nothing, gives it a new one. */
const rowVersion = async (gid: string) => (await sql`select xmin::text as xmin from public.gladiators where id=${gid}`)[0].xmin as string;
const actorOf = async (client: Parameters<typeof readWorld>[0], gid: string) => (await readWorld(client)).actors.find(a => a.gladiatorId === gid)!;
/** A signed-in account with a legacy gladiator: one created without a look, so its appearance is null. */
async function legacy(name: string) {
  const owner = await account();
  const created = await send(owner.token, creation(name));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId as string };
}

describe('change look', () => {
  beforeAll(resetIdentity);
  afterAll(() => sql.end());

  it('changes a legacy gladiator to a chosen look: stored, projected, in every read, with the world revision up and a receipt', async () => {
    const owner = await legacy('Change Look'), other = await legacy('Change Bystander');
    expect(await stored(owner.gid)).toBeNull();
    expect(await projected(owner.gid)).toBeNull();
    const before = await revision(), command = change(LOOK), sentAt = await dbNow();
    const saved = await send(owner.token, command);
    const answeredAt = await dbNow();
    expect(saved).toEqual({ ok: true, receiptId: expect.any(String), value: { appearance: LOOK, receivedAtMs: expect.any(Number) } });
    expect(saved.value.receivedAtMs).toBeGreaterThanOrEqual(sentAt);
    expect(saved.value.receivedAtMs).toBeLessThanOrEqual(answeredAt);
    expect(await stored(owner.gid)).toEqual(LOOK);
    expect(await projected(owner.gid)).toEqual(LOOK);
    expect(await revision()).toBeGreaterThan(before);
    // The owner, another player and a visitor read the new look.
    expect((await readOwner(owner.client)).appearance).toEqual(LOOK);
    expect((await actorOf(other.client, owner.gid)).appearance).toEqual(LOOK);
    expect((await actorOf(anonymous, owner.gid)).appearance).toEqual(LOOK);
    expect((await readProfile(anonymous, owner.gid)).actor.appearance).toEqual(LOOK);
    // The receipt keeps the whole command and the answer, and is the account's own.
    expect(await sql`select gladiator_id, request, result from public.operation_receipts where owner_id=${owner.id} and operation_id=${command.operationId}`)
      .toEqual([{ gladiator_id: owner.gid, request: command, result: saved }]);
    expect(saved.receiptId).toEqual((await sql`select receipt_id from public.operation_receipts where owner_id=${owner.id} and operation_id=${command.operationId}`)[0].receipt_id);
    // Nobody else's gladiator changed.
    expect(await stored(other.gid)).toBeNull();
    expect(await projected(other.gid)).toBeNull();
  });

  it('applies every change of a run: no count and no cooldown, each look stored and each raising the world revision', async () => {
    const owner = await legacy('Change Often');
    const looks = [LOOK, OTHER_LOOK, THIRD_LOOK, LOOK, OTHER_LOOK, { ...THIRD_LOOK, hair: 'short' as const }];
    let previous = await revision();
    for (const look of looks) {
      const saved = await send(owner.token, change(look));
      expect(saved, JSON.stringify(look)).toMatchObject({ ok: true, value: { appearance: look } });
      expect(await stored(owner.gid)).toEqual(look);
      expect(await projected(owner.gid)).toEqual(look);
      const now = await revision();
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
    expect(await receipts(owner.id)).toBe(looks.length);
    // Going back to no look at all is not a change the command offers: a look is always exactly five keys.
    expect(await send(owner.token, change(null))).toEqual({ ok: false, code: 'invalid' });
    expect(await stored(owner.gid)).toEqual(looks.at(-1));
  });

  it('writes nothing for the look the gladiator already has: it answers ok with a receipt, never updating the row or the revision', async () => {
    const owner = await legacy('Change Same');
    expect(await send(owner.token, change(LOOK))).toMatchObject({ ok: true });
    const [version, before] = [await rowVersion(owner.gid), await revision()];
    // The same look with its keys in another order is the same look (jsonb compares values, not order).
    const reordered = { cloth: LOOK.cloth, hairColor: LOOK.hairColor, skin: LOOK.skin, hair: LOOK.hair, body: LOOK.body };
    const again = await send(owner.token, change(reordered));
    expect(again).toEqual({ ok: true, receiptId: expect.any(String), value: { appearance: LOOK, receivedAtMs: expect.any(Number) } });
    expect(await rowVersion(owner.gid)).toBe(version);
    expect(await revision()).toBe(before);
    expect(await receipts(owner.id)).toBe(2);
  });

  it('replays the stored answer for the same operation and refuses another look under it, never changing anything again', async () => {
    const owner = await legacy('Change Replay'), operationId = randomUUID();
    const command = change(LOOK, operationId);
    // A lost reply sent twice at once: the account lock makes it one change and one receipt, both answers the stored result.
    const [saved, twin] = await Promise.all([send(owner.token, command), send(owner.token, command)]);
    expect(saved).toMatchObject({ ok: true, value: { appearance: LOOK } });
    expect(twin).toEqual(saved);
    expect(await receipts(owner.id)).toBe(1);
    // A later change does not make the replay revert it: the stored answer comes back and the current look stays.
    expect(await send(owner.token, change(OTHER_LOOK))).toMatchObject({ ok: true });
    const [version, before] = [await rowVersion(owner.gid), await revision()];
    expect(await send(owner.token, command)).toEqual(saved);
    expect(await database.changeAppearance({ userId: owner.id }, { ...command, operationId: operationId.toUpperCase() })).toEqual(saved);
    expect(await stored(owner.gid)).toEqual(OTHER_LOOK);
    expect([await rowVersion(owner.gid), await revision(), await receipts(owner.id)]).toEqual([version, before, 2]);
    // Another look under the used operation id is a conflict, checked before any shape, and writes nothing.
    expect(await send(owner.token, change(THIRD_LOOK, operationId))).toEqual({ ok: false, code: 'conflict' });
    expect(await rpc(owner.id, operationId, { ...command, appearance: THIRD_LOOK })).toEqual({ ok: false, code: 'conflict' });
    expect(await rpc(owner.id, operationId, { ...command, appearance: { ...LOOK, skin: 5 } })).toEqual({ ok: false, code: 'conflict' });
    expect(await rpc(owner.id, operationId, { ...command, extra: 1 })).toEqual({ ok: false, code: 'conflict' });
    expect(await stored(owner.gid)).toEqual(OTHER_LOOK);
    expect([await rowVersion(owner.gid), await revision(), await receipts(owner.id)]).toEqual([version, before, 2]);
  });

  it('gives an account without a gladiator not-found, and writes nothing', async () => {
    const stranger = await account(), operationId = randomUUID();
    const before = await revision();
    expect(await send(stranger.token, change(LOOK, operationId))).toEqual({ ok: false, code: 'not-found' });
    expect(await database.changeAppearance({ userId: stranger.id }, change(LOOK, operationId))).toEqual({ ok: false, code: 'not-found' });
    expect(await sql`select count(*)::int as n from public.operation_receipts where owner_id=${stranger.id}`).toEqual([{ n: 0 }]);
    expect(await revision()).toBe(before);
    // It is not remembered: once the account has a gladiator the same operation applies.
    const created = await send(stranger.token, creation('Change Late'));
    expect(created).toMatchObject({ ok: true });
    expect(await send(stranger.token, change(LOOK, operationId))).toMatchObject({ ok: true, value: { appearance: LOOK } });
    expect(await stored(created.value.gladiatorId)).toEqual(LOOK);
  });

  it('refuses every invalid look and every malformed command as invalid, writing nothing', async () => {
    const owner = await legacy('Change Invalid'), operationId = randomUUID();
    const [version, before] = [await rowVersion(owner.gid), await revision()];
    for (const appearance of INVALID) expect(await rpc(owner.id, operationId, change(appearance, operationId)), JSON.stringify(appearance)).toEqual({ ok: false, code: 'invalid' });
    const valid = change(LOOK, operationId), { appearance: _appearance, ...withoutLook } = valid;
    for (const command of [withoutLook, { ...valid, extra: 1 }, { ...valid, gladiatorId: owner.gid }, { ...valid, ownerId: owner.id },
      { ...valid, kind: 'set-tournament-opt-in' }, { ...valid, kind: undefined }, { ...valid, operationId: randomUUID() }, { ...valid, operationId: undefined },
      { ...valid, operationId: 'x' }, null, 'change-appearance', [valid], {}]) {
      expect(await rpc(owner.id, operationId, command), JSON.stringify(command)).toEqual({ ok: false, code: 'invalid' });
    }
    // A missing envelope, no operation id and no actor are refused too.
    const { data, error } = await admin.rpc('change_appearance', { actor_id: owner.id, operation_id: operationId, input: {} });
    expect([error, data]).toEqual([null, { ok: false, code: 'invalid' }]);
    expect(await rpc(owner.id, null, valid)).toEqual({ ok: false, code: 'invalid' });
    expect(await rpc(null, operationId, valid)).toEqual({ ok: false, code: 'unauthenticated' });
    expect(await stored(owner.gid)).toBeNull();
    expect([await rowVersion(owner.gid), await revision(), await receipts(owner.id)]).toEqual([version, before, 0]);
    // As for every other invalid command nothing was stored: the same operation still applies with a valid look.
    expect(await rpc(owner.id, operationId, valid)).toMatchObject({ ok: true, value: { appearance: LOOK } });
    expect(await stored(owner.gid)).toEqual(LOOK);
    expect(await receipts(owner.id)).toBe(1);
  });

  it('changes only the caller\'s own gladiator, whatever the command carries', async () => {
    const owner = await legacy('Change Mine'), victim = await legacy('Change Victim');
    const before = await revision();
    // The command has no way to name a gladiator: the actor is the verified session's, and any such key is refused.
    for (const authority of [{ gladiatorId: victim.gid }, { ownerId: victim.id }, { actorId: victim.id }]) {
      expect(await send(owner.token, { ...change(LOOK), ...authority }), JSON.stringify(authority)).toEqual({ ok: false, code: 'invalid' });
      expect(await rpc(owner.id, randomUUID(), { ...change(LOOK), ...authority })).toEqual({ ok: false, code: 'invalid' });
    }
    expect(await stored(victim.gid)).toBeNull();
    expect(await revision()).toBe(before);
    expect(await send(owner.token, change(LOOK))).toMatchObject({ ok: true });
    expect([await stored(owner.gid), await stored(victim.gid)]).toEqual([LOOK, null]);
    expect(await receipts(victim.id)).toBe(0);
  });

  it('changes the look through the real local Edge runtime, which refuses an invalid one and an extra key', async () => {
    const owner = await legacy('Change Edge');
    const denied = directEdge(owner.token, change({ ...LOOK, hair: 'mohawk' }));
    expect([denied.status, denied.body]).toEqual([400, { ok: false, code: 'invalid' }]);
    const extra = directEdge(owner.token, { ...change(LOOK), gladiatorId: owner.gid });
    expect([extra.status, extra.body]).toEqual([400, { ok: false, code: 'invalid' }]);
    expect(await stored(owner.gid)).toBeNull();
    const command = change(OTHER_LOOK), changed = directEdge(owner.token, command);
    expect([changed.status, changed.body.ok, changed.body.value.appearance]).toEqual([200, true, OTHER_LOOK]);
    expect((await readOwner(owner.client)).appearance).toEqual(OTHER_LOOK);
    expect(await projected(owner.gid)).toEqual(OTHER_LOOK);
    // A replay through the endpoint is the stored answer; another look under the operation is a conflict (409).
    expect(directEdge(owner.token, command)).toMatchObject({ status: 200, body: changed.body });
    expect(directEdge(owner.token, change(LOOK, command.operationId))).toMatchObject({ status: 409, body: { ok: false, code: 'conflict' } });
    const stranger = await account();
    expect(directEdge(stranger.token, change(LOOK))).toMatchObject({ status: 404, body: { ok: false, code: 'not-found' } });
    expect(directEdge('not-a-token', change(LOOK))).toMatchObject({ status: 401, body: { ok: false, code: 'unauthenticated' } });
    expect(await stored(owner.gid)).toEqual(OTHER_LOOK);
  });

  it('is a backend-only security-invoker function: no client role can run it', async () => {
    expect(await sql`select p.prosecdef as definer, p.proconfig as config, p.proacl::text as acl, l.lanname as language,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as player,
      has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='public.change_appearance(uuid,uuid,jsonb)'::regprocedure`)
      .toEqual([{ definer: false, config: ['search_path=""'], acl: '{postgres=X/postgres,service_role=X/postgres}', language: 'plpgsql', anon: false, player: false, backend: true }]);
    const owner = await legacy('Change Closed');
    for (const client of [owner.client, anonymous]) {
      const operationId = randomUUID();
      expect((await client.rpc('change_appearance', { actor_id: owner.id, operation_id: operationId, input: { command: change(LOOK, operationId) } })).error).not.toBeNull();
    }
    expect(await stored(owner.gid)).toBeNull();
    expect(await receipts(owner.id)).toBe(0);
  });
});
