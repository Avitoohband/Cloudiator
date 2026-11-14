// Patch 1.9 Task 32: the Show choice a player saves on this device ("Show: 50" under a paged list), set before every page load of `context`.
// The server lists (standings, results, bouts, the Marketplace, history) show a few rows a page; a spec about what a row says or does, not
// about paging, asks for Show 50 so every row it reads is on the page, as the player's own choice would. A spec about paging does not call it.
import type { BrowserContext } from '@playwright/test';
import { PAGE_SIZE_KEY } from '../../src/features/paging/page-size-prefs';

export async function showChoice(context: BrowserContext, sizes: Record<string, number>): Promise<void> {
  await context.addInitScript(({ key, sizes }) => {
    try { localStorage.setItem(key, JSON.stringify(sizes)); } catch { /* No storage: the list shows Fit. */ }
  }, { key: PAGE_SIZE_KEY, sizes });
}
