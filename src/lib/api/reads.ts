import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityId, GladiatorId, LeagueId } from '@contracts/commands';
import type { PublicActivitySummary, RevealedTimeline } from '@contracts/events';
import type {
  OwnerState, PublicActor, PublicProfile, ResultsPage, RevisionState, StandingsPage, TournamentBout, TournamentEntrant, TournamentPlacement, TournamentView,
  WorldSnapshot,
} from '@contracts/reads';
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
    // max(season_index) from the projection table, whose index leads with season_index; the ranked view would evaluate its
    // window function and promotion check over every row first.
    const latest = checked(await client.from('arena_standings').select('season_index').order('season_index', { ascending: false }).limit(1));
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

const TOURNAMENT_ID = /^tournament:(\d{1,15}):(bronze|silver|gold|champion)$/;
const PAGE = 50;
/** The lookup id of a league's tournament in a slot: Task 19's graph id, `tournament:<slot>:<league>`. */
export function tournamentLookupId(slotIndex: number, league: LeagueId): string {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || !LEAGUES.includes(league)) throw new RangeError('Invalid tournament lookup');
  return `tournament:${slotIndex}:${league}`;
}
type TournamentRow = { id: string; slot_index: number; league: LeagueId; starts_at_ms: number; ends_at_ms: number; status: 'active' | 'insufficient-entrants';
  entrants: TournamentEntrant[]; bracket: TournamentView['bracket']; bouts: Omit<TournamentBout, 'revealedResult'>[]; reveal_at_ms: number[] };
type PlacementRow = { gladiator_id: string; activity_id: string; place: number };
const byName = (a: TournamentEntrant, b: TournamentEntrant) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.gladiatorId < b.gladiatorId ? -1 : 1);
/**
 * One league tournament from Task 19's public rows (RLS enforces database time on every result): the frame, its entrants
 * (by name, never in the private seeded order), the bracket's seeded first round from the start, each bout's result only
 * once it is due, and the placements, with their public completion only, once every entrant has settled. Its status is
 * `processing` while a due result or the settlement is missing, so a delay is never shown as a result. Results and
 * placements are read in pages of at most 50. Never rewards, receipts, ratings or seeds.
 */
export async function readTournament(client: SupabaseClient, id: string): Promise<TournamentView> {
  if (typeof id !== 'string' || !TOURNAMENT_ID.test(id)) throw new GatewayReadError('not-found');
  const clock = await readRevision(client);
  const row = checked<TournamentRow>(await client.from('tournament_views')
    .select('id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms').eq('id', id).maybeSingle());
  const results = new Map<string, TournamentBout['revealedResult']>();
  for (let ordinal = -1; ;) {
    const rows = checked(await client.from('tournament_bout_results').select('bout_id,ordinal,result').eq('tournament_id', id)
      .lte('reveal_at_ms', clock.serverNowMs).gt('ordinal', ordinal).order('ordinal').limit(PAGE));
    for (const r of rows) results.set(r.bout_id, r.result);
    if (rows.length < PAGE) break;
    ordinal = rows.at(-1)!.ordinal;
  }
  const entrants = [...row.entrants].map(e => ({ gladiatorId: e.gladiatorId, name: e.name, classId: e.classId })).sort(byName);
  const bouts: TournamentBout[] = row.bouts.map(b => ({ id: b.id, round: b.round, position: b.position, parentBoutIds: [...b.parentBoutIds],
    revealedResult: results.get(b.id) ?? null }));
  let placements: TournamentPlacement[] = [];
  if (row.status === 'active') {
    const placed: PlacementRow[] = [];
    for (let cursor: string | null = null; ;) {
      let query = client.from('tournament_placements').select('gladiator_id,activity_id,place').eq('tournament_id', id).order('gladiator_id').limit(PAGE);
      if (cursor) query = query.gt('gladiator_id', cursor);
      const rows = checked(await query) as PlacementRow[];
      placed.push(...rows);
      if (rows.length < PAGE) break;
      cursor = rows.at(-1)!.gladiator_id;
    }
    // Placements show only once every entrant has settled, each with its public completion.
    if (placed.length > 0 && placed.length === entrants.length) {
      const completions = new Map<string, PublicActivitySummary>();
      for (let start = 0; start < placed.length; start += PAGE) {
        const rows = checked(await client.from('recent_results').select('activity_id,summary')
          .in('activity_id', placed.slice(start, start + PAGE).map(p => p.activity_id)).lte('reveal_at_ms', clock.serverNowMs));
        for (const r of rows) completions.set(r.activity_id, r.summary);
      }
      if (placed.every(p => completions.has(p.activity_id))) {
        placements = placed.map(p => ({ gladiatorId: p.gladiator_id, place: Number(p.place), completion: completions.get(p.activity_id)! }))
          .sort((a, b) => a.place - b.place || (a.gladiatorId < b.gladiatorId ? -1 : 1));
      }
    }
  }
  const dueMissing = bouts.some(b => b.revealedResult === null && Number(row.reveal_at_ms[b.round - 1]) <= clock.serverNowMs);
  const status: TournamentView['status'] = row.status === 'insufficient-entrants' ? 'insufficient-entrants' : placements.length > 0 ? 'completed'
    : clock.serverNowMs >= Number(row.ends_at_ms) || dueMissing ? 'processing' : 'active';
  return { id: row.id, league: row.league, slotIndex: Number(row.slot_index), startsAtMs: Number(row.starts_at_ms), endsAtMs: Number(row.ends_at_ms),
    status, bracket: row.bracket, entrants, bouts, placements };
}
