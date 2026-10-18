// The camp's menu registry: the rail icons in order, their exact accessible names, and which a visitor sees: the eight
// menus of the full-screen camp spec. Task 18 added the 💰 Marketplace between Inventory and shops, and Arena (Task 18 plan
// Decision 11); a visitor browses its listings only.
import type { Viewer } from '../character/useGameState';

export type MenuId = 'gladiator' | 'schedule' | 'inventory' | 'market' | 'arena' | 'tournaments' | 'results' | 'gladiators';
export type MenuDef = { id: MenuId; icon: string; label: string; visitor: boolean };

export const MENUS: readonly MenuDef[] = [
  { id: 'gladiator', icon: '🛡', label: 'My gladiator', visitor: true },
  { id: 'schedule', icon: '🗓', label: 'Schedule', visitor: false },
  { id: 'inventory', icon: '🎒', label: 'Inventory and shops', visitor: false },
  { id: 'market', icon: '💰', label: 'Marketplace', visitor: true },
  { id: 'arena', icon: '⚔', label: 'Arena', visitor: true },
  { id: 'tournaments', icon: '🏆', label: 'Tournaments', visitor: true },
  { id: 'results', icon: '📜', label: 'Results', visitor: true },
  { id: 'gladiators', icon: '👥', label: 'Gladiators', visitor: true },
];

/** A player's menus: all eight. Every other viewer (a visitor, no gladiator yet, loading, unavailable): the six public ones. */
export function menusFor(viewer: Viewer): MenuDef[] {
  return MENUS.filter(menu => viewer === 'player' || menu.visitor);
}
