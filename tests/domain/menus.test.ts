import { describe, expect, it } from 'vitest';
import { MENUS, menusFor } from '@/features/shell/menus';

describe('the camp menus', () => {
  it('lists the seven menus in rail order with their icons and exact labels, and no Marketplace', () => {
    expect(MENUS.map(m => [m.id, m.icon, m.label, m.visitor])).toEqual([
      ['gladiator', '🛡', 'My gladiator', true],
      ['schedule', '🗓', 'Schedule', false],
      ['inventory', '🎒', 'Inventory and shops', false],
      ['arena', '⚔', 'Arena', true],
      ['tournaments', '🏆', 'Tournaments', true],
      ['results', '📜', 'Results', true],
      ['gladiators', '👥', 'Gladiators', true],
    ]);
    expect(MENUS.some(m => /market/i.test(m.label))).toBe(false);
  });

  it('gives a player all seven and every other viewer only the five visitor menus', () => {
    expect(menusFor('player').map(m => m.label)).toEqual(MENUS.map(m => m.label));
    for (const viewer of ['visitor', 'no-gladiator', 'loading', 'unavailable'] as const) {
      expect(menusFor(viewer).map(m => m.label), viewer).toEqual(['My gladiator', 'Arena', 'Tournaments', 'Results', 'Gladiators']);
    }
  });
});
