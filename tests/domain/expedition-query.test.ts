import { describe, expect, it } from 'vitest';
import { expeditionQuery } from '@/features/character/expedition-query';

const query = (search: string, fixtureBuild = true) => expeditionQuery(new URLSearchParams(search), fixtureBuild);
const ID = 'f6c5b7d9-0eb5-4a1d-8e2f-6d7e8f9a0b16';

describe('expedition page query', () => {
  it('accepts only a UUID-shaped activity id', () => {
    expect(query(`activity=${ID}`).activityId).toBe(ID);
    expect(query(`activity=${ID.toUpperCase()}`).activityId).toBe(ID.toUpperCase());
    for (const bad of ['', 'abc', `${ID}x`, `x${ID}`, `${ID}:0`, '../game', `${ID.slice(0, 35)}`, "1' or '1'='1"]) {
      expect(query(`activity=${encodeURIComponent(bad)}`).activityId, bad).toBeNull();
    }
    expect(query('').activityId).toBeNull();
  });

  it('enables fixture mode only when requested in a fixture build', () => {
    expect(query(`mode=fixture&activity=${ID}`)).toMatchObject({ requested: true, fixture: true });
    expect(query(`mode=fixture&activity=${ID}`, false)).toMatchObject({ requested: true, fixture: false });
    expect(query(`activity=${ID}`)).toMatchObject({ requested: false, fixture: false });
  });

  it('reads the minute only in fixture mode, from 0 to 90', () => {
    expect(query(`mode=fixture&activity=${ID}&minute=39`).minute).toBe(39);
    expect(query(`mode=fixture&activity=${ID}&minute=39.5`).minute).toBe(39.5);
    expect(query(`mode=fixture&activity=${ID}&minute=0`).minute).toBe(0);
    expect(query(`mode=fixture&activity=${ID}&minute=90`).minute).toBe(90);
    for (const bad of ['-1', '90.5', '91', 'abc', '', 'Infinity', 'NaN', '1e9', ' 5']) {
      expect(query(`mode=fixture&activity=${ID}&minute=${encodeURIComponent(bad)}`).minute, bad).toBeNull();
    }
    // Outside fixture mode, or in a build without fixtures, the minute grants nothing.
    expect(query(`activity=${ID}&minute=39`).minute).toBeNull();
    expect(query(`mode=fixture&activity=${ID}&minute=39`, false).minute).toBeNull();
  });

  it('reads &play=trip as the whole-trip replay and ignores any other value (Patch A Task 8)', () => {
    expect(query(`activity=${ID}&play=trip`).play).toBe('trip');
    // It names a replay of the trip, never fixture authority, so it reads the same with or without fixtures.
    expect(query(`mode=fixture&activity=${ID}&play=trip`).play).toBe('trip');
    expect(query(`mode=fixture&activity=${ID}&play=trip`, false).play).toBe('trip');
    expect(query(`mode=fixture&activity=${ID}&minute=39&play=trip`)).toMatchObject({ minute: 39, play: 'trip' });
    for (const bad of ['', 'fast', 'TRIP', 'trip ', ' trip', '1', 'trip,trip']) {
      expect(query(`activity=${ID}&play=${encodeURIComponent(bad)}`).play, bad).toBeNull();
    }
    expect(query(`activity=${ID}`).play).toBeNull();
    expect(query('').play).toBeNull();
  });
});
