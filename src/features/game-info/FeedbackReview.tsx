'use client';

// The owner's Feedback tab in Game Info (patch 1.9, the approved mockup and notes.md "Owner (Avi only)"): shown only to a Game Info editor,
// like the editor itself. New, Answered or All (newest first, "N shown"); each item shows its category, its status (New, Read, Answered), the
// gladiator, the time, the text, what was sent with it, and the answer once there is one. Answer opens a text box (1,000 characters) for that
// player, "Sends a message and marks it Answered."; Mark read is offered on a New item only. The status moves New → Read (Mark read, or
// Answer) → Answered. The tab's count is the number of New items (`onCount`). Player text is data: only ever shown as text.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { OwnerFeedbackItem } from '@contracts/reads';
import { useClockMode } from '../../lib/clock-setting';
import { categoryLabel, feedbackDate, ownerDetails, ownerStatus } from '../messages/feedback';
import feedbackStyles from '../messages/feedback.module.css';
import { answerFeedback, listFeedback, markFeedbackRead, type FeedbackFilter } from './feedback-review';
import styles from './game-info.module.css';

const FILTERS: readonly { id: FeedbackFilter; label: string }[] = [{ id: 'new', label: 'New' }, { id: 'answered', label: 'Answered' }, { id: 'all', label: 'All' }];
const STATUS_CLASS = { new: feedbackStyles.statusNew, read: feedbackStyles.statusRead, answered: feedbackStyles.statusAnswered } as const;
/** The answer box's limit (the mockup's; the server takes up to 2,000). */
const ANSWER_MAXIMUM = 1000;

export function FeedbackReview({ onCount }: {
  /** How many items are New in all (the tab's red count), after every read of the list. */
  onCount(count: number): void;
}) {
  const ids = useId();
  const clock = useClockMode();
  const [filter, setFilter] = useState<FeedbackFilter>('new');
  const [items, setItems] = useState<OwnerFeedbackItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [answering, setAnswering] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ id: number; text: string } | null>(null);
  const ticket = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const filters = useRef<HTMLDivElement>(null);

  // Only the latest read lands, and nothing after the tab is gone.
  const load = useCallback(async (which: FeedbackFilter) => {
    const mine = ++ticket.current;
    const result = await listFeedback(which);
    if (mine !== ticket.current) return;
    if (result.ok) { setItems(result.items); setFailed(false); onCount(result.newCount); } else setFailed(true);
  }, [onCount]);
  useEffect(() => { void load(filter); }, [filter, load]);
  useEffect(() => () => { ticket.current++; }, []);
  useEffect(() => { if (answering !== null) box.current?.focus(); }, [answering]);

  const choose = (next: FeedbackFilter) => { setFilter(next); setAnswering(null); setProblem(null); };
  async function markRead(item: OwnerFeedbackItem) {
    if (busy) return;
    setBusy(true); setProblem(null);
    const result = await markFeedbackRead(item.id);
    setBusy(false);
    if (!result.ok) { setProblem({ id: item.id, text: 'Could not mark it read. Try again.' }); return; }
    await load(filter);
    filters.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }
  async function send(item: OwnerFeedbackItem) {
    const text = draft.trim();
    if (busy || !text) return;
    setBusy(true); setProblem(null);
    const result = await answerFeedback(item.id, text);
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'conflict') { setAnswering(null); setDraft(''); setProblem({ id: item.id, text: 'This feedback was already answered.' }); await load(filter); return; }
      setProblem({ id: item.id, text: 'Could not send the answer. Your text is still here. Try again.' });
      return;
    }
    setAnswering(null); setDraft('');
    await load(filter);
    filters.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }

  const now = Date.now();
  return <div className={styles.feedback}>
    <div className={styles.feedbackBar}>
      <div ref={filters} className={styles.fseg} role="group" aria-label="Show">
        {FILTERS.map(option => <button key={option.id} type="button" aria-pressed={filter === option.id} onClick={() => choose(option.id)}>{option.label}</button>)}
      </div>
      {items && <span className={styles.feedbackCount}>Newest first · {items.length} shown</span>}
    </div>
    {items === null ? (failed ? <div className={styles.feedbackState}>
      <p role="alert">Feedback could not be loaded.</p>
      <button type="button" onClick={() => void load(filter)}>Try again</button>
    </div> : <p role="status" className={styles.feedbackState}>Loading feedback…</p>) : <>
      {failed && <p role="alert" className={styles.feedbackState}>Feedback could not be loaded again. <button type="button" onClick={() => void load(filter)}>Try again</button></p>}
      {items.length === 0 ? <p className={styles.feedbackState}>Nothing here. New feedback from players shows up in this list.</p>
        : <ul className={styles.feedbackList} aria-label="Feedback">
          {items.map(item => {
            const details = ownerDetails(item.details, clock);
            const who = item.gladiatorName;
            const textId = `${ids}-answer-${item.id}`;
            return <li key={item.id}>
              <article className={styles.feedbackItem} data-feedback-item={item.id} data-new={item.status === 'new' ? '' : undefined}>
                <div className={styles.feedbackTop}>
                  <span className={`${feedbackStyles.pill} ${feedbackStyles[item.category]}`}>{categoryLabel(item.category)}</span>
                  <span className={`${feedbackStyles.pill} ${STATUS_CLASS[item.status]}`}>{ownerStatus(item.status)}</span>
                  {who !== null ? <b className={styles.feedbackWho}>{who}</b> : <span className={styles.feedbackHint}>No gladiator</span>}
                  <span className={styles.feedbackWhen}>{feedbackDate(item.createdAtMs, now, clock, true)}</span>
                </div>
                <p className={styles.feedbackText}>{item.text}</p>
                <p className={styles.feedbackDetails}>{details ? <><b>Sent with it:</b> {details}</> : 'Sent without game details.'}</p>
                {item.answer !== null && <div className={feedbackStyles.answer} data-feedback-answer=""><b>Your answer</b><p>{item.answer}</p></div>}
                {item.status !== 'answered' && (answering === item.id ? <div className={styles.feedbackAnswer}>
                  <label htmlFor={textId}>Answer to {who ?? 'this player'} (they get a message)</label>
                  <textarea ref={box} id={textId} maxLength={ANSWER_MAXIMUM} rows={4} value={draft} aria-describedby={`${textId}-help`} onChange={event => setDraft(event.target.value)} />
                  <div className={styles.feedbackRow}><span id={`${textId}-help`}>Sends a message and marks it Answered.</span><span>{[...draft].length} / 1,000</span></div>
                  <div className={styles.feedbackActions}>
                    <button type="button" className={styles.gold} disabled={!draft.trim()} aria-disabled={busy || undefined} onClick={() => void send(item)}>Send answer</button>
                    <button type="button" className={styles.ghost} onClick={() => { setAnswering(null); setProblem(null); }}>Cancel</button>
                  </div>
                </div> : <div className={styles.feedbackActions}>
                  <button type="button" className={styles.gold} aria-disabled={busy || undefined} onClick={() => { if (!busy) { setDraft(''); setProblem(null); setAnswering(item.id); } }}>Answer</button>
                  {item.status === 'new' && <button type="button" className={styles.ghost} aria-disabled={busy || undefined} onClick={() => void markRead(item)}>Mark read</button>}
                </div>)}
                {problem?.id === item.id && <p role="alert" className={styles.feedbackProblem}>{problem.text}</p>}
              </article>
            </li>;
          })}
        </ul>}
    </>}
  </div>;
}
