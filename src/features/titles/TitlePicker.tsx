'use client';

// "Choose your title" and the Title button (patch 1.7, spec "My gladiator: the Title button" and "The picker"; the approved mockup, section
// 4). The button sits beside the name on My gladiator and opens the picker, a modal dialog over the running camp like Change look:
// - the top shows how others will see the choice (IN THE CAMP: the title over the name, the camp label's lettering; IN MENUS: the name and
//   the title under it, Champion naming its latest first place from the owner's prestige, ruling D2), and Earned or All;
// - the titles scroll by family, "No title" first; an earned title is a radio choice, a locked one (All) shows its rule and progress and
//   cannot be chosen;
// - Wear title (off while the choice is the worn title) sends one `wear-title`; the same command (and operation id) goes again after an
//   answer that left the outcome open, another title gets a new id. An accepted wear tells the shell the answer's title at once
//   (`onWorn`, Review Focus 5), reads the owner and the camp again (`refresh`) and closes with the status line. A refusal keeps the dialog
//   open with its reason. Cancel, × and Escape close it without a command; while a wear is sent they do nothing.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { WearTitleValue } from '@contracts/commands';
import type { OwnerState, PrestigeAward } from '@contracts/reads';
import { titleById } from '@domain/titles';
import type { GameGateway } from '../../lib/api/gateway';
import { NO_TITLE, titleName, wornTitleText } from './title-text';
import { LATER_TITLES, NO_TITLE_LINE, pickerCounts, pickerGroups, wornStatus, type PickerRow } from './title-picker';
import { WEAR_PREVIEW, WEAR_REFUSED, answeredTitle, keepsWearAttempt, wearAttemptFor, type WearAttempt } from './title-wear';
import styles from './TitlePicker.module.css';

/** The Title button beside the name: TITLE, the worn title's name (or No title) and ›. An id this client does not know is no title. */
export function TitleButton({ wornTitle, onOpen }: { wornTitle: string | null; onOpen(): void }) {
  const name = titleName(wornTitle);
  return <button type="button" className={styles.titleButton} data-title-button="" aria-haspopup="dialog"
    aria-label={`Title: ${name ?? NO_TITLE}. Choose your title`} onClick={onOpen}>
    <span className={styles.titleEyebrow}>TITLE</span>
    <span className={styles.chevron} aria-hidden="true">›</span>
    <span className={name ? styles.titleValue : styles.titleNone}>{name ?? NO_TITLE}</span>
  </button>;
}

/** One choice: a radio named by the title, described by "✓ Earned" (an earned title) and its line. The whole row picks it. */
function Choice({ group, id, label, line, earned, checked, onChoose }: {
  group: string; id: string | null; label: string; line: string; earned: boolean; checked: boolean; onChoose(id: string | null): void;
}) {
  const nameId = useId(), stateId = useId(), lineId = useId();
  return <label className={styles.option}>
    <input type="radio" name={group} value={id ?? ''} checked={checked} onChange={() => onChoose(id)} aria-labelledby={nameId}
      aria-describedby={earned ? `${stateId} ${lineId}` : lineId} />
    <span id={nameId} className={earned ? styles.name : styles.plain}>{label}</span>
    {earned && <span id={stateId} className={styles.earned}>✓ Earned</span>}
    <span id={lineId} className={styles.rule}>{line}</span>
  </label>;
}

/** A locked title (All): its name, rule and progress, with a bar filled to it. Not a choice. */
function Locked({ row }: { row: PickerRow }) {
  return <div className={`${styles.option} ${styles.locked}`} data-testid="locked-title">
    <span className={styles.lock} aria-hidden="true">🔒</span>
    <span className={styles.name}>{row.name}</span>
    <span className={styles.rule}>{row.rule}</span>
    <span className={styles.progress}>
      <span className={styles.bar} aria-hidden="true"><i style={{ width: `${row.share * 100}%` }} /></span>
      <span>{row.progress}</span>
    </span>
  </div>;
}

export function TitlePicker({ owner, gateway, refresh, onWorn, onClose, preview = false }: {
  /** The owner, its `wornTitle` the title shown as worn now (the shell's, which a wear answer sets at once). */
  owner: OwnerState;
  /** Commands, and the owner's public profile for Champion's latest first place (read only when it holds Champion). */
  gateway: Pick<GameGateway, 'command' | 'profile'>;
  /** Reads the owner (and the camp's world) again after a wear; it settles on its own. */
  refresh(): void;
  /**
   * A wear was accepted: the gladiator the picker belongs to and the title the answer says it wears now (null: none), told the moment it
   * arrives, also after the dialog has closed.
   */
  onWorn(gladiatorId: string, titleId: string | null): void;
  /** The dialog has closed: the status line after a wear ("You now wear Wanderer."), or null for Cancel, ×, Escape or the browser closing it. */
  onClose(status: string | null): void;
  /** The fixture preview takes no commands: a refusal says so, instead of inviting another try. */
  preview?: boolean;
}) {
  const worn = titleById(owner.wornTitle) ? owner.wornTitle : null;
  // The picker is keyed by its gladiator: a wear's answer is told for this one.
  const gladiatorId = owner.gladiatorId;
  const [choice, setChoice] = useState<string | null>(worn);
  const [view, setView] = useState<'earned' | 'all'>('earned');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prestige, setPrestige] = useState<readonly PrestigeAward[]>([]);
  const attempt = useRef<WearAttempt | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  const finished = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId(), group = useId();
  const groups = useMemo(() => pickerGroups(owner, view), [owner, view]);
  const counts = pickerCounts(owner);
  // Wear title follows the title worn now (a read from another device may change it while this is open), not the one it opened on.
  const same = choice === worn;
  const champion = owner.titles.some(title => title.id === 'champion');

  // Modal over the camp: the camp keeps running behind it, but takes no input until the dialog closes. The title takes the focus, so the
  // dialog opens at its top.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Champion names its latest first place in the menus' preview (ruling D2): the owner's prestige, read once (only the latest read lands;
  // a failed read keeps the plain name).
  useEffect(() => {
    if (!champion) return;
    let active = true;
    gateway.profile(owner.gladiatorId).then(profile => { if (active) setPrestige(profile.prestige); }, () => undefined);
    return () => { active = false; };
  }, [champion, gateway, owner.gladiatorId]);

  // Closes the dialog here, in the same event, so the focus is given back at once, and tells the shell (once).
  const finish = (status: string | null) => {
    if (finished.current) return;
    finished.current = true;
    const element = dialog.current;
    if (element?.open) element.close();
    onClose(status);
  };

  function choose(id: string | null) {
    // The title being sent is the one on screen: a choice made while it is sent is not taken.
    if (sending.current) return;
    setChoice(id);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || same) return;
    const next = wearAttemptFor(attempt.current, choice, () => crypto.randomUUID());
    attempt.current = next;
    sending.current = true; setBusy(true); setError(null);
    try {
      const result = await gateway.command<WearTitleValue>(next.command);
      if (result.ok) {
        attempt.current = null;
        const titleId = answeredTitle(result.value, next.titleId);
        // The shell hears an accepted wear even when the dialog has gone during the send (Chrome closes a modal dialog on a repeated
        // Escape, with a cancel event it cannot cancel): both are the shell's, safe after this dialog has unmounted.
        onWorn(gladiatorId, titleId);
        refresh();
        if (mounted.current) finish(wornStatus(titleId));
        return;
      }
      if (!mounted.current) return;
      if (!keepsWearAttempt(result.code)) attempt.current = null;
      setError(preview && result.code === 'unavailable' ? WEAR_PREVIEW : WEAR_REFUSED);
    } catch {
      if (mounted.current) setError(WEAR_REFUSED);
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const campTitle = titleName(choice);
  const menuTitle = wornTitleText(choice, prestige);
  // A refusal is about the choice that was sent: once the choice is the worn title (chosen back, or worn after an answer that was lost), it is moot.
  const shownError = same ? null : error;
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={headingId}
    onClose={() => finish(null)} onCancel={event => { event.preventDefault(); if (!sending.current) finish(null); }}>
    <form className={styles.form} onSubmit={submit} noValidate aria-busy={busy}>
      <div className={styles.top}>
        <h2 id={headingId} ref={heading} className={styles.heading} tabIndex={-1}>Choose your title</h2>
        <button type="button" className={styles.close} aria-label="Close" disabled={busy} onClick={() => finish(null)}>×</button>
        <div className={styles.preview} data-testid="title-preview">
          {/* The camp's label, drawn as the camp draws it (decoration: IN MENUS says the same in words). */}
          <div className={styles.previewBox} aria-hidden="true">
            <p className={styles.eyebrow}>IN THE CAMP</p>
            <div className={styles.camp}>
              {campTitle && <span className={styles.campTitle} data-testid="camp-title">{campTitle}</span>}
              <span className={styles.campName}>{owner.name}</span>
            </div>
          </div>
          <div className={styles.previewBox}>
            <p className={styles.eyebrow}>IN MENUS</p>
            <p className={styles.menuName}>{owner.name}</p>
            <p className={menuTitle ? styles.menuTitle : styles.menuNone} data-testid="menu-title">{menuTitle ?? NO_TITLE}</p>
          </div>
        </div>
        <div className={styles.views} role="group" aria-label="Which titles">
          <button type="button" aria-pressed={view === 'earned'} onClick={() => setView('earned')}>Earned · {counts.earned}</button>
          <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>All · {counts.all}</button>
        </div>
      </div>
      <div className={styles.body} data-testid="title-picker-body">
        <fieldset className={styles.family}>
          <legend className={styles.familyName}>Wear nothing</legend>
          <Choice group={group} id={null} label={NO_TITLE} line={NO_TITLE_LINE} earned={false} checked={choice === null} onChoose={choose} />
        </fieldset>
        {groups.map(family => <fieldset key={family.family} className={styles.family}>
          <legend className={styles.familyName}>{family.family}</legend>
          {family.rows.map(row => (row.earned
            ? <Choice key={row.id} group={group} id={row.id} label={row.name} line={row.rule} earned checked={choice === row.id} onChoose={choose} />
            : <Locked key={row.id} row={row} />))}
        </fieldset>)}
        {view === 'all' && <p className={styles.later}>{LATER_TITLES}</p>}
      </div>
      <div className={styles.foot}>
        {shownError && <p role="alert" className={styles.error}>{shownError}</p>}
        <div className={styles.buttons}>
          {/* Wear title stays focusable while the title is sent (aria-disabled; a press then does nothing): a natively disabled button would drop the focus. */}
          <button type="submit" className={styles.wear} disabled={!busy && same} aria-disabled={busy || undefined}>Wear title</button>
          <button type="button" className={styles.cancel} disabled={busy} onClick={() => finish(null)}>Cancel</button>
          {same && <span className={styles.why}>You wear this now</span>}
        </div>
      </div>
    </form>
  </dialog>;
}
