import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MENU_PREFS, MENU_PREFS_KEY, parseMenuPrefs, readMenuPrefs, writeMenuPrefs } from '@/features/shell/menu-prefs';
import { railVisible } from '@/features/shell/rail-reveal';

afterEach(() => vi.unstubAllGlobals());

describe('the menu preferences (pin and position)', () => {
  it('start on the left, unpinned, and a missing or bad value means that', () => {
    expect(DEFAULT_MENU_PREFS).toEqual({ pinned: false, place: 'left' });
    for (const raw of [null, '', 'nope', '{', '[]', '"right"', '{"pinned":"yes","place":"top"}', '{"pinned":1}']) {
      expect(parseMenuPrefs(raw), String(raw)).toEqual(DEFAULT_MENU_PREFS);
    }
  });

  it('read a saved pin and position, each field on its own', () => {
    expect(parseMenuPrefs('{"pinned":true,"place":"bottom"}')).toEqual({ pinned: true, place: 'bottom' });
    expect(parseMenuPrefs('{"pinned":true,"place":"sideways"}')).toEqual({ pinned: true, place: 'left' });
    expect(parseMenuPrefs('{"place":"right"}')).toEqual({ pinned: false, place: 'right' });
  });

  it('round-trip through localStorage, and fall back to the defaults when storage throws', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
    expect(readMenuPrefs()).toEqual(DEFAULT_MENU_PREFS);
    writeMenuPrefs({ pinned: true, place: 'right' });
    expect(data.has(MENU_PREFS_KEY)).toBe(true);
    expect(readMenuPrefs()).toEqual({ pinned: true, place: 'right' });
    const boom = () => { throw new Error('blocked'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom });
    expect(readMenuPrefs()).toEqual(DEFAULT_MENU_PREFS);
    expect(() => writeMenuPrefs({ pinned: false, place: 'left' })).not.toThrow();
  });
});

describe('the rail shown', () => {
  it('stays shown while pinned and follows the reveal state otherwise', () => {
    expect(railVisible({ revealed: false, open: null }, true)).toBe(true);
    expect(railVisible({ revealed: false, open: null }, false)).toBe(false);
    expect(railVisible({ revealed: true, open: null }, false)).toBe(true);
  });
});
