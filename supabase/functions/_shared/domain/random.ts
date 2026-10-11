import type { Seed } from './types.ts';

/** v1: FNV-1a over JS UTF-16 code units, then Mulberry32. Never use for secrets. */
export const RANDOM_VERSION = 'fnv1a-utf16-mulberry32-v1';

/** The backend supplies/stores the seed. Keep this stream private; never log its state. */
export function seededRandom(seed: Seed): () => number {
  if (typeof seed !== 'string' || seed.length === 0) throw new RangeError('A private seed is required');
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}
