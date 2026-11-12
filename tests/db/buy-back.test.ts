import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, account, admin, anonymous, resetIdentity, creation, request, directEdge } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';

// Patch 1.9 (M34, supabase/sql/28-feedback-buyback.sql): every NPC sale of gear stores a snapshot (the item as it was, the gold
// paid, the sale time and the receipt) in public.npc_sales; salvage is never stored. The owner read lists this gladiator's last 10
// gear sales of the current game day not yet bought back (`buyBack`). The `buy-back` command (public.buy_back) takes the same
// account lock, receipt replay, `processing` check and lock order as `sell-item`, returns the same item instance for exactly the
// gold it was sold for (ledger reason `npc-buy-back`) and marks the sale bought back. Older or out-of-window sales are `expired`.
const SLOT = 4_800_000, GAME_DAY = 14_400_000;
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
type Outcome = { ok: boolean; code?: string; receiptId?: string; retryAfterMs?: number; value?: Record<string, unknown> };
const send = async (token: string, body: unknown): Promise<Outcome> => (await handleCommand(request(token, body), deps)).json();
const sell = (itemId: string, quantity = 1) => ({ kind: 'sell-item', operationId: randomUUID(), itemId, quantity });
const buyBack = (saleId: number) => ({ kind: 'buy-back', operationId: randomUUID(), saleId });

/** A gladiator created through the adapter; the trusted local operator funds it and adds items (player paths go through the handler). */
async function fighter(money = 1000) {
  const owner = await account();
  const created = await database.createGladiator({ userId: owner.id }, creation('Seller ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  const gid = created.value.gladiatorId;
  await sql`update public.wallets set money=${money} where gladiator_id=${gid}`;
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    expect(error).toBeNull();
    return data!.state;
  };
  const money_ = async () => Number((await sql`select money::text from public.wallets where gladiator_id=${gid}`)[0].money);
  const item = async (id: string) => (await sql`select item from public.item_instances where id=${id} and gladiator_id=${gid}`)[0]?.item as ItemInstance | undefined;
  const count = async () => (await sql`select count(*)::int as n from public.item_instances where gladiator_id=${gid}`)[0].n as number;
  const ledger = async () => (await sql`select money_delta::float8 as money, reason from public.wallet_ledger where gladiator_id=${gid} and reason<>'creation'
    order by created_at, reason`).map(r => [r.money, r.reason]);
  const sales = async () => sql`select id::int, item_id::text, price::float8 as price, bought_back_at_ms is not null as bought_back from public.npc_sales
    where gladiator_id=${gid} order by id`;
  async function add(catalogId: string, overrides: Partial<ItemInstance> = {}) {
    const entry = CATALOG_V1.items[catalogId], id = randomUUID();
    const value = { id, ownerId: gid, catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats, quantity: 1,
      origin: 'expedition', binding: entry.binding, reservation: null, ...overrides };
    await sql`insert into public.item_instances values(${id},${gid},${sql.json(value as never)})`;
    return value as ItemInstance;
  }
  async function addSalvage(quantity: number) {
    const id = randomUUID(), zero = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };
    const value = { id, ownerId: gid, catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common',
      stats: { damage: 0, armor: 0, weight: 0, intervalMs: 0, attributes: zero }, quantity, origin: 'expedition', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances values(${id},${gid},${sql.json(value as never)})`;
    return value as ItemInstance;
  }
  async function fill(count: number) {
    const entry = CATALOG_V1.items['sword:1:common'];
    const template = { catalogId: entry.id, catalogVersion: 'v1', tier: 1, rarity: 'common', stats: entry.stats, quantity: 1, origin: 'shop', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances(id,gladiator_id,item) select x.id,${gid},${sql.json(template as never)}::jsonb||jsonb_build_object('id',x.id,'ownerId',${gid}::text)
      from (select gen_random_uuid() as id from generate_series(1,${count})) x`;
  }
  /** Sells one item through the handler and answers its sale id from the owner read. */
  async function sold(item: ItemInstance) {
    const result = await send(owner.token, sell(item.id));
    expect(result, item.catalogId).toMatchObject({ ok: true, value: { itemId: item.id, quantity: 1, remainingQuantity: 0 } });
    const entry = (await state()).buyBack.find(row => row.item.id === item.id);
    expect(entry, item.catalogId).toBeDefined();
    return entry!.saleId;
  }
  return { ...owner, gid, state, money: money_, item, count, ledger, sales, add, addSalvage, fill, sold };
}

beforeEach(resetIdentity);
afterAll(() => sql.end());
beforeAll(async () => {
  // Commands answer processing across a slot boundary (a game day ends on one); do not start in a slot's last two minutes.
  const remaining = SLOT - (Date.now() % SLOT);
  if (remaining < 120_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
}, 121_000 + 30_000);

describe('buy back', () => {
  it('lists a gear sale and buys back the identical item for exactly the gold it was sold for', async () => {
    const me = await fighter(100);
    const axe = await me.add('axe:5:uncommon');
    const before = await me.item(axe.id);
    const sale = await send(me.token, sell(axe.id));
    // The sale's own answer is unchanged by the snapshot.
    expect(sale).toEqual({ ok: true, receiptId: expect.any(String), value: { itemId: axe.id, quantity: 1, remainingQuantity: 0, moneyCredit: 34 } });
    expect(await me.money()).toBe(134);
    const [{ now }] = await sql`select floor(extract(epoch from clock_timestamp())*1000)::float8 as now`;
    const list = (await me.state()).buyBack;
    expect(list).toEqual([{ saleId: expect.any(Number), item: before, price: 34, soldAtMs: expect.any(Number),
      expiresAtMs: Math.floor(list[0].soldAtMs / GAME_DAY) * GAME_DAY + GAME_DAY }]);
    expect(list[0].soldAtMs).toBeLessThanOrEqual(now);
    const command = buyBack(list[0].saleId);
    const result = await send(me.token, command);
    expect(result).toEqual({ ok: true, receiptId: expect.any(String), value: { itemId: axe.id, moneyDebit: 34 } });
    // Same id, same jsonb (level, rarity, stats, origin), reservation null; the gold is exactly the sale's.
    expect(await me.item(axe.id)).toEqual(before);
    expect(await me.money()).toBe(100);
    expect(await me.ledger()).toEqual([[34, 'npc-sale'], [-34, 'npc-buy-back']]);
    expect((await me.state()).buyBack).toEqual([]);
    expect(await me.sales()).toEqual([{ id: list[0].saleId, item_id: axe.id, price: 34, bought_back: true }]);
    // A replay returns the stored result and changes nothing; another body under the operation is a conflict.
    expect(await send(me.token, command)).toEqual(result);
    expect(await send(me.token, { ...command, saleId: list[0].saleId + 1 })).toEqual({ ok: false, code: 'conflict' });
    // A second buy back of the same sale is refused: it can no longer be bought back.
    expect(await send(me.token, buyBack(list[0].saleId))).toEqual({ ok: false, code: 'expired' });
    expect(await me.money()).toBe(100);
    expect(await me.count()).toBe(3);
    // It can be sold again: a new sale with its own id.
    const again = await me.sold((await me.item(axe.id))!);
    expect(again).toBeGreaterThan(list[0].saleId);
  });

  it('keeps the last 10 gear sales of the game day: the eleventh-newest and one from an earlier game day are expired', async () => {
    const me = await fighter();
    const swords = [];
    for (let n = 0; n < 12; n++) swords.push(await me.add(n % 2 ? 'sword:5:common' : 'sword:1:common'));
    // Eleven sales through the adapter (the handler's transaction without the per-minute HTTP rate limit).
    for (const sword of swords.slice(0, 11)) {
      expect(await database.inventory({ userId: me.id }, sell(sword.id) as never), sword.id).toMatchObject({ ok: true });
    }
    const saleIds = (await me.sales()).map(row => row.id as number);
    expect(saleIds).toHaveLength(11);
    // Newest first, ten of them: the oldest (eleventh-newest) is not offered and cannot be bought back.
    const list = (await me.state()).buyBack;
    expect(list.map(row => row.saleId)).toEqual([...saleIds].reverse().slice(0, 10));
    expect(list.map(row => row.item.id)).toEqual(swords.slice(1, 11).map(s => s.id).reverse());
    expect(await send(me.token, buyBack(saleIds[0]))).toEqual({ ok: false, code: 'expired' });
    // A bought-back sale still takes its place among the last 10, so a new sale pushes the oldest offered one out.
    expect(await send(me.token, buyBack(saleIds[10]))).toMatchObject({ ok: true, value: { itemId: swords[10].id } });
    expect((await me.state()).buyBack.map(row => row.saleId)).toEqual(saleIds.slice(1, 10).reverse());
    await me.sold(swords[11]);
    expect((await me.state()).buyBack.map(row => row.item.id)).toEqual([swords[11].id, ...swords.slice(2, 10).map(s => s.id).reverse()]);
    expect(await send(me.token, buyBack(saleIds[1]))).toEqual({ ok: false, code: 'expired' });
    // A sale from the previous game day (operator setup: its time moves back one game day) is expired and no longer offered.
    await sql`update public.npc_sales set sold_at_ms=sold_at_ms-${GAME_DAY} where id=${saleIds[5]}`;
    expect((await me.state()).buyBack.map(row => row.saleId)).not.toContain(saleIds[5]);
    expect(await send(me.token, buyBack(saleIds[5]))).toEqual({ ok: false, code: 'expired' });
    expect(await me.item(swords[5].id)).toBeUndefined();
    // The refusals are decided outcomes: each stored with its operation, nothing moved.
    const refused = buyBack(saleIds[5]);
    expect(await send(me.token, refused)).toEqual({ ok: false, code: 'expired' });
    expect(await send(me.token, refused)).toEqual({ ok: false, code: 'expired' });
    expect(await sql`select count(*)::int as n from public.operation_receipts where operation_id=${refused.operationId}`).toEqual([{ n: 1 }]);
  });

  it('removes a gladiator\'s sales of earlier game days when it sells again, keeping today\'s', async () => {
    const me = await fighter();
    const [a, b, c] = [await me.add('sword:1:common'), await me.add('bow:1:common'), await me.add('spear:1:common')];
    const first = await me.sold(a), second = await me.sold(b);
    await sql`update public.npc_sales set sold_at_ms=sold_at_ms-${2 * GAME_DAY} where id=${first}`;
    await me.sold(c);
    expect((await me.sales()).map(row => row.id)).toEqual([second, expect.any(Number)]);
    expect(await send(me.token, buyBack(first))).toEqual({ ok: false, code: 'not-found' });
  });

  it('refuses a buy back without enough spendable gold, with a full bag, or while the world is behind, moving nothing', async () => {
    const me = await fighter(0);
    const [sword, shield] = [await me.add('sword:5:rare'), await me.add('round-shield:1:common')];
    const swordSale = await me.sold(sword), shieldSale = await me.sold(shield);
    expect(await me.money()).toBe(39 + 7);
    // Not enough gold: the price is the sale's, 39.
    await sql`update public.wallets set money=38 where gladiator_id=${me.gid}`;
    expect(await send(me.token, buyBack(swordSale))).toEqual({ ok: false, code: 'insufficient-funds' });
    expect([await me.money(), await me.item(sword.id)]).toEqual([38, undefined]);
    await sql`update public.wallets set money=39 where gladiator_id=${me.gid}`;
    // A full bag (60 of 60): refused even with the gold.
    await me.fill(60 - await me.count());
    expect(await send(me.token, buyBack(swordSale))).toEqual({ ok: false, code: 'inventory-full' });
    expect(await me.money()).toBe(39);
    await sql`delete from public.item_instances where gladiator_id=${me.gid} and item->>'catalogId'='sword:1:common' and item->>'origin'='shop'`;
    // Behind the world clock: processing, with no receipt, so the same operation succeeds after catch-up.
    const command = buyBack(swordSale);
    await sql`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${me.gid}`;
    expect(await send(me.token, command)).toEqual({ ok: false, code: 'processing', retryAfterMs: 1000 });
    expect(await sql`select count(*)::int as n from public.operation_receipts where operation_id=${command.operationId}`).toEqual([{ n: 0 }]);
    await sql`update public.gladiators set processed_slot_index=floor(extract(epoch from clock_timestamp())*1000/4800000) where id=${me.gid}`;
    expect(await send(me.token, command)).toMatchObject({ ok: true, value: { itemId: sword.id, moneyDebit: 39 } });
    expect(await me.money()).toBe(0);
    expect(await send(me.token, buyBack(shieldSale))).toEqual({ ok: false, code: 'insufficient-funds' });
  });

  it('never offers or stores a salvage sale', async () => {
    const me = await fighter();
    const stack = await me.addSalvage(12);
    expect(await send(me.token, sell(stack.id, 5))).toMatchObject({ ok: true, value: { remainingQuantity: 7 } });
    expect(await send(me.token, sell(stack.id, 7))).toMatchObject({ ok: true, value: { remainingQuantity: 0 } });
    expect(await me.sales()).toEqual([]);
    expect((await me.state()).buyBack).toEqual([]);
  });

  it('lets no other gladiator buy it back, and shows a player its own sales only', async () => {
    const me = await fighter(), other = await fighter();
    const axe = await me.add('axe:5:uncommon');
    const saleId = await me.sold(axe);
    expect(await send(other.token, buyBack(saleId))).toEqual({ ok: false, code: 'not-found' });
    expect(await other.item(axe.id)).toBeUndefined();
    expect(await me.item(axe.id)).toBeUndefined();
    expect((await other.state()).buyBack).toEqual([]);
    // An account without a gladiator has nothing to buy back.
    const visitor = await account();
    expect(await send(visitor.token, buyBack(saleId))).toEqual({ ok: false, code: 'not-found' });
    // The table: the owner reads its own rows; another account none; visitors and every write are refused.
    expect((await me.client.from('npc_sales').select('id,gladiator_id,item_id,price')).data).toEqual([{ id: saleId, gladiator_id: me.gid, item_id: axe.id, price: 34 }]);
    expect((await other.client.from('npc_sales').select('id')).data).toEqual([]);
    expect((await anonymous.from('npc_sales').select('id')).error?.code).toBe('42501');
    for (const [who, client] of [['owner', me.client], ['other', other.client], ['visitor', anonymous]] as const) {
      expect((await client.from('npc_sales').update({ bought_back_at_ms: 1 }).eq('id', saleId)).error?.code, who).toBe('42501');
      expect((await client.from('npc_sales').delete().eq('id', saleId)).error?.code, who).toBe('42501');
      expect((await client.rpc('buy_back', { actor_id: me.id, operation_id: randomUUID(), input: { command: buyBack(saleId) } })).error?.code, who).toBe('42501');
    }
    // Backend-only, an invoker function with a pinned search path.
    expect(await sql`select p.prosecdef, p.proconfig, p.proacl::text as acl from pg_proc p where p.oid='public.buy_back(uuid,uuid,jsonb)'::regprocedure`)
      .toEqual([{ prosecdef: false, proconfig: ['search_path=""'], acl: '{postgres=X/postgres,service_role=X/postgres}' }]);
  });

  it('raises historical strength when the item comes back to a stronger loadout, and refuses a stale preparation', async () => {
    const me = await fighter();
    // The operator's sword (no acquisition, so no strength was recorded): the starter loadout's 28 stands.
    const sword = await me.add('sword:5:rare');
    const saleId = await me.sold(sword);
    expect((await me.state()).progression.peakStrength).toBe(28);
    // A preparation from another baseline, or for another item, or none: conflict, stored, nothing moved.
    const stale = buyBack(saleId);
    for (const prepared of [{ itemId: sword.id, baselinePeakStrength: 27, nextPeakStrength: 50.8 }, { itemId: randomUUID(), baselinePeakStrength: 28, nextPeakStrength: 28 }, null]) {
      const command = buyBack(saleId);
      const { data } = await admin.rpc('buy_back', { actor_id: me.id, operation_id: command.operationId, input: { command, prepared } });
      expect(data, JSON.stringify(prepared)).toEqual({ ok: false, code: 'conflict' });
    }
    for (const prepared of [{ itemId: sword.id, baselinePeakStrength: 28, nextPeakStrength: 27 }, { itemId: sword.id, baselinePeakStrength: 28 }, 'x']) {
      const { data } = await admin.rpc('buy_back', { actor_id: me.id, operation_id: stale.operationId, input: { command: stale, prepared } });
      expect(data, JSON.stringify(prepared)).toEqual({ ok: false, code: 'invalid' });
    }
    expect(await me.item(sword.id)).toBeUndefined();
    // Through the command: Sword L5 rare, 4 x 11.7 = 46.8, replaces the starter sword's 24 beside light armor's 4.
    expect(await send(me.token, buyBack(saleId))).toMatchObject({ ok: true, value: { itemId: sword.id, moneyDebit: 39 } });
    expect((await me.state()).progression.peakStrength).toBe(50.8);
  });

  it('counts a bought-back item\'s gold toward gold earned once: selling it again earns no title progress', async () => {
    const me = await fighter(0);
    const gold = async () => Number((await sql`select coalesce(sum(value),0)::int as n from public.title_counters
      where gladiator_id=${me.gid} and counter in ('gold-v1','gold-v2')`)[0].n);
    const axe = await me.add('axe:5:uncommon');
    const first = await me.sold(axe);
    expect(await gold()).toBe(34);
    expect(await send(me.token, buyBack(first))).toMatchObject({ ok: true });
    expect(await gold()).toBe(34);
    const second = await me.sold(axe);
    expect(await gold()).toBe(34);
    expect(await send(me.token, buyBack(second))).toMatchObject({ ok: true });
    await me.sold(axe);
    expect(await gold()).toBe(34);
    expect(await me.money()).toBe(34);
    // Another item's first sale still counts.
    await me.sold(await me.add('sword:5:rare'));
    expect(await gold()).toBe(34 + 39);
  });

  it('buys back through the real local Edge runtime', async () => {
    const me = await fighter(100);
    const boots = await me.add('heavy-boots:1:common');
    const saleId = await me.sold(boots);
    const response = directEdge(me.token, buyBack(saleId));
    expect(response).toMatchObject({ status: 200, origin: 'http://127.0.0.1:3000', body: { ok: true, value: { itemId: boots.id, moneyDebit: 10 } } });
    expect(directEdge(me.token, buyBack(saleId)).status).toBe(409);
    expect(directEdge(me.token, { ...buyBack(saleId), saleId: 0 }).status).toBe(400);
  });
});
