import { useSyncExternalStore } from 'react';

// The menu's two device preferences (Patch 1.9): whether it stays pinned open, and which edge it sits on. Kept on this
// device only (never on the account), read and written inside try/catch, with the page's own memory as the fallback; a
// missing or invalid value means the menu on the left, unpinned. A change reaches every reader at once.

export type MenuPlace = 'left' | 'right' | 'bottom';
export type MenuPrefs = { pinned: boolean; place: MenuPlace };
export const MENU_PLACES: readonly MenuPlace[] = ['left', 'right', 'bottom'];
export const DEFAULT_MENU_PREFS: MenuPrefs = { pinned: false, place: 'left' };
/** The device key (a per-device convenience). */
export const MENU_PREFS_KEY = 'cloudiator.menu.v1';

/** Each field is checked on its own: a bad one falls back to its default, the other is kept. */
export function parseMenuPrefs(raw: string | null): MenuPrefs {
  if (!raw) return DEFAULT_MENU_PREFS;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return DEFAULT_MENU_PREFS; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_MENU_PREFS;
  const { pinned, place } = value as Record<string, unknown>;
  return {
    pinned: pinned === true,
    place: MENU_PLACES.includes(place as MenuPlace) ? (place as MenuPlace) : DEFAULT_MENU_PREFS.place,
  };
}

/** The choice made on this page: the answer where the device's storage cannot hold it. */
let remembered: MenuPrefs | null = null;
let cache: { raw: string | null; prefs: MenuPrefs } = { raw: null, prefs: DEFAULT_MENU_PREFS };
const listeners = new Set<() => void>();

export function readMenuPrefs(): MenuPrefs {
  if (remembered) return remembered;
  let raw: string | null = null;
  try { raw = localStorage.getItem(MENU_PREFS_KEY); } catch { /* Private mode or blocked site data: the defaults answer. */ }
  if (raw !== cache.raw) cache = { raw, prefs: parseMenuPrefs(raw) };
  return cache.prefs;
}

export function writeMenuPrefs(prefs: MenuPrefs): void {
  remembered = null;
  try { localStorage.setItem(MENU_PREFS_KEY, JSON.stringify(prefs)); } catch { remembered = prefs; }
  listeners.forEach(listener => listener());
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => { listeners.delete(onChange); window.removeEventListener('storage', onChange); };
};

/** The saved preferences (the defaults on the server and in the first client render), and a setter that saves. */
export function useMenuPrefs(): [MenuPrefs, (change: Partial<MenuPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, readMenuPrefs, () => DEFAULT_MENU_PREFS);
  return [prefs, change => writeMenuPrefs({ ...readMenuPrefs(), ...change })];
}
