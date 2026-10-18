import { describe, expect, it } from 'vitest';
import { MENUS, menusFor } from '@/features/shell/menus';

describe('the camp menus', () => {
  it('lists the eight menus in rail order with their icons and exact labels, the Marketplace after Inventory and shops', () => {
    expect(MENUS.map(m => [m.id, m.icon, m.label, m.visitor])).toEqual([
      ['gladiator', '🛡', 'My gladiator', true],
      ['schedule', '🗓', 'Schedule', false],
      ['inventory', '🎒', 'Inventory and shops', false],
      ['market', '💰', 'Marketplace', true],
      ['arena', '⚔', 'Arena', true],
      ['tournaments', '🏆', 'Tournaments', true],
      ['results', '📜', 'Results', true],
      ['gladiators', '👥', 'Gladiators', true],
    ]);
  });

  it('gives a player all eight and every other viewer only the six visitor menus', () => {
    expect(menusFor('player').map(m => m.label)).toEqual(MENUS.map(m => m.label));
    for (const viewer of ['visitor', 'no-gladiator', 'loading', 'unavailable'] as const) {
      expect(menusFor(viewer).map(m => m.label), viewer).toEqual(['My gladiator', 'Marketplace', 'Arena', 'Tournaments', 'Results', 'Gladiators']);
    }
  });
});
