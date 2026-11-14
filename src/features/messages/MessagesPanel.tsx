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
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import type { GameMessage, GameNotification, Inbox, MessageBlock, OwnFeedback } from '@contracts/reads';
import { PATCH } from '../../lib/patch';
import { NOTIFICATIONS_PAGE } from '../../lib/api/reads';
import { notificationEntries, notificationsSummary, resultTitleRows, titleNotices, type TitleNotice } from '../titles/title-notices';
import {
  freshNotifications, isNewNotification, isUnread, messageDate, messagesStale, notificationRows, notificationsMark, notificationsStale, tagName, badgeText, type MessagingActions,
  type ShownMessage,
} from './messages';
import { PatchHistory } from './PatchHistory';
import { leftToday, unseenAnswers, type FeedbackActions } from './feedback';
import { FeedbackDialog } from './FeedbackDialog';
import { MyFeedback } from './MyFeedback';
import { useMinuteNow } from '../schedule/use-minute-now';
import { LookDisclaimer } from './LookDisclaimer';
import { levelUpLine, notificationLines, watchLabel } from './notifications';
import { restedNoteLines } from '../schedule/stamina-text';
import type { RestedActivity } from '../../lib/api/reads';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';
import { NoticeCard, TitleLines, useNoticeWear, type NoticeTitles } from './TitleNotices';
import { useLoaded, useLoadedList } from './useLoadedList';
import { Pager } from '../paging/Pager';
import { PagingScope, PanelFooter } from '../paging/PanelFooter';
import { usePagedList } from '../paging/usePagedList';
import styles from './messages.module.css';

type Tab = 'messages' | 'notifications';
/** The tag's colour class: gold patch notes, violet Admin, green Team reply (patch 1.9). */
const TAG_CLASS: Record<GameMessage['kind'], string> = { 'patch-notes': styles.patch, admin: styles.admin, 'team-reply': styles.team };
const NO_FEEDBACK = (): Promise<OwnFeedback[]> => Promise.resolve([]);
/** A footer that is not there (no feedback actions) keeps the panel's clock still. */
const STILL_CLOCK = { now: () => 0, subscribe: () => () => undefined } as unknown as FeedbackActions['clock'];

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
const Tick = () => <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const TickAll = () => <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 12.5L6 17l7-8.5M10 15.5l1.5 1.5L22 6.5" /></svg>;
const Speech = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v11H9l-5 4z" /></svg>;
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
const NO_MESSAGES: readonly ShownMessage[] = [];
const NO_RESTS: readonly RestedActivity[] = [];
const NO_RESTED_ROWS: readonly RestedRow[] = [];
/** A settled rest that replaced a planned activity, as a row of the Notifications list. */
type RestedRow = RestedActivity & { settledAtMs: number; rested: true };
const restedRows = (rests: readonly RestedActivity[]): RestedRow[] =>
  rests.flatMap(rest => (rest.settledAtMs === null ? [] : [{ ...rest, settledAtMs: rest.settledAtMs, rested: true as const }]));
const isRested = (row: GameNotification | RestedRow): row is RestedRow => 'rested' in row;

export function MessagesPanel({ id, inbox, load, loadNotifications, loadPatches, read, seeNotifications, changeLook, onClose, history, initialTab, initialRow, watch, latestPatch = null,
  titles, feedback, rules = RULES_V2 }: MessagingActions & {
  id: string;
  inbox: Inbox;
  /** The owner's titles, the title worn now and the Wear and "Choose a title" actions (patch 1.7); absent shows no title. */
  titles?: NoticeTitles;
  /** Explicit origin return overrides the ordinary unread-count choice; `feedback` opens on My feedback (patch 1.9). */
  initialTab?: Tab | 'feedback';
  /** Patch 1.9 Task 31: the result (its activity id) a Watch left from; Notifications opens on the page that holds it. */
  initialRow?: string;
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
  const [tab, setTab] = useState<Tab>(() => (initialTab === 'feedback' ? 'messages'
    : initialTab ?? (!history && inbox.unread === 0 && inbox.newNotifications > 0 ? 'notifications' : 'messages')));
  // Patch 1.9: My feedback, a view under "Back to messages" (only with the feedback actions), and the Send feedback dialog over the panel.
  const [mine, setMine] = useState(initialTab === 'feedback' && !!feedback && !history);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    if (initialTab === 'feedback') root.current?.querySelector<HTMLElement>('[data-feedback-back]')?.focus();
    else if (initialTab) root.current?.querySelector<HTMLElement>('[data-tab="' + initialTab + '"]')?.focus();
  }, [initialTab]);
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
  // Mark all as read on the Notifications tab raises it, which clears the gold dots.
  const [seenAtOpen, setSeenAtOpen] = useState(inbox.notificationsSeenMs);

  const messages = useLoadedList<ShownMessage>(load, true);
  // The account's own feedback: read when My feedback is shown (and again after a send), never just because the panel opened.
  const own = useLoaded<OwnFeedback[]>(feedback ? feedback.load : NO_FEEDBACK, !!feedback && mine);
  const feedbackNow = useMinuteNow(feedback?.clock ?? STILL_CLOCK);
  const notes = useLoaded(loadNotifications, visitedNotifications);
  const noteItems = notes.value?.items ?? null;
  // Patch 1.7: the owner's title notices, merged with the results read (a notice older than a full page of results is left out).
  const held = titles?.held;
  const notices = useMemo(() => (held ? titleNotices(held) : NO_NOTICES), [held]);
  // Patch 1.9 Task 29: the owner's rests that replaced a planned activity ("Aster rested instead of …"), read with the results and listed among
  // them by time. The server's badge does not count them (accepted), so they never move the server's mark; their gold dots are this panel's.
  const restedItems = notes.value?.rested ?? NO_RESTS;
  // Fix round 1: while the results fill their page, a rest older than the oldest result is left out, and only the results bound the page.
  const noteRows = useMemo(() => (noteItems ? notificationRows(noteItems, restedRows(restedItems), NOTIFICATIONS_PAGE) : null), [noteItems, restedItems]);
  const entries = useMemo(() => (noteRows && noteItems ? notificationEntries(noteRows, notices, NOTIFICATIONS_PAGE, noteItems) : []), [noteRows, noteItems, notices]);
  const listedNotices = useMemo(() => entries.flatMap(entry => (entry.kind === 'notice' ? [entry.notice] : [])), [entries]);
  const wear = useNoticeWear(titles);
  // Patch 1.9 Task 31: Messages and Notifications, 7 rows a page each. The hooks live here, so Back from a message or Patch history returns to the
  // page it left; a tab change goes back to page 1 (and only the shown tab's list and bar are mounted).
  const messagesPaged = usePagedList(messages.items ?? NO_MESSAGES, { list: 'messages', resetKey: tab });
  const notesPaged = usePagedList(entries, { list: 'notifications', resetKey: tab });
  // A Watch's return lands on the page that holds the result it left from, once the list is read (once).
  const rowWanted = useRef(initialRow ?? null);
  useEffect(() => {
    if (rowWanted.current === null || tab !== 'notifications') return;
    const at = entries.findIndex(entry => entry.kind === 'result' && entry.result.activityId === rowWanted.current);
    if (at < 0) { if (noteItems !== null) rowWanted.current = null; return; }
    rowWanted.current = null;
    notesPaged.goToIndex(at);
  });

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
  // Mark as read (patch 1.9): the round check on an unread row, and Mark all as read in the summary line. Each is one `read-message`
  // (the same command opening a message sends, and the same once-per-message guard), sent in list order; one that fails does not stop
  // the rest, and Try again sends only the ones that failed. Progress and results are said in a status region.
  const [marking, setMarking] = useState<ReadonlySet<number>>(() => new Set());
  const [failedIds, setFailedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string; retry: boolean } | null>(null);
  const [announce, setAnnounce] = useState('');
  /**
   * Says `text` in the polite status region. The same words twice in a row (a second identical failure) would change nothing in the
   * region, and a screen reader would stay silent: the repeat alternates a trailing no-break space, so it is said again (Task 21).
   */
  const say = (text: string) => setAnnounce(previous => (previous === text ? `${text}\u00a0` : text));
  const bulkTotal = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const markOne = async (id: number): Promise<boolean> => {
    if (readAsked.current.has(id)) return true;
    readAsked.current.add(id);
    setMarking(previous => new Set(previous).add(id));
    setFailedIds(previous => { const next = new Set(previous); next.delete(id); return next; });
    try { await read(id); return true; } catch {
      readAsked.current.delete(id);
      setFailedIds(previous => new Set(previous).add(id));
      return false;
    } finally { setMarking(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  };
  const unreadIds = (messages.items ?? []).filter(m => isUnread(m, inbox)).map(m => m.id);
  const focusMark = (id: number | undefined) => window.setTimeout(() => {
    // The next unread row may be on another page: the list takes the focus then.
    const target = (id === undefined ? null : root.current?.querySelector<HTMLElement>(`[data-mark-button="${id}"]`)) ?? list.current;
    target?.focus();
  }, 0);
  const markRow = async (id: number) => {
    if (bulk) return;
    const next = unreadIds.find(other => other !== id && !marking.has(other));
    const ok = await markOne(id);
    if (!ok) { say('Could not mark the message as read.'); focusMark(id); return; }
    setBanner(null);
    say(`Marked as read. ${Math.max(0, unreadIds.length - 1)} unread.`);
    focusMark(next);
  };
  const markAll = async (retry: boolean) => {
    if (bulk) return;
    const ids = unreadIds.filter(id => !retry || failedIds.has(id));
    if (ids.length === 0) return;
    if (!retry) { bulkTotal.current = ids.length; setFailedIds(new Set()); }
    setBanner(null);
    let bad = 0;
    for (let n = 0; n < ids.length; n++) {
      setBulk({ done: n, total: ids.length });
      say(`Marking ${n + 1} of ${ids.length}…`);
      if (!(await markOne(ids[n]))) bad++;
    }
    setBulk(null);
    const total = bulkTotal.current;
    const text = bad > 0 ? `Marked ${total - bad} of ${total}. ${bad} could not be marked.` : retry ? 'All marked as read.' : `All ${total} marked as read.`;
    setBanner({ kind: bad > 0 ? 'err' : 'ok', text, retry: bad > 0 });
    say(text);
    window.setTimeout(() => {
      (bad > 0 ? root.current?.querySelector<HTMLElement>('[data-mark-retry]') : list.current)?.focus();
    }, 0);
  };
  // Opening a message moves the focus to Back (the row it came from is gone); Back returns it to that row.
  useEffect(() => {
    if (current !== null) { back.current?.focus(); return; }
    const row = rowToFocus.current;
    rowToFocus.current = null;
    if (row !== null) root.current?.querySelector<HTMLElement>(`[data-message-row="${row}"]`)?.focus();
  }, [current]);
  const detail = current === null ? null : messages.items?.find(message => message.id === current) ?? null;
  // My feedback: opened from the footer (or a request), closed by "Back to messages", which gives the focus back to My feedback.
  const mineBack = useRef(false);
  const openMine = () => { rowToFocus.current = null; setCurrent(null); setPatches(null); setMine(true); };
  const closeMine = () => { mineBack.current = true; setMine(false); };
  useEffect(() => {
    if (mine) { root.current?.querySelector<HTMLElement>('[data-feedback-back]')?.focus(); return; }
    if (!mineBack.current) return;
    mineBack.current = false;
    root.current?.querySelector<HTMLElement>('[data-feedback-mine]')?.focus();
  }, [mine]);
  // An answer opened in My feedback marks its team-reply message read, once (the same guard as opening the message).
  const seeReply = (reply: GameMessage) => {
    if (readAsked.current.has(reply.id)) return;
    readAsked.current.add(reply.id);
    read(reply.id).catch(() => { readAsked.current.delete(reply.id); });
  };
  const sendButton = useRef<HTMLButtonElement>(null);
  const closeDialog = ({ then, sent }: { then: 'mine' | null; sent: boolean }) => {
    setWriting(false);
    // My feedback reads its list when it opens; already open, it reads it again to show the new one.
    if (sent && mine) own.reload();
    if (then === 'mine' && !mine) { openMine(); return; }
    window.setTimeout(() => (then === 'mine' ? root.current?.querySelector<HTMLElement>('[data-feedback-back]') : sendButton.current)?.focus(), 0);
  };
  const unseen = unseenAnswers(messages.items ?? [], inbox);
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
    messagesPaged.goToIndex(messages.items?.indexOf(message) ?? 0);
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
  // Patch 1.9 Task 29 fix round 1: the mark also reaches the newest rested-instead row listed, so its dot does not come back on the next open
  // (the server takes any time up to its now and never moves the mark back; the badge never counted the rests).
  const listedRests = noteRows ? noteRows.filter(isRested) : NO_RESTED_ROWS;
  const newestRest = listedRests.length ? Math.max(...listedRests.map(rest => rest.settledAtMs)) : null;
  const newestRow = notes.value ? Math.max(notes.value.newestSettledMs ?? -Infinity, newestRest ?? -Infinity) : -Infinity;
  const mark = notes.value ? notificationsMark(Number.isFinite(newestRow) ? newestRow : null, listedNotices) : null;
  useEffect(() => {
    if (tab !== 'notifications' || mark === null || mark <= inbox.notificationsSeenMs || mark <= seenUpTo.current) return;
    const before = seenUpTo.current;
    seenUpTo.current = mark;
    seeNotifications(mark).catch(() => { if (seenUpTo.current === mark) seenUpTo.current = before; });
  }, [tab, notes.value, mark]);
  // Mark all as read (patch 1.9, Notifications): clears the gold dots. The mark itself went out when the tab was shown (no second command
  // then); if that one failed or has not been sent, this sends it (one `see-notifications`) and says so when it fails.
  const [notesMarking, setNotesMarking] = useState(false);
  const [notesError, setNotesError] = useState(false);
  // A failed mark gives its message's Try again the focus once the message shows, as a failed Mark all on Messages does (Task 21).
  const notesRetry = useRef<HTMLButtonElement>(null), focusNotesRetry = useRef(false);
  useEffect(() => {
    if (!notesError || !focusNotesRetry.current) return;
    focusNotesRetry.current = false;
    notesRetry.current?.focus();
  }, [notesError]);
  const markNotes = async () => {
    if (notesMarking || mark === null) return;
    setNotesError(false);
    if (mark > inbox.notificationsSeenMs && mark > seenUpTo.current) {
      const before = seenUpTo.current;
      seenUpTo.current = mark;
      setNotesMarking(true);
      say('Marking notifications…');
      try { await seeNotifications(mark); } catch {
        if (seenUpTo.current === mark) seenUpTo.current = before;
        focusNotesRetry.current = true;
        setNotesMarking(false); setNotesError(true); say('Could not mark notifications. Try again.');
        return;
      }
      setNotesMarking(false);
    }
    setSeenAtOpen(previous => Math.max(previous, mark));
    say('Notifications marked as read.');
    window.setTimeout(() => root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(), 0);
  };

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
  const freshNotes = freshNotifications(noteItems ?? [], listedNotices, seenAtOpen) + listedRests.filter(rest => rest.settledAtMs > seenAtOpen).length;
  // "Choose a title": the panel closes (the focus back on the Messages button) and the picker opens on My gladiator, with the focus in it.
  const chooseTitle = () => { onClose(); titles?.choose(); };

  return (
    <section ref={root} id={id} className={styles.panel} aria-label="Messages" data-testid="messages-panel">
      <div className={styles.head}>
        {mine && !detail && !patches ? <button type="button" className={styles.back} data-feedback-back="" onClick={closeMine}><Chevron />Back to messages</button>
          : patches && !detail ? <button type="button" className={styles.back} onClick={closeHistory}><Chevron />Back to messages</button>
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
      <PagingScope className={styles.paged} bodyClassName={styles.body}>
        {detail ? (
          <article className={styles.detail} aria-labelledby={`${ids}-title`}>
            <span className={styles.rowTop} data-row-top="">
              <span className={`${styles.tag} ${TAG_CLASS[detail.kind]}`}>{tagName(detail.kind)}</span>
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
        ) : mine && feedback ? (
          <MyFeedback list={own} held={messages.items ?? []} inbox={inbox} nowMs={feedbackNow} onSeen={seeReply} />
        ) : patches ? (
          <PatchHistory load={loadPatches} build={PATCH} latest={latestPatch} open={patches.patch} notes={noteIds} onReadNote={readNote} />
        ) : tab === 'messages' ? (
          <div role="tabpanel" id={`${ids}-panel-messages`} aria-labelledby={tabId('messages')}>
            {messages.items === null ? (messages.failed ? <Failed what="Messages" retry={messages.reload} /> : <p role="status" className={styles.state}>Loading messages…</p>)
              : <>
                {messages.failed && <Failed what="Messages" retry={messages.reload} />}
                {messageCount === 0 ? <p className={styles.state}>No messages yet.</p> : <>
                  <div className={styles.summary}>
                    <span className={styles.summaryText}>{messageCount} message{messageCount === 1 ? '' : 's'} · {inbox.unread > 0 ? `${inbox.unread} new` : 'all read'}</span>
                    {/* Disabled for the whole run, focusably (aria-disabled), and natively only once it is over (Task 21). */}
                    <button type="button" className={styles.markAll} data-mark-all disabled={!bulk && unreadIds.length === 0} aria-disabled={bulk ? true : undefined} aria-busy={bulk ? true : undefined}
                      onClick={() => markAll(false)}>
                      {bulk ? <><span className={styles.spin} aria-hidden="true" />Marking {bulk.done + 1} of {bulk.total}…</> : <><TickAll />Mark all as read{unreadIds.length > 0 ? ` (${unreadIds.length})` : ''}</>}
                    </button>
                  </div>
                  {banner && <p className={`${styles.banner} ${banner.kind === 'err' ? styles.bannerErr : styles.bannerOk}`} data-mark-banner>
                    <span>{banner.text}</span>
                    {banner.retry && <button type="button" className={styles.bannerRetry} data-mark-retry onClick={() => markAll(true)}>Try again</button>}
                  </p>}
                  <ul className={styles.list} ref={element => { list.current = element; (messagesPaged.listRef as MutableRefObject<HTMLElement | null>).current = element; }} tabIndex={-1} aria-label="Messages">
                    {messagesPaged.rows.map(message => {
                      const unread = isUnread(message, inbox);
                      return <li key={message.id} className={styles.item} data-page-row="" tabIndex={-1}>
                        <button type="button" className={styles.row} data-message-row={message.id} data-unread={unread ? '' : undefined} onClick={() => open(message)}>
                          <span className={styles.rowTop}>
                            <span className={`${styles.tag} ${TAG_CLASS[message.kind]}`} data-message-tag>{tagName(message.kind)}</span>
                            {message.patch !== null && <span className={`${styles.patchNumber} ${styles.room}`} aria-hidden="true">Patch {message.patch}</span>}
                            <span className={styles.date}>{messageDate(message.publishedAtMs)}</span>
                          </span>
                          <span className={styles.rowTitle}>
                            {unread && <span className={styles.dot} data-unread-dot aria-hidden="true" />}
                            {unread && <span className={styles.sr}>Unread: </span>}
                            <span className={unread ? styles.titleNew : styles.title} data-message-title>{message.title}</span>
                          </span>
                          <span className={styles.preview}>{message.preview}</span>
                          {unread && failedIds.has(message.id) && <span className={styles.rowError} data-mark-error>Could not mark. Try again.</span>}
                        </button>
                        {unread && <button type="button" className={styles.mark} data-mark-button={message.id} title="Mark as read" aria-label={`Mark ${message.title} as read`}
                          data-state={marking.has(message.id) ? 'busy' : failedIds.has(message.id) ? 'failed' : undefined} aria-disabled={marking.has(message.id) || bulk ? true : undefined}
                          aria-busy={marking.has(message.id) ? true : undefined} onClick={() => markRow(message.id)}>
                          {marking.has(message.id) ? <span className={styles.spin} aria-hidden="true" /> : <Tick />}
                        </button>}
                        {message.patch !== null && <span className={styles.numberLine}>
                          <span className={`${styles.tag} ${styles.patch} ${styles.room}`} aria-hidden="true">{tagName(message.kind)}</span>
                          <PatchNumber patch={message.patch} onOpen={() => showHistory(message.patch!, message.id)} />
                        </span>}
                      </li>;
                    })}
                  </ul>
                  <PanelFooter><Pager list={messagesPaged} show /></PanelFooter>
                </>}
              </>}
          </div>
        ) : (
          <div role="tabpanel" id={`${ids}-panel-notifications`} aria-labelledby={tabId('notifications')}>
            {noteItems === null ? (notes.failed ? <Failed what="Notifications" retry={notes.reload} /> : <p role="status" className={styles.state}>Loading notifications…</p>)
              : <>
                {notes.failed && <Failed what="Notifications" retry={notes.reload} />}
                {entries.length === 0 ? <p className={styles.state}>No results yet. What your training and expeditions earn shows here.</p> : <>
                  <div className={styles.summary}>
                    <span className={styles.summaryText}>{notificationsSummary(noteRows?.length ?? 0, listedNotices.length, freshNotes)}</span>
                    <button type="button" className={styles.markAll} data-mark-notes disabled={!notesMarking && freshNotes === 0} aria-disabled={notesMarking ? true : undefined}
                      aria-busy={notesMarking ? true : undefined} onClick={markNotes}>
                      {notesMarking ? <><span className={styles.spin} aria-hidden="true" />Marking…</> : <><TickAll />Mark all as read</>}
                    </button>
                  </div>
                  {notesError && <p className={`${styles.banner} ${styles.bannerErr}`} data-mark-banner>
                    <span>Could not mark notifications. Try again.</span>
                    <button type="button" className={styles.bannerRetry} data-mark-retry ref={notesRetry} onClick={markNotes}>Try again</button>
                  </p>}
                  <ul className={styles.list} ref={notesPaged.listRef as RefObject<HTMLUListElement | null>}>
                    {notesPaged.rows.map(entry => {
                      if (entry.kind === 'notice') {
                        return titles && <NoticeCard key={`notice:${entry.notice.key}`} notice={entry.notice} fresh={entry.notice.atMs > seenAtOpen} titles={titles} wear={wear}
                          onChoose={chooseTitle} />;
                      }
                      if (isRested(entry.result)) {
                        const rest = entry.result, fresh = rest.settledAtMs > seenAtOpen;
                        const { title, lines } = restedNoteLines(rest, rest.name, rules);
                        return <li key={rest.activityId} className={styles.card} data-page-row="" tabIndex={-1} data-notification data-rested="" data-unread={fresh ? '' : undefined}>
                          <span className={styles.rowTop}>
                            <span className={styles.rowTitle}>
                              {fresh && <span className={styles.dot} data-unread-dot aria-hidden="true" />}
                              {fresh && <span className={styles.sr}>New: </span>}
                              <span className={fresh ? styles.titleNew : styles.title} data-notification-title>{title}</span>
                            </span>
                            <span className={styles.date}>{messageDate(rest.settledAtMs)}</span>
                          </span>
                          <ul className={styles.lines}>{lines.map((line, n) => <li key={n}>{line}</li>)}</ul>
                        </li>;
                      }
                      const note = entry.result;
                      const { title, lines, levelUp } = notificationLines(note);
                      const fresh = isNewNotification(note, seenAtOpen);
                      const label = watch && watch.kept(note) ? watchLabel(note) : null;
                      const earned = titles ? resultTitleRows(titles.held, note.activityId) : [];
                      return <li key={note.activityId} className={styles.card} data-page-row="" tabIndex={-1} data-notification data-unread={fresh ? '' : undefined}>
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
                  <PanelFooter><Pager list={notesPaged} show /></PanelFooter>
                </>}
              </>}
          </div>
        )}
      </PagingScope>
      {feedback && !detail && !patches && <div className={styles.foot} data-feedback-foot="">
        <button ref={sendButton} type="button" className={styles.sendFeedback} aria-haspopup="dialog" onClick={() => setWriting(true)}><Speech />Send feedback</button>
        {mine ? (own.value && <span className={styles.footHint}>{leftToday(own.value, feedback.clock.now())} left today</span>)
          : <button type="button" className={styles.mineLink} data-feedback-mine="" aria-label={unseen > 0 ? `My feedback, ${unseen} new answer${unseen === 1 ? '' : 's'}` : undefined}
            onClick={openMine}>My feedback{unseen > 0 && <span className={styles.ping} aria-hidden="true">{badgeText(unseen)}</span>}</button>}
      </div>}
      {writing && feedback && <FeedbackDialog actions={feedback} screen="Messages" canSeeMine onClose={closeDialog} />}
      <div className={styles.sr} role="status" aria-live="polite" data-mark-status>{announce}</div>
    </section>
  );
}
