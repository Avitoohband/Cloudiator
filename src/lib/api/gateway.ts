import type { ActivityId, CommandResult, GameCommand, GladiatorId, LeagueId } from '@contracts/commands';
import type { RevealedTimeline } from '@contracts/events';
import type { MarketPage, OwnerState, PublicProfile, ResultsPage, RevisionState, StandingsPage, TournamentView, WorldSnapshot } from '@contracts/reads';
import { getBrowserClient } from './client';

export interface GameGateway {
  command<T>(input: GameCommand): Promise<CommandResult<T>>;
  owner(): Promise<OwnerState>;
  world(): Promise<WorldSnapshot>;
  revision(): Promise<RevisionState>;
  timeline(id: ActivityId): Promise<RevealedTimeline>;
  profile(id: GladiatorId): Promise<PublicProfile>;
  market(cursor?: string): Promise<MarketPage>;
  standings(league: LeagueId): Promise<StandingsPage>;
  tournament(id: string): Promise<TournamentView>;
  recent(cursor?: string): Promise<ResultsPage>;
}

export class GatewayReadError extends Error {
  constructor(public readonly code: 'unavailable' | 'not-found' | 'unauthenticated') { super(code); }
}
/** Small Task 5 owner adapter. Public projections/polling remain Task 10. */
export function createLiveGateway(): GameGateway {
  const unavailable = async (): Promise<never> => { throw new GatewayReadError('unavailable'); };
  return {
    async command<T>(input: GameCommand): Promise<CommandResult<T>> {
      const client = getBrowserClient();
      if (!client) return { ok: false, code: 'unavailable' };
      if (!['create-character', 'edit-schedule', 'queue-build', 'cancel-build', 'buy-shop', 'sell-item', 'discard-item'].includes(input.kind)) return { ok: false, code: 'unavailable' };
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
    async owner() {
      const client = getBrowserClient();
      if (!client) throw new GatewayReadError('unavailable');
      try {
        const session = await client.auth.getSession();
        if (session.error || !session.data.session || (session.data.session.expires_at ?? 0) * 1000 <= Date.now()) throw new GatewayReadError('unauthenticated');
        const { data, error } = await client.from('owner_state').select('state').maybeSingle();
        if (error) throw new GatewayReadError(error.code === 'PGRST301' || error.code === '42501' ? 'unauthenticated' : 'unavailable');
        if (data === null) throw new GatewayReadError('not-found');
        if (!data.state || typeof data.state !== 'object') throw new GatewayReadError('unavailable');
        return data.state as OwnerState;
      } catch (error) { throw error instanceof GatewayReadError ? error : new GatewayReadError('unavailable'); }
    },
    world: unavailable, revision: unavailable, timeline: unavailable, profile: unavailable,
    market: unavailable, standings: unavailable, tournament: unavailable, recent: unavailable,
  };
}
