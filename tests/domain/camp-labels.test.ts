// Patch 1.9, Task 11: the camp's names and titles by the two Settings choices (Off, When zoomed in, Always), and the
// "Tidy" rule for overlapping names (the nearer name wins, names behind fade to 30%; your gladiator, a selected one and
// the talking NPC always stay full).
import { describe, expect, it } from 'vitest';
import {
  CLOSE_ZOOM, DEFAULT_LABEL_PREFS, FADED_LABEL_ALPHA, LABEL_MODES, NAME_ZOOM, labelScale, labelsShown, tidyLabels,
  type LabelMode, type LabelPrefs, type TidyItem,
} from '@/game/labels';

const prefs = (names: LabelMode, titles: LabelMode): LabelPrefs => ({ names, titles });
const gladiator = { npc: false, focused: false, hasTitle: true };
const selected = { npc: false, focused: true, hasTitle: true };
const npc = { npc: true, focused: false, hasTitle: false };
const ZOOMS = [0.5, 0.64, 1, 1.39, 1.4, 1.6, 1.99, 2, 2.4, 3];

describe('names and titles by the Settings choices', () => {
  it('start on When zoomed in for both (today), in the order Off, When zoomed in, Always', () => {
    expect(DEFAULT_LABEL_PREFS).toEqual({ names: 'zoom', titles: 'zoom' });
    expect(LABEL_MODES).toEqual(['off', 'zoom', 'always']);
    expect([NAME_ZOOM, CLOSE_ZOOM]).toEqual([1.4, 2]);
    expect(FADED_LABEL_ALPHA).toBe(0.3);
  });

  it('When zoomed in is today: gladiator names from zoom 1.4, NPC names and titles from zoom 2, a selected or followed gladiator always', () => {
    const zoom = DEFAULT_LABEL_PREFS;
    for (const z of ZOOMS) {
      expect(labelsShown(gladiator, z, zoom), `gladiator at ${z}`).toEqual({ name: z >= 1.4, title: z >= 2 });
      expect(labelsShown(npc, z, zoom), `NPC at ${z}`).toEqual({ name: z >= 2, title: false });
      expect(labelsShown(selected, z, zoom), `selected at ${z}`).toEqual({ name: true, title: true });
      expect(labelsShown({ ...gladiator, hasTitle: false }, z, zoom).title, `untitled at ${z}`).toBe(false);
    }
  });

  it('Always shows every name at any zoom, zoomed out too; titles follow their own choice', () => {
    for (const z of ZOOMS) {
      expect(labelsShown(gladiator, z, prefs('always', 'always')), `gladiator at ${z}`).toEqual({ name: true, title: true });
      expect(labelsShown(npc, z, prefs('always', 'always')), `NPC at ${z}`).toEqual({ name: true, title: false });
      expect(labelsShown(gladiator, z, prefs('always', 'zoom')), `zoom titles at ${z}`).toEqual({ name: true, title: z >= 2 });
      expect(labelsShown(selected, z, prefs('always', 'zoom')), `selected, zoom titles at ${z}`).toEqual({ name: true, title: true });
      expect(labelsShown(gladiator, z, prefs('always', 'off')), `no titles at ${z}`).toEqual({ name: true, title: false });
      expect(labelsShown(selected, z, prefs('always', 'off')), `selected, no titles at ${z}`).toEqual({ name: true, title: false });
    }
  });

  it('Titles Always shows a title with every name that shows, and never without its name', () => {
    for (const z of ZOOMS) {
      expect(labelsShown(gladiator, z, prefs('zoom', 'always')), `at ${z}`).toEqual({ name: z >= 1.4, title: z >= 1.4 });
      expect(labelsShown(selected, z, prefs('zoom', 'always')), `selected at ${z}`).toEqual({ name: true, title: true });
    }
  });

  it('Names Off is really off: no names and no titles, your selected gladiator and NPCs included, whatever Titles says', () => {
    for (const titles of LABEL_MODES) for (const z of ZOOMS) for (const who of [gladiator, selected, npc]) {
      expect(labelsShown(who, z, prefs('off', titles)), `${titles} at ${z}`).toEqual({ name: false, title: false });
    }
  });

  it('keeps names at their zoom-1 size when zoomed out with Always, and today\'s size otherwise', () => {
    expect(labelScale(0.5, prefs('always', 'zoom'))).toBeCloseTo(2);
    expect(labelScale(0.64, prefs('always', 'off'))).toBeCloseTo(1 / 0.64);
    for (const z of [1, 1.4, 2, 3]) expect(labelScale(z, prefs('always', 'always')), `always at ${z}`).toBe(1);
    for (const z of ZOOMS) {
      expect(labelScale(z, prefs('zoom', 'zoom')), `zoom at ${z}`).toBe(1);
      expect(labelScale(z, prefs('off', 'always')), `off at ${z}`).toBe(1);
    }
  });
});

describe('Tidy: overlapping names', () => {
  const box = (x: number, y: number, depth: number, pinned = false, width = 40, height = 12): TidyItem => ({ x, y, width, height, depth, pinned });
  const run = (items: TidyItem[]) => {
    const faded: boolean[] = [];
    const count = tidyLabels(items, faded);
    return { faded: faded.slice(0, items.length), count };
  };

  it('fades nothing when no names overlap', () => {
    expect(run([box(0, 0, 10), box(50, 0, 20), box(0, 20, 30)])).toEqual({ faded: [false, false, false], count: 0 });
  });

  it('keeps the nearer name (lower on screen) and fades the one behind it', () => {
    // Item 0 stands behind (smaller depth); item 1 is nearer.
    expect(run([box(0, 0, 10), box(10, 4, 20)]).faded).toEqual([true, false]);
    expect(run([box(10, 4, 20), box(0, 0, 10)]).faded).toEqual([false, true]);
  });

  it('keeps your gladiator, a selected one and the talking NPC full, ahead of nearer names', () => {
    expect(run([box(0, 0, 10, true), box(10, 4, 20)]).faded).toEqual([false, true]);
    // Two pinned names that overlap both stay full.
    expect(run([box(0, 0, 10, true), box(10, 4, 20, true)]).faded).toEqual([false, false]);
  });

  it('measures against the names already drawn: one faded name does not fade the next', () => {
    // A (nearest) and C (behind) do not touch; B (between) touches both: B fades, C stays.
    const a = box(0, 20, 30), b = box(30, 12, 20), c = box(60, 6, 10);
    expect(run([a, b, c])).toEqual({ faded: [false, true, false], count: 1 });
  });

  it('lets names that only touch at the edge (within the tolerance) both stay', () => {
    expect(run([box(0, 0, 10), box(39.5, 0, 20)]).faded).toEqual([false, false]);
    expect(run([box(0, 0, 10), box(0, 10.5, 20)]).faded).toEqual([false, false]);
    expect(run([box(0, 0, 10), box(0, 9, 20)]).faded).toEqual([true, false]);
  });

  it('is the same answer whatever order the names come in', () => {
    const items = [box(0, 0, 10), box(20, 2, 15), box(35, 5, 25), box(100, 0, 5), box(110, 3, 6, true)];
    const once = run(items).faded;
    const reversed = run([...items].reverse()).faded.reverse();
    expect(reversed).toEqual(once);
    expect(once).toEqual([true, true, false, true, false]);
  });
});
