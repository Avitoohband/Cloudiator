'use client';

import { useEffect, useState } from 'react';
import type { DisplayClock } from '../../game/display-clock';

const MINUTE_MS = 60_000;
/** How often the clock is checked for a new minute while the tab is visible. */
const TICK_MS = 1000;

/**
 * The shared display clock's time to the minute: the "now" a slot time is shown against (`slotTimeText`, Task 23.10, whose
 * wording depends on the local day: "tomorrow" turns into the time alone at midnight). The component renders again only when
 * the minute changes, or when the clock is held or moved, so the wording never stays stale.
 */
export function useMinuteNow(clock: DisplayClock): number {
  const [minute, setMinute] = useState(() => Math.floor(clock.now() / MINUTE_MS));
  useEffect(() => {
    const update = () => setMinute(Math.floor(clock.now() / MINUTE_MS));
    update();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    const off = clock.subscribe(update);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); off(); document.removeEventListener('visibilitychange', update); };
  }, [clock]);
  return minute * MINUTE_MS;
}
