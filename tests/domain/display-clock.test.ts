import { describe, expect, it, vi } from 'vitest';
import { createDisplayClock } from '@/game/display-clock';

describe('display clock', () => {
  it('anchors at the first server time and runs on in real time', () => {
    let perf = 1000;
    const clock = createDisplayClock(() => perf, () => 5);
    expect(clock.synced()).toBe(false);
    expect(clock.now()).toBe(5);
    clock.sync(1_000_000);
    expect(clock.synced()).toBe(true);
    perf += 2500;
    expect(clock.now()).toBe(1_002_500);
  });

  it('never moves back for a later, older read, but moves forward for a server ahead of it', () => {
    let perf = 0;
    const clock = createDisplayClock(() => perf);
    clock.sync(1_000_000);
    perf = 10_000;
    clock.sync(1_000_000);
    expect(clock.now()).toBe(1_010_000);
    clock.sync(1_050_000);
    expect(clock.now()).toBe(1_050_000);
    perf = 11_000;
    expect(clock.now()).toBe(1_051_000);
  });

  it('holds a frozen time for tests and runs on from it when released', () => {
    let perf = 0;
    const clock = createDisplayClock(() => perf);
    clock.sync(1_000_000);
    const seen = vi.fn();
    const off = clock.subscribe(seen);
    clock.freeze(2_000_000);
    perf = 50_000;
    expect(clock.now()).toBe(2_000_000);
    expect(clock.frozen()).toBe(2_000_000);
    // A server read never moves a frozen clock.
    clock.sync(9_000_000);
    expect(clock.now()).toBe(2_000_000);
    clock.freeze(null);
    perf = 51_000;
    expect(clock.now()).toBe(2_001_000);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    clock.freeze(3);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
