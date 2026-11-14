import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ItemInstance, MarketListing, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import { createDisplayClock } from '@/game/display-clock';
import {
  LOWEST_PRICE_TEXT, MARKET_FEE_PERCENT, MARKET_FEE_TERMS, MARKET_SORTS, MINIMUM_PRICE, PRICE_HINT, SELL_SORTS, listableItems, listedAgo, marketCountLine, marketErrorText,
  marketFee, npcValue, npcValueText, priceProblem, sellerLine, sellerReceives, timeLeft, validPrice, WHOLE_PRICE_TEXT,
} from '@/features/market/market-text';
import { MarketOffers, MarketPanel, ownerReads, type OffersModel } from '@/features/market/MarketPanel';
import { itemStatLines } from '@/features/inventory/item-presentation';
import { itemFixture, ownerFixture, worldFixture } from '../fixtures/domain';
import { MARKET_ROWS } from '../fixtures/market';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = worldFixture.serverNowMs;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const item = (catalogId: string, id: string, extra: Partial<ItemInstance> = {}): ItemInstance => ({ ...itemFixture(CATALOG_V1.items[catalogId]), id, ...extra });

describe('market fees (plan Decision 2; launch feedback: at least 1)', () => {
  it('keeps 5% of the price, rounded down but at least 1, and pays the seller the rest', () => {
    // Avi sold an item for 11 and paid no fee (5% floored to 0): now every sale pays at least 1, up to 39 (40 is the first 2).
    expect([2, 11, 19, 20, 39, 40, 101].map(marketFee)).toEqual([1, 1, 1, 1, 1, 2, 5]);
    expect(marketFee(2)).toBe(1);
    expect(marketFee(19)).toBe(1);
    expect(marketFee(40)).toBe(2);
    expect(sellerReceives(2)).toBe(1);
    expect(sellerReceives(11)).toBe(10);
    expect(sellerReceives(101)).toBe(96);
    expect(marketFee(999_999_999)).toBe(49_999_999);
    expect(marketFee(1_000_000_000)).toBe(50_000_000);
    expect(sellerReceives(1_000_000_000)).toBe(950_000_000);
  });

  it('accepts whole prices from 2 to 1,000,000,000 only, so the seller always receives something', () => {
    expect([1, 2].map(validPrice)).toEqual([false, true]);
    expect([2, 3, 11, 1_000_000_000].map(validPrice)).toEqual([true, true, true, true]);
    for (const price of [0, 1, -3, 1.5, 1_000_000_001, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(validPrice(price), String(price)).toBe(false);
    // Every price the market accepts leaves the seller a positive credit.
    for (const price of [2, 3, 19, 20, 21, 39, 40, 1_000_000_000]) expect(sellerReceives(price), String(price)).toBeGreaterThan(0);
  });

  it('takes the rate, the minimum fee and the lowest price from the rules, with exact integer floor math (final review M-b)', async () => {
    // The rules' rate is a whole percent, so `floor(price × percent / 100)` matches the database's bigint `price*5/100`.
    expect(MARKET_FEE_PERCENT / 100).toBe(RULES_V1.fees.marketRate);
    expect(RULES_V1.fees.marketMinimum).toBe(1);
    expect(RULES_V1.marketplace.minimumPrice).toBe(2);
    expect(MINIMUM_PRICE).toBe(RULES_V1.marketplace.minimumPrice);
    const prices = [2, 19, 20, 40, 101, 1_000_000_000];
    expect(prices.map(marketFee)).toEqual([1, 1, 1, 2, 5, 50_000_000]);
    // Other values in the rules change the panel's fee and lowest price with them: nothing is hard-coded.
    vi.resetModules();
    vi.doMock('@domain/rules-v1', async importOriginal => {
      const actual = await importOriginal<typeof import('@domain/rules-v1')>();
      return { RULES_V1: { ...actual.RULES_V1, fees: { ...actual.RULES_V1.fees, marketRate: 0.1, marketMinimum: 3 },
        marketplace: { ...actual.RULES_V1.marketplace, minimumPrice: 7 } } };
    });
    try {
      const ruled = await import('@/features/market/market-text');
      expect(ruled.MARKET_FEE_PERCENT).toBe(10);
      expect(ruled.MINIMUM_PRICE).toBe(7);
      expect(prices.map(ruled.marketFee)).toEqual([3, 3, 3, 4, 10, 100_000_000]);
      expect([6, 7].map(ruled.validPrice)).toEqual([false, true]);
      expect(ruled.MARKET_FEE_TERMS).toBe('10%, at least 3');
      expect(ruled.LOWEST_PRICE_TEXT).toContain('lowest price is 7 gold');
      expect(ruled.WHOLE_PRICE_TEXT).toBe('Enter a whole price from 7 to 1,000,000,000.');
      expect(ruled.marketErrorText('invalid', 'create-listing')).toBe('This item cannot be listed at that price. Only free, tradable equipment can be listed, at a whole price of at least 7 gold, with at most 5 active listings.');
    } finally {
      vi.doUnmock('@domain/rules-v1');
      vi.resetModules();
    }
  });
});

describe('what the Sell form says about a typed price', () => {
  it('says the fee in the words of its label: "5%, at least 1"', () => {
    expect(MARKET_FEE_TERMS).toBe('5%, at least 1');
  });

  it('hints the whole prices from 2, and says the lowest price when a whole price is under it', () => {
    expect(PRICE_HINT).toBe('A whole price from 2 to 1,000,000,000.');
    expect(LOWEST_PRICE_TEXT).toBe('The lowest price is 2 gold, so you always receive something after the fee.');
    for (const typed of ['0', '1', '-3']) expect(priceProblem(typed), typed).toBe('low');
  });

  it('asks for a whole price when the typed one is fractional, too large or not a number, and for nothing while empty or valid', () => {
    for (const typed of ['abc', '0.5', '1.5', '1000000001', '2.5', '1e30']) expect(priceProblem(typed), typed).toBe('whole');
    for (const typed of ['', '  ', '2', '11', '1000000000']) expect(priceProblem(typed), typed).toBeNull();
  });

  it('asks for a whole price within the accepted range', () => {
    expect(WHOLE_PRICE_TEXT).toBe('Enter a whole price from 2 to 1,000,000,000.');
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
  it('explains the equipment, whole-price minimum and listing limit for an invalid listing', () => {
    expect(marketErrorText('invalid', 'create-listing')).toBe('This item cannot be listed at that price. Only free, tradable equipment can be listed, at a whole price of at least 2 gold, with at most 5 active listings.');
  });

  it('explains every code, and that a stale page was refreshed', () => {
    expect(marketErrorText('sold', 'buy-listing')).toMatch(/already (been )?sold.*refreshed/i);
    expect(marketErrorText('expired', 'buy-listing')).toMatch(/expired.*refreshed/i);
    expect(marketErrorText('not-found', 'buy-listing')).toMatch(/no longer open.*refreshed/i);
    expect(marketErrorText('not-found', 'cancel-listing')).toMatch(/no longer open.*refreshed/i);
    expect(marketErrorText('insufficient-funds', 'buy-listing')).toMatch(/not enough available gold/i);
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

describe('words of a listing row (Task 26)', () => {
  it('says how long ago a listing was made, in the units of the time left', () => {
    expect(listedAgo(NOW - 4 * MINUTE, NOW)).toBe('4 min ago');
    expect(listedAgo(NOW - 2 * HOUR, NOW)).toBe('2 h ago');
    expect(listedAgo(NOW - 2 * HOUR - 5 * MINUTE - 59_999, NOW)).toBe('2 h 5 min ago');
    expect(listedAgo(NOW - 6 * DAY - 22 * HOUR, NOW)).toBe('6 d 22 h ago');
    expect(listedAgo(NOW - 2 * DAY, NOW)).toBe('2 d ago');
    expect(listedAgo(NOW - 30_000, NOW)).toBe('just now');
    // A listing the display clock has not reached yet (a clock a little behind the server's) is just made.
    expect(listedAgo(NOW + MINUTE, NOW)).toBe('just now');
  });

  it('names the seller’s class, league and level when the listing carries them, and only those it carries', () => {
    const spear = MARKET_ROWS.find(r => r.item.catalogId === 'spear:10:rare')!;
    expect(sellerLine(spear)).toBeNull();
    expect(sellerLine({ ...spear, sellerClassId: 'duelist', sellerLeague: 'silver', sellerLevel: 14 })).toBe('Duelist · Silver league · Level 14');
    expect(sellerLine({ ...spear, sellerClassId: null, sellerLeague: null, sellerLevel: null })).toBeNull();
    expect(sellerLine({ ...spear, sellerLevel: 14 })).toBe('Level 14');
    expect(sellerLine({ ...spear, sellerLeague: 'champion' })).toBe('Champion league');
    expect(sellerLine({ ...spear, sellerClassId: 'berserker', sellerLevel: 3 })).toBe('Berserker · Level 3');
  });

  it('sorts Browse by Newest, Price low-high, Price high-low and Level, and Sell as the Inventory does without Sell value', () => {
    expect(MARKET_SORTS).toEqual([['newest', 'Newest'], ['price', 'Price low-high'], ['priceDesc', 'Price high-low'], ['level', 'Level']]);
    expect(SELL_SORTS.map(([, label]) => label)).toEqual(['Newest', 'Level', 'Name', 'Damage', 'Armor', 'Weight']);
  });

  it('counts the listings shown in the sort’s words', () => {
    expect(marketCountLine(7, 'newest')).toBe('7 open listings · newest first');
    expect(marketCountLine(1, 'price')).toBe('1 open listing · cheapest first');
    expect(marketCountLine(3, 'priceDesc')).toBe('3 open listings · dearest first');
    expect(marketCountLine(2, 'level')).toBe('2 open listings · lowest level first');
  });
});

describe('the Marketplace panel', () => {
  const clock = createDisplayClock();
  clock.freeze(NOW);
  const reads = { market: async () => ({ rows: [], nextCursor: null }) };
  const panel = (props: Partial<Parameters<typeof MarketPanel>[0]>) => text(renderToStaticMarkup(createElement(MarketPanel, {
    reads, gateway: null, owner: null, viewer: 'visitor', clock, refreshOwner: async () => {}, fixture: false, ...props,
  })));

  it('lets a visitor browse only, with a sign-in prompt and no trading tabs, chip or wallet', () => {
    const html = renderToStaticMarkup(createElement(MarketPanel, { reads, gateway: null, owner: null, viewer: 'visitor', clock, refreshOwner: async () => {}, fixture: false }));
    expect(text(html)).toContain('Sign in with Google to trade');
    expect(text(html)).toContain('Browsing only.');
    expect(html).not.toContain('role="tablist"');
    expect(text(html)).not.toMatch(/My listings|Sell|gold:/);
    // Search, Sort and the item chips are for everyone.
    expect(html).toContain('aria-label="Search the Marketplace"');
    expect(text(html)).toMatch(/All Weapons Armor/);
  });

  it('shows a signed-in account without a gladiator Browse only, with "Create your gladiator to trade"', () => {
    const html = panel({ viewer: 'no-gladiator' });
    expect(html).toContain('Create your gladiator to trade');
    expect(html).not.toMatch(/Sign in with Google to trade|My listings|Sell/);
  });

  it('gives a player the Browse and Sell tabs, the My listings chip with their count, Sort and their available gold (Task 26)', () => {
    const owner = structuredClone(ownerFixture);
    owner.inventory = [item('iron-helmet:5:uncommon', 'listed-helmet', { reservation: { kind: 'listing', referenceId: 'listing-1' } }), item('axe:5:common', 'free-axe')];
    const html = renderToStaticMarkup(createElement(MarketPanel, { reads, gateway: null, owner, viewer: 'player', clock, refreshOwner: async () => {}, fixture: false }));
    expect(html).toContain('role="tablist"');
    expect([...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(m => m[1])).toEqual(['Browse', 'Sell']);
    expect(html).toContain('aria-label="Marketplace filters"');
    // The chip's count is drawn as a badge and read as "My listings (1)".
    expect(text(html)).toContain('All Weapons Armor My listings 1 (1)');
    expect([...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]])).toEqual(MARKET_SORTS);
    expect(text(html)).toContain('Available gold: 100');
    expect(text(html)).toContain('Inventory 2 / 60 slots');
    expect(text(html)).not.toMatch(/Sign in with Google to trade|Create your gladiator to trade/);
  });

  describe('listing rows (Task 26: a list with big icons, every detail on the row, the seller in front)', () => {
    const model: OffersModel = { rows: [...MARKET_ROWS], nextCursor: null, status: 'ready' };
    const offers = (props: Partial<Parameters<typeof MarketOffers>[0]> = {}) => renderToStaticMarkup(createElement(MarketOffers, {
      model, access: 'browse', ownerId: null, now: NOW, busy: false, onBuy: noop, onCancel: noop, onMore: noop, onRetry: noop, onRefresh: noop, ...props,
    }));
    const spear = MARKET_ROWS.find(r => r.item.catalogId === 'spear:10:rare')!;
    const helmet = MARKET_ROWS.find(r => r.seller.name === 'Aster')!;
    const bow = MARKET_ROWS.find(r => r.item.catalogId === 'bow:10:common')!;
    /** The view of every page of `rows` (three cards a page, Patch 1.9 Task 32): each chunk of three rendered on its own, joined. */
    const everyPage = (props: Partial<Parameters<typeof MarketOffers>[0]> = {}, rows: readonly MarketListing[] = MARKET_ROWS) =>
      Array.from({ length: Math.ceil(rows.length / 3) }, (_, n) => offers({ ...props, model: { ...model, rows: rows.slice(n * 3, n * 3 + 3) } })).join('');
    const order = (html: string) => [...html.matchAll(/data-testid="listing-([^"]+)"/g)].map(m => m[1]);
    const idsOf = (rows: readonly MarketListing[]) => rows.map(r => r.listingId);

    it('shows each listing’s big icon with its level, the name and rarity, the level line, the stats, when it was listed, the time left, the NPC value and the price', () => {
      const html = offers({ model: { ...model, rows: [spear] } });
      const said = text(html);
      expect(html).toContain('data-item-icon="spear"');
      expect(said).toContain('L10');
      expect(said).toMatch(/Spear Rare/);
      expect(said).toContain('Level 10 · rare · Tradable');
      // The stat chips are the Inventory card's lines (without "Attribute bonuses: None").
      for (const [label, value] of itemStatLines(spear.item).filter(([label]) => label !== 'Attribute bonuses')) expect(said).toContain(`${label} ${value}`);
      expect(said).not.toContain('Attribute bonuses');
      expect(said).toContain(`Listed 4 min ago · 6 d 23 h left · NPC sale value: ${CATALOG_V1.items['spear:10:rare'].npcSellValue} gold`);
      expect(said).toContain('450 gold');
      // The row is a list item named by its item, seller and price.
      expect(html).toContain(`aria-label="Spear, level 10, rare, sold by Varro, 450 gold"`);
      // The bow was listed 2 hours before its seven days end.
      expect(text(offers({ model: { ...model, rows: [bow] } }))).toContain('2 h left');
      expect(html).not.toMatch(/aria-label="Buy /);
    });

    it('puts the seller in front: an initial, "Sold by", the name and View profile; class, league and level only when the listing carries them', () => {
      const plain = offers({ model: { ...model, rows: [spear] }, onProfile: noop });
      expect(text(plain)).toContain('V Sold by Varro View profile');
      expect(plain).toContain('aria-label="View profile of Varro"');
      expect(text(plain)).not.toMatch(/league|Level 3\b/);
      expect(plain).not.toContain('data-class=');
      const full = offers({ model: { ...model, rows: [{ ...spear, sellerClassId: 'duelist', sellerLeague: 'silver', sellerLevel: 14 }] }, onProfile: noop });
      expect(text(full)).toContain('Sold by Varro Duelist · Silver league · Level 14 View profile');
      expect(full).toContain('data-class="duelist"');
      expect(full).toMatch(/data-league="silver"[^>]*>S</);
      const levelOnly = offers({ model: { ...model, rows: [{ ...spear, sellerLevel: 14 }] }, onProfile: noop });
      expect(text(levelOnly)).toContain('Sold by Varro Level 14 View profile');
      expect(levelOnly).not.toContain('data-league=');
      // No profile handler (a view with no profile card), no button.
      expect(offers({ model: { ...model, rows: [spear] } })).not.toContain('View profile');
    });

    it('offers Buy for the price on others’ listings, and Cancel listing with what the sale pays on the viewer’s own', () => {
      const html = everyPage({ access: 'trade', ownerId: helmet.seller.gladiatorId, available: 10_000 });
      expect((html.match(/aria-label="Buy /g) ?? []).length).toBe(MARKET_ROWS.length - 1);
      expect(html).toContain(`aria-label="Buy Spear for 450 gold"`);
      expect(text(html)).toContain('Buy for 450 gold');
      const own = text(offers({ model: { ...model, rows: [helmet] }, access: 'trade', ownerId: helmet.seller.gladiatorId, available: 10_000 }));
      expect(own).toContain('Your listing');
      expect(own).toContain('Yours');
      expect(own).toContain('Your listing, sold by Aster (you)');
      expect(own).toContain(`You receive ${95 - 4} gold after the market fee (5%, at least 1)`);
      expect(own).not.toMatch(/Buy for/);
      expect(offers({ model: { ...model, rows: [helmet] }, access: 'trade', ownerId: helmet.seller.gladiatorId })).toContain(`aria-label="Cancel listing: Iron helmet for 95 gold"`);
    });

    it('describes a disabled Buy by its reason and marks the price it cannot pay (Task 23.5, C18)', () => {
      const html = offers({ model: { ...model, rows: [spear] }, access: 'trade', ownerId: helmet.seller.gladiatorId, available: 100 });
      const reason = /<p id="([^"]+)"[^>]*>Not enough available gold<\/p>/.exec(html);
      expect(reason).not.toBeNull();
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-describedby="${reason![1]}"`));
      expect(html).toMatch(/<li[^>]*data-poor=""/);
      const full = offers({ model: { ...model, rows: [spear] }, access: 'trade', ownerId: helmet.seller.gladiatorId, available: 1000, full: true });
      expect(text(full)).toContain('Your inventory is full');
      expect(full).not.toMatch(/<li[^>]*data-poor=""/);
      // An enabled Buy is described by nothing.
      expect(offers({ model: { ...model, rows: [spear] }, access: 'trade', ownerId: helmet.seller.gladiatorId, available: 1000 })).not.toContain('aria-describedby');
    });

    it('offers Cancel listing on the seller’s own listings, with what the sale would pay at any price', () => {
      const low = (price: number) => text(offers({ model: { ...model, rows: [{ ...helmet, price }] }, access: 'trade', mine: true, ownerId: helmet.seller.gladiatorId }));
      expect(low(11)).toContain('You receive 10 gold after the market fee (5%, at least 1)');
      expect(low(2)).toContain('You receive 1 gold after the market fee (5%, at least 1)');
    });

    it('greys a listing that ran out while the page was open, says Expired, and offers no Buy', () => {
      const html = offers({ model: { ...model, rows: [bow] }, access: 'trade', now: bow.expiresAtMs });
      expect(text(html)).toMatch(/Expired.*Expired/);
      expect(html).toMatch(/<li[^>]*data-expired=""/);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Buy<\/button>/);
    });

    it('lets a visitor see every row with "Sign in to buy." and no trading control', () => {
      const html = everyPage({ access: 'sign-in', onProfile: noop });
      expect((text(html).match(/Sign in to buy\./g) ?? []).length).toBe(MARKET_ROWS.length);
      expect(html).not.toMatch(/aria-label="(Buy|Cancel listing)/);
      expect((html.match(/>View profile</g) ?? []).length).toBe(MARKET_ROWS.length);
    });

    it('describes a salvage stack listed through the command endpoint by its quantity and NPC value (final review M-d)', () => {
      const units = 12, unitValue = RULES_V1.inventory.salvageSellValue;
      const stack: MarketListing = { listingId: 'salvage-offer', seller: { gladiatorId: 'cassia-id', name: 'Cassia' },
        item: { catalogId: CATALOG_V1.salvage.id, catalogVersion: CATALOG_V1.version, tier: 1, rarity: 'common', stats: structuredClone(CATALOG_V1.salvage.stats), quantity: units },
        price: 150, listedAtMs: NOW - HOUR, expiresAtMs: NOW + DAY };
      const html = offers({ model: { ...model, rows: [stack] }, access: 'trade', ownerId: null, available: 1000 });
      expect(text(html)).toContain(`${units} × Salvage`);
      expect(html).toContain(`aria-label="Buy ${units} × Salvage for 150 gold"`);
      expect(text(html)).toContain(`NPC sale value: ${units * unitValue} gold (${unitValue} gold each)`);
      expect(text(html)).not.toContain('NPC merchants do not buy');
      expect(html).toContain('data-item-icon="salvage"');
      expect(text(html)).toContain(`×${units}`);
      const spearRow = offers({ model: { ...model, rows: [spear] } });
      expect(spearRow).toContain('data-item-icon="spear"');
      expect(text(spearRow)).not.toContain('×');
      expect(text(spearRow)).not.toContain(' each)');
    });

    // Patch 1.6 (spec "Inventory and market"): salvage's NPC value is the active rules' (10 under v1, 4 under v2); gear values stay.
    it('values salvage by the active rules, and gear the same under both', () => {
      const salvage = { catalogId: CATALOG_V1.salvage.id, catalogVersion: CATALOG_V1.version, tier: 1 as const, rarity: 'common' as const, quantity: 12 };
      expect(npcValueText(salvage, RULES_V2)).toBe('NPC sale value: 48 gold (4 gold each)');
      expect(npcValueText(salvage, RULES_V1)).toBe('NPC sale value: 120 gold (10 gold each)');
      expect(npcValueText(salvage)).toBe('NPC sale value: 120 gold (10 gold each)');
      expect(npcValue({ ...salvage, quantity: 1 }, RULES_V2)).toBe(4);
      const gear = { ...spear.item };
      expect(npcValue(gear, RULES_V2)).toBe(CATALOG_V1.items['spear:10:rare'].npcSellValue);
      expect(npcValueText(gear, RULES_V2)).toBe(npcValueText(gear, RULES_V1));
      const stack: MarketListing = { listingId: 'salvage-offer', seller: { gladiatorId: 'cassia-id', name: 'Cassia' },
        item: { ...salvage, stats: structuredClone(CATALOG_V1.salvage.stats) }, price: 150, listedAtMs: NOW - HOUR, expiresAtMs: NOW + DAY };
      expect(text(offers({ model: { ...model, rows: [stack] }, rules: RULES_V2 }))).toContain('NPC sale value: 48 gold (4 gold each)');
      expect(text(offers({ model: { ...model, rows: [stack] } }))).toContain('NPC sale value: 120 gold (10 gold each)');
    });

    it('filters by the Weapons and Armor chips, searches by name and sorts by price and level, and counts in the sort’s words', () => {
      const weapons = MARKET_ROWS.filter(r => CATALOG_V1.items[r.item.catalogId].slot === 'weapon');
      const armor = MARKET_ROWS.filter(r => CATALOG_V1.items[r.item.catalogId]?.slot !== 'weapon');
      expect(weapons.length).toBeGreaterThan(0);
      // Three cards a page: the first page of each chip, in the loaded order.
      expect(order(offers({ filter: 'Weapons' }))).toEqual(idsOf(weapons).slice(0, 3));
      expect(order(offers({ filter: 'Armor' }))).toEqual(idsOf(armor).slice(0, 3));
      expect(order(offers({ query: 'BOW' }))).toEqual([bow.listingId]);
      expect(text(offers({ query: 'bow' }))).toContain('1 listing match “bow”');
      const by = (key: (r: MarketListing) => number, direction = 1) => idsOf([...MARKET_ROWS].sort((a, b) => direction * (key(a) - key(b))));
      expect(order(offers({ sort: 'price' }))).toEqual(by(r => r.price).slice(0, 3));
      expect(order(offers({ sort: 'priceDesc' }))).toEqual(by(r => r.price, -1).slice(0, 3));
      expect(order(offers({ sort: 'level' }))).toEqual(by(r => r.item.tier).slice(0, 3));
      expect(text(offers())).toContain(`Page 1 of ${Math.ceil(MARKET_ROWS.length / 3)}`);
      expect(text(offers())).toContain(`${MARKET_ROWS.length} open listings · newest first`);
      expect(text(offers({ sort: 'priceDesc' }))).toContain(`${MARKET_ROWS.length} open listings · dearest first`);
      // A search the chip hides says so, and offers to clear it.
      const hidden = text(offers({ query: 'bow', filter: 'Armor' }));
      // (The shared NoMatch puts the query in bold: this test's text() spaces the tags.)
      expect(hidden).toMatch(/No match for “\s*bow\s*” in Armor/);
      expect(hidden).toContain('Clear search');
    });

    it('counts the viewer’s own listings against the limit under My listings, with today’s words', () => {
      const html = text(offers({ model: { ...model, rows: [helmet] }, access: 'trade', mine: true, ownerId: helmet.seller.gladiatorId }));
      expect(html).toContain('1 of your 5 listings');
      expect(html).toContain('A listing lasts 7 days. Cancel it, or let it expire, to return the item to your inventory.');
      const empty = offers({ model: { rows: [], nextCursor: null, status: 'ready' }, access: 'trade', mine: true, onSell: noop });
      expect(text(empty)).toContain('You have no open listings.');
      expect(empty).toContain('>List an item<');
    });

    it('says when there are no offers, when they could not be loaded, and that Sort and search apply to the listings loaded so far', () => {
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'ready' } }))).toContain('No open listings right now.');
      // Final review (client minor, fix round 1): an empty Weapons or Armor chip says what it lacks, while All has listings.
      const armorOnly = { rows: MARKET_ROWS.filter(r => CATALOG_V1.items[r.item.catalogId]?.slot !== 'weapon'), nextCursor: null, status: 'ready' as const };
      const weaponsOnly = { rows: MARKET_ROWS.filter(r => CATALOG_V1.items[r.item.catalogId]?.slot === 'weapon'), nextCursor: null, status: 'ready' as const };
      expect(armorOnly.rows.length && weaponsOnly.rows.length).toBeGreaterThan(0);
      expect(text(offers({ model: armorOnly, filter: 'Weapons' }))).toContain('No weapons listed right now.');
      expect(text(offers({ model: weaponsOnly, filter: 'Armor' }))).toContain('No armor listed right now.');
      expect(text(offers({ model: armorOnly, filter: 'Weapons' }))).not.toContain('No open listings right now.');
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'ready' }, filter: 'Weapons' }))).toContain('No open listings right now.');
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'failed' } }))).toContain('Listings could not be loaded right now.');
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'loading' } }))).toContain('Loading listings…');
      // More can be read: no More button; the pager says "Page 1" with "more to see" (Next reads the next 50).
      expect(offers({ model: { ...model, nextCursor: 'x' } })).not.toContain('>More<');
      expect(text(offers({ model: { ...model, nextCursor: 'x' } }))).toContain('more to see');
      expect(text(offers({ model: { ...model, nextCursor: 'x' }, sort: 'price' }))).toContain('Sort and search apply to the listings loaded so far.');
      expect(text(offers({ model: { ...model, nextCursor: 'x' } }))).not.toContain('loaded so far');
      expect(text(offers({ model: { ...model, nextCursor: null }, sort: 'price' }))).not.toContain('loaded so far');
    });
  });
});
