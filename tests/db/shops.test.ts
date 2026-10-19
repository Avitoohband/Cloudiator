import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation, request, directEdge } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase, prepareGrant, prepareShopPurchase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { shopOffers } from '../../supabase/functions/_shared/domain/inventory.ts';

type Outcome = { ok: boolean; code?: string; receiptId?: string; value?: Record<string, unknown> };
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
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand): Promise<Outcome> => (await handleCommand(request(token, body), deps)).json();
const buy = (catalogId: string, quantity = 1): Extract<GameCommand, { kind: 'buy-shop' }> => ({ kind: 'buy-shop', operationId: randomUUID(), catalogId, catalogVersion: 'v1', quantity });
const sell = (itemId: string, quantity = 1): GameCommand => ({ kind: 'sell-item', operationId: randomUUID(), itemId, quantity });
const discard = (itemId: string, quantity = 1): GameCommand => ({ kind: 'discard-item', operationId: randomUUID(), itemId, quantity });
const zero = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };

/** Real creation through the handler; the trusted local operator then funds the wallet and sets the level. */
async function fighter(options: { money?: number; renown?: number; level?: number } = {}) {
  const owner = await account();
  const created = await send(owner.token, creation('Shop ' + randomUUID().slice(0, 8)));
  expect(created.ok).toBe(true);
  const gid = created.value!.gladiatorId as string;
  await sql`update public.wallets set money=${String(options.money ?? 1000)},renown=${options.renown ?? 0} where gladiator_id=${gid}`;
  if (options.level) await sql`update public.gladiators set level=${options.level} where id=${gid}`;
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    expect(error).toBeNull();
    return data!.state;
  };
  const wallet = async () => {
    const row = (await sql`select money::text, renown::text from public.wallets where gladiator_id=${gid}`)[0];
    return { money: Number(row.money), renown: Number(row.renown) };
  };
  const items = async () => (await sql`select item from public.item_instances where gladiator_id=${gid} order by id`).map(row => row.item as ItemInstance);
  const ledger = async () => sql`select money_delta::float8 as money, renown_delta::float8 as renown, reason, receipt_id::text as receipt
    from public.wallet_ledger where gladiator_id=${gid} and reason<>'creation' order by created_at`;
  const peak = async () => Number((await sql`select peak_strength from public.gladiators where id=${gid}`)[0].peak_strength);
  /** Operator inventory setup only; player paths go through the command handler. */
  async function add(catalogId: string, overrides: Partial<ItemInstance> = {}) {
    const entry = CATALOG_V1.items[catalogId], id = randomUUID();
    const item = { id, ownerId: gid, catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats, quantity: 1,
      origin: entry.renownPrice === null ? 'shop' : 'renown', binding: entry.binding, reservation: null, ...overrides };
    await sql`insert into public.item_instances values(${id},${gid},${sql.json(item as never)})`;
    return item as ItemInstance;
  }
  async function addSalvage(quantity: number) {
    const id = randomUUID();
    const item = { id, ownerId: gid, catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common',
      stats: { damage: 0, armor: 0, weight: 0, intervalMs: 0, attributes: zero }, quantity, origin: 'expedition', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances values(${id},${gid},${sql.json(item as never)})`;
    return item as ItemInstance;
  }
  async function fill(count: number) {
    const entry = CATALOG_V1.items['sword:1:common'];
    const template = { catalogId: entry.id, catalogVersion: 'v1', tier: 1, rarity: 'common', stats: entry.stats, quantity: 1, origin: 'shop', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances(id,gladiator_id,item) select x.id,${gid},${sql.json(template as never)}::jsonb||jsonb_build_object('id',x.id,'ownerId',${gid}::text)
      from (select gen_random_uuid() as id from generate_series(1,${count})) x`;
  }
  return { ...owner, gid, state, wallet, items, ledger, peak, add, addSalvage, fill };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;
function equip(state: OwnerState, weapon: string): Extract<GameCommand, { kind: 'queue-build' }> {
  return { kind: 'queue-build', operationId: randomUUID(), expectedVersion: state.buildVersion, classId: state.currentBuild.classId,
    stance: state.currentBuild.stance, allocation: state.currentBuild.allocations, equipment: { ...state.currentBuild.equipment, weapon } };
}

/** Step 1 helpers: each drives the real handler, TypeScript preparation and SQL transaction. */
const db = {
  async buyRenownSword(owner?: Fighter) {
    const player = owner ?? await fighter({ renown: 100 });
    const result = await send(player.token, buy('sword:1:renown'));
    expect(result.ok).toBe(true);
    return result.value!;
  },
  async sellBoundItem() {
    const player = await fighter({ renown: 100 });
    const bought = await db.buyRenownSword(player);
    return send(player.token, sell((bought.itemIds as string[])[0]));
  },
  /** A sale and a build reserving the same item race on separate connections; count the item's terminal transitions. */
  async raceSellAndReserve(player: Fighter) {
    const axe = await player.add('axe:1:common');
    const state = await player.state();
    const [sale, reserve] = await Promise.all([send(player.token, sell(axe.id)), send(player.token, equip(state, axe.id))]);
    const row = (await sql`select item from public.item_instances where id=${axe.id}`)[0]?.item as ItemInstance | undefined;
    const sold = row === undefined ? 1 : 0, reserved = row?.reservation?.kind === 'pending-build' ? 1 : 0;
    if (reserved) expect((await send(player.token, { kind: 'cancel-build', operationId: randomUUID(), expectedVersion: (await player.state()).buildVersion })).ok).toBe(true);
    const loser = sale.ok ? reserve : sale;
    return { terminalTransitions: sold + reserved, successes: [sale.ok, reserve.ok].filter(Boolean).length, sold: sold === 1, loserCode: loser.code };
  },
};

describe('inventory and NPC shops', () => {
  it('rolls back acquired items and the receipt when the final wallet write fails', async () => {
    const owner = await fighter();
    const command = buy('heavy-armor:1:common');
    const prepared = prepareShopPurchase(command, await owner.state());
    await expect(sql.begin(async tx => {
      await tx.unsafe("create function private.test_shop_failure() returns trigger language plpgsql as $$ begin raise exception 'injected shop failure'; end $$");
      await tx.unsafe('create trigger test_shop_failure before update on public.wallets for each row execute function private.test_shop_failure()');
      await tx`select public.buy_shop(${owner.id},${command.operationId},${tx.json({ command, prepared } as never)})`;
    })).rejects.toThrow('injected shop failure');
    expect(await owner.items()).toHaveLength(2);
    expect(await owner.wallet()).toEqual({ money: 1000, renown: 0 });
    expect(await owner.peak()).toBe(28);
    expect(await sql`select count(*)::int as n from public.operation_receipts where operation_id=${command.operationId}`).toEqual([{ n: 0 }]);
    expect(await send(owner.token, command)).toMatchObject({ ok: true });
  });
  it('buys one account-bound banner for 50 renown without inventory or strength effects, replaying once', async () => {
    const owner = await fighter({ renown: 150 });
    await owner.fill(58);
    const before = await owner.peak();
    const command = buy('banner');
    const result = await send(owner.token, command);
    expect(result).toMatchObject({ ok: true, value: { cosmeticId: 'banner', renownDebit: 50, bound: true } });
    expect(await send(owner.token, command)).toEqual(result);
    expect(await send(owner.token, buy('banner'))).toHaveCode('conflict');
    expect(await send(owner.token, buy('banner', 2))).toHaveCode('invalid');
    expect(await owner.wallet()).toEqual({ money: 1000, renown: 100 });
    expect(await owner.items()).toHaveLength(60);
    expect(await owner.peak()).toBe(before);
    expect(await owner.state()).toMatchObject({ ownedCosmetics: [{ catalogId: 'banner', catalogVersion: 'v1', binding: 'bound' }] });
    expect(await owner.ledger()).toHaveLength(1);
    const other = await fighter();
    expect((await other.client.from('owned_cosmetics').select('*')).data).toEqual([]);
    expect((await owner.client.from('owned_cosmetics').delete().eq('gladiator_id', owner.gid)).error).not.toBeNull();
  });
  beforeAll(async () => {
    await resetIdentity();
    // Commands correctly return processing across a shared boundary; do not start a run in its final two minutes.
    const remaining = SLOT - (Date.now() % SLOT);
    if (remaining < 120_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
    // The longest sleep (121 s) plus the default hook time for this setup (Task 23.2 Decision 3; tests/stable-slot-waits.test.ts).
  }, 121_000 + 30_000);
  afterAll(() => sql.end());

  it('exposes backend-only buy_shop, sell_item and discard_item RPCs with invoker security', async () => {
    const rows = await sql`select p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('buy_shop','sell_item','discard_item') order by p.proname`;
    expect(rows).toEqual(['buy_shop', 'discard_item', 'sell_item'].map(proname => ({ proname, prosecdef: false, proconfig: ['search_path=""'],
      authenticated: false, anon: false, service: true })));
    const privateFunctions = await sql`select p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname in ('apply_inventory_plan','guard_cosmetic','guard_historical_strength','guard_inventory_item','inventory_command') order by p.proname`;
    expect(privateFunctions).toEqual(['apply_inventory_plan', 'guard_cosmetic', 'guard_historical_strength', 'guard_inventory_item', 'inventory_command']
      .map(proname => ({ proname, prosecdef: false, proconfig: ['search_path=""'], authenticated: false, anon: false, service: true })));
    for (const role of ['anon', 'authenticated']) {
      const [privileges] = await sql`select has_table_privilege(${role},'public.owned_cosmetics','INSERT,UPDATE,DELETE,TRUNCATE') as mutation`;
      expect(privileges.mutation).toBe(false);
    }
    expect((await anonymous.from('owned_cosmetics').select('*')).error).not.toBeNull();
    const owner = await fighter();
    for (const name of ['buy_shop', 'sell_item', 'discard_item']) {
      expect((await owner.client.rpc(name, { actor_id: owner.id, operation_id: randomUUID(), input: {} })).error, name).not.toBeNull();
      expect((await anonymous.rpc(name, { actor_id: owner.id, operation_id: randomUUID(), input: {} })).error, name).not.toBeNull();
    }
  });

  it('records the starter loadout as historical strength at creation', async () => {
    const owner = await fighter();
    // Starter sword 4 x 6 x (1000/1000) plus light armor 2 x 2.
    expect((await owner.state()).progression.peakStrength).toBe(28);
  });

  it('buys a bound renown sword for renown alone and raises historical strength', async () => {
    const owner = await fighter({ money: 500, renown: 100 });
    const value = await db.buyRenownSword(owner);
    expect(value).toMatchObject({ renownDebit: 50, bound: true, moneyDebit: 0, currency: 'renown', catalogId: 'sword:1:renown', quantity: 1 });
    expect(await owner.wallet()).toEqual({ money: 500, renown: 50 });
    const item = (await owner.items()).find(row => row.id === (value.itemIds as string[])[0])!;
    expect(item).toMatchObject({ ownerId: owner.gid, catalogId: 'sword:1:renown', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity: 1,
      origin: 'renown', binding: 'bound', reservation: null, stats: { damage: 6, armor: 0, weight: 4, intervalMs: 1000, attributes: zero } });
    // Renown sword 4 x 6 x 1.1 replaces the starter sword in the best loadout: 26.4 + 4.
    expect(value.peakStrength).toBe(30.4);
    expect(await owner.peak()).toBe(30.4);
    expect(await owner.ledger()).toEqual([{ money: 0, renown: -50, reason: 'shop-purchase', receipt: expect.any(String) }]);
  });

  it('refuses to sell bound gear to an NPC', async () => {
    expect(await db.sellBoundItem()).toHaveCode('invalid');
    const owner = await fighter({ renown: 50 });
    const bought = await db.buyRenownSword(owner);
    const command = sell((bought.itemIds as string[])[0]);
    expect(await send(owner.token, command)).toHaveCode('invalid');
    expect(await send(owner.token, command)).toHaveCode('invalid');
    expect(await owner.wallet()).toEqual({ money: 1000, renown: 0 });
    expect((await owner.items()).some(item => item.catalogId === 'sword:1:renown')).toBe(true);
    expect(await sql`select count(*)::int as n from public.operation_receipts where operation_id=${command.operationId}`).toEqual([{ n: 1 }]);
  });

  it('charges the exact versioned price for every merchant offer', async () => {
    const money = { sword: 40, axe: 40, spear: 40, bow: 40, 'round-shield': 30, 'leather-hood': 20, 'iron-helmet': 40, 'light-armor': 40, 'heavy-armor': 80, 'light-boots': 20, 'heavy-boots': 40 };
    const renown = { sword: 50, axe: 50, spear: 50, bow: 50, 'round-shield': 40, 'leather-hood': 30, 'iron-helmet': 30, 'light-armor': 50, 'heavy-armor': 50, 'light-boots': 30, 'heavy-boots': 30 };
    const multiplier = { money: { 1: 1, 5: 3, 10: 6 }, renown: { 1: 1, 5: 2, 10: 3 } } as const;
    const buyers = { money: await fighter({ money: 100_000, level: 10 }), renown: await fighter({ renown: 100_000, level: 10 }) };
    const offers = shopOffers(CATALOG_V1);
    expect(offers).toHaveLength(66);
    for (const offer of offers) {
      const [template, tier] = offer.catalogId.split(':') as [keyof typeof money, string];
      const price = (offer.currency === 'money' ? money : renown)[template] * multiplier[offer.currency][Number(tier) as 1 | 5 | 10];
      const owner = buyers[offer.currency];
      const before = await owner.wallet();
      // The adapter path is the handler's own transaction without the per-minute HTTP rate limit.
      const result = await database.inventory({ userId: owner.id }, buy(offer.catalogId)) as Outcome;
      expect(result.ok, offer.catalogId).toBe(true);
      expect(result.value, offer.catalogId).toMatchObject({ moneyDebit: offer.currency === 'money' ? price : 0, renownDebit: offer.currency === 'renown' ? price : 0,
        bound: offer.currency === 'renown' });
      expect(await owner.wallet(), offer.catalogId).toEqual({ money: before.money - (offer.currency === 'money' ? price : 0), renown: before.renown - (offer.currency === 'renown' ? price : 0) });
      const item = (await owner.items()).find(row => row.id === (result.value!.itemIds as string[])[0])!;
      expect(item.stats, offer.catalogId).toEqual(CATALOG_V1.items[offer.catalogId].stats);
      expect(item, offer.catalogId).toMatchObject({ origin: offer.currency === 'renown' ? 'renown' : 'shop', binding: offer.currency === 'renown' ? 'bound' : 'tradable' });
    }
    expect((await buyers.money.state()).inventory).toHaveLength(35);
  }, 120_000);

  it('rejects insufficient spendable money or renown, including funds held for a pending build', async () => {
    const poor = await fighter({ money: 39, renown: 49 });
    expect(await send(poor.token, buy('sword:1:common'))).toHaveCode('insufficient-funds');
    expect(await send(poor.token, buy('sword:1:renown'))).toHaveCode('insufficient-funds');
    expect(await poor.wallet()).toEqual({ money: 39, renown: 49 });
    const held = await fighter({ money: 139 });
    const state = await held.state();
    expect(await send(held.token, { ...equip(state, state.currentBuild.equipment.weapon!), classId: 'berserker' })).toMatchObject({ ok: true, value: { reservedMoney: 100 } });
    expect(await send(held.token, buy('sword:1:common'))).toHaveCode('insufficient-funds');
    expect(await send(held.token, buy('round-shield:1:common'))).toMatchObject({ ok: true, value: { moneyDebit: 30 } });
    expect(await held.state()).toMatchObject({ wallets: { money: 109 }, reservedFees: { money: 100 } });
    expect((await poor.items())).toHaveLength(2);
    expect(await poor.ledger()).toEqual([]);
  });

  it('replays the same purchase operation once and rejects a changed payload', async () => {
    const owner = await fighter({ money: 200 });
    const command = buy('axe:1:common');
    const results = await Promise.all([send(owner.token, command), send(owner.token, command), send(owner.token, command)]);
    expect(results[0].ok).toBe(true);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(await send(owner.token, command)).toEqual(results[0]);
    expect(await send(owner.token, { ...command, quantity: 2 })).toHaveCode('conflict');
    expect(await owner.wallet()).toEqual({ money: 160, renown: 0 });
    expect((await owner.items()).filter(item => item.catalogId === 'axe:1:common')).toHaveLength(1);
    expect(await owner.ledger()).toEqual([{ money: -40, renown: 0, reason: 'shop-purchase', receipt: results[0].receiptId }]);
  });

  it('enforces tier level locks under the lock and refuses variants the merchants do not sell', async () => {
    const owner = await fighter({ money: 1000, renown: 1000 });
    for (const catalogId of ['sword:5:common', 'heavy-armor:10:common', 'sword:5:renown', 'sword:1:uncommon', 'bow:1:rare']) {
      expect(await send(owner.token, buy(catalogId)), catalogId).toHaveCode('invalid');
    }
    await sql`update public.gladiators set level=9 where id=${owner.gid}`;
    expect(await send(owner.token, buy('heavy-armor:10:common'))).toHaveCode('invalid');
    expect(await send(owner.token, buy('sword:5:common'))).toMatchObject({ ok: true, value: { moneyDebit: 120 } });
    expect(await send(owner.token, buy('sword:5:renown'))).toMatchObject({ ok: true, value: { renownDebit: 100 } });
    expect(await owner.wallet()).toEqual({ money: 880, renown: 900 });
  });

  it('counts every owned item against capacity at 59, 60 and 61 and never converts a rejected purchase', async () => {
    const owner = await fighter({ money: 1000, renown: 1000 });
    await owner.fill(57);
    expect((await owner.state()).inventory).toHaveLength(59);
    expect(await send(owner.token, buy('sword:1:common', 2))).toHaveCode('inventory-full');
    expect(await send(owner.token, buy('sword:1:common'))).toMatchObject({ ok: true });
    expect((await owner.state()).inventory).toHaveLength(60);
    const full = buy('sword:1:renown');
    expect(await send(owner.token, full)).toHaveCode('inventory-full');
    expect(await send(owner.token, full)).toHaveCode('inventory-full');
    expect(await owner.wallet()).toEqual({ money: 960, renown: 1000 });
    expect(await owner.ledger()).toHaveLength(1);
    await expect(owner.add('axe:1:common')).rejects.toMatchObject({ message: 'inventory full' });
    expect((await owner.state()).inventory).toHaveLength(60);
  });

  it('serializes concurrent purchases for the last free slot', async () => {
    const owner = await fighter({ money: 1000 });
    await owner.fill(57);
    const results = await Promise.all([send(owner.token, buy('axe:1:common')), send(owner.token, buy('bow:1:common'))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(['inventory-full', 'conflict']).toContain(results.find(result => !result.ok)!.code);
    expect((await owner.state()).inventory).toHaveLength(60);
    expect((await owner.wallet()).money).toBe(960);
  });

  it('sells and discards partial salvage stacks at the catalog value without minting', async () => {
    const owner = await fighter({ money: 100 });
    const stack = await owner.addSalvage(12);
    const before = await owner.peak();
    expect(await send(owner.token, sell(stack.id, 5))).toMatchObject({ ok: true, value: { itemId: stack.id, quantity: 5, remainingQuantity: 7, moneyCredit: 50 } });
    expect(await send(owner.token, sell(stack.id, 8))).toHaveCode('invalid');
    expect(await send(owner.token, discard(stack.id, 2))).toMatchObject({ ok: true, value: { quantity: 2, remainingQuantity: 5 } });
    expect((await owner.items()).find(item => item.id === stack.id)?.quantity).toBe(5);
    expect(await send(owner.token, sell(stack.id, 5))).toMatchObject({ ok: true, value: { remainingQuantity: 0, moneyCredit: 50 } });
    expect((await owner.items()).some(item => item.id === stack.id)).toBe(false);
    expect(await owner.wallet()).toEqual({ money: 200, renown: 0 });
    expect((await owner.ledger()).map(row => [row.money, row.reason])).toEqual([[50, 'npc-sale'], [50, 'npc-sale']]);
    expect(await owner.peak()).toBe(before);
    const axe = await owner.add('axe:5:uncommon', { origin: 'expedition' });
    expect(await send(owner.token, sell(axe.id, 2))).toHaveCode('invalid');
    // 25% of the Common tier-5 axe price (120) x 1.15, rounded down.
    expect(await send(owner.token, sell(axe.id))).toMatchObject({ ok: true, value: { moneyCredit: 34 } });
  });

  it('discards unequipped bound gear for nothing and never lowers historical strength', async () => {
    const owner = await fighter({ money: 100, renown: 200 });
    const sword = await db.buyRenownSword(owner);
    const helmet = await send(owner.token, buy('iron-helmet:1:renown'));
    // 26.4 renown sword + 4 light armor + 2 x 3 x 1.1 renown helmet.
    expect(await owner.peak()).toBe(37);
    const command = discard((helmet.value!.itemIds as string[])[0]);
    const result = await send(owner.token, command);
    expect(result).toMatchObject({ ok: true, value: { quantity: 1, remainingQuantity: 0 } });
    expect(await send(owner.token, command)).toEqual(result);
    expect(await send(owner.token, discard((sword.itemIds as string[])[0]))).toMatchObject({ ok: true });
    expect(await owner.wallet()).toEqual({ money: 100, renown: 120 });
    expect((await owner.items()).map(item => item.catalogId).sort()).toEqual(['light-armor:1:common', 'sword:1:common']);
    expect(await owner.peak()).toBe(37);
    expect((await owner.state()).progression.peakStrength).toBe(37);
    expect(await owner.ledger()).toHaveLength(2);
  });

  it('rejects sale or discard of equipped, pending-build and listed items', async () => {
    const owner = await fighter({ money: 100 });
    const state = await owner.state();
    const starter = state.currentBuild.equipment.weapon!;
    const axe = await owner.add('axe:1:common');
    expect(await send(owner.token, equip(state, axe.id))).toMatchObject({ ok: true });
    const listed = await owner.add('bow:1:common', { reservation: { kind: 'listing', referenceId: randomUUID() } });
    for (const id of [starter, axe.id, listed.id]) {
      expect(await send(owner.token, sell(id)), id).toHaveCode('invalid');
      expect(await send(owner.token, discard(id)), id).toHaveCode('invalid');
    }
    expect(await send(owner.token, sell(randomUUID()))).toHaveCode('not-found');
    expect(await owner.items()).toHaveLength(4);
    expect(await owner.wallet()).toEqual({ money: 100, renown: 0 });
  });

  it('lets exactly one of a concurrent sale and equip reach a terminal transition', async () => {
    const owner = await fighter({ money: 100 });
    const outcomes = [];
    for (let round = 0; round < 6; round++) outcomes.push(await db.raceSellAndReserve(owner));
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ terminalTransitions: 1, successes: 1 });
      // The loser is a decided business outcome (reserved item, stale or missing build item), never an unconfirmed one.
      expect(['invalid', 'conflict']).toContain(outcome.loserCode);
    }
    const sold = outcomes.filter(outcome => outcome.sold).length;
    expect((await owner.wallet()).money).toBe(100 + 10 * sold);
  });

  it('returns processing while the world is behind and replays committed receipts', async () => {
    const owner = await fighter({ money: 100 });
    const command = buy('leather-hood:1:common');
    await sql`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${owner.gid}`;
    expect(await send(owner.token, command)).toHaveCode('processing');
    expect(await sql`select count(*)::int as n from public.operation_receipts where operation_id=${command.operationId}`).toEqual([{ n: 0 }]);
    await sql`update public.gladiators set processed_slot_index=floor(extract(epoch from clock_timestamp())*1000/4800000) where id=${owner.gid}`;
    const result = await send(owner.token, command);
    expect(result).toMatchObject({ ok: true, value: { moneyDebit: 20 } });
    await sql`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${owner.gid}`;
    expect(await send(owner.token, command)).toEqual(result);
    const hood = (result.value!.itemIds as string[])[0];
    expect(await send(owner.token, sell(hood))).toHaveCode('processing');
    expect(await send(owner.token, discard(hood))).toHaveCode('processing');
    expect(await owner.wallet()).toEqual({ money: 80, renown: 0 });
  });

  it('rejects wallet overflow and stale canonical preparation without partial effects', async () => {
    const owner = await fighter({ money: MAX_SAFE - 5 });
    const stack = await owner.addSalvage(3);
    expect(await send(owner.token, sell(stack.id))).toHaveCode('invalid');
    expect(await owner.wallet()).toEqual({ money: MAX_SAFE - 5, renown: 0 });
    const command = buy('sword:1:common');
    const prepared = prepareShopPurchase(command, await owner.state());
    await owner.add('bow:1:common');
    const stale = await admin.rpc('buy_shop', { actor_id: owner.id, operation_id: command.operationId, input: { command, prepared } });
    expect(stale.error).toBeNull();
    expect(stale.data).toHaveCode('conflict');
    expect(await owner.items()).toHaveLength(4);
    expect(await owner.wallet()).toEqual({ money: MAX_SAFE - 5, renown: 0 });
  });

  it('keeps item identity, bound ownership, capacity and historical strength immutable in SQL', async () => {
    const owner = await fighter({ renown: 100 }), other = await fighter();
    const axe = await owner.add('axe:1:common');
    const bought = await db.buyRenownSword(owner);
    const bound = (bought.itemIds as string[])[0];
    await expect(sql`update public.item_instances set item=jsonb_set(item,'{stats,damage}','99') where id=${axe.id}`).rejects.toMatchObject({ message: 'immutable item' });
    await expect(sql`update public.item_instances set item=jsonb_set(item,'{origin}','"renown"') where id=${axe.id}`).rejects.toMatchObject({ message: 'immutable item' });
    await expect(sql`update public.item_instances set item=jsonb_set(item,'{quantity}','2') where id=${axe.id}`).rejects.toMatchObject({ message: 'immutable item' });
    await expect(sql`update public.item_instances set gladiator_id=${other.gid},item=jsonb_set(item,'{ownerId}',to_jsonb(${other.gid}::text)) where id=${bound}`)
      .rejects.toMatchObject({ message: 'immutable item' });
    await expect(sql`update public.gladiators set peak_strength=0 where id=${owner.gid}`).rejects.toMatchObject({ message: 'historical strength decrease' });
    // Unreserved tradable items can still change owner (marketplace transfer) and reservation.
    await sql`update public.item_instances set gladiator_id=${other.gid},item=jsonb_set(item,'{ownerId}',to_jsonb(${other.gid}::text)) where id=${axe.id}`;
    expect((await other.items()).some(item => item.id === axe.id)).toBe(true);
  });

  it('applies a canonical expedition grant plan with partial stacks and logged overflow for settlement', async () => {
    const owner = await fighter({ money: 100 });
    const stack = await owner.addSalvage(998);
    await owner.fill(56);
    const state = await owner.state();
    expect(state.inventory).toHaveLength(59);
    const prepared = prepareGrant(state, [{ catalogId: 'salvage', catalogVersion: 'v1', quantity: 1005, origin: 'expedition' },
      { catalogId: 'axe:5:uncommon', catalogVersion: 'v1', quantity: 1, origin: 'expedition' }]);
    expect(prepared.plan).toMatchObject({ stacked: [{ itemId: stack.id, quantity: 1 }], overflowMoney: 84,
      overflow: [{ catalogId: 'salvage', quantity: 5, money: 50 }, { catalogId: 'axe:5:uncommon', quantity: 1, money: 34 }] });
    // Settlement calls the primitive inside its own locked transaction; the operator reproduces that here.
    const [{ applied }] = await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${owner.id},0))`;
      return tx`select private.apply_inventory_plan(${owner.gid},${tx.json(prepared as never)}) as applied`;
    });
    expect(applied).toMatchObject({ itemIds: [expect.any(String)], overflowMoney: 84 });
    const items = await owner.items();
    expect(items).toHaveLength(60);
    expect(items.find(item => item.id === stack.id)?.quantity).toBe(999);
    expect(items.find(item => item.id === applied.itemIds[0])).toMatchObject({ catalogId: 'salvage', quantity: 999, origin: 'expedition', reservation: null });
    // The primitive never credits money itself; settlement writes its one ledger row with the reported overflow.
    expect(await owner.wallet()).toEqual({ money: 100, renown: 0 });
    const [{ again }] = await sql`select private.apply_inventory_plan(${owner.gid},${sql.json(prepared as never)}) as again`;
    expect(again).toBeNull();
    expect(await owner.items()).toHaveLength(60);
  });

  it('serves item commands through the real authenticated Edge runtime with exact origin enforcement', async () => {
    const owner = await fighter({ money: 100 });
    const response = directEdge(owner.token, buy('light-boots:1:common'));
    expect(response.status).toBe(200);
    expect(response.origin).toBe('http://127.0.0.1:3000');
    expect(response.body).toMatchObject({ ok: true, value: { moneyDebit: 20, bound: false } });
    const boots = response.body.value.itemIds[0];
    expect(directEdge(owner.token, sell(boots), 'https://evil.example').status).toBe(403);
    const sold = directEdge(owner.token, sell(boots));
    expect(sold).toMatchObject({ status: 200, body: { ok: true, value: { moneyCredit: 5 } } });
    expect(await owner.wallet()).toEqual({ money: 85, renown: 0 });
    const other = await account();
    expect((await other.client.from('item_instances').select('*')).data).toEqual([]);
  });
});
