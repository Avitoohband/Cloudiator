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
    // The line shapes of the scratch psql copy: booleans t/f, the settings and the ACL as text.
    expect(lines).toContainEqual(expect.stringMatching(/^fn\|private\.health_report\(bigint\)\|[0-9a-f]{32}\|f\|[vsi]\|search_path=""\|\{postgres=X\/postgres\}$/));
    expect(lines).toContain('cron|cloudiator-coordinate|* * * * *|select private.cron_tick()');
    expect(lines).toContain('seed-singletons|1|1');
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
      /^price 101, fee 5, buyer paid 101, seller received 96, fee right true, owners 1, owner buyer, sold \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(value(corrupted, 'trades', 'sales with a wrong or missing ledger row')).toBe('1');
    expect(value(corrupted, 'trades', `sale ${hash(listingId)}`)).toContain('seller received 97, fee right false');

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
    for (const row of [...clean, ...corrupted]) {
      for (const needle of forbidden) expect(`${row.section} ${row.item} ${row.value}`, `${row.section} ${row.item}`).not.toContain(needle);
    }
  });
});
