// The camp's menu registry: the rail icons in order, their exact accessible names, and which a visitor sees. The
// Marketplace is not listed: Task 18 builds it and adds its entry (plan Decision 2).
import type { Viewer } from '../character/useGameState';

export type MenuId = 'gladiator' | 'schedule' | 'inventory' | 'arena' | 'tournaments' | 'results' | 'gladiators';
export type MenuDef = { id: MenuId; icon: string; label: string; visitor: boolean };

export const MENUS: readonly MenuDef[] = [
  { id: 'gladiator', icon: '🛡', label: 'My gladiator', visitor: true },
  { id: 'schedule', icon: '🗓', label: 'Schedule', visitor: false },
  { id: 'inventory', icon: '🎒', label: 'Inventory and shops', visitor: false },
  { id: 'arena', icon: '⚔', label: 'Arena', visitor: true },
  { id: 'tournaments', icon: '🏆', label: 'Tournaments', visitor: true },
  { id: 'results', icon: '📜', label: 'Results', visitor: true },
  { id: 'gladiators', icon: '👥', label: 'Gladiators', visitor: true },
];

/** A player's menus: all seven. Every other viewer (a visitor, no gladiator yet, loading, unavailable): the five public ones. */
export function menusFor(viewer: Viewer): MenuDef[] {
  return MENUS.filter(menu => viewer === 'player' || menu.visitor);
}
