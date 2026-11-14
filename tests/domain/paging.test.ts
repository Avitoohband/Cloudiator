import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GRID_PAGE, MAX_DOTS, PAGE_SIZES, SHOW_CHOICES, clampPage, dotWindow, pageCount, pageOfIndex, pageRows, pagerLabel, showChoices, slidePage,
} from '../../src/features/paging/paging';
import { createPageController } from '../../src/features/paging/page-controller';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PagingScope, PanelScopeContext, usePanelScope, type PanelScope } from '../../src/features/paging/PanelFooter';
import { keyInPanel, ownsKeys } from '../../src/features/paging/usePageKeys';
import { PAGE_SIZE_KEY, readPageSize, resetPageSizeMemory, writePageSize } from '../../src/features/paging/page-size-prefs';

// Patch 1.9 Task 30 (Avi, 2026-11-13: "Menus next and backwards instead of scrolling"): long menus show one page with Back and Next.

describe('the paging arithmetic', () => {
  it('keeps the approved page sizes', () => {
    expect(PAGE_SIZES.gladiators).toBe(7);
    expect(PAGE_SIZES.market).toBe(3);
    // Task 31 fix round 1: fewer notifications and messages a page so a page fits the popover; the Tournaments lists each have an id of their own.
    expect([PAGE_SIZES.notifications, PAGE_SIZES.messages]).toEqual([6, 3]);
    expect(PAGE_SIZES.titles).toBe(4);
    expect([PAGE_SIZES.tournaments, PAGE_SIZES.tournamentBouts, PAGE_SIZES.placements]).toEqual([6, 6, 6]);
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

  it('maps a slide on a windowed row from the pressed circle, so a still finger stays on it', () => {
    // A row 200 px wide across 30 pages: about 6.9 px a page.
    expect(slidePage(6, 0, 200, 30)).toBe(6);
    expect(slidePage(6, 3, 200, 30)).toBe(6);
    expect(slidePage(6, 7, 200, 30)).toBe(7);
    expect(slidePage(6, -14, 200, 30)).toBe(4);
    expect(slidePage(6, 200, 200, 30)).toBe(30);
    expect(slidePage(6, -500, 200, 30)).toBe(1);
    expect(slidePage(3, 50, 0, 8)).toBe(3);
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

  it('keeps a jump requested during an in-flight cursor read and lands on it when the rows commit', async () => {
    const c = createPageController();
    let finish!: () => void;
    const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    c.sync(input(14, { hasMore: true }), load);
    c.go(2);
    c.next(); // Ask for page 3.
    expect(c.view()).toMatchObject({ page: 2, busy: true });

    c.goToIndex(28); // Page 5. The same response will contain it.
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.view().page).toBe(2);

    finish();
    await Promise.resolve();
    await Promise.resolve();
    // The load promise can settle before the caller's setState is committed.
    c.sync(input(35, { hasMore: false }));
    expect(c.view()).toMatchObject({ page: 5, jump: 28, target: 5, busy: false });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('can jump to an already loaded row on a partial page when no loader is supplied', () => {
    const c = createPageController();
    c.sync(input(50, { hasMore: true }));
    c.goToIndex(49); // Row 50 is present. Only the first seven pages are full.
    expect(c.view()).toMatchObject({ page: 8, jump: 49, target: 8 });
  });

  for (const stateCommitsFirst of [true, false]) {
    it(`does not issue a focus turn when the cursor is exhausted without adding rows (state commits ${stateCommitsFirst ? 'first' : 'after settlement'})`, async () => {
      const c = createPageController();
      let finish!: () => void;
      const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
      c.sync(input(14, { hasMore: true }), load);
      c.go(2);
      const before = c.view().turn;

      c.next();
      expect(c.view()).toMatchObject({ page: 2, busy: true, turn: before });
      if (stateCommitsFirst) c.sync(input(14));
      finish();
      await Promise.resolve();
      await Promise.resolve();
      if (!stateCommitsFirst) c.sync(input(14));

      expect(c.view()).toMatchObject({ page: 2, pages: 2, busy: false, failed: false, turn: before });
      expect(load).toHaveBeenCalledTimes(1);
    });
  }

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

  it('only knows full pages while more can be read, so the partly loaded last page is read first', async () => {
    const c = createPageController();
    let finish!: () => void;
    const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    c.sync(input(50, { hasMore: true }), load);
    expect(c.view()).toMatchObject({ pages: null, knownPages: 7 });
    c.go(8);
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.view().page).toBe(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    c.sync(input(100, { hasMore: true }), load);
    expect(c.view().page).toBe(8);
    // Next from the last full page reads more before it shows the rows after it.
    const d = createPageController();
    const more = vi.fn(() => Promise.resolve());
    d.sync(input(50, { hasMore: true }), more);
    d.go(7);
    d.next();
    expect(more).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    d.sync(input(55, { hasMore: false }), more);
    expect(d.view()).toMatchObject({ page: 8, pages: 8 });
  });

  it('reads more and stays on page 1 when even page 1 is not full yet', async () => {
    const c = createPageController();
    const load = vi.fn(() => Promise.resolve());
    c.sync(input(3, { hasMore: true }), load);
    expect(c.view().knownPages).toBe(1);
    c.next();
    expect(load).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    c.sync(input(20, { hasMore: false }), load);
    expect(c.view().page).toBe(1);
  });

  it('keeps the first row on screen when the size prop changes (a grid 24 to 15)', () => {
    const c = createPageController();
    c.sync(input(100, { size: 24 }));
    c.go(3); // rows 48..71
    c.sync(input(100, { size: 15 }));
    expect(c.view().page).toBe(pageOfIndex(48, 15));
  });

  it('is not busy after a reset during a read', () => {
    const c = createPageController();
    c.sync(input(7, { hasMore: true }), () => new Promise(() => {}));
    c.next();
    expect(c.view().busy).toBe(true);
    c.sync(input(7, { hasMore: true, resetKey: 'x' }), () => new Promise(() => {}));
    expect(c.view().busy).toBe(false);
  });

  it('keeps a jump past the loaded rows until they arrive', () => {
    const c = createPageController();
    c.sync(input(50));
    c.goToIndex(80);
    expect(c.view()).toMatchObject({ page: 8, target: 12 });
    c.sync(input(100));
    expect(c.view().page).toBe(12);
  });

  it('keeps a jump made on open when the saved Show choice applies (fix round 2, R2-2)', () => {
    const c = createPageController();
    c.sync(input(50, { size: 7 }));
    c.goToIndex(28);
    c.sync(input(50, { size: 25 }));
    expect(c.view()).toMatchObject({ page: 2, jump: 28 });
  });

  it('reads once to reach a loaded row past the full pages of a cursor list (fix round 2, R2-3)', async () => {
    const c = createPageController();
    const load = vi.fn(() => Promise.resolve());
    c.sync(input(50, { hasMore: true }), load);
    c.goToIndex(49);
    c.goToIndex(49);
    expect(load).toHaveBeenCalledTimes(1);
    // While it reads, the list stays where it was.
    expect(c.view()).toMatchObject({ page: 1, busy: true });
    await Promise.resolve();
    await Promise.resolve();
    c.sync(input(100, { hasMore: true }), load);
    expect(c.view()).toMatchObject({ page: 8, jump: 49 });
    // The server had no more: the last page shows.
    const d = createPageController();
    d.sync(input(50, { hasMore: true }), () => Promise.resolve());
    d.goToIndex(49);
    await Promise.resolve();
    await Promise.resolve();
    d.sync(input(50, { hasMore: false }), null);
    expect(d.view().page).toBe(8);
  });

  it('a read that a reset left behind never clears a newer read (fix round 2, R2-4)', async () => {
    const c = createPageController();
    let finishOld!: () => void;
    c.sync(input(7, { hasMore: true }), () => new Promise<void>(resolve => { finishOld = resolve; }));
    c.next();
    c.sync(input(7, { hasMore: true, resetKey: 'x' }), () => new Promise<void>(() => {}));
    c.next();
    expect(c.view().busy).toBe(true);
    finishOld();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.view().busy).toBe(true);
  });

  it('jumps to the page that holds a row', () => {
    const c = createPageController();
    c.sync(input(50));
    c.goToIndex(30);
    expect(c.view().page).toBe(5);
    expect(c.view().jump).toBe(30);
  });
});

describe('the paging scope and the keys', () => {
  it('gives a popover its own scope, never the menu around it', () => {
    const menu: PanelScope = { slot: {} as HTMLElement, panel: {} as HTMLElement };
    let seen: PanelScope | null | undefined;
    const Probe = () => { seen = usePanelScope(); return null; };
    const html = renderToStaticMarkup(createElement(PanelScopeContext.Provider, { value: menu },
      createElement(PagingScope, { className: 'pop', children: createElement(Probe) })));
    expect(seen).not.toBe(menu);
    expect(seen).toEqual({ slot: null, panel: null });
    expect(html).toContain('data-paging-scope');
    expect(html).toContain('data-panel-footer');
  });

  it('acts on a key only in its own scope, not a PagingScope inside it (fix round 2, R2-6)', () => {
    const menu = {} as Element, scope = {} as Element;
    const inScope = (owner: Element | null) => ({ closest: () => owner }) as unknown as Element;
    expect(keyInPanel(inScope(menu), menu)).toBe(true);
    expect(keyInPanel(inScope(scope), menu)).toBe(false);
    expect(keyInPanel(inScope(null), menu)).toBe(true);
  });

  it('leaves the arrows to controls that use them, and PageDown to text fields only', () => {
    const at = (selectors: string[]) => ({ closest: (query: string) => (selectors.some(s => query.split(', ').includes(s)) ? {} : null) }) as unknown as Element;
    for (const owner of ['[role="grid"]', '[role="listbox"]', '[role="tablist"]', '[role="radiogroup"]', '[role="menu"]', '[role="toolbar"]', '[role="slider"]', '[data-arrow-keys]', 'input', 'select', 'textarea']) {
      expect(ownsKeys(at([owner]), 'ArrowRight'), owner).toBe(true);
    }
    expect(ownsKeys(at(['[role="grid"]']), 'PageDown')).toBe(false);
    expect(ownsKeys(at(['input']), 'PageDown')).toBe(true);
    expect(ownsKeys(at([]), 'ArrowLeft')).toBe(false);
    expect(ownsKeys(null, 'PageUp')).toBe(false);
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
