'use client';

import { useSyncExternalStore } from 'react';
import { COMPACT_QUERY } from '../shell/rail-reveal';

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener?.('change', onChange);
  return () => query?.removeEventListener?.('change', onChange);
}

/** Whether the shell uses its touch layout now, read once (outside a render: a tap's handler). */
export const isCompactLayout = () => window.matchMedia?.(COMPACT_QUERY).matches ?? false;
const serverSnapshot = () => false;

/** Whether the shell uses its touch layout. Hydration starts with the server's desktop layout. */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, isCompactLayout, serverSnapshot);
}
