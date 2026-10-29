import { describe, expect, it } from 'vitest';
import { buildRefusal } from '../../src/features/build/build-refusal';

describe('build refusals', () => {
  it('explains an invalid build and the reload instead of displaying the server code', () => {
    expect(buildRefusal('invalid')).toBe('That build change is no longer possible. Your build has been reloaded.');
  });

  it('keeps retry, conflict and reservation messages specific to their outcomes', () => {
    expect(buildRefusal('processing')).toBe('The world is processing previous results. Retry shortly.');
    expect(buildRefusal('unavailable')).toBe('This change could not be confirmed. Retry to confirm the same request.');
    expect(buildRefusal('conflict')).toBe('Your build changed. The latest state has been loaded; review and try again.');
    expect(buildRefusal('insufficient-funds')).toBe('Not enough available gold for this reservation.');
  });
});
