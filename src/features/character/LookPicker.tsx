'use client';

// The "Choose a look" step of the creation dialog (gladiator appearance, Task 6), the approved mockup: a live preview, a Random
// look button, Body and Hair as two-column pill buttons, and swatches for skin tone, hair colour and clothes colour. Every
// choice is a real button with `aria-pressed`; the preview is decorative and a visually hidden status says the look in words.
import { useId } from 'react';
import type { Appearance, BodyId, HairId } from '@domain/appearance';
import { LookPreview } from './LookPreview';
import {
  BODY_NAMES, BODY_OPTIONS, HAIR_NAMES, HAIR_OPTIONS, choose, groupLabels, lookRandom, lookSummary, rerollLook, swatchesOf, type ColourGroup,
} from './look-picker';
import styles from './LookPicker.module.css';

export function LookPicker({ look, name, onChange }: { look: Appearance; name: string; onChange(next: Appearance): void }) {
  const ids = { body: useId(), hair: useId(), skin: useId(), hairColor: useId(), cloth: useId() };
  const labels = groupLabels(look);
  const body = (id: BodyId) => <button key={id} type="button" className={styles.pill} aria-pressed={look.body === id} onClick={() => onChange(choose(look, 'body', id))}>{BODY_NAMES[id]}</button>;
  const hair = (id: HairId) => <button key={id} type="button" className={styles.pill} aria-pressed={look.hair === id} onClick={() => onChange(choose(look, 'hair', id))}>{HAIR_NAMES[id]}</button>;
  const swatches = (group: ColourGroup) => <div className={styles.swatches}>
    {swatchesOf(group).map(swatch => <button key={swatch.index} type="button" className={styles.swatch} aria-label={swatch.label} aria-pressed={look[group] === swatch.index}
      onClick={() => onChange(choose(look, group, swatch.index))}><span className={styles.chip} style={{ background: swatch.colour }} aria-hidden="true" /></button>)}
  </div>;
  return <fieldset className={styles.look}>
    <legend>Choose a look</legend>
    <div className={styles.preview}><LookPreview look={look} name={name} /></div>
    <p role="status" className={styles.summary} data-testid="look-summary">{lookSummary(look)}</p>
    <button type="button" className={styles.random} onClick={() => onChange(rerollLook(look, lookRandom))}>Random look</button>
    <div role="group" aria-labelledby={ids.body} className={styles.group}>
      <span id={ids.body} className={styles.groupLabel}>Body</span>
      <div className={styles.pills}>{BODY_OPTIONS.map(body)}</div>
    </div>
    <div role="group" aria-labelledby={ids.hair} className={styles.group}>
      <span id={ids.hair} className={styles.groupLabel}>Hair</span>
      <div className={styles.pills}>{HAIR_OPTIONS.map(hair)}</div>
    </div>
    <div role="group" aria-labelledby={ids.skin} className={styles.group}>
      <span id={ids.skin} className={styles.groupLabel}>{labels.skin}</span>
      {swatches('skin')}
    </div>
    <div role="group" aria-labelledby={ids.hairColor} className={styles.group}>
      <span id={ids.hairColor} className={styles.groupLabel}>{labels.hairColor}</span>
      {swatches('hairColor')}
    </div>
    <div role="group" aria-labelledby={ids.cloth} className={styles.group}>
      <span id={ids.cloth} className={styles.groupLabel}>{labels.cloth}</span>
      {swatches('cloth')}
    </div>
    <p className={`muted ${styles.note}`}>Your look is set when you create your gladiator.</p>
  </fieldset>;
}
