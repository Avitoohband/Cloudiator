'use client';

// Patch 1.9 Task 29 (approved mockup 2026-11-13, "On-screen notice"): when the NEXT slot's planned activity will not run (not enough stamina,
// or a Training past the day's limit), a notice in the column under the chip, under the arrival banner, as the patch notice is drawn:
// "STAMINA", the words (`nextSlotNotice`), "Open schedule" and a dismiss (×). The shell decides when it shows (the player's own, never over a
// scene or a practice fight, once per slot). It never takes the focus and has no timer; the live region is always in the page, so the
// notice, when it arrives, is announced.
import styles from './shell.module.css';

export function StaminaNotice({ text, onOpen, onDismiss }: {
  /** The notice's words, or null for none (the region stays, empty). */
  text: string | null;
  onOpen(): void;
  onDismiss(): void;
}) {
  return (
    <div className={text === null ? styles.sr : styles.staminaNotice} role="status" data-stamina-notice="">
      {text !== null && <>
        <div className={styles.staminaBody}>
          <span className={styles.staminaEyebrow}>Stamina</span>
          <p>{text}</p>
          <button type="button" className={styles.reload} onClick={onOpen}>Open schedule</button>
        </div>
        <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>×</button>
      </>}
    </div>
  );
}
