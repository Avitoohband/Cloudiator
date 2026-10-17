// The left-edge menu rail as a pure state machine (spec "Screen"): whether the rail is shown, and which panel is open.
// The component owns the pointer and focus listeners and the 300 ms timer; this reducer only decides.
import type { MenuId } from './menus';

/** The pointer reveals the rail within this many pixels of the left edge (or over the grip). */
export const EDGE_PX = 12;
/** The rail slides away this long after the pointer leaves it, unless a panel is open. */
export const RAIL_HIDE_MS = 300;
/**
 * The touch layout (shell.module.css): no hover (plan Decision 3), or a window too narrow for a panel beside the rail.
 * There the ☰ button shows and hides the icons; the pointer and focus do not.
 */
export const COMPACT_QUERY = '(hover: none), (max-width: 480px)';

export type RailState = { revealed: boolean; open: MenuId | null };
export type RailEvent = 'edge-enter' | 'leave' | 'leave-timeout' | 'focus-in' | 'focus-out' | { toggle: MenuId } | 'escape' | 'camp-click';

const same = (state: RailState, revealed: boolean, open: MenuId | null): RailState =>
  state.revealed === revealed && state.open === open ? state : { revealed, open };

/**
 * - `edge-enter` (the pointer near the edge, over the grip or the rail) and `focus-in` reveal the rail.
 * - `leave` changes nothing: the caller starts the 300 ms timer, whose `leave-timeout` hides the rail unless a panel is
 *   open. `focus-out` (focus has left the rail) hides it the same way.
 * - `{ toggle }` opens that panel, replacing any other, or closes it when it is the open one; the rail stays shown.
 * - `escape` closes the open panel and keeps the rail for its icon, which takes the focus back.
 * - `camp-click` closes the panel and hides the rail.
 */
export function railReducer(state: RailState, event: RailEvent): RailState {
  if (typeof event === 'object') return same(state, true, state.open === event.toggle ? null : event.toggle);
  switch (event) {
    case 'edge-enter':
    case 'focus-in': return same(state, true, state.open);
    case 'leave': return state;
    case 'leave-timeout':
    case 'focus-out': return same(state, state.open !== null, state.open);
    case 'escape': return state.open === null ? state : same(state, true, null);
    case 'camp-click': return same(state, false, null);
  }
}
