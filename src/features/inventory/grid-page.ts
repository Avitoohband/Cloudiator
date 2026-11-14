'use client';

// Patch 1.9 Task 33 (menus with Back and Next): the Inventory's and the Shops' grids show one page of whole rows, 6 x 4 = 24 tiles where the
// grid has six columns and 5 x 3 = 15 where it has five (the phone's sheet, and a narrow desktop panel). The columns are the CSS's
// (`InventoryPanel.module.css`: five in the touch layout and in a panel up to NARROW_GRID_PX wide); this hook reads the same two facts, so
// the page size always matches the columns drawn. A panel that is not laid out (a hidden section) keeps the size it had.
import { useLayoutEffect, useState, type RefObject } from 'react';
import { GRID_PAGE } from '../paging/paging';
import { useCompactLayout } from '../paging/useCompactLayout';

/** The widest panel whose grid has five columns (the container query in InventoryPanel.module.css). */
export const NARROW_GRID_PX = 370;

/** The grid's layout: 'phone' (five columns, 15 a page) in the touch layout or a narrow panel, else 'desktop' (six columns, 24 a page). */
export function gridLayout(compact: boolean, width: number): keyof typeof GRID_PAGE {
  return compact || width <= NARROW_GRID_PX ? 'phone' : 'desktop';
}

/** The tiles a grid page holds in `panel` (the inventory's container), followed as the panel or the layout changes. */
export function useGridPage(panel: RefObject<HTMLElement | null>): number {
  const compact = useCompactLayout();
  const [layout, setLayout] = useState<keyof typeof GRID_PAGE>('desktop');
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setLayout(gridLayout(compact, width));
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [panel, compact]);
  return GRID_PAGE[layout];
}

/** A grid page's columns: six for a page of 24, five for 15 (Task 33 fix round 1). */
export const gridColumns = (size: number): number => (size === GRID_PAGE.desktop ? 6 : 5);

/** The empty cells that finish a page's last row of `count` tiles: a whole row when there is no tile (Task 33 fix round 1). */
export const rowFill = (count: number, columns: number): number => (count === 0 ? columns : (columns - (count % columns)) % columns);
