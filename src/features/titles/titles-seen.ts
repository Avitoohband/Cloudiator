// Patch 1.9 Task 36 (Avi, 2026-11-14): a tiny "New" mark on a title the player earned but has not yet seen in the title picker. What was seen is
// kept on this device (`localStorage`, one record per gladiator: the ids of the titles seen), every access in try/catch, with this page's own memory
// as the fallback where the storage is blocked. First run, with no record for the gladiator, everything already earned counts as seen, so an existing
// player meets no flood of marks. The picker reads it once when it opens (the marks stay while it is open) and records each earned title whose row
// was on a page the player viewed, so the mark is gone the next time. Pure helpers first, then the storage.
export const SEEN_KEY = 'cloudiator.titles-seen.v1';
export type SeenStore = Record<string, string[]>;

/** The stored record: an object of gladiator id to a list of title ids; anything else (no record, bad JSON, wrong shapes) reads as what is valid. */
export function parseSeen(raw: string | null): SeenStore {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const out: SeenStore = {};
    for (const [id, ids] of Object.entries(value)) if (Array.isArray(ids)) out[id] = ids.filter((entry): entry is string => typeof entry === 'string');
    return out;
  } catch {
    return {};
  }
}

/** The earned titles not in the gladiator's record; none when it has no record (first run). */
export function newTitleIds(store: SeenStore, gladiatorId: string, earned: readonly string[]): Set<string> {
  const seen = store[gladiatorId];
  return seen ? new Set(earned.filter(id => !seen.includes(id))) : new Set();
}

/** `store` with `ids` added to the gladiator's record (the other gladiators untouched). */
export function recordSeen(store: SeenStore, gladiatorId: string, ids: readonly string[]): SeenStore {
  return { ...store, [gladiatorId]: [...new Set([...(store[gladiatorId] ?? []), ...ids])].sort() };
}

/** What this page could not keep in the storage. */
let remembered: SeenStore | null = null;

function load(): SeenStore {
  try {
    return parseSeen(localStorage.getItem(SEEN_KEY));
  } catch {
    return remembered ?? {};
  }
}

function save(store: SeenStore): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(store));
    remembered = null;
  } catch {
    remembered = store;
  }
}

/** The earned titles new to this gladiator now. With no record yet, records everything earned as seen and answers none. */
export function readNewTitles(gladiatorId: string, earned: readonly string[]): Set<string> {
  const store = load();
  if (!store[gladiatorId]) { save(recordSeen(store, gladiatorId, earned)); return new Set(); }
  return newTitleIds(store, gladiatorId, earned);
}

/** Records `ids` as seen by this gladiator. */
export function markTitlesSeen(gladiatorId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  save(recordSeen(load(), gladiatorId, ids));
}

/** Tests only: forget the page's own memory. */
export function resetSeenMemory(): void {
  remembered = null;
}
