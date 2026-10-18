import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { createDisplayClock } from '@/game/display-clock';
import { listableItems, marketErrorText, marketFee, sellerReceives, timeLeft } from '@/features/market/market-text';
import { MarketOffers, MarketPanel, type OffersModel } from '@/features/market/MarketPanel';
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

    it('says when there are no offers, and when they could not be loaded', () => {
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'ready' } }))).toContain('No open listings right now.');
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'failed' } }))).toContain('Listings could not be loaded right now.');
      expect(text(offers({ model: { rows: [], nextCursor: null, status: 'loading' } }))).toContain('Loading listings…');
      expect(offers({ model: { ...model, nextCursor: 'x' } })).toContain('>More<');
    });
  });
});
