import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityId, GladiatorId, LeagueId } from '@contracts/commands';
import type { ActivitySummary, BattleLog, CreditedRewards, PublicActivitySummary, RevealedTimeline } from '@contracts/events';
import type {
  GameMessage, GameNotification, MarketListing, MarketPage, MessageBlock, OwnerState, PrestigeAward, PublicActor, PublicProfile, ResultsPage, RevisionState, SeasonView, StandingRow, StandingsPage,
  TournamentBout, TournamentEntrant, TournamentPlacement, TournamentView, WorldSnapshot,
} from '@contracts/reads';
import { validAppearance, type Appearance } from '@domain/appearance';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { applyXp } from '@domain/inventory';
import { RULES_V1 } from '@domain/rules-v1';
import { TOURNAMENT_BOUT_ID, TOURNAMENT_ID, tournamentRound } from '../tournament-id';
import { replayKept, tournamentEndsAtMs, tournamentReplayKept } from '../replay-retention';

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
  const row = checked<{revision:string;server_now_ms:number;slot_index:number;published_slot_index:number|null}>(
    await client.from('world_revision').select('revision,server_now_ms,slot_index,published_slot_index').single());
  return { revision: row.revision, serverNowMs: Number(row.server_now_ms), slotIndex: Number(row.slot_index),
    publishedSlotIndex: row.published_slot_index === null || row.published_slot_index === undefined ? null : Number(row.published_slot_index) };
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
const LEAGUES: readonly string[] = ['bronze', 'silver', 'gold', 'champion'];
const BADGES: readonly string[] = ['gold', 'silver', 'bronze'];
/** One award from the profile projection (`seasonIndex` a number) as a PrestigeAward (`seasonId` text); anything else is `unavailable`. */
function prestigeAward(entry: unknown): PrestigeAward {
  const award = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
  const { seasonIndex, league, place, badge, title } = award;
  if (typeof seasonIndex !== 'number' || !Number.isSafeInteger(seasonIndex) || seasonIndex < 0 || typeof league !== 'string' || !LEAGUES.includes(league)
    || (place !== 1 && place !== 2 && place !== 3) || typeof badge !== 'string' || !BADGES.includes(badge) || (title !== null && title !== 'champion')) {
    throw new GatewayReadError('unavailable');
  }
  return { seasonId: String(seasonIndex), league: league as LeagueId, place, badge: badge as PrestigeAward['badge'], title };
}
/** A public profile; its prestige is the character's season awards, oldest season first (Task 21), mapped to `PrestigeAward`s. */
export async function readProfile(client: SupabaseClient, id: GladiatorId): Promise<PublicProfile> {
  const { prestige, ...profile } = checked<{ profile: Omit<PublicProfile, 'prestige'> & { prestige: unknown } }>(
    await client.from('public_profile_reads').select('profile').eq('gladiator_id', id).maybeSingle()).profile;
  if (!Array.isArray(prestige)) throw new GatewayReadError('unavailable');
  return { ...profile, prestige: prestige.map(prestigeAward) };
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
/** The most gladiator ids one look read asks for (a battle has two participants; a tournament view may pass a few). */
export const MAX_LOOK_READ = 16;
/**
 * The looks (the look chosen at creation, null for the legacy look) of up to `MAX_LOOK_READ` gladiators, in one public read
 * of the actor projection (`world_actor_reads`, readable as `anon`); only the id and the `appearance` cross, never the whole
 * actor. Ids are lowercased, deduped and checked before any query is built (the column is a uuid: a text value would fail the
 * whole read), and a gladiator the projection does not know is absent from the map. A stored value that is not a valid look
 * reads as the legacy look. The replay waits for this read (`loadLooks`) and treats a failure as the legacy look.
 */
export async function readLooks(client: SupabaseClient, ids: readonly string[]): Promise<Map<string, Appearance | null>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && GLADIATOR_ID.test(id)).map(id => id.toLowerCase()))].slice(0, MAX_LOOK_READ);
  const looks = new Map<string, Appearance | null>();
  if (wanted.length === 0) return looks;
  const rows = checked(await client.from('world_actor_reads').select('gladiator_id,appearance:actor->appearance').in('gladiator_id', wanted)
    .limit(wanted.length)) as unknown as { gladiator_id: string; appearance: unknown }[];
  for (const row of rows) looks.set(row.gladiator_id, validAppearance(row.appearance) ? row.appearance : null);
  return looks;
}
/**
 * The options of the next-slot Rest read, checked before any query is built (the fixture gateway applies the same rule): a
 * gladiator id, which is returned lowercased, and a trip end that is a whole, non-negative time in milliseconds, so the next
 * slot's window `[tripEndMs + slot, tripEndMs + 2 slots)` stays a safe integer; anything else is `unavailable`.
 */
export function parseRestAfter(gladiatorId: GladiatorId, tripEndMs: number): { gladiatorId: GladiatorId; fromMs: number; toMs: number } {
  const slotMs = RULES_V1.clock.slotMs;
  if (typeof gladiatorId !== 'string' || !GLADIATOR_ID.test(gladiatorId) || typeof tripEndMs !== 'number' || !Number.isSafeInteger(tripEndMs) || tripEndMs < 0
    || !Number.isSafeInteger(tripEndMs + 2 * slotMs)) throw new GatewayReadError('unavailable');
  return { gladiatorId: gladiatorId.toLowerCase() as GladiatorId, fromMs: tripEndMs + slotMs, toMs: tripEndMs + 2 * slotMs };
}
/**
 * Whether the gladiator's next slot after a trip that ended at `tripEndMs` was a Rest: a public `recent_results` row (visitors
 * read it as `anon`) revealed in that slot, `[tripEndMs + slot, tripEndMs + 2 slots)`, whose summary's `resolvedKind` is `rest`.
 * The whole-trip replay ends with "Resting" only then. At most four rows are asked for and only their summaries cross; a row
 * this client cannot read is not a Rest. A malformed gladiator id or trip end is `unavailable` before any request.
 */
export async function readRestAfter(client: SupabaseClient, gladiatorId: GladiatorId, tripEndMs: number): Promise<boolean> {
  const next = parseRestAfter(gladiatorId, tripEndMs);
  const rows = checked(await client.from('recent_results').select('summary').eq('gladiator_id', next.gladiatorId)
    .gte('reveal_at_ms', next.fromMs).lt('reveal_at_ms', next.toMs).limit(4)) as unknown as { summary: unknown }[];
  return rows.some(row => typeof row.summary === 'object' && row.summary !== null && (row.summary as { resolvedKind?: unknown }).resolvedKind === 'rest');
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
const MESSAGES_PAGE = 50;
type MessageRow = { id: number | string; kind: string; title: unknown; preview: unknown; body: unknown; action: string | null; published_at_ms: number | string };
/**
 * A message body as blocks: a non-empty list of objects with exactly one key, `p` or `li`, holding text. Anything else (which the
 * database never stores today) is null: a message the client cannot show faithfully is left out, never rendered. The text stays
 * exactly as stored; it is shown as plain text, never as markup.
 */
function messageBlocks(body: unknown): MessageBlock[] | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const blocks: MessageBlock[] = [];
  for (const block of body as unknown[]) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return null;
    const keys = Object.keys(block);
    const text = (block as Record<string, unknown>)[keys[0]];
    if (keys.length !== 1 || typeof text !== 'string') return null;
    if (keys[0] === 'p') blocks.push({ p: text });
    else if (keys[0] === 'li') blocks.push({ li: text });
    else return null;
  }
  return blocks;
}
/**
 * The newest 50 game messages from the public `game_messages` table (visitors read it as `anon`; its row security shows only the
 * visible ones), newest posting time first and then the larger id. A row of a kind or action this client does not know, or with a
 * body it cannot show, is left out rather than failing the list, so an older client keeps working when a newer kind is posted.
 * Unread counts come from the owner read's `inbox`, never from this list.
 */
export async function readMessages(client: SupabaseClient): Promise<GameMessage[]> {
  const rows = checked(await client.from('game_messages').select('id,kind,title,preview,body,action,published_at_ms')
    .order('published_at_ms', { ascending: false }).order('id', { ascending: false }).limit(MESSAGES_PAGE)) as unknown as MessageRow[];
  const messages: GameMessage[] = [];
  for (const row of rows.slice(0, MESSAGES_PAGE)) {
    const body = messageBlocks(row.body), id = Number(row.id), publishedAtMs = Number(row.published_at_ms);
    if ((row.kind !== 'patch-notes' && row.kind !== 'admin') || (row.action !== null && row.action !== 'change-look') || typeof row.title !== 'string'
      || typeof row.preview !== 'string' || body === null || !Number.isSafeInteger(id) || !Number.isSafeInteger(publishedAtMs)) continue;
    messages.push({ id, kind: row.kind, title: row.title, preview: row.preview, body, action: row.action, publishedAtMs });
  }
  return messages;
}
const NOTIFICATIONS_PAGE = 20;
/** What the notifications read brings: the results to show, and the newest settled time of every row it fetched (see `readNotifications`). */
export type NotificationsRead = { items: GameNotification[]; newestSettledMs: number | null };
type NotificationRow = { id: unknown; settled_at_ms: unknown; summary: unknown; destination: unknown; gladiators?: unknown };
const NOTIFICATION_KINDS: readonly string[] = ['training', 'expedition', 'arena', 'tournament'];
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/**
 * The owner's own credited summary as the notification text needs it, or null for one it cannot show faithfully: a kind that earns
 * nothing (or an unknown one), a result word it does not know, rewards that are not whole numbers and a list of items, or a rating
 * change that is not a whole number. The object itself is kept as stored.
 */
function notifiableSummary(value: unknown): ActivitySummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const summary = value as Partial<ActivitySummary>, rewards = summary.rewards as Partial<CreditedRewards> | null | undefined;
  if (typeof summary.resolvedKind !== 'string' || !NOTIFICATION_KINDS.includes(summary.resolvedKind) || !['completed', 'victory', 'defeat'].includes(summary.result as string)
    || typeof rewards !== 'object' || rewards === null || !whole(rewards.money) || !whole(rewards.renown) || !whole(rewards.xp) || !whole(rewards.attributePoints)
    || !whole(rewards.overflowMoney) || !Array.isArray(rewards.items) || (summary.ratingDelta !== undefined && !Number.isSafeInteger(summary.ratingDelta))) return null;
  const itemsFit = rewards.items.every(item => typeof item === 'object' && item !== null && typeof item.catalogId === 'string' && typeof item.rarity === 'string'
    && Number.isSafeInteger(item.tier) && whole(item.quantity));
  return itemsFit ? summary as ActivitySummary : null;
}
/**
 * The XP a gladiator has earned in all at `level` with `xp` into it. `applyXp` spends 100 × the current level per level-up, so the
 * levels below `level` cost 100 × (1 + 2 + … + (level − 1)); null where that is not a safe integer.
 */
function xpEarned(level: number, xp: number): number | null {
  const earned = xp + RULES_V1.progression.xpPerCurrentLevel * (level * (level - 1) / 2);
  return Number.isSafeInteger(earned) ? earned : null;
}
/**
 * The level each of a gladiator's results reached, newest result first (`awards` are their credited XP, null where unknown), from
 * its level and XP now: XP only ever changes by a result's award, so the total before a result is the total after it less its award,
 * and the level is what that total makes of `applyXp`'s rule. A result gets the level it reached only when it raised the level; it
 * gets null when its award is unknown or when the numbers cannot be true (more XP in the results than the gladiator has earned, or no
 * usable level now), and every older result then gets null too. Nothing is guessed. `now` is null when the gladiator's numbers are not
 * a trustworthy snapshot of the results listed (see readNotifications).
 */
function levelsReached(awards: readonly (number | null)[], now: { level: number; xp: number } | null): (number | null)[] {
  let after = now && Number.isSafeInteger(now.level) && now.level >= 1 && whole(now.xp) ? xpEarned(now.level, now.xp) : null;
  return awards.map(award => {
    if (after === null || award === null || award > after) { after = null; return null; }
    const before = after - award;
    const reached = award > 0 ? applyXp(1, 0, after).level : null;
    const raised = reached !== null && reached > applyXp(1, 0, before).level;
    after = before;
    return raised ? reached : null;
  });
}
/**
 * The owner's newest 20 settled results as notifications, newest first: completed activities (never a rest) with a summary that
 * settled at or before the server's now (the timeline's own reveal rule, so an Arena or tournament result is not listed before it
 * is due), from the owner-only `activities` table (row security shows a signed-in reader its own; a visitor has no access). One
 * request also names the gladiator's level and XP now, so the level each result reached (`levelAfter`) comes from one snapshot, and
 * the expedition id the destination is named from (`destination`). The gladiator's numbers include the XP of every result settled, so
 * they are used only when no result settled after the server's now: the same request counts those (`gladiators.newer`, with the same
 * bound), because one committed between the clock read and this read is not in the list but its XP is in the level. A count that is not
 * zero (or not there) leaves every `levelAfter` null. Only those columns cross: never a seed, snapshot or receipt. A row this client
 * cannot show (an unknown kind, a summary it cannot read) is left out rather than failing the list, and the levels of the older
 * results are then unknown (null), never guessed. `newestSettledMs` is the newest settled time of EVERY row fetched, left-out rows
 * included: the badge counts every result of the four kinds, so the "seen" mark must reach the newest fetched row, not the newest one
 * shown (null when no row was fetched).
 */
export async function readNotifications(client: SupabaseClient): Promise<NotificationsRead> {
  const clock = await readRevision(client);
  const rows = checked(await client.from('activities').select('id,slot_index,settled_at_ms,summary,destination:requested->>expeditionId,gladiators(level,xp,newer:activities(count))')
    .eq('status', 'completed').in('resolved_kind', NOTIFICATION_KINDS).not('summary', 'is', null).lte('settled_at_ms', clock.serverNowMs)
    .eq('gladiators.newer.status', 'completed').gt('gladiators.newer.settled_at_ms', clock.serverNowMs)
    .order('settled_at_ms', { ascending: false }).order('slot_index', { ascending: false }).limit(NOTIFICATIONS_PAGE)) as unknown as NotificationRow[];
  const page = rows.slice(0, NOTIFICATIONS_PAGE);
  const fetchedAt = page.map(row => Number(row.settled_at_ms)).filter(Number.isSafeInteger);
  const newestSettledMs = fetchedAt.length ? Math.max(...fetchedAt) : null;
  const shown = page.map(row => {
    const summary = notifiableSummary(row.summary), settledAtMs = Number(row.settled_at_ms);
    return typeof row.id === 'string' && summary !== null && Number.isSafeInteger(settledAtMs) ? { id: row.id, summary, settledAtMs, destination: row.destination } : null;
  });
  const gladiator = page.map(row => row.gladiators).find(value => value !== null && value !== undefined) as { level?: unknown; xp?: unknown; newer?: unknown } | undefined;
  const later = gladiator?.newer, noneLater = Array.isArray(later) && later.length === 1 && (later[0] as { count?: unknown } | null)?.count === 0;
  const now = typeof gladiator === 'object' && gladiator !== null && noneLater ? { level: Number(gladiator.level), xp: Number(gladiator.xp) } : null;
  const levels = levelsReached(shown.map(row => (row ? row.summary.rewards.xp : null)), now);
  const list: GameNotification[] = [];
  shown.forEach((row, i) => {
    if (!row) return;
    const kind = row.summary.resolvedKind as GameNotification['kind'];
    const destination = kind === 'expedition' && typeof row.destination === 'string' && Object.hasOwn(CATALOG_V1.expeditions, row.destination)
      ? CATALOG_V1.expeditions[row.destination as keyof typeof CATALOG_V1.expeditions].name : null;
    list.push({ activityId: row.id, kind, settledAtMs: row.settledAtMs, summary: row.summary, destination, levelAfter: levels[i] });
  });
  return { items: list, newestSettledMs };
}
// ------------------------------------------------------------------ My bouts

export type BoutFilter = 'all' | 'won' | 'lost';
/** How many bouts one page of My bouts holds. */
export const BOUTS_PAGE = 20;
/** One of the owner's own settled Arena or tournament bouts, as the My bouts list shows it. */
export type MyBout = {
  activityId: string; kind: 'arena' | 'tournament'; slotIndex: number;
  /** When it was fought: an Arena slot's start + RULES_V1.arena.revealAfterMs, a tournament's slot start. */
  foughtAtMs: number; settledAtMs: number;
  result: 'victory' | 'defeat' | 'completed'; renown: number;
  /** The owner's rating change; null when the summary has none (an NPC bout). */
  ratingDelta: number | null;
  replayExpiry: ActivitySummary['replayExpiry'];
  /** The run's last bout's opponent, read only while the replay is kept at the read's server time. */
  opponent: { name: string; npc: boolean } | null;
  tieBreak: boolean;
  /** A tournament's last bout's round ("Final", "Semifinal", "Quarterfinal", "Round 1"), else null. */
  round: string | null;
};
export type BoutsPage = { rows: MyBout[]; nextCursor: string | null };
/** The last bout of a run, as far as My bouts needs it: the server's stage label, the log's tie-break reason and its two participants. */
export type LastBout = { label: string; tieBreakReason: string | null; participants: { id: string; gladiatorId: string | null; name: string }[] };

/** A whole, non-negative number from a bigint column: a JSON number, or the text a driver may send it as (anything else is null). */
const wholeOf = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return whole(number) ? number : null;
};
/** A slot index as the cursor writes it: canonical decimal digits, no sign, padding or space, and a safe integer. */
const SLOT_INDEX = /^(0|[1-9]\d{0,14})$/;
/**
 * The My bouts cursor, the slot index of the last bout fetched: none when absent or null, `unavailable` for anything else that is
 * not a whole slot index (an empty string included, which no page ever issues), before any query is built from it. The fixture
 * gateway applies the same rule.
 */
export function parseBoutsCursor(cursor?: string | null): number | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || !SLOT_INDEX.test(cursor)) throw new GatewayReadError('unavailable');
  return Number(cursor);
}
/** The My bouts read's options, checked before any query is built: the cursor, and the filter as the result word it asks the server for (null for All). */
export function parseBoutsRead(filter: BoutFilter, cursor?: string | null): { before: number | null; result: 'victory' | 'defeat' | null } {
  const before = parseBoutsCursor(cursor);
  if (filter !== 'all' && filter !== 'won' && filter !== 'lost') throw new GatewayReadError('unavailable');
  return { before, result: filter === 'won' ? 'victory' : filter === 'lost' ? 'defeat' : null };
}
/**
 * The cursor after a page: the slot index of the last row FETCHED when a full page was (rows left out of the list included, so a
 * left-out row never makes the next page repeat), none for a short page. A full page whose last row has no readable slot gives
 * nothing to continue from: `unavailable`, never a list silently cut short.
 */
export function nextBoutsCursor(fetched: number, lastSlotIndex: unknown): string | null {
  if (fetched < BOUTS_PAGE) return null;
  const slot = wholeOf(lastSlotIndex);
  if (slot === null) throw new GatewayReadError('unavailable');
  return String(slot);
}

type BoutInput = { activityId: unknown; gladiatorId: string; slotIndex: unknown; startsAtMs: unknown; kind: unknown; summary: unknown; lastBout: LastBout | null };
/** A bout read and checked, before its opponent: what a row of `activities` says (the replay's state decides whether the names are read). */
type BoutParts = Omit<MyBout, 'opponent' | 'tieBreak' | 'round'> & { gladiatorId: string };
const ACTIVITY_ID = GLADIATOR_ID;
/**
 * A row of the owner's own `activities` as a bout, or null for one it cannot show faithfully: an id that is not a uuid, a slot or
 * start that is not a whole number, a kind that is not Arena or tournament or that its summary disagrees with, a result word, a
 * renown or a settlement time it does not understand, a rating change that is not a whole number, or a replay state it does not know.
 */
function boutParts(input: Omit<BoutInput, 'lastBout'>): BoutParts | null {
  const { activityId, gladiatorId, kind } = input, slotIndex = wholeOf(input.slotIndex), startsAtMs = wholeOf(input.startsAtMs);
  if (typeof activityId !== 'string' || !ACTIVITY_ID.test(activityId) || typeof gladiatorId !== 'string' || (kind !== 'arena' && kind !== 'tournament')
    || slotIndex === null || startsAtMs === null || typeof input.summary !== 'object' || input.summary === null || Array.isArray(input.summary)) return null;
  const summary = input.summary as Partial<ActivitySummary>, rewards = summary.rewards as Partial<CreditedRewards> | null | undefined;
  const expiry = summary.replayExpiry as { state?: unknown; expiresAtMs?: unknown } | null | undefined, delta: unknown = summary.ratingDelta;
  const replayExpiry: MyBout['replayExpiry'] | null = expiry?.state === 'expired' ? { state: 'expired' }
    : expiry?.state === 'available' && whole(expiry.expiresAtMs) ? { state: 'available', expiresAtMs: expiry.expiresAtMs } : null;
  if (summary.resolvedKind !== kind || (summary.result !== 'victory' && summary.result !== 'defeat' && summary.result !== 'completed') || typeof rewards !== 'object' || rewards === null
    || !whole(rewards.renown) || !whole(summary.settledAtMs) || (delta !== undefined && delta !== null && !Number.isSafeInteger(delta)) || replayExpiry === null) return null;
  return { activityId, gladiatorId, kind, slotIndex, foughtAtMs: kind === 'arena' ? startsAtMs + RULES_V1.arena.revealAfterMs : startsAtMs, settledAtMs: summary.settledAtMs,
    result: summary.result, renown: rewards.renown, ratingDelta: typeof delta === 'number' ? delta : null, replayExpiry };
}
const TIE_BREAKS: readonly unknown[] = ['simultaneous-defeat', 'equal-health-fraction'];
/**
 * The bout with what its run's last bout says: the opponent (the participant whose gladiator id is not the row's; an NPC fallback
 * has none), whether a seeded tie-break decided it, and a tournament's round. Nothing of it for a replay that is no longer kept
 * (`expired`), and nothing of it unless the row's own gladiator is exactly one of the two participants: a bout that is not the owner's
 * never lends a row its opponent, its tie-break or its round (Arena replays Task 2 review, carried to Task 4).
 */
function withLastBout(parts: BoutParts, lastBout: LastBout | null): MyBout {
  const { gladiatorId, ...bout } = parts;
  const kept = lastBout !== null && bout.replayExpiry.state === 'available' ? lastBout : null;
  const mine = kept?.participants.filter(p => p.gladiatorId === gladiatorId) ?? [], other = kept?.participants.filter(p => p.gladiatorId !== gladiatorId) ?? [];
  const log = kept !== null && kept.participants.length === 2 && mine.length === 1 && other.length === 1 ? kept : null;
  return { ...bout, tieBreak: log !== null && TIE_BREAKS.includes(log.tieBreakReason), round: log !== null && bout.kind === 'tournament' ? tournamentRound(log.label) : null,
    opponent: log !== null ? { name: other[0].name, npc: other[0].gladiatorId === null } : null };
}
/**
 * One of the owner's bouts as My bouts shows it, or null for a row it cannot show faithfully. `lastBout` is the run's last bout, read
 * only while the replay is kept; the fixture gateway builds its rows through this too, so the preview and the live read agree.
 */
export function boutOf(input: BoutInput): MyBout | null {
  const parts = boutParts(input);
  return parts && withLastBout(parts, input.lastBout);
}

const NAMES_PAGE = 50;
/** The stage fields the names read takes: its label, the log's tie-break reason and each participant's id, gladiator id and name; never the stage or the log as a whole. */
const NAMES_SELECT = 'activity_id,ordinal,label:stage->>label,tieBreakReason:stage->battleLog->>tieBreakReason,'
  + 'p0id:stage->battleLog->participants->0->>id,p0gladiator:stage->battleLog->participants->0->>gladiatorId,p0name:stage->battleLog->participants->0->>name,'
  + 'p1id:stage->battleLog->participants->1->>id,p1gladiator:stage->battleLog->participants->1->>gladiatorId,p1name:stage->battleLog->participants->1->>name';
type NameRow = Record<string, unknown>;
/** A names row as the last bout it is, or null when a field is missing or not what it should be (a participant needs an id and a name). */
function lastBoutOf(row: NameRow): LastBout | null {
  const participant = (i: 0 | 1) => {
    const id = row[`p${i}id`], gladiatorId = row[`p${i}gladiator`], name = row[`p${i}name`];
    return typeof id === 'string' && typeof name === 'string' && name !== '' && (gladiatorId === null || typeof gladiatorId === 'string') ? { id, gladiatorId, name } : null;
  };
  const first = participant(0), second = participant(1), { label, tieBreakReason } = row;
  return typeof label === 'string' && (tieBreakReason === null || typeof tieBreakReason === 'string') && first && second ? { label, tieBreakReason, participants: [first, second] } : null;
}
/**
 * The last bout of each of `ids` (activity ids) that has one revealed by `nowMs`, from the public `visible_events` view in the
 * pages the Data API allows: bout stages of those activities in activity and ordinal order, each page continuing after the last row
 * of the one before (`or(activity_id.gt.X,and(activity_id.eq.X,ordinal.gt.N))`) until a short page. The bout with the highest
 * ordinal of an activity is its last (a run's bouts are numbered by round). A read that does not move forward is `unavailable`.
 */
async function readLastBouts(client: SupabaseClient, ids: readonly string[], nowMs: number): Promise<Map<string, LastBout>> {
  const wanted = new Set(ids), latest = new Map<string, { ordinal: number; row: NameRow }>();
  let after: { id: string; ordinal: number } | null = null;
  for (;;) {
    let query = client.from('visible_events').select(NAMES_SELECT).in('activity_id', [...wanted]).eq('stage->>kind', 'bout').lte('reveal_at_ms', nowMs)
      .order('activity_id').order('ordinal').limit(NAMES_PAGE);
    if (after) query = query.or(`activity_id.gt.${after.id},and(activity_id.eq.${after.id},ordinal.gt.${after.ordinal})`);
    const page = (checked(await query) as unknown as NameRow[]).slice(0, NAMES_PAGE);
    for (const row of page) {
      const id = row.activity_id, ordinal = wholeOf(row.ordinal);
      if (typeof id === 'string' && ordinal !== null && wanted.has(id) && (latest.get(id)?.ordinal ?? -1) < ordinal) latest.set(id, { ordinal, row });
    }
    if (page.length < NAMES_PAGE) break;
    const tail = page[page.length - 1], id = tail.activity_id, ordinal = wholeOf(tail.ordinal);
    if (typeof id !== 'string' || !ACTIVITY_ID.test(id) || ordinal === null || (after !== null && !(id > after.id || (id === after.id && ordinal > after.ordinal)))) {
      throw new GatewayReadError('unavailable');
    }
    after = { id, ordinal };
  }
  const lastBouts = new Map<string, LastBout>();
  for (const [id, { row }] of latest) {
    const bout = lastBoutOf(row);
    if (bout) lastBouts.set(id, bout);
  }
  return lastBouts;
}
type BoutRow = { id: unknown; gladiator_id: unknown; slot_index: unknown; starts_at_ms: unknown; resolved_kind: unknown; settled_at_ms: unknown; summary: unknown };
/**
 * One page (20) of the owner's own settled Arena and tournament bouts, newest first by slot, from the owner-only `activities`
 * table (row security shows a signed-in reader its own rows; a visitor has no access): completed, with a summary, settled at or
 * before the server's now (the timeline's own reveal rule). Won and Lost are asked of the server (`summary->>result`), and the
 * cursor is the slot index of the last row fetched (`slot_index <`). Only those columns cross: never a seed, snapshot or receipt.
 * A row this client cannot show is left out rather than failing the list (the cursor still comes from it).
 *
 * The opponents come from ONE more read of the public `visible_events` view, only for the rows whose replay is kept at the server's
 * now (an expired one never names an opponent): see `readLastBouts`. Either request failing fails the page, so a list is never half
 * named. A malformed cursor or filter is refused before any request.
 */
export async function readBouts(client: SupabaseClient, filter: BoutFilter, cursor?: string): Promise<BoutsPage> {
  const options = parseBoutsRead(filter, cursor);
  const clock = await readRevision(client);
  let query = client.from('activities').select('id,gladiator_id,slot_index,starts_at_ms,resolved_kind,settled_at_ms,summary')
    .eq('status', 'completed').in('resolved_kind', ['arena', 'tournament']).not('summary', 'is', null).lte('settled_at_ms', clock.serverNowMs);
  if (options.result) query = query.eq('summary->>result', options.result);
  if (options.before !== null) query = query.lt('slot_index', options.before);
  const fetched = (checked(await query.order('slot_index', { ascending: false }).limit(BOUTS_PAGE)) as unknown as BoutRow[]).slice(0, BOUTS_PAGE);
  const parts = fetched.map(row => (typeof row.gladiator_id === 'string'
    ? boutParts({ activityId: row.id, gladiatorId: row.gladiator_id, slotIndex: row.slot_index, startsAtMs: row.starts_at_ms, kind: row.resolved_kind, summary: row.summary }) : null));
  const kept = [...new Set(parts.flatMap(part => (part && replayKept(part.replayExpiry, clock.serverNowMs) ? [part.activityId] : [])))];
  const lastBouts = kept.length > 0 ? await readLastBouts(client, kept, clock.serverNowMs) : new Map<string, LastBout>();
  return { rows: parts.flatMap(part => (part ? [withLastBout(part, lastBouts.get(part.activityId) ?? null)] : [])),
    nextCursor: nextBoutsCursor(fetched.length, fetched.at(-1)?.slot_index) };
}

const STANDINGS_PAGE = 50;
const SEASONS_PAGE = 50;
/** A season id is a canonical non-negative integer string (at most 15 digits, so a safe integer): no sign, padding, space or syntax. */
const SEASON_ID = /^(0|[1-9]\d{0,14})$/;
const STANDINGS_CURSOR = /^(\d{1,15}):(\d{1,15})$/;
/**
 * The standings read's options, checked before any query is built, so the fixture gateway applies the same rules: a league's
 * page is picked by the cursor `season:rank` first, then by `seasonId`. A cursor, when given (even empty), must be well formed.
 * A `seasonId`, when given, must be a canonical non-negative integer string, and is checked even beside a cursor; anything
 * else is `unavailable`. Whether a season exists is not checked here.
 */
export function parseStandingsRead(cursor?: string, seasonId?: string): { cursor: { season: number; after: number } | null; seasonId: number | null } {
  if (seasonId !== undefined && (typeof seasonId !== 'string' || !SEASON_ID.test(seasonId))) throw new GatewayReadError('unavailable');
  const named = seasonId === undefined ? null : Number(seasonId);
  if (cursor === undefined) return { cursor: null, seasonId: named };
  const match = typeof cursor === 'string' ? STANDINGS_CURSOR.exec(cursor) : null;
  if (!match) throw new GatewayReadError('unavailable');
  return { cursor: { season: Number(match[1]), after: Number(match[2]) }, seasonId: named };
}
type SeasonRead = { season_index: number; starts_at_ms: number; ends_at_ms: number; closed_at_ms: number | null };
/**
 * The seasons from the public `seasons` table, newest first, at most 50 rows (the Data API caps a response there too). A
 * visitor reads it as `anon`. `closedAtMs` is null for the open season; an empty list means no season has started yet.
 */
export async function readSeasons(client: SupabaseClient): Promise<SeasonView[]> {
  const rows = checked(await client.from('seasons').select('season_index,starts_at_ms,ends_at_ms,closed_at_ms')
    .order('season_index', { ascending: false }).limit(SEASONS_PAGE)) as SeasonRead[];
  return rows.slice(0, SEASONS_PAGE).map(row => ({ seasonId: String(row.season_index), startsAtMs: Number(row.starts_at_ms), endsAtMs: Number(row.ends_at_ms),
    closedAtMs: row.closed_at_ms === null || row.closed_at_ms === undefined ? null : Number(row.closed_at_ms) }));
}
/** A season's index and whether it is closed, from its `seasons` row (the latest season's when `season` is null); null when there is no row. */
async function seasonState(client: SupabaseClient, season: number | null): Promise<{ season: number; closed: boolean } | null> {
  const query = client.from('seasons').select('season_index,closed_at_ms');
  const rows = checked(await (season === null ? query.order('season_index', { ascending: false }) : query.eq('season_index', season)).limit(1)) as
    Pick<SeasonRead, 'season_index' | 'closed_at_ms'>[];
  return rows.length ? { season: Number(rows[0].season_index), closed: rows[0].closed_at_ms !== null && rows[0].closed_at_ms !== undefined } : null;
}
/**
 * The latest season: the newest `public.seasons` row; with no such row yet, the latest season of Task 16's projection table
 * (which is open), or null when there is none.
 */
async function latestSeason(client: SupabaseClient): Promise<{ season: number; closed: boolean } | null> {
  const latest = await seasonState(client, null);
  if (latest) return latest;
  // max(season_index) from the projection table, whose index leads with season_index; the ranked view would evaluate its
  // window function and promotion check over every row first.
  const probe = checked(await client.from('arena_standings').select('season_index').order('season_index', { ascending: false }).limit(1));
  return probe.length ? { season: Number(probe[0].season_index), closed: false } : null;
}
/** The live view's columns, and the archive's: the same plus the flags and award place frozen at the close. */
const LIVE_COLUMNS = 'gladiator_id,name,rating,human_wins,human_losses,rank,promoted,reward_eligible';
const ARCHIVE_COLUMNS = 'gladiator_id,name,rating,human_wins,human_losses,rank,promoted,inactive,reward_eligible,award_place';
type StandingRead = { gladiator_id: string; name: string; rating: number; human_wins: number; human_losses: number; rank: number; promoted: boolean;
  reward_eligible: boolean; inactive?: boolean; award_place?: number | null };
/** One row of the live view (`closed` false) or of the archive: an open season has no award place and counts inactive from its bouts. */
function standingRow(row: StandingRead, closed: boolean): StandingRow {
  const humanWins = Number(row.human_wins), humanLosses = Number(row.human_losses);
  const place = Number(row.award_place);
  return { rank: Number(row.rank), gladiatorId: row.gladiator_id, name: row.name, rating: Number(row.rating), humanWins, humanLosses,
    promoted: row.promoted === true, inactive: closed ? row.inactive === true : humanWins + humanLosses === 0, rewardEligible: row.reward_eligible === true,
    awardPlace: closed && (place === 1 || place === 2 || place === 3) ? place : null };
}
/**
 * One league's standings of one season (spec §8.3 order: rating, human wins, fewer human losses, stable id), at most 50 rows
 * per page. The season is picked, in this order, by the cursor `season:rank` (later pages stay in their season and start
 * after the rank), then by `seasonId` (which must name a `public.seasons` row, else `unavailable`), then it is the latest
 * `public.seasons` row; with no such row yet, the latest season of Task 16's projection table, which is open, or none.
 * An open season reads the public invoker view, whose `reward_eligible` is the database's highest-qualifying-league rule;
 * a closed season (its row has `closed_at_ms`) reads the frozen archive `season_standings` with `archived: true`, whose
 * flags and award place are as fixed at the close. A cursor's season is trusted, since only this read issues cursors: with
 * no `seasons` row for it (a world that has none) it reads as open.
 */
export async function readStandings(client: SupabaseClient, league: LeagueId, cursor?: string, seasonId?: string): Promise<StandingsPage> {
  if (!LEAGUES.includes(league)) throw new GatewayReadError('unavailable');
  const read = parseStandingsRead(cursor, seasonId);
  let season: number | null = null, closed = false, after = 0;
  if (read.cursor) {
    ({ season, after } = read.cursor);
    closed = (await seasonState(client, season))?.closed ?? false;
  } else if (read.seasonId !== null) {
    const named = await seasonState(client, read.seasonId);
    if (!named) throw new GatewayReadError('unavailable');
    ({ season, closed } = named);
  } else {
    const latest = await latestSeason(client);
    if (latest) ({ season, closed } = latest);
  }
  if (season === null) return { league, seasonId: '', archived: false, rows: [], nextCursor: null };
  // The Data API caps a response at 50 rows (config max_rows), so a full page is what signals a possible next page.
  const rows = checked(await client.from(closed ? 'season_standings' : 'arena_standing_reads').select(closed ? ARCHIVE_COLUMNS : LIVE_COLUMNS)
    .eq('league', league).eq('season_index', season).gt('rank', after).order('rank').limit(STANDINGS_PAGE)) as unknown as StandingRead[];
  const page = rows.slice(0, STANDINGS_PAGE).map(row => standingRow(row, closed));
  return { league, seasonId: String(season), archived: closed, rows: page,
    nextCursor: page.length === STANDINGS_PAGE ? `${season}:${page.at(-1)!.rank}` : null };
}

/**
 * One gladiator's row of a league in the current season (Task 21.4: the owner's season rank and human bouts in "Your
 * standing", also when it is outside the loaded pages), or null when it has no rating row there. The current season is the
 * one `readStandings` picks without a cursor or season id; when that latest season is already closed there is no current
 * season, so null. The row comes from the public ranked view filtered by league, season and gladiator: the gladiator filter
 * applies after the view's window, so the rank is the row's rank in the whole league. A malformed league or gladiator id
 * is `unavailable` before any query.
 */
export async function readStandingOf(client: SupabaseClient, league: LeagueId, gladiatorId: GladiatorId): Promise<StandingRow | null> {
  const id = parseStandingOf(league, gladiatorId);
  const latest = await latestSeason(client);
  if (!latest || latest.closed) return null;
  const rows = checked(await client.from('arena_standing_reads').select(LIVE_COLUMNS).eq('league', league).eq('season_index', latest.season)
    .eq('gladiator_id', id).limit(1)) as unknown as StandingRead[];
  return rows.length ? standingRow(rows[0], false) : null;
}
/**
 * The one-row standing read's options, checked before any query (the fixture gateway applies the same rule): a known league
 * and a gladiator id, which is returned lowercased; anything else is `unavailable`.
 */
export function parseStandingOf(league: LeagueId, gladiatorId: GladiatorId): GladiatorId {
  if (!LEAGUES.includes(league) || typeof gladiatorId !== 'string' || !GLADIATOR_ID.test(gladiatorId)) throw new GatewayReadError('unavailable');
  return gladiatorId.toLowerCase();
}

const PAGE = 50;
/**
 * The result fields a polled tournament read needs, by PostgREST JSON-path selection on `result`: participants, winner,
 * bye and the fight summary (duration, victory and tie-break reasons). Never the battle log (2b review I1): a late
 * 50-entrant view carried about half a megabyte of logs on every poll. A log loads on demand (`readTournamentLog`). Seven
 * days after the tournament, cleanup replaces the log with `result.fight` (Task 22), which carries the same summary.
 */
const POLLED_RESULT = 'bout_id,ordinal,participants:result->participants,winnerId:result->>winnerId,bye:result->bye,fight:result->fight,'
  + 'durationMs:result->battleLog->durationMs,victoryReason:result->battleLog->>victoryReason,tieBreakReason:result->battleLog->>tieBreakReason';
type PolledResultRow = { bout_id: string; ordinal: number; participants: TournamentEntrant[]; winnerId: GladiatorId; bye: boolean;
  fight?: unknown; durationMs: unknown; victoryReason: unknown; tieBreakReason: unknown };
/**
 * A polled row as the view's revealed result: its fight summary is the compacted `result.fight` when there is one, else
 * read through the log (only its three fields cross either way). The stage core checks it is well formed before showing it.
 */
function polledResult(row: PolledResultRow): NonNullable<TournamentBout['revealedResult']> {
  const result: NonNullable<TournamentBout['revealedResult']> = { participants: row.participants, winnerId: row.winnerId, bye: row.bye };
  const compacted = row.fight !== null && typeof row.fight === 'object' ? row.fight as Record<string, unknown> : null;
  const { durationMs, victoryReason, tieBreakReason } = compacted ?? row;
  if (durationMs != null || victoryReason != null || tieBreakReason != null) {
    result.fight = { durationMs, victoryReason, tieBreakReason: tieBreakReason ?? null } as NonNullable<typeof result.fight>;
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
 * cache what this returns. From seven days after the tournament's end (by the sampled server time) the log is no longer
 * kept: `not-found` without asking for it, whether or not cleanup has compacted it yet (Task 22.5).
 */
export async function readTournamentLog(client: SupabaseClient, boutId: string): Promise<BattleLog> {
  if (typeof boutId !== 'string' || !TOURNAMENT_BOUT_ID.test(boutId)) throw new GatewayReadError('not-found');
  const clock = await readRevision(client);
  if (!tournamentReplayKept(tournamentEndsAtMs(boutId)!, clock.serverNowMs)) throw new GatewayReadError('not-found');
  const row = checked<{ battleLog: BattleLog | null }>(await client.from('tournament_bout_results').select('battleLog:result->battleLog')
    .eq('bout_id', boutId).lte('reveal_at_ms', clock.serverNowMs).maybeSingle());
  if (!row.battleLog || typeof row.battleLog !== 'object') throw new GatewayReadError('not-found');
  return row.battleLog;
}
