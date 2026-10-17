import { describe, expect, it } from 'vitest';
import { EDGE_PX, RAIL_HIDE_MS, railReducer, type RailState } from '@/features/shell/rail-reveal';

const rest: RailState = { revealed: false, open: null };
const run = (state: RailState, ...events: Parameters<typeof railReducer>[1][]) => events.reduce(railReducer, state);

describe('the menu rail', () => {
  it('reveals within 12 px of the left edge and hides 300 ms after the pointer leaves', () => {
    expect([EDGE_PX, RAIL_HIDE_MS]).toEqual([12, 300]);
    const shown = railReducer(rest, 'edge-enter');
    expect(shown).toEqual({ revealed: true, open: null });
    // Leaving only starts the 300 ms timer; its timeout hides the rail.
    expect(railReducer(shown, 'leave')).toEqual(shown);
    expect(run(shown, 'leave', 'leave-timeout')).toEqual(rest);
  });

  it('keeps the rail while a panel is open, and opens one panel at a time', () => {
    const open = run(rest, 'edge-enter', { toggle: 'schedule' });
    expect(open).toEqual({ revealed: true, open: 'schedule' });
    expect(run(open, 'leave', 'leave-timeout')).toEqual(open);
    expect(run(open, 'focus-out')).toEqual(open);
    // Another icon replaces the open panel; the same icon closes it and leaves the rail shown under the pointer.
    expect(railReducer(open, { toggle: 'arena' })).toEqual({ revealed: true, open: 'arena' });
    expect(railReducer(open, { toggle: 'schedule' })).toEqual({ revealed: true, open: null });
  });

  it('closes the panel on Escape but keeps the rail for the focused icon, and closes everything on a camp click', () => {
    const open = run(rest, { toggle: 'gladiators' });
    expect(railReducer(open, 'escape')).toEqual({ revealed: true, open: null });
    expect(railReducer(rest, 'escape')).toEqual(rest);
    expect(railReducer(open, 'camp-click')).toEqual(rest);
    expect(railReducer({ revealed: true, open: null }, 'camp-click')).toEqual(rest);
  });

  it('reveals for keyboard focus and hides when focus leaves the rail with no panel open', () => {
    const focused = railReducer(rest, 'focus-in');
    expect(focused).toEqual({ revealed: true, open: null });
    expect(railReducer(focused, 'focus-out')).toEqual(rest);
  });

  it('returns the same state when nothing changes, so React skips the render', () => {
    const shown = railReducer(rest, 'edge-enter');
    expect(railReducer(shown, 'edge-enter')).toBe(shown);
    expect(railReducer(rest, 'leave-timeout')).toBe(rest);
    expect(railReducer(rest, 'camp-click')).toBe(rest);
  });
});
