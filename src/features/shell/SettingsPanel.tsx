'use client';

// The Settings menu (Patch 1.9, the approved mockup). Its first section, Menu, holds the two device preferences for the menu
// rail: keep it open (a switch) and which edge it sits on (a three-way choice ordered by where the menu goes: left, bottom,
// right). They are for the pointer layout; the touch layout shows a line saying so instead (a touch tablet too). The second,
// "Names and titles" (Task 11), chooses when the camp shows names and worn titles over heads: Off, When zoomed in (the camp
// before Patch 1.9) or Always, each with a line saying what it does; it works on phones too. With Names Off, Titles is
// greyed out with a note (its choice is kept for when names come back). Everything applies at once and is saved in this
// browser only. Patch 1.9 (Task 23, the approved feedback mockup): a signed-in account of the live game gets a last section, Help, with
// "Send feedback" and Send…, which opens the same dialog as the Messages panel's footer.
import { useId, useRef, useState, type ReactNode } from 'react';
import { FeedbackDialog } from '../messages/FeedbackDialog';
import { FEEDBACK_ANSWER_LATER, type FeedbackActions } from '../messages/feedback';
import type { LabelMode, LabelPrefs, MenuPlace, MenuPrefs } from './menu-prefs';
import styles from './shell.module.css';

/** The choices in the order they sit on screen, which is also the arrow keys' order. */
const PLACES: readonly { place: MenuPlace; label: string; before?: string; after?: string }[] = [
  { place: 'left', label: 'Left', before: '◀' },
  { place: 'bottom', label: 'Bottom', before: '▼' },
  { place: 'right', label: 'Right', after: '▶' },
];
const MODES: readonly { mode: LabelMode; label: string }[] = [
  { mode: 'off', label: 'Off' },
  { mode: 'zoom', label: 'When zoomed in' },
  { mode: 'always', label: 'Always' },
];
const NAME_HELP: Record<LabelMode, string> = {
  off: 'No names on the camp.',
  zoom: 'Gladiator names from zoom 1.4, NPC names from zoom 2.',
  always: 'Names at any zoom, zoomed out too.',
};
const TITLE_HELP: Record<LabelMode, string> = {
  off: 'No titles.',
  zoom: 'Titles from zoom 2, beside the name.',
  always: 'A title with every name that shows.',
};

/** A three-way choice as a radio group (native radios: the arrow keys move along it), with its line underneath. */
function ModeChoice({ id, label, value, onChange, disabled = false, help }: {
  id: string; label: string; value: LabelMode; onChange(mode: LabelMode): void; disabled?: boolean; help: ReactNode;
}) {
  return (
    <div className={styles.settingsField}>
      <span className={styles.settingsLabel} id={`${id}-label`}>{label}</span>
      <div className={styles.settingsSeg} role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}
        aria-disabled={disabled || undefined} data-disabled={disabled ? '' : undefined}>
        {MODES.map(({ mode, label: text }) => (
          <label key={mode}>
            <input type="radio" name={id} value={mode} checked={value === mode} disabled={disabled} onChange={() => onChange(mode)} />
            <span>{text}</span>
          </label>
        ))}
      </div>
      <div id={`${id}-help`}>{help}</div>
    </div>
  );
}

export function SettingsPanel({ prefs, onChange, labels, onLabels, compact, feedback, onSeeMine, noGladiator = false }: {
  prefs: MenuPrefs; onChange(change: Partial<MenuPrefs>): void;
  labels: LabelPrefs; onLabels(change: Partial<LabelPrefs>): void;
  compact: boolean;
  /** Patch 1.9: Feedback (a signed-in account of the live game only); absent shows no Help section. */
  feedback?: FeedbackActions;
  /** "See my feedback" once sent: Settings closes and Messages opens on My feedback (absent without a gladiator, which has no Messages). */
  onSeeMine?(): void;
  /** A signed-in account without a gladiator (final fix wave): the team's answer arrives once it has one, so Help and the sent line say so. */
  noGladiator?: boolean;
}) {
  const id = useId();
  const namesOff = labels.names === 'off';
  const [writing, setWriting] = useState(false);
  const sendButton = useRef<HTMLButtonElement>(null);
  return (
    <div className={styles.settings} data-testid="settings-panel">
      <section aria-labelledby={`${id}-menu`} className={styles.settingsSection}>
        <h3 id={`${id}-menu`} className={styles.settingsHeading}>Menu</h3>
        {compact ? <p className={styles.settingsPlain}>Menu options are available with a mouse or trackpad.</p> : <>
          <div className={styles.settingsRow}>
            <div>
              <div className={styles.settingsLabel} id={`${id}-pin`}>Keep the menu open</div>
              <p className={styles.settingsHelp} id={`${id}-pin-help`}>Off: it slides away when you move off it.</p>
            </div>
            <button type="button" className={styles.settingsSwitch} role="switch" aria-checked={prefs.pinned} aria-labelledby={`${id}-pin`} aria-describedby={`${id}-pin-help`}
              onClick={() => onChange({ pinned: !prefs.pinned })} />
          </div>
          <div className={styles.settingsField}>
            <span className={styles.settingsLabel} id={`${id}-pos`}>Menu position</span>
            <div className={styles.settingsSeg} role="radiogroup" aria-labelledby={`${id}-pos`}>
              {PLACES.map(({ place, label, before, after }) => (
                <label key={place}>
                  <input type="radio" name={`${id}-place`} value={place} checked={prefs.place === place} onChange={() => onChange({ place })} />
                  <span>{before && <span aria-hidden="true">{before} </span>}{label}{after && <span aria-hidden="true"> {after}</span>}</span>
                </label>
              ))}
            </div>
          </div>
        </>}
      </section>
      <section aria-labelledby={`${id}-labels`} className={styles.settingsSection}>
        <h3 id={`${id}-labels`} className={styles.settingsHeading}>Names and titles</h3>
        <ModeChoice id={`${id}-names`} label="Names" value={labels.names} onChange={names => onLabels({ names })}
          help={<p className={styles.settingsHelp}>{NAME_HELP[labels.names]}</p>} />
        <ModeChoice id={`${id}-titles`} label="Titles" value={labels.titles} onChange={titles => onLabels({ titles })} disabled={namesOff}
          help={namesOff
            ? <p className={styles.settingsNote}>Titles show only where names show. Turn Names on to choose.</p>
            : <p className={styles.settingsHelp}>{TITLE_HELP[labels.titles]}</p>} />
      </section>
      {feedback && <section aria-labelledby={`${id}-help`} className={`${styles.settingsSection} ${styles.settingsHelpSection}`}>
        <h3 id={`${id}-help`} className={styles.settingsHeading}>Help</h3>
        <div className={styles.settingsRow}>
          <div>
            <div className={styles.settingsLabel} id={`${id}-feedback`}>Send feedback</div>
            <p className={styles.settingsHelp} id={`${id}-feedback-help`}>Report a bug or share an idea. {noGladiator ? FEEDBACK_ANSWER_LATER : 'The team answers in your messages.'}</p>
          </div>
          <button ref={sendButton} type="button" className={styles.settingsSend} aria-labelledby={`${id}-feedback`} aria-describedby={`${id}-feedback-help`}
            aria-haspopup="dialog" onClick={() => setWriting(true)}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v11H9l-5 4z" /></svg>
            Send…
          </button>
        </div>
      </section>}
      <p className={styles.settingsFoot}>Saved in this browser. Changes apply at once.</p>
      {writing && feedback && <FeedbackDialog actions={feedback} screen="Settings" canSeeMine={!!onSeeMine} noGladiator={noGladiator} onClose={({ then }) => {
        setWriting(false);
        if (then === 'mine') onSeeMine?.();
        else window.setTimeout(() => sendButton.current?.focus(), 0);
      }} />}
    </div>
  );
}
