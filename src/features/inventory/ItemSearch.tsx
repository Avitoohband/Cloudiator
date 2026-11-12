'use client';

import { useRef, type KeyboardEvent } from 'react';
import type { SortKey } from './item-query';
import styles from './InventoryPanel.module.css';

/**
 * The search field and the Sort select above an item grid (Patch 1.9, the approved search mockup), shared by the Inventory and the
 * Shops. Escape clears a typed search (an empty field leaves Escape to close the menu as it always did); the × button clears it
 * and puts the focus back in the field. The Sort select turns gold when it is not on its default. Each panel names its search
 * landmark, field and Sort (`label`, `sortLabel`: "Search your items", "Sort the shops"), so the two in one menu are told apart.
 */
export function ItemSearch({ query, setQuery, sorts, sort, setSort, label, sortLabel }: {
  query: string; setQuery(query: string): void; sorts: readonly [SortKey, string][]; sort: SortKey; setSort(sort: SortKey): void;
  label: string; sortLabel: string;
}) {
  const field = useRef<HTMLInputElement>(null);
  const changed = sort !== sorts[0][0] ? '' : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && query !== '') { event.preventDefault(); event.stopPropagation(); setQuery(''); }
  };
  return <div className={styles.searchRow}>
    <div className={styles.search} role="search" aria-label={label}>
      <svg className={styles.magnifier} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M10 10l4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
      <input ref={field} type="search" autoComplete="off" aria-label={label} placeholder="Search by name" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} />
      {query !== '' && <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => { setQuery(''); field.current?.focus(); }}>&times;</button>}
    </div>
    <label className={styles.sort} data-changed={changed}>Sort
      <select aria-label={sortLabel} value={sort} data-changed={changed} onChange={event => setSort(event.target.value as SortKey)}>
        {sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
  </div>;
}

/**
 * What the grid shows when nothing matches: the typed text and a button that clears it. `filter` names the chosen filter chip when
 * it hides matches that All would show ("No match for “sword” in Armor"). Not a live region: `MatchCount` announces it, once.
 */
export function NoMatch({ query, clear, filter }: { query: string; clear(): void; filter?: string }) {
  return <div className={styles.noMatch}>
    <span>{filter ? 'No match for' : 'No items match'} &ldquo;<b>{query.trim()}</b>&rdquo;{filter ? ` in ${filter}` : ''}</span>
    <button type="button" onClick={clear}>Clear search</button>
  </div>;
}

/**
 * The line under the grid: how many items match the typed text (with no match, in the filter that hides matches, as `NoMatch`); `idle`
 * is what it says while nothing is typed. It stays mounted so the first count is announced.
 */
export function MatchCount({ count, query, idle = '', filter }: { count: number; query: string; idle?: string; filter?: string }) {
  const text = query.trim();
  return <p className={styles.matchCount} role="status">{text ? `${count} item${count === 1 ? '' : 's'} match “${text}”${count === 0 && filter ? ` in ${filter}` : ''}` : idle}</p>;
}
