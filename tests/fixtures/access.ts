/**
 * The public projections a visitor may SELECT: eight base tables, the five invoker views over them, tournament_views, the
 * marketplace offers (Task 18.1, M14), the season rows and their frozen standings archive (Task 21.1), and the game messages
 * (M25: public text, visible rows only), and the patch list and its features (M26: public text). Shared by the
 * visitor read tests (Task 13.1) and the release access matrix (Task 23.1), which hand-list no other relation.
 */
export const OPEN = ['world_revision_state', 'world_actors', 'public_profiles', 'recent_results', 'activity_stages', 'arena_standings',
  'tournament_bout_results', 'tournament_placements', 'visible_events', 'world_revision', 'world_actor_reads', 'public_profile_reads',
  'arena_standing_reads', 'tournament_views', 'market_offers', 'seasons', 'season_standings', 'game_messages', 'patches', 'patch_features'];
/** tournament_views is granted column by column: never its pairing job or publication time (Task 19 review M1). */
export const PUBLIC_TOURNAMENT_COLUMNS = 'id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms';
/**
 * Patch 1.7 (M28): the three title tables. Owner-only reads (the owner_read policy through auth.uid(), never OPEN); the backend
 * reads and inserts them (and updates the counters); nobody deletes.
 */
export const TITLE_TABLES = ['gladiator_titles', 'title_counters', 'item_firsts'] as const;
/**
 * M28: the title helpers and the command wear-title (public.wear_title), executable by the backend only (the trigger functions are
 * executable by nobody).
 */
export const TITLE_FUNCTIONS = ['private.title_rules()', 'private.founder_cutoff_ms()', 'private.title_measures(uuid,bigint)',
  'private.add_title_count(uuid,text,bigint)', 'private.set_title_count(uuid,text,bigint)',
  'private.award_titles(uuid,bigint,uuid,text,jsonb)', 'private.refresh_item_counters(uuid)', 'public.wear_title(uuid,uuid,jsonb)'] as const;
/**
 * M28: the trigger functions that count and award titles: no EXECUTE for any API role, service_role included. Six functions serve
 * the seven counting triggers (titles_on_item serves titles_on_item and titles_on_item_move; ruling D1).
 */
export const TITLE_TRIGGER_FUNCTIONS = ['private.titles_on_gladiator()', 'private.titles_on_activity()', 'private.titles_on_ledger()',
  'private.titles_on_item()', 'private.titles_on_season_award()', 'private.titles_on_banner()'] as const;
/**
 * M28: the release back-fill (Task 5) and its record, owner-only like the economy switch: absent from every API role's
 * privileges, service_role included.
 */
export const TITLES_OWNER_ONLY = { relation: 'private.title_backfills', function: 'private.backfill_titles()' } as const;
/** Task 5 (1.6): present in the catalog, absent from every API role's effective privilege snapshot. */
export const ECONOMY_OWNER_ONLY = { relation: 'private.economy_switches', function: 'private.switch_to_economy_v2()' } as const;
