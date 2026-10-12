import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let browserClient: SupabaseClient | null = null;

/** Static frontend config contains only the project URL and its publishable key. */
export function getBrowserClient(): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  if (browserClient) return browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !key.startsWith('sb_publishable_')) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) return null;
    browserClient = createClient(url, key, {
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
    });
    return browserClient;
  } catch { return null; }
}

export async function startGoogleSignIn(): Promise<void> {
  const client = getBrowserClient();
  if (!client) throw new Error('unavailable');
  const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: {
    scopes: 'openid email profile', redirectTo: `${window.location.origin}/auth/callback/`,
  } });
  if (error) throw new Error('unavailable');
}

// A single exchange survives React StrictMode's effect replay. Never log codes/tokens.
let callbackExchange: Promise<void> | null = null;
export function completeGoogleSignIn(): Promise<void> {
  if (callbackExchange) return callbackExchange;
  callbackExchange = (async () => {
    const client = getBrowserClient();
    const params = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const providerError = params.get('error') ?? params.get('error_code') ?? fragment.get('error') ?? fragment.get('error_code');
    const code = params.get('code');
    // Remove credential/provider text from history; navigation always uses fixed app routes.
    window.history.replaceState(null, '', '/auth/callback/');
    if (providerError) throw new Error(providerError === 'access_denied' ? 'canceled' : 'unavailable');
    if (!client || !code) throw new Error('unavailable');
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) throw new Error('unavailable');
  })();
  return callbackExchange;
}
