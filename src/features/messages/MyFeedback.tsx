'use client';

// My feedback (patch 1.9, the approved mockup and notes.md "Feedback"): a view of the Messages panel under "Back to messages". The summary
// ("My feedback · 3 sent · 1 answered"), then the account's own feedback newest first, each a disclosure button with its category, its
// status (Sent, Read, Answered) and date, and two lines of its text. Opened, an answered item shows the team's answer (its team-reply
// message, which opening it marks read), a read one says the team has read it, a sent one that the team has not opened it yet. The text is
// data, shown as plain text.
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { GameMessage, Inbox, OwnFeedback } from '@contracts/reads';
import { useClockMode } from '../../lib/clock-setting';
import { categoryLabel, feedbackDate, mineSummary, playerStatus, replyFor } from './feedback';
import { isUnread } from './messages';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
import { usePagedList } from '../paging/usePagedList';
import type { Loaded } from './useLoadedList';
import messages from './messages.module.css';
import styles from './feedback.module.css';

const NO_FEEDBACK: readonly OwnFeedback[] = [];
const STATUS_CLASS = { new: styles.statusSent, read: styles.statusRead, answered: styles.statusAnswered } as const;

export function MyFeedback({ list, held, inbox, nowMs, onSeen }: {
  /** The account's own feedback as last read. */
  list: Loaded<OwnFeedback[]>;
  /** The messages the panel holds: an answer is read from its team-reply message. */
  held: readonly GameMessage[];
  inbox: Inbox;
  /** The shared clock's time to the minute: the rows' dates ("Today 14:12", "Yesterday"). */
  nowMs: number;
  /** An answered item was opened while its reply is unread: the panel marks the reply read (once). */
  onSeen(reply: GameMessage): void;
}) {
  const ids = useId();
  const clock = useClockMode();
  const [open, setOpen] = useState<number | null>(null);
  const items = list.value;
  // Patch 1.9 Task 31: 6 items a page. A feedback just sent is the newest: the list turns to page 1 to show it.
  const paged = usePagedList(items ?? NO_FEEDBACK, { list: 'feedback' });
  const newest = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const now = items ? items[0]?.id ?? null : undefined;
    if (now === undefined) return;
    if (newest.current !== undefined && newest.current !== now) paged.goToIndex(0);
    newest.current = now;
  });
  if (items === null) {
    return list.failed ? <div className={messages.state}>
      <p role="alert">Your feedback could not be loaded.</p>
      <button type="button" className={messages.retry} onClick={list.reload}>Try again</button>
    </div> : <p role="status" className={messages.state}>Loading your feedback…</p>;
  }
  const toggle = (item: OwnFeedback) => {
    const opening = open !== item.id;
    setOpen(opening ? item.id : null);
    const reply = replyFor(item, held);
    if (opening && reply && isUnread(reply, inbox)) onSeen(reply);
  };
  return <>
    <div className={messages.summary}><span className={messages.summaryText}>{mineSummary(items)}</span></div>
    {list.failed && <p className={`${messages.banner} ${messages.bannerErr}`}><span>Your feedback could not be loaded again.</span>
      <button type="button" className={messages.bannerRetry} onClick={list.reload}>Try again</button></p>}
    {items.length === 0 ? <p className={messages.state}>You have not sent any feedback yet.</p>
      : <ul className={messages.list} aria-label="My feedback" ref={paged.listRef as RefObject<HTMLUListElement | null>}>
        {paged.rows.map(item => {
          const shown = open === item.id, reply = replyFor(item, held);
          return <li key={item.id} className={styles.mine} data-page-row="" tabIndex={-1}>
            <button type="button" className={styles.mineRow} data-feedback-row={item.id} aria-expanded={shown} aria-controls={shown ? `${ids}-${item.id}` : undefined}
              onClick={() => toggle(item)}>
              <span className={messages.rowTop}>
                <span className={styles.pills}>
                  <span className={`${styles.pill} ${styles[item.category]}`}>{categoryLabel(item.category)}</span>
                  <span className={`${styles.pill} ${STATUS_CLASS[item.status]}`}>{playerStatus(item.status)}</span>
                </span>
                <span className={messages.date}>{feedbackDate(item.createdAtMs, nowMs, clock)}</span>
              </span>
              <span className={shown ? styles.mineText : styles.mineClamp}>{item.text}</span>
            </button>
            {shown && <div id={`${ids}-${item.id}`} className={styles.mineMore}>
              {item.status === 'answered' ? (reply ? <div className={styles.answer} data-feedback-answer="">
                <b>Answer from the team</b>
                {reply.body.map((block, n) => <p key={n}>{'p' in block ? block.p : `• ${block.li}`}</p>)}
              </div> : <p className={styles.hint}>The team answered. The answer is in your messages.</p>)
                : <p className={styles.hint}>{item.status === 'read' ? 'The team has read it. An answer arrives in your messages if it needs one.' : 'Sent. The team has not opened it yet.'}</p>}
            </div>}
          </li>;
        })}
      </ul>}
    <PanelFooter><Pager list={paged} show /></PanelFooter>
    <p className={styles.mineFoot}>Statuses: Sent → Read → Answered. Answers also arrive as a message.</p>
  </>;
}
