import type { SupabaseClient } from '@supabase/supabase-js';

/** Operator repair/backfill only. SQL also publishes transactionally from authoritative mutations.
 * The RPC accepts no DTO/snapshot supplied by a caller: its whitelist reads trusted stored rows.
 */
export async function refreshProjections(client: SupabaseClient): Promise<void> {
  const { error } = await client.rpc('refresh_projections');
  if (error) throw new Error('projection-refresh-failed');
}
