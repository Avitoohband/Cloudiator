'use client';

// The Settings menu (Patch 1.9, the approved mockup). Its first section, Menu, holds the two device preferences for the menu
// rail: keep it open (a switch) and which edge it sits on (a three-way choice ordered by where the menu goes: left, bottom,
// right). They apply at once and are saved in this browser only. They are for the pointer layout; the touch layout shows a line
// saying so instead (a touch tablet too). A second section, "Names and titles", is added by a later task.
import { useId } from 'react';
import type { MenuPlace, MenuPrefs } from './menu-prefs';
import styles from './shell.module.css';

/** The choices in the order they sit on screen, which is also the arrow keys' order. */
const PLACES: readonly { place: MenuPlace; label: string; before?: string; after?: string }[] = [
  { place: 'left', label: 'Left', before: '◀' },
  { place: 'bottom', label: 'Bottom', before: '▼' },
  { place: 'right', label: 'Right', after: '▶' },
];

export function SettingsPanel({ prefs, onChange, compact }: { prefs: MenuPrefs; onChange(change: Partial<MenuPrefs>): void; compact: boolean }) {
  const id = useId();
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
      <p className={styles.settingsFoot}>Saved in this browser. Changes apply at once.</p>
    </div>
  );
}
