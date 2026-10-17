'use client';

// Google sign-in, the existing Task 5 flow (`startGoogleSignIn` leaves for Google and returns through /auth/callback/).
// Task 13.6: the approved mockup's "G" mark, the hook the corner chip and My gladiator start it with, and a visitor's
// prompt in My gladiator. Watching needs no account; joining needs Google sign-in.
import { useState } from 'react';
import { startGoogleSignIn } from '../../lib/api/client';
import styles from './SignIn.module.css';

/** The mockup's Google mark, a white disc with a blue "G". Decorative: the button's text names the action. */
export function GoogleMark() {
  return <span className={styles.mark} aria-hidden="true" data-testid="google-mark">G</span>;
}

/** Starts Google sign-in: `busy` while the browser leaves for Google, `failed` when it could not be started. */
export function useGoogleSignIn() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function begin() {
    setBusy(true); setFailed(false);
    try { await startGoogleSignIn(); } catch { setFailed(true); setBusy(false); }
  }
  return { busy, failed, begin };
}

export const SIGN_IN_NOT_STARTED = 'Google sign-in could not be started. Please try again.';

/**
 * A visitor's My gladiator (spec "Menus", the Visitor column): everything is open to watch, and the button starts Google
 * sign-in. `unavailable` says why it cannot (the fixture preview, or a build without sign-in configured).
 */
export function SignIn({ unavailable }: { unavailable: string | null }) {
  const { busy, failed, begin } = useGoogleSignIn();
  return <div className={styles.note}>
    <p><b>You’re watching as a visitor.</b></p>
    <p className="muted">Everything in the camp is open to watch. Sign in with Google to create your own gladiator and join.</p>
    <button type="button" className={styles.button} disabled={unavailable !== null || busy} onClick={() => void begin()}>
      <GoogleMark /><span>{busy ? 'Opening Google…' : 'Sign in with Google to create your gladiator'}</span>
    </button>
    {unavailable && <p className="muted">{unavailable}</p>}
    {failed && <p role="alert">{SIGN_IN_NOT_STARTED}</p>}
  </div>;
}
