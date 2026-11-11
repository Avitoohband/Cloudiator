import { useSyncExternalStore } from 'react';
import { DEFAULT_LABEL_PREFS, LABEL_MODES, type LabelMode, type LabelPrefs } from '../../game/labels';

// The Settings panel's device preferences (Patch 1.9): the menu's two (whether it stays pinned open, and which edge it sits
// on) and, since Task 11, when the camp shows names and titles. Kept on this device only (never on the account), each under
// its own key, read and written inside try/catch, with the page's own memory as the fallback; a missing or invalid value
// means the default (the menu on the left, unpinned; names and titles When zoomed in). A change reaches every reader at once.

export type MenuPlace = 'left' | 'right' | 'bottom';
export type MenuPrefs = { pinned: boolean; place: MenuPlace };
export const MENU_PLACES: readonly MenuPlace[] = ['left', 'right', 'bottom'];
export const DEFAULT_MENU_PREFS: MenuPrefs = { pinned: false, place: 'left' };
/** The device key (a per-device convenience). */
export const MENU_PREFS_KEY = 'cloudiator.menu.v1';
export { DEFAULT_LABEL_PREFS };
export type { LabelMode, LabelPrefs };
/** The device key of the Names and Titles choices. */
export const LABEL_PREFS_KEY = 'cloudiator.labels.v1';

/** A saved JSON object's fields, or null for anything else. */
function savedObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Each field is checked on its own: a bad one falls back to its default, the other is kept. */
export function parseMenuPrefs(raw: string | null): MenuPrefs {
  const value = savedObject(raw);
  if (!value) return DEFAULT_MENU_PREFS;
  const { pinned, place } = value;
  return {
    pinned: pinned === true,
    place: MENU_PLACES.includes(place as MenuPlace) ? (place as MenuPlace) : DEFAULT_MENU_PREFS.place,
  };
}

/** Each choice is checked on its own: a bad one falls back to When zoomed in, the other is kept. */
export function parseLabelPrefs(raw: string | null): LabelPrefs {
  const value = savedObject(raw);
  if (!value) return DEFAULT_LABEL_PREFS;
  const mode = (v: unknown, fallback: LabelMode) => (LABEL_MODES.includes(v as LabelMode) ? (v as LabelMode) : fallback);
  return { names: mode(value.names, DEFAULT_LABEL_PREFS.names), titles: mode(value.titles, DEFAULT_LABEL_PREFS.titles) };
}

/** One device preference: read (cached by its raw text, so the snapshot is stable), written, and heard. */
function deviceStore<T>(key: string, parse: (raw: string | null) => T, defaults: T) {
  /** The choice made on this page: the answer where the device's storage cannot hold it. */
  let remembered: T | null = null;
  let cache: { raw: string | null; value: T } = { raw: null, value: defaults };
  const listeners = new Set<() => void>();
  const read = (): T => {
    if (remembered) return remembered;
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { /* Private mode or blocked site data: the defaults answer. */ }
    if (raw !== cache.raw) cache = { raw, value: parse(raw) };
    return cache.value;
  };
  const write = (value: T): void => {
    remembered = null;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { remembered = value; }
    listeners.forEach(listener => listener());
  };
  const subscribe = (onChange: () => void) => {
    listeners.add(onChange);
    window.addEventListener('storage', onChange);
    return () => { listeners.delete(onChange); window.removeEventListener('storage', onChange); };
  };
  /** The saved value (the defaults on the server and in the first client render), and a setter that saves. */
  const useValue = (): [T, (change: Partial<T>) => void] => {
    const value = useSyncExternalStore(subscribe, read, () => defaults);
    return [value, change => write({ ...read(), ...change })];
  };
  return { read, write, useValue };
}

const menuStore = deviceStore(MENU_PREFS_KEY, parseMenuPrefs, DEFAULT_MENU_PREFS);
const labelStore = deviceStore(LABEL_PREFS_KEY, parseLabelPrefs, DEFAULT_LABEL_PREFS);

export const readMenuPrefs = menuStore.read;
export const writeMenuPrefs = menuStore.write;
/** The saved menu preferences (the defaults on the server and in the first client render), and a setter that saves. */
export const useMenuPrefs = menuStore.useValue;

export const readLabelPrefs = labelStore.read;
export const writeLabelPrefs = labelStore.write;
/** The saved Names and Titles choices (When zoomed in on the server and in the first render), and a setter that saves. */
export const useLabelPrefs = labelStore.useValue;
