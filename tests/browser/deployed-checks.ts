// The pure pieces of the deployed acceptance checks (Task 24.2, plan Decisions 1, 8 and 9): tests/browser/deployed.spec.ts
// runs them against the public origin with tests/browser/playwright.deployed.config.ts, and tests/deployed.test.ts tests them.
// Nothing here makes a request. No message names a key, a token or a response body: only paths, statuses, codes, header
// values of our own policy, and provider names. The publishable key the bundle carries is public by design, and still never
// printed: publishableKey returns it to the caller, which keeps it in memory only.
import { connectOrigin, headersFile, headersFor, parseHeaders } from '../../scripts/build-headers.mjs';
import { FIXED_ROUTES, forbiddenMaterial } from '../../scripts/release-scan.mjs';

type Env = Record<string, string | undefined>;
type Headers = Record<string, string>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The deployed site's origin, from CLOUDIATOR_DEPLOYED_ORIGIN: an https origin, or a loopback http origin for a local
 * stand-in. Required: the checks never guess an origin.
 */
export function deployedOrigin(env: Env): string {
  const value = env.CLOUDIATOR_DEPLOYED_ORIGIN?.trim();
  if (!value) {
    throw new Error('CLOUDIATOR_DEPLOYED_ORIGIN is not set. Set it to the deployed site\'s origin (for example '
      + 'https://cloudiator.pages.dev, or http://127.0.0.1:<port> for a local stand-in); the deployed checks never guess one.');
  }
  let url: URL | null = null;
  try { url = new URL(value); } catch { /* refused below */ }
  const https = url?.protocol === 'https:', loopback = url?.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (!url || !(https || loopback) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.endsWith('#')) {
    throw new Error(`CLOUDIATOR_DEPLOYED_ORIGIN must be an origin (https://<host>, or http://127.0.0.1:<port> for a local stand-in), `
      + 'with no path, query or credentials.');
  }
  return url.origin;
}

/**
 * The Supabase project's origin, from CLOUDIATOR_SUPABASE_ORIGIN (https://<project>.supabase.co, or the local stack's loopback
 * URL). Required by connectSrc, cors, anonDenied and authProvidersGoogleOnly; never guessed.
 */
export function supabaseOrigin(env: Env): string {
  const value = env.CLOUDIATOR_SUPABASE_ORIGIN?.trim();
  if (!value) {
    throw new Error('CLOUDIATOR_SUPABASE_ORIGIN is not set. Set it to the project\'s origin (https://<project>.supabase.co, or '
      + 'http://127.0.0.1:54321 for the local stack); the deployed checks never guess one.');
  }
  try {
    const origin = connectOrigin(value);
    if (origin) return origin;
  } catch { /* refused below */ }
  throw new Error('CLOUDIATOR_SUPABASE_ORIGIN must be https://<project>.supabase.co, or a loopback http URL for the local stack.');
}

/** The release scan's fixed routes (scripts/release-scan.mjs), as URL paths. */
export const ROUTES: string[] = FIXED_ROUTES.map((file: string) => `/${file.replace(/index\.html$/, '')}`);

/**
 * A response status other than 200 as a problem (null for 200), so fixedRoutesReload and securityHeaders collect it and still
 * reach their evidence line (Task 24.2b fix round 1). `status` is undefined when the browser got no response at all.
 */
export function statusProblem(label: string, status: number | undefined): string | null {
  if (status === 200) return null;
  return status === undefined ? `${label}: no response, expected 200` : `${label}: status ${status}, expected 200`;
}

/** `text` with every publishable key masked: a page's or Playwright's message can quote the key the bundle carries. */
export function maskKeys(text: string): string {
  return text.replace(/sb_publishable_[A-Za-z0-9_-]+/g, '<publishable key>');
}

/**
 * A check's one evidence line (Task 24.2b): `deployed evidence | <project> | <check> | <description>`, the description on one
 * line, with no column separator of its own, and with any publishable key masked. The list reporter shows no annotations, so
 * tests/browser/deployed-reporter.ts prints each check's `evidence` annotation this way after the run (compression x of y,
 * the assets scanned, the connect-src origin, the favicon, …).
 */
export function evidenceLine(project: string, check: string, description: string): string {
  return `deployed evidence | ${project} | ${check} | ${maskKeys(description).replace(/\s*\n\s*/g, ' ').replaceAll('|', '/')}`;
}

/**
 * The command line flags under which Playwright records a trace: `--trace` in any form, and the UI mode, which always does. A
 * trace holds every request's headers, so it would record the apikey the anonymous probes send; the deployed config refuses
 * them, since a flag overrides its `trace: 'off'`.
 */
export function recordingFlags(argv: readonly string[]): string[] {
  const flags = argv.map(arg => arg.split('=')[0]).filter(flag => flag === '--trace' || flag === '--ui' || flag.startsWith('--ui-'));
  return [...new Set(flags)];
}

/**
 * fixedRoutesReload: a console error on the page at `path` as a problem, naming the resource a failed load was for (its path,
 * never its query), with any publishable key masked. One is recorded instead (null): the browser's own request for the site
 * icon, `/favicon.ico`, answered 404 because the export has no icon (observed on the local stand-in, Task 24.2). Adding an
 * icon is a product choice.
 */
export function consoleError(path: string, text: string, resourceUrl: string | undefined, site: string): string | null {
  let resource: URL | null = null;
  try { resource = resourceUrl ? new URL(resourceUrl) : null; } catch { /* no resource */ }
  const failedLoad = /^Failed to load resource: the server responded with a status of (\d+)/.exec(text);
  if (failedLoad?.[1] === '404' && resource?.origin === site && resource.pathname === '/favicon.ico') return null;
  return maskKeys(`${path}: console error: ${text}${failedLoad && resource ? ` (${resource.origin === site ? resource.pathname : resource.origin + resource.pathname})` : ''}`);
}

/** The headers the generated `_headers` (scripts/build-headers.mjs, for a build connecting to `connect`) gives `pathname`. */
export function expectedHeaders(connect: string | null, pathname: string): Headers {
  return Object.fromEntries(Object.entries(headersFor(parseHeaders(headersFile(connect)), pathname)).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * Every way `actual` (a response's headers, names in lower case) differs from `expected`: a missing or different value (a
 * value repeated by the host counts as different), and immutable caching outside /_next/static/. Other headers may be present.
 */
export function headerMismatches(path: string, expected: Headers, actual: Headers): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(expected)) {
    const got = actual[name];
    if (got === undefined) problems.push(`${path}: ${name} missing (expected ${value})`);
    else if (got !== value) problems.push(`${path}: ${name} is ${got}, expected ${value}`);
  }
  const cache = actual['cache-control'];
  if (!path.startsWith('/_next/static/') && cache && /\bimmutable\b/i.test(cache)) problems.push(`${path}: cache-control is ${cache} outside /_next/static/`);
  return problems;
}

/** A Content-Security-Policy's directives (names in lower case) and their sources; a repeated directive keeps its first. */
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/**
 * The origin a deployed policy's connect-src names besides the site (null when it names none). A policy no build writes (no
 * connect-src, more than one origin, or an origin that is not a project or loopback URL) throws, naming connect-src.
 */
export function policyOrigin(policy: string): string | null {
  const sources = parseCsp(policy).get('connect-src');
  if (!sources || sources[0] !== "'self'") throw new Error(`connect-src is ${sources?.join(' ') ?? 'missing'}, not 'self' and at most one project`);
  const others = sources.slice(1);
  if (others.length === 0) return null;
  if (others.length > 1) throw new Error(`connect-src names ${others.length} origins besides 'self': ${others.join(' ')}`);
  try { return connectOrigin(others[0]); } catch { throw new Error(`connect-src names ${others[0]}, which no build writes`); }
}

/** connectSrc: the policy on `path` lets the page connect to the site and the required project, and nothing else. */
export function connectSrcProblems(path: string, policy: string, required: string): string[] {
  const sources = parseCsp(policy).get('connect-src');
  if (!sources) return [`${path}: no connect-src (${policy ? 'the policy has none' : 'no Content-Security-Policy'})`];
  const expected = ["'self'", required];
  return sources.join(' ') === expected.join(' ') ? [] : [`${path}: connect-src is ${sources.join(' ')}, expected ${expected.join(' ')}`];
}

/** compression: a response the checks asked for with `Accept-Encoding: br, gzip` came back br or gzip. */
export function compressionProblem(path: string, headers: Headers): string | null {
  const encoding = headers['content-encoding'];
  if (!encoding) return `${path}: not compressed (no content-encoding)`;
  return ['br', 'gzip'].includes(encoding.trim().toLowerCase()) ? null : `${path}: content-encoding ${encoding}, expected br or gzip`;
}

/** An origin that is never allowed: the cors check's preflight "from another origin". */
export const FOREIGN_ORIGIN = 'https://not-cloudiator.example';
type Answer = { status: number; headers: Headers };

/** cors: the command preflight from the site gets 204 (or 200), exactly the site's grant, never `*`, cached for 7200 s. */
export function preflightProblems({ status, headers }: Answer, site: string): string[] {
  const problems: string[] = [];
  const label = 'preflight from the site';
  if (status !== 204 && status !== 200) problems.push(`${label}: status ${status}, expected 204 or 200`);
  const grant = headers['access-control-allow-origin'];
  if (grant === '*') problems.push(`${label}: grants every origin (*)`);
  else if (grant === undefined) problems.push(`${label}: no Access-Control-Allow-Origin, expected the site`);
  else if (grant !== site) problems.push(`${label}: grants ${grant}, expected the site`);
  const age = headers['access-control-max-age'];
  if (age === undefined) problems.push(`${label}: Access-Control-Max-Age missing, expected 7200`);
  else if (age !== '7200') problems.push(`${label}: Access-Control-Max-Age ${age}, expected 7200`);
  return problems;
}

/** cors: the command preflight from another origin is refused (403, the handler's answer) with no grant at all. */
export function foreignPreflightProblems({ status, headers }: Answer): string[] {
  const problems: string[] = [];
  const label = 'preflight from another origin';
  if (status !== 403) problems.push(`${label}: status ${status}, expected 403`);
  const grant = headers['access-control-allow-origin'];
  if (grant !== undefined) problems.push(`${label}: grants ${grant}`);
  return problems;
}

/** The `code` of a JSON error body, or null; nothing else of the body is ever read into a message. */
function codeOf(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body);
    const code = value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : null;
  } catch { return null; }
}

/** cors: the worker, asked without its secret, answers 401 `unauthenticated` (its own refusal, not the gateway's). */
export function workerProblems(status: number, body: string): string[] {
  const code = codeOf(body);
  return status === 401 && code === 'unauthenticated' ? []
    : [`game-worker without its secret: status ${status}, code ${code ?? 'none'}, expected 401 unauthenticated`];
}

/** One anonymous Data API request that must be refused, and the PostgREST/PostgreSQL codes that count as the refusal. */
export type AnonProbe = { label: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: Record<string, unknown>;
  profile?: 'private'; expected: string[] };
const rpc = (name: string, args: string[]): AnonProbe => ({ label: `rpc ${name}`, method: 'POST', path: `/rest/v1/rpc/${name}`,
  body: Object.fromEntries(args.map(arg => [arg, null])), expected: ['42501'] });
/**
 * anonDenied: a representative set from tests/db/access-matrix.test.ts, chosen so that a probe changes nothing even if a
 * privilege had been granted: backend-only and owner functions called with null arguments only (each refuses or finds nothing
 * with them), inserts of an empty row, an update and a delete filtered on `is.null` of a NOT NULL primary-key column (so no
 * row can match), and the private schema, which the Data API must not serve at all: a table read, and a call of the STRICT
 * private.schedule_effective_slot with null arguments (STRICT returns null without running). No function that acts without
 * arguments is called (coordinate_work, refresh_projections, private.cleanup_tick). tests/deployed.test.ts checks each rule
 * against the migrations.
 */
export const ANON_PROBES: AnonProbe[] = [
  rpc('create_gladiator', ['actor_id', 'operation_id', 'input']),
  rpc('edit_schedule', ['actor_id', 'operation_id', 'input']),
  rpc('buy_listing', ['actor_id', 'operation_id', 'input']),
  rpc('claim_jobs', ['worker_id', 'kind', 'batch_limit']),
  rpc('complete_job', ['job_id', 'lease_token', 'result']),
  rpc('renew_job', ['job_id', 'lease_token']),
  rpc('settle_activity', ['activity_id', 'lease_token']),
  { label: 'insert wallets', method: 'POST', path: '/rest/v1/wallets', body: {}, expected: ['42501'] },
  { label: 'insert item_instances', method: 'POST', path: '/rest/v1/item_instances', body: {}, expected: ['42501'] },
  { label: 'insert world_actors', method: 'POST', path: '/rest/v1/world_actors', body: {}, expected: ['42501'] },
  { label: 'update wallets', method: 'PATCH', path: '/rest/v1/wallets?gladiator_id=is.null', body: { money: 0 }, expected: ['42501'] },
  { label: 'delete operation_receipts', method: 'DELETE', path: '/rest/v1/operation_receipts?owner_id=is.null', expected: ['42501'] },
  { label: 'read private.jobs', method: 'GET', path: '/rest/v1/jobs?select=id&limit=1', profile: 'private', expected: ['PGRST106'] },
  { label: 'rpc private.schedule_effective_slot', method: 'POST', path: '/rest/v1/rpc/schedule_effective_slot', body: { phase: null, now_ms: null },
    profile: 'private', expected: ['PGRST106'] },
];

/** anonDenied: null when `probe` was refused with one of its codes; otherwise its status and code, never the response text. */
export function denialProblem(probe: AnonProbe, status: number, body: string): string | null {
  const code = codeOf(body);
  return status >= 400 && code !== null && probe.expected.includes(code) ? null
    : `${probe.label}: status ${status}, code ${code ?? 'none'}, expected ${probe.expected.join(' or ')}`;
}

/** authProvidersGoogleOnly: GoTrue's `/auth/v1/settings` has Google on, every other provider off, and sign-up open. */
export function authSettingsProblems(settings: unknown): string[] {
  const external = settings && typeof settings === 'object' ? (settings as { external?: unknown }).external : undefined;
  if (!external || typeof external !== 'object') return ['no external providers in /auth/v1/settings'];
  const on = Object.entries(external as Record<string, unknown>).filter(([, value]) => value === true).map(([name]) => name).sort();
  const problems: string[] = [];
  if (!on.includes('google')) problems.push('Google is not enabled');
  const others = on.filter(name => name !== 'google');
  if (others.length) problems.push(`enabled besides Google: ${others.join(', ')}`);
  if ((settings as { disable_signup?: unknown }).disable_signup !== false) problems.push('sign-up is disabled: a new Google account cannot join');
  return problems;
}

/** The site's own JavaScript chunks `text` references (`/_next/static/chunks/…js`, or `static/chunks/…js` in a loader). */
export function chunkReferences(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\w.:/-])(\/_next\/)?static\/chunks\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\.js(?![\w.-])/g)) {
    found.add(match[1] ? match[0] : `/_next/${match[0]}`);
  }
  return [...found];
}

/** The key the browser-test builds use (playwright.config.ts); next.config.ts refuses it in a production export. */
const TEST_KEY = 'sb_publishable_browser_test_only';

/** shippedAssetsClean: what the release scan (scripts/release-scan.mjs) refuses in the asset at `path`, plus the browser-test key. */
export function shippedProblems(path: string, content: string): string[] {
  const found = forbiddenMaterial(content);
  return [
    ...(found.includes('backend') ? [`${path}: forbidden backend material`] : []),
    ...(found.includes('fixture') ? [`${path}: fixture preview data`] : []),
    ...(content.includes(TEST_KEY) ? [`${path}: the browser-test key`] : []),
  ];
}

/**
 * The one publishable key the deployed bundle carries (public by design: the browser sends it with every request). It is
 * returned to be kept in memory only; a problem names a count, never a key.
 */
export function publishableKey(assets: Map<string, string>): string {
  const keys = new Set<string>();
  for (const text of assets.values()) for (const match of text.matchAll(/sb_publishable_[A-Za-z0-9_-]{8,}/g)) keys.add(match[0]);
  if (keys.has(TEST_KEY)) throw new Error('the browser-test key is in the deployed bundle');
  if (keys.size === 0) throw new Error('no publishable key (sb_publishable_…) in the deployed bundle');
  if (keys.size > 1) throw new Error(`${keys.size} different publishable keys in the deployed bundle`);
  return [...keys][0];
}

type Field = { env: string; row: string; kind: 'count' | 'boolean'; check: (value: number | boolean) => boolean; wanted: string };
const count = (env: string, row: string, check: (n: number) => boolean, wanted: string): Field =>
  ({ env, row, kind: 'count', check: value => check(value as number), wanted });
/**
 * The attested checks (plan Decision 8): Avi runs scripts/hosted-checks.sql after the real journey and pastes its sanitized
 * rows; each value is set from the named `section / item` row before the run. Nothing here reads a database or an account.
 */
export const ATTESTED = {
  persistedCharactersForNewGoogleAccount: {
    characters: count('CLOUDIATOR_ATTEST_NEW_ACCOUNT_CHARACTERS', 'characters / account <hash> (the new Google account): characters N', n => n === 1, '1'),
  },
  completedRealBoundary: {
    boundaries: count('CLOUDIATOR_ATTEST_BOUNDARIES_COMPLETED', 'boundary-latency / last 24 h boundaries', n => n >= 1, 'at least 1'),
    over120s: count('CLOUDIATOR_ATTEST_BOUNDARIES_OVER_120S', 'boundary-latency / last 24 h over 120 s', n => n === 0, '0'),
    duplicateGrants: count('CLOUDIATOR_ATTEST_DUPLICATE_GRANTS', 'duplicate-grants / total (duplicateGrants)', n => n === 0, '0'),
  },
  twoAccountTrade: {
    owners: count('CLOUDIATOR_ATTEST_TRADE_OWNERS', 'trades / sale <hash> (the two-account trade): owners N', n => n === 1, '1'),
    feeCorrect: { env: 'CLOUDIATOR_ATTEST_TRADE_FEE_CORRECT', row: 'trades / sale <hash> (the two-account trade): fee right true|false',
      kind: 'boolean', check: value => value === true, wanted: 'true' },
  },
} satisfies Record<string, Record<string, Field>>;
export type AttestedCheck = keyof typeof ATTESTED;

/** The attested values of `check`, read from the environment; an absent or malformed value throws, naming its variable and row. */
export function attested(check: AttestedCheck, env: Env): Record<string, number | boolean> {
  const values: Record<string, number | boolean> = {};
  for (const [name, field] of Object.entries(ATTESTED[check]) as [string, Field][]) {
    const raw = env[field.env]?.trim();
    if (!raw) throw new Error(`${check} is not attested: ${field.env} is not set. Avi runs scripts/hosted-checks.sql on the project and pastes the sanitized row "${field.row}"; set ${field.env} from it.`);
    if (field.kind === 'count') {
      if (!/^\d+$/.test(raw)) throw new Error(`${field.env} is not a whole number (row "${field.row}").`);
      values[name] = Number(raw);
    } else {
      if (raw !== 'true' && raw !== 'false') throw new Error(`${field.env} must be true or false (row "${field.row}").`);
      values[name] = raw === 'true';
    }
  }
  return values;
}

/** Each attested value of `check` that differs from its acceptance value. */
export function attestedProblems(check: AttestedCheck, values: Record<string, number | boolean>): string[] {
  return (Object.entries(ATTESTED[check]) as [string, Field][])
    .filter(([name, field]) => !field.check(values[name]))
    .map(([name, field]) => `${name} is ${values[name]}, expected ${field.wanted}`);
}
