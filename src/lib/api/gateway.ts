import type { ActivityId, CommandResult, GameCommand, GladiatorId, LeagueId } from '@contracts/commands';
import type { BattleLog, RevealedTimeline } from '@contracts/events';
import type { MarketPage, OwnerState, PublicProfile, ResultsPage, RevisionState, StandingsPage, TournamentView, WorldSnapshot } from '@contracts/reads';
import { getBrowserClient } from './client';
import {
  GatewayReadError, readOwner, readWorld, readRevision, readTimeline, readProfile, readRecent, readStandings, readTournament, readTournamentLog,
} from './reads';
export { GatewayReadError } from './reads';

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

/** Authenticated Data API reads; the server enforces ownership and reveal authorization. */
export function createLiveGateway(): GameGateway {
  const unavailable = async (): Promise<never> => { throw new GatewayReadError('unavailable'); };
  let epoch = 0;
  /** Loaded (or loading) tournament logs of this session; a failed load is forgotten so it can be asked again. */
  const logs = new Map<string, Promise<BattleLog>>();
  async function read<T>(load: (client: NonNullable<ReturnType<typeof getBrowserClient>>) => Promise<T>): Promise<T> {
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
    owner: () => read(readOwner), world: () => read(readWorld), revision: () => read(readRevision),
    timeline: id => read(client => readTimeline(client, id)), profile: id => read(client => readProfile(client, id)),
    recent: cursor => read(client => readRecent(client, cursor)),
    standings: (league, cursor) => read(client => readStandings(client, league, cursor)),
    tournament: id => read(client => readTournament(client, id)),
    tournamentLog: boutId => {
      const cached = logs.get(boutId);
      if (cached) return cached;
      const pending = read(client => readTournamentLog(client, boutId));
      logs.set(boutId, pending);
      pending.catch(() => { if (logs.get(boutId) === pending) logs.delete(boutId); });
      return pending;
    },
    market: unavailable,
  };
}
