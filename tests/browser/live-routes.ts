// Test-only Supabase transport for live-mode browser specs (development server only: the static export carries no
// Supabase configuration). `routeLiveReads` answers the Data API the way PostgREST answers the readers in
// src/lib/api/reads.ts, with rows built from the existing fixture DTOs; `seedSession` stores a signed-in session the
// way supabase-js keeps one. A page with no stored session reads as a visitor (`anon`), and the private objects deny it.
import { randomUUID } from 'node:crypto';
import type { BrowserContext, Request, Route } from '@playwright/test';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { OwnerState, PublicProfile, ResultRow, StandingsPage, TournamentView, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
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
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-only', token_type: 'bearer', expires_at: exp, expires_in: expiresIn, user }));
  }, { user, expiresIn });
  return user;
}

/** An empty shared world at `serverNowMs`, for specs whose subject is not the camp. */
export function emptyWorld(serverNowMs = Date.now()): WorldSnapshot {
  return { revision: 'empty-1', serverNowMs, slotIndex: Math.floor(serverNowMs / SLOT_MS), actors: [] };
}

export type LiveData = {
  /** The public world: its revision, its actors and (by default) the server's time, which then runs in real time. */
  world: WorldSnapshot;
  /** Public profiles by gladiator id. */
  profiles?: Readonly<Record<string, PublicProfile>>;
  /** Current-season standings pages, one league each. */
  standings?: readonly StandingsPage[];
  /** Public tournament views; their round results, logs and placements become the polled and on-demand rows. */
  tournaments?: readonly TournamentView[];
  /** Activity timelines by activity id: their stages, public completion and (for a signed-in reader) owner summary. */
  timelines?: Readonly<Record<string, RevealedTimeline>>;
  /** Recent public results, newest first. */
  recent?: readonly ResultRow[];
  /** The signed-in reader's owner state; null or absent is an account with no gladiator. */
  owner?: OwnerState | null;
  /** The server's current time; by default `world.serverNowMs` running on in real time from the call. */
  serverNowMs?: () => number;
};

export type LiveRequest = { table: string; reader: string | null; query: URLSearchParams };
export type LiveTransport = {
  /** Every Data API request so far, with the reader: a user id, or null for a visitor. */
  readonly requests: readonly LiveRequest[];
  count(table: string): number;
  setWorld(world: WorldSnapshot): void;
  setOwner(owner: OwnerState | null): void;
  /** Replaces the current-season standings pages (the server credited results). */
  setStandings(pages: readonly StandingsPage[]): void;
  /** Replaces the public tournament views (a slot's publication adds its views). */
  setTournaments(views: readonly TournamentView[]): void;
  /** Answers a table's requests `ms` later (a slow page of a load). */
  delay(table: string, ms: number): void;
  /** Holds a table's requests until the returned release is called (then answers them, and later ones, at once). */
  hold(table: string): () => void;
  /** Answers a table's requests with a server error (500, which supabase-js does not retry): a read the backend cannot serve. */
  fail(table: string): void;
  /** Rejects every signed-in request as PostgREST rejects a token it no longer accepts (a stale stored session). */
  rejectSessions(reject?: boolean): void;
  serverNowMs(): number;
};

type Row = Record<string, unknown>;
type Table = { rows: Row[]; private?: boolean };
const INVALID_READER = 'invalid-token';

/**
 * Routes `${SUPABASE_URL}/**` for `context`: the public projections for visitors and signed-in readers alike, the owner
 * state and owner-only activity summaries for signed-in readers only (a visitor is refused, as `anon` is), and the
 * Auth calls of a stored session. Commands and any other request fail the test. Register a spec's own handler for
 * commands or special reads after this one; it runs first, and `route.fallback()` hands everything else here.
 */
export async function routeLiveReads(context: BrowserContext, initial: LiveData): Promise<LiveTransport> {
  const data: LiveData = { ...initial };
  let world = data.world, owner = data.owner ?? null, rejecting = false;
  const started = Date.now(), base = data.world.serverNowMs;
  const now = data.serverNowMs ?? (() => base + (Date.now() - started));
  const requests: LiveRequest[] = [];
  const delays = new Map<string, number>();
  const holds = new Map<string, Promise<void>>();
  const failing = new Set<string>();
  await context.route(`${SUPABASE_URL}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname.startsWith('/auth/v1/')) return auth(route, url, readerOf(request), rejecting);
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table || request.method() !== 'GET') throw new Error(`Unexpected live transport request ${request.method()} ${url.pathname}`);
    const reader = readerOf(request);
    requests.push({ table, reader, query: url.searchParams });
    const wait = delays.get(table);
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    await holds.get(table);
    if (!request.headers().apikey) return json(route, { code: 'PGRST301', message: 'No API key found in request' }, 401);
    if (reader !== null && (rejecting || reader === INVALID_READER)) return json(route, { code: 'PGRST301', message: 'JWT could not be verified' }, 401);
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
    count: table => requests.filter(r => r.table === table).length,
    setWorld: next => { world = next; },
    setOwner: next => { owner = next; },
    setStandings: pages => { data.standings = pages; },
    setTournaments: views => { data.tournaments = views; },
    delay: (table, ms) => { delays.set(table, ms); },
    hold: table => {
      let release!: () => void;
      holds.set(table, new Promise<void>(resolve => { release = resolve; }));
      return () => { holds.delete(table); release(); };
    },
    fail: table => { failing.add(table); },
    rejectSessions: (reject = true) => { rejecting = reject; },
    serverNowMs: now,
  };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });

/** A user id from the bearer token, or null for a visitor (the publishable key, or no token). */
function readerOf(request: Request): string | null {
  const bearer = /^Bearer (.+)$/.exec(request.headers().authorization ?? '')?.[1];
  if (!bearer || bearer === PUBLISHABLE_KEY) return null;
  try { return String(JSON.parse(Buffer.from(bearer.split('.')[1], 'base64').toString('utf8')).sub); } catch { return INVALID_READER; }
}

/** A stored session's Auth calls: its user, a local or global sign-out, and a refresh that is always refused. */
function auth(route: Route, url: URL, reader: string | null, rejecting: boolean) {
  if (url.pathname === '/auth/v1/user') {
    const user = reader === null ? undefined : users.get(reader);
    return user && !rejecting ? json(route, user) : json(route, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, 401);
  }
  if (url.pathname === '/auth/v1/logout') return rejecting ? json(route, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, 401) : route.fulfill({ status: 204, headers: CORS });
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
      const battleLog = result.battleLog ?? (result.fight ? { ...result.fight } : undefined);
      boutResults.push({ tournament_id: view.id, bout_id: bout.id, ordinal, reveal_at_ms: reveals[bout.round - 1],
        result: { participants: result.participants, winnerId: result.winnerId, bye: result.bye, ...(battleLog ? { battleLog } : {}) } });
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
  return {
    world_revision: { rows: [{ revision: world.revision, server_now_ms: now, slot_index: Math.floor(now / SLOT_MS) }] },
    world_actor_reads: { rows: world.actors.map(actor => ({ gladiator_id: actor.gladiatorId, actor })) },
    public_profile_reads: { rows: Object.entries(data.profiles ?? {}).map(([gladiator_id, profile]) => ({ gladiator_id, profile })) },
    visible_events: { rows: due(timelines.flatMap(t => t.stages.map((stage, ordinal) => ({ id: stage.id, activity_id: t.activityId, ordinal, reveal_at_ms: stage.revealedAtMs, stage })))) },
    recent_results: { rows: due([...recent.values()]) },
    arena_standings: { rows: (data.standings ?? []).flatMap(page => page.rows.map(() => ({ season_index: Number(page.seasonId), league: page.league }))) },
    arena_standing_reads: { rows: (data.standings ?? []).flatMap(page => page.rows.map(row => ({ league: page.league, season_index: Number(page.seasonId),
      gladiator_id: row.gladiatorId, name: row.name, rating: row.rating, human_wins: row.humanWins, human_losses: row.humanLosses, rank: row.rank, promoted: row.promoted }))) },
    tournament_views: { rows: tournamentViews },
    tournament_bout_results: { rows: due(boutResults) },
    tournament_placements: { rows: placements },
    // Owner-only: RLS shows a signed-in reader its own rows; `anon` has no grant at all.
    owner_state: { private: true, rows: reader !== null && owner ? [{ state: owner }] : [] },
    activities: { private: true, rows: timelines.filter(t => t.summary).map(t => ({ id: t.activityId, status: 'completed', settled_at_ms: t.summary!.settledAtMs, summary: t.summary })) },
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
    if (RESERVED.has(key)) continue;
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
  const fields = select.split(',').map(item => {
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
