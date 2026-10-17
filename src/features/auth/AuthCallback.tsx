'use client';

import { useEffect } from 'react';
import { completeGoogleSignIn } from '../../lib/api/client';

/**
 * The Google sign-in return. Success, a cancellation and a failure all go back to the camp at the fixed `/game/` route,
 * replacing this entry in history: a cancellation as `?signin=cancelled` and a failure as `?signin=failed`, which the
 * camp turns into a short message (plan Decision 6). Provider text and any other parameter are never shown or followed.
 */
export function AuthCallback() {
  useEffect(() => {
    let active = true;
    void completeGoogleSignIn().then(() => { if (active) window.location.replace('/game/'); })
      .catch((failure: unknown) => {
        if (active) window.location.replace(`/game/?signin=${failure instanceof Error && failure.message === 'canceled' ? 'cancelled' : 'failed'}`);
      });
    return () => { active = false; };
  }, []);
  return <main id="main" className="callback"><p className="eyebrow">CLOUDIATOR</p><h1>Completing Google sign-in…</h1>
    <p role="status">Checking your sign-in…</p>
  </main>;
}
