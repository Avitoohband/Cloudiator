import { createClient } from '@supabase/supabase-js';
import { makeVerifier } from '../_shared/backend/auth.ts';
import { createDatabase } from '../_shared/backend/database.ts';
import { handleCommand } from '../_shared/backend/commands.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing backend configuration: ${name}`);
  return value;
}
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const url = required('SUPABASE_URL');
const verifier = makeVerifier(createClient(url, required('SUPABASE_ANON_KEY'), options));
const database = createDatabase(createClient(url, required('SUPABASE_SERVICE_ROLE_KEY'), options));
const allowedOrigins = required('GAME_ALLOWED_ORIGINS').split(',').map(origin => origin.trim());
if (allowedOrigins.some(origin => !origin || new URL(origin).origin !== origin)) throw new Error('Origins must be exact origins');
export const verifyActor = verifier;
Deno.serve(request => handleCommand(request, { verifyActor, database, allowedOrigins }));
