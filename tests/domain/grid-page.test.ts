import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GRID_PAGE } from '../../src/features/paging/paging';
import { NARROW_GRID_PX, gridLayout } from '../../src/features/inventory/grid-page';
import { GLADIATOR_SECTIONS } from '../../src/features/character/CharacterPanel';
import { INVENTORY_SECTIONS } from '../../src/features/inventory/InventoryPanel';

// Patch 1.9 Task 33 (menus with Back and Next): the Inventory's and the Shops' grids page whole rows, and My gladiator and Inventory and
// shops open as named sections.

describe('the grid page', () => {
  it('holds four rows of six on a desktop panel and three rows of five on a phone or a narrow panel', () => {
    expect(GRID_PAGE.desktop % 6).toBe(0);
    expect(GRID_PAGE.phone % 5).toBe(0);
    expect(gridLayout(false, 676)).toBe('desktop');
    expect(gridLayout(false, NARROW_GRID_PX + 1)).toBe('desktop');
    expect(gridLayout(false, NARROW_GRID_PX)).toBe('phone');
    expect(gridLayout(false, 352)).toBe('phone');
    // The touch layout has five columns at any width (a wide tablet too).
    expect(gridLayout(true, 740)).toBe('phone');
  });

  it('matches the stylesheet: five columns in a panel up to NARROW_GRID_PX wide and in the touch layout', () => {
    const css = readFileSync('src/features/inventory/InventoryPanel.module.css', 'utf8');
    expect(css).toContain(`@container (max-width: ${NARROW_GRID_PX}px) {\n  .grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }`);
    expect(css).toMatch(/@media \(hover: none\), \(max-width: 480px\) \{\n {2}\.gridScroll \{ min-height: 194px; \}\n(?: {2}\/\*[^\n]*\*\/\n)? {2}\.grid \{ grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
  });
});

describe('the named sections', () => {
  it('names My gladiator\'s five sections and the Inventory\'s two, in the approved order', () => {
    expect(GLADIATOR_SECTIONS.map(section => section.name)).toEqual(['Overview', 'Level and stamina', 'Attributes and stats', 'Worn equipment', 'History']);
    expect(INVENTORY_SECTIONS.map(section => section.name)).toEqual(['Inventory', 'Shops']);
    expect(new Set([...GLADIATOR_SECTIONS, ...INVENTORY_SECTIONS].map(section => section.id)).size).toBe(7);
  });
});
