import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityId, GladiatorId, LeagueId } from '@contracts/commands';
import type { BattleLog, PublicActivitySummary, RevealedTimeline } from '@contracts/events';
import type {
  MarketListing, MarketPage, OwnerState, PublicActor, PublicProfile, ResultsPage, RevisionState, StandingsPage, TournamentBout, TournamentEntrant,
  TournamentPlacement, TournamentView, WorldSnapshot,
} from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import { TOURNAMENT_BOUT_ID, TOURNAMENT_ID } from '../tournament-id';

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
/**
 * One activity's revealed timeline: its due stages and its public completion, which anyone may read. With `ownerSummary`
 * it also asks `activities` for the owner's credited summary; that table is owner-only, so a visitor's read must pass
 * `false` (the denial would fail the whole read) and never has a summary. The option is required, so no caller gets
 * either behavior by omission.
 */
export async function readTimeline(client: SupabaseClient, id: ActivityId, options: { ownerSummary: boolean }): Promise<RevealedTimeline> {
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
  if (!options.ownerSummary) return result;
  // This separate query remains owner-only through activities RLS; no privileged fallback.
  const owner = await client.from('activities').select('summary').eq('id', id).eq('status', 'completed').lte('settled_at_ms', clock.serverNowMs).maybeSingle();
  if (owner.error) checked(owner);
  if (owner.data?.summary) result.summary = owner.data.summary;
  return result;
}
/**
 * The results cursor `revealAtMs:activityId`: null for no cursor (absent, null or empty), and `unavailable` for anything
 * malformed, before a query is built from it. The fixture gateway applies the same rule.
 */
export function parseResultsCursor(cursor?: string | null): { time: string; id: string } | null {
  if (!cursor) return null;
  const match = typeof cursor === 'string' ? /^(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(cursor) : null;
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new GatewayReadError('unavailable');
  return { time: match[1], id: match[2] };
}
export async function readRecent(client: SupabaseClient, cursor?: string): Promise<ResultsPage> {
  let query = client.from('recent_results').select('activity_id,gladiator_id,name,summary,reveal_at_ms')
    .order('reveal_at_ms', { ascending: false }).order('activity_id').limit(50);
  const after = parseResultsCursor(cursor);
  if (after) query = query.or(`reveal_at_ms.lt.${after.time},and(reveal_at_ms.eq.${after.time},activity_id.gt.${after.id})`);
  const rows = checked(await query);
  return { rows: rows.map(row => ({ gladiatorId: row.gladiator_id, name: row.name, summary: row.summary })),
    nextCursor: rows.length === 50 ? `${rows.at(-1)!.reveal_at_ms}:${rows.at(-1)!.activity_id}` : null };
}
const MARKET_PAGE = 50;
const GLADIATOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The market read's options, checked before any query is built: the cursor `listedAtMs:listingId` follows the results
 * cursor's rules (none when absent, null or empty; `unavailable` when malformed), and a seller, when given, must be a
 * gladiator id (lowercased here; anything else is `unavailable`, so an empty one never widens to every seller). The fixture
 * gateway applies the same rules.
 */
export function parseMarketRead(cursor?: string | null, seller?: string | null): { after: { time: string; id: string } | null; seller: string | null } {
  const after = parseResultsCursor(cursor);
  if (seller === undefined || seller === null) return { after, seller: null };
  if (typeof seller !== 'string' || !GLADIATOR_ID.test(seller)) throw new GatewayReadError('unavailable');
  return { after, seller: seller.toLowerCase() };
}
type OfferRow = { id: string; seller_gladiator_id: string; seller_name: string; item: MarketListing['item']; price: number; listed_at_ms: number; expires_at_ms: number };
/**
 * One page of open fixed-price offers from the public `market_offers` projection, which visitors read as `anon` (its RLS
 * hides an offer from its expiry time on). Newest listing first, then by listing id, at most 50 rows; with `seller`, only that
 * gladiator's offers. A full page names its last row as the next cursor. The item crosses only its six sanitized fields.
 */
export async function readMarket(client: SupabaseClient, cursor?: string, seller?: GladiatorId): Promise<MarketPage> {
  const options = parseMarketRead(cursor, seller);
  let query = client.from('market_offers').select('id,seller_gladiator_id,seller_name,item,price,listed_at_ms,expires_at_ms')
    .order('listed_at_ms', { ascending: false }).order('id').limit(MARKET_PAGE);
  if (options.seller) query = query.eq('seller_gladiator_id', options.seller);
  if (options.after) query = query.or(`listed_at_ms.lt.${options.after.time},and(listed_at_ms.eq.${options.after.time},id.gt.${options.after.id})`);
  // The Data API caps a response at 50 rows (config max_rows), so a full page is what signals a possible next page.
  const rows = (checked(await query) as OfferRow[]).slice(0, MARKET_PAGE);
  const last = rows.at(-1);
  return {
    rows: rows.map(row => {
      const { catalogId, catalogVersion, tier, rarity, stats, quantity } = row.item;
      return { listingId: row.id, seller: { gladiatorId: row.seller_gladiator_id, name: row.seller_name },
        item: { catalogId, catalogVersion, tier, rarity, stats, quantity }, price: Number(row.price), listedAtMs: Number(row.listed_at_ms), expiresAtMs: Number(row.expires_at_ms) };
    }),
    nextCursor: last && rows.length === MARKET_PAGE ? `${last.listed_at_ms}:${last.id}` : null,
  };
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

const PAGE = 50;
/**
 * The result fields a polled tournament read needs, by PostgREST JSON-path selection on `result`: participants, winner,
 * bye and the fight summary (duration, victory and tie-break reasons). Never the battle log (2b review I1): a late
 * 50-entrant view carried about half a megabyte of logs on every poll. A log loads on demand (`readTournamentLog`).
 */
const POLLED_RESULT = 'bout_id,ordinal,participants:result->participants,winnerId:result->>winnerId,bye:result->bye,'
  + 'durationMs:result->battleLog->durationMs,victoryReason:result->battleLog->>victoryReason,tieBreakReason:result->battleLog->>tieBreakReason';
type PolledResultRow = { bout_id: string; ordinal: number; participants: TournamentEntrant[]; winnerId: GladiatorId; bye: boolean;
  durationMs: unknown; victoryReason: unknown; tieBreakReason: unknown };
/** A polled row as the view's revealed result; the stage core checks it is well formed before showing it. */
function polledResult(row: PolledResultRow): NonNullable<TournamentBout['revealedResult']> {
  const result: NonNullable<TournamentBout['revealedResult']> = { participants: row.participants, winnerId: row.winnerId, bye: row.bye };
  if (row.durationMs != null || row.victoryReason != null || row.tieBreakReason != null) {
    result.fight = { durationMs: row.durationMs, victoryReason: row.victoryReason, tieBreakReason: row.tieBreakReason ?? null } as NonNullable<typeof result.fight>;
  }
  return result;
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
 * placements are read in pages of at most 50. Never rewards, receipts, ratings, seeds or battle logs (each result carries
 * its fight summary; `readTournamentLog` loads one bout's log on demand).
 */
export async function readTournament(client: SupabaseClient, id: string): Promise<TournamentView> {
  if (typeof id !== 'string' || !TOURNAMENT_ID.test(id)) throw new GatewayReadError('not-found');
  const clock = await readRevision(client);
  const row = checked<TournamentRow>(await client.from('tournament_views')
    .select('id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms').eq('id', id).maybeSingle());
  const results = new Map<string, TournamentBout['revealedResult']>();
  for (let ordinal = -1; ;) {
    const rows = checked(await client.from('tournament_bout_results').select(POLLED_RESULT).eq('tournament_id', id)
      .lte('reveal_at_ms', clock.serverNowMs).gt('ordinal', ordinal).order('ordinal').limit(PAGE)) as unknown as PolledResultRow[];
    for (const r of rows) results.set(r.bout_id, polledResult(r));
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

/**
 * One revealed tournament bout's battle log, on demand (2b review I1): only once its public result is due, under the same
 * RLS due-time filter as the polled read and also filtered by the sampled server time. A malformed bout id never reaches
 * a query. A bout that is not due, not published or a bye (no log) is `not-found`. Results are immutable, so callers
 * cache what this returns.
 */
export async function readTournamentLog(client: SupabaseClient, boutId: string): Promise<BattleLog> {
  if (typeof boutId !== 'string' || !TOURNAMENT_BOUT_ID.test(boutId)) throw new GatewayReadError('not-found');
  const clock = await readRevision(client);
  const row = checked<{ battleLog: BattleLog | null }>(await client.from('tournament_bout_results').select('battleLog:result->battleLog')
    .eq('bout_id', boutId).lte('reveal_at_ms', clock.serverNowMs).maybeSingle());
  if (!row.battleLog || typeof row.battleLog !== 'object') throw new GatewayReadError('not-found');
  return row.battleLog;
}
