import { afterEach, describe, expect, it, vi } from 'vitest';

// Arena replays Task 5 (spec 2, plan Review Focus 1): the replay speed this device remembers, in `cloudiator.replay-speed.v1` as
// '1', '2' or '4'. A per-device convenience: every access inside try/catch, the page's own memory answering when storage throws.
describe('the remembered replay speed', () => {
  // Each test imports a fresh module after vi.resetModules(), so the page's memory starts empty.
  const fresh = async () => { vi.resetModules(); return import('../../src/lib/replay-speed'); };
  const memoryStorage = (store = new Map<string, string>()) => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    return store;
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('starts at 1× and remembers 2× on this device', async () => {
    const store = memoryStorage();
    const { SPEED_KEY, readReplaySpeed, saveReplaySpeed } = await fresh();
    expect(SPEED_KEY).toBe('cloudiator.replay-speed.v1');
    expect(readReplaySpeed()).toBe('normal');
    saveReplaySpeed('double');
    expect(store.get(SPEED_KEY)).toBe('2');
    expect(readReplaySpeed()).toBe('double');
    saveReplaySpeed('fast');
    expect(store.get(SPEED_KEY)).toBe('4');
    // A new page reads what this one stored.
    const again = await fresh();
    expect(again.readReplaySpeed()).toBe('fast');
  });

  it('ignores a stored value that is not one of its speeds', async () => {
    memoryStorage(new Map([['cloudiator.replay-speed.v1', '3']]));
    expect((await fresh()).readReplaySpeed()).toBe('normal');
    memoryStorage(new Map([['cloudiator.replay-speed.v1', 'fast']]));
    expect((await fresh()).readReplaySpeed()).toBe('normal');
  });

  it('keeps the choice in memory for the page when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem() { throw new DOMException('blocked', 'SecurityError'); },
      setItem() { throw new DOMException('blocked', 'SecurityError'); },
    });
    const { readReplaySpeed, saveReplaySpeed } = await fresh();
    expect(readReplaySpeed()).toBe('normal');
    expect(() => saveReplaySpeed('double')).not.toThrow();
    expect(readReplaySpeed()).toBe('double');
  });

  it('keeps the choice when only the write fails, over an older stored value', async () => {
    const store = new Map([['cloudiator.replay-speed.v1', '4']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem() { throw new Error('quota'); } });
    const { readReplaySpeed, saveReplaySpeed } = await fresh();
    expect(readReplaySpeed()).toBe('fast');
    saveReplaySpeed('double');
    expect(readReplaySpeed()).toBe('double');
  });
});
