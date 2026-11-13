'use client';

// The owner's Feedback tab in Game Info (patch 1.9, the approved mockup and notes.md "Owner (Avi only)"): shown only to a Game Info editor,
// like the editor itself. New, Answered or All (newest first, "N shown"); each item shows its category, its status (New, Read, Answered), the
// gladiator, the time, the text, what was sent with it, and the answer once there is one. Answer opens a text box (1,000 characters) for that
// player, "Sends a message and marks it Answered."; Mark read is offered on a New item only. The status moves New → Read (Mark read, or
// Answer) → Answered. The tab's count is the number of New items (`onCount`). Player text is data: only ever shown as text.
// M36 (Task 23b; Avi: "You can directly reply but only I approve"): Claude may save a suggested answer through the Game Info MCP. It shows
// under the text as "Suggested by Claude" with Approve and send (sends it as shown) and Edit (fills the answer box with it, up to the
// server's 2,000 characters); either is recorded as an approved suggestion, and the item then reads "Answered (approved suggestion)".
// Answer still opens an empty box for the owner's own words. Nothing reaches a player until the owner sends it here.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { OwnerFeedbackItem } from '@contracts/reads';
import { useClockMode } from '../../lib/clock-setting';
import { categoryLabel, feedbackDate, ownerDetails, ownerStatus } from '../messages/feedback';
import feedbackStyles from '../messages/feedback.module.css';
import { answerFeedback, listFeedback, markFeedbackRead, type FeedbackFilter } from './feedback-review';
import styles from './game-info.module.css';

const FILTERS: readonly { id: FeedbackFilter; label: string }[] = [{ id: 'new', label: 'New' }, { id: 'answered', label: 'Answered' }, { id: 'all', label: 'All' }];
const STATUS_CLASS = { new: feedbackStyles.statusNew, read: feedbackStyles.statusRead, answered: feedbackStyles.statusAnswered } as const;
/** The answer box's limit (the mockup's; the server takes up to 2,000, the limit of an edited suggestion). */
const ANSWER_MAXIMUM = 1000;
const SUGGESTION_MAXIMUM = 2000;
const statusText = (item: OwnerFeedbackItem) => item.status === 'answered' && item.answeredVia === 'claude-approved' ? 'Answered (approved suggestion)' : ownerStatus(item.status);

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
  /** Whether the open box holds Claude's suggestion (Edit) rather than the owner's own words (Answer). */
  const [fromSuggestion, setFromSuggestion] = useState(false);
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
  const open = (item: OwnerFeedbackItem, suggested: boolean) => {
    if (busy) return;
    setDraft(suggested ? item.suggestion ?? '' : ''); setFromSuggestion(suggested); setProblem(null); setAnswering(item.id);
  };
  async function markRead(item: OwnerFeedbackItem) {
    if (busy) return;
    setBusy(true); setProblem(null);
    const result = await markFeedbackRead(item.id);
    setBusy(false);
    if (!result.ok) { setProblem({ id: item.id, text: 'Could not mark it read. Try again.' }); return; }
    await load(filter);
    filters.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }
  /** Sends the open box's text, or (`approve`) the suggestion exactly as shown. */
  async function send(item: OwnerFeedbackItem, approve = false) {
    const suggested = approve || fromSuggestion;
    const text = (approve ? item.suggestion ?? '' : draft).trim();
    if (busy || !text) return;
    setBusy(true); setProblem(null);
    const result = await answerFeedback(item.id, text, suggested);
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'conflict') { setAnswering(null); setDraft(''); setProblem({ id: item.id, text: 'This feedback was already answered.' }); await load(filter); return; }
      setProblem({ id: item.id, text: approve ? 'Could not send the answer. Try again.' : 'Could not send the answer. Your text is still here. Try again.' });
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
            const editing = answering === item.id && fromSuggestion;
            const limit = editing ? SUGGESTION_MAXIMUM : ANSWER_MAXIMUM;
            return <li key={item.id}>
              <article className={styles.feedbackItem} data-feedback-item={item.id} data-new={item.status === 'new' ? '' : undefined}>
                <div className={styles.feedbackTop}>
                  <span className={`${feedbackStyles.pill} ${feedbackStyles[item.category]}`}>{categoryLabel(item.category)}</span>
                  <span className={`${feedbackStyles.pill} ${STATUS_CLASS[item.status]}`}>{statusText(item)}</span>
                  {/* The mockup's "gladiator <name>": the team sees the gladiator's name only, never an account. */}
                  <span className={styles.feedbackHint}>{who !== null ? `gladiator ${who}` : 'No gladiator'}</span>
                  <span className={styles.feedbackWhen}>{feedbackDate(item.createdAtMs, now, clock, true)}</span>
                </div>
                <p className={styles.feedbackText}>{item.text}</p>
                <p className={styles.feedbackDetails}>{details ? <><b>Sent with it:</b> {details}</> : 'Sent without game details.'}</p>
                {item.answer !== null && <div className={feedbackStyles.answer} data-feedback-answer=""><b>Your answer</b><p>{item.answer}</p></div>}
                {item.status !== 'answered' && item.suggestion !== null && <div className={styles.suggestion} data-feedback-suggestion="">
                  <b>Suggested by Claude</b><p>{item.suggestion}</p>
                </div>}
                {item.status !== 'answered' && (answering === item.id ? <div className={styles.feedbackAnswer}>
                  <label htmlFor={textId}>Answer to {who !== null ? `gladiator ${who}` : 'this player'} (they get a message)</label>
                  <textarea ref={box} id={textId} maxLength={limit} rows={4} value={draft} aria-describedby={`${textId}-help`} onChange={event => setDraft(event.target.value)} />
                  <div className={styles.feedbackRow}>
                    <span id={`${textId}-help`}>{editing ? 'Sends your edit of Claude’s suggestion and marks it Answered.' : 'Sends a message and marks it Answered.'}</span>
                    <span>{[...draft].length.toLocaleString('en-US')} / {limit.toLocaleString('en-US')}</span>
                  </div>
                  <div className={styles.feedbackActions}>
                    <button type="button" className={styles.gold} disabled={!draft.trim()} aria-disabled={busy || undefined} onClick={() => void send(item)}>Send answer</button>
                    <button type="button" className={styles.ghost} onClick={() => { setAnswering(null); setProblem(null); }}>Cancel</button>
                  </div>
                </div> : <div className={styles.feedbackActions}>
                  {item.suggestion !== null && <>
                    <button type="button" className={styles.gold} aria-disabled={busy || undefined} onClick={() => void send(item, true)}>Approve and send</button>
                    <button type="button" className={styles.ghost} aria-disabled={busy || undefined} onClick={() => open(item, true)}>Edit</button>
                  </>}
                  <button type="button" className={item.suggestion !== null ? styles.ghost : styles.gold} aria-disabled={busy || undefined} onClick={() => open(item, false)}>Answer</button>
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
