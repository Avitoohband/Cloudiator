'use client';

// The messages button (spec "Game messages and a free look change", Layout): a 44 px round dark button left of the signed-in HUD pill,
// with a red badge on its top right holding the number of unread messages and new results together ("9+" above 9, none at 0). Its name
// says the real count ("Messages, 2 new"), it reports `aria-expanded`, and a polite status line announces a count that rises (a message
// arrived, a result was credited) but not one that falls (the player read something). It opens the panel just after it in the document,
// so the keyboard's next Tab enters it. Whether it is open, and the Escape and outside-press rules, belong to the corner chip, which
// shows one popover at a time.
import { useEffect, useRef, useState, type Ref } from 'react';
import type { Inbox } from '@contracts/reads';
import { badgeText, buttonName, newCount, type MessagingActions } from './messages';
import { MessagesPanel } from './MessagesPanel';
import styles from './messages.module.css';

export function MessagesButton({ inbox, load, loadNotifications, read, seeNotifications, changeLook, open, panelId, onToggle, onClose, buttonRef }: MessagingActions & {
  inbox: Inbox;
  /** Opens the look dialog from the look note's Change look button (the panel closes first). */
  changeLook(): void;
  open: boolean;
  /** The id the open panel takes, which the button's `aria-controls` names. */
  panelId: string;
  onToggle(): void;
  /** Closes the panel and returns the focus to the button. */
  onClose(): void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const count = newCount(inbox);
  const shown = badgeText(count);
  // A count that rises is announced as the button's own name; the first count (the page loading) and any fall are not.
  const before = useRef(count);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    setAnnouncement(count > before.current ? buttonName(count) : '');
    before.current = count;
  }, [count]);
  return <>
    <button ref={buttonRef} type="button" className={styles.button} data-messages-button="" aria-label={buttonName(count)} aria-expanded={open}
      aria-controls={open ? panelId : undefined} onClick={onToggle}>
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" />
      </svg>
      {shown && <span className={styles.badge} data-testid="messages-badge" aria-hidden="true">{shown}</span>}
    </button>
    <span role="status" className={styles.sr} data-testid="messages-live">{announcement}</span>
    {open && <MessagesPanel id={panelId} inbox={inbox} load={load} loadNotifications={loadNotifications} read={read} seeNotifications={seeNotifications}
      changeLook={changeLook} onClose={onClose} />}
  </>;
}
