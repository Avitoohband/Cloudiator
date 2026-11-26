'use client';

import { useId } from 'react';
import { SIGN_IN_NOT_STARTED, useGoogleSignIn } from '../auth/SignIn';
import styles from './promo.module.css';

export function PromoWelcome({ onDismiss }: { onDismiss(): void }) {
  const heading = useId();
  const detail = useId();
  const google = useGoogleSignIn();
  return <section className={styles.welcome} aria-labelledby={heading} onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || google.busy) return;
    event.preventDefault();
    onDismiss();
  }}>
    <h2 id={heading}>Build your gladiator</h2>
    <p id={detail}>Sign in with Google to play.</p>
    <button type="button" className={styles.play} aria-describedby={detail} aria-disabled={google.busy}
      onClick={() => void google.begin()}>{google.busy ? 'Opening Google…' : 'Play free in your browser'}</button>
    <button type="button" className={styles.explore} disabled={google.busy} onClick={onDismiss}>Explore the camp</button>
    {google.failed && <p role="alert">{SIGN_IN_NOT_STARTED}</p>}
  </section>;
}
