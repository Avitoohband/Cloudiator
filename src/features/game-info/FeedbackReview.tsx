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
// M37 (Task 25, from the Task 23b review): an approval names the time of the suggestion the owner saw (the item's, or the one Edit filled
// the box from), and the server refuses it as a conflict when Claude has replaced the suggestion since; the list then reloads with the
// new one. Sending one item never closes or clears the box open on another.
// Task 27 (from the M37 review): when Claude replaced the suggestion an edit was made from, the owner's open box and edited draft stay under
// the alert; the box then goes with the suggestion now shown, so sending the edit again (having read the new one) is not refused again.
// Only an item known to be answered closes its box. When the reloaded list cannot say why (the item left the list shown, or the reload
// failed), the box and draft stay and the alert says so in neutral words (fix round 1); an alert for an item no longer listed shows above
// the list.
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { OwnerFeedbackItem } from '@contracts/reads';
import { useClockMode } from '../../lib/clock-setting';
import { categoryLabel, feedbackDate, ownerDetails, ownerStatus } from '../messages/feedback';
import feedbackStyles from '../messages/feedback.module.css';
import { answerFeedback, listFeedback, markFeedbackRead, type FeedbackFilter } from './feedback-review';
import { Pager } from '../paging/Pager';
import { PanelFooter } from '../paging/PanelFooter';
import { usePagedList } from '../paging/usePagedList';
import styles from './game-info.module.css';

const FILTERS: readonly { id: FeedbackFilter; label: string }[] = [{ id: 'new', label: 'New' }, { id: 'answered', label: 'Answered' }, { id: 'all', label: 'All' }];
const NO_ITEMS: readonly OwnerFeedbackItem[] = [];
const STATUS_CLASS = { new: feedbackStyles.statusNew, read: feedbackStyles.statusRead, answered: feedbackStyles.statusAnswered } as const;
/** The answer box's limit (the mockup's; the server takes up to 2,000, the limit of an edited suggestion). */
const ANSWER_MAXIMUM = 1000;
const SUGGESTION_MAXIMUM = 2000;
/** A refused send whose reason the reloaded list cannot show (fix round 1). */
const CHANGED = 'This feedback changed. It may have been answered, or Claude replaced the suggestion. Reload and check before sending.';
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
  /** The item whose box is open now, for a send that finishes after the owner moved on (it closes only its own box). */
  const answeringNow = useRef<number | null>(null);
  /** The time of Claude's suggestion the open box was filled from (Edit), or null for the owner's own words (Answer). */
  const [suggestionAt, setSuggestionAt] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ id: number; text: string } | null>(null);
  const ticket = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const filters = useRef<HTMLDivElement>(null);
  // Patch 1.9 Task 31: 6 items a page; New, Answered and All go back to page 1.
  const paged = usePagedList(items ?? NO_ITEMS, { list: 'feedback', resetKey: filter });

  // Only the latest read lands, and nothing after the tab is gone. It answers the items it showed (null when it did not land).
  const load = useCallback(async (which: FeedbackFilter): Promise<OwnerFeedbackItem[] | null> => {
    const mine = ++ticket.current;
    const result = await listFeedback(which);
    if (mine !== ticket.current) return null;
    if (result.ok) { setItems(result.items); setFailed(false); onCount(result.newCount); return result.items; }
    setFailed(true);
    return null;
  }, [onCount]);
  const openBox = (id: number | null) => { answeringNow.current = id; setAnswering(id); };
  useEffect(() => { void load(filter); }, [filter, load]);
  useEffect(() => () => { ticket.current++; }, []);
  useEffect(() => { if (answering !== null) box.current?.focus(); }, [answering]);

  const choose = (next: FeedbackFilter) => { setFilter(next); openBox(null); setProblem(null); };
  const open = (item: OwnerFeedbackItem, suggested: boolean) => {
    if (busy) return;
    setDraft(suggested ? item.suggestion ?? '' : ''); setSuggestionAt(suggested ? item.suggestedAtMs : null); setProblem(null); openBox(item.id);
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
  /**
   * Sends the open box's text, or (`approve`) the suggestion exactly as shown. A suggestion's text goes with the time of the suggestion
   * it came from: this item's (Approve and send) or the one Edit filled the box from. Only this item's box closes, never another's.
   */
  async function send(item: OwnerFeedbackItem, approve = false) {
    const at = approve ? item.suggestedAtMs : suggestionAt;
    const text = (approve ? item.suggestion ?? '' : draft).trim();
    if (busy || !text || (approve && at === null)) return;
    setBusy(true); setProblem(null);
    const result = await answerFeedback(item.id, text, at === null ? undefined : { suggestedAtMs: at });
    setBusy(false);
    const closeOwnBox = () => { if (answeringNow.current === item.id) { openBox(null); setDraft(''); } };
    if (!result.ok) {
      if (result.code === 'conflict') {
        // Answered meanwhile, or (an approval) Claude replaced the suggestion: the reloaded list shows which, when it still lists the item.
        const shown = (await load(filter))?.find(other => other.id === item.id);
        const answered = shown?.status === 'answered';
        const replaced = at !== null && shown !== undefined && !answered && shown.suggestion !== null;
        // A replaced suggestion keeps this item's open box and its draft (nothing typed is lost); its next send names the new suggestion.
        if (answered) closeOwnBox();
        else if (replaced && !approve && answeringNow.current === item.id) setSuggestionAt(shown.suggestedAtMs);
        setProblem({ id: item.id, text: answered ? 'This feedback was already answered.'
          : replaced ? 'Claude changed this suggestion after you opened it. Read the new one, then send again.' : CHANGED });
        return;
      }
      setProblem({ id: item.id, text: approve ? 'Could not send the answer. Try again.' : 'Could not send the answer. Your text is still here. Try again.' });
      return;
    }
    closeOwnBox();
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
      {problem && !items.some(item => item.id === problem.id) && <p role="alert" className={styles.feedbackProblem} data-feedback-problem="">{problem.text}</p>}
      {items.length === 0 ? <p className={styles.feedbackState}>Nothing here. New feedback from players shows up in this list.</p>
        : <><ul className={styles.feedbackList} aria-label="Feedback" ref={paged.listRef as RefObject<HTMLUListElement | null>}>
          {paged.rows.map(item => {
            const details = ownerDetails(item.details, clock);
            const who = item.gladiatorName;
            const textId = `${ids}-answer-${item.id}`;
            const editing = answering === item.id && suggestionAt !== null;
            const limit = editing ? SUGGESTION_MAXIMUM : ANSWER_MAXIMUM;
            return <li key={item.id} data-page-row="" tabIndex={-1}>
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
                    <button type="button" className={styles.ghost} onClick={() => { openBox(null); setProblem(null); }}>Cancel</button>
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
        </ul>
        <PanelFooter><Pager list={paged} show /></PanelFooter></>}
    </>}
  </div>;
}
