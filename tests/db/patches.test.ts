import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { sql, account, admin, anonymous, resetIdentity } from '../fixtures/db.ts';
import { parseChangelog } from '../../scripts/changelog.mjs';
import { patchSortKey } from '../../src/lib/patch';

// Patch numbers (Patch A spec, "Patch numbers and the changelog", Server; Task 11b; source supabase/sql/19-patches.sql, M26). The
// server's list of patches and their features is public text in two OPEN tables that nobody writes through the Data API; the
// operator records a patch with private.record_patch (no client role and not service_role may execute it), stamped with the
// database clock. The newest patch rides the revision read (public.world_revision.latest_patch). The seed is CHANGELOG.md's
// released sections, word for word.
beforeEach(resetIdentity);
afterAll(() => sql.end());

const SEED_TIMES: Record<string, number> = { '1.0': 1792920000000, '1.1': 1793006949000, '1.2': 1793095651000, '1.2.1': 1793115007000,
  '1.3': 1793263477000, '1.3.1': 1793295600000 };
/** CHANGELOG.md's released sections that M26 seeds, 1.0 to 1.3.1: a later patch is recorded at its own release, so a dated 1.4 section
 * (the release finalizes it) is not part of the seed. */
const seeded = () => parseChangelog(readFileSync(new URL('../../docs/CHANGELOG.md', import.meta.url), 'utf8'))
  .filter(s => !s.planned && s.date !== null && patchSortKey(s.number)! <= patchSortKey('1.3.1')!);
/** The database's own clock (the container's may differ from this host's). */
const dbNow = async (q: postgres.Sql | postgres.TransactionSql = sql) => Number((await q`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
/** Posts a message as the operator: its id. */
const post = async (kind: string, title: string) =>
  Number((await sql`select private.post_message(${kind}, ${title}, 'A preview.', '[{"p":"Body."}]'::jsonb, null) as id`)[0].id);

class RolledBack extends Error {}
/** Runs `body` as the owner in a transaction that always rolls back: what it returned, or the error it raised. */
async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let seen: T | undefined;
  await sql.begin(async tx => { seen = await body(tx); throw new RolledBack(); }).catch(error => { if (!(error instanceof RolledBack)) throw error; });
  return seen as T;
}
/** The SQLSTATE a write raised inside a rolled-back transaction (null when it succeeded). */
async function refusal(body: (tx: postgres.TransactionSql) => Promise<unknown>) {
  try { await rolledBack(body); return null; } catch (error) { return (error as { code?: string }).code ?? String(error); }
}
const record = (tx: postgres.TransactionSql, number: string, features: string[] = ['One.'], messageId: number | null = null, title = 'Test patch') =>
  tx`select private.record_patch(${number}, ${title}, ${features}::text[], ${messageId}) as number`;
const seedRows = async () => (await sql`select number, sort_key::int as key, title, released_at_ms::bigint as at, message_id::int as message
  from public.patches order by sort_key desc`).map(r => ({ number: r.number as string, key: r.key as number, title: r.title as string,
  at: Number(r.at), message: r.message as number | null }));
const featuresOf = async (q: postgres.Sql | postgres.TransactionSql, number: string) =>
  (await q`select position::int as position, text from public.patch_features where patch=${number} order by position`).map(r => ({ position: r.position as number, text: r.text as string }));

describe('patch numbers', () => {
  it('seeds 1.0 to 1.3.1 exactly as CHANGELOG.md says', async () => {
    const rows = await seedRows();
    expect(rows.map(r => r.number)).toEqual(['1.3.1', '1.3', '1.2.1', '1.2', '1.1', '1.0']);
    expect(rows.map(r => r.key)).toEqual([1003001, 1003000, 1002001, 1002000, 1001000, 1000000]);
    const sections = seeded();
    expect(sections.map(s => s.number)).toEqual(rows.map(r => r.number));
    for (const [i, row] of rows.entries()) {
      const section = sections[i];
      expect(row.title, row.number).toBe(section.title);
      expect(new Date(row.at).toISOString().slice(0, 10), row.number).toBe(section.date);
      expect((await featuresOf(sql, row.number)).map(f => f.text), row.number).toEqual(section.features);
      expect((await featuresOf(sql, row.number)).map(f => f.position), row.number).toEqual(section.features.map((_, j) => j + 1));
    }
    expect(Object.fromEntries(rows.map(r => [r.number, r.at]))).toEqual(SEED_TIMES);
    // A replayed local database has no patch notes, so no row names one (production links notes 1-4 by their titles).
    expect(rows.map(r => r.message)).toEqual([null, null, null, null, null, null]);
    expect((await sql`select latest_patch from public.world_revision`)[0].latest_patch).toBe('1.3.1');
  });

  it('records a patch as the operator, stamped now, and shows it on the revision read', async () => {
    const seen = await rolledBack(async tx => {
      const from = await dbNow(tx);
      const [{ number }] = await record(tx, '1.4', ['One.', 'Two.']);
      const to = await dbNow(tx);
      const [row] = await tx`select title, released_at_ms::bigint as at, message_id from public.patches where number='1.4'`;
      const features = await featuresOf(tx, '1.4');
      await tx.unsafe('set local role anon');
      const [{ latest_patch: latest }] = await tx`select latest_patch from public.world_revision`;
      return { number, title: row.title, at: Number(row.at), from, to, message: row.message_id, features, latest };
    });
    expect(seen.number).toBe('1.4');
    expect(seen.title).toBe('Test patch');
    expect(seen.message).toBeNull();
    expect(seen.features).toEqual([{ position: 1, text: 'One.' }, { position: 2, text: 'Two.' }]);
    // Stamped with the database clock at the call: never back-dated, and within 5 s of the database's time.
    expect(seen.at).toBeGreaterThanOrEqual(seen.from);
    expect(seen.at).toBeLessThanOrEqual(seen.to);
    expect(seen.to - seen.at).toBeLessThan(5_000);
    expect(seen.latest).toBe('1.4');
    // The transaction rolled back: the seed is unchanged.
    expect((await sql`select latest_patch from public.world_revision`)[0].latest_patch).toBe('1.3.1');
  });

  it('links a visible patch note, and a later patch with a third number', async () => {
    const note = await post('patch-notes', 'A patch note');
    const seen = await rolledBack(async tx => {
      await record(tx, '1.4', ['One.'], note);
      await record(tx, '1.4.1', ['Fix.']);
      return { rows: await tx`select number, message_id::int as message from public.patches where sort_key>1003001 order by sort_key`,
        latest: (await tx`select latest_patch from public.world_revision`)[0].latest_patch };
    });
    expect(seen.rows).toEqual([{ number: '1.4', message: note }, { number: '1.4.1', message: null }]);
    expect(seen.latest).toBe('1.4.1');
  });

  it('refuses a bad patch', async () => {
    const admin = await post('admin', 'A note from Avi');
    const hidden = await post('patch-notes', 'A hidden note');
    await sql`select private.hide_message(${hidden})`;
    const twentyOne = Array.from({ length: 21 }, (_, i) => `Feature ${i + 1}.`);
    const cases: [string, (tx: postgres.TransactionSql) => Promise<unknown>, string[]][] = [
      ['a repeated number', async tx => { await record(tx, '1.4'); await record(tx, '1.4'); }, ['23505']],
      ['a seeded number', tx => record(tx, '1.3'), ['23505']],
      ['a number not above 1.4', async tx => { await record(tx, '1.4'); await record(tx, '1.3.2'); }, ['23514']],
      ['a number below the newest seed', tx => record(tx, '1.2.2'), ['23514']],
      ['no features', tx => record(tx, '1.4', []), ['23514']],
      ['a null list', tx => tx`select private.record_patch('1.4', 'Test patch', null::text[], null)`, ['23514']],
      ['21 features', tx => record(tx, '1.4', twentyOne), ['23514']],
      ['an admin message', tx => record(tx, '1.4', ['One.'], admin), ['23514']],
      ['a hidden patch note', tx => record(tx, '1.4', ['One.'], hidden), ['23514']],
      ['no message', tx => record(tx, '1.4', ['One.'], 999_999), ['23514']],
      ['1.3.0', tx => record(tx, '1.3.0'), ['23514', '22P02']],
      ['x', tx => record(tx, 'x'), ['23514', '22P02']],
      ['a 241-character feature', tx => record(tx, '1.4', ['x'.repeat(241)]), ['23514']],
      ['a blank feature', tx => record(tx, '1.4', ['   ']), ['23514']],
      ['a blank title', tx => record(tx, '1.4', ['One.'], null, ' '), ['23514']],
      ['an 81-character title', tx => record(tx, '1.4', ['One.'], null, 'x'.repeat(81)), ['23514']],
    ];
    for (const [label, body, codes] of cases) expect(codes, label).toContain(await refusal(body));
    // Nothing was stored: the six seed rows only.
    expect((await seedRows()).map(r => r.number)).toEqual(['1.3.1', '1.3', '1.2.1', '1.2', '1.1', '1.0']);
    expect((await sql`select count(*)::int as n from public.patch_features`)[0].n).toBe(seeded().reduce((n, s) => n + s.features.length, 0));
    // The limits are accepted: 20 features of 240 characters and an 80-character title.
    const limits = await rolledBack(async tx => {
      await record(tx, '1.4', Array.from({ length: 20 }, () => 'y'.repeat(240)), null, 't'.repeat(80));
      return (await tx`select count(*)::int as n from public.patch_features where patch='1.4'`)[0].n;
    });
    expect(limits).toBe(20);
  });

  it('keeps record_patch operator-only: invoker, search_path pinned, and no client role or service_role may execute it', async () => {
    const fn = 'private.record_patch(text,text,text[],bigint)';
    expect(await sql`select p.prosecdef as definer, p.proconfig as config, p.proacl::text as acl from pg_proc p where p.oid=${fn}::regprocedure`)
      .toEqual([{ definer: false, config: ['search_path=""'], acl: '{postgres=X/postgres}' }]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await sql`select has_function_privilege(${role}::name, ${fn}::text, 'EXECUTE') as ok`)[0].ok, role).toBe(false);
      expect(await refusal(async tx => { await tx.unsafe(`set local role ${role}`); await record(tx, '1.4'); }), role).toBe('42501');
    }
  });

  it('lets everyone read the patches and nobody write them', async () => {
    const player = await account();
    for (const [who, client] of [['visitor', anonymous], ['player', player.client]] as const) {
      const { data, error } = await client.from('patches').select('number,sort_key,title,released_at_ms,message_id,patch_features(position,text)')
        .order('sort_key', { ascending: false });
      expect(error, who).toBeNull();
      expect(data!.map(r => r.number), who).toEqual(['1.3.1', '1.3', '1.2.1', '1.2', '1.1', '1.0']);
      const [newest] = data!;
      expect(newest.patch_features.length, who).toBe(seeded()[0].features.length);
      const revision = await client.from('world_revision').select('latest_patch');
      expect(revision.error, who).toBeNull();
      expect(revision.data, who).toEqual([{ latest_patch: '1.3.1' }]);
    }
    for (const [who, client] of [['visitor', anonymous], ['player', player.client], ['backend', admin]] as const) {
      expect((await client.from('patches').insert({ number: '9.0', title: 'Forged', released_at_ms: 0 })).error?.code, `${who} insert patches`).toBe('42501');
      expect((await client.from('patch_features').insert({ patch: '1.0', position: 20, text: 'Forged.' })).error?.code, `${who} insert features`).toBe('42501');
      expect((await client.from('patches').update({ title: 'Forged' }).eq('number', '1.0')).error?.code, `${who} update patches`).toBe('42501');
      expect((await client.from('patch_features').update({ text: 'Forged.' }).eq('patch', '1.0')).error?.code, `${who} update features`).toBe('42501');
      expect((await client.from('patch_features').delete().eq('patch', '1.0')).error?.code, `${who} delete features`).toBe('42501');
      expect((await client.schema('private').rpc('record_patch', { number: '9.0', title: 'Forged', features: ['Forged.'], message_id: null })).error?.code,
        `${who} rpc`).toBe('PGRST106');
    }
    // Directly in SQL as each API role: no write either.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await refusal(async tx => { await tx.unsafe(`set local role ${role}`); await tx`insert into public.patches(number,title,released_at_ms) values('9.0','Forged',0)`; }), role).toBe('42501');
      expect(await refusal(async tx => { await tx.unsafe(`set local role ${role}`); await tx`update public.patch_features set text='Forged.'`; }), role).toBe('42501');
    }
    expect((await seedRows())[0]).toMatchObject({ number: '1.3.1', title: seeded()[0].title });
  });

  it('orders its source: the tables, then the function, the revision view and the seed (M24 lesson: nothing before what it calls)', () => {
    const source = readFileSync(new URL('../../supabase/sql/19-patches.sql', import.meta.url), 'utf8');
    const at = (needle: string) => { const i = source.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const order = [at('create table if not exists public.patches'), at('create table if not exists public.patch_features'),
      at('create or replace function private.record_patch'), at('create or replace view public.world_revision with(security_invoker=true) as'),
      at('insert into public.patches(number,title,released_at_ms,message_id) values'),
      at('insert into public.patch_features(patch,position,text) values'), at("notify pgrst,'reload schema';")];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The view is 15-release.sql's with one more last column.
    const release = readFileSync(new URL('../../supabase/sql/15-release.sql', import.meta.url), 'utf8');
    const head = 'create or replace view public.world_revision with(security_invoker=true) as\n';
    const was = release.slice(release.indexOf(head), release.indexOf('where singleton;', release.indexOf(head)));
    const now = source.slice(source.indexOf(head), source.indexOf('where singleton;', source.indexOf(head)));
    expect(now.replace(',\n    (select p.number from public.patches p order by p.sort_key desc limit 1) as latest_patch', '')).toBe(was);
  });

  // M26 is Patch 1.4's one migration (one database change per patch, Avi), generated once from 19-patches.sql and 20-profile-card.sql
  // (Task 11c's part has its own file test in tests/db/profile-card.test.ts).
  const M26_SUFFIX = '_patch_1_4.sql';
  it('ships M26 completed from 19-patches.sql: revokes before grants, the source\'s CHECK and generated expressions, the invoker view kept, the operator-only function, the seed, the reload last', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const files = readdirSync(dir).filter(name => name.endsWith(M26_SUFFIX));
    expect(files).toHaveLength(1);
    const all = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
    // The 26th migration (it was the last until M27, patch 1.6, followed it).
    expect(all[25]).toBe(files[0]);
    const m26 = readFileSync(new URL(files[0], dir), 'utf8').replace(/\r\n/g, '\n');
    const source = readFileSync(new URL('../../supabase/sql/19-patches.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const at = (needle: string, from = 0) => { const i = m26.indexOf(needle, from); expect(i, needle).toBeGreaterThan(-1); return i; };
    // record_patch's body is the source's, character for character, created once, and its revoke restated.
    const open = source.indexOf('as $$', source.indexOf('create or replace function private.record_patch(')) + 'as $$'.length;
    const sourceBody = source.slice(open, source.indexOf('$$', open));
    const start = at('CREATE OR REPLACE FUNCTION private.record_patch(');
    expect(m26.indexOf('CREATE OR REPLACE FUNCTION private.record_patch(', start + 1)).toBe(-1);
    const bodyOpen = at('AS $function$', start) + 'AS $function$'.length;
    expect(m26.slice(bodyOpen, m26.indexOf('$function$', bodyOpen))).toBe(sourceBody);
    const acl = source.match(/^revoke all on function private\.record_patch[^;]*;/m)![0];
    expect(m26).toContain(acl);
    // Each table's revoke after its RLS and before its first grant (a new table gets service_role=Dxtm by default).
    for (const table of ['patches', 'patch_features']) {
      const revoke = `revoke all on public.${table} from public,anon,authenticated,service_role;`;
      expect(source).toContain(revoke);
      expect(at(`alter table "public"."${table}" enable row level security;`), table).toBeLessThan(at(revoke));
      expect(at(revoke), table).toBeLessThan(at(`on table "public"."${table}" to`));
      expect(m26).toMatch(new RegExp(`create policy "player_read"\\s+on "public"\\."${table}"\\s+as permissive\\s+for select\\s+to anon, authenticated\\s+using \\(true\\);`));
    }
    // The `between` CHECKs and the generated column are the source's text (M25 lesson: a deparsed `between` inside an AND is another
    // stored expression); the schema fingerprint of the replay, byte-equal to the source-applied one, is the proof for the rest.
    const generated = source.slice(source.indexOf('generated always as ('), source.indexOf(' stored unique,'));
    for (const expression of ["CHECK (char_length(title) between 1 and 80 and title ~ '[^[:space:]]')", 'CHECK (position between 1 and 20)',
      "CHECK (char_length(text) between 1 and 240 and text ~ '[^[:space:]]')", generated]) {
      expect(source.toLowerCase(), expression).toContain(expression.toLowerCase());
      expect(m26, expression).toContain(expression);
    }
    // One world_revision statement, the source's: create or replace with security_invoker (a dropped and re-created view loses its grants).
    const head = 'create or replace view public.world_revision with(security_invoker=true) as';
    const view = source.slice(source.indexOf(head), source.indexOf('where singleton;', source.indexOf(head)) + 'where singleton;'.length);
    expect(m26).toContain(view);
    expect(m26.match(/^create or replace view public\.world_revision\b/gim)).toHaveLength(1);
    expect(m26).not.toMatch(/drop view[^;]*world_revision/i);
    // The seed: the six rows, their features and the four note titles.
    for (const s of seeded()) {
      expect(m26, s.number).toContain(`('${s.number}',$t$${s.title}$t$`);
      for (const f of s.features) expect(m26, f).toContain(`$f$${f}$f$`);
    }
    for (const title of ['Evening Arena, waiting monsters, clearer menus', 'New: choose your gladiator\'s look', 'Messages, gold, fixed builds and bigger beds',
      'Attribute points: easier on a phone']) expect(m26, title).toContain(`m.title=$t$${title}$t$`);
    expect(m26.trimEnd().endsWith("notify pgrst,'reload schema';") || m26.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});
