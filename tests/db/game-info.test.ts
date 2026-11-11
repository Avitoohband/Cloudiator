import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { JSONValue } from 'postgres';
import { account, admin, anonymous, sql } from '../fixtures/db.ts';
import { createGameInfoHandler, createMcpVerifier } from '../../supabase/functions/_shared/backend/game-info.ts';

type Tab = 'wiki' | 'future';
type Reply = { ok: true; version: number; document: Record<string, unknown> } | { ok: false; code: string };
const read = (tab: Tab) => ({ action: 'read', tab });
const save = (tab: Tab, expectedVersion: number, document: unknown) => ({ action: 'save', tab, expectedVersion, document });
const publish = (tab: Tab, expectedVersion: number) => ({ action: 'publish', tab, expectedVersion });
const wiki = (body: string) => ({ entries: [{ id: 'guide', title: 'Camp guide', body }], videos: [null, null] });
const future = (body: string) => ({ entries: [{ id: 'planned', title: 'Future plan', body, patch: '1.9' }] });
const invalid = { ok: false, code: 'invalid' };
const forbidden = { ok: false, code: 'forbidden' };
const conflict = { ok: false, code: 'conflict' };
const users: string[] = [];
let before: { published: JSONValue; drafts: JSONValue } | undefined;

beforeAll(async () => {
  if (!(await sql`select to_regclass('private.game_info_drafts') as relation`)[0].relation) return;
  const [snapshot] = await sql`select (select jsonb_object_agg(tab, to_jsonb(p)) from public.game_info_reads p) as published,
    (select jsonb_object_agg(tab, to_jsonb(d)) from private.game_info_drafts d) as drafts`;
  before = { published: snapshot.published, drafts: snapshot.drafts };
});

afterEach(async () => {
  for (const id of users.splice(0)) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
  }
  const snapshot = before;
  if (!snapshot) return;
  await sql.begin(async tx => {
    await tx`update public.game_info_reads p set version = (data->>'version')::integer, document = data->'document'
      from jsonb_each(${tx.json(snapshot.published)}) as previous(tab, data) where p.tab = previous.tab`;
    await tx`update private.game_info_drafts d set version = (data->>'version')::integer, document = data->'document'
      from jsonb_each(${tx.json(snapshot.drafts)}) as previous(tab, data) where d.tab = previous.tab`;
  });
});
afterAll(() => sql.end());

async function user(owner = false) {
  const result = await account();
  users.push(result.id);
  if (owner) await sql`insert into private.game_info_editors (user_id) values (${result.id})`;
  return result;
}

async function edit(actorId: string | null, mcp: boolean | null, input: Record<string, unknown>) {
  const { data, error } = await admin.rpc('edit_game_info', { actor_id: actorId, mcp, input });
  expect(error).toBeNull();
  return data as Reply;
}

async function published(tab: Tab) {
  const { data, error } = await anonymous.from('game_info_reads').select('*').eq('tab', tab).single();
  expect(error).toBeNull();
  expect(Object.keys(data!).sort()).toEqual(['document', 'tab', 'version']);
  return data!;
}

async function saveThroughMcp(tab: Tab, expectedVersion: number, document: unknown) {
  const token = randomBytes(32).toString('base64url');
  const handle = createGameInfoHandler({ allowedOrigins: [], verifyMcp: await createMcpVerifier(token),
    verifyOwner: async () => { throw Error('This fixture uses the MCP credential'); }, edit });
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const response = await handle(new Request('http://127.0.0.1/functions/v1/game-info', {
      method: incoming.method, body: Buffer.concat(chunks).toString(), headers: { Authorization: incoming.headers.authorization ?? '' },
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing local fixture address');
    const mcp = spawn(process.execPath, ['scripts/game-info-mcp.mjs'], { stdio: ['pipe', 'pipe', 'ignore'], env: {
      NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      CLOUDIATOR_GAME_INFO_MCP_URL: `http://127.0.0.1:${address.port}/functions/v1/game-info`, CLOUDIATOR_GAME_INFO_MCP_TOKEN: token,
    } });
    const output: string[] = [];
    mcp.stdout.setEncoding('utf8').on('data', (chunk: string) => output.push(chunk));
    const finished = once(mcp, 'close');
    const lines = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/call', params: { name: 'game_info_save_draft', arguments: { tab, expectedVersion, document } } },
    ];
    mcp.stdin.end(lines.map(line => JSON.stringify({ jsonrpc: '2.0', ...line }) + '\n').join(''));
    expect((await finished)[0]).toBe(0);
    const response = output.join('').trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 2);
    expect(response?.result?.isError).toBe(false);
    return response.result.structuredContent;
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('Game Info database boundary', () => {
  it('allows visitors to read only the published documents and refuses client writes or RPC calls', async () => {
    const publishedWiki = await published('wiki');
    expect(publishedWiki.document.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'schedule', title: 'Daily schedule' })]));
    expect(publishedWiki.document.videos).toEqual([null, null]);
    const publishedFuture = await published('future');
    expect(publishedFuture.document.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'parties' })]));
    expect(publishedFuture.document).not.toHaveProperty('videos');

    const owner = await user(true);
    for (const client of [anonymous, owner.client]) {
      expect((await client.from('game_info_reads').update({ document: wiki('forged') }).eq('tab', 'wiki')).error?.code).toBe('42501');
      expect((await client.rpc('edit_game_info', { actor_id: owner.id, mcp: false, input: read('wiki') })).error?.code).toBe('42501');
      for (const relation of ['game_info_drafts', 'game_info_editors']) {
        expect((await client.schema('private').from(relation).select('*')).error?.code).toBe('PGRST106');
      }
    }
  });

  it('requires an allowlisted owner or a distinct draft-only MCP identity', async () => {
    const player = await user();
    const owner = await user(true);
    expect(await edit(player.id, false, read('wiki'))).toEqual(forbidden);
    expect(await edit(null, false, read('wiki'))).toEqual(forbidden);
    expect(await edit(owner.id, true, read('wiki'))).toEqual(forbidden);
    expect(await edit(owner.id, null, read('wiki'))).toEqual(forbidden);
    expect(await edit(null, true, publish('wiki', 0))).toEqual(forbidden);
    expect(await edit(owner.id, false, read('wiki'))).toEqual(await edit(null, true, read('wiki')));
  });

  it('validates exact shape, IDs, patch numbers, video links and document size', async () => {
    const publishedWiki = await published('wiki');
    const version: number = publishedWiki.version;
    const entry = { id: 'guide', title: 'Camp guide', body: 'Read the guide.' };
    for (const document of [
      { entries: [entry] }, { ...wiki('text'), videos: ['https://example.test/watch?v=abcdefghijk', null] },
      { ...wiki('text'), videos: ['https://www.youtube.com/watch?v=abcdefghijk&si=tracking', null] },
      { ...wiki('text'), entries: [entry, entry] }, { ...wiki('text'), entries: [{ ...entry, title: '   ' }] },
      { ...wiki('text'), entries: [{ ...entry, patch: '1.9' }] }, { ...wiki('text'), entries: [false] },
      { ...wiki('text'), entries: [{ ...entry, id: 'Invalid ID' }] },
      { ...wiki('text'), entries: Array.from({ length: 10 }, (_, i) => ({ ...entry, id: `entry-${i}`, body: '漢'.repeat(600) })) },
      { ...wiki('text'), entries: [{ ...entry, secret: 'private field' }] },
    ]) expect(await edit(null, true, save('wiki', version, document))).toEqual(invalid);
    expect(await edit(null, true, { ...save('wiki', version, wiki('valid')), actor_id: null })).toEqual(invalid);
    expect(await edit(null, true, { action: 'read', tab: null })).toEqual(invalid);
    expect(await edit(null, true, save('future', version, { ...future('text'), videos: [null, null] }))).toEqual(invalid);
    expect(await edit(null, true, save('future', version, { entries: [{ ...entry, patch: '1.00' }] }))).toEqual(invalid);
    expect(await edit(null, true, read('wiki'))).toMatchObject({ version, document: publishedWiki.document });
    const document = { entries: [entry], videos: ['https://www.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/0123456789a'] };
    expect(await edit(null, true, save('wiki', version, document))).toEqual({ ok: true, version: version + 1, document });
  });

  it('shares drafts across editors, detects competing writes and publishes one complete approved snapshot', async () => {
    const owner = await user(true);
    for (const [tab, make] of [['wiki', wiki], ['future', future]] as const) {
      const visible = await published(tab);
      const version: number = visible.version;
      const first = make('An unpublished MCP draft.');
      expect(await saveThroughMcp(tab, version, first)).toEqual({ tab, version: version + 1, document: first });
      expect(await edit(owner.id, false, read(tab))).toEqual({ ok: true, version: version + 1, document: first });
      expect(await published(tab)).toEqual(visible);
      expect(await edit(owner.id, false, publish(tab, version))).toEqual(conflict);
      expect(await edit(null, true, publish(tab, version + 1))).toEqual(forbidden);

      const changes = [make('Owner edit.'), make('MCP edit.')];
      const answers = await Promise.all([
        edit(owner.id, false, save(tab, version + 1, changes[0])),
        edit(null, true, save(tab, version + 1, changes[1])),
      ]);
      const winner = answers.findIndex(answer => answer.ok);
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(answers[1 - winner]).toEqual(conflict);
      expect(await edit(owner.id, false, publish(tab, version + 2))).toEqual({ ok: true, version: version + 3, document: changes[winner] });
      expect(await published(tab)).toEqual({ tab, version: version + 3, document: changes[winner] });
      expect(await edit(null, true, read(tab))).toEqual({ ok: true, version: version + 3, document: changes[winner] });
    }
  });
});
