// Patch 1.9, Task 21 (a review leftover, folded into 1.9): on a phone a tapped inventory tile or shop cell did not show its card.
// The touch layout puts the card under its grid, often below the menu's visible part, so after a tap (or Enter) the nearest
// scrolling ancestor (the menu's body; never the page) moves the least that shows the card: all of it, or from its top when it is
// taller than the view. A pointer window shows the card beside its grid and moves nothing.
import { COMPACT_QUERY } from '../shell/rail-reveal';

export function revealCard(card: HTMLElement | null): void {
  if (!card || !window.matchMedia?.(COMPACT_QUERY).matches) return;
  for (let parent = card.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
    const box = card.getBoundingClientRect(), view = parent.getBoundingClientRect();
    const top = Math.max(view.top, 0), bottom = Math.min(view.bottom, window.innerHeight);
    if (box.top < top) parent.scrollTop -= top - box.top;
    else if (box.bottom > bottom) parent.scrollTop += Math.min(box.bottom - bottom, box.top - top);
    return;
  }
}
