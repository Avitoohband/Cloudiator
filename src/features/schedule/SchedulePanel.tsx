'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ActivityChoice, DayScheduleValue, GameCommand, Phase, Schedule } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { nextPhaseStart } from '@domain/clock';
import { RULES_V1 } from '@domain/rules-v1';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { useOutcomeFocus } from '../shell/focus-lost';
import { PHASES, arenaNote, choiceHint, choicesFor, lockedChoices, optionLabel, runningNotice, runningPart, savedSummary } from './schedule-text';
import { slotTimeText } from './slot-time';
import { useMinuteNow } from './use-minute-now';

const choiceKey = (choice: ActivityChoice) => choice.kind === 'expedition' ? `expedition:${choice.expeditionId}` : choice.kind;
const choiceOf = (value: string): ActivityChoice => value.startsWith('expedition:') ? { kind: 'expedition', expeditionId: value.split(':')[1] as 'woodland' | 'outpost' | 'mountain' }
  : { kind: value as 'rest' | 'training' | 'arena' };
const sameChoice = (a: ActivityChoice, b: ActivityChoice) => choiceKey(a) === choiceKey(b);
type Edit = Extract<GameCommand, { kind: 'edit-day-schedule' }>;
const SLOT_MS = RULES_V1.clock.slotMs;
/** How often the panel checks the shared clock for a slot boundary while the tab is visible. */
const TICK_MS = 1000;
/** Refusals that say nothing about the choice itself (a retry or a reload answers them): its field is not invalid. */
const NOT_THE_CHOICE = ['processing', 'conflict', 'unavailable', 'rate-limited'];

/**
 * The repeating schedule: the whole day is one draft (a choice for each part), saved with one button as one command that the
 * server applies in full or not at all (launch feedback, 2026-10-25). Each part offers only the choices it may hold (Arena
 * only in the evening) and says what its choice costs; the part running now says so, when it ends and that a change to it
 * starts with its next occurrence.
 *
 * The estimated next start of each part and the running part come from the shared display clock (estimated server time), and
 * follow it: past a slot boundary, or when the clock is held or moved, they move with it, so the panel never shows a start
 * that has already passed or the wrong part as running (the Task 6 stale-clock gate). Its times are short (`slotTimeText`,
 * Task 23.10) and shown against the same clock by the minute, so "tomorrow" and the weekday follow it too.
 */
export function SchedulePanel({ owner, gateway, refresh, clock }: { owner: OwnerState; gateway: GameGateway; refresh(): Promise<void>; clock: DisplayClock }) {
  const [draft, setDraft] = useState<Schedule>(owner.schedule);
  /** The saved day the status line answers: the server's answer and the day sent are kept, not their text, so the wording follows the clock. */
  const [message, setMessage] = useState<{ value: DayScheduleValue; day: Schedule } | null>(null);
  const [error, setError] = useState('');
  /** Whether the server refused the day's choices (not a retry or a reload answering a conflict): the changed parts are then marked invalid. */
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelId = useId(), outcomeId = `${panelId}-outcome`, noteId = `${panelId}-note`;
  /** The shared clock's time to the minute, the "now" every time on this panel is shown against. */
  const nowMs = useMinuteNow(clock);
  // A save sent by keyboard whose button lost the focus gives it to the outcome, never to <body>; a pointer save moves
  // nothing (Task 23.5, `useOutcomeFocus`).
  const { outcome, begin, end, target } = useOutcomeFocus(busy);
  /** The slot the shared clock is in; the estimates and the running part depend on nothing else. Null until mounted. */
  const [slot, setSlot] = useState<number | null>(null);
  const sending = useRef(false), mounted = useRef(false);
  const attempt = useRef<Edit | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const draftVersion = useRef(owner.scheduleVersion);
  /** Keep the conflict explanation through its own reload, then clear it on later background versions. */
  const conflictRefresh = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const update = () => setSlot(Math.floor(clock.now() / SLOT_MS));
    update();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    const off = clock.subscribe(update);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); off(); document.removeEventListener('visibilitychange', update); };
  }, [clock]);
  useEffect(() => {
    if (draftVersion.current !== owner.scheduleVersion) {
      draftVersion.current = owner.scheduleVersion; setDraft(owner.schedule); attempt.current = null;
      if (!conflictRefresh.current) setError('');
      conflictRefresh.current = false; setRefused(false);
      // A save may set its success line in the same render as the refreshed owner. Keep only that version's outcome.
      setMessage(current => current?.value.version === owner.scheduleVersion ? current : null);
    }
  }, [owner.scheduleVersion, owner.schedule]);
  /** The parts whose draft choice differs from the saved day. */
  const changed = PHASES.filter(phase => !sameChoice(draft[phase], owner.schedule[phase]));
  const dirty = changed.length > 0;
  /** The outcome describes a control only while it shows: a saved day or a refusal. */
  const outcomeShown = message || error ? outcomeId : undefined;
  function edit(phase: Phase, choice: ActivityChoice) {
    attempt.current = null; setDraft({ ...draft, [phase]: choice }); setError(''); setMessage(null); setRefused(false);
  }
  function undo() {
    if (sending.current) return;
    attempt.current = null; setDraft(owner.schedule); setError(''); setMessage(null); setRefused(false);
    // Undo disables itself (nothing is left to undo), and Chrome then drops its focus to <body> without an event: a keyboard
    // player is put back on the first part that was changed, never left on the page's top (Task 23.5).
    if (document.activeElement === undoButton.current && undoButton.current?.matches(':focus-visible')) document.getElementById(`schedule-${changed[0]}`)?.focus({ preventScroll: true });
  }
  async function save() {
    if (sending.current || !dirty) return;
    begin();
    sending.current = true; setBusy(true); setError(''); setMessage(null); setRefused(false);
    // The same command (and operation id) is sent again after a failure that left the outcome unknown or the world busy; any edit starts a new one.
    const command: Edit = attempt.current ?? { kind: 'edit-day-schedule', operationId: crypto.randomUUID(), expectedVersion: owner.scheduleVersion, day: draft };
    attempt.current = command;
    try {
      const result = await gateway.command<DayScheduleValue>(command);
      if (!mounted.current) return;
      if (result.ok) {
        await refresh();
        if (mounted.current) { attempt.current = null; setMessage({ value: result.value, day: command.day }); }
      } else {
        if (!['processing', 'unavailable', 'rate-limited'].includes(result.code)) attempt.current = null;
        if (result.code === 'conflict') { conflictRefresh.current = draftVersion.current === command.expectedVersion; await refresh(); }
        if (!mounted.current) return;
        setRefused(!NOT_THE_CHOICE.includes(result.code));
        setError(result.code === 'processing' ? 'The world is processing previous results. Retry shortly.'
          : result.code === 'conflict' ? 'Your schedule changed. The latest plan has been loaded; review and save again.'
            : result.code === 'unavailable' ? 'This change could not be confirmed. Retry to confirm the same request.' : `Schedule change rejected: ${result.code}.`);
      }
    } catch { conflictRefresh.current = false; if (mounted.current) { setRefused(false); setError('This change could not be confirmed. Retry to confirm the same request.'); } }
    finally { sending.current = false; end(); if (mounted.current) setBusy(false); }
  }
  /** The part the clock is in (none until mounted); a change to it starts with its next occurrence, three slots on. */
  const slotStart = (slot ?? 0) * SLOT_MS;
  const running = slot === null ? null : runningPart(slotStart);
  /** A phase's estimated next start, left out until mounted or when its time cannot be shown (`slotTimeText` gives ''). */
  const estimate = (phase: Phase) => {
    const time = slot === null ? '' : slotTimeText(nextPhaseStart(phase, slotStart), nowMs);
    return time ? <p>Estimated next start: {time}</p> : null;
  };
  const level = owner.progression.level, locked = lockedChoices(level);
  return <div className="planning-form">
    <h2>Repeating schedule</h2>
    <p className="muted">Edits apply to the next occurrence that has not started. Your current activity continues.</p>
    {running && <p role="note" className="schedule-running">{runningNotice(running, nextPhaseStart(running.phase, slotStart), nowMs)}</p>}
    <div className="schedule-grid">{PHASES.map((phase, index) => {
      const isRunning = running?.phase === phase;
      const note = arenaNote(phase);
      const noteLine = `${panelId}-${phase}-note`, hintLine = `${panelId}-${phase}-hint`;
      const marked = refused && changed.includes(phase);
      const options = [...choicesFor(phase, level).map(choice => ({ choice, shut: false })), ...locked.map(choice => ({ choice, shut: true }))];
      return <article className={`schedule-slot slot-${index}`} key={phase} data-running={isRunning ? '' : undefined}>
        <div className="slot-head"><h3>{phase}</h3>{isRunning && <span className="running-badge">Running now</span>}</div>
        <label htmlFor={`schedule-${phase}`}>{phase} activity</label>
        <select id={`schedule-${phase}`} value={choiceKey(draft[phase])} disabled={busy} onChange={event => edit(phase, choiceOf(event.target.value))}
          aria-invalid={marked ? true : undefined}
          aria-describedby={[note ? noteLine : '', hintLine, marked && outcomeShown ? outcomeShown : ''].filter(Boolean).join(' ')}>
          {options.map(({ choice, shut }) => <option key={choiceKey(choice)} value={choiceKey(choice)} disabled={shut}>{optionLabel(choice)}</option>)}
        </select>
        {note && <p id={noteLine} className="slot-note">{note}</p>}
        <p id={hintLine} className="slot-hint">{choiceHint(draft[phase])}</p>
        {estimate(phase)}
      </article>;
    })}</div>
    {dirty && <p className="schedule-unsaved">Unsaved changes: {changed.join(', ')}.</p>}
    {message && <p ref={outcome} id={outcomeId} role="status" className="schedule-saved" tabIndex={-1} {...target}>{savedSummary(message.value, message.day, nowMs)}</p>}
    {error && <p ref={outcome} id={outcomeId} role="alert" className="form-error" tabIndex={-1} {...target}>{error}</p>}
    <div className="schedule-actions">
      {/* Save stays focusable while the day is sent (aria-disabled; save() ignores a press then): Chrome drops the focus of a
          control that becomes disabled at its next frame, after the shell's focus rescue has looked, and a keyboard player
          would be left on <body> for the whole save. A saved day then disables it and the saved line takes the focus
          (`useOutcomeFocus`); after a refusal the focus stays on Save. */}
      <button type="button" className="primary-button" onClick={() => void save()} disabled={!busy && !dirty} aria-disabled={busy || undefined}
        aria-describedby={[noteId, outcomeShown ?? ''].filter(Boolean).join(' ')}>Save schedule</button>
      <button type="button" ref={undoButton} onClick={undo} disabled={busy || !dirty}>Undo changes</button>
    </div>
    <p id={noteId} className="muted">One save for the whole day: all three parts are saved together, or none is.</p>
  </div>;
}
