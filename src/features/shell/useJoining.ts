'use client';

// Joining (Task 13.6, moved out of CampShell in 13.7): signed in without a gladiator, the "Create your gladiator" dialog
// opens over the running camp once per account and page load; the chip and My gladiator offer it again. A visitor's
// sign-in starts the count again. Once created, the dialog closes and My gladiator shows the new gladiator once its owner
// state is read.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Viewer } from '../character/useGameState';
import type { MenuId } from './menus';

export function useJoining({ viewer, account, refreshOwner, show }: {
  viewer: Viewer;
  /** The signed-in account, or null. */
  account: string | null;
  refreshOwner(): Promise<void>;
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
  const created = useCallback(() => {
    setCreating(false);
    void refreshOwner().catch(() => undefined).finally(() => show('gladiator'));
  }, [refreshOwner, show]);
  return { creating: creating && viewer === 'no-gladiator', offer: useCallback(() => setCreating(true), []), dismiss: useCallback(() => setCreating(false), []), created };
}
