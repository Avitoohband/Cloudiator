import { vi } from 'vitest';
import type { ClockMode } from '../../src/lib/clock-setting';

// The prototype and its method are read when this file loads, before any test replaces `Intl.DateTimeFormat` with a mock (a
// mock function has a prototype of its own, so patching it later would miss the instances the real formatter makes) and
// before a second pin wraps the first.
const PROTOTYPE = Intl.DateTimeFormat.prototype;
const RESOLVED = PROTOTYPE.resolvedOptions;

/**
 * Pins the device's hour cycle (what `deviceClockMode` reads) to `mode`, so a panel rendered on the server path
 * (`useClockMode` reads the device's choice there) does not depend on the host's locale. A second call changes the pin.
 * Undone by `vi.restoreAllMocks()`.
 */
export function pinDeviceClock(mode: ClockMode) {
  return vi.spyOn(PROTOTYPE, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...RESOLVED.call(this), hourCycle: mode === '12' ? 'h12' : 'h23' };
  });
}
