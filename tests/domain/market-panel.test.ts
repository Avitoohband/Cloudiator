import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ItemInstance, MarketListing, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { createDisplayClock } from '@/game/display-clock';
import { MARKET_FEE_PERCENT, listableItems, marketErrorText, marketFee, sellerReceives, timeLeft } from '@/features/market/market-text';
import { MarketOffers, MarketPanel, ownerReads, type OffersModel } from '@/features/market/MarketPanel';
import { itemFixture, ownerFixture, worldFixture } from '../fixtures/domain';
import { MARKET_ROWS } from '../fixtures/market';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = worldFixture.serverNowMs;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const item = (catalogId: string, id: string, extra: Partial<ItemInstance> = {}): ItemInstance => ({ ...itemFixture(CATALOG_V1.items[catalogId]), id, ...extra });

describe('market fees (plan Decision 2)', () => {
  it('keeps 5% of the price, rounded down, and pays the seller the rest', () => {
    expect([1, 19, 20, 101].map(marketFee)).toEqual([0, 0, 1, 5]);
    expect(sellerReceives(101)).toBe(96);
    expect(sellerReceives(1)).toBe(1);
    expect(marketFee(999_999_999)).toBe(49_999_999);
    expect(marketFee(1_000_000_000)).toBe(50_000_000);
    expect(sellerReceives(1_000_000_000)).toBe(950_000_000);
  });

  it('takes the rate from the rules as a whole percent, with exact integer floor math (final review M-b)', async () => {
    // The rules' rate is a whole percent, so `floor(price × percent / 100)` matches the database's bigint `price*5/100`.
    expect(MARKET_FEE_PERCENT / 100).toBe(RULES_V1.fees.marketRate);
    const prices = [1, 19, 20, 101, 1_000_000_000];
    expect(prices.map(marketFee)).toEqual([0, 0, 1, 5, 50_000_000]);
    // Another rate in the rules changes the panel's fee with it: nothing is hard-coded.
    vi.resetModules();
    vi.doMock('@domain/rules-v1', async importOriginal => {
      const actual = await importOriginal<typeof import('@domain/rules-v1')>();
      return { RULES_V1: { ...actual.RULES_V1, fees: { ...actual.RULES_V1.fees, marketRate: 0.1 } } };
    });
    try {
      const ruled = await import('@/features/market/market-text');
      expect(ruled.MARKET_FEE_PERCENT).toBe(10);
      expect(prices.map(ruled.marketFee)).toEqual([0, 1, 2, 10, 100_000_000]);
    } finally {
      vi.doUnmock('@domain/rules-v1');
      vi.resetModules();
    }
  });
});

describe('a trader’s owner reads (final review I1)', () => {
  it('reads the owner once when the panel opens, however often opening runs, and again on each Refresh', async () => {
    let reads = 0;
    const owner = ownerReads(async () => { reads += 1; });
    await owner.open();
    // A development remount runs the opening effect twice: still one read.
    await owner.open();
    expect(reads).toBe(1);
    await owner.refresh();
    expect(reads).toBe(2);
    await owner.refresh();
    expect(reads).toBe(3);
  });

  it('keeps the owner last shown when a read fails', async () => {
    const owner = ownerReads(() => Promise.reject(new Error('offline')));
    await expect(owner.open()).resolves.toBeUndefined();
    await expect(owner.refresh()).resolves.toBeUndefined();
  });
});

describe('time left on a listing', () => {
  it('names the two largest whole units, never rounding up', () => {
    expect(timeLeft(NOW + 2 * HOUR, NOW)).toBe('2 h left');
    expect(timeLeft(NOW + 2 * HOUR + 30 * MINUTE + 59_999, NOW)).toBe('2 h 30 min left');
    expect(timeLeft(NOW + 6 * DAY + 22 * HOUR + 59 * MINUTE, NOW)).toBe('6 d 22 h left');
    expect(timeLeft(NOW + 7 * DAY, NOW)).toBe('7 d left');
    expect(timeLeft(NOW + 45 * MINUTE + 30_000, NOW)).toBe('45 min left');
    expect(timeLeft(NOW + 59_999, NOW)).toBe('Under a minute left');
  });

  it('says a listing at or past its expiry has expired', () => {
    expect(timeLeft(NOW, NOW)).toBe('Expired');
    expect(timeLeft(NOW - 1, NOW)).toBe('Expired');
  });
});

describe('items a seller can list (controller ruling: equipment only)', () => {
  it('offers tradable equipment that is not equipped, reserved, bound, renown or salvage', () => {
    const owner: OwnerState = structuredClone(ownerFixture);
    owner.inventory = [
      item('axe:5:common', 'free-axe'),
      item('sword:1:renown', 'renown-sword'),
      item('light-armor:1:common', 'bound-armor', { binding: 'bound' }),
      item('round-shield:1:common', 'equipped-shield', { reservation: { kind: 'equipment', referenceId: owner.gladiatorId } }),
      item('iron-helmet:1:common', 'worn-helmet'),
      item('heavy-boots:1:common', 'pending-boots', { reservation: { kind: 'pending-build', referenceId: 'build-op' } }),
      item('spear:1:common', 'reserved-spear'),
      item('bow:1:common', 'listed-bow', { reservation: { kind: 'listing', referenceId: 'listing-1' } }),
      { ...item('axe:1:common', 'salvage'), catalogId: 'salvage', quantity: 12 },
      item('light-armor:5:uncommon', 'free-armor'),
    ];
    owner.currentBuild.equipment.head = 'worn-helmet';
    owner.pendingBuild = { build: { ...owner.currentBuild, version: 2 }, effectiveSlotIndex: 1, reservedMoney: 0, reservedItemIds: ['reserved-spear'], operationId: 'op' };
    expect(listableItems(owner).map(i => i.id)).toEqual(['free-axe', 'free-armor']);
  });
});

describe('market refusals (plan Decision 9)', () => {
  it('explains every code, and that a stale page was refreshed', () => {
    expect(marketErrorText('sold', 'buy-listing')).toMatch(/already (been )?sold.*refreshed/i);
    expect(marketErrorText('expired', 'buy-listing')).toMatch(/expired.*refreshed/i);
    expect(marketErrorText('not-found', 'buy-listing')).toMatch(/no longer open.*refreshed/i);
    expect(marketErrorText('not-found', 'cancel-listing')).toMatch(/no longer open.*refreshed/i);
    expect(marketErrorText('insufficient-funds', 'buy-listing')).toMatch(/not enough available money/i);
    expect(marketErrorText('inventory-full', 'buy-listing')).toMatch(/inventory is full/i);
    expect(marketErrorText('processing', 'buy-listing')).toMatch(/processing.*retry/i);
    expect(marketErrorText('unavailable', 'buy-listing')).toMatch(/retry the same request/i);
    expect(marketErrorText('rate-limited', 'buy-listing')).toMatch(/retry/i);
    expect(marketErrorText('invalid', 'create-listing')).toMatch(/cannot be listed/i);
    expect(marketErrorText('invalid', 'buy-listing')).toMatch(/cannot buy/i);
    for (const code of ['unauthenticated', 'conflict'] as const) expect(marketErrorText(code, 'buy-listing')).not.toMatch(/rejected/i);
  });

  it('says a listing was not created because the item is gone, not that a listing closed (final review M-a)', () => {
    // `create_listing` answers `not-found` when the actor no longer owns the item (12-market.sql).
    const said = marketErrorText('not-found', 'create-listing');
    expect(said).toMatch(/^That item is no longer in your inventory\./);
    expect(said).not.toMatch(/listing is no longer open/i);
  });
});

describe('the Marketplace panel', () => {
  const clock = createDisplayClock();
  clock.freeze(NOW);
  const reads = { market: async () => ({ rows: [], nextCursor: null }) };
  const panel = (props: Partial<Parameters<typeof MarketPanel>[0]>) => text(renderToStaticMarkup(createElement(MarketPanel, {
    reads, gateway: null, owner: null, viewer: 'visitor', clock, refreshOwner: async () => {}, fixture: false, ...props,
  })));

  it('lets a visitor browse only, with a sign-in prompt and no trading tabs or wallet', () => {
    const html = renderToStaticMarkup(createElement(MarketPanel, { reads, gateway: null, owner: null, viewer: 'visitor', clock, refreshOwner: async () => {}, fixture: false }));
    expect(text(html)).toContain('Sign in with Google to trade');
    expect(text(html)).toContain('Browsing only.');
    expect(html).not.toContain('role="tablist"');
    expect(text(html)).not.toMatch(/My listings|Sell|money:/);
  });

  it('shows a signed-in account without a gladiator Browse only, with "Create your gladiator to trade"', () => {
    const html = panel({ viewer: 'no-gladiator' });
    expect(html).toContain('Create your gladiator to trade');
    expect(html).not.toMatch(/Sign in with Google to trade|My listings|Sell/);
  });

  it('gives a player the Browse, My listings and Sell tabs and their available money', () => {
    const owner = structuredClone(ownerFixture);
    const html = renderToStaticMarkup(createElement(MarketPanel, { reads, gateway: null, owner, viewer: 'player', clock, refreshOwner: async () => {}, fixture: false }));
    expect(html).toContain('role="tablist"');
    expect([...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(m => m[1])).toEqual(['Browse', 'My listings', 'Sell']);
    expect(text(html)).toContain('Available money: 100');
    expect(text(html)).not.toMatch(/Sign in with Google to trade|Create your gladiator to trade/);
  });

  describe('offer rows', () => {
    const model: OffersModel = { rows: [...MARKET_ROWS], nextCursor: null, status: 'ready' };
    const offers = (props: Partial<Parameters<typeof MarketOffers>[0]> = {}) => renderToStaticMarkup(createElement(MarketOffers, {
      model, action: null, ownerId: null, now: NOW, busy: false, onAction: noop, onMore: noop, onRetry: noop, ...props,
    }));
    const spear = MARKET_ROWS.find(r => r.item.catalogId === 'spear:10:rare')!;
    const helmet = MARKET_ROWS.find(r => r.seller.name === 'Aster')!;
    const bow = MARKET_ROWS.find(r => r.item.catalogId === 'bow:10:common')!;

    it('shows each offer’s item, tier, rarity, stats, seller, price, NPC sale value and time left', () => {
      const html = text(offers());
      expect(html).toContain('Spear');
      expect(html).toContain('Level 10 · Rare');
      expect(html).toContain(`Damage ${spear.item.stats.damage} · Weight ${spear.item.stats.weight}`);
      expect(text(offers({ model: { ...model, rows: [helmet] } }))).toContain(`Armor ${helmet.item.stats.armor} · Weight ${helmet.item.stats.weight}`);
      expect(html).toContain('Varro');
      expect(html).toContain('450 money');
      expect(html).toContain(`NPC sale value: ${CATALOG_V1.items['spear:10:rare'].npcSellValue} money`);
      expect(html).toContain('6 d 23 h left');
      // The bow was listed 2 hours before its seven days end.
      expect(text(renderToStaticMarkup(createElement(MarketOffers, { model: { ...model, rows: [bow] }, action: null, ownerId: null, now: NOW, busy: false,
        onAction: noop, onMore: noop, onRetry: noop })))).toContain('2 h left');
      expect(html).not.toContain('>Buy<');
    });

    it('offers Buy on others’ offers only, and marks the viewer’s own', () => {
      const html = offers({ action: 'buy', ownerId: helmet.seller.gladiatorId });
      expect((html.match(/>Buy</g) ?? []).length).toBe(MARKET_ROWS.length - 1);
      expect(text(html)).toContain('Your listing');
      expect(html).toContain(`aria-label="Buy Spear for 450 money"`);
    });

    it('describes a disabled Buy by its reason (Task 23.5, C18)', () => {
      const html = offers({ model: { ...model, rows: [spear] }, action: 'buy', ownerId: helmet.seller.gladiatorId, available: 100 });
      const reason = /<p id="([^"]+)"[^>]*>Not enough available money<\/p>/.exec(html);
      expect(reason).not.toBeNull();
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-describedby="${reason![1]}"[^>]*>Buy</button>`));
      // An enabled Buy is described by nothing.
      expect(offers({ model: { ...model, rows: [spear] }, action: 'buy', ownerId: helmet.seller.gladiatorId, available: 1000 })).not.toContain('aria-describedby');
    });

    it('offers Cancel on the seller’s own listings, with what the sale would pay', () => {
      const html = offers({ model: { ...model, rows: [helmet] }, action: 'cancel', ownerId: helmet.seller.gladiatorId });
      expect(html).toContain(`aria-label="Cancel listing: Iron helmet for 95 money"`);
      expect(text(html)).toContain(`You receive ${95 - 4} money after the 5% fee`);
    });

    it('says an offer that ran out while the page was open has expired, without Buy', () => {
      const html = offers({ model: { ...model, rows: [bow] }, action: 'buy', now: bow.expiresAtMs });
      expect(text(html)).toContain('Expired');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Buy</);
    });

    it('describes a salvage stack listed through the command endpoint by its quantity and NPC value (final review M-d)', () => {
      // The database accepts a salvage stack (only the Sell tab offers equipment alone), so Browse can show one.
      const units = 12, unitValue = RULES_V1.inventory.salvageSellValue;
      const stack: MarketListing = { listingId: 'salvage-offer', seller: { gladiatorId: 'cassia-id', name: 'Cassia' },
        item: { catalogId: CATALOG_V1.salvage.id, catalogVersion: CATALOG_V1.version, tier: 1, rarity: 'common', stats: structuredClone(CATALOG_V1.salvage.stats), quantity: units },
        price: 150, listedAtMs: NOW - HOUR, expiresAtMs: NOW + DAY };
      const html = offers({ model: { ...model, rows: [stack] }, action: 'buy', ownerId: null });
      expect(text(html)).toContain(`${units} × Salvage`);
      expect(html).toContain(`aria-label="Buy ${units} × Salvage for 150 money"`);
      expect(text(html)).toContain(`NPC sale value: ${units * unitValue} money (${unitValue} each)`);
      expect(text(html)).not.toContain('NPC merchants do not buy');
      // A neutral glyph, not a weapon's.
      expect(html).not.toContain('🗡');
      expect(html).toContain('aria-hidden="true">📦</span>');
      // Equipment keeps its slot glyph and shows no quantity of one.
      const spearRow = offers({ model: { ...model, rows: [spear] } });
      expect(spearRow).toContain('aria-hidden="true">🗡</span>');
      expect(text(spearRow)).not.toContain('×');
      expect(text(spearRow)).toContain(`NPC sale value: ${CATALOG_V1.items['spear:10:rare'].npcSellValue} money`);
      expect(text(spearRow)).not.toContain(' each)');
    });

    it('says when there are no offers, and when they could not be loaded', () => {
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'ready' } }))).toContain('No open listings right now.');
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'failed' } }))).toContain('Listings could not be loaded right now.');
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'loading' } }))).toContain('Loading listings…');
      expect(offers({ model: { ...model, nextCursor: 'x' } })).toContain('>More<');
    });
  });
});
