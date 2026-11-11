import { createClient } from '@supabase/supabase-js';
import { makeVerifier } from '../_shared/backend/auth.ts';
import { createGameInfoHandler, createMcpVerifier } from '../_shared/backend/game-info.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw Error(`Missing backend configuration: ${name}`);
  return value;
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const url = required('SUPABASE_URL');
const verifyOwner = makeVerifier(createClient(url, required('SUPABASE_ANON_KEY'), options));
const database = createClient(url, required('SUPABASE_SERVICE_ROLE_KEY'), options);
const allowedOrigins = required('GAME_ALLOWED_ORIGINS').split(',').map(origin => origin.trim());
if (allowedOrigins.some(origin => !origin || new URL(origin).origin !== origin)) throw Error('Origins must be exact origins');

Deno.serve(createGameInfoHandler({
  allowedOrigins,
  verifyOwner,
  verifyMcp: await createMcpVerifier(Deno.env.get('CLOUDIATOR_GAME_INFO_MCP_TOKEN')),
  async edit(actorId, mcp, input) {
    const { data, error } = await database.rpc('edit_game_info', { actor_id: actorId, mcp, input });
    if (error) throw Error('Game Info store unavailable');
    return data;
  },
}));
