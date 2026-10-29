'use client';

// The arrival banner the camp shows now (Patch A item 2), from the shared world. It is derived from the latest world, the ids this
// device has been told about and the viewer's own gladiator (welcomed first), so a slower or repeated world read never brings back a
// banner that was closed: closing remembers the ids (`rememberArrivals`, which holds them in memory when storage throws).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorldSnapshot } from '@contracts/reads';
import { arrivalBanner, readSeenArrivals, rememberArrivals, type ArrivalBanner } from './arrivals';

export function useArrivals(world: WorldSnapshot | null, ownerId: string | null): { banner: ArrivalBanner | null; dismiss(): void } {
  // Read once at mount: the page's own announcements update it from then on (the first render has no world, so nothing shows from it).
  const [seen, setSeen] = useState<ReadonlySet<string>>(readSeenArrivals);
  const banner = useMemo(() => (world ? arrivalBanner(world.actors, seen, ownerId) : null), [world, seen, ownerId]);
  const current = useRef(banner);
  useEffect(() => { current.current = banner; });
  /** Closes the banner shown now: its gladiators are remembered, and the next banner (the others, after a welcome) takes its place. */
  const dismiss = useCallback(() => {
    const shown = current.current;
    if (!shown) return;
    rememberArrivals(shown.ids);
    setSeen(readSeenArrivals());
  }, []);
  return { banner, dismiss };
}
