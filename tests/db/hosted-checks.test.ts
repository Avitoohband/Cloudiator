import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql, admin, anonymous, account, resetIdentity, creation, request } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';

// Task 24.1 (plan Decision 1): the two read-only SQL kits the hosted steps run as the database owner. Both are one SELECT, so
// they also run in the hosted SQL editor; here each runs inside a read-only transaction on the local stack (a write would fail
// with SQLSTATE 25006) and must return every labelled section. The hosted checks are also run over a real two-account trade,
// with both Vault secrets present, to show what they report and that they print no secret, account id or email.
const FINGERPRINT = readFileSync(new URL('../../scripts/schema-fingerprint.sql', import.meta.url), 'utf8');
const CHECKS = readFileSync(new URL('../../scripts/hosted-checks.sql', import.meta.url), 'utf8');
const FINGERPRINT_SECTIONS = ['fn', 'rel', 'col', 'pol', 'trg', 'con', 'idx', 'nsp', 'defacl', 'cron', 'seed-rules', 'seed-revision',
  'seed-singletons', 'trg-enabled', 'seed-retention', 'seed-published-mirror', 'seed-retention-jobs', 'seed-owner-signals'];
const CHECK_SECTIONS = ['parity', 'scheduler', 'dispatch', 'job-attempts', 'boundary-latency', 'http-responses', 'duplicate-grants',
  'characters', 'trades'];
type Check = { section: string; item: string; value: string };
const SLOT = 4_800_000;

/** Runs `text` in a read-only transaction on a connection of its own. */
async function readOnly(text: string) {
  const probe = postgres(process.env.LOCAL_DB_URL!, { max: 1, onnotice: () => {} });
  try { return [...await probe.begin('read only', tx => tx.unsafe(text))] as Record<string, string>[]; } finally { await probe.end(); }
}
class RolledBack extends Error {}
/** What `read` sees inside a transaction that first runs `statements`; the transaction always rolls back. */
async function rolledBack<T>(read: (tx: postgres.TransactionSql) => Promise<T>) {
  const probe = postgres(process.env.LOCAL_DB_URL!, { max: 1, onnotice: () => {} });
  let seen: T | undefined;
  try {
    await probe.begin(async tx => { seen = await read(tx); throw new RolledBack(); })
      .catch(error => { if (!(error instanceof RolledBack)) throw error; });
  } finally { await probe.end(); }
  return seen as T;
}
const value = (rows: Check[], section: string, item: string) => rows.find(r => r.section === section && r.item === item)?.value;
const hash = (id: string) => createHash('md5').update(id).digest('hex').slice(0, 12);

const deps = { database: createDatabase(admin), verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand) => (await handleCommand(request(token, body), deps)).json();
/** A real character through the command handler; the trusted local operator funds its wallet. */
async function fighter(money: number) {
  const owner = await account();
  const created = await send(owner.token, creation('Hosted ' + randomUUID().slice(0, 8)));
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const gid = created.value.gladiatorId as string;
  await sql`update public.wallets set money=${String(money)} where gladiator_id=${gid}`;
  return { ...owner, gid };
}

describe('the read-only hosted SQL kits', () => {
  beforeAll(async () => {
    await resetIdentity();
    await sql`update private.scheduler set enabled=false where singleton`;
    // Commands return processing across a shared boundary; do not start the trade in a slot's final three minutes.
    const remaining = SLOT - (Date.now() % SLOT);
    if (remaining < 180_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  }, 181_000 + 30_000);
  afterAll(() => sql.end());

  it('refuses a write in the read-only harness the kits run in', async () => {
    await expect(readOnly('create table public.hosted_checks_probe(id int)')).rejects.toThrow(/read-only transaction/);
  });

  it('prints the schema fingerprint read-only, one line per entry, every section in order', async () => {
    const lines = (await readOnly(FINGERPRINT)).map(row => row.line);
    expect([...new Set(lines.map(line => line.split('|')[0]))]).toEqual(FINGERPRINT_SECTIONS);
    // The order does not depend on the moment or the collation: the same database prints the same lines.
    expect((await readOnly(FINGERPRINT)).map(row => row.line)).toEqual(lines);
    const [{ functions }] = await sql`select count(*)::int as functions from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace)`;
    expect(lines.filter(line => line.startsWith('fn|'))).toHaveLength(functions);
    // The line shapes of the scratch psql copy (booleans t/f, the ACL as text), except that fix round 1 (Minor 6) prints a
    // function's settings and a view's options as their names and an md5 of their values, and Cloudiator's cron jobs only,
    // with the command hashed.
    const md5 = (text: string) => createHash('md5').update(text).digest('hex');
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^fn\\|private\\.health_report\\(bigint\\)\\|[0-9a-f]{32}\\|f\\|[vsi]\\|search_path md5:${md5('search_path=""')}\\|\\{postgres=X/postgres\\}$`)));
    expect(lines).toContainEqual(expect.stringMatching(/^rel\|public\.owner_state\|v\|.*\|security_invoker md5:[0-9a-f]{32}\|[0-9a-f]{32}$/));
    expect(lines.filter(line => line.startsWith('cron|'))).toEqual([`cron|cloudiator-cleanup|23 * * * *|${md5('select private.cleanup_tick()')}`,
      `cron|cloudiator-coordinate|* * * * *|${md5('select private.cron_tick()')}`]);
    expect(lines.filter(line => /search_path=|security_invoker=|select private\./.test(line))).toEqual([]);
    expect(lines).toContain('seed-singletons|1|1');
  });

  it('prints no setting value and no other cron job in the fingerprint (fix round 1, Minor 6)', async () => {
    const VALUE = `fp-probe-value-${randomUUID()}`;
    const lines = await rolledBack(async tx => {
      await tx.unsafe(`create function private.fp_probe() returns int language sql set search_path='' set application_name='${VALUE}' as 'select 1'`);
      await tx.unsafe(`create view public.fp_probe_view with (security_barrier=true) as select 1 as id`);
      await tx.unsafe(`select cron.schedule('fp-probe-job', '* * * * *', 'select 1 /* ${VALUE} */')`);
      return ([...await tx.unsafe(FINGERPRINT)] as unknown as { line: string }[]).map(row => row.line);
    });
    expect(lines).toContainEqual(expect.stringMatching(/^fn\|private\.fp_probe\(\)\|[0-9a-f]{32}\|f\|v\|application_name,search_path md5:[0-9a-f]{32}\|/));
    expect(lines).toContainEqual(expect.stringMatching(/^rel\|public\.fp_probe_view\|v\|.*\|security_barrier md5:[0-9a-f]{32}\|[0-9a-f]{32}$/));
    expect(lines.filter(line => line.includes(VALUE) || line.includes('fp-probe-job') || line.includes('=true'))).toEqual([]);
  });

  it('prints the hosted checks read-only, every section in order and every value as text', async () => {
    const rows = await readOnly(CHECKS) as unknown as Check[];
    expect([...new Set(rows.map(row => row.section))]).toEqual(CHECK_SECTIONS);
    for (const row of rows) for (const field of [row.section, row.item, row.value]) expect(typeof field).toBe('string');
    const [{ migrations }] = await sql`select count(*)::text as migrations from supabase_migrations.schema_migrations`;
    expect(value(rows, 'parity', 'migrations count')).toBe(migrations);
    expect(value(rows, 'parity', 'search path schemas')).toBe('{public,extensions}');
    expect(value(rows, 'scheduler', 'scheduler enabled')).toBe('false');
    for (const kind of ['prepare', 'simulation', 'reveal', 'settlement']) expect(value(rows, 'job-attempts', `${kind} attempts`), kind).toMatch(/^\d+$/);
    expect(value(rows, 'duplicate-grants', 'total (duplicateGrants)')).toBe('0');
  });

  // Task 24.2c (the Task 24.2b review's minor): production must carry neither bench marker (the database comment
  // 'cloudiator-bench' or the schema cloudiator_bench_marker, the two marks scripts/bench-seed.mjs looks for), so the kit's
  // parity section reports whether either is present, by marker name, and never any other comment text. Each mark is planted
  // inside a transaction that always rolls back.
  it('reports whether the database carries a bench marker, by marker name only, and leaves the local database unmarked', { timeout: 30_000 }, async () => {
    const marked = async () => {
      const [row] = await sql`select shobj_description((select oid from pg_database where datname = current_database()), 'pg_database') as comment,
        to_regnamespace('cloudiator_bench_marker') is not null as marker_schema`;
      return row.comment === 'cloudiator-bench' || row.marker_schema === true;
    };
    expect(await marked(), 'the local database starts unmarked').toBe(false);
    const markerRow = (rows: Check[]) => rows.filter(r => r.item === 'bench marker');
    const withMarks = (plant: (tx: postgres.TransactionSql) => Promise<unknown>) => rolledBack(async tx => {
      await plant(tx);
      return [...await tx.unsafe(CHECKS)] as unknown as Check[];
    });
    const reads = (value: string) => [{ section: 'parity', item: 'bench marker', value }];

    const absent = await readOnly(CHECKS) as unknown as Check[];
    expect(markerRow(absent)).toEqual(reads('absent'));
    const comment = await withMarks(tx => tx`comment on database postgres is 'cloudiator-bench'`);
    expect(markerRow(comment)).toEqual(reads('present (comment)'));
    const schema = await withMarks(tx => tx`create schema cloudiator_bench_marker`);
    expect(markerRow(schema)).toEqual(reads('present (schema)'));
    const both = await withMarks(async tx => { await tx`comment on database postgres is 'cloudiator-bench'`; await tx`create schema cloudiator_bench_marker`; });
    expect(markerRow(both)).toEqual(reads('present (comment, schema)'));

    // Any other comment is no marker (the seed compares exactly), and its text is never printed.
    const OTHER = `bench-marker-probe-${randomUUID()}`;
    const other = await withMarks(tx => tx.unsafe(`comment on database postgres is '${OTHER}'`));
    expect(markerRow(other)).toEqual(reads('absent'));
    const nearMiss = await withMarks(tx => tx`comment on database postgres is 'cloudiator-bench '`);
    expect(markerRow(nearMiss)).toEqual(reads('absent'));
    for (const r of other) expect(`${r.section} ${r.item} ${r.value}`).not.toContain(OTHER);
    // The row sits in the parity section and every section is still printed.
    for (const rows of [absent, comment, schema, both, other, nearMiss]) {
      expect([...new Set(rows.map(r => r.section))]).toEqual(CHECK_SECTIONS);
      expect(rows.filter(r => r.item === 'bench marker').map(r => r.section)).toEqual(['parity']);
    }

    expect(await marked(), 'the local database is left unmarked').toBe(false);
  });

  it('reports a two-account trade, one character per account and the Vault secrets by name, never a secret, id or email', { timeout: 60_000 }, async () => {
    const seller = await fighter(1000), buyer = await fighter(1000);
    const entry = CATALOG_V1.items['sword:1:common'];
    const itemId = randomUUID();
    await sql`insert into public.item_instances(id,gladiator_id,item) values(${itemId},${seller.gid},${sql.json({ id: itemId, ownerId: seller.gid,
      catalogId: entry.id, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats, quantity: 1, origin: 'shop',
      binding: 'tradable', reservation: null } as never)})`;
    const listed = await send(seller.token, { kind: 'create-listing', operationId: randomUUID(), itemId, price: 101 });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    const listingId = listed.value.listingId as string;
    const bought = await send(buyer.token, { kind: 'buy-listing', operationId: randomUUID(), listingId });
    expect(bought.ok, JSON.stringify(bought)).toBe(true);

    const SECRET = `hosted-checks-secret-${randomUUID()}`, URL_VALUE = `http://hosted-checks-url-${randomUUID()}.invalid/game-worker`;
    const { clean, corrupted } = await rolledBack(async tx => {
      await tx`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
      await tx`select vault.create_secret(${URL_VALUE},'game_worker_url')`;
      await tx`select vault.create_secret(${SECRET},'game_worker_secret')`;
      const clean = [...await tx.unsafe(CHECKS)] as unknown as Check[];
      // A seller credit one coin off the fee rule must be reported.
      await tx`update public.wallet_ledger set money_delta=money_delta+1 where reason='market-sale' and gladiator_id=${seller.gid}`;
      return { clean, corrupted: [...await tx.unsafe(CHECKS)] as unknown as Check[] };
    });

    expect(value(clean, 'trades', 'listings sold')).toBe('1');
    expect(value(clean, 'trades', 'sales with the price paid and the fee right')).toBe('1');
    expect(value(clean, 'trades', 'sales with a wrong or missing ledger row')).toBe('0');
    expect(value(clean, 'trades', 'sales whose item has one owner, the buyer')).toBe('1');
    expect(value(clean, 'trades', `sale ${hash(listingId)}`)).toMatch(
      /^price 101, fee 5, buyer paid 101, seller received 96 in 1 credit, fee right true, owners 1, owner buyer, sold \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(value(corrupted, 'trades', 'sales with a wrong or missing ledger row')).toBe('1');
    expect(value(corrupted, 'trades', `sale ${hash(listingId)}`)).toContain('seller received 97 in 1 credit, fee right false');

    // Fix round 1 (Important): a sale credited twice is exactly what duplicate-grants check 6 exists for, so the kit must still
    // print every section then, and report it. A second market-sale receipt and ledger row for the same listing is planted.
    const doubled = await rolledBack(async tx => {
      const [{ receipt }] = await tx`insert into public.operation_receipts(owner_id,operation_id,gladiator_id,request,request_digest,result)
        values(${seller.id},${randomUUID()},${seller.gid},${tx.json({ kind: 'market-sale', listingId } as never)},'\\x00'::bytea,'{"ok":true}'::jsonb)
        returning receipt_id::text as receipt`;
      await tx`insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason) values(${seller.gid},${receipt},96,0,'market-sale')`;
      return [...await tx.unsafe(CHECKS)] as unknown as Check[];
    });
    expect([...new Set(doubled.map(row => row.section))]).toEqual(CHECK_SECTIONS);
    expect(value(doubled, 'duplicate-grants', 'sales credited more than once')).toBe('1');
    expect(value(doubled, 'duplicate-grants', 'total (duplicateGrants)')).toBe('1');
    expect(value(doubled, 'trades', 'sales with a wrong or missing ledger row')).toBe('1');
    expect(value(doubled, 'trades', `sale ${hash(listingId)}`)).toContain('seller received 192 in 2 credits, fee right false');

    expect(value(clean, 'characters', 'characters')).toBe('2');
    expect(value(clean, 'characters', 'accounts with a character')).toBe('2');
    expect(value(clean, 'characters', 'accounts with more than one character')).toBe('0');
    for (const owner of [seller, buyer]) {
      expect(value(clean, 'characters', `account ${hash(owner.id)}`), owner.id).toMatch(/^characters 1, created \S+Z, providers email google$/);
    }
    expect(value(clean, 'scheduler', 'vault game_worker_url')).toBe('present');
    expect(value(clean, 'scheduler', 'vault game_worker_secret')).toBe('present');
    expect(value(clean, 'duplicate-grants', 'total (duplicateGrants)')).toBe('0');
    // Nothing that identifies an account or carries a secret: no Vault value, account id, gladiator id, item or listing id, email.
    const forbidden = [SECRET, URL_VALUE, seller.id, buyer.id, seller.gid, buyer.gid, itemId, listingId, '@'];
    for (const row of [...clean, ...corrupted, ...doubled]) {
      for (const needle of forbidden) expect(`${row.section} ${row.item} ${row.value}`, `${row.section} ${row.item}`).not.toContain(needle);
    }
  });
});
