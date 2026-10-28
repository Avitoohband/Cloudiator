'use client';

// The "Change your look" dialog (Task 7, spec "Game messages and a free look change", Goal 4): the look patch note's Change look button
// opens it as a modal dialog over the running camp. It is the creation dialog's look picker (without its Random look and its "set at
// creation" note) on the gladiator's current look: a legacy gladiator opens on male, short hair and the colours it shows today, so
// opening it and saving nothing keeps its look. Changing a look is free and unlimited for now (Avi's disclaimer is said under the title),
// for the player's own gladiator only; the Edge function and the database validate it as at creation.
// - Save look is off until a choice differs from the look the gladiator has. It sends one `change-appearance` command; the same command
//   (and operation id) is sent again after an answer that left the outcome open, and any other look gets a new operation id.
// - After the reply the owner and the camp's world are read again (`refresh`), then the dialog closes (`onClose(true)`), and the shell
//   says "Look saved." A refusal keeps the dialog open with its reason beside Save look. An answer that was lost after the look was
//   stored is settled by the next owner read, which carries that look: the dialog then closes as saved, never leaving "could not be
//   saved" over a look the owner has (the same hazard as a background update arriving before a conflict response, AGENTS.md).
// - Cancel and Escape close it without a command (`onClose(false)`); while a look is being sent they do nothing. The native dialog gives
//   the focus back to what had it (the Messages button); the shell also puts it there.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ChangeAppearanceValue } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import type { Appearance } from '@domain/appearance';
import type { GameGateway } from '../../lib/api/gateway';
import { LookDisclaimer } from '../messages/LookDisclaimer';
import { LookPicker } from './LookPicker';
import { LOOK_PREVIEW, LOOK_REFUSED, attemptFor, currentLook, keepsAttempt, sameLook, type LookAttempt } from './look-change';
import styles from './ChangeLookDialog.module.css';

export function ChangeLookDialog({ owner, gateway, refresh, onClose, preview = false }: {
  owner: OwnerState;
  gateway: GameGateway;
  /** Reads the owner (and the camp's world) again after a look is saved; a failure does not undo the save. */
  refresh(): Promise<void>;
  /** The dialog has closed: `true` after a saved look, `false` for Cancel, Escape or the browser closing it. */
  onClose(saved: boolean): void;
  /** The fixture preview takes no commands: a refusal says so, instead of inviting another try. */
  preview?: boolean;
}) {
  const saved = currentLook(owner);
  const [draft, setDraft] = useState<Appearance>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<LookAttempt | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  const finished = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId(), freeId = useId();
  // Save follows the look the gladiator has now (a read from another device may change it while this is open), not the one it opened on.
  const dirty = !sameLook(draft, saved);

  // Modal over the camp: the camp keeps running behind it, but takes no input until the dialog closes. The title takes the focus, so a
  // long dialog (a phone) opens at its top.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Closes the dialog here, in the same event, so the focus is given back at once, and tells the shell (once).
  const finish = (wasSaved: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const element = dialog.current;
    if (element?.open) element.close();
    onClose(wasSaved);
  };

  // An answer that never came back (the command may have been applied) is settled by what the owner shows next: a read that carries the
  // look the last attempt sent, while that look is still the one on screen, says it was saved. This also covers a read that arrives
  // before the failed answer (the poll after the commit): the attempt is judged once the send has ended. A player who has chosen another
  // look meanwhile keeps the dialog.
  useEffect(() => {
    const sent = attempt.current;
    if (!sent || busy || !sameLook(sent.look, saved) || !sameLook(sent.look, draft)) return;
    attempt.current = null;
    finish(true);
  }, [busy, draft, saved.body, saved.hair, saved.skin, saved.hairColor, saved.cloth]);

  function edit(next: Appearance) {
    // The look being sent is the one on screen: a choice made while it is sent is not taken.
    if (sending.current) return;
    setDraft(next);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !dirty) return;
    const next = attemptFor(attempt.current, draft, () => crypto.randomUUID());
    attempt.current = next;
    sending.current = true; setBusy(true); setError(null);
    try {
      const result = await gateway.command<ChangeAppearanceValue>(next.command);
      if (!mounted.current) return;
      if (result.ok) {
        attempt.current = null;
        // The look is stored: a read that fails does not say otherwise (the next revision poll reads the owner and the camp again).
        try { await refresh(); } catch { /* kept: saved */ }
        if (mounted.current) finish(true);
        return;
      }
      if (!keepsAttempt(result.code)) attempt.current = null;
      setError(preview && result.code === 'unavailable' ? LOOK_PREVIEW : LOOK_REFUSED);
    } catch {
      if (mounted.current) setError(LOOK_REFUSED);
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={freeId}
    onClose={() => finish(false)} onCancel={event => { event.preventDefault(); if (!sending.current) finish(false); }}>
    <form className={`creation-form ${styles.form}`} onSubmit={submit} noValidate aria-busy={busy}>
      <h2 id={titleId} ref={heading} className={styles.title} tabIndex={-1}>Change your look</h2>
      <LookDisclaimer id={freeId} className={styles.free} />
      <LookPicker creation={false} look={draft} name={owner.name} onChange={edit} />
      <div className={styles.actions}>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.buttons}>
          <button type="button" className={styles.cancel} disabled={busy} onClick={() => finish(false)}>Cancel</button>
          {/* Save stays focusable while the look is sent (aria-disabled; a press then does nothing): a natively disabled button would drop the focus. */}
          <button type="submit" className={styles.save} disabled={!busy && !dirty} aria-disabled={busy || undefined}>{busy ? 'Saving…' : 'Save look'}</button>
        </div>
      </div>
    </form>
  </dialog>;
}
