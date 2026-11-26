import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROMO_SOURCES, promoSourceForPath, rememberPromoSource, type PromoSource } from '@/features/promo/source';

const TAB_KEY = 'cloudiator.promo.source.v1';
const PIONEER_KEY = 'cloudiator.signup-source.v1';
const CAPTURED = 1_800_000_000_000;
const LIFETIME = 30 * 24 * 60 * 60 * 1000;
const APPROVED = [
  'yt-profile', 'yt-trailer', 'ig-bio', 'tiktok-bio', 'reddit-webgames-01',
  'reddit-playmygame', 'itch-page', 'indiedb-page', 'reddit-ad-01',
];

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

function expectSources(storage: { session: ReturnType<typeof memoryStorage>; local: ReturnType<typeof memoryStorage> }, code: string, capturedAtMs: number) {
  expect(JSON.parse(storage.session.getItem(TAB_KEY)!)).toEqual({ v: 1, code, capturedAtMs });
  expect(JSON.parse(storage.local.getItem(PIONEER_KEY)!)).toEqual({ code, capturedAtMs });
}

describe('campaign paths', () => {
  it('ships one concrete route per campaign code without a dynamic route matching unknown codes', () => {
    const routes = readdirSync('src/app/game/p', { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(`src/app/game/p/${entry.name}/page.tsx`))
      .map(entry => entry.name);
    expect(routes.sort()).toEqual([...PROMO_SOURCES].sort());
  });

  it('issues exactly the nine approved codes and resolves their canonical paths', () => {
    expect([...PROMO_SOURCES].sort()).toEqual([...APPROVED].sort());
    for (const code of APPROVED) expect(promoSourceForPath(`/game/p/${code}/`)).toBe(code);
  });

  it.each([
    '/', '/game/', '/game/?ref=yt-profile', '/game/p/not-issued/', '/game/p/yt-profile',
    '/game/p/YT-profile/', '/game/p/%79t-profile/', '/game/p/yt-profile%2F/', '/game/p/yt-profile/extra/',
    '/game/p//yt-profile/', '/game/p/yt-profile//', '/game/p/yt-profile/?ref=ig-bio',
    `/game/p/${'y'.repeat(25)}/`,
  ])('rejects %s as a campaign path', (path) => {
    expect(promoSourceForPath(path)).toBeNull();
  });
});

describe('first-touch campaign attribution', () => {
  it('preserves the first source and capture time on repeated visits and in a fresh tab', () => {
    const original = { session: memoryStorage(), local: memoryStorage() };
    rememberPromoSource('yt-profile', CAPTURED, original);
    expectSources(original, 'yt-profile', CAPTURED);
    rememberPromoSource('ig-bio', CAPTURED + 1, original);
    expectSources(original, 'yt-profile', CAPTURED);

    const freshTab = { session: memoryStorage(), local: original.local };
    rememberPromoSource('yt-trailer', CAPTURED + 2, freshTab);
    expectSources(freshTab, 'yt-profile', CAPTURED);
  });

  it.each([
    { tabTime: CAPTURED, localTime: CAPTURED + 1, first: 'yt-profile' },
    { tabTime: CAPTURED + 1, localTime: CAPTURED, first: 'yt-trailer' },
  ])('mirrors the older existing source ($first) into both stores', ({ tabTime, localTime, first }) => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    storage.session.setItem(TAB_KEY, JSON.stringify({ v: 1, code: 'yt-profile', capturedAtMs: tabTime }));
    storage.local.setItem(PIONEER_KEY, JSON.stringify({ code: 'yt-trailer', capturedAtMs: localTime }));

    rememberPromoSource('ig-bio', CAPTURED + 2, storage);
    expectSources(storage, first, CAPTURED);
  });

  it('accepts a new source at the 30-day boundary without refreshing the first timestamp', () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    rememberPromoSource('yt-profile', CAPTURED, storage);
    rememberPromoSource('yt-trailer', CAPTURED + LIFETIME - 1, storage);
    expectSources(storage, 'yt-profile', CAPTURED);

    rememberPromoSource('yt-trailer', CAPTURED + LIFETIME, storage);
    expectSources(storage, 'yt-trailer', CAPTURED + LIFETIME);
  });

  it.each([
    ['broken JSON', '{'],
    ['missing timestamp', JSON.stringify({ code: 'yt-profile' })],
    ['string timestamp', JSON.stringify({ code: 'yt-profile', capturedAtMs: String(CAPTURED) })],
    ['fractional timestamp', JSON.stringify({ code: 'yt-profile', capturedAtMs: CAPTURED - 0.5 })],
    ['future timestamp', JSON.stringify({ code: 'yt-profile', capturedAtMs: CAPTURED + 1 })],
    ['unregistered code', JSON.stringify({ code: 'not-issued', capturedAtMs: CAPTURED - 1 })],
  ])('replaces a local record with %s', (_case, raw) => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    storage.local.setItem(PIONEER_KEY, raw);
    rememberPromoSource('yt-trailer', CAPTURED, storage);
    expectSources(storage, 'yt-trailer', CAPTURED);
  });

  it('replaces an unsupported tab record version with the valid Pioneer record', () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    storage.session.setItem(TAB_KEY, JSON.stringify({ v: 2, code: 'yt-profile', capturedAtMs: CAPTURED - 2 }));
    storage.local.setItem(PIONEER_KEY, JSON.stringify({ code: 'ig-bio', capturedAtMs: CAPTURED - 1 }));

    rememberPromoSource('yt-trailer', CAPTURED, storage);
    expectSources(storage, 'ig-bio', CAPTURED - 1);
  });

  it.each(['session', 'local'] as const)('stores attribution when access to %s storage is denied', (denied) => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    const blocked = () => { throw new Error('Access denied'); };
    const limited = { ...storage, [denied]: { getItem: blocked, setItem: blocked } };

    rememberPromoSource('yt-profile', CAPTURED, limited);
    rememberPromoSource('yt-trailer', CAPTURED + 1, limited);

    if (denied === 'session') {
      expect(JSON.parse(storage.local.getItem(PIONEER_KEY)!)).toEqual({ code: 'yt-profile', capturedAtMs: CAPTURED });
    } else {
      expect(JSON.parse(storage.session.getItem(TAB_KEY)!)).toEqual({ v: 1, code: 'yt-profile', capturedAtMs: CAPTURED });
    }
  });

  it('ignores an unissued caller value before touching storage', () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    rememberPromoSource('not-issued' as PromoSource, CAPTURED, storage);
    expect(storage.session.getItem(TAB_KEY)).toBeNull();
    expect(storage.local.getItem(PIONEER_KEY)).toBeNull();
  });
});
