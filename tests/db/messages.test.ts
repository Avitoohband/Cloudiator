import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, account, admin, anonymous, resetIdentity, creation, request, directEdge, tokenFor, recordingClient } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { readMessages, readOwner } from '../../src/lib/api/reads.ts';

// Game messages (2026-10-28, M25; spec "Settled from the code map" and "Decisions": Storage, Posting, Unread). Messages are public
// text in an OPEN table (visible rows only, `using (not hidden)`), posted and hidden by operator-only functions of the `private`
// schema. A player's read marks are an owner-only table written by `public.read_message` (service_role only, no receipt). The owner
// read carries the small `inbox`: how many visible messages published after the gladiator's creation are unread, the ids read, and
// the creation time the client treats older messages by.
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const handle = async (token: string, body: unknown) => { const response = await handleCommand(request(token, body), deps); return { status: response.status, body: await response.json() }; };
beforeEach(resetIdentity);
afterAll(() => sql.end());

type Block = { p: string } | { li: string };
const BODY: Block[] = [{ p: 'What changed:' }, { li: 'First thing.' }, { li: 'Second thing.' }];
type Posted = { kind: string; title: string; preview: string; body: unknown; action: string | null };
/** Posts as the operator (postgres, the role the linked CLI runs as): the id of the new message. */
const post = async (over: Partial<Posted> = {}) => {
  const m: Posted = { kind: 'patch-notes', title: 'Test note', preview: 'A short preview.', body: BODY, action: null, ...over };
  // The body travels as JSON text cast to jsonb, so a JSON null is a JSON null (a driver parameter of null would be a SQL null, and a
  // parameter the server types as jsonb is serialized again by the driver, hence the cast through text).
  const [{ id }] = await sql`select private.post_message(${m.kind}, ${m.title}, ${m.preview}, ${JSON.stringify(m.body)}::text::jsonb, ${m.action}) as id`;
  return Number(id);
};
const hide = async (id: number) => (await sql`select private.hide_message(${id}) as hidden`)[0].hidden as boolean;
const messageCount = async () => (await sql`select count(*)::int as n from public.game_messages`)[0].n as number;
const revision = async () => (await sql`select revision::int as revision from public.world_revision_state where singleton`)[0].revision as number;
/** The database's own clock (the container's may differ from this host's). */
const dbNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** `public.read_message` as the backend calls it (service_role). */
const readMessage = async (actor: string | null, id: number | null) => {
  const { data, error } = await admin.rpc('read_message', { actor_id: actor, message_id: id });
  expect(error).toBeNull();
  return data;
};
const marks = async (ownerId: string) => (await sql`select message_id::int as id, read_at_ms::bigint as at from public.message_reads where owner_id=${ownerId} order by message_id`)
  .map(r => ({ id: r.id as number, at: Number(r.at) }));
const receipts = async (ownerId: string) => (await sql`select count(*)::int as n from public.operation_receipts where owner_id=${ownerId}`)[0].n as number;
const inboxOf = async (ownerId: string) => (await sql`select state->'inbox' as inbox from public.owner_state where owner_id=${ownerId}`)[0]?.inbox;
/** A signed-in account with a gladiator. */
async function player(name: string) {
  const owner = await account();
  const created = await database.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId };
}
const long = (n: number, c = 'x') => c.repeat(n);

describe('game messages', () => {
  it('posts as the operator: an id, the database clock, the row as posted, and a raised world revision', async () => {
    expect(await messageCount()).toBe(0);
    const before = await revision(), from = await dbNow();
    const id = await post({ kind: 'admin', title: 'A note from Avi', preview: 'Hello players.', body: [{ p: 'Hello players.' }, { li: 'One.' }], action: 'change-look' });
    const to = await dbNow();
    // resetIdentity restarts the identity: the first message of a clean database is 1.
    expect(id).toBe(1);
    expect(await revision()).toBeGreaterThan(before);
    const [row] = await sql`select id::int as id, kind, title, preview, body, action, published_at_ms::bigint as at, hidden from public.game_messages`;
    expect({ ...row, at: Number(row.at) }).toEqual({ id: 1, kind: 'admin', title: 'A note from Avi', preview: 'Hello players.', body: [{ p: 'Hello players.' }, { li: 'One.' }],
      action: 'change-look', at: expect.any(Number), hidden: false });
    expect(Number(row.at)).toBeGreaterThanOrEqual(from);
    expect(Number(row.at)).toBeLessThanOrEqual(to);
    // A second post is a new row with the next id, never back-dated; with no action, the action is null.
    const second = await post();
    expect(second).toBe(2);
    const [newest] = await sql`select action, published_at_ms::bigint as at from public.game_messages where id=${second}`;
    expect(newest.action).toBeNull();
    expect(Number(newest.at)).toBeGreaterThanOrEqual(Number(row.at));
  });

  it('keeps post_message and hide_message operator-only: no client role and not service_role may execute them', async () => {
    const signatures = ['private.post_message(text,text,text,jsonb,text)', 'private.hide_message(bigint)', 'private.valid_message_body(jsonb)'];
    for (const fn of signatures) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await sql`select has_function_privilege(${role}::name, ${fn}::text, 'EXECUTE') as ok`)[0].ok, `${role} ${fn}`).toBe(false);
      }
      // No PUBLIC grant either (every role inherits one), and the owner keeps it.
      expect(await sql`select x.grantee from pg_proc p cross join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
        where p.oid=${fn}::regprocedure and x.grantee=0`, `PUBLIC ${fn}`).toEqual([]);
      expect((await sql`select has_function_privilege('postgres'::name, ${fn}::text, 'EXECUTE') as ok`)[0].ok).toBe(true);
    }
    // Calling them as each role is refused (42501) and posts or hides nothing.
    const id = await post();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await expect(sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select private.post_message('admin','Forged','Forged',${tx.json([{ p: 'Forged' }])},null)`;
      }), `${role} post`).rejects.toMatchObject({ code: '42501' });
      await expect(sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select private.hide_message(${id})`;
      }), `${role} hide`).rejects.toMatchObject({ code: '42501' });
    }
    expect(await messageCount()).toBe(1);
    expect((await sql`select hidden from public.game_messages where id=${id}`)[0].hidden).toBe(false);
    // And the Data API does not serve the private schema at all, to the backend, a player or a visitor.
    const owner = await account();
    for (const [who, client] of [['backend', admin], ['player', owner.client], ['visitor', anonymous]] as const) {
      expect((await client.schema('private').rpc('post_message', { kind: 'admin', title: 'Forged', preview: 'Forged', body: [{ p: 'Forged' }], action: null })).error?.code, who).toBe('PGRST106');
      expect((await client.schema('private').rpc('hide_message', { message_id: id })).error?.code, who).toBe('PGRST106');
    }
    expect(await messageCount()).toBe(1);
  });

  it('is a security-invoker function set: invoker, search_path pinned, no definer', async () => {
    const rows = await sql`select p.proname as name, p.prosecdef as definer, p.proconfig as config from pg_proc p
      where p.oid in ('private.post_message(text,text,text,jsonb,text)'::regprocedure, 'private.hide_message(bigint)'::regprocedure,
        'private.valid_message_body(jsonb)'::regprocedure, 'public.read_message(uuid,bigint)'::regprocedure) order by 1`;
    expect(rows).toEqual(['hide_message', 'post_message', 'read_message', 'valid_message_body'].map(name => ({ name, definer: false, config: ['search_path=""'] })));
    // read_message is the backend's only: service_role executes it, and no client role does.
    expect(await sql`select p.proacl::text as acl, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as player, has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p where p.oid='public.read_message(uuid,bigint)'::regprocedure`)
      .toEqual([{ acl: '{postgres=X/postgres,service_role=X/postgres}', anon: false, player: false, backend: true }]);
  });

  it('refuses a bad kind, title, preview, action or body, and stores nothing', async () => {
    const refused: [string, Partial<Posted>][] = [
      ['a kind other than patch-notes or admin', { kind: 'news' }], ['a kind in another case', { kind: 'Admin' }], ['an empty kind', { kind: '' }],
      ['an empty title', { title: '' }], ['a blank title', { title: '   ' }], ['an 81-character title', { title: long(81) }],
      ['an empty preview', { preview: '' }], ['a blank preview', { preview: ' \n ' }], ['a 141-character preview', { preview: long(141) }],
      ['an action other than change-look', { action: 'delete-account' }], ['an empty action', { action: '' }],
      ['no blocks', { body: [] }], ['a body that is not a list', { body: { p: 'x' } }], ['a text body', { body: 'x' }], ['a JSON null body', { body: null }],
      ['a number body', { body: 1 }],
      ['a block with an unknown key', { body: [{ p: 'x', html: '<b>x</b>' }] }], ['a block with only an unknown key', { body: [{ b: 'x' }] }],
      ['a block with both text keys', { body: [{ p: 'x', li: 'y' }] }], ['an empty block', { body: [{}] }],
      ['a block with empty text', { body: [{ p: '' }] }], ['a block of blanks', { body: [{ li: '  \n ' }] }],
      ['a block whose text is a number', { body: [{ p: 5 }] }], ['a block whose text is null', { body: [{ p: null }] }],
      ['a block whose text is an object', { body: [{ li: { p: 'x' } }] }], ['a block that is a string', { body: ['x'] }], ['a block that is null', { body: [null] }],
      ['a block that is a list', { body: [['x']] }],
      ['21 blocks', { body: Array.from({ length: 21 }, () => ({ p: 'x' })) }],
      ['2,001 characters in one block', { body: [{ p: long(2001) }] }],
      ['2,001 characters over two blocks', { body: [{ p: long(1000) }, { li: long(1001) }] }],
      ['a good block after a bad one', { body: [{ p: 'x' }, { p: 'y', extra: 1 }] }],
    ];
    for (const [label, over] of refused) {
      await expect(post(over), label).rejects.toMatchObject({ code: '23514' });
    }
    // A SQL null in any column is refused too (a CHECK alone passes null).
    for (const [label, args] of [['kind', "null,'t','p','[{\"p\":\"x\"}]'::jsonb"], ['title', "'admin',null,'p','[{\"p\":\"x\"}]'::jsonb"],
      ['preview', "'admin','t',null,'[{\"p\":\"x\"}]'::jsonb"], ['body', "'admin','t','p',null::jsonb"]] as const) {
      await expect(sql.unsafe(`select private.post_message(${args})`), `a null ${label}`).rejects.toMatchObject({ code: '23502' });
    }
    expect(await messageCount()).toBe(0);
    // The table itself holds the rules: a direct insert (the operator's own SQL) is refused by the same constraints.
    await expect(sql`insert into public.game_messages(kind,title,preview,body,published_at_ms) values('admin','t','p','[{"p":"x","html":1}]',0)`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'game_messages_body_check' });
    await expect(sql`insert into public.game_messages(kind,title,preview,body,published_at_ms) values('news','t','p','[{"p":"x"}]',0)`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'game_messages_kind_check' });
    expect(await messageCount()).toBe(0);
  });

  it('accepts the limits and stores the text as data, character for character', async () => {
    const markup = '<b>x</b> <script>alert(1)</script> &amp; "quotes" \\ back\\slash \n newline';
    const accepted: [string, Partial<Posted>][] = [
      ['an 80-character title and a 140-character preview', { title: long(80), preview: long(140) }],
      ['a body of exactly 2,000 characters in one block', { body: [{ li: long(2000) }] }],
      ['20 blocks of 100 characters', { body: Array.from({ length: 20 }, (_, i) => (i % 2 ? { li: long(100) } : { p: long(100) })) }],
      ['one block', { body: [{ p: 'x' }] }],
      ['markup, quotes, backslashes and newlines in every text', { title: markup.slice(0, 40), preview: markup, body: [{ p: markup }, { li: markup }] }],
      ['an admin message with the change-look action', { kind: 'admin', action: 'change-look' }],
    ];
    for (const [label, over] of accepted) {
      const id = await post(over);
      expect(id, label).toBeGreaterThan(0);
    }
    expect(await messageCount()).toBe(accepted.length);
    const [stored] = await sql`select title, preview, body from public.game_messages where title=${markup.slice(0, 40)}`;
    expect(stored).toEqual({ title: markup.slice(0, 40), preview: markup, body: [{ p: markup }, { li: markup }] });
  });

  it('shows visitors and players the visible rows only, and a hidden message disappears, even by its id', async () => {
    const player1 = await account();
    const older = await post({ title: 'Older' }), hidden = await post({ title: 'Hidden', action: 'change-look' }), newest = await post({ title: 'Newest' });
    const before = await revision();
    expect(await hide(hidden)).toBe(true);
    expect(await revision()).toBeGreaterThan(before);
    for (const [who, client] of [['visitor', anonymous], ['player', player1.client]] as const) {
      const all = await client.from('game_messages').select('id,kind,title,preview,body,action,published_at_ms,hidden').order('id');
      expect(all.error, who).toBeNull();
      expect(all.data!.map(r => r.id), who).toEqual([older, newest]);
      expect(all.data!.every(r => r.hidden === false), who).toBe(true);
      // Neither a guessed id nor a filter on the flag reaches the hidden row.
      expect((await client.from('game_messages').select('id,title').eq('id', hidden)).data, who).toEqual([]);
      expect((await client.from('game_messages').select('id').eq('hidden', true)).data, who).toEqual([]);
    }
    // Hiding is not a second hide: false for a message already hidden and for one that does not exist.
    expect(await hide(hidden)).toBe(false);
    expect(await hide(999_999)).toBe(false);
    // The stored row is kept (hiding is not deleting), and it is the operator who sees it.
    expect(await sql`select title, hidden from public.game_messages where id=${hidden}`).toEqual([{ title: 'Hidden', hidden: true }]);
  });

  it('lets no client write a message or read another account\'s read marks, through any command', async () => {
    const a = await player('Marks A'), b = await player('Marks B');
    const id = await post({ title: 'Public' });
    expect(await readMessage(a.id, id)).toEqual({ ok: true, value: { messageId: id } });
    for (const [who, client] of [['visitor', anonymous], ['player', a.client]] as const) {
      expect((await client.from('game_messages').insert({ kind: 'admin', title: 'Forged', preview: 'Forged', body: [{ p: 'Forged' }], published_at_ms: 1 })).error?.code, `${who} insert`).toBe('42501');
      expect((await client.from('game_messages').update({ title: 'Changed' }).eq('id', id)).error?.code, `${who} update`).toBe('42501');
      expect((await client.from('game_messages').delete().eq('id', id)).error?.code, `${who} delete`).toBe('42501');
      expect((await client.from('message_reads').insert({ owner_id: a.id, message_id: id, read_at_ms: 1 })).error?.code, `${who} insert mark`).toBe('42501');
      expect((await client.from('message_reads').delete().eq('message_id', id)).error?.code, `${who} delete mark`).toBe('42501');
    }
    expect((await a.client.from('message_reads').update({ read_at_ms: 1 }).eq('message_id', id)).error?.code).toBe('42501');
    // A visitor cannot read the marks at all; a player reads only its own.
    expect((await anonymous.from('message_reads').select('*')).error?.code).toBe('42501');
    expect((await a.client.from('message_reads').select('owner_id,message_id')).data).toEqual([{ owner_id: a.id, message_id: id }]);
    expect((await b.client.from('message_reads').select('owner_id,message_id')).data).toEqual([]);
    expect(await sql`select title from public.game_messages where id=${id}`).toEqual([{ title: 'Public' }]);
    expect(await messageCount()).toBe(1);
  });

  it('marks a message read for the caller\'s account only: a repeat is a no-op, a hidden or missing id is not-found, and no receipt is written', async () => {
    const a = await player('Reader A'), b = await player('Reader B');
    const id = await post(), second = await post({ title: 'Second' });
    const [receiptsA, receiptsB, before] = [await receipts(a.id), await receipts(b.id), await revision()];
    const from = await dbNow();
    expect(await readMessage(a.id, id)).toEqual({ ok: true, value: { messageId: id } });
    const to = await dbNow();
    const [mark] = await marks(a.id);
    expect(mark.id).toBe(id);
    expect(mark.at).toBeGreaterThanOrEqual(from);
    expect(mark.at).toBeLessThanOrEqual(to);
    expect(await marks(b.id)).toEqual([]);
    // A repeat answers the same and keeps the first mark (the read time does not move).
    await sleep(15);
    expect(await readMessage(a.id, id)).toEqual({ ok: true, value: { messageId: id } });
    expect(await marks(a.id)).toEqual([mark]);
    // The other account's mark is its own, and a message is read per account.
    expect(await readMessage(b.id, id)).toEqual({ ok: true, value: { messageId: id } });
    expect((await marks(b.id)).map(m => m.id)).toEqual([id]);
    expect(await marks(a.id)).toEqual([mark]);
    // A hidden message and one that does not exist are not-found, and leave no mark.
    expect(await hide(second)).toBe(true);
    const afterHide = await revision();
    expect(await readMessage(a.id, second)).toEqual({ ok: false, code: 'not-found' });
    for (const missing of [999_999, 0, -1]) expect(await readMessage(a.id, missing), String(missing)).toEqual({ ok: false, code: 'not-found' });
    expect(await readMessage(a.id, null)).toEqual({ ok: false, code: 'not-found' });
    expect(await readMessage(null, id)).toEqual({ ok: false, code: 'unauthenticated' });
    expect((await marks(a.id)).map(m => m.id)).toEqual([id]);
    // No receipt: receipts are permanent, so a read mark must not write one. And a mark changes nothing public.
    expect([await receipts(a.id), await receipts(b.id)]).toEqual([receiptsA, receiptsB]);
    expect(await revision()).toBe(afterHide);
    expect(afterHide).toBeGreaterThan(before);
    // An account with no gladiator may hold a mark too (it only affects its own reads).
    const stranger = await account();
    expect(await readMessage(stranger.id, id)).toEqual({ ok: true, value: { messageId: id } });
    expect((await marks(stranger.id)).map(m => m.id)).toEqual([id]);
    // No client role can call it.
    for (const client of [a.client, anonymous]) {
      expect((await client.rpc('read_message', { actor_id: a.id, message_id: second })).error?.code).toBe('42501');
    }
  });

  it('carries the inbox in the owner read: a message before the gladiator is not counted, one after is, a read lowers it, every session agrees', async () => {
    const early = await post({ title: 'Before' });
    await sleep(8);
    const owner = await player('Inbox Owner');
    await sleep(8);
    const [{ created }] = await sql`select created_at_ms::bigint as created from public.gladiators where id=${owner.gid}`;
    const since = Number(created);
    // A message posted before the gladiator existed is listed (public) but not counted: a new player starts at no badge.
    expect((await readOwner(owner.client)).inbox).toEqual({ unread: 0, readIds: [], sinceMs: since });
    const fresh = await post({ title: 'After' });
    expect((await readOwner(owner.client)).inbox).toEqual({ unread: 1, readIds: [], sinceMs: since });
    // A second session of the same account (another token) reads the same.
    const second = recordingClient(tokenFor(owner.id)).client;
    expect((await readOwner(second)).inbox).toEqual({ unread: 1, readIds: [], sinceMs: since });
    // Reading the new message lowers the count and adds its id; the other session sees the same at once.
    expect(await readMessage(owner.id, fresh)).toEqual({ ok: true, value: { messageId: fresh } });
    expect((await readOwner(owner.client)).inbox).toEqual({ unread: 0, readIds: [fresh], sinceMs: since });
    expect((await readOwner(second)).inbox).toEqual({ unread: 0, readIds: [fresh], sinceMs: since });
    // Reading an old message adds its id too, and never takes the count below what is unread.
    const third = await post({ title: 'Third' });
    expect((await readOwner(owner.client)).inbox.unread).toBe(1);
    expect(await readMessage(owner.id, early)).toEqual({ ok: true, value: { messageId: early } });
    expect((await readOwner(owner.client)).inbox).toEqual({ unread: 1, readIds: [early, fresh].sort((x, y) => x - y), sinceMs: since });
    // A message hidden by the operator drops out of the count and of the ids read.
    expect(await hide(third)).toBe(true);
    expect(await hide(fresh)).toBe(true);
    expect((await readOwner(owner.client)).inbox).toEqual({ unread: 0, readIds: [early], sinceMs: since });
    // Also for a reader that row security does not filter (the database owner, the backend's service role): the view hides it itself.
    expect(await inboxOf(owner.id)).toEqual({ unread: 0, readIds: [early], sinceMs: since });
    const bypassing = await admin.from('owner_state').select('state').eq('owner_id', owner.id).single();
    expect((bypassing.data!.state as { inbox: unknown }).inbox).toEqual({ unread: 0, readIds: [early], sinceMs: since });
    // It is the same rows through the view the Data API serves.
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    expect(error).toBeNull();
    expect((data!.state as { inbox: unknown }).inbox).toEqual({ unread: 0, readIds: [early], sinceMs: since });
  });

  it('counts per account: a player created after a message sees it as read, and nobody sees another account\'s marks, even bypassing row security', async () => {
    const older = await player('Older Player');
    await sleep(8);
    const shared = await post({ title: 'Shared' });
    await sleep(8);
    const newer = await player('Newer Player');
    // The older player sees it unread; the newer one never gets a badge for it.
    expect(await inboxOf(older.id)).toMatchObject({ unread: 1, readIds: [] });
    expect(await inboxOf(newer.id)).toMatchObject({ unread: 0, readIds: [] });
    // The newer player reading it changes nothing for the older one, as seen by the database owner (no row security applies to it,
    // so the view itself must filter by the account).
    expect(await readMessage(newer.id, shared)).toEqual({ ok: true, value: { messageId: shared } });
    expect(await inboxOf(newer.id)).toMatchObject({ unread: 0, readIds: [shared] });
    expect(await inboxOf(older.id)).toMatchObject({ unread: 1, readIds: [] });
    expect((await readOwner(older.client)).inbox).toMatchObject({ unread: 1, readIds: [] });
    // The service role (row security bypassed, as the backend reads owner_state) sees the same per-account inbox.
    const { data, error } = await admin.from('owner_state').select('owner_id,state').in('owner_id', [older.id, newer.id]).order('owner_id');
    expect(error).toBeNull();
    const byOwner = Object.fromEntries(data!.map(r => [r.owner_id, (r.state as { inbox: unknown }).inbox]));
    expect(byOwner[older.id]).toMatchObject({ unread: 1, readIds: [] });
    expect(byOwner[newer.id]).toMatchObject({ unread: 0, readIds: [shared] });
  });

  it('reads the newest 50 messages for visitors and players, newest first, by posting time and then id', async () => {
    const reader = await account();
    const ids: number[] = [];
    for (let n = 1; n <= 52; n++) ids.push(await post({ title: `Note ${n}`, preview: `Preview ${n}`, action: n === 52 ? 'change-look' : null }));
    for (const [who, client] of [['visitor', anonymous], ['player', reader.client]] as const) {
      const list = await readMessages(client);
      expect(list, who).toHaveLength(50);
      expect(list.map(m => m.id), who).toEqual(ids.slice(2).reverse());
      expect(list[0], who).toEqual({ id: ids[51], kind: 'patch-notes', title: 'Note 52', preview: 'Preview 52', body: BODY, action: 'change-look', publishedAtMs: expect.any(Number) });
      expect(list[1].action, who).toBeNull();
    }
    // The newest posting time is listed first whatever its id, and messages posted in the same millisecond list the later id first.
    await sql`update public.game_messages set published_at_ms=9000000000000 where id in (${ids[10]},${ids[11]},${ids[12]})`;
    await sql`update public.game_messages set published_at_ms=9000000000001 where id=${ids[0]}`;
    const list = await readMessages(anonymous);
    expect(list.map(m => m.id).slice(0, 4)).toEqual([ids[0], ids[12], ids[11], ids[10]]);
    // A hidden message is not listed, and the list refills from older ones.
    await hide(ids[51]);
    expect((await readMessages(anonymous)).map(m => m.id)).not.toContain(ids[51]);
    expect(await readMessages(anonymous)).toHaveLength(50);
  });

  it('marks a message read through the command: no receipt, an own-account mark, not-found for a hidden or missing id, invalid for a bad body', async () => {
    const owner = await player('Command Reader'), other = await player('Command Other');
    const id = await post(), hiddenId = await post({ title: 'Hidden' });
    await hide(hiddenId);
    const [receiptsBefore, otherReceipts] = [await receipts(owner.id), await receipts(other.id)];
    const command = { kind: 'read-message', operationId: randomUUID(), messageId: id };
    const answer = await handle(owner.token, command);
    expect(answer).toEqual({ status: 200, body: { ok: true, value: { messageId: id } } });
    expect((await marks(owner.id)).map(m => m.id)).toEqual([id]);
    // The same command again, and another operation id for the same message, are the same no-op; neither stores a receipt.
    expect(await handle(owner.token, command)).toEqual(answer);
    expect(await handle(owner.token, { ...command, operationId: randomUUID() })).toEqual(answer);
    expect(await marks(owner.id)).toHaveLength(1);
    expect(await receipts(owner.id)).toBe(receiptsBefore);
    expect(await marks(other.id)).toEqual([]);
    // A hidden or missing message: 404 not-found, no mark.
    expect(await handle(owner.token, { ...command, messageId: hiddenId })).toEqual({ status: 404, body: { ok: false, code: 'not-found' } });
    expect(await handle(owner.token, { ...command, messageId: 999_999 })).toEqual({ status: 404, body: { ok: false, code: 'not-found' } });
    // The command names no account: any such key is refused at the boundary, and a bad id never reaches the database.
    for (const bad of [{ ...command, ownerId: other.id }, { ...command, actorId: other.id }, { ...command, messageId: 0 }, { ...command, messageId: 1.5 },
      { ...command, messageId: String(id) }, { ...command, extra: 1 }, { kind: 'read-message', operationId: command.operationId }]) {
      expect(await handle(owner.token, bad), JSON.stringify(bad)).toEqual({ status: 400, body: { ok: false, code: 'invalid' } });
    }
    expect(await marks(other.id)).toEqual([]);
    expect([await receipts(owner.id), await receipts(other.id)]).toEqual([receiptsBefore, otherReceipts]);
    // It moves the owner read at once.
    expect((await readOwner(owner.client)).inbox.readIds).toEqual([id]);
  });

  it('marks a message read through the real local Edge runtime, which refuses a bad id and a missing session', async () => {
    const owner = await player('Edge Reader');
    const id = await post(), command = { kind: 'read-message', operationId: randomUUID(), messageId: id };
    const read = directEdge(owner.token, command);
    expect([read.status, read.body]).toEqual([200, { ok: true, value: { messageId: id } }]);
    expect((await marks(owner.id)).map(m => m.id)).toEqual([id]);
    expect(directEdge(owner.token, { ...command, messageId: 999_999 })).toMatchObject({ status: 404, body: { ok: false, code: 'not-found' } });
    expect(directEdge(owner.token, { ...command, messageId: 0 })).toMatchObject({ status: 400, body: { ok: false, code: 'invalid' } });
    expect(directEdge(owner.token, { ...command, ownerId: owner.id })).toMatchObject({ status: 400, body: { ok: false, code: 'invalid' } });
    expect(directEdge('not-a-token', command)).toMatchObject({ status: 401, body: { ok: false, code: 'unauthenticated' } });
    expect(await receipts(owner.id)).toBe(1);
  });

  it('orders its source: the body function before the table whose CHECK calls it, the table before the read marks that reference it (M24 lesson)', () => {
    const source = readFileSync(new URL('../../supabase/sql/18-messages.sql', import.meta.url), 'utf8');
    const at = (needle: string) => { const i = source.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const body = at('create or replace function private.valid_message_body'), messages = at('create table if not exists public.game_messages'),
      reads = at('create table if not exists public.message_reads'), view = at('create or replace view public.owner_state');
    expect(body).toBeLessThan(messages);
    expect(messages).toBeLessThan(reads);
    expect(reads).toBeLessThan(view);
    // The CHECK that calls the function is in the table, after the function; the view reads both tables, after both.
    expect(source.indexOf('private.valid_message_body(body)', messages)).toBeGreaterThan(messages);
  });
});
