import { createClient } from '@supabase/supabase-js';
import { createWorkerDatabase } from '../_shared/backend/database.ts';
import { handleWorker, runWorker } from '../_shared/backend/jobs.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing backend configuration: ${name}`);
  return value;
}
// Explicit server-only worker credential (backend secrets / Vault); a publishable or user key never authorizes work.
const secret = required('GAME_WORKER_SECRET');
if (secret.length < 32) throw new Error('GAME_WORKER_SECRET must contain at least 32 characters');
const database = createWorkerDatabase(createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } }));
Deno.serve(request => handleWorker(request, { secret, run: () => runWorker({ database, workerId: crypto.randomUUID() }) }));
