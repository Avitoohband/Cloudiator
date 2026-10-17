'use client';

// The "Create your gladiator" dialog (Task 13.6, spec "Joining"): signed in without a gladiator, the existing creation form
// opens as a modal dialog over the running camp. "Not now" or Escape closes it (`onDismiss`); the chip and My gladiator
// offer it again. The draft stays on this device (`cloudiator.creation-draft.v1`) across closing, reloads, sign-out and a
// new sign-in, and a sent attempt keeps its operation ID for its own account only.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Attributes, ClassId, GameCommand } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { validateBuild, validateCreationAllocation } from '@domain/build';
import { deriveStats } from '@domain/stats';
import { GatewayReadError, type GameGateway } from '../../lib/api/gateway';
import { useSession } from '../../lib/api/session';
import styles from './CreateCharacter.module.css';

const keys = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;
const classes = ['berserker', 'guardian', 'duelist'] as const;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);
const storageKey = 'cloudiator.creation-draft.v1';
type Creation = Extract<GameCommand, { kind: 'create-character' }>;
type Draft = { version: 1; name: string; classId: ClassId; allocation: Attributes;
  attempt?: { account: string; command: Creation } };
const initialDraft: Draft = { version: 1, name: '', classId: 'berserker', allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } };
function readDraft(): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Draft | null;
    if (!value || value.version !== 1 || typeof value.name !== 'string' || value.name.length > 100 || !classes.includes(value.classId)
      || !value.allocation || Object.keys(value.allocation).length !== keys.length
      || !keys.every(key => Number.isFinite(value.allocation[key]) && value.allocation[key] >= 0 && value.allocation[key] <= 10)) return structuredClone(initialDraft);
    const clean: Draft = { version: 1, name: value.name, classId: value.classId, allocation: { ...value.allocation } };
    const attempt = value.attempt;
    if (attempt && typeof attempt.account === 'string' && attempt.command?.kind === 'create-character'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt.command.operationId)
      && attempt.command.name === clean.name.trim() && attempt.command.classId === clean.classId
      && keys.every(key => attempt.command.allocation?.[key] === clean.allocation[key])) clean.attempt = {
        account: attempt.account, command: { kind: 'create-character', operationId: attempt.command.operationId,
          name: clean.name.trim(), classId: clean.classId, allocation: { ...clean.allocation } },
      };
    return clean;
  } catch { return structuredClone(initialDraft); }
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

export function CreateCharacter({ gateway, onCreated, onDismiss }: {
  gateway: GameGateway;
  onCreated?: (owner: OwnerState) => void;
  /** "Not now", or Escape: the dialog is closed. */
  onDismiss(): void;
}) {
  const accountId = useSession().userId;
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const sending = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
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
    setDraft(readDraft()); setReady(true);
    return () => { mounted.current = false; };
  }, []);
  const preview = creationPreview(draft.classId, draft.allocation);
  const remaining = RULES_V1.attributes.creationPoints - keys.reduce((sum, key) => sum + draft.allocation[key], 0);
  function update(next: Draft) {
    const clean = { ...next, attempt: undefined };
    setDraft(clean); setError(null); setStorageAvailable(persist(clean));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !accountId || !ready) return;
    const name = draft.name.trim();
    if (!/^[A-Za-z0-9 _-]{3,20}$/.test(name)) { setError('Use 3–20 English letters, digits, spaces, underscores or hyphens.'); return; }
    if (!preview) { setError('Allocate exactly 10 whole points.'); return; }
    const command: Creation = draft.attempt?.account === accountId ? draft.attempt.command : {
      kind: 'create-character', operationId: crypto.randomUUID(), name, classId: draft.classId, allocation: { ...draft.allocation },
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
      if (!result.ok && result.code === 'conflict') setError('This name may already be taken, or this account already has a gladiator. Choose another name and try again.');
      else if (!result.ok && result.code === 'invalid') setError('Check your name and allocate exactly 10 whole points.');
      else if (!result.ok && result.code === 'unauthenticated') setError('Your session has expired. Sign in with Google again; your draft is safe.');
      else if (!result.ok && result.code === 'rate-limited') setError(`Too many attempts. Wait ${Math.ceil(Math.max(1000, Number.isFinite(result.retryAfterMs) ? result.retryAfterMs! : 60_000) / 1000)} seconds before retrying.`);
      else setError('Creation could not be confirmed. Retry with this draft to safely check the same request.');
    } catch { if (mounted.current) setError('Creation could not be confirmed. Retry with this draft to safely check the same request.'); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  // While a creation is being confirmed the dialog stays open, so its outcome is shown.
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onDismiss}
    onCancel={event => { if (sending.current) event.preventDefault(); }}>
    <form className={`creation-form ${styles.form}`} onSubmit={submit} noValidate aria-busy={busy}>
      <h2 id={titleId} ref={heading} className={styles.title} tabIndex={-1}>Create your gladiator</h2>
      <p className="muted">You’re signed in. Name your gladiator and pick a class; the camp keeps running behind this dialog. Your draft stays on this device.</p>
      <fieldset disabled={busy || !ready}>
        <label htmlFor="gladiator-name">Gladiator name</label>
        <input id="gladiator-name" autoComplete="off" maxLength={100} value={draft.name} onChange={event => update({ ...draft, name: event.target.value })} aria-describedby="name-help" />
        <p id="name-help" className="muted">3–20 letters, digits, spaces, underscores or hyphens. Names are unique regardless of case.</p>
        <fieldset className="class-options"><legend>Choose a class</legend>
          {classes.map(classId => <label key={classId}><input type="radio" name="class" value={classId} checked={draft.classId === classId} onChange={() => update({ ...draft, classId })} />{title(classId)}</label>)}
        </fieldset>
        <p className="muted">{keys.filter(key => RULES_V1.classes[draft.classId][key] !== 1).map(key => `${title(key)} +${Math.round((RULES_V1.classes[draft.classId][key] - 1) * 100)}%`).join(' · ')}</p>
        <fieldset className="point-options"><legend>Allocate 10 starting points</legend>
          <p className="muted">Five base points in each attribute.</p>
          {keys.map(key => <label key={key} htmlFor={`points-${key}`}><span>{title(key)} points</span><input id={`points-${key}`} type="number" min="0" max="10" step="1" inputMode="numeric" value={Number.isFinite(draft.allocation[key]) ? draft.allocation[key] : ''} onChange={event => update({ ...draft, allocation: { ...draft.allocation, [key]: event.target.value === '' ? NaN : Number(event.target.value) } })} /></label>)}
          <p role="status">{preview ? 'All 10 points allocated.' : 'Allocate exactly 10 whole points.'} {Number.isFinite(remaining) && remaining !== 0 ? `${remaining} points remaining.` : ''}</p>
        </fieldset>
      </fieldset>
      {preview && <section className="creation-preview" aria-label="Starting build preview"><h4>Starting build preview</h4>
        <dl><div><dt>Health</dt><dd data-testid="preview-hp">{preview.maxHp}</dd></div><div><dt>Stamina</dt><dd data-testid="preview-stamina">{preview.maxStamina}</dd></div><div><dt>Equipment load</dt><dd data-testid="preview-load">{preview.load} / {preview.loadCapacity}</dd></div></dl>
        <p className="muted">Common sword · Light body armor · 100 money · 0 renown</p>
      </section>}
      {error && <p ref={reason} role="alert" className="form-error" tabIndex={-1}>{error}</p>}
      {!storageAvailable && <p role="status">This browser cannot retain your draft after leaving the page.</p>}
      {!accountId && <p className="muted">Sign in with Google before confirming.</p>}
      <div className={styles.actions}>
        <button className={styles.later} type="button" disabled={busy} onClick={() => dialog.current?.close()}>Not now</button>
        <button className={styles.confirm} type="submit" disabled={!accountId || busy || !ready}>{busy ? 'Confirming creation…' : 'Create gladiator'}</button>
      </div>
    </form>
  </dialog>;
}
