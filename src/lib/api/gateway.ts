import type { ActivityId, CommandResult, GameCommand, GladiatorId, LeagueId } from '@contracts/commands';
import type { BattleLog, RevealedTimeline } from '@contracts/events';
import type { MarketPage, OwnerState, PublicProfile, ResultsPage, RevisionState, StandingsPage, TournamentView, WorldSnapshot } from '@contracts/reads';
import { getBrowserClient } from './client';
import {
  GatewayReadError, readOwner, readWorld, readRevision, readTimeline, readProfile, readRecent, readStandings, readTournament, readTournamentLog,
} from './reads';
export { GatewayReadError } from './reads';

/**
 * Public projections (world, revision, timeline, profile, standings, tournament, tournament log, recent results) can be
 * read without a session. `owner()` and `command()` require a signed-in account.
 */
export interface GameGateway {
  /** Session identity changes invalidate pending reads and synchronized caches. */
  subscribeSession?(listener: () => void): () => void;
  command<T>(input: GameCommand): Promise<CommandResult<T>>;
  owner(): Promise<OwnerState>;
  world(): Promise<WorldSnapshot>;
  revision(): Promise<RevisionState>;
  timeline(id: ActivityId): Promise<RevealedTimeline>;
  profile(id: GladiatorId): Promise<PublicProfile>;
  market(cursor?: string): Promise<MarketPage>;
  standings(league: LeagueId, cursor?: string): Promise<StandingsPage>;
  /** A polled read: each fought result carries its fight summary, never its battle log. */
  tournament(id: string): Promise<TournamentView>;
  /**
   * One revealed tournament bout's battle log, loaded on demand when the bout is watched or animated. Results are
   * immutable, so a log is fetched at most once per session; callers share it and must not change it.
   */
  tournamentLog(boutId: string): Promise<BattleLog>;
  recent(cursor?: string): Promise<ResultsPage>;
}

type BrowserClient = NonNullable<ReturnType<typeof getBrowserClient>>;

/**
 * Data API reads. The server enforces ownership and reveal authorization: the public projections are readable without a
 * session (visitors read as `anon`), while the owner's state and every command need a signed-in account.
 */
export function createLiveGateway(): GameGateway {
  const unavailable = async (): Promise<never> => { throw new GatewayReadError('unavailable'); };
  let epoch = 0;
  /** Loaded (or loading) tournament logs, shared by every viewer; a failed load is forgotten so it can be asked again. */
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
      const client = getBrowserClient();
      if (!client) return { ok: false, code: 'unavailable' };
      if (!['create-character', 'edit-schedule', 'queue-build', 'cancel-build', 'buy-shop', 'sell-item', 'discard-item', 'set-tournament-opt-in'].includes(input.kind)) {
        return { ok: false, code: 'unavailable' };
      }
      try {
        const { data, error } = await client.auth.getSession();
        if (error || !data.session || (data.session.expires_at ?? 0) * 1000 <= Date.now()) return { ok: false, code: 'unauthenticated' };
        // fetch keeps the typed business error envelope even on non-2xx HTTP statuses.
        const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/game-command`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${data.session.access_token}` },
          body: JSON.stringify(input),
        });
        const result: unknown = await response.json();
        if (result && typeof result === 'object' && 'ok' in result) {
          if (result.ok === true && response.ok && 'receiptId' in result && typeof result.receiptId === 'string' && 'value' in result) return result as CommandResult<T>;
          if (result.ok === false && 'code' in result && typeof result.code === 'string'
            && ['unauthenticated', 'invalid', 'conflict', 'processing', 'insufficient-funds', 'inventory-full', 'sold', 'expired', 'not-found', 'rate-limited', 'unavailable'].includes(result.code)) return result as CommandResult<T>;
        }
        return { ok: false, code: 'unavailable' };
      } catch { return { ok: false, code: 'unavailable' }; }
    },
    owner: () => read(readOwner),
    world: () => publicRead(readWorld), revision: () => publicRead(readRevision),
    timeline: id => publicRead((client, account) => readTimeline(client, id, { ownerSummary: account !== null })),
    profile: id => publicRead(client => readProfile(client, id)),
    recent: cursor => publicRead(client => readRecent(client, cursor)),
    standings: (league, cursor) => publicRead(client => readStandings(client, league, cursor)),
    tournament: id => publicRead(client => readTournament(client, id)),
    tournamentLog: boutId => {
      // A due log is public and immutable, so a cached one is served without a session check; an account change clears the cache.
      const cached = logs.get(boutId);
      if (cached) return cached;
      const pending = publicRead(client => readTournamentLog(client, boutId));
      logs.set(boutId, pending);
      pending.catch(() => { if (logs.get(boutId) === pending) logs.delete(boutId); });
      return pending;
    },
    market: unavailable,
  };
}
