import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import { account, admin, anonymous, sql } from '../fixtures/db.ts';
import { createGameInfoHandler, createMcpVerifier } from '../../supabase/functions/_shared/backend/game-info.ts';

type Tab = 'wiki' | 'future';
type Reply = { ok: true; version: number; document: Record<string, unknown> } | { ok: false; code: string };
type Entry = { id: string; title: string; body: string; patch?: string; video?: string; videoLength?: string };
const read = (tab: Tab) => ({ action: 'read', tab });
const save = (tab: Tab, expectedVersion: number, document: unknown) => ({ action: 'save', tab, expectedVersion, document });
const publish = (tab: Tab, expectedVersion: number) => ({ action: 'publish', tab, expectedVersion });
const wiki = (body: string) => ({ entries: [{ id: 'guide', title: 'Camp guide', body }] });
const future = (body: string) => ({ entries: [{ id: 'planned', title: 'Future plan', body, patch: '1.9' }] });
const invalid = { ok: false, code: 'invalid' };
const forbidden = { ok: false, code: 'forbidden' };
const conflict = { ok: false, code: 'conflict' };
const users: string[] = [];
let before: { published: JSONValue; drafts: JSONValue } | undefined;

// M32 (`_game_info.sql`) seeded both tabs and gave the Wiki two document-level video slots; M33 (`_game_info_guides.sql`,
// from supabase/sql/27-game-info-guides.sql) moves to one optional guide per Wiki entry and removes the slots.
const migrations = new URL('../../supabase/migrations/', import.meta.url);
function migration(suffix: string) {
  const names = readdirSync(migrations).filter(name => name.endsWith(suffix));
  expect(names, suffix).toHaveLength(1);
  return readFileSync(new URL(names[0], migrations), 'utf8').replace(/\r\n/g, '\n');
}
/** M32's seeded document for one tab (its dollar-quoted JSON). */
const seed = (m32: string, tag: Tab) => JSON.parse(m32.match(new RegExp(`\\$${tag}\\$([^]*?)\\$${tag}\\$`))![1]);
const rows = async (tx: Sql) => [...await tx`select 'draft' as kind, tab, version, document from private.game_info_drafts
  union all select 'published', tab, version, document from public.game_info_reads order by kind, tab`];
const ROLLBACK = new Error('rollback-only');
/** What `run` returns inside a transaction that always rolls back. */
async function rolledBack<T>(run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await sql.begin(async tx => { value = await run(tx); throw ROLLBACK; });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return value as T;
}

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
    verifyOwner: async () => { throw Error('This fixture uses the MCP credential'); }, edit,
    feedback: async () => { throw Error('This fixture saves Game Info documents only'); } });
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
    expect(publishedWiki.document).not.toHaveProperty('videos');
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

  it('validates exact shape, IDs, patch numbers, guide links and lengths, and document size', async () => {
    const publishedWiki = await published('wiki');
    const versions = { wiki: publishedWiki.version as number, future: (await published('future')).version as number };
    const entry = { id: 'guide', title: 'Camp guide', body: 'Read the guide.' };
    const guide = { ...entry, video: 'https://youtu.be/0123456789a' };
    const refused: [Tab, unknown][] = [
      // M32's rules, unchanged by M33.
      ['wiki', { ...wiki('text'), entries: [entry, entry] }], ['wiki', { ...wiki('text'), entries: [{ ...entry, title: '   ' }] }],
      ['wiki', { ...wiki('text'), entries: [{ ...entry, patch: '1.9' }] }], ['wiki', { ...wiki('text'), entries: [false] }],
      ['wiki', { ...wiki('text'), entries: [{ ...entry, id: 'Invalid ID' }] }],
      ['wiki', { ...wiki('text'), entries: Array.from({ length: 10 }, (_, i) => ({ ...entry, id: `entry-${i}`, body: '漢'.repeat(600) })) }],
      ['wiki', { ...wiki('text'), entries: [{ ...entry, secret: 'private field' }] }],
      ['future', { entries: [{ ...entry, patch: '1.00' }] }],
      // M33: the document-level video slots are gone on both tabs.
      ['wiki', { ...wiki('text'), videos: [null, null] }], ['wiki', { ...wiki('text'), videos: ['https://youtu.be/0123456789a', null] }],
      ['future', { ...future('text'), videos: [null, null] }],
      // M33: an entry guide is a bare YouTube link (no tracking, no other host), never null or a number.
      ['wiki', { entries: [{ ...entry, video: 'https://www.youtube.com/watch?v=abcdefghijk&si=tracking' }] }],
      ['wiki', { entries: [{ ...entry, video: 'https://youtu.be/0123456789a?si=tracking' }] }],
      ['wiki', { entries: [{ ...entry, video: 'https://example.test/watch?v=abcdefghijk' }] }],
      ['wiki', { entries: [{ ...entry, video: 'http://youtu.be/0123456789a' }] }],
      ['wiki', { entries: [{ ...entry, video: null }] }], ['wiki', { entries: [{ ...entry, video: 42 }] }],
      // M33: a length is m:ss under an hour, only with a guide, never null or a number.
      ['wiki', { entries: [{ ...entry, videoLength: '1:12' }] }], ['wiki', { entries: [{ ...guide, videoLength: null }] }],
      ['wiki', { entries: [{ ...guide, videoLength: '1:2' }] }], ['wiki', { entries: [{ ...guide, videoLength: '60:00' }] }],
      ['wiki', { entries: [{ ...guide, videoLength: '1:60' }] }], ['wiki', { entries: [{ ...guide, videoLength: 72 }] }],
      // M33: no guide on the Future tab.
      ['future', { entries: [{ ...entry, patch: '1.9', video: 'https://youtu.be/0123456789a' }] }],
      ['future', { entries: [{ ...entry, video: 'https://youtu.be/0123456789a', videoLength: '1:12' }] }],
      ['future', { entries: [{ ...entry, videoLength: '1:12' }] }],
    ];
    for (const [tab, document] of refused) {
      expect(await edit(null, true, save(tab, versions[tab], document)), JSON.stringify(document)).toEqual(invalid);
    }
    expect(await edit(null, true, { ...save('wiki', versions.wiki, wiki('valid')), actor_id: null })).toEqual(invalid);
    expect(await edit(null, true, { action: 'read', tab: null })).toEqual(invalid);
    expect(await edit(null, true, read('wiki'))).toMatchObject({ version: versions.wiki, document: publishedWiki.document });
    // A Wiki without any guide (an absent key means no guide) is valid.
    const document = { entries: [entry] };
    expect(await edit(null, true, save('wiki', versions.wiki, document))).toEqual({ ok: true, version: versions.wiki + 1, document });
  });

  it('saves and publishes one optional YouTube guide per Wiki entry, with an optional m:ss length', async () => {
    const owner = await user(true);
    const { version } = await published('wiki');
    const document = { entries: [
      { id: 'combat', title: 'Combat', body: 'Watch the guide.', video: 'https://www.youtube.com/watch?v=abcdefghijk', videoLength: '1:12' },
      { id: 'arena', title: 'Arena', body: 'A guide without a length.', video: 'https://youtu.be/0123456789a' },
      { id: 'long', title: 'Long guide', body: 'The longest length.', video: 'https://youtube.com/watch?v=ABCDEFGHI-_', videoLength: '59:59' },
      { id: 'gear', title: 'Gear', body: 'No guide yet.' },
    ] };
    expect(await saveThroughMcp('wiki', version, document)).toEqual({ tab: 'wiki', version: version + 1, document });
    expect(await edit(owner.id, false, publish('wiki', version + 1))).toEqual({ ok: true, version: version + 2, document });
    expect(await published('wiki')).toEqual({ tab: 'wiki', version: version + 2, document });
    expect(await edit(null, true, read('wiki'))).toEqual({ ok: true, version: version + 2, document });
  });

  it('M33 removed the Wiki video slots from both seeded tabs, published and draft, keeping their versions and entries', async () => {
    const m32 = migration('_game_info.sql');
    const seeded = { wiki: seed(m32, 'wiki'), future: seed(m32, 'future') };
    // The M32 shape the replay started from.
    expect(seeded.wiki.videos).toEqual([null, null]);
    expect(seeded.future).not.toHaveProperty('videos');
    const wikiNow = { entries: seeded.wiki.entries };
    expect(await rows(sql)).toEqual([
      { kind: 'draft', tab: 'future', version: 0, document: seeded.future },
      { kind: 'draft', tab: 'wiki', version: 0, document: wikiNow },
      { kind: 'published', tab: 'future', version: 0, document: seeded.future },
      { kind: 'published', tab: 'wiki', version: 0, document: wikiNow },
    ]);
  });

  it('M33 on rows that already hold M32 video slots drops only the slots, keeps versions and entries, and refuses slots after', async () => {
    const m32 = migration('_game_info.sql'), m33 = migration('_game_info_guides.sql');
    const m32Validator = m32.match(/^create or replace function private\.valid_game_info_document\([^]*?^end \$\$;$/m)![0];
    const definition = async () => (await sql`select pg_get_functiondef('private.valid_game_info_document(text,jsonb)'::regprocedure)
      || (select proacl::text from pg_proc where oid = 'private.valid_game_info_document(text,jsonb)'::regprocedure) as text`)[0].text as string;
    const installed = await definition();
    expect(installed).toContain("SET search_path TO ''");
    const publishedWiki = { entries: [{ id: 'combat', title: 'Combat', body: 'Published text.' }], videos: [null, null] };
    const draftWiki = { entries: [...publishedWiki.entries, { id: 'arena', title: 'Arena', body: 'Unpublished draft.' }], videos: [null, null] };
    const seen = await rolledBack(async tx => {
      // A stand-in that never commits: M32's validator, and M32-shaped Wiki rows at versions a later publish would leave.
      await tx.unsafe(m32Validator);
      await tx`update public.game_info_reads set version = 3, document = ${tx.json(publishedWiki)}::jsonb where tab = 'wiki'`;
      await tx`update private.game_info_drafts set version = 4, document = ${tx.json(draftWiki)}::jsonb where tab = 'wiki'`;
      const futureBefore = (await rows(tx)).filter(row => row.tab === 'future');
      await tx.unsafe(m33);
      const after = await rows(tx);
      const [check] = await tx`select private.valid_game_info_document('wiki', ${tx.json(publishedWiki)}::jsonb) as slots,
        private.valid_game_info_document('wiki', ${tx.json({ entries: publishedWiki.entries })}::jsonb) as plain`;
      return { futureBefore, after, check };
    });
    expect(seen.after).toEqual([
      ...seen.futureBefore.filter(row => row.kind === 'draft'),
      { kind: 'draft', tab: 'wiki', version: 4, document: { entries: draftWiki.entries } },
      ...seen.futureBefore.filter(row => row.kind === 'published'),
      { kind: 'published', tab: 'wiki', version: 3, document: { entries: publishedWiki.entries } },
    ]);
    expect(seen.check).toEqual({ slots: false, plain: true });
    // The stand-in rolled back: the installed validator is unchanged, byte for byte.
    expect(await definition()).toEqual(installed);
  });

  it('accepts both local drafts in docs/game-info (a read-only check), the Wiki with its fourteen filmed guides', async () => {
    const draft = (name: string) => JSON.parse(readFileSync(new URL(`../../docs/game-info/${name}.draft.json`, import.meta.url), 'utf8'));
    const wikiDraft = draft('wiki') as { entries: Entry[] }, futureDraft = draft('future-updates') as { entries: Entry[] };
    expect(wikiDraft).not.toHaveProperty('videos');
    expect(futureDraft).not.toHaveProperty('videos');
    // Indigo Labs, public since 2026-11-12 (wiki-video-links.json); lengths rounded to the nearest second.
    expect(Object.fromEntries(wikiDraft.entries.filter(entry => 'video' in entry || 'videoLength' in entry)
      .map(entry => [entry.id, [entry.video, entry.videoLength]]))).toEqual({
      start: ['https://youtu.be/XMefdNAuKmE', '1:10'], schedule: ['https://youtu.be/33XA-hv1ccQ', '1:02'],
      stamina: ['https://youtu.be/yjRkEQtAgGk', '0:54'], training: ['https://youtu.be/SoPHhPdNSik', '0:59'],
      attributes: ['https://youtu.be/gQ1pgAnvMx0', '1:00'], combat: ['https://youtu.be/VOc0GXqjBQs', '0:47'],
      gear: ['https://youtu.be/TqIACM2ANbM', '1:00'], expeditions: ['https://youtu.be/QJlumCBaxEA', '0:47'],
      dungeons: ['https://youtu.be/EA9JzlguHwI', '0:56'], arena: ['https://youtu.be/x6nEEiJNgck', '0:58'],
      tournaments: ['https://youtu.be/E7oSV5-J2oA', '0:39'], economy: ['https://youtu.be/4bONZX-vm-o', '0:44'],
      titles: ['https://youtu.be/055M38AScrM', '0:42'], results: ['https://youtu.be/YHoyi8G6dTI', '0:45'],
    });
    const checked = await sql.begin('read only', tx => tx`select
      private.valid_game_info_document('wiki', ${tx.json(wikiDraft)}::jsonb) as wiki,
      private.valid_game_info_document('future', ${tx.json(futureDraft)}::jsonb) as future`);
    expect([...checked]).toEqual([{ wiki: true, future: true }]);
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
