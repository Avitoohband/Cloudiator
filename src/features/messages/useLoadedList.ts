'use client';

// A list read through `load`, for the messages panel's two tabs: the latest read wins (an older one that lands late is dropped), a
// failed read keeps the list already shown and says it failed, and nothing lands after the panel is gone. It reads once `active` is
// true (the Notifications tab reads only when it is first opened) and again whenever `reload` is called.
import { useCallback, useEffect, useRef, useState } from 'react';

export type LoadedList<T> = {
  /** The list as last read; null before the first read lands. */
  items: readonly T[] | null;
  /** Whether the latest read failed (the list read before it, if any, is still in `items`). */
  failed: boolean;
  reload(): void;
};

export function useLoadedList<T>(load: () => Promise<readonly T[]>, active: boolean): LoadedList<T> {
  const [state, setState] = useState<{ items: readonly T[] | null; failed: boolean }>({ items: null, failed: false });
  // Only the latest read lands: each starts a new ticket, and a leaving panel takes them all.
  const ticket = useRef(0);
  const loader = useRef(load);
  useEffect(() => { loader.current = load; });
  const reload = useCallback(() => {
    const mine = ++ticket.current;
    loader.current().then(
      items => { if (mine === ticket.current) setState({ items, failed: false }); },
      () => { if (mine === ticket.current) setState(previous => ({ items: previous.items, failed: true })); },
    );
  }, []);
  useEffect(() => { if (active) reload(); }, [active, reload]);
  useEffect(() => () => { ticket.current++; }, []);
  return { ...state, reload };
}
