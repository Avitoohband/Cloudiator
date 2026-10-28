// Test-only Supabase transport for live-mode browser specs (development server only: the static export carries no
// Supabase configuration). `routeLiveReads` answers the Data API the way PostgREST answers the readers in
// src/lib/api/reads.ts, with rows built from the existing fixture DTOs; `seedSession` stores a signed-in session the
// way supabase-js keeps one. A page with no stored session reads as a visitor (`anon`), and the private objects deny it.
// A visitor's Google sign-in goes through the same test-only consent page as identity.spec.ts (Approve or Cancel test
// Google), and its PKCE exchange signs in `LiveTransport.googleUser`.
import { createHash, randomUUID } from 'node:crypto';
import type { BrowserContext, Request, Route } from '@playwright/test';
import type { ActivitySummary, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { GameMessage, MarketListing, OwnerState, PublicProfile, ResultRow, SeasonView, StandingsPage, TournamentView, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1';

export const SUPABASE_URL = 'http://127.0.0.1:54321';
/** The development server's test-only publishable key (playwright.config.ts); a visitor's request carries it as its bearer. */
export const PUBLISHABLE_KEY = 'sb_publishable_browser_test_only';
export const SLOT_MS = 4_800_000;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

export type TestUser = {
  id: string; aud: 'authenticated'; role: 'authenticated'; email: string;
  app_metadata: { provider: 'google'; providers: ['google'] }; user_metadata: Record<string, never>; identities: never[]; created_at: string;
};
const users = new Map<string, TestUser>();

/** A Google-signed-in account for `seedSession`. */
export function testUser(email = 'live@example.invalid'): TestUser {
  return { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email, app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: {}, identities: [], created_at: new Date().toISOString() };
}

/**
 * Stores a signed-in session for `user` (valid for `expiresIn` seconds) in the page's localStorage before every page
 * load, as supabase-js keeps one (`sb-127-auth-token`). Its access token names the user; `routeLiveReads` answers
 * the session's Auth calls and reads as that user.
 */
export async function seedSession(context: BrowserContext, user: TestUser = testUser(), { expiresIn = 3600 } = {}): Promise<TestUser> {
  users.set(user.id, user);
  await context.addInitScript(({ user, expiresIn }) => {
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp }))}.test-only`;
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: `test-only:${user.id}`, token_type: 'bearer', expires_at: exp, expires_in: expiresIn, user }));
  }, { user, expiresIn });
  return user;
}

/** An empty shared world at `serverNowMs`, for specs whose subject is not the camp. */
export function emptyWorld(serverNowMs = Date.now()): WorldSnapshot {
  return { revision: 'empty-1', serverNowMs, slotIndex: Math.floor(serverNowMs / SLOT_MS), actors: [] };
}

/** One settled result of the owner's: its credited summary and, for an expedition, the id of the destination it went to. */
export type LiveNotification = { summary: ActivitySummary; expeditionId?: string };
export type LiveData = {
  /** The public world: its revision, its actors and (by default) the server's time, which then runs in real time. */
  world: WorldSnapshot;
  /** Public profiles by gladiator id. */
  profiles?: Readonly<Record<string, PublicProfile>>;
  /** Standings pages, one league each: an open season's pages are the live view, an `archived` page's season is closed and its rows the frozen archive. */
  standings?: readonly StandingsPage[];
  /** The public seasons, in any order; by default one per standings page's season (closed for an archived page). */
  seasons?: readonly SeasonView[];
  /**
   * Public tournament views; their round results, logs and placements become the polled and on-demand rows. A result with
   * a fight summary and no log is stored as cleanup leaves it (Task 22.5).
   */
  tournaments?: readonly TournamentView[];
  /** Activity timelines by activity id: their stages, public completion and (for a signed-in reader) owner summary. */
  timelines?: Readonly<Record<string, RevealedTimeline>>;
  /** Recent public results, newest first. */
  recent?: readonly ResultRow[];
  /** Open marketplace offers (the public `market_offers` projection), in any order. */
  market?: readonly MarketListing[];
  /** The visible game messages (the public `game_messages` table), in any order; none by default. */
  messages?: readonly GameMessage[];
  /**
   * The owner's settled results the Notifications tab lists (the owner-only `activities` rows `readNotifications` reads), in any order.
   * The level each reached comes from the owner state's level and XP, as the real read derives it, and an expedition's destination
   * from `expeditionId`. Only a signed-in reader sees them; none by default.
   */
  notifications?: readonly LiveNotification[];
  /** The signed-in reader's owner state; null or absent is an account with no gladiator. */
  owner?: OwnerState | null;
  /** The server's current time; by default `world.serverNowMs` running on in real time from the call. */
  serverNowMs?: () => number;
  /**
   * The revision's published slot (Task 23.2, C5): the latest slot whose boundary is published, null before the first
   * coordination. By default the server time's own slot (the slot is published).
   */
  publishedSlotIndex?: (serverNowMs: number) => number | null;
  /** The account a Google sign-in through the test-only consent page signs in (a new `testUser` by default). */
  googleUser?: TestUser;
};

/** One Data API request: its table, reader and query, and `at`, the test runner's Date.now() when the route received it. */
export type LiveRequest = { table: string; reader: string | null; query: URLSearchParams; at: number };
/** One Auth API call of a stored session: its path (`/auth/v1/logout`), query (`scope=local`) and reader. */
export type AuthRequest = { path: string; reader: string | null; query: URLSearchParams };
/** One owner's presence (Task 23.9) the transport answered: its operation id and reader. */
export type PresenceRequest = { operationId: string; reader: string | null };
export type LiveTransport = {
  /** Every Data API request so far, with the reader: a user id, or null for a visitor. */
  readonly requests: readonly LiveRequest[];
  /** Every presence so far (answered `{ ok: true }`, as the Edge function answers a signed-in owner's). */
  readonly presences: readonly PresenceRequest[];
  /** Every Auth API request so far (`/auth/v1/user`, `/auth/v1/logout`, `/auth/v1/token`). */
  readonly authRequests: readonly AuthRequest[];
  count(table: string): number;
  setWorld(world: WorldSnapshot): void;
  setOwner(owner: OwnerState | null): void;
  /** Replaces the current-season standings pages (the server credited results). */
  setStandings(pages: readonly StandingsPage[]): void;
  /** Replaces the public tournament views (a slot's publication adds its views). */
  setTournaments(views: readonly TournamentView[]): void;
  /** Replaces the activity timelines (the server published a stage that was late). */
  setTimelines(timelines: Readonly<Record<string, RevealedTimeline>>): void;
  /** Replaces the open marketplace offers (a listing was created, bought, cancelled or swept). */
  setMarket(offers: readonly MarketListing[]): void;
  /** Replaces the visible game messages (the operator posted or hid one). */
  setMessages(messages: readonly GameMessage[]): void;
  /** Replaces the owner's settled results the Notifications tab lists (a result was credited). */
  setNotifications(notifications: readonly LiveNotification[]): void;
  /** Replaces the revision's published slot (a slot's publication), or restores the default with undefined. */
  setPublishedSlotIndex(published: ((serverNowMs: number) => number | null) | undefined): void;
  /** Answers a table's requests `ms` later (a slow page of a load). */
  delay(table: string, ms: number): void;
  /** Holds a table's requests until the returned release is called (then answers them, and later ones, at once). */
  hold(table: string): () => void;
  /**
   * Answers a table's requests with a server error (500, which supabase-js does not retry): a read the backend cannot
   * serve. `fail(table, false)` serves the table again.
   */
  fail(table: string, failing?: boolean): void;
  /** Answers the next `times` sign-out requests with a server error (503), as a failed `/auth/v1/logout`. */
  failLogout(times?: number): void;
  /** Rejects every signed-in request as PostgREST rejects a token it no longer accepts (a stale stored session). */
  rejectSessions(reject?: boolean): void;
  /**
   * Answers the next `times` refresh-token grants with a new session for the token's user (a refresh is otherwise always
   * refused). With `accepted` (the default) the server takes the new access tokens even while `rejectSessions` holds;
   * without it, they are refused as well.
   */
  renewSessions(options?: { times?: number; accepted?: boolean }): void;
  /**
   * Refuses a table's requests as PostgREST refuses a role without the grant (401, `42501`), visitors' as well:
   * public reads the server no longer allows. `refuse(table, false)` serves the table again.
   */
  refuse(table: string, refusing?: boolean): void;
  serverNowMs(): number;
  /** The account the test-only Google consent page signs in ("Approve test Google"). */
  readonly googleUser: TestUser;
};

type Row = Record<string, unknown>;
type Table = { rows: Row[]; private?: boolean };
const INVALID_READER = 'invalid-token';

/**
 * Routes `${SUPABASE_URL}/**` for `context`: the public projections for visitors and signed-in readers alike, the owner
 * state and owner-only activity summaries for signed-in readers only (a visitor is refused, as `anon` is), and the
 * Auth calls of a stored session or of a test-only Google sign-in, and a signed-in player's presence (Task 23.9: answered
 * `{ ok: true }`, no receipt). Other commands and any other request fail the test. Register a spec's own handler for
 * commands or special reads after this one; it runs first, and `route.fallback()` hands everything else here (a command
 * handler hands a presence back with `isPresence`).
 */
export async function routeLiveReads(context: BrowserContext, initial: LiveData): Promise<LiveTransport> {
  const data: LiveData = { ...initial };
  let world = data.world, owner = data.owner ?? null, rejecting = false;
  const started = Date.now(), base = data.world.serverNowMs;
  const now = data.serverNowMs ?? (() => base + (Date.now() - started));
  const requests: LiveRequest[] = [];
  const authRequests: AuthRequest[] = [];
  const presences: PresenceRequest[] = [];
  let failedLogouts = 0;
  let renewals = 0, renewalsAccepted = true;
  /** Access tokens issued by an accepted renewal: the server takes them even while rejecting stored sessions. */
  const renewed = new Set<string>();
  const refused = new Set<string>();
  const delays = new Map<string, number>();
  const holds = new Map<string, Promise<void>>();
  const failing = new Set<string>();
  const google: GoogleSignIn = { user: data.googleUser ?? testUser('google@example.invalid'), challenges: new Map() };
  users.set(google.user.id, google.user);
  await context.route(`${SUPABASE_URL}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname.startsWith('/auth/v1/')) {
      authRequests.push({ path: url.pathname, reader: readerOf(request), query: url.searchParams });
      if (url.pathname === '/auth/v1/logout' && failedLogouts > 0) {
        failedLogouts -= 1;
        return json(route, { code: 503, error_code: 'unexpected_failure', msg: 'Service unavailable' }, 503);
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token' && renewals > 0) {
        const token = (JSON.parse(request.postData() ?? '{}') as { refresh_token?: string }).refresh_token ?? '';
        const user = users.get(token.startsWith('test-only:') ? token.slice('test-only:'.length) : '');
        if (user) {
          renewals -= 1;
          const session = sessionFor(user);
          if (renewalsAccepted) renewed.add(session.access_token);
          return json(route, session);
        }
      }
      return auth(route, url, readerOf(request), rejecting && !renewed.has(bearerOf(request) ?? ''), google);
    }
    if (url.pathname === '/functions/v1/game-command' && isPresence(request)) {
      const command = request.postDataJSON() as { operationId: string };
      presences.push({ operationId: command.operationId, reader: readerOf(request) });
      return readerOf(request) === null ? json(route, { ok: false, code: 'unauthenticated' }, 401) : json(route, { ok: true });
    }
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table || request.method() !== 'GET') throw new Error(`Unexpected live transport request ${request.method()} ${url.pathname}`);
    const reader = readerOf(request);
    requests.push({ table, reader, query: url.searchParams, at: Date.now() });
    const wait = delays.get(table);
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    await holds.get(table);
    if (!request.headers().apikey) return json(route, { code: 'PGRST301', message: 'No API key found in request' }, 401);
    if (reader !== null && ((rejecting && !renewed.has(bearerOf(request) ?? '')) || reader === INVALID_READER)) return json(route, { code: 'PGRST301', message: 'JWT could not be verified' }, 401);
    if (refused.has(table)) return json(route, { code: '42501', message: `permission denied for table ${table}`, details: null, hint: null }, 401);
    if (failing.has(table)) return json(route, { code: 'XX000', message: 'internal error', details: null, hint: null }, 500);
    const source = tables({ world, owner, now: now(), reader, data })[table];
    if (!source) throw new Error(`Unexpected live transport table ${table}`);
    if (source.private && reader === null) return json(route, { code: '42501', message: `permission denied for table ${table}`, details: null, hint: null }, 401);
    const rows = query(source.rows, url.searchParams);
    if ((request.headers().accept ?? '').includes('application/vnd.pgrst.object+json')) {
      return rows.length === 1 ? json(route, rows[0])
        : json(route, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null }, 406);
    }
    return json(route, rows);
  });
  return {
    requests,
    presences,
    authRequests,
    count: table => requests.filter(r => r.table === table).length,
    setWorld: next => { world = next; },
    setOwner: next => { owner = next; },
    setStandings: pages => { data.standings = pages; },
    setTournaments: views => { data.tournaments = views; },
    setTimelines: timelines => { data.timelines = timelines; },
    setMarket: offers => { data.market = offers; },
    setMessages: messages => { data.messages = messages; },
    setNotifications: notifications => { data.notifications = notifications; },
    setPublishedSlotIndex: published => { data.publishedSlotIndex = published; },
    delay: (table, ms) => { delays.set(table, ms); },
    hold: table => {
      let release!: () => void;
      holds.set(table, new Promise<void>(resolve => { release = resolve; }));
      return () => { holds.delete(table); release(); };
    },
    fail: (table, on = true) => { if (on) failing.add(table); else failing.delete(table); },
    failLogout: (times = 1) => { failedLogouts = times; },
    rejectSessions: (reject = true) => { rejecting = reject; },
    renewSessions: ({ times = 1, accepted = true } = {}) => { renewals = times; renewalsAccepted = accepted; },
    refuse: (table, on = true) => { if (on) refused.add(table); else refused.delete(table); },
    serverNowMs: now,
    googleUser: google.user,
  };
}

/**
 * Whether a request is the owner's presence (Task 23.9), which a signed-in player's page sends on its own: a spec's command
 * handler hands it back to `routeLiveReads` with `route.fallback()`, so its own command list holds only what it is about.
 */
export function isPresence(request: Request): boolean {
  if (request.method() !== 'POST') return false;
  try { return (request.postDataJSON() as { kind?: unknown } | null)?.kind === 'presence'; } catch { return false; }
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });

const bearerOf = (request: Request) => /^Bearer (.+)$/.exec(request.headers().authorization ?? '')?.[1];
/** A user id from the bearer token, or null for a visitor (the publishable key, or no token). */
function readerOf(request: Request): string | null {
  const bearer = bearerOf(request);
  if (!bearer || bearer === PUBLISHABLE_KEY) return null;
  try { return String(JSON.parse(Buffer.from(bearer.split('.')[1], 'base64').toString('utf8')).sub); } catch { return INVALID_READER; }
}

/** The test-only Google sign-in: the account it signs in, and each issued code's PKCE challenge. */
type GoogleSignIn = { user: TestUser; challenges: Map<string, string> };
let codes = 0;

let issued = 0;
/** A session for `user` as the Auth API returns one; its access token names the user (`readerOf`), and each is new. */
function sessionFor(user: TestUser, expiresIn = 3600) {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return { access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, exp, jti: ++issued })}.test-only`, refresh_token: `test-only:${user.id}`, token_type: 'bearer',
    expires_in: expiresIn, expires_at: exp, user };
}

/**
 * A stored session's Auth calls: its user, a local or global sign-out, and a refresh that is refused (unless
 * `renewSessions` answered it before this). A Google
 * sign-in goes through the test-only consent page (as identity.spec.ts), whose links return to the app's callback with
 * a code or a cancellation (with provider text the app must never show); the code's PKCE exchange signs in `google.user`.
 */
function auth(route: Route, url: URL, reader: string | null, rejecting: boolean, google: GoogleSignIn) {
  if (url.pathname === '/auth/v1/user') {
    const user = reader === null ? undefined : users.get(reader);
    return user && !rejecting ? json(route, user) : json(route, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, 401);
  }
  if (url.pathname === '/auth/v1/logout') return rejecting ? json(route, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, 401) : route.fulfill({ status: 204, headers: CORS });
  if (url.pathname === '/auth/v1/authorize') {
    const callback = new URL(url.searchParams.get('redirect_to') ?? '');
    if (url.searchParams.get('provider') !== 'google' || callback.pathname !== '/auth/callback/') throw new Error(`Unexpected sign-in ${url.search}`);
    const code = `test-code-${++codes}`;
    google.challenges.set(code, url.searchParams.get('code_challenge') ?? '');
    return route.fulfill({ contentType: 'text/html', body: `<html><body><h1>Test-only Google consent</h1><a href="${callback.origin}/auth/callback/?code=${code}">Approve test Google</a> <a href="${callback.origin}/auth/callback/?error=access_denied&error_description=Untrusted%20provider%20text">Cancel test Google</a></body></html>` });
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
    const body = JSON.parse(route.request().postData() ?? '{}') as { auth_code?: string; code_verifier?: string };
    const challenge = google.challenges.get(body.auth_code ?? '');
    if (!challenge || createHash('sha256').update(body.code_verifier ?? '').digest('base64url') !== challenge) {
      return json(route, { code: 400, error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' }, 400);
    }
    google.challenges.delete(body.auth_code!);
    return json(route, sessionFor(google.user));
  }
  if (url.pathname === '/auth/v1/token') return json(route, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }, 400);
  throw new Error(`Unexpected live transport Auth request ${url.pathname}`);
}

/** The Data API objects the app reads, as rows, with their reveal-time row filters applied at the server time `now`. */
function tables({ world, owner, now, reader, data }: { world: WorldSnapshot; owner: OwnerState | null; now: number; reader: string | null; data: LiveData }): Record<string, Table> {
  const timelines = Object.values(data.timelines ?? {});
  const actorOf = (activityId: string) => world.actors.find(a => a.activityId === activityId);
  const recent = new Map<string, Row>();
  for (const row of data.recent ?? []) {
    recent.set(row.summary.activityId, { activity_id: row.summary.activityId, gladiator_id: row.gladiatorId, name: row.name, summary: row.summary, reveal_at_ms: row.summary.settledAtMs });
  }
  for (const t of timelines) {
    if (!t.completion || recent.has(t.activityId)) continue;
    const actor = actorOf(t.activityId);
    recent.set(t.activityId, { activity_id: t.activityId, gladiator_id: actor?.gladiatorId ?? null, name: actor?.name ?? null, summary: t.completion, reveal_at_ms: t.completion.settledAtMs });
  }
  const tournamentViews: Row[] = [], boutResults: Row[] = [], placements: Row[] = [];
  for (const view of data.tournaments ?? []) {
    const reveals = revealTimes(view.startsAtMs, view.bracket?.rounds ?? 0);
    tournamentViews.push({ id: view.id, slot_index: view.slotIndex, league: view.league, starts_at_ms: view.startsAtMs, ends_at_ms: view.endsAtMs,
      status: view.status === 'insufficient-entrants' ? 'insufficient-entrants' : 'active', entrants: view.entrants, bracket: view.bracket,
      bouts: view.bouts.map(({ revealedResult: _result, ...bout }) => bout), reveal_at_ms: reveals });
    view.bouts.forEach((bout, ordinal) => {
      const result = bout.revealedResult;
      if (!result) return;
      // The stored result holds the battle log, or, once cleanup has compacted it (Task 22.5), only its fight summary.
      const detail = result.battleLog ? { battleLog: result.battleLog } : result.fight ? { fight: { ...result.fight } } : {};
      boutResults.push({ tournament_id: view.id, bout_id: bout.id, ordinal, reveal_at_ms: reveals[bout.round - 1],
        result: { participants: result.participants, winnerId: result.winnerId, bye: result.bye, ...detail } });
    });
    for (const p of view.placements) {
      placements.push({ tournament_id: view.id, gladiator_id: p.gladiatorId, activity_id: p.completion.activityId, place: p.place });
      const entrant = view.entrants.find(e => e.gladiatorId === p.gladiatorId);
      if (!recent.has(p.completion.activityId)) {
        recent.set(p.completion.activityId, { activity_id: p.completion.activityId, gladiator_id: p.gladiatorId, name: entrant?.name ?? null, summary: p.completion, reveal_at_ms: p.completion.settledAtMs });
      }
    }
  }
  const due = (rows: Row[]) => rows.filter(row => Number(row.reveal_at_ms) <= now);
  const pages = data.standings ?? [];
  const seasons: SeasonView[] = data.seasons ? [...data.seasons] : [...new Map(pages.filter(page => page.seasonId !== '').map(page => [page.seasonId, page.archived] as const))]
    .map(([seasonId, archived]) => ({ seasonId, startsAtMs: 0, endsAtMs: RULES_V1.seasons.durationMs, closedAtMs: archived ? RULES_V1.seasons.durationMs : null }));
  return {
    world_revision: { rows: [{ revision: world.revision, server_now_ms: now, slot_index: Math.floor(now / SLOT_MS),
      published_slot_index: data.publishedSlotIndex ? data.publishedSlotIndex(now) : Math.floor(now / SLOT_MS) }] },
    world_actor_reads: { rows: world.actors.map(actor => ({ gladiator_id: actor.gladiatorId, actor })) },
    // The projection keeps each award with its season index (a number); the read maps it to a PrestigeAward with a string season id.
    public_profile_reads: { rows: Object.entries(data.profiles ?? {}).map(([gladiator_id, profile]) => ({ gladiator_id,
      profile: { ...profile, prestige: (profile.prestige ?? []).map(({ seasonId, ...award }) => ({ seasonIndex: Number(seasonId), ...award })) } })) },
    visible_events: { rows: due(timelines.flatMap(t => t.stages.map((stage, ordinal) => ({ id: stage.id, activity_id: t.activityId, ordinal, reveal_at_ms: stage.revealedAtMs, stage })))) },
    recent_results: { rows: due([...recent.values()]) },
    seasons: { rows: seasons.map(s => ({ season_index: Number(s.seasonId), starts_at_ms: s.startsAtMs, ends_at_ms: s.endsAtMs, closed_at_ms: s.closedAtMs })) },
    arena_standings: { rows: pages.filter(page => !page.archived).flatMap(page => page.rows.map(() => ({ season_index: Number(page.seasonId), league: page.league }))) },
    arena_standing_reads: { rows: pages.filter(page => !page.archived).flatMap(page => page.rows.map(row => ({ league: page.league, season_index: Number(page.seasonId),
      gladiator_id: row.gladiatorId, name: row.name, rating: row.rating, human_wins: row.humanWins, human_losses: row.humanLosses, rank: row.rank, promoted: row.promoted,
      reward_eligible: row.rewardEligible }))) },
    season_standings: { rows: pages.filter(page => page.archived).flatMap(page => page.rows.map(row => ({ league: page.league, season_index: Number(page.seasonId),
      gladiator_id: row.gladiatorId, name: row.name, rating: row.rating, human_wins: row.humanWins, human_losses: row.humanLosses, rank: row.rank, promoted: row.promoted,
      inactive: row.inactive, reward_eligible: row.rewardEligible, award_place: row.awardPlace }))) },
    tournament_views: { rows: tournamentViews },
    tournament_bout_results: { rows: due(boutResults) },
    tournament_placements: { rows: placements },
    // Open offers, readable by visitors too; RLS hides an offer from its expiry time on, swept or not.
    market_offers: { rows: (data.market ?? []).filter(o => o.expiresAtMs > now).map(o => ({ id: o.listingId, seller_gladiator_id: o.seller.gladiatorId,
      seller_name: o.seller.name, item: o.item, price: o.price, listed_at_ms: o.listedAtMs, expires_at_ms: o.expiresAtMs })) },
    // Game messages (M25), readable by visitors too; the table's row security hides a hidden one, so the rows here are the visible ones.
    game_messages: { rows: (data.messages ?? []).map(m => ({ id: m.id, kind: m.kind, title: m.title, preview: m.preview, body: m.body, action: m.action,
      published_at_ms: m.publishedAtMs })) },
    // Owner-only: RLS shows a signed-in reader its own rows; `anon` has no grant at all.
    owner_state: { private: true, rows: reader !== null && owner ? [{ state: owner }] : [] },
    // The timelines' owner summaries, and the owner's settled results as `readNotifications` selects them: the kind, the slot, the
    // expedition asked for, and the gladiator it embeds with its level and XP now and the count of results that settled after the
    // server's now (none here: every result a spec lists has been revealed).
    activities: { private: true, rows: [
      ...timelines.filter(t => t.summary).map(t => ({ id: t.activityId, status: 'completed', settled_at_ms: t.summary!.settledAtMs, summary: t.summary })),
      ...(owner ? (data.notifications ?? []).map(n => ({ id: n.summary.activityId, slot_index: Math.floor(n.summary.settledAtMs / SLOT_MS), status: 'completed',
        resolved_kind: n.summary.resolvedKind, settled_at_ms: n.summary.settledAtMs, summary: n.summary,
        requested: n.expeditionId ? { expeditionId: n.expeditionId } : {},
        gladiators: { level: owner.progression.level, xp: owner.progression.xp, newer: [{ count: 0 }] } })) : []),
    ] },
  };
}

/** Round r of R reveals `ceil(duration × r / (R + 1))` after the start (spec §8.4; written apart from the app's helper). */
function revealTimes(startsAtMs: number, rounds: number): number[] {
  return Array.from({ length: rounds }, (_, i) => startsAtMs + Math.ceil(RULES_V1.tournament.durationMs * (i + 1) / (rounds + 1)));
}

// --- A small PostgREST query evaluator: filters, `or`/`and` groups, order, limit and JSON-path selects. ---

const RESERVED = new Set(['select', 'order', 'limit', 'offset']);
type Test = (row: Row) => boolean;

function query(rows: Row[], params: URLSearchParams): Row[] {
  const tests: Test[] = [];
  for (const [key, value] of params) {
    // A filter on an embedded resource (`gladiators.newer.status`) narrows that resource, not these rows: the rows carry it ready-made.
    if (RESERVED.has(key) || key.includes('.')) continue;
    if (key === 'or' || key === 'and') tests.push(group(key, value));
    else tests.push(condition(key, value));
  }
  let result = rows.filter(row => tests.every(t => t(row)));
  const order = params.get('order');
  if (order) {
    const keys = order.split(',').map(part => { const [column, direction] = part.split('.'); return { column, descending: direction === 'desc' }; });
    result = [...result].sort((a, b) => {
      for (const { column, descending } of keys) {
        const c = compare(a[column], String(b[column]));
        if (c !== 0) return descending ? -c : c;
      }
      return 0;
    });
  }
  const offset = Number(params.get('offset') ?? 0), limit = params.get('limit');
  result = result.slice(offset, limit === null ? undefined : offset + Number(limit));
  return result.map(projection(params.get('select')));
}

/** `(a.lt.1,and(b.eq.2,c.gt.x))` as one test. */
function group(kind: 'or' | 'and', body: string): Test {
  const parts = splitTopLevel(body.replace(/^\(|\)$/g, ''));
  const tests = parts.map(part => {
    const nested = /^(or|and)\((.*)\)$/.exec(part);
    if (nested) return group(nested[1] as 'or' | 'and', `(${nested[2]})`);
    const [column, ...rest] = part.split('.');
    return condition(column, rest.join('.'));
  });
  return kind === 'or' ? row => tests.some(t => t(row)) : row => tests.every(t => t(row));
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, current = '';
  for (const ch of text) {
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function condition(column: string, filter: string): Test {
  const dot = filter.indexOf('.');
  const op = filter.slice(0, dot), value = filter.slice(dot + 1);
  switch (op) {
    case 'eq': return row => compare(row[column], value) === 0;
    case 'neq': return row => compare(row[column], value) !== 0;
    case 'gt': return row => compare(row[column], value) > 0;
    case 'gte': return row => compare(row[column], value) >= 0;
    case 'lt': return row => compare(row[column], value) < 0;
    case 'lte': return row => compare(row[column], value) <= 0;
    case 'in': {
      const values = splitTopLevel(value.replace(/^\(|\)$/g, '')).map(v => v.replace(/^"|"$/g, ''));
      return row => values.some(v => compare(row[column], v) === 0);
    }
    case 'is': return row => (value === 'null' ? row[column] == null : String(row[column]) === value);
    case 'not': { const inner = condition(column, value); return row => !inner(row); }
    default: throw new Error(`Unsupported PostgREST filter ${column}=${filter}`);
  }
}

/** A column against a filter value: numbers numerically, everything else as text. */
function compare(left: unknown, right: string): number {
  if (typeof left === 'number') return left - Number(right);
  const text = left == null ? '' : String(left);
  return text < right ? -1 : text > right ? 1 : 0;
}

/** `select=a,alias:col->key->>text` as PostgREST names and shapes it (a JSON path names its column by its last key). */
function projection(select: string | null): (row: Row) => Row {
  if (!select || select === '*') return row => ({ ...row });
  const fields = splitTopLevel(select).map(item => {
    // An embedded resource (`gladiators(level,xp,newer:activities(count))`) is a field the row already carries under its name.
    const embedded = /^(?:[a-z_]+:)?([a-z_]+)\(/.exec(item);
    if (embedded) return { name: embedded[1], column: embedded[1], path: [] as { key: string; text: boolean }[] };
    const colon = item.indexOf(':');
    const alias = colon < 0 ? null : item.slice(0, colon), expression = colon < 0 ? item : item.slice(colon + 1);
    const [column, ...steps] = expression.split(/(->>?)/).reduce<string[][]>((acc, token) => {
      if (token === '->' || token === '->>') acc.push([token]); else if (acc.length) acc[acc.length - 1].push(token); else acc.push([token]);
      return acc;
    }, []);
    const path = steps.map(([arrow, key]) => ({ key, text: arrow === '->>' }));
    return { name: alias ?? path.at(-1)?.key ?? column[0], column: column[0], path };
  });
  return row => Object.fromEntries(fields.map(({ name, column, path }) => {
    let value: unknown = row[column];
    let text = false;
    for (const step of path) {
      value = value !== null && typeof value === 'object' ? (value as Row)[step.key] : undefined;
      text = step.text;
    }
    if (value === undefined) value = null;
    if (text && value !== null) value = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return [name, value];
  }));
}
