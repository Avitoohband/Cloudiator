/**
 * The public projections a visitor may SELECT: eight base tables, the five invoker views over them, tournament_views, the
 * marketplace offers (Task 18.1, M14), the season rows and their frozen standings archive (Task 21.1), and the game messages
 * (M25: public text, visible rows only). Shared by the
 * visitor read tests (Task 13.1) and the release access matrix (Task 23.1), which hand-list no other relation.
 */
export const OPEN = ['world_revision_state', 'world_actors', 'public_profiles', 'recent_results', 'activity_stages', 'arena_standings',
  'tournament_bout_results', 'tournament_placements', 'visible_events', 'world_revision', 'world_actor_reads', 'public_profile_reads',
  'arena_standing_reads', 'tournament_views', 'market_offers', 'seasons', 'season_standings', 'game_messages'];
/** tournament_views is granted column by column: never its pairing job or publication time (Task 19 review M1). */
export const PUBLIC_TOURNAMENT_COLUMNS = 'id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms';
