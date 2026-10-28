'use client';

// The messages panel (spec "Game messages and a free look change", Layout and Accessibility): a labelled region under the HUD with two
// tabs, Messages (patch notes and Admin) and Notifications (the player's own training, expedition, Arena and tournament results).
// - Messages: newest first, each row a real button with its tag, date, title and one-line preview; an unread row has a gold dot and a
//   bold title. Opening a row shows its text with Back and Close, and sends the read mark then (not when the list shows, which would
//   spend the command budget on messages nobody opened). The text is data: it is only ever rendered as text, never as markup.
// - Notifications: what each result earned. Opening the tab marks everything shown as seen, once, with the newest shown time; the
//   rows that were new when the panel opened keep their gold dot while it is open.
// - The world revision does not carry either list, so each is read when its tab is first shown and again when the owner's `inbox`
//   says it no longer agrees (a message was posted or hidden, a result was credited), once per change of the inbox.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GameMessage, GameNotification, Inbox, MessageBlock } from '@contracts/reads';
import { isNewNotification, isUnread, messageDate, messagesStale, notificationsStale, tagName, badgeText, type MessagingActions } from './messages';
import { levelUpLine, notificationLines } from './notifications';
import { useLoadedList } from './useLoadedList';
import styles from './messages.module.css';

type Tab = 'messages' | 'notifications';

/** A message body as paragraphs and bullet lists: consecutive bullet items make one list. Plain text only. */
function Body({ blocks }: { blocks: readonly MessageBlock[] }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if ('p' in block) { out.push(<p key={i}>{block.p}</p>); continue; }
    const items: string[] = [];
    const start = i;
    for (; i < blocks.length; i++) { const next = blocks[i]; if (!('li' in next)) break; items.push(next.li); }
    i -= 1;
    out.push(<ul key={start}>{items.map((item, n) => <li key={n}>{item}</li>)}</ul>);
  }
  return <>{out}</>;
}

const Chevron = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>;
const Cross = () => <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;

function Failed({ what, retry }: { what: string; retry(): void }) {
  return <div className={styles.state}>
    <p role="alert">{what} could not be loaded.</p>
    <button type="button" className={styles.retry} onClick={retry}>Try again</button>
  </div>;
}

export function MessagesPanel({ id, inbox, load, loadNotifications, read, seeNotifications, changeLook, onClose }: MessagingActions & {
  id: string;
  inbox: Inbox;
  /** The Change look button: the panel closes (focus back on the Messages button) and the look dialog opens. */
  changeLook(): void;
  /** Closes the panel and returns the focus to the Messages button. */
  onClose(): void;
}) {
  const root = useRef<HTMLElement>(null);
  const ids = useId();
  // Open on what is new: Notifications when only results are, else Messages.
  const [tab, setTab] = useState<Tab>(() => (inbox.unread === 0 && inbox.newNotifications > 0 ? 'notifications' : 'messages'));
  const [visitedNotifications, setVisitedNotifications] = useState(tab === 'notifications');
  const [current, setCurrent] = useState<number | null>(null);
  // The time the account had seen results up to when the panel opened: the rows after it are marked new for as long as the panel is open.
  const [seenAtOpen] = useState(inbox.notificationsSeenMs);

  const messages = useLoadedList<GameMessage>(load, true);
  const notes = useLoadedList<GameNotification>(loadNotifications, visitedNotifications);

  // Read a list again when the inbox says it is stale, once per change of what the inbox says about it (a list that stays stale, such as
  // 25 new results behind a 20-row list, is not read in a loop).
  const messagesKey = `${inbox.unread}|${inbox.readIds.join(',')}`;
  const messagesAsked = useRef(messagesKey);
  useEffect(() => {
    if (messages.items === null || messagesAsked.current === messagesKey || !messagesStale(messages.items, inbox)) return;
    messagesAsked.current = messagesKey;
    messages.reload();
  }, [messages.items, messagesKey]);
  const notesKey = `${inbox.newNotifications}|${inbox.notificationsSeenMs}`;
  const notesAsked = useRef(notesKey);
  useEffect(() => {
    if (notes.items === null || notesAsked.current === notesKey || !notificationsStale(notes.items, inbox)) return;
    notesAsked.current = notesKey;
    notes.reload();
  }, [notes.items, notesKey]);

  // A read mark goes out when a message is opened, once for each message (a failed one is asked again the next time it is opened).
  const readAsked = useRef(new Set<number>());
  const rowToFocus = useRef<number | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const open = (message: GameMessage) => {
    rowToFocus.current = message.id;
    setCurrent(message.id);
    if (isUnread(message, inbox) && !readAsked.current.has(message.id)) {
      readAsked.current.add(message.id);
      read(message.id).catch(() => { readAsked.current.delete(message.id); });
    }
  };
  // Opening a message moves the focus to Back (the row it came from is gone); Back returns it to that row.
  useEffect(() => {
    if (current !== null) { back.current?.focus(); return; }
    const row = rowToFocus.current;
    rowToFocus.current = null;
    if (row !== null) root.current?.querySelector<HTMLElement>(`[data-message-row="${row}"]`)?.focus();
  }, [current]);
  const detail = current === null ? null : messages.items?.find(message => message.id === current) ?? null;
  // A message the operator hid while it was open is gone from the list the next read brings: back to the list.
  useEffect(() => { if (current !== null && messages.items !== null && detail === null) setCurrent(null); }, [current, messages.items, detail]);

  // The results on show are marked seen up to the newest of them, once for each newest time (a later result sends its own).
  const seenUpTo = useRef(0);
  useEffect(() => {
    if (tab !== 'notifications' || notes.items === null || notes.items.length === 0) return;
    const newest = Math.max(...notes.items.map(n => n.settledAtMs));
    if (newest <= inbox.notificationsSeenMs || newest <= seenUpTo.current) return;
    const before = seenUpTo.current;
    seenUpTo.current = newest;
    seeNotifications(newest).catch(() => { if (seenUpTo.current === newest) seenUpTo.current = before; });
  }, [tab, notes.items]);

  const select = (next: Tab) => {
    setTab(next);
    if (next === 'notifications') setVisitedNotifications(true);
  };
  const tabs: readonly { id: Tab; label: string; count: number }[] = [
    { id: 'messages', label: 'Messages', count: inbox.unread },
    { id: 'notifications', label: 'Notifications', count: inbox.newNotifications },
  ];
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    select(tabs[target].id);
    root.current?.querySelector<HTMLElement>(`[data-tab="${tabs[target].id}"]`)?.focus();
  };

  const tabId = (t: Tab) => `${ids}-tab-${t}`;
  const messageCount = messages.items?.length ?? 0;
  const freshNotes = (notes.items ?? []).filter(n => isNewNotification(n, seenAtOpen)).length;

  return (
    <section ref={root} id={id} className={styles.panel} aria-label="Messages" data-testid="messages-panel">
      <div className={styles.head}>
        {detail ? <button ref={back} type="button" className={styles.back} onClick={() => setCurrent(null)}><Chevron />Back to messages</button>
          : <div role="tablist" aria-label="Messages and notifications" className={styles.tabs}>
            {tabs.map((t, index) => {
              const shown = badgeText(t.count);
              return <button key={t.id} id={tabId(t.id)} type="button" role="tab" data-tab={t.id} className={styles.tab} aria-selected={tab === t.id}
                aria-controls={tab === t.id ? `${ids}-panel-${t.id}` : undefined} tabIndex={tab === t.id ? 0 : -1} aria-label={t.count > 0 ? `${t.label}, ${t.count} new` : t.label}
                onClick={() => select(t.id)} onKeyDown={event => onTabKey(event, index)}>
                <span aria-hidden="true">{t.label}</span>{shown && <span className={styles.count} aria-hidden="true">{shown}</span>}
              </button>;
            })}
          </div>}
        <button type="button" className={styles.close} aria-label="Close messages" onClick={onClose}><Cross /></button>
      </div>
      <div className={styles.body}>
        {detail ? (
          <article className={styles.detail} aria-labelledby={`${ids}-title`}>
            <span className={styles.rowTop}>
              <span className={`${styles.tag} ${styles[detail.kind === 'admin' ? 'admin' : 'patch']}`}>{tagName(detail.kind)}</span>
              <span className={styles.date}>{messageDate(detail.publishedAtMs)}</span>
            </span>
            <h3 id={`${ids}-title`} className={styles.detailTitle}>{detail.title}</h3>
            <Body blocks={detail.body} />
            {detail.action === 'change-look' && <div className={styles.action}>
              <button type="button" className={styles.actionButton} onClick={() => { onClose(); changeLook(); }}>Change look</button>
              <p><strong>Free for now</strong>, as often as you like. This is temporary: changing your look will cost something in the future.</p>
            </div>}
          </article>
        ) : tab === 'messages' ? (
          <div role="tabpanel" id={`${ids}-panel-messages`} aria-labelledby={tabId('messages')}>
            {messages.items === null ? (messages.failed ? <Failed what="Messages" retry={messages.reload} /> : <p role="status" className={styles.state}>Loading messages…</p>)
              : <>
                {messages.failed && <Failed what="Messages" retry={messages.reload} />}
                {messageCount === 0 ? <p className={styles.state}>No messages yet.</p> : <>
                  <p className={styles.summary}>{messageCount} message{messageCount === 1 ? '' : 's'} · {inbox.unread > 0 ? `${inbox.unread} new` : 'all read'}</p>
                  <ul className={styles.list}>
                    {messages.items.map(message => {
                      const unread = isUnread(message, inbox);
                      return <li key={message.id}>
                        <button type="button" className={styles.row} data-message-row={message.id} data-unread={unread ? '' : undefined} onClick={() => open(message)}>
                          <span className={styles.rowTop}>
                            <span className={`${styles.tag} ${styles[message.kind === 'admin' ? 'admin' : 'patch']}`} data-message-tag>{tagName(message.kind)}</span>
                            <span className={styles.date}>{messageDate(message.publishedAtMs)}</span>
                          </span>
                          <span className={styles.rowTitle}>
                            {unread && <span className={styles.dot} data-unread-dot aria-hidden="true" />}
                            {unread && <span className={styles.sr}>Unread: </span>}
                            <span className={unread ? styles.titleNew : styles.title} data-message-title>{message.title}</span>
                          </span>
                          <span className={styles.preview}>{message.preview}</span>
                        </button>
                      </li>;
                    })}
                  </ul>
                </>}
              </>}
          </div>
        ) : (
          <div role="tabpanel" id={`${ids}-panel-notifications`} aria-labelledby={tabId('notifications')}>
            {notes.items === null ? (notes.failed ? <Failed what="Notifications" retry={notes.reload} /> : <p role="status" className={styles.state}>Loading notifications…</p>)
              : <>
                {notes.failed && <Failed what="Notifications" retry={notes.reload} />}
                {notes.items.length === 0 ? <p className={styles.state}>No results yet. What your training and expeditions earn shows here.</p> : <>
                  <p className={styles.summary}>Latest {notes.items.length} result{notes.items.length === 1 ? '' : 's'} · {freshNotes > 0 ? `${freshNotes} new` : 'nothing new'}</p>
                  <ul className={styles.list}>
                    {notes.items.map(note => {
                      const { title, lines, levelUp } = notificationLines(note);
                      const fresh = isNewNotification(note, seenAtOpen);
                      return <li key={note.activityId} className={styles.card} data-notification data-unread={fresh ? '' : undefined}>
                        <span className={styles.rowTop}>
                          <span className={styles.rowTitle}>
                            {fresh && <span className={styles.dot} data-unread-dot aria-hidden="true" />}
                            {fresh && <span className={styles.sr}>New: </span>}
                            <span className={fresh ? styles.titleNew : styles.title} data-notification-title>{title}</span>
                          </span>
                          <span className={styles.date}>{messageDate(note.settledAtMs)}</span>
                        </span>
                        <ul className={styles.lines}>
                          {lines.map((line, n) => <li key={n} className={levelUp !== null && line === levelUpLine(levelUp) ? styles.level : undefined}>{line}</li>)}
                        </ul>
                      </li>;
                    })}
                  </ul>
                </>}
              </>}
          </div>
        )}
      </div>
    </section>
  );
}
