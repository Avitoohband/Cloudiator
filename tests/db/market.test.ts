import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation, request, directEdge, makeLegacyPending } from '../fixtures/db.ts';
import { readMarket } from '../../src/lib/api/reads';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { historicalGearScore } from '../../supabase/functions/_shared/domain/inventory.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';

// Task 18.1 (M14): fixed-price listings, purchases and expiry in the database. The market commands are called as the
// backend calls them (service_role RPC with the `{command, prepared}` envelope). Task 18.2 routes them through the handler
// and its `market` adapter (the real Edge runtime case, the residual deadlock) and serves the public `market` read.
type Outcome = { ok: boolean; code?: string; receiptId?: string; retryAfterMs?: number; value?: Record<string, unknown> };
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> { toHaveCode(code: string): R }
}
expect.extend({
  toHaveCode(received: Outcome, code: string) {
    return { pass: received?.ok === false && received.code === code,
      message: () => `expected a failed result with code ${code}, received ${JSON.stringify(received)}` };
  },
});

const SLOT = 4_800_000;
const WEEK = RULES_V1.marketplace.expiryMs;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand): Promise<Outcome> => (await handleCommand(request(token, body), deps)).json();
const sell = (itemId: string): GameCommand => ({ kind: 'sell-item', operationId: randomUUID(), itemId, quantity: 1 });
const discard = (itemId: string): GameCommand => ({ kind: 'discard-item', operationId: randomUUID(), itemId, quantity: 1 });
function equip(state: OwnerState, weapon: string): Extract<GameCommand, { kind: 'queue-build' }> {
  return { kind: 'queue-build', operationId: randomUUID(), expectedVersion: state.buildVersion, classId: state.currentBuild.classId,
    stance: state.currentBuild.stance, allocation: state.currentBuild.allocations, equipment: { ...state.currentBuild.equipment, weapon } };
}

/** Real creation through the handler; the trusted local operator then funds the wallet. */
async function fighter(options: { money?: number } = {}) {
  const owner = await account();
  const created = await send(owner.token, creation('Mkt ' + randomUUID().slice(0, 8)));
  expect(created.ok).toBe(true);
  const gid = created.value!.gladiatorId as string;
  await sql`update public.wallets set money=${String(options.money ?? 1000)} where gladiator_id=${gid}`;
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    expect(error).toBeNull();
    return data!.state;
  };
  const wallet = async () => Number((await sql`select money::text from public.wallets where gladiator_id=${gid}`)[0].money);
  const items = async () => (await sql`select item from public.item_instances where gladiator_id=${gid} order by id`).map(row => row.item as ItemInstance);
  const ledger = async () => (await sql`select money_delta::float8 as money, reason, receipt_id::text as receipt
    from public.wallet_ledger where gladiator_id=${gid} and reason<>'creation' order by created_at`).map(row => ({ ...row }));
  const peak = async () => Number((await sql`select peak_strength from public.gladiators where id=${gid}`)[0].peak_strength);
  /** Operator inventory setup only; player paths go through the commands. */
  async function add(catalogId: string, overrides: Partial<ItemInstance> = {}) {
    const entry = CATALOG_V1.items[catalogId], id = randomUUID();
    const item = { id, ownerId: gid, catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats, quantity: 1,
      origin: entry.renownPrice === null ? 'shop' : 'renown', binding: entry.binding, reservation: null, ...overrides };
    await sql`insert into public.item_instances values(${id},${gid},${sql.json(item as never)})`;
    return item as ItemInstance;
  }
  async function fill(count: number) {
    const entry = CATALOG_V1.items['sword:1:common'];
    const template = { catalogId: entry.id, catalogVersion: 'v1', tier: 1, rarity: 'common', stats: entry.stats, quantity: 1, origin: 'shop', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances(id,gladiator_id,item) select x.id,${gid},${sql.json(template as never)}::jsonb||jsonb_build_object('id',x.id,'ownerId',${gid}::text)
      from (select gen_random_uuid() as id from generate_series(1,${count})) x`;
  }
  return { ...owner, gid, state, wallet, items, ledger, peak, add, fill };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;

/** The backend's RPC call: a refused call (missing function, denied privilege) throws. */
async function rpc(name: 'create_listing' | 'cancel_listing' | 'buy_listing', actor: string, operationId: string, input: unknown): Promise<Outcome> {
  const { data, error } = await admin.rpc(name, { actor_id: actor, operation_id: operationId, input });
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as Outcome;
}
const listCommand = (itemId: string, price: number, operationId: string = randomUUID()) => ({ kind: 'create-listing' as const, operationId, itemId, price });
const cancelCommand = (listingId: string, operationId: string = randomUUID()) => ({ kind: 'cancel-listing' as const, operationId, listingId });
const buyCommand = (listingId: string, operationId: string = randomUUID()) => ({ kind: 'buy-listing' as const, operationId, listingId });
const list = (seller: Fighter, itemId: string, price: number, command: Record<string, unknown> = listCommand(itemId, price)) =>
  rpc('create_listing', seller.id, command.operationId as string, { command, prepared: null });
const cancel = (seller: Fighter, listingId: string, command: Record<string, unknown> = cancelCommand(listingId)) =>
  rpc('cancel_listing', seller.id, command.operationId as string, { command, prepared: null });
type Prepared = { baselinePeakStrength: number; nextPeakStrength: number };
/** Task 18.2's adapter preparation: the buyer's historical strength over owner_state plus the listed item, baseline-checked in SQL. */
async function prepare(buyer: Fighter, listingId: string): Promise<Prepared> {
  const state = await buyer.state();
  const [row] = await sql`select i.item from private.market_listings l join public.item_instances i on i.id=l.item_id where l.id=${listingId}`;
  const items = row ? [...state.inventory, row.item as ItemInstance] : state.inventory;
  return { baselinePeakStrength: state.progression.peakStrength, nextPeakStrength: historicalGearScore(items, state.progression.peakStrength) };
}
async function purchase(buyer: Fighter, listingId: string, command: Record<string, unknown> = buyCommand(listingId), prepared?: unknown) {
  return rpc('buy_listing', buyer.id, command.operationId as string, { command, prepared: prepared === undefined ? await prepare(buyer, listingId) : prepared });
}
const listingId = (result: Outcome) => { expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); return result.value!.listingId as string; };

const listingRow = async (id: string) => (await sql`select status, terminal_receipt_id::text as receipt, buyer_gladiator_id::text as buyer,
  seller_gladiator_id::text as seller, item_id::text as item, price::float8 as price, listed_at_ms::float8 as listed, expires_at_ms::float8 as expires
  from private.market_listings where id=${id}`).map(row => ({ ...row }))[0];
const offerRow = async (id: string) => (await sql`select id::text, seller_gladiator_id::text as seller, seller_name as name, item,
  price::float8 as price, listed_at_ms::float8 as listed, expires_at_ms::float8 as expires from public.market_offers where id=${id}`).map(row => ({ ...row }))[0];
const itemRow = async (id: string) => (await sql`select gladiator_id::text as owner, item from public.item_instances where id=${id}`)
  .map(row => ({ owner: row.owner as string, item: row.item as ItemInstance }))[0];
const receipts = async (operationId: string) => (await sql`select count(*)::int as n from public.operation_receipts where operation_id=${operationId}`)[0].n as number;
const saleReceipts = async (id: string) => (await sql`select count(*)::int as n from public.operation_receipts
  where request->>'kind'='market-sale' and request->>'listingId'=${id}`)[0].n as number;
const nowMs = async () => Number((await sql`select private.planning_now_ms()::text as now`)[0].now);
const sweep = async () => (await sql`select private.expire_listings(private.planning_now_ms()) as n`)[0].n as number;
const definitionOf = async (signature: string): Promise<string> =>
  (await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`)[0].definition;

/**
 * Test-only stand-in for the database clock: a session may pin its own time, every other session keeps real time. It is
 * restored from the definition captured before it was installed and verified byte for byte (AGENTS.md stand-in rule).
 */
async function withClock<T>(run: () => Promise<T>): Promise<T> {
  const definition = await definitionOf('private.planning_now_ms()');
  try {
    await sql.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path=''
      as $clock$ select coalesce(nullif(current_setting('cloudiator.test_now_ms', true),'')::bigint, floor(extract(epoch from clock_timestamp())*1000)::bigint) $clock$`);
    return await run();
  } finally {
    await sql.unsafe(definition);
    expect(await definitionOf('private.planning_now_ms()')).toBe(definition);
  }
}
/** A listing created through the real command in a session whose database clock reads `at` (needs withClock). */
async function listAt(seller: Fighter, itemId: string, price: number, at: number): Promise<Outcome> {
  const command = listCommand(itemId, price);
  return sql.begin(async tx => {
    await tx.unsafe(`set local cloudiator.test_now_ms = '${at}'`);
    return (await tx`select public.create_listing(${seller.id},${command.operationId},${tx.json({ command, prepared: null } as never)}) as r`)[0].r as Outcome;
  });
}
/** Polls until session `pid` waits on a lock (optionally one held by `holder`). */
async function waitsOn(pid: number, holder?: number) {
  for (let n = 0; n < 300; n++) {
    const [row] = holder === undefined
      ? await sql`select cardinality(pg_blocking_pids(${pid}))>0 as waiting`
      : await sql`select ${holder}::int = any(pg_blocking_pids(${pid})) as waiting`;
    if (row.waiting) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

const market = {
  /** Two buyers and the seller's cancel race on separate connections for one listing; count its terminal transitions. */
  async raceTwoBuyersAndCancel(seller: Fighter, first: Fighter, second: Fighter, { price }: { price: number }) {
    const axe = await seller.add('axe:1:common');
    const id = listingId(await list(seller, axe.id, price));
    const prepared = await Promise.all([prepare(first, id), prepare(second, id)]);
    const total = async () => (await Promise.all([seller, first, second].map(f => f.wallet()))).reduce((sum, money) => sum + money, 0);
    const before = await total();
    const results = await Promise.all([purchase(first, id, buyCommand(id), prepared[0]), purchase(second, id, buyCommand(id), prepared[1]), cancel(seller, id)]);
    const row = await listingRow(id), item = await itemRow(axe.id);
    return { id, axe, results, row, item, offer: await offerRow(id), moneyChange: (await total()) - before,
      successes: results.filter(result => result.ok).length, terminal: row.status as string };
  },
};

describe('marketplace listings in the database', () => {
  beforeAll(async () => {
    await resetIdentity();
    await sql`update private.scheduler set enabled=false where singleton`;
    // Commands correctly return processing across a shared boundary; do not start a run in its final three minutes.
    const remaining = SLOT - (Date.now() % SLOT);
    if (remaining < 180_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
    // The longest sleep (181 s) plus the default hook time for this setup (Task 23.2 Decision 3; tests/stable-slot-waits.test.ts).
  }, 181_000 + 30_000);
  afterAll(() => sql.end());

  it('lets exactly one of two buyers and a cancel reach a terminal state', async () => {
    const seller = await fighter(), first = await fighter(), second = await fighter();
    const outcomes = [];
    for (let round = 0; round < 6; round++) outcomes.push(await market.raceTwoBuyersAndCancel(seller, first, second, { price: 101 }));
    for (const outcome of outcomes) {
      const [a, b, c] = outcome.results;
      expect(outcome.successes, JSON.stringify(outcome.results)).toBe(1);
      expect(['sold', 'cancelled']).toContain(outcome.terminal);
      expect(outcome.offer).toBeUndefined();
      expect(outcome.item.item.reservation).toBeNull();
      if (outcome.terminal === 'sold') {
        const [winner, loser] = a.ok ? [first, b] : [second, a];
        expect(outcome.row).toMatchObject({ buyer: winner.gid, receipt: (a.ok ? a : b).receiptId });
        expect(outcome.item).toMatchObject({ owner: winner.gid, item: { ownerId: winner.gid } });
        expect(loser).toHaveCode('sold');
        expect(c).toHaveCode('sold');
        expect(outcome.moneyChange).toBe(-5);
        expect(await saleReceipts(outcome.id)).toBe(1);
      } else {
        expect(outcome.row).toMatchObject({ buyer: null, receipt: c.receiptId });
        expect(outcome.item).toMatchObject({ owner: seller.gid, item: { ownerId: seller.gid } });
        expect(a).toHaveCode('not-found');
        expect(b).toHaveCode('not-found');
        expect(outcome.moneyChange).toBe(0);
        expect(await saleReceipts(outcome.id)).toBe(0);
      }
    }
    const sold = outcomes.filter(outcome => outcome.terminal === 'sold').length;
    expect((await seller.ledger()).map(row => [row.money, row.reason])).toEqual(Array(sold).fill([96, 'market-sale']));
    expect([...await first.ledger(), ...await second.ledger()].map(row => [row.money, row.reason])).toEqual(Array(sold).fill([-101, 'market-purchase']));
    expect(await first.wallet() + await second.wallet() + await seller.wallet()).toBe(3000 - 5 * sold);
  }, 60_000);

  it('replays a successful purchase without new debits or items, and rejects a changed payload', async () => {
    const seller = await fighter(), buyer = await fighter();
    const axe = await seller.add('axe:1:common'), bow = await seller.add('bow:1:common');
    const id = listingId(await list(seller, axe.id, 101)), other = listingId(await list(seller, bow.id, 50));
    const command = buyCommand(id), prepared = await prepare(buyer, id);
    const results = await Promise.all([1, 2, 3].map(() => purchase(buyer, id, command, prepared)));
    expect(results[0]).toMatchObject({ ok: true, receiptId: expect.any(String), value: { listingId: id, itemId: axe.id, price: 101, fee: 5 } });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    // A stale preparation still reaches SQL and replays the committed receipt.
    expect(await purchase(buyer, id, command, { baselinePeakStrength: 1, nextPeakStrength: 1 })).toEqual(results[0]);
    expect(await purchase(buyer, other, { ...command, listingId: other })).toHaveCode('conflict');
    // A stale page: another buyer of the sold listing gets `sold`, and the item stays with its new owner.
    const late = await fighter();
    expect(await purchase(late, id)).toHaveCode('sold');
    expect(await itemRow(axe.id)).toMatchObject({ owner: buyer.gid, item: { ownerId: buyer.gid, reservation: null } });
    expect(await late.wallet()).toBe(1000);
    expect(await buyer.wallet()).toBe(899);
    expect(await seller.wallet()).toBe(1096);
    expect((await buyer.items()).filter(item => item.id === axe.id)).toHaveLength(1);
    expect(await buyer.items()).toHaveLength(3);
    expect(await buyer.ledger()).toEqual([{ money: -101, reason: 'market-purchase', receipt: results[0].receiptId }]);
    expect(await seller.ledger()).toEqual([{ money: 96, reason: 'market-sale', receipt: expect.any(String) }]);
    expect(await saleReceipts(id)).toBe(1);
    expect(await receipts(command.operationId)).toBe(1);
    expect(await listingRow(other)).toMatchObject({ status: 'open' });
    expect(await listingRow(id)).toMatchObject({ status: 'sold', buyer: buyer.gid, receipt: results[0].receiptId });
  });

  // Launch feedback (2026-10-25): the fee is 5 % floored but at least 1 gold, greatest(1, price*5/100), and the lowest price is
  // 2, so a seller always receives something and no sale moves money for free.
  /** Lists a sword at `price`, buys it, and returns the purchase with both wallets' changes. */
  async function sale(seller: Fighter, buyer: Fighter, price: number) {
    const sword = await seller.add('sword:1:common');
    const id = listingId(await list(seller, sword.id, price));
    const before = { seller: await seller.wallet(), buyer: await buyer.wallet() };
    const bought = await purchase(buyer, id);
    return { id, sword, bought, seller: (await seller.wallet()) - before.seller, buyer: (await buyer.wallet()) - before.buyer };
  }
  it('a price-2 sale pays fee 1 and credits 1', async () => {
    expect(RULES_V1.fees.marketRate).toBe(0.05);
    const seller = await fighter({ money: 0 }), buyer = await fighter({ money: 1000 });
    const result = await sale(seller, buyer, 2);
    expect(result.bought).toMatchObject({ ok: true, value: { listingId: result.id, itemId: result.sword.id, price: 2, fee: 1 } });
    expect([result.seller, result.buyer]).toEqual([1, -2]);
    expect((await seller.ledger()).map(row => [row.money, row.reason])).toEqual([[1, 'market-sale']]);
    expect((await buyer.ledger()).map(row => [row.money, row.reason])).toEqual([[-2, 'market-purchase']]);
    // The seller's receipt records the same fee and credit.
    expect((await sql`select result->'value' as value from public.operation_receipts where request->>'kind'='market-sale' and request->>'listingId'=${result.id}`)[0].value)
      .toEqual({ listingId: result.id, itemId: result.sword.id, price: 2, fee: 1, moneyCredit: 1 });
  });

  it('a price-19 sale pays fee 1', async () => {
    const seller = await fighter({ money: 0 }), buyer = await fighter({ money: 1000 });
    // 19 and 20 pay the minimum of 1; from 40 the floored 5 % is above it (40 pays 2, 101 pays 5).
    for (const [price, fee] of [[19, 1], [20, 1], [39, 1], [40, 2], [101, 5]]) {
      const result = await sale(seller, buyer, price);
      expect(result.bought, String(price)).toMatchObject({ ok: true, value: { listingId: result.id, itemId: result.sword.id, price, fee } });
      expect([result.seller, result.buyer], String(price)).toEqual([price - fee, -price]);
    }
    expect((await seller.ledger()).map(row => [row.money, row.reason]))
      .toEqual([[18, 'market-sale'], [19, 'market-sale'], [38, 'market-sale'], [38, 'market-sale'], [96, 'market-sale']]);
    expect((await buyer.ledger()).map(row => [row.money, row.reason]))
      .toEqual([[-19, 'market-purchase'], [-20, 'market-purchase'], [-39, 'market-purchase'], [-40, 'market-purchase'], [-101, 'market-purchase']]);
  });

  it('a listing at price 1 is refused', async () => {
    const seller = await fighter({ money: 0 });
    const sword = await seller.add('sword:1:common');
    const command = listCommand(sword.id, 1);
    // A price shape error: invalid, with no receipt, no listing, no offer, and the item still free.
    expect(await list(seller, sword.id, 1, command)).toHaveCode('invalid');
    expect(await receipts(command.operationId)).toBe(0);
    expect(await sql`select count(*)::int as n from private.market_listings where item_id=${sword.id}`).toEqual([{ n: 0 }]);
    expect(await itemRow(sword.id)).toMatchObject({ owner: seller.gid, item: { reservation: null } });
    // Price 2 is the lowest that lists.
    expect(await list(seller, sword.id, 2)).toMatchObject({ ok: true });
  });

  it('refuses self-purchase, bound and renown items, equipped and pending-build items, and a sixth active listing', async () => {
    expect(RULES_V1.marketplace).toMatchObject({ maximumListings: 5, maximumPrice: 1_000_000_000, expiryMs: 604_800_000 });
    const seller = await fighter({ money: 100 }), other = await fighter();
    const state = await seller.state();
    const starter = state.currentBuild.equipment.weapon!;
    const axe = await seller.add('axe:1:common');
    expect(await send(seller.token, equip(state, axe.id))).toMatchObject({ ok: true });
    const renown = await seller.add('sword:1:renown');
    const renownOrigin = await seller.add('sword:1:common', { origin: 'renown' });
    const bound = await seller.add('sword:1:common', { binding: 'bound' });
    for (const id of [starter, axe.id, renown.id, renownOrigin.id, bound.id]) {
      const command = listCommand(id, 10);
      expect(await list(seller, id, 10, command), id).toHaveCode('invalid');
      expect(await receipts(command.operationId), id).toBe(1);
    }
    expect(await list(seller, randomUUID(), 10)).toHaveCode('not-found');
    expect(await list(seller, (await other.items())[0].id, 10)).toHaveCode('not-found');
    // Shape errors and prices outside 2..1,000,000,000 are refused without a receipt.
    const spare = await seller.add('bow:1:common');
    for (const command of [listCommand(spare.id, 0), listCommand(spare.id, 1), listCommand(spare.id, 1_000_000_001), listCommand(spare.id, 1.5), listCommand(spare.id, -1),
      { ...listCommand(spare.id, 10), extra: true }, { ...listCommand(spare.id, 10), itemId: 'not-a-uuid' }, { ...listCommand(spare.id, 10), price: '10' },
      { ...listCommand(spare.id, 10), kind: 'cancel-listing' }]) {
      expect(await list(seller, spare.id, 10, command), JSON.stringify(command)).toHaveCode('invalid');
      expect(await receipts(command.operationId as string)).toBe(0);
    }
    // Five active listings; the sixth is refused and recorded.
    const listed: string[] = [];
    for (const price of [2, 3, 4, 5, 1_000_000_000]) listed.push(listingId(await list(seller, (await seller.add('sword:1:common')).id, price)));
    const sixth = listCommand((await seller.add('sword:1:common')).id, 5);
    expect(await list(seller, sixth.itemId, 5, sixth)).toHaveCode('invalid');
    expect(await receipts(sixth.operationId)).toBe(1);
    // Players cannot buy their own listing.
    const self = buyCommand(listed[0]);
    expect(await purchase(seller, listed[0], self)).toHaveCode('invalid');
    expect(await receipts(self.operationId)).toBe(1);
    // Only the seller cancels; unknown listings are not found.
    expect(await cancel(other, listed[0])).toHaveCode('not-found');
    expect(await cancel(seller, randomUUID())).toHaveCode('not-found');
    expect(await purchase(other, randomUUID())).toHaveCode('not-found');
    expect(await cancel(seller, listed[1])).toMatchObject({ ok: true });
    expect(await cancel(seller, listed[1])).toHaveCode('not-found');
    expect(await purchase(other, listed[1])).toHaveCode('not-found');
    // A malformed purchase envelope is refused without a receipt.
    for (const command of [{ ...buyCommand(listed[0]), extra: 1 }, { ...buyCommand(listed[0]), listingId: 'nope' }, { ...buyCommand(listed[0]), kind: 'create-listing' }]) {
      expect(await purchase(other, listed[0], command), JSON.stringify(command)).toHaveCode('invalid');
      expect(await receipts(command.operationId)).toBe(0);
    }
    expect(await sql`select status, count(*)::int as n from private.market_listings where seller_gladiator_id=${seller.gid} group by status order by status`)
      .toEqual([{ status: 'cancelled', n: 1 }, { status: 'open', n: 4 }]);
    expect(await seller.wallet()).toBe(100);
    expect(await other.wallet()).toBe(1000);
    expect(await other.items()).toHaveLength(2);
  });

  it('blocks equip, NPC sale, discard and relisting while listed, and allows them after cancel or expiry', async () => {
    await withClock(async () => {
      const seller = await fighter({ money: 100 });
      const axe = await seller.add('axe:1:common');
      const id = listingId(await list(seller, axe.id, 30));
      let state = await seller.state();
      expect(state.inventory.find(item => item.id === axe.id)!.reservation).toEqual({ kind: 'listing', referenceId: id });
      expect(await send(seller.token, equip(state, axe.id))).toHaveCode('invalid');
      expect(await send(seller.token, sell(axe.id))).toHaveCode('invalid');
      expect(await send(seller.token, discard(axe.id))).toHaveCode('invalid');
      expect(await list(seller, axe.id, 30)).toHaveCode('invalid');
      await expect(sql`delete from public.item_instances where id=${axe.id}`).rejects.toMatchObject({ message: 'reserved item' });
      // Cancel returns the same item, which can be relisted, equipped and sold again.
      expect(await cancel(seller, id)).toMatchObject({ ok: true, receiptId: expect.any(String), value: { listingId: id, itemId: axe.id } });
      expect(await itemRow(axe.id)).toMatchObject({ owner: seller.gid, item: { reservation: null } });
      expect(await cancel(seller, listingId(await list(seller, axe.id, 30)))).toMatchObject({ ok: true });
      state = await seller.state();
      expect(await send(seller.token, equip(state, axe.id))).toMatchObject({ ok: true });
      expect(await send(seller.token, { kind: 'cancel-build', operationId: randomUUID(), expectedVersion: (await seller.state()).buildVersion })).toMatchObject({ ok: true });
      expect(await send(seller.token, sell(axe.id))).toMatchObject({ ok: true, value: { moneyCredit: 10 } });
      // Expiry returns the item too: until it is swept the item stays listed.
      const bow = await seller.add('bow:1:common');
      const old = listingId(await listAt(seller, bow.id, 30, await nowMs() - WEEK - 1_000));
      expect(await send(seller.token, discard(bow.id))).toHaveCode('invalid');
      expect(await sweep()).toBe(1);
      expect(await listingRow(old)).toMatchObject({ status: 'expired' });
      expect(await cancel(seller, listingId(await list(seller, bow.id, 30)))).toMatchObject({ ok: true });
      expect(await send(seller.token, discard(bow.id))).toMatchObject({ ok: true });
      expect((await seller.items()).map(item => item.catalogId).sort()).toEqual(['light-armor:1:common', 'sword:1:common']);
    });
  });

  it('lets exactly one of a concurrent listing and a build reservation or NPC sale of the same item succeed', async () => {
    const owner = await fighter({ money: 100 });
    // The handler path prepares before its transaction, so the direct listing call starts later in some rounds to vary who wins.
    const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const delays = [0, 0, 25, 50, 75, 100];
    for (const delay of delays) {
      const axe = await owner.add('axe:1:common');
      const state = await owner.state();
      const [listing, reserve] = await Promise.all([later(delay).then(() => list(owner, axe.id, 25)), send(owner.token, equip(state, axe.id))]);
      expect([listing.ok, reserve.ok].filter(Boolean), JSON.stringify([listing, reserve])).toHaveLength(1);
      const row = await itemRow(axe.id);
      if (listing.ok) {
        expect(row.item.reservation).toEqual({ kind: 'listing', referenceId: listing.value!.listingId });
        expect(['invalid', 'conflict']).toContain(reserve.code);
        expect(await cancel(owner, listing.value!.listingId as string)).toMatchObject({ ok: true });
      } else {
        expect(row.item.reservation).toMatchObject({ kind: 'pending-build' });
        expect(listing).toHaveCode('invalid');
        expect(await send(owner.token, { kind: 'cancel-build', operationId: randomUUID(), expectedVersion: (await owner.state()).buildVersion })).toMatchObject({ ok: true });
      }
    }
    for (const delay of delays) {
      const bow = await owner.add('bow:1:common');
      const [listing, sale] = await Promise.all([later(delay).then(() => list(owner, bow.id, 25)), send(owner.token, sell(bow.id))]);
      expect([listing.ok, sale.ok].filter(Boolean), JSON.stringify([listing, sale])).toHaveLength(1);
      const row = await itemRow(bow.id);
      if (listing.ok) {
        expect(row.item.reservation).toEqual({ kind: 'listing', referenceId: listing.value!.listingId });
        expect(sale).toHaveCode('invalid');
        expect(await cancel(owner, listing.value!.listingId as string)).toMatchObject({ ok: true });
      } else {
        expect(row).toBeUndefined();
        expect(listing).toHaveCode('not-found');
      }
    }
    expect(await sql`select count(*)::int as n from private.market_listings where seller_gladiator_id=${owner.gid} and status='open'`).toEqual([{ n: 0 }]);
  }, 60_000);

  it('refuses a buyer at 60 items with inventory-full and a short buyer with insufficient-funds, with no partial effect', async () => {
    const seller = await fighter(), full = await fighter(), poor = await fighter({ money: 100 }), held = await fighter({ money: 150 });
    await full.fill(58);
    const axe = await seller.add('axe:1:common');
    const id = listingId(await list(seller, axe.id, 101));
    const heldState = await held.state();
    const hold = equip(heldState, heldState.currentBuild.equipment.weapon!);
    expect(await send(held.token, hold)).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    // The server queues no fee any more; a build queued before the release holds one (100 here), as it was left.
    await makeLegacyPending(sql, held.gid, hold.operationId, { fee: 100 });
    expect(await held.state()).toMatchObject({ reservedFees: { money: 100 } });
    const snapshot = async () => ({ listing: await listingRow(id), offer: await offerRow(id), item: await itemRow(axe.id),
      wallets: await Promise.all([seller, full, poor, held].map(f => f.wallet())), counts: await Promise.all([full, poor, held].map(async f => (await f.items()).length)) });
    const before = await snapshot();
    expect(before.counts).toEqual([60, 2, 2]);
    const fullCommand = buyCommand(id);
    expect(await purchase(full, id, fullCommand)).toHaveCode('inventory-full');
    expect(await purchase(full, id, fullCommand)).toHaveCode('inventory-full');
    expect(await receipts(fullCommand.operationId)).toBe(1);
    expect(await purchase(poor, id)).toHaveCode('insufficient-funds');
    // Money held for a pending build is not spendable: 150 - 100 < 101.
    expect(await purchase(held, id)).toHaveCode('insufficient-funds');
    expect(await snapshot()).toEqual(before);
    expect(before.listing).toMatchObject({ status: 'open' });
    for (const f of [seller, full, poor, held]) expect(await f.ledger()).toEqual([]);
    expect(await saleReceipts(id)).toBe(0);
    // Exactly the price, with one free slot, is enough.
    await sql`update public.wallets set money=101 where gladiator_id=${poor.gid}`;
    expect(await purchase(poor, id)).toMatchObject({ ok: true, value: { price: 101, fee: 5 } });
    expect(await poor.wallet()).toBe(0);
  });

  it('refuses a seller credit that would pass the wallet cap', async () => {
    const seller = await fighter({ money: MAX_SAFE - 95 }), buyer = await fighter();
    const axe = await seller.add('axe:1:common');
    const id = listingId(await list(seller, axe.id, 101));
    const command = buyCommand(id);
    expect(await purchase(buyer, id, command)).toHaveCode('invalid');
    expect(await receipts(command.operationId)).toBe(1);
    expect(await seller.wallet()).toBe(MAX_SAFE - 95);
    expect(await buyer.wallet()).toBe(1000);
    expect(await listingRow(id)).toMatchObject({ status: 'open', buyer: null, receipt: null });
    expect(await offerRow(id)).toMatchObject({ id, price: 101 });
    expect(await itemRow(axe.id)).toMatchObject({ owner: seller.gid, item: { reservation: { kind: 'listing', referenceId: id } } });
    expect([...await seller.ledger(), ...await buyer.ledger()]).toEqual([]);
    // The credit may reach the cap exactly.
    await sql`update public.wallets set money=${String(MAX_SAFE - 96)} where gladiator_id=${seller.gid}`;
    expect(await purchase(buyer, id)).toMatchObject({ ok: true, value: { price: 101, fee: 5 } });
    expect(await seller.wallet()).toBe(MAX_SAFE);
  });

  it('expires due listings once, returns the item, and buy after expiry returns expired', async () => {
    await withClock(async () => {
      await sweep();
      const seller = await fighter(), buyer = await fighter();
      const a = await seller.add('axe:1:common'), b = await seller.add('bow:1:common'), c = await seller.add('spear:1:common'), d = await seller.add('sword:1:common');
      const e = await seller.add('round-shield:1:common');
      // The fresh listing comes first: a seller's own command expires its due listings before anything else.
      const fresh = listingId(await list(seller, b.id, 40));
      const now = await nowMs();
      const dueResult = await listAt(seller, a.id, 40, now - WEEK - 60_000);
      expect(dueResult).toMatchObject({ ok: true, value: { expiresAtMs: now - 60_000 } });
      const due = listingId(dueResult);
      const freshRow = await listingRow(fresh);
      expect(freshRow.expires - freshRow.listed).toBe(WEEK);
      expect(await offerRow(fresh)).toMatchObject({ listed: freshRow.listed, expires: freshRow.expires });
      // Unswept, the due listing is still open privately but hidden from every public reader.
      expect(await listingRow(due)).toMatchObject({ status: 'open' });
      expect((await anonymous.from('market_offers').select('id').eq('id', due)).data).toEqual([]);
      expect((await buyer.client.from('market_offers').select('id').eq('id', due)).data).toEqual([]);
      expect((await anonymous.from('market_offers').select('id').eq('id', fresh)).data).toEqual([{ id: fresh }]);
      // The scheduled tick sweeps after coordination (rolled back: this test must not advance the world).
      const rollback = new Error('rollback');
      await expect(sql.begin(async tx => {
        await tx`update private.scheduler set enabled=true where singleton`;
        const [{ tick }] = await tx`select private.cron_tick() as tick`;
        expect(tick).toMatchObject({ ok: true, expiry: { ok: true, expired: 1 } });
        expect((await tx`select status from private.market_listings where id=${due}`)[0].status).toBe('expired');
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await listingRow(due)).toMatchObject({ status: 'open' });
      expect(await sweep()).toBe(1);
      expect(await sweep()).toBe(0);
      expect(await listingRow(due)).toMatchObject({ status: 'expired', receipt: null, buyer: null });
      expect(await itemRow(a.id)).toMatchObject({ owner: seller.gid, item: { reservation: null } });
      expect(await offerRow(due)).toBeUndefined();
      expect(await listingRow(fresh)).toMatchObject({ status: 'open' });
      expect(await purchase(buyer, due)).toHaveCode('expired');
      expect(await cancel(seller, due)).toHaveCode('expired');
      // A due listing that no sweep has reached yet: the purchase itself expires it.
      const unswept = listingId(await listAt(seller, c.id, 40, now - WEEK - 1_000));
      expect(await purchase(buyer, unswept)).toHaveCode('expired');
      expect(await listingRow(unswept)).toMatchObject({ status: 'expired' });
      expect(await itemRow(c.id)).toMatchObject({ owner: seller.gid, item: { reservation: null } });
      expect(await offerRow(unswept)).toBeUndefined();
      // The seller's own next command expires its due listings first, so its listing count and inventory are never stale.
      const lapsed = listingId(await listAt(seller, e.id, 40, now - WEEK - 1_000));
      expect(await cancel(seller, fresh)).toMatchObject({ ok: true, value: { listingId: fresh, itemId: b.id } });
      expect(await listingRow(lapsed)).toMatchObject({ status: 'expired', receipt: null });
      expect(await itemRow(e.id)).toMatchObject({ owner: seller.gid, item: { reservation: null } });
      // Expiry after a proven wait for the listing row: the purchase starts while the listing is valid and is decided by
      // database time sampled after its locks (AGENTS.md Postgres concurrency).
      const soon = listingId(await listAt(seller, d.id, 40, (await nowMs()) - WEEK + 2_000));
      const { expires } = await listingRow(soon);
      const command = buyCommand(soon), prepared = await prepare(buyer, soon);
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const blocker = sql.begin(async tx => {
        await tx`select 1 from private.market_listings where id=${soon} for update`;
        locked(); await hold;
      });
      await ready;
      const contender = await sql.reserve();
      let response: Promise<{ r: Outcome }[]> | undefined;
      try {
        const [{ pid }] = await contender`select pg_backend_pid() as pid`;
        response = contender`select public.buy_listing(${buyer.id},${command.operationId},${contender.json({ command, prepared } as never)}) as r`.execute() as unknown as Promise<{ r: Outcome }[]>;
        response.catch(() => undefined);
        expect(await waitsOn(pid)).toBe(true);
        expect(await nowMs()).toBeLessThan(expires);
        while (await nowMs() <= expires) await new Promise(resolve => setTimeout(resolve, 40));
        release(); await blocker;
        expect((await response)[0].r).toHaveCode('expired');
      } finally { release(); await blocker; await response?.catch(() => undefined); contender.release(); }
      expect(await listingRow(soon)).toMatchObject({ status: 'expired' });
      expect(await buyer.wallet()).toBe(1000);
      expect(await seller.wallet()).toBe(1000);
      expect(await buyer.items()).toHaveLength(2);
      expect([...await seller.ledger(), ...await buyer.ledger()]).toEqual([]);
    });
  }, 60_000);

  it("takes both account locks in gladiator order, which matches boundary_start's order; a residual deadlock aborts atomically and the same operation can be retried", async () => {
    const x = await fighter(), y = await fighter();
    const [low, high] = x.gid < y.gid ? [x, y] : [y, x];
    // The higher gladiator buys from the lower one: a buyer-first order would hold the higher account and wait for the lower.
    const sword = await low.add('sword:1:common');
    const id = listingId(await list(low, sword.id, 30));
    const command = buyCommand(id), prepared = await prepare(high, id);
    let locked!: (pid: number) => void, release!: () => void;
    const ready = new Promise<number>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    // Session B takes account locks as boundary_start does: every member's, in gladiator order.
    const boundary = sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${low.id}::text,0))`;
      const [{ pid }] = await tx`select pg_backend_pid() as pid`;
      locked(pid); await hold;
      await tx`set local lock_timeout='3s'`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${high.id}::text,0))`;
      return 'both';
    });
    const boundaryPid = await ready;
    const contender = await sql.reserve();
    let response: Promise<{ r: Outcome }[]> | undefined;
    try {
      const [{ pid }] = await contender`select pg_backend_pid() as pid`;
      response = contender`select public.buy_listing(${high.id},${command.operationId},${contender.json({ command, prepared } as never)}) as r`.execute() as unknown as Promise<{ r: Outcome }[]>;
      response.catch(() => undefined);
      expect(await waitsOn(pid, boundaryPid)).toBe(true);
      // While it waits for the lower account, the purchase holds no account lock at all.
      expect(await sql`select count(*)::int as n from pg_locks where pid=${pid} and locktype='advisory' and granted`).toEqual([{ n: 0 }]);
      release();
      expect(await boundary).toBe('both');
      expect((await response)[0].r).toMatchObject({ ok: true, value: { listingId: id, itemId: sword.id, price: 30, fee: 1 } });
    } finally {
      release();
      await boundary.catch(() => undefined);
      await response?.catch(() => undefined);
      contender.release();
    }
    expect(await itemRow(sword.id)).toMatchObject({ owner: high.gid, item: { ownerId: high.gid, reservation: null } });

    // A residual deadlock (Task 18.1 review): a boundary does not always take its account locks in global order. Here session
    // B holds the higher account; the purchase, sent through the backend adapter, takes the lower one and waits for the
    // higher; B then asks for the lower. PostgreSQL aborts the purchase (only it runs the deadlock check: B's is pushed far
    // out), and the adapter answers a retryable `processing`.
    const axe = await low.add('axe:1:common');
    const second = listingId(await list(low, axe.id, 40));
    const retried = buyCommand(second);
    const wallets = async () => [await high.wallet(), await low.wallet()];
    const before = await wallets();
    let holding!: (pid: number) => void, proceed!: () => void;
    const held = new Promise<number>(resolve => { holding = resolve; });
    const go = new Promise<void>(resolve => { proceed = resolve; });
    const reversed = sql.begin(async tx => {
      await tx`set local deadlock_timeout='30s'`;
      await tx`set local lock_timeout='15s'`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${high.id}::text,0))`;
      const [{ pid }] = await tx`select pg_backend_pid() as pid`;
      holding(pid); await go;
      await tx`select pg_advisory_xact_lock(hashtextextended(${low.id}::text,0))`;
      return 'both';
    });
    const reversedPid = await held;
    let purchase: Promise<unknown> | undefined;
    let outcome: unknown;
    try {
      purchase = database.market({ userId: high.id }, retried);
      // Some session (the Data API's) waits on B's lock while holding the lower account.
      let waiting = false;
      for (let n = 0; n < 300 && !waiting; n++) {
        [{ waiting }] = await sql`select exists(select 1 from pg_locks l where not l.granted and l.locktype='advisory'
          and ${reversedPid}::int = any(pg_blocking_pids(l.pid))) as waiting`;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      proceed();
      outcome = await purchase;
      expect(await reversed).toBe('both');
    } finally {
      proceed();
      await reversed.catch(() => undefined);
      await purchase?.catch(() => undefined);
    }
    // PostgreSQL aborts the purchase as the deadlock victim. The Data API then either answers the error, which the adapter
    // turns into a retryable `processing` (PostgREST 16, the CLI's default local image), or runs the whole rolled-back
    // transaction again, which completes (PostgREST 14.18, the hosted projects' version, which `supabase start` also uses in
    // a checkout linked to one: observed 2026-10-24). Either way nothing is partial and the purchase happens once.
    if ((outcome as { ok?: boolean }).ok === false) {
      expect(outcome).toEqual({ ok: false, code: 'processing', retryAfterMs: 1000 });
      // Atomic: no receipt, no money, no item moved; the listing is still open.
      expect(await receipts(retried.operationId)).toBe(0);
      expect(await saleReceipts(second)).toBe(0);
      expect(await wallets()).toEqual(before);
      expect(await listingRow(second)).toMatchObject({ status: 'open', buyer: null, receipt: null });
      expect(await itemRow(axe.id)).toMatchObject({ owner: low.gid, item: { reservation: { kind: 'listing', referenceId: second } } });
      // The same operation, sent again, completes once.
      const done = await database.market({ userId: high.id }, retried);
      expect(done).toMatchObject({ ok: true, value: { listingId: second, itemId: axe.id, price: 40, fee: 2 } });
      expect(await database.market({ userId: high.id }, retried)).toEqual(done);
    } else {
      // The retried transaction sold the axe exactly once: one receipt each, the price and the 5 % fee moved once.
      expect(outcome).toMatchObject({ ok: true, value: { listingId: second, itemId: axe.id, price: 40, fee: 2 } });
      expect(await receipts(retried.operationId)).toBe(1);
      expect(await saleReceipts(second)).toBe(1);
      expect(await wallets()).toEqual([before[0] - 40, before[1] + 38]);
      // The same operation, sent again, replays it.
      expect(await database.market({ userId: high.id }, retried)).toEqual(outcome);
    }
    expect(await itemRow(axe.id)).toMatchObject({ owner: high.gid, item: { ownerId: high.gid, reservation: null } });
  });

  it('skips a seller whose account lock or listing row is held, without waiting, and expires the listing once it is free', async () => {
    await withClock(async () => {
      await sweep();
      const seller = await fighter();
      const bow = await seller.add('bow:1:common');
      const due = listingId(await listAt(seller, bow.id, 40, (await nowMs()) - WEEK - 1_000));
      for (const hold of ['account lock', 'listing row'] as const) {
        let locked!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { locked = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const holder = sql.begin(async tx => {
          if (hold === 'account lock') await tx`select pg_advisory_xact_lock(hashtextextended(${seller.id}::text,0))`;
          else await tx`select 1 from private.market_listings where id=${due} for update`;
          locked(); await held;
        });
        await ready;
        try {
          // A sweep that waited would fail on its lock timeout instead of returning.
          const started = Date.now();
          const [{ n }] = await sql.begin(async tx => {
            await tx`set local lock_timeout='2s'`;
            return tx`select private.expire_listings(private.planning_now_ms()) as n`;
          });
          expect(n, hold).toBe(0);
          expect(Date.now() - started, hold).toBeLessThan(2_000);
          expect(await listingRow(due), hold).toMatchObject({ status: 'open' });
          expect(await offerRow(due), hold).toMatchObject({ id: due });
          expect(await itemRow(bow.id), hold).toMatchObject({ item: { reservation: { kind: 'listing', referenceId: due } } });
        } finally { release(); await holder; }
      }
      // Free again: the next sweep expires it and returns the item.
      expect(await sweep()).toBe(1);
      expect(await listingRow(due)).toMatchObject({ status: 'expired', receipt: null, buyer: null });
      expect(await itemRow(bow.id)).toMatchObject({ owner: seller.gid, item: { reservation: null } });
      expect(await offerRow(due)).toBeUndefined();
    });
  });

  it('buys a listing through the real authenticated Edge runtime', async () => {
    const seller = await fighter(), buyer = await fighter(), late = await fighter();
    const armor = await seller.add('heavy-armor:10:rare'), bow = await seller.add('bow:1:common');
    // Listing through the runtime; the adapter canonicalizes ids in any letter case.
    const created = directEdge(seller.token, { kind: 'create-listing', operationId: randomUUID().toUpperCase(), itemId: armor.id.toUpperCase(), price: 200 });
    expect(created).toMatchObject({ status: 200, origin: 'http://127.0.0.1:3000', body: { ok: true, receiptId: expect.any(String),
      value: { listingId: expect.any(String), expiresAtMs: expect.any(Number) } } });
    const id = created.body.value.listingId as string;
    // A price above 1,000,000,000 is refused by the parser, before any transaction or receipt.
    const dear = { kind: 'create-listing', operationId: randomUUID(), itemId: bow.id, price: 1_000_000_001 };
    expect(directEdge(seller.token, dear)).toMatchObject({ status: 400, body: { ok: false, code: 'invalid' } });
    expect(await receipts(dear.operationId)).toBe(0);
    // Visitors read the offer, with its listing time.
    const [{ name }] = await sql`select name from public.gladiators where id=${seller.gid}`;
    const listed = await listingRow(id);
    expect(await readMarket(anonymous, undefined, seller.gid)).toEqual({ nextCursor: null, rows: [{ listingId: id, seller: { gladiatorId: seller.gid, name },
      item: { catalogId: 'heavy-armor:10:rare', catalogVersion: 'v1', tier: 10, rarity: 'rare', stats: armor.stats, quantity: 1 }, price: 200,
      listedAtMs: listed.listed, expiresAtMs: listed.expires }] });
    // The purchase: exact origins only, and the buyer's historical strength prepared from its owner state and the offer
    // (tier 10 rare heavy armor, 2 x 15.6 = 31.2, replaces light armor's 4 beside the starter sword's 24).
    const command = { kind: 'buy-listing', operationId: randomUUID(), listingId: id.toUpperCase() };
    expect(directEdge(buyer.token, command, 'https://evil.example').status).toBe(403);
    const bought = directEdge(buyer.token, command);
    expect(bought).toMatchObject({ status: 200, origin: 'http://127.0.0.1:3000', body: { ok: true, receiptId: expect.any(String),
      value: { listingId: id, itemId: armor.id, price: 200, fee: 10 } } });
    expect(await buyer.peak()).toBe(55.2);
    expect(directEdge(buyer.token, command)).toMatchObject({ status: 200, body: bought.body });
    // A stale page: the next buyer gets `sold`.
    expect(directEdge(late.token, { kind: 'buy-listing', operationId: randomUUID(), listingId: id })).toMatchObject({ status: 409, body: { ok: false, code: 'sold' } });
    expect(await itemRow(armor.id)).toMatchObject({ owner: buyer.gid, item: { ownerId: buyer.gid, reservation: null } });
    expect([await buyer.wallet(), await seller.wallet(), await late.wallet()]).toEqual([800, 1190, 1000]);
    expect(await buyer.ledger()).toEqual([{ money: -200, reason: 'market-purchase', receipt: bought.body.receiptId }]);
    expect((await readMarket(anonymous, undefined, seller.gid)).rows).toEqual([]);
    // Cancelling through the runtime returns the item to its seller.
    const relisted = directEdge(seller.token, { kind: 'create-listing', operationId: randomUUID(), itemId: bow.id, price: 30 });
    const other = relisted.body.value.listingId as string;
    expect(directEdge(seller.token, { kind: 'cancel-listing', operationId: randomUUID(), listingId: other }))
      .toMatchObject({ status: 200, body: { ok: true, value: { listingId: other, itemId: bow.id } } });
    expect(await itemRow(bow.id)).toMatchObject({ owner: seller.gid, item: { reservation: null } });
    expect((await readMarket(anonymous, undefined, seller.gid)).rows).toEqual([]);
  });

  it('pages the public offers newest first through the visitor Data API, 50 at a time', async () => {
    const sellers = [];
    for (let n = 0; n < 11; n++) sellers.push(await fighter());
    for (const seller of sellers) for (let n = 0; n < 5; n++) listingId(await list(seller, (await seller.add('sword:1:common')).id, 10 + n));
    // Every visible offer (other tests' open listings included), in the live read's order.
    const expected = (await sql`select id::text from public.market_offers where expires_at_ms>floor(extract(epoch from clock_timestamp())*1000)
      order by listed_at_ms desc, id`).map(row => row.id as string);
    expect(expected.length).toBeGreaterThan(50);
    const seen: string[] = [], sizes: number[] = [];
    for (let cursor: string | undefined, n = 0; n < 10; n++) {
      const page = await readMarket(anonymous, cursor);
      sizes.push(page.rows.length);
      seen.push(...page.rows.map(row => row.listingId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(sizes[0]).toBe(50);
    expect(sizes.every(size => size <= 50)).toBe(true);
    expect(seen).toEqual(expected);
    // One seller's open listings only, in the same order.
    const own = (await sql`select id::text from public.market_offers where seller_gladiator_id=${sellers[3].gid} order by listed_at_ms desc, id`).map(row => row.id);
    const mine = await readMarket(anonymous, undefined, sellers[3].gid);
    expect(mine.rows.map(row => row.listingId)).toEqual(own);
    expect(own).toHaveLength(5);
    expect(new Set(mine.rows.map(row => row.seller.gladiatorId))).toEqual(new Set([sellers[3].gid]));
    await expect(readMarket(anonymous, 'not-a-cursor')).rejects.toMatchObject({ code: 'unavailable' });
  }, 60_000);

  it('returns processing while either character is behind the current slot', async () => {
    const seller = await fighter(), buyer = await fighter();
    const axe = await seller.add('axe:1:common'), bow = await seller.add('bow:1:common');
    const id = listingId(await list(seller, axe.id, 30));
    const behind = (f: Fighter) => sql`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${f.gid}`;
    const current = (f: Fighter) => sql`update public.gladiators set processed_slot_index=floor(extract(epoch from clock_timestamp())*1000/4800000) where id=${f.gid}`;
    for (const lagging of [seller, buyer]) {
      await behind(lagging);
      const command = buyCommand(id);
      expect(await purchase(buyer, id, command)).toMatchObject({ ok: false, code: 'processing', retryAfterMs: 1000 });
      expect(await receipts(command.operationId)).toBe(0);
      await current(lagging);
    }
    // Create and cancel gate only on the acting seller.
    await behind(seller);
    const create = listCommand(bow.id, 30), cancelling = cancelCommand(id);
    expect(await list(seller, bow.id, 30, create)).toHaveCode('processing');
    expect(await cancel(seller, id, cancelling)).toHaveCode('processing');
    expect(await receipts(create.operationId) + await receipts(cancelling.operationId)).toBe(0);
    await current(seller);
    await behind(buyer);
    expect(await list(seller, bow.id, 30, create)).toMatchObject({ ok: true });
    await current(buyer);
    const command = buyCommand(id);
    const result = await purchase(buyer, id, command);
    expect(result).toMatchObject({ ok: true });
    // A committed receipt replays before the processing gate.
    await behind(buyer);
    expect(await purchase(buyer, id, command)).toEqual(result);
    await current(buyer);
    expect(await listingRow(id)).toMatchObject({ status: 'sold', buyer: buyer.gid });
  });

  it('raises the buyer historical strength from the baseline-checked preparation', async () => {
    const seller = await fighter(), buyer = await fighter();
    const armor = await seller.add('heavy-armor:10:rare');
    const id = listingId(await list(seller, armor.id, 200));
    const prepared = await prepare(buyer, id);
    // Heavy armor tier 10 rare: 2 x (6 x 2 x 1.3) = 31.2 replaces light armor's 4 beside the starter sword's 24.
    expect(prepared).toEqual({ baselinePeakStrength: 28, nextPeakStrength: 55.2 });
    const stale = buyCommand(id);
    expect(await purchase(buyer, id, stale, { baselinePeakStrength: 27, nextPeakStrength: 55.2 })).toHaveCode('conflict');
    expect(await purchase(buyer, id, stale, prepared)).toHaveCode('conflict');
    expect(await receipts(stale.operationId)).toBe(1);
    for (const bad of [null, { baselinePeakStrength: 28, nextPeakStrength: 27.99 }, { baselinePeakStrength: 28, nextPeakStrength: 28.001 },
      { baselinePeakStrength: 28 }, { baselinePeakStrength: 28, nextPeakStrength: '55.2' }, { ...prepared, extra: 1 }, { baselinePeakStrength: -1, nextPeakStrength: 55.2 }]) {
      const command = buyCommand(id);
      expect(await purchase(buyer, id, command, bad), JSON.stringify(bad)).toHaveCode('invalid');
      expect(await receipts(command.operationId)).toBe(0);
    }
    expect(await buyer.peak()).toBe(28);
    expect(await listingRow(id)).toMatchObject({ status: 'open' });
    expect(await purchase(buyer, id, buyCommand(id), prepared)).toMatchObject({ ok: true, value: { price: 200, fee: 10 } });
    expect(await buyer.peak()).toBe(55.2);
    expect((await buyer.state()).progression.peakStrength).toBe(55.2);
    expect(await seller.peak()).toBe(28);
  });

  it('denies clients the private listings table and every market function, and serves open offers to visitors read-only', async () => {
    const rows = await sql`select p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('create_listing','cancel_listing','buy_listing') order by p.proname`;
    expect(rows).toEqual(['buy_listing', 'cancel_listing', 'create_listing'].map(proname => ({ proname, prosecdef: false, proconfig: ['search_path=""'],
      authenticated: false, anon: false, service: true })));
    const privateFunctions = await sql`select p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('anon',p.oid,'EXECUTE') as client,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname in ('market_command','market_close_listing','expire_seller_listings','guard_market_listing','expire_listings','cron_tick')
      order by p.proname`;
    // The sweep and the tick run only from pg_cron: granted to nobody.
    expect(privateFunctions).toEqual(['cron_tick', 'expire_listings', 'expire_seller_listings', 'guard_market_listing', 'market_close_listing', 'market_command']
      .map(proname => ({ proname, prosecdef: false, proconfig: ['search_path=""'], client: false, service: !['cron_tick', 'expire_listings'].includes(proname) })));
    expect(await sql`select c.relname, c.relrowsecurity as rls, c.reloptions,
      has_table_privilege('anon',c.oid,'SELECT') as anon, has_table_privilege('authenticated',c.oid,'SELECT') as player,
      has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as write,
      has_table_privilege('service_role',c.oid,'SELECT') as backend_read, has_table_privilege('service_role',c.oid,'UPDATE') as backend_update
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where (n.nspname,c.relname) in (('private','market_listings'),('public','market_offers')) order by c.relname`).toEqual([
      { relname: 'market_listings', rls: true, reloptions: null, anon: false, player: false, write: false, backend_read: true, backend_update: true },
      { relname: 'market_offers', rls: true, reloptions: null, anon: true, player: true, write: false, backend_read: true, backend_update: false }]);
    // Offers do not bump the world revision: they load on demand.
    const revision = async () => (await sql`select revision::text from public.world_revision_state where singleton`)[0].revision as string;
    const seller = await fighter(), reader = await fighter();
    const sword = await seller.add('sword:5:uncommon');
    const before = await revision();
    const id = listingId(await list(seller, sword.id, 77));
    expect(await revision()).toBe(before);
    const [{ name }] = await sql`select name from public.gladiators where id=${seller.gid}`;
    const { item: _listed, ...row } = (await offerRow(id))!;
    expect(row).toMatchObject({ id, seller: seller.gid, name, price: 77 });
    // Visitors and signed-in players read the sanitized offer, never the owner-only item fields.
    for (const client of [anonymous, reader.client]) {
      const { data, error } = await client.from('market_offers').select('*').eq('id', id);
      expect(error).toBeNull();
      expect(data).toEqual([{ id, seller_gladiator_id: seller.gid, seller_name: name, price: 77, listed_at_ms: row.listed, expires_at_ms: row.expires,
        item: { catalogId: 'sword:5:uncommon', catalogVersion: 'v1', tier: 5, rarity: 'uncommon', stats: sword.stats, quantity: 1 } }]);
      expect((await client.from('market_offers').insert({ id: randomUUID() }).select()).error).not.toBeNull();
      expect((await client.from('market_offers').update({ price: 1 }).eq('id', id).select()).data ?? []).toEqual([]);
      await client.from('market_offers').delete().eq('id', id);
      expect((await client.schema('private').from('market_listings').select('*')).error).not.toBeNull();
      for (const fn of ['create_listing', 'cancel_listing', 'buy_listing']) {
        expect((await client.rpc(fn, { actor_id: seller.id, operation_id: randomUUID(), input: {} })).error, fn).not.toBeNull();
      }
    }
    expect(await offerRow(id)).toMatchObject({ id, price: 77 });
    expect(await cancel(seller, id)).toMatchObject({ ok: true });
    expect(await revision()).toBe(before);
    expect((await anonymous.from('market_offers').select('id').eq('id', id)).data).toEqual([]);
    // An expired offer that no sweep has removed yet is hidden by RLS, even by its id.
    await withClock(async () => {
      const old = listingId(await listAt(seller, sword.id, 77, await nowMs() - WEEK - 1_000));
      expect(await offerRow(old)).toMatchObject({ id: old });
      for (const client of [anonymous, reader.client]) expect((await client.from('market_offers').select('id').eq('id', old)).data).toEqual([]);
      expect(await sweep()).toBe(1);
    });
  });
});
