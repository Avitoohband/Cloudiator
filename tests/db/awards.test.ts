import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { TRAINING, resetWorld, fighter as placedFighter, coordinatorLease, runBoundary, settleDue } from '../fixtures/boundary.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { STORED_COUNTERS, TITLES_V1 } from '../../supabase/functions/_shared/domain/titles.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

// Patch 1.7.1, hand-given titles (plan docs/superpowers/plans/2026-11-06-hand-given-titles-1-7-1.md, Task 1; source
// supabase/sql/23-awards.sql, migration M29). Game Master and High Ground (measure `award`) are never earned by play: no counter,
// trigger or back-fill produces the measure, so private.award_titles never grants them. Only the owner's private.give_title
// gives one: the account lock, then the gladiator row; the title row once (source 'award', at the database time); the title worn
// at once; the deferred projector republishes the gladiator at commit. A second call for the same pair changes nothing.
const commands = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());

const DAY = 86_400_000;
/** The two hand-given titles, in catalog order. */
const GIVEN = TITLES_V1.filter(t => t.measure === 'award').map(t => t.id);
const BY_PLAY = TITLES_V1.filter(t => t.measure !== 'award').map(t => t.id);

async function fighter() {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Awards ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;
type Given = { ok: boolean; given: boolean; worn: string | null };
const give = async (gid: string | null, titleId: string | null) =>
  (await sql`select private.give_title(${gid}::uuid, ${titleId}::text) as result`)[0].result as Given;
/** The error a statement raised (its SQLSTATE and message), or null when it succeeded. */
async function failure(run: () => Promise<unknown>) {
  try { await run(); return null; } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
}
const dbNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
const createdAt = async (gid: string) => Number((await sql`select created_at_ms::bigint as at from public.gladiators where id=${gid}`)[0].at);
const titlesOf = async (gid: string) => (await sql`select title_id, earned_at_ms::bigint as at, activity_id, source, detail
  from public.gladiator_titles where gladiator_id=${gid} order by earned_at_ms, title_id`)
  .map(r => ({ id: r.title_id as string, at: Number(r.at), activity: r.activity_id as string | null, source: r.source as string,
    detail: r.detail as unknown }));
const idsOf = async (gid: string) => (await titlesOf(gid)).map(t => t.id).sort();
const wornOf = async (gid: string) => (await sql`select worn_title from public.gladiators where id=${gid}`)[0].worn_title as string | null;
const worldRevision = async () => (await sql`select revision::int as revision from public.world_revision_state where singleton`)[0].revision as number;
/** The row's transaction id: any UPDATE of it, even one that changes nothing, gives it a new one. */
const rowVersion = async (gid: string) => (await sql`select xmin::text as xmin from public.gladiators where id=${gid}`)[0].xmin as string;
const setCount = (gid: string, counter: string, value: number) => sql`select private.set_title_count(${gid}, ${counter}, ${value})`;
const award = async (gid: string, atMs: number, source = 'result') =>
  (await sql`select private.award_titles(${gid}, ${atMs}, null, ${source}, null) as granted`)[0].granted as number;
/** A gladiator holding and wearing Tiro (its first title). */
async function tiro() {
  const f = await fighter();
  await setCount(f.gid, 'trainings', 10);
  expect(await award(f.gid, (await createdAt(f.gid)) + 1000)).toBe(1);
  expect([await idsOf(f.gid), await wornOf(f.gid)]).toEqual([['tiro'], 'tiro']);
  return f;
}
async function ownerState(f: Pick<Fighter, 'client'>): Promise<OwnerState> {
  const { data, error } = await f.client.from('owner_state').select('state').single();
  if (error) throw new Error(error.message);
  return data!.state;
}
/** A visitor's reads of one gladiator: its world actor and its public profile. */
async function visitorReads(gid: string) {
  const actor = await anonymous.from('world_actor_reads').select('actor').eq('gladiator_id', gid).single();
  const profile = await anonymous.from('public_profile_reads').select('profile').eq('gladiator_id', gid).single();
  expect([actor.error, profile.error]).toEqual([null, null]);
  return { actor: actor.data!.actor as Record<string, unknown>, profile: profile.data!.profile as Record<string, unknown> };
}
/** The backend's wear-title command (service_role), as the Edge function calls it. */
async function wearAs(f: Fighter, titleId: string | null) {
  const operationId = randomUUID(), command = { kind: 'wear-title', operationId, titleId };
  const { data, error } = await admin.rpc('wear_title', { actor_id: f.id, operation_id: operationId, input: { command } });
  expect(error).toBeNull();
  return data as { ok: boolean; code?: string };
}
type Session = { q: Awaited<ReturnType<typeof sql.reserve>>; pid: number };
/** Two reserved sessions, each in an open transaction; both are rolled back (if still open) and released afterwards. */
async function withSessions<T>(run: (a: Session, b: Session) => Promise<T>): Promise<T> {
  const sessions: Session[] = [];
  try {
    for (let n = 0; n < 2; n++) {
      const q = await sql.reserve();
      sessions.push({ q, pid: 0 });
      await q.unsafe('begin');
      await q`set local lock_timeout='15s'`;
      sessions[n].pid = (await q`select pg_backend_pid() as pid`)[0].pid as number;
    }
    return await run(sessions[0], sessions[1]);
  } finally {
    for (const s of sessions) {
      try { await s.q`rollback`; } catch { /* already ended */ } finally { s.q.release(); }
    }
  }
}
/** Database evidence (never elapsed time) that `contender` waits on `holder`. */
async function blockedBy(contender: Session, holder: Session) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    const [{ blocked }] = await sql`select ${holder.pid}::int=any(pg_blocking_pids(${contender.pid})) as blocked`;
    if (blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`backend ${contender.pid} did not wait on ${holder.pid}`);
}

describe('giving a title', () => {
  it('gives a hand-given title once: worn at once, a notice, the world actor and the count republished', async () => {
    const f = await tiro();
    const notices = (await ownerState(f)).inbox.newNotifications, revision = await worldRevision(), before = await dbNow();
    expect(await give(f.gid, 'game-master')).toEqual({ ok: true, given: true, worn: 'game-master' });
    const after = await dbNow();
    // One row, source 'award', no activity or detail, at the database time.
    const given = (await titlesOf(f.gid)).find(t => t.id === 'game-master')!;
    expect(given).toEqual({ id: 'game-master', at: given.at, activity: null, source: 'award', detail: null });
    expect(given.at).toBeGreaterThanOrEqual(before);
    expect(given.at).toBeLessThanOrEqual(after);
    expect(await idsOf(f.gid)).toEqual(['game-master', 'tiro']);
    expect(await wornOf(f.gid)).toBe('game-master');
    // Committed when the call returns: the camp's actor and the profile carry it, the count equals the titles held.
    expect(await worldRevision()).toBeGreaterThan(revision);
    const reads = await visitorReads(f.gid);
    expect(reads.actor.title).toBe('game-master');
    expect((reads.profile.actor as Record<string, unknown>).title).toBe('game-master');
    expect(reads.profile.titlesEarned).toBe(2);
    expect(await sql`select titles_earned from public.public_profiles where gladiator_id=${f.gid}`).toEqual([{ titles_earned: 2 }]);
    // The owner reads it as its own title, worn, with a new notice of its own (no activity, its own source and time).
    const state = await ownerState(f);
    expect(state.wornTitle).toBe('game-master');
    expect(state.titles.find(t => t.id === 'game-master')).toEqual({ id: 'game-master', earnedAtMs: given.at, activityId: null,
      source: 'award', detail: null });
    expect(state.inbox.newNotifications).toBe(notices + 1);
  });

  it('changes nothing on a second call for the same pair, and says so', async () => {
    const f = await tiro();
    expect(await give(f.gid, 'game-master')).toEqual({ ok: true, given: true, worn: 'game-master' });
    // The player switches back to Tiro (any time, as with any title it holds).
    expect(await wearAs(f, 'tiro')).toMatchObject({ ok: true });
    const titles = await titlesOf(f.gid), version = await rowVersion(f.gid), revision = await worldRevision();
    const notices = (await ownerState(f)).inbox.newNotifications;
    // Given again: not given, the title it wears now named, and nothing written (not even an unchanged update).
    expect(await give(f.gid, 'game-master')).toEqual({ ok: true, given: false, worn: 'tiro' });
    expect([await titlesOf(f.gid), await wornOf(f.gid), await rowVersion(f.gid), await worldRevision()])
      .toEqual([titles, 'tiro', version, revision]);
    expect((await ownerState(f)).inbox.newNotifications).toBe(notices);
    // And it can put the given title back on itself.
    expect(await wearAs(f, 'game-master')).toMatchObject({ ok: true });
    expect(await wornOf(f.gid)).toBe('game-master');
  });

  it('gives each hand-given title, also to a gladiator that holds none, and keeps the count equal to the titles held', async () => {
    const f = await fighter();
    expect([await titlesOf(f.gid), await wornOf(f.gid)]).toEqual([[], null]);
    expect(await give(f.gid, 'high-ground')).toEqual({ ok: true, given: true, worn: 'high-ground' });
    expect((await visitorReads(f.gid)).profile.titlesEarned).toBe(1);
    // A second hand-given title is worn in place of the first; both are held.
    expect(await give(f.gid, 'game-master')).toEqual({ ok: true, given: true, worn: 'game-master' });
    expect(await idsOf(f.gid)).toEqual(['game-master', 'high-ground']);
    const reads = await visitorReads(f.gid);
    expect([reads.actor.title, reads.profile.titlesEarned]).toEqual(['game-master', 2]);
    // A player who chose No title gets the given title put on.
    const other = await tiro();
    expect(await wearAs(other, null)).toMatchObject({ ok: true });
    expect(await give(other.gid, 'high-ground')).toEqual({ ok: true, given: true, worn: 'high-ground' });
    expect(await sql`select count(*)::int as n from public.public_profiles p
      where p.titles_earned <> (select count(*) from public.gladiator_titles t where t.gladiator_id=p.gladiator_id)`).toEqual([{ n: 0 }]);
  });

  it('refuses a title earned by play, an unknown id and an unknown gladiator, writing nothing', async () => {
    const f = await tiro();
    const titles = await titlesOf(f.gid), version = await rowVersion(f.gid), revision = await worldRevision();
    for (const titleId of ['croesus', 'tiro', 'founder', 'bannerman', 'den-breaker', 'Game Master', 'GAME-MASTER', 'game-master ', '', null]) {
      expect(await failure(() => give(f.gid, titleId)), JSON.stringify(titleId)).toMatchObject({ code: '23514' });
    }
    for (const gid of [randomUUID(), null]) {
      expect(await failure(() => give(gid, 'game-master')), String(gid)).toMatchObject({ code: '23503' });
    }
    expect([await titlesOf(f.gid), await wornOf(f.gid), await rowVersion(f.gid), await worldRevision()])
      .toEqual([titles, 'tiro', version, revision]);
    expect(await sql`select count(*)::int as n from public.gladiator_titles where source='award'`).toEqual([{ n: 0 }]);
  });

  it('takes the account lock, then the gladiator row, and stamps the database time after the wait', async () => {
    const f = await fighter();
    const { at, waited } = await withSessions(async (a, b) => {
      // The account lock, held by another transaction (a command of the same account).
      await a.q`select pg_advisory_xact_lock(hashtextextended(${f.id}::text,0))`;
      const giving = b.q`select private.give_title(${f.gid}::uuid, 'game-master') as result`.execute();
      await blockedBy(b, a);
      // While it waits for the account lock it holds no lock on the gladiator row: another writer takes the row at once.
      expect(await sql.begin(async tx => (await tx`select id from public.gladiators where id=${f.gid} for update nowait`).length)).toBe(1);
      const waitedUntil = await dbNow();
      await a.q`commit`;
      const [{ result }] = await giving;
      await b.q`commit`;
      expect(result).toEqual({ ok: true, given: true, worn: 'game-master' });
      return { at: (await titlesOf(f.gid))[0].at, waited: waitedUntil };
    });
    expect(at).toBeGreaterThanOrEqual(waited);
    // And the gladiator row next: while another transaction holds the row, the account lock is taken and the call waits on the row.
    await withSessions(async (a, b) => {
      await a.q`select id from public.gladiators where id=${f.gid} for update`;
      const giving = b.q`select private.give_title(${f.gid}::uuid, 'high-ground') as result`.execute();
      await blockedBy(b, a);
      expect(await sql`select count(*)::int as n from pg_locks where pid=${b.pid} and locktype='advisory' and granted`).toEqual([{ n: 1 }]);
      await a.q`commit`;
      expect((await giving)[0].result).toEqual({ ok: true, given: true, worn: 'high-ground' });
      await b.q`commit`;
    });
  });

  it("is the owner's only: no API role may run it", async () => {
    expect(await sql`select p.prosecdef as definer, p.proconfig as config, p.proacl::text as acl, l.lanname as language,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as player,
      has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('private.give_title(uuid,text)')`)
      .toEqual([{ definer: false, config: ['search_path=""'], acl: '{postgres=X/postgres}', language: 'plpgsql', anon: false,
        player: false, backend: false }]);
    const f = await fighter();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await failure(() => sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select private.give_title(${f.gid}::uuid, 'game-master')`;
      })), role).toMatchObject({ code: '42501' });
    }
    // The Data API does not serve the private schema at all.
    for (const [who, client] of [['player', f.client], ['visitor', anonymous], ['backend', admin]] as const) {
      const { error } = await client.schema('private').rpc('give_title', { gladiator_id: f.gid, title_id: 'game-master' });
      expect(error?.code, who).toBe('PGRST106');
    }
    expect([await titlesOf(f.gid), await wornOf(f.gid)]).toEqual([[], null]);
  });

  it("allows the source 'award' and still refuses any other new source", async () => {
    const f = await fighter();
    expect(await sql`select pg_get_constraintdef(c.oid) as check from pg_constraint c
      where c.conrelid='public.gladiator_titles'::regclass and c.conname='gladiator_titles_source_check'`).toEqual([{ check:
      "CHECK ((source = ANY (ARRAY['history'::text, 'result'::text, 'season'::text, 'shop'::text, 'market'::text, 'sale'::text, 'joined'::text, 'award'::text])))" }]);
    expect(await failure(() => sql`insert into public.gladiator_titles(gladiator_id,title_id,earned_at_ms,source)
      values(${f.gid},'game-master',0,'gift')`)).toMatchObject({ code: '23514' });
    // Given titles are kept forever like every title.
    await give(f.gid, 'game-master');
    for (const statement of [sql`update public.gladiator_titles set source='history' where gladiator_id=${f.gid}`,
      sql`delete from public.gladiator_titles where gladiator_id=${f.gid}`]) {
      expect(await failure(() => statement)).toMatchObject({ message: 'immutable gladiator_titles' });
    }
  });
});

describe('never earned by play', () => {
  it('never awards a hand-given title, whatever the measures', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    // Every measure far past every threshold: every stored counter, the banner, Season 1 and 400 days in camp.
    for (const counter of STORED_COUNTERS) await setCount(f.gid, counter, 1_000_000);
    await sql`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding) values(${f.gid},'banner','v1','bound')`;
    await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(0,${created - 2_419_200_000 + 1},${created + 1})`;
    const at = created + 400 * DAY;
    const [{ measures }] = await sql`select private.title_measures(${f.gid}, ${at}) as measures`;
    expect(measures).not.toHaveProperty('award');
    await award(f.gid, at);
    // Every title earned by play, and neither hand-given one.
    expect(await idsOf(f.gid)).toEqual([...BY_PLAY].sort());
    expect(BY_PLAY).toHaveLength(35);
    expect(GIVEN).toEqual(['game-master', 'high-ground']);
  });

  it('never awards one with a real settlement', async () => {
    await resetWorld(299);
    const f = await placedFighter({ schedule: TRAINING });
    // Every counter far past its thresholds, Trainings one short of Tiro: the Training's settlement awards every title its
    // measures meet, Tiro with it.
    for (const counter of STORED_COUNTERS) await setCount(f.gid, counter, 1_000_000);
    await setCount(f.gid, 'trainings', 9);
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    const settled = async () => (await sql`select count(*)::int as n from private.settled_slots where gladiator_id=${f.gid} and slot_index=300`)[0].n === 1;
    for (let round = 0; round < 6 && !await settled(); round++) await settleDue(300, token);
    expect(await settled()).toBe(true);
    const [{ id }] = await sql`select id from public.activities where gladiator_id=${f.gid} and slot_index=300`;
    const titles = await titlesOf(f.gid);
    // Not vacuous: the settlement awarded titles with its result.
    expect(titles.filter(t => t.activity === id).map(t => t.id)).toContain('tiro');
    expect(titles.filter(t => t.activity === id).length).toBeGreaterThan(20);
    expect(titles.filter(t => GIVEN.includes(t.id) || t.source === 'award')).toEqual([]);
  }, 60_000);

  it('never back-fills one, and a back-fill replay keeps a given title', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    // History that earns Tiro (ten points from Training) and Founder (made in Season 1).
    await sql`update public.gladiators set earned_points=20,unspent_points=10 where id=${f.gid}`;
    await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(0,${created - 2_419_200_000 + 1},${created + 1})`;
    const [{ result }] = await sql`select private.backfill_titles() as result`;
    expect(result).toMatchObject({ ok: true, gladiators: 1, titles: 2, founders: 1, replayed: false });
    expect(await idsOf(f.gid)).toEqual(['founder', 'tiro']);
    expect(await give(f.gid, 'high-ground')).toEqual({ ok: true, given: true, worn: 'high-ground' });
    const titles = await titlesOf(f.gid);
    // The back-fill ran once: a later call replays its record and writes nothing.
    expect((await sql`select private.backfill_titles() as result`)[0].result).toEqual({ ...result, replayed: true });
    expect([await titlesOf(f.gid), await wornOf(f.gid)]).toEqual([titles, 'high-ground']);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------
// M29, Patch 1.7.1's one migration (one database change per patch, Avi): generated by the CLI's pg-delta engine from the tested
// 23-awards.sql applied once to a clean M01-M28 reset, then completed from that source (AGENTS.md "Generated migration
// completion"; docs/operations/migrations.md, "Patch 1.7.1 (M29)"). The shape of M28's test (tests/db/titles.test.ts).
it('ships M29 completed from 23-awards.sql: the rules before their grants, the source CHECK in one statement, give_title after the rules and owner-only, the reload last', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const all = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const files = all.filter(name => name.endsWith('_patch_1_7_1.sql'));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d{14}_patch_1_7_1\.sql$/);
  // The 29th migration, after M28 (Patch 1.7, wearable titles).
  expect(all).toHaveLength(30);
  expect(all[27]).toBe('20261106064426_patch_1_7.sql');
  expect(all[28]).toBe(files[0]);
  const m29 = readFileSync(new URL(files[0], dir), 'utf8');
  // LF only: a carriage return in a function body would change its stored text (and the schema fingerprint).
  expect(m29).not.toContain('\r');
  const source = readFileSync(new URL('../../supabase/sql/23-awards.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // Positions are read with the comments blanked (the header names statements too), so every index is the file's own.
  const code = m29.replace(/--[^\n]*/g, comment => ' '.repeat(comment.length));
  const at = (needle: string) => { const i = code.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
  const once = (needle: string) => { const i = at(needle); expect(code.indexOf(needle, i + 1), `${needle} once`).toBe(-1); return i; };
  // The statements outside function bodies, comments and dollar-quoted text removed.
  const topLevel = (sql: string) => sql.replace(/(\$\w*\$)[^]*?\1/g, '$body$').replace(/--[^\n]*/g, '');

  // The provenance header: the generator, its engine and input.
  const header = m29.match(/^(?:--[^\n]*\n)+/)?.[0] ?? '';
  for (const token of ['Supabase CLI 2.120.0', 'db pull patch_1_7_1 --local --schema public,private --diff-engine pg-delta --yes',
    'supabase/sql/23-awards.sql', 'M01-M28']) expect(header, token).toContain(token);
  // One transaction, as every migration: no non-transactional marker, no top-level BEGIN or COMMIT (the source has its own).
  expect(m29).not.toContain('-- pg-delta: transaction=false');
  expect(topLevel(m29)).not.toMatch(/^\s*(?:begin|commit|rollback|end)\s*;/im);
  // No data written, and nothing dropped but the replaced CHECK (inside the source's one ALTER TABLE below).
  expect(topLevel(m29)).not.toMatch(/^\s*(?:insert|update|delete|truncate|call|perform|select)\b/im);
  const check = source.match(/^alter table public\.gladiator_titles drop constraint if exists gladiator_titles_source_check,\n[^;]*;/m)![0];
  expect(check).toContain("add constraint gladiator_titles_source_check check (source in ('history','result','season','shop','market','sale','joined','award'));");
  const checkAt = once(check);
  expect(topLevel(m29.replace(check, ''))).not.toMatch(/\bdrop\b/i);
  // The source's CHECK text (the M25 lesson) in its one ALTER TABLE, and no other table change or CHECK.
  expect(code.match(/^alter table\b/gim)).toHaveLength(1);
  expect(topLevel(m29).match(/\bcheck\s*\(/gi)).toHaveLength(1);

  // The source's two functions in its order (nothing before what it calls), each created once with the source's body character
  // for character; no other function, so none re-emitted unchanged.
  const definitions = (sql: string) => [...sql.matchAll(/^create (?:or replace )?function "?(\w+)"?\."?(\w+)"?\s*\([^]*?\bas\s+(\$\w*\$)([^]*?)\3\s*;/gim)]
    .map(match => ({ name: `${match[1]}.${match[2]}`, body: match[4], index: match.index! }));
  const expected = definitions(source), shipped = definitions(m29);
  expect(expected.map(({ name }) => name)).toEqual(['private.title_rules', 'private.give_title']);
  expect(shipped.map(({ name }) => name)).toEqual(expected.map(({ name }) => name));
  expect(code.match(/^create (?:or replace )?function /gim)).toHaveLength(2);
  const fn = new Map(shipped.map(definition => [definition.name, definition] as const));
  for (const { name, body } of expected) expect(fn.get(name)?.body, name).toBe(body);
  expect(fn.get('private.title_rules')!.body).toContain('{"id":"game-master","measure":"award","threshold":1,"tier":null}');
  const pos = (name: string) => fn.get(name)!.index;

  // Every ACL statement of the source and no other (pg-delta's are replaced): title_rules' revoke, then its grant, after it;
  // give_title's revoke from every API role after it, and no grant on it.
  const acls = source.match(/^(?:revoke|grant) [^;]*;/gm)!;
  expect(acls).toEqual(['revoke all on function private.title_rules() from public,anon,authenticated;',
    'grant execute on function private.title_rules() to service_role;',
    'revoke all on function private.give_title(uuid,text) from public,anon,authenticated,service_role;']);
  for (const statement of acls) once(statement);
  expect(code.match(/^(?:revoke|grant)\b/gim)).toHaveLength(acls.length);
  expect(at(acls[0])).toBeGreaterThan(pos('private.title_rules'));
  expect(at(acls[1])).toBeGreaterThan(at(acls[0]));
  expect(at(acls[2])).toBeGreaterThan(pos('private.give_title'));
  expect(topLevel(m29)).not.toMatch(/^\s*grant\b[^;]*\bgive_title\b/im);

  // The source's order: the rules and their grants, the CHECK, then give_title (which reads the rules) and its revoke; then only
  // the reload.
  expect(pos('private.title_rules')).toBeLessThan(checkAt);
  expect(at(acls[1])).toBeLessThan(checkAt);
  expect(checkAt).toBeLessThan(pos('private.give_title'));
  const reload = once("notify pgrst, 'reload schema';");
  expect(code.slice(at(acls[2]) + acls[2].length, reload).trim()).toBe('');
  expect(code.slice(reload + "notify pgrst, 'reload schema';".length).trim()).toBe('');
});
