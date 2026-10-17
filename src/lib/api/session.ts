'use client';

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getBrowserClient } from './client';

export type SessionState = {
  status: 'loading' | 'unavailable' | 'signed-out' | 'signed-in';
  userId: string | null;
  expiresAtMs: number | null;
};
const signedOut: SessionState = { status: 'signed-out', userId: null, expiresAtMs: null };
function view(session: Session | null): SessionState {
  const expiresAtMs = (session?.expires_at ?? 0) * 1000;
  // This is presentation state only. Every backend command independently verifies identity.
  return session && expiresAtMs > Date.now()
    ? { status: 'signed-in', userId: session.user.id, expiresAtMs } : signedOut;
}
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading', userId: null, expiresAtMs: null });
  useEffect(() => {
    const client = getBrowserClient();
    if (!client) { setState({ status: 'unavailable', userId: null, expiresAtMs: null }); return; }
    let active = true;
    let authRevision = 0;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      authRevision++;
      if (active) setState(view(session));
    });
    const initialRevision = authRevision;
    void client.auth.getSession().then(({ data, error }) => {
      if (active && authRevision === initialRevision) setState(error ? signedOut : view(data.session));
    }).catch(() => { if (active) setState(signedOut); });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (state.status !== 'signed-in' || state.expiresAtMs === null) return;
    const expire = () => { if (Date.now() >= state.expiresAtMs!) setState(signedOut); };
    const timer = window.setTimeout(expire, Math.min(2_147_483_647, Math.max(0, state.expiresAtMs - Date.now())));
    window.addEventListener('focus', expire);
    document.addEventListener('visibilitychange', expire);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', expire); document.removeEventListener('visibilitychange', expire); };
  }, [state.status, state.expiresAtMs]);
  return state;
}

/**
 * Asks Auth once for a new access token for the stored session (its refresh token): true when the session was renewed.
 * A refused refresh keeps a session whose access token has not expired by this device's clock (supabase-js 2.117.3).
 */
export async function refreshSession(): Promise<boolean> {
  const client = getBrowserClient();
  if (!client) return false;
  try {
    const { data, error } = await client.auth.refreshSession();
    return !error && !!data.session;
  } catch { return false; }
}

/**
 * Signs out every session of the account (`global`, the Sign out button), or only this browser's (`local`): a stored
 * session the server no longer accepts is dropped locally, even when the server also refuses its sign-out.
 */
export async function signOut({ scope = 'global' }: { scope?: 'global' | 'local' } = {}): Promise<void> {
  const client = getBrowserClient();
  if (!client) return;
  const { error } = await client.auth.signOut({ scope });
  if (error) throw new Error('unavailable');
}
