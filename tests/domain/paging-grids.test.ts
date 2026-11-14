import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePagedList } from '../../src/features/paging/usePagedList';
import { inOtherModal } from '../../src/features/paging/usePageKeys';

// Patch 1.9 Task 33 fix round 1: two add-only foundation changes for the grids and the menus' modal dialogs.

describe('a grid pages without a list id (review Minor 6)', () => {
  it('takes its fixed size and pages its tiles with no Show choice', () => {
    const seen: { rows: readonly string[]; size: number; fit: number; pages: number | null }[] = [];
    function Grid() {
      const paged = usePagedList(['a', 'b', 'c', 'd', 'e'], { size: 2 });
      seen.push({ rows: paged.rows, size: paged.size, fit: paged.fit, pages: paged.pages });
      return createElement('p', null, paged.rows.join(','));
    }
    expect(renderToStaticMarkup(createElement(Grid))).toBe('<p>a,b</p>');
    expect(seen.at(-1)).toEqual({ rows: ['a', 'b'], size: 2, fit: 2, pages: 3 });
  });

  it('still takes a list with its Fit (the lists of lanes A and B)', () => {
    let fit = 0;
    function List() { fit = usePagedList(['a'], { list: 'gladiators' }).fit; return null; }
    renderToStaticMarkup(createElement(List));
    expect(fit).toBe(7);
  });
});

describe('page and section keys leave a modal dialog in the panel alone (review Minor 8)', () => {
  /** A fake element: its nearest open <dialog>, and what it contains. */
  const element = (dialog: Element | null, inside: Element[] = []) => {
    const self = { closest: (query: string) => (query === 'dialog[open]' ? dialog : null), contains: (other: Element) => other === (self as unknown) || inside.includes(other) };
    return self as unknown as Element;
  };

  it('ignores a key in an open dialog inside the panel (the discard confirmation)', () => {
    const dialog = element(null);
    const panel = element(null, [dialog]);
    expect(inOtherModal(element(dialog), panel)).toBe(true);
  });

  it('acts on a key outside any dialog, or in a dialog that holds the panel (a PagingScope in a dialog)', () => {
    const panel = element(null);
    expect(inOtherModal(element(null), panel)).toBe(false);
    const outer = element(null, [panel]);
    expect(inOtherModal(element(outer), panel)).toBe(false);
    expect(inOtherModal(element(panel), panel)).toBe(false);
  });
});
