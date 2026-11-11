'use client';

// The window and chip widths place the arrival banner. The chip's bottom keeps notices below controls that wrap.
// `remeasureOn` names what can replace the chip element (the viewer), so the new one is observed.
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import { bannerPlace, CLEAR_LEFT, type BannerPlace } from './placement';

const subscribeCompact = (onChange: () => void) => {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const readCompact = () => window.matchMedia?.(COMPACT_QUERY).matches ?? false;

type Measured = { windowWidth: number; chipWidth: number; chipBottom: number; panelClearLeft: number } & BannerPlace;
const FIRST: Measured = { windowWidth: 1280, chipWidth: 371, chipBottom: 0, panelClearLeft: CLEAR_LEFT, ...bannerPlace({ windowWidth: 1280, chipWidth: 371, compact: false }) };

export function useBannerPlace(shellRef: RefObject<HTMLElement | null>, remeasureOn: unknown, openMenu: string | null): BannerPlace & { chipWidth: number; chipBottom: number; panelClearLeft: number } {
  // The server render and the first client render assume a pointer window with Aster's chip; the observer's first report replaces them.
  const compact = useSyncExternalStore(subscribeCompact, readCompact, () => false);
  const [measured, setMeasured] = useState<Measured>(FIRST);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const chip = shell.querySelector<HTMLElement>('[data-testid="corner-chip"]');
    const panel = shell.querySelector<HTMLElement>('[data-menu-surface]:not([hidden])');
    const measure = () => {
      const chipBox = chip?.getBoundingClientRect();
      // Use layout coordinates because the panel animates when it opens.
      const panelClearLeft = panel ? Math.max(CLEAR_LEFT, panel.offsetLeft + panel.offsetWidth + 12) : CLEAR_LEFT;
      const size = { windowWidth: Math.round(shell.clientWidth), chipWidth: Math.ceil(chipBox?.width ?? 0),
        chipBottom: chipBox ? Math.ceil(chipBox.bottom - shell.getBoundingClientRect().top) : 0, panelClearLeft };
      // The previous answer feeds the next (the hysteresis): a banner under the chip needs spare room to return to the top row.
      setMeasured(previous => (previous.windowWidth === size.windowWidth && previous.chipWidth === size.chipWidth && previous.chipBottom === size.chipBottom && previous.panelClearLeft === size.panelClearLeft ? previous
        : { ...size, ...bannerPlace({ ...size, compact: false, wasStacked: previous.stacked }) }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    if (chip) observer.observe(chip);
    if (panel) observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [shellRef, remeasureOn, openMenu]);
  const chipSize = { chipWidth: measured.chipWidth, chipBottom: measured.chipBottom, panelClearLeft: measured.panelClearLeft };
  return compact ? { stacked: true, coversPanel: false, ...chipSize }
    : { stacked: measured.stacked, coversPanel: measured.coversPanel, ...chipSize };
}
