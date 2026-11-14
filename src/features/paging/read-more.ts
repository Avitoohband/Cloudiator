// Patch 1.9 final review M2: Next past the loaded rows of a cursor list kept in a store (My bouts' `bouts-store`, a gladiator's History's
// `history-store`). The pager's `load` must settle once the rows have grown, or reject so the bar says "Could not load more. Try Next again.".
// The stores' `more` answers false, with no failure, while the list's first page is being read again (Results re-reads My bouts each time it
// opens, keeping the old rows on screen) or another read of more is out (the History's landing): such a Next waits for that read and reads on,
// so it never waits for rows that never come.

/** A store's cursor list, as `bouts-store` and `history-store` keep one. */
export type MoreList = {
  rows: readonly unknown[]; nextCursor: string | null; status: 'idle' | 'loading' | 'ready' | 'failed'; loadingMore: boolean; moreFailed: boolean;
};
/** A store of cursor lists: `more` answers true only when it applied a page. */
export type MoreStore<K> = { list(key: K): MoreList; more(key: K): Promise<boolean>; subscribe(listener: () => void): () => void };

/** The list is being read: its first page again, or more. */
const reading = (list: MoreList) => list.status === 'loading' || list.loadingMore;

/** Resolves once `key`'s list in `store` is no longer being read. */
function settled<K>(store: MoreStore<K>, key: K): Promise<void> {
  return new Promise(resolve => {
    if (!reading(store.list(key))) { resolve(); return; }
    const off = store.subscribe(() => {
      if (reading(store.list(key))) return;
      off();
      resolve();
    });
  });
}

/**
 * The pager's `load` for `key`'s list in `store`: resolves once the list holds more rows than when Next was pressed, or has no more to read;
 * rejects when they cannot be read. A Next pressed while the list is being read (again) waits for that read once, then reads on from the rows it
 * left: a re-read first page that holds fewer rows than at the press is read on until it holds more.
 */
export async function readMore<K>(store: MoreStore<K>, key: K): Promise<void> {
  const pressed = store.list(key).rows.length;
  let waited = false;
  for (;;) {
    const applied = await store.more(key);
    const now = store.list(key);
    // Each page applied adds rows or ends the list, so this reads on at most until the rows pressed on are passed.
    if (applied) {
      if (now.rows.length > pressed || !now.nextCursor) return;
      continue;
    }
    if (!waited && reading(now)) {
      waited = true;
      await settled(store, key);
      const after = store.list(key);
      if (after.rows.length > pressed || (after.status === 'ready' && !after.nextCursor)) return;
      continue;
    }
    // Nothing was read: a failed read, or a list that could not be read on (a re-read that failed). The bar says so; Next tries again.
    if (now.moreFailed || now.nextCursor) throw new Error('More could not be loaded.');
    return;
  }
}
