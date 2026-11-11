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

type Measured = { windowWidth: number; chipWidth: number; chipBottom: number; panelClearLeft: number; panelClearRight: number } & BannerPlace;
const FIRST: Measured = { windowWidth: 1280, chipWidth: 371, chipBottom: 0, panelClearLeft: CLEAR_LEFT, panelClearRight: 470, ...bannerPlace({ windowWidth: 1280, chipWidth: 371, compact: false }) };

export function useBannerPlace(shellRef: RefObject<HTMLElement | null>, remeasureOn: unknown, openMenu: string | null, menuPlace: string = 'left'): BannerPlace & { chipWidth: number; chipBottom: number; panelClearLeft: number; panelClearRight: number } {
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
      // Only a panel beside a left rail takes the banner's left; one on the right or above a bottom bar starts below the banner's row.
      const panelClearLeft = panel && menuPlace === 'left' ? Math.max(CLEAR_LEFT, panel.offsetLeft + panel.offsetWidth + 12) : CLEAR_LEFT;
      const panelClearRight = panel && menuPlace === 'right' ? shell.clientWidth - panel.offsetLeft + 12 : 470;
      const size = { windowWidth: Math.round(shell.clientWidth), chipWidth: Math.ceil(chipBox?.width ?? 0),
        chipBottom: chipBox ? Math.ceil(chipBox.bottom - shell.getBoundingClientRect().top) : 0, panelClearLeft, panelClearRight };
      // The previous answer feeds the next (the hysteresis): a banner under the chip needs spare room to return to the top row.
      setMeasured(previous => (previous.windowWidth === size.windowWidth && previous.chipWidth === size.chipWidth && previous.chipBottom === size.chipBottom && previous.panelClearLeft === size.panelClearLeft && previous.panelClearRight === size.panelClearRight ? previous
        : { ...size, ...bannerPlace({ ...size, compact: false, wasStacked: previous.stacked }) }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    if (chip) observer.observe(chip);
    if (panel) observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [shellRef, remeasureOn, openMenu, menuPlace]);
  const chipSize = { chipWidth: measured.chipWidth, chipBottom: measured.chipBottom, panelClearLeft: measured.panelClearLeft, panelClearRight: measured.panelClearRight };
  return compact ? { stacked: true, coversPanel: false, ...chipSize }
    : { stacked: measured.stacked, coversPanel: measured.coversPanel, ...chipSize };
}
