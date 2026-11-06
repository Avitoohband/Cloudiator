'use client';

// The messages panel (spec "Game messages and a free look change", Layout and Accessibility): a labelled region under the HUD with two
// tabs, Messages (patch notes and Admin) and Notifications (the player's own training, expedition, Arena and tournament results).
// - Messages: newest first, each row a real button with its tag, date, title and one-line preview; an unread row has a gold dot and a
//   bold title. Opening a row shows its text with Back and Close, and sends the read mark then (not when the list shows, which would
//   spend the command budget on messages nobody opened). The text is data: it is only ever rendered as text, never as markup.
// - Notifications: what each result earned. Opening the tab marks the results as seen, once, up to the newest row the read fetched (a row
//   the list cannot show included, so the badge always clears); the rows that were new when the panel opened keep their gold dot while it is open.
// - The world revision does not carry either list, so each is read when its tab is first shown and again when the owner's `inbox`
//   says it no longer agrees (a message was posted or hidden, a result was credited), once per change of the inbox.
// - Patch numbers (Patch A, "Patch numbers and the changelog"): a patch note shows "Patch 1.3" after its tag, in the list and opened. The
//   number is a button that opens Patch history (`PatchHistory`) here, at that patch; the account menu opens it too (`history`). In the list
//   the row is a button already, so the number is a button beside it, drawn over the room the row keeps for it after the tag.
// - Titles (patch 1.7, spec "Notices (Notifications tab)"): a title a result earned is a gold line with Wear inside that result's card; the
//   other titles are notices of their own, merged with the results by time (`TitleNotices`, `title-notices.ts`). They count in the summary
//   line and in the badge (the server's `newNotifications`), and the tab is marked seen up to the newest of its results and notices.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Inbox, MessageBlock } from '@contracts/reads';
import { PATCH } from '../../lib/patch';
import { NOTIFICATIONS_PAGE } from '../../lib/api/reads';
import { notificationEntries, notificationsSummary, resultTitleRows, titleNotices, type TitleNotice } from '../titles/title-notices';
import {
  freshNotifications, isNewNotification, isUnread, messageDate, messagesStale, notificationsMark, notificationsStale, tagName, badgeText, type MessagingActions,
  type ShownMessage,
} from './messages';
import { PatchHistory } from './PatchHistory';
import { LookDisclaimer } from './LookDisclaimer';
import { levelUpLine, notificationLines, watchLabel } from './notifications';
import { NoticeCard, TitleLines, useNoticeWear, type NoticeTitles } from './TitleNotices';
import { useLoaded, useLoadedList } from './useLoadedList';
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

/** A patch note's number: a button that opens Patch history at that patch. */
function PatchNumber({ patch, onOpen }: { patch: string; onOpen(): void }) {
  return <button type="button" className={styles.patchNumber} data-patch-number={patch} onClick={onOpen}>Patch {patch}</button>;
}

const NO_NOTICES: readonly TitleNotice[] = [];

export function MessagesPanel({ id, inbox, load, loadNotifications, loadPatches, read, seeNotifications, changeLook, onClose, history, initialTab, watch, latestPatch = null,
  titles }: MessagingActions & {
  id: string;
  inbox: Inbox;
  /** The owner's titles, the title worn now and the Wear and "Choose a title" actions (patch 1.7); absent shows no title. */
  titles?: NoticeTitles;
  /** Explicit origin return overrides the ordinary unread-count choice. */
  initialTab?: Tab;
  /** Opens the panel on Patch history, with that patch open (null: the newest). */
  history?: { patch: string | null };
  /** The server's newest patch (the sync's), for Patch history's "Patch 1.5 is out". */
  latestPatch?: string | null;
  /** The Change look button: the panel closes (focus back on the Messages button) and the look dialog opens. */
  changeLook(): void;
  /** Closes the panel and returns the focus to the Messages button. */
  onClose(): void;
}) {
  const root = useRef<HTMLElement>(null);
  const ids = useId();
  // Open on what is new: Notifications when only results are, else Messages.
  // (Opened on Patch history, it stays on Messages beneath it: the results are marked seen only once their tab is shown.)
  const [tab, setTab] = useState<Tab>(() => (initialTab ?? (!history && inbox.unread === 0 && inbox.newNotifications > 0 ? 'notifications' : 'messages')));
  useEffect(() => { if (initialTab) root.current?.querySelector<HTMLElement>('[data-tab="' + initialTab + '"]')?.focus(); }, [initialTab]);
  // Retention follows the shared clock even while no inbox read changes the cards.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!watch) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') tick(n => n + 1); }, 1000);
    return () => window.clearInterval(timer);
  }, [watch]);
  const [visitedNotifications, setVisitedNotifications] = useState(tab === 'notifications');
  const [current, setCurrent] = useState<number | null>(null);
  // Patch history over the list: the patch it opens at, and the note whose number opened it (Back to messages returns to its row).
  const [patches, setPatches] = useState<{ patch: string | null; from: number | null } | null>(history ? { patch: history.patch, from: null } : null);
  // The time the account had seen results up to when the panel opened: the rows after it are marked new for as long as the panel is open.
  const [seenAtOpen] = useState(inbox.notificationsSeenMs);

  const messages = useLoadedList<ShownMessage>(load, true);
  const notes = useLoaded(loadNotifications, visitedNotifications);
  const noteItems = notes.value?.items ?? null;
  // Patch 1.7: the owner's title notices, merged with the results read (a notice older than a full page of results is left out).
  const held = titles?.held;
  const notices = useMemo(() => (held ? titleNotices(held) : NO_NOTICES), [held]);
  const entries = useMemo(() => (noteItems ? notificationEntries(noteItems, notices, NOTIFICATIONS_PAGE) : []), [noteItems, notices]);
  const listedNotices = useMemo(() => entries.flatMap(entry => (entry.kind === 'notice' ? [entry.notice] : [])), [entries]);
  const wear = useNoticeWear(titles);

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
    if (noteItems === null || notesAsked.current === notesKey || !notificationsStale(noteItems, inbox, notices)) return;
    notesAsked.current = notesKey;
    notes.reload();
  }, [noteItems, notesKey]);

  // A read mark goes out when a message is opened, once for each message (a failed one is asked again the next time it is opened).
  const readAsked = useRef(new Set<number>());
  const rowToFocus = useRef<number | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const open = (message: ShownMessage) => {
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
  // Patch history: from a note's number (the note, open or in the list, is where Back to messages returns), and back to the list.
  const showHistory = (patch: string, from: number) => { rowToFocus.current = null; setCurrent(null); setPatches({ patch, from }); };
  const historyBack = useRef<number | 'tab' | null>(null);
  const closeHistory = () => { historyBack.current = patches?.from ?? 'tab'; setPatches(null); };
  useEffect(() => {
    const target = historyBack.current;
    if (patches !== null || target === null) return;
    historyBack.current = null;
    const row = target === 'tab' ? null : root.current?.querySelector<HTMLElement>(`[data-message-row="${target}"]`);
    (row ?? root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
  }, [patches]);
  const readNote = (messageId: number) => {
    const message = messages.items?.find(m => m.id === messageId);
    if (!message) return;
    setPatches(null);
    setTab('messages');
    open(message);
  };
  const noteIds = (messages.items ?? []).filter(m => m.kind === 'patch-notes').map(m => m.id);
  // A message the operator hid while it was open is gone from the list the next read brings: back to the list.
  useEffect(() => { if (current !== null && messages.items !== null && detail === null) setCurrent(null); }, [current, messages.items, detail]);

  // The results are marked seen up to the newest row the read fetched, once for each newest time (a later result sends its own). That is
  // the newest row, not the newest one shown: the badge counts every result of the four kinds, and the list leaves out a row it cannot
  // read, so a mark that stopped at the newest shown row could leave the badge on for good. Patch 1.7: or up to the newest title notice
  // listed, when it is newer (a notice left out is older than every listed result, so the mark covers it). It waits for the results' read.
  const seenUpTo = useRef(0);
  const mark = notes.value ? notificationsMark(notes.value.newestSettledMs, listedNotices) : null;
  useEffect(() => {
    if (tab !== 'notifications' || mark === null || mark <= inbox.notificationsSeenMs || mark <= seenUpTo.current) return;
    const before = seenUpTo.current;
    seenUpTo.current = mark;
    seeNotifications(mark).catch(() => { if (seenUpTo.current === mark) seenUpTo.current = before; });
  }, [tab, notes.value, mark]);

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
  const freshNotes = freshNotifications(noteItems ?? [], listedNotices, seenAtOpen);
  // "Choose a title": the panel closes (the focus back on the Messages button) and the picker opens on My gladiator, with the focus in it.
  const chooseTitle = () => { onClose(); titles?.choose(); };

  return (
    <section ref={root} id={id} className={styles.panel} aria-label="Messages" data-testid="messages-panel">
      <div className={styles.head}>
        {patches && !detail ? <button type="button" className={styles.back} onClick={closeHistory}><Chevron />Back to messages</button>
          : detail ? <button ref={back} type="button" className={styles.back} onClick={() => setCurrent(null)}><Chevron />Back to messages</button>
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
            <span className={styles.rowTop} data-row-top="">
              <span className={`${styles.tag} ${styles[detail.kind === 'admin' ? 'admin' : 'patch']}`}>{tagName(detail.kind)}</span>
              {detail.patch !== null && <PatchNumber patch={detail.patch} onOpen={() => showHistory(detail.patch!, detail.id)} />}
              <span className={styles.date}>{messageDate(detail.publishedAtMs)}</span>
            </span>
            <h3 id={`${ids}-title`} className={styles.detailTitle}>{detail.title}</h3>
            <Body blocks={detail.body} />
            {detail.action === 'change-look' && <div className={styles.action}>
              <button type="button" className={styles.actionButton} onClick={() => { onClose(); changeLook(); }}>Change look</button>
              <LookDisclaimer />
            </div>}
          </article>
        ) : patches ? (
          <PatchHistory load={loadPatches} build={PATCH} latest={latestPatch} open={patches.patch} notes={noteIds} onReadNote={readNote} />
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
                      return <li key={message.id} className={styles.item}>
                        <button type="button" className={styles.row} data-message-row={message.id} data-unread={unread ? '' : undefined} onClick={() => open(message)}>
                          <span className={styles.rowTop}>
                            <span className={`${styles.tag} ${styles[message.kind === 'admin' ? 'admin' : 'patch']}`} data-message-tag>{tagName(message.kind)}</span>
                            {message.patch !== null && <span className={`${styles.patchNumber} ${styles.room}`} aria-hidden="true">Patch {message.patch}</span>}
                            <span className={styles.date}>{messageDate(message.publishedAtMs)}</span>
                          </span>
                          <span className={styles.rowTitle}>
                            {unread && <span className={styles.dot} data-unread-dot aria-hidden="true" />}
                            {unread && <span className={styles.sr}>Unread: </span>}
                            <span className={unread ? styles.titleNew : styles.title} data-message-title>{message.title}</span>
                          </span>
                          <span className={styles.preview}>{message.preview}</span>
                        </button>
                        {message.patch !== null && <span className={styles.numberLine}>
                          <span className={`${styles.tag} ${styles.patch} ${styles.room}`} aria-hidden="true">{tagName(message.kind)}</span>
                          <PatchNumber patch={message.patch} onOpen={() => showHistory(message.patch!, message.id)} />
                        </span>}
                      </li>;
                    })}
                  </ul>
                </>}
              </>}
          </div>
        ) : (
          <div role="tabpanel" id={`${ids}-panel-notifications`} aria-labelledby={tabId('notifications')}>
            {noteItems === null ? (notes.failed ? <Failed what="Notifications" retry={notes.reload} /> : <p role="status" className={styles.state}>Loading notifications…</p>)
              : <>
                {notes.failed && <Failed what="Notifications" retry={notes.reload} />}
                {entries.length === 0 ? <p className={styles.state}>No results yet. What your training and expeditions earn shows here.</p> : <>
                  <p className={styles.summary}>{notificationsSummary(noteItems.length, listedNotices.length, freshNotes)}</p>
                  <ul className={styles.list}>
                    {entries.map(entry => {
                      if (entry.kind === 'notice') {
                        return titles && <NoticeCard key={`notice:${entry.notice.key}`} notice={entry.notice} fresh={entry.notice.atMs > seenAtOpen} titles={titles} wear={wear}
                          onChoose={chooseTitle} />;
                      }
                      const note = entry.result;
                      const { title, lines, levelUp } = notificationLines(note);
                      const fresh = isNewNotification(note, seenAtOpen);
                      const label = watch && watch.kept(note) ? watchLabel(note) : null;
                      const earned = titles ? resultTitleRows(titles.held, note.activityId) : [];
                      return <li key={note.activityId} className={styles.card} data-notification data-unread={fresh ? '' : undefined}>
                        <span className={styles.rowTop}>
                          <span className={styles.rowTitle}>
                            {fresh && <span className={styles.dot} data-unread-dot aria-hidden="true" />}
                            {fresh && <span className={styles.sr}>New: </span>}
                            <span className={fresh ? styles.titleNew : styles.title} data-notification-title>{title}</span>
                          </span>
                          <span className={styles.date}>{messageDate(note.settledAtMs)}</span>
                        </span>
                        {label && <button type="button" className={styles.noteWatch} aria-label={label.name} onClick={() => watch?.open(note)}>
                          <span className={styles.wide}>{label.wide}</span><span className={styles.narrow}>{label.narrow}</span>
                        </button>}
                        <ul className={styles.lines}>
                          {lines.map((line, n) => <li key={n} className={levelUp !== null && line === levelUpLine(levelUp) ? styles.level : undefined}>{line}</li>)}
                        </ul>
                        {titles && earned.length > 0 && <TitleLines rows={earned} worn={titles.worn} wear={wear} />}
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
