'use client';

// The titles in the Notifications tab (patch 1.7, spec "Notices (Notifications tab)"; the approved mockup, section 5):
// - `TitleLines`: inside a result's card, after its lines, one gold line per title it earned: "New title: {name}" (the name in italics),
//   its small line, and Wear (named "Wear {name}", `aria-pressed`), which reads "Worn ✓" (pressed) while that title is the one worn now;
// - `NoticeCard`: a notice of its own ("New title: {name}" or "New titles", then the same lines), or the release's "Titles from your
//   history": its line, the earned titles as chips (the worn one first and marked), "Choose a title" (the picker on My gladiator) and
//   "You now wear {name}." (nothing when none is worn).
// Wear sends `wear-title` exactly as the picker does (`useNoticeWear`: one at a time; the same operation id again after an answer that left
// the outcome open). The worn title shown is the shell's (`NoticeTitles.worn`), which an accepted wear sets at once and an owner read that
// began before the answer never undoes (Review Focus 5, the Title button's rule); the answer reaches the shell even when the panel has gone.
import { useEffect, useRef, useState } from 'react';
import type { CommandResult, WearTitleValue } from '@contracts/commands';
import type { EarnedTitle } from '@contracts/reads';
import { HISTORY_INTRO, historyChips, type TitleNotice, type TitleRow } from '../titles/title-notices';
import { wornStatus } from '../titles/title-picker';
import { titleName } from '../titles/title-text';
import { WEAR_PREVIEW, WEAR_REFUSED, answeredTitle, keepsWearAttempt, wearAttemptFor, type WearAttempt, type WearCommand } from '../titles/title-wear';
import { messageDate } from './messages';
import styles from './messages.module.css';

/** What the Notifications tab needs for the owner's titles, from the shell. */
export type NoticeTitles = {
  gladiatorId: string;
  /** The titles the owner holds (the owner read's). */
  held: readonly EarnedTitle[];
  /** The title shown as worn now: the shell's, which a wear's answer sets at once (Review Focus 5). */
  worn: string | null;
  /** The fixture preview takes no commands: a refused wear says so. */
  preview: boolean;
  /** Sends one `wear-title`. */
  send(command: WearCommand): Promise<CommandResult<WearTitleValue>>;
  /** A wear was accepted: the gladiator and the title the answer says it wears now. The shell's; safe after the panel has gone. */
  onWorn(gladiatorId: string, titleId: string | null): void;
  /** Reads the owner (and the camp) again after a wear; it settles on its own. */
  refresh(): void;
  /** Opens "Choose your title" on My gladiator. */
  choose(): void;
};

export type NoticeWear = { wear(titleId: string): void; sending: string | null; error: { titleId: string; text: string } | null };

/** Wear from a notice: the picker's command and retry rule, one wear at a time; a refusal is said on its line. */
export function useNoticeWear(titles: NoticeTitles | undefined): NoticeWear {
  const attempt = useRef<WearAttempt | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ titleId: string; text: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const wear = async (titleId: string) => {
    if (!titles || sending.current || titles.worn === titleId) return;
    const { gladiatorId, send, onWorn, refresh, preview } = titles;
    const next = wearAttemptFor(attempt.current, titleId, () => crypto.randomUUID());
    attempt.current = next;
    sending.current = true; setBusy(titleId); setError(null);
    try {
      const result = await send(next.command);
      if (result.ok) {
        attempt.current = null;
        // Told to the shell even when the panel has closed during the send.
        onWorn(gladiatorId, answeredTitle(result.value, next.titleId));
        refresh();
        return;
      }
      if (!keepsWearAttempt(result.code)) attempt.current = null;
      if (mounted.current) setError({ titleId, text: preview && result.code === 'unavailable' ? WEAR_PREVIEW : WEAR_REFUSED });
    } catch {
      if (mounted.current) setError({ titleId, text: WEAR_REFUSED });
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return { wear: titleId => { void wear(titleId); }, sending: busy, error };
}

/** The gold lines of a result or a notice: one per title, with Wear. */
export function TitleLines({ rows, worn, wear }: { rows: readonly TitleRow[]; worn: string | null; wear: NoticeWear }) {
  return <>{rows.map(row => {
    const pressed = worn === row.id;
    // A refusal is about the title that was sent: once it is worn (a lost answer a later read shows), it is moot.
    const error = wear.error?.titleId === row.id && !pressed ? wear.error.text : null;
    return <div key={row.id} className={styles.tline} data-title-line={row.id}>
      <span className={styles.tlineText}>New title: <i>{row.name}</i><small>{row.detail}</small></span>
      {/* Wear stays focusable while a title is sent (aria-disabled; a press then does nothing), so the focus is never dropped. */}
      <button type="button" className={styles.wear} aria-label={`Wear ${row.name}`} aria-pressed={pressed}
        aria-disabled={wear.sending !== null || undefined} onClick={() => wear.wear(row.id)}>{pressed ? 'Worn ✓' : 'Wear'}</button>
      {error && <p role="alert" className={styles.tlineError}>{error}</p>}
    </div>;
  })}</>;
}

/** A title notice's card: its own notice with the gold lines, or the release's history notice. */
export function NoticeCard({ notice, fresh, titles, wear, onChoose }: {
  notice: TitleNotice; fresh: boolean; titles: NoticeTitles; wear: NoticeWear;
  /** "Choose a title": the panel closes and the picker opens on My gladiator. */
  onChoose(): void;
}) {
  const history = notice.kind === 'history';
  return <li className={styles.card} data-title-notice={history ? 'history' : notice.key} data-unread={fresh ? '' : undefined}>
    <span className={styles.rowTop}>
      <span className={styles.rowTitle}>
        {fresh && <span className={styles.dot} data-unread-dot aria-hidden="true" />}
        {fresh && <span className={styles.sr}>New: </span>}
        <span className={fresh ? styles.titleNew : styles.title} data-notice-title>{notice.heading}</span>
      </span>
      <span className={styles.date}>{messageDate(notice.atMs)}</span>
    </span>
    {history ? <>
      <p className={styles.intro}>{HISTORY_INTRO}</p>
      <ul className={styles.tchips}>
        {historyChips(notice.rows, titles.worn).map(chip => <li key={chip.name} className={chip.worn ? styles.tchipWorn : styles.tchip} data-title-chip=""
          data-worn={chip.worn ? '' : undefined}>{chip.name}</li>)}
      </ul>
      <div className={styles.act}>
        <button type="button" className={styles.choose} onClick={onChoose}>Choose a title</button>
        {titleName(titles.worn) !== null && <span>{wornStatus(titles.worn)}</span>}
      </div>
    </> : <TitleLines rows={notice.rows} worn={titles.worn} wear={wear} />}
  </li>;
}
