import type { ActivityId, CommandResult, GameCommand, GladiatorId, LeagueId } from '@contracts/commands';
import type { RevealedTimeline } from '@contracts/events';
import type { MarketPage, OwnerState, PublicProfile, ResultsPage, RevisionState, StandingsPage, TournamentView, WorldSnapshot } from '@contracts/reads';

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
