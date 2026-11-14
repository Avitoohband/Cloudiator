import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_SEEN_KEY, heartbeatAwaySeen, onAwaySeenStorage, readAwaySeen, resetAwaySeenMemory, writeAwaySeen } from '../../src/features/away-summary/away-seen';

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  resetAwaySeenMemory();
});
afterEach(() => vi.unstubAllGlobals());

describe('While you were away device store', () => {
  it('two simulated tabs stop exchanging storage writes and throttle their heartbeats', () => {
    const handlers = [0, 1].map(() => (event: Pick<StorageEvent, 'key'>) => onAwaySeenStorage('a', event));
    const pending: (() => void)[] = [];
    let side = 0;
    const setItem = vi.fn((key: string, value: string) => {
      stored.set(key, value);
      const next = 1 - side;
      pending.push(() => { side = next; handlers[next]({ key }); });
    });
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem });
    writeAwaySeen('a', 120_000);
    for (let remaining = 4; remaining > 0 && pending.length; remaining--) pending.shift()!();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
    heartbeatAwaySeen('a', 149_999);
    expect(setItem).toHaveBeenCalledTimes(1);
    heartbeatAwaySeen('a', 150_000);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('returns no visit when storage is missing or malformed and skips invalid values', () => {
    expect(readAwaySeen('a')).toBeNull();
    stored.set(AWAY_SEEN_KEY, 'invalid json');
    expect(readAwaySeen('a')).toBeNull();
    stored.set(AWAY_SEEN_KEY, JSON.stringify({ a: -1, b: '21', c: 20.5, d: 14 }));
    expect(['a', 'b', 'c', 'd'].map(readAwaySeen)).toEqual([null, null, null, 14]);
    vi.stubGlobal('localStorage', undefined);
    expect(readAwaySeen('other')).toBeNull();
  });

  it('preserves independent entries and never moves a gladiator backward', () => {
    stored.set(AWAY_SEEN_KEY, JSON.stringify({ a: 40, b: 11 }));
    writeAwaySeen('a', 36);
    writeAwaySeen('b', 51.75);
    writeAwaySeen('a', NaN);
    expect(readAwaySeen('a')).toBe(40);
    expect(readAwaySeen('b')).toBe(51);
    expect(JSON.parse(stored.get(AWAY_SEEN_KEY)!)).toEqual({ a: 40, b: 51 });
  });

  it('uses page memory when reads or writes are blocked, including a prior external advance', () => {
    writeAwaySeen('a', 5);
    stored.set(AWAY_SEEN_KEY, JSON.stringify({ a: 15 }));
    expect(readAwaySeen('a')).toBe(15);
    const denied = () => { throw new DOMException('Blocked', 'SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied });
    writeAwaySeen('a', 10);
    writeAwaySeen('b', 40);
    expect(readAwaySeen('a')).toBe(15);
    expect(readAwaySeen('b')).toBe(40);
    resetAwaySeenMemory();
    expect(readAwaySeen('b')).toBeNull();
  });
});
