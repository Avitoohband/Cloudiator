import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GRID_PAGE, MAX_DOTS, PAGE_SIZES, SHOW_CHOICES, clampPage, dotWindow, pageCount, pageOfIndex, pageRows, pagerLabel, scrubPage, showChoices,
} from '../../src/features/paging/paging';
import { createPageController } from '../../src/features/paging/page-controller';
import { PAGE_SIZE_KEY, readPageSize, resetPageSizeMemory, writePageSize } from '../../src/features/paging/page-size-prefs';

// Patch 1.9 Task 30 (Avi, 2026-11-13: "Menus next and backwards instead of scrolling"): long menus show one page with Back and Next.

describe('the paging arithmetic', () => {
  it('keeps the approved page sizes', () => {
    expect(PAGE_SIZES.gladiators).toBe(7);
    expect(PAGE_SIZES.market).toBe(3);
    expect(GRID_PAGE).toEqual({ desktop: 24, phone: 15 });
    expect(SHOW_CHOICES).toEqual([10, 25, 50]);
    expect(MAX_DOTS).toEqual({ desktop: 12, phone: 9, narrow: 7 });
  });

  it('counts pages, at least one', () => {
    expect(pageCount(0, 7)).toBe(1);
    expect(pageCount(7, 7)).toBe(1);
    expect(pageCount(8, 7)).toBe(2);
    expect(pageCount(50, 7)).toBe(8);
  });

  it('clamps a page into 1..pages', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-3, 5)).toBe(1);
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(2.7, 5)).toBe(2);
  });

  it('cuts the rows of a page', () => {
    const rows = Array.from({ length: 17 }, (_, i) => i);
    expect(pageRows(rows, 1, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pageRows(rows, 3, 7)).toEqual([14, 15, 16]);
    expect(pageRows(rows, 9, 7)).toEqual([14, 15, 16]);
    expect(pageRows([], 1, 7)).toEqual([]);
  });

  it('finds the page that holds a row', () => {
    expect(pageOfIndex(0, 7)).toBe(1);
    expect(pageOfIndex(6, 7)).toBe(1);
    expect(pageOfIndex(7, 7)).toBe(2);
    expect(pageOfIndex(49, 7)).toBe(8);
    expect(pageOfIndex(-1, 7)).toBe(1);
  });

  it('labels a known and an unknown total', () => {
    expect(pagerLabel(2, 5)).toEqual({ main: 'Page 2 of 5', sub: null });
    expect(pagerLabel(2, null)).toEqual({ main: 'Page 2', sub: 'more to see' });
  });

  it('shows every circle when they fit', () => {
    expect(dotWindow(1, 1, 9)).toEqual([1]);
    expect(dotWindow(3, 8, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dotWindow(12, 12, 12)).toHaveLength(12);
  });

  it('windows 30 pages with the first, the last and the current page always in', () => {
    for (const max of [9, 12]) {
      for (let page = 1; page <= 30; page++) {
        const dots = dotWindow(page, 30, max);
        expect(dots.length, `${page} at ${max}`).toBeLessThanOrEqual(max);
        expect(dots[0]).toBe(1);
        expect(dots[dots.length - 1]).toBe(30);
        expect(dots).toContain(page);
        const numbers = dots.filter((d): d is number => d !== 'gap');
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
        for (let i = 1; i < dots.length; i++) expect(dots[i] === 'gap' && dots[i - 1] === 'gap').toBe(false);
      }
    }
    expect(dotWindow(15, 30, 9)).toEqual([1, 'gap', 13, 14, 15, 16, 17, 'gap', 30]);
  });

  it('caps the circles at 7 on a screen under 360 px', () => {
    expect(MAX_DOTS.narrow).toBe(7);
    expect(dotWindow(15, 30, MAX_DOTS.narrow)).toHaveLength(7);
  });

  it('maps a slide along a windowed row to all pages in proportion', () => {
    expect(scrubPage(0, 30)).toBe(1);
    expect(scrubPage(1, 30)).toBe(30);
    expect(scrubPage(0.5, 30)).toBe(16);
    expect(scrubPage(-0.4, 30)).toBe(1);
    expect(scrubPage(1.7, 30)).toBe(30);
    expect(scrubPage(0.25, 13)).toBe(4);
    expect(scrubPage(0.3, 1)).toBe(1);
  });

  it('offers Fit first, then the larger choices', () => {
    expect(showChoices(7)).toEqual([7, 10, 25, 50]);
    expect(showChoices(10)).toEqual([10, 25, 50]);
  });
});

describe('the page controller (usePagedList)', () => {
  const input = (total: number, extra: Partial<Parameters<ReturnType<typeof createPageController>['sync']>[0]> = {}) =>
    ({ total, size: 7, hasMore: false, resetKey: '', ...extra });

  it('turns pages, and the ends do nothing', () => {
    const c = createPageController();
    c.sync(input(50));
    expect(c.view()).toMatchObject({ page: 1, pages: 8, knownPages: 8, canBack: false, canNext: true });
    c.back();
    expect(c.view().page).toBe(1);
    c.next();
    expect(c.view().page).toBe(2);
    c.go(8);
    expect(c.view()).toMatchObject({ page: 8, canNext: false });
    c.next();
    expect(c.view().page).toBe(8);
  });

  it('goes back to page 1 when the reset key changes', () => {
    const c = createPageController();
    c.sync(input(50, { resetKey: '' }));
    c.go(4);
    c.sync(input(50, { resetKey: '' }));
    expect(c.view().page).toBe(4);
    c.sync(input(12, { resetKey: 'a' }));
    expect(c.view().page).toBe(1);
  });

  it('shows the last page when the rows shrink under it', () => {
    const c = createPageController();
    c.sync(input(50));
    c.go(8);
    c.sync(input(20));
    expect(c.view().page).toBe(3);
    expect(c.view().canNext).toBe(false);
  });

  it('has no known total while more rows can be read', () => {
    const c = createPageController();
    c.sync(input(7, { hasMore: true }));
    expect(c.view()).toMatchObject({ pages: null, knownPages: 1, canNext: true });
  });

  it('reads more once when Next passes the loaded rows', async () => {
    const c = createPageController();
    let finish!: () => void;
    const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    c.sync(input(7, { hasMore: true }), load);
    c.next();
    expect(c.view().busy).toBe(true);
    c.next();
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.view().busy).toBe(false);
    c.sync(input(14, { hasMore: true }), load);
    expect(c.view().page).toBe(2);
  });

  it('keeps the page and says failed when a read fails', async () => {
    const c = createPageController();
    const load = vi.fn(() => Promise.reject(new Error('down')));
    c.sync(input(7, { hasMore: true }), load);
    c.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.view()).toMatchObject({ page: 1, busy: false, failed: true });
  });

  it('keeps the first row on screen when the size changes', () => {
    const c = createPageController();
    c.sync(input(50));
    c.go(4); // rows 21..27
    c.resize(25);
    expect(c.view().page).toBe(1);
    c.go(2); // rows 25..49
    c.resize(7);
    expect(c.view().page).toBe(pageOfIndex(25, 7));
  });

  it('jumps to the page that holds a row', () => {
    const c = createPageController();
    c.sync(input(50));
    c.goToIndex(30);
    expect(c.view().page).toBe(5);
    expect(c.view().jump).toBe(30);
  });
});

describe('the Show choice on this device', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetPageSizeMemory(); });
  const storage = (values: Record<string, string>) => ({
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value; },
  });

  it('reads a saved choice, and Fit for anything else', () => {
    const values: Record<string, string> = {};
    vi.stubGlobal('localStorage', storage(values));
    expect(readPageSize('gladiators', 7)).toBe(7);
    writePageSize('gladiators', 25);
    expect(JSON.parse(values[PAGE_SIZE_KEY])).toEqual({ gladiators: 25 });
    expect(readPageSize('gladiators', 7)).toBe(25);
    for (const garbage of ['nope', '[]', '{"gladiators":11}', '{"gladiators":"25"}', '{"gladiators":3}']) {
      values[PAGE_SIZE_KEY] = garbage;
      expect(readPageSize('gladiators', 7), garbage).toBe(7);
    }
  });

  it('reads Fit when the storage throws, and keeps a choice for this page', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readPageSize('gladiators', 7)).toBe(7);
    writePageSize('gladiators', 10);
    expect(readPageSize('gladiators', 7)).toBe(10);
  });
});
