'use client';

// The "Create your gladiator" dialog (Task 13.6, spec "Joining"): signed in without a gladiator, the existing creation form
// opens as a modal dialog over the running camp. "Not now" or Escape closes it (`onDismiss`); the chip and My gladiator
// offer it again. The draft stays on this device (`cloudiator.creation-draft.v1`) across closing, reloads, sign-out and a
// new sign-in, and a sent attempt keeps its operation ID for its own account only. The ten starting points (launch feedback,
// 2026-10-25) start at 0 and are spent with a counter, steppers, a cap and two shortcuts (`creation-points.ts`). The look
// (gladiator appearance, 2026-10-26) is chosen after the name: the dialog opens with a random valid one, which the draft keeps
// at once, so reopening shows it again (version 2; a version-1 draft opens with a random look and keeps its name, class and
// points) and Create sends it.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Attributes, ClassId, GameCommand } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { randomAppearance, validAppearance, type Appearance } from '@domain/appearance';
import { RULES_V1 } from '@domain/rules-v1';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { validateBuild, validateCreationAllocation } from '@domain/build';
import { deriveStats } from '@domain/stats';
import { GatewayReadError, type GameGateway } from '../../lib/api/gateway';
import { useSession } from '../../lib/api/session';
import {
  ATTRIBUTE_HINTS, ATTRIBUTE_KEYS, CLASS_SUGGESTIONS, EMPTY_ALLOCATION, cappedNote, pointsLeft, pointsSpent, setPoints,
} from './creation-points';
import { LookPicker } from './LookPicker';
import { lookFromDraft, lookRandom } from './look-picker';
import styles from './CreateCharacter.module.css';

const classes = ['berserker', 'guardian', 'duelist'] as const;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);
const storageKey = 'cloudiator.creation-draft.v1';
type Creation = Extract<GameCommand, { kind: 'create-character' }>;
type Draft = { version: 2; name: string; classId: ClassId; allocation: Attributes; appearance: Appearance;
  attempt?: { account: string; command: Creation } };
/** Shown for the one frame before the saved draft is read (the controls are off until then); never saved or sent. */
const initialDraft: Draft = { version: 2, name: '', classId: 'berserker', allocation: { ...EMPTY_ALLOCATION }, appearance: { body: 'male', hair: 'short', skin: 0, hairColor: 0, cloth: 0 } };
/** A new draft: nothing typed yet, and a random valid look, so new gladiators are not all alike. */
const freshDraft = (): Draft => ({ ...structuredClone(initialDraft), appearance: randomAppearance(lookRandom) });
const sameLook = (a: Appearance, b: Appearance) => a.body === b.body && a.hair === b.hair && a.skin === b.skin && a.hairColor === b.hairColor && a.cloth === b.cloth;
/** The refusals that are about the name: the name field is marked invalid and described by them (Task 23.5). */
const NAME_RULE = 'Use 3–20 English letters, digits, spaces, underscores or hyphens.';
const NAME_TAKEN = 'This name may already be taken, or this account already has a gladiator. Choose another name and try again.';
const NAME_OR_POINTS = 'Check your name and allocate exactly 10 whole points.';
const NAME_ERRORS: readonly string[] = [NAME_RULE, NAME_TAKEN, NAME_OR_POINTS];
/** The refusals that are about the points. Create is off until all are spent, so only a refusal by the server reaches this. */
const POINTS_RULE = `Allocate exactly ${RULES_V1.attributes.creationPoints} whole points.`;
const POINTS_ERRORS: readonly string[] = [POINTS_RULE, NAME_OR_POINTS];
/**
 * The saved draft, and whether its look was drawn at random just now (there was no saved valid look). Such a draft is saved at
 * once: the dialog is mounted afresh each time it opens, so closing it unedited and opening it again shows the same look.
 */
function readDraft(): { draft: Draft; randomLook: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as (Omit<Draft, 'version'> & { version: 1 | 2 }) | null;
    if (!value || (value.version !== 1 && value.version !== 2) || typeof value.name !== 'string' || value.name.length > 100 || !classes.includes(value.classId)
      || !value.allocation || Object.keys(value.allocation).length !== ATTRIBUTE_KEYS.length
      || !ATTRIBUTE_KEYS.every(key => Number.isFinite(value.allocation[key]) && value.allocation[key] >= 0 && value.allocation[key] <= 10)) return { draft: freshDraft(), randomLook: true };
    // A saved draft keeps its values. Only one the counter could not show (a fraction, or more points than there are, which
    // the old form allowed) starts again from 0 points, keeping its name and class.
    const kept = ATTRIBUTE_KEYS.every(key => Number.isInteger(value.allocation[key]))
      && pointsSpent(value.allocation) <= RULES_V1.attributes.creationPoints;
    // The look: a version-2 draft keeps its valid look; a version-1 draft (saved before the look could be chosen) or a damaged one
    // opens with a random look.
    const savedLook = value.version === 2 && validAppearance(value.appearance);
    const clean: Draft = { version: 2, name: value.name, classId: value.classId, allocation: kept ? { ...value.allocation } : { ...EMPTY_ALLOCATION },
      appearance: lookFromDraft(savedLook ? value.appearance : null, lookRandom) };
    // A sent attempt (its immutable command) is kept only with the look it was sent with: the old build's attempts carry none, so
    // they start over with a new operation ID (an account that already has its gladiator is handled by the conflict path).
    const attempt = value.attempt;
    if (value.version === 2 && attempt && typeof attempt.account === 'string' && attempt.command?.kind === 'create-character'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt.command.operationId)
      && attempt.command.name === clean.name.trim() && attempt.command.classId === clean.classId
      && ATTRIBUTE_KEYS.every(key => attempt.command.allocation?.[key] === clean.allocation[key])
      && validAppearance(attempt.command.appearance) && sameLook(attempt.command.appearance, clean.appearance)) clean.attempt = {
        account: attempt.account, command: { kind: 'create-character', operationId: attempt.command.operationId,
          name: clean.name.trim(), classId: clean.classId, allocation: { ...clean.allocation }, appearance: { ...clean.appearance } },
      };
    return { draft: clean, randomLook: !savedLook };
  } catch { return { draft: freshDraft(), randomLook: true }; }
}
function persist(draft: Draft) {
  try { localStorage.setItem(storageKey, JSON.stringify(draft)); return true; } catch { return false; }
}

/** Catalog items here are a visual estimate only; the server supplies all real starter authority. */
function creationPreview(classId: ClassId, allocation: Attributes) {
  if (!validateCreationAllocation(allocation)) return null;
  const items: ItemInstance[] = ['sword:1:common', 'light-armor:1:common'].map((id, index) => {
    const entry = CATALOG_V1.items[id];
    return { id: `preview-${index}`, ownerId: 'preview', catalogId: id, catalogVersion: CATALOG_V1.version,
      tier: entry.tier, rarity: entry.rarity, stats: entry.stats, quantity: 1, origin: 'starter', binding: entry.binding, reservation: null };
  });
  const build = validateBuild({ classId, stance: 'balanced', allocation,
    equipment: { weapon: items[0].id, offHand: null, head: null, body: items[1].id, feet: null } }, items, RULES_V1.attributes.creationPoints, 1);
  return build.ok ? deriveStats(build.snapshot, RULES_V1) : null;
}

export function CreateCharacter({ gateway, onCreated, onDismiss, onFocusLost }: {
  gateway: GameGateway;
  onCreated?: (owner: OwnerState) => void;
  /** "Not now", or Escape: the dialog is closed. */
  onDismiss(): void;
  /**
   * The dialog closed with nothing to give the focus back to (it opened on its own after sign-in, when nothing had the
   * focus): the caller puts it somewhere on the page, never on <body> (Task 23.5 fix round 1).
   */
  onFocusLost?(): void;
}) {
  const accountId = useSession().userId;
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The short status line after a typed number was capped; any other edit clears it. */
  const [capped, setCapped] = useState('');
  /** What each points field held when it took the focus: the capped line says it differently when that was 0 (ruling R10). */
  const heldAtFocus = useRef<Partial<Record<keyof Attributes, number>>>({});
  const [busy, setBusy] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const sending = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId(), errorId = useId(), pointsId = useId(), rowsId = useId(), readyId = useId();
  // Modal over the camp: the camp keeps running behind it, but takes no input until the dialog closes. The title takes
  // the focus, so a long form opens at its top.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    heading.current?.focus({ preventScroll: true });
  }, []);
  // A submit that fails moves the focus to its reason: while a creation is confirmed its button and fields are disabled,
  // which would drop the focus to <body> (13.6 review I1). Editing a field clears the reason.
  const reason = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error && !busy) reason.current?.focus(); }, [error, busy]);
  useEffect(() => {
    mounted.current = true;
    const saved = readDraft();
    setDraft(saved.draft); setReady(true);
    // A look drawn at random now is kept at once (final review item 4), so reopening the dialog does not draw another.
    if (saved.randomLook) setStorageAvailable(persist(saved.draft));
    return () => { mounted.current = false; };
  }, []);
  const preview = creationPreview(draft.classId, draft.allocation);
  const { creationPoints, base } = RULES_V1.attributes;
  const left = pointsLeft(draft.allocation, creationPoints), spent = pointsSpent(draft.allocation);
  const allSpent = validateCreationAllocation(draft.allocation);
  // The name's and the points' refusals describe their fields, which are marked invalid only after a create attempt (Task 23.5,
  // launch feedback): Create is off until all the points are spent, so a points refusal is one the server still sent.
  const nameInvalid = error !== null && NAME_ERRORS.includes(error);
  const pointsInvalid = error !== null && POINTS_ERRORS.includes(error);
  function update(next: Draft, note = '') {
    const clean = { ...next, attempt: undefined };
    setDraft(clean); setError(null); setCapped(note); setStorageAvailable(persist(clean));
  }
  /**
   * A typed or stepped number for one attribute: capped at what is left, with a status line when it was. Only typing can pass
   * the cap (a stepper stops at it), so the field has the focus then and `heldAtFocus` holds what it started from.
   */
  function changePoints(key: keyof Attributes, wanted: number) {
    const result = setPoints(draft.allocation, key, wanted, creationPoints), held = draft.allocation[key];
    update({ ...draft, allocation: result.allocation },
      result.capped ? cappedNote(title(key), left, left + held, heldAtFocus.current[key] ?? held) : '');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !accountId || !ready) return;
    const name = draft.name.trim();
    if (!/^[A-Za-z0-9 _-]{3,20}$/.test(name)) { setError(NAME_RULE); return; }
    if (!preview) { setError(POINTS_RULE); return; }
    const command: Creation = draft.attempt?.account === accountId ? draft.attempt.command : {
      kind: 'create-character', operationId: crypto.randomUUID(), name, classId: draft.classId, allocation: { ...draft.allocation },
      appearance: { ...draft.appearance },
    };
    const attempted: Draft = { ...draft, attempt: { account: accountId, command } };
    // Save the immutable payload before sending, including the UUID needed after an unknown outcome.
    setDraft(attempted); setStorageAvailable(persist(attempted));
    sending.current = true; setBusy(true); setError(null);
    try {
      const result = await gateway.command<{ gladiatorId: string }>(command);
      if (result.ok || result.code === 'conflict') {
        try {
          const owner = await gateway.owner();
          if (mounted.current) {
            try { localStorage.removeItem(storageKey); } catch { /* Successful online authority remains available. */ }
            onCreated?.(owner);
          }
          return;
        } catch (failure) {
          if (!(failure instanceof GatewayReadError && failure.code === 'not-found')) {
            if (mounted.current) setError('Your character could not be loaded. Retry to confirm the online result.');
            return;
          }
        }
      }
      if (!mounted.current) return;
      if (!result.ok && result.code === 'conflict') setError(NAME_TAKEN);
      else if (!result.ok && result.code === 'invalid') setError(NAME_OR_POINTS);
      else if (!result.ok && result.code === 'unauthenticated') setError('Your session has expired. Sign in with Google again; your draft is safe.');
      else if (!result.ok && result.code === 'rate-limited') setError(`Too many attempts. Wait ${Math.ceil(Math.max(1000, Number.isFinite(result.retryAfterMs) ? result.retryAfterMs! : 60_000) / 1000)} seconds before retrying.`);
      else setError('Creation could not be confirmed. Retry with this draft to safely check the same request.');
    } catch { if (mounted.current) setError('Creation could not be confirmed. Retry with this draft to safely check the same request.'); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  // "Not now" and Escape close the dialog here, in the same event, so the focus can be put back at once: the browser gives
  // it back to what had it before the dialog opened, and when nothing had (the dialog opened on its own), `onFocusLost`.
  const close = () => {
    const element = dialog.current;
    element?.close();
    // Right after close() the browser may still report the focus inside the closed dialog (it is fixed up to <body> later).
    const active = document.activeElement;
    if (!active || active === document.body || element?.contains(active)) onFocusLost?.();
  };
  // While a creation is being confirmed the dialog stays open, so its outcome is shown.
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onDismiss}
    onCancel={event => { event.preventDefault(); if (!sending.current) close(); }}>
    <form className={`creation-form ${styles.form}`} onSubmit={submit} noValidate aria-busy={busy}>
      <h2 id={titleId} ref={heading} className={styles.title} tabIndex={-1}>Create your gladiator</h2>
      <p className="muted">You’re signed in. Name your gladiator and pick a class; the camp keeps running behind this dialog. Your draft stays on this device.</p>
      <fieldset disabled={busy || !ready}>
        <label htmlFor="gladiator-name">Gladiator name</label>
        <input id="gladiator-name" autoComplete="off" maxLength={100} value={draft.name} onChange={event => update({ ...draft, name: event.target.value })}
          aria-invalid={nameInvalid ? true : undefined} aria-describedby={nameInvalid ? `name-help ${errorId}` : 'name-help'} />
        <p id="name-help" className="muted">3–20 letters, digits, spaces, underscores or hyphens. Names are unique regardless of case.</p>
        <LookPicker look={draft.appearance} name={draft.name} onChange={appearance => update({ ...draft, appearance })} />
        <fieldset className="class-options"><legend>Choose a class</legend>
          {classes.map(classId => <label key={classId}><input type="radio" name="class" value={classId} checked={draft.classId === classId} onChange={() => update({ ...draft, classId })} />{title(classId)}</label>)}
        </fieldset>
        <p className="muted">{ATTRIBUTE_KEYS.filter(key => RULES_V1.classes[draft.classId][key] !== 1).map(key => `${title(key)} +${Math.round((RULES_V1.classes[draft.classId][key] - 1) * 100)}%`).join(' · ')}</p>
        <fieldset className={`point-options ${styles.points}`} aria-describedby={pointsId}>
          <legend>Spend {creationPoints} starting points</legend>
          <p className="muted">Every attribute starts at {base}. Points add on top.</p>
          <p id={pointsId} role="status" className={styles.counter} data-done={allSpent}>{allSpent ? `All ${creationPoints} spent` : `${left} of ${creationPoints} left`}</p>
          <div className={styles.pips} aria-hidden="true">
            {Array.from({ length: creationPoints }, (_, index) => <span key={index} className={styles.pip} data-on={index < spent} />)}
          </div>
          <div className={styles.shortcuts}>
            <button type="button" className={styles.suggest} onClick={() => update({ ...draft, allocation: { ...CLASS_SUGGESTIONS[draft.classId] } })}>Suggested for {title(draft.classId)}</button>
            <button type="button" className={styles.reset} onClick={() => update({ ...draft, allocation: { ...EMPTY_ALLOCATION } })}>Reset points</button>
          </div>
          {ATTRIBUTE_KEYS.map(key => {
            const value = draft.allocation[key], name = title(key);
            // The steppers stay in the tab order at their limit (aria-disabled, not disabled), so a keyboard user who spends the
            // last point keeps the focus instead of losing it to <body>.
            const atZero = value <= 0, atCap = left === 0;
            return <div key={key} className={styles.row}>
              <label htmlFor={`points-${key}`}>{name}<span className={styles.sr}> points</span></label>
              <span id={`${rowsId}-${key}`} className={styles.hint}>{ATTRIBUTE_HINTS[key]}</span>
              <div className={styles.controls}>
                <span className={styles.base} aria-hidden="true">{base} +</span>
                <button type="button" className={styles.step} aria-label={`Remove a point from ${name}`} aria-disabled={atZero || undefined}
                  onClick={() => { if (!atZero) changePoints(key, value - 1); }}>−</button>
                <input id={`points-${key}`} className={styles.value} type="number" min="0" max={value + left} step="1" inputMode="numeric" value={value}
                  onFocus={() => { heldAtFocus.current[key] = value; }} onChange={event => changePoints(key, Number(event.target.value))}
                  aria-invalid={pointsInvalid ? true : undefined}
                  aria-describedby={`${rowsId}-${key} ${rowsId}-${key}-total${pointsInvalid ? ` ${errorId}` : ''}`} />
                <button type="button" className={styles.step} aria-label={`Add a point to ${name}`} aria-disabled={atCap || undefined}
                  onClick={() => { if (!atCap) changePoints(key, value + 1); }}>+</button>
                <span id={`${rowsId}-${key}-total`} className={styles.total}><span className={styles.sr}>Total </span><span aria-hidden="true">= </span>{base + value}</span>
              </div>
            </div>;
          })}
          <p role="status" className={styles.capped}>{capped}</p>
        </fieldset>
      </fieldset>
      {preview && <section className="creation-preview" aria-label="Starting build preview"><h4>Starting build preview</h4>
        <dl><div><dt>Health</dt><dd data-testid="preview-hp">{preview.maxHp}</dd></div><div><dt>Stamina</dt><dd data-testid="preview-stamina">{preview.maxStamina}</dd></div><div><dt>Equipment load</dt><dd data-testid="preview-load">{preview.load} / {preview.loadCapacity}</dd></div></dl>
        <p className="muted">Common sword · Light body armor · 100 money · 0 renown</p>
      </section>}
      {error && <p ref={reason} id={errorId} role="alert" className="form-error" tabIndex={-1}>{error}</p>}
      {!storageAvailable && <p role="status">This browser cannot retain your draft after leaving the page.</p>}
      {!accountId && <p className="muted">Sign in with Google before confirming.</p>}
      <div className={styles.actions}>
        <p id={readyId} className={styles.createHint}>{allSpent ? 'Ready. You can change your build later.' : `Spend ${left} more point${left === 1 ? '' : 's'} to continue.`}</p>
        <div className={styles.buttons}>
          <button className={styles.later} type="button" disabled={busy} onClick={close}>Not now</button>
          <button className={styles.confirm} type="submit" disabled={!accountId || busy || !ready || !allSpent} aria-describedby={readyId}>{busy ? 'Confirming creation…' : 'Create gladiator'}</button>
        </div>
      </div>
    </form>
  </dialog>;
}
