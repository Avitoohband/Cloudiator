'use client';

// Whether the shell's touch layout applies (`COMPACT_QUERY`: no hover, or a window under 481 px): the layout a list picks its page size by
// when its rows are taller than the sheet can hold (Task 32 fix round 1: the History shows four rows a page there, as a grid passes its
// layout's size). The server render and the first client render say false, as the prerendered page does.
import { useSyncExternalStore } from 'react';
import { COMPACT_QUERY } from '../shell/rail-reveal';

const subscribe = (onChange: () => void) => {
  const query = typeof window === 'undefined' ? undefined : window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const read = () => (typeof window === 'undefined' ? false : window.matchMedia?.(COMPACT_QUERY).matches ?? false);

export const useCompactLayout = (): boolean => useSyncExternalStore(subscribe, read, () => false);
