// Patch 1.9 Task 30: the Show choice (rows per page) per list, on this device only (`localStorage`), every access in try/catch,
// with this page's memory as the fallback where the storage is blocked. A value that is not one of the list's choices reads as Fit.
import { showChoices, type ListId } from './paging';

export const PAGE_SIZE_KEY = 'cloudiator.page-size.v1';

/** Choices made on this page where the storage could not keep them. */
let remembered: Partial<Record<ListId, number>> = {};

function saved(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PAGE_SIZE_KEY) ?? 'null');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The rows a page of `list` shows on this device: the saved choice when it is one of `showChoices(fit)`, else Fit. */
export function readPageSize(list: ListId, fit: number): number {
  const value = remembered[list] ?? saved()[list];
  return typeof value === 'number' && showChoices(fit).includes(value) ? value : fit;
}

export function writePageSize(list: ListId, size: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, JSON.stringify({ ...saved(), [list]: size }));
    delete remembered[list];
  } catch {
    remembered = { ...remembered, [list]: size };
  }
}

/** Tests only: forget the page's own memory. */
export function resetPageSizeMemory(): void {
  remembered = {};
}
