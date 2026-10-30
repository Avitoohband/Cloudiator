'use client';

// "A new patch is out — reload" (Patch A spec, "Patch numbers and the changelog", Client; Avi approved the mockup in chat, 2026-10-29): a
// status in the notice column under the chip, drawn like the sign-in notice, when the server's newest patch is ahead of this build. Desktop:
// "A new patch is out — reload to play Patch 1.5." with a gold Reload and × (named Later); a phone: "Patch 1.5 is out", Reload and ×. The
// shell decides when it shows (`noticeFor`): never over a scene or a modal dialog, and × hides it for this page's life for that number.
// It never takes the focus, has no timer and never reloads by itself. The live region is always in the page, so the notice, when it
// arrives, is announced.
import { noticeText } from '../../lib/patch';
import styles from './shell.module.css';

/** Reloads the current address: the new patch's client comes with it. */
export function reloadPage(): void {
  window.location.reload();
}

export function PatchNotice({ number, compact, onReload, onLater }: {
  /** The patch to announce, or null for none (the region stays, empty). */
  number: string | null;
  /** The phone's short form. */
  compact: boolean;
  onReload(): void;
  onLater(): void;
}) {
  const [lead, rest] = number === null ? ['', ''] : noticeText(number, compact);
  return (
    <div className={number === null ? styles.sr : styles.patchNotice} role="status" data-patch-notice="">
      {number !== null && <>
        <p><b>{lead}</b>{rest}</p>
        <button type="button" className={styles.reload} onClick={onReload}>Reload</button>
        <button type="button" className={styles.dismiss} aria-label="Later" onClick={onLater}>×</button>
      </>}
    </div>
  );
}
