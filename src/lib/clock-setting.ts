import { useSyncExternalStore } from 'react';

// The clock setting (Patch A, item 7): whether this device writes every time of day in 12-hour or 24-hour form. It starts
// on the device's own choice, is remembered on this device only (never on the account), and a change reaches every screen
// that shows a time at once, without a reload. `src/lib/time-format.ts` writes the times in whichever form is chosen.

export type ClockMode = '12' | '24';
/** The device key (a per-device convenience: read and written inside try/catch, with the page's own memory as the fallback). */
export const CLOCK_KEY = 'cloudiator.clock.v1';

const isMode = (value: unknown): value is ClockMode => value === '12' || value === '24';

/**
 * The device's own choice: the hour cycle its locale uses (`h11` and `h12` are 12-hour, `h23` and `h24` 24-hour); a runtime that
 * names none says it with `hour12`.
 */
export function deviceClockMode(): ClockMode {
  const options = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
  if (options.hourCycle === 'h11' || options.hourCycle === 'h12') return '12';
  if (options.hourCycle === 'h23' || options.hourCycle === 'h24') return '24';
  return options.hour12 ? '12' : '24';
}

/** The choice made on this page, kept for the page's life: the answer where the device's storage cannot hold it. */
let remembered: ClockMode | null = null;
/** Whether the last choice did not reach storage: an older value still readable there must not undo it. */
let unsaved = false;
const listeners = new Set<() => void>();

/** The stored choice if it is a valid one, else the choice made on this page, else the device's own. */
export function readClockMode(): ClockMode {
  if (!unsaved) {
    try {
      const stored = localStorage.getItem(CLOCK_KEY);
      if (isMode(stored)) return stored;
    } catch { /* Private mode or blocked site data: the page's own memory answers. */ }
  }
  return remembered ?? deviceClockMode();
}

/** Makes `mode` this device's choice: held in memory first, then stored if the device lets it, then every listener is told. */
export function saveClockMode(mode: ClockMode): void {
  remembered = mode;
  try { localStorage.setItem(CLOCK_KEY, mode); unsaved = false; } catch { unsaved = true; }
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` after every change, also one another tab makes (the `storage` event for the key). Returns the way to stop. */
export function subscribeClockMode(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    // A null key is the whole store being cleared.
    if (event.key !== null && event.key !== CLOCK_KEY) return;
    unsaved = false;
    listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** The clock setting, read again whenever it changes. A server render, and the first client render, use the device's own choice. */
export function useClockMode(): ClockMode {
  return useSyncExternalStore(subscribeClockMode, readClockMode, deviceClockMode);
}
