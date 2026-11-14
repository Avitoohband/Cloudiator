import { afterEach, describe, expect, it } from 'vitest';
import { SEEN_KEY, markTitlesSeen, newTitleIds, parseSeen, readNewTitles, recordSeen, resetSeenMemory } from '../../src/features/titles/titles-seen';

// Patch 1.9 Task 36 (Avi, 2026-11-14: "a tiny new mark near new titles in the titles menu"): which earned titles the player has not yet seen in the picker.

describe('the titles seen on this device', () => {
  afterEach(() => { resetSeenMemory(); delete (globalThis as { localStorage?: unknown }).localStorage; });

  it('reads nothing, a bad record or a wrong shape as no record', () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen('{not json')).toEqual({});
    expect(parseSeen('[1,2]')).toEqual({});
    expect(parseSeen('{"g1":"founder","g2":[1,"tiro"]}')).toEqual({ g2: ['tiro'] });
  });

  it('first run: with no record for the gladiator nothing is new', () => {
    expect(newTitleIds({}, 'g1', ['founder', 'tiro'])).toEqual(new Set());
  });

  it('a title earned after the record is new, and the others are not', () => {
    expect(newTitleIds({ g1: ['founder'] }, 'g1', ['founder', 'tiro'])).toEqual(new Set(['tiro']));
  });

  it('another gladiator\'s record does not count', () => {
    expect(newTitleIds({ g2: ['founder', 'tiro'] }, 'g1', ['founder', 'tiro'])).toEqual(new Set());
    expect(newTitleIds({ g2: ['founder'] }, 'g2', ['founder', 'tiro'])).toEqual(new Set(['tiro']));
  });

  it('recording seen titles adds to the gladiator\'s record and leaves the others alone', () => {
    expect(recordSeen({ g1: ['founder'], g2: ['x'] }, 'g1', ['tiro', 'founder'])).toEqual({ g1: ['founder', 'tiro'], g2: ['x'] });
    expect(recordSeen({}, 'g1', ['tiro'])).toEqual({ g1: ['tiro'] });
  });

  it('keeps working with no storage: the first read marks nothing, the page remembers what was seen', () => {
    // (No localStorage in this runner.)
    expect(readNewTitles('g1', ['founder', 'tiro'])).toEqual(new Set());
    expect(readNewTitles('g1', ['founder', 'tiro', 'wanderer'])).toEqual(new Set(['wanderer']));
  });

  it('writes nothing when every shown title is already recorded', () => {
    const data: Record<string, string> = { [SEEN_KEY]: JSON.stringify({ g1: ['founder', 'tiro'] }) };
    let writes = 0;
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { writes += 1; data[k] = v; } };
    markTitlesSeen('g1', ['tiro']);
    markTitlesSeen('g1', []);
    expect(writes).toBe(0);
    markTitlesSeen('g1', ['wanderer']);
    expect(writes).toBe(1);
  });

  it('uses the page memory when the storage reads but a write fails (quota)', () => {
    const data: Record<string, string> = { [SEEN_KEY]: JSON.stringify({ g1: ['founder'] }) };
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => data[k] ?? null, setItem: () => { throw new Error('quota'); } };
    markTitlesSeen('g1', ['tiro']);
    // The stored record still says only Founder was seen; the page's memory knows Tiro was too.
    expect(readNewTitles('g1', ['founder', 'tiro', 'wanderer'])).toEqual(new Set(['wanderer']));
  });

  it('stores under one versioned key, per gladiator', () => {
    const data: Record<string, string> = {};
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
    expect(SEEN_KEY).toBe('cloudiator.titles-seen.v1');
    expect(readNewTitles('g1', ['founder'])).toEqual(new Set());
    expect(JSON.parse(data[SEEN_KEY])).toEqual({ g1: ['founder'] });
    expect(readNewTitles('g1', ['founder', 'tiro'])).toEqual(new Set(['tiro']));
  });
});
