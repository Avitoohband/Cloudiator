/** Issued campaign paths. Keep these codes stable and share the registry with 2.0 before it accepts attribution. */
export const PROMO_SOURCES = [
  'yt-profile', 'yt-trailer', 'ig-bio', 'tiktok-bio', 'reddit-webgames-01',
  'reddit-playmygame', 'itch-page', 'indiedb-page', 'reddit-ad-01',
] as const;

export type PromoSource = (typeof PROMO_SOURCES)[number];

const TAB_KEY = 'cloudiator.promo.source.v1';
const PIONEER_KEY = 'cloudiator.signup-source.v1';
const SOURCE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

type SourceRecord = { code: PromoSource; capturedAtMs: number };
type SourceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type SourceStores = { session?: SourceStorage | null; local?: SourceStorage | null };
type SourceKey = typeof TAB_KEY | typeof PIONEER_KEY;

export function promoSourceForPath(pathname: string): PromoSource | null {
  return PROMO_SOURCES.find(code => pathname === `/game/p/${code}/`) ?? null;
}

function isPromoSource(code: unknown): code is PromoSource {
  return PROMO_SOURCES.some(source => source === code);
}

function browserStorage(name: 'sessionStorage' | 'localStorage'): SourceStorage | null {
  if (typeof window === 'undefined') return null;
  try { return window[name]; } catch { return null; }
}

function readSource(storage: SourceStorage | null | undefined, key: SourceKey, nowMs: number): SourceRecord | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as { v?: unknown; code?: unknown; capturedAtMs?: unknown } | null;
    if (!record || (key === TAB_KEY && record.v !== 1)) return null;
    const { code, capturedAtMs } = record;
    if (!isPromoSource(code) || typeof capturedAtMs !== 'number' || !Number.isSafeInteger(capturedAtMs)) return null;
    if (capturedAtMs < 0 || capturedAtMs > nowMs || nowMs - capturedAtMs >= SOURCE_LIFETIME_MS) return null;
    return { code, capturedAtMs };
  } catch { return null; }
}

function mirrorSource(storage: SourceStorage | null | undefined, key: SourceKey, current: SourceRecord | null, first: SourceRecord): void {
  if (!storage || (current?.code === first.code && current.capturedAtMs === first.capturedAtMs)) return;
  const record = key === TAB_KEY ? { v: 1, ...first } : first;
  try { storage.setItem(key, JSON.stringify(record)); } catch { /* Attribution is optional when storage is denied. */ }
}

/** Preserve the first valid campaign touch across reloads and the same-origin Google round trip. */
export function rememberPromoSource(code: PromoSource, nowMs = Date.now(), storage?: SourceStores): void {
  if (!isPromoSource(code) || !Number.isSafeInteger(nowMs) || nowMs < 0) return;
  const { session, local } = storage ?? { session: browserStorage('sessionStorage'), local: browserStorage('localStorage') };
  const inTab = readSource(session, TAB_KEY, nowMs);
  const inPioneer = readSource(local, PIONEER_KEY, nowMs);
  // Prefer the shared record on a timestamp tie so tabs converge.
  const first = inPioneer && (!inTab || inPioneer.capturedAtMs <= inTab.capturedAtMs)
    ? inPioneer
    : inTab ?? { code, capturedAtMs: nowMs };
  mirrorSource(local, PIONEER_KEY, inPioneer, first);
  mirrorSource(session, TAB_KEY, inTab, first);
}
