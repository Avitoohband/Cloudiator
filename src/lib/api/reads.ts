import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityId, GladiatorId, LeagueId } from '@contracts/commands';
import type { RevealedTimeline } from '@contracts/events';
import type { OwnerState, PublicActor, PublicProfile, ResultsPage, RevisionState, StandingsPage, WorldSnapshot } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';

export class GatewayReadError extends Error {
  constructor(public readonly code: 'unavailable' | 'not-found' | 'unauthenticated') { super(code); }
}
function checked<T>(result: { data: T | null; error: { code?: string } | null; status?: number }): NonNullable<T> {
  if (result.error) throw new GatewayReadError(result.status === 401 || result.status === 403 || ['PGRST301', 'PGRST302', 'PGRST303', '42501'].includes(result.error.code ?? '') ? 'unauthenticated' : 'unavailable');
  if (result.data === null) throw new GatewayReadError('not-found');
  return result.data as NonNullable<T>;
}
export async function readOwner(client: SupabaseClient): Promise<OwnerState> {
  const row = checked<{ state: OwnerState }>(await client.from('owner_state').select('state').maybeSingle());
  if (!row.state || typeof row.state !== 'object') throw new GatewayReadError('unavailable');
  return row.state;
}
export async function readRevision(client: SupabaseClient): Promise<RevisionState> {
  const row = checked<{revision:string;server_now_ms:number;slot_index:number}>(await client.from('world_revision').select('revision,server_now_ms,slot_index').single());
  return { revision: row.revision, serverNowMs: Number(row.server_now_ms), slotIndex: Number(row.slot_index) };
}
export async function readWorld(client: SupabaseClient): Promise<WorldSnapshot> {
  // A concurrent commit between pages must not be labeled with an earlier revision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readRevision(client), actors: PublicActor[] = [];
    let cursor: string | undefined;
    for (;;) {
      let query = client.from('world_actor_reads').select('gladiator_id,actor').order('gladiator_id').limit(50);
      if (cursor) query = query.gt('gladiator_id', cursor);
      const rows = checked(await query); actors.push(...rows.map(row => row.actor as PublicActor));
      if (rows.length < 50) break;
      cursor = rows.at(-1)!.gladiator_id;
    }
    const after = await readRevision(client);
    if (before.revision === after.revision) return { ...after, actors };
  }
  throw new GatewayReadError('unavailable');
}
export async function readProfile(client: SupabaseClient, id: GladiatorId): Promise<PublicProfile> {
  return checked<{profile:PublicProfile}>(await client.from('public_profile_reads').select('profile').eq('gladiator_id', id).maybeSingle()).profile;
}
export async function readTimeline(client: SupabaseClient, id: ActivityId): Promise<RevealedTimeline> {
  const clock = await readRevision(client);
  const result: RevealedTimeline = { activityId: id, serverNowMs: clock.serverNowMs, visibleThroughMs: clock.serverNowMs, stages: [] };
  let ordinal = -1;
  for (;;) {
    const rows = checked(await client.from('visible_events').select('ordinal,stage').eq('activity_id', id)
      .lte('reveal_at_ms', clock.serverNowMs).gt('ordinal', ordinal).order('ordinal').limit(50));
    result.stages.push(...rows.map(row => row.stage));
    if (rows.length < 50) break;
    ordinal = rows.at(-1)!.ordinal;
  }
  const publicResult = await client.from('recent_results').select('summary').eq('activity_id', id).lte('reveal_at_ms', clock.serverNowMs).maybeSingle();
  if (publicResult.error) checked(publicResult);
  if (publicResult.data) result.completion = publicResult.data.summary;
  // This separate query remains owner-only through activities RLS; no privileged fallback.
  const owner = await client.from('activities').select('summary').eq('id', id).eq('status', 'completed').lte('settled_at_ms', clock.serverNowMs).maybeSingle();
  if (owner.error) checked(owner);
  if (owner.data?.summary) result.summary = owner.data.summary;
  return result;
}
export async function readRecent(client: SupabaseClient, cursor?: string): Promise<ResultsPage> {
  let query = client.from('recent_results').select('activity_id,gladiator_id,name,summary,reveal_at_ms')
    .order('reveal_at_ms', { ascending: false }).order('activity_id').limit(50);
  if (cursor) {
    const match = /^(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(cursor);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new GatewayReadError('unavailable');
    const [,time,id] = match;
    query = query.or(`reveal_at_ms.lt.${time},and(reveal_at_ms.eq.${time},activity_id.gt.${id})`);
  }
  const rows = checked(await query);
  return { rows: rows.map(row => ({ gladiatorId: row.gladiator_id, name: row.name, summary: row.summary })),
    nextCursor: rows.length === 50 ? `${rows.at(-1)!.reveal_at_ms}:${rows.at(-1)!.activity_id}` : null };
}
const LEAGUES: readonly string[] = ['bronze', 'silver', 'gold', 'champion'];
const STANDINGS_PAGE = 50;
type StandingRead = { gladiator_id: string; name: string; rating: number; human_wins: number; human_losses: number; rank: number; promoted: boolean };
/**
 * One league's current-season standings (spec §8.3 order: rating, human wins, fewer human losses, stable id), ranked by
 * the public invoker view over Task 16's standings projection. The current season is the latest one with rows; a
 * cursor `season:rank` keeps later pages in its season and starts after its rank. At most 50 rows per page. Only
 * public standing fields exist in the view; reward eligibility uses the versioned five-human-bout threshold.
 */
export async function readStandings(client: SupabaseClient, league: LeagueId, cursor?: string): Promise<StandingsPage> {
  if (!LEAGUES.includes(league)) throw new GatewayReadError('unavailable');
  let season: number | null = null, after = 0;
  if (cursor !== undefined) {
    const match = /^(\d{1,15}):(\d{1,15})$/.exec(cursor);
    if (!match) throw new GatewayReadError('unavailable');
    season = Number(match[1]); after = Number(match[2]);
  } else {
    const latest = checked(await client.from('arena_standing_reads').select('season_index').order('season_index', { ascending: false }).limit(1));
    if (latest.length) season = Number(latest[0].season_index);
  }
  if (season === null) return { league, seasonId: '', archived: false, rows: [], nextCursor: null };
  // The Data API caps a response at 50 rows (config max_rows), so a full page is what signals a possible next page.
  const rows = checked(await client.from('arena_standing_reads').select('gladiator_id,name,rating,human_wins,human_losses,rank,promoted')
    .eq('league', league).eq('season_index', season).gt('rank', after).order('rank').limit(STANDINGS_PAGE)) as StandingRead[];
  const page = rows.slice(0, STANDINGS_PAGE).map(row => {
    const humanWins = Number(row.human_wins), humanLosses = Number(row.human_losses);
    return { rank: Number(row.rank), gladiatorId: row.gladiator_id, name: row.name, rating: Number(row.rating), humanWins, humanLosses,
      promoted: row.promoted === true, inactive: humanWins + humanLosses === 0,
      rewardEligible: humanWins + humanLosses >= RULES_V1.seasons.minimumHumanBouts };
  });
  return { league, seasonId: String(season), archived: false, rows: page,
    nextCursor: page.length === STANDINGS_PAGE ? `${season}:${page.at(-1)!.rank}` : null };
}
