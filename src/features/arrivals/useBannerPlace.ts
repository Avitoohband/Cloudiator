'use client';

// Measures what `bannerPlace` needs: the window's width and the corner chip's, watched with a ResizeObserver (the chip grows with a long
// name or a big purse, and shrinks again), and whether the shell is in its touch layout. `remeasureOn` names what can replace the chip
// element (the viewer), so the new one is observed.
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import { bannerPlace, type BannerPlace } from './placement';

const subscribeCompact = (onChange: () => void) => {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const readCompact = () => window.matchMedia?.(COMPACT_QUERY).matches ?? false;

export function useBannerPlace(shellRef: RefObject<HTMLElement | null>, remeasureOn: unknown): BannerPlace & { chipWidth: number } {
  // The server render and the first client render assume a pointer window with Aster's chip; the observer's first report replaces them.
  const compact = useSyncExternalStore(subscribeCompact, readCompact, () => false);
  const [size, setSize] = useState({ windowWidth: 1280, chipWidth: 371 });
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const chip = shell.querySelector<HTMLElement>('[data-testid="corner-chip"]');
    const measure = () => {
      const next = { windowWidth: Math.round(shell.clientWidth), chipWidth: Math.ceil(chip?.getBoundingClientRect().width ?? 0) };
      setSize(previous => (previous.windowWidth === next.windowWidth && previous.chipWidth === next.chipWidth ? previous : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    if (chip) observer.observe(chip);
    measure();
    return () => observer.disconnect();
  }, [shellRef, remeasureOn]);
  return { ...bannerPlace({ ...size, compact }), chipWidth: size.chipWidth };
}
