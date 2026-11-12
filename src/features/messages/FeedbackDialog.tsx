'use client';

// The Send feedback dialog (patch 1.9, the approved mockup and notes.md "Feedback"): a small modal over the camp, opened from the Messages
// panel's footer and from Settings → Help. What it is about (Bug, Idea, Balance, Other; Idea first) with a line for each, the message (10 to
// 1,000 characters once trimmed; a counter, and "Write at least 10 characters." under the minimum), and "Include game details" (on at first:
// the five details only, which "What is sent?" shows). The limit line says what is left of 5 a game day (the account's own feedback, read when
// the dialog opens); at 0 it says when the next game day starts and Send stays off. Send sends one `send-feedback`; the same command (and
// operation id) goes again after an answer that left the outcome open, a changed one gets a new id. Sent, it turns into "Feedback sent" with
// "See my feedback" (where the Messages panel exists) and Close. A `daily-limit` answer shows the limit state with the text kept; any other
// refusal says "Could not send. Your text is still here. Try again." Cancel, Close and Escape close it; while a send is out they do nothing.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { FeedbackCategory } from '@contracts/reads';
import { FEEDBACK } from '@domain/feedback';
import { useClockMode } from '../../lib/clock-setting';
import { gameDayOf } from '../../lib/game-day';
import { PATCH } from '../../lib/patch';
import { timeOfDay } from '../../lib/time-format';
import { useMinuteNow } from '../schedule/use-minute-now';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import {
  CATEGORIES, canSendFeedback, deviceText, feedbackDetails, leftToday, limitLine, placeholderFor, textProblem, type FeedbackActions, type SendFeedbackCommand,
} from './feedback';
import styles from './feedback.module.css';

/** The answers that leave the outcome open: the same command goes again, with its operation id. */
const OPEN_ANSWERS: readonly string[] = ['unavailable', 'processing', 'rate-limited'];

const subscribeView = (onChange: () => void) => {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  window.addEventListener('resize', onChange);
  return () => { query?.removeEventListener('change', onChange); window.removeEventListener('resize', onChange); };
};
/** The game's layout (phone: the touch layout) and the window's size, as one string so the store's value is stable between changes. */
const readView = () => `${window.matchMedia?.(COMPACT_QUERY).matches ? 'phone' : 'desktop'}|${window.innerWidth}|${window.innerHeight}`;

export function FeedbackDialog({ actions, screen, canSeeMine, onClose }: {
  actions: FeedbackActions;
  /** The screen it was opened from, sent as a game detail ("Messages", "Settings"). */
  screen: string;
  /** Whether "See my feedback" is offered once sent (the Messages panel exists: a player with a gladiator). */
  canSeeMine: boolean;
  /** The dialog has closed; `then` is 'mine' after "See my feedback", and `sent` says whether a feedback was accepted. */
  onClose(result: { then: 'mine' | null; sent: boolean }): void;
}) {
  const ids = useId();
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [category, setCategory] = useState<FeedbackCategory>('idea');
  const [text, setText] = useState('');
  const [include, setInclude] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  /** What is left, with the game day it was counted for: a dialog left open into the next game day counts again (fix round 1). */
  const [counted, setCounted] = useState<{ day: number; left: number } | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<{ key: string; command: SendFeedbackCommand } | null>(null);
  const sending = useRef(false), mounted = useRef(true), finished = useRef(false), accepted = useRef(false);
  const nowMs = useMinuteNow(actions.clock);
  const day = gameDayOf(nowMs);
  const left = counted !== null && counted.day === day ? counted.left : null;
  const clock = useClockMode();
  const view = useSyncExternalStore(subscribeView, readView, () => 'desktop|0|0');
  const [layout, width, height] = view.split('|');

  // Modal over the camp: the heading takes the focus, so the dialog opens at its top.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    heading.current?.focus({ preventScroll: true });
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // What is left today: the account's own feedback, counted in the current game day, and again when a new game day starts (a send's
  // answer for the same game day, when it comes first, wins).
  useEffect(() => {
    let alive = true;
    actions.load().then(list => {
      if (!alive) return;
      const now = actions.clock.now(), at = gameDayOf(now);
      setCounted(previous => (previous !== null && previous.day === at ? previous : { day: at, left: leftToday(list, now) }));
    }, () => undefined);
    return () => { alive = false; };
  }, [actions, day]);
  useEffect(() => { if (sent) heading.current?.focus(); }, [sent]);

  const finish = (then: 'mine' | null) => {
    if (finished.current) return;
    finished.current = true;
    if (dialog.current?.open) dialog.current.close();
    onClose({ then, sent: accepted.current });
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !canSendFeedback(text, left)) return;
    const key = JSON.stringify([category, text, include]);
    const command: SendFeedbackCommand = attempt.current?.key === key ? attempt.current.command : {
      kind: 'send-feedback', operationId: crypto.randomUUID(), category, text,
      details: include ? feedbackDetails({ screen, userAgent: navigator.userAgent, phone: layout === 'phone', width: Number(width), height: Number(height), sentAtMs: Date.now() }) : null,
    };
    attempt.current = { key, command };
    sending.current = true; setBusy(true); setFailed(false);
    try {
      const result = await actions.send(command);
      if (!mounted.current) return;
      if (result.ok) {
        attempt.current = null;
        accepted.current = true;
        setCounted({ day: gameDayOf(actions.clock.now()), left: Math.max(0, result.value.leftToday) });
        setText('');
        setSent(true);
        return;
      }
      if (result.code === 'daily-limit') { attempt.current = null; setCounted({ day: gameDayOf(actions.clock.now()), left: 0 }); return; }
      if (!OPEN_ANSWERS.includes(result.code)) attempt.current = null;
      setFailed(true);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const headingId = `${ids}-heading`;
  const hint = CATEGORIES.find(c => c.id === category)?.hint ?? '';
  const problem = textProblem(text);
  const ready = canSendFeedback(text, left);
  const shownAt = timeOfDay(Date.now(), clock);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={headingId}
    onClose={() => finish(null)} onCancel={event => { event.preventDefault(); if (!sending.current) finish(null); }}>
    {sent ? <>
      <h2 id={headingId} ref={heading} className={styles.heading} tabIndex={-1}>Feedback sent</h2>
      <p className={styles.ok} role="status">Thanks — your feedback was sent. The team’s answer will arrive in your messages.</p>
      <p className={styles.limit}>{limitLine(left, nowMs)}</p>
      <div className={styles.actions}>
        {canSeeMine && <button type="button" className={styles.ghost} onClick={() => finish('mine')}>See my feedback</button>}
        <button type="button" className={styles.gold} onClick={() => finish(null)}>Close</button>
      </div>
    </> : <form onSubmit={submit} noValidate aria-busy={busy || undefined}>
      <h2 id={headingId} ref={heading} className={styles.heading} tabIndex={-1}>Send feedback</h2>
      <p className={styles.sub}>Tell the team what you found or what you would like to see.</p>
      <span className={styles.label} id={`${ids}-kind`}>What is it about?</span>
      <div className={styles.seg} role="radiogroup" aria-labelledby={`${ids}-kind`} aria-describedby={`${ids}-hint`}>
        {CATEGORIES.map(choice => <label key={choice.id}>
          <input type="radio" name={`${ids}-category`} value={choice.id} checked={category === choice.id} onChange={() => setCategory(choice.id)} />
          <span>{choice.label}</span>
        </label>)}
      </div>
      <p id={`${ids}-hint`} className={styles.categoryHint}>{hint}</p>
      <label className={styles.label} htmlFor={`${ids}-text`}>Your message</label>
      <textarea id={`${ids}-text`} className={styles.text} maxLength={FEEDBACK.textMaximum} rows={5} placeholder={placeholderFor(category)} value={text}
        aria-describedby={`${ids}-note ${ids}-count`} aria-invalid={problem ? true : undefined} onChange={event => { setText(event.target.value); setFailed(false); }} />
      <div className={styles.row}>
        <span id={`${ids}-note`} className={problem ? styles.error : undefined}>{problem ?? 'Please do not include passwords or personal details.'}</span>
        <span id={`${ids}-count`}>{[...text].length} / 1,000</span>
      </div>
      <div className={styles.check}>
        <input type="checkbox" id={`${ids}-include`} checked={include} aria-describedby={`${ids}-include-help`} onChange={event => setInclude(event.target.checked)} />
        <div>
          <label htmlFor={`${ids}-include`}>Include game details</label>
          <p id={`${ids}-include-help`} className={styles.hint}>Helps the team find the problem.{' '}
            <button type="button" className={styles.link} aria-expanded={include && showDetails} aria-controls={include && showDetails ? `${ids}-details` : undefined}
              onClick={() => setShowDetails(open => !open)}>{showDetails ? 'Hide' : 'What is sent?'}</button>
          </p>
        </div>
      </div>
      {include && showDetails && <div id={`${ids}-details`} className={styles.attached} data-feedback-details="">
        <p><b>Patch</b> {PATCH} · <b>Screen</b> {screen}</p>
        <p><b>Device</b> {deviceText(navigator.userAgent, layout === 'phone')}</p>
        <p><b>Sent at</b> {shownAt} · <b>Window</b> {width} x {height}</p>
        <p className={styles.hint}>Nothing else. The team sees your gladiator’s name, and the answer comes to your messages.</p>
      </div>}
      {/* A polite status (fix round 1): a daily-limit answer is said where the player is, and the focus stays on Send. */}
      <p className={left === 0 ? styles.limitZero : styles.limit} role="status">{limitLine(left, nowMs)}</p>
      {failed && <p className={styles.alert} role="alert">Could not send. Your text is still here. Try again.</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={() => { if (!sending.current) finish(null); }}>Cancel</button>
        {/* At 0 left Send stays focusable (aria-disabled), so a refused send keeps the focus; `submit` refuses it. */}
        <button type="submit" className={styles.gold} disabled={!ready && left !== 0} aria-disabled={busy || left === 0 || undefined}>Send</button>
      </div>
    </form>}
  </dialog>;
}
