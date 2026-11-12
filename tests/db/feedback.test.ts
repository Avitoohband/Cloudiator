import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, account, admin, anonymous, resetIdentity, creation, request, directEdge, tokenFor } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { createGameInfoHandler, createMcpVerifier } from '../../supabase/functions/_shared/backend/game-info.ts';
import { readOwner } from '../../src/lib/api/reads.ts';

// Patch 1.9 (M34, supabase/sql/28-feedback-buyback.sql): a signed-in player sends feedback through the command endpoint
// (public.send_feedback: receipts, the per-minute rate limit, at most 5 per account and game day); the player reads its own
// rows through row security (six columns); the Game Info editors list, mark read and answer them through the game-info Edge
// function (public.review_feedback, the private.game_info_editors allowlist; never the MCP credential). An answer is one
// `team-reply` row of public.game_messages for that player only, written in the same transaction that marks the item answered.
const GAME_DAY = 14_400_000;
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
type Answer = { status: number; body: { ok: boolean; code?: string; receiptId?: string; value?: { feedbackId: number; leftToday: number } } };
const send = async (token: string, body: unknown): Promise<Answer> => {
  const response = await handleCommand(request(token, body), deps);
  return { status: response.status, body: await response.json() };
};
const DETAILS = { patch: '1.9', screen: 'Arena', device: 'Chrome 131, Windows, desktop', window: '1920 x 1080', sentAtMs: 1_791_590_400_000 };
const feedback = (over: Record<string, unknown> = {}) => ({ kind: 'send-feedback', operationId: randomUUID(), category: 'bug',
  text: 'The Arena timer shows a wrong number.', details: DETAILS, ...over });
/** public.send_feedback as the backend calls it (service_role), past the Edge parser: SQL's own checks. */
const rpc = async (actorId: string | null, command: Record<string, unknown>) => {
  const { data, error } = await admin.rpc('send_feedback', { actor_id: actorId, operation_id: command.operationId ?? null, input: { command } });
  expect(error).toBeNull();
  return data as { ok: boolean; code?: string; value?: { feedbackId: number; leftToday: number } };
};
/** public.review_feedback as the game-info Edge function calls it (service_role) for a verified account. */
const review = async (actorId: string | null, input: Record<string, unknown>) => {
  const { data, error } = await admin.rpc('review_feedback', { actor_id: actorId, input });
  expect(error).toBeNull();
  return data as Record<string, unknown> & { ok: boolean; code?: string };
};
type Stored = { id: number; owner_id: string; gladiator_id: string | null; category: string; text: string; details: unknown; status: string;
  created_at_ms: number; answer: string | null; answered_at_ms: number | null; answer_message_id: number | null };
const rows = async (ownerId: string): Promise<Stored[]> => (await sql`select id::int, owner_id::text, gladiator_id::text, category, text, details, status,
  created_at_ms::float8 as created_at_ms, answer, answered_at_ms::float8 as answered_at_ms, answer_message_id::int
  from public.feedback where owner_id=${ownerId} order by id`) as unknown as Stored[];
const receipts = async (ownerId: string) => (await sql`select count(*)::int as n from public.operation_receipts where owner_id=${ownerId}`)[0].n as number;
const dbNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
/** A signed-in account with a gladiator (created through the adapter, without the HTTP rate limit). */
async function player(name = 'Feedback ' + randomUUID().slice(0, 8)) {
  const owner = await account();
  const created = await database.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId, name };
}
/** Editors this file allowlisted; removed after each case (other rows of the local allowlist are left alone). */
const editors: string[] = [];
async function editor() {
  const owner = await account();
  await sql`insert into private.game_info_editors(user_id) values(${owner.id})`;
  editors.push(owner.id);
  return owner;
}
/** The game-info handler as deployed, its feedback store the real RPC; an owner session is any locally signed token. */
async function ownerEndpoint() {
  const token = randomBytes(32).toString('base64url');
  const calls: unknown[] = [];
  const handle = createGameInfoHandler({ allowedOrigins: ['http://127.0.0.1:3000'], verifyMcp: await createMcpVerifier(token),
    verifyOwner: makeVerifier(anonymous),
    edit: async () => { throw Error('Game Info documents are not part of this test'); },
    feedback: async (actorId, input) => { calls.push(input); const { data, error } = await admin.rpc('review_feedback', { actor_id: actorId, input });
      if (error) throw Error('Feedback store unavailable'); return data; } });
  const call = async (body: unknown, authorization: string, origin: string | null) => {
    const response = await handle(new Request('http://127.0.0.1/functions/v1/game-info', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { mcpToken: token, calls, call };
}

beforeEach(resetIdentity);
afterEach(async () => { await sql`delete from private.game_info_editors where user_id = any(${editors.splice(0)}::uuid[])`; });
afterAll(() => sql.end());
beforeAll(async () => {
  // A run must not straddle a game-day boundary (it resets the daily count); wait out the last two minutes of a game day.
  const remaining = GAME_DAY - (Date.now() % GAME_DAY);
  if (remaining < 120_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
}, 121_000 + 30_000);

describe('feedback', () => {
  it('stores a signed-in player\'s feedback with its account and gladiator, writes a receipt, replays it and counts down the day', async () => {
    const me = await player();
    const from = await dbNow();
    const command = feedback({ category: 'idea', text: '  A way to rename the gladiator would be great.\n', details: null });
    const first = await send(me.token, command);
    expect(first).toEqual({ status: 200, body: { ok: true, receiptId: expect.any(String), value: { feedbackId: expect.any(Number), leftToday: 4 } } });
    const [row] = await rows(me.id);
    expect(row).toEqual({ id: first.body.value!.feedbackId, owner_id: me.id, gladiator_id: me.gid, category: 'idea',
      text: 'A way to rename the gladiator would be great.', details: null, status: 'new', created_at_ms: expect.any(Number),
      answer: null, answered_at_ms: null, answer_message_id: null });
    expect(row.created_at_ms).toBeGreaterThanOrEqual(from);
    // The same operation replays the stored result; another body under it is a conflict; neither stores another row.
    expect(await send(me.token, command)).toEqual(first);
    expect(await send(me.token, { ...command, text: 'Another text, same operation.' })).toEqual({ status: 409, body: { ok: false, code: 'conflict' } });
    expect(await rows(me.id)).toHaveLength(1);
    expect(await receipts(me.id)).toBe(2);
    // Game details are stored exactly as sent, and the day counts down.
    const second = await send(me.token, feedback());
    expect(second.body).toMatchObject({ ok: true, value: { leftToday: 3 } });
    expect((await rows(me.id))[1]).toMatchObject({ category: 'bug', details: DETAILS });
  });

  it('allows 5 a game day per account: the sixth is daily-limit and stores nothing, and the next game day allows again', async () => {
    const me = await player(), other = await player();
    for (let n = 1; n <= 5; n++) expect((await send(me.token, feedback())).body, `send ${n}`).toMatchObject({ ok: true, value: { leftToday: 5 - n } });
    const sixth = feedback();
    expect(await send(me.token, sixth)).toEqual({ status: 409, body: { ok: false, code: 'daily-limit' } });
    // A refusal writes no receipt: the same operation can be sent again on the next game day.
    expect(await sql`select count(*)::int as n from public.operation_receipts where operation_id=${sixth.operationId}`).toEqual([{ n: 0 }]);
    expect(await rows(me.id)).toHaveLength(5);
    // The limit is per account.
    expect((await send(other.token, feedback())).body).toMatchObject({ ok: true, value: { leftToday: 4 } });
    // The game day is floor(planning time / 14,400,000): the five rows move to the previous game day (operator setup).
    await sql`update public.feedback set created_at_ms=created_at_ms-${GAME_DAY} where owner_id=${me.id}`;
    expect((await send(me.token, sixth)).body).toMatchObject({ ok: true, value: { leftToday: 4 } });
    expect(await rows(me.id)).toHaveLength(6);
  });

  it('lets an account without a gladiator send (no gladiator stored) and refuses a missing account', async () => {
    const visitor = await account();
    expect((await send(visitor.token, feedback({ category: 'other' }))).body).toMatchObject({ ok: true, value: { leftToday: 4 } });
    expect(await rows(visitor.id)).toEqual([expect.objectContaining({ gladiator_id: null, category: 'other' })]);
    expect(await rpc(null, feedback())).toEqual({ ok: false, code: 'unauthenticated' });
  });

  it('checks the category, the text (10 to 1,000 characters after trimming) and the details in SQL as well as at the boundary', async () => {
    const me = await player();
    const created = await receipts(me.id);
    // At the boundary: invalid, never reaching the database.
    for (const bad of [feedback({ text: 'nine char' }), feedback({ text: 'x'.repeat(1001) }), feedback({ category: 'feature' }),
      feedback({ details: { ...DETAILS, email: 'me@example.test' } }), feedback({ details: { ...DETAILS, device: 'd'.repeat(81) } })]) {
      expect(await send(me.token, bad), JSON.stringify(bad).slice(0, 80)).toEqual({ status: 400, body: { ok: false, code: 'invalid' } });
    }
    // In SQL, past the parser: the same rules, no receipt and no row.
    const refused = [feedback({ text: ' nine char ' }), feedback({ text: '\t\n         \n' }), feedback({ text: 'x'.repeat(1001) }), feedback({ text: 42 }),
      feedback({ category: 'Bug' }), feedback({ category: null }), feedback({ details: [] }), feedback({ details: 'Arena' }),
      feedback({ details: { ...DETAILS, email: 'me@example.test' } }), feedback({ details: { ...DETAILS, patch: 'p'.repeat(81) } }),
      feedback({ details: { ...DETAILS, sentAtMs: 1.5 } }), feedback({ details: { ...DETAILS, sentAtMs: -1 } }), feedback({ details: { ...DETAILS, screen: 3 } }),
      (({ details: _d, ...rest }) => rest)(feedback()), { ...feedback(), ownerId: me.id }, { ...feedback(), kind: 'sell-item' }];
    for (const bad of refused) expect(await rpc(me.id, bad), JSON.stringify(bad).slice(0, 80)).toEqual({ ok: false, code: 'invalid' });
    // The command's operation id must be the call's own.
    const mismatched = feedback();
    const { data: wrongOperation } = await admin.rpc('send_feedback', { actor_id: me.id, operation_id: randomUUID(), input: { command: mismatched } });
    expect(wrongOperation).toEqual({ ok: false, code: 'invalid' });
    expect(await rows(me.id)).toEqual([]);
    // Only the creation's receipt: no refusal wrote one.
    expect(await receipts(me.id)).toBe(created);
    // The limits themselves pass: 10 and 1,000 characters (an emoji is one), 80-character details and an empty detail.
    for (const ok of [feedback({ text: '  ten chars! ' }), feedback({ text: '😀'.repeat(1000) }),
      feedback({ details: { ...DETAILS, patch: 'p'.repeat(80), screen: '' } })]) {
      expect(await rpc(me.id, ok), JSON.stringify(ok).slice(0, 80)).toMatchObject({ ok: true });
    }
    expect((await rows(me.id)).map(r => [r.text.length, (r.details as { patch?: string } | null)?.patch?.length ?? 0]))
      .toEqual([[10, 3], [2000, 3], [37, 80]]);
    // The table holds the rules too: a direct insert (the operator's own SQL) is refused by its constraints.
    const insert = (text: string, details: unknown, category = 'bug') => sql`insert into public.feedback(owner_id,category,text,details,created_at_ms)
      values(${me.id},${category},${text},${details === null ? null : JSON.stringify(details)}::jsonb,0)`;
    await expect(insert('short', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('long enough text', null, 'feature')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('long enough text', { ...DETAILS, extra: 1 })).rejects.toMatchObject({ code: '23514' });
    await expect(sql`update public.feedback set status='done' where owner_id=${me.id}`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`update public.feedback set status='answered' where owner_id=${me.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('shows a player only its own feedback, six columns of it, and lets no client write or call the RPCs', async () => {
    const me = await player(), other = await player();
    expect((await send(me.token, feedback({ text: 'Only mine to read, please.' }))).body.ok).toBe(true);
    const columns = 'id,category,text,status,created_at_ms,answered_at_ms';
    const mine = await me.client.from('feedback').select(columns);
    expect(mine.error).toBeNull();
    expect(mine.data).toEqual([{ id: expect.any(Number), category: 'bug', text: 'Only mine to read, please.', status: 'new',
      created_at_ms: expect.any(Number), answered_at_ms: null }]);
    // Never the account, the gladiator, the details or the answer columns, even its own.
    for (const column of ['*', 'owner_id', 'gladiator_id', 'details', 'answer', 'answer_message_id']) {
      expect((await me.client.from('feedback').select(column)).error?.code, column).toBe('42501');
    }
    expect((await other.client.from('feedback').select(columns)).data).toEqual([]);
    expect((await anonymous.from('feedback').select('id')).error?.code).toBe('42501');
    for (const [who, client] of [['owner', me.client], ['other', other.client], ['visitor', anonymous]] as const) {
      expect((await client.from('feedback').insert({ owner_id: me.id, category: 'bug', text: 'Forged feedback text', created_at_ms: 0 })).error?.code, who).toBe('42501');
      expect((await client.from('feedback').update({ status: 'answered' }).eq('owner_id', me.id)).error?.code, who).toBe('42501');
      expect((await client.from('feedback').delete().eq('owner_id', me.id)).error?.code, who).toBe('42501');
      for (const [name, args] of [['send_feedback', { actor_id: me.id, operation_id: randomUUID(), input: { command: feedback() } }],
        ['review_feedback', { actor_id: me.id, input: { tab: 'feedback', action: 'list', filter: 'all' } }]] as const) {
        expect((await client.rpc(name, args)).error?.code, `${who} ${name}`).toBe('42501');
      }
    }
    expect(await rows(me.id)).toHaveLength(1);
    // Backend-only, invoker functions with a pinned search path.
    expect(await sql`select p.proname, p.prosecdef, p.proconfig, p.proacl::text as acl from pg_proc p
      where p.oid in ('public.send_feedback(uuid,uuid,jsonb)'::regprocedure, 'public.review_feedback(uuid,jsonb)'::regprocedure) order by 1`)
      .toEqual(['review_feedback', 'send_feedback'].map(proname => ({ proname, prosecdef: false, proconfig: ['search_path=""'],
        acl: '{postgres=X/postgres,service_role=X/postgres}' })));
  });

  it('lets only a Game Info editor list, mark read and answer; others and missing accounts are forbidden', async () => {
    const a = await player('Varro'), b = await player('Aster');
    const owner = await editor(), stranger = await player();
    const ids: number[] = [];
    for (const [who, category] of [[a, 'bug'], [b, 'idea'], [a, 'balance']] as const) {
      ids.push((await send(who.token, feedback({ category, text: `Feedback about ${category} from ${who.name}.` }))).body.value!.feedbackId);
    }
    for (const actor of [null, stranger.id, a.id, randomUUID()]) {
      for (const input of [{ tab: 'feedback', action: 'list', filter: 'all' }, { tab: 'feedback', action: 'mark-read', id: ids[0] },
        { tab: 'feedback', action: 'answer', id: ids[0], text: 'Forged answer.' }]) {
        expect(await review(actor, input), `${actor} ${input.action}`).toEqual({ ok: false, code: 'forbidden' });
      }
    }
    // The editor's list: newest first, each with its text, details, status, time, the gladiator's name and the answer; the New count.
    const all = await review(owner.id, { tab: 'feedback', action: 'list', filter: 'all' });
    expect(all).toEqual({ ok: true, newCount: 3, items: [ids[2], ids[1], ids[0]].map((id, n) => ({ id, category: ['balance', 'idea', 'bug'][n],
      text: [`Feedback about balance from Varro.`, `Feedback about idea from Aster.`, `Feedback about bug from Varro.`][n], details: DETAILS, status: 'new',
      createdAtMs: expect.any(Number), gladiatorName: ['Varro', 'Aster', 'Varro'][n], answer: null, answeredAtMs: null })) });
    // Mark read: New -> Read, idempotent, and Read leaves the New filter.
    expect(await review(owner.id, { tab: 'feedback', action: 'mark-read', id: ids[1] })).toEqual({ ok: true, id: ids[1], status: 'read' });
    expect(await review(owner.id, { tab: 'feedback', action: 'mark-read', id: ids[1] })).toEqual({ ok: true, id: ids[1], status: 'read' });
    const fresh = await review(owner.id, { tab: 'feedback', action: 'list', filter: 'new' });
    expect([(fresh.items as { id: number }[]).map(i => i.id), fresh.newCount]).toEqual([[ids[2], ids[0]], 2]);
    // Answer: Answered once; a second answer is a conflict; mark read keeps it answered; the Answered filter shows it with the answer.
    expect(await review(owner.id, { tab: 'feedback', action: 'answer', id: ids[0], text: '  Thank you, found it.\n\nIt is fixed in the next patch.  ' }))
      .toEqual({ ok: true, id: ids[0], status: 'answered', messageId: expect.any(Number) });
    expect(await review(owner.id, { tab: 'feedback', action: 'answer', id: ids[0], text: 'A second answer.' })).toEqual({ ok: false, code: 'conflict' });
    expect(await review(owner.id, { tab: 'feedback', action: 'mark-read', id: ids[0] })).toEqual({ ok: true, id: ids[0], status: 'answered' });
    const answered = await review(owner.id, { tab: 'feedback', action: 'list', filter: 'answered' });
    expect(answered).toEqual({ ok: true, newCount: 1, items: [expect.objectContaining({ id: ids[0], status: 'answered',
      answer: 'Thank you, found it.\n\nIt is fixed in the next patch.', answeredAtMs: expect.any(Number) })] });
    // Missing items and malformed actions.
    expect(await review(owner.id, { tab: 'feedback', action: 'mark-read', id: 999_999 })).toEqual({ ok: false, code: 'not-found' });
    expect(await review(owner.id, { tab: 'feedback', action: 'answer', id: 999_999, text: 'Hello.' })).toEqual({ ok: false, code: 'not-found' });
    for (const bad of [{ tab: 'feedback', action: 'list', filter: 'read' }, { tab: 'feedback', action: 'list' }, { tab: 'feedback', action: 'list', filter: 'all', x: 1 },
      { tab: 'feedback', action: 'mark-read', id: '1' }, { tab: 'feedback', action: 'mark-read', id: 0 }, { tab: 'feedback', action: 'answer', id: ids[1], text: '   ' },
      { tab: 'feedback', action: 'answer', id: ids[1], text: 'x'.repeat(2001) }, { tab: 'feedback', action: 'answer', id: ids[1] },
      { tab: 'wiki', action: 'list', filter: 'all' }, { tab: 'feedback', action: 'publish' }]) {
      expect(await review(owner.id, bad), JSON.stringify(bad).slice(0, 80)).toEqual({ ok: false, code: 'invalid' });
    }
    expect((await rows(b.id))[0].status).toBe('read');
    // A 2,000-character answer is accepted; the list holds at most 100, newest first.
    expect(await review(owner.id, { tab: 'feedback', action: 'answer', id: ids[1], text: 'y'.repeat(2000) })).toMatchObject({ ok: true });
    await sql`insert into public.feedback(owner_id,category,text,created_at_ms) select ${stranger.id},'other','Bulk feedback number '||n,0 from generate_series(1,105) n`;
    const page = await review(owner.id, { tab: 'feedback', action: 'list', filter: 'all' });
    const listed = (page.items as { id: number }[]).map(i => i.id);
    expect(listed).toHaveLength(100);
    expect(listed).toEqual([...listed].sort((x, y) => y - x));
    expect(page.newCount).toBe(106);
  });

  it('delivers the answer to that player only: one team reply, its title by category, unread for that account alone', async () => {
    const me = await player(), other = await player();
    const owner = await editor();
    const ids: Record<string, number> = {};
    for (const category of ['bug', 'idea', 'balance', 'other']) ids[category] = (await send(me.token, feedback({ category }))).body.value!.feedbackId;
    expect((await readOwner(me.client)).inbox.unread).toBe(0);
    const answer = await review(owner.id, { tab: 'feedback', action: 'answer', id: ids.bug, text: 'Thank you, found it.\nIt is fixed in the next patch.' });
    const messageId = answer.messageId as number;
    const [message] = await sql`select kind, title, preview, body, action, recipient_id::text, published_at_ms::float8 as at, hidden from public.game_messages where id=${messageId}`;
    expect(message).toEqual({ kind: 'team-reply', title: 'Answer to your bug report', preview: 'Thank you, found it. It is fixed in the next patch.',
      body: [{ p: 'Thank you, found it.' }, { p: 'It is fixed in the next patch.' }], action: null, recipient_id: me.id, at: expect.any(Number), hidden: false });
    // The item's answer time is the message's posting time, so a client can pair them; the player reads its row as answered.
    expect((await rows(me.id)).find(r => r.id === ids.bug)).toMatchObject({ status: 'answered', answered_at_ms: message.at, answer_message_id: messageId });
    expect((await me.client.from('feedback').select('id,status,answered_at_ms').eq('id', ids.bug)).data).toEqual([{ id: ids.bug, status: 'answered', answered_at_ms: message.at }]);
    // Only the recipient sees it and counts it; the other account and visitors never do, and cannot mark it read.
    const listed = async (client: typeof anonymous) => ((await client.from('game_messages').select('id,kind,title')).data ?? []).map(m => m.id);
    expect(await listed(me.client)).toEqual([messageId]);
    expect(await listed(other.client)).toEqual([]);
    expect(await listed(anonymous)).toEqual([]);
    expect((await readOwner(me.client)).inbox.unread).toBe(1);
    expect((await readOwner(other.client)).inbox.unread).toBe(0);
    expect((await admin.rpc('read_message', { actor_id: other.id, message_id: messageId })).data).toEqual({ ok: false, code: 'not-found' });
    expect((await admin.rpc('read_message', { actor_id: me.id, message_id: messageId })).data).toEqual({ ok: true, value: { messageId } });
    expect((await readOwner(me.client)).inbox).toMatchObject({ unread: 0, readIds: [messageId] });
    expect((await readOwner(other.client)).inbox).toMatchObject({ unread: 0, readIds: [] });
    // A broadcast still reaches everyone, beside the reply.
    const [{ broadcast }] = await sql`select private.post_message('admin','A note','A note','[{"p":"Hello."}]'::jsonb,null) as broadcast`;
    expect((await readOwner(other.client)).inbox.unread).toBe(1);
    expect(await listed(other.client)).toEqual([Number(broadcast)]);
    // One title per category; a long answer's preview is cut to 140 characters.
    const titles: Record<string, string> = {};
    for (const category of ['idea', 'balance', 'other']) {
      const reply = await review(owner.id, { tab: 'feedback', action: 'answer', id: ids[category], text: 'z'.repeat(300) });
      const [row] = await sql`select title, preview from public.game_messages where id=${reply.messageId as number}`;
      titles[category] = row.title;
      expect(row.preview).toBe('z'.repeat(139) + '…');
    }
    expect(titles).toEqual({ idea: 'Answer to your idea', balance: 'Answer to your balance report', other: 'Answer to your feedback' });
    expect((await readOwner(me.client)).inbox.unread).toBe(4);
  });

  it('forbids the MCP credential every feedback action through the deployed handler, and serves the editor through it', async () => {
    const me = await player(), owner = await editor();
    const id = (await send(me.token, feedback())).body.value!.feedbackId;
    const endpoint = await ownerEndpoint();
    for (const body of [{ tab: 'feedback', action: 'list', filter: 'all' }, { tab: 'feedback', action: 'mark-read', id },
      { tab: 'feedback', action: 'answer', id, text: 'From the MCP.' }]) {
      expect(await endpoint.call(body, `Bearer ${endpoint.mcpToken}`, null), body.action).toEqual({ status: 403, body: { ok: false, code: 'forbidden' } });
    }
    expect(endpoint.calls).toEqual([]);
    expect((await rows(me.id))[0].status).toBe('new');
    // A signed-in player who is not an editor: forbidden by the allowlist.
    expect(await endpoint.call({ tab: 'feedback', action: 'list', filter: 'all' }, `Bearer ${me.token}`, 'http://127.0.0.1:3000'))
      .toEqual({ status: 403, body: { ok: false, code: 'forbidden' } });
    // The editor's session: list, mark read and answer.
    const session = `Bearer ${tokenFor(owner.id)}`;
    const list = await endpoint.call({ tab: 'feedback', action: 'list', filter: 'new' }, session, 'http://127.0.0.1:3000');
    expect(list).toEqual({ status: 200, body: { ok: true, newCount: 1, items: [expect.objectContaining({ id, status: 'new' })] } });
    expect(await endpoint.call({ tab: 'feedback', action: 'mark-read', id }, session, 'http://127.0.0.1:3000'))
      .toEqual({ status: 200, body: { ok: true, id, status: 'read' } });
    expect(await endpoint.call({ tab: 'feedback', action: 'answer', id, text: 'Thanks!' }, session, 'http://127.0.0.1:3000'))
      .toEqual({ status: 200, body: { ok: true, id, status: 'answered', messageId: expect.any(Number) } });
    expect(await endpoint.call({ tab: 'feedback', action: 'answer', id, text: 'Again.' }, session, 'http://127.0.0.1:3000'))
      .toEqual({ status: 409, body: { ok: false, code: 'conflict' } });
  });

  it('sends feedback through the real local Edge runtime', async () => {
    const me = await player();
    const response = directEdge(me.token, feedback({ category: 'balance', text: 'The troll hall feels too hard at level 10.' }));
    expect(response).toMatchObject({ status: 200, origin: 'http://127.0.0.1:3000', body: { ok: true, value: { leftToday: 4 } } });
    expect(directEdge(me.token, feedback({ text: 'short' })).status).toBe(400);
    expect(await rows(me.id)).toEqual([expect.objectContaining({ category: 'balance', text: 'The troll hall feels too hard at level 10.' })]);
  });
});
