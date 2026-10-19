'use client';

// Joining (Task 13.6, moved out of CampShell in 13.7): signed in without a gladiator, the "Create your gladiator" dialog
// opens over the running camp once per account and page load; the chip and My gladiator offer it again. A visitor's
// sign-in starts the count again. Once created, the dialog closes and My gladiator shows the new gladiator from the owner
// state the dialog read to confirm it (Task 23.4, C6: no second read; the world the creation changed is read at once).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerState } from '@contracts/reads';
import type { Viewer } from '../character/useGameState';
import type { MenuId } from './menus';

export function useJoining({ viewer, account, ownerCreated, show }: {
  viewer: Viewer;
  /** The signed-in account, or null. */
  account: string | null;
  /** Shows the created gladiator's owner state (`GameUiState.ownerCreated`). */
  ownerCreated(owner: OwnerState): void;
  /** Opens a menu (My gladiator, once the gladiator exists). */
  show(id: MenuId): void;
}) {
  const [creating, setCreating] = useState(false);
  const offered = useRef<string | null>(null);
  useEffect(() => {
    if (viewer === 'visitor') offered.current = null;
    if (viewer !== 'no-gladiator') { setCreating(false); return; }
    if (account !== null && offered.current !== account) { offered.current = account; setCreating(true); }
  }, [viewer, account]);
  const created = useCallback((owner: OwnerState) => {
    setCreating(false);
    ownerCreated(owner);
    show('gladiator');
  }, [ownerCreated, show]);
  return { creating: creating && viewer === 'no-gladiator', offer: useCallback(() => setCreating(true), []), dismiss: useCallback(() => setCreating(false), []), created };
}
