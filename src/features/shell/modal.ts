'use client';

// Whether a modal dialog is open: a scene, the creation or change-look dialog, a confirmation (`dialog:modal`, Safari 15.6+, within the
// project's Safari 16.4 floor). One check for the shell's keyboard rules and the reload notice, which waits under any of them.
import { useSyncExternalStore } from 'react';

/** Whether a modal dialog is open now. */
export const modalOpen = (): boolean => document.querySelector('dialog:modal') !== null;

/** Watches the page for a dialog that opens or closes (its `open` attribute) or leaves the page. */
const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  return () => observer.disconnect();
};

/** Whether a modal dialog is open, kept up to date as dialogs open and close (false in the server render). */
export function useModalOpen(): boolean {
  return useSyncExternalStore(subscribe, modalOpen, () => false);
}
