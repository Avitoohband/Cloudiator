'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { Attributes, GameCommand, Stance } from '@contracts/commands';
import type { BuildView, ItemInstance, OwnerState } from '@contracts/reads';
import type { BuildInput } from '@domain/types';
import { validateBuild } from '@domain/build';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { deriveStats, preserveStamina } from '@domain/stats';
import type { GameGateway } from '../../lib/api/gateway';
import type { DisplayClock } from '../../game/display-clock';
import { splitNote, suggestedSplit } from '../character/class-bonus';
import { ClassChips } from '../character/ClassCard';
import { cappedNote, pointsLeft, raisedNote, setPoints } from '../character/creation-points';
import { useClockMode } from '../../lib/clock-setting';
import { PointsStepper, usePressHold, type PointsSource } from '../character/PointsStepper';
import { slotTimeText } from '../schedule/slot-time';
import { useMinuteNow } from '../schedule/use-minute-now';
import { useOutcomeFocus } from '../shell/focus-lost';
import { buildRefusal } from './build-refusal';
import { BuildEquipment, equipmentSlots } from './EquipmentInspection';
import { fixedClassAndPoints, fixedKey, refloored } from './fixed-build';

const attributes = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;
const input = (build: BuildView): BuildInput => ({ classId: build.classId, stance: build.stance, allocation: { ...build.allocations }, equipment: { ...build.equipment } });
const title = (value: string) => value[0].toUpperCase() + value.slice(1);
/**
 * The form's draft for a saved build. The class and the attribute points are fixed at the CURRENT build's (Avi, 2026-10-28): a
 * build queued before the release may hold another class or fewer points, and the form must never send one (the server refuses
 * it), so it starts from the current class and from no attribute below the current build's (`fixedClassAndPoints`).
 */
const draftFrom = (build: BuildView, current: BuildView): BuildInput => {
  const { classId, allocations } = fixedClassAndPoints(build, current);
  return { ...input(build), classId, allocation: allocations };
};
/** The note under the points: what they cost, what can no longer be done, and what comes later (the spec's copy). */
const POINTS_NOTE = "Adding points is free. Points can't be taken back once this build takes effect, and your class is fixed. Respec and class changes will come later as paid options.";
/**
 * The status line under the points: what a typed number was capped or raised to, or what "Suggested for {class}" added (`undo` is
 * the allocation from before it, which Undo puts back). Any other edit, and a reload of the build, clears both.
 */
type PointsNote = { text: string; undo: Attributes | null };
const NO_NOTE: PointsNote = { text: '', undo: null };
/** Which fields a build validation reason names (Task 23.5): the attribute points, or the equipment. */
const EQUIPMENT_REASONS = new Set(['item', 'slot', 'level', 'reserved', 'two-handed']);
/** An attribute value the build rules accept: a whole number from 0 to the cap (`validateBuild`'s bounded integer). */
const wholePoints = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= RULES_V1.attributes.maximumPoints;
type BuildCommand = Extract<GameCommand, { kind: 'queue-build' | 'cancel-build' }>;
function BuildSummary({ build, inventory }: { build: BuildView; inventory: ItemInstance[] }) {
  return <><p>{build.classId} · {build.stance}</p><dl>{attributes.map(key => <div key={key}><dt>{key}</dt><dd>{build.allocations[key]}</dd></div>)}
    {equipmentSlots.map(slot => { const item = inventory.find(item => item.id === build.equipment[slot]); return <div key={slot}><dt>{slot}</dt><dd>{item ? CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId : 'None'}</dd></div>; })}</dl></>;
}

export function BuildPanel({ owner, gateway, refresh, clock }: { owner: OwnerState; gateway: GameGateway; refresh(): Promise<void>; clock: DisplayClock }) {
  /** The shared display clock's time to the minute: the pending build's effective time is shown against it (Task 23.10). */
  const nowMs = useMinuteNow(clock);
  const clockMode = useClockMode();
  const [draft, setDraft] = useState(() => draftFrom(owner.pendingBuild?.build ?? owner.currentBuild, owner.currentBuild));
  /** The short status line after a typed number was capped or raised, or the split was suggested; any other edit, and a reload of the build, clears it. */
  const [pointsNote, setPointsNote] = useState<PointsNote>(NO_NOTE);
  /**
   * The control a keyboard command hands the focus to once the one it came from has gone (Suggested leaves with the last point, Undo with the
   * line). Not `useOutcomeFocus`: nothing is sent here, so there is no outcome line to take the focus. Not `useFocusRescue` alone either: it
   * would drop the focus on the menu panel (the nearest container), where the next step is the Undo or Suggested beside it.
   */
  const [focusAfter, setFocusAfter] = useState<'undo' | 'suggest' | null>(null);
  const suggestButton = useRef<HTMLButtonElement>(null), undoButton = useRef<HTMLButtonElement>(null);
  /** What each points field held when it took the focus: the capped line says it differently when that was 0 (as in creation). */
  const heldAtFocus = useRef<Partial<Record<keyof Attributes, number>>>({});
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const attempt = useRef<BuildCommand | null>(null), sending = useRef(false), mounted = useRef(false);
  const draftVersion = useRef(owner.buildVersion);
  /** The class and points the draft's floor was taken from (`fixedKey`): the current build moves without a new build version when the boundary applies a pending build. */
  const draftFloor = useRef(fixedKey(owner.currentBuild));
  const reviewId = useId(), respecId = useId();
  /** A blur that corrects a typed number holds back the Queue build or +1/+5 press that caused it (fix round 2). */
  const pressHold = usePressHold();
  // A command sent by keyboard whose control went away (Cancel pending build removes its section) gives the focus to its
  // outcome, never to <body>; a pointer command moves nothing (Task 23.5, `useOutcomeFocus`).
  const { outcome, begin, end, target } = useOutcomeFocus(busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const floor = fixedKey(owner.currentBuild);
    if (draftVersion.current !== owner.buildVersion) {
      draftVersion.current = owner.buildVersion; draftFloor.current = floor;
      setDraft(draftFrom(owner.pendingBuild?.build ?? owner.currentBuild, owner.currentBuild)); attempt.current = null; setPointsNote(NO_NOTE);
    } else if (draftFloor.current !== floor) {
      // The boundary applied the pending build under the open form: the current build (so the class and the floor of every attribute) moved
      // while the build version did not. Compared by content, since every owner read brings a new object. The draft keeps its unsent edits
      // but is raised to the new floor, so it can never hold a class or a point the server would refuse (and Queue build is never stuck).
      draftFloor.current = floor;
      setDraft(previous => refloored(previous, owner.currentBuild)); attempt.current = null; setPointsNote(NO_NOTE);
    }
  }, [owner.buildVersion, owner.currentBuild, owner.pendingBuild]);
  // Set together with the draft that brings the control, so it commits with it: the focus is never asked for before the control is there.
  // Whichever of this and the rescue observer runs first, the focus ends here: the rescue leaves a focus that is not on <body>.
  useEffect(() => {
    if (!focusAfter) return;
    (focusAfter === 'undo' ? undoButton : suggestButton).current?.focus();
    setFocusAfter(null);
  }, [focusAfter]);
  const valid = validateBuild(draft, owner.inventory, owner.progression.earnedAttributePoints, owner.progression.level);
  // The review message names its fields: they are marked invalid and described by it (Task 23.5). More points than earned
  // marks every attribute; an attribute that is not a whole number in range (`invalid-input`) marks that one alone, or every
  // attribute when only their sum is over the cap.
  const notWhole = attributes.filter(key => !wholePoints(draft.allocation[key]));
  const pointsInvalid = (key: typeof attributes[number]) => !valid.ok
    && (valid.reason === 'points' || (valid.reason === 'invalid-input' && (notWhole.length ? notWhole.includes(key)
      : attributes.reduce((sum, k) => sum + draft.allocation[k], 0) > RULES_V1.attributes.maximumPoints)));
  const equipmentInvalid = !valid.ok && EQUIPMENT_REASONS.has(valid.reason);
  const reviewed = (invalid: boolean) => (invalid ? { 'aria-invalid': true, 'aria-describedby': reviewId } : {});
  const stats = valid.ok ? deriveStats(valid.snapshot, RULES_V1) : null;
  /** The points earned, how many are left of them, and the floor of each attribute: the current build's value (permanent). */
  const earned = owner.progression.earnedAttributePoints, left = pointsLeft(draft.allocation, earned);
  /** The pending build's effective time, or '' when it cannot be shown: its line is then left out. */
  const effective = owner.pendingBuild ? slotTimeText(owner.pendingBuild.effectiveSlotIndex * RULES_V1.clock.slotMs, nowMs, clockMode) : '';
  function update(next: BuildInput, note = '', undo: Attributes | null = null) { attempt.current = null; setDraft(next); setError(''); setMessage(''); setPointsNote({ text: note, undo }); }
  /**
   * A typed or stepped number for one attribute: raised to the current build's value when below it, capped at what is left when
   * above, with a status line saying which. Only typing can go below (the build step has no −); +5 may ask past the cap, but lands on
   * it with no line (the counter says it, points hotfix 2026-10-29). So a line comes after typing, when the field has had the
   * focus and `heldAtFocus` holds what it started from.
   */
  function changePoints(key: keyof Attributes, wanted: number, source: PointsSource = 'field') {
    const floor = owner.currentBuild.allocations[key], held = draft.allocation[key];
    const result = setPoints(draft.allocation, key, wanted, earned, floor);
    update({ ...draft, allocation: result.allocation }, result.raised ? raisedNote(title(key), floor)
      : result.capped && source === 'field' ? cappedNote(title(key), left, left + held, heldAtFocus.current[key] ?? held) : '');
  }
  /**
   * "Suggested for {class}": the points left go on the attributes the class's way (only adds, only the points left). Nothing is sent: it
   * is a draft edit like any other, and Undo puts the fields back. By keyboard the focus moves to Undo, since this button leaves with the last point.
   */
  function suggest(event: MouseEvent<HTMLButtonElement>) {
    const after = suggestedSplit(draft.allocation, left, draft.classId);
    if (event.currentTarget.matches(':focus-visible')) setFocusAfter('undo');
    update({ ...draft, allocation: after }, splitNote(draft.allocation, after, draft.classId), draft.allocation);
  }
  function undoSuggestion(event: MouseEvent<HTMLButtonElement>) {
    if (!pointsNote.undo) return;
    if (event.currentTarget.matches(':focus-visible')) setFocusAfter('suggest');
    update({ ...draft, allocation: pointsNote.undo });
  }
  async function send(kind: BuildCommand['kind']) {
    if (sending.current || (kind === 'queue-build' && !valid.ok)) return;
    begin();
    sending.current = true; setBusy(true); setError(''); setMessage('');
    const command: BuildCommand = attempt.current?.kind === kind ? attempt.current : kind === 'queue-build'
      ? { kind, operationId: crypto.randomUUID(), expectedVersion: owner.buildVersion, ...structuredClone(draft) }
      : { kind, operationId: crypto.randomUUID(), expectedVersion: owner.buildVersion };
    attempt.current = command;
    try {
      const result = await gateway.command(command);
      if (!mounted.current) return;
      if (result.ok) {
        await refresh();
        if (mounted.current) { attempt.current = null; setMessage(kind === 'queue-build' ? 'Build queued. Your current build continues until the boundary.' : 'Pending build canceled. Reservations released.'); }
      } else {
        setError(buildRefusal(result.code));
        if (!['processing', 'unavailable', 'rate-limited'].includes(result.code)) attempt.current = null;
        if (result.code === 'conflict' || result.code === 'invalid') await refresh();
      }
    } catch { if (mounted.current) setError('This change could not be confirmed. Retry to confirm the same request.'); }
    finally { sending.current = false; end(); if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!pressHold.take()) void send('queue-build'); }
  return <div className="planning-form">
    <div className="build-comparison">
      <section data-testid="current-build"><h2>Current build</h2><BuildSummary build={owner.currentBuild} inventory={owner.inventory} /></section>
      {owner.pendingBuild && <section data-testid="pending-build"><h2>Pending build</h2><BuildSummary build={owner.pendingBuild.build} inventory={owner.inventory} />
        {effective && <p>Effective {effective}</p>}
        <p>Reserved: {owner.pendingBuild.reservedMoney} gold · {owner.pendingBuild.reservedItemIds.length} equipment items</p>
        <button aria-disabled={busy || undefined} onClick={() => void send('cancel-build')}>Cancel pending build</button>
      </section>}
    </div>
    <form onSubmit={submit}>
      <h3>{owner.pendingBuild ? 'Revise pending build' : 'Plan a build'}</h3>
      <fieldset disabled={busy}><legend>Class and stance</legend>
        <div className="build-class"><p>Class: {title(draft.classId)}</p><ClassChips classId={draft.classId} /></div>
        <label htmlFor="build-stance">Stance</label><select id="build-stance" value={draft.stance} onChange={e => update({ ...draft, stance: e.target.value as Stance })}>{Object.keys(RULES_V1.stances).map(value => <option key={value}>{value}</option>)}</select>
      </fieldset>
      <fieldset disabled={busy}><legend>Attribute points · {owner.progression.earnedAttributePoints} earned</legend>
        <div className="build-counter-row">
          <p className="build-counter" role="status" data-done={left === 0}>{left === 0 ? `All ${earned} spent` : `${left} of ${earned} left`}</p>
          {left > 0 && <button type="button" ref={suggestButton} className="build-suggest" onClick={suggest}>Suggested for {title(draft.classId)}</button>}
        </div>
        <div className="build-points">{attributes.map(key => { const floor = owner.currentBuild.allocations[key], value = draft.allocation[key];
          return <PointsStepper key={key} label={key} name={title(key)} value={value} floor={floor} cap={Math.max(floor, value + left)} minus={false} hold={pressHold} fieldProps={reviewed(pointsInvalid(key))}
            onFocus={() => { heldAtFocus.current[key] = value; }} onChange={(wanted, source) => changePoints(key, wanted, source)} />; })}</div>
        <div className="build-points-status">
          <p className="build-points-note" role="status">{pointsNote.text}</p>
          {pointsNote.undo && <button type="button" ref={undoButton} className="build-undo" onClick={undoSuggestion}>Undo</button>}
        </div>
        <p>{POINTS_NOTE}</p>
        {/* Respec, a paid option to come (Avi, change round 1): shown gray and aria-disabled with the line that says so; it does nothing. */}
        <div className="build-respec"><button type="button" aria-disabled="true" aria-describedby={respecId}>Respec</button><span id={respecId}>Coming later as a paid option</span></div>
      </fieldset>
      <BuildEquipment draft={draft} owner={owner} busy={busy} reviewId={equipmentInvalid ? reviewId : undefined} onChange={update} />
      {stats && <div className="creation-preview"><p>Maximum stamina: {stats.maxStamina} · Stamina after change: {preserveStamina(owner.stamina.current, stats.maxStamina)}</p>
        <p>Load: {stats.load} / {stats.loadCapacity} · Combat efficiency: {Math.round(stats.efficiency * 100)}%</p><p>Raising Endurance increases capacity without restoring current stamina.</p></div>}
      {!valid.ok && <p id={reviewId} role="status">Review your build: {valid.reason}.</p>}
      <button className="primary-button" disabled={!valid.ok} aria-disabled={busy || undefined} type="submit" aria-describedby={!valid.ok ? reviewId : undefined}>Queue build</button>
    </form>
    <p className="muted">Available gold: {owner.wallets.money - owner.reservedFees.money}. Reserved fees remain in your wallet until activation.</p>
    {message && <p ref={outcome} role="status" tabIndex={-1} {...target}>{message}</p>}
    {error && <p ref={outcome} role="alert" className="form-error" tabIndex={-1} {...target}>{error}</p>}
  </div>;
}
