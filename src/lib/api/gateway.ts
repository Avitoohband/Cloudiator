import type { ActivityId, ApiErrorCode, CommandResult, GameCommand, GladiatorId, LeagueId, PresenceResult } from '@contracts/commands';
import type { BattleLog, RevealedTimeline } from '@contracts/events';
import type { MarketPage, OwnerState, PublicProfile, ResultsPage, RevisionState, SeasonView, StandingRow, StandingsPage, TournamentView, WorldSnapshot } from '@contracts/reads';
import { getBrowserClient } from './client';
import {
  GatewayReadError, readMarket, readOwner, readWorld, readRevision, readTimeline, readProfile, readRecent, readSeasons, readStandingOf, readStandings, readTournament,
  readTournamentLog,
} from './reads';
export { GatewayReadError } from './reads';

/**
 * Public projections (world, revision, timeline, profile, market offers, seasons, standings and one gladiator's standing,
 * tournament, tournament log, recent results) can be read without a session. `owner()`, `command()` and `sendPresence()` require a
 * signed-in account.
 */
export interface GameGateway {
  /** Session identity changes invalidate pending reads and synchronized caches. */
  subscribeSession?(listener: () => void): () => void;
  command<T>(input: GameCommand): Promise<CommandResult<T>>;
  /**
   * The owner's activity signal (Task 23.8's `presence` command; Task 23.9 sends it from `useGameState`), each with a new
   * operation id. It answers `{ ok: true }` with no receipt, or a refusal; it never throws.
   */
  sendPresence(): Promise<PresenceResult>;
  owner(): Promise<OwnerState>;
  world(): Promise<WorldSnapshot>;
  revision(): Promise<RevisionState>;
  timeline(id: ActivityId): Promise<RevealedTimeline>;
  profile(id: GladiatorId): Promise<PublicProfile>;
  /**
   * One page of open fixed-price offers, newest listing first, at most 50 rows; `cursor` is a page's `nextCursor`, and
   * `seller` keeps only that gladiator's offers. A malformed cursor or seller is `unavailable`. Loaded on demand: offers
   * never change the world revision.
   */
  market(cursor?: string, seller?: GladiatorId): Promise<MarketPage>;
  /** The seasons, newest first, at most 50 rows. A season is closed when its `closedAtMs` is set; the first one is the current season. */
  seasons(): Promise<SeasonView[]>;
  /**
   * One page of a league's standings, at most 50 rows. The season is the cursor's (a page's `nextCursor`, `season:rank`), else
   * `seasonId` (a `SeasonView.seasonId`), else the latest season; a closed season reads its frozen archive (`archived: true`). A
   * malformed cursor, or a season id that is malformed or (without a cursor) names no season, is `unavailable`; beside a cursor a
   * well-formed season id that names no season is ignored.
   */
  standings(league: LeagueId, cursor?: string, seasonId?: string): Promise<StandingsPage>;
  /**
   * One gladiator's row of a league in the current season (the season `standings` picks with neither cursor nor season id),
   * with its rank in the whole league; null when it has no rating row there or the latest season is closed. A malformed
   * league or gladiator id is `unavailable`. The owner's "Your standing" reads it, so its season rank shows beyond the loaded pages.
   */
  standingOf(league: LeagueId, gladiatorId: GladiatorId): Promise<StandingRow | null>;
  /** A polled read: each fought result carries its fight summary, never its battle log. */
  tournament(id: string): Promise<TournamentView>;
  /**
   * One revealed tournament bout's battle log, loaded on demand when the bout is watched or animated. Results are
   * immutable, so a log is fetched once while it is among the `TOURNAMENT_LOG_CACHE_LIMIT` most recently used ones
   * (Task 23.4, C7); callers share it and must not change it.
   */
  tournamentLog(boutId: string): Promise<BattleLog>;
  recent(cursor?: string): Promise<ResultsPage>;
}

type BrowserClient = NonNullable<ReturnType<typeof getBrowserClient>>;

const API_ERROR_CODES: readonly string[] = ['unauthenticated', 'invalid', 'conflict', 'processing', 'insufficient-funds', 'inventory-full', 'sold', 'expired',
  'not-found', 'rate-limited', 'unavailable'] satisfies readonly ApiErrorCode[];
/** A typed business refusal from the command endpoint (`retryAfterMs` kept when the server sent one). */
const isRefusal = (result: object): result is { ok: false; code: ApiErrorCode; retryAfterMs?: number } =>
  'ok' in result && result.ok === false && 'code' in result && typeof result.code === 'string' && API_ERROR_CODES.includes(result.code);

/**
 * How many tournament battle logs (9–14 KB each) the live gateway keeps, most recently used first (Task 23.4, C7). It holds
 * the camp's six rings' current and next windows and the panel's watched replay with room to spare, but never a whole
 * slot's logs (a 50-entrant tournament has 49 bouts, in each of four leagues) for the rest of the session.
 */
export const TOURNAMENT_LOG_CACHE_LIMIT = 64;

/**
 * Data API reads. The server enforces ownership and reveal authorization: the public projections are readable without a
 * session (visitors read as `anon`), while the owner's state and every command need a signed-in account.
 */
export function createLiveGateway(): GameGateway {
  let epoch = 0;
  /**
   * Loaded (or loading) tournament logs, shared by every viewer, in least to most recently used order (a Map keeps its
   * insertion order, and a use moves a log to the end): at most `TOURNAMENT_LOG_CACHE_LIMIT`, the least recently used
   * dropped first. A failed load is forgotten so it can be asked again.
   */
  const logs = new Map<string, Promise<BattleLog>>();
  /** An owner read: needs a session, and fails `unauthenticated` if the account changes while it runs. */
  async function read<T>(load: (client: BrowserClient) => Promise<T>): Promise<T> {
    const client = getBrowserClient();
    if (!client) throw new GatewayReadError('unavailable');
    const ticket = epoch;
    try {
      const before = await client.auth.getSession();
      if (before.error || !before.data.session) throw new GatewayReadError('unauthenticated');
      // Check identity even when the query returned not-found: an old account's absence is not creation authority.
      const result = await load(client).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      const after = await client.auth.getSession();
      if (ticket !== epoch || after.error || !after.data.session || before.data.session.user.id !== after.data.session.user.id) throw new GatewayReadError('unauthenticated');
      if (!result.ok) throw result.error;
      return result.value;
    } catch (error) { throw error instanceof GatewayReadError ? error : new GatewayReadError('unavailable'); }
  }
  /**
   * Posts a command to the `game-command` Edge function with the session's token. Refused locally (`sent: false`) without a
   * configured backend, without a live session, or when the request or its JSON answer fails; otherwise the parsed answer
   * and whether its HTTP status was a success (fetch keeps the typed business error envelope on non-2xx statuses).
   */
  async function post(input: GameCommand): Promise<{ sent: false; refusal: { ok: false; code: 'unavailable' | 'unauthenticated' } } | { sent: true; result: unknown; httpOk: boolean }> {
    const client = getBrowserClient();
    if (!client) return { sent: false, refusal: { ok: false, code: 'unavailable' } };
    try {
      const { data, error } = await client.auth.getSession();
      if (error || !data.session || (data.session.expires_at ?? 0) * 1000 <= Date.now()) return { sent: false, refusal: { ok: false, code: 'unauthenticated' } };
      const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/game-command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify(input),
      });
      return { sent: true, result: await response.json() as unknown, httpOk: response.ok };
    } catch { return { sent: false, refusal: { ok: false, code: 'unavailable' } }; }
  }
  /**
   * A public read: a visitor and a signed-in reader see the same projections, so it needs no session. `account` is the
   * reader's id, or null for a visitor; the timeline asks for the owner summary only when there is one. A result read while
   * the account changed belongs to the old identity, so it is dropped and read once more as the new one; a second change
   * fails `unavailable`. A session that cannot be loaded reads as a visitor, which is how its request is then sent.
   */
  async function publicRead<T>(load: (client: BrowserClient, account: string | null) => Promise<T>): Promise<T> {
    const client = getBrowserClient();
    if (!client) throw new GatewayReadError('unavailable');
    const accountOf = async () => (await client.auth.getSession()).data.session?.user.id ?? null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const ticket = epoch, before = await accountOf();
        const result = await load(client, before).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        const after = await accountOf();
        if (ticket !== epoch || before !== after) continue;
        if (!result.ok) throw result.error;
        return result.value;
      }
    } catch (error) { throw error instanceof GatewayReadError ? error : new GatewayReadError('unavailable'); }
    throw new GatewayReadError('unavailable');
  }
  return {
    subscribeSession(listener) {
      const client = getBrowserClient();
      if (!client) return () => {};
      let account: string | null | undefined;
      const { data } = client.auth.onAuthStateChange((event, session) => {
        const next = session?.user.id ?? null;
        if (event === 'INITIAL_SESSION') { account = next; return; }
        if (next === account) return;
        account = next; epoch++; logs.clear(); listener();
      });
      return () => data.subscription.unsubscribe();
    },
    async command<T>(input: GameCommand): Promise<CommandResult<T>> {
      // A presence has no receipt: it goes through `sendPresence`.
      if (!['create-character', 'edit-schedule', 'queue-build', 'cancel-build', 'buy-shop', 'sell-item', 'discard-item', 'create-listing', 'cancel-listing',
        'buy-listing', 'set-tournament-opt-in'].includes(input.kind)) {
        return { ok: false, code: 'unavailable' };
      }
      const answer = await post(input);
      if (!answer.sent) return answer.refusal;
      const { result, httpOk } = answer;
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true && httpOk && 'receiptId' in result && typeof result.receiptId === 'string' && 'value' in result) return result as CommandResult<T>;
        if (isRefusal(result)) return result;
      }
      return { ok: false, code: 'unavailable' };
    },
    async sendPresence(): Promise<PresenceResult> {
      // A new operation id every time, even after a failure: the server checks it but stores no receipt for a presence.
      const answer = await post({ kind: 'presence', operationId: crypto.randomUUID() });
      if (!answer.sent) return answer.refusal;
      const { result, httpOk } = answer;
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true && httpOk) return { ok: true };
        if (isRefusal(result)) return result;
      }
      return { ok: false, code: 'unavailable' };
    },
    owner: () => read(readOwner),
    world: () => publicRead(readWorld), revision: () => publicRead(readRevision),
    timeline: id => publicRead((client, account) => readTimeline(client, id, { ownerSummary: account !== null })),
    profile: id => publicRead(client => readProfile(client, id)),
    recent: cursor => publicRead(client => readRecent(client, cursor)),
    seasons: () => publicRead(readSeasons),
    standings: (league, cursor, seasonId) => publicRead(client => readStandings(client, league, cursor, seasonId)),
    standingOf: (league, gladiatorId) => publicRead(client => readStandingOf(client, league, gladiatorId)),
    tournament: id => publicRead(client => readTournament(client, id)),
    tournamentLog: boutId => {
      // A due log is public and immutable, so a cached one is served without a session check; an account change clears the cache.
      const cached = logs.get(boutId);
      if (cached) {
        logs.delete(boutId);
        logs.set(boutId, cached);
        return cached;
      }
      const pending = publicRead(client => readTournamentLog(client, boutId));
      logs.set(boutId, pending);
      // Dropping a log still loading only means its next caller reads it again; this one still gets it.
      for (const oldest of logs.keys()) {
        if (logs.size <= TOURNAMENT_LOG_CACHE_LIMIT) break;
        logs.delete(oldest);
      }
      pending.catch(() => { if (logs.get(boutId) === pending) logs.delete(boutId); });
      return pending;
    },
    market: (cursor, seller) => publicRead(client => readMarket(client, cursor, seller)),
  };
}
