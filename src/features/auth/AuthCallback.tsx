'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { completeGoogleSignIn } from '../../lib/api/client';

export function AuthCallback() {
  const [error, setError] = useState<'canceled' | 'failed' | null>(null);
  useEffect(() => {
    let active = true;
    void completeGoogleSignIn().then(() => { if (active) window.location.replace('/game/'); })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error && failure.message === 'canceled' ? 'canceled' : 'failed'); });
    return () => { active = false; };
  }, []);
  return <main id="main" className="callback"><p className="eyebrow">CLOUDIATOR</p><h1>{error ? 'Return to your story' : 'Completing Google sign-in…'}</h1>
    {error ? <><p role="alert">{error === 'canceled' ? 'Google sign-in was canceled. Your creation draft is safe.' : 'Google sign-in could not be completed. Return to the camp and try again.'}</p><Link className="primary-link" href="/game/">Return to the camp</Link></> : <p role="status">Checking your sign-in…</p>}
  </main>;
}
