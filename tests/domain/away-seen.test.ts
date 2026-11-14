import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_SEEN_KEY, readAwaySeen, resetAwaySeenMemory, writeAwaySeen } from '../../src/features/away-summary/away-seen';

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  resetAwaySeenMemory();
});
afterEach(() => vi.unstubAllGlobals());

describe('While you were away device store', () => {
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