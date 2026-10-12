'use client';

import { useState } from 'react';
import { startGoogleSignIn } from '../../lib/api/client';

export function SignIn({ available }: { available: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function begin() {
    setBusy(true); setError(false);
    try { await startGoogleSignIn(); }
    catch { setError(true); setBusy(false); }
  }
  return <div className="welcome">
    <h3>Your story starts here</h3><p>Sign in with Google to create your gladiator and save progress online.</p>
    <button className="primary-button" disabled={!available || busy} onClick={begin}>{busy ? 'Opening Google…' : 'Continue with Google'}</button>
    {!available && <p className="muted">Google sign-in is unavailable until the project is configured.</p>}
    {error && <p role="alert">Google sign-in could not be started. Please try again.</p>}
  </div>;
}
