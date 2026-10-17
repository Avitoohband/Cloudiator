'use client';

// Task 13.7: what the shell does with clicks in the camp world. A click on a gladiator (`select-character`) opens their
// profile card beside them, and a list row opens the same card with the focus (which goes back to that row when the
// card closes). One surface at a time: a menu that opens, closes or changes closes the card, so an Arena entrant's click
// shows its Arena card. A click on a merchant (`open-merchant`) opens Inventory and shops at that merchant for a player,
// counted so every click opens the shops there again, and My gladiator's sign-in prompt for anyone else.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorldSnapshot } from '@contracts/reads';
import type { Merchant } from '@domain/inventory';
import type { SceneBridge } from '../../game/bridge';
import type { ProfileTarget } from '../character/ProfileCard';
import type { Viewer } from '../character/useGameState';
import type { MenuId } from './menus';

/** The open profile card: whose, how it was opened, and where the focus goes back when it closes. */
export type OpenCard = ProfileTarget & { n: number; returnTo: HTMLElement | null };

export function useCampClicks({ bridge, open, viewer, world, show, focusCamp }: {
  bridge: SceneBridge;
  /** The open menu, or null. */
  open: MenuId | null;
  viewer: Viewer;
  world: WorldSnapshot | null;
  show(id: MenuId): void;
  /** Gives the keyboard to the camp view (a closed card that had no row to go back to). */
  focusCamp(): void;
}) {
  const [card, setCard] = useState<OpenCard | null>(null);
  const [shop, setShop] = useState<{ merchant: Merchant; request: number } | null>(null);
  const cards = useRef(0);
  const cardRef = useRef(card), viewerRef = useRef(viewer), worldRef = useRef(world);
  useEffect(() => { cardRef.current = card; viewerRef.current = viewer; worldRef.current = world; });

  const openCard = useCallback((target: ProfileTarget) => {
    const active = document.activeElement;
    setCard({ ...target, n: ++cards.current, returnTo: target.focus && active instanceof HTMLElement ? active : null });
  }, []);
  const closeCard = useCallback((giveFocusBack: boolean) => {
    const current = cardRef.current;
    setCard(null);
    if (!giveFocusBack || !current) return;
    if (current.returnTo?.isConnected) current.returnTo.focus({ preventScroll: true });
    else focusCamp();
  }, [focusCamp]);
  /** A list row's card: the gladiator's world name until the card resolves them. */
  const openRow = useCallback((gladiatorId: string, record: ProfileTarget['record'] = null, name?: string) => openCard({
    gladiatorId, name: name ?? worldRef.current?.actors.find(a => a.gladiatorId === gladiatorId)?.name ?? '', screen: null, record, focus: true,
  }), [openCard]);

  useEffect(() => { setCard(null); }, [open]);
  useEffect(() => { if (open !== 'inventory') setShop(null); }, [open]);

  // A gladiator's click: the card beside them, and the camp keeps the focus.
  useEffect(() => bridge.on('select-character', ({ gladiatorId, screen }) => {
    openCard({ gladiatorId, name: worldRef.current?.actors.find(a => a.gladiatorId === gladiatorId)?.name ?? '', screen, record: null, focus: false });
  }), [bridge, openCard]);
  useEffect(() => bridge.on('open-merchant', ({ merchant }) => {
    if (viewerRef.current !== 'player') { show('gladiator'); return; }
    setShop(current => ({ merchant: merchant === 'weapons' ? 'weaponsmith' : 'armorer', request: (current?.request ?? 0) + 1 }));
    show('inventory');
  }), [bridge, show]);

  return { card, cardRef, openRow, closeCard, shop };
}
