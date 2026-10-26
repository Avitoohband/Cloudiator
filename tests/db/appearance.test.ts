import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation, request, directEdge } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase, prepareCreation } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { BODIES, CLOTH_COLOURS, HAIRS, HAIR_COLOURS, SKIN_TONES, validAppearance, type Appearance } from '../../supabase/functions/_shared/domain/appearance.ts';
import { readOwner, readProfile, readWorld } from '../../src/lib/api/reads.ts';

// Gladiator appearance (2026-10-26, M24; spec "Decisions": Storage, Command, Reads). The look chosen at creation is stored in
// public.gladiators.appearance (null = the legacy look), checked by private.valid_appearance (SQL's restatement of
// validAppearance) in create_gladiator and in the column's CHECK, and published in the public actor and the owner read. No
// existing gladiator changes: they stay null, and M24's projection refresh gives their actors `appearance: null`.
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: unknown) => (await handleCommand(request(token, body), deps)).json();
const LOOK: Appearance = { body: 'female', hair: 'ponytail', skin: 3, hairColor: 5, cloth: 11 };
const { cloth: _cloth, ...missing } = LOOK;
const { hairColor: _hairColor, ...withoutHairColor } = LOOK;
/** Task 1's refused looks (tests/domain/appearance.test.ts, tests/backend/commands.test.ts), every one JSON can carry. */
const INVALID: unknown[] = [null, 'female', 0, true, [], [LOOK], {}, missing, { ...withoutHairColor, haircolor: 0 },
  { ...LOOK, skin: 5 }, { ...LOOK, skin: -1 }, { ...LOOK, cloth: 12 }, { ...LOOK, cloth: -1 }, { ...LOOK, hairColor: 6 },
  { ...LOOK, hairColor: 1.5 }, { ...LOOK, skin: 1e100 }, { ...LOOK, skin: '1' }, { ...LOOK, hairColor: '0' }, { ...LOOK, cloth: null },
  { ...LOOK, skin: true }, { ...LOOK, hair: 'mohawk' }, { ...LOOK, body: 'other' }, { ...LOOK, body: 'Male' }, { ...LOOK, hair: 7 },
  { ...LOOK, extra: 1 }, { ...LOOK, ownerId: 'x' }];
/** Every valid look: 2 bodies x 4 hair styles x 5 skin tones x 6 hair colours x 12 clothes colours. */
const EVERY_LOOK: Appearance[] = BODIES.flatMap(body => HAIRS.flatMap(hair => SKIN_TONES.flatMap((_s, skin) =>
  HAIR_COLOURS.flatMap((_h, hairColor) => CLOTH_COLOURS.map((_c, cloth) => ({ body, hair, skin, hairColor, cloth }))))));
const count = async (table: 'gladiators' | 'operation_receipts', ownerId: string) =>
  (await sql.unsafe(`select count(*)::int as n from public.${table} where owner_id=$1`, [ownerId]))[0].n as number;
const stored = async (gid: string) => (await sql`select appearance from public.gladiators where id=${gid}`)[0].appearance as Appearance | null;
const actorOf = async (client: Parameters<typeof readWorld>[0], gid: string) => (await readWorld(client)).actors.find(a => a.gladiatorId === gid)!;

describe('gladiator appearance', () => {
  beforeAll(resetIdentity);
  afterAll(() => sql.end());

  it('restates validAppearance in SQL: the same answer for every look and every refused one, never null', async () => {
    expect(EVERY_LOOK).toHaveLength(2880);
    const candidates = [...EVERY_LOOK, ...INVALID];
    const [{ results }] = await sql`select jsonb_agg(private.valid_appearance(c) order by n) as results
      from jsonb_array_elements(${JSON.stringify(candidates)}::text::jsonb) with ordinality e(c, n)`;
    expect(results).toEqual(candidates.map(candidate => validAppearance(candidate)));
    expect((results as boolean[]).filter(Boolean)).toHaveLength(EVERY_LOOK.length);
    // A CHECK passes on null, so the function answers false for an unknown value, never null.
    expect(await sql`select private.valid_appearance(null) as valid`).toEqual([{ valid: false }]);
    const [fn] = await sql`select l.lanname as language, p.provolatile as volatility, p.prosecdef as definer, p.proconfig as config,
      p.proacl::text as acl from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='private.valid_appearance(jsonb)'::regprocedure`;
    expect(fn).toEqual({ language: 'sql', volatility: 'i', definer: false, config: ['search_path=""'], acl: '{postgres=X/postgres,service_role=X/postgres}' });
  });

  it('adds a nullable appearance column with no default, checked by valid_appearance', async () => {
    expect(await sql`select data_type, is_nullable, column_default from information_schema.columns
      where table_schema='public' and table_name='gladiators' and column_name='appearance'`)
      .toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
    expect(await sql`select conname, pg_get_constraintdef(oid) as definition, convalidated from pg_constraint
      where conrelid='public.gladiators'::regclass and contype='c' and pg_get_constraintdef(oid) like '%appearance%'`)
      .toEqual([{ conname: 'gladiators_appearance_check', definition: 'CHECK (((appearance IS NULL) OR private.valid_appearance(appearance)))', convalidated: true }]);
  });

  it('stores a chosen look and shows it in the owner read, the public actor and the visitor profile', async () => {
    const owner = await account(), other = await account();
    const command = { ...creation('Look Chosen'), appearance: LOOK };
    // A lost reply sent twice at once: one gladiator and one receipt, both answers the stored result.
    const [created, again] = await Promise.all([send(owner.token, command), send(owner.token, command)]);
    expect(created).toMatchObject({ ok: true });
    expect(again).toEqual(created);
    const gid = created.value.gladiatorId;
    expect(await stored(gid)).toEqual(LOOK);
    expect((await readOwner(owner.client)).appearance).toEqual(LOOK);
    expect((await actorOf(other.client, gid)).appearance).toEqual(LOOK);
    expect((await readProfile(anonymous, gid)).actor.appearance).toEqual(LOOK);
    // The receipt keeps the whole command, look included: a replay returns the stored result, and the same operation with
    // another look or none is a conflict (Spec "Command": the receipt replay compares the whole command).
    expect(await sql`select request from public.operation_receipts where owner_id=${owner.id}`).toEqual([{ request: command }]);
    expect(await send(owner.token, command)).toEqual(created);
    expect(await database.createGladiator({ userId: owner.id }, { ...command, appearance: { ...LOOK, cloth: 0 } })).toEqual({ ok: false, code: 'conflict' });
    const { appearance: _look, ...withoutLook } = command;
    expect(await database.createGladiator({ userId: owner.id }, withoutLook)).toEqual({ ok: false, code: 'conflict' });
    expect([await count('gladiators', owner.id), await count('operation_receipts', owner.id)]).toEqual([1, 1]);
    expect(await stored(gid)).toEqual(LOOK);
  });

  it('stores no appearance for a creation without one (an older open tab): the legacy look, null in every read', async () => {
    const owner = await account(), other = await account();
    const created = await send(owner.token, creation('Look Absent'));
    expect(created).toMatchObject({ ok: true });
    const gid = created.value.gladiatorId;
    expect(await stored(gid)).toBeNull();
    expect(await readOwner(owner.client)).toHaveProperty('appearance', null);
    expect(await actorOf(other.client, gid)).toHaveProperty('appearance', null);
    expect((await readProfile(anonymous, gid)).actor).toHaveProperty('appearance', null);
  });

  it('refuses every invalid look past the parser as invalid, leaving no gladiator and no receipt', async () => {
    const owner = await account();
    const command = creation('Look Invalid');
    const prepared = prepareCreation(command);
    const create = async (commandValue: Record<string, unknown>) => {
      const { data, error } = await admin.rpc('create_gladiator', { actor_id: owner.id, operation_id: command.operationId, input: { ...prepared, command: commandValue } });
      expect(error).toBeNull();
      return data;
    };
    for (const appearance of INVALID) expect(await create({ ...prepared.command, appearance }), JSON.stringify(appearance)).toEqual({ ok: false, code: 'invalid' });
    // The sixth key may only be `appearance`, and a valid look carries no other authority with it.
    expect(await create({ ...prepared.command, look: LOOK })).toEqual({ ok: false, code: 'invalid' });
    expect(await create({ ...prepared.command, appearance: LOOK, ownerId: owner.id })).toEqual({ ok: false, code: 'invalid' });
    expect([await count('gladiators', owner.id), await count('operation_receipts', owner.id)]).toEqual([0, 0]);
    // As for every other invalid creation, nothing was stored: the same operation still creates the gladiator with a valid look.
    expect(await create({ ...prepared.command, appearance: LOOK })).toMatchObject({ ok: true });
    expect((await sql`select appearance from public.gladiators where owner_id=${owner.id}`)).toEqual([{ appearance: LOOK }]);
    // Once its receipt exists, the operation replays: a changed command is a conflict before any shape check, as today.
    expect(await create({ ...prepared.command, appearance: { ...LOOK, skin: 5 } })).toEqual({ ok: false, code: 'conflict' });
    expect([await count('gladiators', owner.id), await count('operation_receipts', owner.id)]).toEqual([1, 1]);
  });

  it('creates with a look through the real local Edge runtime, which refuses an invalid one', async () => {
    const owner = await account();
    const denied = directEdge(owner.token, { ...creation('Edge Bad Look'), appearance: { ...LOOK, hair: 'mohawk' } });
    expect([denied.status, denied.body]).toEqual([400, { ok: false, code: 'invalid' }]);
    const look: Appearance = { body: 'male', hair: 'bald', skin: 4, hairColor: 0, cloth: 7 };
    const created = directEdge(owner.token, { ...creation('Edge Look'), appearance: look });
    expect([created.status, created.body.ok]).toEqual([200, true]);
    expect((await readOwner(owner.client)).appearance).toEqual(look);
  });

  it('refuses an invalid direct write with the CHECK and re-projects a valid one', async () => {
    const owner = await account(), other = await account(), stranger = await account();
    const created = await database.createGladiator({ userId: owner.id }, creation('Look Direct'));
    if (!created.ok) throw Error('creation failed');
    const gid = created.value.gladiatorId;
    for (const bad of INVALID) {
      await expect(sql`update public.gladiators set appearance=${JSON.stringify(bad)}::text::jsonb where id=${gid}`, JSON.stringify(bad))
        .rejects.toMatchObject({ code: '23514', constraint_name: 'gladiators_appearance_check' });
    }
    await expect(sql`insert into public.gladiators(id,owner_id,name,stamina_current,stamina_maximum,processed_slot_index,created_at_ms,orientation_end_ms,appearance)
      values(${randomUUID()},${stranger.id},'Look Insert',10,10,0,0,4800000,${JSON.stringify({ ...LOOK, skin: 5 })}::text::jsonb)`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'gladiators_appearance_check' });
    expect(await stored(gid)).toBeNull();
    // A valid write (a later cosmetic change) is accepted, and the gladiators trigger republishes the actor with it.
    await sql`update public.gladiators set appearance=${JSON.stringify(LOOK)}::text::jsonb where id=${gid}`;
    expect((await actorOf(other.client, gid)).appearance).toEqual(LOOK);
    expect((await readOwner(owner.client)).appearance).toEqual(LOOK);
    await sql`update public.gladiators set appearance=null where id=${gid}`;
    expect(await actorOf(other.client, gid)).toHaveProperty('appearance', null);
  });

  it("gives an existing gladiator's actor appearance: null when the projections are refreshed, as M24 does", async () => {
    const owner = await account(), other = await account();
    const created = await database.createGladiator({ userId: owner.id }, creation('Look Legacy'));
    if (!created.ok) throw Error('creation failed');
    const gid = created.value.gladiatorId;
    // An actor projected before M24 has no appearance key.
    await sql`update public.world_actors set actor=actor-'appearance' where gladiator_id=${gid}`;
    expect(await sql`select actor ? 'appearance' as has from public.world_actors where gladiator_id=${gid}`).toEqual([{ has: false }]);
    await sql`select public.refresh_projections()`;
    expect(await sql`select actor ? 'appearance' as has, jsonb_typeof(actor->'appearance') as type from public.world_actors where gladiator_id=${gid}`)
      .toEqual([{ has: true, type: 'null' }]);
    expect(await actorOf(other.client, gid)).toHaveProperty('appearance', null);
    expect(await stored(gid)).toBeNull();
  });

  it('ships M24 with the projection refresh after the column and the restated projector, and no appearance backfill', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const files = readdirSync(dir).filter(name => name.endsWith('_appearance.sql'));
    expect(files).toHaveLength(1);
    expect(readdirSync(dir).filter(name => name.endsWith('.sql')).sort().at(-1)).toBe(files[0]);
    const m24 = readFileSync(new URL(files[0], dir), 'utf8').replace(/\r\n/g, '\n');
    const refresh = m24.lastIndexOf('\nselect public.refresh_projections();\n');
    expect(refresh).toBeGreaterThan(m24.search(/create or replace function "?private"?\."?project_character"?/i));
    expect(refresh).toBeGreaterThan(m24.search(/add column "?appearance"? jsonb/i));
    // The function the CHECK calls exists before the constraint is added.
    expect(m24.search(/create or replace function "?private"?\."?valid_appearance"?/i))
      .toBeLessThan(m24.search(/add constraint "?gladiators_appearance_check"?/i));
    expect(m24.search(/create or replace function "?private"?\."?valid_appearance"?/i)).toBeGreaterThanOrEqual(0);
    // No backfill: existing gladiators keep the legacy look.
    expect(m24).not.toMatch(/update\s+"?public"?\."?gladiators"?\s+set\s+"?appearance/i);
  });
});
