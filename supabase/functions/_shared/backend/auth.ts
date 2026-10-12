import type { SupabaseClient } from '@supabase/supabase-js';

/** Only constructed after Auth verifies the bearer token. Never derived from a body or user_metadata. */
export type Actor = Readonly<{ userId: string }>;
export function makeVerifier(client: SupabaseClient): (request: Request) => Promise<Actor> {
  return async function verifyActor(request: Request): Promise<Actor> {
    const header = request.headers.get('Authorization');
    if (!header || !/^Bearer [^\s]+$/i.test(header) || header.length > 8192) throw new Error('unauthenticated');
    const { data, error } = await client.auth.getUser(header.slice(7));
    const user = data.user;
    if (error || !user || user.is_anonymous || user.app_metadata.provider !== 'google'
      || !user.identities?.some(identity => identity.provider === 'google')) throw new Error('unauthenticated');
    return Object.freeze({ userId: user.id });
  };
}
