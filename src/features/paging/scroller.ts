// Patch 1.9 final review M11: the one "nearest box that scrolls" helper of the paged menus (`usePagedList`, `shell/section-change`,
// `inventory/phone-card`).

/**
 * The nearest ancestor of `element` that scrolls (overflow-y `auto` or `scroll`): the menu's body, or a box inside it. With `overflowing`, only
 * one whose content is taller than it now: the Show choice (`usePagedList`) measures the rows on screen against the part that really scrolls,
 * passing over a box that could scroll but does not. A section change (scrolled back to its top) and the phone card (laid over what it can see)
 * want the box itself, whether it overflows yet or not.
 */
export function scroller(element: HTMLElement, overflowing = false): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && (!overflowing || node.scrollHeight > node.clientHeight)) return node;
  }
  return null;
}
